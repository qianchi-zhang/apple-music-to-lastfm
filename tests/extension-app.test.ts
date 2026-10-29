// @vitest-environment jsdom
// Historical Coral frontend regression suite. The default Emil interface has
// its own tests; this fixture intentionally remains coupled to src/app.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "../apps/browser-extension/src/theme";
import type { Runtime } from "../apps/browser-extension/src/extension-state";

const html = readFileSync(resolve("apps/browser-extension/coral.html"), "utf8");
const origin = "https://ams-" + "b".repeat(24) + ".preview.workers.dev";
const installation = {
  account: "a".repeat(32),
  name: "ams-" + "b".repeat(24),
  marker: "c".repeat(32),
  key: "d".repeat(64),
  origin,
};
const listeners: Array<{
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
}> = [];
const mediaListeners = new Set<() => void>();
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const element = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  vi.resetModules();
  mediaListeners.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  document.documentElement.style.removeProperty("color-scheme");
  const sourceDocument = new DOMParser().parseFromString(html, "text/html");
  document.body.replaceWith(document.importNode(sourceDocument.body, true));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  // The production entry installs these once per document. Remove them between
  // imports, just as closing an extension tab discards its event handlers.
  for (const target of [window as EventTarget, document as EventTarget]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation(
      (type, listener, options?) => {
        if (listener && (type === "focus" || type === "visibilitychange"))
          listeners.push({ target, type, listener });
        add(type, listener, options);
      },
    );
  }
});

afterEach(() => {
  for (const { target, type, listener } of listeners.splice(0))
    target.removeEventListener(type, listener);
  // Every app import receives its own fake media query. Clear its retained
  // callbacks when the simulated tab closes, alongside the real DOM handlers.
  mediaListeners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function launch(
  options: {
    installed?: boolean;
    enabled?: boolean;
    permission?: boolean;
    authorized?: boolean;
    appleConnected?: boolean;
    applicationConfigured?: boolean;
    savedTheme?: unknown;
    themeWriteFails?: boolean;
    systemDark?: boolean;
    compact?: boolean;
  } = {},
) {
  const fixture = {
    connections: {
      apple: { connected: options.appleConnected ?? true },
      lastfm: {
        connected: options.authorized ?? true,
        application_configured: options.applicationConfigured ?? true,
        username: "FixtureListener",
      },
    },
    runtime: {
      enabled: options.enabled ?? false,
      algorithm_version: "0.3.111",
      algorithm_sha256:
        "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
      last_run_iso: null,
      next_run_ms: null,
      pending_identity: 0,
      pending_submission: 0,
      stats: { total_scrobbled: 0 },
      records: [] as Runtime["records"],
    },
    startError: null as Error | null,
    startStatus: 200,
    startReadbackEnabled: true,
    pauseReadbackEnabled: false,
  };
  const requestPermission = vi.fn(async () => true);
  const containsPermission = vi.fn(async () => options.permission ?? true);
  const storageGet = vi.fn(async (key: string) => {
    if (key === THEME_STORAGE_KEY) return { [key]: options.savedTheme };
    if (key === "installation")
      return options.installed === false ? {} : { installation };
    return {};
  });
  const storageSet = vi.fn(async (value: Record<string, unknown>) => {
    if (options.themeWriteFails && Object.hasOwn(value, THEME_STORAGE_KEY))
      throw Error("synthetic-private-theme-write-failure");
  });
  let systemDark = options.systemDark ?? false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        if (query === "(prefers-color-scheme: dark)") return systemDark;
        if (/^\(max-width: (700|959)px\)$/.test(query))
          return options.compact ?? false;
        return false;
      },
      addEventListener(_type: string, listener: () => void) {
        if (query === "(prefers-color-scheme: dark)")
          mediaListeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        if (query === "(prefers-color-scheme: dark)")
          mediaListeners.delete(listener);
      },
    })),
  );
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
    permissions: { request: requestPermission, contains: containsPermission },
    tabs: { create: vi.fn(async () => ({})), query: vi.fn(async () => []) },
    scripting: { executeScript: vi.fn(async () => []) },
    runtime: { getURL: (path: string) => "chrome-extension://fixture/" + path },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  const network = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const destination = new URL(String(url));
      if (destination.origin !== origin)
        throw Error("Unexpected test destination");
      if (destination.pathname === "/health")
        return Response.json({
          version: "0.3.111",
          algorithm_sha256:
            "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
        });
      if (destination.pathname === "/api/v1/connections")
        return Response.json(fixture.connections);
      if (destination.pathname === "/api/v1/recording")
        return Response.json(fixture.runtime);
      if (
        destination.pathname === "/api/v1/connections/lastfm/application" &&
        init?.method === "PUT"
      ) {
        fixture.connections.lastfm.application_configured = true;
        return Response.json({ ok: true });
      }
      if (
        destination.pathname === "/api/v1/recording/start" &&
        init?.method === "POST"
      ) {
        if (fixture.startError) throw fixture.startError;
        if (fixture.startStatus !== 200)
          return Response.json(
            { error: "rate_limited" },
            { status: fixture.startStatus },
          );
        expect(JSON.parse(String(init.body))).toEqual({
          username: "FixtureListener",
        });
        const response = Response.json({ ...fixture.runtime, enabled: true });
        fixture.runtime.enabled = fixture.startReadbackEnabled;
        return response;
      }
      if (
        destination.pathname === "/api/v1/recording/pause" &&
        init?.method === "POST"
      ) {
        const response = Response.json({ ...fixture.runtime, enabled: false });
        fixture.runtime.enabled = fixture.pauseReadbackEnabled;
        return response;
      }
      throw Error("Unexpected fixture request");
    },
  );
  vi.stubGlobal("fetch", network);
  await import("../apps/browser-extension/src/app");
  await vi.waitFor(() =>
    expect(element("backend").textContent).toBe(
      options.installed === false ? "尚未安装" : origin,
    ),
  );
  if (options.installed !== false && options.permission !== false)
    await vi.waitFor(() =>
      expect(element("runtime").textContent).toBe(
        options.enabled ? "自动记录已开启" : "记录已暂停",
      ),
    );
  return {
    fixture,
    network,
    requestPermission,
    containsPermission,
    storageGet,
    storageSet,
    changeSystemTheme(dark: boolean) {
      systemDark = dark;
      for (const listener of mediaListeners) listener();
    },
  };
}

