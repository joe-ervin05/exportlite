import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("./comparison/", import.meta.url);
const data = JSON.parse(readFileSync(new URL("summary.json", dir)));
const config = JSON.parse(readFileSync(new URL("configuration.json", dir)));
const validation = JSON.parse(readFileSync(new URL("validation.json", dir)));
const tests = JSON.parse(
	readFileSync(new URL("./test-results.json", import.meta.url)),
);
assert(validation.passed && tests.success);
const names = {
	"exportlite-turso": "Direct ExportLite/Turso",
	"exportlite-drizzle": "ExportLite Drizzle adapter",
	"turso-stringify": "Turso execute + stringify",
	"drizzle-stringify": "Drizzle all + stringify",
};
const methods = Object.keys(names);
const row = (fixture, method, latency) =>
	data.find(
		(r) => r.name === fixture && r.method === method && r.latencyMs === latency,
	);
const ms = (n) => n.toFixed(2),
	mib = (n) => (n / 2 ** 20).toFixed(2);
const line = [];
const put = (s) => line.push(s);
put("# Turso and Drizzle: simulated latency comparison\n");
put(
	`Measured October 18, 2026, using the exact prior Node **26.12.0** executable and original varied fixture files. Pinned versions, also checked against current npm metadata: **@libsql/client 0.18.0**, **Drizzle 0.45.4**, **better-sqlite3 13.0.3**, SQLite **3.53.4**. Host: ${config.cpu}, ${config.totalMemoryGiB} GiB RAM.\n`,
);
put(
	"This is a local HTTP protocol simulation, not a live Turso Cloud benchmark. It includes actual official-client and Drizzle execution, SQLite work in a separate server process, protocol serialization/decoding, JSON generation, UTF-8 output and awaited export cleanup. It measures uncompressed JSON.\n",
);
put("## Bulk exports\n");
put(
	"Times are the median of three fresh-client-worker medians, with three measured complete exports per worker after verification and one warmup. Every worker has its own separate fresh HTTP/SQLite server process. Peak RSS is the whole client-process high-water mark, including imports, setup, verification, warmup and timed requests; it excludes the coordinator and database server. Memory columns below use the 100 ms latency workers. No forced garbage collection.\n",
);
for (const [fixture, label] of [
	["narrow-plain", "1,000,000 narrow rows"],
	["wide-plain", "100,000 wide rows"],
]) {
	put(`### ${label}\n`);
	put(
		"| Method | 0 ms latency: total ms | 25 ms latency: total ms | 100 ms latency: total ms | 100 ms worker range, ms | Median peak RSS, MiB | Highest RSS, MiB |",
	);
	put("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const method of methods) {
		const r = row(fixture, method, 100);
		put(
			`| ${names[method]} | ${ms(row(fixture, method, 0).totalMs)} | ${ms(row(fixture, method, 25).totalMs)} | ${ms(r.totalMs)} | ${ms(r.minMs)}–${ms(r.maxMs)} | ${r.medianPeakRssMiB.toFixed(1)} | ${r.maxPeakRssMiB.toFixed(1)} |`,
		);
	}
	put("");
	for (const [stream, normal, label] of [
		["exportlite-turso", "turso-stringify", "Direct ExportLite"],
		["exportlite-drizzle", "drizzle-stringify", "The Drizzle adapter"],
	]) {
		const a = row(fixture, stream, 100),
			b = row(fixture, normal, 100);
		put(
			`${label} is **${(b.totalMs / a.totalMs).toFixed(2)}× faster** than its ordinary query-plus-stringify counterpart at 100 ms added latency, with **${((1 - a.maxPeakRssMiB / b.maxPeakRssMiB) * 100).toFixed(1)}% lower highest observed client RSS**.\n`,
		);
	}
}
put("### Peak client RSS at every latency\n");
put("Highest observed process high-water mark across the three workers, in MiB. The CSV also includes median and minimum worker peaks.\n");
put("| Fixture | Method | 0 ms latency | 25 ms latency | 100 ms latency |");
put("| --- | --- | ---: | ---: | ---: |");
for (const fixture of ["narrow-plain", "wide-plain"])
	for (const method of methods)
		put(`| ${fixture} | ${names[method]} | ${row(fixture, method, 0).maxPeakRssMiB.toFixed(1)} | ${row(fixture, method, 25).maxPeakRssMiB.toFixed(1)} | ${row(fixture, method, 100).maxPeakRssMiB.toFixed(1)} |`);
