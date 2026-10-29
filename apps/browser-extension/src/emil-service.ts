import { safeAlbumArtworkUrl } from "./emil-artwork";
import {
  algorithmVersion,
  algorithmHash,
  previousAlgorithm,
} from "./algorithm-release";
import {
  createArtworkPersistence,
  artworkIdentityKey,
  ARTWORK_CACHE_TTL,
} from "./emil-artwork-cache";
import {
  artworkLookup,
  type ArtworkLookup,
} from "../../../packages/contracts/src/artwork-record";
import { captureAppleCredentials } from "./capture";
import {
  Cloudflare,
  CloudflareError,
  missingWorkersSubdomain,
  validateInstall,
  type InstallState,
} from "./cloudflare";
import { connectApple as saveAppleConnection } from "./connection";
import { ServiceError, toUiError, type UiError } from "./extension-errors";
import {
  deriveViewModel,
  type Connections,
  type Runtime,
} from "./extension-state";
import { createRefreshCoordinator } from "./refresh-coordinator";
import { openLastfmAuthorization } from "./emil-lastfm";
import {
  parseRecordingIssue,
  recordingIssue,
  recordingIssueError,
} from "./recording-issue";

export interface EmilSnapshot {
  installation: InstallState | null;
  connections: Connections | null;
  runtime: Runtime | null;
  verified: boolean;
  fresh: boolean;
  busy: boolean;
  error: UiError | null;
}

export type EmilAccount = { id: string; name: string };
export type EmilCopyInfo = "key" | "homepage" | "callback";

const recentRecordLimit = 10;

