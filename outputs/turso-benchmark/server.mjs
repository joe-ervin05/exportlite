import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
	`${root}exportlite/benchmarks/matched-api/package.json`,
);
const Database = require("better-sqlite3");
const [path, latency] = process.argv.slice(2);
assert.equal(process.version, "v26.12.0");
const db = new Database(path, { readonly: true });
const sessions = new Set();
let records = [];
let active = 0;
const server = createServer(async (req, res) => {
	active++;
	const started = performance.now();
	const cpu = process.cpuUsage();
	const log = {
		path: req.url,
		latencyMs: Number(latency),
		sql: [],
		bytes: 0,
		rows: 0,
		batches: 0,
		batchRows: 0,
	};
	let iterator;
	let buffered = 0;
	let parts = [];
	let stopped = false;
	res.on("close", () => {
		stopped = true;
		iterator?.return?.();
	});
	const flush = async () => {
		if (!buffered || stopped) return;
		const bytes = Buffer.from(parts.join(""));
		parts = [];
		buffered = 0;
		log.bytes += bytes.length;
		if (!res.write(bytes))
			await new Promise((resolve) => {
				const done = () => {
					res.off("drain", done);
					res.off("close", done);
					resolve();
				};
				res.once("drain", done);
				res.once("close", done);
			});
	};
	const write = (text) => {
		if (stopped) throw Error("Client disconnected");
		parts.push(text);
		buffered += Buffer.byteLength(text);
		return buffered >= 65536 ? flush() : undefined;
	};
	const emit = async (text) => {
		const wait = write(text);
		if (wait) await wait;
	};
	const prepare = (stmt) => {
		log.sql.push(stmt.sql);
		const native = db.prepare(stmt.sql);
		assert(native.reader && native.readonly, "Expected read-only SQL");
		const args = stmt.named_args?.length
			? [
					Object.fromEntries(
						stmt.named_args.map(({ name, value }) => [name, decode(value)]),
					),
				]
			: (stmt.args ?? []).map(decode);
		const cols = native
			.columns()
			.map((c) => ({ name: c.name, decltype: c.type }));
		iterator = native.raw().iterate(...args);
		return cols;
	};
	try {
		let body = "";
		for await (const chunk of req) body += chunk;
		const request = JSON.parse(body);
		log.requestTypes = request.requests?.map((r) => r.type) ?? ["cursor"];
		// One fixed delay per HTTP request models added round-trip latency. It is
		// never applied per row or per SQLite batch. No bandwidth cap is simulated.
		if (Number(latency)) await delay(Number(latency));
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/v3/cursor") {
			assert.equal(request.batch.steps.length, 1);
			const baton = randomUUID();
			sessions.add(baton);
			const cols = prepare(request.batch.steps[0].stmt);
			await emit(JSON.stringify({ baton, base_url: null }) + "\n");
			await emit(JSON.stringify({ type: "step_begin", step: 0, cols }) + "\n");
			for (const row of iterator) {
				log.rows++;
				if (row.length === 2) {
					log.batches++;
					log.batchRows += row[1];
				}
				const wait = write(
					JSON.stringify({ type: "row", row: row.map(encode) }) + "\n",
				);
				if (wait) await wait;
			}
			await emit(
				JSON.stringify({
					type: "step_end",
					affected_row_count: 0,
					last_insert_rowid: null,
				}) + "\n",
			);
		} else if (["/v2/pipeline", "/v3/pipeline"].includes(req.url)) {
			await emit('{"baton":null,"base_url":null,"results":[');
			for (const [index, operation] of request.requests.entries()) {
				if (index) await emit(",");
				if (operation.type === "close") {
					if (request.baton) {
						assert(sessions.delete(request.baton), "Unknown cursor session");
					}
					await emit('{"type":"ok","response":{"type":"close"}}');
				} else {
					assert.equal(operation.type, "execute");
					const cols = prepare(operation.stmt);
					await emit(
						'{"type":"ok","response":{"type":"execute","result":{"cols":' +
							JSON.stringify(cols) +
							',"rows":[',
					);
					let first = true;
					for (const row of iterator) {
						log.rows++;
						const wait = write(
							(first ? "" : ",") + JSON.stringify(row.map(encode)),
						);
						first = false;
						if (wait) await wait;
					}
					await emit('],"affected_row_count":0,"last_insert_rowid":null}}}');
				}
			}
			await emit("]}");
		} else throw Error(`Unsupported endpoint ${req.url}`);
		await flush();
		res.end();
	} catch (error) {
		log.error = String(error);
		if (res.headersSent) res.destroy(error);
		else res.writeHead(500).end(JSON.stringify({ error: log.error }));
	} finally {
		iterator?.return?.();
		log.wallMs = performance.now() - started;
		log.cpu = process.cpuUsage(cpu);
		records.push(log);
		active--;
	}
});
// Large buffered client decodes can occupy the event loop longer than Node's
// default five-second idle timeout. Keep the fixture connection reusable.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 180_000;
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.send({
	type: "ready",
	url: `http://127.0.0.1:${server.address().port}`,
	sqlite: db.prepare("SELECT sqlite_version()").pluck().get(),
	driver: require("better-sqlite3/package.json").version,
});
process.on("message", async (message) => {
	if (message.type === "reset") {
		assert.equal(active, 0);
		records = [];
		process.send({ type: "reset", id: message.id });
	}
	if (message.type === "stats")
		process.send({
			type: "stats",
			id: message.id,
			records,
			sessions: sessions.size,
			active,
			peakRssMiB: process.resourceUsage().maxRSS / 1024,
		});
	if (message.type === "stop") {
		server.closeAllConnections();
		server.close(() => {
			db.close();
			process.exit(0);
		});
	}
});

function decode(value) {
	switch (value.type) {
		case "null":
			return null;
		case "integer":
			return BigInt(value.value);
		case "float":
			return value.value;
		case "text":
			return value.value;
		case "blob":
			return Buffer.from(value.base64, "base64");
		default:
			throw Error("Unknown parameter");
	}
}
function encode(value) {
	if (value === null) return { type: "null" };
	if (typeof value === "string") return { type: "text", value };
	if (typeof value === "number")
		return Number.isInteger(value)
			? { type: "integer", value: String(value) }
			: { type: "float", value };
	if (typeof value === "bigint")
		return { type: "integer", value: String(value) };
	if (Buffer.isBuffer(value))
		return { type: "blob", base64: value.toString("base64") };
	throw Error("Unsupported result");
}
