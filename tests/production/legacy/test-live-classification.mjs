import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read=n=>JSON.parse(fs.readFileSync(new URL('./evidence/'+n,import.meta.url)));
const c={console};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),c);
const r=read('lala-mb-recording.json'),l=read('lala-musicbrainz-direct.json')[0].body,a=read('lala-readonly-probe.json').variants;
assert.equal(c.verifiedLiveCompilationConflict(r,l,a),true);
assert.ok(c.scoreMusicBrainzIdentityCandidate(r,l,a,false,true));
for(const mutate of [
 x=>x.status='Bootleg',x=>x.title='另一場演唱會 Live',x=>x.date='2020-12',
 x=>x.media[1].tracks.pop(),x=>x.media[1].tracks[8].recording.id='wrong',
 x=>x.media[1].tracks[8].length+=6000,x=>x.media[1].tracks[8].position=10
]){const copy=structuredClone(l);mutate(copy);assert.equal(c.verifiedLiveCompilationConflict(r,copy,a),false);}
const studio=a.map(t=>({...t,name:'到此为止',album:'录音室专辑'}));
assert.equal(c.verifiedLiveCompilationConflict(r,l,studio),false);
assert.equal(c.verifiedLiveCompilationConflict(r,{...l,media:[]},a),false);
console.log('PASS: exact live classification conflict; wrong release/recording/position/duration/incomplete structure rejected');
