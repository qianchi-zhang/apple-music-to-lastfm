import { afterEach, expect, it, vi } from "vitest";
import {
  createArtworkPersistence,
  artworkIdentityKey,
  ARTWORK_CACHE_KEY,
  ARTWORK_CACHE_TTL,
} from "../apps/browser-extension/src/emil-artwork-cache";

const scope = {
  origin: "https://original.example.workers.dev",
  key: "private-management-key",
  username: "Listener",
};
const first = artworkIdentityKey("track_id", "1001");
const second = artworkIdentityKey("track_id", "i.librarySong");
const cover = "https://is1-ssl.mzstatic.com/image/cover.jpg";
const newerCover = "https://is2-ssl.mzstatic.com/image/newer.jpg";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function browser() {
  const store: Record<string, any> = {};
  const get = vi.fn(async (key: string) => ({
    [key]: structuredClone(store[key]),
  }));
  const set = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(store, structuredClone(value));
  });
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: vi.fn(
        (_name: string, _options: unknown, task: () => Promise<unknown>) => {
          const request = queue.then(task);
          queue = request.then(
            () => undefined,
            () => undefined,
          );
          return request;
        },
      ),
    },
  });
  vi.stubGlobal("chrome", { storage: { local: { get, set } } });
  return { store, get, set, document: () => store[ARTWORK_CACHE_KEY] };
}

it("restores safe URL metadata across instances using only a hashed account scope", async () => {
  const h = browser();
  const cache = createArtworkPersistence();
  await cache.reconcile(scope, [first], () => true);
  await cache.put(first, cover, () => true);
  cache.dispose();
  const restored = await createArtworkPersistence().reconcile(
    scope,
    [first],
    () => true,
  );
  expect(restored).toEqual([
    { identity: first, url: cover, expires: expect.any(Number) },
  ]);
  expect(h.document().scope).toMatch(/^[a-f0-9]{64}$/);
  const saved = JSON.stringify(h.document());
  expect(saved).not.toContain(scope.key);
  expect(saved).not.toContain(scope.origin);
  expect(saved).not.toContain(scope.username);
  expect(saved).not.toContain("data:image");
});

it("merges concurrent page writes and immediately removes covers outside the current ten records", async () => {
  const h = browser();
  const ids = Array.from({ length: 10 }, (_, index) =>
    artworkIdentityKey("track_id", String(1001 + index)),
  );
  const a = createArtworkPersistence(),
    b = createArtworkPersistence();
  await a.reconcile(scope, ids, () => true);
  await b.reconcile(scope, ids, () => true);
  await Promise.all(
    ids.map((id, index) => (index % 2 ? a : b).put(id, cover, () => true)),
  );
  expect(h.document().entries).toHaveLength(10);
  const restored = await b.reconcile(scope, [second], () => true);
  expect(restored).toEqual([]);
  expect(h.document().entries).toEqual([]);
  await a.put(ids[0], newerCover, () => true);
  expect(h.document().entries).toEqual([]);
});

it.each(["origin", "key", "username"] as const)(
  "separates changes to %s and rejects an old page's delayed write",
  async (field) => {
    const h = browser();
    const oldPage = createArtworkPersistence();
    await oldPage.reconcile(scope, [first], () => true);
    await oldPage.put(first, cover, () => true);
    const previousHash = h.document().scope;
    const nextPage = createArtworkPersistence();
    await expect(
      nextPage.reconcile(
        { ...scope, [field]: scope[field] + "-different" },
        [first],
        () => true,
      ),
    ).resolves.toEqual([]);
    expect(h.document().scope).not.toBe(previousHash);
    await oldPage.put(first, cover, () => true);
    expect(h.document().entries).toEqual([]);
    await nextPage.put(first, newerCover, () => true);
    await oldPage.forget(first, newerCover, () => true);
    expect(h.document().entries[0].url).toBe(newerCover);
  },
);

