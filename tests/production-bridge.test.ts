import { afterEach, beforeEach, it, expect, vi } from "vitest";
import type { Env } from "../apps/worker/src/index";
type AppleResponse = (url: URL, init?: RequestInit) => Promise<Response>;
async function setup() {
  const data = new Map<string, any>(),
    kv = new Map<string, string>();
  let alarm: number | null = null;
  const tasks: Promise<unknown>[] = [];
  const storage = {
    async get(k: string) {
      return data.get(k);
    },
    async put(k: string, v: any) {
      data.set(k, structuredClone(v));
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(t: number) {
      alarm = t;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
  const env = {
    STATUS_AUTH_KEY: "test-management",
    ASCROBBLE_STATE: {
      async get(k: string) {
        return kv.get(k) ?? null;
      },
      async put(k: string, v: string) {
        kv.set(k, v);
      },
    },
  } as unknown as Env;
  const { ScrobbleCoordinator, default: worker } =
    await import("../apps/worker/src/production-entry");
  const actor = new ScrobbleCoordinator(
    {
      storage,
      blockConcurrencyWhile(fn: () => Promise<unknown>) {
        tasks.push(fn());
      },
    } as any,
    env,
  );
  await Promise.all(tasks);
  let appleReads = 0,
    posts = 0;
  let authUsername = "FixtureUser";
  const submissionSessions: Array<string | null> = [];
  let history = ["old"];
  let appleResponse: AppleResponse | undefined;
  const appleRequests: Array<{ url: URL; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname === "api.music.apple.com") {
        appleReads++;
        appleRequests.push({ url: u, init });
        if (appleResponse) return appleResponse(u, init);
        return Response.json({
          data: history.map((id) => ({
            id,
            type: "other",
            attributes: {
              name: "Track " + id,
              artistName: "Fixture Artist",
              albumName: "Fixture Album",
              durationInMillis: 180000,
            },
          })),
        });
      }
      if (u.hostname === "ws.audioscrobbler.com") {
        const p = new URLSearchParams(String(init?.body ?? ""));
        if (p.get("method") === "auth.getSession")
          return Response.json({
            session: {
              name: authUsername,
              key: (authUsername.toLowerCase() === "fixtureuser"
                ? "s"
                : "n"
              ).repeat(32),
            },
          });
        if (p.get("method") === "track.scrobble") {
          posts++;
          submissionSessions.push(p.get("sk"));
          return Response.json({
            scrobbles: {
              "@attr": { accepted: "1", ignored: "0" },
              scrobble: { ignoredMessage: { code: "0" } },
            },
          });
        }
        return Response.json({});
      }
      if (u.hostname === "musicbrainz.org")
        return Response.json({ recordings: [], artists: [] });
      if (u.hostname === "music.apple.com")
        return new Response("", { status: 503 });
      throw Error("Unexpected provider " + u.hostname);
    }),
  );
  const request = (
    path: string,
    method = "GET",
    body?: any,
    headers?: Record<string, string>,
  ) =>
    new Request("https://fixture.test" + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = (p: string, m = "GET", b?: any, h?: Record<string, string>) =>
    actor.fetch(request(p, m, b, h));
  const authorize = async () => {
    const res = await call(
      "/api/v1/connections/lastfm/extension/start",
      "POST",
    );
    const auth = (await res.json()) as any;
    const navigation = await actor.fetch(new Request(auth.browser_url));
    const cb = new URL(
      new URL(navigation.headers.get("Location")!).searchParams.get("cb")!,
    );
    cb.searchParams.set("token", "t".repeat(32));
    const returned = await actor.fetch(
      new Request(cb, {
        headers: {
          Cookie: navigation.headers.get("Set-Cookie")!.split(";")[0],
        },
      }),
    );
    expect(returned.status).toBe(303);
    expect(returned.headers.get("Location")).toBe(
      "/api/v1/connections/lastfm/extension/result?result=connected",
    );
  };
  const connect = async () => {
    expect(
      (
        await call("/api/v1/connections/apple", "POST", {
          apple_dev_token: "fixture-dev",
          apple_user_token: "fixture-user",
        })
      ).status,
    ).toBe(200);
    await call("/api/v1/connections/lastfm/application", "PUT", {
      api_key: "a".repeat(32),
      shared_secret: "b".repeat(32),
    });
    await authorize();
  };
  return {
    actor,
    worker,
    env,
    call,
    connect,
    reauthorize: async (username: string) => {
      authUsername = username;
      await authorize();
    },
    kv,
    data,
    appleRequests,
    submissionSessions,
    appleResponse: (response: AppleResponse) => {
      appleResponse = response;
    },
    counts: () => ({ appleReads, posts, alarm }),
    history: (h: string[]) => {
      history = h;
    },
  };
}
beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());
it("fresh installation, Apple validation and official Last.fm exchange remain paused without submitting", async () => {
  const x = await setup();
  expect(x.counts()).toEqual({ appleReads: 0, posts: 0, alarm: null });
  const initial = await x.call("/api/v1/recording");
  expect(((await initial.json()) as any).enabled).toBe(false);
  expect(x.counts().appleReads).toBe(0);
  await x.connect();
  expect(
    ((await (await x.call("/api/v1/connections")).json()) as any).lastfm
      .username,
  ).toBe("FixtureUser");
  expect(x.counts().posts).toBe(0);
  expect(x.counts().alarm).toBe(null);
});
it("start establishes a baseline; production alarm submits only subsequent playback, pause stops requests", async () => {
  const x = await setup();
  await x.connect();
  expect(
    (
      await x.call("/api/v1/recording/start", "POST", {
        username: "FixtureUser",
      })
    ).status,
  ).toBe(200);
  expect(x.counts().posts).toBe(0);
  expect(x.counts().alarm).toBeGreaterThan(Date.now());
  x.history(["new", "old"]);
  await x.actor.alarm();
  expect(x.counts().posts).toBe(1);
  await x.call("/api/v1/recording/pause", "POST");
  const before = x.counts().appleReads;
  await x.actor.alarm();
  expect(x.counts().appleReads).toBe(before);
  expect(x.counts().alarm).toBe(null);
  const result = (await (await x.call("/api/v1/recording")).json()) as any;
  expect(result.algorithm_version).toBe("0.3.111");
  expect(result.records[0].track).toBe("Track new");
});
it("validates Apple with the same production history reader as main", async () => {
  const x = await setup();
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const response = await x.call("/api/v1/connections/apple", "POST", {
    apple_dev_token: "fixture-dev",
    apple_user_token: "fixture-user",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    connected: true,
    verified: true,
  });
  expect(x.appleRequests).toHaveLength(1);
  const { url, init } = x.appleRequests[0];
  expect(url.pathname).toBe("/v1/me/recent/played/tracks");
  expect(url.searchParams.get("limit")).toBe("30");
  expect(url.searchParams.get("offset")).toBe("0");
  expect(init?.signal).toBeUndefined();
  expect(init?.redirect).toBeUndefined();
  expect(timeout).not.toHaveBeenCalled();
  expect(x.counts().alarm).toBeNull();
  expect(x.counts().posts).toBe(0);
});
it("retains main's Apple 401 connection error without replacing saved credentials", async () => {
  const x = await setup();
  await x.connect();
  const original = structuredClone(x.data.get("apple-connection:v1"));
  x.appleResponse(async () => new Response(null, { status: 401 }));
  const response = await x.call("/api/v1/connections/apple", "POST", {
    apple_dev_token: "replacement-dev",
    apple_user_token: "replacement-user",
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "apple_rejected" });
  expect(x.data.get("apple-connection:v1")).toEqual(original);
  expect(x.counts().alarm).toBeNull();
  expect(x.counts().posts).toBe(0);
});
it("retains main's start error for Apple 401 and preserves the paused baseline", async () => {
  const x = await setup();
  await x.connect();
  const start = () =>
    x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  expect((await start()).status).toBe(200);
  await x.call("/api/v1/recording/pause", "POST");
  const original = x.data.get("production-ledger:v1");
  const mirror = x.kv.get("ledger:v1");
  x.appleResponse(async () => new Response(null, { status: 401 }));
  const response = await start();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "connections_required" });
  expect(x.data.get("production-ledger:v1")).toBe(original);
  expect(x.kv.get("ledger:v1")).toBe(mirror);
  expect(x.data.get("extension-enabled:v1")).toBe(false);
  expect(x.counts().alarm).toBeNull();
  expect(x.counts().posts).toBe(0);
});
it.each(["503", "network"])(
  "retains main's available first-page baseline when the next page has a %s failure",
  async (failure) => {
    const x = await setup();
    await x.connect();
    x.appleRequests.length = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    x.appleResponse(async (url) => {
      if (url.searchParams.get("offset") === "0")
        return Response.json({
          data: Array.from({ length: 30 }, (_, index) => ({
            id: String(index + 1),
            type: "songs",
          })),
        });
      if (failure === "network") throw new TypeError("fixture network failure");
      return new Response(null, { status: 503 });
    });
    const response = await x.call("/api/v1/recording/start", "POST", {
      username: "FixtureUser",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).enabled).toBe(true);
    expect(
      x.appleRequests.map(({ url }) => url.searchParams.get("offset")),
    ).toEqual(["0", "30"]);
    const ledger = JSON.parse(x.data.get("production-ledger:v1"));
    expect(ledger.previous_recent).toHaveLength(30);
    expect(ledger.previous_recent[0].id).toBe("1");
    expect(ledger.previous_recent.at(-1).id).toBe("30");
    expect(JSON.parse(x.kv.get("ledger:v1")!)).toEqual(ledger);
    expect(x.data.get("extension-enabled:v1")).toBe(true);
    expect(x.counts().alarm).toBeGreaterThan(Date.now());
    expect(x.counts().posts).toBe(0);
    expect(warning).toHaveBeenCalledTimes(1);
  },
);
it("resume resets the baseline to paused-period history before production polling continues", async () => {
  const x = await setup();
  await x.connect();
  const start = () =>
    x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  expect((await start()).status).toBe(200);
  await x.call("/api/v1/recording/pause", "POST");
  x.history(["paused", "old"]);
  expect((await start()).status).toBe(200);
  expect(
    JSON.parse(x.data.get("production-ledger:v1")).previous_recent.map(
      (track: any) => track.id,
    ),
  ).toEqual(["paused", "old"]);
  expect(x.counts().posts).toBe(0);
  const before = x.counts().appleReads;
  expect((await start()).status).toBe(200);
  expect(x.counts().appleReads).toBe(before);
  x.history(["after-resume", "paused", "old"]);
  await x.actor.alarm();
  expect(x.counts().posts).toBe(1);
  const result = (await (await x.call("/api/v1/recording")).json()) as any;
  expect(result.records[0].track).toBe("Track after-resume");
});
it("keeps recording paused when the requested Last.fm username differs", async () => {
  const x = await setup();
  await x.connect();
  const before = x.counts().appleReads;
  const response = await x.call("/api/v1/recording/start", "POST", {
    username: "DifferentUser",
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "account_changed" });
  expect(x.counts().appleReads).toBe(before);
  expect(x.data.has("production-ledger:v1")).toBe(false);
  expect(x.data.get("extension-enabled:v1")).not.toBe(true);
  expect(x.counts().alarm).toBeNull();
  expect(x.counts().posts).toBe(0);
});
it("accepts genuinely empty Apple history without submitting or misreporting a failed read", async () => {
  const x = await setup();
  x.history([]);
  await x.connect();
  const response = await x.call("/api/v1/recording/start", "POST", {
    username: "FixtureUser",
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).enabled).toBe(true);
  expect(
    JSON.parse(x.data.get("production-ledger:v1")).previous_recent,
  ).toEqual([]);
  expect(x.counts().alarm).toBeGreaterThan(Date.now());
  expect(x.counts().posts).toBe(0);
});
it("uses main’s page-boundary identity, album normalization and library catalog IDs", async () => {
  const x = await setup();
  await x.connect();
  const firstPage = Array.from({ length: 30 }, (_, index) => ({
    id: String(index + 1),
    type: "songs",
    attributes: {
      name: "Song " + index,
      artistName: "Fixture Artist",
      albumName: "Fixture Album - EP",
    },
  }));
  const library = {
    id: "i.fixture",
    type: "library-songs",
    attributes: {
      name: "Library Song",
      artistName: "Track Artist",
      albumArtistName: "Album Artist",
      albumName: "Library Album - Single",
      durationInMillis: 240000,
      isrc: "XXTEST000001",
      playParams: { catalogId: "12345" },
    },
  };
  x.appleRequests.length = 0;
  x.appleResponse(async (url) =>
    Response.json({
      data:
        url.searchParams.get("offset") === "0"
          ? firstPage
          : [firstPage[29], firstPage[29], library],
    }),
  );
  const response = await x.call("/api/v1/recording/start", "POST", {
    username: "FixtureUser",
  });
  expect(response.status).toBe(200);
  const baseline = JSON.parse(
    x.data.get("production-ledger:v1"),
  ).previous_recent;
  expect(baseline).toHaveLength(32);
  expect(baseline.slice(-3).map((track: any) => track.id)).toEqual([
    "30",
    "30",
    "i.fixture",
  ]);
  expect(baseline[0]).toMatchObject({
    id: "1",
    name: "Song 0",
    artist: "Fixture Artist",
    album_artist: "Fixture Artist",
    album: "Fixture Album",
    _apple_raw_album: "Fixture Album - EP",
    duration_ms: 180000,
    catalog_id: "1",
  });
  expect(baseline.at(-1)).toMatchObject({
    id: "i.fixture",
    name: "Library Song",
    artist: "Track Artist",
    album_artist: "Album Artist",
    album: "Library Album",
    _apple_raw_album: "Library Album - Single",
    duration_ms: 240000,
    isrc: "XXTEST000001",
    catalog_id: "12345",
  });
  expect(x.appleRequests).toHaveLength(2);
  const [first, second] = x.appleRequests;
  expect(first.init?.signal).toBeUndefined();
  expect(second.init?.signal).toBeUndefined();
  expect(first.init?.redirect).toBeUndefined();
  expect(second.init?.redirect).toBeUndefined();
  expect(x.counts().posts).toBe(0);
});
it("new public entrypoint requires auth and health reports the pinned identity without storage requests", async () => {
  const x = await setup();
  const h = await x.worker.fetch(
    new Request("https://fixture.test/health"),
    x.env,
  );
  expect(((await h.json()) as any).version).toBe("0.3.111");
  expect(
    (
      await x.worker.fetch(
        new Request("https://fixture.test/api/v1/recording"),
        x.env,
      )
    ).status,
  ).toBe(401);
  expect(x.counts().appleReads).toBe(0);
});

