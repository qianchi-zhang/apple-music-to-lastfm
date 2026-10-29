import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const x={};vm.createContext(x);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),x);
const s={name:'日落 (Live)',album:'日落 (Live)',isrc:'SGA672501003',duration_ms:253404,_apple_album_track_count:1,_apple_track_number:1,_apple_disc_number:1,_apple_release_date:'2025-11-28',_apple_album_upc:'00199957128896'};
const t={...s,_apple_album_upc:'00199957091787'};
assert.equal(x.appleReleaseEquivalenceEvidence(s,t).single_release_equivalence,true);
for(const patch of [{isrc:'other'},{duration_ms:258405},{name:'日落',album:'日落'},{_apple_album_track_count:2},{_apple_release_date:'2024-11-28'},{_apple_is_compilation:true},{_apple_track_number:2},{duration_ms:0}])assert.notEqual(x.appleReleaseEquivalenceEvidence(s,{...t,...patch}).single_release_equivalence,true);
assert.equal(x.preferredAppleRegionForIsrc('SGA672501003').storefront,'tw');assert.equal(x.preferredAppleRegionForIsrc('MYA672501003').storefront,'tw');
console.log('PASS single release exact ISRC/date/title/shape and <=5s; wrong edition rejected; SG/MY prioritize TW');
