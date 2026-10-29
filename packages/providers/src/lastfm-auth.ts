import { md5 } from "../../core/src/md5";
import type { JsonStore } from "../../contracts/src/index";
export interface LastfmApp {
  api_key: string;
  shared_secret: string;
}
export interface LastfmConnection {
  api_key: string;
  app_fingerprint: string;
  session_key: string;
  username: string;
  connected_at: string;
}
export const validLastfmKey = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/i.test(value);
// Authorization tokens are opaque: live web callbacks need not be hexadecimal.
export const validLastfmToken = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{32}$/.test(value);
export function parseLastfmApp(value: unknown): LastfmApp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 2 &&
    validLastfmKey(v.api_key) &&
    validLastfmKey(v.shared_secret)
    ? { api_key: v.api_key, shared_secret: v.shared_secret }
    : null;
}
export async function fingerprint(app: LastfmApp): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(app.api_key + ":" + app.shared_secret),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function lastfmApp(
  store: JsonStore | undefined,
  env: { LASTFM_API_KEY?: string; LASTFM_SHARED_SECRET?: string },
): Promise<LastfmApp | null> {
  return (
    (await store?.get<LastfmApp>("lastfm-app:v1")) ??
    parseLastfmApp({
      api_key: env.LASTFM_API_KEY,
      shared_secret: env.LASTFM_SHARED_SECRET,
    })
  );
}
export type ExchangeResult =
  | { ok: true; username: string; session_key: string }
  | {
      ok: false;
      code:
        | "lastfm_unavailable"
        | "lastfm_invalid_application"
        | "lastfm_not_authorized"
        | "lastfm_expired"
        | "lastfm_invalid_response";
    };
export async function exchangeLastfmToken(
  app: LastfmApp,
  token: string,
  request: typeof fetch = fetch,
): Promise<ExchangeResult> {
  if (!validLastfmToken(token)) return { ok: false, code: "lastfm_expired" };
  const params = new URLSearchParams({
    method: "auth.getSession",
    api_key: app.api_key,
    token,
    format: "json",
    api_sig: md5(
      "api_key" +
        app.api_key +
        "methodauth.getSessiontoken" +
        token +
        app.shared_secret,
    ),
  });
  try {
    const res = await request("https://ws.audioscrobbler.com/2.0/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400)
      return { ok: false, code: "lastfm_unavailable" };
    const data = (await res.json()) as {
      error?: number;
      session?: { name?: unknown; key?: unknown };
    };
    console.log("lastfm_exchange_result", {
      status: res.status,
      code: typeof data.error === "number" ? data.error : null,
    });
    if (data.error)
      return {
        ok: false,
        code: [4, 10, 13, 26].includes(data.error)
          ? "lastfm_invalid_application"
          : data.error === 14
            ? "lastfm_not_authorized"
            : data.error === 15
              ? "lastfm_expired"
              : "lastfm_unavailable",
      };
    if (!res.ok) return { ok: false, code: "lastfm_unavailable" };
    if (
      !validLastfmToken(data.session?.key) ||
      typeof data.session?.name !== "string" ||
      !data.session.name.trim() ||
      data.session.name.length > 128 ||
      /[\x00-\x1f\x7f]/.test(data.session.name)
    )
      return { ok: false, code: "lastfm_invalid_response" };
    return {
      ok: true,
      username: data.session.name,
      session_key: data.session.key,
    };
  } catch {
    return { ok: false, code: "lastfm_unavailable" };
  }
}