it("serves only a static extension handoff at the Worker home and old setup address, without exposing another management UI", async () => {
  const x = await setup();
  const pages: string[] = [];
  for (const path of ["/", "/setup"]) {
    const response = await x.worker.fetch(
      new Request("https://fixture.test" + path),
      x.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    pages.push(html);
    expect(html).toContain("余音的个人后台");
    expect(html).toContain("请回到 Chrome 中的余音页面");
    expect(html).not.toMatch(/<(?:input|form|button|script)\b/i);
    for (const oldControl of [
      "音乐记录控制台",
      "管理密钥",
      'id="authorize"',
      'id="start-recording"',
      "x-ascrobble-auth",
      x.env.STATUS_AUTH_KEY,
    ])
      expect(html).not.toContain(oldControl);
  }
  expect(pages[0]).toBe(pages[1]);
  expect(x.counts()).toEqual({ appleReads: 0, posts: 0, alarm: null });
});

it("continues to serve the isolated Last.fm completion page after removing the old management UI", async () => {
  const x = await setup();
  const response = await x.worker.fetch(
    new Request(
      "https://fixture.test/api/v1/connections/lastfm/extension/result?result=connected",
    ),
    x.env,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('data-lastfm-result="connected"');
  expect(html).toContain("已连接 Last.fm");
  expect(html).not.toContain("音乐记录控制台");
  expect(html).not.toMatch(/<(?:input|form|button|script)\b/i);
  expect(x.counts()).toEqual({ appleReads: 0, posts: 0, alarm: null });
});

it("exposes an actual expired Apple poll as a safe recording issue without changing opt-in polling", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const ledger = JSON.parse(x.data.get("production-ledger:v1"));
  ledger.last_run_iso = new Date(Date.now() - 240000).toISOString();
  x.data.set("production-ledger:v1", JSON.stringify(ledger));
  x.appleResponse(async () => new Response(null, { status: 401 }));
  await x.actor.alarm();
  const afterAlarm = x.counts();
  const status = (await (await x.call("/api/v1/recording")).json()) as any;
  expect(status.enabled).toBe(true);
  expect(status.recording_issue).toEqual({ code: "apple_reconnect_required" });
  expect(status.stats.last_error_message).toBe("apple_token_expired");
  expect(status.next_run_ms).toBeGreaterThan(Date.now());
  expect(x.counts()).toEqual(afterAlarm);
  await x.call("/api/v1/recording/pause", "POST");
  expect(x.counts().alarm).toBeNull();
});

it.each(["pending_scrobbles", "pending_enrichments"])(
  "pauses a Last.fm account switch with %s intact and offers the original account recovery",
  async (pendingKey) => {
    const x = await setup();
    await x.connect();
    await x.call("/api/v1/recording/start", "POST", {
      username: "FixtureUser",
    });
    const ledger = JSON.parse(x.data.get("production-ledger:v1"));
    const oldRecord = {
      track_id: "220366030",
      track: "Old song",
      artist: "Old artist",
      timestamp_iso: "2026-10-27T00:00:00Z",
    };
    ledger[pendingKey] = [oldRecord];
    ledger.recent_scrobbles = [oldRecord];
    ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
    const original = JSON.stringify(ledger);
    x.data.set("production-ledger:v1", original);
    const before = x.counts();
    await x.reauthorize("NewFixture");
    expect(x.data.get("production-ledger:v1")).toBe(original);
    expect(x.data.get("extension-queue-owner:v1")).toBe("FixtureUser");
    expect(x.data.get("extension-enabled:v1")).toBe(false);
    expect(x.counts().alarm).toBeNull();
    const status = (await (await x.call("/api/v1/recording")).json()) as any;
    expect(status.enabled).toBe(false);
    expect(status.recording_issue).toEqual({
      code: "queue_account_changed",
      queue_owner: "FixtureUser",
    });
    expect(status.records).toEqual([]);
    const cover = (await (
      await x.call("/api/v1/artwork?track_id=220366030")
    ).json()) as any;
    expect(cover.artwork_status).toBe("scope_not_found");
    const start = await x.call("/api/v1/recording/start", "POST", {
      username: "NewFixture",
    });
    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({
      error: "queue_account_changed",
      recording_issue: status.recording_issue,
    });
    // Also repair an already-enabled instance carrying this pre-fix condition.
    x.data.set("extension-enabled:v1", true);
    await x.actor.alarm();
    expect(x.data.get("extension-enabled:v1")).toBe(false);
    expect(x.counts()).toEqual({ ...before, alarm: null });
    await x.reauthorize("fixtureuser");
    const restored = (await (await x.call("/api/v1/recording")).json()) as any;
    expect(restored.recording_issue).toBeNull();
    expect(restored.enabled).toBe(false);
    expect(restored.records[0].track).toBe("Old song");
    const resumed = await x.call("/api/v1/recording/start", "POST", {
      username: "fixtureuser",
    });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(x.data.get("production-ledger:v1"))[pendingKey]).toEqual([
      oldRecord,
    ]);
    expect(x.counts().posts).toBe(0);
    if (pendingKey === "pending_scrobbles") {
      await x.actor.alarm();
      expect(x.submissionSessions).toEqual(["s".repeat(32)]);
      expect(
        JSON.parse(x.data.get("production-ledger:v1")).pending_scrobbles,
      ).toEqual([]);
    }
  },
);

