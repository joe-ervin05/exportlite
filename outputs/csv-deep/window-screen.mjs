import assert from 'node:assert/strict';
import{createRequire}from'node:module';
import{createHash}from'node:crypto';
import{spawnSync}from'node:child_process';
import{writeFile}from'node:fs/promises';
import{Writable}from'node:stream';
import{fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));const require=createRequire(`${root}exportlite/package.json`);const Database=require('better-sqlite3');
const api=await import(`${root}exportlite/dist/index.mjs`);const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
export function windowSql(sql,n,binary=true){
 const body=`coalesce("body", '') || char(13, 10)`;
 const payload=binary?`CASE WHEN length(CAST(char(13, 10) AS BLOB))=2 THEN CAST(char(13, 10) || ${body} AS BLOB) ELSE ${body} END`:body;
 return `WITH "__csv_input"("record") AS (${sql}), "__csv_windows" AS (
  SELECT row_number() OVER () AS "rn",group_concat("record",char(13,10)) OVER w AS "body",count(*) OVER w AS "n" FROM "__csv_input"
  WINDOW w AS (ROWS BETWEEN CURRENT ROW AND ${n-1} FOLLOWING)
 ) SELECT ${payload},"n" FROM "__csv_windows" WHERE ("rn"-1)%${n}=0`;
}
if(process.argv[2]==='worker'){
 const[fixture,variant]=process.argv.slice(3);const db=new Database(`${root}outputs/csv-deep/fixtures/${fixture}.sqlite`,{readonly:true});
 let sql;const traced={prepare(s){sql=s;return db.prepare(s)}};
 await api.exportQuery(traced,{sql:'SELECT * FROM data ORDER BY id',columns:{id:api.integer(),name:api.text(),note:api.text(),active:api.integer()},format:'csv',output:new Writable({write(_c,_e,cb){cb()}})});
 if(variant!=='baseline')sql=windowSql(sql,Number(variant.replace('text','')), !variant.startsWith('text'));
 const statement=db.prepare(sql);variant==='baseline'?statement.pluck():statement.raw();
 function run(verify=false){let bytes=0,count=0;const hash=verify?createHash('sha256'):undefined;
  for(const row of statement.iterate()){
   let value;if(variant==='baseline'){value=Buffer.from(row+'\r\n');count++}
   else{value=typeof row[0]==='string'?Buffer.from(row[0]):row[0].subarray(2);count+=Number(row[1])}
   bytes+=value.length;hash?.update(value);
  }return{bytes,count,...(hash?{sha256:hash.digest('hex')}:{})};
 }
 const checked=run(true);run();run();const samples=[];for(let i=0;i<3;i++){const t=performance.now();for(let j=0;j<2;j++)run();samples.push((performance.now()-t)/2)}
 console.log(JSON.stringify({fixture,variant,...checked,medianMs:median(samples),samplesMs:samples,peakRssMiB:process.resourceUsage().maxRSS/1024,queryPlan:db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()}));db.close();
}else{
 const all=[];for(const fixture of ['narrow','wide','quote-heavy','null-heavy'])for(const variant of ['baseline','8','32','64','text32']){
  const c=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'worker',fixture,variant],{encoding:'utf8',maxBuffer:1e6});assert.equal(c.status,0,c.stderr);
  const r=JSON.parse(c.stdout);all.push(r);console.error(fixture,variant,r.medianMs.toFixed(2),r.peakRssMiB.toFixed(1));
 }
 await writeFile(`${root}outputs/csv-deep/window-screen.json`,JSON.stringify(all,null,2)+'\n');
 for(const f of ['narrow','wide','quote-heavy','null-heavy'])assert.equal(new Set(all.filter(r=>r.fixture===f).map(r=>r.sha256)).size,1);
}
