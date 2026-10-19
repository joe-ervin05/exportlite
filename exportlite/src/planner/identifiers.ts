import { ExportLiteError } from "../errors.js";

export function identifier(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ExportLiteError(
      "INVALID_SCHEMA",
      "SQLite identifiers must be nonempty strings without NUL characters.",
    );
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function uniqueColumns(names: readonly string[]): void {
  if (names.length === 0)
    throw new ExportLiteError(
      "INVALID_SCHEMA",
      "At least one result column is required.",
    );
  const seen = new Set<string>();
  for (const name of names) {
    identifier(name);
    if (seen.has(name))
      throw new ExportLiteError(
        "INVALID_SCHEMA",
        `Duplicate result column ${JSON.stringify(name)}. Use unique aliases.`,
      );
    seen.add(name);
  }
}

/** Strip only the final delimiter/comments; the enclosing statement is driver-validated. */
export function subquerySource(sql: string): string {
  let last = -1;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (/\s/.test(char ?? "")) continue;
    if (char === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i + 2);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = char === "[" ? "]" : char;
      for (i++; i < sql.length; i++) {
        if (sql[i] !== end) continue;
        if (end !== "]" && sql[i + 1] === end) {
          i++;
          continue;
        }
        break;
      }
    }
    last = i;
  }
  return sql.slice(0, sql[last] === ";" ? last : last + 1);
}
