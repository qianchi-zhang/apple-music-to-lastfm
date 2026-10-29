import { expect, it, vi } from "vitest";
import { Engine } from "../packages/core/src/engine";
import {
  emptyLedger,
  eventId,
  migrateLedger,
} from "../packages/core/src/ledger";
import { MemoryStore } from "../packages/storage/src/index";
import {
  defaultProfile,
  type Track,
  type Services,
  type ResolvedTrack,
  type UserProfile,
  type SubmissionRecord,
} from "../packages/contracts/src/index";
import { Application } from "../apps/worker/src/application";
const track = (id: string): Track => ({
  id,
  name: id,
  artist: "Fujii Kaze",
  album_artist: "Fujii Kaze",
  album: "Album",
  duration_ms: 180000,
});
function resolved(t: Track): ResolvedTrack {
  return {
    source: t,
    identity: {},
    canonical: {
      artist: "藤井風",
      album_artist: "藤井風",
      track: t.name,
      album: t.album,
    },
    evidence: {},
  };
}
async function setup(capacity = 1000) {
  const store = new MemoryStore();
  let now = Date.parse("2026-09-08T10:00:00Z");
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  let profile: UserProfile = defaultProfile();
  const ledger = emptyLedger();
  ledger.previous_recent = [track("old")];
  ledger.last_detection_iso = new Date(now - 180000).toISOString();
  await store.put("ledger:v1", ledger);
  const services: Services = {
    recent: vi.fn(async () => [track("new"), track("old")]),
    resolve: vi.fn(async (t) => resolved(t)),
    submit: vi.fn(async (items: SubmissionRecord[]) =>
      items.map((i) => ({ event_id: i.event_id, status: "accepted" as const })),
    ),
    secondary: vi.fn(async () => {}),
  };
  const engine = new Engine({
    store,
    services,
    clock,
    profile: async () => profile,
    capacity,
  });
  return {
    store,
    clock,
    services,
    engine,
    setProfile: (p: UserProfile) => {
      profile = p;
    },
    advance: () => {
      now += 180000;
    },
  };
}
it("persists source and profile before identity requests, isolates one failure", async () => {
  const x = await setup();
  x.services.recent = async () => [track("bad"), track("good"), track("old")];
  x.services.resolve = async (t) => {
    const l = await x.engine.status();
    expect(l.pending_enrichments).toHaveLength(2);
    if (t.id === "bad") throw Error("transient");
    return resolved(t);
  };
  await x.engine.run();
  const l = await x.engine.status();
  expect(l.pending_enrichments[0].track.id).toBe("bad");
  expect(l.pending_enrichments[0].profile.revision).toBe(0);
  expect(l.recent_scrobbles[0].track_id).toBe("good");
});
it("configuration changes do not alter deferred identity or submission payloads", async () => {
  const x = await setup();
  x.services.resolve = async () => {
    throw Error("defer");
  };
  await x.engine.run();
  const saved = (await x.engine.status()).pending_enrichments[0];
  x.setProfile({
    ...defaultProfile(),
    revision: 1,
    naming_strategy: "apple_source",
  });
  x.services.resolve = async (t) => resolved(t);
  let payload: SubmissionRecord[] = [];
  x.services.submit = async (items) => {
    payload = structuredClone(items);
    return items.map((i) => ({
      event_id: i.event_id,
      status: "ignored",
      error: "quota",
    }));
  };
  x.advance();
  await x.engine.run();
  expect(payload[0].artist).toBe("藤井風");
  expect(payload[0].timestamp_iso).toBe(saved.timestamp_iso);
  x.setProfile({ ...defaultProfile(), revision: 2 });
  x.advance();
  await x.engine.run();
  expect(payload[0].profile_revision).toBe(0);
});
it("partial success removes only accepted entries", async () => {
  const x = await setup();
  x.services.recent = async () => [track("b"), track("a"), track("old")];
  x.services.submit = async (items) =>
    items.map((i, n) => ({
      event_id: i.event_id,
      status: n === 0 ? "accepted" : "ignored",
    }));
  await x.engine.run();
  const l = await x.engine.status();
  expect(l.stats.total_scrobbled).toBe(1);
  expect(l.pending_scrobbles).toHaveLength(1);
  expect(l.submission_records).toHaveLength(1);
});
it("missing confirmation stays uncertain and is not resubmitted automatically", async () => {
  const x = await setup();
  x.services.submit = vi.fn(async () => []);
  await x.engine.run();
  expect((await x.engine.status()).pending_scrobbles[0].status).toBe(
    "uncertain",
  );
  x.advance();
  await x.engine.run();
  expect(x.services.submit).toHaveBeenCalledTimes(1);
});
it("new engine resumes persisted failure using same event and timestamp", async () => {
  const x = await setup();
  x.services.submit = async (items) =>
    items.map((i) => ({
      event_id: i.event_id,
      status: "failed",
      error: "503",
    }));
  await x.engine.run();
  const pending = (await x.engine.status()).pending_scrobbles[0];
  x.services.submit = async (items) => {
    expect(items[0].event_id).toBe(pending.event_id);
    expect(items[0].timestamp_iso).toBe(pending.timestamp_iso);
    return items.map((i) => ({ event_id: i.event_id, status: "accepted" }));
  };
  const restarted = new Engine({
    store: x.store,
    services: x.services,
    clock: x.clock,
    profile: async () => defaultProfile(),
  });
  await restarted.run(true);
  expect((await restarted.status()).stats.total_scrobbled).toBe(1);
});
it("queue full retains capture snapshot and every pending event", async () => {
  const x = await setup(1);
  const l = await x.engine.status();
  l.pending_enrichments = [
    {
      event_id: "existing",
      track: track("stuck"),
      timestamp_iso: "2026-09-08T09:00:00Z",
      queued_at_iso: "2026-09-08T09:00:00Z",
      kind: "new",
      profile: defaultProfile(),
    },
  ];
  await x.store.put("ledger:v1", l);
  x.services.resolve = async () => {
    throw Error("defer");
  };
  await x.engine.run();
  const after = await x.engine.status();
  expect(after.previous_recent[0].id).toBe("old");
  expect(after.pending_enrichments[0].event_id).toBe("existing");
  expect(after.log_entries.some((i) => i.step === "queue_full")).toBe(true);
});
it("concurrent cron and alarm invoke only one automatic run; manual stays serialized", async () => {
  const x = await setup();
  let active = 0,
    max = 0;
  x.services.recent = async () => {
    max = Math.max(max, ++active);
    await Promise.resolve();
    active--;
    return [track("old")];
  };
  const app = new Application(x);
  const runs = await Promise.all([
    app.automatic(),
    app.automatic(),
    app.handle(new Request("https://test/trigger", { method: "POST" })),
  ]);
  expect(runs[1]).toMatchObject({ skipped: true });
  expect(max).toBe(1);
  expect((await app.engine.status()).stats.total_runs).toBe(2);
});
it("migration is idempotent and preserves timestamps and unknown compatibility fields", () => {
  const old = {
    version: 1,
    previous_recent: [track("old")],
    pending_scrobbles: [
      {
        track_id: "x",
        artist: "Original",
        track: "Name",
        album: "A",
        timestamp_iso: "2026-09-08T01:00:00.001Z",
      },
    ],
    pending_enrichments: [
      { track: track("waiting"), timestamp_iso: "2026-09-08T02:00:00Z" },
    ],
    custom_legacy_field: 42,
  };
  const before = structuredClone(old);
  const first = migrateLedger(old);
  expect(migrateLedger(first)).toEqual(first);
  expect(first.pending_scrobbles[0]).toMatchObject({
    ...old.pending_scrobbles[0],
    profile_revision: "legacy",
  });
  expect(old).toEqual(before);
  expect(first.custom_legacy_field).toBe(42);
  expect(eventId("x", "stamp")).toBe(eventId("x", "stamp"));
});
it("migration rejects malformed input without changing source", () => {
  const old = { version: 1, pending_scrobbles: [{ timestamp_iso: "wrong" }] };
  const before = structuredClone(old);
  expect(() => migrateLedger(old)).toThrow();
  expect(old).toEqual(before);
});
