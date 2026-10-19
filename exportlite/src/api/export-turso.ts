import {
  getTurso,
  type TursoConnection,
  tursoStatement,
} from "../database/turso.js";
import { ExportLiteError } from "../errors.js";
import { createReadableExport } from "../output/readable.js";
import {
  checkAborted,
  OutputWriter,
  validateOptions,
} from "../output/writer.js";
import { ZipOutput } from "../output/zip.js";
import type {
  ExportOptions,
  ExportResult,
  ExportStream,
  QueryParameters,
  StreamExportOptions,
} from "../types.js";

/** Remote producer leaves the local synchronous loop and fast paths untouched. */
export function deliverTursoExport(
  client: TursoConnection,
  sql: string,
  params: QueryParameters | readonly unknown[] | undefined,
  options: ExportOptions | StreamExportOptions,
  started: number,
  batched = false,
  name = "export",
  header?: string,
): Promise<ExportResult | ExportStream> {
  validateOptions(options);
  checkAborted(options.signal);
  const transport = getTurso(client);
  if (!transport)
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "Create the client with createClient() from exportlite/turso.",
    );
  // Validate bindings before creating a file, returning a stream or doing I/O.
  const statement = tursoStatement(sql, params);
  const produce = (destination: ExportOptions): Promise<ExportResult> =>
    transport.run(destination.signal, async (clientSignal) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([clientSignal, controller.signal]);
      const outputError = (cause: Error) =>
        controller.abort(
          new ExportLiteError(
            "OUTPUT_ERROR",
            "Output failed during Turso export.",
            { cause },
          ),
        );
      const outputClose = () => {
        if (
          typeof destination.output !== "string" &&
          !destination.output.writableFinished
        )
          outputError(new Error("Output closed before completion."));
      };
      if (typeof destination.output !== "string") {
        destination.output.on("error", outputError);
        destination.output.on("close", outputClose);
      }
      let output: OutputWriter | ZipOutput | undefined;
      let rowsExported = 0;
      let success = false;
      try {
        const settings = { ...destination, signal };
        output = settings.zip
          ? await ZipOutput.create(settings, name)
          : await OutputWriter.create(settings);
        const json = options.format === "json";
        const suffix = json ? "" : options.format === "csv" ? "\r\n" : "\n";
        if (header !== undefined) {
          const wait = output.write(header);
          if (wait) await wait;
        }
        if (json) {
          const wait = output.write("[");
          if (wait) await wait;
        }
        output.check();
        for await (const [text, count] of transport.iterate(
          statement,
          batched,
          options.format ?? "jsonl",
          signal,
        )) {
          output.check();
          const content = json && batched ? text.slice(1, -1) : text;
          const prefix = json && rowsExported > 0 ? "," : "";
          const wait = output.write(`${prefix}${content}${suffix}`);
          if (wait) await wait;
          rowsExported += count;
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
      } catch (cause) {
        // Aborting a pending read also wakes the writer; preserve the original
        // destination failure rather than reporting that wake-up as cancellation.
        if (controller.signal.aborted) throw controller.signal.reason;
        throw cause;
      } finally {
        controller.abort();
        try {
          if (success) await output?.dispose(true);
          else await output?.dispose(false).catch(() => {});
        } finally {
          if (typeof destination.output !== "string") {
            destination.output.off("error", outputError);
            destination.output.off("close", outputClose);
          }
        }
      }
    });
  return options.output === undefined
    ? Promise.resolve(createReadableExport(options, produce, started))
    : produce(options);
}
