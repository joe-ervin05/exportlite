import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/benchmarks/matched-api/package.json`);
const Database=require('better-sqlite3');
assert.equal(process.version,'v26.12.0');
const [name,variant,output,archive]=process.argv.slice(2);
const fixture=JSON.parse(readFileSync(new URL('./fixtures.json',import.meta.url),'utf8')).cases.find(row=>row.name===name);
assert(fixture);
assert(['baseline','variant'].includes(variant));
const api=await import(new URL(`./${variant}/dist/index.mjs`,import.meta.url));
const db=fixture.cold?undefined:new Database(fixture.path,{readonly:true});

async function consume(connection,verify=false) {
  const options={format:'json',zip:fixture.zip};
  if(!name.startsWith('bulk-')) {
    const stream=fixture.api==='table'?await api.exportTable(connection,fixture.table,{...options,columns:['id','name','note','active']}):await api.exportQuery(connection,{...options,sql:'SELECT id,name,note,active FROM main.data1000 ORDER BY id LIMIT ?',params:[fixture.rows]});
    const buffer=await new Response(stream).arrayBuffer();
    const stats=await stream.result;
    assert.equal(stats.rowsExported,fixture.rows);
    return {bytes:buffer.byteLength,sha256:verify?createHash('sha256').update(new Uint8Array(buffer)).digest('hex'):undefined};
  }
  let bytes=0;
  const hash=verify?createHash('sha256'):undefined;
  const file=verify&&fixture.zip?createWriteStream(archive,{flags:'wx'}):undefined;
  const sink=new Writable({write(chunk,_encoding,callback){bytes+=chunk.length;hash?.update(chunk);if(file)file.write(chunk,callback);else callback();},final(callback){if(file)file.end(callback);else callback();}});
  file?.on('error',error=>sink.destroy(error));
  const stats=await api.exportTable(connection,fixture.table,{...options,columns:['id','name','note','active'],output:sink,end:true});
  if(file)await finished(file,{cleanup:true});
  assert.equal(stats.rowsExported,fixture.rows);
  return {bytes,sha256:hash?.digest('hex')};
}

async function once(verify=false) {
  const connection=db??new Database(fixture.path,{readonly:true});
  try {
    const start=performance.now();
    const result=await consume(connection,verify);
    return {...result,totalMs:performance.now()-start};
  } finally {if(!db)connection.close();}
}

try {
  const verification=await once(true);
  const expected=fixture.zip?fixture.expectedZip:fixture.expected;
  assert.equal(verification.bytes,expected.bytes);
  assert.equal(verification.sha256,expected.sha256);
  for(let i=0;i<fixture.warmups;i++)await once();
  const samples=[];
  for(let sample=0;sample<3;sample++) {
    let totalMs=0;
    for(let repeat=0;repeat<fixture.iterations;repeat++) {
      const result=await once();
      assert.equal(result.bytes,expected.bytes);
      totalMs+=result.totalMs;
    }
    samples.push({totalMs,perRequestMs:totalMs/fixture.iterations,requests:fixture.iterations});
  }
  const ordered=[...samples].sort((a,b)=>a.perRequestMs-b.perRequestMs);
  const probe=db??new Database(fixture.path,{readonly:true});
  const sqlite=probe.prepare('SELECT sqlite_version()').pluck().get();
  if(!db)probe.close();
  const result={name,variant,fixture,verification,samples,median:ordered[1],peakRssMiB:process.resourceUsage().maxRSS/1024,environment:{node:process.version,sqlite,driver:require('better-sqlite3/package.json').version},note:'Small cases use public Web streams consumed through Response.arrayBuffer. Bulk controls use a counting Node writable. Cold cases open a fresh connection outside each request timer; all other cases reuse one connection. Natural GC. No HTTP/network.'};
  writeFileSync(output,JSON.stringify(result,null,2));
  console.log(`${name} ${variant}: ${(result.median.perRequestMs*1000).toFixed(1)} us/request; ${result.peakRssMiB.toFixed(1)} MiB peak RSS`);
} finally {db?.close();}
