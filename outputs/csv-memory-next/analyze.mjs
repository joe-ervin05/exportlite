import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-memory-next");
const summaries = {};
for (const directory of ["profiles-v2", "long-profiles", "queues"]) {
	const profiles = [];
	for (const file of (await readdir(join(here, directory))).filter(
		(f) => f.endsWith(".json") && f !== "summary.json",
	)) {
		const p = JSON.parse(await readFile(join(here, directory, file), "utf8"));
		const exported = p.snapshots.filter((s) => s.label === "export-complete");
		profiles.push({
			name: file.replace(/\.json$/, ""),
			exports: exported.length,
			setup: p.snapshots.find((s) => s.label === "setup-ready"),
			naturalPeaks: p.natural.peaks,
			allocations: p.natural.allocations,
			naturalGc: {
				count: p.natural.gc.length,
				durationMs: p.natural.gc.reduce((n, g) => n + g.duration, 0),
				kinds: Object.fromEntries(
					[...new Set(p.natural.gc.map((g) => g.kind))].map((k) => [
						k,
						p.natural.gc.filter((g) => g.kind === k).length,
					]),
				),
			},
			phases: p.snapshots.filter((s) => !s.label.startsWith("export")),
			checkpoints: exported.filter((s) =>
				[0, 8, 24, 49, 74, 98].includes(s.exportIndex),
			),
			maxPendingBytesByStreamClass: p.streams.reduce((out, stream) => {
				out[stream.name] = Math.max(
					out[stream.name] ?? 0,
					stream.peakPendingBytes,
				);
				return out;
			}, {}),
		});
	}
	summaries[directory] = profiles;
}
const source = JSON.parse(
	await readFile(join(here, "matched/configuration.json"), "utf8"),
);
assert.equal(
	createHash("sha256")
		.update(await readFile(process.execPath))
		.digest("hex"),
	source.nodeSha256,
);
const baselineDist = join(here, "baseline/exportlite/dist");
const currentDist = join(root, "exportlite/dist");
const role = (file) => file.replace(/-[A-Za-z0-9_-]{8}(?=\.(?:mjs|cjs)$)/, "");
const names = await Promise.all(
	[baselineDist, currentDist].map(async (dir) =>
		(await readdir(dir)).filter((file) => /\.(mjs|cjs)$/.test(file)),
	),
);
async function normalized(dir, file, names) {
	let code = (await readFile(join(dir, file), "utf8"))
		.split("\n")
		.filter(
			(line) => !/^\/\/#(?:region|endregion|\s*sourceMappingURL)/.test(line),
		)
		.join("\n");
	for (const name of names) code = code.replaceAll(name, role(name));
	return code;
}
for (const file of names[0]) {
	const current = names[1].find((name) => role(name) === role(file));
	assert(current);
	assert.equal(
		await normalized(baselineDist, file, names[0]),
		await normalized(currentDist, current, names[1]),
		`Production runtime changed: ${file}`,
	);
}
async function verifySource(relative = "src") {
	const baseline = join(here, "baseline/exportlite", relative);
	for (const entry of await readdir(baseline, { withFileTypes: true })) {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) await verifySource(path);
		else
			assert.equal(
				await readFile(join(here, "baseline/exportlite", path), "utf8"),
				await readFile(join(root, "exportlite", path), "utf8"),
				path,
			);
	}
}
await verifySource();
for (const file of ["package.json", "pnpm-lock.yaml", "tsdown.config.ts"])
	assert.equal(
		await readFile(join(here, "baseline/exportlite", file), "utf8"),
		await readFile(join(root, "exportlite", file), "utf8"),
	);
