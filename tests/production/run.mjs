import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,cpSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../..');
const source=readFileSync(path.join(root,'apps/worker/production/worker-0.3.111.js'));
const hash=createHash('sha256').update(source).digest('hex');assert.equal(hash,'531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794');
const names=JSON.parse(readFileSync(new URL('./legacy/allowlist.json',import.meta.url)));
const results=[];const temp=mkdtempSync(path.join(tmpdir(),'ams-111-regression-'));
try{
 writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');writeFileSync(path.join(temp,'worker-fixed.js'),source);cpSync(new URL('./fixtures',import.meta.url),path.join(temp,'evidence'),{recursive:true});
 for(const name of names){copyFileSync(new URL('./legacy/'+name,import.meta.url),path.join(temp,name));const r=spawnSync(process.execPath,['--import',path.join(import.meta.dirname,'support/offline-preload.mjs'),path.join(temp,name)],{encoding:'utf8',timeout:90000,env:{PATH:process.env.PATH,TZ:'UTC'}});results.push({test:name,passed:r.status===0,exitCode:r.status,...(r.status===0?{}:{stderr:r.stderr})});console.log((r.status===0?'PASS ':'FAIL ')+name);}
}finally{rmSync(temp,{recursive:true,force:true});}
mkdirSync(path.join(root,'reports'),{recursive:true});writeFileSync(path.join(root,'reports/production-regressions.json'),JSON.stringify({version:'0.3.111',sha256:hash,network:'blocked; explicit fixture responses only',tests:results},null,2)+'\n');
assert.ok(results.every(r=>r.passed),'Production regressions failed');console.log('Passed '+results.length+' production algorithm regression scripts.');
