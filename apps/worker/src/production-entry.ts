/** Account/setup adapter around the exact pinned 0.3.111 algorithm. */
import {
  ScrobbleCoordinator as Algorithm,
  loadLedger,
  saveLedger,
  fetchRecentlyPlayed,
} from "../production/runtime.generated.js";
import {
  LastfmAuthorization,
  lastfmExtensionResultPage,
  lastfmExtensionRoutes,
} from "./lastfm-connection";
import { CoordinatedKvStore } from "../../../packages/storage/src/index";
import { systemClock } from "../../../packages/contracts/src/index";
import { parseAppleCredentials } from "../../../packages/contracts/src/apple-credentials";
import {
  artworkLookup,
  isAppleTrackId,
  type ArtworkLookup,
} from "../../../packages/contracts/src/artwork-record";
import type { AppleCredentials } from "../../../packages/contracts/src/index";
import {
  API_BASE,
  SPOOFED_HEADERS,
} from "../../../packages/core/src/constants";
import {
  fingerprint,
  type LastfmApp,
  type LastfmConnection,
} from "../../../packages/providers/src/lastfm-auth";
import { setupCookie, validSetupSession } from "./setup-session";
import { extensionHomePage } from "./extension-home";
import { deploymentInfo } from "./deployment";
import type { Env } from "./index";
import { json } from "./application";
import {
  ledgerRecordingIssue,
  queueAccountIssue,
  sameLastfmAccount,
} from "./recording-issue";

const recentRecordLimit = 10;
const artworkCacheLimit = 10;
const artworkCacheMs = 30 * 60 * 1000;
const artworkMissCacheMs = 60 * 1000;

type ArtworkStatus =
  | "ok"
  | "invalid_id"
  | "scope_not_found"
  | "apple_not_connected"
  | "apple_http_error"
  | "invalid_response"
  | "response_id_mismatch"
  | "artwork_missing"
  | "artwork_url_rejected"
  | "timeout"
  | "network_error"
  | "scope_changed"
  | "apple_connection_changed"
  | "resource_changed";
type ArtworkStage =
  | "validation"
  | "scope"
  | "credentials"
  | "public_lookup"
  | "storefront"
  | "catalog"
  | "library";
interface ArtworkResult {
  artwork_url: string | null;
  artwork_status: ArtworkStatus;
  stage: ArtworkStage;
  apple_http_status?: number;
  lookup_kind?: ArtworkLookup["kind"];
  resource_kind?: "catalog" | "library";
}

function artworkScope(record: unknown): string | null {
  const lookup = artworkLookup(record);
  return lookup ? lookup.kind + ":" + lookup.id : null;
}

function originalArtworkId(ledger: any, lookup: ArtworkLookup): string {
  if (lookup.kind === "catalog_id") return lookup.id;
  const recent = Array.isArray(ledger.previous_recent)
    ? ledger.previous_recent
    : [];
  const source =
    recent.find((item: any) => item?.id === lookup.id) ??
    recent.find((item: any) => String(item?.catalog_id ?? "") === lookup.id);
  return isAppleTrackId(source?.id) ? source.id : lookup.id;
}

function appleArtworkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const url = new URL(
      value.replaceAll("{w}", "600").replaceAll("{h}", "600"),
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(
        url.hostname === "mzstatic.com" ||
        url.hostname.endsWith(".mzstatic.com")
      ) ||
      /[{}]/.test(url.href)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function publicAppleArtwork(
  id: string,
  signal: AbortSignal,
): Promise<ArtworkResult> {
  const result: ArtworkResult = {
    artwork_url: null,
    artwork_status: "network_error",
    stage: "public_lookup",
    resource_kind: "catalog",
  };
  try {
    // This public ID lookup must never receive account or management credentials.
    const response = await fetch(
      `https://itunes.apple.com/lookup?id=${id}&entity=song`,
      {
        signal,
        redirect: "manual",
      },
    );
    result.apple_http_status = response.status;
    if (!response.ok) {
      result.artwork_status = "apple_http_error";
      return result;
    }
    result.artwork_status = "invalid_response";
    const data = (await response.json()) as any;
    if (!Array.isArray(data?.results)) return result;
    const song = data.results.find(
      (item: any) =>
        item?.wrapperType === "track" &&
        item.kind === "song" &&
        String(item.trackId) === id,
    );
    if (!song) {
      result.artwork_status = data.results.length
        ? "response_id_mismatch"
        : "artwork_missing";
      return result;
    }
    const raw = song.artworkUrl100;
    if (raw === undefined || raw === null || raw === "") {
      result.artwork_status = "artwork_missing";
      return result;
    }
    const safe = appleArtworkUrl(raw);
    if (!safe) {
      result.artwork_status = "artwork_url_rejected";
      return result;
    }
    const artwork = new URL(safe);
    artwork.pathname = artwork.pathname.replace(
      /\/\d+x\d+bb(?=[.-][^/]+$)/,
      "/600x600bb",
    );
    result.artwork_url = artwork.href;
    result.artwork_status = "ok";
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name))
    )
      result.artwork_status = "timeout";
  }
  return result;
}

