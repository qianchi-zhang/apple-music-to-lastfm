// General matching behavior preserved from aScrobble 0.3.49.
import {
  normalizeAlbumName,
  catalogTitleMatchScore,
  versionAttributesMatch,
  preferredLocaleForIsrc,
  metadataSuggestsTraditionalChinese,
} from "./text";
import { bestCatalogTitleScore } from "./musicbrainz-evidence";
export function appleCatalogItemToTrack(
  item?: any,
  track?: any,
  storefront?: any,
): any {
  if (!item?.attributes) return null;
  const attrs: any = item.attributes;
  const album: any = item.relationships?.albums?.data?.[0];
  const rawAlbum: any =
    attrs.albumName ?? track._apple_raw_album ?? track.album;
  return {
    ...track,
    name: attrs.name ?? track.name,
    artist: attrs.artistName ?? track.artist,
    album_artist:
      album?.attributes?.artistName ??
      attrs.albumArtistName ??
      attrs.artistName ??
      track.album_artist,
    album: normalizeAlbumName(rawAlbum),
    _apple_raw_album: rawAlbum,
    duration_ms: attrs.durationInMillis ?? track.duration_ms,
    isrc: attrs.isrc ?? track.isrc,
    catalog_id: item.id,
    _apple_lookup_method: item._apple_lookup_method ?? "catalog_id_or_isrc",
    _apple_storefront: storefront,
    _apple_album_id: album?.id,
    _apple_album_upc: album?.attributes?.upc,
    _apple_release_date: album?.attributes?.releaseDate,
    _apple_album_track_count: album?.attributes?.trackCount,
    _apple_track_number: attrs.trackNumber,
    _apple_disc_number: attrs.discNumber,
    _apple_is_compilation:
      attrs.isCompilation === true || album?.attributes?.isCompilation === true,
  };
}
export function appleReleaseDateReasonablyClose(left?: any, right?: any): any {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorterLength: any = Math.min(left.length, right.length);
  if (shorterLength === 4 || shorterLength === 7)
    return left.slice(0, shorterLength) === right.slice(0, shorterLength);
  const leftTime: any = new Date(`${left}T00:00:00Z`).getTime();
  const rightTime: any = new Date(`${right}T00:00:00Z`).getTime();
  return (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    Math.abs(leftTime - rightTime) <= 45 * 24 * 60 * 60 * 1e3
  );
}
export function appleReleaseEquivalenceEvidence(
  source?: any,
  candidate?: any,
): any {
  if (!source || !candidate)
    return { matches: true, requires_musicbrainz: false };
  const durationDiff: any = Math.abs(
    Number(source.duration_ms ?? 0) - Number(candidate.duration_ms ?? 0),
  );
  const sourceTrackCount: any = Number(source._apple_album_track_count ?? 0);
  const candidateTrackCount: any = Number(
    candidate._apple_album_track_count ?? 0,
  );
  const sourceTrackNumber: any = Number(source._apple_track_number ?? 0);
  const candidateTrackNumber: any = Number(candidate._apple_track_number ?? 0);
  const exactReleaseDate: any = Boolean(
    source._apple_release_date &&
    candidate._apple_release_date &&
    source._apple_release_date === candidate._apple_release_date,
  );
  const exactTrackShape: any = Boolean(
    sourceTrackCount > 0 &&
    candidateTrackCount === sourceTrackCount &&
    sourceTrackNumber > 0 &&
    candidateTrackNumber === sourceTrackNumber,
  );
  const exactAppleCatalogRelease: any = Boolean(
    source.catalog_id &&
    candidate.catalog_id &&
    String(source.catalog_id) === String(candidate.catalog_id) &&
    source._apple_album_id &&
    candidate._apple_album_id &&
    String(source._apple_album_id) === String(candidate._apple_album_id) &&
    source._apple_album_upc &&
    candidate._apple_album_upc &&
    String(source._apple_album_upc) === String(candidate._apple_album_upc) &&
    source._apple_release_date &&
    candidate._apple_release_date &&
    source._apple_release_date === candidate._apple_release_date &&
    sourceTrackCount > 0 &&
    candidateTrackCount === sourceTrackCount &&
    sourceTrackNumber > 0 &&
    candidateTrackNumber === sourceTrackNumber,
  );
  const nativeSearchEquivalentRecording: any = Boolean(
    source.isrc &&
    candidate.isrc &&
    source.isrc !== candidate.isrc &&
    candidate._apple_lookup_method === "native_catalog_search" &&
    durationDiff <= 1500 &&
    exactReleaseDate &&
    exactTrackShape &&
    !source._apple_is_compilation &&
    !candidate._apple_is_compilation &&
    catalogTitleMatchScore(source.name, candidate.name) >= 90 &&
    catalogTitleMatchScore(source.album, candidate.album) >= 90,
  );
  if (
    source.isrc &&
    candidate.isrc &&
    source.isrc !== candidate.isrc &&
    !nativeSearchEquivalentRecording
  )
    return { matches: false, requires_musicbrainz: false };
  if (durationDiff > 5e3)
    return { matches: false, requires_musicbrainz: false };
  if (
    !exactAppleCatalogRelease &&
    !versionAttributesMatch(
      [source.name, source.album],
      [candidate.name, candidate.album],
    )
  )
    return { matches: false, requires_musicbrainz: false };
  if (
    sourceTrackCount &&
    candidateTrackCount &&
    sourceTrackCount !== candidateTrackCount
  )
    return { matches: false, requires_musicbrainz: false };
  const trackNumbersDiffer: any = Boolean(
    sourceTrackNumber &&
    candidateTrackNumber &&
    sourceTrackNumber !== candidateTrackNumber,
  );
  const datesDiffer: any = Boolean(
    source._apple_release_date &&
    candidate._apple_release_date &&
    source._apple_release_date !== candidate._apple_release_date,
  );
  if (datesDiffer) {
    const matchingTrackCount: any =
      sourceTrackCount > 0 && candidateTrackCount === sourceTrackCount;
    if (
      !matchingTrackCount ||
      !appleReleaseDateReasonablyClose(
        source._apple_release_date,
        candidate._apple_release_date,
      )
    ) {
      return { matches: false, requires_musicbrainz: false };
    }
  }
  if (trackNumbersDiffer) {
    const exactIsrcRegionalReorder: any = Boolean(
      source.isrc &&
      candidate.isrc &&
      source.isrc === candidate.isrc &&
      durationDiff <= 1500 &&
      exactReleaseDate &&
      sourceTrackCount > 0 &&
      candidateTrackCount === sourceTrackCount &&
      !source._apple_is_compilation &&
      !candidate._apple_is_compilation,
    );
    if (exactIsrcRegionalReorder) {
      return {
        matches: true,
        requires_musicbrainz: true,
        exact_apple_catalog_release: false,
        regional_track_order_variance: true,
      };
    }
    const canCompareFullAlbums: any = Boolean(
      source.isrc &&
      candidate.isrc &&
      source.isrc === candidate.isrc &&
      sourceTrackCount > 1 &&
      candidateTrackCount === sourceTrackCount &&
      source._apple_album_id &&
      candidate._apple_album_id &&
      source._apple_storefront &&
      candidate._apple_storefront,
    );
    return {
      matches: false,
      requires_musicbrainz: false,
      requires_album_isrc_set: canCompareFullAlbums,
    };
  }
  const upcsDiffer: any = Boolean(
    source._apple_album_upc &&
    candidate._apple_album_upc &&
    String(source._apple_album_upc) !== String(candidate._apple_album_upc),
  );
  const localizedAlbumTitle: any = Boolean(
    source.album &&
    candidate.album &&
    catalogTitleMatchScore(source.album, candidate.album) < 90,
  );
  return {
    matches: true,
    requires_musicbrainz:
      nativeSearchEquivalentRecording ||
      (!exactAppleCatalogRelease &&
        (datesDiffer || upcsDiffer || localizedAlbumTitle)),
    exact_apple_catalog_release: exactAppleCatalogRelease,
  };
}
export function sameAppleRelease(source?: any, candidate?: any): any {
  return appleReleaseEquivalenceEvidence(source, candidate).matches;
}
export function appleAlbumIsrcSignaturesMatch(
  left?: any,
  right?: any,
  expectedCount?: any,
): any {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    !expectedCount ||
    left.length !== expectedCount ||
    right.length !== expectedCount
  )
    return false;
  const normalize: any = (values?: any) =>
    values
      .map((value?: any) => String(value ?? "").toUpperCase())
      .filter(Boolean)
      .sort();
  const normalizedLeft: any = normalize(left);
  const normalizedRight: any = normalize(right);
  return (
    normalizedLeft.length === expectedCount &&
    normalizedRight.length === expectedCount &&
    normalizedLeft.every(
      (value?: any, index?: any) => value === normalizedRight[index],
    )
  );
}
export function choosePreferredAppleTrack(track?: any, appleTracks?: any): any {
  const preferredLocale: any = preferredLocaleForIsrc(
    track.isrc ?? appleTracks.find((item?: any) => item.isrc)?.isrc,
  );
  if (
    metadataSuggestsTraditionalChinese(
      appleTracks.find((item?: any) => item._is_source_storefront) ?? track,
    )
  ) {
    const exactTraditional: any = appleTracks.find(
      (item?: any) =>
        item._metadata_source === "zh-Hant-TW" &&
        item._apple_release_equivalence_method ===
          "exact_apple_catalog_release",
    );
    if (exactTraditional) return exactTraditional;
  }
  return (
    appleTracks.find(
      (item?: any) => item._metadata_source === preferredLocale,
    ) ??
    appleTracks.find((item?: any) => item._is_source_storefront) ??
    appleTracks[0] ??
    track
  );
}
export function filterMusicBrainzConfirmedAppleVariants(
  appleTracks?: any,
  identity?: any,
): any {
  const confirmedReleaseTitles: any = [
    identity?.album,
    identity?.release_group,
  ].filter(Boolean);
  return appleTracks.filter((candidate?: any) => {
    if (!candidate._apple_release_equivalence_requires_musicbrainz) return true;
    if (!identity?.release_group_mbid || confirmedReleaseTitles.length === 0)
      return false;
    return bestCatalogTitleScore(confirmedReleaseTitles, candidate.album) >= 90;
  });
}
