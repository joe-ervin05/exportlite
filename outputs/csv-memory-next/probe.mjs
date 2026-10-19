import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PerformanceObserver } from "node:perf_hooks";
import { Duplex, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";

const require = createRequire(
	new URL("../../exportlite/package.json", import.meta.url),
);
const snapshots = [];
const keys = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"];
const peaks = Object.fromEntries(keys.map((key) => [key, 0]));
const allocations = {
	nativeBatches: 0,
	nativeBytes: 0,
	nativeMaxBytes: 0,
	nativeBackingBytes: 0,
	nativeFinalizedBytes: 0,
	concatBuffers: 0,
	concatBytes: 0,
	encodedBuffers: 0,
	encodedBytes: 0,
};
const registry = new FinalizationRegistry((bytes) => {
	allocations.nativeFinalizedBytes += bytes;
});
const gc = [];
let phase = "bootstrap",
	exportIndex = -1,
	exportPeaks;
const statements = [];
const streams = [];
const streamStates = new WeakMap();
const write = Writable.prototype.write;
if (Duplex.prototype.write !== write)
	throw new Error("Unexpected Node stream implementation");
Writable.prototype.write = function (chunk, encoding, callback) {
	let state = streamStates.get(this);
	if (!state) {
		state = {
			name: this.constructor.name,
			writes: 0,
			pendingBytes: 0,
			peakPendingBytes: 0,
		};
		streamStates.set(this, state);
		streams.push(state);
	}
	const cb = typeof encoding === "function" ? encoding : callback;
	const size =
		typeof chunk === "string"
			? Buffer.byteLength(
					chunk,
					typeof encoding === "string" ? encoding : "utf8",
				)
			: chunk.byteLength;
	state.writes++;
	state.pendingBytes += size;
	state.peakPendingBytes = Math.max(state.peakPendingBytes, state.pendingBytes);
	return write.call(
		this,
		chunk,
		typeof encoding === "string" ? encoding : undefined,
		(...args) => {
			state.pendingBytes -= size;
			cb?.(...args);
		},
	);
};
Duplex.prototype.write = Writable.prototype.write;
function sample(label) {
	const memory = process.memoryUsage();
	for (const key of keys) {
		peaks[key] = Math.max(peaks[key], memory[key]);
		if (exportPeaks) exportPeaks[key] = Math.max(exportPeaks[key], memory[key]);
	}
	if (label)
		snapshots.push({
			label,
			exportIndex,
			...memory,
			maxRssBytes: process.resourceUsage().maxRSS * 1024,
			allocations: { ...allocations },
			gcCount: gc.length,
			...(exportPeaks ? { exportPeaks: { ...exportPeaks } } : {}),
		});
}
globalThis.exportliteCsvProfile = (label) => {
	phase = label;
	if (label === "export-start") {
		exportIndex++;
		exportPeaks = Object.fromEntries(keys.map((key) => [key, 0]));
	}
	sample(label);
	if (label === "setup-ready" && process.env.PROFILE_GC_AFTER_SETUP) {
		global.gc();
		global.gc();
		sample("setup-after-diagnostic-gc");
	}
	if (label === "export-complete") exportPeaks = undefined;
};
sample("bootstrap");
const Database = require("better-sqlite3");
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (...args) {
	const statement = prepare.apply(this, args);
	statements.push(args[0]);
	const batches = args[0].startsWith('WITH RECURSIVE "__exportlite_batches"');
	const iterate = statement.iterate;
	statement.iterate = function* (...params) {
		let count = 0;
		for (const row of iterate.apply(this, params)) {
			if (batches && Buffer.isBuffer(row[0])) {
				allocations.nativeBatches++;
				allocations.nativeBytes += row[0].length;
				allocations.nativeMaxBytes = Math.max(
					allocations.nativeMaxBytes,
					row[0].length,
				);
				allocations.nativeBackingBytes += row[0].buffer.byteLength;
				registry.register(row[0].buffer, row[0].buffer.byteLength);
				sample();
			} else if (++count % 128 === 0) sample();
			yield row;
		}
	};
	return statement;
};
const from = Buffer.from;
Buffer.from = function (...args) {
	const bytes = from.apply(this, args);
	if (typeof args[0] === "string" && bytes.length >= 4096) {
		allocations.encodedBuffers++;
		allocations.encodedBytes += bytes.length;
		sample();
	}
	return bytes;
};
const concat = Buffer.concat;
Buffer.concat = function (...args) {
	const bytes = concat.apply(this, args);
	if (bytes.length >= 4096) {
		allocations.concatBuffers++;
		allocations.concatBytes += bytes.length;
		sample();
	}
	return bytes;
};
const observer = new PerformanceObserver((list) => {
	for (const entry of list.getEntries())
		gc.push({
			startTime: entry.startTime,
			duration: entry.duration,
			kind: entry.detail.kind,
			phase,
			exportIndex,
		});
	sample();
});
observer.observe({ entryTypes: ["gc"] });
const interval = setInterval(() => sample(), 5);
interval.unref();
process.once("beforeExit", async () => {
	clearInterval(interval);
	await tick();
	sample("end-natural");
	const natural = {
		peaks: { ...peaks },
		allocations: { ...allocations },
		gc: [...gc],
	};
	for (let i = 0; i < 3; i++) {
		global.gc();
		await tick();
	}
	sample("end-after-diagnostic-gc");
	observer.disconnect();
	writeFileSync(
		process.env.PROFILE_OUT,
		`${JSON.stringify({ node: process.version, natural, snapshots, streams, statements: [...new Set(statements)] }, null, 2)}\n`,
	);
});
