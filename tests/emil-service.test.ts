import { afterEach, expect, it, vi } from "vitest";
import { createEmilService } from "../apps/browser-extension/src/emil-service";
import type { InstallState } from "../apps/browser-extension/src/cloudflare";
import type { Runtime } from "../apps/browser-extension/src/extension-state";
import {
  previousAlgorithm,
  algorithmVersion,
  algorithmHash,
} from "../apps/browser-extension/src/algorithm-release";
import {
  ARTWORK_CACHE_KEY,
  ARTWORK_CACHE_LOCK,
  ARTWORK_CACHE_TTL,
} from "../apps/browser-extension/src/emil-artwork-cache";

const origin = "https://ams-" + "b".repeat(24) + ".preview.workers.dev";
const initial: InstallState = {
  account: "a".repeat(32),
  name: "ams-" + "b".repeat(24),
  marker: "c".repeat(32),
  key: "d".repeat(64),
  namespace: "e".repeat(32),
  origin,
};

afterEach(() => vi.unstubAllGlobals());

function harness(
  options: {
    installed?: boolean;
    permission?: boolean;
    store?: Record<string, unknown>;
  } = {},
) {
  const store = options.store ?? {};
  if (!("installation" in store) && options.installed !== false)
    store.installation = { ...initial };
  let namespace: { id: string; title: string } | undefined;
  const fixture = {
    connections: {
      apple: { connected: true },
      lastfm: {
        connected: true,
        application_configured: true,
        username: "Listener",
      },
    },
    runtime: {
      recording_issue: undefined as Runtime["recording_issue"],
      enabled: false,
      algorithm_version: "0.3.111",
      algorithm_sha256: algorithmHash,
      pending_identity: 0,
      pending_submission: 0,
      stats: { total_scrobbled: 4 },
      records: [] as Runtime["records"],
    },
    artwork: null as string | null,
    artworkStatus: 200,
    artworkError: null as Error | null,
    artworkResponse: null as ((catalogId: string) => Promise<Response>) | null,
    version: "0.3.111",
    hash: algorithmHash,
    healthResponse: null as (() => Response) | null,
    tokenResponse: null as (() => Response) | null,
    appleResponse: null as (() => Response) | null,
    authorizationResponse: null as (() => Response) | null,
    settingsResponse: null as (() => Response) | null,
    cloudAccounts: [{ id: initial.account, name: "Personal account" }],
    subdomainResponse: null as
      ((account: string) => Response | Promise<Response>) | null,
    uploadResponse: null as (() => Response) | null,
    extensionAuthorization: true,
    appleArtworkSupport: true,
    artworkDiagnostics: true,
    artworkRuntime: "workerd-manual-v1",
    recordingDiagnostics: true,
    onUpload: null as (() => void) | null,
    startError: null as Error | null,
    startResponse: null as (() => Response) | null,
    readbackEnabled: true,
  };
  const grantedOrigins = new Set<string>(
    options.installed !== false && options.permission !== false
      ? [initial.origin + "/*"]
      : [],
  );
  const grantPermission = (request: { origins: string[] }) => {
    for (const requested of request.origins) grantedOrigins.add(requested);
  };
  const requestPermission = vi.fn(async (request: { origins: string[] }) => {
    grantPermission(request);
    return true;
  });
  const containsPermission = vi.fn(async (request: { origins: string[] }) =>
    request.origins.every((requested) => grantedOrigins.has(requested)),
  );
  const createTab = vi.fn(async (options: { url: string }) => ({
    id: 42,
    url: options.url,
  }));
  const currentTab = vi.fn(async () => ({ id: 8 }));
  const updateTab = vi.fn(
    async (_id: number, _options: { active: boolean }) => ({}),
  );
  const removeTab = vi.fn(async (_id: number) => {});
  const updatedListeners = new Set<(...args: any[]) => void>();
  const removedListeners = new Set<(...args: any[]) => void>();
  const queryTabs = vi.fn(async () => [
    { id: 9, url: "https://music.apple.com/tw/browse" },
  ]);
  const credentials = {
    apple_dev_token: "developer-token",
    apple_user_token: "user-token",
  };
  const executeScript = vi.fn(async () => [{ result: { credentials } }]);
  const storageSet = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(store, structuredClone(value));
  });
  const storageGet = vi.fn(async (key: string) => ({
    [key]: structuredClone(store[key]),
  }));
  const clipboard = vi.fn(async (_value: string) => {});
  let cacheQueue = Promise.resolve();
  const lock = vi.fn(async (_name, _settings, task) => {
    if (_name !== ARTWORK_CACHE_LOCK) return task({ name: _name });
    const request = cacheQueue.then(() => task({ name: _name }));
    cacheQueue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: clipboard },
    locks: { request: lock },
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
    permissions: { request: requestPermission, contains: containsPermission },
    tabs: {
      create: createTab,
      query: queryTabs,
      getCurrent: currentTab,
      update: updateTab,
      remove: removeTab,
      onUpdated: {
        addListener: (listener: (...args: any[]) => void) =>
          updatedListeners.add(listener),
        removeListener: (listener: (...args: any[]) => void) =>
          updatedListeners.delete(listener),
      },
      onRemoved: {
        addListener: (listener: (...args: any[]) => void) =>
          removedListeners.add(listener),
        removeListener: (listener: (...args: any[]) => void) =>
          removedListeners.delete(listener),
      },
    },
    scripting: { executeScript },
    runtime: { getURL: (name: string) => "chrome-extension://fixture/" + name },
  });
  const network = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.protocol === "chrome-extension:")
        return new Response("export default {};");
      if (url.origin === "https://api.cloudflare.com") {
        let result: unknown = {};
        if (url.pathname.endsWith("/user/tokens/verify"))
          return (
            fixture.tokenResponse?.() ??
            Response.json({ success: true, result: { status: "active" } })
          );
        if (url.pathname.endsWith("/accounts")) result = fixture.cloudAccounts;
        if (url.pathname.endsWith("/workers/subdomain"))
          return (
            (await fixture.subdomainResponse?.(url.pathname.split("/")[4])) ??
            Response.json({ success: true, result: { subdomain: "preview" } })
          );
        if (url.pathname.endsWith("/settings"))
          return (
            fixture.settingsResponse?.() ?? new Response(null, { status: 404 })
          );
        if (
          /\/workers\/scripts\/[^/]+$/.test(url.pathname) &&
          init?.method === "PUT"
        ) {
          fixture.onUpload?.();
          if (fixture.uploadResponse) return fixture.uploadResponse();
        }
        if (url.pathname.endsWith("/storage/kv/namespaces")) {
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body));
            namespace = { id: "e".repeat(32), title: body.title };
            result = namespace;
          } else result = namespace ? [namespace] : [];
        }
        return Response.json({ success: true, result });
      }
      if (!url.hostname.endsWith(".workers.dev"))
        throw Error("Unexpected network destination");
      if (url.pathname === "/health")
        return (
          fixture.healthResponse?.() ??
          Response.json({
            version: fixture.version,
            algorithm_sha256: fixture.hash,
            capabilities: {
              lastfm_extension_auth: fixture.extensionAuthorization,
              apple_source_artwork: fixture.appleArtworkSupport,
              apple_artwork_diagnostics: fixture.artworkDiagnostics,
              apple_artwork_runtime: fixture.artworkRuntime,
              recording_diagnostics: fixture.recordingDiagnostics,
            },
          })
        );
      if (url.pathname === "/api/v1/connections")
        return Response.json(fixture.connections);
      if (url.pathname === "/api/v1/recording")
        return Response.json(fixture.runtime);
      if (url.pathname === "/api/v1/artwork") {
        if (fixture.artworkError) throw fixture.artworkError;
        if (fixture.artworkResponse)
          return fixture.artworkResponse(
            url.searchParams.get("track_id") ??
              url.searchParams.get("catalog_id") ??
              "",
          );
        return Response.json(
          { artwork_url: fixture.artwork },
          { status: fixture.artworkStatus },
        );
      }
      if (url.pathname === "/api/v1/recording/start") {
        if (fixture.startError) throw fixture.startError;
        if (fixture.startResponse) return fixture.startResponse();
        fixture.runtime.enabled = fixture.readbackEnabled;
        return Response.json({ enabled: true });
      }
      if (url.pathname === "/api/v1/recording/pause") {
        fixture.runtime.enabled = false;
        return Response.json({ enabled: false });
      }
      if (url.pathname === "/api/v1/connections/apple")
        return (
          fixture.appleResponse?.() ??
          Response.json({ ok: true, connected: true, verified: true })
        );
      if (url.pathname === "/api/v1/connections/lastfm/application")
        return Response.json({ ok: true });
      if (url.pathname === "/api/v1/connections/lastfm/extension/start")
        return (
          fixture.authorizationResponse?.() ??
          Response.json({
            browser_url:
              origin +
              "/api/v1/connections/lastfm/extension/authorize?flow=" +
              "f".repeat(64),
            callback_url:
              origin + "/api/v1/connections/lastfm/extension/result",
          })
        );
      throw Error("Unexpected API path");
    },
  );
  vi.stubGlobal("fetch", network);
  return {
    fixture,
    network,
    requestPermission,
    containsPermission,
    grantedOrigins,
    grantPermission,
    createTab,
    currentTab,
    updateTab,
    removeTab,
    updatedListeners,
    removedListeners,
    emitUpdated: (id: number, url: string) => {
      for (const listener of updatedListeners)
        listener(id, { url }, { id, url });
    },
    emitRemoved: (id: number) => {
      for (const listener of removedListeners) listener(id, {});
    },
    queryTabs,
    executeScript,
    credentials,
    clipboard,
    lock,
    storageSet,
    storageGet,
    store,
  };
}

const writes = (network: ReturnType<typeof harness>["network"]) =>
  network.mock.calls.filter(
    ([, init]) => init?.method && init.method !== "GET",
  );
const installationWrites = (h: ReturnType<typeof harness>) =>
  h.storageSet.mock.calls.filter(([value]) => "installation" in value);
const installationLocks = (h: ReturnType<typeof harness>) =>
  h.lock.mock.calls.filter(([name]) => name === "scrobbler-install");

