import { safeAlbumArtworkUrl } from "./emil-artwork";

export const ARTWORK_CACHE_KEY = "artwork-url-cache:v1";
export const ARTWORK_CACHE_LOCK = "scrobbler-artwork-cache";
export const ARTWORK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const limit = 10;

export interface ArtworkCacheScope {
  origin: string;
  key: string;
  username: string;
}
export interface SavedArtwork {
  identity: string;
  url: string;
  expires: number;
}
interface CacheDocument {
  version: 1;
  scope: string | null;
  revision: string;
  visible: string[];
  entries: SavedArtwork[];
}

export function artworkIdentityKey(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

function safeIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 180) return false;
  try {
    const [kind, id, extra] = JSON.parse(value);
    return (
      extra === undefined &&
      (kind === "track_id" || kind === "catalog_id") &&
      typeof id === "string" &&
      (/^[1-9]\d{0,19}$/.test(id) ||
        (kind === "track_id" && /^i\.[A-Za-z0-9_-]{1,126}$/.test(id)))
    );
  } catch {
    return false;
  }
}
function safePersistentUrl(value: unknown): string | null {
  const url = safeAlbumArtworkUrl(value);
  return url?.startsWith("https://") ? url : null;
}
function readDocument(value: unknown): CacheDocument | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<CacheDocument>;
  if (
    input.version !== 1 ||
    !(
      input.scope === null ||
      (typeof input.scope === "string" && /^[a-f0-9]{64}$/.test(input.scope))
    ) ||
    typeof input.revision !== "string" ||
    input.revision.length > 80 ||
    !Array.isArray(input.visible) ||
    !Array.isArray(input.entries)
  )
    return null;
  const visible = Array.from(
    new Set(input.visible.slice(0, 20).filter(safeIdentity)),
  ).slice(0, 20);
  const entries: SavedArtwork[] = [];
  for (const entry of input.entries.slice(0, limit)) {
    if (!entry || typeof entry !== "object") continue;
    const url = safePersistentUrl(entry.url);
    if (
      !safeIdentity(entry.identity) ||
      !visible.includes(entry.identity) ||
      !url ||
      typeof entry.expires !== "number" ||
      !Number.isFinite(entry.expires) ||
      entry.expires <= Date.now() ||
      entry.expires > Date.now() + ARTWORK_CACHE_TTL ||
      entries.some((saved) => saved.identity === entry.identity)
    )
      continue;
    entries.push({ identity: entry.identity, url, expires: entry.expires });
    if (entries.length === limit) break;
  }
  return {
    version: 1,
    scope: input.scope,
    revision: input.revision,
    visible,
    entries,
  };
}
async function scopeHash(scope: ArtworkCacheScope): Promise<string> {
  const value = JSON.stringify([
    scope.origin,
    scope.key,
    scope.username.trim().toLowerCase(),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A single current-account cache. Locks and revisions reject obsolete tab writes. */
export function createArtworkPersistence() {
  let generation = 0;
  let current: CacheDocument | null = null;
  let lastContext: CacheDocument | null = null;
  let closed = false;
  const locked = async <T>(task: () => Promise<T>): Promise<T> =>
    await navigator.locks.request(ARTWORK_CACHE_LOCK, {}, task);
  const stored = async () => {
    const data = await chrome.storage.local.get(ARTWORK_CACHE_KEY);
    return {
      raw: data[ARTWORK_CACHE_KEY],
      document: readDocument(data[ARTWORK_CACHE_KEY]),
    };
  };
  const write = (document: CacheDocument) =>
    chrome.storage.local.set({ [ARTWORK_CACHE_KEY]: document });

  async function reconcile(
    scope: ArtworkCacheScope | null,
    identities: string[],
    allowed: () => boolean,
  ): Promise<SavedArtwork[]> {
    const revision = ++generation;
    current = null;
    try {
      return await locked(async () => {
        if (closed || revision !== generation || !allowed()) return [];
        const hash = scope ? await scopeHash(scope) : null;
        const { raw, document } = await stored();
        if (closed || revision !== generation || !allowed()) return [];
        const visible = scope
          ? Array.from(new Set(identities.filter(safeIdentity))).slice(0, 20)
          : [];
        const unchanged =
          document?.scope === hash &&
          JSON.stringify(document.visible) === JSON.stringify(visible);
        const next: CacheDocument = {
          version: 1,
          scope: hash,
          revision: unchanged ? document.revision : crypto.randomUUID(),
          visible,
          entries:
            document?.scope === hash
              ? document.entries.filter((entry) =>
                  visible.includes(entry.identity),
                )
              : [],
        };
        if (JSON.stringify(raw) !== JSON.stringify(next)) await write(next);
        if (closed || revision !== generation || !allowed()) return [];
        current = next;
        lastContext = next;
        return next.entries;
      });
    } catch {
      return [];
    }
  }

  async function put(
    identity: string,
    value: string,
    allowed: () => boolean,
  ): Promise<void> {
    const context = current;
    const revision = generation;
    const url = safePersistentUrl(value);
    if (!context?.scope || !context.visible.includes(identity) || !url) return;
    try {
      await locked(async () => {
        const { document } = await stored();
        if (
          revision !== generation ||
          current !== context ||
          !allowed() ||
          document?.scope !== context.scope ||
          document.revision !== context.revision ||
          !document.visible.includes(identity)
        )
          return;
        const next: CacheDocument = {
          ...document,
          entries: [
            { identity, url, expires: Date.now() + ARTWORK_CACHE_TTL },
            ...document.entries.filter((entry) => entry.identity !== identity),
          ].slice(0, limit),
        };
        await write(next);
      });
    } catch {
      // Storage is optional; the caller still returns its successful network URL.
    }
  }

  async function clear(): Promise<void> {
    const context = current;
    const revision = ++generation;
    current = null;
    if (!context) return;
    try {
      await locked(async () => {
        const { document } = await stored();
        if (
          revision !== generation ||
          document?.scope !== context.scope ||
          document.revision !== context.revision
        )
          return;
        const next = {
          ...document,
          revision: crypto.randomUUID(),
          entries: [],
        };
        await write(next);
        if (revision === generation) current = lastContext = next;
      });
    } catch {
      // A backend update must remain usable when browser storage is unavailable.
    }
  }

  async function forget(
    identity: string,
    expectedUrl: string,
    allowed: () => boolean,
  ): Promise<void> {
    // Same-account hydration may temporarily replace `current`. A failed URL
    // still belongs to the stored document revision, so it must not be revived.
    const context = current ?? lastContext;
    if (!context) return;
    try {
      await locked(async () => {
        const { document } = await stored();
        if (
          closed ||
          !allowed() ||
          document?.scope !== context.scope ||
          document.revision !== context.revision ||
          !document.entries.some(
            (entry) => entry.identity === identity && entry.url === expectedUrl,
          )
        )
          return;
        await write({
          ...document,
          entries: document.entries.filter(
            (entry) =>
              !(entry.identity === identity && entry.url === expectedUrl),
          ),
        });
      });
    } catch {
      // A failed image must not affect recording or connection state.
    }
  }
  return {
    reconcile,
    put,
    clear,
    forget,
    dispose: () => {
      generation++;
      closed = true;
      current = null;
      lastContext = null;
    },
  };
}
