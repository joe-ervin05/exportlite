import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler/projects");
const source = join(here, "native-values/exportlite");
const pkg = join(here, "guarded-values/exportlite");
await mkdir(join(here, "guarded-values"));
await mkdir(pkg);
for (const path of [
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
	await cp(join(source, path), join(pkg, path), { recursive: true });
await symlink(
	join(root, "exportlite/node_modules"),
	join(pkg, "node_modules"),
	"dir",
);
const path = join(pkg, "src/planner/csv-js.ts");
let text = await readFile(path, "utf8");
assert(text.includes("CASE typeof(${value}) WHEN 'real'"));
text = text.replace(
	"CASE typeof(${value}) WHEN 'real'",
	"CASE typeof(${value}) WHEN 'integer' THEN CASE WHEN ${value} BETWEEN -9007199254740991 AND 9007199254740991 THEN ${value} ELSE CAST(CAST(${value} AS TEXT) AS BLOB) END WHEN 'real'",
);
await writeFile(path, text);
const encoder = join(pkg, "src/database/csv-js.ts");
text = await readFile(encoder, "utf8");
text = text.replace(
	"safeIntegers(toggle: boolean): ReadStatement }).safeIntegers(true)",
	"safeIntegers(toggle: boolean): ReadStatement }).safeIntegers(false)",
);
await writeFile(encoder, text);
console.log(
	"Configured guarded-values: native safe numbers, exact large integer and REAL bytes.",
);
