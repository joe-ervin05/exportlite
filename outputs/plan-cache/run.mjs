import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,createReadStream } from 'node:fs';
import { tmpdir,loadavg,cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=fileURLToPath(new URL('.',import.meta.url));
const node='<node-26.12.0>';
const fixtures=JSON.parse(readFileSync(`${directory}fixtures.json`,'utf8'));
const smoke=process.argv.includes('--smoke');
const output=smoke?`${directory}smoke/`:directory;
mkdirSync(`${output}raw`,{recursive:true});
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(digest(fixtures.path),fixtures.sha256);
assert.equal(digest(fixtures.sourceFixture.path),fixtures.sourceFixture.fixtureSha256);
const fingerprints=Object.fromEntries(['exportlite/dist/index.mjs','exportlite/src/output/zip.ts','outputs/plan-cache/baseline/dist/index.mjs','outputs/plan-cache/variant/dist/index.mjs','outputs/plan-cache/worker.mjs','outputs/plan-cache/run.mjs'].map(file=>[file,digest(`${root}${file}`)]));
assert.equal(fingerprints['exportlite/dist/index.mjs'],fingerprints['outputs/plan-cache/baseline/dist/index.mjs']);
const jobs=[];
for(let repeat=0;repeat<(smoke?1:5);repeat++)for(const fixture of fixtures.cases)for(const method of repeat%2?['variant','baseline']:['baseline','variant'])jobs.push({name:fixture.name,method,repeat});
writeFileSync(`${output}configuration.json`,JSON.stringify({date:new Date().toISOString(),node,cpu:cpus()[0].model,loadavg:loadavg(),fixtures,jobs,fingerprints,schedule:'Sequential fresh workers, alternating baseline/cache order by round. Every worker verifies output SHA-256 and bytes, warms then measures three batches of requests. Warm cases reuse a connection; cold cases create a new connection before each request timer. Opening/closing connections excluded. Web Response body collection included for small cases; bulk controls use a counting Node writable. Natural GC. RSS is whole-worker high-water across verification, warmup and timed requests. Both versions use fixed 256-row batches, default 64 KiB output flush target, and memLevel 9 ZIP settings. No data or complete-response cache. Query exports cache only successful capability probes, always refreshing query column metadata.'},null,2));
const temporary=mkdtempSync(join(tmpdir(),'exportlite-plan-cache-verify-'));
const {readZip}=await import(`${root}exportlite/benchmarks/read-zip.mjs`);
const all=[];const validation=[];
try {
  for(const job of jobs) {
    const file=`${output}raw/${job.name}-${job.method}-${job.repeat}.json`;
    const archive=`${temporary}/${job.name}-${job.method}-${job.repeat}.zip`;
    await new Promise((resolve,reject)=>{
      const child=spawn(node,[`${directory}worker.mjs`,job.name,job.method,file,archive],{cwd:root,stdio:'inherit'});
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Worker failed: ${code}`)));
    });
    const result=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(result.environment.node,'v26.12.0');
    let decoded;
    if(result.fixture.zip) {
      const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
      assert.equal(hash.digest('hex'),result.verification.sha256);
      decoded=await readZip(archive,{name:'data.json'});
      assert.equal(decoded.sha256,result.fixture.expected.sha256);assert.equal(decoded.bytes,result.fixture.expected.bytes);
      rmSync(archive);
    }
    validation.push({...job,bytes:result.verification.bytes,sha256:result.verification.sha256,decoded,passed:true});
    all.push({...result,repeat:job.repeat});
    writeFileSync(`${output}validation.json`,JSON.stringify(validation,null,2));
  }
} finally {rmSync(temporary,{recursive:true,force:true});}
writeFileSync(`${output}all.json`,JSON.stringify(all,null,2));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=[];
for(const fixture of fixtures.cases)for(const method of ['baseline','variant']) {
  const group=all.filter(row=>row.name===fixture.name&&row.variant===method);assert.equal(group.length,smoke?1:5);
  const values=group.map(row=>row.median.perRequestMs);
  summary.push({name:fixture.name,method,rows:fixture.rows,workers:group.length,perRequestMs:median(values),minMs:Math.min(...values),maxMs:Math.max(...values),peakRssMiB:median(group.map(row=>row.peakRssMiB)),minRssMiB:Math.min(...group.map(row=>row.peakRssMiB)),maxRssMiB:Math.max(...group.map(row=>row.peakRssMiB)),outputBytes:group[0].verification.bytes,sha256:group[0].verification.sha256});
}
for(const [file,hash]of Object.entries(fingerprints))assert.equal(digest(`${root}${file}`),hash,file);
writeFileSync(`${output}summary.json`,JSON.stringify(summary,null,2));
const csv=['case,setting,rows,median_ms,min_ms,max_ms,median_peak_rss_mib,min_rss_mib,max_rss_mib,output_bytes'];
for(const row of summary)csv.push([row.name,row.method,row.rows,row.perRequestMs,row.minMs,row.maxMs,row.peakRssMiB,row.minRssMiB,row.maxRssMiB,row.outputBytes].join(','));
writeFileSync(`${output}summary.csv`,`${csv.join('\n')}\n`);
console.log(JSON.stringify(summary,null,2));