it("claims a legacy queue for the previous verified account before saving a new account", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const ledger = JSON.parse(x.data.get("production-ledger:v1"));
  ledger.pending_scrobbles = [{ track_id: "1" }];
  ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
  x.data.set("production-ledger:v1", JSON.stringify(ledger));
  x.data.delete("extension-queue-owner:v1");
  x.kv.delete("extension-queue-owner:v1");
  await x.reauthorize("NewFixture");
  expect(x.data.get("extension-queue-owner:v1")).toBe("FixtureUser");
  expect(
    (
      await x.call("/api/v1/recording/start", "POST", {
        username: "NewFixture",
      })
    ).status,
  ).toBe(409);
  expect(x.counts().posts).toBe(0);
});

it("keeps same-account reauthorization running and accepts username case differences", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const before = x.counts();
  const ledger = x.data.get("production-ledger:v1");
  await x.reauthorize("fixtureuser");
  expect(x.data.get("extension-enabled:v1")).toBe(true);
  expect(x.data.get("production-ledger:v1")).toBe(ledger);
  expect(x.counts()).toEqual(before);
  const start = await x.call("/api/v1/recording/start", "POST", {
    username: "FixtureUser",
  });
  expect(start.status).toBe(200);
  expect(x.counts()).toEqual(before);
});

