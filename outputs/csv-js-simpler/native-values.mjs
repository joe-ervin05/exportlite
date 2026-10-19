import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const src = join(here, "projects/raw/exportlite");
const pkg = join(here, "projects/native-values/exportlite");
await mkdir(join(here, "projects/native-values"));
await mkdir(pkg);
for (const file of [
	"src",
	"tests",
	"scripts",
	"examples",
	"docs",
	"README.md",
	"LICENSE",
	"THIRD_PARTY_NOTICES",
	"package.json",
	"tsconfig.json",
	"tsdown.config.ts",
])
	await cp(join(src, file), join(pkg, file), { recursive: true });
await symlink(
	join(root, "exportlite/node_modules"),
	join(pkg, "node_modules"),
	"dir",
);
const planner = join(pkg, "src/planner/csv-js.ts");
let sql = await readFile(planner, "utf8");
sql = sql.replace(
	"CASE typeof(${value}) WHEN 'blob' THEN json_quote(${value}) ELSE ${value} END",
	"CASE typeof(${value}) WHEN 'real' THEN CAST(CAST(${value} AS TEXT) AS BLOB) WHEN 'blob' THEN json_quote(${value}) ELSE ${value} END",
);
await writeFile(planner, sql);
const path = join(pkg, "src/database/csv-js.ts");
let encoder = await readFile(path, "utf8");
encoder = encoder.replace(
	"for (const row of statement.raw().iterate(...args))",
	`for (const row of (statement as ReadStatement & { safeIntegers(toggle: boolean): ReadStatement }).safeIntegers(true).raw().iterate(...args))`,
);
encoder = encoder.replace(
	"Buffer.isBuffer(row[0])",
	"Buffer.isBuffer(row[0]) && row[0].length === 1 && row[0][0] === 0",
);
encoder = encoder.replace(
	'else throw new Error("Unsupported SQLite CSV value.");',
	`else if (Buffer.isBuffer(value)) line += value.toString("utf8").replaceAll("\\0", "");
        else throw new Error("Unsupported SQLite CSV value.");`,
);
assert(encoder.includes("safeIntegers(true)"));
await writeFile(path, encoder);
console.log(
	"Configured native-values: exact BigInts, SQLite REAL spelling, no type pairs.",
);
