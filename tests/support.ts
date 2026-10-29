import * as detection from "../packages/core/src/detection";
import * as text from "../packages/core/src/text";
import * as apple from "../packages/core/src/apple-evidence";
import * as mb from "../packages/core/src/musicbrainz-evidence";
import { createProviderRuntime } from "../packages/providers/src/runtime";
import { createServices } from "../packages/providers/src/services";
import { KvStore } from "../packages/storage/src/index";
import { Engine } from "../packages/core/src/engine";
import { applyProfile } from "../packages/profiles/src/index";
import {
  defaultProfile,
  type Clock,
  type Resource,
} from "../packages/contracts/src/index";
import profile from "../examples/fujii-kaze.profile.json";
export function testClock(): Clock {
  let now = Date.now();
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}
export function createHarness(): Record<string, any> {
  const runtime = createProviderRuntime({
    clock: testClock(),
    fetch: (...args) => globalThis.fetch(...args),
  });
  return {
    ...detection,
    ...text,
    ...apple,
    ...mb,
    ...runtime,
    buildLastFmPayload: (p: Resource) => ({
      artist: p.track.artist,
      track: p.track.name,
      album: p.track.album,
      album_artist: p.track.album_artist,
      mbid: p.track.mbid_kind === "recording" ? p.track.mbid : "",
      timestamp: p.timestamp,
      duration_ms: p.track.duration_ms,
    }),
    // Personal example is deliberately tested outside the generic production pipeline.
    applyArtistDisplayOverride: (t: Resource, identity: Resource = {}) => {
      const names = {
        artist: t.artist,
        album_artist: t.album_artist ?? t.artist,
        track: t.name ?? "",
        album: t.album ?? "",
      };
      const out = applyProfile(
        {
          source: {
            ...t,
            id: "fixture",
            name: t.name ?? "",
            artist: t.artist,
            album: t.album ?? "",
            duration_ms: 180000,
          },
          identity,
          canonical: names,
          evidence: {},
        },
        profile as any,
      );
      return {
        ...t,
        artist: out.lastfm.artist,
        album_artist: out.lastfm.album_artist,
      };
    },
  };
}
export function regressionWorker() {
  return {
    async scheduled(_event: unknown, env: any, _ctx: unknown) {
      const clock = testClock();
      const store = new KvStore(env.ASCROBBLE_STATE);
      const engine = new Engine({
        store,
        services: createServices(env.ASCROBBLE_STATE, env, {
          clock,
          fetch: (...args) => globalThis.fetch(...args),
        }),
        clock,
        profile: async () => defaultProfile(),
      });
      return engine.run(true);
    },
  };
}
