import { expect, it, vi } from "vitest";
import { Application } from "../apps/worker/src/application";
import worker from "../apps/worker/src/index";
import { MemoryStore } from "../packages/storage/src/index";
import { defaultProfile } from "../packages/contracts/src/index";
const setup = () => {
  const services = {
    recent: vi.fn(async () => []),
    resolve: vi.fn(),
    submit: vi.fn(),
  };
  const store = new MemoryStore();
  const app = new Application({
    store,
    services,
    clock: { now: () => 0, sleep: async () => {} },
  });
  return { app, services, store };
};
it("status and profile GET do not bootstrap schedules or call services", async () => {
  const { app, services, store } = setup();
  const put = vi.spyOn(store, "put");
  expect((await app.handle(new Request("https://t/status"))).status).toBe(200);
  expect(
    (await app.handle(new Request("https://t/api/v1/profile"))).status,
  ).toBe(200);
  expect(services.recent).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
it("profile update validates revision with serialized compare and write", async () => {
  const { app } = setup();
  const request = () =>
    new Request("https://t/api/v1/profile", {
      method: "PUT",
      body: JSON.stringify(defaultProfile()),
    });
  const result = await Promise.all([
    app.handle(request()),
    app.handle(request()),
  ]);
  expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (
      await app.handle(
        new Request("https://t/api/v1/profile", {
          method: "PUT",
          body: "not json",
        }),
      )
    ).status,
  ).toBe(400);
});
it("preview and validation are side effect free", async () => {
  const { app, services, store } = setup();
  const put = vi.spyOn(store, "put");
  const track = {
    source: { id: "1", name: "a", artist: "b", album: "c", duration_ms: 1 },
    canonical: { artist: "b", album_artist: "b", track: "a", album: "c" },
    identity: {},
    evidence: {},
  };
  const r = await app.handle(
    new Request("https://t/api/v1/profile/preview", {
      method: "POST",
      body: JSON.stringify({ profile: defaultProfile(), track }),
    }),
  );
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).lastfm.artist).toBe("b");
  expect(put).not.toHaveBeenCalled();
  expect(services.resolve).not.toHaveBeenCalled();
  expect(services.submit).not.toHaveBeenCalled();
});
it("all management routes require header authentication, not query key", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  const env: any = {
    STATUS_AUTH_KEY: "secret",
    SCROBBLE_COORDINATOR: { idFromName: () => 1, get: () => ({ fetch }) },
  };
  expect(
    (await worker.fetch(new Request("https://t/status?key=secret"), env))
      .status,
  ).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (
      await worker.fetch(
        new Request("https://t/status", {
          headers: { "x-ascrobble-auth": "secret" },
        }),
        env,
      )
    ).status,
  ).toBe(200);
});
it("external callers cannot invoke internal dispatch", async () => {
  expect(
    (
      await worker.fetch(
        new Request("https://t/internal/automatic", { method: "POST" }),
        {} as any,
      )
    ).status,
  ).toBe(404);
});
