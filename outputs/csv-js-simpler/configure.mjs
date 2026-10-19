import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url));
async function replace(pkg, file, from, to) {
	const path = join(pkg, file);
	const text = await readFile(path, "utf8");
	assert(text.includes(from), `${file}: missing replacement`);
	await writeFile(path, text.replace(from, to));
}
for (const name of ["joined", "buffered", "tokens", "raw"]) {
	const pkg = join(here, "projects", name, "exportlite");
	const chunked = name !== "joined";
	const paired = ["joined", "buffered"].includes(name);
	const encoder = `import { ExportLiteError, sqliteError } from "../errors.js";
import type { ReadStatement } from "./adapter.js";

/** Experimental JS formatting. Ownership/backpressure remain in the writer. */
export function* csvJsRows(statement: ReadStatement, args: unknown[], target = 65_536): Generator<${chunked ? "[Buffer, number]" : "string"}> {
  ${chunked ? "let parts: string[] = [], size = 0, count = 0, total = 0;" : ""}
  try {
    for (const row of statement.raw().iterate(...args)) {
      if (!Array.isArray(row) || !row.length${paired ? " || row.length % 2" : ""})
        throw new Error("Expected SQLite CSV scalars.");
      if (${paired ? 'row[0] === "utf16"' : "Buffer.isBuffer(row[0])"})
        throw new ExportLiteError("INVALID_OPTIONS", "The database uses UTF-16. Set encoding to utf16le or utf16be for declared table exports; exported data remains UTF-8.");
      let line = "";
      for (let index = 0; index < row.length; index += ${paired ? "2" : "1"}) {
        if (index) line += ",";
        ${
					paired
						? `const kind = row[index], value = row[index + 1];
        if (kind === "null") continue;
        if (typeof value !== "string") throw new Error("Expected SQLite scalar text.");
        if (kind === "text") line += '\"' + value.replaceAll('\"', '\"\"') + '\"';
        else if (kind === "integer" || kind === "real") line += value;
        else throw new Error("Unsupported SQLite CSV value.");`
						: name === "tokens"
							? `const value = row[index];
        if (value === null) continue;
        if (typeof value !== "string") throw new Error("Expected SQLite scalar text.");
        if (value.charCodeAt(0) !== 0) line += '\"' + value.replaceAll('\"', '\"\"') + '\"';
        else if (value.charCodeAt(1) === 0) line += '\"' + value.slice(2).replaceAll('\"', '\"\"') + '\"';
        else line += value.slice(1);`
							: `const value = row[index];
        if (value === null) continue;
        if (typeof value === "string") line += '\"' + value.replaceAll('\"', '\"\"') + '\"';
        else if (typeof value === "number" || typeof value === "bigint") line += String(value);
        else throw new Error("Unsupported SQLite CSV value.");`
				}
      }
      ${
				chunked
					? `line += "\\r\\n";
      parts.push(line);
      size += Buffer.byteLength(line);
      count++;
      if (size >= target || ++total % 2048 === 0) {
        const buffer = Buffer.from(parts.join(""), "utf8");
        parts = []; size = 0;
        const rows = count; count = 0;
        yield [buffer, rows];
      }`
					: "yield line;"
			}
    }
    ${chunked ? 'if (count) yield [Buffer.from(parts.join(""), "utf8"), count];' : ""}
  } catch (error) { throw sqliteError(error); }
}
`;
	// Count every record, including when a byte-threshold flush short-circuits.
	await writeFile(
		join(pkg, "src/database/csv-js.ts"),
		encoder.replace(
			"if (size >= target || ++total % 2048 === 0)",
			"if (++total % 2048 === 0 || size >= target)",
		),
	);
	if (chunked) {
		await replace(
			pkg,
			"src/api/export.ts",
			'json || (batched && options.format === "csv")',
			'json || options.format === "csv"',
		);
		await replace(
			pkg,
			"src/api/export.ts",
			': options.format === "csv"\n          ? "\\r\\n"\n          : "\\n";',
			': "\\n";',
		);
		await replace(
			pkg,
			"src/api/export.ts",
			"csvJsRows(statement, args)",
			"csvJsRows(statement, args, options.bufferSize)",
		);
	}
	if (!paired) {
		const file = `import type { SelectedField } from "./columns.js";
/** One result value per cell. Numeric tokens preserve SQLite spelling. */
export function csvJsSelection(values: readonly string[], utf8Guard = false, fields?: readonly SelectedField[]) {
  return values.map((value, index) => {
    const field = fields?.[index];
    let cell: string;
    if (field?.kind === "boolean")
      cell = \`CASE \${value} WHEN 0 THEN 'false' WHEN 1 THEN 'true' ELSE CASE WHEN \${value} IS NULL THEN NULL ELSE json('ExportLite: expected boolean 0 or 1') END END\`;
    else if (field?.kind === "json") cell = \`json(\${value})\`;
    else cell = ${name === "raw" ? "`CASE typeof(${value}) WHEN 'blob' THEN json_quote(${value}) ELSE ${value} END`" : "`CASE typeof(${value}) WHEN 'null' THEN NULL WHEN 'text' THEN CASE WHEN coalesce(unicode(${value}), 0) = 0 THEN char(0, 0) || ${value} ELSE ${value} END WHEN 'blob' THEN json_quote(${value}) ELSE char(0) || CAST(${value} AS TEXT) END`"};
    return utf8Guard && index === 0
      ? \`CASE WHEN length(CAST(char(13, 10) AS BLOB)) = 2 THEN \${cell} ELSE X'00' END\`
      : cell;
  }).join(", ");
}
`;
		await writeFile(join(pkg, "src/planner/csv-js.ts"), file);
		await replace(
			pkg,
			"src/planner/columns.ts",
			"  const values = fields.map((field, index) => {",
			`  if (format === "csv" && csvJS)
    return csvJsSelection(fields.map((field, index) => reference(field, index)), utf8Guard, fields);
  const values = fields.map((field, index) => {`,
		);
	}
}
console.log(
	"Configured joined, buffered, tokens and diagnostic-only raw candidates.",
);
