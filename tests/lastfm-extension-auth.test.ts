import { expect, it, vi } from "vitest";
import { MemoryStore } from "../packages/storage/src/index";
import {
  LastfmAuthorization,
  lastfmExtensionResultPage,
  lastfmExtensionRoutes as routes,
} from "../apps/worker/src/lastfm-connection";
import worker, { type Env } from "../apps/worker/src/index";
import productionWorker from "../apps/worker/src/production-entry";
import { setupCookie } from "../apps/worker/src/setup-session";

const origin = "https://scrobbler.test";
const app = { api_key: "a".repeat(32), shared_secret: "b".repeat(32) };
const token = "t".repeat(32),
  session = "s".repeat(32);
function setup() {
  const store = new MemoryStore();
  let now = 1000000;
  const exchange = vi.fn(async () => ({
    ok: true as const,
    username: "FixtureUser",
    session_key: session,
  }));
  const auth = new LastfmAuthorization(
    store,
    { now: () => now, sleep: async () => {} },
    { LASTFM_API_KEY: app.api_key, LASTFM_SHARED_SECRET: app.shared_secret },
    exchange,
  );
  const begin = async () => {
    const response = await auth.start(
      new Request(origin + routes.start, { method: "POST" }),
      "extension",
    );
    const body = (await response.json()) as {
      browser_url: string;
      callback_url: string;
    };
    return { response, body, browser: new URL(body.browser_url) };
  };
  const navigate = async () => {
    const flow = await begin();
    const response = await auth.authorizeExtension(new Request(flow.browser));
    const official = new URL(response.headers.get("location")!);
    const callback = new URL(official.searchParams.get("cb")!);
    callback.searchParams.set("token", token);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { ...flow, navigation: response, official, callback, cookie };
  };
  return {
    store,
    auth,
    exchange,
    begin,
    navigate,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("authenticates the extension start with the management header and never with a setup cookie", async () => {
  for (const entry of [worker, productionWorker]) {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const env = {
      STATUS_AUTH_KEY: "management-test",
      SCROBBLE_COORDINATOR: {
        idFromName: () => 1,
        get: () => ({ fetch: dispatch }),
      },
    } as unknown as Env;
    const cookie = (await setupCookie("management-test")).split(";")[0];
    const unauthorizedHeaders: Record<string, string>[] = [
      {},
      { Cookie: cookie, Origin: origin },
      { Cookie: cookie, Origin: "https://evil.test" },
    ];
    for (const headers of unauthorizedHeaders) {
      const response = await entry.fetch(
        new Request(origin + routes.start, { method: "POST", headers }),
        env,
      );
      expect(response.status).toBe(401);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (
        await entry.fetch(
          new Request(origin + routes.start, {
            method: "POST",
            headers: {
              "x-ascrobble-auth": "management-test",
              Origin: "chrome-extension://fixture",
            },
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  }
});

it("creates a bounded same-origin browser bootstrap with no cookies or credentials in the JSON response", async () => {
  const x = setup(),
    flow = await x.begin();
  expect(Object.keys(flow.body).sort()).toEqual([
    "browser_url",
    "callback_url",
  ]);
  expect(flow.browser.origin).toBe(origin);
  expect(flow.browser.pathname).toBe(routes.authorize);
  expect(flow.browser.searchParams.get("flow")).toMatch(/^[a-f0-9]{64}$/);
  expect(flow.body.callback_url).toBe(origin + routes.result);
  expect(flow.response.headers.has("set-cookie")).toBe(false);
  expect(flow.response.headers.get("cache-control")).toBe("no-store");
  const text = JSON.stringify(flow.body);
  for (const secret of [
    app.api_key,
    app.shared_secret,
    token,
    session,
    "/setup",
  ])
    expect(text).not.toContain(secret);
  expect(x.exchange).not.toHaveBeenCalled();
});

it("sets the callback cookie during the one-time first-party redirect to the fixed official origin", async () => {
  const x = setup(),
    flow = await x.begin();
  flow.browser.searchParams.set("return_url", "https://evil.test/");
  const response = await x.auth.authorizeExtension(new Request(flow.browser));
  expect(response.status).toBe(303);
  const official = new URL(response.headers.get("location")!);
  expect(official.origin).toBe("https://www.last.fm");
  expect(official.pathname).toBe("/api/auth/");
  expect(official.searchParams.get("api_key")).toBe(app.api_key);
  const cb = new URL(official.searchParams.get("cb")!);
  expect(cb.origin).toBe(origin);
  expect(cb.pathname).toBe("/api/v1/connections/lastfm/callback");
  expect(cb.searchParams.get("mode")).toBe("extension");
  expect(cb.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
  expect(official.href).not.toContain("evil.test");
  expect(response.headers.get("set-cookie")).toMatch(
    /; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/,
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(
    (await x.auth.authorizeExtension(new Request(flow.browser))).headers.get(
      "location",
    ),
  ).toBe(routes.result + "?result=invalid_flow");
});

it("does not consume or exchange on forged bootstrap requests", async () => {
  const x = setup(),
    flow = await x.begin();
  const before = await x.store.get("lastfm-auth:v1");
  const duplicates = new URL(flow.browser);
  duplicates.searchParams.append("flow", duplicates.searchParams.get("flow")!);
  for (const url of [
    origin + routes.authorize,
    flow.browser.href.replace("flow=", "flow=bad"),
    flow.browser.href.replace(origin, "https://evil.test"),
    duplicates.href,
  ]) {
    expect(
      (await x.auth.authorizeExtension(new Request(url))).headers.get(
        "location",
      ),
    ).toBe(routes.result + "?result=invalid_flow");
  }
  expect(await x.store.get("lastfm-auth:v1")).toEqual(before);
  expect(x.exchange).not.toHaveBeenCalled();
});

it("rejects expired, superseded and changed-application bootstrap links", async () => {
  const x = setup(),
    old = await x.begin();
  let flow = await x.begin();
  expect(
    (await x.auth.authorizeExtension(new Request(old.browser))).headers.get(
      "location",
    ),
  ).toContain("invalid_flow");
  x.advance(600001);
  expect(
    (await x.auth.authorizeExtension(new Request(flow.browser))).headers.get(
      "location",
    ),
  ).toContain("invalid_flow");
  flow = await x.begin();
  await x.store.put("lastfm-app:v1", { ...app, shared_secret: "e".repeat(32) });
  expect(
    (await x.auth.authorizeExtension(new Request(flow.browser))).headers.get(
      "location",
    ),
  ).toContain("application_changed");
  expect(x.exchange).not.toHaveBeenCalled();
});

it("requires the bootstrap, matching browser cookie, state, origin and extension mode before consuming a callback", async () => {
  const x = setup();
  await x.begin();
  const tx = await x.store.get<any>("lastfm-auth:v1");
  const premature = new URL(origin + "/api/v1/connections/lastfm/callback");
  premature.searchParams.set("state", tx.state);
  premature.searchParams.set("mode", "extension");
  premature.searchParams.set("token", token);
  expect(
    (
      await x.auth.callback(
        new Request(premature, {
          headers: { Cookie: "__Host-scrobbler-lastfm=" + tx.browser },
        }),
      )
    ).headers.get("location"),
  ).toContain("invalid_flow");
  const flow = await x.navigate(),
    before = await x.store.get("lastfm-auth:v1");
  const duplicates = new URL(flow.callback);
  duplicates.searchParams.append(
    "state",
    duplicates.searchParams.get("state")!,
  );
  for (const [url, cookie] of [
    [flow.callback.href, ""],
    [flow.callback.href, "__Host-scrobbler-lastfm=wrong"],
    [flow.callback.href.replace(origin, "https://evil.test"), flow.cookie],
    [flow.callback.href.replace("state=", "state=bad"), flow.cookie],
    [flow.callback.href.replace("mode=extension", "mode=web"), flow.cookie],
    [duplicates.href, flow.cookie],
  ]) {
    const response = await x.auth.callback(
      new Request(url, { headers: { Cookie: cookie } }),
    );
    expect(response.headers.get("location")).toContain("invalid_flow");
  }
  expect(await x.store.get("lastfm-auth:v1")).toEqual(before);
  expect(x.exchange).not.toHaveBeenCalled();
});

it("completes once on a minimal extension result page and only status exposes the verified username", async () => {
  const x = setup(),
    flow = await x.navigate();
  const request = () =>
    new Request(flow.callback, { headers: { Cookie: flow.cookie } });
  const response = await x.auth.callback(request());
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(
    routes.result + "?result=connected",
  );
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await x.auth.callback(request())).headers.get("location")).toBe(
    routes.result + "?result=invalid_flow",
  );
  expect(x.exchange).toHaveBeenCalledTimes(1);
  expect(x.exchange).toHaveBeenCalledWith(app, token);
  const status = await (await x.auth.status()).text();
  expect(status).toContain('"connected":true');
  expect(status).toContain("FixtureUser");
  expect(await x.store.get("ledger:v1")).toBeNull();
  for (const secret of [session, app.api_key, app.shared_secret, token])
    expect(status).not.toContain(secret);
});

it("returns cancellation, application changes and exchange failures to the extension while preserving an old connection", async () => {
  const x = setup(),
    previous = { session_key: "previous" };
  await x.store.put("lastfm-connection:v1", previous);
  let flow = await x.navigate();
  flow.callback.searchParams.delete("token");
  expect(
    (
      await x.auth.callback(
        new Request(flow.callback, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toBe(routes.result + "?result=cancelled");
  expect(x.exchange).not.toHaveBeenCalled();
  flow = await x.navigate();
  await x.store.put("lastfm-app:v1", { ...app, shared_secret: "e".repeat(32) });
  expect(
    (
      await x.auth.callback(
        new Request(flow.callback, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toBe(routes.result + "?result=application_changed");
  expect(x.exchange).not.toHaveBeenCalled();
  flow = await x.navigate();
  x.exchange.mockResolvedValue({
    ok: false,
    code: "lastfm_unavailable",
  } as never);
  expect(
    (
      await x.auth.callback(
        new Request(flow.callback, { headers: { Cookie: flow.cookie } }),
      )
    ).headers.get("location"),
  ).toBe(routes.result + "?result=lastfm_unavailable");
  expect(await x.store.get("lastfm-connection:v1")).toEqual(previous);
});

it("serves a static escaped fixed-code completion page with no manager, tokens or navigation scripts", async () => {
  for (const candidate of [
    "connected",
    "cancelled",
    "<script>alert(1)</script>",
    "__proto__",
  ]) {
    const url = new URL(origin + routes.result);
    url.searchParams.set("result", candidate);
    url.searchParams.set("token", token);
    const response = lastfmExtensionResultPage(new Request(url));
    const html = await response.text();
    expect(html).toContain(
      'data-lastfm-result="' +
        (["connected", "cancelled"].includes(candidate)
          ? candidate
          : "invalid_flow") +
        '"',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("/setup");
    expect(html).not.toContain(token);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

it("exposes only public completion/one-time navigation routes and advertises the extension capability", async () => {
  for (const entry of [worker, productionWorker]) {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const env = {
      STATUS_AUTH_KEY: "management-test",
      SCROBBLE_COORDINATOR: {
        idFromName: () => 1,
        get: () => ({ fetch: dispatch }),
      },
    } as unknown as Env;
    const health = (await (
      await entry.fetch(new Request(origin + "/health"), env)
    ).json()) as any;
    expect(health.capabilities).toEqual(
      entry === productionWorker
        ? {
            lastfm_extension_auth: true,
            apple_source_artwork: true,
            apple_artwork_diagnostics: true,
            apple_artwork_runtime: "workerd-manual-v1",
            recording_diagnostics: true,
          }
        : { lastfm_extension_auth: true },
    );
    expect(
      (
        await entry.fetch(
          new Request(origin + routes.result + "?result=connected"),
          env,
        )
      ).status,
    ).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (
        await entry.fetch(
          new Request(origin + routes.authorize + "?flow=invalid"),
          env,
        )
      ).status,
    ).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (
        await entry.fetch(
          new Request(origin + routes.authorize, { method: "POST" }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (await entry.fetch(new Request(origin + routes.start), env)).status,
    ).toBe(401);
  }
});
