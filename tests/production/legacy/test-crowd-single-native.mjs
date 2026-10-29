import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),c);
// Public release metadata only; no account trace, events or listening timestamps.
const source=JSON.parse(fs.readFileSync(new URL('./evidence/crowd-single-public-metadata.json',import.meta.url),'utf8'));
const native={...source,artist:'盧廣仲',album_artist:'盧廣仲',name:'愛情怎麼了嗎',album:'愛情怎麼了嗎',catalog_id:'1455326451',_apple_album_id:'1455326450',_apple_album_track_count:2,_apple_storefront:'tw'};
assert.equal(c.appleReleaseEquivalenceEvidence(source,native).verified_regional_track_count,true);
for(const storefront of ['tw','hk','jp','kr','us','gb'])for(const [left,right] of [[1,2],[2,1],[9,10],[10,9]]) {
 assert.equal(c.appleReleaseEquivalenceEvidence({...source,_apple_album_track_count:left},{...native,_apple_storefront:storefront,_apple_album_track_count:right}).verified_regional_track_count,true);
}
for(const change of [{isrc:'other'},{duration_ms:260000},{_apple_artist_ids:['other']},{_apple_release_date:'2020-01-01'},{name:'其他歌'},{album:'精選集'},{_apple_is_compilation:true}])assert.notEqual(c.appleReleaseEquivalenceEvidence(source,{...native,...change}).verified_regional_track_count,true);
const rejectedRelease={...source,mbid:'recording',release_mbid:'release',timestamp:'original'};
const r=c.applyVerifiedNativeArtistFallback(rejectedRelease,source._artist_region_evidence);
assert.equal(r.artist,'盧廣仲');assert.equal(r.album_artist,'盧廣仲');
for(const key of ['name','album','mbid','release_mbid','timestamp'])assert.equal(r[key],rejectedRelease[key]);
for(const country of ['TW','HK','MO','SG','MY'])assert.equal(c.applyVerifiedNativeArtistFallback(rejectedRelease,{...source._artist_region_evidence,country}).artist,'盧廣仲');
assert.equal(c.applyVerifiedNativeArtistFallback(rejectedRelease,{...source._artist_region_evidence,country:'CN'}),rejectedRelease);
console.log('PASS actual single 1/2 track regional proof; identity/version/duration/date guards; independent native artist protection, fields and MBIDs unchanged');
