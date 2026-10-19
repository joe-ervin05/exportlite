import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-memory-next");
const single = process.env.MEMORY_SINGLE === "1";
const output = join(here, single ? "single" : "matched");
await mkdir(output, { recursive: true });
const source = JSON.parse(
	await readFile(
		join(root, "outputs/native-crc/comparison/configuration.json"),
		"utf8",
	),
);
const cases = [
	...["baseline", "batch128", "manual"].flatMap((variant) =>
		["narrow", "wide"].map((fixture) => ({
			fixture,
			scenario: `${fixture}-native`,
			variant,
			orm: false,
			format: "esm",
		})),
	),
	...["baseline", "manual"].map((variant) => ({
		fixture: "wide",
		scenario: "wide-drizzle-esm",
		variant,
		orm: true,
		format: "esm",
	})),
	...["baseline", "batch128", "manual"].map((variant) => ({
		fixture: "json",
		scenario: "json-drizzle-esm",
		variant,
		orm: true,
		format: "esm",
	})),
	...["baseline", "manual"].map((variant) => ({
		fixture: "json",
		scenario: "json-drizzle-cjs",
		variant,
		orm: true,
		format: "cjs",
	})),
	{
		fixture: "json",
		scenario: "json-manual-no-orm",
		variant: "manual",
		orm: false,
		format: "esm",
	},
].filter(
	(c) => !single || (c.variant !== "batch128" && c.fixture !== "narrow"),
);
const builds = {
	baseline: join(here, "baseline/exportlite/dist"),
	batch128: join(here, "candidates/batch128/dist"),
};
const worker = join(root, "exportlite/benchmarks/csv-performance/worker.mjs");
const all = [];
for (let round = 0; round < 5; round++) {
	const order = [
		...cases.slice(round % cases.length),
		...cases.slice(0, round % cases.length),
	];
	for (const compression of ["none", "zip"])
		for (const spec of order) {
			const f = source.fixtures.find((f) => f.name === spec.fixture);
			const fixture = {
				...f,
				drizzle: spec.orm || f.drizzle,
				path: join(root, "outputs/csv-deep/fixtures", `${f.name}.sqlite`),
			};
			const child = spawnSync(
				process.execPath,
				[
					worker,
					"worker",
					JSON.stringify(fixture),
					spec.variant === "manual" ? "manual-tuned" : "table",
					compression,
				],
				{
					encoding: "utf8",
					maxBuffer: 1e6,
					env: {
						...process.env,
						EXPORTLITE_BUILD: builds[spec.variant] ?? builds.baseline,
						CSV_BENCH_DRIZZLE_SETUP: spec.orm ? "matched" : "none",
						CSV_BENCH_DRIZZLE_MODULES: spec.format,
						CSV_BENCH_PACKAGE_FORMAT: spec.format,
						CSV_BENCH_SINGLE: single ? "1" : "0",
					},
				},
			);
			assert.equal(child.status, 0, child.stderr);
			const row = {
				round,
				scenario: spec.scenario,
				variant: spec.variant,
				...JSON.parse(child.stdout),
			};
			if (compression === "none") assert.equal(row.sha256, f.csvSha256);
			all.push(row);
		}
	await writeFile(
		join(output, "all.json"),
		`${JSON.stringify(all, null, 2)}\n`,
	);
	console.error(
		`Completed ${single ? "single-export" : "matched-setup"} round ${round + 1}/5`,
	);
}
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const summary = [];
for (const fixture of ["narrow", "wide", "json"])
	for (const compression of ["none", "zip"]) {
		const group = all.filter(
			(r) => r.fixture === fixture && r.compression === compression,
		);
		if (!group.length) continue;
		assert.equal(new Set(group.map((r) => r.sha256)).size, 1);
		for (const spec of cases.filter((c) => c.fixture === fixture)) {
			const rows = group.filter(
				(r) => r.scenario === spec.scenario && r.variant === spec.variant,
			);
			summary.push({
				scenario: spec.scenario,
				variant: spec.variant,
				compression,
				medianMs: single ? null : median(rows.map((r) => r.medianMs)),
				minMs: single ? null : Math.min(...rows.map((r) => r.medianMs)),
				maxMs: single ? null : Math.max(...rows.map((r) => r.medianMs)),
				medianPeakRssMiB: median(rows.map((r) => r.peakRssMiB)),
				maxPeakRssMiB: Math.max(...rows.map((r) => r.peakRssMiB)),
				medianSetupPeakRssMiB: median(rows.map((r) => r.setupPeakRssMiB)),
				medianSetupRssMiB: median(rows.map((r) => r.setupMemory.rss / 1048576)),
				medianSetupHeapUsedMiB: median(
					rows.map((r) => r.setupMemory.heapUsed / 1048576),
				),
				bytes: rows[0].bytes,
				sha256: rows[0].sha256,
			});
		}
	}
const hash = (b) => createHash("sha256").update(b).digest("hex");
const buildHashes = {};
for (const [variant, dir] of Object.entries(builds)) {
	buildHashes[variant] = {};
	for (const file of (await readdir(dir))
		.filter((n) => /\.(?:mjs|cjs)$/.test(n))
		.sort())
		buildHashes[variant][file] = hash(await readFile(join(dir, file)));
}
await writeFile(
	join(output, "summary.json"),
	`${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
	join(output, "configuration.json"),
	`${JSON.stringify({ node: process.version, nodeSha256: hash(await readFile(process.execPath)), cpu: cpus()[0]?.model, baselineCommit: "62ef56d498e945a3cd720f79edad8097ac293b78", rounds: 5, single, cases, builds: buildHashes, fixtures: source.fixtures.filter((f) => ["narrow", "wide", "json"].includes(f.name)), protocol: single ? "Sequential fresh workers; one hash-verified export each, no warmups or timing claims. Lifetime peak RSS and pre-export setup RSS/peak are recorded separately, without forcing GC or profiling hooks. Same module format and ORM setup for matched package/manual cases." : "Sequential fresh workers, rotating cases; one verification, two warmups, three timed batches of two exports, natural GC. Same Node and immutable fixtures. Time excludes setup and includes public API planning, encoding/ZIP and completion to a counting Node writable. Peak RSS includes setup and all nine exports. No profiling, forced GC or concurrent builds/tests. Both package and manual initialize the same Drizzle schema/driver/module format where specified. The manual-bare reference intentionally skips ORM setup; its output still canonicalizes JSON identically. ZIP settings and native checksum stay fixed. The 128-row candidate is isolated and not shipped." }, null, 2)}\n`,
);
console.log(JSON.stringify({ workers: all.length, cases: summary.length }));
