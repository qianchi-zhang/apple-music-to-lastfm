import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export const productionHash =
  "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794";
export async function generateProductionRuntime() {
  const source = await readFile("apps/worker/production/worker-0.3.111.js");
  if (createHash("sha256").update(source).digest("hex") !== productionHash)
    throw Error("Pinned 0.3.111 source changed; build blocked.");
  await writeFile(
    "apps/worker/production/runtime.generated.js",
    Buffer.concat([
      source,
      Buffer.from(
        "\n// Build bridge: no changes to pinned algorithm bytes above.\nexport {loadLedger,saveLedger,fetchRecentlyPlayed};\n",
      ),
    ]),
  );
}
await generateProductionRuntime();
