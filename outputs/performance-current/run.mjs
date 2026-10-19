import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const node = '<node-26.12.0>';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const fixtures = JSON.parse(readFileSync(`${root}exportlite/benchmarks/results/batch-profile/fixtures.json`, 'utf8'));
for (const fixture of Object.values(fixtures)) assert.equal(sha256(fixture.path), fixture.fixtureSha256);
const fingerprintPaths = ['exportlite/dist/index.mjs', 'exportlite/src/output/writer.ts', 'outputs/performance-current/worker.mjs'];
const fingerprints = Object.fromEntries(fingerprintPaths.map(file => [file, sha256(`${root}${file}`)]));
const methods = ['full-blob', 'after', 'objects'];
const jobs = [];
for (let repeat = 0; repeat < 5; repeat++) {
  for (const dataset of ['matched', 'narrow', 'wide']) {
    for (let offset = 0; offset < methods.length; offset++) jobs.push({dataset, method: methods[(repeat + offset) % methods.length], repeat});
  }
}
const configuration = {date: new Date().toISOString(), node, cpu: cpus()[0].model, fingerprints, fixtures, jobs, schedule: 'Sequential workers, rotating methods; each verifies a complete response, warms once, then measures three responses. Warm reads; natural GC; no compression, HTTP, network or disk writes. Both streaming baselines flush at 64 KiB and yield every 2,048 rows.'};
mkdirSync(`${directory}raw`, {recursive: true});
writeFileSync(`${directory}configuration.json`, JSON.stringify(configuration, null, 2));
const all = [];
for (const job of jobs) {
  const output = `${directory}raw/${job.dataset}-${job.method}-${job.repeat}.json`;
  await new Promise((resolve, reject) => {
    const child = spawn(node, [`${directory}worker.mjs`, `--dataset=${job.dataset}`, `--method=${job.method}`, '--mode=output', `--out=${output}`], {cwd: root, stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker failed: ${code}`)));
  });
  all.push(JSON.parse(readFileSync(output, 'utf8')));
}
writeFileSync(`${directory}all.json`, JSON.stringify(all, null, 2));
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const summary = [];
for (const dataset of ['matched','narrow','wide']) for (const method of methods) {
  const group = all.filter(row => row.dataset === dataset && row.method === method);
  assert.equal(group.length, 5);
  assert(group.every(row => row.expected.sha256 === row.verification.sha256 && row.median.bytes === row.expected.bytes));
  const times = group.map(row => row.median.totalMs);
  summary.push({dataset, method, workers: group.length, totalMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), peakRssMiB: median(group.map(row => row.peakRssMiB)), bytes: group[0].expected.bytes, sha256: group[0].expected.sha256});
}
for (const [file, digest] of Object.entries(fingerprints)) assert.equal(sha256(`${root}${file}`), digest);
writeFileSync(`${directory}summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
