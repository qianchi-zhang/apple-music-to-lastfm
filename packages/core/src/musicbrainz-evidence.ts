// General matching behavior preserved from aScrobble 0.3.49.
import {
  metadataIndicatesLive,
  catalogTitleMatchScore,
  normalizeCatalogText,
  versionAttributesMatch,
  preferredLocaleForIsrc,
  stripRedundantLiveAlbumSuffix,
} from "./text";
import { appleReleaseEquivalenceEvidence } from "./apple-evidence";
export function getMusicBrainzArtistNames(recording?: any): any {
  return (recording?.["artist-credit"] ?? [])
    .map((credit?: any) => credit?.name ?? credit?.artist?.name)
    .filter(Boolean);
}
export function getMusicBrainzReleaseCandidates(
  recording?: any,
  sourceTrack?: any,
  canonicalArtist?: any,
): any {
  const sourceLive: any = metadataIndicatesLive(
    sourceTrack.name,
    sourceTrack.album,
  );
  const durationMs: any = Number(recording?.length ?? 0);
  const sourceDurationMs: any = Number(sourceTrack.duration_ms ?? 0);
  const durationDiffMs: any =
    durationMs && sourceDurationMs
      ? Math.abs(durationMs - sourceDurationMs)
      : Number.POSITIVE_INFINITY;
  const titleScore: any = catalogTitleMatchScore(
    sourceTrack.name,
    recording?.title,
  );
  const artistMatches: any = getMusicBrainzArtistNames(recording).some(
    (name?: any) =>
      normalizeCatalogText(name) === normalizeCatalogText(canonicalArtist),
  );
  if (!artistMatches || titleScore < 90) return [];
  if (Number.isFinite(durationDiffMs) && durationDiffMs > 5e3) return [];
  const candidates: any = [];
  for (const release of recording?.releases ?? []) {
    const releaseGroup: any = release?.["release-group"] ?? {};
    const releaseLive: any = metadataIndicatesLive(
      release?.title,
      ...(releaseGroup?.["secondary-types"] ?? []),
    );
    if (sourceLive !== releaseLive) continue;
    const albumTitleScore: any = catalogTitleMatchScore(
      sourceTrack.album,
      release?.title,
    );
    // MBIDs and artwork may only refine the release that was actually played;
    // they must never switch it to a compilation or another concert.
    if (sourceTrack.album && albumTitleScore < 90) continue;
    const official: any = release?.status === "Official";
    const primaryType: any = releaseGroup?.["primary-type"] ?? "";
    const formalType: any = ["Album", "EP", "Single"].includes(primaryType);
    if (!formalType) continue;
    let score: any =
      Number(recording?.score ?? 0) + titleScore * 2 + albumTitleScore * 3;
    if (durationDiffMs <= 1500) score += 160;
    else if (durationDiffMs <= 3e3) score += 100;
    else if (Number.isFinite(durationDiffMs)) score += 30;
    if (official) score += 120;
    if (release?.country === "TW" || release?.country === "HK") score += 20;
    candidates.push({
      recording,
      release,
      releaseGroup,
      official,
      durationDiffMs,
      titleScore,
      score,
    });
  }
  return candidates;
}
export function findLastFmAlbumTrack(
  albumInfo?: any,
  sourceTrack?: any,
  recording?: any,
  options: any = {},
): any {
  const albumTracks: any = albumInfo?.tracks?.track;
  const tracks: any = Array.isArray(albumTracks)
    ? albumTracks
    : albumTracks
      ? [albumTracks]
      : [];
  const sourceDurationMs: any = Number(
    sourceTrack.duration_ms ?? recording?.length ?? 0,
  );
  const sourceTrackNumber: any = Number(sourceTrack._apple_track_number ?? 0);
  const candidates: any = tracks
    .map((track?: any) => {
      const titleScore: any = Math.max(
        catalogTitleMatchScore(sourceTrack.name, track?.name),
        catalogTitleMatchScore(recording?.title, track?.name),
      );
      const durationMs: any = Number(track?.duration ?? 0) * 1e3;
      const durationDiffMs: any =
        durationMs && sourceDurationMs
          ? Math.abs(durationMs - sourceDurationMs)
          : Number.POSITIVE_INFINITY;
      const lastFmTrackNumber: any = Number(track?.["@attr"]?.rank ?? 0);
      const verifiedDurationAnomaly: any = Boolean(
        options.allow_verified_duration_anomaly &&
        titleScore === 100 &&
        sourceTrackNumber > 0 &&
        lastFmTrackNumber === sourceTrackNumber,
      );
      let score: any = titleScore * 3;
      if (durationDiffMs <= 1500) score += 180;
      else if (durationDiffMs <= 3e3) score += 100;
      else if (verifiedDurationAnomaly) score += 50;
      return {
        track,
        titleScore,
        durationDiffMs,
        verifiedDurationAnomaly,
        score,
      };
    })
    .filter(
      (candidate?: any) =>
        candidate.titleScore >= 90 &&
        (!Number.isFinite(candidate.durationDiffMs) ||
          candidate.durationDiffMs <= 3e3 ||
          candidate.verifiedDurationAnomaly),
    );
  candidates.sort(
    (a?: any, b?: any) =>
      b.score - a.score || a.durationDiffMs - b.durationDiffMs,
  );
  return candidates[0]?.track ?? null;
}
export function bestCatalogTitleScore(values?: any, candidate?: any): any {
  return Math.max(
    0,
    ...values
      .filter(Boolean)
      .map((value?: any) => catalogTitleMatchScore(value, candidate)),
  );
}
export function musicBrainzReleaseTrackEvidence(
  release?: any,
  recording?: any,
  appleTracks?: any,
  isrcExact: any = false,
): any {
  const source: any =
    appleTracks.find((track?: any) => track._is_source_storefront) ??
    appleTracks[0];
  const relatedTracks: any = (release?.media ?? []).flatMap(
    (medium?: any) => medium?.tracks ?? [],
  );
  if (relatedTracks.length === 0)
    return {
      associated: true,
      track_number_match: false,
      track_count_match: false,
    };
  const sourceTrackNumber: any = Number(source?._apple_track_number ?? 0);
  const sourceTrackCount: any = Number(source?._apple_album_track_count ?? 0);
  const matchingTracks: any = relatedTracks.filter((track?: any) => {
    const titleScore: any = bestCatalogTitleScore(
      appleTracks.map((item?: any) => item.name),
      track?.title ?? recording?.title,
    );
    const durationMs: any = Number(track?.length ?? recording?.length ?? 0);
    const sourceDurationMs: any = Number(source?.duration_ms ?? 0);
    const recordingIdMatch: any = Boolean(
      recording?.id &&
      track?.recording?.id &&
      recording.id === track.recording.id,
    );
    const durationMatches: any =
      !durationMs ||
      !sourceDurationMs ||
      Math.abs(durationMs - sourceDurationMs) <= 5e3;
    // The recording endpoint returns only this recording's occurrences inside
    // each release, but those medium tracks do not always repeat recording.id.
    // For an exact-ISRC recording, the release structure can safely identify
    // that occurrence even when Apple localized the title into another script.
    const exactIsrcReleaseOccurrence: any = Boolean(
      isrcExact &&
      recording?.id &&
      durationMatches &&
      sourceTrackNumber > 0 &&
      Number(track?.position ?? track?.number ?? 0) === sourceTrackNumber &&
      sourceTrackCount > 0 &&
      (release?.media ?? []).some(
        (medium?: any) =>
          Number(medium?.["track-count"] ?? 0) === sourceTrackCount &&
          (medium?.tracks ?? []).includes(track),
      ),
    );
    return (
      (recordingIdMatch || titleScore >= 90 || exactIsrcReleaseOccurrence) &&
      durationMatches
    );
  });
  const associated: any = matchingTracks.length > 0;
  const trackNumberMatch: any =
    sourceTrackNumber > 0 &&
    matchingTracks.some(
      (track?: any) =>
        Number(track?.position ?? track?.number ?? 0) === sourceTrackNumber,
    );
  const trackCountMatch: any =
    sourceTrackCount > 0 &&
    (release?.media ?? []).some(
      (medium?: any) =>
        Number(medium?.["track-count"] ?? 0) === sourceTrackCount,
    );
  return {
    associated,
    track_number_match: trackNumberMatch,
    track_count_match: trackCountMatch,
  };
}
export function musicBrainzReleaseDateClose(
  appleDate?: any,
  musicBrainzDate?: any,
): any {
  if (!appleDate || !musicBrainzDate) return false;
  if (appleDate === musicBrainzDate) return true;
  const shorterLength: any = Math.min(appleDate.length, musicBrainzDate.length);
  if (shorterLength === 4 || shorterLength === 7)
    return (
      appleDate.slice(0, shorterLength) ===
      musicBrainzDate.slice(0, shorterLength)
    );
  const appleTime: any = new Date(`${appleDate}T00:00:00Z`).getTime();
  const musicBrainzTime: any = new Date(
    `${musicBrainzDate}T00:00:00Z`,
  ).getTime();
  return (
    Number.isFinite(appleTime) &&
    Number.isFinite(musicBrainzTime) &&
    Math.abs(appleTime - musicBrainzTime) <= 45 * 24 * 60 * 60 * 1e3
  );
}
export function scoreMusicBrainzIdentityCandidate(
  recording?: any,
  release?: any,
  appleTracks?: any,
  isrcExact?: any,
  allowCrossLanguageReleaseGroup: any = false,
): any {
  const artists: any = getMusicBrainzArtistNames(recording);
  const appleArtists: any = appleTracks
    .flatMap((track?: any) => [track.artist, track.album_artist])
    .filter(Boolean);
  const artistMatches: any = artists.some((artist?: any) =>
    appleArtists.some(
      (candidate?: any) =>
        normalizeCatalogText(artist) === normalizeCatalogText(candidate),
    ),
  );
  if (!artistMatches && !isrcExact) return null;
  const titleScore: any = bestCatalogTitleScore(
    appleTracks.map((track?: any) => track.name),
    recording?.title,
  );
  if (titleScore < 90 && !isrcExact) return null;
  const sourceDurationMs: any = Number(
    (
      appleTracks.find((track?: any) => track._is_source_storefront) ??
      appleTracks[0]
    )?.duration_ms ?? 0,
  );
  const durationDiffMs: any =
    recording?.length && sourceDurationMs
      ? Math.abs(Number(recording.length) - sourceDurationMs)
      : Number.POSITIVE_INFINITY;
  if (Number.isFinite(durationDiffMs) && durationDiffMs > 5e3) return null;
  const releaseGroup: any = release?.["release-group"] ?? {};
  const exactNativeAppleTrack: any = appleTracks.find(
    (track?: any) =>
      track._apple_release_equivalence_method ===
        "exact_apple_catalog_release" && !track._is_source_storefront,
  );
  const sourceVersionValues: any = (
    exactNativeAppleTrack ? [exactNativeAppleTrack] : appleTracks
  ).flatMap((track?: any) => [track.name, track.album]);
  const mbVersionValues: any = [
    recording?.title,
    recording?.disambiguation,
    release?.title,
    ...(releaseGroup?.["secondary-types"] ?? []),
  ];
  if (!versionAttributesMatch(sourceVersionValues, mbVersionValues))
    return null;
  if (!release) {
    if (!isrcExact) return null;
    return {
      score: 900,
      titleScore,
      durationDiffMs,
      recording,
      release: null,
      releaseGroup: null,
    };
  }
  if (release.status !== "Official") return null;
  const primaryType: any = releaseGroup?.["primary-type"] ?? "";
  if (!["Album", "EP", "Single"].includes(primaryType)) return null;
  const secondaryTypes: any = releaseGroup?.["secondary-types"] ?? [];
  if (
    secondaryTypes.includes("Compilation") &&
    !appleTracks.some((track?: any) => track._apple_is_compilation)
  )
    return null;
  const albumNames: any = appleTracks.map((track?: any) => track.album);
  const albumTitleScore: any = Math.max(
    bestCatalogTitleScore(albumNames, release.title),
    bestCatalogTitleScore(albumNames, releaseGroup.title),
  );
  const trackEvidence: any = musicBrainzReleaseTrackEvidence(
    release,
    recording,
    appleTracks,
    isrcExact,
  );
  if (!trackEvidence.associated) return null;
  const source: any =
    appleTracks.find((track?: any) => track._is_source_storefront) ??
    appleTracks[0];
  const appleDate: any = source?._apple_release_date ?? "";
  const mbDate: any =
    release.date ?? releaseGroup?.["first-release-date"] ?? "";
  const dateMatch: any = Boolean(
    appleDate &&
    mbDate &&
    (appleDate === mbDate || appleDate.slice(0, 4) === mbDate.slice(0, 4)),
  );
  const closeDateMatch: any = musicBrainzReleaseDateClose(appleDate, mbDate);
  const barcodeMatch: any = Boolean(
    source?._apple_album_upc &&
    release?.barcode &&
    String(source._apple_album_upc) === String(release.barcode),
  );
  const digitalMediumMatch: any = (release?.media ?? []).some(
    (medium?: any) =>
      medium?.format === "Digital Media" &&
      Number(medium?.["track-count"] ?? 0) ===
        Number(source?._apple_album_track_count ?? 0),
  );
  const releaseAliasEvidence: any =
    albumTitleScore < 90 &&
    allowCrossLanguageReleaseGroup &&
    isrcExact &&
    trackEvidence.track_number_match &&
    trackEvidence.track_count_match &&
    (closeDateMatch || barcodeMatch);
  if (albumTitleScore < 90 && !releaseAliasEvidence) return null;
  let score: any =
    (isrcExact ? 1e3 : 0) + titleScore * 3 + albumTitleScore * 4 + 250;
  if (durationDiffMs <= 1500) score += 250;
  else if (durationDiffMs <= 3e3) score += 120;
  if (dateMatch) score += 120;
  if (trackEvidence.track_number_match) score += 100;
  if (trackEvidence.track_count_match) score += 80;
  if (digitalMediumMatch) score += 150;
  if (barcodeMatch) score += 100;
  if (
    release.country === "TW" ||
    release.country === "JP" ||
    release.country === "HK"
  )
    score += 20;
  return {
    score,
    titleScore,
    albumTitleScore,
    durationDiffMs,
    dateMatch,
    closeDateMatch,
    barcodeMatch,
    digitalMediumMatch,
    releaseAliasEvidence,
    trackEvidence,
    recording,
    release,
    releaseGroup,
  };
}
export function buildLegalLastFmAliases(
  preferred?: any,
  appleTracks?: any,
  identity?: any,
  spotifyEvidence?: any,
): any {
  const aliases: any = [];
  const push: any = (value?: any, source?: any) => {
    if (!value?.artist || (!value?.name && !value?.track) || !value?.album)
      return;
    const nativeLocale: any = preferredLocaleForIsrc(
      value.isrc ?? preferred.isrc,
    );
    aliases.push({
      artist: value.artist,
      track: value.name ?? value.track,
      album: value.album,
      album_artist: value.album_artist ?? value.artist,
      duration_ms: value.duration_ms ?? preferred.duration_ms,
      album_track_count:
        value._apple_album_track_count ?? value.album_track_count,
      native_apple_metadata: Boolean(
        value._apple_native_metadata_authority ||
        (nativeLocale &&
          value._metadata_source === nativeLocale &&
          value._is_source_storefront !== true),
      ),
      source,
    });
  };
  const pushIdentityAliases: any = () => {
    if (identity?.release_mbid && identity.album)
      push(
        {
          artist: identity.artist,
          track: identity.track,
          album: identity.album,
          album_artist: identity.album_artist ?? identity.artist,
          duration_ms: preferred.duration_ms,
        },
        "musicbrainz_release",
      );
    if (
      identity?.release_group_mbid &&
      identity.release_group &&
      identity.release_group !== identity.album
    )
      push(
        {
          artist: identity.artist,
          track: identity.track,
          album: identity.release_group,
          album_artist: identity.album_artist ?? identity.artist,
          duration_ms: preferred.duration_ms,
        },
        "musicbrainz_release_group",
      );
  };
  const pushExactAppleArtistComposition: any = () => {
    const source: any =
      appleTracks.find((candidate?: any) => candidate._is_source_storefront) ??
      preferred;
    const exactVariants: any = appleTracks.filter((candidate?: any) => {
      const evidence: any = appleReleaseEquivalenceEvidence(source, candidate);
      return (
        evidence.exact_apple_catalog_release &&
        candidate.name === preferred.name &&
        candidate.album === preferred.album
      );
    });
    const native: any = exactVariants.find(
      (candidate?: any) =>
        candidate._metadata_source === "zh-Hant-TW" &&
        /\p{Script=Han}/u.test(candidate.artist ?? ""),
    );
    const latin: any = exactVariants.find(
      (candidate?: any) =>
        /\p{Script=Latin}/u.test(candidate.artist ?? "") &&
        !/\p{Script=Han}/u.test(candidate.artist ?? ""),
    );
    if (
      !native ||
      !latin ||
      normalizeCatalogText(native.artist) === normalizeCatalogText(latin.artist)
    )
      return;
    push(
      {
        ...native,
        artist: `${native.artist} (${latin.artist})`,
        album_artist: `${native.album_artist ?? native.artist} (${latin.album_artist ?? latin.artist})`,
        _apple_native_metadata_authority: true,
      },
      "apple_exact_release_artist_alias",
    );
  };
  const preferredNativeLocale: any = preferredLocaleForIsrc(preferred.isrc);
  const hasConfirmedNativeAppleMetadata: any = Boolean(
    preferredNativeLocale &&
    preferred._metadata_source === preferredNativeLocale &&
    preferred._is_source_storefront !== true,
  );
  const identityUsesDifferentNativeNames: any = Boolean(
    identity?.confirmed &&
    identity.artist &&
    identity.track &&
    !hasConfirmedNativeAppleMetadata &&
    (normalizeCatalogText(identity.artist) !==
      normalizeCatalogText(preferred.artist) ||
      catalogTitleMatchScore(identity.track, preferred.name) < 90),
  );
  if (identityUsesDifferentNativeNames) pushIdentityAliases();
  pushExactAppleArtistComposition();
  if (
    preferred._apple_raw_album &&
    preferred._apple_raw_album !== preferred.album
  ) {
    push(
      { ...preferred, album: preferred._apple_raw_album },
      "apple_native_raw_release_title",
    );
  }
  push(preferred, "apple_preferred");
  for (const candidate of appleTracks) {
    if (
      candidate._apple_raw_album &&
      candidate._apple_raw_album !== candidate.album
    ) {
      push(
        { ...candidate, album: candidate._apple_raw_album },
        "apple_raw_release_title",
      );
    }
    push(candidate, "apple_same_release");
  }
  const confirmedLiveRelease: any = Boolean(
    identity?.confirmed &&
    identity.release_mbid &&
    identity.release_group_mbid &&
    identity.version_attributes?.live,
  );
  if (confirmedLiveRelease) {
    const confirmedAlbumNames: any = [
      identity.album,
      identity.release_group,
    ].filter(Boolean);
    const identityMatchesAppleRelease: any = appleTracks.some(
      (candidate?: any) => {
        const baseAlbum: any = stripRedundantLiveAlbumSuffix(candidate.album);
        return (
          baseAlbum &&
          confirmedAlbumNames.some(
            (name?: any) => catalogTitleMatchScore(baseAlbum, name) >= 90,
          )
        );
      },
    );
    if (identityMatchesAppleRelease) {
      for (const candidate of appleTracks) {
        const albumWithoutLiveSuffix: any = stripRedundantLiveAlbumSuffix(
          candidate.album,
        );
        if (
          !albumWithoutLiveSuffix ||
          albumWithoutLiveSuffix === candidate.album ||
          !metadataIndicatesLive(candidate.name, candidate.album)
        )
          continue;
        push(
          { ...candidate, album: albumWithoutLiveSuffix },
          "musicbrainz_confirmed_live_album_alias",
        );
      }
    }
  }
  if (!identityUsesDifferentNativeNames) pushIdentityAliases();
  if (spotifyEvidence)
    push(
      {
        artist: spotifyEvidence.artist,
        track: spotifyEvidence.track,
        album: spotifyEvidence.album,
        duration_ms: spotifyEvidence.duration_ms,
      },
      "spotify_verified",
    );
  const seen: any = new Set();
  return aliases.filter((candidate?: any) => {
    const key: any = `${candidate.artist}\n${candidate.track}\n${candidate.album}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
