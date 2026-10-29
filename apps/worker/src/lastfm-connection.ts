import type { JsonStore, Clock } from "../../../packages/contracts/src/index";
import {
  exchangeLastfmToken,
  fingerprint,
  lastfmApp,
  parseLastfmApp,
  validLastfmToken,
  type LastfmApp,
  type LastfmConnection,
  type ExchangeResult,
} from "../../../packages/providers/src/lastfm-auth";
import { json } from "./application";
interface Transaction {
  state: string;
  browser: string;
  origin: string;
  expires: number;
  fingerprint: string;
  used: boolean;
  mode?: "extension";
  bootstrap?: string;
  bootstrapped?: boolean;
}
const cookieName = "__Host-scrobbler-lastfm";
export const lastfmExtensionRoutes = {
  start: "/api/v1/connections/lastfm/extension/start",
  authorize: "/api/v1/connections/lastfm/extension/authorize",
  result: "/api/v1/connections/lastfm/extension/result",
} as const;
const resultMessages = {
  connected: ["已连接 Last.fm", "回到余音即可继续。此页面可以关闭。"],
  cancelled: ["尚未授权", "回到余音，准备好后可以重新授权 Last.fm。"],
  invalid_flow: ["授权已失效", "回到余音重新授权，请使用最新打开的授权页面。"],
  lastfm_expired: ["授权已过期", "回到余音重新授权 Last.fm。"],
  application_changed: [
    "应用信息已更改",
    "回到余音确认 API Key 和 Shared Secret 后重新授权。",
  ],
  lastfm_unavailable: ["暂时无法连接 Last.fm", "回到余音稍后重试。"],
  lastfm_invalid_application: [
    "Last.fm 应用信息无效",
    "回到余音检查 API Key 和 Shared Secret 后重新授权。",
  ],
  lastfm_not_authorized: [
    "Last.fm 尚未同意授权",
    "回到余音重新授权，并在 Last.fm 页面同意连接。",
  ],
  lastfm_invalid_response: ["Last.fm 返回了无效响应", "回到余音稍后重新授权。"],
  save_failed: ["暂时无法保存连接", "回到余音稍后重新授权。"],
} as const;
type ResultCode = keyof typeof resultMessages;
function extensionResult(code: ResultCode, clear = false) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: lastfmExtensionRoutes.result + "?result=" + code,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...(clear ? { "Set-Cookie": clearBrowserCookie } : {}),
    },
  });
}
const clearBrowserCookie = `${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
function setBrowserCookie(browser: string) {
  return `${cookieName}=${browser}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
}
export function lastfmExtensionResultPage(request: Request) {
  const url = new URL(request.url),
    candidate = url.searchParams.get("result");
  const code: ResultCode =
    url.searchParams.getAll("result").length === 1 &&
    candidate !== null &&
    Object.hasOwn(resultMessages, candidate)
      ? (candidate as ResultCode)
      : "invalid_flow";
  const [title, detail] = resultMessages[code];
  return new Response(
    `<!doctype html><html lang="zh-CN" data-lastfm-result="${code}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 余音</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f}main{max-width:360px;padding:40px;text-align:center}h1{font-size:24px;letter-spacing:-.5px;font-weight:600}p{font-size:15px;line-height:1.6;color:#6e6e73}</style><main><h1>${title}</h1><p>${detail}</p></main></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
export function cookie(request: Request, name: string) {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export class LastfmAuthorization {
  constructor(
    private store: JsonStore,
    private clock: Clock,
    private env: { LASTFM_API_KEY?: string; LASTFM_SHARED_SECRET?: string },
    private exchange: (
      app: LastfmApp,
      token: string,
    ) => Promise<ExchangeResult> = exchangeLastfmToken,
    private beforeConnectionSave?: (
      connection: LastfmConnection,
      previous: LastfmConnection | null,
    ) => Promise<void>,
  ) {}
  async status() {
    const app = await lastfmApp(this.store, this.env);
    const connection = await this.store.get<LastfmConnection>(
      "lastfm-connection:v1",
    );
    const connected = !!(
      app &&
      connection &&
      connection.app_fingerprint === (await fingerprint(app))
    );
    return json({
      apple: { connected: !!(await this.store.get("apple-connection:v1")) },
      lastfm: {
        application_configured: !!app,
        connected,
        ...(connected
          ? {
              username: connection!.username,
              connected_at: connection!.connected_at,
            }
          : {}),
      },
    });
  }
  async configure(request: Request) {
    let candidate: unknown;
    try {
      const text = await request.text();
      if (text.length > 1000)
        return json({ error: "invalid_application" }, 400);
      candidate = JSON.parse(text);
    } catch {
      return json({ error: "invalid_application" }, 400);
    }
    const app = parseLastfmApp(candidate);
    if (!app) return json({ error: "invalid_application" }, 400);
    await this.store.put("lastfm-app:v1", app);
    return json({ ok: true });
  }
  async start(request: Request, mode?: "extension") {
    const app = await lastfmApp(this.store, this.env);
    if (!app) return json({ error: "lastfm_application_missing" }, 409);
    const url = new URL(request.url);
    if (url.protocol !== "https:")
      return json({ error: "https_required" }, 400);
    const state = random(),
      browser = random();
    const tx: Transaction = {
      state,
      browser,
      origin: url.origin,
      expires: this.clock.now() + 600000,
      fingerprint: await fingerprint(app),
      used: false,
      ...(mode === "extension"
        ? { mode, bootstrap: random(), bootstrapped: false }
        : {}),
    };
    // One bounded transaction per independent instance. A newer start invalidates the older flow.
    await this.store.put("lastfm-auth:v1", tx);
    const cb = new URL("/api/v1/connections/lastfm/callback", url.origin);
    cb.searchParams.set("state", state);
    if (mode === "extension") cb.searchParams.set("mode", "extension");
    const auth = new URL("https://www.last.fm/api/auth/");
    auth.searchParams.set("api_key", app.api_key);
    auth.searchParams.set("cb", cb.href);
    if (mode === "extension") {
      const browser = new URL(lastfmExtensionRoutes.authorize, url.origin);
      browser.searchParams.set("flow", tx.bootstrap!);
      // Browser navigation establishes the callback cookie in first-party context.
      // The authenticated fetch never relies on cross-origin Set-Cookie behavior.
      const response = json({
        browser_url: browser.href,
        callback_url: new URL(lastfmExtensionRoutes.result, url.origin).href,
      });
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    const response = json({ authorization_url: auth.href });
    response.headers.set("Set-Cookie", setBrowserCookie(browser));
    return response;
  }
  async authorizeExtension(request: Request) {
    const url = new URL(request.url),
      tx = await this.store.get<Transaction>("lastfm-auth:v1");
    if (
      !tx ||
      tx.mode !== "extension" ||
      tx.used ||
      tx.bootstrapped ||
      tx.expires <= this.clock.now() ||
      tx.origin !== url.origin ||
      url.protocol !== "https:" ||
      url.searchParams.getAll("flow").length !== 1 ||
      tx.bootstrap !== url.searchParams.get("flow")
    )
      return extensionResult("invalid_flow");
    const app = await lastfmApp(this.store, this.env);
    if (!app || tx.fingerprint !== (await fingerprint(app)))
      return extensionResult("application_changed");
    await this.store.put("lastfm-auth:v1", { ...tx, bootstrapped: true });
    const callback = new URL("/api/v1/connections/lastfm/callback", url.origin);
    callback.searchParams.set("state", tx.state);
    callback.searchParams.set("mode", "extension");
    const auth = new URL("https://www.last.fm/api/auth/");
    auth.searchParams.set("api_key", app.api_key);
    auth.searchParams.set("cb", callback.href);
    return new Response(null, {
      status: 303,
      headers: {
        Location: auth.href,
        "Set-Cookie": setBrowserCookie(tx.browser),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  async callback(request: Request) {
    const url = new URL(request.url),
      tx = await this.store.get<Transaction>("lastfm-auth:v1");
    const extension =
      url.searchParams.getAll("mode").length === 1 &&
      url.searchParams.get("mode") === "extension";
    const finish = (code: ResultCode, clear = false) =>
      extension
        ? extensionResult(code, clear)
        : new Response(null, {
            status: 303,
            headers: {
              Location: "/setup?lastfm=" + code,
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              ...(clear
                ? {
                    "Set-Cookie": clearBrowserCookie,
                  }
                : {}),
            },
          });
    if (
      !tx ||
      tx.used ||
      tx.origin !== url.origin ||
      (tx.mode === "extension") !== extension ||
      (extension && !tx.bootstrapped) ||
      tx.expires <= this.clock.now() ||
      url.searchParams.getAll("state").length !== 1 ||
      tx.state !== url.searchParams.get("state") ||
      tx.browser !== cookie(request, cookieName)
    )
      return finish("invalid_flow");
    await this.store.put("lastfm-auth:v1", { ...tx, used: true });
    const token = url.searchParams.get("token");
    console.log("lastfm_callback_shape", {
      count: url.searchParams.getAll("token").length,
      length: token?.length ?? 0,
      valid: validLastfmToken(token),
    });
    if (!token) return finish("cancelled", true);
    if (
      url.searchParams.getAll("token").length !== 1 ||
      !validLastfmToken(token)
    )
      return finish("lastfm_expired", true);
    const app = await lastfmApp(this.store, this.env);
    if (!app || tx.fingerprint !== (await fingerprint(app)))
      return finish("application_changed", true);
    const result = await this.exchange(app, token);
    if (!result.ok) return finish(result.code, true);
    const connection: LastfmConnection = {
      api_key: app.api_key,
      app_fingerprint: tx.fingerprint,
      session_key: result.session_key,
      username: result.username,
      connected_at: new Date(this.clock.now()).toISOString(),
    };
    try {
      await this.beforeConnectionSave?.(
        connection,
        await this.store.get<LastfmConnection>("lastfm-connection:v1"),
      );
      await this.store.put("lastfm-connection:v1", connection);
    } catch {
      return finish("save_failed", true);
    }
    return finish("connected", true);
  }
}