function existingWorkerSettings() {
  return {
    compatibility_date: "2026-09-08",
    bindings: [
      { type: "plain_text", name: "INSTALLATION_ID", text: initial.marker },
      { type: "plain_text", name: "INSTALLER_ALGORITHM", text: "0.3.111" },
      {
        type: "plain_text",
        name: "DEPLOYMENT_ACCOUNT_ID",
        text: initial.account,
      },
      {
        type: "plain_text",
        name: "DEPLOYMENT_WORKER_NAME",
        text: initial.name,
      },
      { type: "secret_text", name: "STATUS_AUTH_KEY" },
      {
        type: "kv_namespace",
        name: "ASCROBBLE_STATE",
        namespace_id: initial.namespace,
      },
      {
        type: "durable_object_namespace",
        name: "SCROBBLE_COORDINATOR",
        class_name: "ScrobbleCoordinator",
        namespace_id: "0".repeat(32),
      },
    ],
  };
}

it("loads and verifies an installation with read-only requests and no permission prompt", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    fresh: true,
    busy: false,
    runtime: { enabled: false },
  });
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(installationWrites(h)).toHaveLength(0);
  expect(writes(h.network)).toHaveLength(0);
  for (const [, request] of h.network.mock.calls) {
    expect(request?.credentials).toBe("omit");
    expect(request?.redirect).toBe("error");
  }
});

it.each([404, 500, 503])(
  "treats HTTP %s health failures as temporary unavailability instead of a version mismatch",
  async (status) => {
    const h = harness();
    h.fixture.healthResponse = () =>
      new Response("private-health-upstream-detail", { status });
    const service = createEmilService();
    await expect(service.ready).rejects.toMatchObject({
      code: "backend_unavailable",
      status,
    });
    expect(service.getSnapshot()).toMatchObject({
      installation: initial,
      fresh: false,
      verified: false,
      busy: false,
    });
    expect(service.getSnapshot().error?.recovery).toBe("refresh");
    expect(service.getSnapshot().error?.title).not.toContain("版本");
    expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
      "private-health-upstream-detail",
    );
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(installationWrites(h)).toHaveLength(0);
  },
);

it.each([
  {
    name: "non-JSON",
    response: () => new Response("private-health-upstream-detail"),
  },
  {
    name: "missing version",
    response: () => Response.json({ algorithm_sha256: "f".repeat(64) }),
  },
  {
    name: "missing hash",
    response: () => Response.json({ version: "0.3.111" }),
  },
  {
    name: "invalid version type",
    response: () =>
      Response.json({ version: 3, algorithm_sha256: "f".repeat(64) }),
  },
  {
    name: "blank identity",
    response: () => Response.json({ version: " ", algorithm_sha256: "" }),
  },
])(
  "keeps a successful but $name health response uncertain without claiming a different backend version",
  async ({ response }) => {
    const h = harness();
    h.fixture.healthResponse = response;
    const service = createEmilService();
    await expect(service.ready).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(service.getSnapshot()).toMatchObject({
      installation: initial,
      fresh: false,
      verified: false,
      busy: false,
    });
    expect(service.getSnapshot().error?.recovery).toBe("refresh");
    expect(service.getSnapshot().error?.title).not.toContain("版本");
    expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
      "private-health-upstream-detail",
    );
    expect(h.network).toHaveBeenCalledTimes(1);
  },
);

it("preserves health rate-limit recovery without treating it as a version mismatch", async () => {
  const h = harness();
  h.fixture.healthResponse = () =>
    new Response("private-limit-details", { status: 429 });
  const service = createEmilService();
  await expect(service.ready).rejects.toMatchObject({
    code: "http_429",
    status: 429,
  });
  expect(service.getSnapshot().error?.recovery).toBe("retry");
  expect(service.getSnapshot().error?.title).toContain("请求次数");
  expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
    "private-limit-details",
  );
});

it("preserves a verified installation during temporary health failure and recovers through a read-only check", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  const before = service.getSnapshot();
  h.fixture.healthResponse = () => new Response(null, { status: 503 });
  await expect(service.refresh()).rejects.toMatchObject({
    code: "backend_unavailable",
  });
  expect(service.getSnapshot()).toMatchObject({
    installation: before.installation,
    connections: before.connections,
    runtime: before.runtime,
    verified: true,
    fresh: false,
    busy: false,
  });
  expect(service.getSnapshot().error?.recovery).toBe("refresh");
  h.fixture.healthResponse = null;
  await service.refresh();
  expect(service.getSnapshot()).toMatchObject({
    installation: initial,
    verified: true,
    fresh: true,
    busy: false,
    error: null,
  });
  expect(installationWrites(h)).toHaveLength(0);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(writes(h.network)).toHaveLength(0);
});

it.each([
  { status: 404, code: "backend_unavailable" },
  { status: 200, code: "invalid_response" },
  { status: 429, code: "http_429" },
])(
  "makes health failure $code stale before capturing new Apple credentials without invalidating the saved version",
  async ({ status, code }) => {
    const h = harness();
    const service = createEmilService();
    await service.ready;
    h.fixture.healthResponse = () => new Response("not-json", { status });
    await expect(service.connectApple()).rejects.toMatchObject({ code });
    expect(service.getSnapshot()).toMatchObject({
      installation: initial,
      verified: true,
      fresh: false,
      busy: false,
    });
    expect(h.executeScript).not.toHaveBeenCalled();
    expect(writes(h.network)).toHaveLength(0);
  },
);

it.each([
  "https://is1-ssl.mzstatic.com/image/thumb/Music/cover/600x600bb.jpg",
  "https://mzstatic.com/image/cover.jpg",
  "assets/album-preview-holding-hands.jpg",
  "assets/album-preview-bad-boy.jpg",
])(
  "reads known-record artwork from the saved backend without changing recording state: %s",
  async (artwork) => {
    const h = harness();
    h.fixture.runtime.records = [
      { track: "One", artist: "Artist", catalog_id: "1487109637" },
    ];
    h.fixture.artwork = artwork;
    const changed = vi.fn();
    const service = createEmilService({ onChange: changed });
    await service.ready;
    const before = service.getSnapshot();
    changed.mockClear();
    await expect(service.getArtwork("1487109637")).resolves.toBe(artwork);
    const request = h.network.mock.calls.find(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    );
    expect(String(request?.[0])).toBe(
      origin + "/api/v1/artwork?catalog_id=1487109637",
    );
    expect(request?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
    });
    expect(request?.[1]?.method ?? "GET").toBe("GET");
    expect(service.getSnapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(writes(h.network)).toHaveLength(0);
  },
);

