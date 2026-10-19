import { PassThrough, type Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type ZipStream from "zip-stream";
import { ExportLiteError } from "../errors.js";
import type { ExportOptions } from "../types.js";
import { OutputWriter } from "./writer.js";

// Capture the compressor through the public pipe API so cancellation can close
// every owned stage, including the ZIP writer's internal compression stream.
class EntryInput extends PassThrough {
  compression?: Writable;
  override pipe<T extends NodeJS.WritableStream>(
    destination: T,
    options?: { end?: boolean },
  ): T {
    if (destination instanceof Writable) this.compression = destination;
    return super.pipe(destination, options);
  }
}

function entryName(name: string, format: ExportOptions["format"]): string {
  let stem =
    Array.from(name.replace(/[^\p{L}\p{M}\p{N}_-]/gu, "_"))
      .slice(0, 80)
      .join("") || "export";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return `${stem}.${format === "json" ? "json" : "jsonl"}`;
}

export class ZipOutput {
  private constructor(
    private readonly destination: OutputWriter,
    private readonly json: OutputWriter,
    private readonly input: EntryInput,
    private readonly archive: ZipStream,
    private readonly done: Promise<void>,
  ) {}

  static async create(
    options: ExportOptions,
    name: string,
  ): Promise<ZipOutput> {
    const destination = await OutputWriter.create(options);
    const input = new EntryInput({ highWaterMark: 65_536 });
    let json: OutputWriter | undefined;
    let archive: ZipStream | undefined;
    let done: Promise<void> | undefined;
    try {
      json = await OutputWriter.create({
        ...options,
        output: input,
        end: true,
      });
      // Native import works in both builds with the ZIP writer's ESM export.
      const { default: Archive } = await import("zip-stream");
      archive = new Archive({
        forceZip64: true,
        zlib: { level: 1, chunkSize: 262_144, memLevel: 9 },
      });
      const sink = new Writable({
        highWaterMark: 65_536,
        write(chunk: Buffer, _encoding, callback) {
          destination.writeBytes(chunk).then(() => callback(), callback);
        },
      });
      // The bridge, rather than the caller's stream, belongs to this pipeline.
      done = pipeline(archive as unknown as Readable, sink).catch(
        (cause: unknown) => {
          const error =
            cause instanceof ExportLiteError
              ? cause
              : new ExportLiteError("OUTPUT_ERROR", "ZIP output failed.", {
                  cause,
                });
          input.destroy(error);
          throw error;
        },
      );
      done.catch(() => {});
      const active = archive;
      archive.entry(
        input,
        {
          name: entryName(name, options.format),
          date: new Date("1980-01-01T00:00:00.000Z"),
        },
        (error) => {
          if (error) active.destroy(error);
          else active.finalize();
        },
      );
      return new ZipOutput(destination, json, input, archive, done);
    } catch (cause) {
      input.destroy();
      input.compression?.destroy();
      archive?.destroy();
      await done?.catch(() => {});
      await json?.dispose(false);
      await destination.dispose(false);
      throw cause instanceof ExportLiteError
        ? cause
        : new ExportLiteError(
            "OUTPUT_ERROR",
            "Could not initialize ZIP output.",
            { cause },
          );
    }
  }

  get bytesWritten(): number {
    return this.destination.bytesWritten;
  }

  check(): void {
    this.destination.check();
    this.json.check();
  }

  write(
    text: string | Buffer,
    bytes?: number,
    prefix = "",
    suffix = "",
  ): Promise<void> | undefined {
    this.check();
    return this.json.write(text, bytes, prefix, suffix);
  }

  async complete(): Promise<void> {
    await this.json.complete();
    await this.done;
    await this.destination.complete();
  }

  async dispose(success: boolean): Promise<void> {
    try {
      if (!success) {
        const closed = [this.input, this.archive, this.input.compression]
          .filter((stream) => stream !== undefined)
          .map((stream) => finished(stream, { cleanup: true }).catch(() => {}));
        this.input.destroy();
        this.input.compression?.destroy();
        this.archive.destroy();
        await Promise.all([...closed, this.done.catch(() => {})]);
      }
      await this.json.dispose(success);
    } finally {
      await this.destination.dispose(success);
    }
  }
}
