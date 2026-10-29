// Protocol constants and compatibility defaults from baseline 0.3.49.
export const API_BASE: any = "https://api.music.apple.com/v1";
export const PAGE_SIZE: any = 30;
export const MAX_OFFSET: any = 90;
export const RECENT_TRACK_TYPES: any = "songs,library-songs";
export const HISTORY_SOURCE_VERSION: any = 2;
export const MIGRATION_RECOVERY_KEY: any = `migration-recovery:v${HISTORY_SOURCE_VERSION}`;
export const STATUS_FALLBACK_STALE_MS: any = 3 * 60 * 1e3;
export const STATUS_FALLBACK_COOLDOWN_MS: any = 90 * 1e3;
export const LAST_STATUS_FALLBACK_AT: any = 0;
export const TokenExpiredError: any = class extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. Re-open the aScrobble desktop app to re-authenticate with Apple Music.",
    );
    this.name = "TokenExpiredError";
  }
};
export const SPOOFED_HEADERS: any = {
  Origin: "https://music.apple.com",
  Referer: "https://music.apple.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
};
export const APPLE_TOKEN_REFRESH_AHEAD_MS: any = 7 * 24 * 60 * 60 * 1e3;
export const APPLE_TOKEN_REFRESH_CHECK_COOLDOWN_MS: any = 6 * 60 * 60 * 1e3;
export const KV_KEY_APPLE_DEV_TOKEN_REFRESH_CHECKED: any =
  "apple_dev_token_refresh_checked_iso";
export const DEFAULT_DURATION_MS: any = 18e4;
export const HEAD_OFFSET_SECONDS: any = 10;
export const API_URL: any = "https://ws.audioscrobbler.com/2.0/";
export const BATCH_SIZE: any = 50;
export const LASTFM_PLACEHOLDER_IMAGE_HASH: any =
  "2a96cbd8b46e442fc41c2b86b821562f";
export const MUSICBRAINZ_VARIOUS_ARTISTS_MBID: any =
  "89ad4ac3-39f7-470e-963a-56509c546377";
export const MUSICBRAINZ_API: any = "https://musicbrainz.org/ws/2";
export const MUSICBRAINZ_NOT_FOUND: any = { not_found: true };
export const MUSICBRAINZ_REQUEST_GAP_MS: any = 1100;
export const FORMAL_RELEASE_CACHE_VERSION: any = 3;
export const FORMAL_RELEASE_MATCH_CACHE_MS: any = 180 * 24 * 60 * 60 * 1e3;
export const FORMAL_RELEASE_MISS_CACHE_MS: any = 7 * 24 * 60 * 60 * 1e3;
export const LASTFM_CANONICAL_ARTIST_CACHE_VERSION: any = 1;
export const LASTFM_CANONICAL_ARTIST_CACHE_MS: any = 30 * 24 * 60 * 60 * 1e3;
export const APPLE_STOREFRONT_CACHE_KEY: any = "apple-user-storefront:v1";
export const APPLE_STOREFRONT_CACHE_MS: any = 30 * 24 * 60 * 60 * 1e3;
export const APPLE_NATIVE_REGION_BY_ISRC: any = {
  TW: ["tw", "zh-Hant-TW"],
  HK: ["hk", "zh-Hant-HK"],
  MO: ["mo", "zh-Hant-MO"],
  CN: ["cn", "zh-Hans-CN"],
  JP: ["jp", "ja-JP"],
  KR: ["kr", "ko-KR"],
  US: ["us", "en-US"],
  GB: ["gb", "en-GB"],
  IE: ["ie", "en-IE"],
  CA: ["ca", "en-CA"],
  AU: ["au", "en-AU"],
  NZ: ["nz", "en-NZ"],
  FR: ["fr", "fr-FR"],
  DE: ["de", "de-DE"],
  AT: ["at", "de-AT"],
  IT: ["it", "it-IT"],
  ES: ["es", "es-ES"],
  MX: ["mx", "es-MX"],
  AR: ["ar", "es-AR"],
  CL: ["cl", "es-CL"],
  CO: ["co", "es-CO"],
  PT: ["pt", "pt-PT"],
  BR: ["br", "pt-BR"],
  NL: ["nl", "nl-NL"],
  BE: ["be", "nl-BE"],
  SE: ["se", "sv-SE"],
  NO: ["no", "nb-NO"],
  DK: ["dk", "da-DK"],
  FI: ["fi", "fi-FI"],
  IS: ["is", "is-IS"],
  PL: ["pl", "pl-PL"],
  CZ: ["cz", "cs-CZ"],
  SK: ["sk", "sk-SK"],
  HU: ["hu", "hu-HU"],
  RO: ["ro", "ro-RO"],
  GR: ["gr", "el-GR"],
  TR: ["tr", "tr-TR"],
  RU: ["ru", "ru-RU"],
  UA: ["ua", "uk-UA"],
  IL: ["il", "he-IL"],
  TH: ["th", "th-TH"],
  VN: ["vn", "vi-VN"],
  ID: ["id", "id-ID"],
};
export const TRADITIONAL_CHINESE_SIGNAL: any =
  /[愛戀夢飛紀錄臺灣與為來開關學樂說話這個們長時會還讓裡麼後發現實際應該專輯體風雲點種樣萬無氣聲頭從經過將進覺藝鄉廣傷]/u;
export const MUSICBRAINZ_IDENTITY_CACHE_VERSION: any = 16;
export const MUSICBRAINZ_IDENTITY_MATCH_CACHE_MS: any =
  180 * 24 * 60 * 60 * 1e3;
export const MUSICBRAINZ_IDENTITY_MISS_CACHE_MS: any = 24 * 60 * 60 * 1e3;
export const API_URL2: any = "https://api.listenbrainz.org/1/submit-listens";
export const BATCH_SIZE2: any = 100;
export const LEDGER_KEY: any = "ledger:v1";
export const KV_KEY_APPLE_DEV_TOKEN: any = "apple_dev_token";
export const KV_KEY_APPLE_USER_TOKEN: any = "apple_user_token";
