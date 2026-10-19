import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {cpus} from 'node:os';
import {join} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {finished,pipeline} from 'node:stream/promises';
import {setImmediate as tick} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/package.json`);
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.version,'v26.12.0');
if(process.argv[2]==='worker'){
 const [fixtureText,method,compression]=process.argv.slice(3);const fixture=JSON.parse(fixtureText);
 const Database=require('better-sqlite3');const db=new Database(fixture.path,{readonly:true});
 const build=process.env.EXPORTLITE_BUILD??`${root}exportlite/dist`;
 const api=method.startsWith('manual')?undefined:await import(pathToFileURL(join(build,'index.mjs')));
 const zip=compression==='zip';const ZipStream=zip?(await import(pathToFileURL(require.resolve('zip-stream')))).default:undefined;
 const hasModes=fixture.columns.some(c=>c.mode);const names=fixture.columns.map(c=>c.key);const sql=`SELECT ${names.map(n=>`"${n}"`).join(',')} FROM data ORDER BY id`;
 let orm,table,adapter;
 if(fixture.drizzle&&api){
  const {drizzle}=require('drizzle-orm/better-sqlite3');const schema=require('drizzle-orm/sqlite-core');
  table=schema.sqliteTable('data',Object.fromEntries(fixture.columns.map(c=>[c.key,c.primary?schema.integer(c.key).primaryKey():c.type==='integer'?schema.integer(c.key,c.mode?{mode:c.mode}:undefined):schema.text(c.key,c.mode?{mode:c.mode}:undefined)])));
  orm=drizzle(db);adapter=await import(pathToFileURL(join(build,'drizzle.mjs')));
 }
 const columns=api&&Object.fromEntries(fixture.columns.map(c=>{let value=c.type==='integer'?api.integer(c.key,c.mode?{mode:c.mode}:undefined):api.text(c.key);if(c.primary)value=value.primaryKey();return[c.key,value]}));
 const quote=v=>v===null?'':typeof v==='string'?`"${v.replaceAll('"','""')}"`:String(v);
 const encoders=fixture.columns.map(c=>c.mode==='boolean'?(v)=>v===null?'':v?'\"true\"':'\"false\"':c.mode==='json'?(v)=>v===null?'':quote(JSON.stringify(JSON.parse(v))):quote);
 const normalized=(v,c)=>v===null?null:c.mode==='boolean'?(v?'true':'false'):c.mode==='json'?JSON.stringify(JSON.parse(v)):v;
 async function generate(sink){
  const statement=db.prepare(sql);let parts=[],size=0;
  async function flush(){
   if(!size)return;const bytes=Buffer.from(parts.join(''));parts=[];size=0;
   await new Promise((resolve,reject)=>{
    let callbackDone=false,drained=false,writing=true;
    const cleanup=()=>{sink.off('error',fail);sink.off('drain',onDrain)};
    const complete=()=>{if(!writing&&callbackDone&&drained){cleanup();resolve()}};
    const fail=e=>{cleanup();reject(e)};const onDrain=()=>{drained=true;complete()};
    sink.once('error',fail);sink.once('drain',onDrain);
    drained=sink.write(bytes,e=>{if(e)return;callbackDone=true;complete()});writing=false;complete();
   });
  }
  const append=s=>{parts.push(s);size+=Buffer.byteLength(s);return size>=65536?flush():undefined};
  append(names.map(quote).join(',')+'\r\n');let count=0;
  for(const row of statement.iterate()){
   const record=method==='manual-tuned'?(names.length===4?`${encoders[0](row.id)},${encoders[1](row.name)},${encoders[2](row.note)},${encoders[3](row.active)}\r\n`:names.map((key,index)=>encoders[index](row[key])).join(',')+'\r\n'):names.length===4&&!hasModes?`${quote(row.id)},${quote(row.name)},${quote(row.note)},${quote(row.active)}\r\n`:names.length===4?`${quote(normalized(row.id,fixture.columns[0]))},${quote(normalized(row.name,fixture.columns[1]))},${quote(normalized(row.note,fixture.columns[2]))},${quote(normalized(row.active,fixture.columns[3]))}\r\n`:fixture.columns.map(c=>quote(normalized(row[c.key],c))).join(',')+'\r\n';
   const wait=append(record);if(wait)await wait;if(++count%2048===0)await tick();
  }
  await flush();const done=finished(sink,{readable:false,cleanup:true});sink.end();await done;
 }
 async function consume(verify){
  let bytes=0;const digest=verify?createHash('sha256'):undefined;
  const sink=new Writable({highWaterMark:65536,write(chunk,_e,cb){bytes+=chunk.length;digest?.update(chunk);cb()}});
  if(api){
   const options={format:'csv',zip,output:sink,end:true};let result;
   if(fixture.drizzle)result=method==='table'?await adapter.exportTable(orm,table,options):await adapter.exportQuery(orm,orm.select().from(table).orderBy(table.id),options);
   else result=method==='table'?await api.exportTable(db,'data',{...options,columns}):await api.exportQuery(db,{...options,columns,sql});
   assert.equal(result.rowsExported,fixture.rows);assert.equal(result.bytesWritten,bytes);
  }else if(zip){
   const input=new PassThrough({highWaterMark:65536});const archive=new ZipStream({forceZip64:true,zlib:{level:1,memLevel:9,chunkSize:262144}});
   const done=pipeline(archive,sink);done.catch(()=>{});
   archive.entry(input,{name:'data.csv',date:new Date('1980-01-01T00:00:00Z')},e=>e?archive.destroy(e):archive.finalize());
   try{await generate(input);await done}catch(e){input.destroy();archive.destroy(e);await done.catch(()=>{});throw e}
  }else await generate(sink);
  return{bytes,...(digest?{sha256:digest.digest('hex')}:{})};
 }
 try{
  const verified=await consume(true);for(let i=0;i<2;i++)await consume(false);
  const samplesMs=[],cpuMs=[];
  for(let i=0;i<3;i++){
   const cpu=process.cpuUsage();const t=performance.now();for(let j=0;j<fixture.iterations;j++)await consume(false);
   samplesMs.push((performance.now()-t)/fixture.iterations);const used=process.cpuUsage(cpu);cpuMs.push((used.user+used.system)/1000/fixture.iterations);
  }
  console.log(JSON.stringify({fixture:fixture.name,method,compression,...verified,samplesMs,medianMs:median(samplesMs),cpuSamplesMs:cpuMs,medianCpuMs:median(cpuMs),peakRssMiB:process.resourceUsage().maxRSS/1024}));
 }finally{db.close()}
}else{
 const fixtures=JSON.parse(await readFile(`${root}outputs/csv-deep/fixtures/configuration.json`,'utf8'));
 const rounds=Number(process.env.BENCH_ROUNDS??5);const output=process.env.BENCH_OUT??`${root}outputs/csv-deep/comparison`;await mkdir(output,{recursive:true});
 const builds={before:`${root}outputs/csv-deep/builds/baseline/dist`,after:process.env.EXPORTLITE_AFTER??`${root}exportlite/dist`};
 const cases=[['before','table'],['after','table'],['before','query'],['after','query'],['control','manual']];const all=[];
 for(let round=0;round<rounds;round++){
  const order=[...cases.slice(round%cases.length),...cases.slice(0,round%cases.length)];
  for(const f of fixtures)for(const compression of ['none','zip'])for(const[variant,method]of order){
   const c=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'worker',JSON.stringify(f),method,compression],{encoding:'utf8',maxBuffer:1e6,env:{...process.env,EXPORTLITE_BUILD:builds[variant]??builds.after}});
   assert.equal(c.status,0,c.stderr);const row={round,variant,...JSON.parse(c.stdout)};
   if(compression==='none'){assert.equal(row.sha256,f.csvSha256);assert.equal(row.bytes,f.bytes)}all.push(row);
  }
  await writeFile(`${output}/all.json`,JSON.stringify(all,null,2)+'\n');console.error(`Finished deep CSV round ${round+1}/${rounds}.`);
 }
 const summary=[];
 for(const f of fixtures)for(const compression of ['none','zip']){
  const group=all.filter(r=>r.fixture===f.name&&r.compression===compression);
  assert.equal(new Set(group.filter(r=>compression==='none'||r.method!=='query').map(r=>r.sha256)).size,1);
  assert.equal(new Set(group.filter(r=>r.method==='query').map(r=>r.sha256)).size,1);
  for(const[variant,method]of cases){const rows=group.filter(r=>r.variant===variant&&r.method===method);summary.push({fixture:f.name,compression,variant,method,medianMs:median(rows.map(r=>r.medianMs)),minMs:Math.min(...rows.map(r=>r.medianMs)),maxMs:Math.max(...rows.map(r=>r.medianMs)),medianCpuMs:median(rows.map(r=>r.medianCpuMs)),medianPeakRssMiB:median(rows.map(r=>r.peakRssMiB)),maxPeakRssMiB:Math.max(...rows.map(r=>r.peakRssMiB)),bytes:rows[0].bytes,sha256:rows[0].sha256})}
 }
 const buildHashes={};for(const[variant,path]of Object.entries(builds)){buildHashes[variant]={};for(const file of(await readdir(path)).filter(n=>n.endsWith('.mjs')).sort())buildHashes[variant][file]=hash(await readFile(join(path,file)))}
 await writeFile(`${output}/summary.json`,JSON.stringify(summary,null,2)+'\n');
 await writeFile(`${output}/configuration.json`,JSON.stringify({node:process.version,nodeSha256:hash(await readFile(process.execPath)),cpu:cpus()[0]?.model,sourceCommit:'e601d1a61121c8a4eb27092f3869808b50aca412',rounds,cases,fixtures:fixtures.map(({path,...f})=>f),builds:buildHashes,protocol:'Sequential fresh workers, rotating five-case order. One output verification, two warmups, three timed batches; two exports per bulk batch, 50 tiny. Natural GC, no profiling/forced GC. Counting Node writable; planning, generation, encoding/ZIP and completion included; imports/connection excluded from time. Peak RSS is whole-process including imports/warmups/repeated exports. Fixed 256-row SQL batches, 64 KiB writer and yields every 2048 rows. ZIP level 1, memLevel 9, 256 KiB compression output chunks, unchanged library/CRC. Plain bytes independently match csv-stringify and parse to original fixture values. All before/after and same-name manual archive hashes match. JSON-mode uses Drizzle metadata and manual JS parses/stringifies JSON to match native canonical cells. CPU usage includes process threads.'},null,2)+'\n');
 console.log(JSON.stringify({workers:all.length,cases:summary.length}));
}
