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
const apis={before:await import(new URL('./baseline/dist/index.mjs',import.meta.url)),framed:await import(new URL('./variant/dist/index.mjs',import.meta.url))};
const dataset=process.argv[2];
const metadata=JSON.parse(readFileSync(new URL('./fixtures.json',import.meta.url),'utf8')).cases.find(row=>row.name===dataset);
const expected=metadata.zip?metadata.expectedZip:metadata.expected;
const db=new Database(metadata.path,{readonly:true});
const table=metadata.table;
const columns=['id','name','note','active'];
async function run(method,verify=false){
 let bytes=0;const hash=verify?createHash('sha256'):undefined;
 const sink=new Writable({highWaterMark:65536,write(chunk,_encoding,callback){bytes+=chunk.length;hash?.update(chunk);callback();}});
 const started=performance.now();
 const result=await apis[method].exportTable(db,table,{columns,format:'json',zip:metadata.zip,output:sink,end:true});
 const totalMs=performance.now()-started;
 assert.equal(bytes,expected.bytes);assert.equal(result.bytesWritten,bytes);assert.equal(result.rowsExported,metadata.rows);
 if(verify)assert.equal(hash.digest('hex'),expected.sha256);
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
const result={dataset,node:process.version,note:'Timing-only supporting control: both methods share one process; six adjacent pairs with alternating order, natural GC and no explicit collection. Not an isolated RSS comparison. Each method independently verifies its complete output hash before warmup. Both methods use memLevel 9, fixed 256-row batches and the existing output buffering. before=cache-free baseline; framed=planning-cache prototype (inherited field names from prior timing control).',pairs,medianBeforeMs:median(pairs.map(row=>row.before)),medianFramedMs:median(pairs.map(row=>row.framed)),medianPairedRatio:median(pairs.map(row=>row.ratio))};
db.close();writeFileSync(new URL(`paired-${dataset}.json`,import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({dataset,before:result.medianBeforeMs,framed:result.medianFramedMs,ratio:result.medianPairedRatio}));