function confirmAccount() {
  expect(element("confirm").hidden).toBe(false);
  expect(button("start").disabled).toBe(true);
  input("account-confirmed").click();
  expect(button("start").disabled).toBe(false);
}

it("keeps recording actions unavailable before any installation or remote state exists", async () => {
  const h = await launch({ installed: false });
  expect(element("cloud").hidden).toBe(false);
  expect(element("confirm-step").hidden).toBe(false);
  expect(
    document.querySelector<HTMLButtonElement>('[data-step="confirm"]')!
      .disabled,
  ).toBe(true);
  expect(button("start").disabled).toBe(true);
  expect(button("pause").disabled).toBe(true);
  expect(h.network).not.toHaveBeenCalled();
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("never opens a permission prompt automatically on load or focus", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10000);
  const h = await launch({ permission: false });
  await vi.waitFor(() => expect(h.containsPermission).toHaveBeenCalledTimes(1));
  now.mockReturnValue(14000);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(h.containsPermission).toHaveBeenCalledTimes(2));
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.network).not.toHaveBeenCalled();
  expect(button("start").disabled).toBe(true);
});

it("shows invalid Last.fm input next to its step without making a write request", async () => {
  const h = await launch();
  document.querySelector<HTMLButtonElement>('[data-step="lastfm"]')!.click();
  input("lf-key").value = "not-an-api-key";
  input("lf-secret").value = "not-a-shared-secret";
  button("lf-save").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe(
      "请检查 Last.fm 应用配置",
    ),
  );
  expect(element("feedback").closest("section")?.id).toBe("lastfm");
  expect(element("feedback").hidden).toBe(false);
  expect(document.activeElement).toBe(element("feedback"));
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
  expect(button("lf-save").disabled).toBe(false);
});

it("restores an already-running installation directly to recent records with pause available", async () => {
  await launch({ enabled: true });
  await vi.waitFor(() => expect(element("records").hidden).toBe(false));
  expect(button("pause").disabled).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(element("connections").textContent).toContain("FixtureListener");
});

