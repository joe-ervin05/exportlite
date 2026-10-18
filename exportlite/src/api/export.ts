import { setImmediate } from "node:timers/promises";
import type { ReadStatement } from "../database/adapter.js";
import { jsonBatches, jsonRows } from "../database/better-sqlite3.js";
import { OutputWriter } from "../output/writer.js";
import type { ExportOptions, ExportResult } from "../types.js";

export async function streamExport(
  statement: ReadStatement,
  args: unknown[],
  options: ExportOptions,
  started: number,
  batched = false,
): Promise<ExportResult> {
  const output = await OutputWriter.create(options);
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
      const content = json && batched ? text.slice(1, -1) : text;
      const prefix = json && rowsExported > 0 ? "," : "";
      const suffix = json ? "" : "\n";
      const bytes =
        Buffer.byteLength(text) -
        (json && batched ? 2 : 0) +
        prefix.length +
        suffix.length;
      // Stitch SQLite JSON directly; never parse it or construct JS row objects.
      const wait = output.write(`${prefix}${content}${suffix}`, bytes);
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
    await output.dispose(success);
  }
}