put("");
put("## Small responses and the extra round trip\n");
put(
	"Added latency is applied **once per HTTP request**, never per row or SQLite batch. It models fixed request/response delay; there is no bandwidth cap, TLS, jitter or packet loss. Each ExportLite export uses one cursor request followed by one close request. Ordinary SDK/Drizzle execution combines execute and close in one pipeline request. All paths execute exactly one SQL statement and issue no preflight SQL. ExportLite completion includes the close request.\n",
);
put(
	"| Fixture | Method | 0 ms latency: total ms | 25 ms latency: total ms | 100 ms latency: total ms | Highest RSS at 100 ms, MiB |",
);
put("| --- | --- | ---: | ---: | ---: | ---: |");
for (const [fixture, label] of [
	["table-1", "1 row"],
	["table-10", "10 rows"],
	["table-1000", "1,000 rows"],
])
	for (const method of methods) {
		const r = row(fixture, method, 100);
		put(
			`| ${label} | ${names[method]} | ${ms(row(fixture, method, 0).totalMs)} | ${ms(row(fixture, method, 25).totalMs)} | ${ms(r.totalMs)} | ${r.maxPeakRssMiB.toFixed(1)} |`,
		);
	}
put("");
put(
	"Small-response workers measure three samples of three requests each, after byte verification and one warmup. Small responses consume `Response.arrayBuffer()`; bulk outputs drain to a counting Node writable. Destinations match within every fixture. Small differences in the 0 ms runs are sensitive to HTTP scheduling and process noise.\n",
);
put("## Response sizes and protocol overhead\n");
put(
	"All four paths produce exactly identical final JSON byte lengths and SHA-256 hashes. The response-body bytes crossing the database HTTP connection differ: normal queries encode a typed protocol value for each field, while ExportLite sends one JSON-text value plus a count per 256-row batch. Counts below include the ExportLite close response; HTTP headers and chunk framing are excluded.\n",
);
put(
	"| Fixture | Final JSON, MiB | ExportLite protocol bodies, MiB | Ordinary query protocol bodies, MiB |",
);
put("| --- | ---: | ---: | ---: |");
for (const fixture of ["narrow-plain", "wide-plain"]) {
	const a = row(fixture, "exportlite-turso", 0),
		b = row(fixture, "turso-stringify", 0);
	put(
		`| ${fixture} | ${mib(a.outputBytes)} | ${mib(a.wireResponseBytes)} | ${mib(b.wireResponseBytes)} |`,
	);
}
put("");
put(
	"These wire counts help explain the bulk advantage in this fixture server. They do not establish transfer times over a bandwidth-limited connection.\n",
);
put("## Fairness, validation and limitations\n");
put(
	`- **${validation.workers} sequential fresh client workers**, three per fixture/method/latency combination, with rotated method order; **${validation.totalTimedExports} timed exports**. A separate 16-worker smoke run passed first.`,
);
put(
	"- Official `@libsql/client/http` executes the ordinary Turso queries, and `drizzle-orm/libsql/http` executes the ordinary Drizzle queries. Both use their real buffering/decoding paths. Direct Turso serializes `result.rows` directly with `JSON.stringify()`; Drizzle builds an ordered select, awaits `.all()`, then stringifies the returned objects. No artificial extra row mapping or retained arrays are added.",
);
put(
	"- ExportLite benchmarks use the public table APIs, integer primary-key declarations or Drizzle metadata, fixed 256-row batching and the existing 64 KiB writer. All methods project `id, name, note, active`, in that order, ordered by integer id. Boolean fields use numeric mode to match the existing fixtures.",
);
put(
	"- Every worker validates output byte length and SHA-256; timed exports check output length and ExportLite row counts. Original fixture fingerprints match before and after the run. Package source/build fingerprints match before and after timing.",
);
put(
	"- HTTP traces verify one SQL SELECT per export, no metadata/version/capability queries, two HTTP requests for ExportLite versus one for ordinary queries, 256-row batches and no remaining server sessions.",
);
put(
	"- Client imports, schema declarations and opening SDK/Drizzle wrappers are outside request timing, but are included in peak RSS. Drizzle methods therefore include Drizzle runtime import memory. Server startup and opening the SQLite database are outside timing and client RSS. Reads are warm; these are not cold-start or cold-disk results.",
);
put(
	"- The same benchmark server writes both response formats incrementally with 64 KiB coalescing and honors socket backpressure. It does not buffer the ordinary query result in the server. Its JavaScript protocol framing and serialization can cost more than a native Turso server, particularly for one million typed rows. Total time includes that cost, so these speedup ratios must not be presented as measured Turso Cloud gains. Server traces include response bytes, CPU and request duration for inspection.",
);
put(
	"- A subsequent protocol review confirmed another simulator limitation: the published [libSQL HTTP server](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/hrana/http/mod.rs) collects pipeline results and serializes the complete response before sending it, whereas the fixture writes ordinary pipeline rows incrementally. The simulation therefore does not reproduce that server-side buffering, time to first byte or server memory. Client RSS remains directly measured for the simulated response schedule; a real server's delivery schedule could change both client timing and peak allocations. An incremental client-side pipeline parser would not restore end-to-end streaming on a buffering server. The current [Turso protocol](https://github.com/tursodatabase/turso/blob/main/serverless/PROTOCOL.md#43-stream-retention) retains cursor sessions until close or expiry and provides no close-after-cursor flag.",
);
put(
	"- The fixture server uses a 120-second keep-alive timeout for every method. An initial comparison stopped when the default five-second timeout reset a socket during a large buffered client decode. That interrupted run is excluded. A separate five-export bulk verification passed with the longer timeout before the full comparison was restarted.",
);
put(
	"- Fixed request delay does not reproduce actual TCP flow control, geography, TLS, bandwidth limits, connection setup, cloud query scheduling, serverless cold starts, response limits or concurrent load. Live Turso compatibility and remote performance remain unverified.",
);
put(
	"- Each ExportLite export is an independent read session. The simulation does not change the public API, batch size, output buffering or ZIP settings. Compression is outside this comparison.",
);
put(
	`- Benchmark setup exposed a protocol compatibility check that required an undocumented \`step\` field on \`step_end\`. The [Hrana v3 specification](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md) omits that field. The adapter now accepts the documented message, and the integration fixture sends it. This correction precedes all timing; the **${tests.numPassedTests}-test suite**, ESM/CommonJS builds, public consumer type checks and Biome checks pass. The exact change is preserved in [protocol-compatibility.patch](../../outputs/turso-benchmark/protocol-compatibility.patch).\n`,
);
put("## Reproduce and inspect\n");
put(
	"From the workspace root, use the exact Node executable recorded in configuration.json:\n",
);
put(
	"```sh\n/path/to/node-26.12.0 outputs/turso-benchmark/run.mjs\n/path/to/node-26.12.0 outputs/turso-benchmark/report.mjs\n```\n",
);
put(
	"`--smoke` runs the shorter validation. Running requires permission to bind localhost. All database connections are read-only; no credentials or live cloud resources are used.\n",
);
put("- [Summary CSV](../../outputs/turso-benchmark/comparison/summary.csv)");
put(
	"- [All worker results and server traces](../../outputs/turso-benchmark/comparison/all.json)",
);
put(
	"- [Configuration, versions, method and fingerprints](../../outputs/turso-benchmark/comparison/configuration.json)",
);
put("- [Validation](../../outputs/turso-benchmark/comparison/validation.json)");
put(
	"- [Runner](../../outputs/turso-benchmark/run.mjs), [worker](../../outputs/turso-benchmark/worker.mjs), [server](../../outputs/turso-benchmark/server.mjs)",
);
writeFileSync(
	new URL("../../exportlite/benchmarks/TURSO.md", import.meta.url),
	line.join("\n") + "\n",
);
console.log("Wrote exportlite/benchmarks/TURSO.md");
