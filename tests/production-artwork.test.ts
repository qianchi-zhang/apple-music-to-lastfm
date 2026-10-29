import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../apps/worker/src/index";
import { setupCookie } from "../apps/worker/src/setup-session";

const catalogId = "123456789";
const artworkTemplate =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/test/{w}x{h}bb.jpg";
const artworkUrl =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/test/600x600bb.jpg";
const publicSourceId = "220366030";
const publicSourceArtwork100 =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/c3/d0/e5/mzi.kdgffvqb.jpg/100x100bb.jpg";
const publicSourceArtwork600 = publicSourceArtwork100.replace(
  "100x100bb.jpg",
  "600x600bb.jpg",
);
const publicSourceResult = {
  resultCount: 1,
  results: [
    {
      wrapperType: "track",
      kind: "song",
      trackId: 220366030,
      artistName: "Provider metadata must not replace recorded artist",
      trackName: "Provider metadata must not replace recorded title",
      artworkUrl100: publicSourceArtwork100,
    },
  ],
};

async function setup(
  options: {
    records?: string[];
    rows?: Record<string, unknown>[];
    previous?: Record<string, unknown>[];
    connected?: boolean;
  } = {},
) {
  const data = new Map<string, unknown>();
  const kv = new Map<string, string>();
  let revision = 0;
  const setRows = (rows: Record<string, unknown>[]) => {
    data.set(
      "production-ledger:v1",
      JSON.stringify({
        recent_scrobbles: rows,
        previous_recent: options.previous ?? [],
        last_run_iso: new Date(
          Date.UTC(2026, 9, 25) + revision++ * 1000,
        ).toISOString(),
      }),
    );
  };
  const setRecords = (ids: string[]) =>
    setRows(
      ids.map((id) => ({
        catalog_id: id,
        track_id: "library-" + id,
        artist: "Fixture artist",
        track: "Fixture song",
        album: "Fixture album",
        timestamp_iso: "2026-10-25T01:00:00.000Z",
      })),
    );
  setRecords(options.records ?? [catalogId]);
  if (options.rows) setRows(options.rows);
  const setPrevious = (previous: Record<string, unknown>[]) => {
    const ledger = JSON.parse(data.get("production-ledger:v1") as string);
    ledger.previous_recent = previous;
    ledger.last_run_iso = new Date(
      Date.UTC(2026, 9, 25) + revision++ * 1000,
    ).toISOString();
    data.set("production-ledger:v1", JSON.stringify(ledger));
  };
  if (options.connected !== false)
    data.set("apple-connection:v1", {
      apple_dev_token: "fixture-developer-token",
      apple_user_token: "fixture-user-token",
    });
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    }),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => undefined),
    deleteAlarm: vi.fn(async () => undefined),
  };
  const env = {
    STATUS_AUTH_KEY: "fixture-management-key",
    ASCROBBLE_STATE: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    },
  } as unknown as Env;
  const { ScrobbleCoordinator, default: worker } =
    await import("../apps/worker/src/production-entry");
  const tasks: Promise<unknown>[] = [];
  const actor = new ScrobbleCoordinator(
    {
      storage,
      blockConcurrencyWhile(task: () => Promise<unknown>) {
        tasks.push(task());
      },
    } as any,
    env,
  );
  await Promise.all(tasks);
  const forward = vi.fn((request: Request) => actor.fetch(request));
  env.SCROBBLE_COORDINATOR = {
    idFromName: () => "fixture-actor",
    get: () => ({ fetch: forward }),
  } as unknown as DurableObjectNamespace;
  const upstream = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.music.apple.com")
        throw Error("Unexpected provider");
      if (url.pathname === "/v1/me/storefront")
        return Response.json({ data: [{ id: "tw" }] });
      const id = url.pathname.split("/").at(-1);
      return Response.json({
        data: [{ id, attributes: { artwork: { url: artworkTemplate } } }],
      });
    },
  );
  const publicUpstream = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ resultCount: 0, results: [] }),
  );
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).origin === "https://itunes.apple.com"
      ? publicUpstream(input, init)
      : upstream(input, init),
  );
  const request = (
    path: string,
    headers: Record<string, string> = {
      "x-ascrobble-auth": env.STATUS_AUTH_KEY,
    },
  ) =>
    worker.fetch(new Request("https://fixture.test" + path, { headers }), env);
  const artwork = (id = catalogId) =>
    request("/api/v1/artwork?catalog_id=" + encodeURIComponent(id));
  const trackArtwork = (id: string) =>
    request("/api/v1/artwork?track_id=" + encodeURIComponent(id));
  const expectNoWrites = () => {
    expect(storage.put).not.toHaveBeenCalled();
    expect(env.ASCROBBLE_STATE.put).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
  };
  return {
    actor,
    artwork,
    trackArtwork,
    request,
    data,
    setRecords,
    setRows,
    setPrevious,
    upstream,
    publicUpstream,
    forward,
    env,
    storage,
    expectNoWrites,
  };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

