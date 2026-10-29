export const brandIconFiles = [16, 32, 48, 64, 128].map(
  (size) => `assets/brand-icon-${size}.png`,
);
export const extensionAppSource = "emil.html";
export const extensionAppEntrySource = "src/emil-app.ts";
export const themeStyleFiles = ["emil.css"];
export const themeAssetFiles: string[] = [
  "assets/service-apple-music.svg",
  "assets/service-cloudflare.svg",
  "assets/service-lastfm.png",
  "assets/album-preview-holding-hands.jpg",
  "assets/album-preview-bad-boy.jpg",
  "assets/album-preview-yeh-hui-mei.jpg",
  "assets/album-preview-common-jasmin-orange.jpg",
  "assets/album-preview-capricorn.jpg",
  "assets/album-preview-novembers-chopin.jpg",
];
export const extensionIcons = [
  "clock",
  "arrow-clockwise",
  "link",
  "gear",
  "cloud",
  "arrow-up-right",
  "check",
  "info",
  "music-note",
  "music-notes",
  "copy",
  "pause",
];
export const extensionAssetFiles = [
  ...extensionIcons.map((name) => "icons/" + name + ".svg"),
  ...brandIconFiles,
  ...themeStyleFiles,
  ...themeAssetFiles,
  "Phosphor-LICENSE.txt",
];
