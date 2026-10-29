import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const x={};vm.createContext(x);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),x);
const t={artist:'서하리',album_artist:'서하리',name:'Gwiyomi song',album:'Gwiyomi song',isrc:'KRA341404898',_apple_artist_ids:['823718853']};
const r=x.normalizeVerifiedHariArtist(t);assert.equal(r.artist,'하리');assert.equal(r.album_artist,'하리');assert.equal(r.name,t.name);assert.equal(r.album,t.album);
for(const patch of [{isrc:'US123'},{_apple_artist_ids:['other']},{_apple_artist_ids:[]},{artist:'Other'}])assert.equal(x.normalizeVerifiedHariArtist({...t,...patch}).artist,patch.artist??t.artist);
assert.equal(x.normalizeVerifiedHariArtist({...t,album_artist:'Various Artists'}).album_artist,'Various Artists');
console.log('PASS Hari scoped artist identity override, unrelated artists and credits preserved');