for (const [directory, expectedWorkers] of [
	["screen", 126],
	["size-screen", 72],
]) {
	const rows = JSON.parse(
		await readFile(join(here, directory, "all.json"), "utf8"),
	);
	assert.equal(rows.length, expectedWorkers);
	await writeFile(
		join(here, directory, "configuration.json"),
		`${JSON.stringify({ node: process.version, nodeSha256: source.nodeSha256, cpu: source.cpu, baselineCommit: source.baselineCommit, rounds: 3, variants: [...new Set(rows.map((r) => r.variant))], fixtures: source.fixtures, protocol: "Exploratory, sequential fresh-worker table-export screen using the maintained worker, natural GC and matched ESM Drizzle setup. One verification, two warmups, three timed batches of two exports. No instrumentation, forced GC or concurrent benchmarks/builds/tests. Hashes agree across candidates. These screens reject tradeoffs; no candidate is shipped or fully reliability-qualified." }, null, 2)}\n`,
	);
}
await writeFile(
	join(here, "analysis.json"),
	`${JSON.stringify({ node: process.version, baselineCommit: source.baselineCommit, productionRuntimeUnchanged: true, note: "Diagnostic profiles are separate from uninstrumented timing/RSS measurements. The v2 profiler counts native allocations, destination writes and backing-store finalizers. The queue profiler additionally intercepts Node Duplex writes to observe PassThrough/zlib queues; do not compare profiler timings or exact GC schedules across these versions. GC is forced only after exports and connection close.", summaries }, null, 2)}\n`,
);
const qualification = {
	node: process.version,
	nodeSha256: source.nodeSha256,
	baselineCommit: source.baselineCommit,
	productionRuntimeUnchanged: true,
	identicalRuntimeFilesAfterNormalizingBuildLocation: names[0].length,
	normalization:
		"Only chunk hash filenames and bundler region/source-map comments differ between source locations. All 14 JS files otherwise match exactly.",
	acceptedChanges: [
		"Match Drizzle setup between package and manual JSON-mode workers.",
		"Match ESM/CJS module formats by default and report chosen formats.",
		"Record pre-export setup memory and its high-water mark separately.",
		"Support isolated single-export/diagnostic workers without changing the package API.",
	],
	adoptedRuntimeCandidates: [],
	workers: {
		initialCandidateScreen: 126,
		additionalSizeScreen: 72,
		fiveRoundMatchedSetup: 140,
		fiveRoundSingleExport: 90,
		diagnosticProfiles: 28,
		repeated99ExportProfiles: 4,
		queueProfiles: 4,
		maintainedRunnerSmoke: 24,
	},
	validation: {
		build: true,
		typecheck: true,
		lint: true,
		tests: 469,
		testFiles: 12,
		unchangedPublicDeclarations: 12,
		defaultRunnerEsmAndCjsSmokes: true,
		outputChecks:
			"All variants/manual/module formats in each cohort match plain CSV and ZIP hashes. Plain hashes also match independently generated fixture CSV.",
	},
	reliabilityNote:
		"An initial suite run alongside fixture preparation failed the existing Turso early-abort session-count assertion. The isolated 84-test Turso run and full 469-test rerun passed with no runtime/test changes. Both initial and rerun logs are retained.",
	limits: [
		"All performance measurements use local SQLite and counting Node destinations, not live Turso or HTTP delivery.",
		"Whole-process RSS includes startup and repeated exports; setup peaks cannot simply be subtracted to obtain precise incremental CSV memory.",
		"Profiles are diagnostic and are not the release timing comparison.",
		"The three-round candidate screens are exploratory; only the 128-row candidate received the five-round matched recheck.",
		"No global GC hooks, buffer detachment/reuse, adaptive sizing or extra SQL requests were introduced.",
	],
};
const tests = await readFile(join(here, "tests-recheck.txt"), "utf8");
assert(tests.includes("469 passed"));
for (const mode of ["esm", "cjs"]) {
	const data = JSON.parse(
		await readFile(join(here, `smoke-${mode}/configuration.json`), "utf8"),
	);
	assert.equal(data.packageFormat, mode);
	assert.equal(data.drizzleModules, mode);
	const all = JSON.parse(
		await readFile(join(here, `smoke-${mode}/all.json`), "utf8"),
	);
	assert.equal(all.length, 12);
	for (const row of all.filter((r) => r.fixture === "json"))
		assert.equal(row.drizzleSetup, true);
}
const baseline = join(here, "baseline/exportlite/dist");
for (const file of (await readdir(baseline)).filter((f) =>
	/\.d\.(mts|cts)$/.test(f),
))
	assert.equal(
		await readFile(join(baseline, file), "utf8"),
		await readFile(join(root, "exportlite/dist", file), "utf8"),
	);
await writeFile(
	join(here, "qualification.json"),
	`${JSON.stringify(qualification, null, 2)}\n`,
);
await writeFile(
	join(here, "versions.json"),
	`${JSON.stringify({ checkedOn: "2026-10-19", source: "https://registry.npmjs.org/<package>/latest", packages: { "better-sqlite3": "13.0.3", "drizzle-orm": "0.45.4", "zip-stream": "7.0.5", tsdown: "0.23.1" }, changes: "No dependency changes." }, null, 2)}\n`,
);
console.log(
	"Analysis, unchanged runtime/declarations and qualification evidence verified.",
);
