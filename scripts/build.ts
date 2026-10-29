import "./production-runtime";
import {
  extensionIcons,
  extensionAssetFiles,
  extensionAppSource,
  extensionAppEntrySource,
  brandIconFiles,
  themeStyleFiles,
  themeAssetFiles,
} from "./extension-assets";
import { zipFiles } from "./zip";
import { build } from "esbuild";
import { mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";
await build({
  entryPoints: ["apps/worker/src/production-entry.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/worker.js",
});
await rm("dist/browser-extension", { recursive: true, force: true });
await mkdir("dist/browser-extension", { recursive: true });
await build({
  entryPoints: ["apps/browser-extension/src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome103",
  outfile: "dist/browser-extension/popup.js",
});
for (const file of ["manifest.json", "popup.html", "popup.css"])
  await copyFile(
    "apps/browser-extension/" + file,
    "dist/browser-extension/" + file,
  );
for (const [entry, name] of [
  [extensionAppEntrySource, "app"],
  ["src/background.ts", "background"],
])
  await build({
    entryPoints: ["apps/browser-extension/" + entry],
    bundle: true,
    format: "iife",
    target: "chrome103",
    outfile: "dist/browser-extension/" + name + ".js",
  });
await copyFile(
  "apps/browser-extension/" + extensionAppSource,
  "dist/browser-extension/app.html",
);
for (const name of themeStyleFiles)
  await copyFile(
    "apps/browser-extension/" + name,
    "dist/browser-extension/" + name,
  );
await copyFile("dist/worker.js", "dist/browser-extension/worker.bundle.txt");
await copyFile(
  "apps/worker/production/worker-0.3.111.js",
  "dist/browser-extension/algorithm-0.3.111.txt",
);
await copyFile("LICENSE", "dist/browser-extension/LICENSE");
await copyFile(
  "apps/worker/production/OpenCC-LICENSE.txt",
  "dist/browser-extension/OpenCC-LICENSE.txt",
);
await mkdir("dist/browser-extension/icons", { recursive: true });
for (const icon of extensionIcons)
  await copyFile(
    "node_modules/@phosphor-icons/core/assets/regular/" + icon + ".svg",
    "dist/browser-extension/icons/" + icon + ".svg",
  );
await mkdir("dist/browser-extension/assets", { recursive: true });
for (const file of [...brandIconFiles, ...themeAssetFiles])
  await copyFile(
    "apps/browser-extension/" + file,
    "dist/browser-extension/" + file,
  );
await copyFile(
  "node_modules/@phosphor-icons/core/LICENSE",
  "dist/browser-extension/Phosphor-LICENSE.txt",
);
console.log("Built Worker and unpacked browser extension.");

await mkdir("dist/site", { recursive: true });
for (const file of [
  "index.html",
  "style.css",
  "guide.js",
  "wizard.js",
  "_headers",
  "release.json",
])
  await copyFile("apps/install-site/" + file, "dist/site/" + file);
await mkdir("dist/site/assets", { recursive: true });
for (const file of brandIconFiles)
  await copyFile("apps/browser-extension/" + file, "dist/site/" + file);
console.log("Built independent deployment guide in dist/site.");

await writeFile(
  "dist/site/browser-extension.zip",
  zipFiles(
    await Promise.all(
      [
        "manifest.json",
        "popup.html",
        "popup.css",
        "popup.js",
        "app.html",
        "app.js",
        "background.js",
        "worker.bundle.txt",
        "algorithm-0.3.111.txt",
        "LICENSE",
        "OpenCC-LICENSE.txt",
        ...extensionAssetFiles,
      ].map(async (name) => ({
        name: "browser-extension/" + name,
        data: await readFile("dist/browser-extension/" + name),
      })),
    ),
  ),
);
