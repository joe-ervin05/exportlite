import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,loadavg,cpus} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=fileURLToPath(new URL('.',import.meta.url));
const node='<node-26.12.0>';
const fixtures=JSON.parse(readFileSync(`${directory}fixtures.json`,'utf8'));
const smoke=process.argv.includes('--smoke');
if(smoke)fixtures.cases=fixtures.cases.filter(row=>['table-1','narrow-plain','wide-zip'].includes(row.name));
const rounds=smoke?1:5;
const output=`${directory}${smoke?'smoke':'comparison'}/`;
mkdirSync(`${output}raw`,{recursive:true});
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const fixture of fixtures.cases)assert.equal(digest(fixture.path),fixture.fixtureSha256??fixtures.smallFixtureSha256);
const tracked=['exportlite/dist/index.mjs','exportlite/src/output/zip.ts','outputs/declared-primary-key/baseline/dist/index.mjs','outputs/declared-primary-key/variant/dist/index.mjs','outputs/declared-primary-key/worker.mjs','outputs/declared-primary-key/run.mjs'];
const fingerprints=Object.fromEntries(tracked.map(file=>[file,digest(`${root}${file}`)]));
assert.equal(fingerprints['exportlite/dist/index.mjs'],fingerprints['outputs/declared-primary-key/variant/dist/index.mjs']);
const jobs=[];
for(let repeat=0;repeat<rounds;repeat++)for(const fixture of fixtures.cases)for(const method of repeat%2?['variant','baseline']:['baseline','variant'])jobs.push({name:fixture.name,method,repeat});
writeFileSync(`${output}configuration.json`,JSON.stringify({date:new Date().toISOString(),node,cpu:cpus()[0].model,loadavg:loadavg(),fixtures,jobs,fingerprints,schedule:'Sequential fresh workers, alternating method order by round. Five workers per case and method; each verifies bytes/SHA-256, warms, then measures three request batches. Small cases consume public Web streams through Response.arrayBuffer; bulk cases use a counting Node writable. Connection open/close excluded for cold cases. Natural GC, no forced collection. Peak RSS is whole-worker high-water across verification, warmup and measurements, captured before untimed query-count diagnostics. Same typed field selection, fixed 256-row batches, 64 KiB output flush target, ZIP level 1 / memLevel 9 / 256 KiB zlib buffer. Same fixture files and exact Node 26.12.0. No HTTP or remote database latency included.'},null,2));
const temporary=mkdtempSync(join(tmpdir(),'exportlite-declared-pk-verify-'));
const {readZip}=await import(`${root}exportlite/benchmarks/read-zip.mjs`);
const all=[],validation=[];
try {
 for(const job of jobs) {
  const file=`${output}raw/${job.name}-${job.method}-${job.repeat}.json`;
  const archive=`${temporary}/${job.name}-${job.method}-${job.repeat}.zip`;
  await new Promise((resolve,reject)=>{
   const child=spawn(node,[`${directory}worker.mjs`,job.name,job.method,file,archive],{cwd:root,stdio:'inherit'});
   child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Worker failed: ${code}`)));
  });
  const result=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(result.environment.node,'v26.12.0');assert.equal(result.environment.sqlite,'3.53.4');
  let decoded;
  if(result.fixture.zip) {
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
 const group=all.filter(row=>row.name===fixture.name&&row.variant===method);assert.equal(group.length,rounds);
 const values=group.map(row=>row.median.perRequestMs);
 summary.push({name:fixture.name,method,rows:fixture.rows,workers:group.length,perRequestMs:median(values),minMs:Math.min(...values),maxMs:Math.max(...values),peakRssMiB:median(group.map(row=>row.peakRssMiB)),minRssMiB:Math.min(...group.map(row=>row.peakRssMiB)),maxRssMiB:Math.max(...group.map(row=>row.peakRssMiB)),outputBytes:group[0].verification.bytes,sha256:group[0].verification.sha256});
}
for(const fixture of fixtures.cases){const rows=summary.filter(row=>row.name===fixture.name);assert.equal(rows[0].outputBytes,rows[1].outputBytes);assert.equal(rows[0].sha256,rows[1].sha256);}
for(const [file,hash]of Object.entries(fingerprints))assert.equal(digest(`${root}${file}`),hash,file);
writeFileSync(`${output}summary.json`,JSON.stringify(summary,null,2));
const csv=['case,setting,rows,median_ms,min_ms,max_ms,median_peak_rss_mib,min_rss_mib,max_rss_mib,output_bytes'];
for(const row of summary)csv.push([row.name,row.method,row.rows,row.perRequestMs,row.minMs,row.maxMs,row.peakRssMiB,row.minRssMiB,row.maxRssMiB,row.outputBytes].join(','));
writeFileSync(`${output}summary.csv`,`${csv.join('\n')}\n`);
console.log(JSON.stringify(summary,null,2));
