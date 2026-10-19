import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
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
const fingerprintPaths = ['exportlite/dist/index.mjs', 'exportlite/src/output/writer.ts', 'exportlite/src/output/zip.ts', 'exportlite/benchmarks/baselines/pre-direct-zip/dist/index.mjs', ...['fixed-1024','fixed-4096','adaptive-p95'].map(mode => `outputs/zip-batch-sizing/variants/${mode}/dist/index.mjs`), 'outputs/zip-running-average/variants/adaptive-mean/dist/index.mjs', 'outputs/zip-running-average/worker.mjs', 'outputs/zip-running-average/run.mjs'];
const fingerprints = Object.fromEntries(fingerprintPaths.map(file => [file, sha256(`${root}${file}`)]));
const previous = JSON.parse(readFileSync(`${root}outputs/performance-current/configuration.json`, 'utf8'));
assert.equal(fingerprints['exportlite/benchmarks/baselines/pre-direct-zip/dist/index.mjs'], previous.fingerprints['exportlite/dist/index.mjs']);

const methods = ['buffered', 'fixed-1024', 'fixed-4096', 'adaptive-p95', 'adaptive-mean'];
const jobs = [];
for (let repeat = 0; repeat < (smoke ? 1 : 5); repeat++) {
  for (const dataset of ['matched', 'narrow', 'wide']) {
    for (let offset = 0; offset < methods.length; offset++) jobs.push({dataset, method: methods[(repeat + offset) % methods.length], repeat});
  }
}
const configuration = {
  date: new Date().toISOString(), node, cpu: cpus()[0].model, logicalCpus: cpus().length, loadavg: loadavg(), fingerprints, fixtures, jobs,
  samplesPerWorker: smoke ? 1 : 3,
  zip: {level: 1, chunkSize: 262144, forceZip64: true, timestamp: '1980-01-01T00:00:00.000Z', entries: 1},
  schedule: 'Sequential fresh workers with rotating method order. Each verifies an actual ZIP, warms once and measures three complete ZIP exports. Same fixtures, Node 26.12.0, compression and unchanged callback/drain/cancellation lifecycle. Timings include planning, JSON generation, encoding, compression, ZIP finalization and destination completion, excluding process/module startup, verification, disk, HTTP and network. Natural GC. RSS is whole-process high-water including verification, warmup and timed samples. Buffered = unchanged 256-row default; fixed variants feed SQL-framed native batches directly to ZIP; adaptive-p95 = historical p95 of last 64 total batch byte sizes; adaptive-mean = cumulative mean batch bytes / cumulative mean batch rows (equivalently total bytes / total rows), using two counters and no sample window; both use target 256 KiB with 10% headroom, initial 64 rows, at most doubling, 1–65536 rows. Active adaptive state is scoped to the iterator. Plain output and prepare-only adapter fallbacks retain 256 rows.',

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
      const child = spawn(node, [`${directory}worker.mjs`, `--dataset=${job.dataset}`, `--method=exportlite`, `--variant=${job.method}`, `--samples=${smoke ? 1 : 3}`, `--archive=${archive}`, `--out=${output}`], {cwd: root, stdio: 'inherit'});
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
    const priorZip = JSON.parse(readFileSync(`${root}outputs/performance-zip/summary.json`, 'utf8')).find(row => row.dataset === job.dataset);
    assert.equal(encodedSha256, priorZip.encodedSha256);
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
for (const dataset of ['matched','narrow','wide']) for (const method of methods) {
  const group = all.filter(row => row.dataset === dataset && row.method === method);
  assert.equal(group.length, smoke ? 1 : 5);
  const times = group.map(row => row.median.totalMs);
  summary.push({dataset, method, workers: group.length, totalMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), peakRssMiB: median(group.map(row => row.peakRssMiB)), zipBytes: group[0].median.bytes, jsonBytes: group[0].expected.bytes, encodedSha256: group[0].verification.archiveSha256, decodedSha256: group[0].expected.sha256});
}
for (const [file, digest] of Object.entries(fingerprints)) assert.equal(sha256(`${root}${file}`), digest);
assert.equal(validation.length, jobs.length);
writeFileSync(`${resultDirectory}summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
