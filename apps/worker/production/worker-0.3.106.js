// src/apple.ts
var API_BASE = "https://api.music.apple.com/v1";
var PAGE_SIZE = 30;
var MAX_OFFSET = 90;
var RECENT_TRACK_TYPES = "songs,library-songs";
var HISTORY_SOURCE_VERSION = 2;
var MIGRATION_RECOVERY_KEY = `migration-recovery:v${HISTORY_SOURCE_VERSION}`;
var STATUS_FALLBACK_STALE_MS = 3 * 60 * 1e3;
var STATUS_FALLBACK_COOLDOWN_MS = 90 * 1e3;
var LAST_STATUS_FALLBACK_AT = 0;
var TokenExpiredError = class extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. Re-open the aScrobble desktop app to re-authenticate with Apple Music."
    );
    this.name = "TokenExpiredError";
  }
};
var SPOOFED_HEADERS = {
  Origin: "https://music.apple.com",
  Referer: "https://music.apple.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
};
var APPLE_TOKEN_REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1e3;
var APPLE_TOKEN_REFRESH_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1e3;
var KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED = "apple_dev_token_refresh_checked_iso";
function decodeJwtJson(token, partIndex) {
  try {
    let encoded = token.split(".")[partIndex]?.replace(/-/g, "+").replace(/_/g, "/") ?? "";
    while (encoded.length % 4) encoded += "=";
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
}
function appleDeveloperTokenNeedsRefresh(token, now = Date.now()) {
  const payload = decodeJwtJson(token, 1);
  return !payload?.exp || payload.exp * 1e3 - now <= APPLE_TOKEN_REFRESH_AHEAD_MS;
}
async function fetchAppleWebDeveloperToken() {
  const homeResponse = await fetch("https://music.apple.com/", {
    headers: { ...SPOOFED_HEADERS, Accept: "text/html,application/xhtml+xml" }
  });
  if (!homeResponse.ok) throw new Error(`apple_music_home_http_${homeResponse.status}`);
  const html = await homeResponse.text();
  const scriptMatches = [...html.matchAll(/src=["']([^"']*\/assets\/index~[^"']+\.js[^"']*)["']/gi)];
  if (scriptMatches.length === 0) throw new Error("apple_music_index_script_not_found");
  const scriptUrl = new URL(scriptMatches[0][1], "https://music.apple.com/").toString();
  const scriptResponse = await fetch(scriptUrl, {
    headers: { ...SPOOFED_HEADERS, Accept: "application/javascript,*/*;q=0.8" }
  });
  if (!scriptResponse.ok) throw new Error(`apple_music_index_http_${scriptResponse.status}`);
  const script = await scriptResponse.text();
  const candidates = script.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
  let bestToken = null;
  let bestExpiry = 0;
  for (const candidate of new Set(candidates)) {
    const header = decodeJwtJson(candidate, 0);
    const payload = decodeJwtJson(candidate, 1);
    if (header?.kid !== "WebPlayKid" || payload?.iss !== "AMPWebPlay") continue;
    const expiry = Number(payload.exp ?? 0);
    if (expiry > bestExpiry) {
      bestToken = candidate;
      bestExpiry = expiry;
    }
  }
  if (!bestToken || bestExpiry * 1e3 <= Date.now()) {
    throw new Error("valid_apple_web_developer_token_not_found");
  }
  return bestToken;
}
async function refreshAppleDeveloperToken(env, currentToken, force = false) {
  const now = Date.now();
  if (!force && !appleDeveloperTokenNeedsRefresh(currentToken, now)) return currentToken;
  const lastCheckedIso = await env.ASCROBBLE_STATE.get(KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED);
  const lastChecked = lastCheckedIso ? new Date(lastCheckedIso).getTime() : 0;
  if (!force && lastChecked && now - lastChecked < APPLE_TOKEN_REFRESH_CHECK_COOLDOWN_MS) {
    return currentToken;
  }
  const freshToken = await fetchAppleWebDeveloperToken();
  await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED, new Date(now).toISOString());
  const currentExpiry = Number(decodeJwtJson(currentToken, 1)?.exp ?? 0);
  const freshExpiry = Number(decodeJwtJson(freshToken, 1)?.exp ?? 0);
  if (freshExpiry > currentExpiry || currentExpiry * 1e3 <= now) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_DEV_TOKEN, freshToken);
    return freshToken;
  }
  return currentToken;
}
function normalizeAlbumName(rawAlbum) {
  if (!rawAlbum) return "";
  return rawAlbum.replace(/ - (EP|Single)$/i, "").trim();
}
async function fetchTrackPlayCount(devToken, musicUserToken, isrc) {
  const url = `${API_BASE}/me/library/songs?filter[isrc]=${encodeURIComponent(isrc)}&fields[library-songs]=playCount&limit=1`;
  const headers = {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS
  };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const json2 = await response.json();
    const count = json2.data?.[0]?.attributes?.playCount;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}
async function fetchRecentlyPlayed(devToken, musicUserToken, diagnostic = null) {
  const tracks = [];
  const headers = {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS
  };
  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
    const url = `${API_BASE}/me/recent/played/tracks?limit=${PAGE_SIZE}&offset=${offset}&types=${encodeURIComponent(RECENT_TRACK_TYPES)}`;
    const page = diagnostic ? { offset, requested_at: new Date().toISOString(), path: new URL(url).pathname + new URL(url).search } : null;
    if (page) diagnostic.apple_pages.push(page);
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (e) {
      if (page) { page.failure = "network_error"; page.finished_at = new Date().toISOString(); }
      console.warn(`Apple fetch failed at offset ${offset}:`, e);
      break;
    }
    if (page) { page.status = response.status; page.finished_at = new Date().toISOString(); page.headers = Object.fromEntries(["date", "age", "etag", "cache-control", "x-cache", "x-apple-request-uuid"].map(k => [k, response.headers.get(k)])); }
    if (response.status === 401) throw new TokenExpiredError();
    if (!response.ok) {
      const body = await response.text();
      console.warn(
        `Apple API ${response.status} at offset ${offset}: ${body.slice(0, 200)}`
      );
      break;
    }
    const json2 = await response.json();
    const items = json2.data ?? [];
    if (page) { page.count = items.length; page.next = json2.next ?? null; page.items = items.map(item => ({ id: item.id, type: item.type, attributes: Object.fromEntries(["name", "artistName", "albumName", "albumArtistName", "durationInMillis", "isrc", "releaseDate", "discNumber", "trackNumber", "playCount", "lastPlayedDate", "playParams"].filter(k => item.attributes?.[k] !== undefined).map(k => [k, item.attributes[k]])) })); }
    if (items.length === 0) break;
    for (const item of items) {
      if (!item.id) continue;
      const attrs = item.attributes ?? {};
      const rawAlbum = attrs.albumName ?? "";
      tracks.push({
        id: item.id,
        type: item.type,
        name: attrs.name ?? "",
        artist: attrs.artistName ?? "",
        album_artist: attrs.albumArtistName ?? attrs.artistName ?? "",
        album: normalizeAlbumName(rawAlbum),
        _apple_raw_album: rawAlbum,
        duration_ms: attrs.durationInMillis ?? 18e4,
        isrc: attrs.isrc,
        catalog_id: item.type === "songs" ? item.id : attrs.playParams?.catalogId ?? null
      });
    }
    if (items.length < PAGE_SIZE) break;
  }
  const deduped = [];
  for (let i = 0; i < tracks.length; i++) {
    if (i > 0 && i % PAGE_SIZE === 0 && tracks[i - 1].id === tracks[i].id) {
      continue;
    }
    deduped.push(tracks[i]);
  }
  return deduped;
}

// src/detect.ts
function appleHistoryTrackIdentity(track) {
  const catalogId = track?.catalog_id ?? (track?.type === "songs" ? track?.id : null);
  if (catalogId) return `catalog|${catalogId}`;
  if (track?.isrc) return `isrc|${String(track.isrc).toUpperCase()}`;
  return `resource|${track?.type ?? "unknown"}|${track?.id ?? ""}`;
}
function detectPlays(current, previous, _elapsedSeconds = 180, prevState = {}) {
  if (previous.length === 0) {
    const plays = [...current].reverse().map((track) => ({ track, kind: "new" }));
    return {
      plays,
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }
  const k = findShift(current, previous);
  if (k !== null && k > 0) {
    const newPlays = [];
    for (let i = 0; i < k; i++) {
      newPlays.push({ track: current[i], kind: "new" });
    }
    return {
      plays: newPlays.reverse(),
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }
  if (current.length >= 2 && previous.length >= 2 && appleHistoryTrackIdentity(current[0]) === appleHistoryTrackIdentity(previous[0])) {
    const curTail = current.slice(1);
    const prevTail = previous.slice(1);
    const tailShift = findShift(curTail, prevTail);
    if (tailShift !== null && tailShift > 0) {
      const interimPlays = [];
      for (let i = 0; i < tailShift; i++) {
        interimPlays.push({ track: curTail[i], kind: "top-rebound" });
      }
      interimPlays.push({ track: current[0], kind: "top-rebound" });
      return {
        plays: interimPlays.reverse(),
        newState: { stationaryIdle: false, handledCount: (prevState.handledCount ?? 1) + 1, position0ElapsedSec: 0 }
      };
    }
  }
  if (current.length > 0 && previous.length > 0 && appleHistoryTrackIdentity(current[0]) === appleHistoryTrackIdentity(previous[0])) {
    return {
      plays: [],
      newState: {
        stationaryIdle: true,
        handledCount: prevState.handledCount ?? 1,
        position0ElapsedSec: 0
      }
    };
  }
  if (findMoveToFront(current, previous) !== null) {
    return {
      plays: [{ track: current[0], kind: "move-to-front" }],
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }
  const fallback = fallbackDetect(current, previous);
  return {
    plays: fallback,
    newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
  };
}
function findMoveToFront(current, previous) {
  if (current.length < 2 || current.length !== previous.length) return null;
  const before = previous.map(appleHistoryTrackIdentity);
  const after = current.map(appleHistoryTrackIdentity);
  // Require a unique identity and an exact single move, not a general reorder.
  if (new Set(before).size !== before.length || new Set(after).size !== after.length) return null;
  const from = before.indexOf(after[0]);
  if (from <= 0) return null;
  const expected = [before[from], ...before.slice(0, from), ...before.slice(from + 1)];
  return after.every((id, i) => id === expected[i]) ? from : null;
}
function selectHistoryBaseline(current, previous) {
  // A strict suffix contains no evidence of a new play. Do not forget the
  // vanished head: restoring that same snapshot must not create a new play.
  const removed = previous.length - current.length;
  if (removed > 0 && current.every((track, i) =>
    appleHistoryTrackIdentity(track) === appleHistoryTrackIdentity(previous[removed + i]))) {
    return previous;
  }
  return current;
}
function findShift(current, previous) {
  const curLen = current.length;
  const prevLen = previous.length;
  for (let k = 0; k < curLen; k++) {
    const suffixLen = curLen - k;
    if (suffixLen > prevLen) continue;
    let match = true;
    for (let i = 0; i < suffixLen; i++) {
      if (appleHistoryTrackIdentity(current[k + i]) !== appleHistoryTrackIdentity(previous[i])) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return null;
}
function fallbackDetect(current, previous) {
  const previousIds = new Set(previous.map(appleHistoryTrackIdentity));
  const detected = [];
  for (const track of current) {
    if (previousIds.has(appleHistoryTrackIdentity(track))) break;
    detected.push({ track, kind: "new" });
  }
  return detected.reverse();
}
function filterImplausibleInferredRepeats(plays, elapsedSeconds) {
  const inferred = plays.filter((play) => play.kind === "repeat" || play.kind === "top-rebound");
  if (inferred.length === 0) return { plays, dropped: 0 };
  const minimumListeningSeconds = inferred.reduce((sum, play) => {
    const durationSeconds = Number(play.track?.duration_ms ?? DEFAULT_DURATION_MS) / 1e3;
    return sum + Math.min(Math.max(durationSeconds / 2, 30), 240);
  }, 0);
  const plausibleWindowSeconds = Math.max(Number(elapsedSeconds ?? 0), 0) + 60;
  if (minimumListeningSeconds <= plausibleWindowSeconds) return { plays, dropped: 0 };
  const safePlays = plays.filter((play) => play.kind !== "repeat" && play.kind !== "top-rebound");
  return { plays: safePlays, dropped: plays.length - safePlays.length };
}

// src/timestamps.ts
var DEFAULT_DURATION_MS = 18e4;
var HEAD_OFFSET_SECONDS = 10;
function assignTimestamps(plays, runTime, lastRunTime) {
  if (plays.length === 0) return plays;
  const floor = lastRunTime ?? new Date(runTime.getTime() - 6 * 60 * 60 * 1e3);
  const windowSeconds = Math.max(
    1,
    (runTime.getTime() - floor.getTime()) / 1e3 - HEAD_OFFSET_SECONDS
  );
  const totalDurationSeconds = plays.reduce(
    (sum, p) => sum + (p.track.duration_ms || DEFAULT_DURATION_MS) / 1e3,
    0
  );
  const scale = totalDurationSeconds > windowSeconds ? windowSeconds / totalDurationSeconds : 1;
  let cumulative = HEAD_OFFSET_SECONDS;
  const reversed = [];
  for (let i = plays.length - 1; i >= 0; i--) {
    const play = plays[i];
    const durationSeconds = (play.track.duration_ms || DEFAULT_DURATION_MS) / 1e3 * scale;
    const timestamp = new Date(
      runTime.getTime() - (cumulative + durationSeconds) * 1e3
    );
    cumulative += durationSeconds;
    reversed.push({ ...play, timestamp });
  }
  return reversed.reverse();
}

// src/md5.ts
function cmn(q, a, b, x, s, t) {
  a = (a + q | 0) + (x + t | 0) | 0;
  return (a << s | a >>> 32 - s) + b | 0;
}
function ff(a, b, c, d, x, s, t) {
  return cmn(b & c | ~b & d, a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
  return cmn(b & d | c & ~d, a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
function md5cycle(x, k) {
  let [a, b, c, d] = x;
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);
  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);
  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);
  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);
  x[0] = x[0] + a | 0;
  x[1] = x[1] + b | 0;
  x[2] = x[2] + c | 0;
  x[3] = x[3] + d | 0;
}
function md51(bytes) {
  const n = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  const tail = new Array(16);
  for (i = 64; i <= n; i += 64) {
    md5blk(bytes, i - 64, tail);
    md5cycle(state, tail);
  }
  const bufLen = n - (i - 64);
  for (let j = 0; j < 16; j++) tail[j] = 0;
  for (let j = 0; j < bufLen; j++) {
    tail[j >> 2] |= bytes[i - 64 + j] << (j % 4 << 3);
  }
  tail[bufLen >> 2] |= 128 << (bufLen % 4 << 3);
  if (bufLen > 55) {
    md5cycle(state, tail);
    for (let j = 0; j < 16; j++) tail[j] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}
function md5blk(bytes, offset, out) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    out[i] = bytes[j] | bytes[j + 1] << 8 | bytes[j + 2] << 16 | bytes[j + 3] << 24;
  }
}
function rhex(n) {
  const hex = "0123456789abcdef";
  let s = "";
  for (let j = 0; j < 4; j++) {
    s += hex[n >> j * 8 + 4 & 15] + hex[n >> j * 8 & 15];
  }
  return s;
}
function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const state = md51(bytes);
  return state.map(rhex).join("");
}

// src/lastfm.ts
var API_URL = "https://ws.audioscrobbler.com/2.0/";
var BATCH_SIZE = 50;
var LASTFM_PLACEHOLDER_IMAGE_HASH = "2a96cbd8b46e442fc41c2b86b821562f";
function lastFmAlbumHasRealArtwork(album) {
  const images = album?.image ?? [];
  return images.some((entry) => {
    const url = entry?.["#text"] ?? "";
    return url.length > 0 && !url.includes(LASTFM_PLACEHOLDER_IMAGE_HASH);
  });
}
async function getLastFmAlbumInfo(apiKey, artist, album) {
  if (!artist || !album) return null;
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    method: "album.getInfo",
    api_key: apiKey,
    artist,
    album,
    autocorrect: "1",
    format: "json"
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8e3) });
  if (!response.ok) return null;
  const data = await response.json();
  return lastFmAlbumHasRealArtwork(data.album) ? data.album : null;
}
async function searchLastFmAlbums(apiKey, album) {
  if (!album) return [];
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    method: "album.search",
    api_key: apiKey,
    album,
    limit: "30",
    format: "json"
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8e3) });
  if (!response.ok) return [];
  const data = await response.json();
  const matches = data.results?.albummatches?.album;
  return Array.isArray(matches) ? matches : matches ? [matches] : [];
}
async function getLastFmTrackAlbumInfo(apiKey, artist, track) {
  if (!artist || !track) return null;
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    method: "track.getInfo",
    api_key: apiKey,
    artist,
    track,
    autocorrect: "1",
    format: "json"
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8e3) });
  if (!response.ok) return null;
  const data = await response.json();
  return lastFmAlbumHasRealArtwork(data.track?.album) ? data.track.album : null;
}
async function getLastFmTrackInfo(apiKey, artist, track) {
  if (!artist || !track) return null;
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    method: "track.getInfo",
    api_key: apiKey,
    artist,
    track,
    autocorrect: "1",
    format: "json"
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8e3) });
  if (!response.ok) return null;
  const data = await response.json();
  return data.track?.name ? data.track : null;
}
// Comparison only: OpenCC 1.1.9 TSCharacters (Apache-2.0), unambiguous mappings.
// https://github.com/BYVoid/OpenCC/blob/ver.1.1.9/data/dictionary/TSCharacters.txt
var CHINESE_COMPARISON_MAP = {"㑮":"𫝈","㑯":"㑔","㑳":"㑇","㑶":"㐹","㒓":"𠉂","㓄":"𪠟","㓨":"刾","㔋":"𪟎","㖮":"𪠵","㗲":"𠵾","㗿":"𪡛","㘉":"𠰱","㘓":"𪢌","㘔":"𫬐","㘚":"㘎","㛝":"𫝦","㜄":"㚯","㜏":"㛣","㜐":"𫝧","㜗":"𡞋","㜢":"𡞱","㜷":"𡝠","㞞":"𪨊","㟺":"𪩇","㠏":"㟆","㠣":"𫵷","㢗":"𪪑","㢝":"𢋈","㥮":"㤘","㦎":"𢛯","㦛":"𢗓","㦞":"𪫷","㨻":"𪮃","㩋":"𪮋","㩜":"㨫","㩳":"㧐","㩵":"擜","㪎":"𪯋","㯤":"𣘐","㰙":"𣗙","㵗":"𣳆","㵾":"𪷍","㶆":"𫞛","㷍":"𤆢","㷿":"𤈷","㸇":"𤎺","㹽":"𫞣","㺏":"𤠋","㺜":"𪺻","㻶":"𪼋","㿖":"𪽮","㿗":"𤻊","㿧":"𤽯","䀉":"𥁢","䀹":"𥅴","䁪":"𥇢","䁻":"䀥","䂎":"𥎝","䃮":"鿎","䅐":"𫀨","䅳":"𫀬","䆉":"𫁂","䉑":"𫁲","䉙":"𥬀","䉬":"𫂈","䉲":"𥮜","䉶":"𫁷","䊭":"𥺅","䊷":"䌶","䊺":"𫄚","䋃":"𫄜","䋔":"𫄞","䋙":"䌺","䋚":"䌻","䋦":"𫄩","䋹":"䌿","䋻":"䌾","䋼":"𫄮","䋿":"𦈓","䌈":"𦈖","䌋":"𦈘","䌖":"𦈜","䌝":"𦈟","䌟":"𦈞","䌥":"𦈠","䌰":"𦈙","䍤":"𫅅","䍦":"䍠","䍽":"𦍠","䎙":"𫅭","䎱":"䎬","䓣":"𬜯","䕤":"𫟕","䕳":"𦰴","䖅":"𫟑","䗅":"𫊪","䗿":"𧉞","䙔":"𫋲","䙡":"䙌","䙱":"𧜭","䚩":"𫌯","䛄":"𫍠","䛳":"𫍫","䜀":"䜧","䜖":"𫟢","䝭":"𫎧","䝻":"𧹕","䝼":"䞍","䞈":"𧹑","䞋":"𫎪","䞓":"𫎭","䟃":"𫎺","䟆":"𫎳","䟐":"𫎱","䠆":"𫏃","䠱":"𨅛","䡐":"𫟤","䡩":"𫟥","䡵":"𫟦","䢨":"𨑹","䤤":"𫟺","䥄":"𫠀","䥇":"䦂","䥑":"鿏","䥕":"𬭯","䥗":"𫔋","䥩":"𨱖","䥯":"𫔆","䥱":"䥾","䦘":"𨸄","䦛":"䦶","䦟":"䦷","䦯":"𫔵","䦳":"𨷿","䧢":"𨸟","䪊":"𫖅","䪏":"𩏼","䪗":"𩐀","䪘":"𩏿","䪴":"𫖫","䪾":"𫖬","䫀":"𫖱","䫂":"𫖰","䫟":"𫖲","䫴":"𩖗","䫶":"𫖺","䫻":"𫗇","䫾":"𫠈","䬓":"𫗊","䬘":"𩙮","䬝":"𩙯","䬞":"𩙧","䬧":"𫗟","䭀":"𩠇","䭃":"𩠈","䭑":"𫗱","䭔":"𫗰","䭿":"𩧭","䮄":"𫠊","䮝":"𩧰","䮞":"𩨁","䮠":"𩧿","䮫":"𩨇","䮰":"𫘮","䮳":"𩨏","䮾":"𩧪","䯀":"䯅","䯤":"𩩈","䰾":"鲃","䱀":"𫚐","䱁":"𫚏","䱙":"𩾈","䱧":"𫚠","䱬":"𩾊","䱰":"𩾋","䱷":"䲣","䱸":"𫠑","䱽":"䲝","䲁":"鳚","䲅":"𫚜","䲖":"𩾂","䲘":"鳤","䲰":"𪉂","䳜":"𫛬","䳢":"𫛰","䳤":"𫛮","䳧":"𫛺","䳫":"𫛼","䴉":"鹮","䴋":"𫜅","䴬":"𪎈","䴱":"𫜒","䴴":"𪎋","䴽":"𫜔","䵳":"𪑅","䵴":"𫜙","䶕":"𫜨","䶲":"𫜳","丟":"丢","並":"并","亂":"乱","亙":"亘","亞":"亚","佇":"伫","佈":"布","佔":"占","併":"并","來":"来","侖":"仑","侶":"侣","侷":"局","俁":"俣","係":"系","俓":"𠇹","俔":"伣","俠":"侠","俥":"伡","俬":"私","倀":"伥","倆":"俩","倈":"俫","倉":"仓","個":"个","們":"们","倖":"幸","倫":"伦","倲":"㑈","偉":"伟","偑":"㐽","側":"侧","偵":"侦","偽":"伪","傌":"㐷","傑":"杰","傖":"伧","傘":"伞","備":"备","傢":"家","傭":"佣","傯":"偬","傳":"传","傴":"伛","債":"债","傷":"伤","傾":"倾","僂":"偻","僅":"仅","僉":"佥","僑":"侨","僕":"仆","僞":"伪","僤":"𫢸","僥":"侥","僨":"偾","僱":"雇","價":"价","儀":"仪","儁":"俊","儂":"侬","億":"亿","儈":"侩","儉":"俭","儎":"傤","儐":"傧","儔":"俦","儕":"侪","償":"偿","儣":"𠆲","優":"优","儭":"𠋆","儲":"储","儷":"俪","儸":"㑩","儺":"傩","儻":"傥","儼":"俨","兇":"凶","兌":"兑","兒":"儿","兗":"兖","內":"内","兩":"两","冊":"册","冑":"胄","冪":"幂","凈":"净","凍":"冻","凙":"𪞝","凜":"凛","凱":"凯","別":"别","刪":"删","剄":"刭","則":"则","剎":"刹","剗":"刬","剛":"刚","剝":"剥","剮":"剐","剴":"剀","創":"创","剷":"铲","剾":"𠛅","劇":"剧","劉":"刘","劊":"刽","劌":"刿","劍":"剑","劏":"㓥","劑":"剂","劚":"㔉","勁":"劲","勑":"𠡠","動":"动","務":"务","勛":"勋","勝":"胜","勞":"劳","勢":"势","勣":"𪟝","勩":"勚","勱":"劢","勳":"勋","勵":"励","勸":"劝","勻":"匀","匭":"匦","匯":"汇","匱":"匮","區":"区","協":"协","卹":"恤","卻":"却","卽":"即","厙":"厍","厠":"厕","厤":"历","厭":"厌","厲":"厉","厴":"厣","參":"参","叄":"叁","叢":"丛","吒":"咤","吳":"吴","吶":"呐","呂":"吕","咼":"呙","員":"员","哯":"𠯟","唄":"呗","唓":"𪠳","唸":"念","問":"问","啓":"启","啞":"哑","啟":"启","啢":"唡","喎":"㖞","喚":"唤","喪":"丧","喫":"吃","喬":"乔","單":"单","喲":"哟","嗆":"呛","嗇":"啬","嗊":"唝","嗎":"吗","嗚":"呜","嗩":"唢","嗰":"𠮶","嗶":"哔","嗹":"𪡏","嘆":"叹","嘍":"喽","嘓":"啯","嘔":"呕","嘖":"啧","嘗":"尝","嘜":"唛","嘩":"哗","嘪":"𪡃","嘮":"唠","嘯":"啸","嘰":"叽","嘳":"𪡞","嘵":"哓","嘸":"呒","嘺":"𪡀","嘽":"啴","噅":"𠯠","噓":"嘘","噚":"㖊","噝":"咝","噞":"𪡋","噠":"哒","噥":"哝","噦":"哕","噯":"嗳","噲":"哙","噴":"喷","噸":"吨","嚀":"咛","嚇":"吓","嚌":"哜","嚐":"尝","嚕":"噜","嚙":"啮","嚛":"𪠸","嚥":"咽","嚦":"呖","嚧":"𠰷","嚨":"咙","嚮":"向","嚲":"亸","嚳":"喾","嚴":"严","嚶":"嘤","嚽":"𪢕","囀":"啭","囁":"嗫","囂":"嚣","囃":"𠱞","囅":"冁","囈":"呓","囉":"啰","囌":"苏","囑":"嘱","囒":"𪢠","囪":"囱","圇":"囵","國":"国","圍":"围","園":"园","圓":"圆","圖":"图","團":"团","圞":"𪢮","垻":"坝","埡":"垭","埨":"𫭢","埬":"𪣆","埰":"采","執":"执","堅":"坚","堊":"垩","堖":"垴","堚":"𪣒","堝":"埚","堯":"尧","報":"报","場":"场","塊":"块","塋":"茔","塏":"垲","塒":"埘","塗":"涂","塚":"冢","塢":"坞","塤":"埙","塵":"尘","塸":"𫭟","塹":"堑","塿":"𪣻","墊":"垫","墜":"坠","墠":"𫮃","墮":"堕","墰":"坛","墲":"𪢸","墳":"坟","墶":"垯","墻":"墙","墾":"垦","壇":"坛","壈":"𡒄","壋":"垱","壎":"埙","壓":"压","壗":"𡋤","壘":"垒","壙":"圹","壚":"垆","壜":"坛","壞":"坏","壟":"垄","壠":"垅","壢":"坜","壣":"𪤚","壩":"坝","壪":"塆","壯":"壮","壺":"壶","壼":"壸","壽":"寿","夠":"够","夢":"梦","夾":"夹","奐":"奂","奧":"奥","奩":"奁","奪":"夺","奬":"奖","奮":"奋","奼":"姹","妝":"妆","姍":"姗","姦":"奸","娙":"𫰛","娛":"娱","婁":"娄","婡":"𫝫","婦":"妇","婭":"娅","媈":"𫝨","媧":"娲","媯":"妫","媰":"㛀","媼":"媪","媽":"妈","嫋":"袅","嫗":"妪","嫵":"妩","嫺":"娴","嫻":"娴","嫿":"婳","嬀":"妫","嬃":"媭","嬇":"𫝬","嬈":"娆","嬋":"婵","嬌":"娇","嬙":"嫱","嬡":"嫒","嬣":"𪥰","嬤":"嬷","嬦":"𫝩","嬪":"嫔","嬰":"婴","嬸":"婶","嬻":"𪥿","孃":"娘","孄":"𫝮","孆":"𫝭","孇":"𪥫","孋":"㛤","孌":"娈","孎":"𡠟","孫":"孙","學":"学","孻":"𡥧","孾":"𪧀","孿":"孪","宮":"宫","寀":"采","寠":"𪧘","寢":"寝","實":"实","寧":"宁","審":"审","寫":"写","寬":"宽","寵":"宠","寶":"宝","將":"将","專":"专","尋":"寻","對":"对","導":"导","尷":"尴","屆":"届","屍":"尸","屓":"屃","屜":"屉","屢":"屡","層":"层","屨":"屦","屩":"𪨗","屬":"属","岡":"冈","峯":"峰","峴":"岘","島":"岛","峽":"峡","崍":"崃","崑":"昆","崗":"岗","崢":"峥","崬":"岽","嵐":"岚","嵗":"岁","嵼":"𡶴","嵽":"𫶇","嵾":"㟥","嶁":"嵝","嶄":"崭","嶇":"岖","嶈":"𡺃","嶔":"嵚","嶗":"崂","嶘":"𡺄","嶠":"峤","嶢":"峣","嶧":"峄","嶨":"峃","嶮":"崄","嶸":"嵘","嶹":"𫝵","嶺":"岭","嶼":"屿","嶽":"岳","巊":"𪩎","巋":"岿","巒":"峦","巔":"巅","巖":"岩","巗":"𪨷","巘":"𪩘","巰":"巯","巹":"卺","帥":"帅","師":"师","帳":"帐","帶":"带","幀":"帧","幃":"帏","幓":"㡎","幗":"帼","幘":"帻","幝":"𪩷","幟":"帜","幣":"币","幩":"𪩸","幫":"帮","幬":"帱","幹":"干","幾":"几","庫":"库","廁":"厕","廂":"厢","廄":"厩","廈":"厦","廎":"庼","廕":"荫","廚":"厨","廝":"厮","廞":"𫷷","廟":"庙","廠":"厂","廡":"庑","廢":"废","廣":"广","廧":"𪪞","廩":"廪","廳":"厅","弒":"弑","弔":"吊","弳":"弪","張":"张","強":"强","彃":"𪪼","彄":"𫸩","彆":"别","彈":"弹","彌":"弥","彎":"弯","彔":"录","彙":"汇","彠":"彟","彥":"彦","彫":"雕","彲":"彨","彿":"佛","後":"后","徑":"径","從":"从","徠":"徕","復":"复","徹":"彻","徿":"𪫌","恆":"恒","恥":"耻","悅":"悦","悞":"悮","悵":"怅","悶":"闷","悽":"凄","惡":"恶","惱":"恼","惲":"恽","惻":"恻","愛":"爱","愜":"惬","愨":"悫","愴":"怆","愷":"恺","愻":"𢙏","愾":"忾","慄":"栗","態":"态","慍":"愠","慘":"惨","慚":"惭","慟":"恸","慣":"惯","慤":"悫","慪":"怄","慫":"怂","慮":"虑","慳":"悭","慶":"庆","慺":"㥪","慼":"戚","慾":"欲","憂":"忧","憊":"惫","憐":"怜","憑":"凭","憒":"愦","憖":"慭","憚":"惮","憢":"𢙒","憤":"愤","憫":"悯","憮":"怃","憲":"宪","憶":"忆","憸":"𪫺","憹":"𢙐","懀":"𢙓","懇":"恳","應":"应","懌":"怿","懍":"懔","懎":"𢠁","懞":"蒙","懟":"怼","懣":"懑","懤":"㤽","懨":"恹","懲":"惩","懶":"懒","懷":"怀","懸":"悬","懺":"忏","懼":"惧","懾":"慑","戀":"恋","戇":"戆","戔":"戋","戧":"戗","戩":"戬","戱":"戯","戲":"戏","戶":"户","拋":"抛","挩":"捝","挱":"挲","挾":"挟","捨":"舍","捫":"扪","捱":"挨","捲":"卷","掃":"扫","掄":"抡","掆":"㧏","掗":"挜","掙":"挣","掚":"𪭵","掛":"挂","採":"采","揀":"拣","揚":"扬","換":"换","揮":"挥","揯":"搄","損":"损","搖":"摇","搗":"捣","搵":"揾","搶":"抢","摋":"𢫬","摐":"𪭢","摑":"掴","摜":"掼","摟":"搂","摯":"挚","摳":"抠","摶":"抟","摺":"折","摻":"掺","撈":"捞","撊":"𪭾","撏":"挦","撐":"撑","撓":"挠","撝":"㧑","撟":"挢","撣":"掸","撥":"拨","撧":"𪮖","撫":"抚","撲":"扑","撳":"揿","撻":"挞","撾":"挝","撿":"捡","擁":"拥","擄":"掳","擇":"择","擊":"击","擋":"挡","擓":"㧟","擔":"担","據":"据","擟":"𪭧","擠":"挤","擫":"𢬍","擬":"拟","擯":"摈","擰":"拧","擱":"搁","擲":"掷","擴":"扩","擷":"撷","擺":"摆","擻":"擞","擼":"撸","擽":"㧰","擾":"扰","攄":"摅","攆":"撵","攋":"𪮶","攏":"拢","攔":"拦","攖":"撄","攙":"搀","攛":"撺","攜":"携","攝":"摄","攢":"攒","攣":"挛","攤":"摊","攪":"搅","攬":"揽","敎":"教","敓":"敚","敗":"败","敘":"叙","敵":"敌","數":"数","斂":"敛","斃":"毙","斅":"𢽾","斆":"敩","斕":"斓","斬":"斩","斷":"断","斸":"𣃁","旂":"旗","旣":"既","昇":"升","時":"时","晉":"晋","晛":"𬀪","晝":"昼","暈":"晕","暉":"晖","暐":"𬀩","暘":"旸","暢":"畅","暫":"暂","曄":"晔","曆":"历","曇":"昙","曉":"晓","曊":"𪰶","曏":"向","曖":"暧","曠":"旷","曥":"𣆐","曨":"昽","曬":"晒","書":"书","會":"会","朥":"𦛨","朧":"胧","朮":"术","東":"东","枴":"拐","柵":"栅","柺":"拐","査":"查","桱":"𣐕","桿":"杆","梔":"栀","梖":"𪱷","梘":"枧","梜":"𬂩","條":"条","梟":"枭","梲":"棁","棄":"弃","棊":"棋","棖":"枨","棗":"枣","棟":"栋","棡":"㭎","棧":"栈","棲":"栖","棶":"梾","椏":"桠","椲":"㭏","楇":"𣒌","楊":"杨","楓":"枫","楨":"桢","業":"业","極":"极","榘":"矩","榦":"干","榪":"杩","榮":"荣","榲":"榅","榿":"桤","構":"构","槍":"枪","槓":"杠","槤":"梿","槧":"椠","槨":"椁","槫":"𣏢","槮":"椮","槳":"桨","槶":"椢","槼":"椝","樁":"桩","樂":"乐","樅":"枞","樑":"梁","樓":"楼","標":"标","樞":"枢","樠":"𣗊","樢":"㭤","樣":"样","樤":"𣔌","樧":"榝","樫":"㭴","樳":"桪","樸":"朴","樹":"树","樺":"桦","樿":"椫","橈":"桡","橋":"桥","機":"机","橢":"椭","橫":"横","橯":"𣓿","檁":"檩","檉":"柽","檔":"档","檜":"桧","檟":"槚","檢":"检","檣":"樯","檭":"𣘴","檮":"梼","檯":"台","檳":"槟","檵":"𪲛","檸":"柠","檻":"槛","櫃":"柜","櫅":"𪲎","櫍":"𬃊","櫓":"橹","櫚":"榈","櫛":"栉","櫝":"椟","櫞":"橼","櫟":"栎","櫠":"𪲮","櫥":"橱","櫧":"槠","櫨":"栌","櫪":"枥","櫫":"橥","櫬":"榇","櫱":"蘖","櫳":"栊","櫸":"榉","櫻":"樱","欄":"栏","欅":"榉","欇":"𪳍","權":"权","欍":"𣐤","欏":"椤","欐":"𪲔","欑":"𪴙","欒":"栾","欓":"𣗋","欖":"榄","欘":"𣚚","欞":"棂","欽":"钦","歎":"叹","歐":"欧","歟":"欤","歡":"欢","歲":"岁","歷":"历","歸":"归","歿":"殁","殘":"残","殞":"殒","殢":"𣨼","殤":"殇","殨":"㱮","殫":"殚","殭":"僵","殮":"殓","殯":"殡","殰":"㱩","殲":"歼","殺":"杀","殻":"壳","殼":"壳","毀":"毁","毆":"殴","毊":"𪵑","毿":"毵","氂":"牦","氈":"毡","氌":"氇","氣":"气","氫":"氢","氬":"氩","氭":"𣱝","氳":"氲","氾":"泛","汎":"泛","汙":"污","決":"决","沒":"没","沖":"冲","況":"况","泝":"溯","洩":"泄","洶":"汹","浹":"浃","浿":"𬇙","涇":"泾","涗":"涚","涼":"凉","淒":"凄","淚":"泪","淥":"渌","淨":"净","淩":"凌","淪":"沦","淵":"渊","淶":"涞","淺":"浅","渙":"涣","減":"减","渢":"沨","渦":"涡","測":"测","渾":"浑","湊":"凑","湋":"𣲗","湞":"浈","湧":"涌","湯":"汤","溈":"沩","準":"准","溝":"沟","溡":"𪶄","溫":"温","溮":"浉","溳":"涢","溼":"湿","滄":"沧","滅":"灭","滌":"涤","滎":"荥","滙":"汇","滬":"沪","滯":"滞","滲":"渗","滷":"卤","滸":"浒","滻":"浐","滾":"滚","滿":"满","漁":"渔","漊":"溇","漍":"𬇹","漚":"沤","漢":"汉","漣":"涟","漬":"渍","漲":"涨","漵":"溆","漸":"渐","漿":"浆","潁":"颍","潑":"泼","潔":"洁","潕":"𣲘","潙":"沩","潚":"㴋","潛":"潜","潣":"𫞗","潤":"润","潯":"浔","潰":"溃","潷":"滗","潿":"涠","澀":"涩","澅":"𣶩","澆":"浇","澇":"涝","澐":"沄","澗":"涧","澠":"渑","澤":"泽","澦":"滪","澩":"泶","澫":"𬇕","澬":"𫞚","澮":"浍","澱":"淀","澾":"㳠","濁":"浊","濃":"浓","濄":"㳡","濆":"𣸣","濕":"湿","濘":"泞","濚":"溁","濛":"蒙","濜":"浕","濟":"济","濤":"涛","濧":"㳔","濫":"滥","濰":"潍","濱":"滨","濺":"溅","濼":"泺","濾":"滤","濿":"𪵱","瀂":"澛","瀃":"𣽷","瀅":"滢","瀆":"渎","瀇":"㲿","瀉":"泻","瀏":"浏","瀕":"濒","瀘":"泸","瀝":"沥","瀟":"潇","瀠":"潆","瀦":"潴","瀧":"泷","瀨":"濑","瀲":"潋","瀾":"澜","灃":"沣","灄":"滠","灍":"𫞝","灑":"洒","灒":"𪷽","灕":"漓","灘":"滩","灙":"𣺼","灝":"灏","灡":"㳕","灣":"湾","灤":"滦","灧":"滟","灩":"滟","災":"灾","為":"为","烏":"乌","烴":"烃","無":"无","煇":"𪸩","煉":"炼","煒":"炜","煙":"烟","煢":"茕","煥":"焕","煩":"烦","煬":"炀","煱":"㶽","熂":"𪸕","熅":"煴","熉":"𤈶","熌":"𤇄","熒":"荧","熓":"𤆡","熗":"炝","熚":"𤇹","熡":"𤋏","熰":"𬉼","熱":"热","熲":"颎","熾":"炽","燀":"𬊤","燁":"烨","燈":"灯","燉":"炖","燒":"烧","燖":"𬊈","燙":"烫","燜":"焖","營":"营","燦":"灿","燬":"毁","燭":"烛","燴":"烩","燶":"㶶","燻":"熏","燼":"烬","燾":"焘","爃":"𫞡","爄":"𤇃","爇":"𦶟","爍":"烁","爐":"炉","爖":"𤇭","爛":"烂","爥":"𪹳","爧":"𫞠","爭":"争","爲":"为","爺":"爷","爾":"尔","牀":"床","牆":"墙","牘":"牍","牽":"牵","犖":"荦","犛":"牦","犞":"𪺭","犢":"犊","犧":"牺","狀":"状","狹":"狭","狽":"狈","猌":"𪺽","猙":"狰","猶":"犹","猻":"狲","獁":"犸","獃":"呆","獄":"狱","獅":"狮","獊":"𪺷","獎":"奖","獨":"独","獩":"𤞃","獪":"狯","獫":"猃","獮":"狝","獰":"狞","獱":"㺍","獲":"获","獵":"猎","獷":"犷","獸":"兽","獺":"獭","獻":"献","獼":"猕","玀":"猡","玁":"𤞤","珼":"𫞥","現":"现","琱":"雕","琺":"珐","琿":"珲","瑋":"玮","瑒":"玚","瑣":"琐","瑤":"瑶","瑩":"莹","瑪":"玛","瑲":"玱","瑻":"𪻲","瑽":"𪻐","璉":"琏","璊":"𫞩","璕":"𬍤","璗":"𬍡","璝":"𪻺","璡":"琎","璣":"玑","璦":"瑷","璫":"珰","璯":"㻅","環":"环","璵":"玙","璸":"瑸","璼":"𫞨","璽":"玺","璾":"𫞦","璿":"璇","瓄":"𪻨","瓅":"𬍛","瓊":"琼","瓏":"珑","瓔":"璎","瓕":"𤦀","瓚":"瓒","瓛":"𤩽","甌":"瓯","甕":"瓮","產":"产","産":"产","甦":"苏","甯":"宁","畝":"亩","畢":"毕","異":"异","畵":"画","當":"当","畼":"𪽈","疇":"畴","疊":"叠","痙":"痉","痠":"酸","痮":"𪽪","痾":"疴","瘂":"痖","瘋":"疯","瘍":"疡","瘓":"痪","瘞":"瘗","瘡":"疮","瘧":"疟","瘮":"瘆","瘱":"𪽷","瘲":"疭","瘺":"瘘","瘻":"瘘","療":"疗","癆":"痨","癇":"痫","癉":"瘅","癐":"𤶊","癒":"愈","癘":"疠","癟":"瘪","癡":"痴","癢":"痒","癤":"疖","癥":"症","癧":"疬","癩":"癞","癬":"癣","癭":"瘿","癮":"瘾","癰":"痈","癱":"瘫","癲":"癫","發":"发","皁":"皂","皚":"皑","皟":"𤾀","皰":"疱","皸":"皲","皺":"皱","盃":"杯","盜":"盗","盞":"盏","盡":"尽","監":"监","盤":"盘","盧":"卢","盨":"𪾔","盪":"荡","眝":"𪾣","眞":"真","眥":"眦","眾":"众","睍":"𪾢","睏":"困","睜":"睁","睞":"睐","瞘":"眍","瞜":"䁖","瞞":"瞒","瞤":"𥆧","瞶":"瞆","瞼":"睑","矇":"蒙","矉":"𪾸","矑":"𪾦","矓":"眬","矚":"瞩","矯":"矫","硃":"朱","硜":"硁","硤":"硖","硨":"砗","硯":"砚","碕":"埼","碙":"𥐻","碩":"硕","碭":"砀","碸":"砜","確":"确","碼":"码","碽":"䂵","磑":"硙","磚":"砖","磠":"硵","磣":"碜","磧":"碛","磯":"矶","磽":"硗","磾":"䃅","礄":"硚","礆":"硷","礎":"础","礐":"𬒈","礒":"𥐟","礙":"碍","礦":"矿","礪":"砺","礫":"砾","礬":"矾","礮":"𪿫","礱":"砻","祕":"秘","祿":"禄","禍":"祸","禎":"祯","禕":"祎","禡":"祃","禦":"御","禪":"禅","禮":"礼","禰":"祢","禱":"祷","禿":"秃","秈":"籼","稅":"税","稈":"秆","稏":"䅉","稜":"棱","稟":"禀","種":"种","稱":"称","穀":"谷","穇":"䅟","穌":"稣","積":"积","穎":"颖","穠":"秾","穡":"穑","穢":"秽","穩":"稳","穫":"获","穭":"穞","窩":"窝","窪":"洼","窮":"穷","窯":"窑","窵":"窎","窶":"窭","窺":"窥","竄":"窜","竅":"窍","竇":"窦","竈":"灶","竊":"窃","竚":"𥩟","竪":"竖","竱":"𫁟","競":"竞","筆":"笔","筍":"笋","筧":"笕","筴":"䇲","箇":"个","箋":"笺","箏":"筝","節":"节","範":"范","築":"筑","篋":"箧","篔":"筼","篘":"𥬠","篠":"筿","篢":"𬕂","篤":"笃","篩":"筛","篳":"筚","篸":"𥮾","簀":"箦","簂":"𫂆","簍":"篓","簑":"蓑","簞":"箪","簡":"简","簢":"𫂃","簣":"篑","簫":"箫","簹":"筜","簽":"签","簾":"帘","籃":"篮","籅":"𥫣","籋":"𥬞","籌":"筹","籔":"䉤","籙":"箓","籛":"篯","籜":"箨","籟":"籁","籠":"笼","籤":"签","籩":"笾","籪":"簖","籬":"篱","籮":"箩","籲":"吁","粵":"粤","糉":"粽","糝":"糁","糞":"粪","糧":"粮","糰":"团","糲":"粝","糴":"籴","糶":"粜","糹":"纟","糺":"𫄙","糾":"纠","紀":"纪","紂":"纣","紃":"𬘓","約":"约","紅":"红","紆":"纡","紇":"纥","紈":"纨","紉":"纫","紋":"纹","納":"纳","紐":"纽","紓":"纾","純":"纯","紕":"纰","紖":"纼","紗":"纱","紘":"纮","紙":"纸","級":"级","紛":"纷","紜":"纭","紝":"纴","紞":"𬘘","紟":"𫄛","紡":"纺","紬":"䌷","紮":"扎","細":"细","紱":"绂","紲":"绁","紳":"绅","紵":"纻","紹":"绍","紺":"绀","紼":"绋","紿":"绐","絀":"绌","絁":"𫄟","終":"终","絃":"弦","組":"组","絅":"䌹","絆":"绊","絍":"𫟃","絎":"绗","結":"结","絕":"绝","絙":"𫄠","絛":"绦","絝":"绔","絞":"绞","絡":"络","絢":"绚","絥":"𫄢","給":"给","絧":"𫄡","絨":"绒","絪":"𬘡","絰":"绖","統":"统","絲":"丝","絳":"绛","絶":"绝","絹":"绢","絺":"𫄨","綀":"𦈌","綁":"绑","綃":"绡","綄":"𬘫","綆":"绠","綇":"𦈋","綈":"绨","綉":"绣","綋":"𫟄","綌":"绤","綎":"𬘩","綏":"绥","綐":"䌼","綑":"捆","經":"经","綖":"𫄧","綜":"综","綝":"𬘭","綞":"缍","綟":"𫄫","綠":"绿","綡":"𫟅","綢":"绸","綣":"绻","綧":"𬘯","綪":"𬘬","綫":"线","綬":"绶","維":"维","綯":"绹","綰":"绾","綱":"纲","網":"网","綳":"绷","綴":"缀","綸":"纶","綹":"绺","綺":"绮","綻":"绽","綽":"绰","綾":"绫","綿":"绵","緄":"绲","緇":"缁","緊":"紧","緋":"绯","緍":"𦈏","緑":"绿","緒":"绪","緓":"绬","緔":"绱","緗":"缃","緘":"缄","緙":"缂","緝":"缉","緞":"缎","緟":"𫟆","締":"缔","緡":"缗","緣":"缘","緤":"𫄬","緦":"缌","編":"编","緩":"缓","緬":"缅","緮":"𫄭","緯":"纬","緰":"𦈕","緱":"缑","緲":"缈","練":"练","緶":"缏","緷":"𦈉","緸":"𦈑","緹":"缇","緻":"致","緼":"缊","縈":"萦","縉":"缙","縊":"缢","縋":"缒","縍":"𫄰","縎":"𦈔","縐":"绉","縑":"缣","縕":"缊","縗":"缞","縛":"缚","縝":"缜","縞":"缟","縟":"缛","縣":"县","縧":"绦","縫":"缝","縬":"𦈚","縭":"缡","縮":"缩","縯":"𬙂","縰":"𫄳","縱":"纵","縲":"缧","縳":"䌸","縴":"纤","縵":"缦","縶":"絷","縷":"缕","縸":"𫄲","縹":"缥","縺":"𦈐","總":"总","績":"绩","繂":"𫄴","繃":"绷","繅":"缫","繆":"缪","繈":"𫄶","繏":"𦈝","繐":"𰬸","繒":"缯","繓":"𦈛","織":"织","繕":"缮","繚":"缭","繞":"绕","繟":"𦈎","繡":"绣","繢":"缋","繨":"𫄤","繩":"绳","繪":"绘","繫":"系","繬":"𫄱","繭":"茧","繮":"缰","繯":"缳","繰":"缲","繳":"缴","繶":"𫄷","繷":"𫄣","繸":"䍁","繹":"绎","繻":"𦈡","繼":"继","繽":"缤","繾":"缱","繿":"䍀","纁":"𫄸","纆":"𬙊","纇":"颣","纈":"缬","纊":"纩","續":"续","纍":"累","纏":"缠","纓":"缨","纔":"才","纕":"𬙋","纖":"纤","纗":"𫄹","纘":"缵","纚":"𫄥","纜":"缆","缽":"钵","罃":"䓨","罈":"坛","罌":"罂","罎":"坛","罰":"罚","罵":"骂","罷":"罢","羅":"罗","羆":"罴","羈":"羁","羋":"芈","羣":"群","羥":"羟","羨":"羡","義":"义","羵":"𫅗","羶":"膻","習":"习","翫":"玩","翬":"翚","翹":"翘","翽":"翙","耬":"耧","耮":"耢","聖":"圣","聞":"闻","聯":"联","聰":"聪","聲":"声","聳":"耸","聵":"聩","聶":"聂","職":"职","聹":"聍","聻":"𫆏","聽":"听","聾":"聋","肅":"肃","脅":"胁","脈":"脉","脛":"胫","脣":"唇","脥":"𣍰","脩":"修","脫":"脱","脹":"胀","腎":"肾","腖":"胨","腡":"脶","腦":"脑","腪":"𣍯","腫":"肿","腳":"脚","腸":"肠","膃":"腽","膕":"腘","膚":"肤","膞":"䏝","膠":"胶","膢":"𦝼","膩":"腻","膹":"𪱥","膽":"胆","膾":"脍","膿":"脓","臉":"脸","臍":"脐","臏":"膑","臗":"𣎑","臘":"腊","臚":"胪","臟":"脏","臠":"脔","臢":"臜","臥":"卧","臨":"临","臺":"台","與":"与","興":"兴","舉":"举","舊":"旧","舘":"馆","艙":"舱","艣":"𫇛","艤":"舣","艦":"舰","艫":"舻","艱":"艰","艷":"艳","芻":"刍","苧":"苎","茲":"兹","荊":"荆","莊":"庄","莖":"茎","莢":"荚","莧":"苋","菕":"𰰨","華":"华","菴":"庵","菸":"烟","萇":"苌","萊":"莱","萬":"万","萴":"荝","萵":"莴","葉":"叶","葒":"荭","葝":"𫈎","葤":"荮","葦":"苇","葯":"药","葷":"荤","蒍":"𫇭","蒐":"搜","蒓":"莼","蒔":"莳","蒕":"蒀","蒞":"莅","蒭":"𫇴","蒼":"苍","蓀":"荪","蓆":"席","蓋":"盖","蓧":"𦰏","蓮":"莲","蓯":"苁","蓴":"莼","蓽":"荜","蔄":"𬜬","蔔":"卜","蔘":"参","蔞":"蒌","蔣":"蒋","蔥":"葱","蔦":"茑","蔭":"荫","蔯":"𫈟","蔿":"𫇭","蕁":"荨","蕆":"蒇","蕎":"荞","蕒":"荬","蕓":"芸","蕕":"莸","蕘":"荛","蕝":"𫈵","蕢":"蒉","蕩":"荡","蕪":"芜","蕭":"萧","蕳":"𫈉","蕷":"蓣","蕽":"𫇽","薀":"蕰","薆":"𫉁","薈":"荟","薊":"蓟","薌":"芗","薑":"姜","薔":"蔷","薘":"荙","薟":"莶","薦":"荐","薩":"萨","薳":"䓕","薴":"苧","薵":"䓓","薺":"荠","藍":"蓝","藎":"荩","藝":"艺","藥":"药","藪":"薮","藭":"䓖","藴":"蕴","藶":"苈","藷":"𫉄","藹":"蔼","藺":"蔺","蘀":"萚","蘄":"蕲","蘆":"芦","蘇":"苏","蘊":"蕴","蘚":"藓","蘞":"蔹","蘟":"𦻕","蘢":"茏","蘭":"兰","蘺":"蓠","蘿":"萝","虆":"蔂","虉":"𬟁","處":"处","虛":"虚","虜":"虏","號":"号","虧":"亏","虯":"虬","蛺":"蛱","蛻":"蜕","蜆":"蚬","蝀":"𬟽","蝕":"蚀","蝟":"猬","蝦":"虾","蝨":"虱","蝸":"蜗","螄":"蛳","螞":"蚂","螢":"萤","螮":"䗖","螻":"蝼","螿":"螀","蟂":"𫋇","蟄":"蛰","蟈":"蝈","蟎":"螨","蟘":"𫋌","蟜":"𫊸","蟣":"虮","蟬":"蝉","蟯":"蛲","蟲":"虫","蟳":"𫊻","蟶":"蛏","蟻":"蚁","蠀":"𧏗","蠁":"蚃","蠅":"蝇","蠆":"虿","蠍":"蝎","蠐":"蛴","蠑":"蝾","蠔":"蚝","蠙":"𧏖","蠟":"蜡","蠣":"蛎","蠦":"𫊮","蠨":"蟏","蠱":"蛊","蠶":"蚕","蠻":"蛮","蠾":"𧑏","衆":"众","衊":"蔑","術":"术","衕":"同","衚":"胡","衛":"卫","衝":"冲","袞":"衮","裊":"袅","裏":"里","補":"补","裝":"装","裡":"里","製":"制","複":"复","褌":"裈","褘":"袆","褲":"裤","褳":"裢","褸":"褛","褻":"亵","襀":"𫌀","襇":"裥","襉":"裥","襏":"袯","襓":"𫋹","襖":"袄","襗":"𫋷","襘":"𫋻","襝":"裣","襠":"裆","襤":"褴","襪":"袜","襯":"衬","襰":"𧝝","襲":"袭","襴":"襕","襵":"𫌇","覈":"核","見":"见","覎":"觃","規":"规","覓":"觅","視":"视","覘":"觇","覛":"𫌪","覡":"觋","覥":"觍","覦":"觎","親":"亲","覬":"觊","覯":"觏","覲":"觐","覷":"觑","覹":"𫌭","覺":"觉","覼":"𫌨","覽":"览","覿":"觌","觀":"观","觴":"觞","觶":"觯","觸":"触","訁":"讠","訂":"订","訃":"讣","計":"计","訊":"讯","訌":"讧","討":"讨","訏":"𬣙","訐":"讦","訑":"𫍙","訒":"讱","訓":"训","訕":"讪","訖":"讫","記":"记","訛":"讹","訜":"𫍛","訝":"讶","訞":"𫍚","訟":"讼","訢":"䜣","訣":"诀","訥":"讷","訨":"𫟞","訩":"讻","訪":"访","設":"设","許":"许","訴":"诉","訶":"诃","診":"诊","註":"注","証":"证","詀":"𧮪","詁":"诂","詆":"诋","詊":"𫟟","詎":"讵","詐":"诈","詑":"𫍡","詒":"诒","詓":"𫍜","詔":"诏","評":"评","詖":"诐","詗":"诇","詘":"诎","詛":"诅","詝":"𬣞","詞":"词","詠":"咏","詡":"诩","詢":"询","詣":"诣","試":"试","詩":"诗","詪":"𬣳","詫":"诧","詬":"诟","詭":"诡","詮":"诠","詰":"诘","話":"话","該":"该","詳":"详","詵":"诜","詷":"𫍣","詼":"诙","詿":"诖","誂":"𫍥","誄":"诔","誅":"诛","誆":"诓","誇":"夸","誋":"𫍪","誌":"志","認":"认","誑":"诳","誒":"诶","誕":"诞","誘":"诱","誚":"诮","語":"语","誠":"诚","誡":"诫","誣":"诬","誤":"误","誥":"诰","誦":"诵","誨":"诲","說":"说","誫":"𫍨","説":"说","誰":"谁","課":"课","誳":"𫍮","誴":"𫟡","誶":"谇","誷":"𫍬","誹":"诽","誺":"𫍧","誼":"谊","誾":"訚","調":"调","諂":"谄","諄":"谆","談":"谈","諉":"诿","請":"请","諍":"诤","諏":"诹","諑":"诼","諒":"谅","諓":"𬣡","論":"论","諗":"谂","諛":"谀","諜":"谍","諝":"谞","諞":"谝","諟":"𬤊","諡":"谥","諢":"诨","諣":"𫍩","諤":"谔","諥":"𫍳","諦":"谛","諧":"谐","諭":"谕","諯":"𫍱","諰":"𫍰","諱":"讳","諲":"𬤇","諳":"谙","諴":"𫍯","諶":"谌","諷":"讽","諸":"诸","諺":"谚","諼":"谖","諾":"诺","謀":"谋","謁":"谒","謂":"谓","謄":"誊","謅":"诌","謆":"𫍸","謉":"𫍷","謊":"谎","謎":"谜","謏":"𫍲","謐":"谧","謔":"谑","謖":"谡","謗":"谤","謙":"谦","謚":"谥","講":"讲","謝":"谢","謠":"谣","謡":"谣","謨":"谟","謫":"谪","謬":"谬","謭":"谫","謯":"𫍹","謱":"𫍴","謳":"讴","謸":"𫍵","謹":"谨","謾":"谩","譁":"哗","譂":"𫟠","譅":"𰶎","譆":"𫍻","證":"证","譊":"𫍢","譎":"谲","譏":"讥","譑":"𫍤","譓":"𬤝","譖":"谮","識":"识","譙":"谯","譚":"谭","譜":"谱","譞":"𫍽","譟":"噪","譨":"𫍦","譫":"谵","譭":"毁","譯":"译","議":"议","譴":"谴","護":"护","譸":"诪","譽":"誉","讀":"读","讅":"谉","變":"变","讋":"詟","讌":"䜩","讎":"雠","讒":"谗","讓":"让","讕":"谰","讖":"谶","讚":"赞","讜":"谠","讞":"谳","豈":"岂","豎":"竖","豐":"丰","豔":"艳","豬":"猪","豵":"𫎆","豶":"豮","貓":"猫","貗":"𫎌","貙":"䝙","貝":"贝","貞":"贞","貟":"贠","負":"负","財":"财","貢":"贡","貧":"贫","貨":"货","販":"贩","貪":"贪","貫":"贯","責":"责","貯":"贮","貰":"贳","貲":"赀","貳":"贰","貴":"贵","貶":"贬","貸":"贷","貺":"贶","費":"费","貼":"贴","貽":"贻","貿":"贸","賀":"贺","賁":"贲","賂":"赂","賃":"赁","賄":"贿","賅":"赅","資":"资","賈":"贾","賊":"贼","賑":"赈","賒":"赊","賓":"宾","賕":"赇","賙":"赒","賚":"赉","賜":"赐","賝":"𫎩","賞":"赏","賟":"𧹖","賠":"赔","賡":"赓","賢":"贤","賣":"卖","賤":"贱","賦":"赋","賧":"赕","質":"质","賫":"赍","賬":"账","賭":"赌","賰":"䞐","賴":"赖","賵":"赗","賺":"赚","賻":"赙","購":"购","賽":"赛","賾":"赜","贃":"𧹗","贄":"贽","贅":"赘","贇":"赟","贈":"赠","贉":"𫎫","贊":"赞","贋":"赝","贍":"赡","贏":"赢","贐":"赆","贑":"𫎬","贓":"赃","贔":"赑","贖":"赎","贗":"赝","贚":"𫎦","贛":"赣","贜":"赃","赬":"赪","趕":"赶","趙":"赵","趨":"趋","趲":"趱","跡":"迹","踐":"践","踰":"逾","踴":"踊","蹌":"跄","蹔":"𫏐","蹕":"跸","蹟":"迹","蹠":"跖","蹣":"蹒","蹤":"踪","蹳":"𫏆","蹺":"跷","蹻":"𫏋","躂":"跶","躉":"趸","躊":"踌","躋":"跻","躍":"跃","躎":"䟢","躑":"踯","躒":"跞","躓":"踬","躕":"蹰","躘":"𨀁","躚":"跹","躝":"𨅬","躡":"蹑","躥":"蹿","躦":"躜","躪":"躏","軀":"躯","軉":"𨉗","車":"车","軋":"轧","軌":"轨","軍":"军","軏":"𫐄","軑":"轪","軒":"轩","軔":"轫","軕":"𫐅","軗":"𨐅","軛":"轭","軜":"𫐇","軝":"𬨂","軟":"软","軤":"轷","軨":"𫐉","軫":"轸","軬":"𫐊","軲":"轱","軷":"𫐈","軸":"轴","軹":"轵","軺":"轺","軻":"轲","軼":"轶","軾":"轼","軿":"𫐌","較":"较","輄":"𨐈","輅":"辂","輇":"辁","輈":"辀","載":"载","輊":"轾","輋":"𪨶","輒":"辄","輓":"挽","輔":"辅","輕":"轻","輖":"𫐏","輗":"𫐐","輛":"辆","輜":"辎","輝":"辉","輞":"辋","輟":"辍","輢":"𫐎","輥":"辊","輦":"辇","輨":"𫐑","輩":"辈","輪":"轮","輬":"辌","輮":"𫐓","輯":"辑","輳":"辏","輶":"𬨎","輷":"𫐒","輸":"输","輻":"辐","輼":"辒","輾":"辗","輿":"舆","轀":"辒","轂":"毂","轄":"辖","轅":"辕","轆":"辘","轇":"𫐖","轉":"转","轊":"𫐕","轍":"辙","轎":"轿","轐":"𫐗","轔":"辚","轗":"𫐘","轟":"轰","轠":"𫐙","轡":"辔","轢":"轹","轣":"𫐆","轤":"轳","辦":"办","辭":"辞","辮":"辫","辯":"辩","農":"农","迴":"回","逕":"迳","這":"这","連":"连","週":"周","進":"进","遊":"游","運":"运","過":"过","達":"达","違":"违","遙":"遥","遜":"逊","遞":"递","遠":"远","遡":"溯","適":"适","遱":"𫐷","遲":"迟","遷":"迁","選":"选","遺":"遗","遼":"辽","邁":"迈","還":"还","邇":"迩","邊":"边","邏":"逻","邐":"逦","郟":"郏","郵":"邮","鄆":"郓","鄉":"乡","鄒":"邹","鄔":"邬","鄖":"郧","鄟":"𫑘","鄧":"邓","鄩":"𬩽","鄭":"郑","鄰":"邻","鄲":"郸","鄳":"𫑡","鄴":"邺","鄶":"郐","鄺":"邝","酇":"酂","酈":"郦","醃":"腌","醖":"酝","醜":"丑","醞":"酝","醟":"蒏","醣":"糖","醫":"医","醬":"酱","醱":"酦","醲":"𬪩","醶":"𫑷","釀":"酿","釁":"衅","釃":"酾","釅":"酽","釋":"释","釐":"厘","釒":"钅","釓":"钆","釔":"钇","釕":"钌","釗":"钊","釘":"钉","釙":"钋","釚":"𫟲","針":"针","釟":"𫓥","釣":"钓","釤":"钐","釦":"扣","釧":"钏","釨":"𫓦","釩":"钒","釲":"𫟳","釳":"𨰿","釴":"𬬩","釵":"钗","釷":"钍","釹":"钕","釺":"钎","釾":"䥺","釿":"𬬱","鈀":"钯","鈁":"钫","鈃":"钘","鈄":"钭","鈅":"钥","鈆":"𫓪","鈇":"𫓧","鈈":"钚","鈉":"钠","鈋":"𨱂","鈍":"钝","鈎":"钩","鈐":"钤","鈑":"钣","鈒":"钑","鈔":"钞","鈕":"钮","鈖":"𫟴","鈗":"𫟵","鈛":"𫓨","鈞":"钧","鈠":"𨱁","鈡":"钟","鈣":"钙","鈥":"钬","鈦":"钛","鈧":"钪","鈮":"铌","鈯":"𨱄","鈰":"铈","鈲":"𨱃","鈳":"钶","鈴":"铃","鈷":"钴","鈸":"钹","鈹":"铍","鈺":"钰","鈽":"钸","鈾":"铀","鈿":"钿","鉀":"钾","鉁":"𨱅","鉆":"钻","鉈":"铊","鉉":"铉","鉊":"𬬿","鉋":"铇","鉍":"铋","鉑":"铂","鉔":"𫓬","鉕":"钷","鉗":"钳","鉚":"铆","鉛":"铅","鉝":"𫟷","鉞":"钺","鉠":"𫓭","鉢":"钵","鉤":"钩","鉥":"𬬸","鉦":"钲","鉧":"𬭁","鉬":"钼","鉭":"钽","鉮":"𬬹","鉳":"锫","鉶":"铏","鉷":"𫟹","鉸":"铰","鉺":"铒","鉻":"铬","鉽":"𫟸","鉾":"𫓴","鉿":"铪","銀":"银","銁":"𫓲","銂":"𫟻","銃":"铳","銅":"铜","銈":"𫓯","銊":"𫓰","銍":"铚","銏":"𫟶","銑":"铣","銓":"铨","銖":"铢","銘":"铭","銚":"铫","銛":"铦","銜":"衔","銠":"铑","銣":"铷","銥":"铱","銦":"铟","銨":"铵","銩":"铥","銪":"铕","銫":"铯","銬":"铐","銱":"铞","銳":"锐","銶":"𨱇","銷":"销","銹":"锈","銻":"锑","銼":"锉","鋁":"铝","鋂":"𰾄","鋃":"锒","鋅":"锌","鋇":"钡","鋉":"𨱈","鋌":"铤","鋏":"铗","鋐":"𬭎","鋒":"锋","鋗":"𫓶","鋙":"铻","鋝":"锊","鋟":"锓","鋠":"𫓵","鋣":"铘","鋤":"锄","鋥":"锃","鋦":"锔","鋨":"锇","鋩":"铓","鋪":"铺","鋭":"锐","鋮":"铖","鋯":"锆","鋰":"锂","鋱":"铽","鋶":"锍","鋸":"锯","鋹":"𬬮","鋼":"钢","錀":"𬬭","錁":"锞","錂":"𨱋","錄":"录","錆":"锖","錇":"锫","錈":"锩","錏":"铔","錐":"锥","錒":"锕","錕":"锟","錘":"锤","錙":"锱","錚":"铮","錛":"锛","錜":"𫓻","錝":"𫓽","錞":"𬭚","錟":"锬","錠":"锭","錡":"锜","錢":"钱","錤":"𫓹","錥":"𫓾","錦":"锦","錨":"锚","錩":"锠","錫":"锡","錮":"锢","錯":"错","録":"录","錳":"锰","錶":"表","錸":"铼","錼":"镎","錽":"𫓸","鍀":"锝","鍁":"锨","鍃":"锪","鍄":"𨱉","鍅":"钫","鍆":"钔","鍇":"锴","鍈":"锳","鍉":"𫔂","鍋":"锅","鍍":"镀","鍒":"𫔄","鍔":"锷","鍘":"铡","鍚":"钖","鍛":"锻","鍠":"锽","鍤":"锸","鍥":"锲","鍩":"锘","鍬":"锹","鍭":"𬭤","鍮":"𨱎","鍰":"锾","鍵":"键","鍶":"锶","鍺":"锗","鍼":"针","鎂":"镁","鎄":"锿","鎇":"镅","鎈":"𫟿","鎊":"镑","鎌":"镰","鎍":"𫔅","鎓":"𬭩","鎔":"镕","鎖":"锁","鎘":"镉","鎙":"𫔈","鎚":"锤","鎛":"镈","鎝":"𨱏","鎞":"𫔇","鎡":"镃","鎢":"钨","鎣":"蓥","鎦":"镏","鎧":"铠","鎩":"铩","鎪":"锼","鎬":"镐","鎭":"镇","鎮":"镇","鎯":"𨱍","鎰":"镒","鎲":"镋","鎳":"镍","鎵":"镓","鎶":"鿔","鎷":"𨰾","鎸":"镌","鎿":"镎","鏃":"镞","鏆":"𨱌","鏈":"链","鏉":"𨱒","鏌":"镆","鏍":"镙","鏏":"𬭬","鏐":"镠","鏑":"镝","鏗":"铿","鏘":"锵","鏚":"𬭭","鏜":"镗","鏝":"镘","鏞":"镛","鏟":"铲","鏡":"镜","鏢":"镖","鏤":"镂","鏥":"𫔊","鏦":"𫓩","鏨":"錾","鏰":"镚","鏵":"铧","鏷":"镤","鏹":"镪","鏺":"䥽","鏻":"𬭸","鏽":"锈","鏾":"𫔌","鐃":"铙","鐄":"𨱑","鐇":"𫔍","鐈":"𫓱","鐋":"铴","鐍":"𫔎","鐎":"𨱓","鐏":"𨱔","鐐":"镣","鐒":"铹","鐓":"镦","鐔":"镡","鐘":"钟","鐙":"镫","鐝":"镢","鐠":"镨","鐥":"䦅","鐦":"锎","鐧":"锏","鐨":"镄","鐩":"𬭼","鐪":"𫓺","鐫":"镌","鐮":"镰","鐯":"䦃","鐲":"镯","鐳":"镭","鐵":"铁","鐶":"镮","鐸":"铎","鐺":"铛","鐼":"𫔁","鐽":"𫟼","鐿":"镱","鑀":"𰾭","鑄":"铸","鑉":"𫠁","鑊":"镬","鑌":"镔","鑑":"鉴","鑒":"鉴","鑔":"镲","鑕":"锧","鑞":"镴","鑠":"铄","鑣":"镳","鑥":"镥","鑪":"𬬻","鑭":"镧","鑰":"钥","鑱":"镵","鑲":"镶","鑴":"𫔔","鑷":"镊","鑹":"镩","鑼":"锣","鑽":"钻","鑾":"銮","鑿":"凿","钂":"镋","長":"长","門":"门","閂":"闩","閃":"闪","閆":"闫","閈":"闬","閉":"闭","閌":"闶","閍":"𨸂","閎":"闳","閏":"闰","閐":"𨸃","閑":"闲","間":"间","閔":"闵","閗":"𫔯","閘":"闸","閝":"𫠂","閞":"𫔰","閡":"阂","閣":"阁","閤":"合","閥":"阀","閨":"闺","閩":"闽","閫":"阃","閬":"阆","閭":"闾","閱":"阅","閲":"阅","閵":"𫔴","閶":"阊","閹":"阉","閻":"阎","閼":"阏","閽":"阍","閾":"阈","閿":"阌","闃":"阒","闆":"板","闇":"暗","闈":"闱","闉":"𬮱","闊":"阔","闋":"阕","闌":"阑","闍":"阇","闐":"阗","闑":"𫔶","闒":"阘","闓":"闿","闔":"阖","闕":"阙","闖":"闯","關":"关","闞":"阚","闠":"阓","闡":"阐","闢":"辟","闤":"阛","闥":"闼","陘":"陉","陝":"陕","陞":"升","陣":"阵","陰":"阴","陳":"陈","陸":"陆","陽":"阳","隉":"陧","隊":"队","階":"阶","隑":"𬮿","隕":"陨","際":"际","隤":"𬯎","隨":"随","險":"险","隮":"𬯀","隯":"陦","隱":"隐","隴":"陇","隸":"隶","隻":"只","雋":"隽","雖":"虽","雙":"双","雛":"雏","雜":"杂","雞":"鸡","離":"离","難":"难","雲":"云","電":"电","霑":"沾","霢":"霡","霣":"𫕥","霧":"雾","霼":"𪵣","霽":"霁","靂":"雳","靄":"霭","靆":"叇","靈":"灵","靉":"叆","靚":"靓","靜":"静","靝":"靔","靧":"𫖃","靨":"靥","鞏":"巩","鞝":"绱","鞦":"秋","鞽":"鞒","鞾":"𫖇","韁":"缰","韃":"鞑","韆":"千","韉":"鞯","韋":"韦","韌":"韧","韍":"韨","韓":"韩","韙":"韪","韚":"𫠅","韛":"𫖔","韜":"韬","韞":"韫","韠":"𫖒","韻":"韵","響":"响","頁":"页","頂":"顶","頃":"顷","項":"项","順":"顺","頇":"顸","須":"须","頊":"顼","頌":"颂","頍":"𫠆","頎":"颀","頏":"颃","預":"预","頑":"顽","頒":"颁","頓":"顿","頔":"𬱖","頗":"颇","領":"领","頜":"颌","頠":"𬱟","頡":"颉","頤":"颐","頦":"颏","頫":"𫖯","頭":"头","頮":"颒","頰":"颊","頲":"颋","頴":"颕","頵":"𫖳","頷":"颔","頸":"颈","頹":"颓","頻":"频","頽":"颓","顂":"𩓋","顃":"𩖖","顅":"𫖶","顆":"颗","題":"题","額":"额","顎":"颚","顏":"颜","顒":"颙","顓":"颛","顔":"颜","顗":"𫖮","顙":"颡","顛":"颠","類":"类","顢":"颟","顣":"𫖹","顥":"颢","顧":"顾","顫":"颤","顬":"颥","顯":"显","顰":"颦","顱":"颅","顳":"颞","顴":"颧","風":"风","颭":"飐","颮":"飑","颯":"飒","颰":"𩙥","颱":"台","颳":"刮","颶":"飓","颷":"𩙪","颸":"飔","颺":"飏","颻":"飖","颼":"飕","颾":"𩙫","飀":"飗","飄":"飘","飆":"飙","飈":"飚","飋":"𫗋","飛":"飞","飠":"饣","飢":"饥","飣":"饤","飥":"饦","飦":"𫗞","飩":"饨","飪":"饪","飫":"饫","飭":"饬","飯":"饭","飱":"飧","飲":"饮","飴":"饴","飵":"𫗢","飶":"𫗣","飼":"饲","飽":"饱","飾":"饰","飿":"饳","餃":"饺","餄":"饸","餅":"饼","餈":"糍","餉":"饷","養":"养","餌":"饵","餎":"饹","餏":"饻","餑":"饽","餒":"馁","餓":"饿","餔":"𫗦","餕":"馂","餖":"饾","餗":"𫗧","餚":"肴","餛":"馄","餜":"馃","餞":"饯","餡":"馅","餦":"𫗠","餧":"𫗪","館":"馆","餪":"𫗬","餫":"𫗥","餭":"𫗮","餳":"饧","餶":"馉","餷":"馇","餸":"𩠌","餺":"馎","餼":"饩","餾":"馏","餿":"馊","饁":"馌","饃":"馍","饅":"馒","饈":"馐","饉":"馑","饊":"馓","饋":"馈","饌":"馔","饑":"饥","饒":"饶","饗":"飨","饘":"𫗴","饜":"餍","饞":"馋","饟":"𫗵","饠":"𫗩","饢":"馕","馬":"马","馭":"驭","馮":"冯","馯":"𫘛","馱":"驮","馳":"驰","馴":"驯","馹":"驲","馼":"𫘜","駁":"驳","駃":"𫘝","駉":"𬳶","駊":"𫘟","駎":"𩧨","駐":"驻","駑":"驽","駒":"驹","駓":"𬳵","駔":"驵","駕":"驾","駘":"骀","駙":"驸","駚":"𩧫","駛":"驶","駝":"驼","駞":"𫘞","駟":"驷","駡":"骂","駢":"骈","駤":"𫘠","駧":"𩧲","駩":"𩧴","駪":"𬳽","駫":"𫘡","駭":"骇","駰":"骃","駱":"骆","駶":"𩧺","駸":"骎","駻":"𫘣","駼":"𬳿","駿":"骏","騁":"骋","騂":"骍","騃":"𫘤","騄":"𫘧","騅":"骓","騉":"𫘥","騊":"𫘦","騌":"骔","騍":"骒","騎":"骑","騏":"骐","騑":"𬴂","騔":"𩨀","騖":"骛","騙":"骗","騚":"𩨊","騜":"𫘩","騝":"𩨃","騞":"𬴃","騟":"𩨈","騠":"𫘨","騤":"骙","騧":"䯄","騪":"𩨄","騫":"骞","騭":"骘","騮":"骝","騰":"腾","騱":"𫘬","騴":"𫘫","騵":"𫘪","騶":"驺","騷":"骚","騸":"骟","騻":"𫘭","騼":"𫠋","騾":"骡","驀":"蓦","驁":"骜","驂":"骖","驃":"骠","驅":"驱","驊":"骅","驋":"𩧯","驌":"骕","驍":"骁","驎":"𬴊","驏":"骣","驓":"𫘯","驕":"骄","驗":"验","驙":"𫘰","驚":"惊","驛":"驿","驟":"骤","驢":"驴","驤":"骧","驥":"骥","驦":"骦","驨":"𫘱","驪":"骊","驫":"骉","骯":"肮","髏":"髅","髒":"脏","體":"体","髕":"髌","髖":"髋","髮":"发","鬆":"松","鬍":"胡","鬖":"𩭹","鬚":"须","鬠":"𫘽","鬢":"鬓","鬥":"斗","鬧":"闹","鬨":"哄","鬩":"阋","鬮":"阄","鬱":"郁","鬹":"鬶","魎":"魉","魘":"魇","魚":"鱼","魛":"鱽","魟":"𫚉","魢":"鱾","魥":"𩽹","魦":"𫚌","魨":"鲀","魯":"鲁","魴":"鲂","魵":"𫚍","魷":"鱿","魺":"鲄","魽":"𫠐","鮀":"𬶍","鮁":"鲅","鮃":"鲆","鮄":"𫚒","鮅":"𫚑","鮆":"𫚖","鮈":"𬶋","鮊":"鲌","鮋":"鲉","鮍":"鲏","鮎":"鲇","鮐":"鲐","鮑":"鲍","鮒":"鲋","鮓":"鲊","鮚":"鲒","鮜":"鲘","鮝":"鲞","鮞":"鲕","鮟":"𩽾","鮠":"𬶏","鮡":"𬶐","鮣":"䲟","鮤":"𫚓","鮦":"鲖","鮪":"鲔","鮫":"鲛","鮭":"鲑","鮮":"鲜","鮯":"𫚗","鮰":"𫚔","鮳":"鲓","鮵":"𫚛","鮶":"鲪","鮸":"𩾃","鮺":"鲝","鮿":"𫚚","鯀":"鲧","鯁":"鲠","鯄":"𩾁","鯆":"𫚙","鯇":"鲩","鯉":"鲤","鯊":"鲨","鯒":"鲬","鯔":"鲻","鯕":"鲯","鯖":"鲭","鯗":"鲞","鯛":"鲷","鯝":"鲴","鯞":"𫚡","鯡":"鲱","鯢":"鲵","鯤":"鲲","鯧":"鲳","鯨":"鲸","鯪":"鲮","鯫":"鲰","鯬":"𫚞","鯰":"鲶","鯱":"𩾇","鯴":"鲺","鯶":"𩽼","鯷":"鳀","鯻":"𬶟","鯽":"鲫","鯾":"𫚣","鯿":"鳊","鰁":"鳈","鰂":"鲗","鰃":"鳂","鰆":"䲠","鰈":"鲽","鰉":"鳇","鰊":"𬶠","鰋":"𫚢","鰌":"䲡","鰍":"鳅","鰏":"鲾","鰐":"鳄","鰑":"𫚊","鰒":"鳆","鰓":"鳃","鰕":"𫚥","鰛":"鳁","鰜":"鳒","鰟":"鳑","鰠":"鳋","鰣":"鲥","鰤":"𫚕","鰥":"鳏","鰦":"𫚤","鰧":"䲢","鰨":"鳎","鰩":"鳐","鰫":"𫚦","鰭":"鳍","鰮":"鳁","鰱":"鲢","鰲":"鳌","鰳":"鳓","鰵":"鳘","鰶":"𬶭","鰷":"鲦","鰹":"鲣","鰺":"鲹","鰻":"鳗","鰼":"鳛","鰽":"𫚧","鰾":"鳔","鱀":"𬶨","鱂":"鳉","鱄":"𫚋","鱅":"鳙","鱆":"𫠒","鱇":"𩾌","鱈":"鳕","鱉":"鳖","鱊":"𫚪","鱒":"鳟","鱔":"鳝","鱖":"鳜","鱗":"鳞","鱘":"鲟","鱚":"𬶮","鱝":"鲼","鱟":"鲎","鱠":"鲙","鱢":"𫚫","鱣":"鳣","鱤":"鳡","鱧":"鳢","鱨":"鲿","鱭":"鲚","鱮":"𫚈","鱯":"鳠","鱲":"𫚭","鱷":"鳄","鱸":"鲈","鱺":"鲡","鳥":"鸟","鳧":"凫","鳩":"鸠","鳬":"凫","鳲":"鸤","鳳":"凤","鳴":"鸣","鳶":"鸢","鳷":"𫛛","鳼":"𪉃","鳽":"𫛚","鳾":"䴓","鴀":"𫛜","鴃":"𫛞","鴅":"𫛝","鴆":"鸩","鴇":"鸨","鴉":"鸦","鴐":"𫛤","鴒":"鸰","鴔":"𫛡","鴕":"鸵","鴗":"𫁡","鴛":"鸳","鴜":"𪉈","鴝":"鸲","鴞":"鸮","鴟":"鸱","鴣":"鸪","鴥":"𫛣","鴦":"鸯","鴨":"鸭","鴮":"𫛦","鴯":"鸸","鴰":"鸹","鴲":"𪉆","鴳":"𫛩","鴴":"鸻","鴷":"䴕","鴻":"鸿","鴽":"𫛪","鴿":"鸽","鵁":"䴔","鵂":"鸺","鵃":"鸼","鵊":"𫛥","鵏":"𬷕","鵐":"鹀","鵑":"鹃","鵒":"鹆","鵓":"鹁","鵚":"𪉍","鵜":"鹈","鵝":"鹅","鵟":"𫛭","鵠":"鹄","鵡":"鹉","鵧":"𫛨","鵩":"𫛳","鵪":"鹌","鵫":"𫛱","鵬":"鹏","鵮":"鹐","鵯":"鹎","鵲":"鹊","鵷":"鹓","鵾":"鹍","鶄":"䴖","鶇":"鸫","鶉":"鹑","鶊":"鹒","鶌":"𫛵","鶒":"𫛶","鶓":"鹋","鶖":"鹙","鶗":"𫛸","鶘":"鹕","鶚":"鹗","鶠":"𬸘","鶡":"鹖","鶥":"鹛","鶦":"𫛷","鶩":"鹜","鶪":"䴗","鶬":"鸧","鶭":"𫛯","鶯":"莺","鶰":"𫛫","鶱":"𬸣","鶲":"鹟","鶴":"鹤","鶹":"鹠","鶺":"鹡","鶻":"鹘","鶼":"鹣","鶿":"鹚","鷀":"鹚","鷁":"鹢","鷂":"鹞","鷄":"鸡","鷅":"𫛽","鷉":"䴘","鷊":"鹝","鷐":"𫜀","鷓":"鹧","鷔":"𪉑","鷖":"鹥","鷗":"鸥","鷙":"鸷","鷚":"鹨","鷟":"𬸦","鷣":"𫜃","鷤":"𫛴","鷥":"鸶","鷦":"鹪","鷨":"𪉊","鷩":"𫜁","鷫":"鹔","鷭":"𬸪","鷯":"鹩","鷲":"鹫","鷳":"鹇","鷴":"鹇","鷷":"𫜄","鷸":"鹬","鷹":"鹰","鷺":"鹭","鷽":"鸴","鷿":"𬸯","鸂":"㶉","鸇":"鹯","鸊":"䴙","鸋":"𫛢","鸌":"鹱","鸏":"鹲","鸑":"𬸚","鸕":"鸬","鸗":"𫛟","鸘":"鹴","鸚":"鹦","鸛":"鹳","鸝":"鹂","鸞":"鸾","鹵":"卤","鹹":"咸","鹺":"鹾","鹼":"碱","鹽":"盐","麗":"丽","麥":"麦","麨":"𪎊","麩":"麸","麫":"面","麬":"𤿲","麯":"曲","麲":"𪎉","麳":"𪎌","麷":"𫜑","黃":"黄","黌":"黉","點":"点","黨":"党","黲":"黪","黴":"霉","黶":"黡","黷":"黩","黽":"黾","黿":"鼋","鼂":"鼌","鼉":"鼍","鼕":"冬","鼴":"鼹","齊":"齐","齋":"斋","齎":"赍","齏":"齑","齒":"齿","齔":"龀","齕":"龁","齗":"龂","齘":"𬹼","齙":"龅","齜":"龇","齟":"龃","齠":"龆","齡":"龄","齣":"出","齦":"龈","齩":"𫜪","齪":"龊","齬":"龉","齭":"𫜭","齮":"𬺈","齯":"𫠜","齰":"𫜬","齲":"龋","齴":"𫜮","齶":"腭","齷":"龌","齼":"𬺓","齾":"𫜰","龍":"龙","龎":"厐","龐":"庞","龑":"䶮","龓":"𫜲","龔":"龚","龕":"龛","龜":"龟","龭":"𩨎","龯":"𨱆","鿁":"䜤","鿓":"鿒","𠁞":"𠀾","𠌥":"𠆿","𠏢":"𠉗","𠐊":"𫝋","𠗣":"㓆","𠞆":"𠛆","𠠎":"𠚳","𠬙":"𪠡","𠽃":"𪠺","𠿕":"𪜎","𡂡":"𪢒","𡃄":"𪡺","𡃕":"𠴛","𡃤":"𪢐","𡄔":"𠴢","𡄣":"𠵸","𡅏":"𠲥","𡅯":"𪢖","𡑍":"𫭼","𡑭":"𡋗","𡓁":"𪤄","𡓾":"𡋀","𡔖":"𡍣","𡞵":"㛟","𡟫":"𫝪","𡠹":"㛿","𡢃":"㛠","𡮉":"𡭜","𡮣":"𡭬","𡳳":"𡳃","𡸗":"𪨩","𡹬":"𪨹","𡻕":"岁","𡽗":"𡸃","𡾱":"㟜","𡿖":"𪩛","𢍰":"𪪴","𢠼":"𢙑","𢣐":"𪬚","𢣚":"𢘝","𢣭":"𢘞","𢤩":"𪫡","𢤱":"𢘙","𢤿":"𪬯","𢯷":"𪭝","𢶒":"𪭯","𢶫":"𢫞","𢷮":"𢫊","𢹿":"𢬦","𢺳":"𪮳","𣈶":"暅","𣋋":"𣈣","𣍐":"𫧃","𣙎":"㭣","𣜬":"𪳗","𣝕":"𣘷","𣞻":"𣘓","𣠩":"𣞎","𣠲":"𣑶","𣯩":"𣯣","𣯴":"𣭤","𣯶":"毶","𣽏":"𪶮","𣾷":"㳢","𣿉":"𣶫","𤁣":"𣺽","𤄷":"𪶒","𤅶":"𣷷","𤑳":"𤎻","𤑹":"𪹀","𤒎":"𤊀","𤒻":"𪹹","𤓌":"𪹠","𤓎":"𤎺","𤓩":"𤊰","𤘀":"𪺣","𤛮":"𤙯","𤛱":"𫞢","𤜆":"𪺪","𤠮":"𪺸","𤢟":"𤝢","𤢻":"𢢐","𤩂":"𫞧","𤪺":"㻘","𤫩":"㻏","𤬅":"𪼴","𤳷":"𪽝","𤳸":"𤳄","𤷃":"𪽭","𤸫":"𤶧","𤺔":"𪽴","𥊝":"𥅿","𥌃":"𥅘","𥏝":"𪿊","𥕥":"𥐰","𥖅":"𥐯","𥖲":"𪿞","𥗇":"𪿵","𥗽":"𬒗","𥜐":"𫀓","𥜰":"𫀌","𥞵":"𥞦","𥢢":"䅪","𥢶":"𫞷","𥢷":"𫀮","𥨐":"𥧂","𥪂":"𥩺","𥯤":"𫁳","𥴨":"𫂖","𥴼":"𫁺","𥵃":"𥱔","𥵊":"𥭉","𥶽":"𫁱","𥸠":"𥮋","𥻦":"𫂿","𥼽":"𥹥","𥽖":"𥺇","𥾯":"𫄝","𥿊":"𦈈","𦀖":"𫄦","𦂅":"𦈒","𦃄":"𦈗","𦃩":"𫄯","𦅇":"𫄪","𦅈":"𫄵","𦆲":"𫟇","𦒀":"𫅥","𦔖":"𫅼","𦘧":"𡳒","𦟼":"𫆝","𦠅":"𫞅","𦡝":"𫆫","𦢈":"𣍨","𦣎":"𦟗","𦧺":"𫇘","𦪙":"䑽","𦪽":"𦨩","𦱌":"𫇪","𦾟":"𦶻","𧎈":"𧌥","𧒯":"𫊹","𧔥":"𧒭","𧕟":"𧉐","𧜗":"䘞","𧜵":"䙊","𧝞":"䘛","𧞫":"𫌋","𧟀":"𧝧","𧡴":"𫌫","𧢄":"𫌬","𧦝":"𫍞","𧦧":"𫍟","𧩕":"𫍭","𧩙":"䜥","𧩼":"𫍶","𧫝":"𫍺","𧬤":"𫍼","𧭈":"𫍾","𧭹":"𫍐","𧳟":"𧳕","𧵳":"䞌","𧶔":"𧹓","𧶧":"䞎","𧷎":"𪠀","𧸘":"𫎨","𧹈":"𪥠","𧽯":"𫎸","𨂐":"𫏌","𨄣":"𨀱","𨅍":"𨁴","𨆪":"𫏕","𨇁":"𧿈","𨇞":"𨅫","𨇤":"𫏨","𨇰":"𫏞","𨇽":"𫏑","𨈊":"𨂺","𨈌":"𨄄","𨊰":"䢀","𨊸":"䢁","𨊻":"𨐆","𨋢":"䢂","𨌈":"𫐍","𨍰":"𫐔","𨎌":"𫐋","𨎮":"𨐉","𨏠":"𨐇","𨏥":"𨐊","𨞺":"𫟫","𨟊":"𫟬","𨢿":"𨡙","𨣈":"𨡺","𨣞":"𨟳","𨣧":"𨠨","𨤻":"𨤰","𨥛":"𨱀","𨥟":"𫓫","𨦫":"䦀","𨧀":"𬭊","𨧜":"䦁","𨧰":"𫟽","𨧱":"𨱊","𨨏":"𬭛","𨨛":"𫓼","𨨢":"𫓿","𨩰":"𫟾","𨪕":"𫓮","𨫒":"𨱐","𨬖":"𫔏","𨭆":"𬭶","𨭎":"𬭳","𨭖":"𫔑","𨭸":"𫔐","𨮂":"𨱕","𨮳":"𫔒","𨯅":"䥿","𨯟":"𫔓","𨰃":"𫔉","𨰋":"𫓳","𨰥":"𫔕","𨰲":"𫔃","𨲳":"𫔖","𨳑":"𨸁","𨳕":"𨸀","𨴗":"𨸅","𨴹":"𫔲","𨵩":"𨸆","𨵸":"𨸇","𨶀":"𨸉","𨶏":"𨸊","𨶮":"𨸌","𨶲":"𨸋","𨷲":"𨸎","𨼳":"𫔽","𨽏":"𨸘","𩀨":"𫕚","𩅙":"𫕨","𩎖":"𫖑","𩎢":"𩏾","𩏂":"𫖓","𩏠":"𫖖","𩏪":"𩏽","𩏷":"𫃗","𩑔":"𫖪","𩒎":"𫖭","𩓣":"𩖕","𩓥":"𫖵","𩔑":"𫖷","𩔳":"𫖴","𩖰":"𫠇","𩗀":"𩙦","𩗓":"𫗈","𩗴":"𫗉","𩘀":"𩙩","𩘝":"𩙭","𩘹":"𩙨","𩘺":"𩙬","𩙈":"𩙰","𩚛":"𩟿","𩚥":"𩠀","𩚩":"𫗡","𩚵":"𩠁","𩛆":"𩠂","𩛌":"𫗤","𩛡":"𫗨","𩛩":"𩠃","𩜇":"𩠉","𩜦":"𩠆","𩜵":"𩠊","𩝔":"𩠋","𩝽":"𫗳","𩞄":"𩠎","𩞦":"𩠏","𩞯":"䭪","𩟐":"𩠅","𩟗":"𫗚","𩠴":"𩠠","𩡣":"𩡖","𩡺":"𩧦","𩢡":"𩧬","𩢴":"𩧵","𩢸":"𩧳","𩢾":"𩧮","𩣏":"𩧶","𩣑":"䯃","𩣫":"𩧸","𩣵":"𩧻","𩣺":"𩧼","𩤊":"𩧩","𩤙":"𩨆","𩤲":"𩨉","𩤸":"𩨅","𩥄":"𩨋","𩥇":"𩨍","𩥉":"𩧱","𩥑":"𩨌","𩦠":"𫠌","𩧆":"𩨐","𩭙":"𩬣","𩯁":"𫙂","𩯳":"𩯒","𩰀":"𩬤","𩰹":"𩰰","𩳤":"𩲒","𩴵":"𩴌","𩵦":"𫠏","𩵩":"𩽺","𩵹":"𩽻","𩶁":"𫚎","𩶘":"䲞","𩶰":"𩽿","𩶱":"𩽽","𩷰":"𩾄","𩸃":"𩾅","𩸄":"𫚝","𩸡":"𫚟","𩸦":"𩾆","𩻗":"𫚨","𩻬":"𫚩","𩻮":"𫚘","𩼶":"𫚬","𩽇":"𩾎","𩿅":"𫠖","𩿤":"𫛠","𩿪":"𪉄","𪀖":"𫛧","𪀦":"𪉅","𪀾":"𪉋","𪁈":"𪉉","𪁖":"𪉌","𪂆":"𪉎","𪃍":"𪉐","𪃏":"𪉏","𪃒":"𫛻","𪃧":"𫛹","𪄆":"𪉔","𪄕":"𪉒","𪅂":"𫜂","𪆷":"𫛾","𪇳":"𪉕","𪈼":"𱊜","𪉸":"𫜊","𪋿":"𫧮","𪌭":"𫜓","𪍠":"𫜕","𪓰":"𫜟","𪔵":"𪔭","𪘀":"𪚏","𪘯":"𪚐","𪙏":"𫜯","𪟖":"𠛾","𪷓":"𣶭","𫒡":"𫓷","𫜦":"𫜫"};
function chineseCatalogEquivalent(a, b) {
  const fold = s => [...normalizeCatalogText(s)].map(c => CHINESE_COMPARISON_MAP[c] ?? c).join("");
  return Boolean(a && b && fold(a) === fold(b));
}
function normalizeCatalogText(value) {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}
function lastFmWidthPunctuationAlias(value) {
  return (value ?? "").replace(/[？]/g, "?").replace(/[！]/g, "!").replace(/[：]/g, ":").replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/[［]/g, "[").replace(/[］]/g, "]").replace(/[＃]/g, "#").replace(/[＆]/g, "&").replace(/[／]/g, "/").replace(/[～]/g, "~").replace(/　/g, " ");
}
var FUJII_KAZE_ARTIST_MBID = "c3a4aeca-8f02-4d22-b1ff-693434ab09a8";
var FUJII_KAZE_DISPLAY_NAME = "藤井 風";
var FUJII_KAZE_ARTIST_ALIASES = /* @__PURE__ */ new Set([
  "藤井風",
  "藤井风",
  "fujiikaze"
]);
function isFujiiKazeArtistName(value) {
  return FUJII_KAZE_ARTIST_ALIASES.has(normalizeCatalogText(value));
}
function applyArtistDisplayOverride(track, identity = null) {
  if (!track?.artist) return track;
  const identityConfirmsFujiiKaze = identity?.artist_mbid === FUJII_KAZE_ARTIST_MBID;
  if (!isFujiiKazeArtistName(track.artist) && !(identityConfirmsFujiiKaze && isFujiiKazeArtistName(identity?.artist))) {
    return track;
  }
  const albumArtist = track.album_artist;
  return {
    ...track,
    artist: FUJII_KAZE_DISPLAY_NAME,
    album_artist: !albumArtist || isFujiiKazeArtistName(albumArtist) ? FUJII_KAZE_DISPLAY_NAME : albumArtist,
    _artist_display_override: "fujii_kaze"
  };
}
var MUSICBRAINZ_VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";
function isVariousArtistsName(value) {
  const normalized = normalizeCatalogText(value);
  return normalized === "variousartists" || normalized === "variousartist" || normalized === "群星";
}
function normalizeAlbumArtistForLastFm(value) {
  return isVariousArtistsName(value) ? "Various Artists" : value;
}
function stripVersionQualifiers(value) {
  return (value ?? "").replace(/[\(\[（【][^\)\]）】]*(?:live|remaster(?:ed)?|version|edit|mix|acoustic|instrumental|现场|現場|演唱会|演唱會)[^\)\]）】]*[\)\]）】]/giu, " ").replace(/(?:\s*[-–—]\s*)?(?:live|remaster(?:ed)?|acoustic|instrumental|现场版|現場版)$/giu, " ").replace(/\s+/g, " ").trim();
}
function stripRedundantLiveAlbumSuffix(value) {
  return (value ?? "").replace(/\s*[\(\[（【]\s*live\s*[\)\]）】]\s*$/iu, "").replace(/\s+/g, " ").trim();
}
function catalogTitleMatchScore(sourceTitle, candidateTitle) {
  const source = normalizeCatalogText(stripVersionQualifiers(sourceTitle));
  const candidate = normalizeCatalogText(stripVersionQualifiers(candidateTitle));
  if (!source || !candidate) return 0;
  if (source === candidate) return 100;
  // Comparison only; never rewrite display strings or fold kana-bearing titles.
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(source + candidate) &&
      chineseCatalogEquivalent(source, candidate)) return 100;
  if (source.includes(candidate) || candidate.includes(source)) return 92;
  const sourceCjk = [...source].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)).join("");
  const candidateCjk = [...candidate].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)).join("");
  if (sourceCjk.length >= 3 && candidateCjk.length >= 3) {
    if (sourceCjk === candidateCjk) return 96;
    if (sourceCjk.includes(candidateCjk) || candidateCjk.includes(sourceCjk)) return 90;
  }
  const sourceTokens = new Set(stripVersionQualifiers(sourceTitle).normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const candidateTokens = new Set(stripVersionQualifiers(candidateTitle).normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (sourceTokens.size === 0 || candidateTokens.size === 0) return 0;
  const common = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
  return Math.round(80 * common / Math.max(sourceTokens.size, candidateTokens.size));
}
function metadataIndicatesLive(...values) {
  return values.some((value) => /(?:\blive\b|现场|現場|演唱会|演唱會)/iu.test(value ?? ""));
}
function versionAttributes(...values) {
  const text = values.filter(Boolean).join(" ");
  return {
    live: metadataIndicatesLive(text),
    remaster: /(?:remaster(?:ed)?|重制|重製)/iu.test(text),
    acoustic: /(?:acoustic|不插电|不插電)/iu.test(text),
    instrumental: /(?:instrumental|伴奏|純音樂|纯音乐)/iu.test(text),
    remix: /(?:remix|混音)/iu.test(text)
  };
}
function versionAttributesMatch(leftValues, rightValues) {
  const left = versionAttributes(...leftValues);
  const right = versionAttributes(...rightValues);
  return Object.keys(left).every((key) => left[key] === right[key]);
}
function musicBrainzEscape(value) {
  return (value ?? "").replace(/([\\"])/g, "\\$1");
}
var MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
var MUSICBRAINZ_NOT_FOUND = { not_found: true };
var MUSICBRAINZ_REQUEST_GAP_MS = 1100;
var lastMusicBrainzRequestAt = 0;
var musicBrainzRequestChain = Promise.resolve();
async function getMusicBrainzJson(url) {
  const request = musicBrainzRequestChain.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const waitMs = Math.max(0, lastMusicBrainzRequestAt + MUSICBRAINZ_REQUEST_GAP_MS - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      let response = null;
      let retryAfterSeconds = 0;
      try {
        response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "aScrobble/0.3.23 (https://github.com/ThisCrashesYouOnPhone/aScrobble)"
          },
          signal: AbortSignal.timeout(1e4)
        });
        lastMusicBrainzRequestAt = Date.now();
        if (response.ok) return response.json();
        if (response.status === 404) return MUSICBRAINZ_NOT_FOUND;
        if (![429, 502, 503, 504].includes(response.status)) return null;
        retryAfterSeconds = Number(response.headers.get("Retry-After") ?? 0);
      } catch (err) {
        lastMusicBrainzRequestAt = Date.now();
        if (attempt === 2) throw err;
      }
      if (attempt === 2) return null;
      const retryMs = Math.max(MUSICBRAINZ_REQUEST_GAP_MS, retryAfterSeconds * 1e3, (attempt + 1) * 1500);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    return null;
  });
  musicBrainzRequestChain = request.catch(() => null);
  return request;
}
async function searchMusicBrainzRecordings(artist, track) {
  const title = stripVersionQualifiers(track);
  if (!artist || !title) return [];
  const url = new URL(`${MUSICBRAINZ_API}/recording/`);
  url.search = new URLSearchParams({
    query: `recording:"${musicBrainzEscape(title)}" AND artist:"${musicBrainzEscape(artist)}"`,
    fmt: "json",
    limit: "15"
  }).toString();
  const data = await getMusicBrainzJson(url);
  if (data === MUSICBRAINZ_NOT_FOUND) return [];
  if (!data) throw new Error("musicbrainz_recording_search_failed");
  return Array.isArray(data?.recordings) ? data.recordings : [];
}
async function lookupMusicBrainzNativeArtistNames(artist) {
  if (!artist) return [];
  const url = new URL(`${MUSICBRAINZ_API}/artist/`);
  url.search = new URLSearchParams({ query: artist, limit: "5", fmt: "json" }).toString();
  const data = await getMusicBrainzJson(url);
  if (data === MUSICBRAINZ_NOT_FOUND) return [];
  if (!data) throw new Error("musicbrainz_artist_lookup_failed");
  const normalizedInput = normalizeCatalogText(artist);
  return (data.artists ?? []).filter((candidate) => {
    if (Number(candidate?.score ?? 0) < 90 || !candidate?.name) return false;
    if (normalizeCatalogText(candidate.name) === normalizedInput) return true;
    return (candidate.aliases ?? []).some((alias) => normalizeCatalogText(alias?.name) === normalizedInput);
  }).map((candidate) => candidate.name).filter((name) => normalizeCatalogText(name) !== normalizedInput);
}
var FORMAL_RELEASE_CACHE_VERSION = 3;
var FORMAL_RELEASE_MATCH_CACHE_MS = 180 * 24 * 60 * 60 * 1e3;
var FORMAL_RELEASE_MISS_CACHE_MS = 7 * 24 * 60 * 60 * 1e3;
function formalReleaseCacheKey(track, artist) {
  const durationSeconds = Math.round(Number(track.duration_ms ?? 0) / 1e3);
  return `lastfm-formal-release:v${FORMAL_RELEASE_CACHE_VERSION}:${md5(`${artist}\n${stripVersionQualifiers(track.name)}\n${durationSeconds}`)}`;
}
function getMusicBrainzArtistNames(recording) {
  return (recording?.["artist-credit"] ?? []).map((credit) => credit?.name ?? credit?.artist?.name).filter(Boolean);
}
function getMusicBrainzReleaseCandidates(recording, sourceTrack, canonicalArtist) {
  const sourceLive = metadataIndicatesLive(sourceTrack.name, sourceTrack.album);
  const durationMs = Number(recording?.length ?? 0);
  const sourceDurationMs = Number(sourceTrack.duration_ms ?? 0);
  const durationDiffMs = durationMs && sourceDurationMs ? Math.abs(durationMs - sourceDurationMs) : Number.POSITIVE_INFINITY;
  const titleScore = catalogTitleMatchScore(sourceTrack.name, recording?.title);
  const artistMatches = getMusicBrainzArtistNames(recording).some(
    (name) => normalizeCatalogText(name) === normalizeCatalogText(canonicalArtist)
  );
  if (!artistMatches || titleScore < 90) return [];
  if (Number.isFinite(durationDiffMs) && durationDiffMs > 5e3) return [];
  const candidates = [];
  for (const release of recording?.releases ?? []) {
    const releaseGroup = release?.["release-group"] ?? {};
    const releaseLive = metadataIndicatesLive(release?.title, ...(releaseGroup?.["secondary-types"] ?? []));
    if (sourceLive !== releaseLive) continue;
    const albumTitleScore = catalogTitleMatchScore(sourceTrack.album, release?.title);
    // MBIDs and artwork may only refine the release that was actually played;
    // they must never switch it to a compilation or another concert.
    if (sourceTrack.album && albumTitleScore < 90) continue;
    const official = release?.status === "Official";
    const primaryType = releaseGroup?.["primary-type"] ?? "";
    const formalType = ["Album", "EP", "Single"].includes(primaryType);
    if (!formalType) continue;
    let score = Number(recording?.score ?? 0) + titleScore * 2 + albumTitleScore * 3;
    if (durationDiffMs <= 1500) score += 160;
    else if (durationDiffMs <= 3e3) score += 100;
    else if (Number.isFinite(durationDiffMs)) score += 30;
    if (official) score += 120;
    if (release?.country === "TW" || release?.country === "HK") score += 20;
    candidates.push({ recording, release, releaseGroup, official, durationDiffMs, titleScore, score });
  }
  return candidates;
}
function findLastFmAlbumTrack(albumInfo, sourceTrack, recording, options = {}) {
  const albumTracks = albumInfo?.tracks?.track;
  const tracks = Array.isArray(albumTracks) ? albumTracks : albumTracks ? [albumTracks] : [];
  const sourceDurationMs = Number(sourceTrack.duration_ms ?? recording?.length ?? 0);
  const sourceTrackNumber = Number(options.verified_album_track_number ?? sourceTrack._apple_track_number ?? 0);
  const candidates = tracks.map((track) => {
    const titleScore = Math.max(
      catalogTitleMatchScore(sourceTrack.name, track?.name),
      catalogTitleMatchScore(recording?.title, track?.name)
    );
    const durationMs = Number(track?.duration ?? 0) * 1e3;
    const durationDiffMs = durationMs && sourceDurationMs ? Math.abs(durationMs - sourceDurationMs) : Number.POSITIVE_INFINITY;
    const lastFmTrackNumber = Number(track?.["@attr"]?.rank ?? 0);
    const verifiedDurationAnomaly = Boolean(
      options.allow_verified_duration_anomaly &&
      titleScore === 100 &&
      sourceTrackNumber > 0 &&
      lastFmTrackNumber === sourceTrackNumber
    );
    let score = titleScore * 3;
    if (durationDiffMs <= 1500) score += 180;
    else if (durationDiffMs <= 3e3) score += 100;
    else if (verifiedDurationAnomaly) score += 50;
    return { track, titleScore, durationDiffMs, verifiedDurationAnomaly, score };
  }).filter((candidate) => candidate.titleScore >= 90 && (
    !Number.isFinite(candidate.durationDiffMs) ||
    candidate.durationDiffMs <= 5e3 ||
    candidate.verifiedDurationAnomaly
  ));
  candidates.sort((a, b) => b.score - a.score || a.durationDiffMs - b.durationDiffMs);
  return candidates[0]?.track ?? null;
}
async function resolveFormalReleaseTrackForArtwork(track, canonicalArtist, apiKey, kv) {
  const cacheKey = formalReleaseCacheKey(track, canonicalArtist);
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, "json");
      const checkedAt = cached?.checked_at_iso ? new Date(cached.checked_at_iso).getTime() : 0;
      const maxAge = cached?.match ? FORMAL_RELEASE_MATCH_CACHE_MS : FORMAL_RELEASE_MISS_CACHE_MS;
      if (checkedAt && Date.now() - checkedAt < maxAge) {
        return cached.match ? { ...track, ...cached.track } : null;
      }
    } catch (err) {
      console.warn("Formal release cache read failed:", err);
    }
  }
  const recordings = await searchMusicBrainzRecordings(canonicalArtist, track.name).catch(() => []);
  const candidates = recordings.flatMap(
    (recording) => getMusicBrainzReleaseCandidates(recording, track, canonicalArtist)
  ).sort((a, b) => b.score - a.score || a.durationDiffMs - b.durationDiffMs);
  let match = null;
  for (const candidate of candidates.slice(0, 5)) {
    const albumInfo = await getLastFmAlbumInfo(apiKey, canonicalArtist, candidate.release.title).catch(() => null);
    if (!lastFmAlbumHasRealArtwork(albumInfo)) continue;
    const albumTrack = findLastFmAlbumTrack(albumInfo, track, candidate.recording);
    if (!albumTrack?.name) continue;
    match = {
      name: albumTrack.name,
      artist: canonicalArtist,
      album: albumInfo.name ?? candidate.release.title,
      album_artist: albumInfo.artist ?? canonicalArtist,
      duration_ms: candidate.recording.length ?? track.duration_ms,
      mbid: candidate.recording.id,
      release_mbid: candidate.release.id,
      release_group_mbid: candidate.releaseGroup.id,
      _lastfm_album_mbid: albumInfo.mbid || candidate.release.id,
      _lastfm_artwork_match: true,
      _lastfm_formal_release_match: true
    };
    break;
  }
  if (kv) {
    const record = {
      match: Boolean(match),
      track: match,
      checked_at_iso: new Date().toISOString()
    };
    await kv.put(cacheKey, JSON.stringify(record)).catch((err) => {
      console.warn("Formal release cache write failed:", err);
    });
  }
  return match ? { ...track, ...match } : null;
}
async function getLastFmArtistInfo(apiKey, artist) {
  if (!artist) return null;
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    method: "artist.getInfo",
    api_key: apiKey,
    artist,
    autocorrect: "1",
    format: "json"
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8e3) });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.artist?.name) return null;
  return {
    input: artist,
    name: data.artist.name,
    mbid: data.artist.mbid ?? "",
    playcount: Number(data.artist.stats?.playcount ?? 0)
  };
}
var LASTFM_CANONICAL_ARTIST_CACHE_VERSION = 1;
var LASTFM_CANONICAL_ARTIST_CACHE_MS = 30 * 24 * 60 * 60 * 1e3;
var APPLE_STOREFRONT_CACHE_KEY = "apple-user-storefront:v1";
var APPLE_STOREFRONT_CACHE_MS = 30 * 24 * 60 * 60 * 1e3;
var APPLE_NATIVE_SEARCH_CACHE_VERSION = 1;
var APPLE_NATIVE_SEARCH_CACHE_MS = 180 * 24 * 60 * 60 * 1e3;
var MEMORY_APPLE_STOREFRONT = null;
var APPLE_NATIVE_REGION_BY_ISRC = {
  SG: ["tw", "zh-Hant-TW"], MY: ["tw", "zh-Hant-TW"],
  TW: ["tw", "zh-Hant-TW"], HK: ["hk", "zh-Hant-HK"], MO: ["mo", "zh-Hant-MO"], CN: ["cn", "zh-Hans-CN"],
  JP: ["jp", "ja-JP"], KR: ["kr", "ko-KR"],
  US: ["us", "en-US"], GB: ["gb", "en-GB"], IE: ["ie", "en-IE"], CA: ["ca", "en-CA"], AU: ["au", "en-AU"], NZ: ["nz", "en-NZ"],
  FR: ["fr", "fr-FR"], DE: ["de", "de-DE"], AT: ["at", "de-AT"], IT: ["it", "it-IT"],
  ES: ["es", "es-ES"], MX: ["mx", "es-MX"], AR: ["ar", "es-AR"], CL: ["cl", "es-CL"], CO: ["co", "es-CO"],
  PT: ["pt", "pt-PT"], BR: ["br", "pt-BR"], NL: ["nl", "nl-NL"], BE: ["be", "nl-BE"],
  SE: ["se", "sv-SE"], NO: ["no", "nb-NO"], DK: ["dk", "da-DK"], FI: ["fi", "fi-FI"], IS: ["is", "is-IS"],
  PL: ["pl", "pl-PL"], CZ: ["cz", "cs-CZ"], SK: ["sk", "sk-SK"], HU: ["hu", "hu-HU"], RO: ["ro", "ro-RO"],
  GR: ["gr", "el-GR"], TR: ["tr", "tr-TR"], RU: ["ru", "ru-RU"], UA: ["ua", "uk-UA"],
  IL: ["il", "he-IL"], TH: ["th", "th-TH"], VN: ["vn", "vi-VN"], ID: ["id", "id-ID"]
};
function canonicalArtistCacheKey(artist) {
  return `lastfm-artist-canonical:v${LASTFM_CANONICAL_ARTIST_CACHE_VERSION}:${md5(artist)}`;
}
async function resolveLastFmCanonicalArtist(track, devToken, musicUserToken, apiKey, kv, appleVariants = null) {
  if (!track.artist) return track.artist;
  if (kv) {
    try {
      const cached = await kv.get(canonicalArtistCacheKey(track.artist), "json");
      const checkedAt = cached?.checked_at_iso ? new Date(cached.checked_at_iso).getTime() : 0;
      if (cached?.name && checkedAt && Date.now() - checkedAt < LASTFM_CANONICAL_ARTIST_CACHE_MS) {
        return cached.name;
      }
    } catch (err) {
      console.warn("Canonical artist cache read failed:", err);
    }
  }
  const variants = /* @__PURE__ */ new Set([track.artist]);
  if (track.type === "library-songs" || track.type === "songs") {
    const localizedTracks = appleVariants ?? await getAppleCatalogVariants(
      track,
      devToken,
      musicUserToken,
      kv
    );
    for (const localizedTrack of localizedTracks) {
      if (localizedTrack?.artist) variants.add(localizedTrack.artist);
    }
  }
  const infos = (await Promise.all(
    [...variants].map((artist) => getLastFmArtistInfo(apiKey, artist).catch(() => null))
  )).filter(Boolean);
  if (infos.length === 0) return track.artist;
  infos.sort((a, b) => {
    const mbidDiff = Number(Boolean(b.mbid)) - Number(Boolean(a.mbid));
    return mbidDiff || b.playcount - a.playcount;
  });
  const best = infos[0];
  if (kv) {
    const record = {
      name: best.name,
      mbid: best.mbid || null,
      checked_at_iso: new Date().toISOString(),
      aliases: [...variants]
    };
    await Promise.all(
      [...variants].map((alias) =>
        kv.put(canonicalArtistCacheKey(alias), JSON.stringify(record)).catch((err) => {
          console.warn("Canonical artist cache write failed:", err);
        })
      )
    );
  }
  return best.name;
}
function defaultLocaleForStorefront(storefront) {
  const match = Object.values(APPLE_NATIVE_REGION_BY_ISRC).find(([candidate]) => candidate === storefront);
  if (match) return match[1];
  return "en-US";
}
async function getAppleUserStorefront(devToken, musicUserToken, kv) {
  const now = Date.now();
  if (MEMORY_APPLE_STOREFRONT?.id && now - MEMORY_APPLE_STOREFRONT.checked_at_ms < APPLE_STOREFRONT_CACHE_MS) {
    return MEMORY_APPLE_STOREFRONT;
  }
  if (kv) {
    const cached = await kv.get(APPLE_STOREFRONT_CACHE_KEY, "json").catch(() => null);
    const checkedAt = cached?.checked_at_iso ? new Date(cached.checked_at_iso).getTime() : 0;
    if (cached?.id && checkedAt && now - checkedAt < APPLE_STOREFRONT_CACHE_MS) {
      MEMORY_APPLE_STOREFRONT = { ...cached, checked_at_ms: checkedAt };
      return MEMORY_APPLE_STOREFRONT;
    }
  }
  const response = await fetch(`${API_BASE}/me/storefront`, {
    headers: {
      Authorization: `Bearer ${devToken}`,
      "Music-User-Token": musicUserToken,
      ...SPOOFED_HEADERS
    },
    signal: AbortSignal.timeout(8e3)
  });
  if (!response.ok) throw new Error(`apple_storefront_http_${response.status}`);
  const data = await response.json();
  const storefront = data.data?.[0];
  if (!storefront?.id) throw new Error("apple_storefront_missing");
  const record = {
    id: storefront.id,
    locale: storefront.attributes?.defaultLanguageTag ?? defaultLocaleForStorefront(storefront.id),
    checked_at_iso: new Date(now).toISOString(),
    checked_at_ms: now
  };
  MEMORY_APPLE_STOREFRONT = record;
  if (kv) {
    const persisted = { id: record.id, locale: record.locale, checked_at_iso: record.checked_at_iso };
    await kv.put(APPLE_STOREFRONT_CACHE_KEY, JSON.stringify(persisted)).catch(() => void 0);
  }
  return record;
}
function appleCatalogItemToTrack(item, track, storefront) {
  if (!item?.attributes) return null;
  const attrs = item.attributes;
  const album = item.relationships?.albums?.data?.[0];
  const rawAlbum = attrs.albumName ?? track._apple_raw_album ?? track.album;
  return normalizeVerifiedGDragonArtist({
    ...track,
    name: attrs.name ?? track.name,
    artist: attrs.artistName ?? track.artist,
    album_artist: album?.attributes?.artistName ?? attrs.albumArtistName ?? attrs.artistName ?? track.album_artist,
    album: normalizeAlbumName(rawAlbum),
    _apple_raw_album: rawAlbum,
    duration_ms: attrs.durationInMillis ?? track.duration_ms,
    isrc: item._apple_native_isrc_unavailable === true ? null : attrs.isrc ?? track.isrc,
    catalog_id: item.id,
    _apple_artist_ids: (item.relationships?.artists?.data ?? []).map(a => a.id),
    _apple_artist_names: (item.relationships?.artists?.data ?? []).map(a => a.attributes?.name ?? null),
    _apple_lookup_method: item._apple_lookup_method ?? "catalog_id_or_isrc",
    _apple_storefront: storefront,
    _apple_album_id: album?.id,
    _apple_album_upc: album?.attributes?.upc,
    _apple_release_date: album?.attributes?.releaseDate ?? attrs.releaseDate,
    _apple_album_track_count: album?.attributes?.trackCount,
    _apple_track_number: attrs.trackNumber,
    _apple_disc_number: attrs.discNumber,
    _apple_is_compilation: attrs.isCompilation === true || album?.attributes?.isCompilation === true,
    _apple_release_structure_inferred: item._apple_release_structure_inferred === true
  });
}
function appleReleaseDateReasonablyClose(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength === 4 || shorterLength === 7) return left.slice(0, shorterLength) === right.slice(0, shorterLength);
  const leftTime = new Date(`${left}T00:00:00Z`).getTime();
  const rightTime = new Date(`${right}T00:00:00Z`).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 45 * 24 * 60 * 60 * 1e3;
}
function appleReleaseEquivalenceEvidence(source, candidate) {
  if (!source || !candidate) return { matches: true, requires_musicbrainz: false };
  const durationDiff = Math.abs(Number(source.duration_ms ?? 0) - Number(candidate.duration_ms ?? 0));
  const sourceTrackCount = Number(source._apple_album_track_count ?? 0);
  const candidateTrackCount = Number(candidate._apple_album_track_count ?? 0);
  const sourceTrackNumber = Number(source._apple_track_number ?? 0);
  const candidateTrackNumber = Number(candidate._apple_track_number ?? 0);
  const exactReleaseDate = Boolean(source._apple_release_date && candidate._apple_release_date && source._apple_release_date === candidate._apple_release_date);
  const exactTrackShape = Boolean(sourceTrackCount > 0 && candidateTrackCount === sourceTrackCount && sourceTrackNumber > 0 && candidateTrackNumber === sourceTrackNumber);
  const exactAppleCatalogRelease = Boolean(
    source.catalog_id && candidate.catalog_id && String(source.catalog_id) === String(candidate.catalog_id) &&
    source._apple_album_id && candidate._apple_album_id && String(source._apple_album_id) === String(candidate._apple_album_id) &&
    source._apple_album_upc && candidate._apple_album_upc && String(source._apple_album_upc) === String(candidate._apple_album_upc) &&
    source._apple_release_date && candidate._apple_release_date && source._apple_release_date === candidate._apple_release_date &&
    sourceTrackCount > 0 && candidateTrackCount === sourceTrackCount &&
    sourceTrackNumber > 0 && candidateTrackNumber === sourceTrackNumber
  );
  const nativeSearchEquivalentRecording = Boolean(
    source.isrc && candidate.isrc && source.isrc !== candidate.isrc &&
    candidate._apple_lookup_method === "native_catalog_search" &&
    durationDiff <= 1500 && exactReleaseDate && exactTrackShape &&
    !source._apple_is_compilation && !candidate._apple_is_compilation &&
    catalogTitleMatchScore(source.name, candidate.name) >= 90 &&
    catalogTitleMatchScore(source.album, candidate.album) >= 90
  );
  const crossIsrcNativeSearchCandidate = Boolean(
    source.isrc && candidate.isrc && source.isrc !== candidate.isrc &&
    candidate._apple_lookup_method === "native_catalog_search" &&
    durationDiff <= 1500 && exactReleaseDate && exactTrackShape &&
    !source._apple_is_compilation && !candidate._apple_is_compilation &&
    catalogTitleMatchScore(source.name, candidate.name) >= 90
  );
  if (source.isrc && candidate.isrc && source.isrc !== candidate.isrc && !crossIsrcNativeSearchCandidate) return { matches: false, requires_musicbrainz: false };
  if (durationDiff > 5e3) return { matches: false, requires_musicbrainz: false };
  if (!exactAppleCatalogRelease && !versionAttributesMatch([source.name, source.album], [candidate.name, candidate.album])) return { matches: false, requires_musicbrainz: false };
  const verifiedRegionalTrackCount = sourceTrackCount > 1 && candidateTrackCount > sourceTrackCount &&
    source.isrc && source.isrc === candidate.isrc &&
    Number(source.duration_ms) > 0 && Number(candidate.duration_ms) > 0 && durationDiff < 5000 &&
    exactReleaseDate && sourceTrackNumber > 0 && sourceTrackNumber === candidateTrackNumber &&
    Number(source._apple_disc_number) > 0 && Number(source._apple_disc_number) === Number(candidate._apple_disc_number) &&
    !source._apple_is_compilation && !candidate._apple_is_compilation &&
    source._apple_release_structure_inferred !== true && candidate._apple_release_structure_inferred !== true &&
    source._apple_artist_ids?.length > 0 && JSON.stringify(source._apple_artist_ids) === JSON.stringify(candidate._apple_artist_ids) &&
    catalogTitleMatchScore(source.name, candidate.name) === 100 &&
    catalogTitleMatchScore(source.album, candidate.album) === 100;
  if (verifiedRegionalTrackCount) return { matches: true, requires_musicbrainz: false, verified_regional_track_count: true };
  if (sourceTrackCount && candidateTrackCount && sourceTrackCount !== candidateTrackCount) return { matches: false, requires_musicbrainz: false };
  const verifiedSingle = sourceTrackCount === 1 && candidateTrackCount === 1 &&
    sourceTrackNumber === 1 && candidateTrackNumber === 1 &&
    Number(source._apple_disc_number) === 1 && Number(candidate._apple_disc_number) === 1 &&
    source.isrc && source.isrc === candidate.isrc &&
    Number(source.duration_ms) > 0 && Number(candidate.duration_ms) > 0 && durationDiff <= 5000 && exactReleaseDate &&
    !source._apple_is_compilation && !candidate._apple_is_compilation &&
    (catalogTitleMatchScore(source.name, candidate.name) >= 90 || chineseCatalogEquivalent(source.name, candidate.name)) &&
    (catalogTitleMatchScore(source.album, candidate.album) >= 90 || chineseCatalogEquivalent(source.album, candidate.album));
  if (verifiedSingle) return { matches: true, requires_musicbrainz: false,
    exact_apple_catalog_release: exactAppleCatalogRelease, single_release_equivalence: true };
  const trackNumbersDiffer = Boolean(sourceTrackNumber && candidateTrackNumber && sourceTrackNumber !== candidateTrackNumber);
  const datesDiffer = Boolean(source._apple_release_date && candidate._apple_release_date && source._apple_release_date !== candidate._apple_release_date);
  if (datesDiffer) {
    const matchingTrackCount = sourceTrackCount > 0 && candidateTrackCount === sourceTrackCount;
    if (!matchingTrackCount || !appleReleaseDateReasonablyClose(source._apple_release_date, candidate._apple_release_date)) {
      // Regional reissues may have different dates/UPCs. Require complete album
      // recording evidence rather than accepting the single matching ISRC.
      const canVerifyRegionalEdition = Boolean(matchingTrackCount && sourceTrackCount > 1 &&
        source.isrc && source.isrc === candidate.isrc && durationDiff <= 1500 &&
        !source._apple_is_compilation && !candidate._apple_is_compilation &&
        source._apple_album_id && candidate._apple_album_id && source._apple_storefront && candidate._apple_storefront);
      return { matches: false, requires_musicbrainz: false, requires_album_isrc_set: canVerifyRegionalEdition };
    }
  }
  if (trackNumbersDiffer) {
    const exactIsrcRegionalReorder = Boolean(
      source.isrc && candidate.isrc && source.isrc === candidate.isrc &&
      durationDiff <= 1500 && exactReleaseDate &&
      sourceTrackCount > 0 && candidateTrackCount === sourceTrackCount &&
      !source._apple_is_compilation && !candidate._apple_is_compilation
    );
    if (exactIsrcRegionalReorder) {
      return {
        matches: true,
        requires_musicbrainz: true,
        exact_apple_catalog_release: false,
        regional_track_order_variance: true
      };
    }
    const canCompareFullAlbums = Boolean(source.isrc && candidate.isrc && source.isrc === candidate.isrc && sourceTrackCount > 1 && candidateTrackCount === sourceTrackCount && source._apple_album_id && candidate._apple_album_id && source._apple_storefront && candidate._apple_storefront);
    return { matches: false, requires_musicbrainz: false, requires_album_isrc_set: canCompareFullAlbums };
  }
  const upcsDiffer = Boolean(source._apple_album_upc && candidate._apple_album_upc && String(source._apple_album_upc) !== String(candidate._apple_album_upc));
  const localizedAlbumTitle = Boolean(source.album && candidate.album && catalogTitleMatchScore(source.album, candidate.album) < 90);
  return {
    matches: true,
    requires_musicbrainz: candidate._apple_release_structure_inferred === true || crossIsrcNativeSearchCandidate || !exactAppleCatalogRelease && (datesDiffer || upcsDiffer || localizedAlbumTitle || Boolean(source._apple_album_id && candidate._apple_album_id && source._apple_album_id !== candidate._apple_album_id)),
    exact_apple_catalog_release: exactAppleCatalogRelease,
    cross_isrc_native_search_candidate: crossIsrcNativeSearchCandidate,
    native_search_same_title_release: nativeSearchEquivalentRecording
  };
}
function sameAppleRelease(source, candidate) {
  return appleReleaseEquivalenceEvidence(source, candidate).matches;
}
function appleAlbumIsrcSignaturesMatch(left, right, expectedCount) {
  if (!Array.isArray(left) || !Array.isArray(right) || !expectedCount || left.length !== expectedCount || right.length !== expectedCount) return false;
  const normalize = (values) => values.map((value) => String(value ?? "").toUpperCase()).filter(Boolean).sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === expectedCount && normalizedRight.length === expectedCount && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
async function getAppleAlbumIsrcSignature(track, devToken, musicUserToken, cache) {
  const albumId = track?._apple_album_id;
  const storefront = track?._apple_storefront;
  const expectedCount = Number(track?._apple_album_track_count ?? 0);
  if (!albumId || !storefront || expectedCount <= 1 || expectedCount > 100) return null;
  const cacheKey = `${storefront}:${albumId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const request = (async () => {
    const url = `${API_BASE}/catalog/${encodeURIComponent(storefront)}/albums/${encodeURIComponent(albumId)}/tracks?limit=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS
      },
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.next || !Array.isArray(data.data) || data.data.length > expectedCount) return null;
    const isrcs = data.data.map((item) => item?.attributes?.isrc).filter(Boolean);
    return isrcs.length === data.data.length ? isrcs : null;
  })().catch(() => null);
  cache.set(cacheKey, request);
  return request;
}
function regionalAlbumSubsetEvidence(source, candidate, left, right) {
  const count = Number(source?._apple_album_track_count);
  if (!Array.isArray(left) || !Array.isArray(right) || count < 2 || right.length !== count ||
      left.length < Math.max(2, Math.ceil(count * 0.8)) || left.length >= count ||
      Number(candidate._apple_album_track_count) !== count ||
      !source.isrc || source.isrc !== candidate.isrc ||
      !left.includes(source.isrc) || !right.includes(source.isrc) ||
      !source._apple_release_date || source._apple_release_date !== candidate._apple_release_date ||
      source._apple_is_compilation || candidate._apple_is_compilation ||
      Number(source._apple_track_number) !== Number(candidate._apple_track_number) ||
      Number(source._apple_disc_number) !== Number(candidate._apple_disc_number) ||
      !Number(source.duration_ms) || !Number(candidate.duration_ms) ||
      Math.abs(Number(source.duration_ms) - Number(candidate.duration_ms)) > 5000 ||
      !versionAttributesMatch([source.name, source.album], [candidate.name, candidate.album])) return false;
  const remaining = [...right];
  return left.every(isrc => { const i = remaining.indexOf(isrc); if (i < 0) return false; remaining.splice(i, 1); return true; });
}
async function chooseAppleCatalogItem(items, track, sourceTrack, devToken, musicUserToken) {
  const albumSignatureCache = /* @__PURE__ */ new Map();
  const evaluated = items.map((item) => appleCatalogItemToTrack(item, track, item._storefront)).filter(Boolean).map((candidate) => {
    const evidence = appleReleaseEquivalenceEvidence(sourceTrack, candidate);
    return { candidate, evidence };
  });
  const candidates = [];
  for (const { candidate, evidence } of evaluated) {
    if (evidence.matches && evidence.requires_musicbrainz && sourceTrack?.isrc &&
        sourceTrack.isrc === candidate.isrc && !sourceTrack._apple_is_compilation && !candidate._apple_is_compilation) {
      const [left, right] = await Promise.all([
        getAppleAlbumIsrcSignature(sourceTrack, devToken, musicUserToken, albumSignatureCache),
        getAppleAlbumIsrcSignature(candidate, devToken, musicUserToken, albumSignatureCache)
      ]);
      if (appleAlbumIsrcSignaturesMatch(left, right, Number(sourceTrack._apple_album_track_count))) {
        candidates.push({ ...candidate, _apple_release_equivalence_requires_musicbrainz: false,
          _apple_release_equivalence_method: "exact_album_isrc_set" });
        continue;
      }
      if (regionalAlbumSubsetEvidence(sourceTrack, candidate, left, right)) {
        candidates.push({ ...candidate, _apple_release_equivalence_requires_musicbrainz: true,
          _apple_release_equivalence_method: "regional_album_isrc_subset" });
        continue;
      }
    }
    if (evidence.matches) {
      candidates.push({
        ...candidate,
        _apple_release_equivalence_requires_musicbrainz: evidence.requires_musicbrainz,
        ...(evidence.single_release_equivalence ? { _apple_release_equivalence_method: "verified_single_release" } : {}),
        ...(evidence.verified_regional_track_count ? { _apple_release_equivalence_method: "verified_regional_track_count" } : {}),
        ...(evidence.exact_apple_catalog_release ? { _apple_release_equivalence_method: "exact_apple_catalog_release" } : {})
      });
      continue;
    }
    if (!evidence.requires_album_isrc_set || !sourceTrack) continue;
    const [sourceSignature, candidateSignature] = await Promise.all([
      getAppleAlbumIsrcSignature(sourceTrack, devToken, musicUserToken, albumSignatureCache),
      getAppleAlbumIsrcSignature(candidate, devToken, musicUserToken, albumSignatureCache)
    ]);
    const expectedCount = Number(sourceTrack._apple_album_track_count ?? 0);
    if (!appleAlbumIsrcSignaturesMatch(sourceSignature, candidateSignature, expectedCount)) continue;
    candidates.push({
      ...candidate,
      _apple_release_equivalence_requires_musicbrainz: false,
      _apple_release_equivalence_method: "exact_album_isrc_set"
    });
  }
  candidates.sort((a, b) => {
    const score = (candidate) => {
      const durationDiff = Math.abs(Number(track.duration_ms ?? 0) - Number(candidate.duration_ms ?? 0));
      let value = candidate.isrc && candidate.isrc === track.isrc ? 1e3 : 0;
      if (durationDiff <= 1500) value += 300;
      else if (durationDiff <= 3e3) value += 150;
      if (metadataIndicatesLive(track.name, track.album) === metadataIndicatesLive(candidate.name, candidate.album)) value += 200;
      if (sourceTrack?._apple_release_date && candidate._apple_release_date === sourceTrack._apple_release_date) value += 150;
      if (sourceTrack?._apple_album_track_count && candidate._apple_album_track_count === sourceTrack._apple_album_track_count) value += 150;
      return value;
    };
    return score(b) - score(a);
  });
  return candidates[0] ?? null;
}
function rankAppleNativeSearchItems(items, sourceTrack, limit = 3) {
  if (!Array.isArray(items) || !sourceTrack?.name) return [];
  return items.map((item, index) => {
    const attrs = item?.attributes ?? {};
    const titleScore = catalogTitleMatchScore(sourceTrack.name, attrs.name);
    const sourceDuration = Number(sourceTrack.duration_ms ?? 0);
    const candidateDuration = Number(attrs.durationInMillis ?? 0);
    const durationDiff = sourceDuration && candidateDuration
      ? Math.abs(sourceDuration - candidateDuration)
      : Number.POSITIVE_INFINITY;
    const versionMatch = versionAttributesMatch(
      [sourceTrack.name, sourceTrack.album],
      [attrs.name, attrs.albumName]
    );
    return { item, index, titleScore, durationDiff, versionMatch };
  }).filter((candidate) =>
    candidate.titleScore >= 90 &&
    candidate.durationDiff <= 5e3 &&
    candidate.versionMatch
  ).sort((a, b) =>
    b.titleScore - a.titleScore || a.durationDiff - b.durationDiff || a.index - b.index
  ).slice(0, limit).map((candidate) => candidate.item);
}
function inferAppleSearchReleaseStructure(item, sourceTrack) {
  const attrs = item?.attributes ?? {};
  const sourceTrackCount = Number(sourceTrack?._apple_album_track_count ?? 0);
  if (!attrs.albumName || !attrs.releaseDate || !attrs.trackNumber || sourceTrackCount <= 0) return null;
  let albumId = null;
  try {
    const match = new URL(attrs.url).pathname.match(/\/album\/[^/]+\/(\d+)/u);
    albumId = match?.[1] ?? null;
  } catch {
  }
  return {
    ...item,
    _apple_release_structure_inferred: true,
    relationships: {
      ...item.relationships,
      albums: {
        data: [{
          id: albumId,
          attributes: {
            artistName: attrs.artistName,
            releaseDate: attrs.releaseDate,
            trackCount: sourceTrackCount
          }
        }]
      }
    }
  };
}
function appleNativeSearchCacheKey(sourceTrack, storefront) {
  return `apple-native-search:v${APPLE_NATIVE_SEARCH_CACHE_VERSION}:${md5(`${storefront}\n${sourceTrack?.isrc ?? ""}\n${sourceTrack?.artist ?? ""}\n${sourceTrack?.name ?? ""}\n${Math.round(Number(sourceTrack?.duration_ms ?? 0) / 1e3)}`)}`;
}
async function fetchAppleITunesSearchItems(sourceTrack, locale, storefront) {
  const term = `${sourceTrack?.name ?? ""} ${sourceTrack?.artist ?? ""}`.trim();
  if (!term) return [];
  const url = new URL("https://itunes.apple.com/search");
  url.search = new URLSearchParams({
    term,
    country: storefront.toUpperCase(),
    media: "music",
    entity: "song",
    limit: "5",
    lang: locale.replace(/-/g, "_").toLowerCase()
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(12e3) });
  if (!response.ok) return [];
  const data = await response.json();
  return rankAppleNativeSearchItems((data.results ?? []).map((result) => ({
    id: String(result.trackId),
    _apple_native_isrc_unavailable: true,
    _apple_release_structure_inferred: true,
    _apple_lookup_method: "itunes_search",
    attributes: {
      name: result.trackName,
      artistName: result.artistName,
      albumName: result.collectionName,
      durationInMillis: result.trackTimeMillis,
      releaseDate: String(result.releaseDate ?? "").slice(0, 10),
      trackNumber: result.trackNumber,
      discNumber: result.discNumber,
      url: result.trackViewUrl
    },
    relationships: {
      albums: {
        data: [{
          id: result.collectionId ? String(result.collectionId) : null,
          attributes: {
            artistName: result.collectionArtistName ?? result.artistName,
            releaseDate: String(result.releaseDate ?? "").slice(0, 10),
            trackCount: result.trackCount
          }
        }]
      }
    }
  })), sourceTrack, 3);
}
async function fetchAppleNativeSearchItems(sourceTrack, devToken, musicUserToken, locale, storefront, kv = null) {
  if (!sourceTrack?.name || !sourceTrack?.artist) return [];
  const cacheKey = appleNativeSearchCacheKey(sourceTrack, storefront);
  if (kv) {
    const cached = await kv.get(cacheKey, "json").catch(() => null);
    const checkedAt = cached?.checked_at_iso ? new Date(cached.checked_at_iso).getTime() : 0;
    if (Array.isArray(cached?.items) && cached.items.length > 0 && checkedAt && Date.now() - checkedAt < APPLE_NATIVE_SEARCH_CACHE_MS) {
      return cached.items;
    }
  }
  const searchTerm = `${sourceTrack.name} ${sourceTrack.artist}`;
  const searchPath = `/catalog/${storefront}/search?term=${encodeURIComponent(searchTerm)}&types=songs&limit=5&l=${encodeURIComponent(locale)}`;
  const searchApiBases = [API_BASE, "https://amp-api.music.apple.com/v1"];
  let response = null;
  let networkFailure = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`${searchApiBases[attempt]}${searchPath}`, {
        headers: {
          Authorization: `Bearer ${devToken}`,
          "Music-User-Token": musicUserToken,
          ...SPOOFED_HEADERS
        },
        signal: AbortSignal.timeout(15e3)
      });
      if (response.ok || ![429, 502, 503, 504].includes(response.status)) break;
    } catch (err) {
      networkFailure = true;
      response = null;
      if (attempt === 1) break;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!response?.ok) {
    const iTunesItems = await fetchAppleITunesSearchItems(sourceTrack, locale, storefront).catch(() => []);
    if (iTunesItems.length > 0) {
      if (kv) await kv.put(cacheKey, JSON.stringify({ items: iTunesItems, checked_at_iso: new Date().toISOString() })).catch(() => void 0);
      return iTunesItems;
    }
    if (networkFailure) throw new Error("apple_native_search_transient_failure:network");
    if (response && [429, 502, 503, 504].includes(response.status)) throw new Error(`apple_native_search_transient_failure:http_${response.status}`);
    return [];
  }
  const data = await response.json();
  const plausibleItems = rankAppleNativeSearchItems(data?.results?.songs?.data ?? [], sourceTrack, 3);
  const items = (await Promise.all(plausibleItems.map(async (item) => {
    const album = item?.relationships?.albums?.data?.[0];
    if (album?.attributes?.releaseDate && album?.attributes?.trackCount) return item;
    const inferred = inferAppleSearchReleaseStructure(item, sourceTrack);
    if (inferred) return inferred;
    const itemUrl = `${API_BASE}/catalog/${storefront}/songs/${encodeURIComponent(item.id)}?include=albums&l=${encodeURIComponent(locale)}`;
    const itemResponse = await fetch(itemUrl, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS
      },
      signal: AbortSignal.timeout(12e3)
    });
    if (!itemResponse.ok) return null;
    const itemData = await itemResponse.json();
    return itemData?.data?.[0] ?? null;
  }))).filter(Boolean);
  if (kv && items.length > 0) {
    await kv.put(cacheKey, JSON.stringify({ items, checked_at_iso: new Date().toISOString() })).catch(() => void 0);
  }
  return items;
}
async function getAppleCatalogTrackForLastFm(track, devToken, musicUserToken, locale = "en-US", storefront = "us", useLibraryEndpoint = false, sourceTrack = null, preferNativeSearch = false, kv = null) {
  if (!track.id || track.type !== "library-songs" && track.type !== "songs") return null;
  const catalogId = track.catalog_id ?? (track.type === "songs" ? track.id : null);
  const directUrl = useLibraryEndpoint && track.type === "library-songs" ? `${API_BASE}/me/library/songs/${encodeURIComponent(track.id)}/catalog?include=albums,artists&l=${encodeURIComponent(locale)}` : `${API_BASE}/catalog/${storefront}/songs/${encodeURIComponent(catalogId ?? track.id)}?include=albums,artists&l=${encodeURIComponent(locale)}`;
  let lookupMethod = "catalog_id";
  let response = null;
  let data = null;
  let items = [];
  if (items.length === 0) {
    lookupMethod = "catalog_id";
    response = await fetch(directUrl, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS
      },
      signal: AbortSignal.timeout(8e3)
    });
    data = response.ok ? await response.json() : null;
    items = data?.data ?? [];
  }
  if (items.length === 0 && useLibraryEndpoint && catalogId) {
    const catalogUrl = `${API_BASE}/catalog/${storefront}/songs/${encodeURIComponent(catalogId)}?include=albums&l=${encodeURIComponent(locale)}`;
    response = await fetch(catalogUrl, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS
      },
      signal: AbortSignal.timeout(8e3)
    });
    data = response.ok ? await response.json() : null;
    items = data?.data ?? [];
  }
  if (items.length === 0 && track.isrc && !useLibraryEndpoint) {
    const isrcUrl = `${API_BASE}/catalog/${storefront}/songs?filter[isrc]=${encodeURIComponent(track.isrc)}&include=albums&l=${encodeURIComponent(locale)}`;
    response = await fetch(isrcUrl, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        "Music-User-Token": musicUserToken,
        ...SPOOFED_HEADERS
      },
      signal: AbortSignal.timeout(8e3)
    });
    data = response.ok ? await response.json() : null;
    items = data?.data ?? [];
    if (items.length > 0) lookupMethod = "isrc";
  }
  if (items.length === 0 && !useLibraryEndpoint && sourceTrack?.name && sourceTrack?.artist && (track.isrc || preferNativeSearch)) {
    items = await fetchAppleNativeSearchItems(sourceTrack, devToken, musicUserToken, locale, storefront, kv);
    if (items.length > 0) lookupMethod = "native_catalog_search";
  }
  const taggedItems = items.map((item) => ({ ...item, _storefront: storefront, _apple_lookup_method: item._apple_lookup_method ?? lookupMethod }));
  return chooseAppleCatalogItem(taggedItems, track, sourceTrack, devToken, musicUserToken);
}
async function getAppleCatalogVariants(track, devToken, musicUserToken, kv) {
  if (track.type !== "library-songs" && track.type !== "songs") return [];
  const storefront = await getAppleUserStorefront(devToken, musicUserToken, kv);
  const sourceTrack = await getAppleCatalogTrackForLastFm(
    track,
    devToken,
    musicUserToken,
    storefront.locale ?? defaultLocaleForStorefront(storefront.id),
    storefront.id,
    track.type === "library-songs",
    null,
    false,
    kv
  ).catch(() => null);
  const lookupTrack = sourceTrack ? { ...track, isrc: sourceTrack.isrc ?? track.isrc } : track;
  const artistRegion = await resolveArtistNativeRegion(sourceTrack ?? track, kv).catch(() => ({region:null, method:"artist_lookup_failed_preserve_source"}));
  const preferredRegion = artistRegion?.region ?? preferredAppleRegionForIsrc(lookupTrack.isrc);
  const preferredLocale = preferredRegion?.locale ?? null;
  const preferredStorefront = preferredRegion?.storefront ?? null;
  const supplementalNativeRegions = supplementalAppleNativeRegions(sourceTrack ?? lookupTrack, preferredRegion);
  const specs = [
    { storefront: storefront.id, locale: storefront.locale ?? defaultLocaleForStorefront(storefront.id), isSource: true },
    ...preferredStorefront ? [{ storefront: preferredStorefront, locale: preferredLocale, isSource: false }] : [],
    ...supplementalNativeRegions.map((region) => ({ ...region, isSource: false, preferNativeSearch: true }))
  ];
  const seenSpecs = /* @__PURE__ */ new Set();
  const uniqueSpecs = specs.filter((spec) => {
    const key = `${spec.storefront}\n${spec.locale}`;
    if (seenSpecs.has(key)) return false;
    seenSpecs.add(key);
    return true;
  });
  const crossStorefront = await Promise.all(
    uniqueSpecs.map(async (spec) => ({
      source: spec.locale,
      isSource: spec.isSource,
      required: spec.preferNativeSearch === true,
      ...await (async () => {
        try {
          const value = spec.storefront === storefront.id && sourceTrack ? sourceTrack : await getAppleCatalogTrackForLastFm(
        {
          ...lookupTrack,
          id: sourceTrack?.catalog_id ?? lookupTrack.catalog_id ?? lookupTrack.id,
          catalog_id: sourceTrack?.catalog_id ?? lookupTrack.catalog_id,
          type: "songs"
        },
        devToken,
        musicUserToken,
        spec.locale,
        spec.storefront,
        false,
        sourceTrack,
        spec.preferNativeSearch === true,
        kv
          );
          return { value, error: null };
        } catch (error) {
          return { value: null, error };
        }
      })()
    }))
  );
  const requiredTransientFailure = crossStorefront.find((entry) =>
    entry.required && entry.error instanceof Error && entry.error.message.startsWith("apple_native_search_transient_failure")
  );
  const variants = crossStorefront.filter((entry) => entry.value).map((entry) => ({
    ...entry.value,
    _metadata_source: entry.source,
    _artist_region_evidence: artistRegion,
    _is_source_storefront: entry.isSource
  }));
  // A localized primary name may not be an MB alias. Retry the verified
  // cross-storefront name only when the same primary Apple artist ID is retained.
  if (!artistRegion?.region) {
    const primaryId = sourceTrack?._apple_artist_ids?.[0];
    for (const variant of variants) {
      if (!primaryId || variant._apple_artist_ids?.[0] !== primaryId || variant._is_source_storefront ||
          variant._apple_release_equivalence_requires_musicbrainz !== false) continue;
      const alternate = await resolveArtistNativeRegion(variant, kv).catch(() => null);
      if (alternate?.region) {
        for (const value of variants) value._artist_region_evidence = alternate;
        if (!variants.some(v => v._metadata_source === alternate.region.locale)) {
          const native = await getAppleCatalogTrackForLastFm(
            { ...lookupTrack, id: sourceTrack?.catalog_id ?? lookupTrack.catalog_id ?? lookupTrack.id,
              catalog_id: sourceTrack?.catalog_id ?? lookupTrack.catalog_id, type: "songs" },
            devToken, musicUserToken, alternate.region.locale, alternate.region.storefront,
            false, sourceTrack, false, kv
          ).catch(() => null);
          if (native) variants.push({ ...native, _metadata_source: alternate.region.locale,
            _artist_region_evidence: alternate, _is_source_storefront: false });
        }
        break;
      }
    }
  }
  variants._apple_native_lookup_transient = Boolean(requiredTransientFailure);
  return variants;
}
function preferredAppleRegionForIsrc(isrc) {
  const territory = (isrc ?? "").slice(0, 2).toUpperCase();
  const region = APPLE_NATIVE_REGION_BY_ISRC[territory];
  return region ? { storefront: region[0], locale: region[1] } : null;
}
async function resolveArtistNativeRegion(track, kv) {
  if (!track?.artist) return null;
  // Region follows the first credited artist; never alter the complete credit.
  const primaryArtist = track._apple_artist_names?.[0] ||
    (track._apple_artist_ids?.length > 1 ? track.artist.split(/\s+&\s+|,\s+/u)[0] : track.artist);
  const key = `artist-native-region:v2:${md5(`${track._apple_artist_ids?.[0] ?? ""}\n${primaryArtist}`)}`;
  const cached = await kv?.get(key, "json").catch(() => null);
  if (cached && Date.now() - Date.parse(cached.checked_at_iso) < 30 * 864e5) return cached.evidence;
  const url = new URL(`${MUSICBRAINZ_API}/artist/`);
  url.search = new URLSearchParams({query: primaryArtist, limit: "25", fmt: "json"}).toString();
  const data = await getMusicBrainzJson(url);
  const input = normalizeCatalogText(primaryArtist);
  const matches = [...new Map((data?.artists ?? []).filter(a => a.id && Number(a.score) >= 95 &&
    [a.name, ...(a.aliases ?? []).map(x => x.name)].some(n => normalizeCatalogText(n) === input)).map(a => [a.id, a])).values()];
  let evidence = { region: null, method: "unresolved_artist_preserve_source" };
  if (matches.length === 1) {
    const a = matches[0];
    const country = a.country ?? a.area?.["iso-3166-1-codes"]?.[0];
    const region = APPLE_NATIVE_REGION_BY_ISRC[["SG", "MY"].includes(country) ? "TW" : country];
    if (region) evidence = {artist_mbid:a.id, name:a.name, country, primary_artist:primaryArtist, primary_apple_artist_id:track._apple_artist_ids?.[0] ?? null, region:{storefront:region[0],locale:region[1]}, method:"musicbrainz_primary_artist_region"};
  }
  await kv?.put(key, JSON.stringify({evidence, checked_at_iso:new Date().toISOString()})).catch(() => void 0);
  return evidence;
}
function preferredLocaleForIsrc(isrc) {
  return preferredAppleRegionForIsrc(isrc)?.locale ?? null;
}
var TRADITIONAL_CHINESE_SIGNAL = /[愛戀夢飛紀錄臺灣與為來開關學樂說話這個們長時會還讓裡麼後發現實際應該專輯體風雲點種樣萬無氣聲頭從經過將進覺藝鄉廣傷]/u;
function metadataSuggestsTraditionalChinese(track) {
  return TRADITIONAL_CHINESE_SIGNAL.test([track?.artist, track?.album_artist, track?.name, track?.album, track?._apple_raw_album].filter(Boolean).join(" "));
}
function supplementalAppleNativeRegions(track, preferredRegion) {
  const metadata = [track?.artist, track?.album_artist, track?.name, track?.album, track?._apple_raw_album].filter(Boolean).join(" ");
  // ISRC registrant country must not suppress a Korean-language lookup.
  if (/\p{Script=Hangul}/u.test(metadata) && preferredRegion?.storefront !== "kr") return [{ storefront: "kr", locale: "ko-KR" }];
  // An unknown ISRC registrant territory must not disable native discovery.
  // Script selects candidates only; release equivalence still gates adoption.
  if (!preferredRegion) {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(metadata)) return [{ storefront: "jp", locale: "ja-JP" }];
    if (/\p{Script=Hangul}/u.test(metadata)) return [{ storefront: "kr", locale: "ko-KR" }];
    if (/\p{Script=Han}/u.test(metadata)) return [{ storefront: "hk", locale: "zh-Hant-HK" }, { storefront: "tw", locale: "zh-Hant-TW" }];
  }
  const chineseRegionalFallback = /\p{Script=Han}/u.test(metadata) && ["cn", "hk", "mo"].includes(preferredRegion?.storefront);
  if (!metadataSuggestsTraditionalChinese(track) && !chineseRegionalFallback) return [];
  if (preferredRegion?.storefront === "tw") return [];
  return [{ storefront: "tw", locale: "zh-Hant-TW" }];
}
var MUSICBRAINZ_IDENTITY_CACHE_VERSION = 21;
var MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS = 180 * 24 * 60 * 60 * 1e3;
var MUSICBRAINZ_IDENTITY_MISS_CACHE_MS = 24 * 60 * 60 * 1e3;
function musicBrainzIdentityCacheKey(track, version = MUSICBRAINZ_IDENTITY_CACHE_VERSION) {
  return `musicbrainz-identity:v${version}:${md5(`${track.isrc ?? ""}\n${track.artist}\n${track.name}\n${track.album}\n${Math.round(Number(track.duration_ms ?? 0) / 1e3)}`)}`;
}
async function lookupMusicBrainzRecordingsByIsrc(isrc) {
  if (!isrc) return [];
  const url = new URL(`${MUSICBRAINZ_API}/isrc/${encodeURIComponent(isrc)}`);
  url.search = new URLSearchParams({ inc: "artist-credits", fmt: "json" }).toString();
  const data = await getMusicBrainzJson(url);
  if (data === MUSICBRAINZ_NOT_FOUND) return [];
  if (!data) throw new Error("musicbrainz_isrc_lookup_failed");
  return Array.isArray(data?.recordings) ? data.recordings : [];
}
async function hydrateMusicBrainzRecording(recording) {
  if (!recording?.id) return null;
  const url = new URL(`${MUSICBRAINZ_API}/recording/${encodeURIComponent(recording.id)}`);
  url.search = new URLSearchParams({
    inc: "artist-credits+releases+release-groups+media",
    fmt: "json"
  }).toString();
  const data = await getMusicBrainzJson(url);
  if (data === MUSICBRAINZ_NOT_FOUND) return null;
  if (!data) throw new Error("musicbrainz_recording_hydration_failed");
  return data;
}
async function hydrateMusicBrainzRelease(releaseId) {
  if (!releaseId) return null;
  const url = new URL(`${MUSICBRAINZ_API}/release/${encodeURIComponent(releaseId)}`);
  url.search = new URLSearchParams({
    inc: "artist-credits+recordings+release-groups+media",
    fmt: "json"
  }).toString();
  const data = await getMusicBrainzJson(url);
  if (data === MUSICBRAINZ_NOT_FOUND) return null;
  if (!data) throw new Error("musicbrainz_release_hydration_failed");
  return data;
}
function bestCatalogTitleScore(values, candidate) {
  return Math.max(0, ...values.filter(Boolean).map((value) => catalogTitleMatchScore(value, candidate)));
}
function musicBrainzReleaseTrackEvidence(release, recording, appleTracks, isrcExact = false) {
  const source = appleTracks.find((track) => track._is_source_storefront) ?? appleTracks[0];
  const relatedTracks = (release?.media ?? []).flatMap((medium) => medium?.tracks ?? []);
  if (relatedTracks.length === 0) return { associated: true, track_number_match: false, track_count_match: false };
  const sourceTrackNumber = Number(source?._apple_track_number ?? 0);
  const sourceTrackCount = Number(source?._apple_album_track_count ?? 0);
  const matchingTracks = relatedTracks.filter((track) => {
    const titleScore = bestCatalogTitleScore(appleTracks.map((item) => item.name), track?.title ?? recording?.title);
    const durationMs = Number(track?.length ?? recording?.length ?? 0);
    const sourceDurationMs = Number(source?.duration_ms ?? 0);
    const recordingIdMatch = Boolean(recording?.id && track?.recording?.id && recording.id === track.recording.id);
    const durationMatches = !durationMs || !sourceDurationMs || Math.abs(durationMs - sourceDurationMs) <= 5e3;
    // The recording endpoint returns only this recording's occurrences inside
    // each release, but those medium tracks do not always repeat recording.id.
    // For an exact-ISRC recording, the release structure can safely identify
    // that occurrence even when Apple localized the title into another script.
    const exactIsrcReleaseOccurrence = Boolean(
      isrcExact && recording?.id && durationMatches &&
      sourceTrackNumber > 0 && Number(track?.position ?? track?.number ?? 0) === sourceTrackNumber &&
      sourceTrackCount > 0 && (release?.media ?? []).some((medium) =>
        Number(medium?.["track-count"] ?? 0) === sourceTrackCount &&
        (medium?.tracks ?? []).includes(track)
      )
    );
    return (recordingIdMatch || titleScore >= 90 || exactIsrcReleaseOccurrence) && durationMatches;
  });
  const associated = matchingTracks.length > 0;
  const trackNumberMatch = sourceTrackNumber > 0 && matchingTracks.some((track) => Number(track?.position ?? track?.number ?? 0) === sourceTrackNumber);
  const trackCountMatch = sourceTrackCount > 0 && (release?.media ?? []).some((medium) => Number(medium?.["track-count"] ?? 0) === sourceTrackCount);
  return { associated, track_number_match: trackNumberMatch, track_count_match: trackCountMatch };
}
function musicBrainzReleaseDateClose(appleDate, musicBrainzDate) {
  if (!appleDate || !musicBrainzDate) return false;
  if (appleDate === musicBrainzDate) return true;
  const shorterLength = Math.min(appleDate.length, musicBrainzDate.length);
  if (shorterLength === 4 || shorterLength === 7) return appleDate.slice(0, shorterLength) === musicBrainzDate.slice(0, shorterLength);
  const appleTime = new Date(`${appleDate}T00:00:00Z`).getTime();
  const musicBrainzTime = new Date(`${musicBrainzDate}T00:00:00Z`).getTime();
  return Number.isFinite(appleTime) && Number.isFinite(musicBrainzTime) && Math.abs(appleTime - musicBrainzTime) <= 45 * 24 * 60 * 60 * 1e3;
}
function verifiedLiveCompilationConflict(recording, release, appleTracks) {
  if (release?.status !== "Official" || !(release["release-group"]?.["secondary-types"] ?? []).includes("Compilation")) return false;
  const source = appleTracks.find(t => t._is_source_storefront) ?? appleTracks[0];
  if (!source || source._apple_is_compilation || !metadataIndicatesLive(source.name, source.album) ||
      !metadataIndicatesLive(recording?.title, release.title) ||
      !musicBrainzReleaseDateClose(source._apple_release_date, release.date)) return false;
  const albumKey = (title, artists) => {
    let key = normalizeCatalogText(stripVersionQualifiers(title));
    for (const artist of artists) {
      const prefix = normalizeCatalogText(artist);
      if (prefix && key.startsWith(prefix)) key = key.slice(prefix.length);
    }
    return key;
  };
  const artists = getMusicBrainzArtistNames(release);
  if (!artists.some(a => appleTracks.some(t => normalizeCatalogText(t.artist) === normalizeCatalogText(a)))) return false;
  if (!appleTracks.some(t => albumKey(t.album, [t.artist, t.album_artist].filter(Boolean)) === albumKey(release.title, artists))) return false;
  const media = [...(release.media ?? [])].sort((a,b)=>Number(a.position)-Number(b.position));
  if (!media.length || media.some((m,i)=>Number(m.position)!==i+1 || !m.tracks?.length || m.tracks.length!==Number(m["track-count"]))) return false;
  const tracks = media.flatMap(m => [...m.tracks].sort((a,b)=>Number(a.position)-Number(b.position)));
  if (media.some(m=>[...m.tracks].sort((a,b)=>Number(a.position)-Number(b.position)).some((t,i)=>Number(t.position)!==i+1 || !t.recording?.id))) return false;
  if (tracks.length !== Number(source._apple_album_track_count) || Number(source._apple_disc_number)!==1) return false;
  const target = tracks[Number(source._apple_track_number)-1];
  return Boolean(target?.recording?.id === recording?.id &&
    bestCatalogTitleScore(appleTracks.map(t=>t.name), target.title) >= 90 &&
    Number(target.length)>0 && Number(source.duration_ms)>0 &&
    Math.abs(Number(target.length)-Number(source.duration_ms))<=1500);
}
function scoreMusicBrainzIdentityCandidate(recording, release, appleTracks, isrcExact, allowCrossLanguageReleaseGroup = false) {
  const artists = getMusicBrainzArtistNames(recording);
  const appleArtists = appleTracks.flatMap((track) => [track.artist, track.album_artist]).filter(Boolean);
  const artistMatches = artists.some((artist) => appleArtists.some((candidate) => normalizeCatalogText(artist) === normalizeCatalogText(candidate)));
  if (!artistMatches && !isrcExact) return null;
  const titleScore = bestCatalogTitleScore(appleTracks.map((track) => track.name), recording?.title);
  if (titleScore < 90 && !isrcExact) return null;
  const sourceDurationMs = Number((appleTracks.find((track) => track._is_source_storefront) ?? appleTracks[0])?.duration_ms ?? 0);
  const durationDiffMs = recording?.length && sourceDurationMs ? Math.abs(Number(recording.length) - sourceDurationMs) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(durationDiffMs) && durationDiffMs > 5e3) return null;
  const releaseGroup = release?.["release-group"] ?? {};
  const exactNativeAppleTrack = appleTracks.find((track) => track._apple_release_equivalence_method === "exact_apple_catalog_release" && !track._is_source_storefront);
  const sourceVersionValues = (exactNativeAppleTrack ? [exactNativeAppleTrack] : appleTracks).flatMap((track) => [track.name, track.album]);
  const mbVersionValues = [recording?.title, recording?.disambiguation, release?.title, ...(releaseGroup?.["secondary-types"] ?? [])];
  if (!versionAttributesMatch(sourceVersionValues, mbVersionValues)) return null;
  if (!release) {
    if (!isrcExact) return null;
    return { score: 900, titleScore, durationDiffMs, recording, release: null, releaseGroup: null };
  }
  if (release.status !== "Official") return null;
  const primaryType = releaseGroup?.["primary-type"] ?? "";
  if (!["Album", "EP", "Single"].includes(primaryType)) return null;
  const secondaryTypes = releaseGroup?.["secondary-types"] ?? [];
  const verifiedClassificationConflict = verifiedLiveCompilationConflict(recording, release, appleTracks);
  if (secondaryTypes.includes("Compilation") && !appleTracks.some((track) => track._apple_is_compilation) && !verifiedClassificationConflict) return null;
  const albumNames = appleTracks.map((track) => track.album);
  const albumTitleScore = Math.max(
    verifiedClassificationConflict ? 100 : 0,
    bestCatalogTitleScore(albumNames, release.title),
    bestCatalogTitleScore(albumNames, releaseGroup.title)
  );
  const trackEvidence = musicBrainzReleaseTrackEvidence(release, recording, appleTracks, isrcExact);
  if (verifiedClassificationConflict) Object.assign(trackEvidence, { associated: true, track_number_match: true, track_count_match: true });
  if (!trackEvidence.associated) return null;
  const source = appleTracks.find((track) => track._is_source_storefront) ?? appleTracks[0];
  const appleDate = source?._apple_release_date ?? "";
  const mbDate = release.date ?? releaseGroup?.["first-release-date"] ?? "";
  const dateMatch = Boolean(appleDate && mbDate && (appleDate === mbDate || appleDate.slice(0, 4) === mbDate.slice(0, 4)));
  const closeDateMatch = musicBrainzReleaseDateClose(appleDate, mbDate);
  const barcodeMatch = Boolean(source?._apple_album_upc && release?.barcode && String(source._apple_album_upc) === String(release.barcode));
  const digitalMediumMatch = (release?.media ?? []).some((medium) => medium?.format === "Digital Media" && Number(medium?.["track-count"] ?? 0) === Number(source?._apple_album_track_count ?? 0));
  const crossScriptMediumEvidence = Boolean(
    allowCrossLanguageReleaseGroup &&
    titleScore >= 96 &&
    durationDiffMs <= 1500 &&
    trackEvidence.track_number_match &&
    trackEvidence.track_count_match &&
    closeDateMatch &&
    !secondaryTypes.includes("Compilation") &&
    Number(source?._apple_album_track_count ?? 0) > 1
  );
  const releaseAliasEvidence = albumTitleScore < 90 && (
    allowCrossLanguageReleaseGroup && isrcExact && trackEvidence.track_number_match && trackEvidence.track_count_match && (closeDateMatch || barcodeMatch) ||
    crossScriptMediumEvidence
  );
  if (albumTitleScore < 90 && !releaseAliasEvidence) return null;
  let score = (isrcExact ? 1e3 : 0) + titleScore * 3 + albumTitleScore * 4 + 250;
  if (durationDiffMs <= 1500) score += 250;
  else if (durationDiffMs <= 3e3) score += 120;
  if (dateMatch) score += 120;
  if (trackEvidence.track_number_match) score += 100;
  if (trackEvidence.track_count_match) score += 80;
  if (digitalMediumMatch) score += 150;
  if (barcodeMatch) score += 100;
  if (release.country === "TW" || release.country === "JP" || release.country === "HK") score += 20;
  return { score, titleScore, albumTitleScore, durationDiffMs, dateMatch, closeDateMatch, barcodeMatch, digitalMediumMatch, releaseAliasEvidence, trackEvidence, recording, release, releaseGroup };
}
function rankMusicBrainzRecordingCandidates(recordings, appleTracks) {
  const source = appleTracks.find(t => t._is_source_storefront) ?? appleTracks[0] ?? {};
  const sourceDuration = Number(source.duration_ms ?? 0);
  const sourceVersion = versionAttributes(...appleTracks.flatMap(t => [t.name, t.album]));
  const seen = new Set();
  return recordings.filter(r => {
    if (!r?.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  }).map((recording, index) => {
    const duration = Number(recording.length ?? 0);
    const difference = duration > 0 && sourceDuration > 0 ? Math.abs(duration - sourceDuration) : null;
    const releases = recording.releases ?? [];
    const albumScore = Math.max(0, ...releases.map(r => bestCatalogTitleScore(appleTracks.map(t => t.album), r.title)));
    const candidateVersion = versionAttributes(recording.title, recording.disambiguation, ...releases.flatMap(r => [r.title, ...(r["release-group"]?.["secondary-types"] ?? [])]));
    const score = albumScore * 5 + (difference === null ? 0 : difference <= 1500 ? 300 : difference <= 5000 ? 150 : -1000) + (sourceVersion.live && candidateVersion.live ? 200 : !sourceVersion.live && candidateVersion.live ? -500 : 0);
    return { recording, index, difference, score };
  }).filter(r => r.difference === null || r.difference <= 5000)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(r => r.recording);
}
async function resolveMusicBrainzIdentity(track, appleTracks, kv) {
  const cacheKey = musicBrainzIdentityCacheKey(track);
  if (kv) {
    const cached = await kv.get(cacheKey, "json").catch(() => null);
    const checkedAt = cached?.checked_at_iso ? new Date(cached.checked_at_iso).getTime() : 0;
    const maxAge = cached?.identity ? MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS : MUSICBRAINZ_IDENTITY_MISS_CACHE_MS;
    if (checkedAt && Date.now() - checkedAt < maxAge) return cached.identity ?? null;
    for (const legacyVersion of [18, 17, 16, 8, 7, 6, 5, 4]) {
      const legacy = await kv.get(musicBrainzIdentityCacheKey(track, legacyVersion), "json").catch(() => null);
      const legacyCheckedAt = legacy?.checked_at_iso ? new Date(legacy.checked_at_iso).getTime() : 0;
      if (!legacy?.identity?.release_mbid || !legacyCheckedAt || Date.now() - legacyCheckedAt >= MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS) continue;
      if (track._apple_is_compilation === true && !legacy.identity.album_artist) continue;
      const upgradedIdentity = {
        ...legacy.identity,
        version_attributes: legacy.identity.version_attributes ?? versionAttributes(track.name, track.album)
      };
      await kv.put(cacheKey, JSON.stringify({ identity: upgradedIdentity, checked_at_iso: new Date().toISOString() })).catch(() => void 0);
      return upgradedIdentity;
    }
  }
  let isrcExact = false;
  let recordings = [];
  let scoringAppleTracks = appleTracks;
  let lookupFailed = false;
  if (track.isrc) {
    try {
      recordings = await lookupMusicBrainzRecordingsByIsrc(track.isrc);
    } catch (err) {
      lookupFailed = true;
      recordings = [];
    }
    isrcExact = recordings.length > 0;
  }
  if (recordings.length === 0) {
    const searchTracks = [...appleTracks].sort((a, b) => Number(Boolean(b._metadata_source === preferredLocaleForIsrc(track.isrc))) - Number(Boolean(a._metadata_source === preferredLocaleForIsrc(track.isrc))));
    const seen = /* @__PURE__ */ new Set();
    for (const candidate of searchTracks.slice(0, 2)) {
      const key = `${candidate.artist}\n${stripVersionQualifiers(candidate.name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let found = [];
      try {
        found = await searchMusicBrainzRecordings(candidate.artist, candidate.name);
      } catch (err) {
        lookupFailed = true;
        continue;
      }
      recordings.push(...found);
      if (found.length > 0) break;
    }
  }
  if (recordings.length === 0) {
    const sourceArtists = [...new Set(appleTracks.flatMap((candidate) => [candidate.artist, candidate.album_artist]).filter(Boolean))].slice(0, 2);
    const nativeArtistNames = [];
    for (const sourceArtist of sourceArtists) {
      try {
        nativeArtistNames.push(...await lookupMusicBrainzNativeArtistNames(sourceArtist));
      } catch (err) {
        lookupFailed = true;
      }
    }
    const uniqueNativeArtistNames = [...new Set(nativeArtistNames)];
    const source = appleTracks.find((candidate) => candidate._is_source_storefront) ?? appleTracks[0] ?? track;
    const nativeAliasTracks = uniqueNativeArtistNames.map((artist) => ({
      ...source,
      artist,
      album_artist: artist,
      _metadata_source: "musicbrainz_artist_alias",
      _is_source_storefront: false
    }));
    scoringAppleTracks = [...appleTracks, ...nativeAliasTracks];
    for (const candidate of nativeAliasTracks.slice(0, 2)) {
      let found = [];
      try {
        found = await searchMusicBrainzRecordings(candidate.artist, candidate.name);
      } catch (err) {
        lookupFailed = true;
        continue;
      }
      recordings.push(...found);
      if (found.length > 0) break;
    }
  }
  const sourceArtistNames = new Set(appleTracks.flatMap((candidate) => [candidate.artist, candidate.album_artist]).filter(Boolean).map(normalizeCatalogText));
  const recordingAliasArtistNames = [];
  for (const recording of recordings) {
    for (const credit of recording?.["artist-credit"] ?? []) {
      const nativeName = credit?.name ?? credit?.artist?.name;
      const aliases = credit?.artist?.aliases ?? [];
      if (!nativeName || !aliases.some((alias) => sourceArtistNames.has(normalizeCatalogText(alias?.name)))) continue;
      recordingAliasArtistNames.push(nativeName);
    }
  }
  if (recordingAliasArtistNames.length > 0) {
    const source = appleTracks.find((candidate) => candidate._is_source_storefront) ?? appleTracks[0] ?? track;
    const existingArtists = new Set(scoringAppleTracks.flatMap((candidate) => [candidate.artist, candidate.album_artist]).filter(Boolean).map(normalizeCatalogText));
    const recordingAliasTracks = [...new Set(recordingAliasArtistNames)].filter((artist) => !existingArtists.has(normalizeCatalogText(artist))).map((artist) => ({
      ...source,
      artist,
      album_artist: artist,
      _metadata_source: "musicbrainz_recording_artist_alias",
      _is_source_storefront: false
    }));
    scoringAppleTracks = [...scoringAppleTracks, ...recordingAliasTracks];
  }
  const hydrated = [];
  const seenRecordings = /* @__PURE__ */ new Set();
  let hydrationFailed = false;
  for (const recording of rankMusicBrainzRecordingCandidates(recordings, scoringAppleTracks).slice(0, 5)) {
    if (!recording?.id || seenRecordings.has(recording.id)) continue;
    seenRecordings.add(recording.id);
    let full = null;
    try {
      full = await hydrateMusicBrainzRecording(recording);
    } catch (err) {
      hydrationFailed = true;
    }
    hydrated.push(full ?? recording);
  }
  const scored = [];
  for (const recording of hydrated) {
    const releases = Array.isArray(recording?.releases) && recording.releases.length > 0 ? recording.releases : [null];
    const releaseAliases = [];
    let conflictHydrations = 0;
    for (let release of releases) {
      if ((release?.["release-group"]?.["secondary-types"] ?? []).includes("Compilation") &&
          !appleTracks.some(t=>t._apple_is_compilation) && metadataIndicatesLive(recording.title, release.title) &&
          conflictHydrations++ < 3) {
        try { release = await hydrateMusicBrainzRelease(release.id) ?? release; }
        catch { hydrationFailed = true; }
      }
      const candidate = scoreMusicBrainzIdentityCandidate(recording, release, scoringAppleTracks, isrcExact, true);
      if (!candidate) continue;
      if (candidate.releaseAliasEvidence) releaseAliases.push(candidate);
      else scored.push(candidate);
    }
    const aliasReleaseGroups = new Set(releaseAliases.map((candidate) => candidate.releaseGroup?.id).filter(Boolean));
    if (releaseAliases.length > 0 && aliasReleaseGroups.size === 1) {
      scored.push(...releaseAliases);
    }
    if (isrcExact && releases.some(Boolean)) {
      const recordingOnly = scoreMusicBrainzIdentityCandidate(recording, null, scoringAppleTracks, true);
      if (recordingOnly) scored.push(recordingOnly);
    }
  }
  scored.sort((a, b) => b.score - a.score || a.durationDiffMs - b.durationDiffMs);
  let best = scored[0];
  if (best?.release?.id && appleTracks.some((candidate) => candidate._apple_is_compilation === true)) {
    try {
      const hydratedRelease = await hydrateMusicBrainzRelease(best.release.id);
      const hydratedCandidate = scoreMusicBrainzIdentityCandidate(
        best.recording,
        hydratedRelease,
        scoringAppleTracks,
        isrcExact,
        true
      );
      if (hydratedCandidate) best = { ...hydratedCandidate, score: Math.max(best.score, hydratedCandidate.score) };
    } catch (err) {
      console.warn(`MusicBrainz compilation release hydration skipped for ${best.release.id}:`, err);
    }
  }
  const secondDifferentRecording = scored.find((candidate) => candidate.recording?.id !== best?.recording?.id);
  const recordingUnambiguous = Boolean(best) && (!secondDifferentRecording || best.score - secondDifferentRecording.score >= 40);
  let identity = null;
  if (best && recordingUnambiguous) {
    const sameRecordingReleases = scored.filter((candidate) => candidate.recording?.id === best.recording?.id && candidate.release);
    const secondRelease = sameRecordingReleases.find((candidate) => candidate.release?.id !== best.release?.id);
    const aliasGroupConfirmed = Boolean(best.releaseAliasEvidence) && sameRecordingReleases.filter((candidate) => candidate.releaseAliasEvidence).every((candidate) => candidate.releaseGroup?.id === best.releaseGroup?.id);
    const releaseTitleConfirmed = best.albumTitleScore >= 90 || aliasGroupConfirmed;
    const releaseConfirmed = Boolean(best.release) && releaseTitleConfirmed && (!secondRelease || best.score - secondRelease.score >= 20 || !best.releaseAliasEvidence && best.releaseGroup?.id === secondRelease.releaseGroup?.id);
    const releaseGroupConfirmed = Boolean(best.releaseGroup?.id) && releaseTitleConfirmed;
    const releaseGroupReleaseMbids = releaseGroupConfirmed ? sameRecordingReleases.filter((candidate) => candidate.releaseGroup?.id === best.releaseGroup.id).map((candidate) => candidate.release?.id).filter(Boolean) : [];
    identity = {
      confirmed: true,
      method: isrcExact ? "isrc" : "strict_search",
      recording_mbid: best.recording.id,
      release_mbid: releaseConfirmed ? best.release.id : null,
      release_group_mbid: releaseGroupConfirmed ? best.releaseGroup.id : null,
      artist_mbid: best.recording?.["artist-credit"]?.[0]?.artist?.id ?? null,
      artist: getMusicBrainzArtistNames(best.recording)[0] ?? track.artist,
      track: best.recording.title,
      album: releaseConfirmed ? best.release.title : null,
      album_artist: releaseConfirmed
        ? getMusicBrainzArtistNames(best.release)[0] ?? track.album_artist ?? track.artist
        : null,
      release_track_count: releaseConfirmed
        ? (best.release?.media ?? []).reduce((total, medium) => total + Number(medium?.["track-count"] ?? 0), 0)
        : null,
      release_track_number_confirmed: releaseConfirmed ? best.trackEvidence?.track_number_match === true : false,
      release_group: releaseGroupConfirmed ? best.releaseGroup?.title ?? null : null,
      release_group_release_mbids: [...new Set(releaseGroupReleaseMbids)],
      confirmed_apple_album_titles: verifiedLiveCompilationConflict(best.recording, best.release, appleTracks)
        ? appleTracks.filter(t => t.isrc && t.isrc === track.isrc && Number(t.duration_ms) === Number(track.duration_ms) &&
          Number(t._apple_track_number) === Number(track._apple_track_number) && Number(t._apple_disc_number) === Number(track._apple_disc_number) &&
          Number(t._apple_album_track_count) === (best.release.media ?? []).reduce((n,m)=>n+Number(m["track-count"]),0) &&
          musicBrainzReleaseDateClose(t._apple_release_date, best.release.date)).map(t=>t.album) : [],
      release_equivalence_method: verifiedLiveCompilationConflict(best.recording, best.release, appleTracks) ? "verified_live_classification_conflict" : best.releaseAliasEvidence ? "isrc_medium_release_group" : null,
      version_attributes: versionAttributes(
        best.recording?.title,
        best.recording?.disambiguation,
        best.release?.title,
        ...(best.releaseGroup?.["secondary-types"] ?? [])
      ),
      score: best.score
    };
  }
  const expectedNativeLocale = preferredLocaleForIsrc(track.isrc);
  const nativeAppleLookupIncomplete = Boolean(
    expectedNativeLocale &&
    !appleTracks.some((candidate) => candidate?._metadata_source === expectedNativeLocale)
  );
  if (kv && (identity || !lookupFailed && !hydrationFailed && !nativeAppleLookupIncomplete)) {
    await kv.put(cacheKey, JSON.stringify({ identity, checked_at_iso: new Date().toISOString() })).catch(() => void 0);
  }
  if (!identity && (lookupFailed || hydrationFailed)) {
    throw new Error("musicbrainz_identity_transient_failure");
  }
  return identity;
}
var SPOTIFY_TOKEN_CACHE = null;
async function getSpotifyClientToken(env) {
  if (!env?.SPOTIFY_CLIENT_ID || !env?.SPOTIFY_CLIENT_SECRET) return null;
  if (SPOTIFY_TOKEN_CACHE?.token && SPOTIFY_TOKEN_CACHE.expires_at_ms > Date.now() + 6e4) return SPOTIFY_TOKEN_CACHE.token;
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(8e3)
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.access_token) return null;
  SPOTIFY_TOKEN_CACHE = { token: data.access_token, expires_at_ms: Date.now() + Number(data.expires_in ?? 3600) * 1e3 };
  return data.access_token;
}
async function getConditionalSpotifyEvidence(track, appleTracks, identity, env) {
  if (!track.isrc || !env?.SPOTIFY_CLIENT_ID || !env?.SPOTIFY_CLIENT_SECRET) return null;
  if (appleTracks.length > 1 && identity?.recording_mbid && identity?.release_mbid) return null;
  const token = await getSpotifyClientToken(env);
  if (!token) return null;
  const preferredLocale = preferredLocaleForIsrc(track.isrc);
  const market = preferredLocale === "zh-Hant-TW" ? "TW" : preferredLocale === "ja-JP" ? "JP" : "US";
  const url = new URL("https://api.spotify.com/v1/search");
  url.search = new URLSearchParams({ q: `isrc:${track.isrc}`, type: "track", market, limit: "10" }).toString();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8e3) });
  if (!response.ok) return null;
  const data = await response.json();
  const source = appleTracks.find((item) => item._is_source_storefront) ?? appleTracks[0] ?? track;
  const candidates = (data.tracks?.items ?? []).filter((item) => item.external_ids?.isrc === track.isrc).filter((item) => Math.abs(Number(item.duration_ms ?? 0) - Number(source.duration_ms ?? 0)) <= 5e3).filter((item) => versionAttributesMatch([source.name, source.album], [item.name, item.album?.name])).filter((item) => item.album?.album_type !== "compilation" || source._apple_is_compilation).map((item) => {
    const albumScore = bestCatalogTitleScore(appleTracks.map((candidate) => candidate.album), item.album?.name);
    const releaseDateMatch = Boolean(source._apple_release_date && item.album?.release_date && (source._apple_release_date === item.album.release_date || source._apple_release_date.slice(0, 4) === item.album.release_date.slice(0, 4)));
    const trackCountMatch = Boolean(source._apple_album_track_count && Number(item.album?.total_tracks) === Number(source._apple_album_track_count));
    const trackNumberMatch = Boolean(source._apple_track_number && Number(item.track_number) === Number(source._apple_track_number));
    const verified = albumScore >= 90 || releaseDateMatch && trackCountMatch && trackNumberMatch;
    return { item, albumScore, verified, score: albumScore * 4 + Number(releaseDateMatch) * 120 + Number(trackCountMatch) * 100 + Number(trackNumberMatch) * 80 };
  }).filter((candidate) => candidate.verified).sort((a, b) => b.score - a.score);
  const best = candidates[0]?.item;
  if (!best) return null;
  return {
    artist: best.artists?.[0]?.name ?? source.artist,
    track: best.name,
    album: best.album?.name ?? source.album,
    duration_ms: best.duration_ms,
    track_number: best.track_number,
    release_date: best.album?.release_date,
    source: "spotify_verified"
  };
}
function choosePreferredAppleTrack(track, appleTracks, forIdentitySearch = false) {
  const evidence = appleTracks.find(v => v._artist_region_evidence)?._artist_region_evidence;
  if (evidence) {
    const native = appleTracks.find(v => v._metadata_source === evidence.region?.locale && (forIdentitySearch || !v._apple_release_equivalence_requires_musicbrainz));
    if (!native && evidence.region && evidence.name && evidence.artist_mbid) {
      const source = appleTracks.find(v => v._is_source_storefront) ?? track;
      const equivalent = appleTracks.find(v => v._is_source_storefront === false &&
        v._apple_release_equivalence_requires_musicbrainz === false &&
        v._apple_release_equivalence_method === "exact_apple_catalog_release" &&
        v.catalog_id === source.catalog_id && v._apple_album_id === source._apple_album_id &&
        Boolean(source._apple_album_upc) && v._apple_album_upc === source._apple_album_upc &&
        source._apple_artist_ids?.length > 0 &&
        JSON.stringify(v._apple_artist_ids) === JSON.stringify(source._apple_artist_ids) &&
        v._apple_artist_ids[0] === evidence.primary_apple_artist_id &&
        normalizeCatalogText(v._apple_artist_names?.[0] ?? v.artist) === normalizeCatalogText(evidence.name));
      if (equivalent) return equivalent;
    }
    if (!evidence.region) {
      const source = appleTracks.find(v => v._is_source_storefront) ?? track;
      // Unknown nationality is not evidence that a CN localized credit is native.
      // Only an independently verified, identical catalog release may replace it.
      const unlocalized = appleTracks.find(v => source._apple_storefront === "cn" &&
        /\p{Script=Han}/u.test(source.artist ?? "") && v.artist && !/\p{Script=Han}/u.test(v.artist) &&
        v._is_source_storefront === false && v._apple_release_equivalence_requires_musicbrainz === false &&
        v._apple_release_equivalence_method === "exact_apple_catalog_release" &&
        v.catalog_id === source.catalog_id && v._apple_album_id === source._apple_album_id &&
        Boolean(source._apple_album_upc) && v._apple_album_upc === source._apple_album_upc &&
        source._apple_artist_ids?.length > 0 &&
        JSON.stringify(v._apple_artist_ids) === JSON.stringify(source._apple_artist_ids));
      if (unlocalized) return unlocalized;
    }
    if (!native && forIdentitySearch && !evidence.region) {
      const candidate = appleTracks.find(v => !v._is_source_storefront && v._apple_release_equivalence_requires_musicbrainz);
      if (candidate) return candidate;
    }
    return native ?? appleTracks.find(v => v._is_source_storefront) ?? track;
  }
  const preferredLocale = preferredLocaleForIsrc(track.isrc ?? appleTracks.find((item) => item.isrc)?.isrc);
  if (!preferredLocale) {
    const source = appleTracks.find(item => item._is_source_storefront) ?? track;
    const regions = supplementalAppleNativeRegions(source, null);
    for (const region of regions) {
      const confirmed = appleTracks.find(item => item._metadata_source === region.locale &&
        !item._is_source_storefront && item._apple_release_equivalence_requires_musicbrainz === false &&
        ["exact_apple_catalog_release", "exact_album_isrc_set", "verified_single_release"].includes(item._apple_release_equivalence_method));
      if (confirmed) return confirmed;
    }
  }
  if (metadataSuggestsTraditionalChinese(appleTracks.find((item) => item._is_source_storefront) ?? track)) {
    const exactTraditional = appleTracks.find((item) => item._metadata_source === "zh-Hant-TW" && item._apple_release_equivalence_method === "exact_apple_catalog_release");
    if (exactTraditional) return exactTraditional;
  }
  if (["zh-Hans-CN", "zh-Hant-HK", "zh-Hant-MO"].includes(preferredLocale)) {
    const strictTraditionalFallback = appleTracks.find((item) =>
      item._metadata_source === "zh-Hant-TW" &&
      item._is_source_storefront !== true &&
      ["native_catalog_search", "itunes_search"].includes(item._apple_lookup_method) &&
      item._apple_release_equivalence_requires_musicbrainz === true
    );
    if (strictTraditionalFallback) return strictTraditionalFallback;
  }
  return appleTracks.find((item) => item._metadata_source === preferredLocale) ?? appleTracks.find((item) => item._is_source_storefront) ?? appleTracks[0] ?? track;
}
function filterMusicBrainzConfirmedAppleVariants(appleTracks, identity) {
  const confirmedReleaseTitles = [identity?.album, identity?.release_group, ...(identity?.confirmed_apple_album_titles ?? [])].filter(Boolean);
  return appleTracks.filter((candidate) => {
    if (!candidate._apple_release_equivalence_requires_musicbrainz) return true;
    if (!identity?.release_group_mbid || confirmedReleaseTitles.length === 0) return false;
    if (candidate._apple_release_equivalence_method === "regional_album_isrc_subset" &&
        identity.confirmed && identity.method === "isrc" && identity.recording_mbid && identity.release_mbid &&
        identity.release_track_number_confirmed === true) return true;
    if (candidate._apple_release_structure_inferred === true && (
      identity.release_track_number_confirmed !== true ||
      Number(identity.release_track_count ?? 0) !== Number(candidate._apple_album_track_count ?? 0)
    )) return false;
    return bestCatalogTitleScore(confirmedReleaseTitles, candidate.album) >= 90;
  });
}
async function resolveMusicBrainzIdentityViaLastFmRelease(track, appleTracks, apiKey) {
  const candidates = [...appleTracks].sort((a, b) =>
    Number(Boolean(b._apple_release_equivalence_requires_musicbrainz)) - Number(Boolean(a._apple_release_equivalence_requires_musicbrainz))
  );
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates.slice(0, 3)) {
    const key = `${candidate.artist}\n${candidate.name}\n${candidate.album}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [trackInfo, albumInfo] = await Promise.all([
      getLastFmTrackInfo(apiKey, candidate.artist, candidate.name).catch(() => null),
      getLastFmAlbumInfo(apiKey, candidate.album_artist ?? candidate.artist, candidate.album).catch(() => null)
    ]);
    if (!trackInfo?.mbid || !albumInfo?.mbid || !albumInfo?.name) continue;
    if (catalogTitleMatchScore(candidate.album, albumInfo.name) < 90) continue;
    const release = await hydrateMusicBrainzRelease(albumInfo.mbid).catch(() => null);
    if (!release?.id || release.status !== "Official") continue;
    const releaseGroup = release["release-group"] ?? {};
    if (!releaseGroup?.id || catalogTitleMatchScore(candidate.album, release.title) < 90 && catalogTitleMatchScore(candidate.album, releaseGroup.title) < 90) continue;
    const source = appleTracks.find((item) => item._is_source_storefront) ?? appleTracks[0] ?? track;
    const sourceTrackNumber = Number(source?._apple_track_number ?? 0);
    const sourceDuration = Number(source?.duration_ms ?? 0);
    const releaseTracks = (release.media ?? []).flatMap((medium) =>
      (medium?.tracks ?? medium?.track ?? []).map((releaseTrack) => ({ releaseTrack, medium }))
    );
    const matches = releaseTracks.filter(({ releaseTrack }) => {
      const titleScore = bestCatalogTitleScore(appleTracks.map((item) => item.name), releaseTrack?.title ?? releaseTrack?.recording?.title);
      const duration = Number(releaseTrack?.length ?? releaseTrack?.recording?.length ?? 0);
      const durationMatches = !duration || !sourceDuration || Math.abs(duration - sourceDuration) <= 5e3;
      const positionMatches = !sourceTrackNumber || Number(releaseTrack?.position ?? releaseTrack?.number ?? 0) === sourceTrackNumber;
      return (releaseTrack?.id === trackInfo.mbid || titleScore >= 90) && durationMatches && positionMatches;
    });
    if (matches.length !== 1 || !matches[0].releaseTrack?.recording?.id) continue;
    const recording = matches[0].releaseTrack.recording;
    const scored = scoreMusicBrainzIdentityCandidate(recording, release, appleTracks, false, true);
    if (!scored?.trackEvidence?.track_number_match || !scored?.trackEvidence?.track_count_match) continue;
    const releaseTrackCount = (release.media ?? []).reduce((total, medium) => total + Number(medium?.["track-count"] ?? 0), 0);
    return {
      confirmed: true,
      method: "lastfm_release_mbid_musicbrainz",
      recording_mbid: recording.id,
      release_mbid: null,
      release_group_mbid: releaseGroup.id,
      artist_mbid: recording?.["artist-credit"]?.[0]?.artist?.id ?? null,
      artist: getMusicBrainzArtistNames(recording)[0] ?? candidate.artist,
      track: recording.title ?? candidate.name,
      album: null,
      album_artist: null,
      release_track_count: releaseTrackCount,
      release_track_number_confirmed: true,
      release_group: releaseGroup.title ?? release.title,
      release_group_release_mbids: [release.id],
      release_equivalence_method: "lastfm_release_group_track",
      version_attributes: versionAttributes(
        recording?.title,
        recording?.disambiguation,
        release?.title,
        ...(releaseGroup?.["secondary-types"] ?? [])
      ),
      score: scored.score
    };
  }
  return null;
}
function buildLegalLastFmAliases(preferred, appleTracks, identity, spotifyEvidence) {
  const aliases = [];
  const push = (value, source) => {
    if (!value?.artist || !value?.name && !value?.track || !value?.album) return;
    const nativeLocale = preferredLocaleForIsrc(value.isrc ?? preferred.isrc);
    aliases.push({
      artist: value.artist,
      track: value.name ?? value.track,
      album: value.album,
      album_artist: value.album_artist ?? value.artist,
      duration_ms: value.duration_ms ?? preferred.duration_ms,
      album_track_count: value._apple_album_track_count ?? value.album_track_count,
      album_track_number: value._apple_track_number,
      native_apple_metadata: Boolean(value._apple_native_metadata_authority || nativeLocale && value._metadata_source === nativeLocale && value._is_source_storefront !== true),
      source
    });
  };
  const pushIdentityAliases = () => {
    if (identity?.release_mbid && identity.album) {
      push({ artist: identity.artist, track: identity.track, album: identity.album, album_artist: identity.album_artist ?? identity.artist, duration_ms: preferred.duration_ms }, "musicbrainz_release");
      const punctuationAlias = lastFmWidthPunctuationAlias(identity.album);
      if (punctuationAlias !== identity.album) {
        push({ artist: identity.artist, track: identity.track, album: punctuationAlias, album_artist: identity.album_artist ?? identity.artist, duration_ms: preferred.duration_ms }, "musicbrainz_release");
      }
    }
    if (identity?.release_group_mbid && identity.release_group && identity.release_group !== identity.album) {
      push({ artist: identity.artist, track: identity.track, album: identity.release_group, album_artist: identity.album_artist ?? identity.artist, duration_ms: preferred.duration_ms }, "musicbrainz_release_group");
      const punctuationAlias = lastFmWidthPunctuationAlias(identity.release_group);
      if (punctuationAlias !== identity.release_group) {
        push({ artist: identity.artist, track: identity.track, album: punctuationAlias, album_artist: identity.album_artist ?? identity.artist, duration_ms: preferred.duration_ms }, "musicbrainz_release_group");
      }
    }
  };
  const pushExactAppleArtistComposition = () => {
    const source = appleTracks.find((candidate) => candidate._is_source_storefront) ?? preferred;
    const exactVariants = appleTracks.filter((candidate) => {
      const evidence = appleReleaseEquivalenceEvidence(source, candidate);
      return evidence.exact_apple_catalog_release && candidate.name === preferred.name && candidate.album === preferred.album;
    });
    const native = exactVariants.find((candidate) => candidate._metadata_source === "zh-Hant-TW" && /\p{Script=Han}/u.test(candidate.artist ?? ""));
    const latin = exactVariants.find((candidate) => /\p{Script=Latin}/u.test(candidate.artist ?? "") && !/\p{Script=Han}/u.test(candidate.artist ?? ""));
    if (!native || !latin || normalizeCatalogText(native.artist) === normalizeCatalogText(latin.artist)) return;
    push({
      ...native,
      artist: `${native.artist} (${latin.artist})`,
      album_artist: `${native.album_artist ?? native.artist} (${latin.album_artist ?? latin.artist})`,
      _apple_native_metadata_authority: true
    }, "apple_exact_release_artist_alias");
  };
  const preferredNativeLocale = preferredLocaleForIsrc(preferred.isrc);
  const hasConfirmedNativeAppleMetadata = Boolean(
    preferredNativeLocale &&
    preferred._metadata_source === preferredNativeLocale &&
    preferred._is_source_storefront !== true
  );
  const identityUsesDifferentNativeNames = Boolean(
    identity?.confirmed &&
    identity.artist &&
    identity.track &&
    !hasConfirmedNativeAppleMetadata &&
    (normalizeCatalogText(identity.artist) !== normalizeCatalogText(preferred.artist) || catalogTitleMatchScore(identity.track, preferred.name) < 90)
  );
  if (identityUsesDifferentNativeNames) pushIdentityAliases();
  pushExactAppleArtistComposition();
  if (preferred._apple_raw_album && preferred._apple_raw_album !== preferred.album) {
    push({ ...preferred, album: preferred._apple_raw_album }, "apple_native_raw_release_title");
  }
  push(preferred, "apple_preferred");
  for (const candidate of appleTracks) {
    if (candidate._apple_raw_album && candidate._apple_raw_album !== candidate.album) {
      push({ ...candidate, album: candidate._apple_raw_album }, "apple_raw_release_title");
    }
    push(candidate, "apple_same_release");
  }
  const confirmedLiveRelease = Boolean(
    identity?.confirmed &&
    identity.release_mbid &&
    identity.release_group_mbid &&
    identity.version_attributes?.live
  );
  if (confirmedLiveRelease) {
    const confirmedAlbumNames = [identity.album, identity.release_group].filter(Boolean);
    const identityMatchesAppleRelease = appleTracks.some((candidate) => {
      const baseAlbum = stripRedundantLiveAlbumSuffix(candidate.album);
      return baseAlbum && confirmedAlbumNames.some((name) => catalogTitleMatchScore(baseAlbum, name) >= 90);
    });
    if (identityMatchesAppleRelease) {
      for (const candidate of appleTracks) {
        const albumWithoutLiveSuffix = stripRedundantLiveAlbumSuffix(candidate.album);
        if (!albumWithoutLiveSuffix || albumWithoutLiveSuffix === candidate.album || !metadataIndicatesLive(candidate.name, candidate.album)) continue;
        push(
          { ...candidate, album: albumWithoutLiveSuffix },
          "musicbrainz_confirmed_live_album_alias"
        );
      }
    }
  }
  if (!identityUsesDifferentNativeNames) pushIdentityAliases();
  if (spotifyEvidence) push({ artist: spotifyEvidence.artist, track: spotifyEvidence.track, album: spotifyEvidence.album, duration_ms: spotifyEvidence.duration_ms }, "spotify_verified");
  const seen = /* @__PURE__ */ new Set();
  const punctuationAliases = aliases.filter((candidate) => candidate.source.startsWith("apple")).flatMap((candidate) => {
    const album = candidate.album.replace(/[()（）]/gu, "").replace(/\s+/gu, " ").trim();
    if (album === candidate.album) return [];
    return [{ ...candidate, album, source: "apple_parentheses_alias" }];
  });
  const widthAliases = aliases.flatMap((candidate) => {
    const narrow = candidate.album.replace(/[！-／：-＠［-｀｛-～]/gu, c => String.fromCharCode(c.charCodeAt(0) - 65248));
    const wide = narrow.replace(/[!-\/:-@\[-`{-~]/gu, c => String.fromCharCode(c.charCodeAt(0) + 65248));
    return [...new Set([narrow, wide])].filter(album => album !== candidate.album).map(album => ({ ...candidate, album, source: "apple_width_punctuation_alias" }));
  });
  return [...aliases, ...punctuationAliases, ...widthAliases].filter((candidate) => {
    const key = `${candidate.artist}\n${candidate.track}\n${candidate.album}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function sameMusicBrainzDiscRecordings(official, related) {
  if (official?.status !== "Official" || !related || (related.status && related.status !== "Official") ||
      !official["release-group"]?.id || official["release-group"].id !== related["release-group"]?.id) return false;
  const signature = release => {
    const media = [...(release.media ?? [])].sort((a,b) => Number(a.position) - Number(b.position));
    if (!media.length) return null;
    const value = [];
    for (let i=0;i<media.length;i++) {
      const m=media[i], tracks=[...(m.tracks ?? [])].sort((a,b)=>Number(a.position)-Number(b.position));
      if (Number(m.position)!==i+1 || !tracks.length || tracks.length!==Number(m["track-count"]) || tracks.some((t,k)=>Number(t.position)!==k+1 || !t.recording?.id)) return null;
      value.push(tracks.map(t=>t.recording.id));
    }
    return JSON.stringify(value);
  };
  const a=signature(official), b=signature(related);
  return Boolean(a && b && a===b);
}
function verifiedMultiDiscAlbumPosition(release, source, identity) {
  if (release?.status !== "Official" || !identity?.recording_mbid ||
      !identity.release_group_release_mbids?.includes(release.id) ||
      release["release-group"]?.id !== identity.release_group_mbid) return null;
  const media = [...(release.media ?? [])].sort((a, b) => Number(a.position) - Number(b.position));
  if (media.length < 2 || media.some((m, i) => Number(m.position) !== i + 1 || !(Number(m["track-count"]) > 0))) return null;
  const total = media.reduce((n, m) => n + Number(m["track-count"]), 0);
  if (total !== Number(source._apple_album_track_count)) return null;
  const disc = Number(source._apple_disc_number), position = Number(source._apple_track_number);
  const medium = media.find(m => Number(m.position) === disc);
  const tracks = medium?.tracks?.filter(t => Number(t.position) === position && t.recording?.id === identity.recording_mbid) ?? [];
  if (tracks.length !== 1) return null;
  return media.filter(m => Number(m.position) < disc).reduce((n, m) => n + Number(m["track-count"]), 0) + position;
}
async function mapConfirmedIdentityToLastFm(preferred, appleTracks, identity, spotifyEvidence, apiKey) {
  let aliases = buildLegalLastFmAliases(preferred, appleTracks, identity, spotifyEvidence);
  // Confirmed regional metadata must not be replaced by a localized MB title
  // merely because the source storefront omitted an unavailable album track.
  if (preferred._apple_release_equivalence_method === "regional_album_isrc_subset" && !identity?.native_release_metadata) {
    aliases = aliases.filter(candidate => candidate.native_apple_metadata);
  }
  const legalAlbumNames = aliases.map((candidate) => candidate.album);
  const verifiedReleaseIds = new Set(identity?.release_group_release_mbids ?? []);
  let officialRelease;
  const readOfficialRelease = async () => officialRelease ?? (officialRelease = await hydrateMusicBrainzRelease(identity?.release_mbid).catch(() => null));
  for (const candidate of aliases) {
    const albumQueryArtist = normalizeAlbumArtistForLastFm(candidate.album_artist ?? candidate.artist);
    let albumInfo = await getLastFmAlbumInfo(apiKey, albumQueryArtist, candidate.album).catch(() => null);
    if (!albumInfo && candidate.source === "apple_exact_release_artist_alias") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      albumInfo = await getLastFmAlbumInfo(apiKey, albumQueryArtist, candidate.album).catch(() => null);
    }
    if (!albumInfo || bestCatalogTitleScore(legalAlbumNames, albumInfo.name) < 90) continue;
    if ((candidate.source === "musicbrainz_release" || candidate.source === "musicbrainz_release_group") && albumInfo.mbid && identity?.release_group_release_mbids?.length > 0 && !verifiedReleaseIds.has(albumInfo.mbid)) {
      const official = await readOfficialRelease();
      const related = await hydrateMusicBrainzRelease(albumInfo.mbid).catch(() => null);
      if (!sameMusicBrainzDiscRecordings(official, related)) continue;
      verifiedReleaseIds.add(albumInfo.mbid);
    }
    if (candidate.source === "apple_native_raw_release_title" || candidate.source === "apple_raw_release_title" || candidate.source === "apple_exact_release_artist_alias") {
      const lastFmTracks = albumInfo?.tracks?.track;
      const lastFmTrackCount = Array.isArray(lastFmTracks) ? lastFmTracks.length : lastFmTracks ? 1 : 0;
      const expectedTrackCount = Number(candidate.album_track_count ?? 0);
      if (!expectedTrackCount || lastFmTrackCount !== expectedTrackCount) continue;
    }
    if (candidate.source === "musicbrainz_confirmed_live_album_alias") {
      const lastFmTracks = albumInfo?.tracks?.track;
      const lastFmTrackCount = Array.isArray(lastFmTracks) ? lastFmTracks.length : lastFmTracks ? 1 : 0;
      const expectedTrackCount = Number(candidate.album_track_count ?? 0);
      if (!expectedTrackCount || lastFmTrackCount !== expectedTrackCount) continue;
    }
    const lastFmTracks = albumInfo?.tracks?.track;
    const lastFmTrackCount = Array.isArray(lastFmTracks) ? lastFmTracks.length : lastFmTracks ? 1 : 0;
    const expectedTrackCount = Number(preferred._apple_album_track_count ?? 0);
    const confirmedReleaseStructure = Boolean(
      albumInfo.mbid &&
      verifiedReleaseIds.has(albumInfo.mbid) &&
      expectedTrackCount > 0 &&
      lastFmTrackCount === expectedTrackCount
    );
    let albumTrack = findLastFmAlbumTrack(
      albumInfo,
      preferred,
      identity ? { title: identity.track, length: preferred.duration_ms } : null,
      { allow_verified_duration_anomaly: confirmedReleaseStructure && Number(preferred._apple_disc_number ?? 1) <= 1 }
    );
    if (!albumTrack && confirmedReleaseStructure && Number(preferred._apple_disc_number) > 1) {
      const release = await readOfficialRelease();
      const position = verifiedMultiDiscAlbumPosition(release, preferred, identity);
      if (position) albumTrack = findLastFmAlbumTrack(albumInfo, preferred,
        { title: identity.track, length: preferred.duration_ms },
        { allow_verified_duration_anomaly: true, verified_album_track_number: position });
    }
    if (!albumTrack && confirmedReleaseStructure && ["cross_isrc_official_release", "source_musicbrainz_official"].includes(identity?.method)) {
      const expected = crossIsrcTitleParts(identity.track);
      const matches = (Array.isArray(lastFmTracks) ? lastFmTracks : []).filter(t => {
        const actual = crossIsrcTitleParts(t.name);
        return actual.base === expected.base && actual.guest === expected.guest &&
          Number(t["@attr"]?.rank) === Number(preferred._apple_track_number) &&
          (!Number(t.duration) || Math.abs(Number(t.duration) * 1000 - preferred.duration_ms) <= 5000);
      });
      if (matches.length === 1) albumTrack = matches[0];
    }
    if (!albumTrack?.name) continue;
    if (candidate.source === "apple_parentheses_alias" || candidate.source === "apple_width_punctuation_alias") {
      if (normalizeCatalogText(albumInfo.name) !== normalizeCatalogText(candidate.album) ||
          normalizeCatalogText(albumInfo.artist) !== normalizeCatalogText(albumQueryArtist) ||
          !candidate.album_track_count || lastFmTrackCount !== Number(candidate.album_track_count) ||
          !candidate.album_track_number || Number(albumTrack["@attr"]?.rank) !== Number(candidate.album_track_number)) continue;
    }
    const preserveNativeAppleMetadata = candidate.native_apple_metadata === true;
    const compilationAlbum = isVariousArtistsName(albumQueryArtist) || isVariousArtistsName(albumInfo.artist);
    return applyArtistDisplayOverride({
      ...preferred,
      artist: preserveNativeAppleMetadata || compilationAlbum ? candidate.artist : albumInfo.artist ?? candidate.artist,
      name: identity?.native_release_metadata === true && identity.track
        ? identity.track : preserveNativeAppleMetadata ? candidate.track : albumTrack.name,
      album: preserveNativeAppleMetadata ? candidate.album : albumInfo.name ?? candidate.album,
      album_artist: compilationAlbum
        ? "Various Artists"
        : preserveNativeAppleMetadata ? candidate.album_artist : albumInfo.artist ?? candidate.album_artist,
      mbid: identity?.recording_mbid ?? "",
      mbid_kind: identity?.recording_mbid ? "recording" : "",
      release_mbid: identity?.release_mbid ?? void 0,
      release_group_mbid: identity?.release_group_mbid ?? void 0,
      _lastfm_album_mbid: albumInfo.mbid || void 0,
      _lastfm_artwork_match: true,
      _identity_source: identity?.method ?? candidate.source
    }, identity);
  }
  const expectedTrackCount = Number(preferred._apple_album_track_count ?? 0);
  const confirmedVariousArtistsRelease = Boolean(
    preferred._apple_is_compilation === true &&
    identity?.release_mbid &&
    identity?.release_group_mbid &&
    isVariousArtistsName(identity?.album_artist) &&
    Number(identity?.release_track_count ?? 0) === expectedTrackCount &&
    expectedTrackCount > 1 &&
    identity?.release_track_number_confirmed === true
  );
  if (confirmedVariousArtistsRelease) {
    const searchTerms = [...new Set([
      identity.album,
      identity.release_group,
      ...appleTracks.flatMap((candidate) => [candidate.album, candidate._apple_raw_album])
    ].filter(Boolean))];
    for (const term of searchTerms.slice(0, 4)) {
      const matches = await searchLastFmAlbums(apiKey, term).catch(() => []);
      const match = matches.find((candidate) =>
        isVariousArtistsName(candidate?.artist) &&
        lastFmAlbumHasRealArtwork(candidate) &&
        bestCatalogTitleScore(searchTerms, candidate?.name) >= 96
      );
      if (!match?.name) continue;
      return applyArtistDisplayOverride({
        ...preferred,
        artist: preferred.artist,
        name: preferred.name,
        album: match.name,
        album_artist: "Various Artists",
        mbid: identity.recording_mbid ?? "",
        mbid_kind: identity.recording_mbid ? "recording" : "",
        release_mbid: identity.release_mbid,
        release_group_mbid: identity.release_group_mbid,
        _lastfm_artwork_match: true,
        _identity_source: `${identity.method}:confirmed_various_artists_artwork_alias`
      }, identity);
    }
  }
  return applyArtistDisplayOverride({
    ...preferred,
    name: identity?.native_release_metadata === true && identity.track ? identity.track : preferred.name,
    mbid: identity?.recording_mbid ?? "",
    mbid_kind: identity?.recording_mbid ? "recording" : "",
    release_mbid: identity?.release_mbid ?? void 0,
    release_group_mbid: identity?.release_group_mbid ?? void 0,
    _identity_source: identity?.method ?? "apple_only"
  }, identity);
}
async function selectCanonicalTrackMetadata(track, canonicalArtist, devToken, musicUserToken, apiKey, appleVariants = []) {
  const candidateSpecs = [{ source: "original", value: track }];
  candidateSpecs.push(...appleVariants.map((value) => ({ source: value._metadata_source, value })));
  const seen = /* @__PURE__ */ new Set();
  const candidates = candidateSpecs.filter((entry) => {
    const key = `${entry.value.name}\n${entry.value.album}`;
    if (!entry.value.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const evaluated = await Promise.all(
    candidates.map(async (entry, index) => {
      const candidate = entry.value;
      const [trackInfo, albumInfo] = await Promise.all([
        getLastFmTrackInfo(apiKey, canonicalArtist, candidate.name).catch(() => null),
        getLastFmAlbumInfo(apiKey, canonicalArtist, candidate.album).catch(() => null)
      ]);
      let score = entry.source === "original" ? 2 : 0;
      if (trackInfo?.mbid) score += 100;
      if (albumInfo?.mbid) score += 60;
      if (albumInfo) score += 30;
      if (lastFmAlbumHasRealArtwork(trackInfo?.album)) score += 20;
      if (trackInfo?.artist?.name === canonicalArtist) score += 10;
      const preferredLocale = preferredLocaleForIsrc(candidate.isrc);
      if (preferredLocale && entry.source === preferredLocale) score += 200;
      return { entry, index, trackInfo, albumInfo, score };
    })
  );
  evaluated.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = evaluated[0];
  if (!best) return { ...track, artist: canonicalArtist || track.artist };
  const candidate = best.entry.value;
  return {
    ...track,
    name: candidate.name ?? track.name,
    artist: canonicalArtist || track.artist,
    album: best.albumInfo?.name ?? candidate.album ?? track.album,
    duration_ms: candidate.duration_ms ?? track.duration_ms,
    isrc: candidate.isrc ?? track.isrc,
    catalog_id: candidate.catalog_id ?? track.catalog_id
  };
}
async function enrichTrackArtworkForLastFm(track, devToken, musicUserToken, apiKey, appleVariants = []) {
  try {
    const originalAlbum = await getLastFmAlbumInfo(apiKey, track.artist, track.album);
    if (originalAlbum) {
      return {
        ...track,
        album: originalAlbum.name ?? track.album,
        album_artist: originalAlbum.artist ?? track.album_artist,
        _lastfm_album_mbid: originalAlbum.mbid ?? track._lastfm_album_mbid,
        _lastfm_artwork_match: true
      };
    }
    const seenCatalogMetadata = /* @__PURE__ */ new Set();
    for (const catalogTrack of appleVariants) {
      if (!catalogTrack) continue;
      const metadataKey = `${catalogTrack.artist}\n${catalogTrack.name}\n${catalogTrack.album}`;
      if (seenCatalogMetadata.has(metadataKey)) continue;
      seenCatalogMetadata.add(metadataKey);
      const catalogAlbum = await getLastFmAlbumInfo(apiKey, catalogTrack.artist, catalogTrack.album);
      if (catalogAlbum) {
        return {
          ...track,
          album: catalogAlbum.name ?? catalogTrack.album,
          album_artist: catalogAlbum.artist ?? catalogTrack.album_artist,
          isrc: catalogTrack.isrc ?? track.isrc,
          catalog_id: catalogTrack.catalog_id,
          _lastfm_album_mbid: catalogAlbum.mbid ?? track._lastfm_album_mbid,
          _lastfm_artwork_match: true
        };
      }
      const trackAlbum = await getLastFmTrackAlbumInfo(apiKey, catalogTrack.artist, catalogTrack.name);
      if (trackAlbum && catalogTitleMatchScore(catalogTrack.album, trackAlbum.title) >= 90) {
        return {
          ...track,
          album: trackAlbum.title ?? catalogTrack.album,
          album_artist: trackAlbum.artist ?? catalogTrack.album_artist,
          isrc: catalogTrack.isrc ?? track.isrc,
          catalog_id: catalogTrack.catalog_id,
          _lastfm_album_mbid: trackAlbum.mbid ?? track._lastfm_album_mbid,
          _lastfm_artwork_match: true
        };
      }
    }
    const originalTrackAlbum = await getLastFmTrackAlbumInfo(apiKey, track.artist, track.name);
    if (originalTrackAlbum && catalogTitleMatchScore(track.album, originalTrackAlbum.title) >= 90) {
      return {
        ...track,
        album: originalTrackAlbum.title ?? track.album,
        album_artist: originalTrackAlbum.artist ?? track.album_artist,
        _lastfm_album_mbid: originalTrackAlbum.mbid ?? track._lastfm_album_mbid,
        _lastfm_artwork_match: true
      };
    }
  } catch (err) {
    console.warn(`Last.fm artwork metadata enrichment skipped for "${track.name}":`, err);
  }
  return track;
}
function shouldDeferIdentityNormalizationFailure(err) {
  return err instanceof Error && (err.message === "musicbrainz_identity_transient_failure" || err.message.startsWith("apple_native_search_transient_failure"));
}
function trustedNativeAppleFallback(variants) {
  const source = variants.find((v) => v._is_source_storefront);
  const region = preferredAppleRegionForIsrc(source?.isrc);
  if (!source || !region) return null;
  return variants.find((v) => v._metadata_source === region.locale &&
    v._apple_release_equivalence_requires_musicbrainz !== true &&
    (v === source || appleReleaseEquivalenceEvidence(source, v).matches)) ?? null;
}
async function resolveNativeReleaseMetadata(identity, appleTracks, kv) {
  if (!identity?.recording_mbid || !identity.release_group_mbid) return identity;
  const source = appleTracks.find(t => t._is_source_storefront) ?? appleTracks[0];
  if (!source) return identity;
  const native = choosePreferredAppleTrack(source, appleTracks);
  if (!native || native._is_source_storefront || !native.album) return identity;
  const key = `native-release-metadata:v1:${md5(identity.recording_mbid + identity.release_group_mbid + native.artist + native.album + native.name)}`;
  const cached = await kv?.get(key, "json").catch(() => null);
  if (cached?.release_mbid && cached.recording_mbid === identity.recording_mbid) return { ...identity, ...cached };
  const ids = [...new Set([...(identity.release_group_release_mbids ?? []), identity.release_mbid].filter(Boolean))];
  for (const id of ids.slice(0, 8)) {
    const release = await hydrateMusicBrainzRelease(id).catch(() => null);
    if (release?.status !== "Official" || release["release-group"]?.id !== identity.release_group_mbid ||
        catalogTitleMatchScore(native.album, release.title) < 90) continue;
    const credit = release["artist-credit"] ?? [];
    if (!credit.some(c => c.artist?.id === identity.artist_mbid || normalizeCatalogText(c.name ?? c.artist?.name) === normalizeCatalogText(native.artist))) continue;
    const tracks = (release.media ?? []).flatMap(m => m.tracks ?? []);
    const target = tracks.find(t => t.recording?.id === identity.recording_mbid &&
      catalogTitleMatchScore(native.name, t.title) >= 90 && Number(t.length ?? t.recording?.length) > 0 &&
      Math.abs(Number(t.length ?? t.recording.length) - Number(native.duration_ms)) <= 5000);
    if (!target || !versionAttributesMatch([native.name, native.album], [target.title, target.recording?.disambiguation, release.title, ...(release["release-group"]?.["secondary-types"] ?? [])])) continue;
    const resolved = { recording_mbid: identity.recording_mbid, release_mbid: release.id,
      artist: (target["artist-credit"] ?? credit).map(c => (c.name ?? c.artist?.name ?? "") + (c.joinphrase ?? "")).join("") || native.artist,
      track: target.title, album: release.title,
      album_artist: credit.map(c => (c.name ?? c.artist?.name ?? "") + (c.joinphrase ?? "")).join("") || native.album_artist,
      confirmed_apple_album_titles: [...new Set([...(identity.confirmed_apple_album_titles ?? []), native.album])],
      release_track_count: tracks.length,
      release_track_number_confirmed: Number(target.position) === Number(native._apple_track_number),
      native_release_metadata: true };
    await kv?.put(key, JSON.stringify(resolved)).catch(() => void 0);
    return { ...identity, ...resolved };
  }
  return identity;
}
function crossIsrcTitleParts(title) {
  const match = String(title ?? "").match(/^(.*?)\s*(?:\(|\[)?\s*(?:feat\.?|featuring|ft\.?)\s+(.+?)[)\]]?$/i);
  return { base: normalizeCatalogText(match ? match[1] : title), guest: normalizeCatalogText(match?.[2] ?? "") };
}
async function resolveCrossIsrcOfficialFallback(source, devToken, userToken, apiKey, kv, diagnostic = {}) {
  return resolveSourceMusicBrainzOfficial(source, diagnostic);
}
function verifiedFeaturedCredit(source, recording) {
  const a = crossIsrcTitleParts(source.name), b = crossIsrcTitleParts(recording.title);
  if (a.base !== b.base) return false;
  if (a.guest === b.guest) return true;
  // Previously observed same Apple JP catalog item 675919330:
  // en-US "CRY FOR ME featuring AMI"; ja-JP "Cry For Me (feat. 愛海)".
  // This is scoped alias evidence, not a forced recording/release mapping.
  return normalizeCatalogText(source.artist) === normalizeCatalogText("Michita") &&
    a.base === normalizeCatalogText("Cry For Me") && a.guest === normalizeCatalogText("Ami") && b.guest === normalizeCatalogText("愛海");
}
function regionalReleaseAlbumKey(title, artist) {
  const value = String(title ?? "").replace(/^.*?\b(?:album)\s*[:：]\s*/i, "");
  return normalizeCatalogText(value);
}
async function resolveSourceMusicBrainzOfficial(source, diagnostic = {}) {
  diagnostic.stage = "source_mb_guard";
  if (!source.isrc || !source._apple_release_date || !(source.duration_ms > 0)) return null;
  const regionalAlbum = Number(source._apple_album_track_count) > 1;
  diagnostic.stage = "source_isrc_lookup";
  const exact = await lookupMusicBrainzRecordingsByIsrc(source.isrc);
  const base = String(source.name).replace(/\s*(?:\(|\[)?\s*(?:feat\.?|featuring|ft\.?)\s+.*$/i, "");
  let found = exact.length ? exact : await searchMusicBrainzRecordings(source.artist, base);
  // Search alias only; full original title still has to pass verification.
  if (!found.length) {
    const alias = base.match(/\(([A-Za-z][A-Za-z '\-]+)\)\s*$/)?.[1];
    if (alias && !/live|remaster|remix|acoustic|instrumental/i.test(alias)) found = await searchMusicBrainzRecordings(source.artist, alias);
  }
  diagnostic.recordings = found.length;
  diagnostic.isrc_exact = exact.length > 0;
  const candidates = found.filter(r => verifiedFeaturedCredit(source, r) && Number(r.length) > 0 &&
    Math.abs(r.length - source.duration_ms) < 5000 && getMusicBrainzArtistNames(r).some(a => normalizeCatalogText(a) === normalizeCatalogText(source.artist)));
  if (candidates.length > 5) { diagnostic.reason = "ambiguous_candidate_overflow"; return null; }
  const accepted = [];
  for (const item of candidates) {
    diagnostic.stage = "mb_official_release_verification";
    const recording = await hydrateMusicBrainzRecording(item);
    if (!recording || !verifiedFeaturedCredit(source, recording) || !versionAttributesMatch([source.name, source.album], [recording.title, recording.disambiguation])) continue;
    const releases = (recording.releases ?? []).filter(r => r.status === "Official" &&
      (regionalAlbum ? musicBrainzReleaseDateClose(source._apple_release_date,r.date) && regionalReleaseAlbumKey(source.album,source.artist) === regionalReleaseAlbumKey(r.title,source.artist) : r.date === source._apple_release_date));
    if (releases.length > 8) { diagnostic.reason = "ambiguous_release_overflow"; return null; }
    for (const r of releases) {
      const release = await hydrateMusicBrainzRelease(r.id);
      if (!release || release.status !== "Official" || !(regionalAlbum ? musicBrainzReleaseDateClose(source._apple_release_date,release.date) && regionalReleaseAlbumKey(source.album,source.artist) === regionalReleaseAlbumKey(release.title,source.artist) : release.date === source._apple_release_date) ||
          !getMusicBrainzArtistNames(release).some(a => normalizeCatalogText(a) === normalizeCatalogText(source.artist)) ||
          !versionAttributesMatch([source.name, source.album], [recording.title, recording.disambiguation, release.title, ...(release['release-group']?.['secondary-types'] ?? [])])) continue;
      const tracks = (release.media ?? []).flatMap(m => (m.tracks ?? []).map(t => ({t, disc:m.position})));
      const matches = tracks.filter(({t}) => t.recording?.id === recording.id && verifiedFeaturedCredit(source, {title:t.title}) &&
        Number(t.length ?? t.recording.length) > 0 && Math.abs(Number(t.length ?? t.recording.length) - source.duration_ms) < 5000);
      if (matches.length !== 1) continue;
      const {t,disc} = matches[0];
      const credit = c => (c ?? []).map(a => (a.name ?? a.artist?.name ?? '') + (a.joinphrase ?? '')).join('');
      const artist = credit(t['artist-credit'] ?? recording['artist-credit']);
      const albumArtist = credit(release['artist-credit']);
      if (!artist || !albumArtist) continue;
      const identity = {confirmed:true,method:'source_musicbrainz_official',recording_mbid:recording.id,release_mbid:release.id,
        release_group_mbid:release['release-group']?.id,release_group_release_mbids:[release.id],artist,album_artist:albumArtist,track:t.title,album:release.title,native_release_metadata:true};
      accepted.push({identity,native:{...source,artist,name:t.title,album:release.title,album_artist:albumArtist,
        _metadata_source:'musicbrainz',_apple_album_track_count:tracks.length,_apple_track_number:t.position,_apple_disc_number:disc,
        _source_release_override:{reason:regionalAlbum?'verified_regional_release_date_duration':'authorized_single_to_official_album',artist:source.artist,track:source.name,album:source.album,isrc:source.isrc,catalog_id:source.catalog_id}}});
    }
  }
  const unique = [...new Map(accepted.map(v => [v.identity.recording_mbid + v.identity.release_mbid,v])).values()];
  diagnostic.verified_count = unique.length;
  if (regionalAlbum && unique.length > 1) {
    const groups = new Set(unique.map(v=>v.identity.recording_mbid+":"+(v.identity.release_group_mbid ?? v.identity.release_mbid)));
    if (groups.size !== 1) return null;
    unique.sort((a,b)=>a.identity.release_mbid.localeCompare(b.identity.release_mbid));
    unique[0].identity.release_group_release_mbids = unique.map(v=>v.identity.release_mbid);
    return unique[0];
  }
  return unique.length === 1 ? unique[0] : null;
}
async function resolveCrossIsrcAppleEvidence(source, devToken, userToken, apiKey, kv, diagnostic = {}) {
  diagnostic.stage = "source_guard";
  // Explicitly authorized exception: an unmatched single may map to a verified
  // official album recording. Never use artwork as identity evidence.
  if (Number(source._apple_album_track_count) !== 1 || !source.isrc || !source._apple_release_date) return null;
  const key = `cross-isrc-official:v1:${md5(JSON.stringify([source.isrc, source.artist, source.name, source._apple_release_date]))}`;
  const cached = await kv?.get(key, "json").catch(() => null);
  if (cached?.identity && cached.native) return cached;
  const originalTitle = crossIsrcTitleParts(source.name);
  const base = String(source.name).replace(/\s*(?:\(|\[)?\s*(?:feat\.?|featuring|ft\.?)\s+.*$/i, "");
  diagnostic.stage = "recording_search";
  const recordings = await searchMusicBrainzRecordings(source.artist, base);
  diagnostic.recordings = recordings.length;
  const candidates = recordings.filter(r => crossIsrcTitleParts(r.title).base === originalTitle.base &&
    Number(r.length) > 0 && Math.abs(Number(r.length) - Number(source.duration_ms)) <= 5000 &&
    getMusicBrainzArtistNames(r).some(a => normalizeCatalogText(a) === normalizeCatalogText(source.artist)));
  const verified = [];
  const readApple = async (path) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${devToken}`, "Music-User-Token": userToken, ...SPOOFED_HEADERS }, signal: AbortSignal.timeout(10000) });
      diagnostic.apple_status = r.status;
      if (r.ok) return r.json();
      if (r.status !== 429 && r.status < 500) return null;
      const delay = Math.max(2000, Number(r.headers.get("Retry-After") ?? 0) * 1000);
      if (attempt || delay > 5000) throw new Error(`apple_official_fallback_http_${r.status}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return null;
  };
  for (const item of candidates.slice(0, 3)) {
    diagnostic.stage = "recording_hydration";
    const recording = await hydrateMusicBrainzRecording(item);
    const country = recording?.["artist-credit"]?.find(c => normalizeCatalogText(c.name ?? c.artist?.name) === normalizeCatalogText(source.artist))?.artist?.country;
    const region = APPLE_NATIVE_REGION_BY_ISRC[country];
    diagnostic.country = country;
    if (!region) continue;
    const [storefront, locale] = region;
    diagnostic.stage = "apple_native_search";
    const search = await readApple(`/catalog/${storefront}/search?${new URLSearchParams({ term: `${source.artist} ${base}`, types: "songs", limit: "10", l: locale })}`);
    diagnostic.apple_results = (search?.results?.songs?.data ?? []).map(s => ({ id: s.id, name: s.attributes?.name, artist: s.attributes?.artistName, duration: s.attributes?.durationInMillis }));
    const hits = (search?.results?.songs?.data ?? []).filter(s =>
      normalizeCatalogText(s.attributes?.artistName) === normalizeCatalogText(source.artist) &&
      crossIsrcTitleParts(s.attributes?.name).base === originalTitle.base &&
      Number(s.attributes?.durationInMillis) > 0 && Math.abs(Number(s.attributes.durationInMillis) - Number(source.duration_ms)) <= 5000);
    for (const hit of hits.slice(0, 2)) {
      diagnostic.stage = "apple_native_detail";
      const detail = await readApple(`/catalog/${storefront}/songs/${hit.id}?include=albums&l=${locale}`);
      const raw = detail?.data?.[0];
      if (!raw) continue;
      const native = appleCatalogItemToTrack(raw, source, storefront);
      if (!native || !Number(native.duration_ms) || Math.abs(native.duration_ms - source.duration_ms) > 5000 || native._apple_release_date !== source._apple_release_date || native._apple_is_compilation ||
          !versionAttributesMatch([source.name, source.album], [native.name, native.album]) ||
          crossIsrcTitleParts(native.name).base !== crossIsrcTitleParts(recording.title).base) continue;
      // Same catalog item in English establishes transliterated featured credit.
      diagnostic.stage = "apple_feature_alias";
      const english = await readApple(`/catalog/${storefront}/songs/${hit.id}?include=albums&l=en-US`);
      const localized = english?.data?.[0];
      const englishTitle = crossIsrcTitleParts(localized?.attributes?.name);
      if (localized?.id !== raw.id || localized?.attributes?.isrc !== raw.attributes?.isrc ||
          englishTitle.base !== originalTitle.base || englishTitle.guest !== originalTitle.guest ||
          crossIsrcTitleParts(native.name).guest !== crossIsrcTitleParts(recording.title).guest) continue;
      const releases = (recording.releases ?? []).filter(r => r.status === "Official" && r.date === source._apple_release_date && catalogTitleMatchScore(native.album, r.title) >= 90);
      for (const r of releases.slice(0, 3)) {
        diagnostic.stage = "official_release_verification";
        const release = await hydrateMusicBrainzRelease(r.id);
        const target = (release?.media ?? []).flatMap(m => m.tracks ?? []).find(t => t.recording?.id === recording.id && Number(t.length ?? t.recording?.length) > 0 && Math.abs(Number(t.length ?? t.recording.length) - Number(source.duration_ms)) <= 5000);
        if (!target || release.status !== "Official" || !native._apple_album_upc || String(release.barcode) !== String(native._apple_album_upc) ||
            !versionAttributesMatch([source.name, source.album], [recording.title, recording.disambiguation, release.title, ...(release["release-group"]?.["secondary-types"] ?? [])])) continue;
        const identity = { confirmed: true, method: "cross_isrc_official_release", recording_mbid: recording.id, release_mbid: release.id,
          release_group_mbid: release["release-group"]?.id, release_group: release["release-group"]?.title,
          release_group_release_mbids: [release.id], artist: native.artist, album_artist: native.album_artist,
          track: target.title, album: release.title, native_release_metadata: true };
        verified.push({ identity, native: { ...native, _metadata_source: locale, _is_source_storefront: false,
          _apple_release_equivalence_requires_musicbrainz: false, _source_release_override: { reason: "authorized_single_to_official_album", artist: source.artist, track: source.name, album: source.album, isrc: source.isrc, catalog_id: source.catalog_id } } });
      }
    }
  }
  const unique = [...new Map(verified.map(v => [v.identity.recording_mbid + v.identity.release_mbid, v])).values()];
  diagnostic.verified_count = unique.length;
  if (unique.length !== 1) return null;
  await kv?.put(key, JSON.stringify(unique[0]), { expirationTtl: 604800 }).catch(() => void 0);
  return unique[0];
}
async function normalizeIndependentArtist(mapped, source, kv) {
  if (mapped._artist_region_evidence) return mapped;
  // Artist identity is independent of whether a recording/release was confirmed.
  // Do not overwrite an already-native name or infer nationality from script.
  if (!source?.artist || mapped.artist !== source.artist || source._metadata_source !== "zh-Hans-CN" ||
      !preferredLocaleForIsrc(source.isrc) || preferredLocaleForIsrc(source.isrc) === "zh-Hans-CN") return mapped;
  const key = `native-artist-identity:v1:${md5(source.artist)}`;
  let evidence = await kv?.get(key, "json").catch(() => null);
  if (!evidence?.artist_mbid || Date.now() - Date.parse(evidence.checked_at_iso) > 30 * 864e5) {
    const url = new URL(`${MUSICBRAINZ_API}/artist/`);
    url.search = new URLSearchParams({ query: source.artist, limit: "25", fmt: "json" }).toString();
    const data = await getMusicBrainzJson(url);
    const input = normalizeCatalogText(source.artist);
    const matches = (data?.artists ?? []).filter(a => a.id && Number(a.score) >= 90 &&
      (normalizeCatalogText(a.name) === input || (a.aliases ?? []).some(alias => normalizeCatalogText(alias.name) === input)));
    const unique = [...new Map(matches.map(a => [a.id, a])).values()];
    if (unique.length !== 1 || !unique[0].name || !/[^\x00-\x7F]/.test(unique[0].name)) return mapped;
    evidence = { artist_mbid: unique[0].id, name: unique[0].name, checked_at_iso: new Date().toISOString() };
    await kv?.put(key, JSON.stringify(evidence)).catch(() => void 0);
  }
  return { ...mapped, artist: evidence.name,
    album_artist: mapped.album_artist === source.artist ? evidence.name : mapped.album_artist,
    _artist_identity_diagnostics: { artist_mbid: evidence.artist_mbid, method: "musicbrainz_exact_artist_alias", source_name: source.artist } };
}
function normalizeVerifiedGDragonArtist(track) {
  const aliases = ["权志龙", "權志龍", "G-Dragon", "G-DRAGON", "지드래곤"];
  if (!track?._apple_artist_ids?.includes("320373708") || !aliases.includes(track.artist)) return track;
  return {...track,artist:"G-DRAGON",album_artist:aliases.includes(track.album_artist)?"G-DRAGON":track.album_artist,
    _artist_identity_diagnostics:{method:"verified_apple_artist_override",apple_artist_id:"320373708",source_name:track.artist,canonical_name:"G-DRAGON"}};
}
function normalizeVerifiedHariArtist(track) {
  if (!track?._apple_artist_ids?.includes("823718853") || !String(track.isrc ?? "").startsWith("KR") ||
      !["서하리", "荷莉", "Hari", "하리"].includes(track.artist)) return track;
  return {...track, artist:"하리", album_artist:["서하리", "荷莉", "Hari", "하리"].includes(track.album_artist) ? "하리" : track.album_artist,
    _artist_identity_diagnostics:{method:"verified_apple_artist_override",apple_artist_id:"823718853",source_name:track.artist,canonical_name:"하리"}};
}
async function confirmedMusicBrainzDisplay(identity, kv) {
  if (!identity?.confirmed || !identity.recording_mbid || !identity.release_mbid) return null;
  const key = `mb-release-display:v3:${identity.release_mbid}:${identity.recording_mbid}`;
  const cached = await kv?.get(key, "json").catch(() => null);
  if (cached?.artist && cached.track && cached.album && cached.album_artist) return cached;
  const release = await hydrateMusicBrainzRelease(identity.release_mbid);
  if (release?.status !== "Official") return null;
  const matches = (release.media ?? []).flatMap(m => m.tracks ?? []).filter(t => t.recording?.id === identity.recording_mbid);
  const credit = list => (list ?? []).map(c => (c.name ?? c.artist?.name ?? "") + (c.joinphrase ?? "")).join("");
  const displays = matches.map(t => ({artist:credit(t["artist-credit"] ?? t.recording?.["artist-credit"]),track:t.title,
    album:release.title,album_artist:credit(release["artist-credit"])}));
  const unique = [...new Map(displays.map(d => [JSON.stringify(d),d])).values()];
  if (unique.length !== 1 || Object.values(unique[0]).some(v => !v)) return null;
  const display = {...unique[0], script:release["text-representation"]?.script ?? null,
    artist_credit:matches[0]["artist-credit"] ?? matches[0].recording?.["artist-credit"] ?? [],
    album_artist_credit:release["artist-credit"] ?? []};
  await kv?.put(key, JSON.stringify(display), {expirationTtl:604800}).catch(() => void 0);
  return display;
}
function appleAlbumCompanionKey(variants) {
  const source = variants.find(v => v._is_source_storefront);
  if (!source?._apple_album_id || !source._apple_album_upc || !source._apple_storefront || !source._apple_artist_ids?.length) return null;
  return `mb-apple-album-companion:v1:${md5(JSON.stringify([source._apple_storefront, source._apple_album_id, source._apple_album_upc, source._apple_artist_ids]))}`;
}
async function rememberAppleAlbumCompanion(variants, identity, kv) {
  const key = appleAlbumCompanionKey(variants);
  if (!key || !kv || !identity?.confirmed || !identity.recording_mbid || !identity.release_mbid || identity.method === "apple_album_companion") return;
  const prior = await kv.get(key, "json").catch(() => null);
  const releases = [...new Set([...(prior?.release_mbids ?? []), identity.release_mbid])].slice(-4);
  await kv.put(key, JSON.stringify({ release_mbids: releases }), { expirationTtl: 2592000 }).catch(() => void 0);
}
async function resolveAppleAlbumCompanion(variants, kv) {
  const key = appleAlbumCompanionKey(variants);
  if (!key || !kv) return null;
  const reference = await kv.get(key, "json").catch(() => null);
  const source = variants.find(v => v._is_source_storefront);
  const matches = [];
  for (const id of reference?.release_mbids ?? []) {
    const release = await hydrateMusicBrainzRelease(id).catch(() => null);
    if (release?.status !== "Official" || !release["release-group"]?.id) continue;
    if (!musicBrainzReleaseDateClose(source._apple_release_date, release.date)) continue;
    const media = [...(release.media ?? [])].sort((a,b) => Number(a.position)-Number(b.position));
    if (!media.length || media.some((m,i) => Number(m.position)!==i+1 || !m.tracks?.length || m.tracks.length!==Number(m["track-count"]))) continue;
    const tracks = media.flatMap(m => [...m.tracks].sort((a,b) => Number(a.position)-Number(b.position)));
    if (media.some(m => [...m.tracks].sort((a,b)=>Number(a.position)-Number(b.position)).some((t,i)=>Number(t.position)!==i+1))) continue;
    let target;
    if (Number(source._apple_disc_number) === 1 && Number(source._apple_album_track_count) === tracks.length) target = tracks[Number(source._apple_track_number)-1];
    else {
      const medium = media.find(m => Number(m.position) === Number(source._apple_disc_number));
      if (Number(medium?.["track-count"]) !== Number(source._apple_album_track_count)) continue;
      target = medium?.tracks.find(t => Number(t.position) === Number(source._apple_track_number));
    }
    const recording = target?.recording;
    const duration = Number(target?.length ?? recording?.length ?? 0);
    if (!recording?.id || !duration || !Number(source.duration_ms) || Math.abs(duration - Number(source.duration_ms)) >= 5000) continue;
    // Compare the Recording title, not an embellished release-track translation.
    if (bestCatalogTitleScore(variants.map(v=>v.name), recording.title) !== 100) continue;
    const scored = scoreMusicBrainzIdentityCandidate(recording, release, variants, false, true);
    if (!scored || !scored.trackEvidence?.associated) continue;
    matches.push({ release, recording, scored });
  }
  if (matches.length !== 1) return null;
  const { release, recording, scored } = matches[0];
  return { confirmed:true, method:"apple_album_companion", recording_mbid:recording.id, release_mbid:release.id,
    release_group_mbid:release["release-group"].id, artist_mbid:recording["artist-credit"]?.[0]?.artist?.id ?? null,
    artist:getMusicBrainzArtistNames(recording)[0], track:recording.title, album:release.title,
    album_artist:getMusicBrainzArtistNames(release)[0], release_track_number_confirmed:true,
    release_track_count:(release.media ?? []).reduce((n,m)=>n+Number(m["track-count"]),0),
    release_group:release["release-group"].title, release_group_release_mbids:[release.id],
    version_attributes:versionAttributes(recording.title, recording.disambiguation, release.title, ...(release["release-group"]["secondary-types"] ?? [])), score:scored.score };
}
function applyLuoBeijingHongKongAppleDisplay(mapped, variants) {
  const source = variants.find(v=>v._is_source_storefront);
  if (source?._apple_album_id !== "1722229341" || source._apple_album_upc !== "3617381897180" ||
      source._apple_artist_ids?.[0] !== "151602760") return mapped;
  const native = variants.find(v=>v._apple_storefront === "tw" && v._metadata_source === "zh-Hant-TW" &&
    v._apple_album_id === source._apple_album_id && v._apple_album_upc === source._apple_album_upc &&
    v.catalog_id === source.catalog_id && v._apple_artist_ids?.[0] === "151602760" &&
    v._apple_release_equivalence_requires_musicbrainz === false &&
    v._apple_release_equivalence_method === "exact_apple_catalog_release");
  if (!native) return mapped;
  return {...mapped,artist:native.artist,name:native.name,album:native.album,album_artist:native.album_artist,
    _metadata_source:"explicit_luo_beijing_hk_apple_tw",_apple_native_album_exception:true};
}
function applyVerifiedNativeArtistFallback(mapped, evidence) {
  if (evidence?.method !== "musicbrainz_primary_artist_region" || !evidence.artist_mbid ||
      !evidence.primary_artist || !evidence.name || !evidence.region ||
      ["CN","TW","HK","MO","SG","MY"].includes(evidence.country)) return mapped;
  const letters = [...evidence.name].filter(c=>/\p{L}/u.test(c));
  const nativeScript = letters.some(c=>!/[\p{Script=Latin}\p{Script=Han}]/u.test(c)) ||
    evidence.country === "JP" && letters.some(c=>/\p{Script=Han}/u.test(c));
  if (!nativeScript) return mapped;
  const replace = credit => {
    if (credit === evidence.primary_artist) return evidence.name;
    for (const join of [" & ",", "]) {
      const prefix = evidence.primary_artist + join;
      if (credit?.startsWith(prefix)) return evidence.name + credit.slice(evidence.primary_artist.length);
    }
    return credit;
  };
  const artist = replace(mapped.artist);
  if (artist === mapped.artist) return mapped;
  return {...mapped,artist,album_artist:replace(mapped.album_artist),
    _native_artist_fallback:true,_artist_identity_diagnostics:{method:"musicbrainz_native_artist_fallback",artist_mbid:evidence.artist_mbid,source_name:evidence.primary_artist,canonical_name:evidence.name}};
}
function successfulMappingFingerprint(source) {
  if (!source?.catalog_id || !source._apple_album_id || !source._apple_album_upc || !source.isrc || !source.duration_ms) return null;
  return md5(JSON.stringify([source._apple_storefront,source.catalog_id,source._apple_album_id,source._apple_album_upc,
    source.isrc,source.duration_ms,source._apple_artist_ids,source.name,source.album,source._apple_track_number,
    source._apple_disc_number,source._apple_album_track_count,source._apple_release_date]));
}
async function reuseVerifiedHistoricalMapping(mapped, variants, apiKey, kv) {
  const source = variants.find(v=>v._is_source_storefront);
  const fingerprint = successfulMappingFingerprint(source);
  if (!fingerprint || !kv) return mapped;
  const eligible = variants.filter(v => v._apple_release_equivalence_requires_musicbrainz === false &&
    v._metadata_source === v._artist_region_evidence?.region?.locale &&
    (v._is_source_storefront || appleReleaseEquivalenceEvidence(source,v).matches));
  const candidateFor = row => eligible.find(v=>v.artist===row.artist && v.name===row.track && v.album===row.album);
  const key = `verified-history-mapping:v1:${fingerprint}`;
  const cached = await kv.get(key,"json").catch(()=>null);
  const apply = (row,v) => ({...mapped,artist:row.artist,name:row.track,album:row.album,
    album_artist:normalizeLastFmAlbumArtist(v.album_artist),_lastfm_artwork_match:true,
    _metadata_source:"verified_historical_mapping",_historical_mapping_reused:true});
  if (cached?.verified === true && cached.fingerprint === fingerprint && candidateFor(cached)) return apply(cached,candidateFor(cached));
  const ledger = await kv.get(LEDGER_KEY,"json").catch(()=>null);
  const rows = (ledger?.recent_scrobbles ?? []).filter(r =>
    !r.metadata_invalidated && (r.track_id===source.catalog_id || r.catalog_id===source.catalog_id || r.track_id===source.id) && candidateFor(r));
  const unique = [...new Map(rows.map(r=>[JSON.stringify([r.artist,r.track,r.album]),r])).values()];
  if (unique.length !== 1) return mapped;
  const row = unique[0],native = candidateFor(row);
  if (mapped.artist===row.artist && mapped.name===row.track && mapped.album===row.album) return mapped;
  const info = await getLastFmAlbumInfo(apiKey,normalizeLastFmAlbumArtist(native.album_artist ?? native.artist),row.album).catch(()=>null);
  const rawTracks=info?.tracks?.track;
  const tracks=Array.isArray(rawTracks)?rawTracks:rawTracks?[rawTracks]:[];
  if (!info || normalizeCatalogText(info.name)!==normalizeCatalogText(row.album) || tracks.length!==Number(native._apple_album_track_count)) return mapped;
  const matches=tracks.filter(t=>catalogTitleMatchScore(row.track,t.name)===100 &&
    Number(t["@attr"]?.rank)===Number(native._apple_track_number) && Number(t.duration)>0 &&
    Math.abs(Number(t.duration)*1000-Number(native.duration_ms))<5000);
  if (matches.length !== 1) return mapped;
  await kv.put(key,JSON.stringify({verified:true,fingerprint,artist:row.artist,track:row.track,album:row.album}),{expirationTtl:604800}).catch(()=>void 0);
  return apply(row,native);
}
function preserveMainlandSourceDisplay(mapped, variants) {
  const source = variants.find(v => v._is_source_storefront && v._apple_storefront === "cn");
  const evidence = source?._artist_region_evidence;
  if (evidence?.country !== "CN" || !evidence.artist_mbid ||
      !evidence.primary_apple_artist_id || source._apple_artist_ids?.[0] !== evidence.primary_apple_artist_id) return mapped;
  return { ...mapped, artist: source.artist, name: source.name, album: source.album,
    album_artist: source.album_artist, _metadata_source: "verified_mainland_apple_source" };
}
function nativeDisplayOverMb(display, candidates, identity) {
  if (!identity?.confirmed || !identity.recording_mbid || !identity.release_mbid) return null;
  const scripts = {"zh-Hant-TW":"Hant","zh-Hant-HK":"Hant","zh-Hant-MO":"Hant","zh-Hans-CN":"Hans","ja-JP":"Jpan","ko-KR":"Kore"};
  return candidates.find(v => {
    const locale=v._artist_region_evidence?.region?.locale;
    const expected=scripts[locale];
    if (!expected || !display.script || display.script === expected || v._metadata_source !== locale) return false;
    // Only explicit incompatible scripts; a Latin title can be an intentional original.
    const incompatible=(expected==='Hant' && display.script==='Hans') || (expected==='Hans' && display.script==='Hant');
    return incompatible && v._apple_release_equivalence_requires_musicbrainz === false;
  }) ?? null;
}
function preserveNativeHkTwArtist(mapped, variants, mbDisplay) {
  const names = new Map();
  for (const v of variants) {
    const e = v._artist_region_evidence;
    const nativeStorefront = {HK:"hk",TW:"tw",SG:"tw",MY:"tw"}[e?.country];
    if (!nativeStorefront || !e.artist_mbid || !e.primary_apple_artist_id ||
        v._apple_storefront !== nativeStorefront || v._apple_artist_ids?.[0] !== e.primary_apple_artist_id) continue;
    const name = v._apple_artist_names?.[0] || (v._apple_artist_ids?.length === 1 ? v.artist : null);
    if (name) names.set(e.artist_mbid, name);
  }
  const replaceCredit = (credits, fallback) => {
    if (!credits?.length || !credits.some(c => names.has(c.artist?.id))) return fallback;
    return credits.map(c => (names.get(c.artist?.id) ?? c.name ?? c.artist?.name ?? "") + (c.joinphrase ?? "")).join("");
  };
  return {...mapped, artist:replaceCredit(mbDisplay?.artist_credit, mapped.artist),
    album_artist:replaceCredit(mbDisplay?.album_artist_credit, mapped.album_artist)};
}
async function enrichTrackForLastFm(track, devToken, musicUserToken, apiKey, kv, env = null) {
  let appleVariants = [];
  try {
    appleVariants = await getAppleCatalogVariants(track, devToken, musicUserToken, kv);
    for (let i = 0; i < appleVariants.length; i++) appleVariants[i] = normalizeVerifiedHariArtist(appleVariants[i]);
    const provisionalPreferred = choosePreferredAppleTrack(track, appleVariants, true);
    let identity = null;
    try {
      identity = await resolveMusicBrainzIdentity(provisionalPreferred, appleVariants.length > 0 ? appleVariants : [provisionalPreferred], kv);
    } catch (err) {
      if (!shouldDeferIdentityNormalizationFailure(err)) throw err;
      identity = await resolveMusicBrainzIdentityViaLastFmRelease(
        provisionalPreferred,
        appleVariants.length > 0 ? appleVariants : [provisionalPreferred],
        apiKey
      );
      if (!identity && !trustedNativeAppleFallback(appleVariants)) throw err;
      if (kv && identity) {
        await kv.put(
          musicBrainzIdentityCacheKey(provisionalPreferred),
          JSON.stringify({ identity, checked_at_iso: new Date().toISOString() })
        ).catch(() => void 0);
      }
    }
    if (!identity) {
      const source = appleVariants.find(v=>v._is_source_storefront) ?? provisionalPreferred;
      const regional = await resolveSourceMusicBrainzOfficial(source).catch(()=>null);
      if (regional) identity = regional.identity;
    }
    if (!identity) identity = await resolveAppleAlbumCompanion(appleVariants, kv).catch(() => null);
    if (!identity && appleVariants._apple_native_lookup_transient === true && !trustedNativeAppleFallback(appleVariants)) {
      throw new Error("apple_native_search_transient_failure:unconfirmed_identity");
    }
    identity = await resolveNativeReleaseMetadata(identity, appleVariants, kv);
    await rememberAppleAlbumCompanion(appleVariants, identity, kv).catch(() => void 0);
    const confirmedAppleVariants = filterMusicBrainzConfirmedAppleVariants(appleVariants, identity);
    // These candidates have already passed the final release gate.
    const preferred = choosePreferredAppleTrack(track, confirmedAppleVariants, true);
    const spotifyEvidence = await getConditionalSpotifyEvidence(
      preferred,
      confirmedAppleVariants.length > 0 ? confirmedAppleVariants : [preferred],
      identity,
      env
    ).catch(() => null);
    let mapped = await mapConfirmedIdentityToLastFm(
      preferred,
      confirmedAppleVariants.length > 0 ? confirmedAppleVariants : [preferred],
      identity,
      spotifyEvidence,
      apiKey
    );
    if (!identity) {
      const diagnostic = {};
      const fallback = await resolveCrossIsrcOfficialFallback(appleVariants.find(v => v._is_source_storefront) ?? preferred, devToken, musicUserToken, apiKey, kv, diagnostic).catch(err => { diagnostic.error = String(err?.message ?? err); return null; });
      if (fallback) {
        identity = fallback.identity;
        mapped = await mapConfirmedIdentityToLastFm(fallback.native, [fallback.native], identity, null, apiKey);
        mapped = { ...mapped, artist: identity.artist, name: identity.track, album: identity.album, album_artist: identity.album_artist };
        appleVariants.push(fallback.native);
      }
      mapped._cross_isrc_diagnostics = diagnostic;
    }
    if (!identity && preferred._artist_region_evidence) {
      mapped = {...mapped, artist:preferred.artist, name:preferred.name, album:preferred.album, album_artist:preferred.album_artist,
        _artist_region_evidence:preferred._artist_region_evidence};
    }
    const mbDisplay = await confirmedMusicBrainzDisplay(identity, kv);
    if (mbDisplay) {
      const verifiedCandidates = confirmedAppleVariants.map(v => ({...v, _apple_release_equivalence_requires_musicbrainz:false}));
      const nativeDisplay = nativeDisplayOverMb(mbDisplay, verifiedCandidates, identity);
      const canonical = preserveMainlandSourceDisplay(preserveNativeHkTwArtist(nativeDisplay ? {...mapped, artist:nativeDisplay.artist, name:nativeDisplay.name, album:nativeDisplay.album, album_artist:nativeDisplay.album_artist} : {...mapped, artist:mbDisplay.artist, name:mbDisplay.track, album:mbDisplay.album, album_artist:mbDisplay.album_artist}, confirmedAppleVariants, mbDisplay), confirmedAppleVariants);
      // Artwork is checked for the final MB fields, never used to choose them.
      const info = await getLastFmAlbumInfo(apiKey, canonical.album_artist, canonical.album).catch(() => null);
      mapped = {...canonical, mbid:identity.recording_mbid, mbid_kind:"recording", _metadata_source:canonical._metadata_source === "verified_mainland_apple_source" ? canonical._metadata_source : nativeDisplay ? "verified_apple_native_over_mb_script" : "musicbrainz_release_track",
        _lastfm_artwork_match:Boolean(lastFmAlbumHasRealArtwork(info) && findLastFmAlbumTrack(info, canonical, {title:canonical.name,length:canonical.duration_ms}))};
    } else if (!identity?.confirmed) {
      mapped = await normalizeIndependentArtist(mapped, appleVariants.find(v => v._is_source_storefront) ?? preferred, kv).catch(() => mapped);
      const artistEvidence = appleVariants.find(v=>v._artist_region_evidence?.artist_mbid)?._artist_region_evidence ??
        await resolveArtistNativeRegion(track,kv).catch(()=>null);
      mapped = applyVerifiedNativeArtistFallback(mapped,artistEvidence);
    }
    mapped = await reuseVerifiedHistoricalMapping(mapped, confirmedAppleVariants, apiKey, kv).catch(()=>mapped);
    const albumException = applyLuoBeijingHongKongAppleDisplay(mapped, confirmedAppleVariants);
    if (albumException !== mapped) {
      const info = await getLastFmAlbumInfo(apiKey,normalizeLastFmAlbumArtist(albumException.album_artist),albumException.album).catch(()=>null);
      mapped = {...albumException,_lastfm_artwork_match:Boolean(info && findLastFmAlbumTrack(info,albumException,{title:albumException.name,length:albumException.duration_ms}))};
    }
    mapped = normalizeVerifiedHariArtist(mapped);
    // User-defined display policy must run after every metadata/display mapping.
    mapped = applyArtistDisplayOverride(mapped, identity);
    return {
      ...mapped,
      album_artist: normalizeLastFmAlbumArtist(mapped.album_artist),
      _apple_variant_diagnostics: appleVariants.map((candidate) => ({
        artist: candidate.artist,
        track: candidate.name,
        album: candidate.album,
        isrc: candidate.isrc,
        catalog_id: candidate.catalog_id,
        storefront: candidate._apple_storefront,
        metadata_source: candidate._metadata_source,
        lookup_method: candidate._apple_lookup_method,
        requires_musicbrainz: candidate._apple_release_equivalence_requires_musicbrainz === true
      })),
      _musicbrainz_identity_diagnostics: identity ? {
        recording_mbid: identity.recording_mbid,
        release_mbid: identity.release_mbid,
        release_group_mbid: identity.release_group_mbid,
        method: identity.method
      } : null
    };
  } catch (err) {
    console.warn(`Identity normalization skipped for "${track.artist}":`, err);
    if (shouldDeferIdentityNormalizationFailure(err)) throw err;
    return {
      ...track,
      mbid: "",
      mbid_kind: "",
      _identity_source: "apple_fallback",
      _identity_error: err instanceof Error ? err.message : String(err)
    };
  }
}
function signParams(params, sharedSecret) {
  const sigString = Object.keys(params).filter((k) => k !== "format" && k !== "callback").sort().map((k) => `${k}${params[k]}`).join("") + sharedSecret;
  return md5(sigString);
}
async function scrobbleBatch(plays, apiKey, sharedSecret, sessionKey) {
  const result = { accepted: 0, ignored: 0, errors: 0, last_error: null, items: [] };
  if (plays.length === 0) return result;
  for (let chunkStart = 0; chunkStart < plays.length; chunkStart += BATCH_SIZE) {
    const chunk = plays.slice(chunkStart, chunkStart + BATCH_SIZE);
    const params = {
      method: "track.scrobble",
      api_key: apiKey,
      sk: sessionKey
    };
    chunk.forEach((play, i) => {
      if (!play.artist || !play.track) return;
      params[`artist[${i}]`] = play.artist;
      params[`track[${i}]`] = play.track;
      params[`timestamp[${i}]`] = Math.floor(
        play.timestamp.getTime() / 1e3
      ).toString();
      if (play.album) params[`album[${i}]`] = play.album;
      if (play.album_artist) params[`albumArtist[${i}]`] = normalizeLastFmAlbumArtist(play.album_artist);
      if (play.mbid) params[`mbid[${i}]`] = play.mbid;
      if (play.duration_ms) {
        params[`duration[${i}]`] = Math.floor(play.duration_ms / 1e3).toString();
      }
    });
    params.api_sig = signParams(params, sharedSecret);
    params.format = "json";
    const body = new URLSearchParams(params);
    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
    } catch (e) {
      console.error("Last.fm HTTP error:", e);
      result.errors += chunk.length;
      result.last_error = `network_error: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (!response.ok) {
      const text = await response.text();
      console.error(`Last.fm ${response.status}: ${text.slice(0, 300)}`);
      result.errors += chunk.length;
      result.last_error = `http_${response.status}: ${text.slice(0, 200)}`;
      continue;
    }
    let json2;
    try {
      json2 = await response.json();
    } catch {
      console.error("Last.fm non-JSON response");
      result.errors += chunk.length;
      result.last_error = "non_json_response";
      continue;
    }
    if (json2?.error) {
      result.errors += chunk.length;
      result.last_error = `api_${json2.error}: ${json2.message ?? "unknown Last.fm error"}`;
      console.error(`Last.fm API error ${json2.error}: ${json2.message ?? "unknown"}`);
      continue;
    }
    const attr = json2?.scrobbles?.["@attr"] ?? {};
    const accepted = parseInt(attr.accepted ?? "0", 10);
    const ignored = parseInt(attr.ignored ?? "0", 10);
    result.accepted += accepted;
    result.ignored += ignored;
    let scrobbleList = json2?.scrobbles?.scrobble ?? [];
    if (!Array.isArray(scrobbleList)) scrobbleList = [scrobbleList];
    for (let index = 0; index < chunk.length; index++) {
      const submitted = chunk[index];
      const returned = scrobbleList[index] ?? {};
      const ignoredMessage = returned?.ignoredMessage ?? {};
      const ignoredCode = String(ignoredMessage.code ?? "0");
      result.items.push({
        artist: submitted.artist,
        track: submitted.track,
        accepted: ignoredCode === "0",
        ignored_code: ignoredCode,
        ignored_message: ignoredMessage["#text"] ?? "",
        corrected: {
          artist: String(returned?.artist?.corrected ?? "0") === "1",
          track: String(returned?.track?.corrected ?? "0") === "1",
          album: String(returned?.album?.corrected ?? "0") === "1",
          album_artist: String(returned?.albumArtist?.corrected ?? "0") === "1"
        },
        returned: {
          artist: returned?.artist?.["#text"] ?? "",
          track: returned?.track?.["#text"] ?? "",
          album: returned?.album?.["#text"] ?? "",
          album_artist: returned?.albumArtist?.["#text"] ?? ""
        }
      });
    }
    const unaccounted = Math.max(0, chunk.length - accepted - ignored);
    if (unaccounted > 0) {
      result.errors += unaccounted;
      result.last_error = `incomplete_response: ${accepted} accepted, ${ignored} ignored, ${chunk.length} submitted`;
    }
    if (ignored > 0) {
      for (const s of scrobbleList) {
        const msg = s?.ignoredMessage ?? {};
        if (msg.code && msg.code !== "0") {
          console.warn(
            `  ignored: ${s?.track?.["#text"] ?? "?"} \u2014 ${msg["#text"] ?? "?"} (code ${msg.code})`
          );
          result.last_error = `ignored_${msg.code}: ${msg["#text"] ?? "unknown"}`;
        }
      }
    }
  }
  return result;
}

// src/listenbrainz.ts
var API_URL2 = "https://api.listenbrainz.org/1/submit-listens";
var BATCH_SIZE2 = 100;
async function submitBatch(plays, userToken) {
  const result = { accepted: 0, errors: 0 };
  if (plays.length === 0) return result;
  const entries = plays.filter((p) => p.artist && p.track).map((p) => ({
    listened_at: Math.floor(p.timestamp.getTime() / 1e3),
    track_metadata: {
      artist_name: p.artist,
      track_name: p.track,
      release_name: p.album || void 0,
      additional_info: {
        submission_client: "aScrobble-scrobbler",
        submission_client_version: "0.2.0",
        music_service: "music.apple.com",
        duration_ms: p.duration_ms || void 0
      }
    }
  }));
  for (let chunkStart = 0; chunkStart < entries.length; chunkStart += BATCH_SIZE2) {
    const chunk = entries.slice(chunkStart, chunkStart + BATCH_SIZE2);
    const body = {
      listen_type: chunk.length === 1 ? "single" : "import",
      payload: chunk
    };
    let response;
    try {
      response = await fetch(API_URL2, {
        method: "POST",
        headers: {
          Authorization: `Token ${userToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      console.error("ListenBrainz HTTP error:", e);
      result.errors += chunk.length;
      continue;
    }
    if (response.ok) {
      result.accepted += chunk.length;
    } else if (response.status === 401) {
      console.error(
        "ListenBrainz 401 \u2014 LISTENBRAINZ_TOKEN invalid. Get a new one at https://listenbrainz.org/profile/"
      );
      result.errors += chunk.length;
      break;
    } else {
      const text = await response.text();
      console.error(`ListenBrainz ${response.status}: ${text.slice(0, 300)}`);
      result.errors += chunk.length;
    }
  }
  return result;
}

// src/notify.ts
async function notifyTokenExpired(webhookUrl) {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    "\u{1F534} **aScrobble**: Apple Music tokens expired (401).\nRe-open the aScrobble desktop app to re-authenticate with Apple Music."
  );
}
async function notifyMilestone(webhookUrl, total) {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    `\u{1F3B5} **aScrobble**: hit **${total.toLocaleString()}** total scrobbles`
  );
}
async function notifySummary(webhookUrl, accepted, repeatCount, ignored) {
  if (!webhookUrl || accepted === 0) return;
  const parts = [`**${accepted}** scrobbled`];
  if (repeatCount > 0) parts.push(`${repeatCount} repeat plays`);
  if (ignored > 0) parts.push(`${ignored} ignored`);
  await postMessage(webhookUrl, "\u{1F3B5} " + parts.join(" \xB7 "));
}
async function postMessage(webhookUrl, message) {
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Discord uses "content", Slack accepts "text"; sending both covers both.
      body: JSON.stringify({ content: message, text: message })
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`Notify webhook ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("Notify webhook error:", e);
  }
}

// src/ledger.ts
var LEDGER_KEY = "ledger:v1";
function addLogEntry(ledger, step, details, level = "info") {
  if (!ledger.log_entries) ledger.log_entries = [];
  ledger.log_entries.unshift({
    timestamp_iso: (/* @__PURE__ */ new Date()).toISOString(),
    step,
    details,
    level
  });
  ledger.log_entries = ledger.log_entries.slice(0, 50);
}
var MAX_RECENT_SCROBBLES = 1e3;
var MAX_PENDING_SCROBBLES = 1e3;
var MAX_PENDING_ENRICHMENTS = 1e3;
var PENDING_ENRICHMENT_BATCH_SIZE = 5;
var DEFAULT_LEDGER = {
  version: 1,
  last_run_iso: null,
  previous_recent: [],
  recent_scrobbles: [],
  pending_scrobbles: [],
  pending_enrichments: [],
  stats: {
    total_scrobbled: 0,
    total_runs: 0,
    total_errors: 0,
    last_success_iso: null,
    last_error_iso: null,
    last_error_message: null
  }
};
var MEMORY_LEDGER_CACHE = null;
async function loadLedger(kv, diagnostic = null) {
  try {
    const raw = await kv.get(LEDGER_KEY, "json");
    if (raw && typeof raw === "object") {
      const kvLedger = { ...DEFAULT_LEDGER, ...raw };
      if (diagnostic) diagnostic.ledger_read = { kv_last_run: kvLedger.last_run_iso, memory_last_run: MEMORY_LEDGER_CACHE?.last_run_iso ?? null, selected: "kv", kv_previous: kvLedger.previous_recent };
      if (MEMORY_LEDGER_CACHE && MEMORY_LEDGER_CACHE.last_run_iso) {
        const memoryTime = new Date(MEMORY_LEDGER_CACHE.last_run_iso).getTime();
        const kvTime = kvLedger.last_run_iso ? new Date(kvLedger.last_run_iso).getTime() : 0;
        if (memoryTime >= kvTime) {
          if (diagnostic) diagnostic.ledger_read.selected = "memory";
          return MEMORY_LEDGER_CACHE;
        }
      }
      MEMORY_LEDGER_CACHE = kvLedger;
      return kvLedger;
    }
  } catch (e) {
    if (diagnostic) diagnostic.ledger_read = { selected: MEMORY_LEDGER_CACHE ? "memory_after_read_failure" : "default_after_read_failure", read_failed: true };
    console.warn("Ledger read failed, starting fresh:", e);
  }
  return MEMORY_LEDGER_CACHE ?? { ...DEFAULT_LEDGER };
}
async function saveLedger(kv, ledger) {
  MEMORY_LEDGER_CACHE = ledger;
  await kv.put(LEDGER_KEY, JSON.stringify(ledger));
}
async function loadMigrationRecovery(kv) {
  try {
    const recovery = await kv.get(MIGRATION_RECOVERY_KEY, "json");
    return recovery && typeof recovery === "object" ? recovery : null;
  } catch (e) {
    console.warn("Migration recovery read failed:", e);
    return null;
  }
}
async function saveMigrationRecovery(kv, recovery) {
  await kv.put(MIGRATION_RECOVERY_KEY, JSON.stringify(recovery));
}
function buildMigrationRecovery(ledger, timestamped, result) {
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    version: HISTORY_SOURCE_VERSION,
    accepted: result.accepted,
    ignored: result.ignored,
    errors: result.errors,
    completed_at_iso: completedAt,
    recent_scrobbles: timestamped.map((p) => ({
      artist: p.track.artist,
      track: p.track.name,
      album: p.track.album,
      timestamp_iso: p.timestamp?.toISOString() ?? completedAt,
      kind: "recovered"
    })),
    log_entries: [
      {
        timestamp_iso: completedAt,
        step: "migration_recovery_done",
        details: `Recovered Apple library plays: ${result.accepted} accepted · ${result.ignored} ignored · ${result.errors} errors`,
        level: result.accepted > 0 ? "success" : result.errors > 0 ? "error" : "info"
      }
    ]
  };
}
function addRecentScrobbles(ledger, plays) {
  const newEntries = plays.map((p) => ({
    track_id: p.track.id ?? "",
    catalog_id: p.track.catalog_id ?? null,
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp_iso: p.timestamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
    kind: p.kind
  }));
  ledger.recent_scrobbles = [...newEntries, ...ledger.recent_scrobbles].slice(
    0,
    MAX_RECENT_SCROBBLES
  );
}
function pendingScrobbleKey(item) {
  return `${item.artist}\n${item.track}\n${item.timestamp_iso}`;
}
function pendingEnrichmentKey(item) {
  return `${item.track?.id ?? ""}\n${item.timestamp_iso}`;
}
function appendPendingEnrichments(ledger, plays) {
  if (!ledger.pending_enrichments) ledger.pending_enrichments = [];
  const existing = new Set(ledger.pending_enrichments.map(pendingEnrichmentKey));
  for (const play of plays) {
    const item = {
      track: play.track,
      kind: play.kind,
      timestamp_iso: play.timestamp.toISOString(),
      queued_at_iso: (/* @__PURE__ */ new Date()).toISOString()
    };
    const key = pendingEnrichmentKey(item);
    if (existing.has(key)) continue;
    ledger.pending_enrichments.push(item);
    existing.add(key);
  }
  ledger.pending_enrichments = ledger.pending_enrichments.slice(-MAX_PENDING_ENRICHMENTS);
}
function pendingEnrichmentToTimestamped(item) {
  return {
    track: item.track,
    kind: item.kind ?? "new",
    timestamp: new Date(item.timestamp_iso)
  };
}
async function processPendingEnrichmentBatch(items, enrichFn) {
  const succeeded = [];
  const failed = [];
  for (const item of items) {
    const pending = pendingEnrichmentToTimestamped(item);
    try {
      const enrichedTrack = await enrichFn(pending.track);
      succeeded.push({ ...pending, track: enrichedTrack });
    } catch (error) {
      failed.push({ item, pending, error });
    }
  }
  return { succeeded, failed };
}
function appendPendingScrobbles(ledger, plays) {
  if (!ledger.pending_scrobbles) ledger.pending_scrobbles = [];
  const existing = new Set(ledger.pending_scrobbles.map(pendingScrobbleKey));
  for (const p of plays) {
    const item = {
      track_id: p.track.id ?? "",
      artist: p.track.artist,
      track: p.track.name,
      album: p.track.album ?? "",
      album_artist: normalizeLastFmAlbumArtist(p.track.album_artist ?? ""),
      mbid: p.track.mbid ?? "",
      mbid_kind: p.track.mbid_kind ?? "",
      duration_ms: p.track.duration_ms ?? 18e4,
      timestamp_iso: p.timestamp.toISOString(),
      kind: p.kind,
      queued_at_iso: (/* @__PURE__ */ new Date()).toISOString()
    };
    const key = pendingScrobbleKey(item);
    if (!existing.has(key)) {
      ledger.pending_scrobbles.push(item);
      existing.add(key);
    }
  }
  ledger.pending_scrobbles = ledger.pending_scrobbles.slice(-MAX_PENDING_SCROBBLES);
}
function pendingToTimestamped(item) {
  return {
    track: {
      id: item.track_id,
      artist: item.artist,
      name: item.track,
      album: item.album,
      album_artist: item.album_artist,
      mbid: item.mbid,
      mbid_kind: item.mbid_kind,
      duration_ms: item.duration_ms
    },
    kind: item.kind ?? "new",
    timestamp: new Date(item.timestamp_iso)
  };
}
function normalizeLastFmAlbumArtist(value) {
  return typeof value === "string" && value.trim() === "群星" ? "Various Artists" : value;
}
function buildLastFmPayload(play) {
  return {
    artist: play.track.artist,
    track: play.track.name,
    album: play.track.album,
    album_artist: normalizeLastFmAlbumArtist(play.track.album_artist),
    mbid: play.track.mbid_kind === "recording" ? play.track.mbid : "",
    timestamp: play.timestamp,
    duration_ms: play.track.duration_ms
  };
}
function parseLastRunTime(ledger) {
  if (!ledger.last_run_iso) return null;
  const d = new Date(ledger.last_run_iso);
  return isNaN(d.getTime()) ? null : d;
}

// src/kv_keys.ts
var KV_KEY_APPLE_DEV_TOKEN = "apple_dev_token";
var KV_KEY_APPLE_USER_TOKEN = "apple_user_token";

// src/scrobbler.ts
var CB_ERROR_THRESHOLD = 5;
var CB_BASE_COOLDOWN_MS = 30 * 60 * 1e3;
var CB_INSTANT_TRIP_ERRORS = /* @__PURE__ */ new Set(["apple_token_expired", "apple_tokens_missing_in_kv"]);
var CB_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1e3;
var DEDUP_WINDOW_MS = 30 * 1e3;
var DEDUP_MAX_ENTRIES = 200;
var PENDING_SUBMIT_BATCH_SIZE = 50;
function isCircuitOpen(ledger, now) {
  if (!ledger.circuit_open_until_iso) return false;
  return now < new Date(ledger.circuit_open_until_iso).getTime();
}
function openCircuit(ledger, now) {
  const opens = ledger.consecutive_errors ?? CB_ERROR_THRESHOLD;
  const multiplier = Math.pow(2, Math.max(0, Math.floor(opens / CB_ERROR_THRESHOLD) - 1));
  const cooldown = Math.min(CB_BASE_COOLDOWN_MS * multiplier, CB_MAX_COOLDOWN_MS);
  ledger.circuit_open_until_iso = new Date(now + cooldown).toISOString();
  console.warn(
    `Circuit breaker OPEN \u2014 pausing polls for ${Math.round(cooldown / 6e4)} min (consecutive_errors=${ledger.consecutive_errors})`
  );
}
function resetCircuit(ledger) {
  ledger.consecutive_errors = 0;
  ledger.circuit_open_until_iso = void 0;
}
function dedupKey(trackId, bucketMs) {
  const bucket = Math.floor(bucketMs / DEDUP_WINDOW_MS);
  return `${trackId}:${bucket}`;
}
function pruneDedup(ledger, now) {
  if (!ledger.recent_scrobble_ids) return;
  const cutoff = Math.floor((now - DEDUP_WINDOW_MS) / DEDUP_WINDOW_MS);
  ledger.recent_scrobble_ids = ledger.recent_scrobble_ids.filter((k) => {
    const bucket = parseInt(k.slice(k.lastIndexOf(":") + 1) || "0", 10);
    return bucket > cutoff;
  }).slice(0, DEDUP_MAX_ENTRIES);
}
function isDuplicate(ledger, trackId, now) {
  if (!ledger.recent_scrobble_ids) return false;
  return ledger.recent_scrobble_ids.includes(dedupKey(trackId, now));
}
function recordScrobbled(ledger, trackId, now) {
  if (!ledger.recent_scrobble_ids) ledger.recent_scrobble_ids = [];
  ledger.recent_scrobble_ids.push(dedupKey(trackId, now));
}
async function failRun(env, ledger, runTime, startedAt, errorMessage, instantTrip = false) {
  ledger.stats.total_errors += 1;
  ledger.stats.last_error_iso = runTime.toISOString();
  ledger.stats.last_error_message = errorMessage;
  ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
  const shouldOpen = instantTrip || CB_INSTANT_TRIP_ERRORS.has(errorMessage) || ledger.consecutive_errors >= CB_ERROR_THRESHOLD;
  if (shouldOpen && !isCircuitOpen(ledger, startedAt)) {
    openCircuit(ledger, startedAt);
  }
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return {
    ok: false,
    detected: 0,
    accepted: 0,
    ignored: 0,
    errors: 1,
    repeat_count: 0,
    elapsed_ms: Date.now() - startedAt,
    error_message: errorMessage,
    circuit_open: isCircuitOpen(ledger, startedAt)
  };
}
async function pollAndScrobble(env, isManual = false) {
  const startedAt = Date.now();
  const runTime = new Date(startedAt);
  const diagnostic = env.__diagnostic ?? null;
  const ledger = await loadLedger(env.ASCROBBLE_STATE, diagnostic);
  if (diagnostic) { diagnostic.previous = structuredClone(ledger.previous_recent); diagnostic.before = { last_run_iso: ledger.last_run_iso, last_save_iso: ledger.last_save_iso, total_runs: ledger.stats.total_runs, history_source_version: ledger.history_source_version, recent_scrobble_ids: [...(ledger.recent_scrobble_ids ?? [])], pending: diagnosticPending(ledger), recent: structuredClone((ledger.recent_scrobbles ?? []).slice(0, 1000)) }; }
  const lastRunTime = parseLastRunTime(ledger);
  ledger.stats.total_runs += 1;
  ledger.last_run_iso = runTime.toISOString();
  addLogEntry(ledger, "poll_start", `Run #${ledger.stats.total_runs} started${isManual ? " (manual)" : ""} \xB7 elapsed since last: ${lastRunTime ? Math.round((startedAt - lastRunTime.getTime()) / 1e3) + "s" : "first run"}`, "info");
  if (isManual) {
    resetCircuit(ledger);
    addLogEntry(ledger, "circuit_reset", "Manual trigger \u2014 circuit breaker reset", "info");
  }
  if (isCircuitOpen(ledger, startedAt)) {
    const until = new Date(ledger.circuit_open_until_iso);
    const minLeft = Math.round((until.getTime() - startedAt) / 6e4);
    console.warn(
      `Circuit breaker is OPEN \u2014 skipping poll. Will retry after ${until.toISOString()} (${minLeft} min remaining)`
    );
    addLogEntry(ledger, "circuit_open", `Circuit open \u2014 skipping poll for ${minLeft}min more`, "error");
    ledger.last_run_iso = runTime.toISOString();
    const lastSaveTime = ledger.last_save_iso ? new Date(ledger.last_save_iso).getTime() : 0;
    if (startedAt - lastSaveTime > 15 * 60 * 1e3) {
      ledger.last_save_iso = runTime.toISOString();
      await saveLedger(env.ASCROBBLE_STATE, ledger);
    }
    return {
      ok: false,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
      circuit_open: true
    };
  }
  addLogEntry(ledger, "kv_token_read", "Reading Apple dev + user tokens from Cloudflare KV...", "info");
  let [appleDevToken, appleUserToken] = await Promise.all([
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_DEV_TOKEN),
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_USER_TOKEN)
  ]);
  if (!appleDevToken || !appleUserToken) {
    const msg = "apple_tokens_missing_in_kv";
    console.error(
      `${msg}: expected keys ${KV_KEY_APPLE_DEV_TOKEN} and ${KV_KEY_APPLE_USER_TOKEN}`
    );
    addLogEntry(ledger, "kv_token_missing", "Apple tokens not found in KV \u2014 circuit tripped", "error");
    return failRun(
      env,
      ledger,
      runTime,
      startedAt,
      msg,
      /*instantTrip=*/
      true
    );
  }
  addLogEntry(ledger, "kv_token_ok", "Apple tokens found in KV \u2713", "info");
  if (appleDeveloperTokenNeedsRefresh(appleDevToken)) {
    try {
      const refreshedToken = await refreshAppleDeveloperToken(env, appleDevToken);
      if (refreshedToken !== appleDevToken) {
        appleDevToken = refreshedToken;
        addLogEntry(ledger, "apple_dev_token_refreshed", "Apple web developer token refreshed automatically", "success");
      }
    } catch (err) {
      console.warn("Pre-emptive Apple developer token refresh failed; using current token:", err);
      addLogEntry(ledger, "apple_dev_token_refresh_deferred", "Automatic Apple token refresh deferred; current token is still being tried", "info");
    }
  }
  addLogEntry(ledger, "apple_fetch_start", "Calling Apple Music /v1/me/recent/played/tracks...", "info");
  let current;
  try {
    current = await fetchRecentlyPlayed(appleDevToken, appleUserToken, diagnostic);
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      try {
        const refreshedToken = await refreshAppleDeveloperToken(env, appleDevToken, true);
        if (refreshedToken === appleDevToken) throw e;
        appleDevToken = refreshedToken;
        addLogEntry(ledger, "apple_dev_token_refreshed_after_401", "Apple developer token refreshed after a 401; retrying", "success");
        current = await fetchRecentlyPlayed(appleDevToken, appleUserToken, diagnostic);
      } catch (refreshErr) {
        console.error("Apple token refresh after 401 failed \u2014 tripping circuit breaker", refreshErr);
        addLogEntry(ledger, "apple_token_expired", "Apple Music returned 401 and automatic developer-token refresh could not recover", "error");
        await notifyTokenExpired(env.NOTIFY_WEBHOOK_URL);
        return failRun(
          env,
          ledger,
          runTime,
          startedAt,
          "apple_token_expired",
          /*instantTrip=*/
          true
        );
      }
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Apple API error:", msg);
      addLogEntry(ledger, "apple_fetch_error", `Apple API error: ${msg}`, "error");
      return failRun(env, ledger, runTime, startedAt, `apple_api_error: ${msg}`);
    }
  }
  resetCircuit(ledger);
  if (diagnostic) diagnostic.current = structuredClone(current);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  console.log(`Apple returned ${current.length} tracks`);
  addLogEntry(ledger, "apple_fetch_success", `Fetched ${current.length} recently played tracks from Apple API`, "info");
  if (ledger.history_source_version !== HISTORY_SOURCE_VERSION) {
    console.log(`History source migration to v${HISTORY_SOURCE_VERSION} — snapshotting ${current.length} tracks without scrobbling`);
    addLogEntry(ledger, "history_source_migration", `Enabled Apple catalog + library history; safely snapshotting ${current.length} tracks`, "success");
    ledger.history_source_version = HISTORY_SOURCE_VERSION;
    ledger.previous_recent = current;
    ledger.stationary_idle = false;
    ledger.handled_count = 1;
    ledger.position0_elapsed_sec = 0;
    ledger.top_track_id = void 0;
    ledger.top_track_play_count = void 0;
    ledger.stats.last_success_iso = runTime.toISOString();
    ledger.last_save_iso = runTime.toISOString();
    await saveLedger(env.ASCROBBLE_STATE, ledger);
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  if (ledger.previous_recent.length === 0) {
    console.log(`First run \u2014 snapshotting ${current.length} tracks without scrobbling`);
    addLogEntry(ledger, "bootstrap_snapshot", `Snapshotting ${current.length} tracks on initial run`, "info");
    ledger.previous_recent = current;
    ledger.stats.last_success_iso = runTime.toISOString();
    await saveLedger(env.ASCROBBLE_STATE, ledger);
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  const elapsedSeconds = lastRunTime ? Math.max(0, Math.round((startedAt - lastRunTime.getTime()) / 1e3)) : 180;
  const prevState = {
    stationaryIdle: ledger.stationary_idle ?? false,
    handledCount: ledger.handled_count ?? 1,
    position0ElapsedSec: ledger.position0_elapsed_sec ?? 0
  };
  const detection = detectPlays(current, ledger.previous_recent, elapsedSeconds, prevState);
  const nextHistoryBaseline = selectHistoryBaseline(current, ledger.previous_recent);
  if (diagnostic) diagnostic.baseline_update = {
    action: nextHistoryBaseline === current ? "advance" : "retain_on_prefix_loss",
    observed_count: current.length,
    retained_count: nextHistoryBaseline.length
  };
  if (diagnostic) { diagnostic.elapsed_seconds = elapsedSeconds; diagnostic.prev_state = prevState; diagnostic.decision = explainHistoryDecision(current, ledger.previous_recent); diagnostic.detected = structuredClone(detection); }
  const repeatSafety = filterImplausibleInferredRepeats(detection.plays, elapsedSeconds);
  const plays = repeatSafety.plays;
  if (repeatSafety.dropped > 0) {
    console.warn(`Repeat safety guard: dropped ${repeatSafety.dropped} implausible inferred repeat(s)`);
    addLogEntry(ledger, "repeat_burst_blocked", `Dropped ${repeatSafety.dropped} inferred repeat(s) that could not fit in the ${elapsedSeconds}s polling window`, "warn");
  }
  ledger.stationary_idle = detection.newState.stationaryIdle;
  ledger.handled_count = detection.newState.handledCount;
  ledger.position0_elapsed_sec = detection.newState.position0ElapsedSec;
  if (plays.length === 0 && current.length > 0 && ledger.previous_recent.length > 0) {
    const topTrack = current[0];
    const prevTopTrack = ledger.previous_recent[0];
    const topTrackIdentity = appleHistoryTrackIdentity(topTrack);
    if (topTrackIdentity === appleHistoryTrackIdentity(prevTopTrack) && topTrack.isrc) {
      const newCount = await fetchTrackPlayCount(appleDevToken, appleUserToken, topTrack.isrc);
      if (newCount !== null) {
        const prevCount = ledger.top_track_id === topTrackIdentity ? ledger.top_track_play_count : void 0;
        if (prevCount !== void 0 && newCount > prevCount) {
          const delta = newCount - prevCount;
          console.log(
            `Position-0 probe: play count for "${topTrack.name}" rose by ${delta} \u2014 emitting ${delta} silent repeat(s)`
          );
          addLogEntry(ledger, "repeat_probe_detected", `Library playCount rose by ${delta} for "${topTrack.name}"`, "success");
          for (let i = 0; i < delta; i++) {
            plays.push({ track: topTrack, kind: "repeat" });
          }
          ledger.stationary_idle = false;
        }
        ledger.top_track_id = topTrackIdentity;
        ledger.top_track_play_count = newCount;
      }
    } else {
      ledger.top_track_id = current[0] ? appleHistoryTrackIdentity(current[0]) : void 0;
      ledger.top_track_play_count = void 0;
    }
  }
  pruneDedup(ledger, startedAt);
  const deduped = plays.filter((p) => {
    const trackId = appleHistoryTrackIdentity(p.track);
    if (!trackId) return true;
    if (isDuplicate(ledger, trackId, startedAt)) {
      console.warn(`Dedup guard: skipping "${p.track.name}" \u2014 already scrobbled in last 30s`);
      addLogEntry(ledger, "dedup_skipped", `Skipping duplicate play "${p.track.name}" within 30s window`, "warn");
      return false;
    }
    return true;
  });
  if (diagnostic) { diagnostic.repeat_safety_dropped = repeatSafety.dropped; diagnostic.after_guards = structuredClone(deduped); diagnostic.stage = "detected"; await env.__saveDiagnostic(); }
  const pendingAtStart = ledger.pending_scrobbles ?? [];
  const pendingEnrichmentsAtStart = ledger.pending_enrichments ?? [];
  if (deduped.length === 0 && pendingAtStart.length === 0 && pendingEnrichmentsAtStart.length === 0) {
    console.log("No new plays");
    ledger.previous_recent = nextHistoryBaseline;
    const topTrackName = current[0]?.name ?? "None";
    addLogEntry(ledger, "poll_idle", `Checked ${current.length} Apple tracks \u2014 0 new plays. Latest track in history: "${topTrackName}"`, "info");
    const lastSaveTime = ledger.last_save_iso ? new Date(ledger.last_save_iso).getTime() : 0;
    const shouldSave = !ledger.last_save_iso || startedAt - lastSaveTime >= 2 * 60 * 1e3;
    if (shouldSave) {
      ledger.last_save_iso = runTime.toISOString();
      await saveLedger(env.ASCROBBLE_STATE, ledger);
    }
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  if (deduped.length > 0) {
    addLogEntry(ledger, "scrobble_detected", `Detected ${deduped.length} play(s): ${deduped.map((p) => `"${p.track.name}"`).join(", ")}`, "success");
    const dedupDropped = plays.length - deduped.length;
    console.log(`Detected ${deduped.length} play(s) (${dedupDropped} deduped)`);
    const timestamped = assignTimestamps(deduped, runTime, lastRunTime);
    if (diagnostic) diagnostic.timestamped = structuredClone(timestamped);
    for (const p of timestamped) {
      console.log(
        `  [${p.kind}] ${p.track.artist} \u2014 ${p.track.name} @ ${p.timestamp?.toISOString()}`
      );
    }
    appendPendingEnrichments(ledger, timestamped);
    ledger.previous_recent = nextHistoryBaseline;
    ledger.last_save_iso = runTime.toISOString();
    addLogEntry(ledger, "pending_enrichment_saved", `Persisted ${timestamped.length} detected play(s) before metadata enrichment · ${ledger.pending_enrichments.length} awaiting enrichment`, "success");
    await saveLedger(env.ASCROBBLE_STATE, ledger);
  } else {
    ledger.previous_recent = nextHistoryBaseline;
    addLogEntry(ledger, "pending_retry", `Retrying ${pendingAtStart.length} Last.fm submission(s) and ${pendingEnrichmentsAtStart.length} metadata enrichment(s)`, "warn");
  }
  const enrichmentItems = (ledger.pending_enrichments ?? []).slice(0, PENDING_ENRICHMENT_BATCH_SIZE);
  const enrichmentResult = await processPendingEnrichmentBatch(
    enrichmentItems,
    (track) => enrichTrackForLastFm(
        track,
        appleDevToken,
        appleUserToken,
        env.LASTFM_API_KEY,
        env.ASCROBBLE_STATE,
        env
    )
  );
  const retainedEnrichments = enrichmentResult.failed.map((failure) => failure.item);
  const enrichedTimestamped = enrichmentResult.succeeded;
  const adjustedCount = enrichedTimestamped.filter((pending) => {
    const original = enrichmentItems.find((item) => pendingEnrichmentKey(item) === `${pending.track.id ?? ""}\n${pending.timestamp.toISOString()}`)?.track;
    return original && (pending.track.artist !== original.artist || pending.track.album !== original.album || pending.track.name !== original.name);
  }).length;
  for (const { pending, error } of enrichmentResult.failed) {
    console.warn(`Deferred metadata enrichment for "${pending.track.artist} — ${pending.track.name}":`, error);
    addLogEntry(ledger, "pending_enrichment_deferred", `Deferred "${pending.track.name}" until a later poll: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
  ledger.pending_enrichments = [
    ...retainedEnrichments,
    ...(ledger.pending_enrichments ?? []).slice(enrichmentItems.length)
  ];
  if (adjustedCount > 0) {
    addLogEntry(ledger, "lastfm_metadata_enriched", `Adjusted ${adjustedCount} track metadata record(s) to improve Last.fm artwork matching`, "success");
  }
  if (enrichedTimestamped.length > 0) {
    appendPendingScrobbles(ledger, enrichedTimestamped);
    addLogEntry(ledger, "pending_queue_saved", `Prepared ${enrichedTimestamped.length} scrobble(s) · ${ledger.pending_scrobbles.length} awaiting Last.fm · ${ledger.pending_enrichments.length} still awaiting metadata`, "success");
  }
  if (enrichmentItems.length > 0) {
    ledger.last_save_iso = runTime.toISOString();
    await saveLedger(env.ASCROBBLE_STATE, ledger);
  }
  const submissionItems = (ledger.pending_scrobbles ?? []).slice(0, PENDING_SUBMIT_BATCH_SIZE);
  if (submissionItems.length === 0) {
    ledger.last_save_iso = runTime.toISOString();
    addLogEntry(ledger, "poll_enrichment_deferred", `No Last.fm submission ready · ${ledger.pending_enrichments?.length ?? 0} play(s) retained for metadata retry`, "warn");
    await saveLedger(env.ASCROBBLE_STATE, ledger);
    return {
      ok: true,
      detected: deduped.length,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      deferred_enrichments: ledger.pending_enrichments?.length ?? 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  const submissionTimestamped = submissionItems.map(pendingToTimestamped);
  const payload = submissionTimestamped.map(buildLastFmPayload);
  if (diagnostic) { diagnostic.submission = structuredClone(payload); diagnostic.stage = "before_submit"; await env.__saveDiagnostic(); }
  addLogEntry(ledger, "lastfm_submit_start", `Submitting ${payload.length} persisted scrobble(s) to Last.fm...`, "info");
  let lfmResult = await scrobbleBatch(
    payload,
    env.LASTFM_API_KEY,
    env.LASTFM_SHARED_SECRET,
    env.LASTFM_SESSION_KEY
  );
  if (diagnostic) diagnostic.lastfm_attempts.push(structuredClone(lfmResult));
  if (lfmResult.errors > 0 && lfmResult.accepted === 0) {
    console.warn(`Last.fm: all ${lfmResult.errors} tracks failed \u2014 retrying after 1 s`);
    addLogEntry(ledger, "lastfm_submit_retry", `All ${lfmResult.errors} tracks failed \u2014 retrying in 1s...`, "warn");
    await new Promise((r) => setTimeout(r, 1e3));
    lfmResult = await scrobbleBatch(
      payload,
      env.LASTFM_API_KEY,
      env.LASTFM_SHARED_SECRET,
      env.LASTFM_SESSION_KEY
    );
    if (diagnostic) diagnostic.lastfm_attempts.push(structuredClone(lfmResult));
  }
  console.log(
    `Last.fm: ${lfmResult.accepted} accepted, ${lfmResult.ignored} ignored, ${lfmResult.errors} errors`
  );
  const committedIndexes = new Set(
    lfmResult.items.map((item, index) => item.accepted ? index : -1).filter((index) => index >= 0)
  );
  const committedTimestamped = submissionTimestamped.filter((_item, index) => committedIndexes.has(index));
  const committedPendingKeys = new Set(submissionItems.filter((_item, index) => committedIndexes.has(index)).map(pendingScrobbleKey));
  const submissionSucceeded = committedTimestamped.length === payload.length && lfmResult.errors === 0 && lfmResult.ignored === 0;
  addLogEntry(
    ledger,
    "lastfm_submit_done",
    `Last.fm: ${lfmResult.accepted} accepted \xB7 ${lfmResult.ignored} ignored \xB7 ${lfmResult.errors} errors`,
    submissionSucceeded ? "success" : "error"
  );
  if (!submissionSucceeded) {
    const msg = `lastfm_submit_failed (${lfmResult.errors} errors)`;
    console.error(msg);
    ledger.stats.total_errors += 1;
    ledger.stats.last_error_iso = runTime.toISOString();
    ledger.stats.last_error_message = lfmResult.last_error ?? msg;
    ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
    addLogEntry(ledger, "pending_queue_retained", `Submission failed; retained all ${ledger.pending_scrobbles.length} pending scrobble(s) for the next poll${lfmResult.last_error ? ` · ${lfmResult.last_error}` : ""}`, "error");
    addLogEntry(ledger, "circuit_error_count", `Consecutive errors: ${ledger.consecutive_errors}/${5}`, "warn");
    if (ledger.consecutive_errors >= CB_ERROR_THRESHOLD) {
      openCircuit(ledger, startedAt);
      addLogEntry(ledger, "circuit_tripped", `Circuit breaker tripped after ${CB_ERROR_THRESHOLD} consecutive errors`, "error");
    }
    if (committedPendingKeys.size > 0) {
      ledger.pending_scrobbles = (ledger.pending_scrobbles ?? []).filter((item) => !committedPendingKeys.has(pendingScrobbleKey(item)));
      addLogEntry(ledger, "pending_queue_partial_commit", `Last.fm confirmed ${committedPendingKeys.size} item(s); retained only the failed/ignored entries`, "warn");
    }
  } else {
    ledger.pending_scrobbles = (ledger.pending_scrobbles ?? []).slice(submissionItems.length);
    resetCircuit(ledger);
    ledger.stats.last_error_message = null;
    ledger.stats.last_error_iso = null;
    addLogEntry(ledger, "pending_queue_committed", `Last.fm confirmed ${payload.length} scrobble(s) · ${ledger.pending_scrobbles.length} still pending`, "success");
  }
  if (env.LISTENBRAINZ_TOKEN && committedTimestamped.length > 0) {
    addLogEntry(ledger, "listenbrainz_submit", "Also submitting to ListenBrainz...", "info");
    const lbResult = await submitBatch(committedTimestamped.map(buildLastFmPayload), env.LISTENBRAINZ_TOKEN);
    console.log(
      `ListenBrainz: ${lbResult.accepted} accepted, ${lbResult.errors} errors`
    );
    addLogEntry(ledger, "listenbrainz_done", `ListenBrainz: ${lbResult.accepted} accepted \xB7 ${lbResult.errors} errors`, lbResult.accepted > 0 ? "success" : "info");
  }
  const repeatCount = committedTimestamped.filter((p) => p.kind === "repeat").length;
  await notifySummary(
    env.NOTIFY_WEBHOOK_URL,
    lfmResult.accepted,
    repeatCount,
    lfmResult.ignored
  );
  const oldTotal = ledger.stats.total_scrobbled;
  const newTotal = oldTotal + committedTimestamped.length;
  if (Math.floor(oldTotal / 1e3) < Math.floor(newTotal / 1e3)) {
    const milestone = Math.floor(newTotal / 1e3) * 1e3;
    await notifyMilestone(env.NOTIFY_WEBHOOK_URL, milestone);
  }
  if (committedTimestamped.length > 0) {
    for (const p of committedTimestamped) {
      const trackId = appleHistoryTrackIdentity(p.track);
      if (trackId) recordScrobbled(ledger, trackId, startedAt);
    }
    addRecentScrobbles(ledger, committedTimestamped);
  }
  ledger.previous_recent = nextHistoryBaseline;
  ledger.stats.total_scrobbled = newTotal;
  if (submissionSucceeded) {
    ledger.stats.last_success_iso = runTime.toISOString();
  }
  ledger.last_save_iso = runTime.toISOString();
  addLogEntry(
    ledger,
    "poll_complete",
    `Run done in ${Date.now() - startedAt}ms \u2014 ${lfmResult.accepted} scrobbled, ${ledger.pending_scrobbles?.length ?? 0} pending, ${newTotal} total. Saving KV.`,
    submissionSucceeded ? "success" : "error"
  );
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return {
    ok: submissionSucceeded,
    detected: deduped.length,
    accepted: lfmResult.accepted,
    ignored: lfmResult.ignored,
    errors: lfmResult.errors,
    repeat_count: repeatCount,
    elapsed_ms: Date.now() - startedAt
  };
}
async function getStatus(env) {
  const [ledger, recovery] = await Promise.all([
    loadLedger(env.ASCROBBLE_STATE),
    loadMigrationRecovery(env.ASCROBBLE_STATE)
  ]);
  if (!recovery) return ledger;
  const legacyRecoveryIncluded = ledger.migration_recovery_version === HISTORY_SOURCE_VERSION;
  const baseRecent = (ledger.recent_scrobbles ?? []).filter((entry) => entry.kind !== "recovered");
  const baseLogs = (ledger.log_entries ?? []).filter((entry) => !entry.step.startsWith("migration_recovery"));
  return {
    ...ledger,
    migration_recovery_version: HISTORY_SOURCE_VERSION,
    stats: {
      ...ledger.stats,
      total_scrobbled: ledger.stats.total_scrobbled + (legacyRecoveryIncluded ? 0 : recovery.accepted)
    },
    recent_scrobbles: [...(recovery.recent_scrobbles ?? []), ...baseRecent].slice(0, MAX_RECENT_SCROBBLES),
    log_entries: [...(recovery.log_entries ?? []), ...baseLogs].slice(0, 50)
  };
}
async function resetLedgerStats(env) {
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  ledger.stats.total_errors = 0;
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  ledger.consecutive_errors = 0;
  ledger.circuit_open_until_iso = void 0;
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return ledger;
}
async function updateTokens(env, appleDevToken, appleUserToken) {
  const updated = [];
  if (appleDevToken) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_DEV_TOKEN, appleDevToken);
    updated.push(KV_KEY_APPLE_DEV_TOKEN);
  }
  if (appleUserToken) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_USER_TOKEN, appleUserToken);
    updated.push(KV_KEY_APPLE_USER_TOKEN);
  }
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  resetCircuit(ledger);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  addLogEntry(ledger, "tokens_updated", `Updated KV tokens: ${updated.join(", ")}`, "success");
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ok: true, updated };
}
async function clearCache(env, opts = {}) {
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  if (opts.clear_snapshot !== false) {
    ledger.previous_recent = [];
    ledger.stationary_idle = false;
    ledger.handled_count = 0;
    ledger.position0_elapsed_sec = 0;
    ledger.top_track_id = void 0;
    ledger.top_track_play_count = void 0;
  }
  if (opts.clear_dedup !== false) {
    ledger.recent_scrobble_ids = [];
  }
  if (opts.clear_logs) {
    ledger.log_entries = [];
  }
  if (opts.clear_recent) {
    ledger.recent_scrobbles = [];
  }
  if (opts.clear_circuit !== false) {
    resetCircuit(ledger);
    ledger.stats.last_error_message = null;
    ledger.stats.last_error_iso = null;
  }
  addLogEntry(ledger, "cache_cleared", "Cleared worker state & cache via API", "info");
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ok: true, ledger };
}
async function prepareExactRecoveryTracks(env, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    throw new Error("items_must_be_an_array_with_1_to_20_entries");
  }
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  let [appleDevToken, appleUserToken] = await Promise.all([
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_DEV_TOKEN),
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_USER_TOKEN)
  ]);
  if (!appleDevToken || !appleUserToken) {
    throw new Error("apple_tokens_missing_in_kv");
  }
  if (appleDeveloperTokenNeedsRefresh(appleDevToken)) {
    appleDevToken = await refreshAppleDeveloperToken(env, appleDevToken);
  }
  const now = Date.now();
  const seen = /* @__PURE__ */ new Set();
  const requested = items.map((item) => {
    const trackId = typeof item?.track_id === "string" ? item.track_id.trim() : "";
    const timestamp = new Date(item?.timestamp_iso ?? "");
    if (!trackId || isNaN(timestamp.getTime())) {
      throw new Error("each_item_requires_track_id_and_valid_timestamp_iso");
    }
    if (seen.has(trackId)) throw new Error(`duplicate_recovery_track_id: ${trackId}`);
    seen.add(trackId);
    if (timestamp.getTime() > now + 5 * 60 * 1e3 || timestamp.getTime() < now - 14 * 24 * 60 * 60 * 1e3) {
      throw new Error(`recovery_timestamp_out_of_range: ${trackId}`);
    }
    const source = (ledger.previous_recent ?? []).find((track) => track.id === trackId);
    if (!source) throw new Error(`apple_source_track_not_found: ${trackId}`);
    return { source, timestamp };
  });
  const enriched = [];
  for (const { source } of requested) {
    enriched.push(await enrichTrackForLastFm(
      source,
      appleDevToken,
      appleUserToken,
      env.LASTFM_API_KEY,
      env.ASCROBBLE_STATE,
      env
    ));
  }
  const plays = requested.map(({ timestamp }, index) => ({
    track: enriched[index],
    kind: "replacement",
    timestamp
  }));
  return { ledger, plays };
}
function recoveryPreview(plays) {
  return plays.map((p) => ({
    track_id: p.track.id,
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    album_artist: p.track.album_artist,
    mbid: p.track.mbid,
    identity_source: p.track._identity_source,
    identity_error: p.track._identity_error,
    lastfm_artwork_match: p.track._lastfm_artwork_match === true,
    historical_mapping_reused: p.track._historical_mapping_reused === true,
    native_artist_fallback: p.track._native_artist_fallback === true,
    apple_native_album_exception: p.track._apple_native_album_exception === true,
    isrc: p.track.isrc,
    catalog_id: p.track.catalog_id,
    apple_variants: p.track._apple_variant_diagnostics,
    musicbrainz_identity: p.track._musicbrainz_identity_diagnostics,
    cross_isrc_diagnostics: p.track._cross_isrc_diagnostics,
    timestamp_iso: p.timestamp.toISOString()
  }));
}
async function queueExactRecoveryTracks(env, items, dryRun = false) {
  const { ledger, plays } = await prepareExactRecoveryTracks(env, items);
  const preview = recoveryPreview(plays);
  if (dryRun) return { ok: true, dry_run: true, preview };
  const replacementTimes = new Set(plays.map((p) => p.timestamp.toISOString()));
  const beforeRecent = (ledger.recent_scrobbles ?? []).length;
  ledger.recent_scrobbles = (ledger.recent_scrobbles ?? []).filter(
    (entry) => !replacementTimes.has(entry.timestamp_iso)
  );
  const replacedDashboardEntries = beforeRecent - ledger.recent_scrobbles.length;
  ledger.stats.total_scrobbled = Math.max(
    0,
    (ledger.stats.total_scrobbled ?? 0) - replacedDashboardEntries
  );
  const beforePending = (ledger.pending_scrobbles ?? []).length;
  appendPendingScrobbles(ledger, plays);
  const queued = (ledger.pending_scrobbles ?? []).length - beforePending;
  if (queued !== plays.length) {
    throw new Error(`recovery_queue_conflict: requested=${plays.length}, queued=${queued}`);
  }
  addLogEntry(
    ledger,
    "exact_recovery_queued",
    `Queued ${queued} exact-source replacement scrobble(s); removed ${replacedDashboardEntries} stale dashboard record(s)`,
    "success"
  );
  ledger.last_save_iso = (/* @__PURE__ */ new Date()).toISOString();
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ok: true, dry_run: false, queued, replaced_dashboard_entries: replacedDashboardEntries, preview };
}
async function recoverMigrationTracks(env) {
  const existingRecovery = await loadMigrationRecovery(env.ASCROBBLE_STATE);
  if (existingRecovery) {
    return { ok: true, already_recovered: true, accepted: 0, ignored: 0, errors: 0 };
  }
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  if (ledger.history_source_version !== HISTORY_SOURCE_VERSION || ledger.previous_recent.length < 5) {
    return { ok: false, error: "library_history_not_ready" };
  }
  const recovered = ledger.previous_recent.slice(0, 5).reverse().map((track) => ({
    track,
    kind: "recovered"
  }));
  const migrationTime = ledger.stats.last_success_iso ? new Date(ledger.stats.last_success_iso) : /* @__PURE__ */ new Date();
  const runTime = isNaN(migrationTime.getTime()) ? /* @__PURE__ */ new Date() : migrationTime;
  const timestamped = assignTimestamps(recovered, runTime, null);
  const payload = timestamped.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp: p.timestamp,
    duration_ms: p.track.duration_ms
  }));
  addLogEntry(ledger, "migration_recovery_start", `Recovering ${payload.length} newly visible Apple library plays`, "info");
  const result = await scrobbleBatch(
    payload,
    env.LASTFM_API_KEY,
    env.LASTFM_SHARED_SECRET,
    env.LASTFM_SESSION_KEY
  );
  if (result.errors === 0) {
    await saveMigrationRecovery(
      env.ASCROBBLE_STATE,
      buildMigrationRecovery(ledger, timestamped, result)
    );
  }
  return { ok: result.errors === 0, already_recovered: false, ...result };
}
async function acknowledgeMigrationRecovery(env) {
  const existingRecovery = await loadMigrationRecovery(env.ASCROBBLE_STATE);
  if (existingRecovery) return { ok: true, already_recorded: true };
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  if (ledger.history_source_version !== HISTORY_SOURCE_VERSION || ledger.previous_recent.length < 5) {
    return { ok: false, error: "library_history_not_ready" };
  }
  const recovered = ledger.previous_recent.slice(0, 5).reverse().map((track) => ({ track, kind: "recovered" }));
  const migrationTime = ledger.stats.last_success_iso ? new Date(ledger.stats.last_success_iso) : /* @__PURE__ */ new Date();
  const runTime = isNaN(migrationTime.getTime()) ? /* @__PURE__ */ new Date() : migrationTime;
  const timestamped = assignTimestamps(recovered, runTime, null);
  await saveMigrationRecovery(
    env.ASCROBBLE_STATE,
    buildMigrationRecovery(ledger, timestamped, { accepted: 5, ignored: 0, errors: 0 })
  );
  return { ok: true, already_recorded: false, accepted: 5 };
}
async function pollThroughCoordinator(env, isManual = false, source = "internal") {
  if (!env.SCROBBLE_COORDINATOR) {
    return pollAndScrobble(env, isManual);
  }
  const id = env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator");
  const stub = env.SCROBBLE_COORDINATOR.get(id);
  const response = await stub.fetch(
    `https://coordinator.internal/poll?manual=${isManual ? "1" : "0"}&source=${encodeURIComponent(source)}`,
    { method: "POST" }
  );
  if (!response.ok) {
    throw new Error(`scrobble_coordinator_http_${response.status}: ${await response.text()}`);
  }
  return response.json();
}
async function recoverExactTracksThroughCoordinator(env, items, dryRun = false) {
  if (!env.SCROBBLE_COORDINATOR) {
    const recovery = await queueExactRecoveryTracks(env, items, dryRun);
    if (dryRun) return recovery;
    const run = await pollAndScrobble(env, true);
    return { ...recovery, run };
  }
  const id = env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator");
  const stub = env.SCROBBLE_COORDINATOR.get(id);
  const response = await stub.fetch("https://coordinator.internal/recover-exact-tracks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, dry_run: dryRun })
  });
  if (!response.ok) {
    throw new Error(`exact_recovery_coordinator_http_${response.status}: ${await response.text()}`);
  }
  const recovery = await response.json();
  if (dryRun) return recovery;
  const run = await pollThroughCoordinator(env, true, "exact_recovery");
  return { ...recovery, run };
}
async function getCoordinatorAutomationStatus(env) {
  if (!env.SCROBBLE_COORDINATOR) {
    return { alarm_supported: false, alarm_scheduled: false };
  }
  const id = env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator");
  const stub = env.SCROBBLE_COORDINATOR.get(id);
  const response = await stub.fetch("https://coordinator.internal/automation-status");
  if (!response.ok) {
    throw new Error(`scrobble_coordinator_status_http_${response.status}: ${await response.text()}`);
  }
  return response.json();
}
// Temporary flight recorder: observational only; never changes detection or submission.
var DIAGNOSTIC_UNTIL = Date.parse("2026-09-19T04:15:00Z");
var DIAGNOSTIC_CAPACITY = 2048;
function diagnosticPending(ledger) {
  return { enrichments: (ledger.pending_enrichments ?? []).map(x => ({ track: x.track, timestamp_iso: x.timestamp_iso, kind: x.kind })), scrobbles: structuredClone(ledger.pending_scrobbles ?? []) };
}
function explainHistoryDecision(current, previous) {
  const identities = rows => rows.map(appleHistoryTrackIdentity);
  if (!previous.length) return { branch: "bootstrap", current_ids: identities(current), previous_ids: [] };
  const shift = findShift(current, previous);
  let branch = "fallback", tailShift = null;
  if (shift !== null && shift > 0) branch = "prefix_shift";
  else if (current.length >= 2 && previous.length >= 2 && appleHistoryTrackIdentity(current[0]) === appleHistoryTrackIdentity(previous[0])) {
    tailShift = findShift(current.slice(1), previous.slice(1));
    branch = tailShift !== null && tailShift > 0 ? "top_rebound" : "stationary";
  } else if (current.length && previous.length && appleHistoryTrackIdentity(current[0]) === appleHistoryTrackIdentity(previous[0])) branch = "stationary";
  const movedFrom = branch === "fallback" ? findMoveToFront(current, previous) : null;
  if (movedFrom !== null) branch = "move_to_front";
  const previousIds = new Set(identities(previous));
  return { branch, shift, moved_from: movedFrom, tail_shift: tailShift, matched_suffix_length: shift === null ? null : current.length - shift, fallback_first_overlap: current.findIndex(t => previousIds.has(appleHistoryTrackIdentity(t))), current_ids: identities(current), previous_ids: identities(previous) };
}
async function encodeDiagnostic(value) {
  return new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
async function decodeDiagnostic(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
}
var DO_ALARM_INTERVAL_MS = 3 * 60 * 1e3;
var ScrobbleCoordinator = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
    state.blockConcurrencyWhile(async () => {
      const existingAlarm = await state.storage.getAlarm();
      if (existingAlarm === null) {
        await state.storage.setAlarm(Date.now() + DO_ALARM_INTERVAL_MS);
      }
    });
  }
  enqueue(isManual = false, source = "internal") {
    return this.enqueueJob(() => this.recordedPoll(isManual, source));
  }
  async recordedPoll(isManual, source) {
    if (Date.now() >= DIAGNOSTIC_UNTIL) return pollAndScrobble(this.env, isManual);
    let seq;
    try {
      seq = (await this.state.storage.get("diagnostic:sequence") ?? 0) + 1;
      await this.state.storage.put("diagnostic:sequence", seq);
    } catch { console.error("diagnostic_storage_unavailable"); return pollAndScrobble(this.env, isManual); }
    const trace = { schema: 1, version: "0.3.106", seq, source, manual: isManual, started_at: new Date().toISOString(), stage: "started", apple_pages: [], lastfm_attempts: [] };
    const save = async () => {
      try {
        const bytes = await encodeDiagnostic(trace);
        const slot = String(seq % DIAGNOSTIC_CAPACITY).padStart(4, "0");
        const prefix = `diagnostic:run:${slot}`;
        const parts = Math.ceil(bytes.length / 60000);
        const meta = { seq, started_at: trace.started_at, completed_at: trace.completed_at ?? null, source, stage: trace.stage, branch: trace.decision?.branch ?? null, previous_count: trace.previous?.length ?? null, current_count: trace.current?.length ?? null, detected: trace.detected?.plays?.length ?? 0, after_guards: trace.after_guards?.length ?? 0, accepted: trace.result?.accepted ?? null, parts, bytes: bytes.length };
        await this.state.storage.transaction(async tx => {
          const old = await tx.get(prefix);
          const values = { [prefix]: meta };
          values[`diagnostic:index:${slot}`] = meta;
          for (let i = 0; i < parts; i++) values[`${prefix}:part:${i}`] = bytes.slice(i * 60000, (i + 1) * 60000);
          await tx.put(values);
          for (let i = parts; i < (old?.parts ?? 0); i++) await tx.delete(`${prefix}:part:${i}`);
        });
      } catch { console.error("diagnostic_checkpoint_failed", seq, trace.stage); }
    };
    await save();
    try {
      const result = await pollAndScrobble({ ...this.env, __diagnostic: trace, __saveDiagnostic: save }, isManual);
      trace.result = result;
      trace.stage = "completed";
      return result;
    } catch (error) {
      trace.stage = "threw";
      trace.error_type = error?.name ?? "Error";
      throw error;
    } finally {
      trace.completed_at = new Date().toISOString();
      trace.after = MEMORY_LEDGER_CACHE ? { last_run_iso: MEMORY_LEDGER_CACHE.last_run_iso, last_save_iso: MEMORY_LEDGER_CACHE.last_save_iso, pending: diagnosticPending(MEMORY_LEDGER_CACHE), total_scrobbled: MEMORY_LEDGER_CACHE.stats.total_scrobbled } : null;
      await save();
      console.log("diagnostic_run", JSON.stringify({ seq, source, branch: trace.decision?.branch, previous: trace.previous?.length, current: trace.current?.length, detected: trace.detected?.plays?.length, stage: trace.stage }));
    }
  }
  enqueueJob(task) {
    const job = this.queue.catch(() => void 0).then(task);
    this.queue = job.then(() => void 0, () => void 0);
    return job;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/diagnostics" && request.method === "GET") {
      const seq = Number(url.searchParams.get("seq"));
      if (seq > 0 && Number.isSafeInteger(seq)) {
        const prefix = `diagnostic:run:${String(seq % DIAGNOSTIC_CAPACITY).padStart(4, "0")}`;
        const record = await this.state.storage.transaction(async tx => {
          const meta = await tx.get(prefix);
          if (!meta || meta.seq !== seq) return null;
          const bytes = new Uint8Array(meta.bytes);
          for (let i = 0; i < meta.parts; i++) bytes.set(new Uint8Array(await tx.get(`${prefix}:part:${i}`)), i * 60000);
          return bytes;
        });
        return record ? json(await decodeDiagnostic(record)) : json({ error: "diagnostic_not_retained" }, 404);
      }
      const records = await this.state.storage.list({ prefix: "diagnostic:index:" });
      const runs = [...records.entries()].filter(([k]) => !k.includes(":part:")).map(([,v]) => v).filter(v => v.seq > Number(url.searchParams.get("after") ?? 0)).sort((a,b) => a.seq - b.seq).slice(0, 200);
      return json({ enabled: Date.now() < DIAGNOSTIC_UNTIL, until: new Date(DIAGNOSTIC_UNTIL).toISOString(), capacity: DIAGNOSTIC_CAPACITY, runs, next_after: runs.at(-1)?.seq ?? null });
    }
    if (url.pathname === "/automation-status") {
      const nextAlarm = await this.state.storage.getAlarm();
      const lastAlarmStartedIso = await this.state.storage.get("last_alarm_started_iso") ?? null;
      const lastAlarmCompletedIso = await this.state.storage.get("last_alarm_completed_iso") ?? null;
      return json({
        runtime_version: "0.3.106",
        alarm_supported: true,
        alarm_scheduled: nextAlarm !== null,
        next_alarm_iso: nextAlarm === null ? null : new Date(nextAlarm).toISOString(),
        last_alarm_started_iso: lastAlarmStartedIso,
        last_alarm_completed_iso: lastAlarmCompletedIso,
        interval_seconds: DO_ALARM_INTERVAL_MS / 1e3
      });
    }
    if (url.pathname === "/pending-album-artist-test" && request.method === "POST") {
      const body = await request.json();
      return this.enqueueJob(async () => {
        if (body.album_artist !== "Various Artists") return json({ error: "unsupported_alias" }, 400);
        let ledger = await loadLedger(this.env.ASCROBBLE_STATE);
        if (!(ledger.pending_scrobbles ?? []).some(x => x.track_id === body.track_id && x.timestamp_iso === body.timestamp_iso)) {
          const source = ledger.previous_recent.find(x => x.id === body.track_id || x.catalog_id === body.track_id);
          if (!source) return json({ error: "source_not_retained" }, 409);
          await queueExactRecoveryTracks(this.env, [{ track_id: source.id, timestamp_iso: body.timestamp_iso }], false);
          ledger = await loadLedger(this.env.ASCROBBLE_STATE);
        }
        const matches = (ledger.pending_scrobbles ?? []).filter(x => x.track_id === body.track_id && x.timestamp_iso === body.timestamp_iso);
        if (matches.length !== 1 || matches[0].album_artist !== "群星") return json({ error: "pending_precondition_failed" }, 409);
        matches[0].album_artist = "Various Artists";
        addLogEntry(ledger, "pending_album_artist_alias_test", `Changed album artist only for ${body.track_id} at ${body.timestamp_iso}: 群星 -> Various Artists`, "info");
        await saveLedger(this.env.ASCROBBLE_STATE, ledger);
        const run = await this.recordedPoll(true, "pending_album_artist_alias_test");
        return json({ ok: true, run });
      });
    }
    if (url.pathname === "/recover-exact-tracks" && request.method === "POST") {
      try {
        const body = await request.json();
        const dryRun = body?.dry_run === true;
        const result = await this.enqueueJob(() => queueExactRecoveryTracks(this.env, body?.items, dryRun));
        return json(result, 200);
      } catch (err) {
        console.error("Serialized exact recovery failed:", err);
        return json({ error: String(err) }, 500);
      }
    }
    const isManual = url.searchParams.get("manual") === "1";
    try {
      const result = await this.enqueue(isManual, url.searchParams.get("source") ?? "internal");
      return json(result, 200);
    } catch (err) {
      console.error("Serialized poll failed:", err);
      return json({ error: String(err) }, 500);
    }
  }
  async alarm() {
    await this.state.storage.put("last_alarm_started_iso", new Date().toISOString());
    try {
      await this.enqueue(false, "alarm");
    } catch (err) {
      console.error("Durable Object alarm poll failed:", err);
    } finally {
      await this.state.storage.put("last_alarm_completed_iso", new Date().toISOString());
      await this.state.storage.setAlarm(Date.now() + DO_ALARM_INTERVAL_MS);
    }
  }
};

// src/index.ts
var index_default = {
  async scheduled(_controller, env, _ctx) {
    try {
      await pollThroughCoordinator(env, false, "cron");
    } catch (err) {
      console.error("scheduled() failed:", err);
      throw err;
    }
  },
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-ascrobble-auth, Cache-Control"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }
    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          service: "aScrobble-scrobbler",
          version: "0.3.106",
          cross_isrc_official_release_fallback: true,
          regional_missing_tracks_native_metadata: true,
          verified_single_release_equivalence: true,
          sg_my_taiwan_metadata_priority: true,
          verified_release_track_title_priority: true,
          native_release_track_metadata: true,
          unknown_isrc_native_region_discovery: true,
          independent_native_artist_identity: true,
          musicbrainz_verified_live_classification_conflict: true,
          history_exact_move_to_front: true,
          history_prefix_loss_baseline_retention: true,
          diagnostic_flight_recorder: true,
          diagnostic_until: new Date(DIAGNOSTIC_UNTIL).toISOString(),
          durable_alarm: true,
          apple_developer_token_auto_refresh: true,
          lastfm_artwork_metadata_enrichment: true,
          lastfm_canonical_artist_resolution: true,
          musicbrainz_formal_release_artwork_matching: true,
          lastfm_persistent_retry_queue: true,
          exact_played_release_priority: true,
          authenticated_exact_recovery: true,
          apple_storefront_aware: true,
          apple_isrc_cross_storefront_fallback: true,
          recovery_split_invocation: true,
          musicbrainz_identity_before_lastfm: true,
          musicbrainz_lastfm_release_direct_fallback: true,
          apple_release_evidence_guard: true,
          lastfm_recording_mbid_only: true,
          musicbrainz_confirmed_live_album_alias: true,
          musicbrainz_transient_miss_not_cached: true,
          musicbrainz_positive_cache_migration: true,
          musicbrainz_recording_identity_independent: true,
          spotify_release_gap_trigger: true,
          musicbrainz_release_group_equivalence: true,
          musicbrainz_medium_level_track_evidence: true,
          lastfm_release_group_mbid_guard: true,
          apple_raw_release_title_alias: true,
          apple_native_raw_release_title_priority: true,
          apple_reasonable_release_date_variance: true,
          apple_cross_storefront_release_group_confirmation: true,
          apple_exact_album_isrc_set_equivalence: true,
          apple_exact_catalog_release_localization: true,
          apple_library_play_params_catalog_id: true,
          apple_korean_native_metadata: true,
          apple_isrc_native_storefront_routing: true,
          apple_native_search_release_guard: true,
          apple_regional_track_order_variance: true,
          musicbrainz_isrc_cross_language_identity: true,
          musicbrainz_native_lookup_miss_not_cached: true,
          musicbrainz_native_artist_alias_resolution: true,
          apple_native_metadata_precedes_localized_musicbrainz_titles: true,
          musicbrainz_exact_isrc_release_track_context: true,
          apple_exact_catalog_native_metadata_authority: true,
          apple_album_compilation_metadata: true,
          apple_script_aware_native_storefront_supplement: true,
          apple_exact_release_artist_alias_composition: true,
          conservative_irregular_history_fallback: true,
          implausible_repeat_burst_guard: true,
          lastfm_exact_release_alias_retry: true,
          lastfm_confirmed_release_duration_anomaly_tolerance: true,
          apple_album_artist_relationship: true,
          various_artists_release_mapping: true,
          lastfm_confirmed_compilation_artwork_alias: true,
          canonical_artist_display_override_fujii_kaze: true,
          apple_cjk_tw_native_search_fallback: true,
          apple_cross_isrc_strict_structure_candidate: true,
          apple_native_search_transient_defer: true,
          apple_exact_lookup_before_search: true,
          trusted_native_metadata_optional_lookup_fallback: true,
          apple_native_search_cache: true,
          apple_amp_api_search_fallback: true,
          apple_itunes_search_fallback: true,
          musicbrainz_cross_script_medium_release_confirmation: true,
          lastfm_width_punctuation_release_alias: true,
          apple_library_catalog_identity_dedup: true,
          lastfm_verified_parentheses_alias: true,
          musicbrainz_transient_failure_defers_scrobble: true,
          musicbrainz_not_found_is_definitive: true,
          per_track_enrichment_queue: true,
          spotify_conditional_auxiliary_supported: true,
          spotify_conditional_auxiliary_configured: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET)
        },
        200,
        corsHeaders
      );
    }
    const providedKey = url.searchParams.get("key") ?? request.headers.get("x-ascrobble-auth") ?? "";
    if (!env.STATUS_AUTH_KEY) {
      console.error("STATUS_AUTH_KEY not set in worker environment");
      return json(
        { error: "Worker is misconfigured: STATUS_AUTH_KEY not set" },
        500,
        corsHeaders
      );
    }
    if (providedKey !== env.STATUS_AUTH_KEY) {
      console.warn("Unauthorized request to worker: invalid/missing auth key");
      return json({ error: "unauthorized" }, 401, corsHeaders);
    }
    if (url.pathname === "/diagnostics" && request.method === "GET") {
      if (!env.SCROBBLE_COORDINATOR) return json({ error: "coordinator_unavailable" }, 503, corsHeaders);
      const id = env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator");
      const response = await env.SCROBBLE_COORDINATOR.get(id).fetch(`https://coordinator.internal/diagnostics${url.search}`);
      return json(await response.json(), response.status, corsHeaders);
    }
    if (url.pathname === "/automation-status" && request.method === "GET") {
      try {
        const status = await getCoordinatorAutomationStatus(env);
        return json(status, 200, corsHeaders);
      } catch (err) {
        console.error("/automation-status request failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/status" && request.method === "GET") {
      try {
        // Always return cached state immediately. If Cloudflare Cron has missed
        // several minutes, start a non-blocking fallback poll after responding.
        // This keeps the desktop UI independent of Apple/Last.fm latency while
        // still making the system self-healing when scheduled events are delayed.
        const ledger = await getStatus(env);
        const now = Date.now();
        const lastRunAt = ledger.last_run_iso ? new Date(ledger.last_run_iso).getTime() : 0;
        const isStale = !lastRunAt || now - lastRunAt >= STATUS_FALLBACK_STALE_MS;
        if (isStale && now - LAST_STATUS_FALLBACK_AT >= STATUS_FALLBACK_COOLDOWN_MS) {
          LAST_STATUS_FALLBACK_AT = now;
          _ctx.waitUntil(
            pollThroughCoordinator(env, false, "status_fallback").catch((err) => {
              console.error("Background status fallback poll failed:", err);
            })
          );
        }
        return json(ledger, 200, corsHeaders);
      } catch (err) {
        console.error("/status request failed:", err);
        return json({ error: "failed to fetch status" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/reset-stats" && request.method === "POST") {
      try {
        const ledger = await resetLedgerStats(env);
        return json(ledger, 200, corsHeaders);
      } catch (err) {
        console.error("/reset-stats failed:", err);
        return json({ error: "failed to reset stats" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/clear-cache" && request.method === "POST") {
      try {
        let opts = {};
        if (request.headers.get("Content-Type")?.includes("application/json")) {
          opts = await request.json().catch(() => ({}));
        }
        const res = await clearCache(env, opts);
        return json(res, 200, corsHeaders);
      } catch (err) {
        console.error("/clear-cache failed:", err);
        return json({ error: "failed to clear cache" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/update-tokens" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const res = await updateTokens(
          env,
          body.apple_dev_token,
          body.apple_user_token
        );
        return json(res, 200, corsHeaders);
      } catch (err) {
        console.error("/update-tokens failed:", err);
        return json({ error: "failed to update tokens" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/recover-migration" && request.method === "POST") {
      try {
        const res = await recoverMigrationTracks(env);
        return json(res, res.ok ? 200 : 409, corsHeaders);
      } catch (err) {
        console.error("/recover-migration failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/acknowledge-migration-recovery" && request.method === "POST") {
      try {
        const res = await acknowledgeMigrationRecovery(env);
        return json(res, res.ok ? 200 : 409, corsHeaders);
      } catch (err) {
        console.error("/acknowledge-migration-recovery failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/pending-album-artist-test" && request.method === "POST") {
      const id = env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator");
      return env.SCROBBLE_COORDINATOR.get(id).fetch("https://coordinator.internal/pending-album-artist-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text() });
    }
    if (url.pathname === "/recover-exact-tracks" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const res = await recoverExactTracksThroughCoordinator(
          env,
          body.items,
          body.dry_run === true
        );
        const ok = res.ok === true && (res.dry_run === true || res.run?.ok === true);
        return json(res, ok ? 200 : 503, corsHeaders);
      } catch (err) {
        console.error("/recover-exact-tracks failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        await pollThroughCoordinator(env, true, "manual_trigger");
        const ledger = await getStatus(env);
        return json({ ok: true, triggered: true, ledger }, 200, corsHeaders);
      } catch (err) {
        console.error("/trigger failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }
    return json({ error: "not found" }, 404, corsHeaders);
  }
};
function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      ...corsHeaders
    }
  });
}
export {
  ScrobbleCoordinator,
  index_default as default
};
