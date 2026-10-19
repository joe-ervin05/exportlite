import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const builds = {
	before: join(root, "outputs/native-crc/baseline/exportlite/dist"),
	"bundled-js": join(root, "outputs/native-crc/bundled-js"),
	native: join(root, "exportlite/dist"),
};
const fixtureDirectory = join(root, "outputs/csv-deep/fixtures");
const fixtures = JSON.parse(
	await readFile(join(fixtureDirectory, "configuration.json"), "utf8"),
)
	.filter((f) => ["tiny", "narrow", "wide", "quote-heavy"].includes(f.name))
	.map((f) => ({
		...f,
		path: join(fixtureDirectory, `${f.source ?? f.name}.sqlite`),
	}));
const output = join(root, "outputs/native-crc/control");
await mkdir(output, { recursive: true });
const all = [];
for (let round = 0; round < 5; round++) {
	const labels = Object.keys(builds);
	const order = [...labels.slice(round % 3), ...labels.slice(0, round % 3)];
	for (const fixture of fixtures)
		for (const variant of order) {
			const child = spawnSync(
				process.execPath,
				[
					join(root, "exportlite/benchmarks/csv-performance/worker.mjs"),
					"worker",
					JSON.stringify(fixture),
					"table",
					"zip",
				],
				{
					cwd: join(root, "exportlite"),
					encoding: "utf8",
					maxBuffer: 1e6,
					env: { ...process.env, EXPORTLITE_BUILD: builds[variant] },
				},
			);
			assert.equal(child.status, 0, child.stderr);
			all.push({ round, variant, ...JSON.parse(child.stdout) });
		}
	await writeFile(
		join(output, "all.json"),
		`${JSON.stringify(all, null, 2)}\n`,
	);
	console.error(`Finished native CRC control round ${round + 1}/5.`);
}
const summary = [];
for (const fixture of fixtures) {
	const group = all.filter((row) => row.fixture === fixture.name);
	assert.equal(new Set(group.map((row) => row.sha256)).size, 1);
	for (const variant of Object.keys(builds)) {
		const rows = group.filter((row) => row.variant === variant);
		summary.push({
			fixture: fixture.name,
			variant,
			medianMs: median(rows.map((row) => row.medianMs)),
			minMs: Math.min(...rows.map((row) => row.medianMs)),
			maxMs: Math.max(...rows.map((row) => row.medianMs)),
			medianCpuMs: median(rows.map((row) => row.medianCpuMs)),
			medianPeakRssMiB: median(rows.map((row) => row.peakRssMiB)),
			maxPeakRssMiB: Math.max(...rows.map((row) => row.peakRssMiB)),
			bytes: rows[0].bytes,
			sha256: rows[0].sha256,
		});
	}
}
const buildHashes = {};
for (const [variant, path] of Object.entries(builds)) {
	buildHashes[variant] = {};
	for (const file of (await readdir(path))
		.filter((name) => name.endsWith(".mjs"))
		.sort())
		buildHashes[variant][file] = hash(await readFile(join(path, file)));
}
await writeFile(
	join(output, "summary.json"),
	`${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
	join(output, "configuration.json"),
	`${JSON.stringify({ node: process.version, nodeSha256: hash(await readFile(process.execPath)), cpu: cpus()[0]?.model, rounds: 5, beforeCommit: "fcca5563d82ab7b6c607779ef59db360f7bba307", builds: buildHashes, fixtures: fixtures.map(({ path, ...f }) => f), protocol: "60 sequential fresh workers, rotating baseline/bundled-JS/native order. Same CSV worker and settings as the 500-worker comparison. Bundled-JS is the current configuration with only the crc-32 alias removed, retaining the original checksum implementation. Natural GC; no concurrent profiles, builds or tests. Time includes planning, encoding, ZIP and completion to a counting Node writable; imports/connections excluded from time but included in whole-process peak RSS. Archive hashes must match across all builds." }, null, 2)}\n`,
);
console.log(JSON.stringify({ workers: all.length, cases: summary.length }));