it("opens the next setup step from the persistent guide entry without changing service state", async () => {
  const h = await launch({ enabled: true });
  await vi.waitFor(() => expect(element("records").hidden).toBe(false));
  const guide = document.querySelector<HTMLAnchorElement>(
    'header [data-view="connections"][data-guide-entry]',
  )!;
  expect(
    Array.from(document.querySelectorAll("header nav [data-view]")).map(
      (link) => link.textContent?.trim(),
    ),
  ).toEqual(["连接向导", "最近记录", "设置"]);
  const requestCount = h.network.mock.calls.length;
  guide.click();
  expect(element("confirm").hidden).toBe(false);
  expect(document.activeElement).toBe(element("confirm-title"));
  document.querySelector<HTMLButtonElement>('[data-step="apple"]')!.click();
  expect(element("apple").hidden).toBe(false);
  document
    .querySelector<HTMLAnchorElement>('header nav [data-view="records"]')!
    .click();
  expect(element("records").hidden).toBe(false);
  guide.click();
  expect(element("confirm").hidden).toBe(false);
  expect(element("apple").hidden).toBe(true);
  expect(element("records").hidden).toBe(true);
  expect(document.activeElement).toBe(element("confirm-title"));
  expect(h.network).toHaveBeenCalledTimes(requestCount);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.storageSet).not.toHaveBeenCalled();
  expect(h.fixture.runtime.enabled).toBe(true);
});

it("shows the detailed credential guides expanded before setup begins", async () => {
  await launch({ installed: false });
  expect((element("cloud-installation") as HTMLDetailsElement).open).toBe(true);
  expect((element("cloud-help") as HTMLDetailsElement).open).toBe(true);
  expect(
    document.querySelector<HTMLDetailsElement>(".application-help")!.open,
  ).toBe(true);
  expect((element("lastfm-config") as HTMLDetailsElement).open).toBe(true);
  expect(button("copy-homepage").disabled).toBe(true);
});

