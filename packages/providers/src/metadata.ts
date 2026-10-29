// General matching behavior preserved from aScrobble 0.3.49.
import {
  FORMAL_RELEASE_CACHE_VERSION,
  FORMAL_RELEASE_MATCH_CACHE_MS,
  FORMAL_RELEASE_MISS_CACHE_MS,
  LASTFM_CANONICAL_ARTIST_CACHE_VERSION,
  MUSICBRAINZ_IDENTITY_CACHE_VERSION,
} from "../../core/src/constants";
import { md5 } from "../../core/src/md5";
import {
  stripVersionQualifiers,
  lastFmAlbumHasRealArtwork,
  preferredLocaleForIsrc,
} from "../../core/src/text";
import {
  getMusicBrainzReleaseCandidates,
  findLastFmAlbumTrack,
} from "../../core/src/musicbrainz-evidence";
import type { ProviderContext } from "./runtime";
export function createMetadata(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;
  const searchMusicBrainzRecordings = (...args: any[]): any =>
    ctx.api.searchMusicBrainzRecordings(...args);
  const getLastFmAlbumInfo = (...args: any[]): any =>
    ctx.api.getLastFmAlbumInfo(...args);
  const getLastFmTrackInfo = (...args: any[]): any =>
    ctx.api.getLastFmTrackInfo(...args);
  function formalReleaseCacheKey(track?: any, artist?: any): any {
    const durationSeconds: any = Math.round(
      Number(track.duration_ms ?? 0) / 1e3,
    );
    return `lastfm-formal-release:v${FORMAL_RELEASE_CACHE_VERSION}:${md5(`${artist}\n${stripVersionQualifiers(track.name)}\n${durationSeconds}`)}`;
  }
  async function resolveFormalReleaseTrackForArtwork(
    track?: any,
    canonicalArtist?: any,
    apiKey?: any,
    kv?: any,
  ): Promise<any> {
    const cacheKey: any = formalReleaseCacheKey(track, canonicalArtist);
    if (kv) {
      try {
        const cached: any = await kv.get(cacheKey, "json");
        const checkedAt: any = cached?.checked_at_iso
          ? new Date(cached.checked_at_iso).getTime()
          : 0;
        const maxAge: any = cached?.match
          ? FORMAL_RELEASE_MATCH_CACHE_MS
          : FORMAL_RELEASE_MISS_CACHE_MS;
        if (checkedAt && Date.now() - checkedAt < maxAge) {
          return cached.match ? { ...track, ...cached.track } : null;
        }
      } catch (err: any) {
        console.warn("Formal release cache read failed:", err);
      }
    }
    const recordings: any = await searchMusicBrainzRecordings(
      canonicalArtist,
      track.name,
    ).catch(() => []);
    const candidates: any = recordings
      .flatMap((recording?: any) =>
        getMusicBrainzReleaseCandidates(recording, track, canonicalArtist),
      )
      .sort(
        (a?: any, b?: any) =>
          b.score - a.score || a.durationDiffMs - b.durationDiffMs,
      );
    let match: any = null;
    for (const candidate of candidates.slice(0, 5)) {
      const albumInfo: any = await getLastFmAlbumInfo(
        apiKey,
        canonicalArtist,
        candidate.release.title,
      ).catch(() => null);
      if (!lastFmAlbumHasRealArtwork(albumInfo)) continue;
      const albumTrack: any = findLastFmAlbumTrack(
        albumInfo,
        track,
        candidate.recording,
      );
      if (!albumTrack?.name) continue;
      match = {
        name: albumTrack.name,
        artist: canonicalArtist,
        album: albumInfo.name ?? candidate.release.title,
        album_artist: albumInfo.artist ?? canonicalArtist,
        duration_ms: candidate.recording.length ?? track.duration_ms,
        mbid: candidate.recording.id,
        release_mbid: candidate.release.id,
        release_group_mbid: candidate.releaseGroup.id,
        _lastfm_album_mbid: albumInfo.mbid || candidate.release.id,
        _lastfm_artwork_match: true,
        _lastfm_formal_release_match: true,
      };
      break;
    }
    if (kv) {
      const record: any = {
        match: Boolean(match),
        track: match,
        checked_at_iso: new Date().toISOString(),
      };
      await kv.put(cacheKey, JSON.stringify(record)).catch((err?: any) => {
        console.warn("Formal release cache write failed:", err);
      });
    }
    return match ? { ...track, ...match } : null;
  }
  function canonicalArtistCacheKey(artist?: any): any {
    return `lastfm-artist-canonical:v${LASTFM_CANONICAL_ARTIST_CACHE_VERSION}:${md5(artist)}`;
  }
  function musicBrainzIdentityCacheKey(
    track?: any,
    version: any = MUSICBRAINZ_IDENTITY_CACHE_VERSION,
  ): any {
    return `musicbrainz-identity:v${version}:${md5(`${track.isrc ?? ""}\n${track.artist}\n${track.name}\n${track.album}\n${Math.round(Number(track.duration_ms ?? 0) / 1e3)}`)}`;
  }
  async function selectCanonicalTrackMetadata(
    track?: any,
    canonicalArtist?: any,
    devToken?: any,
    musicUserToken?: any,
    apiKey?: any,
    appleVariants: any = [],
  ): Promise<any> {
    const candidateSpecs: any = [{ source: "original", value: track }];
    candidateSpecs.push(
      ...appleVariants.map((value?: any) => ({
        source: value._metadata_source,
        value,
      })),
    );
    const seen: any = new Set();
    const candidates: any = candidateSpecs.filter((entry?: any) => {
      const key: any = `${entry.value.name}\n${entry.value.album}`;
      if (!entry.value.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const evaluated: any = await Promise.all(
      candidates.map(async (entry?: any, index?: any) => {
        const candidate: any = entry.value;
        const [trackInfo, albumInfo]: any = await Promise.all([
          getLastFmTrackInfo(apiKey, canonicalArtist, candidate.name).catch(
            () => null,
          ),
          getLastFmAlbumInfo(apiKey, canonicalArtist, candidate.album).catch(
            () => null,
          ),
        ]);
        let score: any = entry.source === "original" ? 2 : 0;
        if (trackInfo?.mbid) score += 100;
        if (albumInfo?.mbid) score += 60;
        if (albumInfo) score += 30;
        if (lastFmAlbumHasRealArtwork(trackInfo?.album)) score += 20;
        if (trackInfo?.artist?.name === canonicalArtist) score += 10;
        const preferredLocale: any = preferredLocaleForIsrc(candidate.isrc);
        if (preferredLocale && entry.source === preferredLocale) score += 200;
        return { entry, index, trackInfo, albumInfo, score };
      }),
    );
    evaluated.sort(
      (a?: any, b?: any) => b.score - a.score || a.index - b.index,
    );
    const best: any = evaluated[0];
    if (!best) return { ...track, artist: canonicalArtist || track.artist };
    const candidate: any = best.entry.value;
    return {
      ...track,
      name: candidate.name ?? track.name,
      artist: canonicalArtist || track.artist,
      album: best.albumInfo?.name ?? candidate.album ?? track.album,
      duration_ms: candidate.duration_ms ?? track.duration_ms,
      isrc: candidate.isrc ?? track.isrc,
      catalog_id: candidate.catalog_id ?? track.catalog_id,
    };
  }
  return {
    formalReleaseCacheKey,
    resolveFormalReleaseTrackForArtwork,
    canonicalArtistCacheKey,
    musicBrainzIdentityCacheKey,
    selectCanonicalTrackMetadata,
  };
}
