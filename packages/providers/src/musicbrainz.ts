// General matching behavior preserved from aScrobble 0.3.49.
import {
  MUSICBRAINZ_REQUEST_GAP_MS,
  MUSICBRAINZ_NOT_FOUND,
  MUSICBRAINZ_API,
  MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS,
  MUSICBRAINZ_IDENTITY_MISS_CACHE_MS,
} from "../../core/src/constants";
import {
  stripVersionQualifiers,
  musicBrainzEscape,
  normalizeCatalogText,
  versionAttributes,
  preferredLocaleForIsrc,
} from "../../core/src/text";
import {
  scoreMusicBrainzIdentityCandidate,
  getMusicBrainzArtistNames,
} from "../../core/src/musicbrainz-evidence";
import type { ProviderContext } from "./runtime";
export function createMusicbrainz(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;
  const musicBrainzIdentityCacheKey = (...args: any[]): any =>
    ctx.api.musicBrainzIdentityCacheKey(...args);
  async function getMusicBrainzJson(url?: any): Promise<any> {
    const request: any = ctx.state.musicBrainzRequestChain.then(async () => {
      for (let attempt: any = 0; attempt < 3; attempt++) {
        const waitMs: any = Math.max(
          0,
          ctx.state.lastMusicBrainzRequestAt +
            MUSICBRAINZ_REQUEST_GAP_MS -
            Date.now(),
        );
        if (waitMs > 0)
          await new Promise((resolve?: any) => setTimeout(resolve, waitMs));
        let response: any = null;
        let retryAfterSeconds: any = 0;
        try {
          response = await fetch(url, {
            headers: {
              Accept: "application/json",
              "User-Agent":
                "aScrobble/0.3.23 (https://github.com/ThisCrashesYouOnPhone/aScrobble)",
            },
            signal: AbortSignal.timeout(1e4),
          });
          ctx.state.lastMusicBrainzRequestAt = Date.now();
          if (response.ok) return response.json();
          if (response.status === 404) return MUSICBRAINZ_NOT_FOUND;
          if (![429, 502, 503, 504].includes(response.status)) return null;
          retryAfterSeconds = Number(response.headers.get("Retry-After") ?? 0);
        } catch (err: any) {
          ctx.state.lastMusicBrainzRequestAt = Date.now();
          if (attempt === 2) throw err;
        }
        if (attempt === 2) return null;
        const retryMs: any = Math.max(
          MUSICBRAINZ_REQUEST_GAP_MS,
          retryAfterSeconds * 1e3,
          (attempt + 1) * 1500,
        );
        await new Promise((resolve?: any) => setTimeout(resolve, retryMs));
      }
      return null;
    });
    ctx.state.musicBrainzRequestChain = request.catch(() => null);
    return request;
  }
  async function searchMusicBrainzRecordings(
    artist?: any,
    track?: any,
  ): Promise<any> {
    const title: any = stripVersionQualifiers(track);
    if (!artist || !title) return [];
    const url: any = new URL(`${MUSICBRAINZ_API}/recording/`);
    url.search = new URLSearchParams({
      query: `recording:"${musicBrainzEscape(title)}" AND artist:"${musicBrainzEscape(artist)}"`,
      fmt: "json",
      limit: "15",
    }).toString();
    const data: any = await getMusicBrainzJson(url);
    if (data === MUSICBRAINZ_NOT_FOUND) return [];
    if (!data) throw new Error("musicbrainz_recording_search_failed");
    return Array.isArray(data?.recordings) ? data.recordings : [];
  }
  async function lookupMusicBrainzNativeArtistNames(
    artist?: any,
  ): Promise<any> {
    if (!artist) return [];
    const url: any = new URL(`${MUSICBRAINZ_API}/artist/`);
    url.search = new URLSearchParams({
      query: artist,
      limit: "5",
      fmt: "json",
    }).toString();
    const data: any = await getMusicBrainzJson(url);
    if (data === MUSICBRAINZ_NOT_FOUND) return [];
    if (!data) throw new Error("musicbrainz_artist_lookup_failed");
    const normalizedInput: any = normalizeCatalogText(artist);
    return (data.artists ?? [])
      .filter((candidate?: any) => {
        if (Number(candidate?.score ?? 0) < 90 || !candidate?.name)
          return false;
        if (normalizeCatalogText(candidate.name) === normalizedInput)
          return true;
        return (candidate.aliases ?? []).some(
          (alias?: any) =>
            normalizeCatalogText(alias?.name) === normalizedInput,
        );
      })
      .map((candidate?: any) => candidate.name)
      .filter((name?: any) => normalizeCatalogText(name) !== normalizedInput);
  }
  async function lookupMusicBrainzRecordingsByIsrc(isrc?: any): Promise<any> {
    if (!isrc) return [];
    const url: any = new URL(
      `${MUSICBRAINZ_API}/isrc/${encodeURIComponent(isrc)}`,
    );
    url.search = new URLSearchParams({
      inc: "artist-credits",
      fmt: "json",
    }).toString();
    const data: any = await getMusicBrainzJson(url);
    if (data === MUSICBRAINZ_NOT_FOUND) return [];
    if (!data) throw new Error("musicbrainz_isrc_lookup_failed");
    return Array.isArray(data?.recordings) ? data.recordings : [];
  }
  async function hydrateMusicBrainzRecording(recording?: any): Promise<any> {
    if (!recording?.id) return null;
    const url: any = new URL(
      `${MUSICBRAINZ_API}/recording/${encodeURIComponent(recording.id)}`,
    );
    url.search = new URLSearchParams({
      inc: "artist-credits+releases+release-groups+media",
      fmt: "json",
    }).toString();
    const data: any = await getMusicBrainzJson(url);
    if (data === MUSICBRAINZ_NOT_FOUND) return null;
    if (!data) throw new Error("musicbrainz_recording_hydration_failed");
    return data;
  }
  async function hydrateMusicBrainzRelease(releaseId?: any): Promise<any> {
    if (!releaseId) return null;
    const url: any = new URL(
      `${MUSICBRAINZ_API}/release/${encodeURIComponent(releaseId)}`,
    );
    url.search = new URLSearchParams({
      inc: "artist-credits+recordings+release-groups+media",
      fmt: "json",
    }).toString();
    const data: any = await getMusicBrainzJson(url);
    if (data === MUSICBRAINZ_NOT_FOUND) return null;
    if (!data) throw new Error("musicbrainz_release_hydration_failed");
    return data;
  }
  async function resolveMusicBrainzIdentity(
    track?: any,
    appleTracks?: any,
    kv?: any,
  ): Promise<any> {
    const cacheKey: any = musicBrainzIdentityCacheKey(track);
    if (kv) {
      const cached: any = await kv.get(cacheKey, "json").catch(() => null);
      const checkedAt: any = cached?.checked_at_iso
        ? new Date(cached.checked_at_iso).getTime()
        : 0;
      const maxAge: any = cached?.identity
        ? MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS
        : MUSICBRAINZ_IDENTITY_MISS_CACHE_MS;
      if (checkedAt && Date.now() - checkedAt < maxAge)
        return cached.identity ?? null;
      for (const legacyVersion of [8, 7, 6, 5, 4]) {
        const legacy: any = await kv
          .get(musicBrainzIdentityCacheKey(track, legacyVersion), "json")
          .catch(() => null);
        const legacyCheckedAt: any = legacy?.checked_at_iso
          ? new Date(legacy.checked_at_iso).getTime()
          : 0;
        if (
          !legacy?.identity?.release_mbid ||
          !legacyCheckedAt ||
          Date.now() - legacyCheckedAt >= MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS
        )
          continue;
        if (
          track._apple_is_compilation === true &&
          !legacy.identity.album_artist
        )
          continue;
        const upgradedIdentity: any = {
          ...legacy.identity,
          version_attributes:
            legacy.identity.version_attributes ??
            versionAttributes(track.name, track.album),
        };
        await kv
          .put(
            cacheKey,
            JSON.stringify({
              identity: upgradedIdentity,
              checked_at_iso: new Date().toISOString(),
            }),
          )
          .catch(() => void 0);
        return upgradedIdentity;
      }
    }
    let isrcExact: any = false;
    let recordings: any = [];
    let scoringAppleTracks: any = appleTracks;
    let lookupFailed: any = false;
    if (track.isrc) {
      try {
        recordings = await lookupMusicBrainzRecordingsByIsrc(track.isrc);
      } catch (err: any) {
        lookupFailed = true;
        recordings = [];
      }
      isrcExact = recordings.length > 0;
    }
    if (recordings.length === 0) {
      const searchTracks: any = [...appleTracks].sort(
        (a?: any, b?: any) =>
          Number(
            Boolean(b._metadata_source === preferredLocaleForIsrc(track.isrc)),
          ) -
          Number(
            Boolean(a._metadata_source === preferredLocaleForIsrc(track.isrc)),
          ),
      );
      const seen: any = new Set();
      for (const candidate of searchTracks.slice(0, 2)) {
        const key: any = `${candidate.artist}\n${stripVersionQualifiers(candidate.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let found: any = [];
        try {
          found = await searchMusicBrainzRecordings(
            candidate.artist,
            candidate.name,
          );
        } catch (err: any) {
          lookupFailed = true;
          continue;
        }
        recordings.push(...found);
        if (found.length > 0) break;
      }
    }
    if (recordings.length === 0) {
      const sourceArtists: any = [
        ...new Set(
          appleTracks
            .flatMap((candidate?: any) => [
              candidate.artist,
              candidate.album_artist,
            ])
            .filter(Boolean),
        ),
      ].slice(0, 2);
      const nativeArtistNames: any = [];
      for (const sourceArtist of sourceArtists) {
        try {
          nativeArtistNames.push(
            ...(await lookupMusicBrainzNativeArtistNames(sourceArtist)),
          );
        } catch (err: any) {
          lookupFailed = true;
        }
      }
      const uniqueNativeArtistNames: any = [...new Set(nativeArtistNames)];
      const source: any =
        appleTracks.find(
          (candidate?: any) => candidate._is_source_storefront,
        ) ??
        appleTracks[0] ??
        track;
      const nativeAliasTracks: any = uniqueNativeArtistNames.map(
        (artist?: any) => ({
          ...source,
          artist,
          album_artist: artist,
          _metadata_source: "musicbrainz_artist_alias",
          _is_source_storefront: false,
        }),
      );
      scoringAppleTracks = [...appleTracks, ...nativeAliasTracks];
      for (const candidate of nativeAliasTracks.slice(0, 2)) {
        let found: any = [];
        try {
          found = await searchMusicBrainzRecordings(
            candidate.artist,
            candidate.name,
          );
        } catch (err: any) {
          lookupFailed = true;
          continue;
        }
        recordings.push(...found);
        if (found.length > 0) break;
      }
    }
    const sourceArtistNames: any = new Set(
      appleTracks
        .flatMap((candidate?: any) => [
          candidate.artist,
          candidate.album_artist,
        ])
        .filter(Boolean)
        .map(normalizeCatalogText),
    );
    const recordingAliasArtistNames: any = [];
    for (const recording of recordings) {
      for (const credit of recording?.["artist-credit"] ?? []) {
        const nativeName: any = credit?.name ?? credit?.artist?.name;
        const aliases: any = credit?.artist?.aliases ?? [];
        if (
          !nativeName ||
          !aliases.some((alias?: any) =>
            sourceArtistNames.has(normalizeCatalogText(alias?.name)),
          )
        )
          continue;
        recordingAliasArtistNames.push(nativeName);
      }
    }
    if (recordingAliasArtistNames.length > 0) {
      const source: any =
        appleTracks.find(
          (candidate?: any) => candidate._is_source_storefront,
        ) ??
        appleTracks[0] ??
        track;
      const existingArtists: any = new Set(
        scoringAppleTracks
          .flatMap((candidate?: any) => [
            candidate.artist,
            candidate.album_artist,
          ])
          .filter(Boolean)
          .map(normalizeCatalogText),
      );
      const recordingAliasTracks: any = [...new Set(recordingAliasArtistNames)]
        .filter(
          (artist?: any) => !existingArtists.has(normalizeCatalogText(artist)),
        )
        .map((artist?: any) => ({
          ...source,
          artist,
          album_artist: artist,
          _metadata_source: "musicbrainz_recording_artist_alias",
          _is_source_storefront: false,
        }));
      scoringAppleTracks = [...scoringAppleTracks, ...recordingAliasTracks];
    }
    const hydrated: any = [];
    const seenRecordings: any = new Set();
    let hydrationFailed: any = false;
    for (const recording of recordings.slice(0, 3)) {
      if (!recording?.id || seenRecordings.has(recording.id)) continue;
      seenRecordings.add(recording.id);
      let full: any = null;
      try {
        full = await hydrateMusicBrainzRecording(recording);
      } catch (err: any) {
        hydrationFailed = true;
      }
      hydrated.push(full ?? recording);
    }
    const scored: any = [];
    for (const recording of hydrated) {
      const releases: any =
        Array.isArray(recording?.releases) && recording.releases.length > 0
          ? recording.releases
          : [null];
      const releaseAliases: any = [];
      for (const release of releases) {
        const candidate: any = scoreMusicBrainzIdentityCandidate(
          recording,
          release,
          scoringAppleTracks,
          isrcExact,
          true,
        );
        if (!candidate) continue;
        if (candidate.releaseAliasEvidence) releaseAliases.push(candidate);
        else scored.push(candidate);
      }
      const aliasReleaseGroups: any = new Set(
        releaseAliases
          .map((candidate?: any) => candidate.releaseGroup?.id)
          .filter(Boolean),
      );
      if (releaseAliases.length > 0 && aliasReleaseGroups.size === 1) {
        scored.push(...releaseAliases);
      }
      if (isrcExact && releases.some(Boolean)) {
        const recordingOnly: any = scoreMusicBrainzIdentityCandidate(
          recording,
          null,
          scoringAppleTracks,
          true,
        );
        if (recordingOnly) scored.push(recordingOnly);
      }
    }
    scored.sort(
      (a?: any, b?: any) =>
        b.score - a.score || a.durationDiffMs - b.durationDiffMs,
    );
    let best: any = scored[0];
    if (
      best?.release?.id &&
      appleTracks.some(
        (candidate?: any) => candidate._apple_is_compilation === true,
      )
    ) {
      try {
        const hydratedRelease: any = await hydrateMusicBrainzRelease(
          best.release.id,
        );
        const hydratedCandidate: any = scoreMusicBrainzIdentityCandidate(
          best.recording,
          hydratedRelease,
          scoringAppleTracks,
          isrcExact,
          true,
        );
        if (hydratedCandidate)
          best = {
            ...hydratedCandidate,
            score: Math.max(best.score, hydratedCandidate.score),
          };
      } catch (err: any) {
        console.warn(
          `MusicBrainz compilation release hydration skipped for ${best.release.id}:`,
          err,
        );
      }
    }
    const secondDifferentRecording: any = scored.find(
      (candidate?: any) => candidate.recording?.id !== best?.recording?.id,
    );
    const recordingUnambiguous: any =
      Boolean(best) &&
      (!secondDifferentRecording ||
        best.score - secondDifferentRecording.score >= 40);
    let identity: any = null;
    if (best && recordingUnambiguous) {
      const sameRecordingReleases: any = scored.filter(
        (candidate?: any) =>
          candidate.recording?.id === best.recording?.id && candidate.release,
      );
      const secondRelease: any = sameRecordingReleases.find(
        (candidate?: any) => candidate.release?.id !== best.release?.id,
      );
      const aliasGroupConfirmed: any =
        Boolean(best.releaseAliasEvidence) &&
        sameRecordingReleases
          .filter((candidate?: any) => candidate.releaseAliasEvidence)
          .every(
            (candidate?: any) =>
              candidate.releaseGroup?.id === best.releaseGroup?.id,
          );
      const releaseTitleConfirmed: any =
        best.albumTitleScore >= 90 || aliasGroupConfirmed;
      const releaseConfirmed: any =
        Boolean(best.release) &&
        releaseTitleConfirmed &&
        (!secondRelease ||
          best.score - secondRelease.score >= 20 ||
          (!best.releaseAliasEvidence &&
            best.releaseGroup?.id === secondRelease.releaseGroup?.id));
      const releaseGroupConfirmed: any =
        Boolean(best.releaseGroup?.id) && releaseTitleConfirmed;
      const releaseGroupReleaseMbids: any = releaseGroupConfirmed
        ? sameRecordingReleases
            .filter(
              (candidate?: any) =>
                candidate.releaseGroup?.id === best.releaseGroup.id,
            )
            .map((candidate?: any) => candidate.release?.id)
            .filter(Boolean)
        : [];
      identity = {
        confirmed: true,
        method: isrcExact ? "isrc" : "strict_search",
        recording_mbid: best.recording.id,
        release_mbid: releaseConfirmed ? best.release.id : null,
        release_group_mbid: releaseGroupConfirmed ? best.releaseGroup.id : null,
        artist_mbid: best.recording?.["artist-credit"]?.[0]?.artist?.id ?? null,
        artist: getMusicBrainzArtistNames(best.recording)[0] ?? track.artist,
        track: best.recording.title,
        album: releaseConfirmed ? best.release.title : null,
        album_artist: releaseConfirmed
          ? (getMusicBrainzArtistNames(best.release)[0] ??
            track.album_artist ??
            track.artist)
          : null,
        release_track_count: releaseConfirmed
          ? (best.release?.media ?? []).reduce(
              (total?: any, medium?: any) =>
                total + Number(medium?.["track-count"] ?? 0),
              0,
            )
          : null,
        release_track_number_confirmed: releaseConfirmed
          ? best.trackEvidence?.track_number_match === true
          : false,
        release_group: releaseGroupConfirmed
          ? (best.releaseGroup?.title ?? null)
          : null,
        release_group_release_mbids: [...new Set(releaseGroupReleaseMbids)],
        release_equivalence_method: best.releaseAliasEvidence
          ? "isrc_medium_release_group"
          : null,
        version_attributes: versionAttributes(
          best.recording?.title,
          best.recording?.disambiguation,
          best.release?.title,
          ...(best.releaseGroup?.["secondary-types"] ?? []),
        ),
        score: best.score,
      };
    }
    const expectedNativeLocale: any = preferredLocaleForIsrc(track.isrc);
    const nativeAppleLookupIncomplete: any = Boolean(
      expectedNativeLocale &&
      !appleTracks.some(
        (candidate?: any) =>
          candidate?._metadata_source === expectedNativeLocale,
      ),
    );
    if (
      kv &&
      (identity ||
        (!lookupFailed && !hydrationFailed && !nativeAppleLookupIncomplete))
    ) {
      await kv
        .put(
          cacheKey,
          JSON.stringify({
            identity,
            checked_at_iso: new Date().toISOString(),
          }),
        )
        .catch(() => void 0);
    }
    if (!identity && (lookupFailed || hydrationFailed)) {
      throw new Error("musicbrainz_identity_transient_failure");
    }
    return identity;
  }
  return {
    getMusicBrainzJson,
    searchMusicBrainzRecordings,
    lookupMusicBrainzNativeArtistNames,
    lookupMusicBrainzRecordingsByIsrc,
    hydrateMusicBrainzRecording,
    hydrateMusicBrainzRelease,
    resolveMusicBrainzIdentity,
  };
}
