import { expect, it } from "vitest";
import {
  ServiceError,
  toUiError,
  type UiError,
} from "../apps/browser-extension/src/extension-errors";
import { CloudflareError } from "../apps/browser-extension/src/cloudflare";

it.each<[string, UiError["recovery"]]>([
  ["not_signed_in", "apple"],
  ["not_ready", "apple"],
  ["tokens_unavailable", "apple"],
  ["capture_failed", "apple"],
  ["apple_tab_missing", "apple"],
  ["wrong_tab", "apple"],
  ["apple_tabs", "apple"],
  ["cloud_token", "cloud"],
  ["deployment_origin_changed", "cloud"],
  ["install_busy", "cloud"],
  ["install_conflict", "settings"],
  ["missing_asset", "settings"],
  ["clipboard_unavailable", "retry-copy"],
  ["invalid_response", "refresh"],
  ["backend_unavailable", "refresh"],
  ["backend_update_required", "backend_update"],
  ["backend_upgrade_required", "backend_update"],
  ["backend_update_pending", "refresh"],
  ["backend_update_missing", "settings"],
  ["backend_update_conflict", "settings"],
  ["backend_update_invalid", "backend_update"],
  ["account_changed", "refresh"],
  ["connections_required", "apple"],
  ["invalid_application", "lastfm"],
  ["lastfm_application_missing", "lastfm"],
  ["cancelled", "lastfm"],
  ["invalid_flow", "lastfm"],
  ["lastfm_expired", "lastfm"],
  ["application_changed", "lastfm"],
  ["lastfm_unavailable", "lastfm"],
  ["lastfm_invalid_application", "lastfm"],
  ["lastfm_not_authorized", "lastfm"],
  ["lastfm_invalid_response", "lastfm"],
  ["save_failed", "lastfm"],
  ["lastfm_not_connected", "lastfm"],
  ["invalid_credentials", "apple"],
  ["apple_rejected", "apple"],
  ["apple_unavailable", "apple"],
  ["apple_invalid_response", "apple"],
  ["unauthorized", "settings"],
  ["invalid_key", "settings"],
  ["permission_denied", "refresh"],
  ["version_mismatch", "settings"],
  ["http_429", "retry"],
])("provides a fixed recovery action for %s", (code, recovery) => {
  const result = toUiError(new ServiceError(code));
  expect(result.recovery).toBe(recovery);
  expect(result.title).toBeTruthy();
  expect(result.detail).toBeTruthy();
  expect(result.action).toBeTruthy();
});

it("keeps upgrade recovery on the existing backend and requires original account verification", () => {
  const result = toUiError(new ServiceError("backend_update_required"));
  expect(result.recovery).toBe("backend_update");
  expect(result.detail).toContain("原部署账户");
  expect(result.detail).toContain("更新现有后台");
  expect(result.detail).toContain("已有连接和记录会保留");
});

it.each([
  "cancelled",
  "invalid_flow",
  "lastfm_expired",
  "application_changed",
  "lastfm_unavailable",
  "lastfm_invalid_application",
  "lastfm_not_authorized",
  "lastfm_invalid_response",
  "save_failed",
  "lastfm_not_connected",
])(
  "gives an actionable Last.fm recovery for %s without exposing callback text",
  (code) => {
    const error = new ServiceError(code);
    error.message = "Bearer synthetic-secret ?token=private-authorization";
    const result = toUiError(error);
    expect(result.recovery).toBe("lastfm");
    expect(result).toEqual(toUiError(new ServiceError(code)));
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|private-authorization|管理钥匙|复制钥匙|连接成功/,
    );
  },
);

it("keeps unconfirmed callback success distinct from a verified Last.fm connection", () => {
  const result = toUiError(new ServiceError("lastfm_not_connected"));
  expect(result.title).toBe("Last.fm 连接尚未确认");
  expect(result.detail).toContain("尚未确认有效的账户连接");
  expect(toUiError(new ServiceError("connected")).title).toBe(
    "暂时无法完成操作",
  );
});

it.each([
  ["update_http", 403, "Cloudflare 拒绝了后台更新请求", "backend_update"],
  ["update_http", 503, "Cloudflare 后台更新请求失败", "backend_update"],
  ["update_platform", 200, "Cloudflare 未完成后台更新", "backend_update"],
  ["update_invalid", 200, "后台更新结果尚未确认", "refresh"],
] as const)(
  "provides precise %s update diagnostics for HTTP %s",
  (code, status, title, recovery) => {
    const error = new CloudflareError(code, status, [10057]);
    error.message = "synthetic-secret-upstream";
    const result = toUiError(error);
    expect(result.title).toBe(title);
    expect(result.recovery).toBe(recovery);
    expect(result.detail).toContain("HTTP " + status);
    expect(result.detail).toContain("Cloudflare 代码 10057");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  },
);

