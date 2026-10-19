import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { ExportLiteError } from "../errors.js";
import type {
  ExportOptions,
  ExportResult,
  ExportStream,
  StreamExportOptions,
} from "../types.js";

type Producer = (options: ExportOptions) => Promise<ExportResult>;

/** Reuses the destination writer so both API forms share export/ZIP semantics. */
class ReadableExport extends PassThrough {
  readonly result: Promise<ExportResult>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private running: Promise<ExportResult> | undefined;
  private failed = false;
  private resolveResult!: (result: ExportResult) => void;
  private rejectResult!: (error: unknown) => void;

  constructor(
    private readonly options: StreamExportOptions,
    private readonly produce: Producer,
    started: number,
  ) {
    super({ highWaterMark: 65_536 });
    this.options = { ...options };
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    const produced = new Promise<ExportResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    const consumed = finished(this, {
      readable: true,
      writable: false,
      cleanup: true,
    });
    this.result = Promise.all([produced, consumed])
      .then(([result]) => ({
        ...result,
        durationMs: performance.now() - started,
      }))
      .catch((cause: unknown) => {
        throw this.signal.aborted ? this.abortError() : cause;
      })
      .finally(() => this.signal.removeEventListener("abort", this.onAbort));
    // Consumers can handle body errors without awaiting stats.
    this.result.catch(() => {});
    this.on("error", () => {});
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private readonly onAbort = (): void => {
    this.destroy(this.abortError());
  };

  private abortError(): ExportLiteError {
    return new ExportLiteError("ABORTED", "Export aborted.", {
      cause: this.signal.reason,
    });
  }

  override _read(size: number): void {
    super._read(size);
    if (this.running || this.destroyed) return;
    this.running = Promise.resolve().then(() =>
      this.produce({
        ...this.options,
        output: this,
        end: true,
        signal: this.signal,
      }),
    );
    this.running.then(
      (result) => {
        this.resolveResult(result);
      },
      (cause: unknown) => {
        this.failed = true;
        this.rejectResult(cause);
        this.destroy(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    // Normal auto-destruction must close immediately: the producer's final
    // writable completion can itself be waiting for this close event.
    if (this.failed || (this.readableEnded && this.writableFinished)) {
      callback(error);
      return;
    }
    this.controller.abort(
      error ?? new Error("Export stream closed before completion."),
    );
    if (!this.running) {
      this.rejectResult(this.abortError());
      callback(error);
      return;
    }
    // Cancellation closes only after the SQL iterator and owned ZIP stages
    // have been released, so pipeline callers can safely reuse the connection.
    this.running.then(
      () => callback(error),
      () => callback(error),
    );
  }
}

/** Pull only on demand; Web cancellation waits for the existing writer cleanup. */
export function createReadableExport(
  options: StreamExportOptions,
  produce: Producer,
  started: number,
): ExportStream {
  const source = new ReadableExport(options, produce, started);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  let resolveConsumed!: () => void;
  let rejectConsumed!: (error: unknown) => void;
  const consumed = new Promise<void>((resolve, reject) => {
    resolveConsumed = resolve;
    rejectConsumed = reject;
  });
  const onError = (error: unknown): void => {
    if (settled) return;
    settled = true;
    controller.error(error);
    rejectConsumed(error);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        source.on("error", onError);
      },
      async pull() {
        try {
          iterator ??= source[Symbol.asyncIterator]();
          const chunk = await iterator.next();
          if (settled) return;
          if (chunk.done) {
            await source.result;
            settled = true;
            controller.close();
            resolveConsumed();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          onError(error);
        }
      },
      async cancel(reason: unknown) {
        settled = true;
        source.destroy(reason instanceof Error ? reason : undefined);
        // Await cancellation before reporting it: the caller may immediately
        // reuse or close its database after cancel() or result settles.
        await source.result.catch(() => {});
        rejectConsumed(
          new ExportLiteError("ABORTED", "Export aborted.", { cause: reason }),
        );
      },
    },
    { highWaterMark: 0 },
  );
  const result = Promise.all([source.result, consumed])
    .then(([stats]) => ({ ...stats, durationMs: performance.now() - started }))
    .finally(() => source.off("error", onError));
  result.catch(() => {});
  return Object.defineProperty(stream, "result", {
    value: result,
  }) as ExportStream;
}