it("does not request artwork for a catalog ID absent from the loaded records", async () => {
  const h = harness();
  h.fixture.runtime.records = [
    { track: "One", artist: "Artist", catalog_id: "1487109637" },
  ];
  const service = createEmilService();
  await service.ready;
  const reads = h.network.mock.calls.length;
  await expect(service.getArtwork("1487091683")).resolves.toBeNull();
  await expect(
    service.getArtwork("1487109637&catalog_id=1487091683"),
  ).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(reads);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it.each(["1487109637", "i.originalTrack"])(
  "reads source Apple track %s with a null catalog ID and shares its cover request",
  async (trackId) => {
    const h = harness();
    const record = {
      track: "Matched title",
      artist: "Matched artist",
      album: "Matched album",
      track_id: trackId,
      catalog_id: null,
    };
    h.fixture.runtime.records = [record];
    h.fixture.artwork = "https://is1-ssl.mzstatic.com/original.jpg";
    const service = createEmilService();
    await service.ready;
    const before = service.getSnapshot();
    const [left, right] = await Promise.all([
      service.getArtwork(record),
      service.getArtwork({ ...record }),
    ]);
    expect(left).toBe(h.fixture.artwork);
    expect(right).toBe(left);
    const requests = h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    );
    expect(requests).toHaveLength(1);
    const query = new URL(String(requests[0][0])).searchParams;
    expect(query.get("track_id")).toBe(trackId);
    expect(query.has("catalog_id")).toBe(false);
    expect(query.has("artist")).toBe(false);
    expect(query.has("album")).toBe(false);
    expect(service.getSnapshot()).toEqual(before);
    expect(writes(h.network)).toHaveLength(0);
    expect(h.requestPermission).not.toHaveBeenCalled();
  },
);

it("uses source track identity ahead of a matched catalog ID and does not cache a late source cover", async () => {
  const h = harness();
  const original = {
    track: "Same text",
    artist: "Artist",
    track_id: "1001",
    catalog_id: "9999",
  };
  h.fixture.runtime.records = [original];
  let finish!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const requested = vi.fn(async () => pendingResponse);
  h.fixture.artworkResponse = requested;
  const service = createEmilService();
  await service.ready;
  const pending = service.getArtwork(original);
  await vi.waitFor(() => expect(requested).toHaveBeenCalledWith("1001"));
  const changed = { ...original, track_id: "1002" };
  h.fixture.runtime.records = [changed];
  await service.refresh();
  finish(
    Response.json({ artwork_url: "https://is1-ssl.mzstatic.com/stale.jpg" }),
  );
  await expect(pending).resolves.toBeNull();
  h.fixture.artworkResponse = async () =>
    Response.json({ artwork_url: "https://is1-ssl.mzstatic.com/current.jpg" });
  await expect(service.getArtwork(changed)).resolves.toBe(
    "https://is1-ssl.mzstatic.com/current.jpg",
  );
  await expect(service.getArtwork(original)).resolves.toBeNull();
  expect(writes(h.network)).toHaveLength(0);
});

it("does not read source tracks outside the latest ten records", async () => {
  const h = harness();
  h.fixture.runtime.records = Array.from({ length: 11 }, (_, i) => ({
    track: "Song " + i,
    artist: "Artist",
    track_id: String(1000 + i),
    catalog_id: null,
  }));
  const service = createEmilService();
  await service.ready;
  const reads = h.network.mock.calls.length;
  await expect(
    service.getArtwork(h.fixture.runtime.records[10]),
  ).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(reads);
});

it("keeps only the latest ten runtime records and never enriches an eleventh record", async () => {
  const h = harness();
  const records = Array.from({ length: 12 }, (_, index) => ({
    track: "Song " + index,
    artist: "Artist",
    catalog_id: String(1001 + index),
  }));
  h.fixture.runtime.records = records;
  const service = createEmilService();
  await service.ready;
  expect(service.getSnapshot().runtime?.records).toEqual(records.slice(0, 10));
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/tenth.jpg";
  await expect(service.getArtwork("1010")).resolves.toBe(h.fixture.artwork);
  const reads = h.network.mock.calls.length;
  await expect(service.getArtwork("1011")).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(reads);
  const refreshed = [
    { track: "Newest", artist: "Artist", catalog_id: "2001" },
    ...records,
  ];
  h.fixture.runtime.records = refreshed;
  await service.refresh();
  expect(service.getSnapshot().runtime?.records).toEqual(
    refreshed.slice(0, 10),
  );
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("discards a cached cover as soon as its song leaves the ten recent records", async () => {
  const h = harness();
  const records = Array.from({ length: 11 }, (_, index) => ({
    track: "Song " + index,
    artist: "Artist",
    catalog_id: String(1001 + index),
  }));
  h.fixture.runtime.records = records.slice(0, 10);
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/original.jpg";
  const service = createEmilService();
  await service.ready;
  await expect(service.getArtwork("1001")).resolves.toBe(h.fixture.artwork);
  h.fixture.runtime.records = records.slice(1);
  await service.refresh();
  const reads = h.network.mock.calls.length;
  await expect(service.getArtwork("1001")).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(reads);

  h.fixture.runtime.records = records.slice(0, 10);
  h.fixture.artwork = "https://is2-ssl.mzstatic.com/refetched.jpg";
  await service.refresh();
  await expect(service.getArtwork("1001")).resolves.toBe(h.fixture.artwork);
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(2);
});

it("does not cache late artwork for a record that has left the recent ten", async () => {
  const h = harness();
  h.fixture.runtime.records = [
    { track: "Old song", artist: "Artist", catalog_id: "1001" },
  ];
  let finishOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const artwork = vi.fn(async () => oldResponse);
  h.fixture.artworkResponse = artwork;
  const service = createEmilService();
  await service.ready;
  const older = service.getArtwork("1001");
  await vi.waitFor(() => expect(artwork).toHaveBeenCalledTimes(1));
  h.fixture.runtime.records = [
    { track: "New song", artist: "Artist", catalog_id: "1002" },
  ];
  await service.refresh();
  finishOld(
    Response.json({ artwork_url: "https://is1-ssl.mzstatic.com/stale.jpg" }),
  );
  await expect(older).resolves.toBeNull();
  h.fixture.runtime.records = [
    { track: "Old song again", artist: "Artist", catalog_id: "1001" },
  ];
  h.fixture.artworkResponse = async () =>
    Response.json({ artwork_url: "https://is2-ssl.mzstatic.com/new.jpg" });
  await service.refresh();
  await expect(service.getArtwork("1001")).resolves.toBe(
    "https://is2-ssl.mzstatic.com/new.jpg",
  );
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(2);
  expect(service.getSnapshot()).toMatchObject({
    fresh: true,
    busy: false,
    error: null,
  });
});

it("gives a rapidly returning record a new artwork request while an obsolete response is still pending", async () => {
  const h = harness();
  const oldRecord = {
    track: "Returning song",
    artist: "Artist",
    catalog_id: "1001",
  };
  h.fixture.runtime.records = [oldRecord];
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const newResponse = new Promise<Response>((resolve) => {
    finishNew = resolve;
  });
  let attempts = 0;
  const artwork = vi.fn(async () =>
    attempts++ === 0 ? oldResponse : newResponse,
  );
  h.fixture.artworkResponse = artwork;
  const service = createEmilService();
  await service.ready;
  const obsolete = service.getArtwork("1001");
  await vi.waitFor(() => expect(artwork).toHaveBeenCalledTimes(1));
  h.fixture.runtime.records = [
    { track: "Another song", artist: "Artist", catalog_id: "1002" },
  ];
  await service.refresh();
  h.fixture.runtime.records = [oldRecord];
  await service.refresh();
  const current = service.getArtwork("1001");
  await vi.waitFor(() => expect(artwork).toHaveBeenCalledTimes(2));
  finishOld(
    Response.json({ artwork_url: "https://is1-ssl.mzstatic.com/obsolete.jpg" }),
  );
  await expect(obsolete).resolves.toBeNull();
  const sharedCurrent = service.getArtwork("1001");
  finishNew(
    Response.json({ artwork_url: "https://is2-ssl.mzstatic.com/current.jpg" }),
  );
  await expect(Promise.all([current, sharedCurrent])).resolves.toEqual(
    Array(2).fill("https://is2-ssl.mzstatic.com/current.jpg"),
  );
  await expect(service.getArtwork("1001")).resolves.toBe(
    "https://is2-ssl.mzstatic.com/current.jpg",
  );
  expect(artwork).toHaveBeenCalledTimes(2);
});

it("silently skips artwork when saved host permission is unavailable", async () => {
  const h = harness();
  h.fixture.runtime.records = [
    { track: "One", artist: "Artist", catalog_id: "1487109637" },
  ];
  const service = createEmilService();
  await service.ready;
  const before = service.getSnapshot();
  const reads = h.network.mock.calls.length;
  h.containsPermission.mockResolvedValue(false);
  await expect(service.getArtwork("1487109637")).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(reads);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(service.getSnapshot()).toEqual(before);
});

it.each([
  {
    initialArtwork: "https://is1-ssl.mzstatic.com/first.jpg",
    lifetime: ARTWORK_CACHE_TTL,
  },
  { initialArtwork: null, lifetime: 60 * 1000 },
])(
  "caches optional artwork for its useful lifetime and retries after expiry: $initialArtwork",
  async ({ initialArtwork, lifetime }) => {
    const h = harness();
    h.fixture.runtime.records = [
      { track: "One", artist: "Artist", catalog_id: "1487109637" },
    ];
    h.fixture.artwork = initialArtwork;
    const service = createEmilService();
    await service.ready;
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const artworkReads = () =>
      h.network.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
      ).length;
    try {
      await expect(service.getArtwork("1487109637")).resolves.toBe(
        initialArtwork,
      );
      expect(artworkReads()).toBe(1);
      h.fixture.artwork = "https://is2-ssl.mzstatic.com/new.jpg";
      now += lifetime - 1;
      await expect(service.getArtwork("1487109637")).resolves.toBe(
        initialArtwork,
      );
      expect(artworkReads()).toBe(1);
      now += 2;
      await expect(service.getArtwork("1487109637")).resolves.toBe(
        h.fixture.artwork,
      );
      expect(artworkReads()).toBe(2);
      expect(h.requestPermission).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);

it("rechecks record membership and permission before reusing a cached cover", async () => {
  const h = harness();
  h.fixture.runtime.records = [
    { track: "One", artist: "Artist", catalog_id: "1487109637" },
  ];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/cover.jpg";
  const service = createEmilService();
  await service.ready;
  await expect(service.getArtwork("1487109637")).resolves.toBe(
    h.fixture.artwork,
  );
  const firstReads = h.network.mock.calls.length;
  h.containsPermission.mockResolvedValue(false);
  await expect(service.getArtwork("1487109637")).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(firstReads);
  h.containsPermission.mockResolvedValue(true);
  h.fixture.runtime.records = [];
  await service.refresh();
  const afterRefresh = h.network.mock.calls.length;
  await expect(service.getArtwork("1487109637")).resolves.toBeNull();
  expect(h.network).toHaveBeenCalledTimes(afterRefresh);
  expect(h.requestPermission).not.toHaveBeenCalled();
});

it("restores a successful cover after a page reload without another artwork API request", async () => {
  const h = harness();
  const record = {
    track: "Source song",
    artist: "Artist",
    track_id: "i.originalTrack",
    catalog_id: null,
  };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/persistent.jpg";
  const first = createEmilService();
  await first.ready;
  await expect(first.getArtwork(record)).resolves.toBe(h.fixture.artwork);
  const serialized = JSON.stringify(h.store[ARTWORK_CACHE_KEY]);
  expect(serialized).not.toContain(initial.key);
  expect(serialized).not.toContain("Listener");
  expect(serialized).not.toContain("developer-token");
  first.dispose();
  h.network.mockClear();
  const reloaded = createEmilService();
  await reloaded.ready;
  await expect(reloaded.getArtwork(record)).resolves.toBe(h.fixture.artwork);
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(0);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(installationWrites(h)).toHaveLength(0);
});

it("prunes persistent covers outside the recent ten and never reuses a previous Last.fm account's cache", async () => {
  const h = harness();
  const record = { track: "Source song", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/persistent.jpg";
  const service = createEmilService();
  await service.ready;
  await service.getArtwork(record);
  h.fixture.connections.lastfm.username = "DifferentListener";
  await service.refresh();
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  await service.getArtwork(record);
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(2);
  h.fixture.runtime.records = Array.from({ length: 10 }, (_, index) => ({
    track: "Other " + index,
    artist: "Artist",
    track_id: String(2001 + index),
  }));
  await service.refresh();
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  expect(JSON.stringify(h.store[ARTWORK_CACHE_KEY])).not.toContain('"1001"');
});

it("does not persist missing covers and retries them after reloading", async () => {
  const h = harness();
  const record = { track: "Missing", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  const first = createEmilService();
  await first.ready;
  await expect(first.getArtwork(record)).resolves.toBeNull();
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  first.dispose();
  const second = createEmilService();
  await second.ready;
  await expect(second.getArtwork(record)).resolves.toBeNull();
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(2);
});

it("returns network artwork normally when persistent cache storage fails", async () => {
  const h = harness();
  const record = { track: "Source", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/safe.jpg";
  h.storageSet.mockRejectedValue(Error("cache storage full"));
  const service = createEmilService();
  await service.ready;
  const before = service.getSnapshot();
  await expect(service.getArtwork(record)).resolves.toBe(h.fixture.artwork);
  expect(service.getSnapshot()).toEqual(before);
});

it("keeps persisted covers during a temporary backend failure and clears them only after confirmed local removal", async () => {
  const h = harness();
  const record = { track: "Source", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/persistent.jpg";
  const first = createEmilService();
  await first.ready;
  await first.getArtwork(record);
  first.dispose();
  const savedCache = structuredClone(h.store[ARTWORK_CACHE_KEY]);
  h.fixture.healthResponse = () => new Response(null, { status: 503 });
  const unavailable = createEmilService();
  await expect(unavailable.ready).rejects.toMatchObject({
    code: "backend_unavailable",
  });
  expect(h.store[ARTWORK_CACHE_KEY]).toEqual(savedCache);
  unavailable.dispose();
  h.store.installation = undefined;
  const removed = createEmilService();
  await removed.ready;
  expect(h.store[ARTWORK_CACHE_KEY]).toMatchObject({
    scope: null,
    entries: [],
    visible: [],
  });
});

it("removes persisted cover metadata after updating the backend so a reload fetches it again", async () => {
  const h = harness();
  const record = { track: "Source", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/before-update.jpg";
  const service = createEmilService();
  await service.ready;
  await service.getArtwork(record);
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: existingWorkerSettings() });
  await service.updateBackend("", initial.account);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  service.dispose();
  h.fixture.artwork = "https://is2-ssl.mzstatic.com/after-update.jpg";
  h.network.mockClear();
  const reloaded = createEmilService();
  await reloaded.ready;
  await expect(reloaded.getArtwork(record)).resolves.toBe(h.fixture.artwork);
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(1);
});

it("invalidates a restored failed image URL without changing state, while ignoring old URL and old account errors", async () => {
  const h = harness();
  const record = { track: "Source", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/old.jpg";
  const first = createEmilService();
  await first.ready;
  await first.getArtwork(record);
  first.dispose();
  const service = createEmilService();
  await service.ready;
  const oldScope = service.getArtworkScope();
  const oldUrl = (await service.getArtwork(record))!;
  const before = service.getSnapshot();
  await service.forgetArtwork(record, oldUrl, oldScope);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  expect(service.getSnapshot()).toEqual(before);
  h.fixture.artwork = "https://is2-ssl.mzstatic.com/recovered.jpg";
  await expect(service.getArtwork(record)).resolves.toBe(h.fixture.artwork);
  await service.forgetArtwork(record, oldUrl, oldScope);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: Array<{ url: string }> })
      .entries[0].url,
  ).toBe(h.fixture.artwork);
  h.fixture.connections.lastfm.username = "NextListener";
  await service.refresh();
  await service.getArtwork(record);
  await service.forgetArtwork(record, h.fixture.artwork, oldScope);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: Array<{ url: string }> })
      .entries[0].url,
  ).toBe(h.fixture.artwork);
});

it("does not resurrect a failed persistent URL when a same-account refresh overlaps its removal", async () => {
  const h = harness();
  const record = { track: "Source", artist: "Artist", track_id: "1001" };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/failed.jpg";
  const service = createEmilService();
  await service.ready;
  const failedUrl = (await service.getArtwork(record))!;
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.storageGet.mockImplementationOnce(async (key) => {
    expect(key).toBe(ARTWORK_CACHE_KEY);
    started();
    await delayed;
    return { [key]: structuredClone(h.store[key]) };
  });
  const forgetting = service.forgetArtwork(
    record,
    failedUrl,
    service.getArtworkScope(),
  );
  await began;
  const cacheLocks = () =>
    h.lock.mock.calls.filter(([name]) => name === ARTWORK_CACHE_LOCK).length;
  const before = cacheLocks();
  const refreshing = service.refresh();
  await vi.waitFor(() => expect(cacheLocks()).toBeGreaterThan(before));
  release();
  await Promise.all([forgetting, refreshing]);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  h.fixture.artwork = "https://is2-ssl.mzstatic.com/recovered.jpg";
  await expect(service.getArtwork(record)).resolves.toBe(h.fixture.artwork);
  expect(
    h.network.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
    ),
  ).toHaveLength(2);
});

it("shares duplicate artwork reads while limiting catalogue requests to three at a time", async () => {
  const h = harness();
  const ids = Array.from({ length: 10 }, (_, index) => String(1001 + index));
  h.fixture.runtime.records = ids.map((catalog_id) => ({
    track: catalog_id,
    artist: "Artist",
    catalog_id,
  }));
  const finish = new Map<string, () => void>();
  let active = 0;
  let peak = 0;
  h.fixture.artworkResponse = async (id) => {
    peak = Math.max(peak, ++active);
    return new Promise<Response>((resolve) =>
      finish.set(id, () => {
        active--;
        resolve(
          Response.json({
            artwork_url: "https://is1-ssl.mzstatic.com/cover.jpg",
          }),
        );
      }),
    );
  };
  const service = createEmilService();
  await service.ready;
  const requests = [...ids, ids[0]].map((id) => service.getArtwork(id));
  await vi.waitFor(() => expect(finish.size).toBe(3));
  expect(active).toBe(3);
  const completed = new Set<string>();
  while (completed.size < ids.length) {
    await vi.waitFor(() => expect(finish.size).toBeGreaterThan(completed.size));
    for (const [id, done] of finish) {
      if (completed.has(id)) continue;
      completed.add(id);
      done();
    }
  }
  await expect(Promise.all(requests)).resolves.toEqual(
    Array(ids.length + 1).fill("https://is1-ssl.mzstatic.com/cover.jpg"),
  );
  expect(peak).toBeLessThanOrEqual(3);
  h.fixture.artworkResponse = null;
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/cover.jpg";
  await expect(service.getArtwork(ids[0])).resolves.toBe(h.fixture.artwork);
  const artworkRequests = h.network.mock.calls.filter(
    ([url]) => new URL(String(url)).pathname === "/api/v1/artwork",
  );
  expect(artworkRequests).toHaveLength(ids.length);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(writes(h.network)).toHaveLength(0);
});

it.each(["missing", "not-found", "upstream-error", "network-error"])(
  "keeps recording status intact when artwork is %s",
  async (failure) => {
    const h = harness();
    h.fixture.runtime.records = [
      { track: "One", artist: "Artist", catalog_id: "1487109637" },
    ];
    if (failure === "not-found") h.fixture.artworkStatus = 404;
    if (failure === "upstream-error") h.fixture.artworkStatus = 503;
    if (failure === "network-error")
      h.fixture.artworkError = new TypeError("private-artwork-transport-error");
    const changed = vi.fn();
    const service = createEmilService({ onChange: changed });
    await service.ready;
    const before = service.getSnapshot();
    changed.mockClear();
    await expect(service.getArtwork("1487109637")).resolves.toBeNull();
    expect(service.getSnapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect(h.requestPermission).not.toHaveBeenCalled();
  },
);

it.each([
  "http://is1-ssl.mzstatic.com/cover.jpg",
  "https://is1-ssl.mzstatic.com.evil.test/cover.jpg",
  "https://evil.test/is1-ssl.mzstatic.com/cover.jpg",
  "https://user:password@is1-ssl.mzstatic.com/cover.jpg",
  "https://is1-ssl.mzstatic.com:8443/cover.jpg",
  "data:image/svg+xml,<svg onload='alert(1)'/>",
  "javascript:alert(1)",
  "assets/other-cover.jpg",
  "assets/album-preview-holding-hands.jpg?untrusted=1",
])(
  "rejects unsafe artwork without publishing an error: %s",
  async (artwork) => {
    const h = harness();
    h.fixture.runtime.records = [
      { track: "One", artist: "Artist", catalog_id: "1487109637" },
    ];
    h.fixture.artwork = artwork;
    const changed = vi.fn();
    const service = createEmilService({ onChange: changed });
    await service.ready;
    const before = service.getSnapshot();
    changed.mockClear();
    await expect(service.getArtwork("1487109637")).resolves.toBeNull();
    expect(service.getSnapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  },
);

it("keeps unavailable host access stale until a deliberate permission request", async () => {
  const h = harness({ permission: false });
  const service = createEmilService();
  await service.ready;
  expect(service.getSnapshot().fresh).toBe(false);
  expect(h.network).not.toHaveBeenCalled();
  expect(h.requestPermission).not.toHaveBeenCalled();
  await service.refresh({ permission: true });
  expect(h.requestPermission).toHaveBeenCalledOnce();
  expect(service.getSnapshot().fresh).toBe(true);
});

it("does not begin a background read after a mutation overtakes its permission check", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  let finishContains!: (value: boolean) => void;
  let finishRequest!: (value: boolean) => void;
  h.containsPermission.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (finishContains = resolve)),
  );
  h.requestPermission.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (finishRequest = resolve)),
  );
  const reads = h.network.mock.calls.length;
  const background = service.refresh();
  const start = service.startRecording("Listener");
  finishContains(true);
  await background;
  expect(h.network).toHaveBeenCalledTimes(reads);
  finishRequest(true);
  await start;
  expect(service.getSnapshot().runtime?.enabled).toBe(true);
  expect(writes(h.network)).toHaveLength(1);
});