it("asks users to check both music accounts for missing connections", () => {
  const result = toUiError(new ServiceError("connections_required"));
  expect(result.detail).toContain("Apple Music");
  expect(result.detail).toContain("Last.fm");
});

it("guides users to one Apple tab without referencing nonexistent diagnostics", () => {
  const tabs = toUiError(new ServiceError("apple_tabs"));
  expect(tabs.detail).toContain("只保留一个官网标签页");
  expect(tabs.detail).toContain("music.apple.com");
  for (const code of [
    "not_signed_in",
    "not_ready",
    "tokens_unavailable",
    "capture_failed",
    "apple_tab_missing",
    "wrong_tab",
    "apple_tabs",
  ])
    expect(JSON.stringify(toUiError(new ServiceError(code)))).not.toContain(
      "下方诊断",
    );
});

it("distinguishes a missing Apple page from multiple tabs and a page that navigated away", () => {
  const missing = toUiError(new ServiceError("apple_tab_missing"));
  const multiple = toUiError(new ServiceError("apple_tabs"));
  const moved = toUiError(new ServiceError("wrong_tab"));
  expect(missing.title).toBe("请先打开 Apple Music");
  expect(missing.detail).toContain("没有找到 Apple Music 官网标签页");
  expect(missing.detail).toContain("同一 Chrome");
  expect(missing.detail).toContain("重新连接");
  expect(missing.openAppleMusic).toBe(true);
  expect(multiple.detail).toContain("只保留一个");
  expect(multiple.openAppleMusic).toBeUndefined();
  expect(moved.detail).toContain("已离开 Apple Music 官网");
  expect(moved.openAppleMusic).toBe(true);
  expect(new Set([missing.title, multiple.title, moved.title]).size).toBe(3);
});

it("explains the actual Cloudflare, backend, and Apple host permission contexts", () => {
  const result = toUiError(new ServiceError("permission_denied"));
  expect(result.detail).toContain("Cloudflare API");
  expect(result.detail).toContain("个人后台网址");
  expect(result.detail).toContain("Apple Music 官网");
  expect(result.detail).toContain("重新点击连接");
});

it("revalidates a changed deployment origin before requesting the exact new host", () => {
  const result = toUiError(new ServiceError("deployment_origin_changed"));
  expect(result.title).toContain("网址已变化");
  expect(result.detail).toContain("重新验证 Token");
  expect(result.detail).toContain("对应网址的访问权限");
  expect(result.recovery).toBe("cloud");
});

it("does not claim a clipboard copy succeeded when the browser refused it", () => {
  const result = toUiError(new ServiceError("clipboard_unavailable"));
  expect(result.title).toContain("未允许复制");
  expect(result.detail).toContain("未能");
  expect(result.action).toBe("重试复制");
  expect(JSON.stringify(result)).not.toContain("已复制");
});

it("explains that another installation page must finish before continuing", () => {
  expect(toUiError(new ServiceError("install_busy")).detail).toContain(
    "等待另一个页面完成",
  );
  expect(toUiError(new ServiceError("missing_asset")).detail).toContain(
    "完整扩展安装包",
  );
});

it("keeps malformed responses uncertain until status has been checked", () => {
  const result = toUiError(new ServiceError("invalid_response"));
  expect(result.detail).toContain("操作结果尚未确认");
  expect(result.recovery).toBe("refresh");
});

it("keeps a temporarily unavailable backend separate from a version mismatch", () => {
  const result = toUiError(new ServiceError("backend_unavailable", 503));
  expect(result.title).toBe("个人后台暂时不可用");
  expect(result.recovery).toBe("refresh");
  expect(result.detail).toContain("保留现有安装和连接");
  expect(result.detail).toContain("不要重复安装");
  expect(JSON.stringify(result)).not.toMatch(/版本|升级|钥匙无效/);
});

it.each(["apple_unavailable", "apple_invalid_response"])(
  "preserves the Apple connection when %s can be retried",
  (code) => {
    const result = toUiError(new ServiceError(code, 502));
    expect(result.recovery).toBe("apple");
    expect(result.detail).toContain("保留现有连接");
    expect(result.detail).toContain("稍后重试");
    expect(JSON.stringify(result)).not.toMatch(
      /已过期|未接受|重新登录|连接成功/,
    );
    if (code === "apple_invalid_response") {
      expect(result.detail).toContain("信息不完整");
      expect(result.detail).toContain("暂时无法确认连接状态");
      expect(result.detail).toContain("仍失败时再重新连接");
    }
  },
);

