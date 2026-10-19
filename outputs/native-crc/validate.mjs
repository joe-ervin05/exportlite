import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readZip } from "../../exportlite/benchmarks/read-zip.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(`${root}exportlite/package.json`);
const Database = require("better-sqlite3");
const fixtures = JSON.parse(
	await readFile(`${root}outputs/csv-deep/fixtures/configuration.json`, "utf8"),
).map((f) => ({
	...f,
	path: `${root}outputs/csv-deep/fixtures/${f.source ?? f.name}.sqlite`,
}));
const builds = {
	before: `${root}outputs/native-crc/baseline/exportlite/dist`,
	after: `${root}exportlite/dist`,
};
const directory = await mkdtemp(join(tmpdir(), "exportlite-native-crc-"));
async function run(variant, fixture, method, format, zip) {
	const build = builds[variant];
	const api = await import(pathToFileURL(`${build}/index.mjs`));
	const db = new Database(fixture.path, { readonly: true });
	const statements = [];
	const prepare = db.prepare.bind(db);
	db.prepare = (sql) => {
		statements.push(sql);
		return prepare(sql);
	};
	const digest = createHash("sha256");
	let bytes = 0;
	const chunks = [];
	const sink = new Writable({
		write(chunk, _encoding, callback) {
			digest.update(chunk);
			bytes += chunk.length;
			chunks.push(chunk.length);
			callback();
		},
	});
	const path = join(directory, `${variant}.zip`);
	const options = { format, zip, output: zip ? path : sink, end: true };
	try {
		let result;
		if (fixture.drizzle) {
			const { drizzle } = require("drizzle-orm/better-sqlite3");
			const schema = require("drizzle-orm/sqlite-core");
			const table = schema.sqliteTable(
				"data",
				Object.fromEntries(
					fixture.columns.map((c) => [
						c.key,
						c.primary
							? schema.integer(c.key).primaryKey()
							: c.type === "integer"
								? schema.integer(c.key, c.mode ? { mode: c.mode } : undefined)
								: schema.text(c.key, c.mode ? { mode: c.mode } : undefined),
					]),
				),
			);
			const adapter = await import(pathToFileURL(`${build}/drizzle.mjs`));
			const orm = drizzle(db);
			result =
				method === "table"
					? await adapter.exportTable(orm, table, options)
					: await adapter.exportQuery(
							orm,
							orm.select().from(table).orderBy(table.id),
							options,
						);
		} else {
			const columns = Object.fromEntries(
				fixture.columns.map((c) => {
					let value =
						c.type === "integer"
							? api.integer(c.key, c.mode ? { mode: c.mode } : undefined)
							: api.text(c.key);
					if (c.primary) value = value.primaryKey();
					return [c.key, value];
				}),
			);
			result =
				method === "table"
					? await api.exportTable(db, "data", { ...options, columns })
					: await api.exportQuery(db, {
							...options,
							columns,
							sql: "SELECT * FROM data ORDER BY id",
						});
		}
		assert.equal(result.rowsExported, fixture.rows);
		assert.equal(statements.length, 1);
		let decoded;
		if (zip) {
			const archive = await readFile(path);
			digest.update(archive);
			bytes = archive.length;
			decoded = await readZip(path, {
				name: `${method === "table" ? "data" : "export"}.${format}`,
			});
			await rm(path);
		}
		assert.equal(result.bytesWritten, bytes);
		return {
			sql: statements[0],
			sha256: digest.digest("hex"),
			bytes,
			chunks,
			decoded,
		};
	} finally {
		db.close();
	}
}
const cases = [];
try {
	for (const fixture of fixtures)
		for (const method of ["table", "query"])
			for (const format of ["json", "jsonl", "csv"]) {
				let plain;
				for (const zip of [false, true]) {
					const before = await run("before", fixture, method, format, zip);
					const after = await run("after", fixture, method, format, zip);
					assert.equal(before.sql, after.sql);
					assert.equal(before.sha256, after.sha256);
					assert.equal(before.bytes, after.bytes);
					if (!zip) {
						assert.deepEqual(before.chunks, after.chunks);
						plain = after;
					} else {
						assert.equal(after.decoded.sha256, plain.sha256);
						assert.equal(after.decoded.bytes, plain.bytes);
						assert.deepEqual(after.decoded, before.decoded);
					}
					cases.push({
						fixture: fixture.name,
						method,
						format,
						zip,
						bytes: after.bytes,
						sha256: after.sha256,
						preparedStatements: 1,
						sqlIdentical: true,
						...(zip
							? { decoded: after.decoded }
							: { chunkBoundariesIdentical: true }),
					});
				}
			}
	const declarations = [];
	for (const file of (await readdir(builds.before)).filter((name) =>
		/\.d\.(?:mts|cts)$/.test(name),
	)) {
		assert.equal(
			await readFile(join(builds.before, file), "utf8"),
			await readFile(join(builds.after, file), "utf8"),
		);
		declarations.push(file);
	}
	await writeFile(
		`${root}outputs/native-crc/equivalence.json`,
		`${JSON.stringify({ node: process.version, beforeCommit: "fcca5563d82ab7b6c607779ef59db360f7bba307", declarationsIdentical: declarations, cases }, null, 2)}\n`,
	);
	console.log(
		`Verified ${cases.length} before/after cases, independent ZIP decode/CRC and ${declarations.length} unchanged declaration files.`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