it("closes the compact step picker after an allowed selection and focuses its guide without unlocking future steps", async () => {
  const h = await launch({ compact: true, appleConnected: false });
  const picker = element("setup-step-picker") as HTMLDetailsElement;
  const nextStep = document.querySelector<HTMLButtonElement>(
    '[data-step="lastfm"]',
  )!;
  const confirmStep = document.querySelector<HTMLButtonElement>(
    '[data-step="confirm"]',
  )!;
  expect(picker.open).toBe(false);
  expect(nextStep.disabled).toBe(false);
  expect(confirmStep.disabled).toBe(true);
  const requestCount = h.network.mock.calls.length;
  picker.open = true;
  nextStep.click();
  expect(picker.open).toBe(false);
  expect(element("lastfm").hidden).toBe(false);
  expect(document.activeElement).toBe(element("lastfm-title"));
  expect(confirmStep.disabled).toBe(true);
  expect(button("start").disabled).toBe(true);
  expect(h.network).toHaveBeenCalledTimes(requestCount);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("keeps completed installation and connection steps compact without authorizing any changes", async () => {
  const h = await launch();
  expect((element("cloud-installation") as HTMLDetailsElement).open).toBe(
    false,
  );
  expect(element("cloud-ready").hidden).toBe(false);
  expect((element("apple-reconnect") as HTMLDetailsElement).open).toBe(false);
  expect(element("apple-connected-note").hidden).toBe(false);
  expect(element("apple-description").textContent).toContain("连接已保存");
  expect(element("apple-description").textContent).toContain(
    "可继续连接 Last.fm",
  );
  expect(element("apple-description").textContent).not.toContain(
    "在浏览器登录 Apple Music",
  );
  expect(button("continue-apple").hidden).toBe(false);
  expect(button("continue-apple").classList.contains("primary")).toBe(true);
  expect((element("lastfm-config") as HTMLDetailsElement).open).toBe(false);
  expect((element("lastfm-reconnect") as HTMLDetailsElement).open).toBe(false);
  expect(element("cloud-installation").contains(input("token"))).toBe(true);
  expect(element("apple-reconnect").contains(button("apple-connect"))).toBe(
    true,
  );
  expect(
    element("lastfm-reconnect").contains(element("lastfm-authorize")),
  ).toBe(true);
  const requestCount = h.network.mock.calls.length;
  (element("cloud-installation") as HTMLDetailsElement).open = true;
  (element("apple-reconnect") as HTMLDetailsElement).open = true;
  (element("lastfm-reconnect") as HTMLDetailsElement).open = true;
  expect(h.network).toHaveBeenCalledTimes(requestCount);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
});

it("expands Apple connection instructions when the account still needs connecting", async () => {
  const h = await launch({ appleConnected: false });
  expect(element("apple").hidden).toBe(false);
  expect((element("apple-reconnect") as HTMLDetailsElement).open).toBe(true);
  expect(element("apple-connected-note").hidden).toBe(true);
  expect(element("apple-description").textContent).toContain(
    "在浏览器登录 Apple Music",
  );
  expect(button("continue-apple").hidden).toBe(true);
  expect(button("apple-connect").disabled).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("prioritizes Last.fm authorization while preserving an expanded configuration edit during refresh", async () => {
  const h = await launch({ authorized: false });
  expect(element("lastfm").hidden).toBe(false);
  const configuration = element("lastfm-config") as HTMLDetailsElement;
  expect(configuration.open).toBe(false);
  expect(element("lastfm-authorize").hidden).toBe(false);
  expect(button("console").disabled).toBe(false);
  configuration.open = true;
  input("lf-key").value = "e".repeat(32);
  input("lf-secret").value = "f".repeat(32);
  h.fixture.runtime.stats.total_scrobbled = 7;
  const readsBefore = h.network.mock.calls.length;
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(h.network.mock.calls.length).toBeGreaterThan(readsBefore),
  );
  await vi.waitFor(() => expect(element("submitted").textContent).toBe("7"));
  expect(configuration.open).toBe(true);
  expect(input("lf-key").value).toBe("e".repeat(32));
  expect(input("lf-secret").value).toBe("f".repeat(32));
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("moves focus from saved Last.fm application credentials to account authorization without starting recording", async () => {
  const h = await launch({ authorized: false, applicationConfigured: false });
  const configuration = element("lastfm-config") as HTMLDetailsElement;
  const authorization = element("lastfm-reconnect") as HTMLDetailsElement;
  expect(element("lastfm").hidden).toBe(false);
  expect(configuration.open).toBe(true);
  expect(authorization.open).toBe(false);
  expect(element("lastfm-authorize").hidden).toBe(true);
  input("lf-key").value = "e".repeat(32);
  input("lf-secret").value = "f".repeat(32);
  button("lf-save").focus();
  button("lf-save").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("应用配置已保存"),
  );
  expect(configuration.open).toBe(false);
  expect(authorization.open).toBe(true);
  expect(element("lastfm-authorize").hidden).toBe(false);
  expect(document.activeElement).toBe(authorization.querySelector("summary"));
  expect(input("lf-key").value).toBe("");
  expect(input("lf-secret").value).toBe("");
  expect(h.fixture.connections.lastfm.application_configured).toBe(true);
  expect(h.fixture.connections.lastfm.connected).toBe(false);
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
  const serviceWrites = h.network.mock.calls.filter(
    ([, init]) => init?.method && init.method !== "GET",
  );
  expect(serviceWrites).toHaveLength(1);
  expect(String(serviceWrites[0][0])).toBe(
    origin + "/api/v1/connections/lastfm/application",
  );
  expect(serviceWrites[0][1]?.method).toBe("PUT");
  expect(JSON.parse(String(serviceWrites[0][1]?.body))).toEqual({
    api_key: "e".repeat(32),
    shared_secret: "f".repeat(32),
  });
});

it("returns from settings to the listening ledger through the brand without a service mutation", async () => {
  const h = await launch({ enabled: true });
  document.querySelector<HTMLAnchorElement>('[data-view="settings"]')!.click();
  expect(element("settings").hidden).toBe(false);
  document.querySelector<HTMLAnchorElement>(".brand")!.click();
  expect(element("records").hidden).toBe(false);
  expect(element("settings").hidden).toBe(true);
  expect(
    document.querySelector<HTMLElement>("[data-coral-app]")!.dataset
      .currentView,
  ).toBe("records");
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("groups the ledger by supplied dates, keeps API order and labels an unknown date honestly", async () => {
  const h = await launch({ enabled: true });
  h.fixture.runtime.records = [
    {
      track: "Later song",
      artist: "Fixture artist",
      album: "Later album",
      status: "accepted",
      timestamp_iso: "2026-10-23T12:00:00Z",
    },
    {
      track: "Earlier song",
      artist: "Fixture artist",
      album: "Earlier album",
      status: "accepted",
      timestamp_iso: "2026-10-22T12:00:00Z",
    },
    {
      track: "Undated song",
      artist: "Fixture artist",
      status: "unknown",
      timestamp_iso: "invalid-date",
    },
  ];
  button("refresh").click();
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".record-row")).toHaveLength(3),
  );
  expect(
    Array.from(document.querySelectorAll(".record-name strong")).map(
      (node) => node.textContent,
    ),
  ).toEqual(["Later song", "Earlier song", "Undated song"]);
  expect(document.querySelectorAll(".record-day")).toHaveLength(3);
  expect(element("record-list").textContent).toContain("日期待确认");
  expect(
    document.querySelectorAll('.record-row[data-status="accepted"]'),
  ).toHaveLength(2);
  expect(element("record-list").textContent).toContain("状态待确认");
  expect(element("record-header").hidden).toBe(true);
});

it("requires explicit account confirmation before enabling start", async () => {
  const h = await launch();
  confirmAccount();
  expect(
    h.network.mock.calls.some(([url]) =>
      String(url).endsWith("/recording/start"),
    ),
  ).toBe(false);
  input("account-confirmed").click();
  expect(button("start").disabled).toBe(true);
});

it("checks authorization after returning to the tab without automatically starting recording", async () => {
  const h = await launch({ authorized: false });
  expect(element("lastfm").hidden).toBe(false);
  button("console").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("已打开个人后台"),
  );
  const readsBefore = h.network.mock.calls.length;
  h.fixture.connections.lastfm.connected = true;
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(element("confirm").hidden).toBe(false));
  expect(h.network.mock.calls.length).toBeGreaterThan(readsBefore);
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("keeps start unavailable after successful start and enables pause from the refreshed state", async () => {
  const h = await launch();
  confirmAccount();
  button("start").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("自动记录已开启"),
  );
  expect(element("records").hidden).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(button("start").hidden).toBe(true);
  expect(button("pause").disabled).toBe(false);
  expect(
    h.network.mock.calls.filter(([url]) =>
      String(url).endsWith("/recording/start"),
    ),
  ).toHaveLength(1);
});

it("does not re-enable start when the write outcome is unknown after timeout", async () => {
  const h = await launch();
  confirmAccount();
  const error = new Error("synthetic-private-timeout");
  error.name = "TimeoutError";
  h.fixture.startError = error;
  button("start").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("操作结果未确认"),
  );
  expect(button("start").disabled).toBe(true);
  expect(element("runtime").textContent).toBe("后台状态待检查");
  expect(document.body.textContent).not.toContain("synthetic-private-timeout");
  expect(button("recovery").textContent).toBe("先检查当前状态");
});

it("does not render arbitrary errors from browser operations", async () => {
  const h = await launch();
  h.requestPermission.mockRejectedValueOnce(Error("synthetic-private-token"));
  document.querySelector<HTMLAnchorElement>('[data-view="records"]')!.click();
  button("refresh").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("暂时无法完成操作"),
  );
  expect(document.body.textContent).not.toContain("synthetic-private-token");
  expect(element("feedback").closest("section")?.id).toBe("records");
});

