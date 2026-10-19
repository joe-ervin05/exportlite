/** Text is always quoted: one replacement pass, including embedded CR/LF. */
export function csvHeader(columns: readonly string[]): string {
  return `${columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(",")}\r\n`;
}

/** SQLite constructs records; values and whole exports never become JS objects. */
export function csvRecord(values: readonly string[]): string {
  const cells = values
    .map(
      (value) =>
        `CASE typeof(${value}) WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${value}) WHEN 'text' THEN '"' || replace(${value}, '"', '""') || '"' ELSE CAST(${value} AS TEXT) END`,
    )
    .join(", ");
  return `concat_ws(',', ${cells})`;
}

/** OFFSET prevents flattening without materializing the query. CSV examines
 * values more than once; computed/nondeterministic fields must run once. */
export function csvSource(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) LIMIT -1 OFFSET 0`;
}
