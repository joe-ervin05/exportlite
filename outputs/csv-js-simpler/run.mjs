import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const fixtures = JSON.parse(
	await readFile(
		join(root, "outputs/csv-deep/fixtures/configuration.json"),
		"utf8",
	),
)
	.filter((f) =>
		(process.env.CSV_JS_FIXTURES ?? "narrow,wide").split(",").includes(f.name),
	)
	.map((f) => ({
		...f,
		path: join(
			root,
			"outputs/csv-deep/fixtures",
			`${f.source ?? f.name}.sqlite`,
		),
	}));
assert(fixtures.length);
const variants = (
	process.env.CSV_JS_CASES ?? "sqlite,pairs,joined,buffered,tokens,raw,manual"
).split(",");
const methods = (process.env.BENCH_METHODS ?? "table").split(",");
const compressions = (process.env.BENCH_COMPRESSIONS ?? "none,zip").split(",");
const cases = variants.flatMap((variant) =>
	variant === "manual"
		? [{ variant, method: "manual-tuned" }]
		: methods.map((method) => ({ variant, method })),
);
const output = join(here, process.env.BENCH_OUT ?? "screen");
await mkdir(output);
const rounds = Number(process.env.BENCH_ROUNDS ?? 1);
assert.equal(process.version, "v26.12.0");
assert(Number.isSafeInteger(rounds) && rounds > 0);
const builds = Object.fromEntries(
	variants.map((name) => [
		name,
		name === "before"
			? process.env.EXPORTLITE_BEFORE
			: name === "sqlite" || name === "manual"
				? (process.env.EXPORTLITE_SQLITE_BUILD ?? join(root, "exportlite/dist"))
				: join(here, "projects", name, "exportlite/dist"),
	]),
);
assert(Object.values(builds).every((path) => typeof path === "string" && path));
const hash = (b) => createHash("sha256").update(b).digest("hex");
const worker = join(root, "exportlite/benchmarks/csv-performance/worker.mjs");
const all = [];
for (let round = 0; round < rounds; round++) {
	const order = [
		...cases.slice(round % cases.length),
		...cases.slice(0, round % cases.length),
	];
	for (const f of fixtures)
		for (const compression of compressions)
			for (const spec of order) {
				const child = spawnSync(
					process.execPath,
					[worker, "worker", JSON.stringify(f), spec.method, compression],
					{
						encoding: "utf8",
						maxBuffer: 1e6,
						env: { ...process.env, EXPORTLITE_BUILD: builds[spec.variant] },
					},
				);
				assert.equal(
					child.status,
					0,
					`${f.name} ${compression} ${spec.variant} ${spec.method}: ${child.stderr}`,
				);
				const row = {
					round,
					variant: spec.variant,
					...JSON.parse(child.stdout),
				};
				assert(Number.isFinite(row.medianMs));
				if (compression === "none") {
					assert.equal(row.sha256, f.csvSha256);
					assert.equal(row.bytes, f.bytes);
				}
				all.push(row);
			}
	await writeFile(
		join(output, "all.json"),
		JSON.stringify(all, null, 2) + "\n",
	);
	console.error(`Completed ${round + 1}/${rounds} rounds`);
}
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const summary = [];
for (const f of fixtures)
	for (const compression of compressions) {
		const group = all.filter(
			(r) => r.fixture === f.name && r.compression === compression,
		);
		if (compression === "none")
			assert.equal(new Set(group.map((r) => r.sha256)).size, 1);
		for (const method of ["table", "query", "manual-tuned"]) {
			const same = group.filter((r) => r.method === method);
			if (same.length) assert.equal(new Set(same.map((r) => r.sha256)).size, 1);
		}
		for (const spec of cases) {
			const rows = group.filter(
				(r) => r.variant === spec.variant && r.method === spec.method,
			);
			summary.push({
				fixture: f.name,
				compression,
				...spec,
				medianMs: median(rows.map((r) => r.medianMs)),
				minMs: Math.min(...rows.map((r) => r.medianMs)),
				maxMs: Math.max(...rows.map((r) => r.medianMs)),
				medianPeakRssMiB: median(rows.map((r) => r.peakRssMiB)),
				maxPeakRssMiB: Math.max(...rows.map((r) => r.peakRssMiB)),
				medianSetupRssMiB: median(rows.map((r) => r.setupMemory.rss / 1048576)),
				medianCpuMs: median(rows.map((r) => r.medianCpuMs)),
				bytes: rows[0].bytes,
				sha256: rows[0].sha256,
			});
		}
	}
const buildHashes = {};
for (const [name, path] of Object.entries(builds)) {
	buildHashes[name] = {};
	for (const file of (await readdir(path))
		.filter((f) => /\.(?:mjs|cjs)$/.test(f))
		.sort())
		buildHashes[name][file] = hash(await readFile(join(path, file)));
}
await writeFile(
	join(output, "summary.json"),
	JSON.stringify(summary, null, 2) + "\n",
);
await writeFile(
	join(output, "configuration.json"),
	JSON.stringify(
		{
			node: process.version,
			nodeSha256: hash(await readFile(process.execPath)),
			cpu: cpus()[0]?.model,
			rounds,
			cases,
			compressions,
			fixtures,
			buildHashes,
			workerSha256: hash(await readFile(worker)),
			protocol:
				"Sequential fresh workers, rotating method order. One output verification, two warmups, three timed batches (two exports for bulk data). Same Node/fixtures, natural GC, no profiling hooks or forced GC. Setup excluded from time, included in whole-process peak RSS; matched ESM Drizzle setup. API generation, UTF-8, ZIP and sink completion included; no HTTP/disk. ZIP settings and package native CRC fixed. Manual uses installed unmodified ZIP writer. Raw variant is diagnostic ONLY and does not preserve arbitrary numeric fidelity.",
		},
		null,
		2,
	) + "\n",
);
console.log(
	JSON.stringify({ workers: all.length, cases: summary.length, output }),
);