it("clears explicit confirmation when a refreshed Last.fm account changes", async () => {
  const h = await launch();
  confirmAccount();
  h.fixture.connections.lastfm.username = "AnotherListener";
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(element("confirm-user").textContent).toBe("AnotherListener"),
  );
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("checks an uncertain start result without sending the start mutation again", async () => {
  const h = await launch();
  confirmAccount();
  const error = new Error("outcome unknown");
  error.name = "TimeoutError";
  h.fixture.startError = error;
  button("start").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("操作结果未确认"),
  );
  // The remote request may have succeeded despite the transport timeout.
  h.fixture.runtime.enabled = true;
  button("recovery").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("已检查后台状态"),
  );
  expect(element("runtime").textContent).toBe("自动记录已开启");
  expect(button("start").disabled).toBe(true);
  expect(button("pause").disabled).toBe(false);
  expect(
    h.network.mock.calls.filter(([url]) =>
      String(url).endsWith("/recording/start"),
    ),
  ).toHaveLength(1);
});

it("shows a clipboard failure locally instead of claiming the management key was copied", async () => {
  await launch();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
    new DOMException("synthetic clipboard failure", "NotAllowedError"),
  );
  document.querySelector<HTMLButtonElement>('[data-step="lastfm"]')!.click();
  button("copy-key-lastfm").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("浏览器未允许复制"),
  );
  expect(element("feedback").closest("section")?.id).toBe("lastfm");
  expect(element("feedback").textContent).not.toContain("已复制");
  expect(element("feedback").textContent).not.toContain(
    "synthetic clipboard failure",
  );
});