it.each(["backend_unavailable", "apple_unavailable", "apple_invalid_response"])(
  "never includes upstream details in the fixed %s message",
  (code) => {
    const error = new ServiceError(code, 503);
    error.message = "Bearer synthetic-secret <script>upstream failure</script>";
    const result = toUiError(error);
    expect(result).toEqual(toUiError(new ServiceError(code)));
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|Bearer|<script>|upstream failure/,
    );
  },
);

it.each(["AbortError", "TimeoutError", "TypeError"])(
  "does not claim completion after %s",
  (name) => {
    const error =
      name === "TypeError"
        ? new TypeError("synthetic-secret")
        : new Error("synthetic-secret");
    error.name = name;
    const result = toUiError(error);
    expect(result.title).toContain("结果未确认");
    expect(result.recovery).toBe("refresh");
    expect(result.action).toContain("先检查");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(result.detail).not.toContain("保存成功");
  },
);

it.each([
  "synthetic-secret",
  new Error("Bearer synthetic-secret"),
  new ServiceError("unknown_synthetic-secret", 500),
  new ServiceError("__proto__"),
  new Error("toString"),
  { message: "synthetic-secret", token: "synthetic-secret" },
  null,
  undefined,
])("never displays arbitrary exception content", (error) => {
  const result = toUiError(error);
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  expect(result.recovery).toBe("refresh");
  expect(result.title).toBe("暂时无法完成操作");
});

it.each([
  "请填写完整的 Cloudflare API Token。",
  "未找到可用账户，请检查 Token 的 Account Settings 读取权限。",
  "账户过多，请把 Token 限制到要部署的一个账户后重试。",
  "Cloudflare 操作失败（HTTP 403）。synthetic-secret",
])(
  "guides Cloudflare credential failures to their configuration",
  (message) => {
    const result = toUiError(new Error(message));
    expect(result.recovery).toBe("cloud");
    expect(result.detail).toContain("Account Settings");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  },
);

it("maps Cloudflare rate limits to retry rather than credential changes", () => {
  const result = toUiError(
    new Error(
      "Cloudflare 操作失败（HTTP 429）。请检查 Token 的账户范围及 Workers Scripts、Workers KV Storage 权限，然后重试。",
    ),
  );
  expect(result.recovery).toBe("retry");
  expect(result.detail).toContain("无需更改账户配置");
  expect(toUiError(new ServiceError("other", 429))).toEqual(result);
});

it("explains workers.dev setup before resuming the original installation", () => {
  const result = toUiError(
    new Error(
      "请先在 Cloudflare 的 Workers & Pages 设置 workers.dev 子域名，再回来重试。",
    ),
  );
  expect(result.recovery).toBe("cloud");
  expect(result.detail).toContain("继续原安装");
});

it.each([
  "同名服务不属于此次安装，已停止，未覆盖现有服务。",
  "存储状态不一致，未创建或覆盖数据。请检查该账户的 KV。",
  "已有服务的存储缺失，已停止以保护数据。",
  "保存的安装信息无效，未修改云端资源。",
])(
  "protects existing resources when installation metadata conflicts",
  (message) => {
    const result = toUiError(new Error(message));
    expect(result.recovery).toBe("settings");
    expect(result.detail).toContain("不要删除存储或重新部署");
  },
);

it("returns independent message objects so consumers cannot alter the whitelist", () => {
  const result = toUiError(new ServiceError("invalid_key"));
  result.detail = "synthetic-secret";
  expect(toUiError(new ServiceError("invalid_key")).detail).not.toBe(
    "synthetic-secret",
  );
});

it("distinguishes Token format, denied account access, and an empty account list", () => {
  const format = toUiError(new CloudflareError("token_format"));
  const denied = toUiError(new CloudflareError("accounts_http", 403, [9109]));
  const empty = toUiError(new CloudflareError("accounts_empty"));
  expect(new Set([format.title, denied.title, empty.title]).size).toBe(3);
  expect(format.title).toBe("API Token 格式不完整");
  expect(format.detail).toContain("完整 Token 值");
  expect(denied.title).toBe("Token 已验证，但无权读取账户");
  expect(denied.detail).toContain("Token 有效性检查已通过");
  expect(denied.detail).toContain("Account Settings");
  expect(denied.detail).toContain("HTTP 403");
  expect(denied.detail).toContain("Cloudflare 代码 9109");
  expect(empty.title).toBe("Token 没有可用的部署账户");
  expect(empty.detail).toContain("没有返回可用账户");
  for (const result of [format, denied, empty])
    expect(result.recovery).toBe("cloud");
});

