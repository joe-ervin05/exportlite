import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url));
for (const name of (
	process.env.CSV_JS_CANDIDATES ?? "pairs,joined,buffered,tokens,raw"
).split(",")) {
	const pkg =
		name === "sqlite"
			? join(here, "base/exportlite")
			: join(here, "projects", name, "exportlite");
	const result = spawnSync(
		process.env.BUILD_NODE,
		[join(pkg, "node_modules/tsdown/dist/run.mjs")],
		{ cwd: pkg, encoding: "utf8", maxBuffer: 1e7 },
	);
	await writeFile(
		join(here, `build-${name}.txt`),
		`${result.stdout}\n${result.stderr}`,
	);
	assert.equal(result.status, 0, result.stderr);
	console.log(name);
}