it.each([
  {
    source: "copy-callback",
    value: origin + "/api/v1/connections/lastfm/callback",
    stale: false,
  },
  { source: "copy-key-lastfm", value: installation.key, stale: true },
])(
  "retries only $source after clipboard failure, including stale=$stale, while preserving the guide and edits",
  async ({ source, value, stale }) => {
    const h = await launch({ authorized: false });
    const configuration = element("lastfm-config") as HTMLDetailsElement;
    configuration.open = true;
    input("lf-key").value = "e".repeat(32);
    input("lf-secret").value = "f".repeat(32);
    if (stale) {
      h.containsPermission.mockResolvedValue(false);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() =>
        expect(element("runtime").textContent).toBe("后台状态待检查"),
      );
    }
    const networkCount = h.network.mock.calls.length;
    const permissionCheckCount = h.containsPermission.mock.calls.length;
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(
        new DOMException("private-copy-retry-failure", "NotAllowedError"),
      );
    button(source).click();
    await vi.waitFor(() =>
      expect(button("recovery").textContent).toBe("重试复制"),
    );
    expect(element(source + "-status").textContent).not.toContain("已复制");
    expect(document.activeElement).toBe(element("feedback"));
    button("recovery").click();
    await vi.waitFor(() =>
      expect(element(source + "-status").textContent).toContain("已复制"),
    );
    expect(clipboard.mock.calls).toEqual([[value], [value]]);
    await vi.waitFor(() => expect(document.activeElement).toBe(button(source)));
    expect(element("lastfm").hidden).toBe(false);
    expect(element("settings").hidden).toBe(true);
    expect(configuration.open).toBe(true);
    expect(input("lf-key").value).toBe("e".repeat(32));
    expect(input("lf-secret").value).toBe("f".repeat(32));
    expect(input("account-confirmed").checked).toBe(false);
    expect(button("start").disabled).toBe(true);
    expect(h.network).toHaveBeenCalledTimes(networkCount);
    expect(h.containsPermission).toHaveBeenCalledTimes(permissionCheckCount);
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(installation.key);
    expect(document.body.textContent).not.toContain(
      "private-copy-retry-failure",
    );
  },
);

