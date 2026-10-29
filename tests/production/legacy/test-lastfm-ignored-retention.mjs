import worker from "./worker-fixed.js";

class MemoryKv {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, value); }
}

const previous = { id: "old", type: "other", name: "Old", artist: "Artist", album_artist: "Artist", album: "Album", duration_ms: 180000 };
const current = { id: "new", type: "other", name: "New", artist: "Artist", album_artist: "Artist", album: "Album", duration_ms: 180000 };
const ledger = {
  version: 1,
  history_source_version: 2,
  last_run_iso: new Date(Date.now() - 180000).toISOString(),
  previous_recent: [previous],
  recent_scrobbles: [],
  pending_scrobbles: [],
  stats: { total_scrobbled: 0, total_runs: 0, total_errors: 0, last_success_iso: null, last_error_iso: null, last_error_message: null }
};
const kv = new MemoryKv({ "ledger:v1": JSON.stringify(ledger), apple_dev_token: "dev", apple_user_token: "user" });
const env = { ASCROBBLE_STATE: kv, LASTFM_API_KEY: "key", LASTFM_SHARED_SECRET: "secret", LASTFM_SESSION_KEY: "session", STATUS_AUTH_KEY: "status" };

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
  if (url.hostname === "music.apple.com") return new Response("", { status: 503 });
  if (url.hostname === "api.music.apple.com") {
    return new Response(JSON.stringify({ data: [current, previous].map((track) => ({ id: track.id, type: track.type, attributes: { name: track.name, artistName: track.artist, albumArtistName: track.album_artist, albumName: track.album, durationInMillis: track.duration_ms } })) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === "musicbrainz.org") return new Response(JSON.stringify({ recordings: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.hostname === "ws.audioscrobbler.com" && init.method === "POST") {
    return new Response(JSON.stringify({ scrobbles: { "@attr": { accepted: "0", ignored: "1" }, scrobble: [{ artist: { "#text": "Artist", corrected: "0" }, track: { "#text": "New", corrected: "0" }, album: { "#text": "Album", corrected: "0" }, albumArtist: { "#text": "Artist", corrected: "0" }, ignoredMessage: { code: "2", "#text": "Daily scrobble limit exceeded" } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === "ws.audioscrobbler.com") return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  throw new Error(`Unexpected request: ${url}`);
};

await worker.scheduled({}, env, {});
globalThis.fetch = realFetch;
const after = JSON.parse(kv.values.get("ledger:v1"));
if (after.pending_scrobbles?.length !== 1) throw new Error("Ignored Last.fm scrobble was removed from the persistent queue");
if (after.recent_scrobbles?.length !== 0) throw new Error("Ignored Last.fm scrobble was recorded as successful");
if (!String(after.stats?.last_error_message).includes("ignored_2")) throw new Error("Ignored message details were not retained");

console.log(JSON.stringify({ ok: true, pending: after.pending_scrobbles.length, last_error: after.stats.last_error_message }, null, 2));
