export type ExportErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_QUERY"
  | "INVALID_SCHEMA"
  | "UNSUPPORTED_SQLITE"
  | "SQLITE_ERROR"
  | "REMOTE_ERROR"
  | "OUTPUT_ERROR"
  | "ABORTED";

export class ExportLiteError extends Error {
  override readonly name = "ExportLiteError";

  constructor(
    public readonly code: ExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function sqliteError(error: unknown): ExportLiteError {
  if (error instanceof ExportLiteError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const hint = /cannot hold BLOB/i.test(detail)
    ? " BLOB values are unsupported in this prototype; select other columns or CAST/hex them in exportQuery()."
    : "";
  return new ExportLiteError(
    "SQLITE_ERROR",
    `SQLite export failed: ${detail}.${hint}`,
    {
      cause: error,
    },
  );
}
