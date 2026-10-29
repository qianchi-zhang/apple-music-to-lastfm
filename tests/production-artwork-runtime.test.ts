import { build } from "esbuild";
import {
  Log,
  LogLevel,
  Miniflare,
  Response as WorkerResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const managementKey = "runtime-fixture-management-key";
const developerToken = "runtime-fixture-developer-token";
const userToken = "runtime-fixture-user-token";
const numericId = "220366030";
const libraryId = "i.RuntimeOriginal";
const artwork100 =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/fixture/100x100bb.jpg";
const artwork600 = artwork100.replace("100x100", "600x600");
let script: string;
let runtime: Miniflare | undefined;
let scenario: "public" | "library" | "fallback" | "redirect";
let requests: Array<{ url: string; headers: Record<string, string> }>;

beforeAll(async () => {
  // Bundle the real production entry; only the local harness adds seed/readback routes.
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "artwork-runtime-harness.ts",
      loader: "ts",
      contents: `
        import production, { ScrobbleCoordinator } from "./apps/worker/src/production-entry";
        import pinned from "./apps/worker/production/runtime.generated.js";
        export class RuntimeCoordinator extends ScrobbleCoordinator {
          constructor(state, env) { super(state, env); this.testState = state; }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/__seed") {
              const { id, connected } = await request.json();
              this.seedRevision = (this.seedRevision ?? 0) + 1;
              await this.testState.storage.deleteAll();
              await this.testState.storage.put({
                "production-ledger:v1": JSON.stringify({
                  recent_scrobbles: [{ track_id: id, catalog_id: null,
                    artist: "Recorded artist", track: "Recorded title", album: "Recorded album",
                    timestamp_iso: "2026-10-27T01:00:00.000Z" }],
                  previous_recent: [],
                  last_run_iso: new Date(Date.UTC(2026, 9, 27, 1) + this.seedRevision * 1000).toISOString()
                }),
                "extension-enabled:v1": false,
                ...(connected ? { "apple-connection:v1": {
                  apple_dev_token: ${JSON.stringify(developerToken)},
                  apple_user_token: ${JSON.stringify(userToken)}
                } } : {})
              });
              return Response.json({ seeded: true });
            }
            if (path === "/__snapshot") return Response.json({
              entries: Object.fromEntries(await this.testState.storage.list()),
              alarm: await this.testState.storage.getAlarm()
            });
            return super.fetch(request);
          }
        }
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === "/__pinned_health")
            return pinned.fetch(new Request("https://runtime.test/health"), env);
          if (new URL(request.url).pathname.startsWith("/__")) {
            const id = env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator");
            return env.SCROBBLE_COORDINATOR.get(id).fetch(request);
          }
          return production.fetch(request, env);
        } };
      `,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  script = result.outputFiles[0].text;
});

beforeEach(() => {
  requests = [];
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      script,
      modules: true,
      // Matches the installed workerd release; no remote Workers or real credentials.
      compatibilityDate: "2026-09-07",
      log: new Log(LogLevel.NONE),
      cf: false,
      bindings: { STATUS_AUTH_KEY: managementKey },
      kvNamespaces: ["ASCROBBLE_STATE"],
      durableObjects: {
        SCROBBLE_COORDINATOR: {
          className: "RuntimeCoordinator",
          useSQLite: true,
        },
      },
      outboundService(request) {
        const url = new URL(request.url);
        requests.push({
          url: url.href,
          headers: Object.fromEntries(request.headers),
        });
        // Every outbound request is intercepted here: this suite never uses the network.
        if (scenario === "redirect")
          return new WorkerResponse(null, {
            status: 302,
            headers: { Location: "https://credential-leak.invalid/redirected" },
          });
        if (url.origin === "https://itunes.apple.com") {
          if (scenario === "public")
            return WorkerResponse.json({
              results: [
                {
                  wrapperType: "track",
                  kind: "song",
                  trackId: Number(numericId),
                  artworkUrl100: artwork100,
                },
              ],
            });
          if (scenario === "fallback")
            return WorkerResponse.json({ results: [] });
        }
        if (url.origin === "https://api.music.apple.com") {
          if (scenario === "fallback" && url.pathname === "/v1/me/storefront")
            return WorkerResponse.json({ data: [{ id: "tw" }] });
          if (
            (scenario === "fallback" &&
              url.pathname === "/v1/catalog/tw/songs/" + numericId) ||
            (scenario === "library" &&
              url.pathname === "/v1/me/library/songs/" + libraryId)
          )
            return WorkerResponse.json({
              data: [
                {
                  id: scenario === "library" ? libraryId : numericId,
                  attributes: { artwork: { url: artwork600 } },
                },
              ],
            });
        }
        return new WorkerResponse("Unexpected fixture request", {
          status: 500,
        });
      },
    }),
  );
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

