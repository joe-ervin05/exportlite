import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cp,
	copyFile,
	mkdir,
	readFile,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-memory-next");
const baseline = join(here, "baseline/exportlite");
const cases = process.env.CSV_MEMORY_CANDIDATES?.split(",") ?? [
	"yield256",
	"yield512",
	"batch128",
	"batch64",
	"text",
	"zip128k",
	"zip64k",
];
async function replace(directory, file, from, to) {
	const path = join(directory, file);
	const text = await readFile(path, "utf8");
	assert(text.includes(from), `${file}: missing candidate boundary`);
	await writeFile(path, text.replace(from, to));
}
await mkdir(join(here, "candidates"), { recursive: true });
for (const name of cases) {
	const directory = join(here, "candidates", name);
	await mkdir(directory);
	await cp(join(baseline, "src"), join(directory, "src"), { recursive: true });
	for (const file of ["package.json", "tsconfig.json", "tsdown.config.ts"])
		await copyFile(join(baseline, file), join(directory, file));
	await symlink(
		join(root, "exportlite/node_modules"),
		join(directory, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	if (name.startsWith("yield"))
		await replace(
			directory,
			"src/api/export.ts",
			"if (sinceYield >= 2048)",
			`if (sinceYield >= (batched && options.format === "csv" ? ${name.slice(5)} : 2048))`,
		);
	if (name.startsWith("batch")) {
		const size = Number(name.slice(5));
		const path = join(directory, "src/planner/batches.ts");
		const source = await readFile(path, "utf8");
		await writeFile(
			path,
			source.replaceAll("255", `${size - 1}`).replaceAll("256", `${size}`),
		);
	}
	if (name === "text")
		await replace(
			directory,
			"src/planner/batches.ts",
			"const payload = options.binary ?",
			'const payload = options.binary && options.format !== "csv" ?',
		);
	if (name.startsWith("zip"))
		await replace(
			directory,
			"src/output/zip.ts",
			"chunkSize: 262_144",
			`chunkSize: ${name === "zip128k" ? "131_072" : "65_536"}`,
		);
	const child = spawnSync(
		process.env.BUILD_NODE ?? process.execPath,
		[join(directory, "node_modules/tsdown/dist/run.mjs")],
		{ cwd: directory, encoding: "utf8", maxBuffer: 1e7 },
	);
	assert.equal(child.status, 0, child.stderr);
	await writeFile(
		join(directory, "build.txt"),
		`${child.stdout}\n${child.stderr}`,
	);
	console.log(name);
}
