// General matching behavior preserved from aScrobble 0.3.49.
import {
  APPLE_TOKEN_REFRESH_AHEAD_MS,
  SPOOFED_HEADERS,
  KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED,
  APPLE_TOKEN_REFRESH_CHECK_COOLDOWN_MS,
  KV_KEY_APPLE_DEV_TOKEN,
  API_BASE,
  MAX_OFFSET,
  PAGE_SIZE,
  RECENT_TRACK_TYPES,
  TokenExpiredError,
  APPLE_STOREFRONT_CACHE_MS,
  APPLE_STOREFRONT_CACHE_KEY,
} from "../../core/src/constants";
import {
  normalizeAlbumName,
  defaultLocaleForStorefront,
  metadataIndicatesLive,
  preferredAppleRegionForIsrc,
  supplementalAppleNativeRegions,
} from "../../core/src/text";
import {
  appleCatalogItemToTrack,
  appleReleaseEquivalenceEvidence,
  appleAlbumIsrcSignaturesMatch,
} from "../../core/src/apple-evidence";
import type { ProviderContext } from "./runtime";
export function createApple(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;

  function decodeJwtJson(token?: any, partIndex?: any): any {
    try {
      let encoded: any =
        token.split(".")[partIndex]?.replace(/-/g, "+").replace(/_/g, "/") ??
        "";
      while (encoded.length % 4) encoded += "=";
      return JSON.parse(atob(encoded));
    } catch {
      return null;
    }
  }
  function appleDeveloperTokenNeedsRefresh(
    token?: any,
    now: any = Date.now(),
  ): any {
    const payload: any = decodeJwtJson(token, 1);
    return (
      !payload?.exp || payload.exp * 1e3 - now <= APPLE_TOKEN_REFRESH_AHEAD_MS
    );
  }
  async function fetchAppleWebDeveloperToken(): Promise<any> {
    const homeResponse: any = await fetch("https://music.apple.com/", {
      headers: {
        ...SPOOFED_HEADERS,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!homeResponse.ok)
      throw new Error(`apple_music_home_http_${homeResponse.status}`);
    const html: any = await homeResponse.text();
    const scriptMatches: any = [
      ...html.matchAll(
        /src=["']([^"']*\/assets\/index~[^"']+\.js[^"']*)["']/gi,
      ),
    ];
    if (scriptMatches.length === 0)
      throw new Error("apple_music_index_script_not_found");
    const scriptUrl: any = new URL(
      scriptMatches[0][1],
      "https://music.apple.com/",
    ).toString();
    const scriptResponse: any = await fetch(scriptUrl, {
      headers: {
        ...SPOOFED_HEADERS,
        Accept: "application/javascript,*/*;q=0.8",
      },
    });
    if (!scriptResponse.ok)
      throw new Error(`apple_music_index_http_${scriptResponse.status}`);
    const script: any = await scriptResponse.text();
    const candidates: any =
      script.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
    let bestToken: any = null;
    let bestExpiry: any = 0;
    for (const candidate of new Set(candidates)) {
      const header: any = decodeJwtJson(candidate, 0);
      const payload: any = decodeJwtJson(candidate, 1);
      if (header?.kid !== "WebPlayKid" || payload?.iss !== "AMPWebPlay")
        continue;
      const expiry: any = Number(payload.exp ?? 0);
      if (expiry > bestExpiry) {
        bestToken = candidate;
        bestExpiry = expiry;
      }
    }
    if (!bestToken || bestExpiry * 1e3 <= Date.now()) {
      throw new Error("valid_apple_web_developer_token_not_found");
    }
    return bestToken;
  }
  async function refreshAppleDeveloperToken(
    env?: any,
    currentToken?: any,
    force: any = false,
  ): Promise<any> {
    const now: any = Date.now();
    if (!force && !appleDeveloperTokenNeedsRefresh(currentToken, now))
      return currentToken;
    const lastCheckedIso: any = await env.ASCROBBLE_STATE.get(
      KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED,
    );
    const lastChecked: any = lastCheckedIso
      ? new Date(lastCheckedIso).getTime()
      : 0;
    if (
      !force &&
      lastChecked &&
      now - lastChecked < APPLE_TOKEN_REFRESH_CHECK_COOLDOWN_MS
    ) {
      return currentToken;
    }
    const freshToken: any = await fetchAppleWebDeveloperToken();
    await env.ASCROBBLE_STATE.put(
      KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED,
      new Date(now).toISOString(),
    );
    const currentExpiry: any = Number(decodeJwtJson(currentToken, 1)?.exp ?? 0);
    const freshExpiry: any = Number(decodeJwtJson(freshToken, 1)?.exp ?? 0);
    if (freshExpiry > currentExpiry || currentExpiry * 1e3 <= now) {
      await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_DEV_TOKEN, freshToken);
      return freshToken;
    }
    return currentToken;
  }
  async function fetchTrackPlayCount(
    devToken?: any,
    musicUserToken?: any,
    isrc?: any,
  ): Promise<any> {
    const url: any = `${API_BASE}/me/library/songs?filter[isrc]=${encodeURIComponent(isrc)}&fields[library-songs]=playCount&limit=1`;
    const headers: any = {
      Authorization: `Bearer ${devToken}`,
      "Music-User-Token": musicUserToken,
      ...SPOOFED_HEADERS,
    };
    try {
      const response: any = await fetch(url, { headers });
      if (!response.ok) return null;
      const json2: any = await response.json();
      const count: any = json2.data?.[0]?.attributes?.playCount;
      return typeof count === "number" ? count : null;
    } catch {
      return null;
    }
  }
  async function fetchRecentlyPlayed(
    devToken?: any,
    musicUserToken?: any,
  ): Promise<any> {
    const tracks: any = [];
    const headers: any = {
      Authorization: `Bearer ${devToken}`,
      "Music-User-Token": musicUserToken,
      ...SPOOFED_HEADERS,
    };
    for (let offset: any = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
      const url: any = `${API_BASE}/me/recent/played/tracks?limit=${PAGE_SIZE}&offset=${offset}&types=${encodeURIComponent(RECENT_TRACK_TYPES)}`;
      let response: any;
      try {
        response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(30000),
        });
      } catch (e: any) {
        throw new Error(`apple_history_incomplete_at_${offset}`);
      }
      if (response.status === 401) throw new TokenExpiredError();
      if (!response.ok) {
        const body: any = await response.text();
        console.warn(
          `Apple API ${response.status} at offset ${offset}: ${body.slice(0, 200)}`,
        );
        throw new Error(`apple_history_http_${response.status}_at_${offset}`);
      }
      const json2: any = await response.json();
      if (!Array.isArray(json2.data))
        throw new Error("apple_history_invalid_response");
      const items: any = json2.data;
      if (items.length === 0) break;
      for (const item of items) {
        if (!item.id) continue;
        const attrs: any = item.attributes ?? {};
        const rawAlbum: any = attrs.albumName ?? "";
        tracks.push({
          id: item.id,
          type: item.type,
          name: attrs.name ?? "",
          artist: attrs.artistName ?? "",
          album_artist: attrs.albumArtistName ?? attrs.artistName ?? "",
          album: normalizeAlbumName(rawAlbum),
          _apple_raw_album: rawAlbum,
          duration_ms: attrs.durationInMillis ?? 18e4,
          isrc: attrs.isrc,
          catalog_id:
            item.type === "songs"
              ? item.id
              : (attrs.playParams?.catalogId ?? null),
        });
      }
      if (items.length < PAGE_SIZE) break;
    }
    const deduped: any = [];
    for (let i: any = 0; i < tracks.length; i++) {
      if (i > 0 && i % PAGE_SIZE === 0 && tracks[i - 1].id === tracks[i].id) {
        continue;
      }
      deduped.push(tracks[i]);
    }
    return deduped;
  }
  async function getAppleUserStorefront(
    devToken?: any,
    musicUserToken?: any,
    kv?: any,
  ): Promise<any> {
    const now: any = Date.now();
    if (
      ctx.state.MEMORY_APPLE_STOREFRONT?.id &&
      now - ctx.state.MEMORY_APPLE_STOREFRONT.checked_at_ms <
        APPLE_STOREFRONT_CACHE_MS
    ) {
      return ctx.state.MEMORY_APPLE_STOREFRONT;
    }
    if (kv) {
      const cached: any = await kv
        .get(APPLE_STOREFRONT_CACHE_KEY, "json")
        .catch(() => null);
      const checkedAt: any = cached?.checked_at_iso
        ? new Date(cached.checked_at_iso).getTime()
        : 0;
      if (
        cached?.id &&
        checkedAt &&
        now - checkedAt < APPLE_STOREFRONT_CACHE_MS
      ) {
        ctx.state.MEMORY_APPLE_STOREFRONT = {
          ...cached,
          checked_at_ms: checkedAt,
        };
        return ctx.state.MEMORY_APPLE_STOREFRONT;
      }
    }
    const response: any = await fetch(`${API_BASE}/me/storefront`, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS,
      },
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok)
      throw new Error(`apple_storefront_http_${response.status}`);
    const data: any = await response.json();
    const storefront: any = data.data?.[0];
    if (!storefront?.id) throw new Error("apple_storefront_missing");
    const record: any = {
      id: storefront.id,
      locale:
        storefront.attributes?.defaultLanguageTag ??
        defaultLocaleForStorefront(storefront.id),
      checked_at_iso: new Date(now).toISOString(),
      checked_at_ms: now,
    };
    ctx.state.MEMORY_APPLE_STOREFRONT = record;
    if (kv) {
      const persisted: any = {
        id: record.id,
        locale: record.locale,
        checked_at_iso: record.checked_at_iso,
      };
      await kv
        .put(APPLE_STOREFRONT_CACHE_KEY, JSON.stringify(persisted))
        .catch(() => void 0);
    }
    return record;
  }
  async function getAppleAlbumIsrcSignature(
    track?: any,
    devToken?: any,
    musicUserToken?: any,
    cache?: any,
  ): Promise<any> {
    const albumId: any = track?._apple_album_id;
    const storefront: any = track?._apple_storefront;
    const expectedCount: any = Number(track?._apple_album_track_count ?? 0);
    if (!albumId || !storefront || expectedCount <= 1 || expectedCount > 100)
      return null;
    const cacheKey: any = `${storefront}:${albumId}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const request: any = (async () => {
      const url: any = `${API_BASE}/catalog/${encodeURIComponent(storefront)}/albums/${encodeURIComponent(albumId)}/tracks?limit=100`;
      const response: any = await fetch(url, {
        headers: {
          Authorization: `Bearer ${devToken}`,
          "Music-User-Token": musicUserToken,
          ...SPOOFED_HEADERS,
        },
        signal: AbortSignal.timeout(8e3),
      });
      if (!response.ok) return null;
      const data: any = await response.json();
      if (
        data.next ||
        !Array.isArray(data.data) ||
        data.data.length !== expectedCount
      )
        return null;
      const isrcs: any = data.data
        .map((item?: any) => item?.attributes?.isrc)
        .filter(Boolean);
      return isrcs.length === expectedCount ? isrcs : null;
    })().catch(() => null);
    cache.set(cacheKey, request);
    return request;
  }
  async function chooseAppleCatalogItem(
    items?: any,
    track?: any,
    sourceTrack?: any,
    devToken?: any,
    musicUserToken?: any,
  ): Promise<any> {
    const albumSignatureCache: any = new Map();
    const evaluated: any = items
      .map((item?: any) =>
        appleCatalogItemToTrack(item, track, item._storefront),
      )
      .filter(Boolean)
      .map((candidate?: any) => {
        const evidence: any = appleReleaseEquivalenceEvidence(
          sourceTrack,
          candidate,
        );
        return { candidate, evidence };
      });
    const candidates: any = [];
    for (const { candidate, evidence } of evaluated) {
      if (evidence.matches) {
        candidates.push({
          ...candidate,
          _apple_release_equivalence_requires_musicbrainz:
            evidence.requires_musicbrainz,
          ...(evidence.exact_apple_catalog_release
            ? {
                _apple_release_equivalence_method:
                  "exact_apple_catalog_release",
              }
            : {}),
        });
        continue;
      }
      if (!evidence.requires_album_isrc_set || !sourceTrack) continue;
      const [sourceSignature, candidateSignature]: any = await Promise.all([
        getAppleAlbumIsrcSignature(
          sourceTrack,
          devToken,
          musicUserToken,
          albumSignatureCache,
        ),
        getAppleAlbumIsrcSignature(
          candidate,
          devToken,
          musicUserToken,
          albumSignatureCache,
        ),
      ]);
      const expectedCount: any = Number(
        sourceTrack._apple_album_track_count ?? 0,
      );
      if (
        !appleAlbumIsrcSignaturesMatch(
          sourceSignature,
          candidateSignature,
          expectedCount,
        )
      )
        continue;
      candidates.push({
        ...candidate,
        _apple_release_equivalence_requires_musicbrainz: false,
        _apple_release_equivalence_method: "exact_album_isrc_set",
      });
    }
    candidates.sort((a?: any, b?: any) => {
      const score: any = (candidate?: any) => {
        const durationDiff: any = Math.abs(
          Number(track.duration_ms ?? 0) - Number(candidate.duration_ms ?? 0),
        );
        let value: any =
          candidate.isrc && candidate.isrc === track.isrc ? 1e3 : 0;
        if (durationDiff <= 1500) value += 300;
        else if (durationDiff <= 3e3) value += 150;
        if (
          metadataIndicatesLive(track.name, track.album) ===
          metadataIndicatesLive(candidate.name, candidate.album)
        )
          value += 200;
        if (
          sourceTrack?._apple_release_date &&
          candidate._apple_release_date === sourceTrack._apple_release_date
        )
          value += 150;
        if (
          sourceTrack?._apple_album_track_count &&
          candidate._apple_album_track_count ===
            sourceTrack._apple_album_track_count
        )
          value += 150;
        return value;
      };
      return score(b) - score(a);
    });
    return candidates[0] ?? null;
  }
  async function getAppleCatalogTrackForLastFm(
    track?: any,
    devToken?: any,
    musicUserToken?: any,
    locale: any = "en-US",
    storefront: any = "us",
    useLibraryEndpoint: any = false,
    sourceTrack: any = null,
  ): Promise<any> {
    if (!track.id || (track.type !== "library-songs" && track.type !== "songs"))
      return null;
    const catalogId: any =
      track.catalog_id ?? (track.type === "songs" ? track.id : null);
    const directUrl: any =
      useLibraryEndpoint && track.type === "library-songs"
        ? `${API_BASE}/me/library/songs/${encodeURIComponent(track.id)}/catalog?include=albums&l=${encodeURIComponent(locale)}`
        : `${API_BASE}/catalog/${storefront}/songs/${encodeURIComponent(catalogId ?? track.id)}?include=albums&l=${encodeURIComponent(locale)}`;
    let lookupMethod: any = "catalog_id";
    let response: any = await fetch(directUrl, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS,
      },
      signal: AbortSignal.timeout(8e3),
    });
    let data: any = response.ok ? await response.json() : null;
    let items: any = data?.data ?? [];
    if (items.length === 0 && useLibraryEndpoint && catalogId) {
      const catalogUrl: any = `${API_BASE}/catalog/${storefront}/songs/${encodeURIComponent(catalogId)}?include=albums&l=${encodeURIComponent(locale)}`;
      response = await fetch(catalogUrl, {
        headers: {
          Authorization: `Bearer ${devToken}`,
          "Music-User-Token": musicUserToken,
          ...SPOOFED_HEADERS,
        },
        signal: AbortSignal.timeout(8e3),
      });
      data = response.ok ? await response.json() : null;
      items = data?.data ?? [];
    }
    if (items.length === 0 && track.isrc && !useLibraryEndpoint) {
      const isrcUrl: any = `${API_BASE}/catalog/${storefront}/songs?filter[isrc]=${encodeURIComponent(track.isrc)}&include=albums&l=${encodeURIComponent(locale)}`;
      response = await fetch(isrcUrl, {
        headers: {
          Authorization: `Bearer ${devToken}`,
          "Music-User-Token": musicUserToken,
          ...SPOOFED_HEADERS,
        },
        signal: AbortSignal.timeout(8e3),
      });
      data = response.ok ? await response.json() : null;
      items = data?.data ?? [];
      if (items.length > 0) lookupMethod = "isrc";
    }
    if (
      items.length === 0 &&
      track.isrc &&
      !useLibraryEndpoint &&
      sourceTrack?.name &&
      sourceTrack?.artist
    ) {
      const searchTerm: any = `${sourceTrack.name} ${sourceTrack.artist}`;
      const searchUrl: any = `${API_BASE}/catalog/${storefront}/search?term=${encodeURIComponent(searchTerm)}&types=songs&limit=10&include=albums&l=${encodeURIComponent(locale)}`;
      response = await fetch(searchUrl, {
        headers: {
          Authorization: `Bearer ${devToken}`,
          "Music-User-Token": musicUserToken,
          ...SPOOFED_HEADERS,
        },
        signal: AbortSignal.timeout(8e3),
      });
      data = response.ok ? await response.json() : null;
      items = data?.results?.songs?.data ?? [];
      if (items.length > 0) {
        items = (
          await Promise.all(
            items.slice(0, 5).map(async (item?: any) => {
              const album: any = item?.relationships?.albums?.data?.[0];
              if (
                album?.attributes?.releaseDate &&
                album?.attributes?.trackCount
              )
                return item;
              const itemUrl: any = `${API_BASE}/catalog/${storefront}/songs/${encodeURIComponent(item.id)}?include=albums&l=${encodeURIComponent(locale)}`;
              const itemResponse: any = await fetch(itemUrl, {
                headers: {
                  Authorization: `Bearer ${devToken}`,
                  "Music-User-Token": musicUserToken,
                  ...SPOOFED_HEADERS,
                },
                signal: AbortSignal.timeout(8e3),
              });
              if (!itemResponse.ok) return null;
              const itemData: any = await itemResponse.json();
              return itemData?.data?.[0] ?? null;
            }),
          )
        ).filter(Boolean);
      }
      if (items.length > 0) lookupMethod = "native_catalog_search";
    }
    const taggedItems: any = items.map((item?: any) => ({
      ...item,
      _storefront: storefront,
      _apple_lookup_method: lookupMethod,
    }));
    return chooseAppleCatalogItem(
      taggedItems,
      track,
      sourceTrack,
      devToken,
      musicUserToken,
    );
  }
  async function getAppleCatalogVariants(
    track?: any,
    devToken?: any,
    musicUserToken?: any,
    kv?: any,
  ): Promise<any> {
    if (track.type !== "library-songs" && track.type !== "songs") return [];
    const storefront: any = await getAppleUserStorefront(
      devToken,
      musicUserToken,
      kv,
    );
    const sourceTrack: any = await getAppleCatalogTrackForLastFm(
      track,
      devToken,
      musicUserToken,
      storefront.locale ?? defaultLocaleForStorefront(storefront.id),
      storefront.id,
      track.type === "library-songs",
    ).catch(() => null);
    const lookupTrack: any = sourceTrack
      ? { ...track, isrc: sourceTrack.isrc ?? track.isrc }
      : track;
    const preferredRegion: any = preferredAppleRegionForIsrc(lookupTrack.isrc);
    const preferredLocale: any = preferredRegion?.locale ?? null;
    const preferredStorefront: any = preferredRegion?.storefront ?? null;
    const supplementalNativeRegions: any = supplementalAppleNativeRegions(
      sourceTrack ?? lookupTrack,
      preferredRegion,
    );
    const specs: any = [
      {
        storefront: storefront.id,
        locale: storefront.locale ?? defaultLocaleForStorefront(storefront.id),
        isSource: true,
      },
      ...(preferredStorefront
        ? [
            {
              storefront: preferredStorefront,
              locale: preferredLocale,
              isSource: false,
            },
          ]
        : []),
      ...supplementalNativeRegions.map((region?: any) => ({
        ...region,
        isSource: false,
      })),
    ];
    const seenSpecs: any = new Set();
    const uniqueSpecs: any = specs.filter((spec?: any) => {
      const key: any = `${spec.storefront}\n${spec.locale}`;
      if (seenSpecs.has(key)) return false;
      seenSpecs.add(key);
      return true;
    });
    const crossStorefront: any = await Promise.all(
      uniqueSpecs.map(async (spec?: any) => ({
        source: spec.locale,
        isSource: spec.isSource,
        value:
          spec.storefront === storefront.id && sourceTrack
            ? sourceTrack
            : await getAppleCatalogTrackForLastFm(
                {
                  ...lookupTrack,
                  id:
                    sourceTrack?.catalog_id ??
                    lookupTrack.catalog_id ??
                    lookupTrack.id,
                  catalog_id: sourceTrack?.catalog_id ?? lookupTrack.catalog_id,
                  type: "songs",
                },
                devToken,
                musicUserToken,
                spec.locale,
                spec.storefront,
                false,
                sourceTrack,
              ).catch(() => null),
      })),
    );
    return crossStorefront
      .filter((entry?: any) => entry.value)
      .map((entry?: any) => ({
        ...entry.value,
        _metadata_source: entry.source,
        _is_source_storefront: entry.isSource,
      }));
  }
  return {
    decodeJwtJson,
    appleDeveloperTokenNeedsRefresh,
    fetchAppleWebDeveloperToken,
    refreshAppleDeveloperToken,
    fetchTrackPlayCount,
    fetchRecentlyPlayed,
    getAppleUserStorefront,
    getAppleAlbumIsrcSignature,
    chooseAppleCatalogItem,
    getAppleCatalogTrackForLastFm,
    getAppleCatalogVariants,
  };
}