it.each(["version", "hash"])(
  "rejects a complete health identity with a different %s before reading or mutating service data",
  async (field) => {
    const h = harness();
    if (field === "version") h.fixture.version = "other";
    else
      h.fixture.healthResponse = () =>
        Response.json({
          version: h.fixture.version,
          algorithm_sha256: "f".repeat(64),
        });
    const service = createEmilService();
    await expect(service.ready).rejects.toThrow("version_mismatch");
    expect(h.network).toHaveBeenCalledOnce();
    expect(service.getSnapshot()).toMatchObject({
      verified: false,
      fresh: false,
    });
    await expect(service.startRecording("Listener")).rejects.toThrow();
    expect(writes(h.network)).toHaveLength(0);
  },
);

it("requires the confirmed account and rechecks its current identity before starting", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await expect(service.startRecording("")).rejects.toThrow("account_changed");
  await expect(service.startRecording("someone else")).rejects.toThrow(
    "account_changed",
  );
  h.fixture.connections.lastfm.username = "ChangedListener";
  await expect(service.startRecording("Listener")).rejects.toThrow(
    "account_changed",
  );
  expect(service.getSnapshot().connections?.lastfm.username).toBe(
    "ChangedListener",
  );
  expect(writes(h.network)).toHaveLength(0);
});

it("starts only with confirmed connections, then follows remote readback and permits pause after disconnect", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await service.startRecording("Listener");
  expect(service.getSnapshot().runtime?.enabled).toBe(true);
  expect(JSON.parse(String(writes(h.network)[0][1]?.body))).toEqual({
    username: "Listener",
  });
  h.fixture.connections.apple.connected = false;
  h.fixture.connections.lastfm.connected = false;
  await service.refresh();
  await service.pauseRecording();
  expect(service.getSnapshot().runtime?.enabled).toBe(false);
  expect(
    writes(h.network).map(([url]) => new URL(String(url)).pathname),
  ).toEqual(["/api/v1/recording/start", "/api/v1/recording/pause"]);
});

