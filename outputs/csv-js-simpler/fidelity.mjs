import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const require = createRequire(join(root, "exportlite/package.json"));
const Database = require("better-sqlite3");
const variants = [
	"sqlite",
	"buffered",
	"tokens",
	"native-values",
	"guarded-values",
	"chain",
	"raw",
];
const apis = Object.fromEntries(
	await Promise.all(
		variants.map(async (name) => [
			name,
			await import(
				pathToFileURL(
					join(
						name === "sqlite"
							? join(root, "exportlite")
							: join(here, "projects", name, "exportlite"),
						"dist/index.mjs",
					),
				)
			),
		]),
	),
);
const all = [];
for (const [encoding, pragma] of [
	["utf8", "UTF-8"],
	["utf16le", "UTF-16le"],
	["utf16be", "UTF-16be"],
])
	for (const safe of [false, true]) {
		const db = new Database(":memory:");
		try {
			db.exec(
				`PRAGMA encoding='${pragma}'; CREATE TABLE scalars(id INTEGER PRIMARY KEY,payload)`,
			);
			db.defaultSafeIntegers(safe);
			const literals = [
				"NULL",
				"''",
				"0",
				"1",
				"-1",
				"9007199254740991",
				"9007199254740992",
				"9007199254740993",
				"9223372036854775807",
				"-9223372036854775808",
				"1.0",
				"-0.0",
				"1e100",
				"9e999",
				"-9e999",
				"'1.0'",
				"'null'",
				"'true'",
			];
			const insert = db.prepare("INSERT INTO scalars VALUES(?,?)");
			const strings = [
				"",
				"\0",
				"\0\0",
				"\0t",
				'\0"1,2\r\n',
				"\0utf16",
				"utf16",
				'雪,"quoted"\r\n\0tail',
				"😀",
				"1.0",
				"Inf",
				"=1+1",
			];
			for (let i = 0; i < 260; i++) {
				const key = i * 3 - 400;
				if (i % 2) insert.run(key, strings[i % strings.length]);
				else
					db.exec(
						`INSERT INTO scalars VALUES(${key},${literals[(i / 2) % literals.length]})`,
					);
			}
			for (const query of [false, true])
				for (const zip of [false, true]) {
					let reference;
					for (const name of variants) {
						const api = apis[name];
						const options = {
							columns: {
								id: api.integer().primaryKey(),
								value: api.text("payload"),
							},
							format: "csv",
							encoding,
							zip,
						};
						const stream = query
							? await api.exportQuery(db, {
									...options,
									sql: "SELECT id,payload FROM scalars WHERE id >= ? ORDER BY id",
									params: [-400],
								})
							: await api.exportTable(db, "scalars", options);
						const bytes = Buffer.from(await new Response(stream).arrayBuffer());
						const result = await stream.result;
						assert.equal(result.rowsExported, 260);
						assert.equal(result.bytesWritten, bytes.length);
						assert.equal(
							typeof db.prepare("SELECT 1 AS n").get().n,
							safe ? "bigint" : "number",
						);
						const hash = createHash("sha256").update(bytes).digest("hex");
						if (name === "sqlite") reference = hash;
						if (name !== "raw")
							assert.equal(
								hash,
								reference,
								`${encoding} ${safe} ${query} ${zip} ${name}`,
							);
						all.push({
							encoding,
							safeIntegersDefault: safe,
							query,
							zip,
							variant: name,
							bytes: bytes.length,
							sha256: hash,
							matches: hash === reference,
						});
					}
				}
		} finally {
			db.close();
		}
	}
assert(
	all.some((r) => r.variant === "raw" && !r.matches),
	"Unsafe raw diagnostic should expose numeric contract differences",
);
await writeFile(
	join(here, process.env.CSV_JS_FIDELITY_OUTPUT ?? "fidelity.json"),
	JSON.stringify(
		{
			node: process.version,
			description:
				"168 actual Web-stream exports: three database encodings, two caller safe-integer defaults, table/parameterized query, plain/ZIP and seven implementations. Dynamic scalar storage, exact 64-bit extrema, REAL spellings/infinities, NULL, empty strings, leading/embedded NUL, quotes/newlines/Unicode, sparse keys and aliases. Caller safe-integer defaults are verified after every export. All preserving candidates match production bytes; raw is deliberately unsafe and must fail numeric fidelity.",
			all,
		},
		null,
		2,
	) + "\n",
);
console.log(
	JSON.stringify({
		exports: all.length,
		preservingMatches: all.filter((r) => r.variant !== "raw" && r.matches)
			.length,
		unsafeRawMismatches: all.filter((r) => r.variant === "raw" && !r.matches)
			.length,
	}),
);
