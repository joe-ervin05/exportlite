import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const here = join(root, "outputs/csv-js-simpler");
const read = async (path) =>
	JSON.parse(await readFile(join(here, path), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.version, "v26.12.0");
const configuration = await read("comparison/configuration.json");
assert.equal(configuration.nodeSha256, hash(await readFile(process.execPath)));
const workers = await read("comparison/all.json");
assert.equal(workers.length, 250);
assert.equal(new Set(workers.map((r) => r.round)).size, 5);
const summary = await read("comparison/summary.json");
assert.equal(summary.length, 50);
for (const variant of ["native-values", "guarded-values"])
	for (const [file, expected] of Object.entries(
		configuration.buildHashes[variant],
	))
		assert.equal(
			hash(await readFile(join(here, "timed-builds", variant, file))),
			expected,
		);
const decls = (await readdir(join(root, "exportlite/dist"))).filter((f) =>
	/\.d\.[cm]ts$/.test(f),
);
assert.equal(decls.length, 12);
for (const directory of ["native-values", "guarded-values"])
	for (const file of decls)
		assert(
			(await readFile(join(root, "exportlite/dist", file))).equals(
				await readFile(
					join(here, "projects", directory, "exportlite/dist", file),
				),
			),
			`${directory}/${file}`,
		);
const patches = {};
for (const variant of ["native-values", "guarded-values"])
	for (const stage of ["timed", "qualified"]) {
		const name = `${variant}-${stage}.patch`,
			path = join(here, name);
		const checked = spawnSync(
			"git",
			[
				"apply",
				"--check",
				"--unidiff-zero",
				"--unsafe-paths",
				`--directory=${join(here, "base")}`,
				path,
			],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(checked.status, 0, checked.stderr);
		patches[name] = hash(await readFile(path));
	}
const suites = {};
for (const [name, path] of Object.entries({
	production: "production-tests.txt",
	native: "native-values-qualified-tests.txt",
	guarded: "guarded-values-qualified-tests.txt",
})) {
	const text = await readFile(join(here, path), "utf8");
	assert(text.includes("473 passed (473)"), path);
	suites[name] = 473;
}
assert(
	(await readFile(join(here, "jsonb-before.txt"), "utf8")).includes("4 failed"),
);
assert(
	(await readFile(join(here, "jsonb-after.txt"), "utf8")).includes(
		"40 passed (40)",
	),
);
const fidelity = await read("fidelity-qualified.json");
assert.equal(fidelity.all.length, 168);
assert.equal(
	fidelity.all.filter((r) => r.variant !== "raw" && r.matches).length,
	144,
);
assert.equal(
	fidelity.all.filter((r) => r.variant === "raw" && !r.matches).length,
	24,
);
const changed = spawnSync(
	"git",
	["diff", "--name-only", "c2f7c51", "--", "exportlite/src"],
	{ cwd: root, encoding: "utf8" },
);
assert.equal(changed.status, 0);
assert.equal(changed.stdout.trim(), "exportlite/src/planner/csv.ts");
const untouched = spawnSync(
	"git",
	[
		"diff",
		"--exit-code",
		"c2f7c51",
		"--",
		"exportlite/package.json",
		"exportlite/pnpm-lock.yaml",
		"exportlite/tsdown.config.ts",
	],
	{ cwd: root, encoding: "utf8" },
);
assert.equal(untouched.status, 0);
const regressions = await read("blob-regression/summary.json");
const regression = [];
for (const fixture of ["narrow", "wide"])
	for (const compression of ["none", "zip"]) {
		const rows = regressions.filter(
			(r) => r.fixture === fixture && r.compression === compression,
		);
		assert.equal(rows.length, 2);
		assert.equal(new Set(rows.map((r) => r.sha256)).size, 1);
		assert.equal(new Set(rows.map((r) => r.bytes)).size, 1);
		const before = rows.find((r) => r.variant === "before"),
			after = rows.find((r) => r.variant === "sqlite");
		regression.push({
			fixture,
			compression,
			beforeMs: before.medianMs,
			afterMs: after.medianMs,
			changePct: 100 * (after.medianMs / before.medianMs - 1),
			beforePeakMiB: before.medianPeakRssMiB,
			afterPeakMiB: after.medianPeakRssMiB,
		});
	}
const percentages = [];
for (const fixture of ["narrow", "wide", "boolean", "json", "many-columns"])
	for (const compression of ["none", "zip"]) {
		const rows = summary.filter(
			(r) => r.fixture === fixture && r.compression === compression,
		);
		const old = rows.find((r) => r.variant === "pairs"),
			exact = rows.find((r) => r.variant === "native-values"),
			manual = rows.find((r) => r.variant === "manual"),
			sqlite = rows.find((r) => r.variant === "sqlite");
		percentages.push({
			fixture,
			compression,
			exactTimeSavedVsOldPct: 100 * (1 - exact.medianMs / old.medianMs),
			exactExtraTimeVsManualPct: 100 * (exact.medianMs / manual.medianMs - 1),
			exactExtraTimeVsSqlitePct: 100 * (exact.medianMs / sqlite.medianMs - 1),
		});
	}
const pkg = JSON.parse(
	await readFile(join(root, "exportlite/package.json"), "utf8"),
);
await writeFile(
	join(here, "qualification.json"),
	JSON.stringify(
		{
			node: process.version,
			nodeSha256: configuration.nodeSha256,
			baseline: "c2f7c513ed0958b24bf2897b6e1da1b730ca0d3a",
			versions: Object.fromEntries(
				[
					"better-sqlite3",
					"drizzle-orm",
					"zip-stream",
					"tsdown",
					"typescript",
				].map((p) => [p, pkg.devDependencies[p]]),
			),
			workers: 250,
			rounds: 5,
			cases: 50,
			publicDeclarationFilesIdentical: decls,
			suites,
			qualifiedFidelity: {
				exports: 168,
				preservingMatches: 144,
				unsafeRawMismatches: 24,
				callerSafeIntegerSettingVerified: true,
			},
			productionChanges: [
				"Only CSV raw-BLOB rejection; SQLite remains the default.",
				"No new API option, package/build configuration, batch, buffering, ZIP or driver change.",
			],
			prototypeStatus:
				"Experimental only. Timed patches retain original BLOB guards; qualified patches add the rejection fix and regression tests. Not shipped.",
			patches,
			regression,
			percentages,
			initialHarnessFailures:
				"The first native-values suite lacked two copied example files; restored, then the full 469 original tests passed. Production and both qualified candidates subsequently pass all 473 tests.",
		},
		null,
		2,
	) + "\n",
);
console.log(
	JSON.stringify(
		{ workers: 250, publicTypes: decls.length, suites, regression },
		null,
		2,
	),
);
