import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const node='<node-26.12.0>';
for(const dataset of ['matched','narrow','wide']){
 const result=spawnSync(node,[fileURLToPath(new URL('./paired-timing.mjs',import.meta.url)),dataset],{stdio:'inherit'});
 assert.equal(result.status,0);
}
