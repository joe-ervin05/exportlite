import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-memory-next");
const fixtures = JSON.parse(
	await readFile(
		join(root, "outputs/native-crc/comparison/configuration.json"),
		"utf8",
	),
).fixtures.filter((f) => ["wide", "json", "narrow"].includes(f.name));
const variants = process.env.CSV_MEMORY_CANDIDATES?.split(",") ?? [
	"baseline",
	"yield256",
	"yield512",
	"batch128",
	"batch64",
	"text",
	"zip128k",
	"zip64k",
];
const output = join(here, process.env.CSV_MEMORY_SCREEN_OUT ?? "screen");
await mkdir(output, { recursive: true });
const all = [];
for (let round = 0; round < 3; round++) {
	const order = [...variants.slice(round), ...variants.slice(0, round)];
	for (const f of fixtures)
		for (const compression of ["none", "zip"])
			for (const variant of order) {
				if (compression === "none" && variant.startsWith("zip")) continue;
				const fixture = {
					...f,
					path: join(root, "outputs/csv-deep/fixtures", `${f.name}.sqlite`),
				};
				const build =
					variant === "baseline"
						? join(here, "baseline/exportlite/dist")
						: join(here, "candidates", variant, "dist");
				const child = spawnSync(
					process.execPath,
					[
						join(root, "exportlite/benchmarks/csv-performance/worker.mjs"),
						"worker",
						JSON.stringify(fixture),
						"table",
						compression,
					],
					{
						encoding: "utf8",
						maxBuffer: 1e6,
						env: { ...process.env, EXPORTLITE_BUILD: build },
					},
				);
				assert.equal(child.status, 0, child.stderr);
				const row = { round, variant, ...JSON.parse(child.stdout) };
				if (compression === "none") assert.equal(row.sha256, f.csvSha256);
				all.push(row);
			}
	await writeFile(
		join(output, "all.json"),
		`${JSON.stringify(all, null, 2)}\n`,
	);
	console.error(`Completed candidate screen round ${round + 1}/3`);
}
const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const f of fixtures)
	for (const compression of ["none", "zip"]) {
		const group = all.filter(
			(row) => row.fixture === f.name && row.compression === compression,
		);
		assert.equal(new Set(group.map((row) => row.sha256)).size, 1);
		for (const variant of variants) {
			const rows = group.filter((row) => row.variant === variant);
			if (!rows.length) continue;
			summary.push({
				fixture: f.name,
				compression,
				variant,
				medianMs: median(rows.map((r) => r.medianMs)),
				medianPeakRssMiB: median(rows.map((r) => r.peakRssMiB)),
				maxPeakRssMiB: Math.max(...rows.map((r) => r.peakRssMiB)),
				medianSetupPeakRssMiB: median(rows.map((r) => r.setupPeakRssMiB)),
				bytes: rows[0].bytes,
				sha256: rows[0].sha256,
			});
		}
	}
await writeFile(
	join(output, "summary.json"),
	`${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ workers: all.length, cases: summary.length }));
