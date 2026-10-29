// General matching behavior preserved from aScrobble 0.3.49.
import {
  LASTFM_PLACEHOLDER_IMAGE_HASH,
  APPLE_NATIVE_REGION_BY_ISRC,
  TRADITIONAL_CHINESE_SIGNAL,
} from "./constants";
export function normalizeAlbumName(rawAlbum?: string | null): string {
  if (!rawAlbum) return "";
  return rawAlbum.replace(/ - (EP|Single)$/i, "").trim();
}
export function normalizeCatalogText(value?: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}
export function isVariousArtistsName(value?: any): any {
  const normalized: any = normalizeCatalogText(value);
  return (
    normalized === "variousartists" ||
    normalized === "variousartist" ||
    normalized === "群星"
  );
}
export function normalizeAlbumArtistForLastFm(value?: any): any {
  return isVariousArtistsName(value) ? "Various Artists" : value;
}
export function stripVersionQualifiers(value?: string | null): string {
  return (value ?? "")
    .replace(
      /[\(\[（【][^\)\]）】]*(?:live|remaster(?:ed)?|version|edit|mix|acoustic|instrumental|现场|現場|演唱会|演唱會)[^\)\]）】]*[\)\]）】]/giu,
      " ",
    )
    .replace(
      /(?:\s*[-–—]\s*)?(?:live|remaster(?:ed)?|acoustic|instrumental|现场版|現場版)$/giu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}
export function stripRedundantLiveAlbumSuffix(value?: string | null): string {
  return (value ?? "")
    .replace(/\s*[\(\[（【]\s*live\s*[\)\]）】]\s*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function catalogTitleMatchScore(
  sourceTitle?: string | null,
  candidateTitle?: string | null,
): number {
  const source: any = normalizeCatalogText(stripVersionQualifiers(sourceTitle));
  const candidate: any = normalizeCatalogText(
    stripVersionQualifiers(candidateTitle),
  );
  if (!source || !candidate) return 0;
  if (source === candidate) return 100;
  if (source.includes(candidate) || candidate.includes(source)) return 92;
  const sourceCjk: any = [...source]
    .filter((char?: any) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        char,
      ),
    )
    .join("");
  const candidateCjk: any = [...candidate]
    .filter((char?: any) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        char,
      ),
    )
    .join("");
  if (sourceCjk.length >= 3 && candidateCjk.length >= 3) {
    if (sourceCjk === candidateCjk) return 96;
    if (sourceCjk.includes(candidateCjk) || candidateCjk.includes(sourceCjk))
      return 90;
  }
  const sourceTokens: any = new Set(
    stripVersionQualifiers(sourceTitle)
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const candidateTokens: any = new Set(
    stripVersionQualifiers(candidateTitle)
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  if (sourceTokens.size === 0 || candidateTokens.size === 0) return 0;
  const common: any = [...sourceTokens].filter((token?: any) =>
    candidateTokens.has(token),
  ).length;
  return Math.round(
    (80 * common) / Math.max(sourceTokens.size, candidateTokens.size),
  );
}
export function metadataIndicatesLive(...values: any[]): any {
  return values.some((value?: any) =>
    /(?:\blive\b|现场|現場|演唱会|演唱會)/iu.test(value ?? ""),
  );
}
export function versionAttributes(...values: any[]): any {
  const text: any = values.filter(Boolean).join(" ");
  return {
    live: metadataIndicatesLive(text),
    remaster: /(?:remaster(?:ed)?|重制|重製)/iu.test(text),
    acoustic: /(?:acoustic|不插电|不插電)/iu.test(text),
    instrumental: /(?:instrumental|伴奏|純音樂|纯音乐)/iu.test(text),
    remix: /(?:remix|混音)/iu.test(text),
  };
}
export function versionAttributesMatch(
  leftValues?: any,
  rightValues?: any,
): any {
  const left: any = versionAttributes(...leftValues);
  const right: any = versionAttributes(...rightValues);
  return Object.keys(left).every((key?: any) => left[key] === right[key]);
}
export function musicBrainzEscape(value?: string | null): string {
  return (value ?? "").replace(/([\\"])/g, "\\$1");
}
export function lastFmAlbumHasRealArtwork(album?: any): any {
  const images: any = album?.image ?? [];
  return images.some((entry?: any) => {
    const url: any = entry?.["#text"] ?? "";
    return url.length > 0 && !url.includes(LASTFM_PLACEHOLDER_IMAGE_HASH);
  });
}
export function preferredAppleRegionForIsrc(isrc?: any): any {
  const territory: any = (isrc ?? "").slice(0, 2).toUpperCase();
  const region: any = APPLE_NATIVE_REGION_BY_ISRC[territory];
  return region ? { storefront: region[0], locale: region[1] } : null;
}
export function preferredLocaleForIsrc(isrc?: any): any {
  return preferredAppleRegionForIsrc(isrc)?.locale ?? null;
}
export function metadataSuggestsTraditionalChinese(track?: any): any {
  return TRADITIONAL_CHINESE_SIGNAL.test(
    [
      track?.artist,
      track?.album_artist,
      track?.name,
      track?.album,
      track?._apple_raw_album,
    ]
      .filter(Boolean)
      .join(" "),
  );
}
export function supplementalAppleNativeRegions(
  track?: any,
  preferredRegion?: any,
): any {
  if (!metadataSuggestsTraditionalChinese(track)) return [];
  if (["tw", "hk", "mo"].includes(preferredRegion?.storefront)) return [];
  return [{ storefront: "tw", locale: "zh-Hant-TW" }];
}
export function defaultLocaleForStorefront(storefront?: any): any {
  const match: any = Object.values(APPLE_NATIVE_REGION_BY_ISRC).find(
    ([candidate]: any) => candidate === storefront,
  );
  if (match) return match[1];
  return "en-US";
}
export function shouldDeferIdentityNormalizationFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === "musicbrainz_identity_transient_failure"
  );
}
