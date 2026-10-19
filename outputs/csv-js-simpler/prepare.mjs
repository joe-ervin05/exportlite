import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const old = "6cedfe09ff9853116906a62426cfccc237bac0a8";
const current = "c2f7c513ed0958b24bf2897b6e1da1b730ca0d3a";
function run(command, args, options = {}) {
	const r = spawnSync(command, args, {
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	assert.equal(r.status, 0, r.stderr?.toString() || r.error?.message);
	return r.stdout;
}
await mkdir(join(here, "projects"), { recursive: true });
const base = join(here, "base");
await mkdir(base);
run("tar", ["-x", "-C", base], {
	input: run("git", ["archive", current, "exportlite"], { cwd: root }),
});
await symlink(
	join(root, "exportlite/node_modules"),
	join(base, "exportlite/node_modules"),
	"dir",
);
const legacy = join(here, "projects/pairs");
await mkdir(legacy);
run("tar", ["-x", "-C", legacy], {
	input: run("git", ["archive", old, "exportlite"], { cwd: root }),
});
run(
	"git",
	[
		"apply",
		"--unsafe-paths",
		`--directory=${legacy}`,
		join(base, "exportlite/benchmarks/csv-js/candidate.patch"),
	],
	{ cwd: root },
);
const pkg = join(legacy, "exportlite");
for (const path of [
	"src/output",
	"src/planner/csv.ts",
	"tsdown.config.ts",
	"package.json",
	"tests",
	"scripts",
	"examples",
	"docs",
	"README.md",
	"THIRD_PARTY_NOTICES",
	"LICENSE",
]) {
	await cp(join(base, "exportlite", path), join(pkg, path), {
		recursive: true,
	});
}
// Keep the original paired scalar experiment but use current non-experimental
// formatting and native CRC32 everywhere that experiment does not apply.
const columns = join(pkg, "src/planner/columns.ts");
let text = await readFile(columns, "utf8");
text = text.replace(
	"  const values = fields.map((field, index) => {",
	`  if (format === "csv" && !csvJS)
    return csvRecord(fields.map((field, index) => reference(field, index)), fields);
  const values = fields.map((field, index) => {`,
);
await writeFile(columns, text);
await symlink(
	join(root, "exportlite/node_modules"),
	join(pkg, "node_modules"),
	"dir",
);
for (const name of ["joined", "buffered", "tokens", "raw"]) {
	const dest = join(here, "projects", name, "exportlite");
	await mkdir(dest, { recursive: true });
	for (const path of [
		"src",
		"tests",
		"scripts",
		"examples",
		"docs",
		"README.md",
		"THIRD_PARTY_NOTICES",
		"LICENSE",
		"package.json",
		"tsconfig.json",
		"tsdown.config.ts",
	])
		await cp(join(pkg, path), join(dest, path), { recursive: true });
	await symlink(
		join(root, "exportlite/node_modules"),
		join(dest, "node_modules"),
		"dir",
	);
}
console.log(
	JSON.stringify({
		root: here,
		originalExperiment: old,
		currentBaseline: current,
	}),
);
