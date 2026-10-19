import assert from 'node:assert/strict';
import{createRequire}from'node:module';
import{createHash}from'node:crypto';
import{readFile,writeFile}from'node:fs/promises';
import{Writable}from'node:stream';
import{fileURLToPath,pathToFileURL}from'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));const require=createRequire(`${root}exportlite/package.json`);const Database=require('better-sqlite3');
const fixtures=JSON.parse(await readFile(`${root}outputs/csv-deep/fixtures/configuration.json`,'utf8'));
const builds={before:`${root}outputs/csv-deep/builds/baseline/dist`,after:`${root}exportlite/dist`};
async function open(build,f,method,format,zip,execute){
 const api=await import(pathToFileURL(`${build}/index.mjs`));const db=new Database(f.path,{readonly:true});const statements=[];const prepare=db.prepare.bind(db);db.prepare=s=>{statements.push(s);return prepare(s)};
 const digest=createHash('sha256');const chunks=[];let bytes=0;
 const output=new Writable({write(chunk,_e,cb){digest.update(chunk);chunks.push(chunk.length);bytes+=chunk.length;cb()}});
 const options={format,zip,...(execute?{output,end:true}:{})};let pending;
 if(f.drizzle){
  const{drizzle}=require('drizzle-orm/better-sqlite3');const schema=require('drizzle-orm/sqlite-core');const table=schema.sqliteTable('data',Object.fromEntries(f.columns.map(c=>[c.key,c.primary?schema.integer(c.key).primaryKey():c.type==='integer'?schema.integer(c.key,c.mode?{mode:c.mode}:undefined):schema.text(c.key,c.mode?{mode:c.mode}:undefined)])));
  const adapter=await import(pathToFileURL(`${build}/drizzle.mjs`));const orm=drizzle(db);
  pending=method==='table'?adapter.exportTable(orm,table,options):adapter.exportQuery(orm,orm.select().from(table).orderBy(table.id),options);
 }else{
  const columns=Object.fromEntries(f.columns.map(c=>{let v=c.type==='integer'?api.integer(c.key,c.mode?{mode:c.mode}:undefined):api.text(c.key);if(c.primary)v=v.primaryKey();return[c.key,v]}));
  pending=method==='table'?api.exportTable(db,'data',{...options,columns}):api.exportQuery(db,{...options,columns,sql:'SELECT * FROM data ORDER BY id'});
 }
 try{
  const result=await pending;
  if(!execute){await result.cancel();await assert.rejects(result.result,e=>e.code==='ABORTED')}
  else{assert.equal(result.rowsExported,f.rows);assert.equal(result.bytesWritten,bytes)}
  assert.equal(statements.length,1);return{sql:statements[0],bytes,sha256:digest.digest('hex'),chunks};
 }finally{db.close()}
}
const cases=[];for(const f of fixtures)for(const method of['table','query']){
 for(const format of['json','jsonl']){
  const a=await open(builds.before,f,method,format,false,false);const b=await open(builds.after,f,method,format,false,false);
  assert.equal(a.sql,b.sql);cases.push({fixture:f.name,method,format,generatedSqlIdentical:true,preparedStatements:1});
 }
 for(const zip of[false,true]){
  const a=await open(builds.before,f,method,'csv',zip,true);const b=await open(builds.after,f,method,'csv',zip,true);
  assert.equal(a.sha256,b.sha256);assert.equal(a.bytes,b.bytes);if(!zip)assert.deepEqual(a.chunks,b.chunks);
  cases.push({fixture:f.name,method,format:'csv',zip,bytes:b.bytes,sha256:b.sha256,plainChunkBoundariesIdentical:zip?undefined:true,zipChunkBoundariesIdentical:zip?JSON.stringify(a.chunks)===JSON.stringify(b.chunks):undefined,preparedStatements:1});
 }
}
await writeFile(`${root}outputs/csv-deep/equivalence.json`,JSON.stringify({node:process.version,cases},null,2)+'\n');console.log('Verified 40 unchanged JSON/JSONL plans and 40 CSV/plain-ZIP equivalence cases, each with one statement.');
