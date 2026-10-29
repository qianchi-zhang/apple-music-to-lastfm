import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const x={};vm.createContext(x);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),x);
const t={artist:'权志龙',album_artist:'权志龙',name:'삐딱하게 (Crooked)',_apple_artist_ids:['320373708']};
assert.equal(x.normalizeVerifiedGDragonArtist(t).artist,'G-DRAGON');assert.equal(x.normalizeVerifiedGDragonArtist({...t,_apple_artist_ids:['other']}).artist,'权志龙');
assert.equal(x.supplementalAppleNativeRegions(t,{storefront:'hk'}).some(r=>r.storefront==='kr'),true);
console.log('PASS identity-bound G-DRAGON and Korean lookup despite HK ISRC');
