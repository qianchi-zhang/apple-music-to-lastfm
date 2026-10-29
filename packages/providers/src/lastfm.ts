import { submitLastfm } from "./submission";
// General matching behavior preserved from aScrobble 0.3.49.
import {
  API_URL,
  LASTFM_CANONICAL_ARTIST_CACHE_MS,
  BATCH_SIZE,
} from "../../core/src/constants";
import {
  lastFmAlbumHasRealArtwork,
  normalizeAlbumArtistForLastFm,
  isVariousArtistsName,
  catalogTitleMatchScore,
  shouldDeferIdentityNormalizationFailure,
} from "../../core/src/text";
import {
  buildLegalLastFmAliases,
  bestCatalogTitleScore,
  findLastFmAlbumTrack,
} from "../../core/src/musicbrainz-evidence";
import {
  choosePreferredAppleTrack,
  filterMusicBrainzConfirmedAppleVariants,
} from "../../core/src/apple-evidence";
import { md5 } from "../../core/src/md5";
import type { ProviderContext } from "./runtime";
export function createLastfm(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;
  const canonicalArtistCacheKey = (...args: any[]): any =>
    ctx.api.canonicalArtistCacheKey(...args);
  const getAppleCatalogVariants = (...args: any[]): any =>
    ctx.api.getAppleCatalogVariants(...args);
  const resolveMusicBrainzIdentity = (...args: any[]): any =>
    ctx.api.resolveMusicBrainzIdentity(...args);
  const getConditionalSpotifyEvidence = (...args: any[]): any =>
    ctx.api.getConditionalSpotifyEvidence(...args);
  async function getLastFmAlbumInfo(
    apiKey?: any,
    artist?: any,
    album?: any,
  ): Promise<any> {
    if (!artist || !album) return null;
    const url: any = new URL(API_URL);
    url.search = new URLSearchParams({
      method: "album.getInfo",
      api_key: apiKey,
      artist,
      album,
      autocorrect: "1",
      format: "json",
    }).toString();
    const response: any = await fetch(url, {
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    return lastFmAlbumHasRealArtwork(data.album) ? data.album : null;
  }
  async function searchLastFmAlbums(apiKey?: any, album?: any): Promise<any> {
    if (!album) return [];
    const url: any = new URL(API_URL);
    url.search = new URLSearchParams({
      method: "album.search",
      api_key: apiKey,
      album,
      limit: "30",
      format: "json",
    }).toString();
    const response: any = await fetch(url, {
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok) return [];
    const data: any = await response.json();
    const matches: any = data.results?.albummatches?.album;
    return Array.isArray(matches) ? matches : matches ? [matches] : [];
  }
  async function getLastFmTrackAlbumInfo(
    apiKey?: any,
    artist?: any,
    track?: any,
  ): Promise<any> {
    if (!artist || !track) return null;
    const url: any = new URL(API_URL);
    url.search = new URLSearchParams({
      method: "track.getInfo",
      api_key: apiKey,
      artist,
      track,
      autocorrect: "1",
      format: "json",
    }).toString();
    const response: any = await fetch(url, {
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    return lastFmAlbumHasRealArtwork(data.track?.album)
      ? data.track.album
      : null;
  }
  async function getLastFmTrackInfo(
    apiKey?: any,
    artist?: any,
    track?: any,
  ): Promise<any> {
    if (!artist || !track) return null;
    const url: any = new URL(API_URL);
    url.search = new URLSearchParams({
      method: "track.getInfo",
      api_key: apiKey,
      artist,
      track,
      autocorrect: "1",
      format: "json",
    }).toString();
    const response: any = await fetch(url, {
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    return data.track?.name ? data.track : null;
  }
  async function getLastFmArtistInfo(apiKey?: any, artist?: any): Promise<any> {
    if (!artist) return null;
    const url: any = new URL(API_URL);
    url.search = new URLSearchParams({
      method: "artist.getInfo",
      api_key: apiKey,
      artist,
      autocorrect: "1",
      format: "json",
    }).toString();
    const response: any = await fetch(url, {
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    if (!data.artist?.name) return null;
    return {
      input: artist,
      name: data.artist.name,
      mbid: data.artist.mbid ?? "",
      playcount: Number(data.artist.stats?.playcount ?? 0),
    };
  }
  async function resolveLastFmCanonicalArtist(
    track?: any,
    devToken?: any,
    musicUserToken?: any,
    apiKey?: any,
    kv?: any,
    appleVariants: any = null,
  ): Promise<any> {
    if (!track.artist) return track.artist;
    if (kv) {
      try {
        const cached: any = await kv.get(
          canonicalArtistCacheKey(track.artist),
          "json",
        );
        const checkedAt: any = cached?.checked_at_iso
          ? new Date(cached.checked_at_iso).getTime()
          : 0;
        if (
          cached?.name &&
          checkedAt &&
          Date.now() - checkedAt < LASTFM_CANONICAL_ARTIST_CACHE_MS
        ) {
          return cached.name;
        }
      } catch (err: any) {
        console.warn("Canonical artist cache read failed:", err);
      }
    }
    const variants: any = new Set([track.artist]);
    if (track.type === "library-songs" || track.type === "songs") {
      const localizedTracks: any =
        appleVariants ??
        (await getAppleCatalogVariants(track, devToken, musicUserToken, kv));
      for (const localizedTrack of localizedTracks) {
        if (localizedTrack?.artist) variants.add(localizedTrack.artist);
      }
    }
    const infos: any = (
      await Promise.all(
        [...variants].map((artist?: any) =>
          getLastFmArtistInfo(apiKey, artist).catch(() => null),
        ),
      )
    ).filter(Boolean);
    if (infos.length === 0) return track.artist;
    infos.sort((a?: any, b?: any) => {
      const mbidDiff: any = Number(Boolean(b.mbid)) - Number(Boolean(a.mbid));
      return mbidDiff || b.playcount - a.playcount;
    });
    const best: any = infos[0];
    if (kv) {
      const record: any = {
        name: best.name,
        mbid: best.mbid || null,
        checked_at_iso: new Date().toISOString(),
        aliases: [...variants],
      };
      await Promise.all(
        [...variants].map((alias?: any) =>
          kv
            .put(canonicalArtistCacheKey(alias), JSON.stringify(record))
            .catch((err?: any) => {
              console.warn("Canonical artist cache write failed:", err);
            }),
        ),
      );
    }
    return best.name;
  }
  async function mapConfirmedIdentityToLastFm(
    preferred?: any,
    appleTracks?: any,
    identity?: any,
    spotifyEvidence?: any,
    apiKey?: any,
  ): Promise<any> {
    const aliases: any = buildLegalLastFmAliases(
      preferred,
      appleTracks,
      identity,
      spotifyEvidence,
    );
    const legalAlbumNames: any = aliases.map(
      (candidate?: any) => candidate.album,
    );
    for (const candidate of aliases) {
      const albumQueryArtist: any = normalizeAlbumArtistForLastFm(
        candidate.album_artist ?? candidate.artist,
      );
      let albumInfo: any = await getLastFmAlbumInfo(
        apiKey,
        albumQueryArtist,
        candidate.album,
      ).catch(() => null);
      if (
        !albumInfo &&
        candidate.source === "apple_exact_release_artist_alias"
      ) {
        await new Promise((resolve?: any) => setTimeout(resolve, 300));
        albumInfo = await getLastFmAlbumInfo(
          apiKey,
          albumQueryArtist,
          candidate.album,
        ).catch(() => null);
      }
      if (
        !albumInfo ||
        bestCatalogTitleScore(legalAlbumNames, albumInfo.name) < 90
      )
        continue;
      if (
        (candidate.source === "musicbrainz_release" ||
          candidate.source === "musicbrainz_release_group") &&
        albumInfo.mbid &&
        identity?.release_group_release_mbids?.length > 0 &&
        !identity.release_group_release_mbids.includes(albumInfo.mbid)
      )
        continue;
      if (
        candidate.source === "apple_native_raw_release_title" ||
        candidate.source === "apple_raw_release_title" ||
        candidate.source === "apple_exact_release_artist_alias"
      ) {
        const lastFmTracks: any = albumInfo?.tracks?.track;
        const lastFmTrackCount: any = Array.isArray(lastFmTracks)
          ? lastFmTracks.length
          : lastFmTracks
            ? 1
            : 0;
        const expectedTrackCount: any = Number(
          candidate.album_track_count ?? 0,
        );
        if (!expectedTrackCount || lastFmTrackCount !== expectedTrackCount)
          continue;
      }
      if (candidate.source === "musicbrainz_confirmed_live_album_alias") {
        const lastFmTracks: any = albumInfo?.tracks?.track;
        const lastFmTrackCount: any = Array.isArray(lastFmTracks)
          ? lastFmTracks.length
          : lastFmTracks
            ? 1
            : 0;
        const expectedTrackCount: any = Number(
          candidate.album_track_count ?? 0,
        );
        if (!expectedTrackCount || lastFmTrackCount !== expectedTrackCount)
          continue;
      }
      const lastFmTracks: any = albumInfo?.tracks?.track;
      const lastFmTrackCount: any = Array.isArray(lastFmTracks)
        ? lastFmTracks.length
        : lastFmTracks
          ? 1
          : 0;
      const expectedTrackCount: any = Number(
        preferred._apple_album_track_count ?? 0,
      );
      const confirmedReleaseStructure: any = Boolean(
        albumInfo.mbid &&
        identity?.release_group_release_mbids?.includes(albumInfo.mbid) &&
        expectedTrackCount > 0 &&
        lastFmTrackCount === expectedTrackCount,
      );
      const albumTrack: any = findLastFmAlbumTrack(
        albumInfo,
        preferred,
        identity
          ? { title: identity.track, length: preferred.duration_ms }
          : null,
        { allow_verified_duration_anomaly: confirmedReleaseStructure },
      );
      if (!albumTrack?.name) continue;
      const preserveNativeAppleMetadata: any =
        candidate.native_apple_metadata === true;
      const compilationAlbum: any =
        isVariousArtistsName(albumQueryArtist) ||
        isVariousArtistsName(albumInfo.artist);
      return {
        ...preferred,
        artist:
          preserveNativeAppleMetadata || compilationAlbum
            ? candidate.artist
            : (albumInfo.artist ?? candidate.artist),
        name: preserveNativeAppleMetadata ? candidate.track : albumTrack.name,
        album: preserveNativeAppleMetadata
          ? candidate.album
          : (albumInfo.name ?? candidate.album),
        album_artist: compilationAlbum
          ? "Various Artists"
          : preserveNativeAppleMetadata
            ? candidate.album_artist
            : (albumInfo.artist ?? candidate.album_artist),
        mbid: identity?.recording_mbid ?? "",
        mbid_kind: identity?.recording_mbid ? "recording" : "",
        release_mbid: identity?.release_mbid ?? void 0,
        release_group_mbid: identity?.release_group_mbid ?? void 0,
        _lastfm_album_mbid: albumInfo.mbid || void 0,
        _lastfm_artwork_match: true,
        _identity_source: identity?.method ?? candidate.source,
      };
    }
    const expectedTrackCount: any = Number(
      preferred._apple_album_track_count ?? 0,
    );
    const confirmedVariousArtistsRelease: any = Boolean(
      preferred._apple_is_compilation === true &&
      identity?.release_mbid &&
      identity?.release_group_mbid &&
      isVariousArtistsName(identity?.album_artist) &&
      Number(identity?.release_track_count ?? 0) === expectedTrackCount &&
      expectedTrackCount > 1 &&
      identity?.release_track_number_confirmed === true,
    );
    if (confirmedVariousArtistsRelease) {
      const searchTerms: any = [
        ...new Set(
          [
            identity.album,
            identity.release_group,
            ...appleTracks.flatMap((candidate?: any) => [
              candidate.album,
              candidate._apple_raw_album,
            ]),
          ].filter(Boolean),
        ),
      ];
      for (const term of searchTerms.slice(0, 4)) {
        const matches: any = await searchLastFmAlbums(apiKey, term).catch(
          () => [],
        );
        const match: any = matches.find(
          (candidate?: any) =>
            isVariousArtistsName(candidate?.artist) &&
            lastFmAlbumHasRealArtwork(candidate) &&
            bestCatalogTitleScore(searchTerms, candidate?.name) >= 96,
        );
        if (!match?.name) continue;
        return {
          ...preferred,
          artist: preferred.artist,
          name: preferred.name,
          album: match.name,
          album_artist: "Various Artists",
          mbid: identity.recording_mbid ?? "",
          mbid_kind: identity.recording_mbid ? "recording" : "",
          release_mbid: identity.release_mbid,
          release_group_mbid: identity.release_group_mbid,
          _lastfm_artwork_match: true,
          _identity_source: `${identity.method}:confirmed_various_artists_artwork_alias`,
        };
      }
    }
    return {
      ...preferred,
      mbid: identity?.recording_mbid ?? "",
      mbid_kind: identity?.recording_mbid ? "recording" : "",
      release_mbid: identity?.release_mbid ?? void 0,
      release_group_mbid: identity?.release_group_mbid ?? void 0,
      _identity_source: identity?.method ?? "apple_only",
    };
  }
  async function enrichTrackArtworkForLastFm(
    track?: any,
    devToken?: any,
    musicUserToken?: any,
    apiKey?: any,
    appleVariants: any = [],
  ): Promise<any> {
    try {
      const originalAlbum: any = await getLastFmAlbumInfo(
        apiKey,
        track.artist,
        track.album,
      );
      if (originalAlbum) {
        return {
          ...track,
          album: originalAlbum.name ?? track.album,
          album_artist: originalAlbum.artist ?? track.album_artist,
          _lastfm_album_mbid: originalAlbum.mbid ?? track._lastfm_album_mbid,
          _lastfm_artwork_match: true,
        };
      }
      const seenCatalogMetadata: any = new Set();
      for (const catalogTrack of appleVariants) {
        if (!catalogTrack) continue;
        const metadataKey: any = `${catalogTrack.artist}\n${catalogTrack.name}\n${catalogTrack.album}`;
        if (seenCatalogMetadata.has(metadataKey)) continue;
        seenCatalogMetadata.add(metadataKey);
        const catalogAlbum: any = await getLastFmAlbumInfo(
          apiKey,
          catalogTrack.artist,
          catalogTrack.album,
        );
        if (catalogAlbum) {
          return {
            ...track,
            album: catalogAlbum.name ?? catalogTrack.album,
            album_artist: catalogAlbum.artist ?? catalogTrack.album_artist,
            isrc: catalogTrack.isrc ?? track.isrc,
            catalog_id: catalogTrack.catalog_id,
            _lastfm_album_mbid: catalogAlbum.mbid ?? track._lastfm_album_mbid,
            _lastfm_artwork_match: true,
          };
        }
        const trackAlbum: any = await getLastFmTrackAlbumInfo(
          apiKey,
          catalogTrack.artist,
          catalogTrack.name,
        );
        if (
          trackAlbum &&
          catalogTitleMatchScore(catalogTrack.album, trackAlbum.title) >= 90
        ) {
          return {
            ...track,
            album: trackAlbum.title ?? catalogTrack.album,
            album_artist: trackAlbum.artist ?? catalogTrack.album_artist,
            isrc: catalogTrack.isrc ?? track.isrc,
            catalog_id: catalogTrack.catalog_id,
            _lastfm_album_mbid: trackAlbum.mbid ?? track._lastfm_album_mbid,
            _lastfm_artwork_match: true,
          };
        }
      }
      const originalTrackAlbum: any = await getLastFmTrackAlbumInfo(
        apiKey,
        track.artist,
        track.name,
      );
      if (
        originalTrackAlbum &&
        catalogTitleMatchScore(track.album, originalTrackAlbum.title) >= 90
      ) {
        return {
          ...track,
          album: originalTrackAlbum.title ?? track.album,
          album_artist: originalTrackAlbum.artist ?? track.album_artist,
          _lastfm_album_mbid:
            originalTrackAlbum.mbid ?? track._lastfm_album_mbid,
          _lastfm_artwork_match: true,
        };
      }
    } catch (err: any) {
      console.warn(
        `Last.fm artwork metadata enrichment skipped for "${track.name}":`,
        err,
      );
    }
    return track;
  }
  async function enrichTrackForLastFm(
    track?: any,
    devToken?: any,
    musicUserToken?: any,
    apiKey?: any,
    kv?: any,
    env: any = null,
  ): Promise<any> {
    let appleVariants: any = [];
    try {
      appleVariants = await getAppleCatalogVariants(
        track,
        devToken,
        musicUserToken,
        kv,
      );
      const provisionalPreferred: any = choosePreferredAppleTrack(
        track,
        appleVariants,
      );
      const identity: any = await resolveMusicBrainzIdentity(
        provisionalPreferred,
        appleVariants.length > 0 ? appleVariants : [provisionalPreferred],
        kv,
      );
      const confirmedAppleVariants: any =
        filterMusicBrainzConfirmedAppleVariants(appleVariants, identity);
      const preferred: any = choosePreferredAppleTrack(
        track,
        confirmedAppleVariants,
      );
      const spotifyEvidence: any = await getConditionalSpotifyEvidence(
        preferred,
        confirmedAppleVariants.length > 0
          ? confirmedAppleVariants
          : [preferred],
        identity,
        env,
      ).catch(() => null);
      return mapConfirmedIdentityToLastFm(
        preferred,
        confirmedAppleVariants.length > 0
          ? confirmedAppleVariants
          : [preferred],
        identity,
        spotifyEvidence,
        apiKey,
      );
    } catch (err: any) {
      console.warn(
        `Identity normalization skipped for "${track.artist}":`,
        err,
      );
      if (shouldDeferIdentityNormalizationFailure(err)) throw err;
      return {
        ...track,
        mbid: "",
        mbid_kind: "",
        _identity_source: "apple_fallback",
      };
    }
  }
  function signParams(params?: any, sharedSecret?: any): any {
    const sigString: any =
      Object.keys(params)
        .filter((k?: any) => k !== "format" && k !== "callback")
        .sort()
        .map((k?: any) => `${k}${params[k]}`)
        .join("") + sharedSecret;
    return md5(sigString);
  }
  async function scrobbleBatch(
    plays: any,
    apiKey: any,
    sharedSecret: any,
    sessionKey: any,
  ): Promise<any> {
    return submitLastfm(plays, apiKey, sharedSecret, sessionKey, fetch);
  }

  return {
    getLastFmAlbumInfo,
    searchLastFmAlbums,
    getLastFmTrackAlbumInfo,
    getLastFmTrackInfo,
    getLastFmArtistInfo,
    resolveLastFmCanonicalArtist,
    mapConfirmedIdentityToLastFm,
    enrichTrackArtworkForLastFm,
    enrichTrackForLastFm,
    signParams,
    scrobbleBatch,
  };
}
