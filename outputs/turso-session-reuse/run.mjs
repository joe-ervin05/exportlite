import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = fileURLToPath(new URL(".", import.meta.url));
const node =
	"<node-26.12.0>";
assert.equal(process.version, "v26.12.0");
const fixtures = JSON.parse(readFileSync(`${directory}fixtures.json`));
const methods = [
	"exportlite-turso",
	"exportlite-drizzle",
	"turso-stringify",
	"drizzle-stringify",
];
const latencies = [0, 25, 100];
const smoke = process.argv.includes("--smoke");
const verifyBulk = process.argv.includes("--verify-bulk");
const rounds = smoke || verifyBulk ? 1 : 3;
const output = `${directory}${smoke ? "smoke" : verifyBulk ? "verify-bulk" : "comparison"}/`;
mkdirSync(`${output}raw`, { recursive: true });
const digest = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");
for (const f of fixtures.cases) assert.equal(digest(f.path), f.fixtureSha256);
const tracked = [
	"exportlite/package.json",
	"exportlite/pnpm-lock.yaml",
	"outputs/turso-session-reuse/server.mjs",
	"outputs/turso-session-reuse/worker.mjs",
	"outputs/turso-session-reuse/run.mjs",
	"outputs/turso-session-reuse/fixtures.json",
];
for (const dir of ["exportlite/src", "exportlite/dist"]) {
	const visit = (path) => {
		for (const entry of readdirSync(root + path, { withFileTypes: true })) {
			const next = `${path}/${entry.name}`;
			if (entry.isDirectory()) visit(next);
			else tracked.push(next);
		}
	};
	visit(dir);
}
const fingerprints = Object.fromEntries(
	tracked.map((p) => [p, digest(root + p)]),
);
const jobs = [];
for (let round = 0; round < rounds; round++)
	for (const [fi, f] of fixtures.cases.entries())
		for (const [li, latency] of latencies.entries()) {
			if (
				smoke &&
				!(
					(latency === 0 &&
						["table-1", "narrow-plain", "wide-plain"].includes(f.name)) ||
					(latency === 100 && f.name === "table-1")
				)
			)
				continue;
			if (verifyBulk && !(f.name === "narrow-plain" && latency === 0)) continue;
			const offset = (round + fi + li) % methods.length;
			for (const method of [
				...methods.slice(offset),
				...methods.slice(0, offset),
			]) {
				if (verifyBulk && method !== "drizzle-stringify") continue;
				jobs.push({ name: f.name, method, latency, round });
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
	methods,
	latencies,
	rounds,
	jobs,
	fingerprints,
	versionsChecked: {
		date: "2026-10-18",
		"@libsql/client": "0.18.0",
		"drizzle-orm": "0.45.4",
		"better-sqlite3": "13.0.3",
		source: "npm registry latest metadata; existing pinned versions retained",
	},
	methodology:
		"Sequential fresh client workers with a separate fresh HTTP/SQLite server process per worker. Whole-client-process maxRSS excludes database server and coordinator. Each worker verifies output SHA-256, performs one warmup, then takes three timed samples (three requests/sample for 1/10/1000 rows; one request/sample for bulk). Natural GC, no forced collection. Time includes query construction, one cursor HTTP request per healthy ExportLite export, protocol decode, JSON generation, UTF-8 encoding and completed drain to matching destinations. One reusable export session per client. Awaitable client close is measured separately after all exports; its single cleanup HTTP request is excluded from individual export times but included in client peak RSS. Creating and closing a client per export still pays both round trips. Imports, client/schema/Drizzle initialization and server startup are outside timing but client imports are included in RSS. Fixed 256-row batches and 64KiB buffering. No compression, disk output, TLS, bandwidth cap, jitter or packet loss. Fixed latency is added once to every HTTP request on the server, not per record or SQL batch. Protocol responses are written incrementally in 64KiB chunks for both cursor and ordinary pipeline requests. This JS fixture endpoint is not an actual Turso server; its response framing/serialization CPU can affect total time.",
};
writeFileSync(
	`${output}configuration.json`,
	JSON.stringify(configuration, null, 2) + "\n",
);
const all = [];
for (const [ji, job] of jobs.entries()) {
	const f = fixtures.cases.find((f) => f.name === job.name);
	const stem = `${job.name}-${job.method}-lat${job.latency}-r${job.round}`;
	const server = spawn(
		node,
		[`${directory}server.mjs`, f.path, String(job.latency)],
		{ cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"] },
	);
	try {
		const ready = await message(server, "ready");
		assert.equal(ready.sqlite, "3.53.4");
		assert.equal(ready.driver, "13.0.3");
		const file = `${output}raw/${stem}.json`;
		const child = spawn(
			node,
			[
				`${directory}worker.mjs`,
				job.name,
				job.method,
				ready.url,
				String(job.latency),
				file,
				smoke ? "1" : "",
			],
			{ cwd: root, stdio: "inherit" },
		);
		await exited(child);
		const result = JSON.parse(readFileSync(file));
		const id = randomUUID();
		const pending = message(server, "stats", id);
		server.send({ type: "stats", id });
		const stats = await pending;
		assert.equal(stats.active, 0);
		assert.equal(stats.sessions, 0);
		assert(
			stats.records.every((r) => !r.error),
			"Server error",
		);
		const expectedHttp =
			result.requests + (job.method.startsWith("exportlite") ? 1 : 0);
		assert.equal(stats.records.length, expectedHttp);
		assert.equal(stats.records.flatMap((r) => r.sql).length, result.requests);
		assert(
			stats.records
				.flatMap((r) => r.sql)
				.every((sql) => !/pragma|sqlite_version|sqlite_schema/i.test(sql)),
			"Unexpected preflight SQL",
		);
		if (job.method.startsWith("exportlite")) {
			assert.equal(stats.openedSessions, 1);
			assert.equal(stats.reusedRequests, result.requests - 1);
			assert.equal(stats.maxSessions, 1);
			assert.equal(
				stats.records.filter((r) => r.path.endsWith("pipeline")).length,
				1,
			);
			assert(
				stats.records
					.filter((r) => r.path === "/v3/cursor")
					.every(
						(r) =>
							r.batchRows === f.rows && r.batches === Math.ceil(f.rows / 256),
					),
			);
			assert(
				stats.records
					.filter((r) => r.path.endsWith("pipeline"))
					.every(
						(r) => r.sql.length === 0 && r.requestTypes.join(",") === "close",
					),
			);
		} else
			assert(
				stats.records.every(
					(r) =>
						r.path === "/v2/pipeline" &&
						r.requestTypes.join(",") === "execute,close",
				),
			);
		result.server = stats;
		result.round = job.round;
		result.wireResponseBytesPerExport =
			stats.records.reduce((sum, r) => sum + r.bytes, 0) / result.requests;
		result.httpRequestsPerExport = stats.records.length / result.requests;
		result.exportHttpRequests =
			stats.records.filter((r) => r.sql.length > 0).length / result.requests;
		writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
		all.push(result);
		writeFileSync(`${output}all.json`, JSON.stringify(all, null, 2) + "\n");
		console.log(`Completed ${ji + 1}/${jobs.length}`);
	} catch (error) {
		const id = randomUUID();
		const pending = message(server, "stats", id);
		server.send({ type: "stats", id });
		const stats = await pending;
		writeFileSync(
			`${output}raw/${stem}.failure.json`,
			JSON.stringify({ job, error: String(error), server: stats }, null, 2) +
				"\n",
		);
		throw error;
	} finally {
		const done = exited(server);
		server.send({ type: "stop" });
		await done;
	}
}
for (const [path, hash] of Object.entries(fingerprints))
	assert.equal(digest(root + path), hash, path);
for (const f of fixtures.cases) assert.equal(digest(f.path), f.fixtureSha256);
const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const f of fixtures.cases)
	for (const latency of latencies)
		for (const method of methods) {
			const rows = all.filter(
				(r) =>
					r.name === f.name && r.method === method && r.latencyMs === latency,
			);
			if (!rows.length) continue;
			assert.equal(rows.length, rounds);
			const times = rows.map((r) => r.median.perRequestMs),
				rss = rows.map((r) => r.peakRssMiB);
			summary.push({
				name: f.name,
				rows: f.rows,
				latencyMs: latency,
				method,
				workers: rows.length,
				totalMs: median(times),
				minMs: Math.min(...times),
				maxMs: Math.max(...times),
				medianPeakRssMiB: median(rss),
				maxPeakRssMiB: Math.max(...rss),
				minPeakRssMiB: Math.min(...rss),
				initialRssMiB: median(rows.map((r) => r.initialMemory.rss / 2 ** 20)),
				outputBytes: f.expected.bytes,
				sha256: f.expected.sha256,
				httpRequests: rows[0].httpRequestsPerExport,
				exportHttpRequests: rows[0].exportHttpRequests,
				shutdownMs: median(rows.map((r) => r.shutdownMs)),
				wireResponseBytes: rows[0].wireResponseBytesPerExport,
			});
		}
writeFileSync(`${output}summary.json`, JSON.stringify(summary, null, 2) + "\n");
const keys = Object.keys(summary[0]);
writeFileSync(
	`${output}summary.csv`,
	keys.join(",") +
		"\n" +
		summary.map((r) => keys.map((k) => r[k]).join(",")).join("\n") +
		"\n",
);
writeFileSync(
	`${output}validation.json`,
	JSON.stringify(
		{
			passed: true,
			workers: all.length,
			verifiedBytes: all.length,
			fixtureFingerprintsUnchanged: true,
			packageFingerprintsUnchanged: true,
			totalTimedExports: all.reduce(
				(sum, r) => sum + r.samples.reduce((sum, s) => sum + s.requests, 0),
				0,
			),
			allSessionsClosed: true,
		},
		null,
		2,
	) + "\n",
);
console.log(
	`Finished ${jobs.length} workers; identical-byte validation and source/fixture fingerprint checks passed.`,
);

function message(child, type, id) {
	return new Promise((resolve, reject) => {
		const clean = () => {
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onMessage = (m) => {
			if (m.type === type && (!id || m.id === id)) {
				clean();
				resolve(m);
			}
		};
		const onError = (e) => {
			clean();
			reject(e);
		};
		const onExit = (code) => onError(Error(`Server exited early: ${code}`));
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}
function exited(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(Error(`Process failed: ${code}`)),
		);
	});
}
