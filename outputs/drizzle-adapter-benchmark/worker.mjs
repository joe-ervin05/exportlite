import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
	`${root}exportlite/benchmarks/matched-api/package.json`,
);
const Database = require("better-sqlite3");
assert.equal(process.version, "v26.12.0");
const [name, method, output] = process.argv.slice(2);
const fixture = JSON.parse(
	readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
).cases.find((row) => row.name === name);
assert(fixture);
assert(fixture.methods.includes(method));

// Each worker imports only the libraries used by its method. Native connections
// come from the same Node-26-compatible benchmark driver in every worker.
let api;
let drizzle;
let table;
let columns;
const usesDrizzle =
	method.startsWith("drizzle") || method.endsWith("-drizzle-host");
if (usesDrizzle) {
	({ drizzle } = await import(
		`${root}exportlite/node_modules/drizzle-orm/better-sqlite3/index.js`
	));
	const { integer, text, sqliteTable } = await import(
		`${root}exportlite/node_modules/drizzle-orm/sqlite-core/index.js`
	);
	table = sqliteTable(fixture.table, {
		id: integer().primaryKey(),
		name: text(),
		note: text(),
		active: integer(),
	});
	columns = {
		id: table.id,
		name: table.name,
		note: table.note,
		active: table.active,
	};
	if (method.startsWith("drizzle-adapter"))
		api = await import(`${root}exportlite/dist/drizzle.mjs`);
}
if (method.startsWith("exportlite")) {
	api = await import(`${root}exportlite/dist/index.mjs`);
	columns = {
		id: api.integer().primaryKey(),
		name: api.text(),
		note: api.text(),
		active: api.integer(),
	};
}

const tableName = `"${fixture.table.replaceAll('"', '""')}"`;
const sourceSql = `SELECT id,name,note,active FROM main.${tableName} ORDER BY id`;
const context = (client) => ({
	client,
	orm: drizzle ? drizzle(client) : undefined,
});
const persistent = fixture.cold
	? undefined
	: context(new Database(fixture.path, { readonly: true }));
const initialMemory = process.memoryUsage();
const makeQuery = (orm) => orm.select(columns).from(table).orderBy(table.id);

async function consume(connection, verify) {
	const hash = verify ? createHash("sha256") : undefined;
	let bytes = 0;
	let stream;
	const options = { columns, format: "json" };
	const sink =
		fixture.rows > 1000
			? new Writable({
					write(chunk, _encoding, callback) {
						bytes += chunk.length;
						hash?.update(chunk);
						callback();
					},
				})
			: undefined;
	const destination = sink ? { output: sink, end: true } : {};
	let result;
	switch (method) {
		case "exportlite-table":
		case "exportlite-table-drizzle-host":
			result = await api.exportTable(connection.client, fixture.table, {
				...options,
				...destination,
			});
			break;
		case "drizzle-adapter-table":
			result = await api.exportTable(connection.orm, table, {
				...options,
				...destination,
			});
			break;
		case "exportlite-query":
			result = await api.exportQuery(connection.client, {
				...options,
				...destination,
				sql: sourceSql,
			});
			break;
		case "drizzle-adapter-query":
			result = await api.exportQuery(
				connection.orm,
				makeQuery(connection.orm),
				{ format: "json", ...destination },
			);
			break;
		case "drizzle-stringify": {
			// Normal buffered Drizzle, then ordinary JSON serialization and UTF-8
			// encoding. Do not retain the row array artificially after stringify.
			const text = JSON.stringify(makeQuery(connection.orm).all());
			if (sink) {
				sink.end(Buffer.from(text, "utf8"));
				await finished(sink, { cleanup: true });
			} else {
				const buffer = await new Response(text).arrayBuffer();
				bytes = buffer.byteLength;
				hash?.update(new Uint8Array(buffer));
			}
			break;
		}
		default:
			throw new Error(`Unknown method ${method}`);
	}
	if (method !== "drizzle-stringify") {
		if (sink) {
			assert.equal(result.rowsExported, fixture.rows);
			assert.equal(result.bytesWritten, bytes);
		} else {
			stream = result;
			const buffer = await new Response(stream).arrayBuffer();
			bytes = buffer.byteLength;
			hash?.update(new Uint8Array(buffer));
			assert.equal((await stream.result).rowsExported, fixture.rows);
		}
	}
	return { bytes, sha256: hash?.digest("hex") };
}

async function once(verify = false) {
	// Connection creation, Drizzle wrapping and close are outside request timing.
	const connection =
		persistent ?? context(new Database(fixture.path, { readonly: true }));
	try {
		const start = performance.now();
		const result = await consume(connection, verify);
		return { ...result, totalMs: performance.now() - start };
	} finally {
		if (!persistent) connection.client.close();
	}
}

try {
	const verification = await once(true);
	assert.equal(verification.bytes, fixture.expected.bytes);
	assert.equal(verification.sha256, fixture.expected.sha256);
	for (let i = 0; i < fixture.warmups; i++) await once();
	const samples = [];
	for (let sample = 0; sample < 3; sample++) {
		let totalMs = 0;
		for (let repeat = 0; repeat < fixture.iterations; repeat++) {
			const result = await once();
			assert.equal(result.bytes, fixture.expected.bytes);
			totalMs += result.totalMs;
		}
		samples.push({
			totalMs,
			perRequestMs: totalMs / fixture.iterations,
			requests: fixture.iterations,
		});
	}
	const memory = process.memoryUsage();
	const peakRssMiB = process.resourceUsage().maxRSS / 1024;
	const probe =
		persistent?.client ?? new Database(fixture.path, { readonly: true });
	const sqlite = probe.prepare("SELECT sqlite_version()").pluck().get();
	if (!persistent) probe.close();
	const result = {
		name,
		method,
		fixture,
		verification,
		samples,
		median: [...samples].sort((a, b) => a.perRequestMs - b.perRequestMs)[1],
		initialMemory,
		finalMemory: memory,
		peakRssMiB,
		environment: {
			node: process.version,
			sqlite,
			driver: require("better-sqlite3/package.json").version,
			drizzle: usesDrizzle
				? JSON.parse(
						readFileSync(
							`${root}exportlite/node_modules/drizzle-orm/package.json`,
							"utf8",
						),
					).version
				: undefined,
		},
		note: "Total includes per-request statement/query construction, SQL execution, JSON generation, UTF-8 encoding and draining the result. Small cases consume Response.arrayBuffer; bulk cases use an identical counting Node writable. Imports, schema/column declaration and connection/Drizzle construction are outside timing but included in whole-process peak RSS. Natural GC; no forced collection. Verification and warmup precede three measured request batches. Query builders are constructed on every adapter-query/Drizzle request; no prepared-query or result cache is used. No ZIP, disk output, HTTP or remote latency.",
	};
	writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
	console.log(
		`${name} ${method}: ${result.median.perRequestMs.toFixed(4)} ms, ${peakRssMiB.toFixed(1)} MiB peak RSS`,
	);
} finally {
	persistent?.client.close();
}
