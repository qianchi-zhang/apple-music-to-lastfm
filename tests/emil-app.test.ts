// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Runtime } from "../apps/browser-extension/src/extension-state";
import { THEME_STORAGE_KEY } from "../apps/browser-extension/src/theme";
import { ARTWORK_CACHE_KEY } from "../apps/browser-extension/src/emil-artwork-cache";
import { previousAlgorithm } from "../apps/browser-extension/src/algorithm-release";

const html = readFileSync(resolve("apps/browser-extension/emil.html"), "utf8");
const origin = "https://ams-" + "b".repeat(24) + ".preview.workers.dev";
const installation = {
  account: "a".repeat(32),
  name: "ams-" + "b".repeat(24),
  marker: "c".repeat(32),
  key: "d".repeat(64),
  origin,
};
const authorizationBrowserUrl =
  origin +
  "/api/v1/connections/lastfm/extension/authorize?flow=" +
  "e".repeat(64);
const authorizationCallbackUrl =
  origin + "/api/v1/connections/lastfm/extension/result";
const listeners: Array<{
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
}> = [];
const mediaListeners = new Set<() => void>();
const element = <T = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const input = (id: string) => element<HTMLInputElement>(id);
const select = <T extends Element = HTMLButtonElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const sheet = () => element<HTMLDialogElement>("setup-sheet");
const recordTitles = () =>
  Array.from(
    document.querySelectorAll(".record-title"),
    (row) => row.textContent,
  );
const recordRow = (title: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".record-row")).find(
    (row) => row.querySelector(".record-title")?.textContent === title,
  )!;
const rowArtwork = (title: string) =>
  recordRow(title).querySelector<HTMLImageElement>(".record-cover img");
const latestArtwork = () => element<HTMLImageElement>("latest-artwork");
const moreHistory = () => element<HTMLAnchorElement>("more-history");
const firstArtwork =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/one/600x600bb.jpg";
const secondArtwork =
  "https://is2-ssl.mzstatic.com/image/thumb/Music/two/600x600bb.jpg";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  mediaListeners.clear();
  history.replaceState(null, "", "/");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  document.documentElement.style.removeProperty("color-scheme");
  const source = new DOMParser().parseFromString(html, "text/html");
  document.body.replaceWith(document.importNode(source.body, true));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);

  // jsdom has dialog elements but does not implement their browser methods.
  sheet().showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  sheet().close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });

  // Re-importing the entry represents a new extension tab. Track global
  // listeners so a closed fixture cannot refresh a later test's document.
  for (const target of [window as EventTarget, document as EventTarget]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation(
      (type, listener, options?) => {
        if (listener) listeners.push({ target, type, listener });
        add(type, listener, options);
      },
    );
  }
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  for (const { target, type, listener } of listeners.splice(0))
    target.removeEventListener(type, listener);
  mediaListeners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("../apps/browser-extension/src/emil-service");
  document.body.replaceChildren();
});

async function launch(
  options: {
    installed?: boolean;
    enabled?: boolean;
    appleConnected?: boolean;
    authorized?: boolean;
    username?: string;
    applicationConfigured?: boolean;
    initialHash?: "journal" | "connections" | "settings";
    interruptedInstallation?: boolean;
    hasHostPermission?: boolean;
    storageError?: boolean;
    networkError?: boolean;
    healthVersion?: string;
    healthHash?: string;
    deferInitialRead?: boolean;
    records?: Runtime["records"];
    artworkResponse?: (catalogId: string) => Promise<Response>;
    savedTheme?: "light" | "dark" | "system";
    reducedMotion?: boolean;
    lastfmStartStatus?: number;
    lastfmExtensionAuth?: boolean;
    recordingIssue?: Runtime["recording_issue"];
  } = {},
) {
  if (options.initialHash)
    history.replaceState(null, "", "/#" + options.initialHash);
  let releaseInitialRead: (() => void) | undefined;
  const initialRead = options.deferInitialRead
    ? new Promise<void>((resolve) => {
        releaseInitialRead = resolve;
      })
    : Promise.resolve();
  const fixture = {
    connections: {
      apple: { connected: options.appleConnected ?? true },
      lastfm: {
        connected: options.authorized ?? true,
        application_configured: options.applicationConfigured ?? true,
        username: options.username ?? "FixtureListener",
      },
    },
    runtime: {
      recording_issue: options.recordingIssue,
      enabled: options.enabled ?? false,
      algorithm_version: "0.3.111",
      algorithm_sha256:
        "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
      pending_identity: 1,
      pending_submission: 2,
      stats: { total_scrobbled: options.records?.length ?? 0 },
      records: options.records ?? [],
    } satisfies Runtime,
    startError: null as Error | null,
    pauseError: null as Error | null,
    startReadbackEnabled: true,
    pauseReadbackEnabled: false,
    artworkResponse: options.artworkResponse,
  };
  const requestPermission = vi.fn(async () => true);
  const containsPermission = vi.fn(
    async () => options.hasHostPermission ?? true,
  );
  const store: Record<string, unknown> = {};
  const storageGet = vi.fn(async (key: string) => {
    if (key === THEME_STORAGE_KEY) return { [key]: options.savedTheme };
    await initialRead;
    if (options.storageError) throw Error("private-storage-error");
    const savedInstallation = options.interruptedInstallation
      ? { ...installation, origin: undefined }
      : installation;
    return key === "installation"
      ? options.installed !== false
        ? { installation: savedInstallation }
        : {}
      : { [key]: structuredClone(store[key]) };
  });
  const storageSet = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(store, structuredClone(value));
  });
  const openTab = vi.fn(async (_options: { url: string }) => ({ id: 202 }));
  const queryTabs = vi.fn(async () => [] as Array<{ id: number }>);
  const executeScript = vi.fn(async () => [] as Array<{ result: unknown }>);
  const updateTab = vi.fn(
    async (id: number, _options: { active?: boolean }) => ({ id }),
  );
  const removeTab = vi.fn(async (_id: number) => {});
  const tabUpdatedListeners = new Set<
    (
      tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: { id?: number; url?: string },
    ) => void
  >();
  const tabRemovedListeners = new Set<
    (
      tabId: number,
      info: { windowId: number; isWindowClosing: boolean },
    ) => void
  >();
  let systemDark = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query === "(prefers-reduced-motion: reduce)"
          ? (options.reducedMotion ?? true)
          : query === "(prefers-color-scheme: dark)" && systemDark;
      },
      addEventListener(_type: string, listener: () => void) {
        if (query === "(prefers-color-scheme: dark)")
          mediaListeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        mediaListeners.delete(listener);
      },
    })),
  );
  vi.stubGlobal("chrome", {
    storage: { local: { get: storageGet, set: storageSet } },
    permissions: { request: requestPermission, contains: containsPermission },
    tabs: {
      create: openTab,
      query: queryTabs,
      getCurrent: vi.fn(async () => ({ id: 101 })),
      update: updateTab,
      remove: removeTab,
      onUpdated: {
        addListener: vi.fn((listener) => tabUpdatedListeners.add(listener)),
        removeListener: vi.fn((listener) =>
          tabUpdatedListeners.delete(listener),
        ),
      },
      onRemoved: {
        addListener: vi.fn((listener) => tabRemovedListeners.add(listener)),
        removeListener: vi.fn((listener) =>
          tabRemovedListeners.delete(listener),
        ),
      },
    },
    scripting: { executeScript },
    runtime: { getURL: (path: string) => "chrome-extension://fixture/" + path },
  });
  const clipboard = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  let cacheQueue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn(
        (_name: string, _options: unknown, task: () => Promise<unknown>) => {
          const request = cacheQueue.then(task);
          cacheQueue = request.then(
            () => undefined,
            () => undefined,
          );
          return request;
        },
      ),
    },
  });
  const network = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const destination = new URL(
        typeof url === "string" || url instanceof URL ? String(url) : url.url,
      );
      if (destination.origin !== origin)
        throw Error("Unexpected test destination");
      if (options.networkError) throw new TypeError("private-network-error");
      if (destination.pathname === "/health")
        return Response.json({
          version: options.healthVersion ?? "0.3.111",
          algorithm_sha256:
            options.healthHash ??
            "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
          capabilities: {
            lastfm_extension_auth: options.lastfmExtensionAuth ?? true,
          },
        });
      if (destination.pathname === "/api/v1/connections")
        return Response.json(fixture.connections);
      if (destination.pathname === "/api/v1/recording")
        return Response.json(fixture.runtime);
      if (
        destination.pathname === "/api/v1/connections/apple" &&
        init?.method === "POST"
      ) {
        fixture.connections.apple.connected = true;
        return Response.json({ ok: true, connected: true, verified: true });
      }
      if (destination.pathname === "/api/v1/artwork")
        return fixture.artworkResponse
          ? fixture.artworkResponse(
              destination.searchParams.get("track_id") ??
                destination.searchParams.get("catalog_id") ??
                "",
            )
          : Response.json({ artwork_url: null });
      if (
        destination.pathname === "/api/v1/connections/lastfm/application" &&
        init?.method === "PUT"
      ) {
        fixture.connections.lastfm.application_configured = true;
        return Response.json({ ok: true });
      }
      if (
        destination.pathname === "/api/v1/connections/lastfm/extension/start" &&
        init?.method === "POST"
      ) {
        if (options.lastfmStartStatus)
          return Response.json(
            { error: "not_found" },
            { status: options.lastfmStartStatus },
          );
        return Response.json({
          browser_url: authorizationBrowserUrl,
          callback_url: authorizationCallbackUrl,
        });
      }
      if (
        destination.pathname === "/api/v1/recording/start" &&
        init?.method === "POST"
      ) {
        if (fixture.startError) throw fixture.startError;
        fixture.runtime.enabled = fixture.startReadbackEnabled;
        return Response.json({ ok: true, enabled: true });
      }
      if (
        destination.pathname === "/api/v1/recording/pause" &&
        init?.method === "POST"
      ) {
        if (fixture.pauseError) throw fixture.pauseError;
        fixture.runtime.enabled = fixture.pauseReadbackEnabled;
        return Response.json({ ok: true, enabled: false });
      }
      throw Error("Unexpected fixture request");
    },
  );
  vi.stubGlobal("fetch", network);
  await import("../apps/browser-extension/src/emil-app");
  async function ready() {
    await vi.waitFor(() =>
      expect(document.body.getAttribute("aria-busy")).toBe("false"),
    );
  }
  if (!options.deferInitialRead) await ready();
  return {
    fixture,
    network,
    clipboard,
    openTab,
    queryTabs,
    executeScript,
    updateTab,
    removeTab,
    emitTabUpdated(tabId: number, url: string) {
      for (const listener of tabUpdatedListeners)
        listener(tabId, { url }, { id: tabId, url });
    },
    requestPermission,
    containsPermission,
    storageGet,
    storageSet,
    store,
    ready,
    releaseInitialRead: () => releaseInitialRead?.(),
    changeSystemTheme(dark: boolean) {
      systemDark = dark;
      for (const listener of mediaListeners) listener();
    },
  };
}

it.each([
  {
    scenario: "no Apple tab",
    title: "请先打开 Apple Music",
    tabs: [],
    openAppleMusic: true,
  },
  {
    scenario: "multiple Apple tabs",
    title: "请保留一个 Apple Music 官网标签页",
    tabs: [{ id: 9 }, { id: 10 }],
  },
  {
    scenario: "signed out",
    title: "请先登录 Apple Music",
    tabs: [{ id: 9 }],
    captureError: "not_signed_in",
    openAppleMusic: true,
  },
  {
    scenario: "page still loading",
    title: "Apple Music 还未准备好",
    tabs: [{ id: 9 }],
    captureError: "not_ready",
    openAppleMusic: true,
  },
  {
    scenario: "page navigated away",
    title: "Apple Music 页面已离开",
    tabs: [{ id: 9 }],
    captureError: "wrong_tab",
    openAppleMusic: true,
  },
  {
    scenario: "permission declined",
    title: "尚未允许访问服务",
    tabs: [{ id: 9 }],
    permission: "declined",
  },
  {
    scenario: "permission request rejected",
    title: "尚未允许访问服务",
    tabs: [{ id: 9 }],
    permission: "rejected",
  },
])(
  "shows and focuses actionable Apple feedback beside the connect button for $scenario",
  async ({ title, tabs, captureError, permission, openAppleMusic }) => {
    const h = await launch({ appleConnected: false, authorized: false });
    h.queryTabs.mockResolvedValue(tabs);
    if (captureError)
      h.executeScript.mockResolvedValue([{ result: { error: captureError } }]);
    if (permission === "declined")
      h.requestPermission.mockResolvedValueOnce(false);
    if (permission === "rejected")
      h.requestPermission.mockRejectedValueOnce(
        Error("private-permission-detail"),
      );
    select('[data-setup="apple"]').click();
    const alert = element("apple-error");
    const scroll = vi.fn();
    alert.scrollIntoView = scroll;
    button("connect-apple").click();

    await vi.waitFor(() => expect(alert.hidden).toBe(false));
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(element("apple-error-title").textContent).toBe(title);
    expect(button("connect-apple").nextElementSibling).toBe(alert);
    expect(
      alert.closest('[data-step-panel="apple"]')?.hasAttribute("hidden"),
    ).toBe(false);
    expect(document.activeElement).toBe(alert);
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(element("apple-panel-status").hidden).toBe(true);
    expect(element("sheet-error").hidden).toBe(true);
    expect(element("toast").hidden).toBe(true);
    const link = element<HTMLAnchorElement>("apple-error-open");
    expect(link.hidden).toBe(!openAppleMusic);
    expect(link.href).toBe("https://music.apple.com/");
    expect(link.target).toBe("_blank");
    expect(link.textContent).toContain("打开 Apple Music");
    expect(document.body.textContent).not.toContain(
      "private-permission-detail",
    );
    expect(mutations(h.network)).toHaveLength(0);

    // Ordinary rerenders must not scroll again or take focus from the user.
    button("connect-apple").focus();
    select('[data-step="apple"]').click();
    expect(scroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button("connect-apple"));
  },
);

