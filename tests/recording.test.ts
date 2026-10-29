import { it, expect, vi } from "vitest";
import { Application } from "../apps/worker/src/application";
import { Recording } from "../apps/worker/src/recording";
import { MemoryStore } from "../packages/storage/src/index";
import { setupPage } from "../apps/worker/src/setup-page";
import { Script } from "node:vm";
function fixture() {
  const store = new MemoryStore();
  let now = 1000000;
  let alarm: number | null = null;
  const clock = { now: () => now, sleep: async () => {} };
  const services = {
    recent: vi.fn(async () => [
      {
        id: "song",
        name: "track",
        artist: "artist",
        album: "album",
        duration_ms: 200000,
      },
    ]),
    resolve: vi.fn(),
    submit: vi.fn(),
  };
  const alarms = {
    setAlarm: vi.fn(async (time: number) => {
      alarm = time;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
    getAlarm: async () => alarm,
  };
  const app = new Application({ store, services, clock });
  const connections = vi.fn(async () => ({
    apple: { connected: true },
    lastfm: { connected: true, username: "test" },
  }));
  const controller = () =>
    new Recording(app, store, alarms, clock, connections);
  return {
    store,
    services,
    alarms,
    app,
    connections,
    controller,
    r: controller(),
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
it("fresh GET is side-effect free and starting initializes baseline without submitting history", async () => {
  const f = fixture();
  const put = vi.spyOn(f.store, "put");
  expect((await f.r.status()).enabled).toBe(false);
  expect(put).not.toHaveBeenCalled();
  expect(f.services.recent).not.toHaveBeenCalled();
  await f.r.tick();
  expect(f.services.recent).not.toHaveBeenCalled();
  const result = await f.r.start("test");
  expect(result.enabled).toBe(true);
  expect(f.services.submit).not.toHaveBeenCalled();
  expect((await f.app.engine.status()).previous_recent).toHaveLength(1);
  await f.r.start("test");
  expect(f.services.recent).toHaveBeenCalledTimes(1);
  expect(await f.alarms.getAlarm()).toBe(f.now() + 180000);
});
it("rejects missing connections or changed target without enabling or collecting", async () => {
  const f = fixture();
  await expect(f.r.start("wrong")).rejects.toMatchObject({
    code: "account_changed",
  });
  f.connections.mockResolvedValue({
    apple: { connected: false },
    lastfm: { connected: true, username: "test" },
  });
  await expect(f.r.start("test")).rejects.toMatchObject({
    code: "connections_required",
  });
  expect(f.services.recent).not.toHaveBeenCalled();
  expect((await f.r.status()).enabled).toBe(false);
});
it("failed baseline does not enable or overwrite snapshot", async () => {
  const f = fixture();
  await f.r.start("test");
  await f.r.pause();
  const old = await f.app.engine.status();
  f.services.recent.mockRejectedValueOnce(Error("offline"));
  await expect(f.r.start("test")).rejects.toThrow("offline");
  expect(await f.app.engine.status()).toEqual(old);
  expect((await f.r.status()).enabled).toBe(false);
});
it("skipped cron preserves shared deadline; simultaneous due events run once", async () => {
  const f = fixture();
  await f.r.start("test");
  f.advance(179000);
  await f.r.tick();
  expect(await f.alarms.getAlarm()).toBe(1180000);
  f.advance(1000);
  await Promise.all([f.r.tick(), f.r.tick()]);
  expect(f.services.recent).toHaveBeenCalledTimes(2);
  expect((await f.app.engine.status()).stats.total_runs).toBe(1);
  expect(await f.alarms.getAlarm()).toBe(1360000);
});
it("pause blocks automatic and manual runs across controller recreation", async () => {
  const f = fixture();
  await f.r.start("test");
  await f.r.pause();
  f.advance(200000);
  await f.controller().tick();
  await f.r.tick(true);
  expect(f.services.recent).toHaveBeenCalledTimes(1);
  expect(await f.alarms.getAlarm()).toBeNull();
  expect((await f.r.status()).next_run_ms).toBeNull();
});
it("resume preserves queued data and replaces snapshot to exclude paused history", async () => {
  const f = fixture();
  await f.r.start("test");
  const l = await f.app.engine.status();
  l.pending_enrichments.push({
    event_id: "queued",
    track: { id: "old" },
    timestamp_iso: "2026-09-08T00:00:00Z",
    kind: "new",
    queued_at_iso: "2026-09-08T00:00:00Z",
    profile: {
      schema_version: 1,
      revision: 7,
      naming_strategy: "apple_source",
      rules: [],
    },
  } as any);
  await f.store.put("ledger:v1", l);
  await f.r.pause();
  f.services.recent.mockResolvedValue([
    {
      id: "paused",
      name: "new baseline",
      artist: "artist",
      album: "album",
      duration_ms: 200000,
    },
  ]);
  await f.r.start("test");
  const resumed = await f.app.engine.status();
  expect(resumed.pending_enrichments).toEqual(l.pending_enrichments);
  expect(resumed.previous_recent[0].id).toBe("paused");
  expect(f.services.submit).not.toHaveBeenCalled();
});
it("existing schedule is preserved without resetting live baseline", async () => {
  const f = fixture();
  await f.store.put("schedule:v1", { next_run_ms: 2000000 });
  expect((await f.r.status()).enabled).toBe(true);
  await f.r.start("test");
  expect(f.services.recent).not.toHaveBeenCalled();
  expect(await f.alarms.getAlarm()).toBe(2000000);
});
it("pause queued behind a run removes its rearmed alarm", async () => {
  const f = fixture();
  await f.r.start("test");
  f.advance(180000);
  let finish!: () => void;
  f.services.recent.mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      finish = r;
    });
    return [];
  });
  const tick = f.r.tick();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const pause = f.r.pause();
  finish();
  await Promise.all([tick, pause]);
  expect((await f.r.status()).enabled).toBe(false);
  expect(await f.alarms.getAlarm()).toBeNull();
});
it("dashboard script parses and renders data with text APIs", async () => {
  const html = await setupPage().text();
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Script(script!)).not.toThrow();
  expect(script).not.toContain("innerHTML");
  expect(html).toContain("暂停记录");
});
