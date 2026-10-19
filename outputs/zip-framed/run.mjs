import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = fileURLToPath(new URL('.', import.meta.url));
const { readZip } = await import(`${root}exportlite/benchmarks/read-zip.mjs`);
const smoke = process.argv.includes('--smoke');
const resultDirectory = smoke ? `${directory}smoke/` : directory;
const node = '<node-26.12.0>';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const fixtures = JSON.parse(readFileSync(`${root}exportlite/benchmarks/results/batch-profile/fixtures.json`, 'utf8'));
for (const fixture of Object.values(fixtures)) assert.equal(sha256(fixture.path), fixture.fixtureSha256);
const fingerprintPaths = ['exportlite/dist/index.mjs', 'exportlite/src/output/writer.ts', 'exportlite/src/output/zip.ts', 'exportlite/benchmarks/baselines/pre-direct-zip/dist/index.mjs', 'exportlite/benchmarks/baselines/sql-framed-zip-prototype/dist/index.mjs', 'exportlite/benchmarks/baselines/sql-framed-zip-prototype/src/output/writer.ts', 'exportlite/benchmarks/baselines/sql-framed-zip-prototype/src/output/zip.ts', 'outputs/zip-framed/worker.mjs', 'outputs/zip-framed/run.mjs'];
const fingerprints = Object.fromEntries(fingerprintPaths.map(file => [file, sha256(`${root}${file}`)]));
const previous = JSON.parse(readFileSync(`${root}outputs/performance-current/configuration.json`, 'utf8'));
assert.equal(fingerprints['exportlite/benchmarks/baselines/pre-direct-zip/dist/index.mjs'], previous.fingerprints['exportlite/dist/index.mjs']);

const methods = ['before', 'framed', 'objects'];
const jobs = [];
for (let repeat = 0; repeat < (smoke ? 1 : 5); repeat++) {
  for (const dataset of smoke ? ['narrow','wide'] : ['matched', 'narrow', 'wide']) {
    for (let offset = 0; offset < methods.length; offset++) jobs.push({dataset, method: methods[(repeat + offset) % methods.length], repeat});
  }
}
const configuration = {
  date: new Date().toISOString(), node, cpu: cpus()[0].model, fingerprints, fixtures, jobs,
  samplesPerWorker: smoke ? 1 : 3,
  zip: {level: 1, chunkSize: 262144, forceZip64: true, timestamp: '1980-01-01T00:00:00.000Z', entries: 1},
  schedule: 'Sequential fresh workers, rotating methods; each writes an untimed verification archive, warms once, then measures three complete ZIP responses to a counting in-memory sink. Warm reads; natural GC; no explicit collection. Both streaming baselines use 64 KiB uncompressed flush targets and yield every 2,048 rows. Before uses the exact saved buffered ZIP build. SQL-framed feeds each native batch directly to ZIP with separators already included by SQLite, reusing the unchanged callback/drain/abort checks. JS object streaming is unchanged. The public API and compression settings are unchanged. Timings include compression, checksums, ZIP finalization and destination completion; exclude process/module startup, verification, disk, HTTP and network. RSS is a process high-water mark including startup, verification, warmup and three timed exports.',
  packageVersionCheck: {checked: new Date().toISOString(), betterSqlite3: '13.0.3', zipStream: '7.0.5', yauzl: '3.4.0', sources: ['https://registry.npmjs.org/better-sqlite3/latest','https://www.npmjs.com/package/zip-stream','https://www.npmjs.com/package/yauzl?activeTab=versions']},
};
mkdirSync(`${resultDirectory}raw`, {recursive: true});
writeFileSync(`${resultDirectory}configuration.json`, JSON.stringify(configuration, null, 2));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'exportlite-zip-comparison-'));
const all = [];
const validation = [];
const archiveDigests = new Map();
try {
  for (const job of jobs) {
    const stem = `${job.dataset}-${job.method}-${job.repeat}`;
    const output = `${resultDirectory}raw/${stem}.json`;
    const archive = `${temporaryDirectory}/${stem}.zip`;
    await new Promise((resolve, reject) => {
      const child = spawn(node, [`${directory}worker.mjs`, `--dataset=${job.dataset}`, `--method=${job.method === "objects" ? "objects" : "exportlite"}`, `--variant=${job.method}`, `--samples=${smoke ? 1 : 3}`, `--archive=${archive}`, `--out=${output}`], {cwd: root, stdio: 'inherit'});
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker failed: ${code}`)));
    });
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.environment.node, 'v26.12.0');
    assert.equal(statSync(archive).size, result.verification.bytes);
    const encodedHash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) encodedHash.update(chunk);
    const encodedSha256 = encodedHash.digest('hex');
    assert.equal(encodedSha256, result.verification.archiveSha256);
    if (archiveDigests.has(job.dataset)) assert.equal(encodedSha256, archiveDigests.get(job.dataset));
    else archiveDigests.set(job.dataset, encodedSha256);
    const decoded = await readZip(archive, {name: result.entryName});
    assert.equal(decoded.sha256, fixtures[job.dataset].expected.sha256);
    assert.equal(decoded.bytes, fixtures[job.dataset].expected.bytes);
    assert(result.samples.every(sample => sample.bytes === result.verification.bytes));
    validation.push({dataset: job.dataset, method: job.method, repeat: job.repeat, encodedBytes: result.verification.bytes, encodedSha256, decoded, passed: true});
    all.push({...result, method: job.method});
    rmSync(archive);
    writeFileSync(`${resultDirectory}validation.json`, JSON.stringify(validation, null, 2));
  }
} finally {
  rmSync(temporaryDirectory, {recursive: true, force: true});
}
writeFileSync(`${resultDirectory}all.json`, JSON.stringify(all, null, 2));
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const summary = [];
for (const dataset of smoke ? ['narrow','wide'] : ['matched','narrow','wide']) for (const method of methods) {
  const group = all.filter(row => row.dataset === dataset && row.method === method);
  assert.equal(group.length, smoke ? 1 : 5);
  const times = group.map(row => row.median.totalMs);
  summary.push({dataset, method, workers: group.length, totalMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), peakRssMiB: median(group.map(row => row.peakRssMiB)), zipBytes: group[0].median.bytes, jsonBytes: group[0].expected.bytes, encodedSha256: group[0].verification.archiveSha256, decodedSha256: group[0].expected.sha256});
}
for (const [file, digest] of Object.entries(fingerprints)) assert.equal(sha256(`${root}${file}`), digest);
assert.equal(validation.length, jobs.length);
writeFileSync(`${resultDirectory}summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