it("clears missing-tab feedback while retrying and advances only after a real Apple connection succeeds", async () => {
  const h = await launch({ appleConnected: false, authorized: false });
  select('[data-setup="apple"]').click();
  button("connect-apple").click();
  await vi.waitFor(() =>
    expect(element("apple-error-title").textContent).toBe(
      "请先打开 Apple Music",
    ),
  );
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(true);
  expect(mutations(h.network)).toHaveLength(0);

  h.queryTabs.mockResolvedValue([{ id: 9 }]);
  let finishCapture!: (value: Array<{ result: unknown }>) => void;
  h.executeScript.mockReturnValueOnce(
    new Promise((resolve) => {
      finishCapture = resolve;
    }),
  );
  button("connect-apple").click();
  expect(element("apple-error").hidden).toBe(true);
  expect(element("apple-error-title").textContent).toBe("");
  expect(button("connect-apple").disabled).toBe(true);
  await vi.waitFor(() => expect(h.executeScript).toHaveBeenCalledOnce());
  finishCapture([
    {
      result: {
        credentials: {
          apple_dev_token: "fixture-developer-token",
          apple_user_token: "fixture-user-token",
        },
      },
    },
  ]);
  await vi.waitFor(() =>
    expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(
      false,
    ),
  );
  expect(element("apple-error").hidden).toBe(true);
  expect(element("sheet-error").hidden).toBe(true);
  expect(element("toast").textContent).toContain("Apple Music 已连接");
  expect(document.activeElement).toBe(element("sheet-title"));
  expect(
    mutations(h.network).map(([url]) => new URL(String(url)).pathname),
  ).toEqual(["/api/v1/connections/apple"]);
  expect(h.fixture.runtime.enabled).toBe(false);
  expect(document.body.textContent).not.toMatch(
    /fixture-developer-token|fixture-user-token/,
  );
});

it("retains backend recovery beside Apple connection errors when a version change disables reconnecting", async () => {
  const h = await launch({ appleConnected: false, authorized: false });
  h.queryTabs.mockResolvedValue([{ id: 9 }]);
  h.network.mockImplementationOnce(async () =>
    Response.json({
      version: "changed-after-load",
      algorithm_sha256:
        "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
    }),
  );
  select('[data-setup="apple"]').click();
  button("connect-apple").click();
  await vi.waitFor(() =>
    expect(element("apple-error-title").textContent).toBe(
      "后台版本与扩展不匹配",
    ),
  );
  expect(button("connect-apple").disabled).toBe(true);
  expect(button("apple-error-recovery").hidden).toBe(false);
  expect(button("apple-error-recovery").textContent).toBe("检查后台版本");
  expect(element("apple-error-open").hidden).toBe(true);
  button("apple-error-recovery").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(element("page-settings").hidden).toBe(false);
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(mutations(h.network)).toHaveLength(0);
});

function openRecordingControls() {
  button("top-status").click();
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(false);
  expect(button("start-recording").disabled).toBe(false);
}

function refreshConnections() {
  select('[data-page="connections"]').click();
  button("refresh").click();
}

function mutations(network: Awaited<ReturnType<typeof launch>>["network"]) {
  return network.mock.calls.filter(
    ([, init]) => init?.method && init.method !== "GET",
  );
}
function settingsWrites(h: Awaited<ReturnType<typeof launch>>) {
  return h.storageSet.mock.calls.filter(([value]) =>
    Object.keys(value).some((key) => key !== ARTWORK_CACHE_KEY),
  );
}

function connectionOverview() {
  return {
    intro: select<HTMLElement>(".connection-intro").innerHTML,
    cloud: element("connection-cloud-state").outerHTML,
    apple: element("connection-apple-state").outerHTML,
    lastfm: element("connection-lastfm-state").outerHTML,
    lastfmDetail: element("connection-lastfm-detail").textContent,
    topStatus: button("top-status").outerHTML,
    recordingAction: button("recording-action").outerHTML,
    recordingStatus: element("recording-status").outerHTML,
  };
}

function stubBackendUpdates(
  accounts: Array<{ id: string; name: string }>,
  getArtwork?: (
    value: string | Runtime["records"][number],
  ) => Promise<string | null>,
) {
  const cloudAccounts = vi.fn(async (_token: string) => accounts);
  const updateBackend = vi.fn(async (_token: string, _account: string) => {});
  const deploy = vi.fn(async (_token: string, _account: string) => {});
  vi.doMock(
    "../apps/browser-extension/src/emil-service",
    async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import("../apps/browser-extension/src/emil-service")
        >();
      return {
        ...actual,
        createEmilService: (
          options: Parameters<typeof actual.createEmilService>[0],
        ) => ({
          ...actual.createEmilService(options),
          cloudAccounts,
          updateBackend,
          deploy,
          ...(getArtwork ? { getArtwork } : {}),
        }),
      };
    },
  );
  return { cloudAccounts, updateBackend, deploy };
}

it("updates the existing backend from settings with its account locked and returns to Last.fm", async () => {
  const calls = stubBackendUpdates([
    { id: "9".repeat(32), name: "Other account" },
    { id: installation.account, name: "Original account" },
  ]);
  const h = await launch({ authorized: false, initialHash: "settings" });
  button("update-backend").click();
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(element("cloud-form").hidden).toBe(false);
  expect(element("cloud-complete").hidden).toBe(true);
  expect(element("sheet-title").textContent).toBe("让个人后台保持最新。");
  expect(element("cloud-entry-title").textContent).toBe("验证并更新");
  expect(button("deploy").textContent).toContain("更新个人后台");
  expect(button("deploy").disabled).toBe(true);

  input("cloud-token").value = "fixture-update-token";
  button("load-accounts").click();
  await vi.waitFor(() => expect(button("deploy").disabled).toBe(false));
  expect(calls.cloudAccounts).toHaveBeenCalledWith("fixture-update-token");
  expect(input("cloud-token").value).toBe("");
  const account = element<HTMLSelectElement>("cloud-account");
  expect(account.value).toBe(installation.account);
  expect(account.disabled).toBe(true);
  expect(account.options[0].disabled).toBe(true);
  expect(account.options[1].disabled).toBe(false);
  button("deploy").click();
  await vi.waitFor(() =>
    expect(calls.updateBackend).toHaveBeenCalledWith("", installation.account),
  );
  await vi.waitFor(() =>
    expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(
      false,
    ),
  );
  expect(calls.deploy).not.toHaveBeenCalled();
  expect(settingsWrites(h)).toHaveLength(0);
  expect(element("backend-origin").textContent).toBe(installation.origin);
  expect(h.fixture.runtime.enabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
});

it("offers a working upgrade entry for an installed 0.3.106 backend before its connections can be verified", async () => {
  const calls = stubBackendUpdates([
    { id: installation.account, name: "Original account" },
  ]);
  const h = await launch({
    healthVersion: previousAlgorithm.version,
    healthHash: previousAlgorithm.hash,
  });
  expect(element("global-error").hidden).toBe(false);
  expect(element("global-error").textContent).toContain("个人后台需要升级");
  expect(element("global-error").textContent).toContain("0.3.106");
  expect(element("global-error").textContent).toContain("0.3.111");
  expect(button("error-recovery").textContent).toBe("重新连接 Cloudflare");
  expect(
    h.network.mock.calls.every(
      ([url]) => new URL(String(url)).pathname === "/health",
    ),
  ).toBe(true);
  button("error-recovery").click();
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(element("cloud-form").hidden).toBe(false);
  input("cloud-token").value = "fixture-upgrade-token";
  button("load-accounts").click();
  await vi.waitFor(() => expect(button("deploy").disabled).toBe(false));
  expect(element<HTMLSelectElement>("cloud-account").value).toBe(
    installation.account,
  );
  expect(element<HTMLSelectElement>("cloud-account").disabled).toBe(true);
  button("deploy").click();
  await vi.waitFor(() =>
    expect(calls.updateBackend).toHaveBeenCalledExactlyOnceWith(
      "",
      installation.account,
    ),
  );
  expect(calls.deploy).not.toHaveBeenCalled();
  expect(settingsWrites(h)).toHaveLength(0);
});

it("keeps backend updates disabled when the Token does not include the original account", async () => {
  const calls = stubBackendUpdates([
    { id: "9".repeat(32), name: "Other account" },
  ]);
  const h = await launch({ authorized: false, initialHash: "settings" });
  button("update-backend").click();
  input("cloud-token").value = "fixture-wrong-account-token";
  button("load-accounts").click();
  await vi.waitFor(() =>
    expect(element("cloud-account-selection").hidden).toBe(false),
  );
  expect(element<HTMLSelectElement>("cloud-account").value).toBe("");
  expect(element<HTMLSelectElement>("cloud-account").disabled).toBe(true);
  expect(button("deploy").disabled).toBe(true);
  expect(element("cloud-account-hint").textContent).toContain("原部署账户");
  expect(element("sheet-feedback").textContent).toContain("未包含原部署账户");
  button("deploy").click();
  expect(calls.updateBackend).not.toHaveBeenCalled();
  expect(calls.deploy).not.toHaveBeenCalled();
  expect(settingsWrites(h)).toHaveLength(0);
});

it("opens Cloudflare reconnection directly below the primary action without changing the existing installation", async () => {
  const calls = stubBackendUpdates([
    { id: installation.account, name: "Original account" },
  ]);
  const h = await launch({
    initialHash: "connections",
    records: [{ track: "Existing song", artist: "Artist" }],
  });
  select('[data-setup="cloud"]').click();
  const complete = element("cloud-complete");
  const reconnect = button("show-cloud-form");
  expect(complete.hidden).toBe(false);
  expect(complete.querySelector("details")).toBeNull();
  expect(complete.textContent).not.toContain("安装恢复选项");
  expect(reconnect.textContent?.trim()).toBe("重新连接 Cloudflare");
  expect(complete.querySelector(".button.primary")?.nextElementSibling).toBe(
    reconnect,
  );
  const row = recordRow("Existing song");
  const reads = h.network.mock.calls.length;
  input("cloud-token").value = "fixture-token-from-an-earlier-attempt";
  element<HTMLSelectElement>("cloud-account").add(
    new Option("Earlier account", installation.account),
  );
  element("cloud-account-selection").hidden = false;
  element("install-progress").hidden = false;
  element("sheet-feedback").textContent = "Earlier verification feedback";

  reconnect.click();

  expect(element("cloud-form").hidden).toBe(false);
  expect(complete.hidden).toBe(true);
  expect(element("sheet-title").textContent).toBe("重新连接 Cloudflare。");
  expect(element("sheet-description").textContent).toBe(
    "重新验证 Cloudflare Token，并更新现有个人后台，保留连接和聆听记录。",
  );
  expect(button("deploy").textContent).toContain("连接并继续");
  expect(button("deploy").disabled).toBe(true);
  expect(input("cloud-token").value).toBe("");
  expect(element<HTMLSelectElement>("cloud-account").options).toHaveLength(0);
  expect(element("cloud-account-selection").hidden).toBe(true);
  expect(element("install-progress").hidden).toBe(true);
  expect(element("sheet-feedback").textContent).toBe("");
  expect(element<HTMLDetailsElement>("cloud-token-guide").open).toBe(true);
  expect(element("cloud-origin").textContent).toBe(installation.origin);
  expect(recordRow("Existing song")).toBe(row);
  expect(h.network).toHaveBeenCalledTimes(reads);
  expect(settingsWrites(h)).toHaveLength(0);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(calls.cloudAccounts).not.toHaveBeenCalled();
  expect(calls.updateBackend).not.toHaveBeenCalled();
  expect(calls.deploy).not.toHaveBeenCalled();
  expect(mutations(h.network)).toHaveLength(0);

  let finishUpdate!: () => void;
  calls.updateBackend.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }),
  );
  input("cloud-token").value = "fixture-reconnect-token";
  button("load-accounts").click();
  await vi.waitFor(() => expect(button("deploy").disabled).toBe(false));
  expect(calls.cloudAccounts).toHaveBeenCalledExactlyOnceWith(
    "fixture-reconnect-token",
  );
  const account = element<HTMLSelectElement>("cloud-account");
  expect(account.value).toBe(installation.account);
  expect(account.disabled).toBe(true);
  expect(element("sheet-feedback").textContent).toContain("连接并继续");
  expect(button("deploy").textContent).toContain("连接并继续");
  button("deploy").click();
  await vi.waitFor(() =>
    expect(calls.updateBackend).toHaveBeenCalledExactlyOnceWith(
      "",
      installation.account,
    ),
  );
  expect(calls.deploy).not.toHaveBeenCalled();
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(true);
  expect(element("toast").textContent).not.toContain("已重新连接");
  finishUpdate();
  await vi.waitFor(() =>
    expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(
      false,
    ),
  );
  expect(element("toast").textContent).toContain(
    "Cloudflare 已重新连接，个人后台已更新",
  );
  expect(settingsWrites(h)).toHaveLength(0);
  expect(element("backend-origin").textContent).toBe(installation.origin);
  expect(h.fixture.runtime.records).toHaveLength(1);
  expect(h.fixture.runtime.enabled).toBe(false);
});

it("keeps a first Cloudflare installation on the deploy path", async () => {
  const calls = stubBackendUpdates([
    { id: installation.account, name: "New account" },
  ]);
  await launch({ installed: false, initialHash: "connections" });
  button("continue-setup").click();
  input("cloud-token").value = "fixture-install-token";
  button("load-accounts").click();
  await vi.waitFor(() => expect(button("deploy").disabled).toBe(false));
  expect(element<HTMLSelectElement>("cloud-account").disabled).toBe(false);
  expect(button("deploy").textContent).toContain("安装个人后台");
  button("deploy").click();
  await vi.waitFor(() =>
    expect(calls.deploy).toHaveBeenCalledExactlyOnceWith(
      "",
      installation.account,
    ),
  );
  expect(calls.updateBackend).not.toHaveBeenCalled();
});

it("keeps the Cloudflare reconnection form open when its backend update fails", async () => {
  const calls = stubBackendUpdates([
    { id: installation.account, name: "Original account" },
  ]);
  calls.updateBackend.mockRejectedValueOnce(Error("fixture-upload-failed"));
  await launch({ initialHash: "connections" });
  select('[data-setup="cloud"]').click();
  button("show-cloud-form").click();
  expect(document.activeElement).toBe(element("sheet-title"));
  input("cloud-token").value = "fixture-reconnect-token";
  button("load-accounts").click();
  await vi.waitFor(() => expect(button("deploy").disabled).toBe(false));
  button("deploy").click();
  await vi.waitFor(() => expect(calls.updateBackend).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.deploy).not.toHaveBeenCalled();
  expect(element("cloud-form").hidden).toBe(false);
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(true);
  expect(element("toast").textContent).not.toContain("已重新连接");
});

