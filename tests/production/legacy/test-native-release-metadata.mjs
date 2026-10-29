import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const x={console,URL,URLSearchParams,TextEncoder,setTimeout,clearTimeout};vm.createContext(x);
vm.runInContext(fs.readFileSync(new URL('./worker-fixed.js',import.meta.url),'utf8').replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/,''),x);
const variants=JSON.parse(fs.readFileSync(new URL('./evidence/jay-readonly-probe.json',import.meta.url))).variants;
const native=variants.find(t=>!t._is_source_storefront);
const identity={recording_mbid:'recording',release_mbid:'simplified',release_group_mbid:'group',artist_mbid:'artist',release_group_release_mbids:['native'],artist:'周杰伦',track:'简体',album:'简体'};
const release={id:'native',status:'Official',title:'周杰倫地表最強世界巡迴演唱會','release-group':{id:'group','secondary-types':['Live']},'artist-credit':[{name:'周杰倫',artist:{id:'artist'}}],media:[{tracks:[{title:'大笨鐘+暗號+彩虹+龍捲風',position:19,length:227000,recording:{id:'recording'}}]}]};
x.hydrateMusicBrainzRelease=async()=>release;
const result=await x.resolveNativeReleaseMetadata(identity,variants,null);
assert.equal(result.release_mbid,'native');assert.equal(result.track,'大笨鐘+暗號+彩虹+龍捲風');assert.equal(result.artist,'周杰倫');assert.equal(result.recording_mbid,'recording');
for(const mutate of [r=>r.status='Bootleg',r=>r['release-group'].id='wrong',r=>r.media[0].tracks[0].recording.id='wrong',r=>r.media[0].tracks[0].length=240000]) {
 const bad=structuredClone(release);mutate(bad);x.hydrateMusicBrainzRelease=async()=>bad;
 assert.equal(await x.resolveNativeReleaseMetadata(identity,variants,null),identity);
}
x.getLastFmAlbumInfo=async()=>null;
const fallback=await x.mapConfirmedIdentityToLastFm(native,variants,null,null,'');
assert.equal(fallback.name,native.name);assert.equal(fallback.artist,native.artist);assert.equal(fallback.album,native.album);assert.equal(fallback.mbid,'');
const confirmedFallback=await x.mapConfirmedIdentityToLastFm(native,variants,result,null,'');
assert.equal(confirmedFallback.name,'大笨鐘+暗號+彩虹+龍捲風');
x.getLastFmAlbumInfo=async()=>({name:native.album,artist:native.artist});
x.findLastFmAlbumTrack=()=>({name:native.name});
const confirmedArtwork=await x.mapConfirmedIdentityToLastFm(native,variants,result,null,'');
assert.equal(confirmedArtwork.name,'大笨鐘+暗號+彩虹+龍捲風');
console.log('PASS native Release/Track fields; wrong identity/version rejected; no MB/Lastfm preserves full Apple native fields');