it("distinguishes a platform-declared account error from an HTTP rejection", () => {
  const result = toUiError(
    new CloudflareError("accounts_platform", 200, [10000]),
  );
  expect(result.title).toBe("Cloudflare 未接受账户查询");
  expect(result.detail).toContain("Token 有效性检查已通过");
  expect(result.detail).toContain("HTTP 200");
  expect(result.detail).toContain("Cloudflare 代码 10000");
  expect(result.recovery).toBe("cloud");
});

it("keeps temporary account-read failures separate from invalid Token claims", () => {
  const unavailable = toUiError(new CloudflareError("accounts_http", 503));
  expect(unavailable.title).toBe("Cloudflare 账户读取失败");
  expect(unavailable.detail).toContain("HTTP 503");
  expect(unavailable.detail).not.toMatch(/被拒绝|权限不足|Token 无效/);
  const invalid = toUiError(new CloudflareError("accounts_invalid", 200));
  expect(invalid.title).toBe("Cloudflare 账户响应无法读取");
  expect(invalid.detail).toContain("暂时无法确认");
});

it("never displays arbitrary Cloudflare exception text or unsafe diagnostics", () => {
  const error = new CloudflareError("accounts_http", 403, [9109]);
  Object.assign(error, {
    message:
      "Bearer synthetic-secret https://private.test/ <script>upstream</script>",
    status: "403 synthetic-secret",
    errorCodes: [9109, "9109 synthetic-secret", -1, 1.5, {}, Infinity],
    token: "synthetic-secret",
    body: { secret: "synthetic-secret" },
  });
  const result = toUiError(error);
  const rendered = JSON.stringify(result);
  expect(rendered).toContain("Cloudflare 代码 9109");
  expect(rendered).not.toContain("HTTP");
  expect(rendered).not.toMatch(
    /synthetic-secret|Bearer|private\.test|<script>|upstream|Infinity|1\.5/,
  );
});

it("retains safe recovery for install errors and rate limits", () => {
  expect(toUiError(new CloudflareError("install_http", 403))).toMatchObject({
    title: "Cloudflare 拒绝了后台安装请求",
    recovery: "cloud",
  });
  for (const code of ["token_http", "accounts_http", "install_http"] as const)
    expect(toUiError(new CloudflareError(code, 429))).toEqual(
      toUiError(new ServiceError("http_429")),
    );
});

it.each([
  ["token_expired", "Cloudflare Token 已过期", "已过期"],
  ["token_disabled", "Cloudflare Token 已停用", "已停用"],
  ["token_http", "Cloudflare 未接受此 Token", "尚未进入账户权限检查"],
  ["token_platform", "Cloudflare 未通过 Token 验证", "尚未进入账户查询"],
  ["token_invalid", "暂时无法确认 Token 状态", "尚未进入账户查询"],
] as const)(
  "provides a fixed Token-verification explanation for %s",
  (code, title, detail) => {
    const error = new CloudflareError(code, 403, [10000]);
    error.message =
      "Bearer synthetic-secret https://private.test/ upstream-message";
    const result = toUiError(error);
    expect(result.title).toBe(title);
    expect(result.detail).toContain(detail);
    expect(result.recovery).toBe("cloud");
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|private\.test|upstream-message/,
    );
    if (["token_http", "token_platform", "token_invalid"].includes(code)) {
      expect(result.detail).toContain("HTTP 403");
      expect(result.detail).toContain("Cloudflare 代码 10000");
    }
  },
);

it("does not call a temporary Token-verification HTTP failure an invalid Token", () => {
  const result = toUiError(new CloudflareError("token_http", 503));
  expect(result.title).toBe("Cloudflare Token 检查暂时失败");
  expect(result.detail).toContain("当前没有开始安装后台");
  expect(result.detail).toContain("HTTP 503");
  expect(result.detail).not.toMatch(/已撤销|已过期|无效/);
});

it.each([
  ["install_http", "Cloudflare 后台安装请求失败", "cloud"],
  ["install_platform", "Cloudflare 未完成后台安装", "cloud"],
  ["install_invalid", "后台安装结果尚未确认", "refresh"],
] as const)(
  "shows safe numeric installation diagnostics for %s",
  (code, title, recovery) => {
    const error = new CloudflareError(code, 400, [10021]);
    Object.assign(error, {
      message: "Bearer synthetic-secret https://private.test/ upstream-message",
      token: "synthetic-secret",
      body: { secret: "synthetic-secret" },
    });
    const result = toUiError(error);
    expect(result.title).toBe(title);
    expect(result.recovery).toBe(recovery);
    expect(result.detail).toContain("HTTP 400");
    expect(result.detail).toContain("Cloudflare 代码 10021");
    expect(result.detail).toContain("本次安装信息");
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|private\.test|upstream-message/,
    );
  },
);
