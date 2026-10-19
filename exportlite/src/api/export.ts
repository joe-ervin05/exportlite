import { setImmediate } from "node:timers/promises";
import type { ReadStatement } from "../database/adapter.js";
import { jsonBatches, jsonRows } from "../database/better-sqlite3.js";
import { createReadableExport } from "../output/readable.js";
import { OutputWriter } from "../output/writer.js";
import { ZipOutput } from "../output/zip.js";
import type {
  ExportOptions,
  ExportResult,
  ExportStream,
  StreamExportOptions,
} from "../types.js";

/** Share local delivery setup without adding work to the synchronous row loop. */
export function deliverLocalExport(
  statement: ReadStatement,
  args: unknown[],
  options: ExportOptions | StreamExportOptions,
  started: number,
  batched = false,
  name = "export",
): Promise<ExportResult | ExportStream> {
  if (options.output === undefined)
    return Promise.resolve(
      createReadableExport(
        options,
        (destination) =>
          streamExport(statement, args, destination, started, batched, name),
        started,
      ),
    );
  return streamExport(statement, args, options, started, batched, name);
}

export async function streamExport(
  statement: ReadStatement,
  args: unknown[],
  options: ExportOptions,
  started: number,
  batched = false,
  name = "export",
): Promise<ExportResult> {
  const output = options.zip
    ? await ZipOutput.create(options, name)
    : await OutputWriter.create(options);
  let rowsExported = 0;
  let sinceYield = 0;
  let success = false;
  try {
    const json = options.format === "json";
    if (json) {
      const wait = output.write("[");
      if (wait) await wait;
    }
    output.check();
    const values = batched
      ? jsonBatches(statement, args)
      : jsonRows(statement, args);
    for (const value of values) {
      output.check();
      const text = typeof value === "string" ? value : value[0];
      const count = typeof value === "string" ? 1 : Number(value[1]);
      const content =
        json && batched
          ? typeof text === "string"
            ? text.slice(1, -1)
            : text.subarray(1, -1)
          : text;
      const prefix = json && rowsExported > 0 ? "," : "";
      const suffix = json ? "" : "\n";
      const bytes =
        (typeof text === "string" ? Buffer.byteLength(text) : text.length) -
        (json && batched ? 2 : 0) +
        prefix.length +
        suffix.length;
      // Stitch SQLite JSON directly; never parse it or construct JS row objects.
      const wait =
        typeof content === "string"
          ? output.write(`${prefix}${content}${suffix}`, bytes)
          : output.write(content, bytes, prefix, suffix);
      if (wait) await wait;
      rowsExported += count;
      sinceYield += count;
      // Allow signals and stream errors to arrive even with a synchronous sink.
      if (sinceYield >= 2048) {
        await setImmediate();
        sinceYield = 0;
        output.check();
      }
    }
    if (json) {
      const wait = output.write("]");
      if (wait) await wait;
    }
    await output.complete();
    success = true;
    return {
      rowsExported,
      bytesWritten: output.bytesWritten,
      durationMs: performance.now() - started,
    };
  } finally {
    // Cleanup still runs, but cannot replace an execution/output failure.
    if (success) await output.dispose(true);
    else await output.dispose(false).catch(() => {});
  }
}