it("retries missing covers immediately after a backend update while preserving loaded rows and images", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  try {
    let missingArtwork: string | null = null;
    const getArtwork = vi.fn(
      async (value: string | Runtime["records"][number]) =>
        typeof value === "object" && value.track_id === "1002"
          ? secondArtwork
          : missingArtwork,
    );
    const calls = stubBackendUpdates(
      [{ id: installation.account, name: "Original account" }],
      getArtwork,
    );
    await launch({
      initialHash: "connections",
      records: [
        {
          track: "Missing sleeve",
          artist: "Artist",
          track_id: "1001",
          catalog_id: null,
        },
        {
          track: "Loaded sleeve",
          artist: "Artist",
          track_id: "1002",
          catalog_id: null,
        },
      ],
    });
    await vi.waitFor(() => expect(getArtwork).toHaveBeenCalledTimes(3));
    expect(latestArtwork().getAttribute("src")).toBeNull();
    expect(rowArtwork("Missing sleeve")).toBeNull();
    const missingRow = recordRow("Missing sleeve");
    const loadedRow = recordRow("Loaded sleeve");
    const loadedImage = rowArtwork("Loaded sleeve")!;
    loadedImage.dispatchEvent(new Event("load"));
    const before = Date.now();

    select('[data-setup="cloud"]').click();
    button("show-cloud-form").click();
    input("cloud-token").value = "fixture-update-token";
    button("load-accounts").click();
    await vi.waitFor(() => expect(button("deploy").disabled).toBe(false));
    calls.updateBackend.mockImplementationOnce(async () => {
      missingArtwork = firstArtwork;
    });
    button("deploy").click();
    await vi.waitFor(() =>
      expect(element("toast").textContent).toContain("个人后台已更新"),
    );
    // The page behind the sheet remains unchanged until it is dismissed.
    expect(rowArtwork("Missing sleeve")).toBeNull();
    button("close-sheet").click();
    await vi.waitFor(() => {
      expect(latestArtwork().getAttribute("src")).toBe(firstArtwork);
      expect(rowArtwork("Missing sleeve")?.getAttribute("src")).toBe(
        firstArtwork,
      );
    });
    expect(Date.now() - before).toBeLessThan(1000);
    expect(recordRow("Missing sleeve")).toBe(missingRow);
    expect(recordRow("Loaded sleeve")).toBe(loadedRow);
    expect(rowArtwork("Loaded sleeve")).toBe(loadedImage);
    expect(loadedImage.hidden).toBe(false);
    expect(loadedImage.getAttribute("src")).toBe(secondArtwork);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { name: "a legacy health response", lastfmExtensionAuth: false },
  { name: "an unavailable start route", lastfmStartStatus: 404 },
])("recovers $name in the same backend update sheet", async (options) => {
  const h = await launch({ authorized: false, ...options });
  select('[data-setup="lastfm"]').click();
  button("authorize-lastfm").click();
  await vi.waitFor(() =>
    expect(element("sheet-error").textContent).toContain("个人后台需要更新"),
  );
  expect(h.openTab).not.toHaveBeenCalled();
  if (options.lastfmExtensionAuth === false)
    expect(
      h.network.mock.calls.some(([url]) =>
        String(url).endsWith("/api/v1/connections/lastfm/extension/start"),
      ),
    ).toBe(false);
  expect(button("sheet-recovery").textContent).toBe("更新个人后台");
  button("sheet-recovery").click();
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(element("cloud-form").hidden).toBe(false);
  expect(element("cloud-entry-title").textContent).toBe("验证并更新");
  expect(button("deploy").disabled).toBe(true);
  expect(element("backend-origin").textContent).toBe(installation.origin);
  expect(settingsWrites(h)).toHaveLength(0);
  expect(h.fixture.runtime.enabled).toBe(false);
});

function sheetAnimationClock() {
  let time = 0;
  let sequence = 0;
  const horizontalPositions: number[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 900);
  // A real bounding rect includes the current transform. Keep that behavior
  // for a 544 × 760 sheet centered within the 1280 × 900 viewport.
  vi.spyOn(sheet(), "getBoundingClientRect").mockImplementation(() => {
    const translate = sheet().style.transform.match(
      /translate3d\(\s*([-\d.]+)(?:px)?,\s*([-\d.]+)(?:px)?,\s*[-\d.]+(?:px)?\s*\)/,
    );
    return new DOMRect(
      368 + Number(translate?.[1] ?? 0),
      70 + Number(translate?.[2] ?? 0),
      544,
      760,
    );
  });
  return {
    now: () => time,
    horizontalPositions,
    advance(ms: number) {
      const end = time + ms;
      while (time < end) {
        time = Math.min(time + 16, end);
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(time);
        horizontalPositions.push(sheet().getBoundingClientRect().left);
      }
    },
  };
}

it("welcomes a first installation with connections and opens only its available setup step", async () => {
  const h = await launch({ installed: false });
  expect(element("page-connections").hidden).toBe(false);
  expect(element("page-journal").hidden).toBe(true);
  expect(element("empty-history").hidden).toBe(false);
  expect(recordTitles()).toHaveLength(0);
  expect(element("top-status-label").textContent).toBe("等待连接");
  expect(button("refresh").disabled).toBe(true);
  expect(element("startup-state").hidden).toBe(true);
  expect(element("setup-summary").textContent).toMatch(/已完成\s*0\s*\/\s*3/);
  expect(button("continue-setup").textContent).toContain("开始连接");
  button("continue-setup").click();
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(document.querySelectorAll("#setup-progress [data-step]")).toHaveLength(
    3,
  );
  expect(document.querySelector('[data-step="confirm"]')).toBeNull();
  expect(element("sheet-step-label").textContent).toBe("01 / 03");
  expect(document.getElementById("confirm-account")).toBeNull();
  expect(button("start-recording").disabled).toBe(true);
  button("close-sheet").click();
  expect(sheet().open).toBe(false);
  expect(element("page-connections").hidden).toBe(false);
  expect(h.network).not.toHaveBeenCalled();
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("keeps the journal focused on records and places recording controls in connection settings", async () => {
  await launch();
  const journal = element("page-journal");
  const connections = element("page-connections");
  expect(journal.getAttribute("aria-label")).toBe("聆听记录");
  expect(journal.querySelector("h1")).toBeNull();
  expect(document.getElementById("journal-title")).toBeNull();
  expect(document.getElementById("record-count")).toBeNull();
  expect(document.getElementById("connections-start")).toBeNull();
  for (const id of ["recording-action", "recording-status", "refresh"]) {
    expect(journal.contains(element(id))).toBe(false);
    expect(connections.contains(element(id))).toBe(true);
  }
  select('[data-page="connections"]').click();
  expect(element("page-connections").hidden).toBe(false);
  expect(button("recording-action").disabled).toBe(false);
});

it("keeps a failed first Cloudflare verification in new-installation guidance", async () => {
  const h = await launch({ installed: false });
  h.network
    .mockResolvedValueOnce(
      Response.json({ success: true, result: { status: "active" } }),
    )
    .mockResolvedValueOnce(
      Response.json(
        { success: false, errors: [{ code: 10000 }] },
        { status: 403 },
      ),
    );
  button("continue-setup").click();
  input("cloud-token").value = "fixture-cloud-token-123456";
  button("load-accounts").click();
  await vi.waitFor(() => expect(element("sheet-error").hidden).toBe(false));
  await h.ready();
  expect(h.network).toHaveBeenCalledTimes(2);
  expect(String(h.network.mock.calls[0][0])).toBe(
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
  );
  expect(String(h.network.mock.calls[1][0])).toBe(
    "https://api.cloudflare.com/client/v4/accounts?per_page=50&page=1",
  );
  expect(element("setup-summary").textContent).toMatch(/已完成\s*0\s*\/\s*3/);
  expect(element("setup-summary").textContent).not.toContain("待确认");
  expect(button("continue-setup").textContent).toContain("开始连接");
  expect(button("continue-setup").textContent).not.toContain("检查已有连接");
  button("close-sheet").click();
  expect(element("page-connections").hidden).toBe(false);
  button("continue-setup").click();
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="cloud"]').hidden).toBe(false);
  expect(h.network).toHaveBeenCalledTimes(2);
});

it.each(["empty-connect", "error-recovery", "top-status"])(
  "retries unread installation storage through %s without opening a new installation",
  async (entry) => {
    const options = { storageError: true };
    const h = await launch(options);
    const installationReads = () =>
      h.storageGet.mock.calls.filter(([key]) => key === "installation").length;
    expect(installationReads()).toBe(1);
    expect(element("setup-summary").textContent).toContain("待确认");
    expect(h.network).not.toHaveBeenCalled();
    options.storageError = false;
    button(entry).click();
    expect(sheet().open).toBe(false);
    await vi.waitFor(() => expect(installationReads()).toBe(2));
    await vi.waitFor(() =>
      expect(element("backend-origin").textContent).toBe(origin),
    );
    await h.ready();
    expect(element("setup-summary").textContent).toMatch(/已完成\s*3\s*\/\s*3/);
    expect(sheet().open).toBe(false);
    expect(h.network.mock.calls.length).toBeGreaterThan(0);
    expect(
      h.network.mock.calls.every(
        ([url]) => new URL(String(url)).origin === origin,
      ),
    ).toBe(true);
    expect(mutations(h.network)).toHaveLength(0);
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(settingsWrites(h)).toHaveLength(0);
  },
);

it.each<{
  name: string;
  options: NonNullable<Parameters<typeof launch>[0]>;
  expectedPage: "journal" | "connections";
  completed: number | null;
}>([
  {
    name: "an interrupted deployment without a worker origin",
    options: { interruptedInstallation: true },
    expectedPage: "connections",
    completed: 0,
  },
  {
    name: "a verified worker missing Apple Music",
    options: { appleConnected: false },
    expectedPage: "connections",
    completed: 2,
  },
  {
    name: "a verified worker missing Last.fm",
    options: { authorized: false },
    expectedPage: "connections",
    completed: 2,
  },
  {
    name: "all three connections with recording paused",
    options: {},
    expectedPage: "journal",
    completed: 3,
  },
  {
    name: "all three connections with recording active",
    options: { enabled: true },
    expectedPage: "journal",
    completed: 3,
  },
  {
    name: "a saved worker awaiting browser permission",
    options: { hasHostPermission: false },
    expectedPage: "journal",
    completed: null,
  },
  {
    name: "a saved worker with an unavailable network",
    options: { networkError: true },
    expectedPage: "journal",
    completed: null,
  },
  {
    name: "a saved worker requiring a version check",
    options: { healthVersion: "0.0.0" },
    expectedPage: "journal",
    completed: null,
  },
  {
    name: "a browser storage read failure",
    options: { storageError: true },
    expectedPage: "journal",
    completed: null,
  },
])(
  "chooses a safe first page for $name",
  async ({ options, expectedPage, completed }) => {
    const h = await launch(options);
    expect(element("startup-state").hidden).toBe(true);
    expect(element("page-" + expectedPage).hidden).toBe(false);
    expect(
      element(
        "page-" + (expectedPage === "journal" ? "connections" : "journal"),
      ).hidden,
    ).toBe(true);
    const progress = element("setup-summary").textContent;
    if (completed === null) {
      expect(progress).toContain("待确认");
      expect(progress).not.toMatch(/0\s*\/\s*3/);
    } else {
      expect(progress).toMatch(
        new RegExp(`已完成\\s*${completed}\\s*\\/\\s*3`),
      );
    }
    expect(sheet().open).toBe(false);
    expect(mutations(h.network)).toHaveLength(0);
    expect(h.requestPermission).not.toHaveBeenCalled();
  },
);

it.each(["journal", "connections", "settings"] as const)(
  "honors an explicit #%s entry before automatic onboarding",
  async (initialHash) => {
    await launch({ installed: false, initialHash });
    expect(element("page-" + initialHash).hidden).toBe(false);
    expect(location.hash).toBe("#" + initialHash);
    expect(sheet().open).toBe(false);
  },
);

it("keeps a neutral loading entry until the first installation read settles", async () => {
  const h = await launch({ installed: false, deferInitialRead: true });
  expect(element("startup-state").hidden).toBe(false);
  expect(document.body.dataset.initializing).toBe("true");
  expect(document.body.getAttribute("aria-busy")).toBe("true");
  expect(button("continue-setup").disabled).toBe(true);
  expect(sheet().open).toBe(false);
  expect(h.network).not.toHaveBeenCalled();
  h.releaseInitialRead();
  await h.ready();
  expect(element("startup-state").hidden).toBe(true);
  expect(document.body.hasAttribute("data-initializing")).toBe(false);
  expect(element("page-connections").hidden).toBe(false);
  expect(button("continue-setup").disabled).toBe(false);
});

it("keeps a page chosen during the initial read when onboarding resolves", async () => {
  const h = await launch({ installed: false, deferInitialRead: true });
  select('[data-page="settings"]').click();
  expect(element("page-settings").hidden).toBe(false);
  h.releaseInitialRead();
  await h.ready();
  expect(element("page-settings").hidden).toBe(false);
  expect(element("page-connections").hidden).toBe(true);
  expect(location.hash).toBe("#settings");
});

it("does not choose the initial page again after a connection refresh", async () => {
  const h = await launch({ authorized: false });
  expect(element("page-connections").hidden).toBe(false);
  h.fixture.connections.lastfm.connected = true;
  button("refresh").click();
  await vi.waitFor(() => expect(element("lastfm-complete").hidden).toBe(false));
  expect(element("page-connections").hidden).toBe(false);

  select('[data-page="journal"]').click();
  h.fixture.connections.apple.connected = false;
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(element("connection-apple-state").textContent).toBe("等待连接"),
  );
  expect(element("page-journal").hidden).toBe(false);
  expect(element("page-connections").hidden).toBe(true);
});

it.each([
  { appleConnected: false, authorized: true, nextStep: "apple" },
  { appleConnected: true, authorized: false, nextStep: "lastfm" },
])(
  "continues an incomplete connection at $nextStep and returns to connections on dismissal",
  async ({ appleConnected, authorized, nextStep }) => {
    const h = await launch({ appleConnected, authorized });
    expect(element("page-connections").hidden).toBe(false);
    expect(button("continue-setup").textContent).toContain("继续连接");
    button("continue-setup").click();
    expect(sheet().open).toBe(true);
    expect(select<HTMLElement>(`[data-step-panel="${nextStep}"]`).hidden).toBe(
      false,
    );
    button("close-sheet").click();
    expect(sheet().open).toBe(false);
    expect(element("page-connections").hidden).toBe(false);
    expect(mutations(h.network)).toHaveLength(0);
  },
);

it("starts ready connections from the overview with one explicit click", async () => {
  const h = await launch({ initialHash: "connections" });
  expect(element("setup-summary").textContent).toMatch(/已完成\s*3\s*\/\s*3/);
  expect(button("continue-setup").textContent).toContain("开始自动记录");
  expect(mutations(h.network)).toHaveLength(0);
  button("continue-setup").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  expect(sheet().open).toBe(false);
  expect(mutations(h.network)).toHaveLength(1);
  expect(JSON.parse(String(mutations(h.network)[0][1]?.body))).toEqual({
    username: "FixtureListener",
  });
  expect(element("page-journal").hidden).toBe(false);
});