it("advertises source artwork support independently of the unchanged production algorithm identity", async () => {
  const x = await setup();
  const health = await x.request("/health", {});
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({
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
  expect(x.forward).not.toHaveBeenCalled();
  expect(x.upstream).not.toHaveBeenCalled();
  x.expectNoWrites();
});

it("requires the management header or existing scoped setup session before dispatch", async () => {
  const x = await setup();
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { "x-ascrobble-auth": "wrong" },
  ];
  for (const headers of rejectedHeaders) {
    expect(
      (await x.request("/api/v1/artwork?catalog_id=" + catalogId, headers))
        .status,
    ).toBe(401);
  }
  expect(
    (
      await x.request(
        "/api/v1/artwork?catalog_id=" +
          catalogId +
          "&key=" +
          x.env.STATUS_AUTH_KEY,
        {},
      )
    ).status,
  ).toBe(401);
  expect(x.forward).not.toHaveBeenCalled();
  expect(x.upstream).not.toHaveBeenCalled();
  const cookie = (await setupCookie(x.env.STATUS_AUTH_KEY)).split(";")[0];
  const response = await x.request("/api/v1/artwork?catalog_id=" + catalogId, {
    Cookie: cookie,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ artwork_url: artworkUrl });
  x.expectNoWrites();
});

it("looks up the exact existing catalog ID in the account storefront without exposing tokens or writing state", async () => {
  const x = await setup();
  const before = structuredClone([...x.data]);
  const response = await x.artwork();
  expect(await response.json()).toMatchObject({ artwork_url: artworkUrl });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(x.upstream.mock.calls.map(([url]) => String(url))).toEqual([
    "https://api.music.apple.com/v1/me/storefront",
    "https://api.music.apple.com/v1/catalog/tw/songs/" + catalogId,
  ]);
  const storefront = x.upstream.mock.calls[0][1]!;
  const catalog = x.upstream.mock.calls[1][1]!;
  expect(storefront.headers).toHaveProperty(
    "Music-User-Token",
    "fixture-user-token",
  );
  expect(catalog.headers).toHaveProperty(
    "Authorization",
    "Bearer fixture-developer-token",
  );
  expect(catalog.headers).not.toHaveProperty("Music-User-Token");
  expect(storefront.signal).toBeInstanceOf(AbortSignal);
  expect(catalog.signal).toBe(storefront.signal);
  expect(storefront.redirect).toBe("manual");
  expect(catalog.redirect).toBe("manual");
  expect([...x.data]).toEqual(before);
  x.expectNoWrites();
});

it("rejects IDs absent from the visible recent records and malformed queries without provider requests", async () => {
  const ids = Array.from({ length: 11 }, (_, index) => String(1000 + index));
  const x = await setup({ records: ids });
  for (const id of [
    "",
    "unknown",
    "123/456",
    "000123",
    "9".repeat(21),
    catalogId,
    ids[10],
  ]) {
    expect(await (await x.artwork(id)).json()).toMatchObject({
      artwork_url: null,
    });
  }
  expect(
    await (
      await x.request("/api/v1/artwork?catalog_id=1000&catalog_id=1001")
    ).json(),
  ).toMatchObject({ artwork_url: null });
  expect(x.upstream).not.toHaveBeenCalled();
  x.expectNoWrites();
});

it("returns only ten recent records without trimming the underlying ledger or requesting artwork", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => String(1000 + index));
  const x = await setup({ records: ids });
  const before = structuredClone([...x.data]);
  const status = (await (await x.request("/api/v1/recording")).json()) as any;
  expect(status.records.map((record: any) => record.catalog_id)).toEqual(
    ids.slice(0, 10),
  );
  expect(x.upstream).not.toHaveBeenCalled();
  expect([...x.data]).toEqual(before);
  expect(await (await x.artwork(ids[9])).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(await (await x.artwork(ids[10])).json()).toMatchObject({
    artwork_url: null,
  });
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.expectNoWrites();
});

it.each([
  "http://is1-ssl.mzstatic.com/cover.jpg",
  "https://mzstatic.com.evil.test/cover.jpg",
  "https://evil.test/cover.jpg",
  "https://fixture:secret@is1-ssl.mzstatic.com/cover.jpg",
  "https://is1-ssl.mzstatic.com:8443/cover.jpg",
  "data:image/png;base64,AAAA",
  "javascript:alert(1)",
  "not a URL",
])("omits unsafe artwork URL %s", async (url) => {
  const x = await setup();
  x.upstream
    .mockResolvedValueOnce(Response.json({ data: [{ id: "tw" }] }))
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: catalogId, attributes: { artwork: { url } } }],
      }),
    );
  expect(await (await x.artwork()).json()).toMatchObject({ artwork_url: null });
  x.expectNoWrites();
});

