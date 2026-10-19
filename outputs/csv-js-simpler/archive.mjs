import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const base = join(here, "base");
const stage = process.env.CSV_JS_ARCHIVE_STAGE ?? "timed";
if (stage === "timed") {
	await mkdir(base);
	const archive = spawnSync(
		"git",
		["archive", "c2f7c513ed0958b24bf2897b6e1da1b730ca0d3a", "exportlite"],
		{ cwd: root, maxBuffer: 32 * 1024 * 1024 },
	);
	assert.equal(archive.status, 0, archive.stderr.toString());
	const untar = spawnSync("tar", ["-x", "-C", base], {
		input: archive.stdout,
		maxBuffer: 1e6,
	});
	assert.equal(untar.status, 0, untar.stderr.toString());
	await symlink(
		join(root, "exportlite/node_modules"),
		join(base, "exportlite/node_modules"),
		"dir",
	);
}
for (const name of ["native-values", "guarded-values"]) {
	const from = join(base, "exportlite"),
		to = join(here, "projects", name, "exportlite");
	const parts = [];
	for (const path of ["src", "tests"]) {
		const child = spawnSync(
			"git",
			[
				"diff",
				"--no-index",
				"--no-ext-diff",
				"--unified=0",
				"--",
				join(from, path),
				join(to, path),
			],
			{ encoding: "utf8", maxBuffer: 1e7 },
		);
		assert([0, 1].includes(child.status), child.stderr);
		let diff = child.stdout;
		for (const prefix of ["a", "b"])
			for (const directory of [from, to])
				diff = diff.replaceAll(`${prefix}${directory}`, `${prefix}/exportlite`);
		parts.push(diff);
	}
	await writeFile(join(here, `${name}-${stage}.patch`), parts.join(""));
	if (stage === "timed") {
		await cp(join(to, "dist"), join(here, "timed-builds", name), {
			recursive: true,
		});
		await cp(
			join(root, "exportlite/src/planner/csv.ts"),
			join(to, "src/planner/csv.ts"),
		);
		const file = join(to, "src/planner/csv-js.ts");
		const source = await readFile(file, "utf8");
		assert(source.includes("json_quote(${value})"));
		await writeFile(
			file,
			source.replaceAll(
				"json_quote(${value})",
				"json('ExportLite: BLOB values require an explicit conversion')",
			),
		);
		const test = join(to, "tests/csv.test.ts");
		const current = await readFile(
			join(root, "exportlite/tests/csv.test.ts"),
			"utf8",
		);
		await writeFile(
			test,
			current
				.replace(
					`expect(statements[0]).toContain('WITH RECURSIVE "__exportlite_batches"');`,
					`expect(statements[0]).toContain("SELECT CASE WHEN");`,
				)
				.replace(
					"expect(stopped).toBeLessThan(8);",
					"expect(stopped).toBeLessThan(2048);",
				),
		);
	}
}
console.log(`Archived ${stage} candidate patches.`);
