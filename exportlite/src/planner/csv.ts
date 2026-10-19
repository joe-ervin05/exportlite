import type { SelectedField } from "./columns.js";

/** Text is always quoted: one replacement pass, including embedded CR/LF. */
export function csvHeader(columns: readonly string[]): string {
  return `${columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(",")}\r\n`;
}

/** SQLite constructs records; values and whole exports never become JS objects. */
export function csvRecord(
  values: readonly string[],
  fields?: readonly SelectedField[],
): string {
  const cells = values
    .map((value, index) => {
      const field = fields?.[index];
      if (field?.kind === "boolean")
        return `CASE ${value} WHEN 0 THEN '"false"' WHEN 1 THEN '"true"' ELSE CASE WHEN ${value} IS NULL THEN '' ELSE json('ExportLite: expected boolean 0 or 1') END END`;
      if (field?.kind === "json")
        return `CASE WHEN ${value} IS NULL THEN '' ELSE '"' || replace(json(${value}), '"', '""') || '"' END`;
      // Declarations affect branch order only. SQLite's actual storage type
      // still controls quoting, numeric spelling and BLOB rejection.
      const numeric =
        field?.dataType === "integer" || field?.dataType === "real"
          ? ` WHEN '${field.dataType}' THEN CAST(${value} AS TEXT)`
          : "";
      return `CASE typeof(${value}) WHEN 'null' THEN ''${numeric} WHEN 'text' THEN '"' || replace(${value}, '"', '""') || '"' WHEN 'blob' THEN json_quote(${value}) ELSE CAST(${value} AS TEXT) END`;
    })
    .join(", ");
  return `concat_ws(',', ${cells})`;
}

/** OFFSET prevents flattening without materializing the query. CSV examines
 * values more than once; computed/nondeterministic fields must run once. */
export function csvSource(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) LIMIT -1 OFFSET 0`;
}