it.each([
  "no artwork",
  "wrong song",
  "HTTP error",
  "invalid JSON",
  "network failure",
  "invalid storefront",
])("returns neutral unavailable artwork for %s", async (kind) => {
  const x = await setup();
  x.upstream.mockImplementation(async (input) => {
    if (kind === "network failure")
      throw new DOMException("private provider failure", "AbortError");
    if (kind === "HTTP error")
      return new Response("private provider error", { status: 401 });
    if (kind === "invalid JSON") return new Response("not JSON");
    if (String(input).endsWith("/me/storefront"))
      return Response.json({
        data: [{ id: kind === "invalid storefront" ? "tw/evil" : "tw" }],
      });
    return Response.json({
      data: [
        {
          id: kind === "wrong song" ? "987654321" : catalogId,
          attributes:
            kind === "no artwork" ? {} : { artwork: { url: artworkTemplate } },
        },
      ],
    });
  });
  const response = await x.artwork();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ artwork_url: null });
  x.expectNoWrites();
});

it("does not query protected Apple endpoints when credentials are missing", async () => {
  const x = await setup({ connected: false });
  expect(await (await x.artwork()).json()).toMatchObject({ artwork_url: null });
  expect(x.upstream).not.toHaveBeenCalled();
  expect(x.publicUpstream).toHaveBeenCalledTimes(1);
  x.expectNoWrites();
});

it("caches successful artwork and storefront for a finite time, then reads them again", async () => {
  const x = await setup();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await x.artwork();
  await x.artwork();
  expect(x.upstream).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(now + 30 * 60 * 1000 + 1);
  await x.artwork();
  expect(x.upstream).toHaveBeenCalledTimes(4);
  x.expectNoWrites();
});

