import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = `${root}exportlite/`;
const nativeRequire = createRequire(`${packageRoot}benchmarks/matched-api/package.json`);
const Database = nativeRequire('better-sqlite3');
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key,...value] = arg.replace(/^--/,'').split('=');
  return [key,value.join('=')];
}));
assert.equal(process.version,'v26.12.0');
const variant = options.variant;
assert(['current','mem9'].includes(variant));
const { exportTable } = await import(variant === 'current' ? `${packageRoot}dist/index.mjs` : new URL('./variant/dist/index.mjs',import.meta.url));
const fixture = JSON.parse(readFileSync(`${packageRoot}benchmarks/results/batch-profile/fixtures.json`,'utf8'))[options.dataset];
assert(fixture);
const table = options.dataset === 'matched' ? 'users' : 'data';
const columns = options.dataset === 'matched' ? ['name'] : ['id','name','note','active'];
const entryName = `${table}.json`;
const db = new Database(fixture.path,{readonly:true});

async function run(verify=false) {
  let bytes = 0;
  const hash = verify ? createHash('sha256') : undefined;
  const file = verify ? createWriteStream(options.archive,{flags:'wx'}) : undefined;
  const sink = new Writable({
    highWaterMark:65_536,
    write(chunk,_encoding,callback) {
      bytes += chunk.length;
      hash?.update(chunk);
      if (file) file.write(chunk,callback);
      else callback();
    },
    final(callback) {
      if (file) file.end(callback);
      else callback();
    },
  });
  file?.on('error',error => sink.destroy(error));
  const started = performance.now();
  const result = await exportTable(db,table,{columns,format:'json',zip:true,output:sink,end:true});
  const totalMs = performance.now()-started;
  if (file) await finished(file,{cleanup:true});
  assert.equal(result.rowsExported,fixture.rows);
  assert.equal(result.bytesWritten,bytes);
  return {totalMs,bytes,archiveSha256:hash?.digest('hex') ?? null};
}

try {
  const verification = await run(true);
  await run();
  const samples = [];
  for (let repeat=0;repeat<Number(options.samples ?? 3);repeat++) {
    const sample = await run();
    assert.equal(sample.bytes,verification.bytes);
    samples.push(sample);
  }
  const ordered = [...samples].sort((a,b) => a.totalMs-b.totalMs);
  const result = {
    dataset:options.dataset,variant,method:variant,mode:'zip-output',expected:fixture.expected,entryName,
    verification,samples,median:ordered[Math.floor(ordered.length/2)],
    peakRssMiB:process.resourceUsage().maxRSS/1024,
    environment:{node:process.version,v8:process.versions.v8,sqlite:db.prepare('SELECT sqlite_version() v').get().v,driver:nativeRequire('better-sqlite3/package.json').version,zipStream:JSON.parse(readFileSync(`${packageRoot}node_modules/zip-stream/package.json`,'utf8')).version,zlib:process.versions.zlib},
    zip:{level:1,chunkSize:262_144,memLevel:variant === 'mem9' ? 9 : 8,memLevelExplicit:variant === 'mem9',forceZip64:true,entryName,continuous:true},
    sql:'Public exportTable(); existing fixed 256-row batches and 64 KiB output flush target.',
  };
  writeFileSync(options.out,`${JSON.stringify(result,null,2)}\n`);
  console.log(`${options.dataset} ${variant}: ${result.median.totalMs.toFixed(2)} ms; ${result.median.bytes} ZIP bytes; ${result.peakRssMiB.toFixed(1)} MiB RSS`);
} finally {
  db.close();
}
