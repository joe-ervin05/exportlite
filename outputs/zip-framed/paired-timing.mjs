import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
assert.equal(process.version,'v26.12.0');
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/benchmarks/matched-api/package.json`);
const Database=require('better-sqlite3');
const apis={before:await import(`${root}exportlite/benchmarks/baselines/pre-direct-zip/dist/index.mjs`),framed:await import(`${root}exportlite/benchmarks/baselines/sql-framed-zip-prototype/dist/index.mjs`)};
const dataset=process.argv[2];
const metadata=JSON.parse(readFileSync(`${root}exportlite/benchmarks/results/batch-profile/fixtures.json`,'utf8'))[dataset];
const expected=JSON.parse(readFileSync(`${root}outputs/performance-zip/summary.json`,'utf8')).find(row=>row.dataset===dataset);
const db=new Database(metadata.path,{readonly:true});
const table=dataset==='matched'?'users':'data';
const columns=dataset==='matched'?['name']:['id','name','note','active'];
async function run(method,verify=false){
 let bytes=0;const hash=verify?createHash('sha256'):undefined;
 const sink=new Writable({highWaterMark:65536,write(chunk,_encoding,callback){bytes+=chunk.length;hash?.update(chunk);callback();}});
 const started=performance.now();
 const result=await apis[method].exportTable(db,table,{columns,format:'json',zip:true,output:sink,end:true});
 const totalMs=performance.now()-started;
 assert.equal(bytes,expected.zipBytes);assert.equal(result.bytesWritten,bytes);assert.equal(result.rowsExported,metadata.rows);
 if(verify)assert.equal(hash.digest('hex'),expected.encodedSha256);
 return totalMs;
}
for(const method of ['before','framed']){await run(method,true);await run(method);}
const pairs=[];
for(let repeat=0;repeat<6;repeat++){
 const order=repeat%2?['framed','before']:['before','framed'];const times={};
 for(const method of order)times[method]=await run(method);
 pairs.push({repeat,order,...times,ratio:times.framed/times.before});
}
const median=values=>{const a=[...values].sort((x,y)=>x-y);const middle=Math.floor(a.length/2);return a.length%2?a[middle]:(a[middle-1]+a[middle])/2;};
const result={dataset,node:process.version,note:'Timing-only supporting control: both methods share one process; six adjacent pairs with alternating order, natural GC and no explicit collection. Not an isolated RSS comparison. Each method independently verifies its complete ZIP hash before warmup.',pairs,medianBeforeMs:median(pairs.map(row=>row.before)),medianFramedMs:median(pairs.map(row=>row.framed)),medianPairedRatio:median(pairs.map(row=>row.ratio))};
db.close();writeFileSync(new URL(`paired-${dataset}.json`,import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({dataset,before:result.medianBeforeMs,framed:result.medianFramedMs,ratio:result.medianPairedRatio}));