it("confirms a management-key copy only after success and clears stale success after a failed retry", async () => {
  const h = await launch({ authorized: false });
  let finishCopy!: () => void;
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockImplementationOnce(
      () => new Promise<void>((resolveCopy) => (finishCopy = resolveCopy)),
    );
  const status = element("copy-key-lastfm-status");
  expect(status.getAttribute("role")).toBe("status");
  button("copy-key-lastfm").click();
  expect(status.textContent).not.toContain("已复制");
  expect(clipboard).toHaveBeenCalledWith(installation.key);
  finishCopy();
  await vi.waitFor(() => expect(status.textContent).toContain("已复制"));
  clipboard.mockRejectedValueOnce(
    new DOMException("synthetic-private-clipboard-error", "NotAllowedError"),
  );
  button("copy-key-lastfm").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("浏览器未允许复制"),
  );
  expect(status.textContent).not.toContain("已复制");
  expect(document.body.textContent).not.toContain(installation.key);
  expect(document.body.textContent).not.toContain(
    "synthetic-private-clipboard-error",
  );
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("copies the exact homepage and callback addresses with local feedback and keeps the settings key private", async () => {
  const h = await launch({ authorized: false });
  const clipboard = vi.spyOn(navigator.clipboard, "writeText");
  const homepageStatus = element("copy-homepage-status");
  const callbackStatus = element("copy-callback-status");
  const settingsStatus = element("copy-key-status");
  expect(homepageStatus.getAttribute("role")).toBe("status");
  expect(callbackStatus.getAttribute("role")).toBe("status");
  expect(settingsStatus.getAttribute("role")).toBe("status");
  (element("lastfm-config") as HTMLDetailsElement).open = true;
  expect(element("application-homepage").textContent).toBe(origin);
  expect(button("copy-homepage").disabled).toBe(false);
  expect(button("copy-homepage").getAttribute("aria-label")).toBe(
    "复制应用主页",
  );
  button("copy-homepage").click();
  await vi.waitFor(() =>
    expect(homepageStatus.textContent).toContain("已复制"),
  );
  expect(clipboard).toHaveBeenLastCalledWith(origin);
  clipboard.mockRejectedValueOnce(
    new DOMException("private-homepage-failure", "NotAllowedError"),
  );
  button("copy-homepage").click();
  await vi.waitFor(() => expect(button("copy-homepage").disabled).toBe(false));
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("浏览器未允许复制"),
  );
  expect(homepageStatus.textContent).not.toContain("已复制");
  button("copy-callback").click();
  await vi.waitFor(() =>
    expect(callbackStatus.textContent).toContain("已复制"),
  );
  expect(clipboard).toHaveBeenLastCalledWith(
    origin + "/api/v1/connections/lastfm/callback",
  );
  expect(settingsStatus.textContent).not.toContain("已复制");
  clipboard.mockRejectedValueOnce(
    new DOMException("private-callback-failure", "NotAllowedError"),
  );
  button("copy-callback").click();
  await vi.waitFor(() => expect(button("copy-callback").disabled).toBe(false));
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("浏览器未允许复制"),
  );
  expect(callbackStatus.textContent).not.toContain("已复制");
  document.querySelector<HTMLAnchorElement>('[data-view="settings"]')!.click();
  button("copy-key").click();
  await vi.waitFor(() =>
    expect(settingsStatus.textContent).toContain("已复制"),
  );
  expect(clipboard).toHaveBeenLastCalledWith(installation.key);
  clipboard.mockRejectedValueOnce(
    new DOMException("private-settings-failure", "NotAllowedError"),
  );
  button("copy-key").click();
  await vi.waitFor(() => expect(button("copy-key").disabled).toBe(false));
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("浏览器未允许复制"),
  );
  expect(settingsStatus.textContent).not.toContain("已复制");
  expect(document.body.textContent).not.toContain(installation.key);
  expect(document.body.textContent).not.toContain("private-homepage-failure");
  expect(document.body.textContent).not.toContain("private-callback-failure");
  expect(document.body.textContent).not.toContain("private-settings-failure");
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("uses the latest paused state instead of claiming that a concurrent start is still active", async () => {
  const h = await launch();
  confirmAccount();
  h.fixture.startReadbackEnabled = false;
  button("start").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("已读取最新运行状态"),
  );
  expect(element("runtime").textContent).toBe("记录已暂停");
  expect(button("pause").disabled).toBe(true);
  expect(element("feedback-detail").textContent).toContain("后台目前显示暂停");
});

it("uses the latest active state instead of claiming that a concurrent pause is still effective", async () => {
  const h = await launch({ enabled: true });
  h.fixture.pauseReadbackEnabled = true;
  button("pause").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("已读取最新运行状态"),
  );
  expect(element("runtime").textContent).toBe("自动记录已开启");
  expect(button("pause").disabled).toBe(false);
  expect(element("feedback-detail").textContent).toContain(
    "后台目前仍显示开启",
  );
});

it("invalidates previously read state after access is removed without prompting for new permission", async () => {
  const h = await launch({ enabled: true });
  const readsBefore = h.network.mock.calls.length;
  h.containsPermission.mockResolvedValue(false);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(element("runtime").textContent).toBe("后台状态待检查"),
  );
  expect(button("start").disabled).toBe(true);
  expect(button("pause").disabled).toBe(true);
  expect(h.network.mock.calls).toHaveLength(readsBefore);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("checks status after a rate-limited start instead of repeating the mutation or reporting an account change", async () => {
  const h = await launch();
  confirmAccount();
  h.fixture.startStatus = 429;
  button("start").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe(
      "服务暂时限制了请求次数",
    ),
  );
  expect(button("start").disabled).toBe(true);
  expect(button("recovery").textContent).toBe("稍后重试");
  button("recovery").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("已检查当前状态"),
  );
  expect(element("runtime").textContent).toBe("记录已暂停");
  expect(
    h.network.mock.calls.filter(([url]) =>
      String(url).endsWith("/recording/start"),
    ),
  ).toHaveLength(1);
  expect(element("feedback-title").textContent).not.toContain("账户已变化");
});

it("clears the previous account confirmation when reopening authorization and checks immediately on return", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10000);
  const h = await launch();
  confirmAccount();
  document.querySelector<HTMLButtonElement>('[data-step="lastfm"]')!.click();
  button("console").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("已打开个人后台"),
  );
  expect(input("account-confirmed").checked).toBe(false);
  const checksBefore = h.containsPermission.mock.calls.length;
  // No clock advance: launching authorization resets the focus throttle.
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(element("confirm").hidden).toBe(false));
  expect(h.containsPermission.mock.calls.length).toBeGreaterThan(checksBefore);
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
});

