import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extensionAppSource, themeStyleFiles } from "./extension-assets";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Read the stored entries emitted by scripts/zip.ts through their directory. */
function archiveEntries(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const end = archive.length - 22;
  if (end < 0 || u32(end) !== 0x06054b50)
    throw Error("Archive has no supported ZIP directory");
  const count = u16(end + 10);
  const directory = u32(end + 16);
  let offset = directory;
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50)
      throw Error("Archive has an invalid ZIP directory entry");
    const size = u32(offset + 20);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const local = u32(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      u16(offset + 8) !== 0 ||
      u16(offset + 10) !== 0 ||
      u32(offset + 24) !== size ||
      local + 30 > directory ||
      u32(local) !== 0x04034b50
    )
      throw Error("Archive entry is not an uncompressed stored file");
    const name = new TextDecoder().decode(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    );
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (entries.has(name) || start + size > directory)
      throw Error("Archive contains a duplicate or truncated file");
    entries.set(name, archive.subarray(start, start + size));
    offset = next;
  }
  return entries;
}

const expected =
  "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794";
const source = await readFile("apps/worker/production/worker-0.3.111.js"),
  packaged = await readFile("dist/browser-extension/algorithm-0.3.111.txt");
if (sha(source) !== expected || sha(source) !== sha(packaged))
  throw Error("Algorithm differs from pinned production source");
const worker = await readFile("dist/worker.js"),
  extensionWorker = await readFile("dist/browser-extension/worker.bundle.txt");
if (sha(worker) !== sha(extensionWorker))
  throw Error("Extension deployment payload differs from built Worker");
const manifest = JSON.parse(
  await readFile("dist/browser-extension/manifest.json", "utf8"),
);
const zip = await readFile("dist/site/browser-extension.zip");
const archive = archiveEntries(zip);
if (archive.has("browser-extension/app.css"))
  throw Error("Archive still contains the previous app.css stylesheet");
const uiArtifacts = await Promise.all(
  [
    { source: extensionAppSource, destination: "app.html" },
    ...themeStyleFiles.map((name) => ({ source: name, destination: name })),
  ].map(async ({ source, destination }) => {
    const original = await readFile("apps/browser-extension/" + source);
    const built = await readFile("dist/browser-extension/" + destination);
    const archived = archive.get("browser-extension/" + destination);
    if (sha(original) !== sha(built))
      throw Error("Built UI differs from its selected source: " + destination);
    if (!archived || sha(original) !== sha(archived))
      throw Error(
        "Archived UI differs from its selected source: " + destination,
      );
    return {
      source,
      destination,
      sha256: sha(original),
      bytes: original.length,
    };
  }),
);
await mkdir("reports", { recursive: true });
await writeFile(
  "reports/extension-alignment.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      extensionVersion: manifest.version,
      algorithmVersion: "0.3.111",
      algorithmSha256: expected,
      algorithmBytes: source.length,
      exactAlgorithmCopy: true,
      exactWorkerPayload: true,
      workerSha256: sha(worker),
      uiEntrySource: extensionAppSource,
      exactUiSourceCopy: true,
      exactUiArchiveCopy: true,
      uiArtifacts,
      archiveSha256: sha(zip),
      archiveBytes: zip.length,
      verificationScope: "offline artifact consistency only",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Verified extension " +
    manifest.version +
    " contains exact 0.3.111 algorithm, current deployment payload and selected UI sources.",
);
