const demoCovers = new Set([
  "assets/album-preview-holding-hands.jpg",
  "assets/album-preview-bad-boy.jpg",
  "assets/album-preview-yeh-hui-mei.jpg",
  "assets/album-preview-common-jasmin-orange.jpg",
  "assets/album-preview-capricorn.jpg",
  "assets/album-preview-novembers-chopin.jpg",
]);

/** Apple catalogue artwork and explicitly bundled offline demo covers only. */
export function safeAlbumArtworkUrl(value: unknown): string | null {
  if (typeof value === "string" && demoCovers.has(value)) return value;
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const url = new URL(
      value.replaceAll("{w}", "600").replaceAll("{h}", "600"),
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(
        url.hostname === "mzstatic.com" ||
        url.hostname.endsWith(".mzstatic.com")
      ) ||
      /[{}]/.test(url.href)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