export class ScrobbleCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private store: CoordinatedKvStore;
  private lastfm: LastfmAuthorization;
  private algorithm: Algorithm;
  private runtime: any;
  private kv: any;
  private artworkConnection?: AppleCredentials;
  private artworkStorefront?: { id: string; expires: number };
  private artworkCache = new Map<
    string,
    { result: ArtworkResult; expires: number; resourceId: string }
  >();
  private artworkScopes = new Map<string, object>();
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.store = new CoordinatedKvStore(env.ASCROBBLE_STATE, state.storage);
    this.lastfm = new LastfmAuthorization(
      this.store,
      systemClock,
      env,
      undefined,
      async (connection, previous) => {
        const owner = await this.store.get<string>("extension-queue-owner:v1");
        const previousOwner = owner ?? previous?.username;
        if (
          previousOwner &&
          !sameLastfmAccount(previousOwner, connection.username)
        ) {
          // Pause before saving a different account. The frozen ledger and its
          // pending queue stay intact until the original account reconnects.
          await this.store.put("extension-enabled:v1", false);
          await this.state.storage.deleteAlarm();
          const ledger = await loadLedger(this.kv);
          if (!owner)
            await this.store.put("extension-queue-owner:v1", previousOwner);
          await this.rememberRecordOwners(ledger, previousOwner);
          this.artworkScopes.clear();
          this.artworkCache.clear();
        }
      },
    );
    this.kv = {
      get: async (key: string, type?: string) => {
        let value =
          key === "ledger:v1"
            ? await state.storage.get<string>("production-ledger:v1")
            : undefined;
        if (value === undefined)
          value = (await env.ASCROBBLE_STATE.get(key)) ?? undefined;
        return value === undefined
          ? null
          : type === "json"
            ? JSON.parse(value)
            : value;
      },
      put: async (key: string, value: string, options?: any) => {
        if (key === "ledger:v1")
          await state.storage.put("production-ledger:v1", value);
        if (key === "apple_dev_token") {
          const pair = await this.store.get<any>("apple-connection:v1");
          if (pair)
            await this.store.put("apple-connection:v1", {
              ...pair,
              apple_dev_token: value,
            });
        }
        await env.ASCROBBLE_STATE.put(key, value, options);
      },
    };
    this.runtime = { ...env, ASCROBBLE_STATE: this.kv };
    // Original constructor arms Alarm. Disable that bootstrap; adapter owns opt-in scheduling.
    const storage = new Proxy(state.storage, {
      get: (target, key) =>
        key === "setAlarm"
          ? async () => {}
          : typeof Reflect.get(target, key) === "function"
            ? Reflect.get(target, key).bind(target)
            : Reflect.get(target, key),
    });
    this.algorithm = new Algorithm(
      {
        storage,
        blockConcurrencyWhile: (task: () => Promise<void>) =>
          state.blockConcurrencyWhile(task),
      },
      this.runtime,
    );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.catch(() => {}).then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
  private async credentials() {
    const apple = await this.store.get<{
      apple_dev_token: string;
      apple_user_token: string;
    }>("apple-connection:v1");
    const app = await this.store.get<LastfmApp>("lastfm-app:v1"),
      c = await this.store.get<LastfmConnection>("lastfm-connection:v1");
    if (!apple || !app || !c || c.app_fingerprint !== (await fingerprint(app)))
      throw Error("connections_required");
    const ledger = await loadLedger(this.kv);
    const owner = await this.store.get<string>("extension-queue-owner:v1");
    if (queueAccountIssue(ledger, owner, c.username))
      throw Error("queue_account_changed");
    if (owner && !sameLastfmAccount(owner, c.username))
      await this.rememberRecordOwners(ledger, owner);
    await this.store.put("extension-queue-owner:v1", c.username);
    Object.assign(this.runtime, {
      LASTFM_API_KEY: app.api_key,
      LASTFM_SHARED_SECRET: app.shared_secret,
      LASTFM_SESSION_KEY: c.session_key,
    });
    // Credentials come from the atomic connection object, not stale KV mirrors.
    const original = this.kv.get;
    if (!this.runtime.__atomicApple) {
      this.kv.get = async (key: string, type?: string) => {
        if (key === "apple_dev_token" || key === "apple_user_token") {
          const pair = await this.store.get<any>("apple-connection:v1");
          return pair?.[key] ?? null;
        }
        return original(key, type);
      };
      this.runtime.__atomicApple = true;
    }
    return { apple, username: c.username };
  }
  private async recordIdentity(record: any): Promise<string> {
    const identity = JSON.stringify([
      record?.track_id,
      record?.catalog_id,
      record?.timestamp_iso,
      record?.track,
      record?.artist,
      record?.album,
    ]);
    // Keep the bounded ownership index small even when titles are very long.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(identity),
    );
    return Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }
  private async rememberRecordOwners(ledger: any, owner: string) {
    const previous = await this.store.get<Array<[string, string]>>(
      "extension-record-owners:v1",
    );
    const known = new Map(previous ?? []);
    const records = (ledger.recent_scrobbles ?? []).slice(0, 1000);
    await this.store.put(
      "extension-record-owners:v1",
      await Promise.all(
        records.map(async (record: any) => {
          const key = await this.recordIdentity(record);
          return [key, known.get(key) ?? owner];
        }),
      ),
    );
  }
  private async currentRecords(ledger: any): Promise<any[]> {
    const [connection, owner, entries] = await Promise.all([
      this.store.get<LastfmConnection>("lastfm-connection:v1"),
      this.store.get<string>("extension-queue-owner:v1"),
      this.store.get<Array<[string, string]>>("extension-record-owners:v1"),
    ]);
    let records: any[];
    if (!entries?.length || !connection) {
      records =
        owner && connection && !sameLastfmAccount(owner, connection.username)
          ? []
          : (ledger.recent_scrobbles ?? []).slice(0, recentRecordLimit);
    } else {
      const owners = new Map(entries);
      records = [];
      for (const record of (ledger.recent_scrobbles ?? []).slice(0, 1000)) {
        const recordOwner =
          owners.get(await this.recordIdentity(record)) ?? owner;
        if (
          !recordOwner ||
          sameLastfmAccount(recordOwner, connection.username)
        ) {
          records.push(record);
          if (records.length === recentRecordLimit) break;
        }
      }
    }
    const ids = new Set<string>(
      records
        .map(artworkScope)
        .filter((key: string | null): key is string => !!key),
    );
    const now = Date.now();
    for (const id of this.artworkScopes.keys())
      if (!ids.has(id)) this.artworkScopes.delete(id);
    for (const id of ids)
      if (!this.artworkScopes.has(id)) this.artworkScopes.set(id, {});
    for (const [id, cached] of this.artworkCache)
      if (!ids.has(id) || cached.expires <= now) this.artworkCache.delete(id);
    return records;
  }
  private async status() {
    // Query must not invoke the production /status stale-poll fallback.
    const ledger = await loadLedger(this.kv),
      enabled =
        (await this.store.get<boolean>("extension-enabled:v1")) === true,
      alarm = await this.state.storage.getAlarm();
    const records = await this.currentRecords(ledger);
    const [connection, owner, appleVerifiedAt] = await Promise.all([
      this.store.get<LastfmConnection>("lastfm-connection:v1"),
      this.store.get<string>("extension-queue-owner:v1"),
      this.store.get<string>("extension-apple-verified-at:v1"),
    ]);
    const issue =
      queueAccountIssue(ledger, owner, connection?.username) ??
      ledgerRecordingIssue(ledger, {
        apple: appleVerifiedAt,
        lastfm: connection?.connected_at,
      });
    return json({
      enabled,
      recording_issue: issue,
      algorithm_version: "0.3.111",
      algorithm_sha256:
        "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
      last_run_iso: ledger.last_run_iso ?? null,
      next_run_ms: enabled ? alarm : null,
      alarm_ms: alarm,
      stats: ledger.stats,
      pending_identity: ledger.pending_enrichments?.length ?? 0,
      pending_submission: ledger.pending_scrobbles?.length ?? 0,
      pending_identity_records: [],
      events: [],
      records: records.map((r: any, i: number) => ({
        ...r,
        event_id: r.timestamp_iso + ":" + i,
        status: "accepted",
        attempts: 1,
      })),
    });
  }
  private async artwork(url: URL): Promise<Response> {
    const catalogId = url.searchParams.get("catalog_id") ?? "";
    const trackId = url.searchParams.get("track_id") ?? "";
    const missing = (artwork_status: ArtworkStatus, stage: ArtworkStage) =>
      json({ artwork_url: null, artwork_status, stage });
    // Refresh the active ten-record scope even for a request whose ID is stale.
    const ledger = await loadLedger(this.kv);
    const records = await this.currentRecords(ledger);
    const catalogCount = url.searchParams.getAll("catalog_id").length;
    const trackCount = url.searchParams.getAll("track_id").length;
    if (!(
      (catalogCount === 1 &&
        trackCount === 0 &&
        /^[1-9]\d{0,19}$/.test(catalogId)) ||
      (trackCount === 1 && catalogCount === 0 && isAppleTrackId(trackId))
    ))
      return missing("invalid_id", "validation");

    // Only enrich records already visible in this account. Artwork is independent
    // of the frozen matching/submission algorithm and never writes business state.
    const record = records.find((candidate: any) =>
      trackCount
        ? candidate.track_id === trackId
        : String(candidate.catalog_id ?? "") === catalogId,
    );
    const lookup = artworkLookup(record);
    const scopeKey = artworkScope(record);
    if (!lookup || !scopeKey) return missing("scope_not_found", "scope");
    const resourceId = originalArtworkId(ledger, lookup);
    const publicId = /^[1-9]\d{0,19}$/.test(lookup.id) ? lookup.id : null;
    const scope = this.artworkScopes.get(scopeKey);
    if (!scope) return missing("scope_not_found", "scope");
    const apple = parseAppleCredentials(
      await this.store.get("apple-connection:v1"),
    );
    if (
      apple?.apple_dev_token !== this.artworkConnection?.apple_dev_token ||
      apple?.apple_user_token !== this.artworkConnection?.apple_user_token
    ) {
      this.artworkConnection = apple ?? undefined;
      this.artworkStorefront = undefined;
      this.artworkCache.clear();
    }
    if (!apple && !publicId)
      return missing("apple_not_connected", "credentials");
    const connection = this.artworkConnection;
    const now = Date.now();
    const cached = this.artworkCache.get(scopeKey);
    if (cached && cached.resourceId === resourceId)
      return this.artworkScopes.get(scopeKey) === scope
        ? json(cached.result)
        : missing("scope_changed", "scope");
    this.artworkCache.delete(scopeKey);

    const library = resourceId.startsWith("i.");
    const result: ArtworkResult = {
      artwork_url: null,
      artwork_status: "network_error",
      stage: library ? "library" : "storefront",
      lookup_kind: lookup.kind,
      resource_kind: library ? "library" : "catalog",
    };
    let signal: AbortSignal | undefined;
    try {
      // One deadline covers both reads; redirects must never forward credentials.
      signal = AbortSignal.timeout(5000);
      if (publicId) {
        Object.assign(result, await publicAppleArtwork(publicId, signal), {
          lookup_kind: lookup.kind,
        });
      }
      if (!result.artwork_url && apple && !signal.aborted) {
        result.stage = library ? "library" : "storefront";
        result.resource_kind = library ? "library" : "catalog";
        result.artwork_status = "network_error";
        delete result.apple_http_status;
        let endpoint = `${API_BASE}/me/library/songs/${encodeURIComponent(resourceId)}`;
        if (!library) {
          let storefront = this.artworkStorefront;
          if (!storefront || storefront.expires <= now) {
            const response = await fetch(`${API_BASE}/me/storefront`, {
              headers: {
                ...SPOOFED_HEADERS,
                Authorization: `Bearer ${apple.apple_dev_token}`,
                "Music-User-Token": apple.apple_user_token,
              },
              signal,
              redirect: "manual",
            });
            result.apple_http_status = response.status;
            if (!response.ok) {
              result.artwork_status = "apple_http_error";
              throw Error("artwork unavailable");
            }
            result.artwork_status = "invalid_response";
            const data = (await response.json()) as any;
            const id = data?.data?.[0]?.id;
            if (typeof id !== "string" || !/^[a-z]{2}$/i.test(id))
              throw Error("artwork unavailable");
            storefront = {
              id: id.toLowerCase(),
              expires: now + artworkCacheMs,
            };
            if (this.artworkConnection === connection)
              this.artworkStorefront = storefront;
          }
          endpoint = `${API_BASE}/catalog/${storefront.id}/songs/${resourceId}`;
        }
        result.stage = library ? "library" : "catalog";
        result.artwork_status = "network_error";
        delete result.apple_http_status;
        const response = await fetch(endpoint, {
          headers: {
            ...SPOOFED_HEADERS,
            Authorization: `Bearer ${apple.apple_dev_token}`,
            ...(library ? { "Music-User-Token": apple.apple_user_token } : {}),
          },
          signal,
          redirect: "manual",
        });
        result.apple_http_status = response.status;
        if (!response.ok) {
          result.artwork_status = "apple_http_error";
          throw Error("artwork unavailable");
        }
        result.artwork_status = "invalid_response";
        const data = (await response.json()) as any;
        if (!Array.isArray(data?.data)) throw Error("artwork unavailable");
        const song = data.data.find(
          (item: any) => String(item?.id) === resourceId,
        );
        if (!song) result.artwork_status = "response_id_mismatch";
        else {
          const rawArtwork = song.attributes?.artwork?.url;
          if (
            rawArtwork === undefined ||
            rawArtwork === null ||
            rawArtwork === ""
          )
            result.artwork_status = "artwork_missing";
          else {
            result.artwork_url = appleArtworkUrl(rawArtwork);
            result.artwork_status = result.artwork_url
              ? "ok"
              : "artwork_url_rejected";
          }
        }
      }
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name))
      )
        result.artwork_status = "timeout";
      // Cover art availability must not turn a healthy recording into an error.
    }
    // A cover request may finish after its song has left the ten-row view. Read
    // again before caching or returning it, and reject a scope invalidated meanwhile.
    const [latestLedger, latestAppleValue] = await Promise.all([
      loadLedger(this.kv),
      this.store.get("apple-connection:v1"),
    ]);
    const latestApple = parseAppleCredentials(latestAppleValue);
    await this.currentRecords(latestLedger);
    if (this.artworkScopes.get(scopeKey) !== scope)
      return missing("scope_changed", "scope");
    if (
      this.artworkConnection !== connection ||
      latestApple?.apple_dev_token !== apple?.apple_dev_token ||
      latestApple?.apple_user_token !== apple?.apple_user_token
    )
      return missing("apple_connection_changed", "credentials");
    if (originalArtworkId(latestLedger, lookup) !== resourceId)
      return missing("resource_changed", "scope");
    if (
      !this.artworkCache.has(scopeKey) &&
      this.artworkCache.size >= artworkCacheLimit
    )
      this.artworkCache.delete(this.artworkCache.keys().next().value!);
    this.artworkCache.set(scopeKey, {
      result,
      resourceId,
      expires:
        Date.now() + (result.artwork_url ? artworkCacheMs : artworkMissCacheMs),
    });
    return json(result);
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    // Artwork waits do not hold the queue used to pause or advance recording.
    if (url.pathname === "/api/v1/artwork" && request.method === "GET")
      return this.artwork(url);
    return this.serial(async () => {
      const path = url.pathname;
      if (path === "/api/v1/connections") return this.lastfm.status();
      if (path === "/api/v1/recording" && request.method === "GET")
        return this.status();
      if (
        path === "/api/v1/connections/lastfm/application" &&
        request.method === "PUT"
      )
        return this.lastfm.configure(request);
      if (
        path === "/api/v1/connections/lastfm/start" &&
        request.method === "POST"
      )
        return this.lastfm.start(request);
      if (path === lastfmExtensionRoutes.start && request.method === "POST")
        return this.lastfm.start(request, "extension");
      if (path === lastfmExtensionRoutes.authorize && request.method === "GET")
        return this.lastfm.authorizeExtension(request);
      if (
        path === "/api/v1/connections/lastfm/callback" &&
        request.method === "GET"
      )
        return this.lastfm.callback(request);
      if (path === "/api/v1/connections/apple" && request.method === "POST") {
        let value;
        try {
          const text = await request.text();
          if (text.length > 40000) throw Error();
          value = parseAppleCredentials(JSON.parse(text));
        } catch {
          return json({ error: "invalid_credentials" }, 400);
        }
        if (!value) return json({ error: "invalid_credentials" }, 400);
        try {
          await fetchRecentlyPlayed(
            value.apple_dev_token,
            value.apple_user_token,
          );
        } catch {
          return json({ error: "apple_rejected" }, 400);
        }
        await this.store.put("apple-connection:v1", value);
        await this.store.put(
          "extension-apple-verified-at:v1",
          new Date().toISOString(),
        );
        return json({ ok: true, connected: true, verified: true });
      }
      if (path === "/api/v1/recording/pause" && request.method === "POST") {
        await this.store.put("extension-enabled:v1", false);
        await this.state.storage.deleteAlarm();
        return this.status();
      }
      if (path === "/api/v1/recording/start" && request.method === "POST") {
        let body: any;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid_request" }, 400);
        }
        try {
          const { apple, username } = await this.credentials();
          if (
            typeof body.username !== "string" ||
            !sameLastfmAccount(body.username, username)
          )
            return json({ error: "account_changed" }, 409);
          if (
            (await this.store.get<boolean>("extension-enabled:v1")) !== true
          ) {
            const current = await fetchRecentlyPlayed(
              apple.apple_dev_token,
              apple.apple_user_token,
            );
            const ledger = await loadLedger(this.kv);
            Object.assign(ledger, {
              previous_recent: current,
              history_source_version: 2,
              stationary_idle: false,
              handled_count: 1,
              position0_elapsed_sec: 0,
              top_track_id: undefined,
              top_track_play_count: undefined,
              last_run_iso: new Date().toISOString(),
            });
            await saveLedger(this.kv, ledger);
            await this.state.storage.setAlarm(Date.now() + 180000);
            await this.store.put("extension-enabled:v1", true);
          }
          return this.status();
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "queue_account_changed"
          ) {
            await this.store.put("extension-enabled:v1", false);
            await this.state.storage.deleteAlarm();
            const ledger = await loadLedger(this.kv);
            const owner = await this.store.get<string>(
              "extension-queue-owner:v1",
            );
            const connection = await this.store.get<LastfmConnection>(
              "lastfm-connection:v1",
            );
            return json(
              {
                error: "queue_account_changed",
                recording_issue: queueAccountIssue(
                  ledger,
                  owner,
                  connection?.username,
                ),
              },
              409,
            );
          }
          return json({ error: "connections_required" }, 409);
        }
      }
      return json({ error: "not found" }, 404);
    });
  }
  async alarm() {
    return this.serial(async () => {
      if ((await this.store.get<boolean>("extension-enabled:v1")) !== true) {
        await this.state.storage.deleteAlarm();
        return;
      }
      try {
        await this.credentials();
        await this.algorithm.enqueue(false, "extension_alarm");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "queue_account_changed"
        ) {
          await this.store.put("extension-enabled:v1", false);
          await this.state.storage.deleteAlarm();
          return;
        }
        throw error;
      } finally {
        if ((await this.store.get<boolean>("extension-enabled:v1")) === true)
          await this.state.storage.setAlarm(Date.now() + 180000);
      }
    });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname,
      origin = new URL(request.url).origin;
    if ((path === "/" || path === "/setup") && request.method === "GET")
      return extensionHomePage();
    if (path === lastfmExtensionRoutes.result && request.method === "GET")
      return lastfmExtensionResultPage(request);
    if (path === "/health" && request.method === "GET")
      return json({
        ok: true,
        service: "apple-music-scrobbler",
        version: "0.3.111",
        algorithm_sha256:
          "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
        capabilities: {
          lastfm_extension_auth: true,
          apple_source_artwork: true,
          apple_artwork_diagnostics: true,
          apple_artwork_runtime: "workerd-manual-v1",
          recording_diagnostics: true,
        },
      });
    if (!env.STATUS_AUTH_KEY)
      return json({ error: "management key not configured" }, 503);
    const header =
      request.headers.get("x-ascrobble-auth") === env.STATUS_AUTH_KEY;
    if (path === "/api/v1/setup/session" && request.method === "POST") {
      if (!header) return json({ error: "unauthorized" }, 401);
      if (
        request.headers.get("Origin") !== origin ||
        !origin.startsWith("https://")
      )
        return json({ error: "invalid_origin" }, 403);
      const res = json({ ok: true });
      res.headers.set("Set-Cookie", await setupCookie(env.STATUS_AUTH_KEY));
      return res;
    }
    const callback =
      (path === "/api/v1/connections/lastfm/callback" ||
        path === lastfmExtensionRoutes.authorize) &&
      request.method === "GET";
    const scoped = [
      "/api/v1/deployment",
      "/api/v1/connections",
      "/api/v1/recording",
      "/api/v1/artwork",
      "/api/v1/recording/start",
      "/api/v1/recording/pause",
      "/api/v1/connections/lastfm/application",
      "/api/v1/connections/lastfm/start",
    ].includes(path);
    const session =
      scoped &&
      (await validSetupSession(request, env.STATUS_AUTH_KEY)) &&
      (request.method === "GET" || request.headers.get("Origin") === origin);
    if (!header && !session && !callback)
      return json({ error: "unauthorized" }, 401);
    if (path === "/api/v1/deployment" && request.method === "GET")
      return json(deploymentInfo(env));
    if (!env.SCROBBLE_COORDINATOR)
      return json({ error: "coordinator binding required" }, 503);
    return env.SCROBBLE_COORDINATOR.get(
      env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator"),
    ).fetch(request);
  },
  async scheduled() {}, // Only the opt-in Alarm runs this adapter; no status-triggered polling.
};
