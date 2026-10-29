import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { MemoryStore } from "../packages/storage/src/index";
import {
  exchangeLastfmToken,
  parseLastfmApp,
  fingerprint,
} from "../packages/providers/src/lastfm-auth";
import { LastfmAuthorization } from "../apps/worker/src/lastfm-connection";
import {
  setupCookie,
  validSetupSession,
} from "../apps/worker/src/setup-session";
import worker, { type Env } from "../apps/worker/src/index";
import { createServices } from "../packages/providers/src/services";
const app = { api_key: "a".repeat(32), shared_secret: "b".repeat(32) };
const token = "c".repeat(32),
  session = "d".repeat(32),
  origin = "https://scrobbler.test";
function setup() {
  const store = new MemoryStore();
  let now = 1000000;
  const exchange = vi.fn(async () => ({
    ok: true as const,
    username: "listener",
    session_key: session,
  }));
  const auth = new LastfmAuthorization(
    store,
    { now: () => now, sleep: async () => {} },
    { LASTFM_API_KEY: app.api_key, LASTFM_SHARED_SECRET: app.shared_secret },
    exchange,
  );
  return {
    store,
    auth,
    exchange,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function start(auth: LastfmAuthorization) {
  const response = await auth.start(
    new Request(origin + "/api/v1/connections/lastfm/start", {
      method: "POST",
    }),
  );
  const body = (await response.json()) as { authorization_url: string };
  const url = new URL(body.authorization_url);
  const cb = new URL(url.searchParams.get("cb")!);
  cb.searchParams.set("token", token);
  return { url, cb, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}
it("validates app credentials and signs getSession correctly without putting the secret in the URL", async () => {
  expect(parseLastfmApp(app)).toEqual(app);
  expect(parseLastfmApp({ ...app, extra: true })).toBeNull();
  const network = vi.fn(async () =>
    Response.json({ session: { name: "listener", key: session } }),
  );
  expect(await exchangeLastfmToken(app, token, network)).toEqual({
    ok: true,
    username: "listener",
    session_key: session,
  });
  const [url, options] = network.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("https://ws.audioscrobbler.com/2.0/");
  expect(options.redirect).toBe("manual");
  const body = new URLSearchParams(String(options.body));
  expect(body.get("api_sig")).toBe(
    createHash("md5")
      .update(
        "api_key" +
          app.api_key +
          "methodauth.getSessiontoken" +
          token +
          app.shared_secret,
      )
      .digest("hex"),
  );
  expect(body.has("shared_secret")).toBe(false);
});
it("maps upstream failures without exposing response bodies or errors", async () => {
  for (const [error, code] of [
    [14, "lastfm_not_authorized"],
    [15, "lastfm_expired"],
    [13, "lastfm_invalid_application"],
    [29, "lastfm_unavailable"],
  ] as const) {
    expect(
      await exchangeLastfmToken(app, token, async () =>
        Response.json({ error, message: app.shared_secret }),
      ),
    ).toEqual({ ok: false, code });
  }
  expect(
    await exchangeLastfmToken(app, token, async () => {
      throw Error(app.shared_secret);
    }),
  ).toEqual({ ok: false, code: "lastfm_unavailable" });
  expect(
    await exchangeLastfmToken(
      app,
      token,
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://evil.test" },
        }),
    ),
  ).toEqual({ ok: false, code: "lastfm_unavailable" });
  expect(
    await exchangeLastfmToken(app, token, async () =>
      Response.json({ session: { name: "listener" } }),
    ),
  ).toEqual({ ok: false, code: "lastfm_invalid_response" });
});
it("binds callback to browser, origin and state; invalid callbacks do not consume or exchange", async () => {
  const { auth, exchange, store } = setup();
  const flow = await start(auth);
  expect(flow.url.origin).toBe("https://www.last.fm");
  const initial = await store.get("lastfm-auth:v1");
  for (const request of [
    new Request(flow.cb),
    new Request(flow.cb, {
      headers: { Cookie: "__Host-scrobbler-lastfm=wrong" },
    }),
    new Request(flow.cb.href.replace(origin, "https://other.test"), {
      headers: { Cookie: flow.cookie },
    }),
    new Request(flow.cb.href.replace("state=", "state=bad"), {
      headers: { Cookie: flow.cookie },
    }),
  ]) {
    expect((await auth.callback(request)).headers.get("location")).toBe(
      "/setup?lastfm=invalid_flow",
    );
  }
  expect(exchange).not.toHaveBeenCalled();
  expect(await store.get("lastfm-auth:v1")).toEqual(initial);
});
it("persists session on successful single-use callback, exposes only username and leaves ledger alone", async () => {
  const { auth, exchange, store } = setup();
  const flow = await start(auth);
  const request = () =>
    new Request(flow.cb, { headers: { Cookie: flow.cookie } });
  expect((await auth.callback(request())).headers.get("location")).toBe(
    "/setup?lastfm=connected",
  );
  expect((await auth.callback(request())).headers.get("location")).toBe(
    "/setup?lastfm=invalid_flow",
  );
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(await store.get("ledger:v1")).toBeNull();
  const status = await (await auth.status()).text();
  expect(status).toContain("listener");
  expect(status).not.toContain(session);
  expect(status).not.toContain(app.shared_secret);
});
it("expired and superseded callbacks cannot connect", async () => {
  const { auth, exchange, advance } = setup();
  const old = await start(auth);
  await start(auth);
  expect(
    (
      await auth.callback(
        new Request(old.cb, { headers: { Cookie: old.cookie } }),
      )
    ).headers.get("location"),
  ).toContain("invalid_flow");
  const flow = await start(auth);
  advance(600001);
  expect(
    (
      await auth.callback(
        new Request(flow.cb, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toContain("invalid_flow");
  expect(exchange).not.toHaveBeenCalled();
});
it("cancelled, changed-app and failed exchanges preserve the previous connection", async () => {
  const { auth, store, exchange } = setup();
  const old = { session_key: "old" };
  await store.put("lastfm-connection:v1", old);
  let flow = await start(auth);
  flow.cb.searchParams.delete("token");
  expect(
    (
      await auth.callback(
        new Request(flow.cb, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toContain("cancelled");
  flow = await start(auth);
  await store.put("lastfm-app:v1", { ...app, shared_secret: "e".repeat(32) });
  expect(
    (
      await auth.callback(
        new Request(flow.cb, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toContain("application_changed");
  expect(exchange).not.toHaveBeenCalled();
  flow = await start(auth);
  exchange.mockResolvedValue({
    ok: false,
    code: "lastfm_unavailable",
  } as never);
  expect(
    (
      await auth.callback(
        new Request(flow.cb, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toContain("lastfm_unavailable");
  expect(await store.get("lastfm-connection:v1")).toEqual(old);
});
it("reports save failure and consumes transaction before exchange", async () => {
  const { auth, store, exchange } = setup();
  const flow = await start(auth);
  const original = store.put.bind(store);
  vi.spyOn(store, "put").mockImplementation(async (k, v) => {
    if (k === "lastfm-connection:v1") throw Error("private");
    return original(k, v);
  });
  expect(
    (
      await auth.callback(
        new Request(flow.cb, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toContain("save_failed");
  expect((await store.get<{ used: boolean }>("lastfm-auth:v1"))?.used).toBe(
    true,
  );
  expect(exchange).toHaveBeenCalledTimes(1);
});
it("configuration validation preserves stored app; status reports credential changes as disconnected", async () => {
  const { auth, store } = setup();
  await store.put("lastfm-app:v1", app);
  await store.put("lastfm-connection:v1", {
    app_fingerprint: await fingerprint(app),
    username: "listener",
  });
  expect(
    (
      await auth.configure(
        new Request(origin, {
          method: "PUT",
          body: JSON.stringify({ ...app, password: "bad" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(await store.get("lastfm-app:v1")).toEqual(app);
  await auth.configure(
    new Request(origin, {
      method: "PUT",
      body: JSON.stringify({ ...app, shared_secret: "e".repeat(32) }),
    }),
  );
  expect(
    ((await (await auth.status()).json()) as { lastfm: { connected: boolean } })
      .lastfm.connected,
  ).toBe(false);
});
it("setup sessions reject tampering, expiry and secret rotation", async () => {
  const now = Date.now();
  const value = (await setupCookie("secret", now)).split(";")[0];
  const req = (cookie: string) =>
    new Request(origin, { headers: { Cookie: cookie } });
  expect(await validSetupSession(req(value), "secret", now)).toBe(true);
  expect(await validSetupSession(req(value + "x"), "secret", now)).toBe(false);
  expect(await validSetupSession(req(value), "rotated", now)).toBe(false);
  expect(await validSetupSession(req(value), "secret", now + 3600001)).toBe(
    false,
  );
});
it("cookie authentication is scoped to setup and protects mutations from cross-origin requests", async () => {
  const stub = vi.fn(async () => Response.json({ ok: true }));
  const env = {
    STATUS_AUTH_KEY: "secret",
    SCROBBLE_COORDINATOR: { idFromName: () => 1, get: () => ({ fetch: stub }) },
  } as unknown as Env;
  const cookie = (await setupCookie("secret")).split(";")[0];
  const run = (path: string, method = "GET", originHeader = origin) =>
    worker.fetch(
      new Request(origin + path, {
        method,
        headers: { Cookie: cookie, Origin: originHeader },
      }),
      env,
    );
  expect((await run("/api/v1/connections")).status).toBe(200);
  expect((await run("/api/v1/connections/lastfm/start", "POST")).status).toBe(
    200,
  );
  expect(
    (await run("/api/v1/connections/lastfm/start", "POST", "https://evil.test"))
      .status,
  ).toBe(401);
  expect((await run("/api/v1/recording")).status).toBe(200);
  expect((await run("/api/v1/recording/start", "POST")).status).toBe(200);
  expect(
    (await run("/api/v1/recording/pause", "POST", "https://evil.test")).status,
  ).toBe(401);
  expect((await run("/trigger", "POST")).status).toBe(401);
  expect((await run("/api/v1/profile", "PUT")).status).toBe(401);
  expect((await run("/internal/automatic", "POST")).status).toBe(404);
});
it("setup HTML uses CSP and contains no embedded runtime secrets", async () => {
  const res = await worker.fetch(new Request(origin + "/setup"), {
    STATUS_AUTH_KEY: "private-marker",
  } as Env);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(await res.text()).not.toContain("private-marker");
});
it("submission reads durable session after restart and never falls back across an app change", async () => {
  const store = new MemoryStore();
  await store.put("lastfm-app:v1", app);
  await store.put("lastfm-connection:v1", {
    api_key: app.api_key,
    app_fingerprint: await fingerprint(app),
    session_key: session,
    username: "listener",
  });
  const network = vi.fn(async () =>
    Response.json({
      scrobbles: {
        "@attr": { accepted: 1, ignored: 0 },
        scrobble: { ignoredMessage: { code: "0", "#text": "" } },
      },
    }),
  );
  const services = createServices(
    { get: async () => null, put: async () => {} },
    {
      LASTFM_API_KEY: "legacy",
      LASTFM_SHARED_SECRET: "legacy",
      LASTFM_SESSION_KEY: "legacy",
    },
    { credentialStore: store, fetch: network },
  );
  await services.submit([
    {
      event_id: "e",
      artist: "a",
      track: "t",
      album: "b",
      timestamp_iso: new Date().toISOString(),
    } as never,
  ]);
  const body = new URLSearchParams(
    String((network.mock.calls[0] as unknown as [string, RequestInit])[1].body),
  );
  expect(body.get("sk")).toBe(session);
  expect(body.get("api_key")).toBe(app.api_key);
  await store.put("lastfm-app:v1", { ...app, shared_secret: "e".repeat(32) });
  await expect(services.submit([])).rejects.toThrow("lastfm_not_connected");
  expect(network).toHaveBeenCalledTimes(1);
});

it("accepts opaque non-hex web tokens through callback and signs their exact value", async () => {
  const opaque = "Gz-_.+&=".repeat(4);
  const context = setup();
  const flow = await start(context.auth);
  flow.cb.searchParams.set("token", opaque);
  const result = await context.auth.callback(
    new Request(flow.cb, { headers: { cookie: flow.cookie } }),
  );
  expect(result.headers.get("location")).toContain("lastfm=connected");
  expect(context.exchange).toHaveBeenCalledWith(app, opaque);
  const network = vi.fn(async () =>
    Response.json({ session: { name: "listener", key: "Z".repeat(32) } }),
  );
  expect(await exchangeLastfmToken(app, opaque, network)).toEqual({
    ok: true,
    username: "listener",
    session_key: "Z".repeat(32),
  });
  const [, options] = network.mock.calls[0] as unknown as [string, RequestInit];
  const body = new URLSearchParams(String(options.body));
  expect(body.get("token")).toBe(opaque);
  expect(body.get("api_sig")).toBe(
    createHash("md5")
      .update(
        "api_key" +
          app.api_key +
          "methodauth.getSessiontoken" +
          opaque +
          app.shared_secret,
      )
      .digest("hex"),
  );
  for (const invalid of [
    "x".repeat(31),
    "x".repeat(33),
    "x".repeat(31) + "\n",
    "x".repeat(31) + " ",
  ]) {
    const fetcher = vi.fn();
    expect((await exchangeLastfmToken(app, invalid, fetcher)).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  }
});
