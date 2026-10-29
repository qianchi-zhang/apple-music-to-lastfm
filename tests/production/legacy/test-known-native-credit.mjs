import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),c);
const evidence={region:{locale:'de-DE'},name:'Julia Fischer',artist_mbid:'julia',primary_apple_artist_id:'1'};
const s={artist:'朱莉亚 · 费雪',catalog_id:'s',_apple_album_id:'a',_apple_album_upc:'u',_apple_artist_ids:['1'],_artist_region_evidence:evidence,_is_source_storefront:true};
const gb={...s,artist:'Julia Fischer',_apple_artist_names:['Julia Fischer'],_is_source_storefront:false,_metadata_source:'en-GB',_apple_release_equivalence_method:'exact_apple_catalog_release',_apple_release_equivalence_requires_musicbrainz:false};
for(const search of [true,false])assert.equal(c.choosePreferredAppleTrack(s,[s,gb],search).artist,'Julia Fischer');
for(const change of [{_apple_album_upc:'x'},{_apple_artist_ids:['2']},{_apple_artist_names:['Other']},{_apple_release_equivalence_requires_musicbrainz:true}])assert.equal(c.choosePreferredAppleTrack(s,[s,{...gb,...change}]).artist,s.artist);
const de={...gb,_metadata_source:'de-DE',artist:'German native'};assert.equal(c.choosePreferredAppleTrack(s,[s,gb,de]).artist,de.artist);
console.log('PASS native-region priority and verified MB-name same-release alternate fallback');