it("lets an existing Token holder skip the guide without losing input or contacting Cloudflare", async () => {
  const h = await launch({ installed: false });
  button("continue-setup").click();
  const guide = element<HTMLDetailsElement>("cloud-token-guide");
  expect(guide.open).toBe(true);
  input("cloud-token").value = "fixture-token-already-entered";
  button("skip-token-guide").focus();
  button("skip-token-guide").click();
  expect(guide.open).toBe(false);
  expect(document.activeElement).toBe(input("cloud-token"));
  expect(input("cloud-token").value).toBe("fixture-token-already-entered");
  expect(sheet().open).toBe(true);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.network).not.toHaveBeenCalled();
});

it("keeps the connection overview still while Apple setup reports an error and then succeeds", async () => {
  const h = await launch({
    appleConnected: false,
    authorized: false,
    initialHash: "connections",
  });
  select('[data-setup="apple"]').click();
  const background = connectionOverview();
  const backgroundMutations = vi.fn();
  const observer = new MutationObserver(backgroundMutations);
  observer.observe(select(".connection-intro"), {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  button("connect-apple").click();
  expect(button("connect-apple").disabled).toBe(true);
  expect(connectionOverview()).toEqual(background);
  await vi.waitFor(() => expect(element("apple-error").hidden).toBe(false));
  expect(element("apple-error-title").textContent).toBe("请先打开 Apple Music");
  expect(connectionOverview()).toEqual(background);
  expect(backgroundMutations).not.toHaveBeenCalled();

  h.queryTabs.mockResolvedValue([{ id: 9 }]);
  h.executeScript.mockResolvedValue([
    {
      result: {
        credentials: {
          apple_dev_token: "fixture-developer-token",
          apple_user_token: "fixture-user-token",
        },
      },
    },
  ]);
  button("connect-apple").click();
  expect(element("apple-error").hidden).toBe(true);
  await vi.waitFor(() =>
    expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(
      false,
    ),
  );
  expect(h.fixture.connections.apple.connected).toBe(true);
  expect(element("connection-apple-state").textContent).toBe("等待连接");
  expect(connectionOverview()).toEqual(background);
  expect(backgroundMutations).not.toHaveBeenCalled();

  observer.disconnect();
  button("close-sheet").click();
  expect(sheet().open).toBe(false);
  expect(element("connection-apple-state").textContent).toBe("已连接");
  expect(element("setup-summary").textContent).toMatch(/已完成\s*2\s*\/\s*3/);
  expect(mutations(h.network)).toHaveLength(1);
});

it.each([true, false])(
  "keeps authorization and start updates inside the sheet until it closes (reduced motion: %s)",
  async (reducedMotion) => {
    const clock = reducedMotion ? undefined : sheetAnimationClock();
    const h = await launch({
      authorized: false,
      initialHash: "connections",
      reducedMotion,
    });
    select('[data-setup="lastfm"]').click();
    clock?.advance(1000);
    const background = connectionOverview();
    button("authorize-lastfm").click();
    expect(button("authorize-lastfm").disabled).toBe(true);
    expect(connectionOverview()).toEqual(background);
    await vi.waitFor(() =>
      expect(h.openTab).toHaveBeenCalledWith({ url: authorizationBrowserUrl }),
    );
    h.fixture.connections.lastfm.connected = true;
    h.emitTabUpdated(202, authorizationCallbackUrl + "?result=connected");
    await vi.waitFor(() =>
      expect(element("sheet-title").textContent).toContain("设置已完成"),
    );
    await vi.waitFor(() =>
      expect(button("start-recording").disabled).toBe(false),
    );
    expect(element("confirm-username").textContent).toBe("FixtureListener");
    expect(element("lastfm-complete").hidden).toBe(false);
    expect(connectionOverview()).toEqual(background);
    expect(element("setup-summary").textContent).toMatch(/已完成\s*2\s*\/\s*3/);

    button("start-recording").click();
    expect(button("start-recording").disabled).toBe(true);
    expect(connectionOverview()).toEqual(background);
    await vi.waitFor(() => expect(h.fixture.runtime.enabled).toBe(true));
    if (clock) {
      await vi.waitFor(() =>
        expect(element("toast").textContent).toContain("记录已开启"),
      );
      expect(sheet().open).toBe(true);
      clock.advance(160);
      expect(sheet().open).toBe(true);
      expect(element("page-connections").hidden).toBe(false);
      expect(element("page-journal").hidden).toBe(true);
      expect(location.hash).toBe("#connections");
      expect(connectionOverview()).toEqual(background);
      clock.advance(240);
    }
    await vi.waitFor(() => expect(sheet().open).toBe(false));
    expect(element("page-journal").hidden).toBe(false);
    expect(element("page-connections").hidden).toBe(true);
    expect(location.hash).toBe("#journal");
    expect(element("setup-summary").textContent).toMatch(/已完成\s*3\s*\/\s*3/);
    expect(element("connection-lastfm-state").textContent).toBe("已连接");
    expect(element("top-status-label").textContent).toBe("正在记录");
    expect(
      mutations(h.network).map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/api/v1/connections/lastfm/extension/start",
      "/api/v1/recording/start",
    ]);
  },
);

it("dismisses a centered sheet below the viewport and restores interaction within 400ms", async () => {
  const clock = sheetAnimationClock();
  await launch({
    installed: false,
    reducedMotion: false,
    initialHash: "journal",
  });
  select('[data-page="connections"]').click();
  const opener = button("recording-action");
  const scrim = element("setup-scrim");
  opener.focus();
  opener.click();
  expect(sheet().open).toBe(true);
  expect(sheet().getBoundingClientRect().left).toBe(368);
  expect(sheet().getBoundingClientRect().top).toBeGreaterThanOrEqual(
    innerHeight,
  );
  expect(document.body.style.overflow).toBe("hidden");
  expect(scrim.hidden).toBe(false);
  clock.advance(1000);
  expect(sheet().getBoundingClientRect().top).toBeCloseTo(70, 2);
  expect(Number(scrim.style.opacity)).toBe(1);

  const closeTimes: number[] = [];
  const closeEdges: number[] = [];
  vi.mocked(sheet().close).mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    closeEdges.push(this.getBoundingClientRect().top);
    this.open = false;
    closeTimes.push(clock.now());
  });
  button("close-sheet").focus();
  button("close-sheet").click();
  const started = clock.now();
  clock.advance(160);
  expect(sheet().open).toBe(true);
  expect(sheet().getBoundingClientRect().top).toBeLessThan(innerHeight);
  expect(document.body.style.overflow).toBe("hidden");
  expect(scrim.hidden).toBe(false);
  expect(Number(scrim.style.opacity)).toBeGreaterThan(0);
  expect(Number(scrim.style.opacity)).toBeLessThan(1);
  clock.advance(240);
  expect(sheet().open).toBe(false);
  expect(closeTimes).toHaveLength(1);
  expect(closeTimes[0] - started).toBeLessThanOrEqual(400);
  expect(closeEdges[0]).toBeGreaterThanOrEqual(innerHeight);
  expect(scrim.hidden).toBe(true);
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(opener);
  expect(element("page-connections").hidden).toBe(false);
  clock.advance(1000);
  expect(closeTimes).toHaveLength(1);
  expect(clock.horizontalPositions.every((left) => left === 368)).toBe(true);
});

it("keeps a closing sheet open when normal-motion dismissal is reversed", async () => {
  const clock = sheetAnimationClock();
  await launch({
    installed: false,
    reducedMotion: false,
    initialHash: "journal",
  });
  select('[data-page="connections"]').click();
  const opener = button("recording-action");
  opener.focus();
  opener.click();
  clock.advance(1000);
  button("close-sheet").focus();
  button("close-sheet").click();
  clock.advance(160);
  expect(sheet().open).toBe(true);

  button("recording-action").click();
  // Cross both the geometric dismissal time and the old spring-rest deadline.
  clock.advance(240);
  expect(sheet().open).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  expect(element("setup-scrim").hidden).toBe(false);
  clock.advance(1000);
  expect(sheet().open).toBe(true);
  expect(sheet().close).not.toHaveBeenCalled();
  expect(sheet().getBoundingClientRect().top).toBeCloseTo(70, 2);
  expect(clock.horizontalPositions.every((left) => left === 368)).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  expect(Number(element("setup-scrim").style.opacity)).toBe(1);

  button("close-sheet").click();
  clock.advance(400);
  expect(sheet().open).toBe(false);
  expect(sheet().close).toHaveBeenCalledTimes(1);
  expect(element("setup-scrim").hidden).toBe(true);
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(opener);
  expect(clock.horizontalPositions.every((left) => left === 368)).toBe(true);
});

it("keeps background updates pending when a closing sheet is reopened", async () => {
  const clock = sheetAnimationClock();
  const h = await launch({
    authorized: false,
    reducedMotion: false,
    initialHash: "connections",
  });
  const opener = select('[data-setup="lastfm"]');
  opener.focus();
  opener.click();
  clock.advance(1000);
  const background = connectionOverview();
  button("close-sheet").click();
  clock.advance(160);
  expect(sheet().open).toBe(true);

  h.fixture.connections.lastfm.connected = true;
  h.fixture.connections.lastfm.username = "NewlyAuthorizedListener";
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(element("confirm-username").textContent).toBe(
      "NewlyAuthorizedListener",
    ),
  );
  expect(connectionOverview()).toEqual(background);
  opener.click();
  clock.advance(1240);
  expect(sheet().open).toBe(true);
  expect(sheet().close).not.toHaveBeenCalled();
  expect(connectionOverview()).toEqual(background);
  expect(element("connected-lastfm-user").textContent).toContain(
    "NewlyAuthorizedListener",
  );

  button("close-sheet").click();
  clock.advance(400);
  expect(sheet().open).toBe(false);
  expect(sheet().close).toHaveBeenCalledTimes(1);
  expect(element("connection-lastfm-state").textContent).toBe("已连接");
  expect(element("connection-lastfm-detail").textContent).toContain(
    "NewlyAuthorizedListener",
  );
  expect(element("setup-summary").textContent).toMatch(/已完成\s*3\s*\/\s*3/);
  expect(element("page-connections").hidden).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
});

it("shows only the latest ten records in backend order and safely renders supplied text", async () => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const h = await launch({
    enabled: true,
    records: [
      {
        track: "Today song",
        artist: "Fixture Artist",
        album: "One Album",
        status: "accepted",
        timestamp_iso: today.toISOString(),
        catalog_id: "1487109637",
      },
      {
        track: "<img src=x onerror=alert(1)>",
        artist: "<svg onload=alert(1)>Other Artist</svg>",
        album: "Two Album",
        status: "pending",
        timestamp_iso: today.toISOString(),
      },
      {
        track: "Yesterday song",
        artist: "Fixture Artist",
        album: "Older Album",
        status: "accepted",
        timestamp_iso: yesterday.toISOString(),
      },
      { track: "Undated song", artist: "Other Artist", status: "accepted" },
      { track: "Fifth song", artist: "Other Artist", status: "accepted" },
      { track: "Sixth song", artist: "Other Artist", status: "accepted" },
      { track: "Seventh song", artist: "Other Artist", catalog_id: "7007" },
      { track: "Eighth song", artist: "Other Artist", catalog_id: "7008" },
      { track: "Ninth song", artist: "Other Artist", catalog_id: "7009" },
      { track: "Tenth song", artist: "Other Artist", catalog_id: "7010" },
      { track: "Eleventh song", artist: "Other Artist", catalog_id: "7011" },
      { track: "Twelfth song", artist: "Other Artist", catalog_id: "7012" },
    ],
    artworkResponse: async () => Response.json({ artwork_url: firstArtwork }),
  });
  await vi.waitFor(() =>
    expect(latestArtwork().getAttribute("src")).toBe(firstArtwork),
  );
  latestArtwork().dispatchEvent(new Event("load"));
  expect(recordTitles()).toEqual([
    "Today song",
    "<img src=x onerror=alert(1)>",
    "Yesterday song",
    "Undated song",
    "Fifth song",
    "Sixth song",
    "Seventh song",
    "Eighth song",
    "Ninth song",
    "Tenth song",
  ]);
  expect(element("records").querySelector('img[src="x"]')).toBeNull();
  for (const title of recordTitles()) {
    const row = recordRow(title!);
    expect(row.children).toHaveLength(4);
    expect(row.children[0].classList.contains("record-cover")).toBe(true);
    expect(row.children[1].classList.contains("record-track")).toBe(true);
    expect(row.children[2].classList.contains("record-artist")).toBe(true);
    expect(row.children[3].classList.contains("record-meta")).toBe(true);
    expect(row.querySelector(".record-track .record-title")?.textContent).toBe(
      title,
    );
    expect(row.querySelector(".record-track .record-subtitle")).not.toBeNull();
  }
  const artist =
    recordRow("Today song").querySelector<HTMLElement>(".record-artist")!;
  expect(artist.textContent).toBe("Fixture Artist");
  expect(artist.title).toBe("Fixture Artist");
  const untrustedArtist = recordRow(
    "<img src=x onerror=alert(1)>",
  ).querySelector<HTMLElement>(".record-artist")!;
  expect(untrustedArtist.textContent).toBe(
    "<svg onload=alert(1)>Other Artist</svg>",
  );
  expect(untrustedArtist.title).toBe("<svg onload=alert(1)>Other Artist</svg>");
  expect(untrustedArtist.querySelector("svg, img")).toBeNull();
  expect(
    recordRow("Today song").querySelector(".record-subtitle")?.textContent,
  ).toBe("Fixture Artist · One Album");
  expect(
    element("records").querySelector("button, [role=button], input"),
  ).toBeNull();
  expect(element("records").textContent).toContain("时间未提供");
  expect(element("records").textContent).toContain("待处理");
  expect(recordRow("Today song").textContent).not.toContain("已记录");
  const acceptedTime = recordRow("Today song").querySelector("time")!;
  expect(acceptedTime.dateTime).toBe(today.toISOString());
  expect(acceptedTime.textContent).not.toBe("—");
  expect(recordRow("<img src=x onerror=alert(1)>").textContent).toContain(
    "待处理",
  );
  expect(document.getElementById("search")).toBeNull();
  expect(document.querySelector("[data-filter]")).toBeNull();
  expect(recordTitles()).toHaveLength(10);
  expect(element("history-footnote").textContent).toMatch(/最近\s*10\s*首/);
  expect(element("records").textContent).not.toContain("Eleventh song");
  await vi.waitFor(() =>
    expect(rowArtwork("Tenth song")?.getAttribute("src")).toBe(firstArtwork),
  );
  expect(
    h.network.mock.calls.some(([url]) =>
      /catalog_id=701[12]/.test(String(url)),
    ),
  ).toBe(false);
  expect(element("latest-track").textContent).toBe("Today song");
  expect(element("latest-artist").textContent).toContain("Fixture Artist");
  expect(element("latest-album").textContent).toContain("One Album");
  expect(latestArtwork().getAttribute("src")).toBe(firstArtwork);
  expect(mutations(h.network)).toHaveLength(0);
});

