import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-memory-next");
const profileDirectory = join(
	here,
	process.env.PROFILE_DIRECTORY ?? "profiles-v2",
);
const long = process.env.PROFILE_LONG === "1";
const probe = process.env.PROFILE_PROBE ?? "probe-v2.mjs";
const fixtures = JSON.parse(
	await readFile(
		join(root, "outputs/native-crc/comparison/configuration.json"),
		"utf8",
	),
).fixtures;
await mkdir(profileDirectory, { recursive: true });
const cases = [];
for (const name of ["wide", "json"]) {
	const f = fixtures.find((f) => f.name === name);
	for (const compression of ["none", "zip"])
		for (const [label, method, setup, modules] of [
			["package-esm", "table", "matched", "esm"],
			["manual-esm", "manual-tuned", "matched", "esm"],
			["package-dual", "table", "matched", "dual"],
			["manual-bare", "manual-tuned", "none", "esm"],
			["package-cjs", "table", "matched", "cjs"],
			["manual-cjs", "manual-tuned", "matched", "cjs"],
			...(name === "wide"
				? [
						["package-with-drizzle", "table", "matched", "esm"],
						["manual-with-drizzle", "manual-tuned", "matched", "esm"],
					]
				: []),
		]) {
			if (
				(long || process.env.PROFILE_PACKAGE_ONLY === "1") &&
				label !== "package-esm"
			)
				continue;
			const fixture = {
				...f,
				...(long ? { iterations: 32 } : {}),
				path: join(root, "outputs/csv-deep/fixtures", `${name}.sqlite`),
				drizzle: !!f.drizzle || label.includes("with-drizzle"),
			};
			const id = `${name}-${compression}-${label}`;
			const output = join(profileDirectory, `${id}.json`);
			const child = spawnSync(
				process.execPath,
				[
					"--expose-gc",
					"--import",
					join(here, probe),
					join(root, "exportlite/benchmarks/csv-performance/worker.mjs"),
					"worker",
					JSON.stringify(fixture),
					method,
					compression,
				],
				{
					encoding: "utf8",
					maxBuffer: 1e6,
					env: {
						...process.env,
						PROFILE_OUT: output,
						CSV_BENCH_DRIZZLE_SETUP: setup,
						CSV_BENCH_DRIZZLE_MODULES: modules,
						CSV_BENCH_PACKAGE_FORMAT: modules === "cjs" ? "cjs" : "esm",
					},
				},
			);
			assert.equal(child.status, 0, child.stderr);
			const result = JSON.parse(child.stdout);
			const profile = JSON.parse(await readFile(output, "utf8"));
			cases.push({
				name,
				compression,
				label,
				result,
				natural: profile.natural,
				setup: profile.snapshots.find((s) => s.label === "setup-ready"),
				collected: profile.snapshots.at(-1),
			});
			console.error(id);
		}
}
for (const name of ["wide", "json"])
	for (const compression of ["none", "zip"])
		assert.equal(
			new Set(
				cases
					.filter((c) => c.name === name && c.compression === compression)
					.map((c) => c.result.sha256),
			).size,
			1,
		);
await writeFile(
	join(profileDirectory, "summary.json"),
	`${JSON.stringify({ node: process.version, probe, protocol: `Instrumented, ${long ? 99 : 9}-export diagnostic workers; sampled native allocations, buffer copies, setup/export memory, natural GC, stream pending bytes and backing-store finalizers. Explicit GC only after work and connection close. These timings and peaks are not release performance comparisons.`, cases }, null, 2)}\n`,
);
