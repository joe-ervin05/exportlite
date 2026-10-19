import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url));
for (const name of ["buffered", "tokens", "native-values"]) {
	const path = join(here, "projects", name, "exportlite/tests/csv.test.ts");
	let source = await readFile(path, "utf8");
	assert(
		source.includes(
			`expect(statements[0]).toContain('WITH RECURSIVE "__exportlite_batches"');`,
		),
	);
	source = source.replace(
		`expect(statements[0]).toContain('WITH RECURSIVE "__exportlite_batches"');`,
		`expect(statements[0]).toContain("SELECT CASE WHEN");`,
	);
	// The probe counts iterator results. These experiments return individual rows,
	// rather than 256-row native batches. The same held callback must stop early,
	// stay stopped, cancel awaitably, and preserve the caller's output/connection.
	assert(source.includes("expect(stopped).toBeLessThan(8);"));
	source = source.replace(
		"expect(stopped).toBeLessThan(8);",
		"expect(stopped).toBeLessThan(2048);",
	);
	await writeFile(path, source);
}
console.log("Updated only internal SQL shape and iterator-unit assertions.");
