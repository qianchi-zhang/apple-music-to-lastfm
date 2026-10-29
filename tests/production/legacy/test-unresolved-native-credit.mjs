import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),c);
const s={artist:'交响乐团 & 指挥',catalog_id:'song',_apple_album_id:'album',_apple_album_upc:'upc',_apple_artist_ids:['orchestra','conductor'],_apple_storefront:'cn',_is_source_storefront:true,_artist_region_evidence:{region:null}};
const v={...s,artist:'Simón Bolívar Symphony Orchestra of Venezuela & Gustavo Dudamel',_is_source_storefront:false,_apple_storefront:'fr',_apple_release_equivalence_method:'exact_apple_catalog_release',_apple_release_equivalence_requires_musicbrainz:false};
for(const search of [true,false])assert.equal(c.choosePreferredAppleTrack(s,[s,v],search).artist,v.artist);
for(const change of [{_apple_album_upc:'other'},{catalog_id:'other'},{_apple_artist_ids:['other']},{_apple_release_equivalence_requires_musicbrainz:true},{_apple_release_equivalence_method:'unverified'},{artist:'繁體樂團'}])assert.equal(c.choosePreferredAppleTrack(s,[s,{...v,...change}],false).artist,s.artist);
const known={...s,_artist_region_evidence:{region:{locale:'zh-Hans-CN'}} ,_metadata_source:'zh-Hans-CN'};
assert.equal(c.choosePreferredAppleTrack(known,[known,v],true).artist,s.artist);
console.log('PASS unknown region exact-release nonlocalized credit, search/final gates, known CN unchanged');
