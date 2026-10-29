import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),c);
const source={artist:'李荣浩',name:'模特',album:'模特',album_artist:'李荣浩',_is_source_storefront:true,_apple_storefront:'cn',_apple_artist_ids:['1'],_artist_region_evidence:{country:'CN',artist_mbid:'li',primary_apple_artist_id:'1'}};
const mapped={artist:'Ronghao Li',name:'Model',album:'Model',album_artist:'Ronghao Li',mbid:'recording',release_mbid:'release'};
const result=c.preserveMainlandSourceDisplay(mapped,[source]);
assert.equal(result.artist,'李荣浩');assert.equal(result.name,'模特');assert.equal(result.album,'模特');assert.equal(result.album_artist,'李荣浩');assert.equal(result.mbid,'recording');assert.equal(result.release_mbid,'release');
for(const country of ['TW','HK',null])assert.equal(c.preserveMainlandSourceDisplay(mapped,[{...source,_artist_region_evidence:{...source._artist_region_evidence,country}}]),mapped);
assert.equal(c.preserveMainlandSourceDisplay(mapped,[{...source,_apple_artist_ids:['wrong']}]),mapped);
console.log('PASS mainland source display retained, MBIDs preserved, non-mainland and mismatched IDs unchanged');
