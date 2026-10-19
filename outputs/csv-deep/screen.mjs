import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/package.json`);
const Database=require('better-sqlite3');
const api=await import(`${root}outputs/csv-deep/builds/baseline/dist/index.mjs`);
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const values=[0,1,2,3].map(i=>`"__exportlite_c${i}"`);
function record(mode,terminal=false) {
 const cells=values.map((v,i)=>{
  const end=terminal&&i===3;
  const replace=`replace(${v}, '"', '""')`;
  const text=mode==='instr'?`concat('"', CASE WHEN instr(${v}, '"') THEN ${replace} ELSE ${v} END, '"'${end?', char(13, 10)':''})`
   :mode==='printf'?`CASE WHEN instr(${v}, char(0)) THEN concat('"', ${replace}, '"'${end?', char(13, 10)':''}) ELSE printf('"%w"${end?'\r\n':''}', ${v}) END`
   :mode==='concat'?`concat('"', ${replace}, '"'${end?', char(13, 10)':''})`
   :`'"' || ${replace} || '"'${end?' || char(13, 10)':''}`;
  return `CASE typeof(${v}) WHEN 'null' THEN ${end?'char(13, 10)':"''"} WHEN 'blob' THEN json_quote(${v}) WHEN 'text' THEN ${text} ELSE ${end?`concat(CAST(${v} AS TEXT), char(13, 10))`:`CAST(${v} AS TEXT)`} END`;
 });
 return `concat_ws(',', ${cells.join(', ')})`;
}
const variants=['baseline','concat','instr','printf','flat','no-numeric-cast','terminal','terminal-concat','no-prefix','terminal-no-prefix','terminal-concat-no-prefix','batch32','batch64','batch128','batch512','batch1024','text-batch','one-pass','text-first','hint-first','concat-null','concat-null-integer-first','printf-row','null-first-hint'];
function rewrite(sql,variant) {
 if(variant==='one-pass') {
  const source='main."data" AS "__exportlite_source"';
  const key='"__exportlite_source"."id"';
  const projection=values.map((v,i)=>`"__exportlite_source"."${['id','name','note','active'][i]}" AS ${v}`).join(', ');
  const aggregate=`SELECT printf('%020lld%04d', max("__key"), count(*)) || group_concat(${record('baseline')}, char(13, 10)) || char(13, 10) FROM`;
  const chunk=(where)=>`(${aggregate} (SELECT ${projection}, ${key} AS "__key" FROM ${source} ${where} ORDER BY ${key} LIMIT 256))`;
  const boundary=`CAST(substr("data", 1, 20) AS INTEGER)`;
  const count=`CAST(substr("data", 21, 4) AS INTEGER)`;
  return {prefix:false,header:24,sql:`WITH RECURSIVE "__exportlite_batches"("data") AS (
   SELECT ${chunk(`WHERE CASE WHEN ${key} IS NULL THEN json('ExportLite: primary key must not be null') ELSE 1 END`)}
   UNION ALL
   SELECT ${chunk(`WHERE ${key}>${boundary}`)} FROM "__exportlite_batches" WHERE ${count}=256
  ) SELECT CAST("data" AS BLOB), ${count} FROM "__exportlite_batches" WHERE ${count}>0`};
 }
 let newRecord=record('baseline');
 const terminal=variant.includes('terminal');
 if(variant.includes('concat'))newRecord=record('concat',terminal);
 else if(variant==='instr'||variant==='printf')newRecord=record(variant);
 else if(terminal)newRecord=record('baseline',true);
 if(variant==='flat') {
  const pieces=[];
  values.forEach((v,i)=>{
   if(i)pieces.push("','");
   pieces.push(`CASE WHEN typeof(${v})='text' THEN '"' ELSE '' END`);
   pieces.push(`CASE typeof(${v}) WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${v}) WHEN 'text' THEN replace(${v}, '"', '""') ELSE CAST(${v} AS TEXT) END`);
   pieces.push(`CASE WHEN typeof(${v})='text' THEN '"' ELSE '' END`);
  });
  newRecord=`concat(${pieces.join(', ')})`;
 }
 if(variant==='null-first-hint')newRecord=`concat_ws(',', ${values.map((v,i)=>i===0||i===3?`CASE typeof(${v}) WHEN 'null' THEN '' WHEN 'integer' THEN CAST(${v} AS TEXT) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`:`CASE typeof(${v}) WHEN 'null' THEN '' WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`).join(', ')})`;
 if(variant==='text-first')newRecord=`concat_ws(',', ${values.map(v=>`CASE typeof(${v}) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`).join(', ')})`;
 if(variant==='hint-first')newRecord=`concat_ws(',', ${values.map((v,i)=>i===0||i===3?`CASE typeof(${v}) WHEN 'integer' THEN CAST(${v} AS TEXT) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`:`CASE typeof(${v}) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`).join(', ')})`;
 if(variant==='concat-null'||variant==='concat-null-integer-first') {
  const c=values.map((v,i)=>variant.endsWith('integer-first')&&(i===0||i===3)?`CASE typeof(${v}) WHEN 'integer' THEN ${v} WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`:`CASE typeof(${v}) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' WHEN 'blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`);
  newRecord=`concat(${c.join(", ',', ")})`;
 }
 if(variant==='printf-row') {
  const formats=values.map(v=>`CASE typeof(${v}) WHEN 'text' THEN '"%w"' WHEN 'blob' THEN json_quote(${v}) ELSE '%s' END`);
  const guard=values.map(v=>`instr(CAST(${v} AS BLOB), x'00')`).join(' OR ');
  newRecord=`CASE WHEN ${guard} THEN ${record('baseline')} ELSE printf(concat_ws(',', ${formats.join(', ')}), ${values.join(', ')}) END`;
 }
 if(variant==='no-numeric-cast')for(const v of values)newRecord=newRecord.replaceAll(`ELSE CAST(${v} AS TEXT) END`,`ELSE ${v} END`);
 assert(sql.includes(record('baseline')));
 sql=sql.replace(record('baseline'),newRecord);
 if(terminal)sql=sql.replace(`group_concat(${newRecord}, char(13, 10)) || char(13, 10)`,`group_concat(${newRecord}, '')`);
 if(variant.includes('no-prefix'))sql=sql.replace('CAST(char(13, 10) || ', 'CAST(');
 if(variant==='text-batch')sql=sql.replace('CAST(char(13, 10) || ','(').replace(' AS BLOB)',')');
 if(variant.startsWith('batch')){
  const n=Number(variant.slice(5));
  sql=sql.replaceAll('OFFSET 255',`OFFSET ${n-1}`).replace('THEN 256 ELSE',`THEN ${n} ELSE`);
 }
 return {sql,prefix:!variant.includes('no-prefix')&&variant!=='text-batch'};
}
if(process.argv[2]==='worker'){
 const [fixture,variant]=process.argv.slice(3);
 const db=new Database(`${root}outputs/csv-js/fixtures/${fixture}.sqlite`,{readonly:true});
 let sql;
 const traced={prepare(text){if(text.startsWith('WITH RECURSIVE'))sql=text;return db.prepare(text)}};
 await api.exportTable(traced,'data',{format:'csv',columns:{id:api.integer().primaryKey(),name:api.text(),note:api.text(),active:api.integer()},output:new Writable({write(_c,_e,cb){cb()}})});
 const spec=rewrite(sql,variant);
 const statement=db.prepare(spec.sql).raw();
 function run(verify=false){let bytes=0,count=0;const hash=verify?createHash('sha256'):undefined;for(const row of statement.iterate()){
   let value=row[0];if(typeof value==='string')value=Buffer.from(value);if(spec.prefix)value=value.subarray(2);if(spec.header)value=value.subarray(spec.header);
   bytes+=value.length;count+=Number(row[1]);hash?.update(value);
  }return{bytes,count,...(hash?{sha256:hash.digest('hex')}:{})};}
 const checked=run(true);run();run();const samples=[];
 for(let i=0;i<(Number(process.env.SCREEN_PROFILE)|| (process.env.SCREEN_VERIFY?1:5));i++){const t=performance.now();for(let j=0;j<3;j++)run();samples.push((performance.now()-t)/3)}
 const instructions=db.prepare(`EXPLAIN ${spec.sql}`).all();
 console.log(JSON.stringify({fixture,variant,...checked,medianMs:median(samples),samplesMs:samples,peakRssMiB:process.resourceUsage().maxRSS/1024,instructions:instructions.length}));
 db.close();
} else {
 assert.equal(process.version,'v26.12.0');const all=[];
 for(const fixture of ['tiny','narrow','wide'])for(const variant of (process.env.SCREEN_VARIANTS?process.env.SCREEN_VARIANTS.split(','):variants)){
  const c=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'worker',fixture,variant],{encoding:'utf8',maxBuffer:1e6});
  assert.equal(c.status,0,c.stderr);const row=JSON.parse(c.stdout);all.push(row);
  console.error(fixture,variant,row.medianMs.toFixed(2),row.peakRssMiB.toFixed(1));
 }
 await writeFile(`${root}outputs/csv-deep/screen${process.env.SCREEN_VERIFY?'-verify':''}.json`,JSON.stringify(all,null,2)+'\n');
 for(const f of ['tiny','narrow','wide'])assert.equal(new Set(all.filter(r=>r.fixture===f).map(r=>r.sha256)).size,1);
 await writeFile(`${root}outputs/csv-deep/screen.json`,JSON.stringify(all,null,2)+'\n');
}