/** Non-visual extension operations. Provider credentials never enter snapshots. */
export function createEmilService(
  options: {
    onChange?: (snapshot: EmilSnapshot) => void;
    onProgress?: (message: string) => void;
  } = {},
) {
  let state: EmilSnapshot = {
    installation: null,
    connections: null,
    runtime: null,
    verified: false,
    fresh: false,
    busy: false,
    error: null,
  };
  let cloudClient: Cloudflare | undefined;
  let accounts: EmilAccount[] = [];
  const accountDomains = new Map<
    string,
    { domain: string } | { error: Error }
  >();
  let loading: Promise<void> | undefined;
  let lastfmExtensionAuth = false;
  let appleSourceArtwork = false;
  let artworkDiagnostics = false;
  let workerdArtwork = false;
  let recordingDiagnostics = false;
  let closeLastfmAuthorization: ((closeTab?: boolean) => void) | undefined;
  const persistentArtwork = createArtworkPersistence();
  let artworkPersistenceReady: Promise<void> = Promise.resolve();
  let artworkScopeToken = {};
  let artworkScopeFingerprint = "";
  let disposed = false;
  const artworkCache = new Map<
    string,
    { url: string | null; expires: number }
  >();
  const artworkPending = new Map<string, Promise<string | null>>();
  const artworkWaiters: Array<() => void> = [];
  let artworkActive = 0;
  async function artworkSlot<T>(task: () => Promise<T>): Promise<T> {
    if (artworkActive >= 3)
      await new Promise<void>((resolve) => artworkWaiters.push(resolve));
    else artworkActive++;
    try {
      return await task();
    } finally {
      const next = artworkWaiters.shift();
      if (next) next();
      else artworkActive--;
    }
  }

  const getSnapshot = (): EmilSnapshot => ({ ...state });
  function artworkIdentity(
    value: string | Runtime["records"][number],
  ): ArtworkLookup | null {
    return typeof value === "string"
      ? /^[1-9]\d{0,19}$/.test(value)
        ? { kind: "catalog_id", id: value }
        : null
      : artworkLookup(value);
  }
  function artworkAccount(): string {
    const username = state.connections?.lastfm.username;
    return state.connections?.lastfm.connected && typeof username === "string"
      ? username.trim().toLowerCase()
      : "";
  }
  function artworkMemoryKey(identity: ArtworkLookup): string {
    return JSON.stringify([
      state.installation?.origin,
      state.installation?.key,
      artworkAccount(),
      identity.kind,
      identity.id,
    ]);
  }
  function visibleArtworkIdentities(): ArtworkLookup[] {
    return (state.runtime?.records ?? [])
      .slice(0, recentRecordLimit)
      .flatMap((record) =>
        [
          artworkIdentity(record),
          artworkIdentity(String(record.catalog_id ?? "")),
        ].filter((value): value is ArtworkLookup => value !== null),
      );
  }
  function restoreArtworkCache() {
    const origin = state.installation?.origin;
    const key = state.installation?.key;
    const username = artworkAccount();
    const identities = visibleArtworkIdentities();
    const fingerprint = JSON.stringify([origin, key, username]);
    if (fingerprint !== artworkScopeFingerprint) {
      artworkScopeFingerprint = fingerprint;
      artworkScopeToken = {};
      artworkCache.clear();
      artworkPending.clear();
    }
    const allowed = () =>
      !disposed &&
      state.verified &&
      state.installation?.origin === origin &&
      state.installation?.key === key &&
      artworkAccount() === username;
    artworkPersistenceReady = persistentArtwork
      .reconcile(
        origin && key && username ? { origin, key, username } : null,
        identities.map((identity) =>
          artworkIdentityKey(identity.kind, identity.id),
        ),
        allowed,
      )
      .then((entries) => {
        if (!allowed()) return;
        for (const entry of entries) {
          const identity = identities.find(
            (value) =>
              artworkIdentityKey(value.kind, value.id) === entry.identity,
          );
          if (identity && !artworkCache.has(artworkMemoryKey(identity)))
            artworkCache.set(artworkMemoryKey(identity), {
              url: entry.url,
              expires: entry.expires,
            });
        }
        pruneArtworkCache();
      });
  }
  function pruneArtworkCache() {
    const visible = new Set(
      state.verified && state.installation?.origin
        ? visibleArtworkIdentities().map(artworkMemoryKey)
        : [],
    );
    for (const [key, cached] of artworkCache)
      if (!visible.has(key) || cached.expires <= Date.now())
        artworkCache.delete(key);
    for (const key of artworkPending.keys())
      if (!visible.has(key)) artworkPending.delete(key);
  }
  function publish() {
    pruneArtworkCache();
    options.onChange?.(getSnapshot());
  }
  function fail(error: unknown) {
    state.error =
      error instanceof ServiceError && error.code === "queue_account_changed"
        ? (recordingIssueError(recordingIssue(state.runtime)) ??
          toUiError(error))
        : toUiError(error);
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)) ||
      (error instanceof ServiceError &&
        [
          "permission_denied",
          "unauthorized",
          "version_mismatch",
          "backend_upgrade_required",
          "backend_unavailable",
          "invalid_response",
          "http_429",
        ].includes(error.code))
    )
      state.fresh = false;
    if (
      error instanceof ServiceError &&
      ["version_mismatch", "backend_upgrade_required"].includes(error.code)
    )
      state.verified = false;
    publish();
  }
  function installation() {
    const value = state.installation;
    if (!value?.origin) throw new ServiceError("connections_required");
    return value as InstallState & { origin: string };
  }
  async function permission(origins: string | string[]) {
    try {
      if (
        await chrome.permissions.request({
          origins: (Array.isArray(origins) ? origins : [origins]).map(
            (origin) => origin + "/*",
          ),
        })
      )
        return;
    } catch {
      // Chrome may reject when a grant is unavailable, just as it may return false.
    }
    throw new ServiceError("permission_denied");
  }
  async function save(value: InstallState) {
    const valid = validateInstall(value);
    await chrome.storage.local.set({ installation: valid });
    state.installation = { ...valid };
    publish();
  }
  async function verifyHealth(allowPrevious = false): Promise<boolean> {
    const { origin } = installation();
    const response = await fetch(origin + "/health", {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new ServiceError(
        response.status === 429 ? "http_429" : "backend_unavailable",
        response.status,
      );
    const health = (await response.json().catch(() => null)) as {
      version?: unknown;
      algorithm_sha256?: unknown;
      capabilities?: {
        lastfm_extension_auth?: unknown;
        apple_source_artwork?: unknown;
        apple_artwork_diagnostics?: unknown;
        apple_artwork_runtime?: unknown;
        recording_diagnostics?: unknown;
      };
    } | null;
    if (
      typeof health?.version !== "string" ||
      !health.version.trim() ||
      typeof health.algorithm_sha256 !== "string" ||
      !health.algorithm_sha256.trim()
    )
      throw new ServiceError("invalid_response");
    const current =
      health.version === algorithmVersion &&
      health.algorithm_sha256 === algorithmHash;
    const previous =
      health.version === previousAlgorithm.version &&
      health.algorithm_sha256 === previousAlgorithm.hash;
    if (previous && !allowPrevious)
      throw new ServiceError("backend_upgrade_required");
    if (!current && !(allowPrevious && previous))
      throw new ServiceError("version_mismatch");
    lastfmExtensionAuth = health.capabilities?.lastfm_extension_auth === true;
    appleSourceArtwork = health.capabilities?.apple_source_artwork === true;
    artworkDiagnostics =
      health.capabilities?.apple_artwork_diagnostics === true;
    workerdArtwork =
      health.capabilities?.apple_artwork_runtime === "workerd-manual-v1";
    recordingDiagnostics = health.capabilities?.recording_diagnostics === true;
    return current;
  }
  async function api(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutMs = 60000,
    allowPrevious = false,
  ) {
    const { origin, key } = installation();
    if (method !== "GET") {
      state.fresh = false;
      publish();
    }
    await verifyHealth(allowPrevious);
    if (
      path === "/api/v1/connections/lastfm/extension/start" &&
      !lastfmExtensionAuth
    )
      throw new ServiceError("backend_update_required");
    const result = await fetch(origin + path, {
      method,
      headers: { "x-ascrobble-auth": key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: any;
    try {
      data = await result.json();
    } catch {
      throw new ServiceError("invalid_response", result.status);
    }
    if (!result.ok) {
      if (data?.error === "queue_account_changed" && state.runtime) {
        const issue = parseRecordingIssue(data.recording_issue);
        state.runtime = {
          ...state.runtime,
          recording_issue:
            issue?.code === "queue_account_changed"
              ? issue
              : { code: "queue_account_changed" },
        };
      }
      throw new ServiceError(
        path === "/api/v1/connections/lastfm/extension/start" &&
          result.status === 404
          ? "backend_update_required"
          : result.status === 401 || result.status === 403
            ? "unauthorized"
            : typeof data?.error === "string"
              ? data.error
              : "backend_error",
        result.status,
      );
    }
    return data;
  }
  async function readConnections(allowPrevious = false) {
    const connections = (await api(
      "/api/v1/connections",
      "GET",
      undefined,
      60000,
      allowPrevious,
    )) as Connections;
    const runtime = (await api(
      "/api/v1/recording",
      "GET",
      undefined,
      60000,
      allowPrevious,
    )) as Runtime;
    if (
      typeof connections?.apple?.connected !== "boolean" ||
      typeof connections?.lastfm?.connected !== "boolean" ||
      typeof runtime?.enabled !== "boolean" ||
      typeof runtime.algorithm_version !== "string" ||
      typeof runtime.algorithm_sha256 !== "string" ||
      !Array.isArray(runtime.records) ||
      typeof runtime.stats?.total_scrobbled !== "number"
    )
      throw new ServiceError("invalid_response");
    const current =
      runtime.algorithm_version === algorithmVersion &&
      runtime.algorithm_sha256 === algorithmHash;
    const previous =
      runtime.algorithm_version === previousAlgorithm.version &&
      runtime.algorithm_sha256 === previousAlgorithm.hash;
    if (previous && !allowPrevious)
      throw new ServiceError("backend_upgrade_required");
    if (!current && !(allowPrevious && previous))
      throw new ServiceError("version_mismatch");
    return {
      connections,
      runtime: {
        ...runtime,
        ...(Object.hasOwn(runtime, "recording_issue")
          ? { recording_issue: parseRecordingIssue(runtime.recording_issue) }
          : {}),
        records: runtime.records.slice(0, recentRecordLimit),
      },
    };
  }
  const refreshCoordinator = createRefreshCoordinator(
    () => readConnections(),
    (value) => {
      state = {
        ...state,
        ...value,
        verified: true,
        fresh: true,
        error: null,
      };
      restoreArtworkCache();
      publish();
    },
  );
  async function refreshNow() {
    try {
      await refreshCoordinator.run();
      await artworkPersistenceReady;
    } catch (error) {
      state.fresh = false;
      throw error;
    }
  }
  async function refresh(
    settings: { permission?: boolean } = {},
  ): Promise<void> {
    if (state.busy || !state.installation?.origin) return;
    try {
      const { origin } = installation();
      if (settings.permission) await permission(origin);
      else if (
        !(await chrome.permissions.contains({ origins: [origin + "/*"] }))
      ) {
        state.fresh = false;
        publish();
        return;
      }
      // A mutation may have begun while the browser checked host permission.
      if (state.busy) return;
      await refreshNow();
    } catch (error) {
      fail(error);
      throw error;
    }
  }
  /** Optional cover enrichment never changes recording/error/busy state. */
  async function getArtwork(
    value: string | Runtime["records"][number],
  ): Promise<string | null> {
    const identity = artworkIdentity(value);
    if (!identity) return null;
    const origin = state.installation?.origin;
    const key = state.installation?.key;
    const username = artworkAccount();
    const allowed = () =>
      !!origin &&
      !!key &&
      !disposed &&
      state.verified &&
      state.installation?.origin === origin &&
      state.installation.key === key &&
      artworkAccount() === username &&
      !!state.runtime?.records
        .slice(0, recentRecordLimit)
        .some((record) =>
          identity.kind === "track_id"
            ? artworkLookup(record)?.kind === "track_id" &&
              record.track_id === identity.id
            : String(record.catalog_id ?? "") === identity.id,
        );
    if (!allowed()) return null;
    try {
      if (
        !(await chrome.permissions.contains({ origins: [origin + "/*"] })) ||
        !allowed()
      )
        return null;
      await artworkPersistenceReady;
      if (!allowed()) return null;
      const cacheKey = JSON.stringify([
        origin,
        key,
        username,
        identity.kind,
        identity.id,
      ]);
      const cached = artworkCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) return cached.url;
      const pending = artworkPending.get(cacheKey);
      if (pending) return pending;
      if (artworkPending.size >= recentRecordLimit) return null;
      const request: Promise<string | null> = artworkSlot(
        async (): Promise<string | null> => {
          if (!allowed()) return null;
          let url: string | null = null;
          try {
            const data = await api(
              "/api/v1/artwork?" +
                identity.kind +
                "=" +
                encodeURIComponent(identity.id),
              "GET",
              undefined,
              8000,
            );
            if (!allowed()) return null;
            url = safeAlbumArtworkUrl(data?.artwork_url);
          } catch {
            /* A missing cover does not change the operational state. */
          }
          if (!allowed() || artworkPending.get(cacheKey) !== request)
            return null;
          pruneArtworkCache();
          if (artworkCache.size >= recentRecordLimit)
            artworkCache.delete(artworkCache.keys().next().value!);
          artworkCache.set(cacheKey, {
            url,
            expires: Date.now() + (url ? ARTWORK_CACHE_TTL : 60000),
          });
          await artworkPersistenceReady;
          if (!allowed() || artworkPending.get(cacheKey) !== request)
            return null;
          if (url)
            await persistentArtwork.put(
              artworkIdentityKey(identity.kind, identity.id),
              url,
              allowed,
            );
          return allowed() && artworkPending.get(cacheKey) === request
            ? url
            : null;
        },
      );
      artworkPending.set(cacheKey, request);
      try {
        return await request;
      } finally {
        if (artworkPending.get(cacheKey) === request)
          artworkPending.delete(cacheKey);
      }
    } catch {
      return null;
    }
  }
  async function forgetArtwork(
    value: string | Runtime["records"][number],
    expectedUrl: string,
    token: object,
  ): Promise<void> {
    const identity = artworkIdentity(value);
    if (!identity || token !== artworkScopeToken || disposed) return;
    await artworkPersistenceReady;
    if (token !== artworkScopeToken || disposed) return;
    const cacheKey = artworkMemoryKey(identity);
    if (artworkCache.get(cacheKey)?.url !== expectedUrl) return;
    artworkCache.delete(cacheKey);
    await persistentArtwork.forget(
      artworkIdentityKey(identity.kind, identity.id),
      expectedUrl,
      () =>
        !disposed &&
        token === artworkScopeToken &&
        (!artworkCache.has(cacheKey) ||
          artworkCache.get(cacheKey)?.url === expectedUrl),
    );
    if (
      token === artworkScopeToken &&
      artworkCache.get(cacheKey)?.url === expectedUrl
    )
      artworkCache.delete(cacheKey);
  }
  async function operation<T>(task: () => Promise<T>): Promise<T> {
    if (state.busy) throw new ServiceError("operation_busy");
    refreshCoordinator.invalidate();
    state.busy = true;
    state.error = null;
    publish();
    try {
      return await task();
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      state.busy = false;
      publish();
    }
  }
  function load(): Promise<void> {
    if (loading) return loading;
    if (state.busy) return Promise.reject(new ServiceError("operation_busy"));
    refreshCoordinator.invalidate();
    state.busy = true;
    const request = Promise.resolve().then(async () => {
      try {
        const saved = await chrome.storage.local.get("installation");
        const value = saved.installation
          ? validateInstall(saved.installation as InstallState)
          : null;
        state = {
          installation: value ? { ...value } : null,
          connections: null,
          runtime: null,
          verified: false,
          fresh: false,
          busy: true,
          error: null,
        };
        publish();
        if (!value?.origin)
          await persistentArtwork.reconcile(
            null,
            [],
            () => !disposed && !state.installation?.origin,
          );
        if (
          value?.origin &&
          (await chrome.permissions.contains({
            origins: [value.origin + "/*"],
          }))
        )
          await refreshNow();
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        state.busy = false;
        publish();
      }
    });
    loading = request;
    void request
      .finally(() => {
        if (loading === request) loading = undefined;
      })
      .catch(() => {});
    return request;
  }
  async function cloudAccounts(token: string): Promise<EmilAccount[]> {
    return operation(async () => {
      cloudClient = undefined;
      accounts = [];
      accountDomains.clear();
      await permission("https://api.cloudflare.com");
      const client = new Cloudflare(token.trim());
      const result = await client.accounts();
      let nextAccount = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, result.length) }, async () => {
          while (nextAccount < result.length) {
            const account = result[nextAccount++];
            try {
              accountDomains.set(account.id, {
                domain: await client.subdomain(account.id),
              });
            } catch (error) {
              // One inaccessible account must not block a different valid choice.
              // Cache only local diagnostics, never arbitrary upstream messages.
              const safeError =
                error instanceof CloudflareError
                  ? new CloudflareError(
                      error.code,
                      error.status,
                      error.errorCodes,
                    )
                  : error instanceof Error &&
                      error.message === missingWorkersSubdomain
                    ? Error(missingWorkersSubdomain)
                    : new TypeError();
              accountDomains.set(account.id, { error: safeError });
            }
          }
        }),
      );
      cloudClient = client;
      accounts = result;
      return result.map((account) => ({ ...account }));
    });
  }
  async function deploy(token: string, account: string): Promise<void> {
    return operation(async () => {
      if (
        token.trim() ||
        !cloudClient ||
        !accounts.some((item) => item.id === account)
      )
        throw new ServiceError("cloud_token");
      const prepared = accountDomains.get(account);
      if (!prepared) throw new ServiceError("cloud_token");
      if ("error" in prepared) throw prepared.error;
      const original = state.installation
        ? { ...validateInstall(state.installation) }
        : null;
      if (original && original.account !== account)
        throw new ServiceError("install_conflict");
      const hex = (length: number) =>
        Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      const candidate: InstallState = original ?? {
        account,
        name: "ams-" + hex(12),
        marker: hex(16),
        key: hex(32),
      };
      const expectedOrigin =
        "https://" + candidate.name + "." + prepared.domain + ".workers.dev";
      if (candidate.origin && candidate.origin !== expectedOrigin)
        throw new ServiceError("deployment_origin_changed");
      // Begin the native request in the installation click's user gesture, before
      // awaiting a lock, storage read or network request. Grant only this Worker.
      await permission(["https://api.cloudflare.com", expectedOrigin]);
      await navigator.locks.request(
        "scrobbler-install",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new ServiceError("install_busy");
          const saved = await chrome.storage.local.get("installation");
          const latest = saved.installation
            ? validateInstall(saved.installation as InstallState)
            : null;
          if (
            !!latest !== !!original ||
            (latest &&
              original &&
              (
                [
                  "account",
                  "name",
                  "marker",
                  "key",
                  "namespace",
                  "origin",
                ] as const
              ).some((field) => latest[field] !== original[field]))
          )
            throw new ServiceError("install_conflict");
          if (!original) await save(candidate);
          const asset = await fetch(chrome.runtime.getURL("worker.bundle.txt"));
          if (!asset.ok) throw new ServiceError("missing_asset");
          await cloudClient!.install(
            candidate,
            await asset.text(),
            save,
            (message) => options.onProgress?.(message),
            expectedOrigin,
          );
          cloudClient = undefined;
          accounts = [];
          accountDomains.clear();
          // A user may revoke access while deployment is running. The normal
          // first install already granted this exact origin before any writes.
          if (
            !(await chrome.permissions.contains({
              origins: [installation().origin + "/*"],
            }))
          )
            throw new ServiceError("permission_denied");
          await refreshNow();
        },
      );
    });
  }
  async function connectApple(): Promise<void> {
    return operation(async () => {
      if (!state.verified) throw new ServiceError("connections_required");
      const { origin, key } = installation();
      await permission(["https://music.apple.com", origin]);
      const tabs = await chrome.tabs.query({
        url: "https://music.apple.com/*",
      });
      if (!tabs.length) throw new ServiceError("apple_tab_missing");
      if (tabs.length !== 1 || !tabs[0].id)
        throw new ServiceError("apple_tabs");
      await verifyHealth();
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: "MAIN",
        func: captureAppleCredentials,
      });
      const value = result[0]?.result;
      if (!value) throw new ServiceError("tokens_unavailable");
      if ("error" in value)
        throw new ServiceError(value.error || "tokens_unavailable");
      state.fresh = false;
      publish();
      try {
        await saveAppleConnection(origin, key, value.credentials);
      } finally {
        value.credentials.apple_dev_token = "";
        value.credentials.apple_user_token = "";
      }
      await refreshNow();
    });
  }
  async function updateBackend(token: string, account: string): Promise<void> {
    return operation(async () => {
      const current = installation();
      if (account !== current.account)
        throw new ServiceError("install_conflict");
      await permission(["https://api.cloudflare.com", current.origin]);
      if (token.trim()) {
        cloudClient = new Cloudflare(token.trim());
        accounts = await cloudClient.accounts();
      }
      if (!cloudClient || !accounts.some((item) => item.id === current.account))
        throw new ServiceError("cloud_token");
      // Confirm this page still manages the existing instance before uploading code.
      const beforeUpdate = await readConnections(true);
      await navigator.locks.request(
        "scrobbler-install",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new ServiceError("install_busy");
          const saved = await chrome.storage.local.get("installation");
          const latest = validateInstall(saved.installation as InstallState);
          if (
            latest.account !== current.account ||
            latest.name !== current.name ||
            latest.marker !== current.marker ||
            latest.key !== current.key ||
            latest.namespace !== current.namespace
          )
            throw new ServiceError("install_conflict");
          const asset = await fetch(chrome.runtime.getURL("worker.bundle.txt"));
          if (!asset.ok) throw new ServiceError("missing_asset");
          state.fresh = false;
          publish();
          await cloudClient!.update(latest, await asset.text(), (message) =>
            options.onProgress?.(message),
          );
          // Old missing-image responses and in-flight reads belong to the previous
          // deployment. Do not let them hide covers after the upload succeeds.
          artworkCache.clear();
          artworkPending.clear();
          artworkScopeToken = {};
          if (!state.verified) {
            const username = beforeUpdate.connections.lastfm.username;
            await persistentArtwork.reconcile(
              beforeUpdate.connections.lastfm.connected &&
                typeof username === "string" &&
                username.trim()
                ? { origin: current.origin, key: current.key, username }
                : null,
              [],
              () =>
                state.installation?.origin === current.origin &&
                state.installation?.key === current.key,
            );
          }
          await persistentArtwork.clear();
          cloudClient = undefined;
          accounts = [];
          accountDomains.clear();
          // Read back the complete target release before treating this upload as
          // active. The known previous release may still be served briefly.
          let releaseReady = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const currentRelease = await verifyHealth(true);
            releaseReady =
              currentRelease &&
              lastfmExtensionAuth &&
              appleSourceArtwork &&
              artworkDiagnostics &&
              workerdArtwork &&
              recordingDiagnostics;
            if (releaseReady) break;
            if (attempt < 2)
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
          }
          if (!releaseReady) throw new ServiceError("backend_update_pending");
          try {
            await refreshNow();
          } catch (error) {
            if (
              error instanceof ServiceError &&
              error.code === "backend_upgrade_required"
            ) {
              state.verified = false;
              throw new ServiceError("backend_update_pending");
            }
            throw error;
          }
        },
      );
    });
  }
  async function saveLastfmApplication(
    key: string,
    secret: string,
  ): Promise<void> {
    return operation(async () => {
      const api_key = key.trim();
      const shared_secret = secret.trim();
      if (
        !/^[a-f\d]{32}$/i.test(api_key) ||
        !/^[a-f\d]{32}$/i.test(shared_secret)
      )
        throw new ServiceError("invalid_application");
      await permission(installation().origin);
      await api("/api/v1/connections/lastfm/application", "PUT", {
        api_key,
        shared_secret,
      });
      await refreshNow();
    });
  }
  async function authorizeLastfm(): Promise<void> {
    return operation(async () => {
      const { origin, key } = installation();
      await permission(origin);
      closeLastfmAuthorization?.();
      closeLastfmAuthorization = undefined;
      const data = await api(
        "/api/v1/connections/lastfm/extension/start",
        "POST",
        {},
      );
      closeLastfmAuthorization = await openLastfmAuthorization(
        origin,
        data,
        async (result) => {
          if (
            state.installation?.origin !== origin ||
            state.installation.key !== key
          )
            return;
          try {
            await refreshNow();
            if (
              state.installation?.origin !== origin ||
              state.installation.key !== key
            )
              return;
            if (result !== "connected" && result !== "closed")
              throw new ServiceError(result);
            if (
              result === "connected" &&
              (!state.fresh || !state.connections?.lastfm.connected)
            )
              throw new ServiceError("lastfm_not_connected");
          } catch (error) {
            fail(error);
          }
        },
      );
    });
  }
  async function startRecording(confirmedUsername: string): Promise<void> {
    return operation(async () => {
      const model = deriveViewModel({
        installed: !!state.installation?.origin,
        verified: state.verified,
        busy: false,
        fresh: state.fresh,
        connections: state.connections,
        runtime: state.runtime,
      });
      if (
        !model.canStart ||
        !confirmedUsername ||
        confirmedUsername !== state.connections?.lastfm.username
      )
        throw new ServiceError("account_changed");
      await permission(installation().origin);
      const latest = (await api("/api/v1/connections")) as Connections;
      if (latest?.lastfm?.username !== confirmedUsername) {
        await refreshNow();
        throw new ServiceError("account_changed");
      }
      if (!latest?.apple?.connected || !latest?.lastfm?.connected) {
        await refreshNow();
        throw new ServiceError("connections_required");
      }
      await api("/api/v1/recording/start", "POST", {
        username: confirmedUsername,
      });
      await refreshNow();
    });
  }
  async function pauseRecording(): Promise<void> {
    return operation(async () => {
      const model = deriveViewModel({
        installed: !!state.installation?.origin,
        verified: state.verified,
        busy: false,
        fresh: state.fresh,
        connections: state.connections,
        runtime: state.runtime,
      });
      if (!model.canPause) throw new ServiceError("connections_required");
      await permission(installation().origin);
      await api("/api/v1/recording/pause", "POST", {});
      await refreshNow();
    });
  }
  async function copyInfo(kind: EmilCopyInfo): Promise<void> {
    try {
      const value = installation();
      await navigator.clipboard.writeText(
        kind === "key"
          ? value.key
          : kind === "callback"
            ? value.origin + "/api/v1/connections/lastfm/callback"
            : value.origin,
      );
      state.error = null;
      publish();
    } catch (error) {
      const failure =
        error instanceof ServiceError
          ? error
          : new ServiceError("clipboard_unavailable");
      fail(failure);
      throw failure;
    }
  }
  const ready = load();
  function dispose() {
    disposed = true;
    persistentArtwork.dispose();
    closeLastfmAuthorization?.(false);
    closeLastfmAuthorization = undefined;
    refreshCoordinator.invalidate();
  }
  return {
    ready,
    getSnapshot,
    load,
    refresh,
    cloudAccounts,
    deploy,
    updateBackend,
    connectApple,
    saveLastfmApplication,
    authorizeLastfm,
    startRecording,
    pauseRecording,
    copyInfo,
    getArtwork,
    getArtworkScope: () => artworkScopeToken,
    forgetArtwork,
    dispose,
  };
}
