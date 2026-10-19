import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = fileURLToPath(new URL(".", import.meta.url));
const node =
	"<node-26.12.0>";
const fixtures = JSON.parse(readFileSync(`${directory}fixtures.json`, "utf8"));
const smoke = process.argv.includes("--smoke");
if (smoke)
	fixtures.cases = fixtures.cases.filter((row) =>
		["table-1", "narrow-plain", "wide-plain"].includes(row.name),
	);
const rounds = smoke ? 1 : 5;
const output = `${directory}${smoke ? "smoke" : "comparison"}/`;
mkdirSync(`${output}raw`, { recursive: true });
const digest = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");
for (const fixture of fixtures.cases)
	assert.equal(
		digest(fixture.path),
		fixture.fixtureSha256 ?? fixtures.smallFixtureSha256,
	);
const tracked = [
	"exportlite/package.json",
	"exportlite/pnpm-lock.yaml",
	"exportlite/tsdown.config.ts",
	"exportlite/benchmarks/matched-api/package.json",
	"exportlite/benchmarks/matched-api/package-lock.json",
	"outputs/drizzle-adapter-benchmark/worker.mjs",
	"outputs/drizzle-adapter-benchmark/run.mjs",
	"outputs/drizzle-adapter-benchmark/fixtures.json",
];
for (const dir of ["exportlite/src", "exportlite/dist"]) {
	const visit = (path) => {
		for (const entry of readdirSync(`${root}${path}`, {
			withFileTypes: true,
		})) {
			const child = `${path}/${entry.name}`;
			if (entry.isDirectory()) visit(child);
			else tracked.push(child);
		}
	};
	visit(dir);
}
const fingerprints = Object.fromEntries(
	tracked.map((file) => [file, digest(`${root}${file}`)]),
);
const jobs = [];
for (let repeat = 0; repeat < rounds; repeat++) {
	for (const [caseIndex, fixture] of fixtures.cases.entries()) {
		const primary = fixture.methods.slice(0, 3);
		const offset = (repeat + caseIndex) % primary.length;
		const controls = fixture.methods.slice(3);
		if (repeat % 2) controls.reverse();
		for (const method of [
			...primary.slice(offset),
			...primary.slice(0, offset),
			...controls,
		])
			jobs.push({ name: fixture.name, method, repeat });
	}
}
const configuration = {
	date: new Date().toISOString(),
	node,
	nodeSha256: digest(node),
	cpu: cpus()[0].model,
	totalMemoryGiB: totalmem() / 2 ** 30,
	loadavg: loadavg(),
	fixtures,
	jobs,
	fingerprints,
	versionsChecked: {
		date: "2026-10-18",
		drizzle: {
			version: "0.45.4",
			source: "https://www.npmjs.com/package/drizzle-orm?activeTab=versions",
		},
		betterSqlite3: {
			version: "13.0.3",
			source: "https://www.npmjs.com/package/better-sqlite3?activeTab=versions",
		},
	},
	schedule:
		"Sequential fresh worker processes; rotate the three main methods per case and round, alternate the additional controls. Five workers per case/method, each verifies bytes/SHA-256, warms, then measures three request batches. Same fixture files and exact Node 26.12.0. Small cases use Response.arrayBuffer; bulk cases drain to a counting Node writable. All methods include JSON generation and UTF-8 output. Normal Drizzle constructs a query per request, calls all(), JSON.stringify(), and encodes the full text. Source schema/column declaration and connection/Drizzle initialization are outside timing. Fixed 256-row table batching and 64 KiB buffering are unchanged. Both query-export controls use row streaming. The drizzle-host control imports Drizzle, declares the same schema and wraps the native connection, then calls direct ExportLite on that connection. Natural GC, no forced collection. Peak RSS is whole-worker high-water including imports, validation, warmup and timed requests. No ZIP, HTTP, disk output or remote latency.",
};
writeFileSync(
	`${output}configuration.json`,
	`${JSON.stringify(configuration, null, 2)}\n`,
);
const all = [];
const validation = [];
for (const job of jobs) {
	const file = `${output}raw/${job.name}-${job.method}-${job.repeat}.json`;
	await new Promise((resolve, reject) => {
		const child = spawn(
			node,
			[`${directory}worker.mjs`, job.name, job.method, file],
			{ cwd: root, stdio: "inherit" },
		);
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`Worker failed: ${code}`)),
		);
	});
	const result = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(result.environment.node, "v26.12.0");
	assert.equal(result.environment.sqlite, "3.53.4");
	assert.equal(result.environment.driver, "13.0.3");
	if (job.method.startsWith("drizzle"))
		assert.equal(result.environment.drizzle, "0.45.4");
	all.push({ ...result, repeat: job.repeat });
	validation.push({ ...job, ...result.verification, passed: true });
	writeFileSync(
		`${output}validation.json`,
		`${JSON.stringify(validation, null, 2)}\n`,
	);
}
writeFileSync(`${output}all.json`, `${JSON.stringify(all, null, 2)}\n`);
const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const fixture of fixtures.cases)
	for (const method of fixture.methods) {
		const group = all.filter(
			(row) => row.name === fixture.name && row.method === method,
		);
		assert.equal(group.length, rounds);
		const times = group.map((row) => row.median.perRequestMs);
		const rss = group.map((row) => row.peakRssMiB);
		summary.push({
			name: fixture.name,
			method,
			rows: fixture.rows,
			workers: group.length,
			perRequestMs: median(times),
			minMs: Math.min(...times),
			maxMs: Math.max(...times),
			peakRssMiB: median(rss),
			minRssMiB: Math.min(...rss),
			maxRssMiB: Math.max(...rss),
			initialRssMiB: median(
				group.map((row) => row.initialMemory.rss / 2 ** 20),
			),
			outputBytes: group[0].verification.bytes,
			sha256: group[0].verification.sha256,
		});
	}
for (const fixture of fixtures.cases) {
	const rows = summary.filter((row) => row.name === fixture.name);
	for (const row of rows) {
		assert.equal(row.outputBytes, rows[0].outputBytes);
		assert.equal(row.sha256, rows[0].sha256);
	}
}
for (const [file, hash] of Object.entries(fingerprints))
	assert.equal(digest(`${root}${file}`), hash, file);
for (const fixture of fixtures.cases)
	assert.equal(
		digest(fixture.path),
		fixture.fixtureSha256 ?? fixtures.smallFixtureSha256,
	);
writeFileSync(`${output}summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
const csv = [
	"case,method,rows,workers,median_ms,min_ms,max_ms,median_peak_rss_mib,min_rss_mib,max_rss_mib,initial_rss_mib,output_bytes",
];
for (const row of summary)
	csv.push(
		[
			row.name,
			row.method,
			row.rows,
			row.workers,
			row.perRequestMs,
			row.minMs,
			row.maxMs,
			row.peakRssMiB,
			row.minRssMiB,
			row.maxRssMiB,
			row.initialRssMiB,
			row.outputBytes,
		].join(","),
	);
writeFileSync(`${output}summary.csv`, `${csv.join("\n")}\n`);
console.log(
	`Finished ${jobs.length} workers; ${validation.length} identical-byte validations passed.`,
);