it("keeps the queue bound to its original account when a different Last.fm application is configured first", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const ledger = JSON.parse(x.data.get("production-ledger:v1"));
  ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
  ledger.pending_scrobbles = [
    {
      track_id: "1",
      track: "Old queue",
      artist: "Fixture",
      timestamp_iso: "2026-10-27T00:00:00Z",
    },
  ];
  const original = JSON.stringify(ledger);
  x.data.set("production-ledger:v1", original);
  await x.call("/api/v1/connections/lastfm/application", "PUT", {
    api_key: "e".repeat(32),
    shared_secret: "f".repeat(32),
  });
  expect(
    ((await (await x.call("/api/v1/connections")).json()) as any).lastfm
      .connected,
  ).toBe(false);
  await x.reauthorize("NewFixture");
  expect(x.data.get("production-ledger:v1")).toBe(original);
  expect(x.data.get("extension-queue-owner:v1")).toBe("FixtureUser");
  const status = (await (await x.call("/api/v1/recording")).json()) as any;
  expect(status.enabled).toBe(false);
  expect(status.recording_issue).toEqual({
    code: "queue_account_changed",
    queue_owner: "FixtureUser",
  });
  expect(x.counts().alarm).toBeNull();
  expect(x.counts().posts).toBe(0);
});

it("isolates prior account records without deleting the ledger when the old queue is empty", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const ledger = JSON.parse(x.data.get("production-ledger:v1"));
  ledger.recent_scrobbles = [
    {
      track_id: "1",
      track: "Prior account song",
      timestamp_iso: "2026-10-27T00:00:00Z",
    },
  ];
  ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
  x.data.set("production-ledger:v1", JSON.stringify(ledger));
  await x.reauthorize("NewFixture");
  const newStart = await x.call("/api/v1/recording/start", "POST", {
    username: "NewFixture",
  });
  expect(newStart.status).toBe(200);
  expect(((await newStart.json()) as any).records).toEqual([]);
  expect(
    JSON.parse(x.data.get("production-ledger:v1")).recent_scrobbles,
  ).toEqual(ledger.recent_scrobbles);
  // A new accepted row belongs to the currently running account by default.
  const updated = JSON.parse(x.data.get("production-ledger:v1"));
  updated.last_run_iso = new Date(Date.now() + 2000).toISOString();
  updated.recent_scrobbles.unshift({
    track_id: "2",
    track: "New account song",
    timestamp_iso: "2026-10-27T00:01:00Z",
  });
  x.data.set("production-ledger:v1", JSON.stringify(updated));
  expect(
    ((await (await x.call("/api/v1/recording")).json()) as any).records.map(
      (r: any) => r.track,
    ),
  ).toEqual(["New account song"]);
  await x.reauthorize("FixtureUser");
  expect(
    ((await (await x.call("/api/v1/recording")).json()) as any).records.map(
      (r: any) => r.track,
    ),
  ).toEqual(["Prior account song"]);
});

