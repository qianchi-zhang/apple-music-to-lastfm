import { it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
it("offline migration dry-run, idempotence and failed writes preserve source and existing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrobbler-migrate-"));
  try {
    const input = join(dir, "old.json"),
      output = join(dir, "new.json");
    const raw = JSON.stringify({
      version: 1,
      previous_recent: [],
      pending_scrobbles: [
        {
          track_id: "example",
          artist: "Original",
          track: "Song",
          album: "Album",
          timestamp_iso: "2026-09-08T01:00:00Z",
        },
      ],
      pending_enrichments: [],
    });
    writeFileSync(input, raw);
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/migrate.ts", ...args],
        { encoding: "utf8" },
      );
    expect(run("--input", input, "--dry-run").status).toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(run("--input", input, "--output", output).status).toBe(0);
    const migrated = readFileSync(output, "utf8");
    expect(JSON.parse(migrated).pending_scrobbles[0]).toMatchObject({
      artist: "Original",
      timestamp_iso: "2026-09-08T01:00:00Z",
      profile_revision: "legacy",
    });
    expect(run("--input", input, "--output", output).status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(migrated);
    expect(readFileSync(input, "utf8")).toBe(raw);
    expect(run("--input", input, "--output", input).status).not.toBe(0);
    const second = join(dir, "second.json");
    expect(run("--input", output, "--output", second).status).toBe(0);
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual(
      JSON.parse(migrated),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