it("uses status readback instead of a start response when another console has paused", async () => {
  const h = harness();
  h.fixture.readbackEnabled = false;
  const service = createEmilService();
  await service.ready;
  await service.startRecording("Listener");
  expect(service.getSnapshot().runtime?.enabled).toBe(false);
});

it("leaves a timed-out mutation stale and refreshes without repeating the mutation", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  h.fixture.startError = Object.assign(Error("private upstream secret"), {
    name: "TimeoutError",
  });
  await expect(service.startRecording("Listener")).rejects.toThrow();
  expect(service.getSnapshot()).toMatchObject({ fresh: false, busy: false });
  expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
    "private upstream secret",
  );
  await expect(service.startRecording("Listener")).rejects.toThrow();
  h.fixture.runtime.enabled = true;
  await service.refresh();
  expect(service.getSnapshot()).toMatchObject({
    fresh: true,
    runtime: { enabled: true },
  });
  expect(writes(h.network)).toHaveLength(1);
});

it.each([
  { status: 400, code: "apple_rejected" },
  { status: 502, code: "apple_unavailable" },
  { status: 502, code: "apple_invalid_response" },
])(
  "keeps Apple validation failure $code recoverable without replacing saved connections or exposing upstream details",
  async ({ status, code }) => {
    const h = harness();
    h.fixture.appleResponse = () =>
      Response.json(
        { error: code, message: "private-apple-upstream-detail" },
        { status },
      );
    const service = createEmilService();
    await service.ready;
    const previousConnections = service.getSnapshot().connections;
    await expect(service.connectApple()).rejects.toThrow(code);
    expect(service.getSnapshot()).toMatchObject({
      installation: initial,
      connections: previousConnections,
      verified: true,
      fresh: false,
      busy: false,
    });
    expect(service.getSnapshot().error?.recovery).toBe("apple");
    expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
      "private-apple-upstream-detail",
    );
    expect(h.credentials).toEqual({
      apple_dev_token: "",
      apple_user_token: "",
    });
    expect(
      writes(h.network).map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/v1/connections/apple"]);
  },
);

it("captures Apple credentials only on explicit connection and clears the captured pair afterwards", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await service.connectApple();
  expect(h.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { tabId: 9 },
      world: "MAIN",
    }),
  );
  expect(h.credentials).toEqual({ apple_dev_token: "", apple_user_token: "" });
  expect(JSON.stringify(service.getSnapshot())).not.toContain(
    "developer-token",
  );
  const apple = writes(h.network).find(([url]) =>
    String(url).endsWith("/apple"),
  );
  expect(JSON.parse(String(apple?.[1]?.body))).toEqual({
    apple_dev_token: "developer-token",
    apple_user_token: "user-token",
  });
});

it("explains a missing Apple Music tab before accessing an unavailable backend and succeeds after it is opened", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  h.queryTabs.mockResolvedValueOnce([]);
  h.fixture.healthResponse = () => new Response(null, { status: 503 });
  h.network.mockClear();

  await expect(service.connectApple()).rejects.toMatchObject({
    code: "apple_tab_missing",
  });
  expect(h.network).not.toHaveBeenCalled();
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    busy: false,
    error: { recovery: "apple" },
  });

  h.fixture.healthResponse = null;
  await service.connectApple();
  expect(h.executeScript).toHaveBeenCalledOnce();
  expect(writes(h.network)).toHaveLength(1);
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    fresh: true,
    busy: false,
    error: null,
  });
});

it("asks users to choose one Apple Music tab without capturing credentials from an ambiguous account", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  h.queryTabs.mockResolvedValueOnce([
    { id: 9, url: "https://music.apple.com/tw/browse" },
    { id: 10, url: "https://music.apple.com/us/browse" },
  ]);
  h.network.mockClear();
  await expect(service.connectApple()).rejects.toMatchObject({
    code: "apple_tabs",
  });
  expect(h.network).not.toHaveBeenCalled();
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(service.getSnapshot().error?.recovery).toBe("apple");
});

it.each(["denied", "rejected"])(
  "does not inspect Apple Music or send credentials when permission is %s",
  async (failure) => {
    const h = harness();
    const service = createEmilService();
    await service.ready;
    h.network.mockClear();
    if (failure === "denied") h.requestPermission.mockResolvedValueOnce(false);
    else
      h.requestPermission.mockRejectedValueOnce(
        Error("private browser user-gesture diagnostics"),
      );

    await expect(service.connectApple()).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(h.queryTabs).not.toHaveBeenCalled();
    expect(h.executeScript).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
    expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
      "private browser",
    );
    expect(service.getSnapshot().busy).toBe(false);
  },
);

it("rechecks the algorithm before capturing Apple credentials for an existing installation", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  h.fixture.version = "changed-after-load";
  await expect(service.connectApple()).rejects.toThrow("version_mismatch");
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(writes(h.network)).toHaveLength(0);
  expect(service.getSnapshot()).toMatchObject({
    fresh: false,
    verified: false,
  });
});

it("validates Last.fm application input locally and opens the integrated browser handoff without a management page", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await expect(service.saveLastfmApplication("bad", "bad")).rejects.toThrow(
    "invalid_application",
  );
  expect(writes(h.network)).toHaveLength(0);
  await service.saveLastfmApplication("e".repeat(32), "f".repeat(32));
  await service.authorizeLastfm();
  expect(h.createTab).toHaveBeenCalledWith({
    url:
      origin +
      "/api/v1/connections/lastfm/extension/authorize?flow=" +
      "f".repeat(64),
  });
  expect(
    writes(h.network).map(([url]) => new URL(String(url)).pathname),
  ).toEqual([
    "/api/v1/connections/lastfm/application",
    "/api/v1/connections/lastfm/extension/start",
  ]);
  expect(h.clipboard).not.toHaveBeenCalled();
  expect(String(h.createTab.mock.calls[0][0].url)).not.toContain(initial.key);
  expect(String(h.createTab.mock.calls[0][0].url)).not.toContain("/setup");
});