it.each(["apple", "lastfm"])(
  "clears an old %s auth issue after successful verification without rewriting ledger stats",
  async (provider) => {
    const x = await setup();
    await x.connect();
    await x.call("/api/v1/recording/start", "POST", {
      username: "FixtureUser",
    });
    const ledger = JSON.parse(x.data.get("production-ledger:v1"));
    ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
    const errorAt = new Date(Date.now() - 1000).toISOString();
    ledger.stats.last_error_iso = errorAt;
    ledger.stats.last_success_iso = null;
    ledger.stats.last_error_message =
      provider === "apple" ? "apple_token_expired" : "api_9: private";
    x.data.set("production-ledger:v1", JSON.stringify(ledger));
    if (provider === "apple") {
      x.data.set(
        "extension-apple-verified-at:v1",
        new Date(Date.now() - 2000).toISOString(),
      );
      const before = (await (await x.call("/api/v1/recording")).json()) as any;
      expect(before.recording_issue).toEqual({
        code: "apple_reconnect_required",
      });
      await x.call("/api/v1/connections/apple", "POST", {
        apple_dev_token: "fixture-dev",
        apple_user_token: "fixture-user",
      });
    } else {
      const c = x.data.get("lastfm-connection:v1");
      x.data.set("lastfm-connection:v1", {
        ...c,
        connected_at: new Date(Date.now() - 2000).toISOString(),
      });
      const before = (await (await x.call("/api/v1/recording")).json()) as any;
      expect(before.recording_issue).toEqual({
        code: "lastfm_reconnect_required",
      });
      await x.reauthorize("FixtureUser");
    }
    const status = (await (await x.call("/api/v1/recording")).json()) as any;
    expect(status.recording_issue).toBeNull();
    expect(status.stats.last_error_message).toBe(
      ledger.stats.last_error_message,
    );
    expect(JSON.parse(x.data.get("production-ledger:v1"))).toEqual(ledger);
  },
);