it("links to the current verified Last.fm profile and removes an old account link when the connection becomes untrusted", async () => {
  const options: NonNullable<Parameters<typeof launch>[0]> = {
    username: "First/Listener ?#中文",
    records: [{ track: "Recent song", artist: "Artist" }],
  };
  const h = await launch(options);
  const profile = (username: string) =>
    "https://www.last.fm/user/" + encodeURIComponent(username);
  expect(moreHistory().hidden).toBe(false);
  expect(moreHistory().getAttribute("href")).toBe(profile(options.username!));
  expect(moreHistory().target).toBe("_blank");
  expect(moreHistory().rel.split(/\s+/)).toEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );

  h.fixture.connections.lastfm.username = "SecondListener";
  refreshConnections();
  await vi.waitFor(() =>
    expect(moreHistory().getAttribute("href")).toBe(profile("SecondListener")),
  );
  expect(moreHistory().outerHTML).not.toContain(
    encodeURIComponent(options.username!),
  );

  options.healthVersion = "different-algorithm";
  refreshConnections();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("需要检查"),
  );
  expect(moreHistory().hidden).toBe(true);
  expect(moreHistory().hasAttribute("href")).toBe(false);
  expect(moreHistory().outerHTML).not.toContain("SecondListener");
  expect(element("history-footnote").textContent).toContain("上次读取");
  expect(mutations(h.network)).toHaveLength(0);
});

it.each<NonNullable<Parameters<typeof launch>[0]>>([
  { installed: false },
  { hasHostPermission: false },
  { networkError: true },
  { authorized: false },
  { username: "" },
  { username: ".." },
  { username: "\ud800" },
])("keeps unavailable Last.fm history links inert for %j", async (options) => {
  await launch(options);
  expect(moreHistory().hidden).toBe(true);
  expect(moreHistory().hasAttribute("href")).toBe(false);
});

it("shows the latest recorded song and its real album sleeve without the marketing hero", async () => {
  const artwork = vi.fn(async () =>
    Response.json({ artwork_url: firstArtwork }),
  );
  await launch({
    enabled: true,
    records: [
      {
        track: "Latest song",
        artist: "Latest artist",
        album: "Latest album",
        catalog_id: "1487109637",
      },
      {
        track: "Older song",
        artist: "Older artist",
        album: "Older album",
        catalog_id: "1487091683",
      },
    ],
    artworkResponse: artwork,
  });
  expect(recordTitles()).toEqual(["Latest song", "Older song"]);
  expect(element("latest-track").textContent).toBe("Latest song");
  expect(element("latest-artist").textContent).toContain("Latest artist");
  expect(element("latest-album").textContent).toContain("Latest album");
  for (const removed of [
    "hero-description",
    "total-recorded",
    "apple-status",
    "lastfm-status",
    "apple-check",
    "lastfm-check",
    "last-checked",
    "pending-count",
  ])
    expect(document.getElementById(removed)).toBeNull();
  expect(document.querySelector(".memory-disc")).not.toBeNull();
  expect(latestArtwork().closest(".memory-sleeve")).not.toBeNull();
  await vi.waitFor(() =>
    expect(latestArtwork().getAttribute("src")).toBe(firstArtwork),
  );
  latestArtwork().dispatchEvent(new Event("load"));
  expect(latestArtwork().hidden).toBe(false);
  expect(element("artwork-placeholder").hidden).toBe(true);
  expect(artwork).toHaveBeenCalledWith("1487109637");
  expect(artwork).toHaveBeenCalledWith("1487091683");
  expect(artwork).toHaveBeenCalledTimes(2);
});

it("does not borrow an older song's cover when the latest record has no Apple ID", async () => {
  const artwork = vi.fn(async () =>
    Response.json({ artwork_url: firstArtwork }),
  );
  await launch({
    records: [
      { track: "Latest uncatalogued song", artist: "New artist" },
      { track: "Older song", artist: "Old artist", catalog_id: "1487109637" },
    ],
    artworkResponse: artwork,
  });
  expect(element("latest-track").textContent).toBe("Latest uncatalogued song");
  expect(latestArtwork().getAttribute("src")).toBeNull();
  expect(element("artwork-placeholder").hidden).toBe(false);
  await vi.waitFor(() => expect(artwork).toHaveBeenCalledWith("1487109637"));
});

it.each(["1487109637", "i.abc123XYZ"])(
  "uses the original Apple track ID %s for both covers when catalog_id is null",
  async (trackId) => {
    const artwork = vi.fn(async (id: string) =>
      Response.json({
        artwork_url: id === trackId ? firstArtwork : secondArtwork,
      }),
    );
    const h = await launch({
      records: [
        {
          track: "Latest source song",
          artist: "Latest artist",
          album: "Original album",
          track_id: trackId,
          catalog_id: null,
        },
        { track: "Older song", artist: "Old artist", catalog_id: "1487091683" },
      ],
      artworkResponse: artwork,
    });
    await vi.waitFor(() => {
      expect(latestArtwork().getAttribute("src")).toBe(firstArtwork);
      expect(rowArtwork("Latest source song")?.getAttribute("src")).toBe(
        firstArtwork,
      );
      expect(rowArtwork("Older song")?.getAttribute("src")).toBe(secondArtwork);
    });
    latestArtwork().dispatchEvent(new Event("load"));
    rowArtwork("Latest source song")!.dispatchEvent(new Event("load"));
    expect(latestArtwork().hidden).toBe(false);
    expect(rowArtwork("Latest source song")?.hidden).toBe(false);
    expect(element("artwork-placeholder").hidden).toBe(true);
    expect(artwork.mock.calls.filter(([id]) => id === trackId)).toHaveLength(1);
    const requests = h.network.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname === "/api/v1/artwork");
    expect(
      requests.some((url) => url.searchParams.get("track_id") === trackId),
    ).toBe(true);
    expect(requests.some((url) => url.searchParams.has("record_key"))).toBe(
      false,
    );
    expect(mutations(h.network)).toHaveLength(0);
  },
);

it("prefers the preserved source ID over a different matched catalogue ID", async () => {
  const artwork = vi.fn(async (id: string) =>
    Response.json({
      artwork_url: id === "i.originalSong" ? firstArtwork : secondArtwork,
    }),
  );
  const h = await launch({
    records: [
      {
        track: "Source song",
        artist: "Original artist",
        album: "Original album",
        track_id: "i.originalSong",
        catalog_id: "1487091683",
      },
    ],
    artworkResponse: artwork,
  });
  await vi.waitFor(() => {
    expect(latestArtwork().getAttribute("src")).toBe(firstArtwork);
    expect(rowArtwork("Source song")?.getAttribute("src")).toBe(firstArtwork);
  });
  expect(artwork).toHaveBeenCalledExactlyOnceWith("i.originalSong");
  const requests = h.network.mock.calls
    .map(([url]) => new URL(String(url)))
    .filter((url) => url.pathname === "/api/v1/artwork");
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get("track_id")).toBe("i.originalSong");
  expect(requests[0].searchParams.has("catalog_id")).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
});

it("refreshes both covers when the source ID changes while the visible metadata stays the same", async () => {
  const artwork = vi.fn(async (id: string) =>
    Response.json({
      artwork_url: id === "i.originalSong" ? firstArtwork : secondArtwork,
    }),
  );
  const record = {
    track: "Same title",
    artist: "Same artist",
    album: "Same album",
    track_id: "i.originalSong",
    catalog_id: null,
  };
  const h = await launch({ records: [record], artworkResponse: artwork });
  await vi.waitFor(() =>
    expect(rowArtwork(record.track)?.getAttribute("src")).toBe(firstArtwork),
  );
  const oldCover = rowArtwork(record.track)!;
  h.fixture.runtime.records = [{ ...record, track_id: "i.changedSong" }];
  refreshConnections();
  await vi.waitFor(() => {
    expect(latestArtwork().getAttribute("src")).toBe(secondArtwork);
    expect(rowArtwork(record.track)?.getAttribute("src")).toBe(secondArtwork);
  });
  expect(oldCover.isConnected).toBe(false);
  expect(artwork).toHaveBeenCalledWith("i.changedSong");
});

it("uses each list record's album artwork and retains the music placeholder when its cover is unavailable", async () => {
  const h = await launch({
    records: [
      {
        track: "First song",
        artist: "First artist",
        album: "First album",
        catalog_id: "1001",
      },
      {
        track: "Second song",
        artist: "Second artist",
        album: "Second album",
        catalog_id: "1002",
      },
      { track: "No catalogue", artist: "Third artist" },
      { track: "Missing cover", artist: "Fourth artist", catalog_id: "1004" },
      { track: "Failed cover", artist: "Fifth artist", catalog_id: "1005" },
      { track: "Image failure", artist: "Sixth artist", catalog_id: "1006" },
    ],
    artworkResponse: async (id) =>
      Response.json(
        {
          artwork_url:
            id === "1001"
              ? firstArtwork
              : id === "1002" || id === "1006"
                ? secondArtwork
                : null,
        },
        { status: id === "1005" ? 503 : 200 },
      ),
  });
  await vi.waitFor(() => {
    expect(rowArtwork("First song")?.getAttribute("src")).toBe(firstArtwork);
    expect(rowArtwork("Second song")?.getAttribute("src")).toBe(secondArtwork);
    expect(rowArtwork("Image failure")?.getAttribute("src")).toBe(
      secondArtwork,
    );
  });
  expect(
    recordRow("First song").querySelector(".record-subtitle")?.textContent,
  ).toBe("First artist · First album");
  expect(
    recordRow("Second song").querySelector(".record-subtitle")?.textContent,
  ).toBe("Second artist · Second album");
  for (const title of ["First song", "Second song"]) {
    expect(rowArtwork(title)?.hidden).toBe(true);
    rowArtwork(title)!.dispatchEvent(new Event("load"));
    expect(rowArtwork(title)?.hidden).toBe(false);
    expect(
      recordRow(title).querySelector<HTMLElement>(".record-cover")?.dataset
        .artwork,
    ).toBe("true");
  }
  for (const title of ["No catalogue", "Missing cover", "Failed cover"]) {
    expect(rowArtwork(title)).toBeNull();
    expect(recordRow(title).querySelector(".record-cover svg")).not.toBeNull();
    expect(
      recordRow(title).querySelector<HTMLElement>(".record-cover")?.dataset
        .artwork,
    ).not.toBe("true");
  }
  rowArtwork("Image failure")!.dispatchEvent(new Event("error"));
  expect(rowArtwork("Image failure")).toBeNull();
  expect(
    recordRow("Image failure").querySelector(".record-cover svg"),
  ).not.toBeNull();
  expect(element("global-error").hidden).toBe(true);
  expect(mutations(h.network)).toHaveLength(0);
});

it("shares one artwork request between repeated list records and the latest album sleeve", async () => {
  const artwork = vi.fn(async (id: string) =>
    Response.json({
      artwork_url: id === "1001" ? firstArtwork : secondArtwork,
    }),
  );
  const h = await launch({
    records: [
      { track: "Latest play", artist: "Artist", catalog_id: "1001" },
      { track: "Other song", artist: "Artist", catalog_id: "1002" },
      { track: "Earlier play", artist: "Artist", catalog_id: "1001" },
    ],
    artworkResponse: artwork,
  });
  await vi.waitFor(() => {
    expect(latestArtwork().getAttribute("src")).toBe(firstArtwork);
    expect(rowArtwork("Latest play")?.getAttribute("src")).toBe(firstArtwork);
    expect(rowArtwork("Earlier play")?.getAttribute("src")).toBe(firstArtwork);
    expect(rowArtwork("Other song")?.getAttribute("src")).toBe(secondArtwork);
  });
  expect(artwork.mock.calls.filter(([id]) => id === "1001")).toHaveLength(1);
  expect(artwork.mock.calls.filter(([id]) => id === "1002")).toHaveLength(1);
  const artworkRequests = () =>
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ).length;
  expect(artworkRequests()).toBe(2);
  refreshConnections();
  await vi.waitFor(() =>
    expect(element("toast").textContent).toContain("连接状态已更新"),
  );
  await vi.waitFor(() =>
    expect(rowArtwork("Earlier play")?.getAttribute("src")).toBe(firstArtwork),
  );
  expect(artworkRequests()).toBe(2);
  expect(latestArtwork().getAttribute("src")).toBe(firstArtwork);
});

it("keeps loaded record rows and covers stable while pausing, starting, and refreshing unchanged songs", async () => {
  const artwork = vi.fn(async (id: string) =>
    Response.json({
      artwork_url: id === "1001" ? firstArtwork : secondArtwork,
    }),
  );
  const h = await launch({
    enabled: true,
    records: [{ track: "Stable song", artist: "Artist", catalog_id: "1001" }],
    artworkResponse: artwork,
  });
  await vi.waitFor(() =>
    expect(rowArtwork("Stable song")?.getAttribute("src")).toBe(firstArtwork),
  );
  const row = recordRow("Stable song");
  const image = rowArtwork("Stable song")!;
  image.dispatchEvent(new Event("load"));
  const expectLoadedSong = () => {
    expect(recordRow("Stable song")).toBe(row);
    expect(rowArtwork("Stable song")).toBe(image);
    expect(image.hidden).toBe(false);
    expect(image.getAttribute("src")).toBe(firstArtwork);
    expect(row.querySelectorAll(".record-cover img")).toHaveLength(1);
  };
  button("top-status").click();
  button("pause-recording").click();
  const whilePausing = {
    busy: button("pause-recording").disabled,
    row: recordRow("Stable song"),
    image: rowArtwork("Stable song"),
    hidden: rowArtwork("Stable song")?.hidden,
  };
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(whilePausing.busy).toBe(true);
  expect(whilePausing.row).toBe(row);
  expect(whilePausing.image).toBe(image);
  expect(whilePausing.hidden).toBe(false);
  expectLoadedSong();
  button("top-status").click();
  button("start-recording").click();
  const whileStarting = {
    busy: button("start-recording").disabled,
    row: recordRow("Stable song"),
    image: rowArtwork("Stable song"),
    hidden: rowArtwork("Stable song")?.hidden,
  };
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(whileStarting.busy).toBe(true);
  expect(whileStarting.row).toBe(row);
  expect(whileStarting.image).toBe(image);
  expect(whileStarting.hidden).toBe(false);
  expectLoadedSong();
  refreshConnections();
  await vi.waitFor(() =>
    expect(element("toast").textContent).toContain("连接状态已更新"),
  );
  expectLoadedSong();
  expect(artwork).toHaveBeenCalledTimes(1);

  h.fixture.runtime.records = [
    { track: "Actually new song", artist: "New artist", catalog_id: "1002" },
  ];
  refreshConnections();
  await vi.waitFor(() =>
    expect(rowArtwork("Actually new song")?.getAttribute("src")).toBe(
      secondArtwork,
    ),
  );
  expect(recordTitles()).toEqual(["Actually new song"]);
  expect(row.isConnected).toBe(false);
});

