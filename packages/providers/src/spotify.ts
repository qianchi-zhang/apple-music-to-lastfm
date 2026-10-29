// General matching behavior preserved from aScrobble 0.3.49.
import {
  preferredLocaleForIsrc,
  versionAttributesMatch,
} from "../../core/src/text";
import { bestCatalogTitleScore } from "../../core/src/musicbrainz-evidence";
import type { ProviderContext } from "./runtime";
export function createSpotify(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;

  async function getSpotifyClientToken(env?: any): Promise<any> {
    if (!env?.SPOTIFY_CLIENT_ID || !env?.SPOTIFY_CLIENT_SECRET) return null;
    if (
      ctx.state.SPOTIFY_TOKEN_CACHE?.token &&
      ctx.state.SPOTIFY_TOKEN_CACHE.expires_at_ms > Date.now() + 6e4
    )
      return ctx.state.SPOTIFY_TOKEN_CACHE.token;
    const response: any = await fetch(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(8e3),
      },
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    if (!data.access_token) return null;
    ctx.state.SPOTIFY_TOKEN_CACHE = {
      token: data.access_token,
      expires_at_ms: Date.now() + Number(data.expires_in ?? 3600) * 1e3,
    };
    return data.access_token;
  }
  async function getConditionalSpotifyEvidence(
    track?: any,
    appleTracks?: any,
    identity?: any,
    env?: any,
  ): Promise<any> {
    if (!track.isrc || !env?.SPOTIFY_CLIENT_ID || !env?.SPOTIFY_CLIENT_SECRET)
      return null;
    if (
      appleTracks.length > 1 &&
      identity?.recording_mbid &&
      identity?.release_mbid
    )
      return null;
    const token: any = await getSpotifyClientToken(env);
    if (!token) return null;
    const preferredLocale: any = preferredLocaleForIsrc(track.isrc);
    const market: any =
      preferredLocale === "zh-Hant-TW"
        ? "TW"
        : preferredLocale === "ja-JP"
          ? "JP"
          : "US";
    const url: any = new URL("https://api.spotify.com/v1/search");
    url.search = new URLSearchParams({
      q: `isrc:${track.isrc}`,
      type: "track",
      market,
      limit: "10",
    }).toString();
    const response: any = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8e3),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const source: any =
      appleTracks.find((item?: any) => item._is_source_storefront) ??
      appleTracks[0] ??
      track;
    const candidates: any = (data.tracks?.items ?? [])
      .filter((item?: any) => item.external_ids?.isrc === track.isrc)
      .filter(
        (item?: any) =>
          Math.abs(
            Number(item.duration_ms ?? 0) - Number(source.duration_ms ?? 0),
          ) <= 5e3,
      )
      .filter((item?: any) =>
        versionAttributesMatch(
          [source.name, source.album],
          [item.name, item.album?.name],
        ),
      )
      .filter(
        (item?: any) =>
          item.album?.album_type !== "compilation" ||
          source._apple_is_compilation,
      )
      .map((item?: any) => {
        const albumScore: any = bestCatalogTitleScore(
          appleTracks.map((candidate?: any) => candidate.album),
          item.album?.name,
        );
        const releaseDateMatch: any = Boolean(
          source._apple_release_date &&
          item.album?.release_date &&
          (source._apple_release_date === item.album.release_date ||
            source._apple_release_date.slice(0, 4) ===
              item.album.release_date.slice(0, 4)),
        );
        const trackCountMatch: any = Boolean(
          source._apple_album_track_count &&
          Number(item.album?.total_tracks) ===
            Number(source._apple_album_track_count),
        );
        const trackNumberMatch: any = Boolean(
          source._apple_track_number &&
          Number(item.track_number) === Number(source._apple_track_number),
        );
        const verified: any =
          albumScore >= 90 ||
          (releaseDateMatch && trackCountMatch && trackNumberMatch);
        return {
          item,
          albumScore,
          verified,
          score:
            albumScore * 4 +
            Number(releaseDateMatch) * 120 +
            Number(trackCountMatch) * 100 +
            Number(trackNumberMatch) * 80,
        };
      })
      .filter((candidate?: any) => candidate.verified)
      .sort((a?: any, b?: any) => b.score - a.score);
    const best: any = candidates[0]?.item;
    if (!best) return null;
    return {
      artist: best.artists?.[0]?.name ?? source.artist,
      track: best.name,
      album: best.album?.name ?? source.album,
      duration_ms: best.duration_ms,
      track_number: best.track_number,
      release_date: best.album?.release_date,
      source: "spotify_verified",
    };
  }
  return { getSpotifyClientToken, getConditionalSpotifyEvidence };
}
