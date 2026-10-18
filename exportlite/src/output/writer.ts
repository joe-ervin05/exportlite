import { open, unlink } from "node:fs/promises";
import { finished as onFinished, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { ExportLiteError } from "../errors.js";
import type { ExportOptions } from "../types.js";

export function validateOptions(options: ExportOptions): void {
  for (const key of ["batchSize", "targetBatchBytes", "batchEstimator"]) {
    if (key in options && Reflect.get(options, key) !== undefined)
      throw new ExportLiteError(
        "INVALID_OPTIONS",
        "Batch sizing is internal in v0; remove batchSize, targetBatchBytes and batchEstimator.",
      );
  }
  if (
    options.format !== undefined &&
    options.format !== "json" &&
    options.format !== "jsonl"
  ) {
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "This prototype supports only json and jsonl.",
    );
  }
  const size = options.bufferSize ?? 65_536;
  if (!Number.isSafeInteger(size) || size < 1 || size > 16_777_216) {
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "bufferSize must be an integer from 1 to 16777216 bytes.",
    );
  }
  if (typeof options.output === "string") {
    if (!options.output || options.output.includes("\0"))
      throw new ExportLiteError(
        "INVALID_OPTIONS",
        "output must be a nonempty file path without NUL characters.",
      );
  } else if (
    !options.output ||
    typeof options.output.write !== "function" ||
    options.output.writableObjectMode
  ) {
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "output must be a file path or a byte-mode Node.js Writable.",
    );
  }
  if (options.end !== undefined && typeof options.end !== "boolean")
    throw new ExportLiteError("INVALID_OPTIONS", "end must be a boolean.");
}

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ExportLiteError("ABORTED", "Export aborted.", {
      cause: signal.reason,
    });
}

export class OutputWriter {
  bytesWritten = 0;
  private parts: string[] = [];
  private buffered = 0;
  private failure: Error | undefined;
  private rejectPending: ((error: Error) => void) | undefined;

  private constructor(
    private readonly stream: Writable,
    private readonly options: ExportOptions,
    private readonly ownedPath?: string,
  ) {
    stream.on("error", this.onError);
    stream.on("close", this.onClose);
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  static async create(options: ExportOptions): Promise<OutputWriter> {
    checkAborted(options.signal);
    if (typeof options.output !== "string") {
      const stream = options.output;
      if (!stream.writable || stream.destroyed || stream.writableEnded)
        throw new ExportLiteError(
          "OUTPUT_ERROR",
          "The destination stream is not writable.",
        );
      return new OutputWriter(stream, options);
    }
    try {
      const file = await open(options.output, "wx");
      return new OutputWriter(
        file.createWriteStream(),
        options,
        options.output,
      );
    } catch (cause) {
      throw new ExportLiteError(
        "OUTPUT_ERROR",
        "Could not create output file; the path must not already exist and its parent directory must exist.",
        { cause },
      );
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectPending?.(this.failure);
  }

  private readonly onError = (cause: Error): void => {
    this.fail(
      new ExportLiteError("OUTPUT_ERROR", `Output failed: ${cause.message}`, {
        cause,
      }),
    );
  };
  private readonly onClose = (): void => {
    if (!this.stream.writableFinished)
      this.fail(
        new ExportLiteError(
          "OUTPUT_ERROR",
          "Output stream closed before the export completed.",
        ),
      );
  };
  private readonly onAbort = (): void => {
    this.fail(
      new ExportLiteError("ABORTED", "Export aborted.", {
        cause: this.options.signal?.reason,
      }),
    );
  };

  check(): void {
    checkAborted(this.options.signal);
    if (this.failure) throw this.failure;
    if (this.stream.destroyed || this.stream.writableEnded)
      throw new ExportLiteError(
        "OUTPUT_ERROR",
        "Output stream is no longer writable.",
      );
  }

  write(text: string, knownBytes?: number): Promise<void> | undefined {
    this.check();
    this.parts.push(text);
    this.buffered += knownBytes ?? Buffer.byteLength(text);
    if (this.buffered >= (this.options.bufferSize ?? 65_536))
      return this.flush();
    return undefined;
  }

  private async flush(): Promise<void> {
    this.check();
    if (this.buffered === 0) return;
    const text = this.parts.join("");
    const bytes = this.buffered;
    this.parts = [];
    this.buffered = 0;
    await new Promise<void>((resolve, reject) => {
      let callbackDone = false;
      let drained = false;
      let writing = true;
      const cleanup = () => {
        this.stream.off("drain", onDrain);
        this.rejectPending = undefined;
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const complete = () => {
        if (!writing && callbackDone && drained) {
          cleanup();
          resolve();
        }
      };
      const onDrain = () => {
        drained = true;
        complete();
      };
      this.rejectPending = fail;
      this.stream.once("drain", onDrain);
      try {
        const accepted = this.stream.write(text, "utf8", (error) => {
          // Node emits the same error next; keep the listener attached until then.
          if (error) return;
          callbackDone = true;
          complete();
        });
        drained ||= accepted;
        writing = false;
        complete();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.bytesWritten += bytes;
    this.check();
  }

  async complete(): Promise<void> {
    await this.flush();
    this.check();
    if (this.ownedPath !== undefined || this.options.end) {
      await new Promise<void>((resolve, reject) => {
        let cleanup = () => {};
        const fail = (error: Error) => {
          cleanup();
          this.rejectPending = undefined;
          reject(error);
        };
        this.rejectPending = fail;
        cleanup = onFinished(this.stream, { readable: false }, (error) => {
          cleanup();
          this.rejectPending = undefined;
          if (error)
            reject(
              this.failure ??
                new ExportLiteError(
                  "OUTPUT_ERROR",
                  `Output finalization failed: ${error.message}`,
                  { cause: error },
                ),
            );
          else resolve();
        });
        try {
          this.stream.end();
        } catch (cause) {
          fail(
            new ExportLiteError("OUTPUT_ERROR", "Output finalization failed.", {
              cause,
            }),
          );
        }
      });
    }
    if (this.failure) throw this.failure;
  }

  async dispose(success: boolean): Promise<void> {
    try {
      if (!success && this.ownedPath !== undefined) {
        const done = finished(this.stream, {
          readable: false,
          cleanup: true,
        }).catch(() => {});
        this.stream.destroy();
        await done;
        await unlink(this.ownedPath);
      }
    } finally {
      this.stream.off("error", this.onError);
      this.stream.off("close", this.onClose);
      this.options.signal?.removeEventListener("abort", this.onAbort);
    }
  }
}
