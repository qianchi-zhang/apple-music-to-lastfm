import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { migrateLedger } from "../packages/core/src/ledger";
import { defaultProfile } from "../packages/contracts/src/index";
import { validateProfile } from "../packages/profiles/src/index";
const args = process.argv.slice(2);
const value = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const input = value("--input");
const output = value("--output");
const dry = args.includes("--dry-run");
if (!input || (!dry && !output))
  throw new Error(
    "Usage: npm run migrate -- --input ledger.json [--profile profile.json] --dry-run OR --output new.local.json",
  );
const profilePath = value("--profile");
const profile = profilePath
  ? JSON.parse(await readFile(profilePath, "utf8"))
  : defaultProfile();
const errors = validateProfile(profile);
if (errors.length) throw new Error(errors.join("; "));
const migrated = migrateLedger(
  JSON.parse(await readFile(input, "utf8")),
  profile,
);
if (!dry) {
  if (resolve(input) === resolve(output!))
    throw new Error("Refusing to overwrite input");
  const temp = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(migrated, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await link(temp, output!);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
console.log(
  JSON.stringify({
    ok: true,
    dry_run: dry,
    schema_version: 2,
    pending_enrichments: migrated.pending_enrichments.length,
    pending_scrobbles: migrated.pending_scrobbles.length,
    previous_recent: migrated.previous_recent.length,
  }),
);
