import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler/projects");
const source = join(here, "native-values/exportlite");
const pkg = join(here, "chain/exportlite");
await mkdir(join(here, "chain"));
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
const path = join(pkg, "src/database/csv-js.ts");
let text = await readFile(path, "utf8");
const start = text.indexOf('      let line = "";');
const end = text.indexOf("      parts.push(line);", start);
if (start < 0 || end < 0) throw Error("Missing encoder loop");
text =
	text.slice(0, start) +
	`      if (!encode) {
        encode = (row) => cell(row[0]);
        for (let index = 1; index < row.length; index++) {
          const previous: (row: unknown[]) => string = encode;
          encode = (row): string => previous(row) + "," + cell(row[index]);
        }
      }
      const line = encode(row) + "\\r\\n";
` +
	text.slice(end);
text = text.replace(
	"  try {",
	`  const cell = (value: unknown): string => {
    if (value === null) return "";
    if (typeof value === "string") return '\"' + value.replaceAll('\"', '\"\"') + '\"';
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (Buffer.isBuffer(value)) return value.toString("utf8").replaceAll("\\0", "");
    throw new Error("Unsupported SQLite CSV value.");
  };
  let encode: ((row: unknown[]) => string) | undefined;
  try {`,
);
await writeFile(path, text);
console.log(
	"Configured schema-length closure chain, without runtime code generation.",
);