it("only handles its own same-instance Last.fm completion by reading status and leaves recording paused", async () => {
  const h = harness();
  h.fixture.connections.lastfm.connected = false;
  const service = createEmilService();
  await service.ready;
  await service.authorizeLastfm();
  h.network.mockClear();
  const result =
    origin + "/api/v1/connections/lastfm/extension/result?result=connected";
  h.emitUpdated(999, result);
  h.emitUpdated(42, result.replace(origin, "https://other.workers.dev"));
  h.emitUpdated(42, origin + "/setup?lastfm=connected");
  await Promise.resolve();
  expect(h.network).not.toHaveBeenCalled();
  expect(h.updateTab).not.toHaveBeenCalled();
  expect(h.removeTab).not.toHaveBeenCalled();

  h.fixture.connections.lastfm.connected = true;
  h.emitUpdated(42, result);
  await vi.waitFor(() => expect(h.removeTab).toHaveBeenCalledWith(42));
  expect(h.updateTab).toHaveBeenCalledWith(8, { active: true });
  expect(service.getSnapshot()).toMatchObject({
    fresh: true,
    error: null,
    connections: { lastfm: { connected: true, username: "Listener" } },
    runtime: { enabled: false },
  });
  expect(writes(h.network)).toHaveLength(0);
  expect(
    h.network.mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual(["/health", "/api/v1/connections", "/health", "/api/v1/recording"]);
  expect(h.updatedListeners.size).toBe(0);
  expect(h.removedListeners.size).toBe(0);
  h.emitUpdated(42, result);
  h.emitRemoved(42);
  expect(h.network).toHaveBeenCalledTimes(4);
});

it("does not claim Last.fm success from a connected URL until the backend confirms a connection", async () => {
  const h = harness();
  h.fixture.connections.lastfm.connected = false;
  const service = createEmilService();
  await service.ready;
  await service.authorizeLastfm();
  h.network.mockClear();
  h.emitUpdated(
    42,
    origin + "/api/v1/connections/lastfm/extension/result?result=connected",
  );
  await vi.waitFor(() => expect(h.removeTab).toHaveBeenCalledWith(42));
  expect(service.getSnapshot()).toMatchObject({
    connections: { lastfm: { connected: false } },
    runtime: { enabled: false },
    error: { recovery: "lastfm", title: "Last.fm 连接尚未确认" },
  });
  expect(writes(h.network)).toHaveLength(0);
  expect(installationWrites(h)).toHaveLength(0);
});

it("closing the authorization tab only refreshes status and never treats closure as consent", async () => {
  const h = harness();
  h.fixture.connections.lastfm.connected = false;
  const service = createEmilService();
  await service.ready;
  await service.authorizeLastfm();
  h.network.mockClear();
  h.emitRemoved(999);
  expect(h.network).not.toHaveBeenCalled();
  h.emitRemoved(42);
  await vi.waitFor(() =>
    expect(h.updateTab).toHaveBeenCalledWith(8, { active: true }),
  );
  expect(service.getSnapshot()).toMatchObject({
    fresh: true,
    error: null,
    connections: { lastfm: { connected: false } },
    runtime: { enabled: false },
  });
  expect(writes(h.network)).toHaveLength(0);
  expect(h.removeTab).not.toHaveBeenCalled();
});

it("requires an in-place backend update before creating an authorization transaction on an old instance", async () => {
  const h = harness();
  h.fixture.healthResponse = () =>
    Response.json({
      version: "0.3.111",
      algorithm_sha256:
        "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
    });
  const service = createEmilService();
  await service.ready;
  await expect(service.authorizeLastfm()).rejects.toMatchObject({
    code: "backend_update_required",
  });
  expect(service.getSnapshot()).toMatchObject({
    installation: initial,
    verified: true,
    connections: { lastfm: { connected: true } },
    error: { recovery: "backend_update" },
  });
  expect(writes(h.network)).toHaveLength(0);
  expect(h.createTab).not.toHaveBeenCalled();
  expect(installationWrites(h)).toHaveLength(0);
});

it("maps a missing integrated authorization endpoint to the existing backend update recovery", async () => {
  const h = harness();
  h.fixture.authorizationResponse = () =>
    Response.json({ error: "not found" }, { status: 404 });
  const service = createEmilService();
  await service.ready;
  await expect(service.authorizeLastfm()).rejects.toMatchObject({
    code: "backend_update_required",
  });
  expect(service.getSnapshot().error?.recovery).toBe("backend_update");
  expect(h.createTab).not.toHaveBeenCalled();
  expect(installationWrites(h)).toHaveLength(0);
});

it.each([
  {
    browser_url: "https://evil.test/authorize",
    callback_url: origin + "/api/v1/connections/lastfm/extension/result",
  },
  {
    browser_url: origin + "/setup?flow=" + "f".repeat(64),
    callback_url: origin + "/api/v1/connections/lastfm/extension/result",
  },
  {
    browser_url:
      origin +
      "/api/v1/connections/lastfm/extension/authorize?flow=" +
      "f".repeat(64),
    callback_url: "https://evil.test/complete",
  },
])(
  "rejects an untrusted authorization destination without opening a tab: %j",
  async (response) => {
    const h = harness();
    h.fixture.authorizationResponse = () => Response.json(response);
    const service = createEmilService();
    await service.ready;
    await expect(service.authorizeLastfm()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(h.createTab).not.toHaveBeenCalled();
    expect(h.updatedListeners.size).toBe(0);
    expect(h.removedListeners.size).toBe(0);
    expect(
      writes(h.network).map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/v1/connections/lastfm/extension/start"]);
  },
);

it("updates only the owned existing Worker under the installation lock and preserves bindings, connection data and recording state", async () => {
  const h = harness();
  h.fixture.extensionAuthorization = false;
  h.fixture.runtime.records = [
    { track: "Existing song", artist: "Existing artist", catalog_id: "123" },
  ];
  const service = createEmilService();
  await service.ready;
  const before = service.getSnapshot();
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: existingWorkerSettings() });
  h.fixture.onUpload = () => {
    h.fixture.extensionAuthorization = true;
  };
  h.network.mockClear();
  await service.updateBackend("", initial.account);
  expect(h.lock).toHaveBeenCalledWith(
    "scrobbler-install",
    { ifAvailable: true },
    expect.any(Function),
  );
  const mutations = writes(h.network);
  expect(mutations).toHaveLength(1);
  const [target, request] = mutations[0];
  expect(String(target)).toBe(
    "https://api.cloudflare.com/client/v4/accounts/" +
      initial.account +
      "/workers/scripts/" +
      initial.name +
      "?bindings_inherit=strict",
  );
  expect(request?.method).toBe("PUT");
  const form = request?.body as FormData;
  const metadata = JSON.parse(String(form.get("metadata")));
  expect(metadata.bindings).toEqual(
    existingWorkerSettings().bindings.map(({ name }) =>
      name === "INSTALLER_ALGORITHM"
        ? { type: "plain_text", name, text: algorithmVersion }
        : { type: "inherit", name },
    ),
  );
  expect(metadata).not.toHaveProperty("migrations");
  expect(JSON.stringify(metadata)).not.toContain(initial.key);
  expect(installationWrites(h)).toHaveLength(0);
  expect(service.getSnapshot()).toMatchObject({
    installation: initial,
    connections: before.connections,
    runtime: before.runtime,
    verified: true,
    fresh: true,
    error: null,
  });
  expect(h.createTab).not.toHaveBeenCalled();
  expect(h.clipboard).not.toHaveBeenCalled();
  await service.authorizeLastfm();
  expect(h.createTab).toHaveBeenCalledOnce();
});

it("offers an in-place upgrade for the known previous release and authenticates its read-only preflight before uploading 0.3.111", async () => {
  const h = harness();
  h.fixture.version = previousAlgorithm.version;
  h.fixture.hash = previousAlgorithm.hash;
  h.fixture.runtime.algorithm_version = previousAlgorithm.version;
  h.fixture.runtime.algorithm_sha256 = previousAlgorithm.hash;
  h.fixture.runtime.enabled = true;
  h.fixture.runtime.records = [
    { track: "Preserved song", artist: "Artist", track_id: "1001" },
  ];
  const originalRecords = structuredClone(h.fixture.runtime.records);
  const service = createEmilService();
  await expect(service.ready).rejects.toMatchObject({
    code: "backend_upgrade_required",
  });
  expect(service.getSnapshot()).toMatchObject({
    installation: initial,
    verified: false,
    fresh: false,
    error: {
      title: "个人后台需要升级",
      recovery: "backend_update",
      action: "重新连接 Cloudflare",
    },
  });
  expect(writes(h.network)).toHaveLength(0);
  await service.cloudAccounts("test-token-".repeat(4));
  const oldSettings = existingWorkerSettings();
  oldSettings.bindings.find(
    (binding) => binding.name === "INSTALLER_ALGORITHM",
  )!.text = previousAlgorithm.version;
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: oldSettings });
  h.fixture.onUpload = () => {
    h.fixture.version = algorithmVersion;
    h.fixture.hash = algorithmHash;
    h.fixture.runtime.algorithm_version = algorithmVersion;
    h.fixture.runtime.algorithm_sha256 = algorithmHash;
  };
  h.network.mockClear();
  await service.updateBackend("", initial.account);
  expect(writes(h.network)).toHaveLength(1);
  expect(writes(h.network)[0][1]?.method).toBe("PUT");
  const preflight = h.network.mock.calls.filter(([url]) =>
    ["/api/v1/connections", "/api/v1/recording"].includes(
      new URL(String(url)).pathname,
    ),
  );
  expect(preflight).toHaveLength(4);
  expect(
    preflight.every(
      ([, init]) =>
        (init?.headers as Record<string, string>)["x-ascrobble-auth"] ===
        initial.key,
    ),
  ).toBe(true);
  expect(installationWrites(h)).toHaveLength(0);
  expect(service.getSnapshot()).toMatchObject({
    installation: initial,
    verified: true,
    fresh: true,
    runtime: {
      enabled: true,
      algorithm_version: "0.3.111",
      records: originalRecords,
    },
    error: null,
  });
  const metadata = JSON.parse(
    String((writes(h.network)[0][1]?.body as FormData).get("metadata")),
  );
  expect(
    metadata.bindings.find(
      (binding: { name: string }) => binding.name === "INSTALLER_ALGORITHM",
    ),
  ).toEqual({
    name: "INSTALLER_ALGORITHM",
    type: "plain_text",
    text: algorithmVersion,
  });
  expect(
    metadata.bindings.find(
      (binding: { name: string }) => binding.name === "SCROBBLE_COORDINATOR",
    ),
  ).toEqual({ name: "SCROBBLE_COORDINATOR", type: "inherit" });
});

it.each([
  {
    version: previousAlgorithm.version,
    hash: previousAlgorithm.hash,
    error: "backend_upgrade_required",
  },
  {
    version: algorithmVersion,
    hash: previousAlgorithm.hash,
    error: "version_mismatch",
  },
  {
    version: previousAlgorithm.version,
    hash: algorithmHash,
    error: "version_mismatch",
  },
])(
  "does not verify a 0.3.111 health endpoint with inconsistent runtime identity $version / $hash",
  async ({ version, hash, error }) => {
    const h = harness();
    h.fixture.runtime.algorithm_version = version;
    h.fixture.runtime.algorithm_sha256 = hash;
    const service = createEmilService();
    await expect(service.ready).rejects.toMatchObject({ code: error });
    expect(service.getSnapshot()).toMatchObject({
      verified: false,
      fresh: false,
      runtime: null,
    });
    expect(writes(h.network)).toHaveLength(0);
    if (error === "version_mismatch") {
      await service.cloudAccounts("test-token-".repeat(4));
      await expect(
        service.updateBackend("", initial.account),
      ).rejects.toMatchObject({ code: "version_mismatch" });
      expect(writes(h.network)).toHaveLength(0);
    }
  },
);

it("does not report an upgrade as complete while the runtime still serves the exact previous release", async () => {
  const h = harness();
  h.fixture.version = previousAlgorithm.version;
  h.fixture.hash = previousAlgorithm.hash;
  h.fixture.runtime.algorithm_version = previousAlgorithm.version;
  h.fixture.runtime.algorithm_sha256 = previousAlgorithm.hash;
  const snapshots: Array<{ verified: boolean }> = [];
  const service = createEmilService({
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  await expect(service.ready).rejects.toMatchObject({
    code: "backend_upgrade_required",
  });
  await service.cloudAccounts("test-token-".repeat(4));
  const oldSettings = existingWorkerSettings();
  oldSettings.bindings.find(
    (binding) => binding.name === "INSTALLER_ALGORITHM",
  )!.text = previousAlgorithm.version;
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: oldSettings });
  h.fixture.onUpload = () => {
    h.fixture.version = algorithmVersion;
    h.fixture.hash = algorithmHash;
  };
  await expect(
    service.updateBackend("", initial.account),
  ).rejects.toMatchObject({ code: "backend_update_pending" });
  expect(snapshots.some((snapshot) => snapshot.verified)).toBe(false);
  expect(service.getSnapshot()).toMatchObject({
    verified: false,
    fresh: false,
    runtime: null,
  });
  expect(writes(h.network)).toHaveLength(1);
  h.fixture.runtime.algorithm_version = algorithmVersion;
  h.fixture.runtime.algorithm_sha256 = algorithmHash;
  await service.refresh();
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    fresh: true,
    error: null,
  });
  expect(writes(h.network)).toHaveLength(1);
});

it.each([
  { version: "0.3.110", hash: previousAlgorithm.hash },
  { version: previousAlgorithm.version, hash: algorithmHash },
])(
  "rejects an unknown release/hash during the explicit update preflight: $version",
  async ({ version, hash }) => {
    const h = harness();
    h.fixture.version = version;
    h.fixture.hash = hash;
    const service = createEmilService();
    await expect(service.ready).rejects.toMatchObject({
      code: "version_mismatch",
    });
    await service.cloudAccounts("test-token-".repeat(4));
    h.network.mockClear();
    await expect(
      service.updateBackend("", initial.account),
    ).rejects.toMatchObject({ code: "version_mismatch" });
    expect(writes(h.network)).toHaveLength(0);
    expect(
      h.network.mock.calls.every(
        ([url]) => new URL(String(url)).pathname === "/health",
      ),
    ).toBe(true);
  },
);

