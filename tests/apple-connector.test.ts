import { it, expect, vi, afterEach } from "vitest";
import {
  captureAppleCredentials,
  inspectAppleConnection,
} from "../apps/browser-extension/src/capture";
import {
  backendOrigin,
  connectApple,
  isAppleTab,
} from "../apps/browser-extension/src/connection";
import { verifyAppleAccess } from "../packages/providers/src/verify-apple";
import { parseAppleCredentials } from "../packages/contracts/src/apple-credentials";
import { Application } from "../apps/worker/src/application";
import { MemoryStore } from "../packages/storage/src/index";
import { createServices } from "../packages/providers/src/services";
const credentials = {
  apple_dev_token: "test-developer",
  apple_user_token: "test-user",
};
afterEach(() => vi.unstubAllGlobals());
it("only reads MusicKit from the exact Apple origin after explicit invocation", () => {
  const getInstance = vi.fn(() => ({
    isAuthorized: true,
    developerToken: credentials.apple_dev_token,
    musicUserToken: credentials.apple_user_token,
  }));
  vi.stubGlobal("window", { MusicKit: { getInstance } });
  vi.stubGlobal("location", {
    origin: "https://music.apple.com.attacker.test",
  });
  expect(captureAppleCredentials()).toEqual({ error: "wrong_tab" });
  expect(getInstance).not.toHaveBeenCalled();
  vi.stubGlobal("location", { origin: "https://music.apple.com" });
  expect(captureAppleCredentials()).toEqual({ credentials });
});
it("missing kit, signed-out and unavailable credentials have actionable distinct results", () => {
  vi.stubGlobal("location", { origin: "https://music.apple.com" });
  vi.stubGlobal("window", {});
  expect(captureAppleCredentials()).toEqual({ error: "not_ready" });
  vi.stubGlobal("window", {
    MusicKit: { getInstance: () => ({ isAuthorized: false }) },
  });
  expect(captureAppleCredentials()).toEqual({ error: "not_signed_in" });
  vi.stubGlobal("window", {
    MusicKit: { getInstance: () => ({ isAuthorized: true }) },
  });
  expect(captureAppleCredentials()).toEqual({ error: "tokens_unavailable" });
});
it("rejects insecure, embedded-credential and ambiguous destinations", () => {
  for (const value of [
    "http://example.test",
    "https://a:b@example.test",
    "https://example.test/path",
    "https://example.test/?key=x",
    "https://example.test/#x",
    "https://example.test:444",
    "https://music.apple.com",
  ])
    expect(() => backendOrigin(value)).toThrow();
  expect(backendOrigin("https://my-worker.workers.dev/")).toBe(
    "https://my-worker.workers.dev",
  );
  expect(isAppleTab("https://music.apple.com/us/home")).toBe(true);
  expect(isAppleTab("https://music.apple.com.attacker.test")).toBe(false);
});
it("sends only to the explicitly selected origin, does not follow redirects or attach cookies", async () => {
  const request = vi.fn(async () =>
    Response.json({ ok: true, connected: true, verified: true }),
  );
  await connectApple("https://mine.workers.dev", "admin", credentials, request);
  const [url, options] = request.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("https://mine.workers.dev/api/v1/connections/apple");
  expect(options).toMatchObject({
    redirect: "error",
    credentials: "omit",
    method: "POST",
  });
  expect(options.headers).toHaveProperty("x-ascrobble-auth", "admin");
  expect(JSON.parse(String(options.body))).toEqual(credentials);
});
it("reports HTTP and transport failures without displaying remote content or secrets", async () => {
  for (const [status, body, code] of [
    [401, {}, "invalid_key"],
    [404, {}, "backend_upgrade"],
    [422, { error: "apple_rejected" }, "apple_rejected"],
    [400, { error: "apple_rejected" }, "apple_rejected"],
    [502, { error: "apple_unavailable" }, "apple_unavailable"],
    [502, { error: "apple_invalid_response" }, "apple_invalid_response"],
    [400, { error: "invalid_credentials" }, "invalid_credentials"],
    [503, { error: "save_failed" }, "save_failed"],
    [429, { error: "sensitive upstream detail" }, "http_429"],
    [502, { error: "sensitive upstream detail" }, "apple_unavailable"],
    [502, {}, "apple_unavailable"],
    [200, { ok: true }, "backend_error"],
  ] as const) {
    const failure = await connectApple(
      "https://mine.test",
      "admin",
      credentials,
      async () => Response.json(body, { status }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(code);
    expect((failure as Error).message).not.toContain(
      "sensitive upstream detail",
    );
  }
  await expect(
    connectApple("https://mine.test", "admin", credentials, async () => {
      throw Error("sensitive upstream detail");
    }),
  ).rejects.toThrow("network_error");
});
it("validates only recent-track read access and does not accept malformed responses", async () => {
  for (const [status, body, ok] of [
    [200, { data: [] }, true],
    [200, { data: {} }, false],
    [401, {}, false],
    [403, {}, false],
    [429, {}, false],
  ] as const) {
    const request = vi.fn(async () => Response.json(body, { status }));
    expect((await verifyAppleAccess(credentials, request)).ok).toBe(ok);
    expect(String((request.mock.calls[0] as unknown as [string])[0])).toContain(
      "/me/recent/played/tracks",
    );
  }
});
it("rejects excessive, unknown or header-injecting credentials", () => {
  expect(parseAppleCredentials(credentials)).toEqual(credentials);
  for (const value of [
    { ...credentials, password: "no" },
    { ...credentials, apple_user_token: "a\nb" },
    { ...credentials, apple_dev_token: "x".repeat(16001) },
    null,
  ])
    expect(parseAppleCredentials(value)).toBeNull();
});
it("rejects Apple redirects without forwarding tokens and logs only fixed diagnostic fields", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://untrusted.test/" },
        }),
    );
    expect(await verifyAppleAccess(credentials, request)).toEqual({
      ok: false,
      code: "apple_unavailable",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      (request.mock.calls[0] as unknown as [string, RequestInit])[1].redirect,
    ).toBe("manual");
    await verifyAppleAccess(credentials, async () => {
      throw Error(credentials.apple_user_token);
    });
    expect(log.mock.calls).toEqual([
      ["apple_connection_verification", { phase: "http", status: 307 }],
      [
        "apple_connection_verification",
        { phase: "transport_or_parse", kind: "network" },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});
function setup() {
  const store = new MemoryStore();
  const services = {
    recent: vi.fn(async () => []),
    resolve: vi.fn(),
    submit: vi.fn(),
    verifyApple: vi.fn(async () => ({ ok: true })),
  };
  const app = new Application({
    store,
    services,
    clock: { now: () => 0, sleep: async () => {} },
  });
  return { store, services, app };
}
const request = () =>
  new Request("https://mine.test/api/v1/connections/apple", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
it("persists a verified pair atomically without calling scrobble or changing ledger", async () => {
  const { store, services, app } = setup();
  const put = vi.spyOn(store, "put");
  expect((await app.handle(request())).status).toBe(200);
  expect(put).toHaveBeenCalledTimes(1);
  expect(await store.get("apple-connection:v1")).toEqual(credentials);
  expect(services.submit).not.toHaveBeenCalled();
  expect(services.recent).not.toHaveBeenCalled();
});
it("rejected or unavailable verification preserves old credentials", async () => {
  const { store, services, app } = setup();
  await store.put("apple-connection:v1", { old: true });
  services.verifyApple.mockResolvedValue({ ok: false });
  expect((await app.handle(request())).status).toBe(502);
  expect(await store.get("apple-connection:v1")).toEqual({ old: true });
  services.verifyApple.mockRejectedValue(Error("sensitive detail"));
  const response = await app.handle(request());
  expect(await response.text()).not.toContain("sensitive");
});
it("save failure is reported instead of claiming connected", async () => {
  const { store, app } = setup();
  vi.spyOn(store, "put").mockRejectedValue(Error("private storage detail"));
  const response = await app.handle(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "save_failed" });
});
it("provider reads connector credentials after restart instead of stale legacy KV", async () => {
  const store = new MemoryStore();
  const dev =
    "eyJhbGciOiJIUzI1NiJ9." +
    Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url") +
    ".test";
  await store.put("apple-connection:v1", {
    apple_dev_token: dev,
    apple_user_token: "new-user",
  });
  const network = vi.fn(async () => Response.json({ data: [] }));
  const services = createServices(
    { get: async () => "legacy", put: async () => {} },
    { LASTFM_API_KEY: "", LASTFM_SHARED_SECRET: "", LASTFM_SESSION_KEY: "" },
    { credentialStore: store, fetch: network },
  );
  await services.recent();
  const headers = (network.mock.calls[0] as unknown as [string, RequestInit])[1]
    .headers;
  expect(headers).toHaveProperty("Music-User-Token", "new-user");
  expect(headers).toHaveProperty("Authorization", "Bearer " + dev);
});
it("malformed JSON never echoes submitted credential text", async () => {
  const { app } = setup();
  const response = await app.handle(
    new Request("https://mine.test/api/v1/connections/apple", {
      method: "POST",
      body: '{"apple_user_token":"sensitive-synthetic-value"',
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("sensitive-synthetic-value");
});
it("legacy token updates remain effective after connecting through the extension", async () => {
  const { store, services } = setup();
  await store.put("apple-connection:v1", credentials);
  const app = new Application({
    store,
    services,
    kv: { get: async () => null, put: async () => {} },
    clock: { now: () => 0, sleep: async () => {} },
  });
  expect(
    (
      await app.handle(
        new Request("https://mine.test/update-tokens", {
          method: "POST",
          body: JSON.stringify({ apple_user_token: "replacement" }),
        }),
      )
    ).status,
  ).toBe(200);
  expect(await store.get("apple-connection:v1")).toEqual({
    ...credentials,
    apple_user_token: "replacement",
  });
});

it("readiness probe never returns token values", () => {
  vi.stubGlobal("location", { origin: "https://music.apple.com" });
  vi.stubGlobal("window", {
    MusicKit: {
      getInstance: () => ({
        isAuthorized: true,
        developerToken: "sensitive-dev",
        musicUserToken: "sensitive-user",
      }),
    },
  });
  expect(inspectAppleConnection()).toEqual({ ready: true });
});