it("keeps the ownership index bounded and stores hashes rather than long song metadata", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const ledger = JSON.parse(x.data.get("production-ledger:v1"));
  ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
  ledger.recent_scrobbles = Array.from({ length: 1001 }, (_, i) => ({
    track_id: String(i + 1),
    track: "Long title".repeat(100),
    timestamp_iso: "2026-10-27T00:00:00Z",
  }));
  const original = JSON.stringify(ledger);
  x.data.set("production-ledger:v1", original);
  await x.reauthorize("NewFixture");
  const owners = x.data.get("extension-record-owners:v1");
  expect(owners).toHaveLength(1000);
  expect(
    owners.every(
      ([key, owner]: [string, string]) =>
        /^[a-f0-9]{64}$/.test(key) && owner === "FixtureUser",
    ),
  ).toBe(true);
  expect(JSON.stringify(owners).length).toBeLessThan(100000);
  expect(x.data.get("production-ledger:v1")).toBe(original);
  const beforeData = structuredClone(x.data),
    beforeKv = structuredClone(x.kv),
    beforeCounts = x.counts();
  const status = (await (await x.call("/api/v1/recording")).json()) as any;
  expect(status.records).toEqual([]);
  expect(x.data).toEqual(beforeData);
  expect(x.kv).toEqual(beforeKv);
  expect(x.counts()).toEqual(beforeCounts);
});