it("clears previous persisted covers after an owned upgrade that began before the old backend could be verified", async () => {
  const h = harness();
  const record = {
    track: "Preserved song",
    artist: "Artist",
    track_id: "1001",
  };
  h.fixture.runtime.records = [record];
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/previous-release.jpg";
  const previousPage = createEmilService();
  await previousPage.ready;
  await previousPage.getArtwork(record);
  previousPage.dispose();
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toHaveLength(1);
  h.fixture.version = previousAlgorithm.version;
  h.fixture.hash = previousAlgorithm.hash;
  const upgradePage = createEmilService();
  await expect(upgradePage.ready).rejects.toMatchObject({
    code: "backend_upgrade_required",
  });
  await upgradePage.cloudAccounts("test-token-".repeat(4));
  const oldSettings = existingWorkerSettings();
  oldSettings.bindings.find(
    (binding) => binding.name === "INSTALLER_ALGORITHM",
  )!.text = previousAlgorithm.version;
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: oldSettings });
  h.fixture.onUpload = () => {
    h.fixture.version = algorithmVersion;
    h.fixture.hash = algorithmHash;
    h.fixture.runtime.algorithm_version = algorithmVersion;
    h.fixture.runtime.algorithm_sha256 = algorithmHash;
  };
  await upgradePage.updateBackend("", initial.account);
  expect(
    (h.store[ARTWORK_CACHE_KEY] as { entries: unknown[] }).entries,
  ).toEqual([]);
  expect(installationWrites(h)).toHaveLength(0);
  expect(upgradePage.getSnapshot()).toMatchObject({
    installation: initial,
    verified: true,
    fresh: true,
  });
});

it("waits for the target release after an upload instead of treating a still-served previous release as active", async () => {
  const h = harness();
  h.fixture.version = previousAlgorithm.version;
  h.fixture.hash = previousAlgorithm.hash;
  const service = createEmilService();
  await expect(service.ready).rejects.toMatchObject({
    code: "backend_upgrade_required",
  });
  await service.cloudAccounts("test-token-".repeat(4));
  const oldSettings = existingWorkerSettings();
  oldSettings.bindings.find(
    (binding) => binding.name === "INSTALLER_ALGORITHM",
  )!.text = previousAlgorithm.version;
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: oldSettings });
  await expect(
    service.updateBackend("", initial.account),
  ).rejects.toMatchObject({ code: "backend_update_pending" });
  expect(writes(h.network)).toHaveLength(1);
  expect(service.getSnapshot().verified).toBe(false);
});

it.each(["appleArtworkSupport", "artworkDiagnostics"] as const)(
  "requires current artwork capability %s after upload instead of accepting an older image backend",
  async (capability) => {
    const h = harness();
    h.fixture[capability] = false;
    const service = createEmilService();
    await service.ready;
    const before = service.getSnapshot();
    await service.cloudAccounts("test-token-".repeat(4));
    h.fixture.settingsResponse = () =>
      Response.json({ success: true, result: existingWorkerSettings() });
    await expect(
      service.updateBackend("", initial.account),
    ).rejects.toMatchObject({
      code: "backend_update_pending",
    });
    expect(writes(h.network)).toHaveLength(1);
    expect(service.getSnapshot()).toMatchObject({
      installation: before.installation,
      connections: before.connections,
      runtime: before.runtime,
      error: { recovery: "refresh" },
    });
    expect(installationWrites(h)).toHaveLength(0);
  },
);

it("does not confirm an artwork update while the old runtime marker is still served", async () => {
  const h = harness();
  h.fixture.artworkRuntime = "";
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: existingWorkerSettings() });
  await expect(
    service.updateBackend("", initial.account),
  ).rejects.toMatchObject({
    code: "backend_update_pending",
  });
  expect(writes(h.network)).toHaveLength(1);
  expect(installationWrites(h)).toHaveLength(0);
  expect(service.getSnapshot().error?.recovery).toBe("refresh");
});

it("does not report a complete backend update until recording diagnostics are served", async () => {
  const h = harness();
  h.fixture.recordingDiagnostics = false;
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: existingWorkerSettings() });
  await expect(
    service.updateBackend("", initial.account),
  ).rejects.toMatchObject({ code: "backend_update_pending" });
  expect(writes(h.network)).toHaveLength(1);
  expect(service.getSnapshot().error?.recovery).toBe("refresh");
});

it("receives HTTP200 recording issues without treating the entire backend as unavailable and still allows pause", async () => {
  const h = harness();
  h.fixture.runtime.enabled = true;
  h.fixture.runtime.recording_issue = { code: "apple_reconnect_required" };
  const service = createEmilService();
  await service.ready;
  expect(service.getSnapshot()).toMatchObject({
    fresh: true,
    verified: true,
    runtime: { recording_issue: { code: "apple_reconnect_required" } },
  });
  await service.pauseRecording();
  expect(service.getSnapshot().runtime?.enabled).toBe(false);
  expect(
    h.network.mock.calls.some(([url]) =>
      String(url).endsWith("/recording/pause"),
    ),
  ).toBe(true);
});

it("retains the safe original queue owner from a start conflict that races with readback", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  h.fixture.startResponse = () =>
    Response.json(
      {
        error: "queue_account_changed",
        recording_issue: {
          code: "queue_account_changed",
          queue_owner: "OriginalListener",
          upstream: "private-secret",
        },
      },
      { status: 409 },
    );
  await expect(service.startRecording("Listener")).rejects.toMatchObject({
    code: "queue_account_changed",
  });
  expect(service.getSnapshot().runtime?.recording_issue).toEqual({
    code: "queue_account_changed",
    queue_owner: "OriginalListener",
  });
  expect(service.getSnapshot().error?.detail).toContain("OriginalListener");
  expect(JSON.stringify(service.getSnapshot())).not.toContain("private-secret");
});

it("invalidates missing and pending artwork from the previous deployment after a verified update", async () => {
  const h = harness();
  const first = {
    track: "First",
    artist: "Artist",
    track_id: "1001",
    catalog_id: null,
  };
  const second = {
    track: "Second",
    artist: "Artist",
    track_id: "1002",
    catalog_id: null,
  };
  h.fixture.runtime.records = [first, second];
  h.fixture.appleArtworkSupport = false;
  const service = createEmilService();
  await service.ready;
  await expect(service.getArtwork(first)).resolves.toBeNull();
  let finishOld!: (value: Response) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.fixture.artworkResponse = async () => {
    started();
    return new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
  };
  const old = service.getArtwork(second);
  await began;
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: existingWorkerSettings() });
  h.fixture.onUpload = () => {
    h.fixture.appleArtworkSupport = true;
  };
  await service.updateBackend("", initial.account);
  h.fixture.artworkResponse = null;
  h.fixture.artwork = "https://is1-ssl.mzstatic.com/updated.jpg";
  await expect(service.getArtwork(first)).resolves.toBe(h.fixture.artwork);
  await expect(service.getArtwork(second)).resolves.toBe(h.fixture.artwork);
  finishOld(Response.json({ artwork_url: null }));
  await expect(old).resolves.toBeNull();
  await expect(service.getArtwork(second)).resolves.toBe(h.fixture.artwork);
  expect(writes(h.network)).toHaveLength(1);
});

it("refuses a different deployment account before uploading and leaves existing credentials and records untouched", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  const before = service.getSnapshot();
  h.network.mockClear();
  await expect(service.updateBackend("", "0".repeat(32))).rejects.toMatchObject(
    { code: "install_conflict" },
  );
  expect(h.network).not.toHaveBeenCalled();
  expect(installationLocks(h)).toHaveLength(0);
  expect(installationWrites(h)).toHaveLength(0);
  expect(service.getSnapshot()).toMatchObject({
    installation: before.installation,
    connections: before.connections,
    runtime: before.runtime,
  });
});

it("refuses an installation changed by another extension page while waiting for the update lock", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.store.installation = { ...initial, key: "0".repeat(64) };
  h.network.mockClear();
  await expect(
    service.updateBackend("", initial.account),
  ).rejects.toMatchObject({ code: "install_conflict" });
  expect(writes(h.network)).toHaveLength(0);
  expect(installationWrites(h)).toHaveLength(0);
  expect(service.getSnapshot().installation).toEqual(initial);
});

it("copies exact private information without service requests and reports denied clipboard access", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  const previous = h.network.mock.calls.length;
  await service.copyInfo("key");
  await service.copyInfo("homepage");
  await service.copyInfo("callback");
  expect(h.clipboard.mock.calls).toEqual([
    [initial.key],
    [origin],
    [origin + "/api/v1/connections/lastfm/callback"],
  ]);
  h.clipboard.mockRejectedValueOnce(new Error("private browser details"));
  await expect(service.copyInfo("key")).rejects.toThrow(
    "clipboard_unavailable",
  );
  expect(service.getSnapshot().error?.recovery).toBe("retry-copy");
  expect(h.network).toHaveBeenCalledTimes(previous);
});

it.each([
  {
    name: "HTTP rejection",
    code: "token_http",
    response: () => Response.json({ success: false }, { status: 403 }),
  },
  {
    name: "expired token",
    code: "token_expired",
    response: () =>
      Response.json({ success: true, result: { status: "expired" } }),
  },
  {
    name: "disabled token",
    code: "token_disabled",
    response: () =>
      Response.json({ success: true, result: { status: "disabled" } }),
  },
])(
  "clears cached deployment access after a read-only token verification fails with $name",
  async ({ code, response }) => {
    const h = harness({ installed: false });
    const service = createEmilService();
    await service.ready;
    await service.cloudAccounts("test-token-".repeat(4));
    h.network.mockClear();
    h.fixture.tokenResponse = response;

    await expect(
      service.cloudAccounts("replacement-token-".repeat(3)),
    ).rejects.toMatchObject({ code });
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(String(h.network.mock.calls[0][0])).toBe(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
    );
    expect(writes(h.network)).toHaveLength(0);
    expect(installationWrites(h)).toHaveLength(0);
    expect(service.getSnapshot().installation).toBeNull();

    await expect(service.deploy("", initial.account)).rejects.toMatchObject({
      code: "cloud_token",
    });
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(installationLocks(h)).toHaveLength(0);
    expect(installationWrites(h)).toHaveLength(0);
  },
);