const appearance = (value: string) =>
  document.querySelector<HTMLInputElement>(
    'input[name="appearance"][value="' + value + '"]',
  )!;

it("restores a saved dark preference in the real app without starting or modifying installation", async () => {
  const h = await launch({ savedTheme: "dark" });
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe("深色外观"),
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(appearance("dark").checked).toBe(true);
  expect(h.storageGet).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  expect(h.storageGet).toHaveBeenCalledWith("installation");
  expect(h.storageSet).not.toHaveBeenCalled();
  expect(element("backend").textContent).toBe(origin);
  expect(input("account-confirmed").checked).toBe(false);
  expect(button("start").disabled).toBe(true);
  expect(
    h.network.mock.calls.every(
      ([, init]) => !init?.method || init.method === "GET",
    ),
  ).toBe(true);
});

it("changes appearance using its separate storage key without disturbing the confirmed account or requesting service writes", async () => {
  const h = await launch();
  confirmAccount();
  const readsBefore = h.network.mock.calls.length;
  appearance("dark").click();
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe("深色外观"),
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.dataset.themePreference).toBe("dark");
  appearance("light").click();
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe("浅色外观"),
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(h.storageSet.mock.calls).toEqual([
    [{ [THEME_STORAGE_KEY]: "dark" }],
    [{ [THEME_STORAGE_KEY]: "light" }],
  ]);
  expect(input("account-confirmed").checked).toBe(true);
  expect(button("start").disabled).toBe(false);
  expect(element("confirm-user").textContent).toBe("FixtureListener");
  expect(element("backend").textContent).toBe(origin);
  expect(h.network.mock.calls).toHaveLength(readsBefore);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("follows system changes only when the system radio is selected", async () => {
  const h = await launch({ systemDark: true });
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe("跟随系统 · 深色"),
  );
  expect(appearance("system").checked).toBe(true);
  h.changeSystemTheme(false);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(element("theme-status").textContent).toBe("跟随系统 · 浅色");
  appearance("dark").click();
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe("深色外观"),
  );
  h.changeSystemTheme(true);
  h.changeSystemTheme(false);
  expect(document.documentElement.dataset.theme).toBe("dark");
  appearance("system").click();
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe("跟随系统 · 浅色"),
  );
  h.changeSystemTheme(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("keeps a theme choice effective for this page after storage failure without blocking account actions", async () => {
  const h = await launch({ themeWriteFails: true });
  confirmAccount();
  appearance("dark").click();
  await vi.waitFor(() =>
    expect(element("theme-status").textContent).toBe(
      "外观仅在本页生效，偏好未能保存。",
    ),
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(appearance("dark").checked).toBe(true);
  expect(input("account-confirmed").checked).toBe(true);
  expect(button("start").disabled).toBe(false);
  expect(document.body.textContent).not.toContain(
    "synthetic-private-theme-write-failure",
  );
  button("start").click();
  await vi.waitFor(() =>
    expect(element("feedback-title").textContent).toBe("自动记录已开启"),
  );
  expect(button("pause").disabled).toBe(false);
  expect(h.storageSet.mock.calls).toEqual([[{ [THEME_STORAGE_KEY]: "dark" }]]);
});

it("opens permission instructions from Cloudflare recovery without retrying deployment", async () => {
  const h = await launch({ installed: false });
  h.network
    .mockResolvedValueOnce(
      Response.json({ success: true, result: { status: "active" } }),
    )
    .mockResolvedValueOnce(
      Response.json(
        { success: false, errors: [{ message: "Forbidden" }] },
        { status: 403 },
      ),
    );
  const help = element("cloud-help") as HTMLDetailsElement;
  // Recovery must reopen the guide even after a user has collapsed it.
  help.open = false;
  help.scrollIntoView = vi.fn();
  input("token").value = "A".repeat(40);
  button("accounts").click();
  await vi.waitFor(() =>
    expect(button("recovery").textContent).toBe("检查 Token 账户权限"),
  );
  expect(help.open).toBe(false);
  const requestCount = h.network.mock.calls.length;
  button("recovery").click();
  expect(help.open).toBe(true);
  expect(help.scrollIntoView).toHaveBeenCalled();
  expect(h.network).toHaveBeenCalledTimes(requestCount);
  expect(element("cloud").hidden).toBe(false);
});