async function seed(id: string, connected = true) {
  const response = await runtime!.dispatchFetch("https://runtime.test/__seed", {
    method: "POST",
    body: JSON.stringify({ id, connected }),
  });
  expect(response.status).toBe(200);
}
async function snapshot() {
  return (
    await runtime!.dispatchFetch("https://runtime.test/__snapshot")
  ).json();
}
async function artwork(id: string) {
  const response = await runtime!.dispatchFetch(
    "https://runtime.test/api/v1/artwork?track_id=" + encodeURIComponent(id),
    { headers: { "x-ascrobble-auth": managementKey } },
  );
  expect(response.status).toBe(200);
  return response.json();
}

it("runs the pinned 0.3.111 source and its adapter in workerd without changing recording state", async () => {
  scenario = "public";
  await seed(numericId, false);
  const before = await snapshot();
  const pinned = await (
    await runtime!.dispatchFetch("https://runtime.test/__pinned_health")
  ).json();
  expect(pinned).toMatchObject({
    version: "0.3.111",
    diagnostic_flight_recorder: true,
    durable_alarm: true,
  });
  const adapter = await (
    await runtime!.dispatchFetch("https://runtime.test/health")
  ).json();
  expect(adapter).toMatchObject({
    version: "0.3.111",
    algorithm_sha256:
      "531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794",
    capabilities: { apple_artwork_runtime: "workerd-manual-v1" },
  });
  expect(requests).toEqual([]);
  expect(await snapshot()).toEqual(before);
});

it("runs the numeric source-ID lookup in workerd without forwarding any credentials", async () => {
  scenario = "public";
  await seed(numericId);
  const before = await snapshot();
  expect(await artwork(numericId)).toMatchObject({
    artwork_url: artwork600,
    stage: "public_lookup",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(
    "https://itunes.apple.com/lookup?id=220366030&entity=song",
  );
  expect(JSON.stringify(requests)).not.toContain(developerToken);
  expect(JSON.stringify(requests)).not.toContain(userToken);
  expect(JSON.stringify(requests)).not.toContain(managementKey);
  expect(requests[0].headers).not.toHaveProperty("authorization");
  expect(requests[0].headers).not.toHaveProperty("cookie");
  expect(await snapshot()).toEqual(before);
});

it("runs the native library lookup in workerd and keeps tokens on the Apple API origin", async () => {
  scenario = "library";
  await seed(libraryId);
  const before = await snapshot();
  expect(await artwork(libraryId)).toMatchObject({
    artwork_url: artwork600,
    stage: "library",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: "https://api.music.apple.com/v1/me/library/songs/" + libraryId,
    headers: {
      authorization: "Bearer " + developerToken,
      "music-user-token": userToken,
    },
  });
  expect(JSON.stringify(requests)).not.toContain(managementKey);
  expect(await snapshot()).toEqual(before);
});

it("runs the storefront and catalog fallback in workerd when the public lookup misses", async () => {
  scenario = "fallback";
  await seed(numericId);
  const before = await snapshot();
  expect(await artwork(numericId)).toMatchObject({
    artwork_url: artwork600,
    stage: "catalog",
  });
  expect(requests.map((request) => request.url)).toEqual([
    "https://itunes.apple.com/lookup?id=220366030&entity=song",
    "https://api.music.apple.com/v1/me/storefront",
    "https://api.music.apple.com/v1/catalog/tw/songs/220366030",
  ]);
  expect(requests[0].headers).not.toHaveProperty("authorization");
  expect(requests[2].headers).not.toHaveProperty("music-user-token");
  expect(JSON.stringify(requests)).not.toContain(managementKey);
  expect(await snapshot()).toEqual(before);
});

it("rejects public and credentialed library redirects without following or forwarding credentials", async () => {
  scenario = "redirect";
  for (const [id, connected, stage] of [
    [numericId, false, "public_lookup"],
    [libraryId, true, "library"],
  ] as const) {
    await seed(id, connected);
    const before = await snapshot();
    expect(await artwork(id)).toMatchObject({
      artwork_url: null,
      artwork_status: "apple_http_error",
      apple_http_status: 302,
      stage,
    });
    expect(await snapshot()).toEqual(before);
  }
  expect(requests).toHaveLength(2);
  expect(
    requests.every(
      ({ url }) => new URL(url).hostname !== "credential-leak.invalid",
    ),
  ).toBe(true);
  expect(JSON.stringify(requests)).not.toContain(managementKey);
});