it("retries unavailable artwork after the short miss cache expires", async () => {
  const x = await setup();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  x.upstream.mockRejectedValueOnce(Error("temporary"));
  await x.artwork();
  await x.artwork();
  expect(x.upstream).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(now + 60001);
  expect(await (await x.artwork()).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(3);
  x.expectNoWrites();
});

it("invalidates cached artwork on Apple connection changes and still checks record membership on cache hits", async () => {
  const x = await setup();
  await x.artwork();
  x.data.set("apple-connection:v1", {
    apple_dev_token: "new-developer-token",
    apple_user_token: "new-user-token",
  });
  await x.artwork();
  expect(x.upstream).toHaveBeenCalledTimes(4);
  expect(x.upstream.mock.calls[2][1]?.headers).toHaveProperty(
    "Music-User-Token",
    "new-user-token",
  );
  x.setRecords([]);
  expect(await (await x.artwork()).json()).toMatchObject({ artwork_url: null });
  expect(x.upstream).toHaveBeenCalledTimes(4);
  x.setRecords([catalogId]);
  expect(await (await x.artwork()).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(5);
  x.expectNoWrites();
});

it("bounds the cache to the ten visible recent records as they change", async () => {
  const ids = Array.from({ length: 11 }, (_, index) => String(1000 + index));
  const x = await setup({ records: ids.slice(0, 10) });
  for (const id of ids.slice(0, 10)) await x.artwork(id);
  expect(x.upstream).toHaveBeenCalledTimes(11);
  x.setRecords(ids.slice(1));
  await x.artwork(ids[10]);
  x.setRecords(ids.slice(0, 10));
  await x.artwork(ids[0]);
  expect(x.upstream).toHaveBeenCalledTimes(13);
  x.expectNoWrites();
});

it("prunes departed covers during status reads so a returning song requires a new lookup", async () => {
  const records = [
    ...Array.from({ length: 9 }, (_, index) => String(1000 + index)),
    catalogId,
  ];
  const x = await setup({ records });
  await x.artwork();
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.setRecords(["987654321", ...records]);
  await x.request("/api/v1/recording");
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.setRecords(records);
  expect(await (await x.artwork()).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(3);
  x.expectNoWrites();
});

it.each([false, true])(
  "discards late artwork after its record leaves the view (intermediate status read: %s)",
  async (readStatus) => {
    const records = [
      ...Array.from({ length: 9 }, (_, index) => String(1000 + index)),
      catalogId,
    ];
    const x = await setup({ records });
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    x.upstream
      .mockResolvedValueOnce(Response.json({ data: [{ id: "tw" }] }))
      .mockImplementationOnce(async () => {
        started();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
    const pending = x.artwork();
    await ready;
    x.setRecords(["987654321", ...records]);
    if (readStatus) await x.request("/api/v1/recording");
    release(
      Response.json({
        data: [
          { id: catalogId, attributes: { artwork: { url: artworkTemplate } } },
        ],
      }),
    );
    expect(await (await pending).json()).toMatchObject({ artwork_url: null });
    x.setRecords(records);
    expect(await (await x.artwork()).json()).toMatchObject({
      artwork_url: artworkUrl,
    });
    expect(x.upstream).toHaveBeenCalledTimes(3);
    x.expectNoWrites();
  },
);

it("does not revive an invalidated in-flight cover when the song returns before completion", async () => {
  const x = await setup();
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  x.upstream
    .mockResolvedValueOnce(Response.json({ data: [{ id: "tw" }] }))
    .mockImplementationOnce(async () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
  const pending = x.artwork();
  await ready;
  x.setRecords([]);
  await x.request("/api/v1/recording");
  x.setRecords([catalogId]);
  await x.request("/api/v1/recording");
  release(
    Response.json({
      data: [
        { id: catalogId, attributes: { artwork: { url: artworkTemplate } } },
      ],
    }),
  );
  expect(await (await pending).json()).toMatchObject({ artwork_url: null });
  expect(await (await x.artwork()).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(3);
  x.expectNoWrites();
});

it("does not hold the recording queue during artwork requests and keeps status provider-free", async () => {
  const x = await setup();
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  x.upstream.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const artwork = x.artwork();
  await ready;
  const status = await x.request("/api/v1/recording");
  expect(status.status).toBe(200);
  expect(x.upstream).toHaveBeenCalledTimes(1);
  release(Response.json({ data: [{ id: "tw" }] }));
  expect(await (await artwork).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.expectNoWrites();
});

it("reads the original numeric track ID when the real ledger has catalog_id:null", async () => {
  const x = await setup({
    rows: [
      {
        track_id: "1412345678",
        catalog_id: null,
        artist: "Recorded artist",
        track: "Last.fm corrected title",
        album: "Corrected album",
        timestamp_iso: "2026-10-27T02:00:00.000Z",
      },
    ],
  });
  const before = structuredClone([...x.data]);
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream.mock.calls.map(([input]) => String(input))).toEqual([
    "https://api.music.apple.com/v1/me/storefront",
    "https://api.music.apple.com/v1/catalog/tw/songs/1412345678",
  ]);
  expect([...x.data]).toEqual(before);
  x.expectNoWrites();
});

it("uses the original track ID even for a legacy request using a different matched catalog ID", async () => {
  const x = await setup({
    rows: [{ track_id: "1412345678", catalog_id: catalogId }],
  });
  expect(await (await x.artwork()).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(String(x.upstream.mock.calls[1][0])).toBe(
    "https://api.music.apple.com/v1/catalog/tw/songs/1412345678",
  );
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.expectNoWrites();
});

it("keeps legacy catalog-only records working", async () => {
  const x = await setup({ rows: [{ catalog_id: catalogId }] });
  expect(await (await x.artwork()).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(await (await x.trackArtwork(catalogId)).json()).toMatchObject({
    artwork_url: null,
  });
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.expectNoWrites();
});

it("reads a library song directly with both Apple tokens and no storefront request", async () => {
  const x = await setup({
    rows: [{ track_id: "i.Original_-123", catalog_id: null }],
  });
  expect(await (await x.trackArtwork("i.Original_-123")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(1);
  const [input, init] = x.upstream.mock.calls[0];
  expect(String(input)).toBe(
    "https://api.music.apple.com/v1/me/library/songs/i.Original_-123",
  );
  expect(init?.headers).toMatchObject({
    Authorization: "Bearer fixture-developer-token",
    "Music-User-Token": "fixture-user-token",
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(init?.redirect).toBe("manual");
  x.expectNoWrites();
});

it("maps a preserved original catalog reference back to the exact previous library resource", async () => {
  const x = await setup({
    rows: [{ track_id: "1412345678", catalog_id: "987654321" }],
    previous: [{ id: "i.LibrarySource", catalog_id: "1412345678" }],
  });
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream.mock.calls.map(([input]) => String(input))).toEqual([
    "https://api.music.apple.com/v1/me/library/songs/i.LibrarySource",
  ]);
  x.expectNoWrites();
});

it("prefers a direct previous resource ID over another resource's catalog mapping", async () => {
  const x = await setup({
    rows: [{ track_id: "1412345678", catalog_id: null }],
    previous: [
      { id: "i.OtherResource", catalog_id: "1412345678" },
      { id: "1412345678", catalog_id: "987654321" },
    ],
  });
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(String(x.upstream.mock.calls[1][0])).toBe(
    "https://api.music.apple.com/v1/catalog/tw/songs/1412345678",
  );
  expect(x.upstream).toHaveBeenCalledTimes(2);
  x.expectNoWrites();
});

it("does not use unsafe previous resource IDs or matched metadata as an artwork request", async () => {
  const x = await setup({
    rows: [{ track_id: "1412345678", catalog_id: "987654321" }],
    previous: [{ id: "i.invalid/other", catalog_id: "1412345678" }],
  });
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(String(x.upstream.mock.calls[1][0])).toBe(
    "https://api.music.apple.com/v1/catalog/tw/songs/1412345678",
  );
  x.expectNoWrites();
});

it("requires one valid lookup selector in the most recent ten records", async () => {
  const ids = Array.from({ length: 11 }, (_, index) => "i.Source" + index);
  const x = await setup({
    rows: ids.map((id) => ({ track_id: id, catalog_id: null })),
  });
  for (const id of [
    "",
    "i.",
    "i.invalid/path",
    "i." + "x".repeat(127),
    "01",
    "i.Unlisted",
    ids[10],
  ])
    expect(await (await x.trackArtwork(id)).json()).toMatchObject({
      artwork_url: null,
    });
  for (const query of [
    "track_id=i.Source0&track_id=i.Source1",
    "track_id=i.Source0&catalog_id=" + catalogId,
    "record_key=anything",
  ])
    expect(
      await (await x.request("/api/v1/artwork?" + query)).json(),
    ).toMatchObject({
      artwork_url: null,
    });
  expect(x.upstream).not.toHaveBeenCalled();
  expect(await (await x.trackArtwork(ids[9])).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(1);
  x.expectNoWrites();
});

it.each([
  "wrong resource",
  "missing artwork",
  "HTTP error",
  "invalid JSON",
  "network failure",
])(
  "keeps library artwork unavailable for %s without trying the matched catalog ID",
  async (kind) => {
    const x = await setup({
      rows: [{ track_id: "i.Original", catalog_id: catalogId }],
    });
    x.upstream.mockImplementation(async () => {
      if (kind === "HTTP error")
        return new Response("private upstream response", { status: 401 });
      if (kind === "invalid JSON") return new Response("invalid");
      if (kind === "network failure") throw Error("private details");
      return Response.json({
        data: [
          {
            id: kind === "wrong resource" ? "i.Other" : "i.Original",
            attributes:
              kind === "missing artwork"
                ? {}
                : { artwork: { url: artworkTemplate } },
          },
        ],
      });
    });
    expect(await (await x.trackArtwork("i.Original")).json()).toMatchObject({
      artwork_url: null,
    });
    expect(x.upstream).toHaveBeenCalledTimes(1);
    x.expectNoWrites();
  },
);

it("invalidates cached artwork when the exact original resource mapping changes", async () => {
  const x = await setup({
    rows: [{ track_id: "1412345678", catalog_id: null }],
    previous: [{ id: "i.First", catalog_id: "1412345678" }],
  });
  await x.trackArtwork("1412345678");
  await x.trackArtwork("1412345678");
  expect(x.upstream).toHaveBeenCalledTimes(1);
  x.setPrevious([{ id: "i.Second", catalog_id: "1412345678" }]);
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(x.upstream).toHaveBeenCalledTimes(2);
  expect(String(x.upstream.mock.calls[1][0])).toBe(
    "https://api.music.apple.com/v1/me/library/songs/i.Second",
  );
  x.expectNoWrites();
});

it("discards late artwork when its original resource mapping changes", async () => {
  const x = await setup({
    rows: [{ track_id: "1412345678", catalog_id: null }],
    previous: [{ id: "i.First", catalog_id: "1412345678" }],
  });
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  x.upstream.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = x.trackArtwork("1412345678");
  await ready;
  x.setPrevious([{ id: "i.Second", catalog_id: "1412345678" }]);
  release(
    Response.json({
      data: [
        { id: "i.First", attributes: { artwork: { url: artworkTemplate } } },
      ],
    }),
  );
  expect(await (await pending).json()).toMatchObject({ artwork_url: null });
  expect(await (await x.trackArtwork("1412345678")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  expect(String(x.upstream.mock.calls[1][0])).toBe(
    "https://api.music.apple.com/v1/me/library/songs/i.Second",
  );
  x.expectNoWrites();
});

it("does not return a late cover after Apple credentials change without another cover request", async () => {
  const x = await setup({
    rows: [{ track_id: "i.Original", catalog_id: null }],
  });
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  x.upstream.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = x.trackArtwork("i.Original");
  await ready;
  x.data.set("apple-connection:v1", {
    apple_dev_token: "new-dev-token",
    apple_user_token: "new-user-token",
  });
  release(
    Response.json({
      data: [
        { id: "i.Original", attributes: { artwork: { url: artworkTemplate } } },
      ],
    }),
  );
  expect(await (await pending).json()).toMatchObject({ artwork_url: null });
  x.expectNoWrites();
});

it("prunes departed original track covers and never blocks pausing recording", async () => {
  const row = { track_id: "i.Original", catalog_id: null };
  const x = await setup({ rows: [row] });
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  x.upstream.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = x.trackArtwork("i.Original");
  await ready;
  const paused = await x.actor.fetch(
    new Request("https://fixture.test/api/v1/recording/pause", {
      method: "POST",
    }),
  );
  expect(paused.status).toBe(200);
  expect(x.storage.deleteAlarm).toHaveBeenCalledTimes(1);
  x.setRows([]);
  await x.request("/api/v1/recording");
  x.setRows([row]);
  await x.request("/api/v1/recording");
  release(
    Response.json({
      data: [
        { id: "i.Original", attributes: { artwork: { url: artworkTemplate } } },
      ],
    }),
  );
  expect(await (await pending).json()).toMatchObject({ artwork_url: null });
  expect(await (await x.trackArtwork("i.Original")).json()).toMatchObject({
    artwork_url: artworkUrl,
  });
  x.setRows([]);
  expect(await (await x.trackArtwork("i.Original")).json()).toMatchObject({
    artwork_url: null,
  });
  expect(x.upstream).toHaveBeenCalledTimes(2);
});

it("distinguishes invalid selectors, out-of-scope records and missing Apple credentials without exposing record data", async () => {
  const x = await setup({ connected: false });
  expect(await (await x.artwork("invalid/private")).json()).toEqual({
    artwork_url: null,
    artwork_status: "invalid_id",
    stage: "validation",
  });
  expect(await (await x.artwork("987654321")).json()).toEqual({
    artwork_url: null,
    artwork_status: "scope_not_found",
    stage: "scope",
  });
  x.setRows([{ track_id: "i.Original", catalog_id: null }]);
  expect(await (await x.trackArtwork("i.Original")).json()).toEqual({
    artwork_url: null,
    artwork_status: "apple_not_connected",
    stage: "credentials",
  });
  expect(x.upstream).not.toHaveBeenCalled();
  expect(x.publicUpstream).not.toHaveBeenCalled();
  x.expectNoWrites();
});

it.each([
  ["storefront", "HTTP error", "apple_http_error", 403],
  ["storefront", "network failure", "network_error", undefined],
  ["storefront", "timeout", "timeout", undefined],
  ["storefront", "invalid JSON", "invalid_response", 200],
  ["storefront", "invalid shape", "invalid_response", 200],
  ["catalog", "HTTP error", "apple_http_error", 403],
  ["catalog", "network failure", "network_error", undefined],
  ["catalog", "timeout", "timeout", undefined],
  ["catalog", "invalid JSON", "invalid_response", 200],
  ["catalog", "invalid shape", "invalid_response", 200],
  ["catalog", "wrong ID", "response_id_mismatch", 200],
  ["catalog", "missing artwork", "artwork_missing", 200],
  ["catalog", "rejected URL", "artwork_url_rejected", 200],
  ["library", "HTTP error", "apple_http_error", 403],
  ["library", "network failure", "network_error", undefined],
  ["library", "timeout", "timeout", undefined],
  ["library", "invalid JSON", "invalid_response", 200],
  ["library", "invalid shape", "invalid_response", 200],
  ["library", "wrong ID", "response_id_mismatch", 200],
  ["library", "missing artwork", "artwork_missing", 200],
  ["library", "rejected URL", "artwork_url_rejected", 200],
] as const)(
  "reports only fixed diagnostics for %s %s",
  async (stage, failure, status, httpStatus) => {
    const id = stage === "library" ? "i.Original" : "1412345678";
    const x = await setup({ rows: [{ track_id: id, catalog_id: null }] });
    const privateValue =
      "fixture-user-token private provider body https://private.example/private/path";
    x.upstream.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/me/storefront") && stage !== "storefront")
        return Response.json({ data: [{ id: "tw" }] });
      if (failure === "HTTP error")
        return new Response(privateValue, { status: 403 });
      if (failure === "network failure") throw new TypeError(privateValue);
      if (failure === "timeout")
        throw new DOMException(privateValue, "TimeoutError");
      if (failure === "invalid JSON") return new Response(privateValue);
      if (failure === "invalid shape")
        return Response.json({ details: privateValue });
      if (failure === "wrong ID")
        return Response.json({ data: [{ id: "unrelated-private-id" }] });
      if (failure === "missing artwork")
        return Response.json({ data: [{ id, attributes: {} }] });
      return Response.json({
        data: [
          {
            id,
            attributes: {
              artwork: {
                url: "https://private.example/private/path?token=private",
              },
            },
          },
        ],
      });
    });
    const expected = {
      artwork_url: null,
      artwork_status: status,
      stage,
      lookup_kind: "track_id",
      resource_kind: stage === "library" ? "library" : "catalog",
      ...(httpStatus === undefined ? {} : { apple_http_status: httpStatus }),
    };
    const first = await (await x.trackArtwork(id)).json();
    expect(first).toEqual(expected);
    const count = x.upstream.mock.calls.length;
    expect(await (await x.trackArtwork(id)).json()).toEqual(expected);
    expect(x.upstream).toHaveBeenCalledTimes(count);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(JSON.stringify(first)).not.toContain("fixture");
    expect(JSON.stringify(first)).not.toContain(id);
    x.expectNoWrites();
  },
);

it.each(["i.Original", "1412345678"])(
  "reports successful %s artwork without returning provider credentials or lookup IDs",
  async (id) => {
    const x = await setup({ rows: [{ track_id: id, catalog_id: null }] });
    expect(await (await x.trackArtwork(id)).json()).toEqual({
      artwork_url: artworkUrl,
      artwork_status: "ok",
      stage: id.startsWith("i.") ? "library" : "catalog",
      lookup_kind: "track_id",
      resource_kind: id.startsWith("i.") ? "library" : "catalog",
      apple_http_status: 200,
    });
    x.expectNoWrites();
  },
);

it.each([false, true])(
  "reads the exact real source ID 220366030 through public Apple lookup without credentials (Apple connected: %s)",
  async (connected) => {
    const x = await setup({
      rows: [
        {
          track_id: publicSourceId,
          catalog_id: null,
          artist: "Recorded artist",
          track: "Recorded title",
        },
      ],
      connected,
    });
    const before = structuredClone([...x.data]);
    x.publicUpstream.mockImplementation(async () =>
      Response.json(publicSourceResult),
    );
    const expected = {
      artwork_url: publicSourceArtwork600,
      artwork_status: "ok",
      stage: "public_lookup",
      resource_kind: "catalog",
      lookup_kind: "track_id",
      apple_http_status: 200,
    };
    expect(await (await x.trackArtwork(publicSourceId)).json()).toEqual(
      expected,
    );
    expect(await (await x.trackArtwork(publicSourceId)).json()).toEqual(
      expected,
    );
    expect(x.publicUpstream).toHaveBeenCalledTimes(1);
    const [input, init] = x.publicUpstream.mock.calls[0];
    expect(String(input)).toBe(
      "https://itunes.apple.com/lookup?id=220366030&entity=song",
    );
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(x.upstream).not.toHaveBeenCalled();
    expect([...x.data]).toEqual(before);
    x.expectNoWrites();
  },
);

it("uses the source track ID for public lookup even when a matched catalog ID or original library mapping exists", async () => {
  const x = await setup({
    rows: [{ track_id: publicSourceId, catalog_id: "987654321" }],
    previous: [{ id: "i.Original", catalog_id: publicSourceId }],
  });
  x.publicUpstream.mockImplementation(async () =>
    Response.json(publicSourceResult),
  );
  expect(await (await x.artwork("987654321")).json()).toMatchObject({
    artwork_url: publicSourceArtwork600,
    stage: "public_lookup",
  });
  expect(String(x.publicUpstream.mock.calls[0][0])).toBe(
    "https://itunes.apple.com/lookup?id=220366030&entity=song",
  );
  expect(x.upstream).not.toHaveBeenCalled();
  x.expectNoWrites();
});

it.each([
  { wrapperType: "collection", kind: "song", trackId: 220366030 },
  { wrapperType: "track", kind: "music-video", trackId: 220366030 },
  { wrapperType: "track", kind: "song", trackId: 220366031 },
])(
  "rejects public lookup records with a different identity or resource type: %j",
  async (item) => {
    const x = await setup({
      rows: [{ track_id: publicSourceId, catalog_id: null }],
      connected: false,
    });
    x.publicUpstream.mockImplementation(async () =>
      Response.json({
        results: [{ ...item, artworkUrl100: publicSourceArtwork100 }],
      }),
    );
    expect(await (await x.trackArtwork(publicSourceId)).json()).toEqual({
      artwork_url: null,
      artwork_status: "response_id_mismatch",
      stage: "public_lookup",
      lookup_kind: "track_id",
      resource_kind: "catalog",
      apple_http_status: 200,
    });
    expect(x.upstream).not.toHaveBeenCalled();
    x.expectNoWrites();
  },
);

it.each([
  "https://evil.test/100x100bb.jpg",
  "https://mzstatic.com.evil.test/100x100bb.jpg",
  "http://is1-ssl.mzstatic.com/100x100bb.jpg",
  "https://private@is1-ssl.mzstatic.com/100x100bb.jpg",
])("rejects unsafe public lookup artwork: %s", async (url) => {
  const x = await setup({
    rows: [{ track_id: publicSourceId, catalog_id: null }],
    connected: false,
  });
  x.publicUpstream.mockImplementation(async () =>
    Response.json({
      results: [
        {
          wrapperType: "track",
          kind: "song",
          trackId: 220366030,
          artworkUrl100: url,
        },
      ],
    }),
  );
  expect(await (await x.trackArtwork(publicSourceId)).json()).toMatchObject({
    artwork_url: null,
    artwork_status: "artwork_url_rejected",
    stage: "public_lookup",
  });
  expect(x.upstream).not.toHaveBeenCalled();
  x.expectNoWrites();
});

it("keeps the native Apple fallback when public lookup has no result and shares its five-second deadline", async () => {
  const x = await setup({
    rows: [{ track_id: publicSourceId, catalog_id: null }],
  });
  expect(await (await x.trackArtwork(publicSourceId)).json()).toMatchObject({
    artwork_url: artworkUrl,
    stage: "catalog",
  });
  expect(x.publicUpstream).toHaveBeenCalledTimes(1);
  expect(x.upstream).toHaveBeenCalledTimes(2);
  const publicRequest = x.publicUpstream.mock.calls[0][1]!;
  expect(publicRequest.signal).toBe(x.upstream.mock.calls[0][1]?.signal);
  expect(publicRequest.signal).toBe(x.upstream.mock.calls[1][1]?.signal);
  expect(publicRequest.headers).toBeUndefined();
  x.expectNoWrites();
});

it("rejects late public lookup results after the source record leaves and returns, while recording pause stays responsive", async () => {
  const row = { track_id: publicSourceId, catalog_id: null };
  const x = await setup({ rows: [row], connected: false });
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  x.publicUpstream.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = x.trackArtwork(publicSourceId);
  await ready;
  const paused = await x.actor.fetch(
    new Request("https://fixture.test/api/v1/recording/pause", {
      method: "POST",
    }),
  );
  expect(paused.status).toBe(200);
  expect(x.storage.deleteAlarm).toHaveBeenCalledTimes(1);
  x.setRows([]);
  await x.request("/api/v1/recording");
  x.setRows([row]);
  await x.request("/api/v1/recording");
  release(Response.json(publicSourceResult));
  expect(await (await pending).json()).toEqual({
    artwork_url: null,
    artwork_status: "scope_changed",
    stage: "scope",
  });
  x.publicUpstream.mockImplementation(async () =>
    Response.json(publicSourceResult),
  );
  expect(await (await x.trackArtwork(publicSourceId)).json()).toMatchObject({
    artwork_url: publicSourceArtwork600,
  });
  expect(x.upstream).not.toHaveBeenCalled();
});

it.each([301, 302])(
  "rejects public Apple lookup redirects (%s) without following an unsafe target",
  async (status) => {
    const x = await setup({
      rows: [{ track_id: publicSourceId, catalog_id: null }],
      connected: false,
    });
    x.publicUpstream.mockImplementation(
      async () =>
        new Response(null, {
          status,
          headers: {
            Location: "https://unsafe.example/private?token=must-not-appear",
          },
        }),
    );
    expect(await (await x.trackArtwork(publicSourceId)).json()).toEqual({
      artwork_url: null,
      artwork_status: "apple_http_error",
      stage: "public_lookup",
      lookup_kind: "track_id",
      resource_kind: "catalog",
      apple_http_status: status,
    });
    expect(x.publicUpstream).toHaveBeenCalledTimes(1);
    const [input, init] = x.publicUpstream.mock.calls[0];
    expect(new URL(String(input)).origin).toBe("https://itunes.apple.com");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toBeUndefined();
    expect(x.upstream).not.toHaveBeenCalled();
    x.expectNoWrites();
  },
);

it.each([
  ["storefront", 301],
  ["storefront", 302],
  ["catalog", 301],
  ["catalog", 302],
  ["library", 301],
  ["library", 302],
] as const)(
  "rejects private Apple %s redirects (%s) without forwarding credentials to an unsafe target",
  async (stage, status) => {
    const id = stage === "library" ? "i.Original" : publicSourceId;
    const x = await setup({ rows: [{ track_id: id, catalog_id: null }] });
    x.upstream.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (stage === "catalog" && url.pathname.endsWith("/me/storefront"))
        return Response.json({ data: [{ id: "tw" }] });
      return new Response(null, {
        status,
        headers: {
          Location: "https://unsafe.example/private?token=must-not-appear",
        },
      });
    });
    expect(await (await x.trackArtwork(id)).json()).toEqual({
      artwork_url: null,
      artwork_status: "apple_http_error",
      stage,
      lookup_kind: "track_id",
      resource_kind: stage === "library" ? "library" : "catalog",
      apple_http_status: status,
    });
    expect(x.upstream).toHaveBeenCalledTimes(stage === "catalog" ? 2 : 1);
    for (const [input, init] of x.upstream.mock.calls) {
      expect(new URL(String(input)).origin).toBe("https://api.music.apple.com");
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).not.toHaveProperty("x-ascrobble-auth");
    }
    x.expectNoWrites();
  },
);
