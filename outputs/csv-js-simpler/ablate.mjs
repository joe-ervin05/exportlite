import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
if (process.argv[2] === "worker") {
	const [fixture, variant] = process.argv.slice(3);
	const require = createRequire(join(root, "exportlite/package.json"));
	const Database = require("better-sqlite3");
	const db = new Database(
		join(root, "outputs/csv-deep/fixtures", `${fixture}.sqlite`),
		{ readonly: true },
	);
	let sql = "SELECT id,name,note,active FROM data ORDER BY id";
	if (variant === "fenced") sql = `SELECT * FROM (${sql} LIMIT -1 OFFSET 0)`;
	if (["pairs", "native-values"].includes(variant)) {
		const api = await import(
			pathToFileURL(
				join(here, "projects", variant, "exportlite/dist/index.mjs"),
			)
		);
		const traced = {
			prepare(text) {
				sql = text;
				return db.prepare(text);
			},
		};
		await api.exportTable(traced, "data", {
			columns: {
				id: api.integer().primaryKey(),
				name: api.text(),
				note: api.text(),
				active: api.integer(),
			},
			format: "csv",
			output: new Writable({
				write(_b, _e, cb) {
					cb();
				},
			}),
		});
	}
	const statement = db.prepare(sql).raw();
	if (variant === "native-values") statement.safeIntegers(true);
	let rows = 0,
		slots = 0;
	function consume() {
		rows = 0;
		slots = 0;
		for (const row of statement.iterate()) {
			rows++;
			slots += row.length;
		}
	}
	consume();
	consume();
	const samples = [];
	for (let j = 0; j < 5; j++) {
		const start = performance.now();
		for (let i = 0; i < 3; i++) consume();
		samples.push((performance.now() - start) / 3);
	}
	console.log(
		JSON.stringify({
			fixture,
			variant,
			rows,
			slots,
			medianMs: median(samples),
			samplesMs: samples,
			queryPlan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(),
		}),
	);
	db.close();
} else {
	assert.equal(process.version, "v26.12.0");
	const all = [];
	const variants = ["direct", "fenced", "pairs", "native-values"];
	for (let round = 0; round < 3; round++)
		for (const fixture of ["narrow", "wide"])
			for (const variant of [
				...variants.slice(round),
				...variants.slice(0, round),
			]) {
				const child = spawnSync(
					process.execPath,
					[fileURLToPath(import.meta.url), "worker", fixture, variant],
					{ encoding: "utf8", maxBuffer: 1e6 },
				);
				assert.equal(child.status, 0, child.stderr);
				all.push({ round, ...JSON.parse(child.stdout) });
			}
	const summary = [];
	for (const fixture of ["narrow", "wide"])
		for (const variant of variants) {
			const rows = all.filter(
				(r) => r.fixture === fixture && r.variant === variant,
			);
			summary.push({
				fixture,
				variant,
				medianMs: median(rows.map((r) => r.medianMs)),
				minMs: Math.min(...rows.map((r) => r.medianMs)),
				maxMs: Math.max(...rows.map((r) => r.medianMs)),
				rows: rows[0].rows,
				slots: rows[0].slots,
			});
		}
	await writeFile(
		join(here, "ablation.json"),
		JSON.stringify(
			{
				node: process.version,
				nodeSha256: createHash("sha256")
					.update(await readFile(process.execPath))
					.digest("hex"),
				protocol:
					"Diagnostic only. Three rotated rounds of fresh workers. Prepared raw iterator consumption: count rows/slots, no CSV encoding or writes. Two warmups, five batches of three consumes; natural GC. No per-record timing hooks. Figures cannot be subtracted from full delivery medians to assign exact costs.",
				all,
				summary,
			},
			null,
			2,
		) + "\n",
	);
	console.log(JSON.stringify(summary, null, 2));
}
