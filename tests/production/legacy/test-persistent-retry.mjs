import worker from "./worker-fixed.js";

class MemoryKv {
  constructor(seed = {}) {
    this.values = new Map(Object.entries(seed));
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.values.set(key, value);
  }
}

const previousTrack = {
  id: "old-track",
  type: "other",
  name: "Old Song",
  artist: "Old Artist",
  album_artist: "Old Artist",
  album: "Old Album",
  duration_ms: 180000,
};
const newTrack = {
  id: "new-track",
  type: "other",
  name: "New Song",
  artist: "New Artist",
  album_artist: "New Artist",
  album: "New Album",
  duration_ms: 200000,
};

const ledger = {
  version: 1,
  history_source_version: 2,
  last_run_iso: new Date(Date.now() - 180000).toISOString(),
  previous_recent: [previousTrack],
  recent_scrobbles: [],
  pending_scrobbles: [],
  stats: {
    total_scrobbled: 0,
    total_runs: 0,
    total_errors: 0,
    last_success_iso: null,
    last_error_iso: null,
    last_error_message: null,
  },
};
const kv = new MemoryKv({
  "ledger:v1": JSON.stringify(ledger),
  apple_dev_token: "developer-token",
  apple_user_token: "user-token",
});
const env = {
  ASCROBBLE_STATE: kv,
  LASTFM_API_KEY: "api-key",
  LASTFM_SHARED_SECRET: "shared-secret",
  LASTFM_SESSION_KEY: "session-key",
  STATUS_AUTH_KEY: "status-key",
};

let lastFmShouldFail = true;
let lastFmPosts = 0;
globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const url = new URL(rawUrl);
  if (url.hostname === "music.apple.com") {
    return new Response("", { status: 503 });
  }
  if (url.hostname === "api.music.apple.com") {
    return new Response(JSON.stringify({
      data: [newTrack, previousTrack].map((track) => ({
        id: track.id,
        type: track.type,
        attributes: {
          name: track.name,
          artistName: track.artist,
          albumArtistName: track.album_artist,
          albumName: track.album,
          durationInMillis: track.duration_ms,
        },
      })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === "musicbrainz.org") {
    return new Response(JSON.stringify({ recordings: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.hostname === "ws.audioscrobbler.com" && init.method === "POST") {
    lastFmPosts += 1;
    if (lastFmShouldFail) {
      return new Response("temporary outage", { status: 503 });
    }
    return new Response(JSON.stringify({
      scrobbles: {
        "@attr": { accepted: "1", ignored: "0" },
        scrobble: [{ ignoredMessage: { code: "0", "#text": "" } }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === "ws.audioscrobbler.com") {
    const method = url.searchParams.get("method");
    const body = method === "artist.getInfo"
      ? { artist: { name: "New Artist", mbid: "artist-mbid", stats: { playcount: "1" } } }
      : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

await worker.scheduled({}, env, {});
const afterFailure = JSON.parse(kv.values.get("ledger:v1"));
if (afterFailure.pending_scrobbles?.length !== 1) {
  throw new Error(`Expected 1 persisted pending scrobble, got ${afterFailure.pending_scrobbles?.length}`);
}
if (afterFailure.recent_scrobbles.length !== 0) {
  throw new Error("Failed scrobble was incorrectly recorded as successful");
}
if (afterFailure.previous_recent[0]?.id !== "new-track") {
  throw new Error("Apple history baseline was not advanced after durable enqueue");
}
if (lastFmPosts !== 2) {
  throw new Error(`Expected initial submit plus one retry, got ${lastFmPosts} POSTs`);
}

lastFmShouldFail = false;
await worker.scheduled({}, env, {});
const afterRecovery = JSON.parse(kv.values.get("ledger:v1"));
if (afterRecovery.pending_scrobbles?.length !== 0) {
  throw new Error("Pending queue was not cleared after Last.fm confirmation");
}
if (afterRecovery.recent_scrobbles.length !== 1) {
  throw new Error("Recovered scrobble was not recorded exactly once");
}
if (afterRecovery.stats.total_scrobbled !== 1) {
  throw new Error(`Expected total_scrobbled=1, got ${afterRecovery.stats.total_scrobbled}`);
}

console.log(JSON.stringify({
  ok: true,
  failed_attempts: 2,
  pending_after_failure: afterFailure.pending_scrobbles.length,
  pending_after_recovery: afterRecovery.pending_scrobbles.length,
  total_scrobbled: afterRecovery.stats.total_scrobbled,
}, null, 2));