it("deploys under the installation lock using a cached token client and keeps recording paused", async () => {
  const h = harness({ installed: false });
  const progress = vi.fn();
  const service = createEmilService({ onProgress: progress });
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  await service.deploy("", initial.account);
  expect(h.lock).toHaveBeenCalledWith(
    "scrobbler-install",
    { ifAvailable: true },
    expect.any(Function),
  );
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    fresh: true,
    runtime: { enabled: false },
  });
  expect(service.getSnapshot().installation?.origin).toMatch(
    /^https:\/\/ams-[a-f\d]{24}\.preview\.workers\.dev$/,
  );
  expect(progress).toHaveBeenCalledTimes(4);
  expect(
    h.storageSet.mock.calls.every(
      ([value]) => !JSON.stringify(value).includes("test-token"),
    ),
  ).toBe(true);
  expect(
    h.network.mock.calls.some(([url]) =>
      /\/recording\/start$|schedules/.test(String(url)),
    ),
  ).toBe(false);
});

it("requests the exact new backend in the installation click and completes without a recovery click", async () => {
  const h = harness({ installed: false, permission: false });
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.network.mockClear();
  h.requestPermission.mockClear();
  let userGesture = true;
  let grant!: () => void;
  h.requestPermission.mockImplementationOnce((request) => {
    expect(userGesture).toBe(true);
    return new Promise<boolean>((resolve) => {
      grant = () => {
        h.grantPermission(request);
        resolve(true);
      };
    });
  });
  const deploying = service.deploy("", initial.account);
  userGesture = false;
  expect(h.requestPermission).toHaveBeenCalledOnce();
  const requested = h.requestPermission.mock.calls[0][0].origins;
  expect(requested).toHaveLength(2);
  expect(requested).toContain("https://api.cloudflare.com/*");
  const workerPermission = requested.find(
    (item) => item !== "https://api.cloudflare.com/*",
  )!;
  expect(workerPermission).toMatch(
    /^https:\/\/ams-[a-f\d]{24}\.preview\.workers\.dev\/\*$/,
  );
  expect(installationLocks(h)).toHaveLength(0);
  expect(installationWrites(h)).toHaveLength(0);
  expect(h.network).not.toHaveBeenCalled();

  grant();
  await deploying;
  const deployed = service.getSnapshot().installation!;
  expect(deployed.origin + "/*").toBe(workerPermission);
  expect(h.grantedOrigins.has(workerPermission)).toBe(true);
  expect(h.requestPermission).toHaveBeenCalledOnce();
  expect(installationLocks(h)).toHaveLength(1);
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    fresh: true,
    busy: false,
    error: null,
    runtime: { enabled: false },
  });
  expect(
    h.network.mock.calls.some(([url]) => {
      const destination = new URL(String(url));
      return (
        destination.origin === deployed.origin &&
        destination.pathname === "/health"
      );
    }),
  ).toBe(true);
});

it.each(["denied", "rejected"])(
  "does not create any installation or cloud resources when initial host permission is %s",
  async (failure) => {
    const h = harness({ installed: false });
    const service = createEmilService();
    await service.ready;
    await service.cloudAccounts("test-token-".repeat(4));
    h.network.mockClear();
    if (failure === "denied") h.requestPermission.mockResolvedValueOnce(false);
    else
      h.requestPermission.mockRejectedValueOnce(
        Error("private permission details"),
      );

    await expect(service.deploy("", initial.account)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(h.network).not.toHaveBeenCalled();
    expect(installationLocks(h)).toHaveLength(0);
    expect(installationWrites(h)).toHaveLength(0);
    expect(service.getSnapshot()).toMatchObject({
      installation: null,
      busy: false,
      verified: false,
    });
    expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
      "private permission details",
    );
  },
);

it("reuses the saved installation identity after a cloud upload fails and is retried", async () => {
  const h = harness({ installed: false });
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.uploadResponse = () =>
    Response.json({ success: false }, { status: 503 });
  await expect(service.deploy("", initial.account)).rejects.toThrow();
  const first = service.getSnapshot().installation!;
  expect(first.name).toMatch(/^ams-[a-f\d]{24}$/);
  expect(first.namespace).toBeDefined();
  h.fixture.uploadResponse = null;
  await service.cloudAccounts("test-token-".repeat(4));
  await service.deploy("", initial.account);
  const completed = service.getSnapshot().installation!;
  expect(completed).toMatchObject({
    name: first.name,
    marker: first.marker,
    key: first.key,
    namespace: first.namespace,
  });
  const uploadedNames = h.network.mock.calls
    .filter(
      ([url, init]) =>
        /\/workers\/scripts\/[^/]+$/.test(new URL(String(url)).pathname) &&
        init?.method === "PUT",
    )
    .map(([url]) => new URL(String(url)).pathname.split("/").at(-1));
  expect(uploadedNames).toEqual([first.name, first.name]);
  expect(
    h.requestPermission.mock.calls.filter(([request]) =>
      request.origins.includes(completed.origin + "/*"),
    ),
  ).toHaveLength(2);
});

it.each(["new", "existing"])(
  "stops before installing when another page changes the %s local installation while permission is pending",
  async (kind) => {
    const h = harness({ installed: kind === "existing" });
    const service = createEmilService();
    await service.ready;
    await service.cloudAccounts("test-token-".repeat(4));
    const before = service.getSnapshot().installation;
    let grant!: () => void;
    h.requestPermission.mockImplementationOnce(
      (request) =>
        new Promise<boolean>((resolve) => {
          grant = () => {
            h.grantPermission(request);
            resolve(true);
          };
        }),
    );
    const deploying = service.deploy("", initial.account);
    expect(installationLocks(h)).toHaveLength(0);
    h.storageGet.mockResolvedValueOnce({
      installation: { ...initial, key: "0".repeat(64) },
    });
    h.network.mockClear();
    grant();
    await expect(deploying).rejects.toMatchObject({
      code: "install_conflict",
    });
    expect(h.network).not.toHaveBeenCalled();
    expect(installationWrites(h)).toHaveLength(0);
    expect(service.getSnapshot().installation).toEqual(before);
  },
);

it("keeps other deployment accounts usable when one account cannot read its Workers domain", async () => {
  const h = harness({ installed: false });
  const failingAccount = "1".repeat(32);
  h.fixture.cloudAccounts.unshift({
    id: failingAccount,
    name: "Unavailable account",
  });
  h.fixture.subdomainResponse = (account) =>
    account === failingAccount
      ? Response.json(
          { success: false, errors: [{ code: 10000 }] },
          { status: 403 },
        )
      : Response.json({ success: true, result: { subdomain: "preview" } });
  const service = createEmilService();
  await service.ready;
  const accounts = await service.cloudAccounts("test-token-".repeat(4));
  expect(accounts.map((account) => account.id)).toEqual([
    failingAccount,
    initial.account,
  ]);
  h.network.mockClear();
  await expect(service.deploy("", failingAccount)).rejects.toThrow();
  expect(writes(h.network)).toHaveLength(0);
  expect(installationLocks(h)).toHaveLength(0);
  expect(installationWrites(h)).toHaveLength(0);
  await service.deploy("", initial.account);
  expect(service.getSnapshot()).toMatchObject({ verified: true, fresh: true });
});

it("stops before cloud writes if the account domain changed since the permission was prepared", async () => {
  const h = harness({ installed: false });
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.subdomainResponse = () =>
    Response.json({
      success: true,
      result: { subdomain: "changed" },
    });
  h.network.mockClear();
  await expect(service.deploy("", initial.account)).rejects.toThrow(
    "deployment_origin_changed",
  );
  expect(writes(h.network)).toHaveLength(0);
  expect(
    h.network.mock.calls.some(([url]) =>
      new URL(String(url)).hostname.endsWith(".workers.dev"),
    ),
  ).toBe(false);
  expect(service.getSnapshot()).toMatchObject({
    verified: false,
    busy: false,
  });
});

it("requests existing backend and Cloudflare permission in the update click before checking or changing either service", async () => {
  const h = harness();
  const service = createEmilService();
  await service.ready;
  await service.cloudAccounts("test-token-".repeat(4));
  h.fixture.settingsResponse = () =>
    Response.json({ success: true, result: existingWorkerSettings() });
  h.network.mockClear();
  h.requestPermission.mockClear();
  let userGesture = true;
  let grant!: () => void;
  h.requestPermission.mockImplementationOnce((request) => {
    expect(userGesture).toBe(true);
    return new Promise<boolean>((resolve) => {
      grant = () => {
        h.grantPermission(request);
        resolve(true);
      };
    });
  });
  const updating = service.updateBackend("", initial.account);
  userGesture = false;
  expect(h.requestPermission).toHaveBeenCalledExactlyOnceWith({
    origins: ["https://api.cloudflare.com/*", origin + "/*"],
  });
  expect(h.network).not.toHaveBeenCalled();
  expect(installationLocks(h)).toHaveLength(0);
  expect(installationWrites(h)).toHaveLength(0);
  grant();
  await updating;
  expect(h.requestPermission).toHaveBeenCalledOnce();
  expect(service.getSnapshot()).toMatchObject({
    verified: true,
    fresh: true,
    busy: false,
  });
});

it.each(["denied", "rejected"])(
  "leaves an existing installation untouched when update host permission is %s",
  async (failure) => {
    const h = harness();
    const service = createEmilService();
    await service.ready;
    await service.cloudAccounts("test-token-".repeat(4));
    const previous = service.getSnapshot();
    h.network.mockClear();
    if (failure === "denied") h.requestPermission.mockResolvedValueOnce(false);
    else
      h.requestPermission.mockRejectedValueOnce(
        Error("private permission diagnostics"),
      );

    await expect(
      service.updateBackend("", initial.account),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(h.network).not.toHaveBeenCalled();
    expect(installationLocks(h)).toHaveLength(0);
    expect(installationWrites(h)).toHaveLength(0);
    expect(service.getSnapshot()).toMatchObject({
      installation: previous.installation,
      connections: previous.connections,
      runtime: previous.runtime,
      busy: false,
    });
    expect(JSON.stringify(service.getSnapshot().error)).not.toContain(
      "private permission diagnostics",
    );
  },
);
