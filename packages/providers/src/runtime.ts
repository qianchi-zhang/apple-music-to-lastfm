import type { Clock, Resource } from "../../contracts/src/index";
import { systemClock } from "../../contracts/src/index";
import { createApple } from "./apple";
import { createLastfm } from "./lastfm";
import { createMusicbrainz } from "./musicbrainz";
import { createMetadata } from "./metadata";
import { createSpotify } from "./spotify";
import { createListenbrainz } from "./listenbrainz";
import { createNotifications } from "./notifications";
/** Dynamic provider envelopes remain local to adapters; domain uses explicit contracts. */
export interface ProviderContext {
  api: Record<string, (...args: any[]) => any>;
  state: Resource;
  fetch: typeof fetch;
  Date: DateConstructor;
  console: Pick<Console, "log" | "warn" | "error">;
  setTimeout: (callback: (...args: any[]) => void, ms?: number) => void;
}
export function createProviderRuntime(
  options: {
    fetch?: typeof fetch;
    clock?: Clock;
    logger?: ProviderContext["console"];
  } = {},
) {
  const clock = options.clock ?? systemClock;
  class ClockDate extends globalThis.Date {
    constructor(value?: any) {
      super(value === undefined ? clock.now() : value);
    }
    static now() {
      return clock.now();
    }
  }
  const ctx: ProviderContext = {
    api: {},
    state: {
      lastMusicBrainzRequestAt: 0,
      musicBrainzRequestChain: Promise.resolve(),
      MEMORY_APPLE_STOREFRONT: null,
      SPOTIFY_TOKEN_CACHE: null,
    },
    fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
    Date: ClockDate as DateConstructor,
    console: options.logger ?? console,
    setTimeout: (callback, ms) => {
      void clock.sleep(ms ?? 0).then(() => callback());
    },
  };
  for (const factory of [
    createApple,
    createLastfm,
    createMusicbrainz,
    createMetadata,
    createSpotify,
    createListenbrainz,
    createNotifications,
  ])
    Object.assign(ctx.api, factory(ctx));
  return ctx.api;
}