it("avoids hashing ordinary single-account history and stops indexed reads after ten visible rows", async () => {
  const x = await setup();
  await x.connect();
  await x.call("/api/v1/recording/start", "POST", { username: "FixtureUser" });
  const ledger = JSON.parse(x.data.get("production-ledger:v1"));
  ledger.last_run_iso = new Date(Date.now() + 1000).toISOString();
  ledger.recent_scrobbles = Array.from({ length: 1000 }, (_, i) => ({
    track_id: String(i + 1),
    track: "Song " + i,
    timestamp_iso: "2026-10-27T00:00:00Z",
  }));
  x.data.set("production-ledger:v1", JSON.stringify(ledger));
  const digest = vi.spyOn(crypto.subtle, "digest");
  expect(
    ((await (await x.call("/api/v1/recording")).json()) as any).records,
  ).toHaveLength(10);
  expect(digest).not.toHaveBeenCalled();
  // An index is present, but the first ten rows all belong to this account.
  x.data.set("extension-record-owners:v1", [["unrelated", "OtherUser"]]);
  expect(
    ((await (await x.call("/api/v1/recording")).json()) as any).records,
  ).toHaveLength(10);
  expect(digest).toHaveBeenCalledTimes(10);
  digest.mockClear();
  x.data.delete("extension-record-owners:v1");
  x.data.set("extension-queue-owner:v1", "OtherUser");
  expect(
    ((await (await x.call("/api/v1/recording")).json()) as any).records,
  ).toEqual([]);
  expect(digest).not.toHaveBeenCalled();
});
