import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [name, method, url, latency, output, smoke] = process.argv.slice(2);
assert.equal(process.version, "v26.12.0");
const fixture = JSON.parse(
	readFileSync(new URL("./fixtures.json", import.meta.url)),
).cases.find((row) => row.name === name);
assert(fixture);
const isExport = method.startsWith("exportlite");
const usesDrizzle = method.includes("drizzle");
let api, columns, table, orm;
let client;
if (isExport) {
	const factory = await import(`${root}exportlite/dist/turso.mjs`);
	client = factory.createClient({ url });
	api = factory;
	const core = await import(`${root}exportlite/dist/index.mjs`);
	columns = {
		id: core.integer().primaryKey(),
		name: core.text(),
		note: core.text(),
		active: core.integer(),
	};
} else {
	const factory = await import(
		`${root}exportlite/node_modules/@libsql/client/lib-esm/http.js`
	);
	client = factory.createClient({ url });
}
if (usesDrizzle) {
	const { drizzle } = await import(
		`${root}exportlite/node_modules/drizzle-orm/libsql/http/index.js`
	);
	const { sqliteTable, integer, text } = await import(
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
	orm = drizzle(client);
	if (isExport) api = await import(`${root}exportlite/dist/drizzle.mjs`);
}
const initialMemory = process.memoryUsage();
const sql = `SELECT id,name,note,active FROM main."${fixture.table.replaceAll('"', '""')}" ORDER BY id`;
async function once(verify = false) {
	const start = performance.now();
	let bytes = 0;
	const hash = verify ? createHash("sha256") : undefined;
	const sink =
		fixture.rows > 1000
			? new Writable({
					write(chunk, encoding, callback) {
						bytes += chunk.length;
						hash?.update(chunk);
						callback();
					},
				})
			: undefined;
	if (isExport) {
		const result = usesDrizzle
			? await api.exportTable(orm, table, {
					columns,
					format: "json",
					...(sink ? { output: sink, end: true } : {}),
				})
			: await api.exportTable(client, fixture.table, {
					columns,
					format: "json",
					...(sink ? { output: sink, end: true } : {}),
				});
		if (sink) {
			assert.equal(result.rowsExported, fixture.rows);
			assert.equal(result.bytesWritten, bytes);
		} else {
			const buffer = await new Response(result).arrayBuffer();
			bytes = buffer.byteLength;
			hash?.update(new Uint8Array(buffer));
			assert.equal((await result.result).rowsExported, fixture.rows);
		}
	} else {
		const text = usesDrizzle
			? JSON.stringify(
					await orm.select(columns).from(table).orderBy(table.id).all(),
				)
			: JSON.stringify((await client.execute(sql)).rows);
		if (sink) {
			sink.end(Buffer.from(text, "utf8"));
			await finished(sink, { cleanup: true });
		} else {
			const buffer = await new Response(text).arrayBuffer();
			bytes = buffer.byteLength;
			hash?.update(new Uint8Array(buffer));
		}
	}
	const totalMs = performance.now() - start;
	assert.equal(bytes, fixture.expected.bytes);
	return { bytes, sha256: hash?.digest("hex"), totalMs };
}
try {
	const verification = await once(true);
	assert.equal(verification.sha256, fixture.expected.sha256);
	if (!smoke) await once();
	const samples = [];
	const iterations = smoke ? 1 : fixture.iterations;
	for (let sample = 0; sample < (smoke ? 1 : 3); sample++) {
		let totalMs = 0;
		for (let i = 0; i < iterations; i++) totalMs += (await once()).totalMs;
		samples.push({
			totalMs,
			perRequestMs: totalMs / iterations,
			requests: iterations,
		});
	}
	const result = {
		name,
		method,
		latencyMs: Number(latency),
		verification,
		samples,
		median: [...samples].sort((a, b) => a.perRequestMs - b.perRequestMs)[
			Math.floor(samples.length / 2)
		],
		initialMemory,
		finalMemory: process.memoryUsage(),
		peakRssMiB: process.resourceUsage().maxRSS / 1024,
		node: process.version,
		requests: 1 + (smoke ? 0 : 1) + samples.length * iterations,
	};
	writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
	console.log(
		`${name} ${method} +${latency}ms: ${result.median.perRequestMs.toFixed(2)}ms; ${result.peakRssMiB.toFixed(1)}MiB client peak RSS`,
	);
} finally {
	client.close();
}