it("writes a logout tombstone even when the old page has no successful cover yet", async () => {
  const h = browser();
  const oldPage = createArtworkPersistence();
  await oldPage.reconcile(scope, [first], () => true);
  await createArtworkPersistence().reconcile(null, [], () => true);
  await oldPage.put(first, cover, () => true);
  expect(h.document()).toMatchObject({ scope: null, visible: [], entries: [] });
});

it("expires successful URL metadata after seven days", async () => {
  browser();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const cache = createArtworkPersistence();
  await cache.reconcile(scope, [first], () => true);
  await cache.put(first, cover, () => true);
  now += ARTWORK_CACHE_TTL - 1;
  await expect(
    createArtworkPersistence().reconcile(scope, [first], () => true),
  ).resolves.toHaveLength(1);
  now += 2;
  await expect(
    createArtworkPersistence().reconcile(scope, [first], () => true),
  ).resolves.toEqual([]);
});

it.each([
  "http://is1-ssl.mzstatic.com/x.jpg",
  "https://is1-ssl.mzstatic.com.evil.test/x.jpg",
  "https://user:pass@is1-ssl.mzstatic.com/x.jpg",
  "assets/album-preview-bad-boy.jpg",
  "data:image/png;base64,eA==",
])("does not persist or restore an unsafe/non-Apple URL %s", async (url) => {
  const h = browser();
  const cache = createArtworkPersistence();
  await cache.reconcile(scope, [first], () => true);
  await cache.put(first, url, () => true);
  expect(h.document().entries).toEqual([]);
  h.document().entries.push({
    identity: first,
    url,
    expires: Date.now() + 10000,
  });
  await expect(
    createArtworkPersistence().reconcile(scope, [first], () => true),
  ).resolves.toEqual([]);
  expect(h.document().entries).toEqual([]);
});

it("only removes the expected failed URL and clears all entries after a backend update", async () => {
  const h = browser();
  const cache = createArtworkPersistence();
  await cache.reconcile(scope, [first], () => true);
  await cache.put(first, cover, () => true);
  await cache.put(first, newerCover, () => true);
  await cache.forget(first, cover, () => true);
  expect(h.document().entries[0].url).toBe(newerCover);
  await cache.forget(first, newerCover, () => true);
  expect(h.document().entries).toEqual([]);
  await cache.put(first, cover, () => true);
  await cache.clear();
  expect(h.document().entries).toEqual([]);
});

it.each(["forget-first", "hydrate-first"] as const)(
  "does not revive a failed URL during same-scope hydration (%s)",
  async (order) => {
    const h = browser();
    const cache = createArtworkPersistence();
    await cache.reconcile(scope, [first], () => true);
    await cache.put(first, cover, () => true);
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.get.mockImplementationOnce(async (key) => {
      started();
      await delayed;
      return { [key]: structuredClone(h.store[key]) };
    });
    const firstOperation =
      order === "forget-first"
        ? cache.forget(first, cover, () => true)
        : cache.reconcile(scope, [first], () => true);
    await began;
    const secondOperation =
      order === "forget-first"
        ? cache.reconcile(scope, [first], () => true)
        : cache.forget(first, cover, () => true);
    release();
    await Promise.all([firstOperation, secondOperation]);
    expect(h.document().entries).toEqual([]);
    await expect(cache.reconcile(scope, [first], () => true)).resolves.toEqual(
      [],
    );
  },
);

it("treats browser storage failure as an optional cache miss", async () => {
  const h = browser();
  h.get.mockRejectedValueOnce(Error("storage unavailable"));
  const cache = createArtworkPersistence();
  await expect(cache.reconcile(scope, [first], () => true)).resolves.toEqual(
    [],
  );
  await expect(cache.put(first, cover, () => true)).resolves.toBeUndefined();
  await cache.reconcile(scope, [first], () => true);
  h.set.mockRejectedValueOnce(Error("quota exceeded"));
  await expect(cache.put(first, cover, () => true)).resolves.toBeUndefined();
});