it("keeps an already loaded cover visible when freshness fails and recovers while updating the stale-history note", async () => {
  const options: NonNullable<Parameters<typeof launch>[0]> = {
    records: [{ track: "Saved song", artist: "Artist", catalog_id: "1001" }],
    artworkResponse: async () => Response.json({ artwork_url: firstArtwork }),
  };
  await launch(options);
  await vi.waitFor(() =>
    expect(rowArtwork("Saved song")?.getAttribute("src")).toBe(firstArtwork),
  );
  const row = recordRow("Saved song");
  const image = rowArtwork("Saved song")!;
  image.dispatchEvent(new Event("load"));
  options.networkError = true;
  refreshConnections();
  await vi.waitFor(() => expect(element("global-error").hidden).toBe(false));
  expect(recordRow("Saved song")).toBe(row);
  expect(rowArtwork("Saved song")).toBe(image);
  expect(image.hidden).toBe(false);
  expect(element("history-footnote").textContent).toContain("上次读取");
  options.networkError = false;
  button("error-recovery").click();
  await vi.waitFor(() => expect(element("global-error").hidden).toBe(true));
  expect(recordRow("Saved song")).toBe(row);
  expect(rowArtwork("Saved song")).toBe(image);
  expect(image.hidden).toBe(false);
  expect(element("history-footnote").textContent).not.toContain("上次读取");
});

