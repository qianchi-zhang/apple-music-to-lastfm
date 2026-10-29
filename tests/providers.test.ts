import { expect, it } from "vitest";
import { createProviderRuntime } from "../packages/providers/src/runtime";
import { testClock } from "./support";
it("incomplete history request fails instead of replacing the snapshot with empty history", async () => {
  const api = createProviderRuntime({
    clock: testClock(),
    fetch: async () => new Response("", { status: 503 }),
  });
  await expect(api.fetchRecentlyPlayed("dev", "user")).rejects.toThrow();
});
it("malformed history response fails closed", async () => {
  const api = createProviderRuntime({
    clock: testClock(),
    fetch: async () => new Response("{}"),
  });
  await expect(api.fetchRecentlyPlayed("dev", "user")).rejects.toThrow(
    "invalid_response",
  );
});
it("provider caches are isolated between instances", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ access_token: `token${calls}`, expires_in: 3600 }),
    );
  };
  const a = createProviderRuntime({ fetch, clock: testClock() }),
    b = createProviderRuntime({ fetch, clock: testClock() });
  const env = { SPOTIFY_CLIENT_ID: "a", SPOTIFY_CLIENT_SECRET: "b" };
  expect(await a.getSpotifyClientToken(env)).toBe("token1");
  expect(await a.getSpotifyClientToken(env)).toBe("token1");
  expect(await b.getSpotifyClientToken(env)).toBe("token2");
});
