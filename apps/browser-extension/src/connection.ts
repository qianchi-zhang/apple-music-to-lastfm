import { parseAppleCredentials } from "../../../packages/contracts/src/apple-credentials";
export function backendOrigin(input: string): string {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port ||
    url.hostname === "music.apple.com"
  )
    throw Error("invalid_backend");
  return url.origin;
}
export function isAppleTab(url: string | undefined): boolean {
  try {
    return new URL(url ?? "").origin === "https://music.apple.com";
  } catch {
    return false;
  }
}
export async function connectApple(
  origin: string,
  key: string,
  value: unknown,
  request: typeof fetch = fetch,
) {
  const target = backendOrigin(origin);
  const credentials = parseAppleCredentials(value);
  if (!credentials) throw Error("tokens_unavailable");
  if (!key.trim() || /[\s\x00-\x1f\x7f]/.test(key) || key.length > 4000)
    throw Error("invalid_key");
  let response: Response;
  try {
    response = await request(target + "/api/v1/connections/apple", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ascrobble-auth": key },
      body: JSON.stringify(credentials),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw Error("network_error");
  }
  if (response.status === 401 || response.status === 403)
    throw Error("invalid_key");
  if (response.status === 404) throw Error("backend_upgrade");
  if (response.status === 429) throw Error("http_429");
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    connected?: boolean;
    verified?: boolean;
    error?: string;
  } | null;
  if (
    response.ok &&
    body?.ok === true &&
    body.connected === true &&
    body.verified === true
  )
    return;
  if (
    typeof body?.error === "string" &&
    [
      "invalid_credentials",
      "apple_rejected",
      "apple_unavailable",
      "apple_invalid_response",
      "save_failed",
    ].includes(body.error)
  )
    throw Error(body.error);
  if (response.status === 502) throw Error("apple_unavailable");
  throw Error("backend_error");
}
export const errors: Record<string, string> = {
  invalid_backend:
    "请输入你自己的 HTTPS 后台网址，例如 https://你的服务.workers.dev，不要包含路径或参数。",
  invalid_key: "管理密钥为空或不正确。请使用你自己后台的管理密钥，然后重试。",
  wrong_tab: "请先打开 Apple Music 网页，登录后在那个标签页点击扩展图标。",
  not_ready: "Apple Music 还没有加载完成。等页面显示音乐内容后，重新点击连接。",
  not_signed_in: "请先在 Apple Music 网页登录你的账号，再回来连接。",
  tokens_unavailable:
    "暂时无法读取 Apple Music 凭据。刷新 Apple Music 页面后重试；仍失败可复制下方诊断代码。",
  permission_denied:
    "没有获得向这个后台发送请求的权限。再次点击连接，并允许访问你填写的后台。",
  network_error:
    "未能确认后台是否已保存。请检查网址和网络后重试；此操作只更新连接，不会重复提交播放。",
  backend_upgrade:
    "这个后台尚未支持连接助手。请更新到包含连接接口的版本后重试。",
  apple_rejected:
    "Apple 未接受这次连接。请在 Apple Music 重新登录，并确认账号可以使用 Apple Music 后再试。",
  apple_unavailable: "Apple 暂时无法完成验证。原连接保持不变，请稍后重试。",
  apple_invalid_response:
    "暂时无法确认 Apple 返回的验证结果。原连接保持不变，请稍后重试。",
  invalid_credentials:
    "Apple Music 连接信息不完整。请在 Apple Music 官网登录后重新连接。",
  http_429: "请求暂时受到限制。请稍后重试，无需重新配置或安装后台。",
  save_failed: "验证成功，但后台保存失败。请稍后重新连接。",
  backend_error: "后台未确认连接成功。请检查后台配置后重试。",
  capture_failed:
    "浏览器未能读取此页面。请在 Apple Music 标签页重新打开扩展再试。",
};