it("recovers missing artwork after a later refresh without replacing the existing song row", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  try {
    let url: string | null = null;
    const artwork = vi.fn(async () => Response.json({ artwork_url: url }));
    const h = await launch({
      records: [
        { track: "Recoverable cover", artist: "Artist", catalog_id: "1001" },
      ],
      artworkResponse: artwork,
    });
    await vi.waitFor(() => expect(artwork).toHaveBeenCalledTimes(1));
    const row = recordRow("Recoverable cover");
    expect(rowArtwork("Recoverable cover")).toBeNull();
    url = firstArtwork;
    vi.setSystemTime(new Date(2026, 9, 27, 12, 1, 1));
    refreshConnections();
    await vi.waitFor(() =>
      expect(rowArtwork("Recoverable cover")?.getAttribute("src")).toBe(
        firstArtwork,
      ),
    );
    expect(recordRow("Recoverable cover")).toBe(row);
    const image = rowArtwork("Recoverable cover")!;
    image.dispatchEvent(new Event("load"));
    expect(artwork).toHaveBeenCalledTimes(2);
    const recordingReads = () =>
      h.network.mock.calls.filter(
        ([value]) => new URL(String(value)).pathname === "/api/v1/recording",
      ).length;
    const beforeRefresh = recordingReads();
    refreshConnections();
    await vi.waitFor(() => expect(recordingReads()).toBe(beforeRefresh + 1));
    expect(rowArtwork("Recoverable cover")).toBe(image);
    expect(image.hidden).toBe(false);
    expect(artwork).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("updates empty-history guidance when an unchanged empty record list recovers and recording pauses", async () => {
  const options = { networkError: true, enabled: true };
  await launch(options);
  expect(element("empty-history").hidden).toBe(false);
  expect(element("empty-history").querySelector("h3")?.textContent).toBe(
    "先确认你的连接",
  );
  options.networkError = false;
  button("error-recovery").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  expect(element("empty-history").querySelector("h3")?.textContent).toBe(
    "等一首歌的时间",
  );
  expect(element("empty-description").textContent).toContain(
    "新的播放被记录后",
  );
  button("top-status").click();
  button("pause-recording").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(element("empty-history").hidden).toBe(false);
  expect(element("empty-description").textContent).toContain("开始记录");
  expect(recordTitles()).toHaveLength(0);
});

it("updates local-day record grouping after midnight even when the songs have not changed", async () => {
  const beforeMidnight = new Date(2026, 9, 26, 23, 59);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(beforeMidnight);
  try {
    await launch({
      records: [
        {
          track: "Late song",
          artist: "Artist",
          timestamp_iso: beforeMidnight.toISOString(),
        },
      ],
    });
    expect(document.querySelector(".record-group-label")?.textContent).toMatch(
      /^今天/,
    );
    vi.setSystemTime(new Date(2026, 9, 27, 0, 1));
    refreshConnections();
    await vi.waitFor(() =>
      expect(
        document.querySelector(".record-group-label")?.textContent,
      ).toMatch(/^昨天/),
    );
    expect(recordTitles()).toEqual(["Late song"]);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a late old-row artwork response out of a refreshed record list", async () => {
  let finishOlder!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => {
    finishOlder = resolve;
  });
  const artwork = vi.fn(async (id: string) =>
    id === "1001" ? older : Response.json({ artwork_url: secondArtwork }),
  );
  const h = await launch({
    records: [{ track: "Old row", artist: "Old artist", catalog_id: "1001" }],
    artworkResponse: artwork,
  });
  await vi.waitFor(() => expect(artwork).toHaveBeenCalledWith("1001"));
  const detachedCover = recordRow("Old row").querySelector(".record-cover")!;
  h.fixture.runtime.records = [
    { track: "New row", artist: "New artist", catalog_id: "1002" },
  ];
  refreshConnections();
  await vi.waitFor(() =>
    expect(rowArtwork("New row")?.getAttribute("src")).toBe(secondArtwork),
  );
  finishOlder(Response.json({ artwork_url: firstArtwork }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(detachedCover.isConnected).toBe(false);
  expect(detachedCover.querySelector("img")).toBeNull();
  expect(recordTitles()).toEqual(["New row"]);
  expect(rowArtwork("New row")?.getAttribute("src")).toBe(secondArtwork);
});

it("clears the previous sleeve while a refreshed latest song loads its own artwork", async () => {
  let resolveNewArtwork!: (response: Response) => void;
  const newer = new Promise<Response>((resolve) => {
    resolveNewArtwork = resolve;
  });
  const h = await launch({
    records: [
      {
        track: "First song",
        artist: "First artist",
        album: "First album",
        catalog_id: "1487109637",
      },
    ],
    artworkResponse: async (id) =>
      id === "1487109637"
        ? Response.json({ artwork_url: firstArtwork })
        : newer,
  });
  await vi.waitFor(() =>
    expect(latestArtwork().getAttribute("src")).toBe(firstArtwork),
  );
  latestArtwork().dispatchEvent(new Event("load"));
  h.fixture.runtime.records = [
    {
      track: "New latest song",
      artist: "New artist",
      album: "New album",
      catalog_id: "1487091683",
    },
  ];
  refreshConnections();
  await vi.waitFor(() =>
    expect(element("latest-track").textContent).toBe("New latest song"),
  );
  expect(element("latest-album").textContent).toContain("New album");
  expect(latestArtwork().getAttribute("src")).toBeNull();
  expect(element("artwork-placeholder").hidden).toBe(false);
  resolveNewArtwork(Response.json({ artwork_url: secondArtwork }));
  await vi.waitFor(() =>
    expect(latestArtwork().getAttribute("src")).toBe(secondArtwork),
  );
  latestArtwork().dispatchEvent(new Event("load"));
  expect(latestArtwork().hidden).toBe(false);
  expect(element("artwork-placeholder").hidden).toBe(true);
  expect(mutations(h.network)).toHaveLength(0);
});

it("ignores late artwork for an older record after a newer record has loaded", async () => {
  let resolveOldArtwork!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => {
    resolveOldArtwork = resolve;
  });
  const artwork = vi.fn(async (id: string) =>
    id === "1487109637" ? older : Response.json({ artwork_url: secondArtwork }),
  );
  const h = await launch({
    records: [
      { track: "Old song", artist: "Old artist", catalog_id: "1487109637" },
    ],
    artworkResponse: artwork,
  });
  await vi.waitFor(() => expect(artwork).toHaveBeenCalledWith("1487109637"));
  h.fixture.runtime.records = [
    { track: "New song", artist: "New artist", catalog_id: "1487091683" },
  ];
  refreshConnections();
  await vi.waitFor(() =>
    expect(latestArtwork().getAttribute("src")).toBe(secondArtwork),
  );
  latestArtwork().dispatchEvent(new Event("load"));
  resolveOldArtwork(Response.json({ artwork_url: firstArtwork }));
  // Let the older fetch/json chain settle after the new image is already visible.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(element("latest-track").textContent).toBe("New song");
  expect(latestArtwork().getAttribute("src")).toBe(secondArtwork);
  expect(latestArtwork().hidden).toBe(false);
  expect(element("artwork-placeholder").hidden).toBe(true);
});

it("updates the latest sleeve during visible journal refreshes and stops background polling away from the journal", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    const h = await launch({
      records: [
        { track: "First song", artist: "Artist", catalog_id: "1487109637" },
      ],
      artworkResponse: async (id) =>
        Response.json({
          artwork_url: id === "1487109637" ? firstArtwork : secondArtwork,
        }),
    });
    await vi.waitFor(() =>
      expect(latestArtwork().getAttribute("src")).toBe(firstArtwork),
    );
    latestArtwork().dispatchEvent(new Event("load"));
    h.fixture.runtime.records = [
      {
        track: "Automatically refreshed song",
        artist: "Artist",
        catalog_id: "1487091683",
      },
    ];
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() =>
      expect(latestArtwork().getAttribute("src")).toBe(secondArtwork),
    );
    latestArtwork().dispatchEvent(new Event("load"));
    expect(element("latest-track").textContent).toBe(
      "Automatically refreshed song",
    );
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(mutations(h.network)).toHaveLength(0);

    select('[data-page="settings"]').click();
    let reads = h.network.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.network).toHaveBeenCalledTimes(reads);
    select('[data-page="journal"]').click();
    button("top-status").click();
    expect(sheet().open).toBe(true);
    reads = h.network.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.network).toHaveBeenCalledTimes(reads);
    button("close-sheet").click();
    vi.mocked(
      Object.getOwnPropertyDescriptor(document, "hidden")!.get!,
    ).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.network).toHaveBeenCalledTimes(reads);
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["not-found", "network", "unsafe-url"])(
  "keeps the music console usable with an explicit sleeve placeholder for %s",
  async (failure) => {
    await launch({
      enabled: true,
      records: [
        { track: "Latest song", artist: "Artist", catalog_id: "1487109637" },
      ],
      artworkResponse: async () => {
        if (failure === "network") throw new TypeError("private-artwork-error");
        return Response.json(
          {
            artwork_url:
              failure === "unsafe-url"
                ? "https://is1-ssl.mzstatic.com.evil.test/cover.jpg"
                : null,
          },
          { status: failure === "not-found" ? 404 : 200 },
        );
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(latestArtwork().getAttribute("src")).toBeNull();
    expect(element("artwork-placeholder").hidden).toBe(false);
    expect(rowArtwork("Latest song")).toBeNull();
    expect(
      recordRow("Latest song").querySelector(".record-cover svg"),
    ).not.toBeNull();
    expect(element("latest-track").textContent).toBe("Latest song");
    expect(element("top-status-label").textContent).toBe("正在记录");
    expect(element("global-error").hidden).toBe(true);
    expect(document.body.getAttribute("aria-busy")).toBe("false");
    expect(button("recording-action").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("private-artwork-error");
  },
);

it("returns to the sleeve placeholder when a real album image fails to load", async () => {
  await launch({
    records: [
      { track: "Latest song", artist: "Artist", catalog_id: "1487109637" },
    ],
    artworkResponse: async () => Response.json({ artwork_url: firstArtwork }),
  });
  await vi.waitFor(() =>
    expect(latestArtwork().getAttribute("src")).toBe(firstArtwork),
  );
  latestArtwork().dispatchEvent(new Event("error"));
  expect(latestArtwork().getAttribute("src")).toBeNull();
  expect(latestArtwork().hidden).toBe(true);
  expect(element("artwork-placeholder").hidden).toBe(false);
  expect(element("global-error").hidden).toBe(true);
});

it.each(["latest", "row"] as const)(
  "forgets failed %s artwork so the next retry reads fresh metadata",
  async (target) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 27, 12));
    try {
      let url = firstArtwork;
      const artwork = vi.fn(async () => Response.json({ artwork_url: url }));
      const h = await launch({
        records: [
          { track: "Recovering cover", artist: "Artist", track_id: "1001" },
        ],
        artworkResponse: artwork,
      });
      await vi.waitFor(() =>
        expect(rowArtwork("Recovering cover")?.getAttribute("src")).toBe(
          firstArtwork,
        ),
      );
      latestArtwork().dispatchEvent(new Event("load"));
      rowArtwork("Recovering cover")!.dispatchEvent(new Event("load"));
      expect(
        (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
      ).toHaveLength(1);
      (target === "latest"
        ? latestArtwork()
        : rowArtwork("Recovering cover")!
      ).dispatchEvent(new Event("error"));
      await vi.waitFor(() =>
        expect(
          (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
        ).toEqual([]),
      );
      url = secondArtwork;
      vi.setSystemTime(new Date(2026, 9, 27, 12, 1, 1));
      refreshConnections();
      await vi.waitFor(() =>
        expect(
          (target === "latest"
            ? latestArtwork()
            : rowArtwork("Recovering cover")
          )?.getAttribute("src"),
        ).toBe(secondArtwork),
      );
      expect(artwork).toHaveBeenCalledTimes(2);
      expect(element("global-error").hidden).toBe(true);
      expect(settingsWrites(h)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("does not let a detached row's late image error evict the same song's current persisted URL", async () => {
  const h = await launch({
    records: [{ track: "Returning song", artist: "Artist", track_id: "1001" }],
    artworkResponse: async () => Response.json({ artwork_url: firstArtwork }),
  });
  await vi.waitFor(() =>
    expect(rowArtwork("Returning song")?.getAttribute("src")).toBe(
      firstArtwork,
    ),
  );
  const oldImage = rowArtwork("Returning song")!;
  oldImage.dispatchEvent(new Event("load"));
  h.fixture.runtime.records = [
    { track: "Different song", artist: "Artist", track_id: "1002" },
  ];
  refreshConnections();
  await vi.waitFor(() =>
    expect(rowArtwork("Different song")?.getAttribute("src")).toBe(
      firstArtwork,
    ),
  );
  h.fixture.runtime.records = [
    { track: "Returning song", artist: "Artist", track_id: "1001" },
  ];
  refreshConnections();
  await vi.waitFor(() =>
    expect(rowArtwork("Returning song")?.getAttribute("src")).toBe(
      firstArtwork,
    ),
  );
  expect(oldImage.isConnected).toBe(false);
  oldImage.dispatchEvent(new Event("error"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: Array<{ url: string }> })
      .entries[0].url,
  ).toBe(firstArtwork);
  expect(rowArtwork("Returning song")?.getAttribute("src")).toBe(firstArtwork);
});

it("reloads both covers for a different Last.fm account even when the latest record payload is unchanged", async () => {
  let url = firstArtwork;
  const artwork = vi.fn(async () => Response.json({ artwork_url: url }));
  const h = await launch({
    records: [
      { track: "Same recorded song", artist: "Artist", track_id: "1001" },
    ],
    artworkResponse: artwork,
  });
  await vi.waitFor(() =>
    expect(rowArtwork("Same recorded song")?.getAttribute("src")).toBe(
      firstArtwork,
    ),
  );
  const previousSleeve = latestArtwork();
  previousSleeve.dispatchEvent(new Event("load"));
  rowArtwork("Same recorded song")!.dispatchEvent(new Event("load"));
  h.fixture.connections.lastfm.username = "DifferentListener";
  url = secondArtwork;
  refreshConnections();
  await vi.waitFor(() => {
    expect(latestArtwork().getAttribute("src")).toBe(secondArtwork);
    expect(rowArtwork("Same recorded song")?.getAttribute("src")).toBe(
      secondArtwork,
    );
  });
  expect(latestArtwork()).not.toBe(previousSleeve);
  expect(artwork).toHaveBeenCalledTimes(2);
  previousSleeve.dispatchEvent(new Event("error"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(latestArtwork().getAttribute("src")).toBe(secondArtwork);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: Array<{ url: string }> })
      .entries[0].url,
  ).toBe(secondArtwork);
});

it("restores and saves appearance independently without rechecking the service", async () => {
  const h = await launch({ savedTheme: "dark" });
  await vi.waitFor(() =>
    expect(document.documentElement.dataset.theme).toBe("dark"),
  );
  openRecordingControls();
  button("close-sheet").click();
  select('[data-page="settings"]').click();
  const reads = h.network.mock.calls.length;
  select('[data-theme-choice="light"]').click();
  await vi.waitFor(() =>
    expect(h.storageSet).toHaveBeenCalledWith({ [THEME_STORAGE_KEY]: "light" }),
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  select('[data-theme-choice="system"]').click();
  await vi.waitFor(() =>
    expect(h.storageSet).toHaveBeenCalledWith({
      [THEME_STORAGE_KEY]: "system",
    }),
  );
  h.changeSystemTheme(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(
    select('[data-theme-choice="system"]').getAttribute("aria-pressed"),
  ).toBe("true");
  expect(element("confirm-username").textContent).toBe("FixtureListener");
  expect(document.getElementById("confirm-account")).toBeNull();
  expect(h.network).toHaveBeenCalledTimes(reads);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(settingsWrites(h)).toHaveLength(2);
});

it("starts with one explicit click and pauses using the resulting remote state", async () => {
  const h = await launch();
  expect(mutations(h.network)).toHaveLength(0);
  openRecordingControls();
  expect(element("confirm-username").textContent).toBe("FixtureListener");
  button("start-recording").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  expect(sheet().open).toBe(false);
  expect(document.getElementById("confirm-account")).toBeNull();
  const start = mutations(h.network)[0];
  expect(String(start[0])).toBe(origin + "/api/v1/recording/start");
  expect(JSON.parse(String(start[1]?.body))).toEqual({
    username: "FixtureListener",
  });
  select('[data-page="connections"]').click();
  button("recording-action").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("记录已暂停"),
  );
  expect(mutations(h.network).map(([url]) => String(url))).toEqual([
    origin + "/api/v1/recording/start",
    origin + "/api/v1/recording/pause",
  ]);
});

it("pauses and restarts from connection settings with one click per action", async () => {
  const h = await launch({ enabled: true });
  expect(element("page-journal").hidden).toBe(false);
  select('[data-page="connections"]').click();
  expect(button("recording-action").textContent).toContain("暂停记录");
  button("recording-action").focus();
  button("recording-action").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("记录已暂停"),
  );
  expect(element("page-connections").hidden).toBe(false);
  expect(button("recording-action").textContent).toContain("开始记录");
  expect(sheet().open).toBe(false);
  expect(mutations(h.network).map(([url]) => String(url))).toEqual([
    origin + "/api/v1/recording/pause",
  ]);

  button("recording-action").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  expect(sheet().open).toBe(false);
  expect(element("page-journal").hidden).toBe(false);
  expect(mutations(h.network).map(([url]) => String(url))).toEqual([
    origin + "/api/v1/recording/pause",
    origin + "/api/v1/recording/start",
  ]);
});

it("opens recording controls from the top status and restarts with one click after a pause", async () => {
  const h = await launch({ enabled: true });
  const top = button("top-status");
  top.focus();
  top.click();
  expect(sheet().open).toBe(true);
  expect(element("page-journal").hidden).toBe(false);
  expect(element("sheet-label").textContent).toBe("记录设置");
  expect(element("sheet-title").textContent).toContain("正在记录");
  expect(element("setup-progress").hidden).toBe(true);
  expect(element("sheet-step-label").hidden).toBe(true);
  expect(element("recording-pause-controls").hidden).toBe(false);
  expect(element("recording-start-controls").hidden).toBe(true);
  expect(button("pause-recording").disabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
  expect(h.requestPermission).not.toHaveBeenCalled();

  button("pause-recording").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(element("top-status-label").textContent).toBe("记录已暂停");
  expect(element("page-journal").hidden).toBe(false);
  expect(document.activeElement).toBe(top);
  expect(mutations(h.network).map(([url]) => String(url))).toEqual([
    origin + "/api/v1/recording/pause",
  ]);

  top.click();
  expect(element("sheet-title").textContent).toContain("记录已暂停");
  expect(element("recording-pause-controls").hidden).toBe(true);
  expect(element("recording-start-controls").hidden).toBe(false);
  expect(button("start-recording").disabled).toBe(false);
  button("start-recording").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(element("top-status-label").textContent).toBe("正在记录");
  expect(document.activeElement).toBe(top);
  expect(mutations(h.network).map(([url]) => String(url))).toEqual([
    origin + "/api/v1/recording/pause",
    origin + "/api/v1/recording/start",
  ]);
});

it.each([
  { options: { installed: false }, step: "cloud" },
  { options: { enabled: true, appleConnected: false }, step: "apple" },
  { options: { enabled: true, authorized: false }, step: "lastfm" },
])(
  "keeps incomplete top-status connections in the $step guide",
  async ({ options, step }) => {
    const h = await launch(options);
    button("top-status").click();
    expect(sheet().open).toBe(true);
    expect(select<HTMLElement>(`[data-step-panel="${step}"]`).hidden).toBe(
      false,
    );
    expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(
      true,
    );
    expect(element("setup-progress").hidden).toBe(false);
    expect(element("sheet-step-label").hidden).toBe(false);
    expect(mutations(h.network)).toHaveLength(0);
  },
);

it("checks an unverified saved connection from the top status without offering quick pause", async () => {
  const h = await launch({ enabled: true, hasHostPermission: false });
  expect(element("top-status-label").textContent).toBe("需要检查");
  button("top-status").click();
  expect(sheet().open).toBe(false);
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  expect(sheet().open).toBe(false);
  expect(h.requestPermission).toHaveBeenCalledTimes(1);
  expect(mutations(h.network)).toHaveLength(0);
});

it("prevents duplicate pause requests while the recording controls are busy", async () => {
  const h = await launch({ enabled: true });
  button("top-status").click();
  let allowPause!: (value: boolean) => void;
  h.requestPermission.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        allowPause = resolve;
      }),
  );
  button("pause-recording").click();
  expect(document.body.getAttribute("aria-busy")).toBe("false");
  expect(button("pause-recording").disabled).toBe(true);
  expect(button("start-recording").disabled).toBe(true);
  button("pause-recording").click();
  expect(h.requestPermission).toHaveBeenCalledTimes(1);
  expect(mutations(h.network)).toHaveLength(0);
  allowPause(true);
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(mutations(h.network)).toHaveLength(1);
});

it("keeps failed quick-pause controls open and recovers state before an explicit retry", async () => {
  const h = await launch({ enabled: true });
  h.fixture.pauseError = Object.assign(
    Error("private-pause-transport-details"),
    { name: "TimeoutError" },
  );
  button("top-status").click();
  button("pause-recording").click();
  await vi.waitFor(() => expect(element("sheet-error").hidden).toBe(false));
  expect(sheet().open).toBe(true);
  expect(button("pause-recording").disabled).toBe(true);
  expect(button("start-recording").disabled).toBe(true);
  expect(element("toast").hidden).toBe(true);
  expect(element("top-status-label").textContent).toBe("正在记录");
  expect(document.body.textContent).not.toContain(
    "private-pause-transport-details",
  );
  expect(mutations(h.network)).toHaveLength(1);

  h.fixture.pauseError = null;
  button("sheet-recovery").click();
  await vi.waitFor(() => expect(element("sheet-error").hidden).toBe(true));
  expect(sheet().open).toBe(true);
  expect(button("pause-recording").disabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(1);
  button("pause-recording").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(element("top-status-label").textContent).toBe("记录已暂停");
  expect(mutations(h.network)).toHaveLength(2);
});

it("keeps quick-pause controls open when remote readback says recording is still active", async () => {
  const h = await launch({ enabled: true });
  h.fixture.pauseReadbackEnabled = true;
  button("top-status").click();
  button("pause-recording").click();
  await vi.waitFor(() =>
    expect(element("sheet-feedback").textContent).toContain("仍在"),
  );
  expect(sheet().open).toBe(true);
  expect(element("top-status-label").textContent).toBe("正在记录");
  expect(element("recording-pause-controls").hidden).toBe(false);
  expect(button("pause-recording").disabled).toBe(false);
  expect(element("toast").textContent).not.toContain("已暂停");
  expect(mutations(h.network)).toHaveLength(1);
});

it("switches open recording controls to the latest remote state without starting automatically", async () => {
  const h = await launch();
  button("top-status").click();
  expect(element("recording-start-controls").hidden).toBe(false);
  expect(button("start-recording").disabled).toBe(false);
  h.fixture.runtime.enabled = true;
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(element("recording-pause-controls").hidden).toBe(false),
  );
  expect(element("recording-start-controls").hidden).toBe(true);
  expect(button("start-recording").disabled).toBe(true);

  const later = Date.now() + 4000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);
  try {
    h.fixture.runtime.enabled = false;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(element("recording-start-controls").hidden).toBe(false),
    );
    expect(element("recording-pause-controls").hidden).toBe(true);
    expect(button("start-recording").disabled).toBe(false);
    expect(sheet().open).toBe(true);
    expect(mutations(h.network)).toHaveLength(0);
  } finally {
    clock.mockRestore();
  }
});

it("reports the final readback when another tab reverses a successful start or pause", async () => {
  const h = await launch();
  h.fixture.startReadbackEnabled = false;
  h.fixture.pauseReadbackEnabled = true;
  openRecordingControls();
  button("start-recording").click();
  await vi.waitFor(() =>
    expect(element("sheet-feedback").textContent).toContain("记录仍处于暂停"),
  );
  expect(element("top-status-label").textContent).toBe("记录已暂停");
  expect(sheet().open).toBe(true);
  expect(button("start-recording").disabled).toBe(false);
  expect(element("toast").hidden).toBe(true);

  button("close-sheet").click();
  // Another tab starts the service. This tab reads that state before trying
  // to pause; a later concurrent start reverses the successful pause response.
  h.fixture.runtime.enabled = true;
  button("refresh").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  button("recording-action").click();
  await vi.waitFor(() =>
    expect(element("toast").textContent).toContain("记录仍在运行"),
  );
  expect(element("top-status-label").textContent).toBe("正在记录");
  expect(button("recording-action").textContent).toContain("暂停记录");
  expect(element("toast").textContent).not.toContain("已暂停");
  expect(mutations(h.network).map(([url]) => String(url))).toEqual([
    origin + "/api/v1/recording/start",
    origin + "/api/v1/recording/pause",
  ]);
});

it("shows the current Last.fm account after focus refresh without starting automatically", async () => {
  const h = await launch();
  openRecordingControls();
  h.fixture.connections.lastfm.username = "AnotherListener";
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(element("confirm-username").textContent).toBe("AnotherListener"),
  );
  expect(button("start-recording").disabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it.each([
  "apple_reconnect_required",
  "lastfm_reconnect_required",
  "apple_unavailable",
  "lastfm_unavailable",
  "recording_unavailable",
] as const)(
  "shows HTTP200 recording failure %s and keeps pause available without rebuilding songs",
  async (code) => {
    const h = await launch({
      enabled: true,
      initialHash: "connections",
      records: [
        {
          track: "Stable song",
          artist: "Artist",
          track_id: "123",
          timestamp_iso: "2026-10-27T12:00:00Z",
        },
      ],
    });
    const row = recordRow("Stable song");
    h.fixture.runtime.recording_issue = { code };
    button("refresh").click();
    await vi.waitFor(() =>
      expect(element("top-status-label").textContent).toBe("需要检查"),
    );
    expect(element("top-status").dataset.state).toBe("error");
    expect(element("recording-status").dataset.active).toBe("false");
    expect(element("global-error").hidden).toBe(false);
    expect(recordRow("Stable song")).toBe(row);
    button("top-status").click();
    expect(element("sheet-title").textContent).toBe("记录需要检查。");
    expect(button("pause-recording").disabled).toBe(false);
    button("pause-recording").click();
    await vi.waitFor(() => expect(sheet().open).toBe(false));
    expect(h.fixture.runtime.enabled).toBe(false);
    expect(
      mutations(h.network).map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/v1/recording/pause"]);
  },
);

it("clears an explicit recording issue on successful readback, ignoring retained historical raw errors", async () => {
  const h = await launch({
    enabled: true,
    recordingIssue: { code: "apple_reconnect_required" },
  });
  expect(element("top-status-label").textContent).toBe("需要检查");
  Object.assign(h.fixture.runtime.stats, {
    last_error_message: "apple_token_expired",
    last_error_iso: "2026-10-27T12:00:00Z",
  });
  h.fixture.runtime.recording_issue = null;
  button("refresh").click();
  await vi.waitFor(() =>
    expect(element("top-status-label").textContent).toBe("正在记录"),
  );
  expect(element("global-error").hidden).toBe(true);
  expect(element("top-status").dataset.state).toBe("active");
});

it("keeps a changed-account queue blocked after wrong authorization and recovers only after original-account authorization", async () => {
  const h = await launch({
    username: "NewListener",
    recordingIssue: {
      code: "queue_account_changed",
      queue_owner: "OriginalListener",
    },
  });
  expect(element("error-detail").textContent).toContain("OriginalListener");
  expect(element("error-detail").textContent).toContain(
    "退出当前账户并登录原账户",
  );
  expect(button("start-recording").disabled).toBe(true);
  button("error-recovery").click();
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(false);
  expect(element("lastfm-configuration").hidden).toBe(false);
  expect(element("lastfm-form").hidden).toBe(true);
  expect(element("lastfm-application-guide").hidden).toBe(true);
  expect(element("lastfm-authorization-description").textContent).toContain(
    "OriginalListener",
  );
  expect(button("authorize-lastfm").disabled).toBe(false);
  button("authorize-lastfm").click();
  await vi.waitFor(() => expect(h.openTab).toHaveBeenCalledTimes(1));
  await h.ready();
  h.emitTabUpdated(202, authorizationCallbackUrl + "?result=connected");
  await vi.waitFor(() => expect(h.updateTab).toHaveBeenCalled());
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(false);
  expect(button("start-recording-lastfm").disabled).toBe(true);
  expect(element("lastfm-form").hidden).toBe(true);
  expect(element("sheet-title").textContent).not.toContain("设置已完成");
  button("check-authorization").click();
  await vi.waitFor(() =>
    expect(element("sheet-feedback").textContent).toContain(
      "原账户的待提交歌曲仍需处理",
    ),
  );
  expect(element("sheet-feedback").textContent).not.toContain("可以开始");
  expect(element("lastfm-form").hidden).toBe(true);
  button("authorize-lastfm").click();
  await vi.waitFor(() => expect(h.openTab).toHaveBeenCalledTimes(2));
  await h.ready();
  h.fixture.connections.lastfm.username = "OriginalListener";
  h.fixture.runtime.recording_issue = null;
  h.emitTabUpdated(202, authorizationCallbackUrl + "?result=connected");
  await vi.waitFor(() =>
    expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(
      false,
    ),
  );
  expect(element("confirm-username").textContent).toBe("OriginalListener");
  expect(button("start-recording").disabled).toBe(false);
  expect(h.fixture.runtime.enabled).toBe(false);
  expect(
    mutations(h.network).every(
      ([url]) => !String(url).endsWith("/recording/start"),
    ),
  ).toBe(true);
});

it("opens an already configured Last.fm recovery directly at authorization, with optional application editing", async () => {
  const h = await launch({
    recordingIssue: { code: "lastfm_reconnect_required" },
    applicationConfigured: true,
  });
  button("error-recovery").click();
  expect(element("lastfm-configuration").hidden).toBe(false);
  expect(element("lastfm-complete").hidden).toBe(true);
  expect(element("lastfm-application-guide").hidden).toBe(true);
  expect(element("lastfm-application-urls").hidden).toBe(true);
  expect(element("lastfm-form").hidden).toBe(true);
  expect(element("lastfm-authorization-number").hidden).toBe(true);
  expect(button("authorize-lastfm").disabled).toBe(false);
  expect(button("check-authorization").disabled).toBe(false);
  expect(button("reconfigure-lastfm-recovery").hidden).toBe(false);
  expect(element("sheet-description").textContent).toBe(
    "重新授权你的 Last.fm 账户，继续使用已保存的应用配置。",
  );
  expect(mutations(h.network)).toHaveLength(0);
  button("reconfigure-lastfm-recovery").click();
  expect(element("lastfm-form").hidden).toBe(false);
  expect(element("lastfm-application-guide").hidden).toBe(false);
  expect(element("lastfm-application-urls").hidden).toBe(false);
  expect(document.activeElement).toBe(element("sheet-title"));
  expect(mutations(h.network)).toHaveLength(0);
});

it("focuses the new step heading and reconfiguration heading, but does not refocus on unchanged refresh", async () => {
  const h = await launch({ authorized: false });
  select('[data-setup="apple"]').click();
  expect(document.activeElement).toBe(button("close-sheet"));
  select('[data-continue="lastfm"]').click();
  expect(document.activeElement).toBe(element("sheet-title"));
  input("lastfm-key").focus();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(
      h.network.mock.calls.filter(([url]) => String(url).endsWith("/recording"))
        .length,
    ).toBeGreaterThan(1),
  );
  expect(document.activeElement).toBe(input("lastfm-key"));
  h.fixture.connections.lastfm.connected = true;
  h.emitTabUpdated(202, authorizationCallbackUrl + "?result=connected");
  button("check-authorization").click();
  await vi.waitFor(() =>
    expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(
      false,
    ),
  );
  button("close-sheet").click();
  select('[data-setup="lastfm"]').click();
  button("reconfigure-lastfm").click();
  expect(document.activeElement).toBe(element("sheet-title"));
});

it("does not hide a form or take focus when authorization returns while a new application is being edited", async () => {
  const h = await launch({ authorized: false });
  select('[data-setup="lastfm"]').click();
  button("authorize-lastfm").click();
  await vi.waitFor(() => expect(h.openTab).toHaveBeenCalled());
  await h.ready();
  input("lastfm-key").value = "work-in-progress";
  input("lastfm-key").focus();
  h.fixture.connections.lastfm.connected = true;
  h.emitTabUpdated(202, authorizationCallbackUrl + "?result=connected");
  await vi.waitFor(() => expect(h.updateTab).toHaveBeenCalled());
  expect(document.activeElement).toBe(input("lastfm-key"));
  expect(element("lastfm-configuration").hidden).toBe(false);
  expect(input("lastfm-key").value).toBe("work-in-progress");
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(false);
});

it("refuses a start when fresh service readback finds a different account than the visible one", async () => {
  const h = await launch();
  openRecordingControls();
  expect(element("confirm-username").textContent).toBe("FixtureListener");
  h.fixture.connections.lastfm.username = "AnotherListener";
  button("start-recording").click();
  await vi.waitFor(() => expect(element("sheet-error").hidden).toBe(false));
  expect(element("confirm-username").textContent).toBe("AnotherListener");
  expect(h.fixture.runtime.enabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
  expect(sheet().open).toBe(true);
});

it("clears saved Last.fm secrets and checks authorization on return without starting automatically", async () => {
  const h = await launch({ authorized: false, applicationConfigured: false });
  select('[data-setup="lastfm"]').click();
  const authorizationPanel = select<HTMLElement>('[data-step-panel="lastfm"]');
  expect(authorizationPanel.querySelector('[data-copy="key"]')).toBeNull();
  expect(authorizationPanel.textContent).not.toContain("解锁");
  expect(document.getElementById("open-backend")).toBeNull();
  expect(button("authorize-lastfm").textContent).toContain("前往 Last.fm 授权");
  expect(button("authorize-lastfm").disabled).toBe(true);
  input("lastfm-key").value = "e".repeat(32);
  input("lastfm-secret").value = "f".repeat(32);
  button("save-lastfm").click();
  await vi.waitFor(() => expect(input("lastfm-secret").value).toBe(""));
  expect(input("lastfm-key").value).toBe("");
  expect(button("authorize-lastfm").disabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(1);
  expect(JSON.parse(String(mutations(h.network)[0][1]?.body))).toEqual({
    api_key: "e".repeat(32),
    shared_secret: "f".repeat(32),
  });
  button("authorize-lastfm").click();
  await vi.waitFor(() =>
    expect(h.openTab).toHaveBeenCalledWith({
      url: authorizationBrowserUrl,
    }),
  );
  await vi.waitFor(() =>
    expect(document.body.getAttribute("aria-busy")).toBe("false"),
  );
  expect(element("sheet-feedback").textContent).toContain(
    "请在 Last.fm 官网同意连接，完成后会自动回到余音",
  );
  expect(element("lastfm-complete").hidden).toBe(true);
  expect(document.getElementById("confirm-account")).toBeNull();
  expect(button("start-recording").disabled).toBe(true);
  expect(h.fixture.runtime.enabled).toBe(false);

  button("check-authorization").click();
  await vi.waitFor(() =>
    expect(element("sheet-feedback").textContent).toContain(
      "还没有读到授权结果，请在 Last.fm 官网同意连接后再检查",
    ),
  );
  expect(element("lastfm-complete").hidden).toBe(true);
  expect(authorizationPanel.hidden).toBe(false);
  h.fixture.connections.lastfm.connected = true;
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(element("lastfm-complete").hidden).toBe(false));
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(false);
  expect(element("setup-progress").hidden).toBe(true);
  expect(element("sheet-step-label").hidden).toBe(true);
  expect(element("confirm-username").textContent).toBe("FixtureListener");
  expect(button("start-recording").disabled).toBe(false);
  expect(h.fixture.runtime.enabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(2);
  expect(document.body.textContent).not.toContain("f".repeat(32));
});

it("returns from official Last.fm authorization to setup completion and starts only on a single explicit click", async () => {
  const h = await launch({ authorized: false });
  select('[data-setup="lastfm"]').click();
  button("authorize-lastfm").click();
  await vi.waitFor(() =>
    expect(h.openTab).toHaveBeenCalledWith({ url: authorizationBrowserUrl }),
  );
  await h.ready();
  expect(element("lastfm-complete").hidden).toBe(true);
  h.fixture.connections.lastfm.connected = true;
  h.emitTabUpdated(202, authorizationCallbackUrl + "?result=connected");
  await vi.waitFor(() => expect(element("lastfm-complete").hidden).toBe(false));
  await vi.waitFor(() =>
    expect(h.updateTab).toHaveBeenCalledWith(101, { active: true }),
  );
  expect(h.removeTab).toHaveBeenCalledWith(202);
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="confirm"]').hidden).toBe(false);
  expect(element("setup-progress").hidden).toBe(true);
  expect(element("sheet-step-label").hidden).toBe(true);
  expect(element("sheet-title").textContent).toContain("设置已完成");
  expect(document.activeElement).toBe(element("sheet-title"));
  expect(element("connected-lastfm-user").textContent).toContain(
    "FixtureListener",
  );
  expect(document.getElementById("confirm-account")).toBeNull();
  expect(button("start-recording").disabled).toBe(false);
  expect(h.fixture.runtime.enabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(1);
  button("start-recording").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(h.fixture.runtime.enabled).toBe(true);
  expect(
    mutations(h.network).map(([url]) => new URL(String(url)).pathname),
  ).toEqual([
    "/api/v1/connections/lastfm/extension/start",
    "/api/v1/recording/start",
  ]);
});

it("starts an already connected Last.fm detail view with one explicit click", async () => {
  const h = await launch();
  select('[data-setup="lastfm"]').click();
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(false);
  expect(element("sheet-step-label").textContent).toBe("03 / 03");
  expect(button("start-recording-lastfm").disabled).toBe(false);
  expect(mutations(h.network)).toHaveLength(0);
  button("start-recording-lastfm").click();
  await vi.waitFor(() => expect(sheet().open).toBe(false));
  expect(h.fixture.runtime.enabled).toBe(true);
  expect(
    mutations(h.network).map(([url]) => new URL(String(url)).pathname),
  ).toEqual(["/api/v1/recording/start"]);
});

it("recovers an uncertain start by reading state without replaying the mutation or exposing its error", async () => {
  const h = await launch();
  openRecordingControls();
  h.fixture.startError = Object.assign(Error("private-transport-details"), {
    name: "TimeoutError",
  });
  button("start-recording").click();
  await vi.waitFor(() =>
    expect(element("sheet-error").textContent).toContain("操作结果未确认"),
  );
  expect(element("sheet-error").hidden).toBe(false);
  expect(element("global-error").hidden).toBe(true);
  expect(button("start-recording").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("private-transport-details");
  // The remote mutation may have succeeded despite the interrupted response.
  h.fixture.runtime.enabled = true;
  button("sheet-recovery").click();
  await vi.waitFor(() => expect(element("sheet-error").hidden).toBe(true));
  expect(element("recording-pause-controls").hidden).toBe(false);
  expect(element("top-status-label").textContent).toBe("记录已暂停");
  button("close-sheet").click();
  expect(element("top-status-label").textContent).toBe("正在记录");
  expect(mutations(h.network)).toHaveLength(1);
});

it("retries a failed Homepage copy in the same panel without losing edits or rechecking the service", async () => {
  const h = await launch({ authorized: false });
  select('[data-setup="lastfm"]').click();
  input("lastfm-key").value = "e".repeat(32);
  input("lastfm-secret").value = "f".repeat(32);
  const reads = h.network.mock.calls.length;
  const checks = h.containsPermission.mock.calls.length;
  h.clipboard.mockRejectedValueOnce(
    new DOMException("private-clipboard-error", "NotAllowedError"),
  );
  select('[data-step-panel="lastfm"] [data-copy="homepage"]').click();
  await vi.waitFor(() =>
    expect(element("sheet-error").textContent).toContain("浏览器未允许复制"),
  );
  expect(element("sheet-feedback").textContent).not.toContain("已复制");
  expect(button("sheet-recovery").textContent).toBe("重试复制");
  button("sheet-recovery").click();
  await vi.waitFor(() =>
    expect(element("sheet-feedback").textContent).toContain("Homepage 已复制"),
  );
  expect(h.clipboard.mock.calls).toEqual([
    [installation.origin],
    [installation.origin],
  ]);
  expect(sheet().open).toBe(true);
  expect(select<HTMLElement>('[data-step-panel="lastfm"]').hidden).toBe(false);
  expect(input("lastfm-key").value).toBe("e".repeat(32));
  expect(input("lastfm-secret").value).toBe("f".repeat(32));
  expect(h.network).toHaveBeenCalledTimes(reads);
  expect(h.containsPermission).toHaveBeenCalledTimes(checks);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(installation.key);
  expect(document.body.textContent).not.toContain("private-clipboard-error");
});

it("keeps management-key backup in settings and clears an earlier success when a later copy fails", async () => {
  const h = await launch({ initialHash: "settings" });
  const copyKey = select('#page-settings [data-copy="key"]');
  copyKey.click();
  await vi.waitFor(() =>
    expect(element("settings-feedback").textContent).toContain(
      "管理钥匙已复制",
    ),
  );
  expect(element("toast").hidden).toBe(false);
  const reads = h.network.mock.calls.length;

  h.clipboard.mockRejectedValueOnce(
    new DOMException("private-second-copy-failure", "NotAllowedError"),
  );
  copyKey.click();
  expect(element("sheet-feedback").textContent).toBe("");
  expect(element("settings-feedback").textContent).toBe("");
  expect(element("toast").hidden).toBe(true);
  await vi.waitFor(() =>
    expect(element("global-error").textContent).toContain("浏览器未允许复制"),
  );
  expect(element("global-error").hidden).toBe(false);
  expect(element("settings-feedback").textContent).not.toContain("已复制");
  expect(element("toast").hidden).toBe(true);
  expect(h.clipboard.mock.calls).toEqual([
    [installation.key],
    [installation.key],
  ]);
  expect(h.network).toHaveBeenCalledTimes(reads);
  expect(document.body.textContent).not.toContain(
    "private-second-copy-failure",
  );
});
