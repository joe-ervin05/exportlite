import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const current = JSON.parse(
	readFileSync(new URL("./comparison/summary.json", import.meta.url)),
);
const previous = JSON.parse(
	readFileSync(
		new URL("../turso-benchmark/comparison/summary.json", import.meta.url),
	),
);
const configuration = JSON.parse(
	readFileSync(new URL("./comparison/configuration.json", import.meta.url)),
);
const oldConfiguration = JSON.parse(
	readFileSync(
		new URL(
			"../turso-benchmark/comparison/configuration.json",
			import.meta.url,
		),
	),
);
const validation = JSON.parse(
	readFileSync(new URL("./comparison/validation.json", import.meta.url)),
);
const tests = JSON.parse(
	readFileSync(new URL("./test-results.json", import.meta.url)),
);
assert(validation.passed && tests.success);
assert.equal(configuration.nodeSha256, oldConfiguration.nodeSha256);
for (const fixture of configuration.fixtures.cases) {
	const old = oldConfiguration.fixtures.cases.find(
		(f) => f.name === fixture.name,
	);
	assert.equal(fixture.fixtureSha256, old.fixtureSha256);
	assert.equal(fixture.expected.sha256, old.expected.sha256);
}
const methods = [
	"exportlite-turso",
	"exportlite-drizzle",
	"turso-stringify",
	"drizzle-stringify",
];
const labels = {
	"exportlite-turso": "Direct ExportLite/Turso",
	"exportlite-drizzle": "ExportLite Drizzle adapter",
	"turso-stringify": "Turso execute + stringify",
	"drizzle-stringify": "Drizzle all + stringify",
};
const row = (data, fixture, method, latency) =>
	data.find(
		(r) => r.name === fixture && r.method === method && r.latencyMs === latency,
	);
const ms = (value) => value.toFixed(2);
const lines = [];
const put = (value) => lines.push(value);
put("# Reusable Turso export sessions: implementation and latency benchmark\n");
put(
	"Measured October 18, 2026, on the same Apple M1 Pro / 32 GiB machine, exact Node **26.12.0** executable (verified binary SHA-256), original varied fixture database files (verified SHA-256), SQLite **3.53.4**, `@libsql/client` **0.18.0**, Drizzle **0.45.4**, and `better-sqlite3` **13.0.3**. Current npm versions were checked and the pinned versions retained.\n",
);
put("## Result and API behavior\n");
put(
	"Each client retains one healthy export session. Direct and Drizzle exports on that client serialize when consumption starts, including output completion and cleanup. Each healthy export sends one cursor request containing one SQL SELECT, with no schema or capability preflight. Successful exports keep only the latest baton and base URL. The session is separate from ordinary SDK/Drizzle queries and their transactions; each export reads a fresh snapshot. Fixed 256-row batching, row fallbacks, 64 KiB buffering and ZIP settings are unchanged.\n",
);
put(
	"Use **`await client.close()`** to abort active/queued exports, wait for output and cursor cleanup, and close the retained session. Close is idempotent and reports remote cleanup failure; a completed export and its valid file are unaffected by a later shutdown failure. `await client.reconnect()` drains the old export lifecycle before opening a fresh one. A slow export blocks subsequent exports on that client; different clients remain independent.\n",
);
put(
	"Cancelled/failed exports discard their session before the queue advances. Expiry recovery makes at most one fresh request after a cached baton is rejected with HTTP 404 or legacy HTTP 400 / `STREAM_EXPIRED`, before a cursor header or row is accepted. Other HTTP errors, network failures, SQL errors and partial streams are never replayed. An expired close is treated as already closed. The modern `replication_index` cursor terminator is accepted alongside legacy cursor framing.\n",
);
put("## Timing boundary and shutdown cost\n");
put(
	"**Export times include complete UTF-8 output; client shutdown is measured separately.** This is the intended client-lifetime change: the old implementation awaited close after each export, while the new implementation awaits it at client shutdown. Every worker explicitly awaits shutdown, verifies zero remaining sessions, and records `shutdownMs`. Creating and closing a client for every export still pays a query round trip plus a close round trip. Reuse benefits a client that outlives an individual export.\n",
);
put(
	"All four methods were rerun at **0, 25 and 100 ms added latency per HTTP request**, never per row or SQLite batch. Ordinary Turso/Drizzle execution still combines execute and close in one pipeline request. There is no compression, TLS, bandwidth cap, jitter or packet loss in this local HTTP simulation.\n",
);
put("## Bulk comparison\n");
put(
	"Times are medians of three fresh-worker medians; each bulk worker verifies bytes, warms once, then measures three complete exports. RSS is the whole client-process high-water mark, including imports, verification, warmup, timed requests and shutdown. It excludes the database server and coordinator. Memory columns use the 100 ms workers; the CSV contains every latency's memory measurements.\n",
);
for (const [fixture, label] of [
	["narrow-plain", "1,000,000 narrow rows"],
	["wide-plain", "100,000 wide rows"],
]) {
	put(`### ${label}\n`);
	put(
		"| Method | 0 ms: export ms | 25 ms: export ms | 100 ms: export ms | 100 ms worker range, ms | Median peak RSS, MiB | Highest RSS, MiB |",
	);
	put("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const method of methods) {
		const r = row(current, fixture, method, 100);
		put(
			`| ${labels[method]} | ${ms(row(current, fixture, method, 0).totalMs)} | ${ms(row(current, fixture, method, 25).totalMs)} | ${ms(r.totalMs)} | ${ms(r.minMs)}–${ms(r.maxMs)} | ${r.medianPeakRssMiB.toFixed(1)} | ${r.maxPeakRssMiB.toFixed(1)} |`,
		);
	}
	put("");
}
put("## Change from closing after each export\n");
put(
	"The previous numbers are the preceding matched benchmark, not a concurrent rerun of the old implementation. The comparison therefore includes ordinary run-to-run variation. A 100 ms reduction is the expected structural benefit of removing one close round trip from each successful export; the measured delta need not equal it exactly.\n",
);
put(
	"| Fixture | ExportLite API | Previous 100 ms total, ms | Reuse 100 ms export, ms | Saved, ms | Previous highest RSS, MiB | Reuse highest RSS, MiB |",
);
put("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
for (const fixture of [
	"table-1",
	"table-10",
	"table-1000",
	"narrow-plain",
	"wide-plain",
])
	for (const method of methods.slice(0, 2)) {
		const a = row(previous, fixture, method, 100),
			b = row(current, fixture, method, 100);
		put(
			`| ${fixture} | ${labels[method]} | ${ms(a.totalMs)} | ${ms(b.totalMs)} | ${ms(a.totalMs - b.totalMs)} | ${a.maxPeakRssMiB.toFixed(1)} | ${b.maxPeakRssMiB.toFixed(1)} |`,
		);
	}
put("");
put("### Client shutdown at 100 ms added latency\n");
put(
	"One explicit close request per ExportLite worker/client, outside export timing. A bulk client performs five exports total (verification, warmup and three measured exports); a small client performs eleven. Closing a client per request would add this cost back to the response lifecycle.\n",
);
put("| Fixture | API | Median awaited client close, ms |");
put("| --- | --- | ---: |");
for (const fixture of ["table-1", "narrow-plain", "wide-plain"])
	for (const method of methods.slice(0, 2))
		put(
			`| ${fixture} | ${labels[method]} | ${ms(row(current, fixture, method, 100).shutdownMs)} |`,
		);
put("");
put("## Small responses\n");
put(
	"Each worker measures three samples of three requests after byte verification and one warmup. As in the prior comparison, small outputs consume `Response.arrayBuffer()`; bulk outputs drain to the same counting Node writable.\n",
);
put(
	"| Fixture | Method | 0 ms: export ms | 25 ms: export ms | 100 ms: export ms | Highest RSS at 100 ms, MiB |",
);
put("| --- | --- | ---: | ---: | ---: | ---: |");
for (const fixture of ["table-1", "table-10", "table-1000"])
	for (const method of methods) {
		const r = row(current, fixture, method, 100);
		put(
			`| ${fixture} | ${labels[method]} | ${ms(row(current, fixture, method, 0).totalMs)} | ${ms(row(current, fixture, method, 25).totalMs)} | ${ms(r.totalMs)} | ${r.maxPeakRssMiB.toFixed(1)} |`,
		);
	}
put("");
put("## Validation and limits\n");
put(
	`- **${validation.workers} sequential fresh workers**, three per fixture/method/latency combination, with rotated method order; **${validation.totalTimedExports} timed exports**. A 16-worker smoke run passed first.`,
);
put(
	"- All worker output lengths and SHA-256 hashes match the original fixtures and all four methods. Narrow JSON is 83,369,847 bytes; wide JSON is 100,920,480 bytes. Timed exports check lengths and ExportLite row counts. Fixture and package source/build fingerprints match before and after timing.",
);
put(
	"- Traces verify exactly one SQL statement and cursor request per healthy ExportLite export, no preflights, one opened session per client, baton rotation/reuse, at most one retained session, one close request per client and zero sessions after awaited shutdown. Ordinary queries retain their one execute-plus-close pipeline request per export.",
);
put(
	"- In the CSV, `exportHttpRequests` counts data requests only (one per export). `httpRequests` includes the amortized client-shutdown request: 12/11 for small ExportLite workers and 6/5 for bulk workers. Shutdown has not been eliminated; it has moved to client lifetime and is timed separately.",
);
put(
	`- **${tests.numPassedTests} reliability tests pass on Node 26.12.0**, including serialized direct/Drizzle exports, queued cancellation, no queued-file creation, stalled outputs, independent clients, legacy/modern expiry, bounded recovery, no replay after HTTP/network/SQL/partial-stream failures, awaited/idempotent close, active/idle shutdown failures, reconnect and preservation of completed files. ESM/CommonJS builds, public consumer types and Biome checks pass.`,
);
put(
	"- Whole-process peak RSS includes SDK and optional Drizzle imports, setup and natural GC. No forced collection or artificial retained row arrays. The direct SDK baseline stringifies `result.rows`; normal Drizzle builds an ordered select, awaits `.all()` and stringifies its objects. Imported Drizzle runtime contributes to adapter process memory.",
);
put(
	"- The local server uses actual read-only SQLite and official JSON protocol framing, incrementally coalesced to 64 KiB, with the same 120-second HTTP keep-alive timeout as the preceding completed comparison. Its JavaScript serialization cost affects wall time. The published libSQL server buffers ordinary pipeline results before sending; the fixture streams those bodies, so server memory, response scheduling and time to first byte are not faithfully simulated. See [reference server source](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/hrana/http/mod.rs).",
);
put(
	"- These are local protocol measurements, not verified Turso Cloud gains. Actual network bandwidth, TLS, server implementations, response limits, cold starts and concurrent load remain unmeasured. Idle-expiry recovery and queue contention are tested for correctness but are outside the sequential healthy-session timing matrix. Live Turso compatibility remains unverified.",
);
put(
	"- Queueing changes concurrency: one slow consumer can delay other exports on that client. A client kept idle can lose its cached session and incur one failed request on recovery. Shutdown must be awaited when confirmed cleanup matters; on an unreachable server, expiry remains the final resource cleanup fallback.\n",
);
put("## Reproduce\n");
put(
	"Use the exact Node executable recorded in configuration.json, from the workspace root:\n",
);
put(
	"```sh\n/path/to/node-26.12.0 outputs/turso-session-reuse/run.mjs\n/path/to/node-26.12.0 outputs/turso-session-reuse/report.mjs\n```\n",
);
put(
	"Localhost binding permission is required. Add `--smoke` for the short run. No live credentials or cloud resources are used.\n",
);
put(
	"- [Summary CSV](../../outputs/turso-session-reuse/comparison/summary.csv)",
);
put(
	"- [Worker measurements and HTTP traces](../../outputs/turso-session-reuse/comparison/all.json)",
);
put(
	"- [Configuration, versions and fingerprints](../../outputs/turso-session-reuse/comparison/configuration.json)",
);
put(
	"- [Validation](../../outputs/turso-session-reuse/comparison/validation.json)",
);
put("- [Previous per-export close benchmark](TURSO.md)");
put(
	"- [Runner](../../outputs/turso-session-reuse/run.mjs), [worker](../../outputs/turso-session-reuse/worker.mjs), [server](../../outputs/turso-session-reuse/server.mjs)",
);
writeFileSync(
	new URL("../../exportlite/benchmarks/TURSO-SESSIONS.md", import.meta.url),
	lines.join("\n") + "\n",
);
console.log("Wrote exportlite/benchmarks/TURSO-SESSIONS.md");
