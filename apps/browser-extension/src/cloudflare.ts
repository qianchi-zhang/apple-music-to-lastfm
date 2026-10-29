import { algorithmVersion, previousAlgorithm } from "./algorithm-release";

/** Fixed-origin API client. Tokens stay in the calling page's memory. */
export interface InstallState {
  account: string;
  name: string;
  marker: string;
  key: string;
  namespace?: string;
  origin?: string;
}
const id = /^[a-f0-9]{32}$/;
const accountsPath = "/accounts?per_page=50&page=1";
const tokenVerifyPath = "/user/tokens/verify";
export const missingWorkersSubdomain =
  "请先在 Cloudflare 的 Workers & Pages 设置 workers.dev 子域名，再回来重试。";
type CloudflareErrorCode =
  | "token_format"
  | "token_http"
  | "token_platform"
  | "token_invalid"
  | "token_expired"
  | "token_disabled"
  | "accounts_http"
  | "accounts_platform"
  | "accounts_empty"
  | "accounts_invalid"
  | "accounts_limit"
  | "install_http"
  | "install_platform"
  | "install_invalid"
  | "update_http"
  | "update_platform"
  | "update_invalid";

/** Diagnostics contain only local categories and bounded numeric metadata. */
export class CloudflareError extends Error {
  readonly status?: number;
  readonly errorCodes: number[];
  constructor(
    readonly code: CloudflareErrorCode,
    status?: unknown,
    errorCodes?: unknown,
  ) {
    super(code);
    this.name = "CloudflareError";
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    )
      this.status = status;
    this.errorCodes = Array.isArray(errorCodes)
      ? [
          ...new Set(
            errorCodes.filter(
              (value): value is number =>
                typeof value === "number" &&
                Number.isInteger(value) &&
                value >= 0 &&
                value <= 99999999,
            ),
          ),
        ].slice(0, 5)
      : [];
  }
}
export function validateInstall(s: InstallState): InstallState {
  if (
    !s ||
    !id.test(s.account) ||
    !/^ams-[a-f0-9]{24}$/.test(s.name) ||
    !/^[a-f0-9]{32}$/.test(s.marker) ||
    !/^[a-f0-9]{64}$/.test(s.key) ||
    (s.namespace && !id.test(s.namespace)) ||
    (s.origin &&
      !new RegExp("^https://" + s.name + "\\.[a-z0-9-]+\\.workers\\.dev$").test(
        s.origin,
      ))
  )
    throw Error("保存的安装信息无效，未修改云端资源。");
  return s;
}
export class Cloudflare {
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(token))
      throw new CloudflareError("token_format");
  }
  async call(
    path: string,
    method = "GET",
    body?: unknown,
    missing = false,
    operation: "install" | "update" = "install",
  ): Promise<any> {
    if (!/^\/(accounts|user)\//.test(path) && path !== accountsPath)
      throw Error("无效的 Cloudflare 请求。");
    // Window.fetch must not receive the Cloudflare instance as its receiver.
    const request = this.request;
    const response = await request(
      "https://api.cloudflare.com/client/v4" + path,
      {
        method,
        headers: {
          Authorization: "Bearer " + this.token,
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(60000),
      },
    );
    if (missing && response.status === 404) return null;
    const data = (await response.json().catch(() => null)) as any;
    const scope =
      path === tokenVerifyPath
        ? "token"
        : path === accountsPath
          ? "accounts"
          : operation;
    // Never retain upstream text, headers, request destinations or bodies.
    const errorCodes = Array.isArray(data?.errors)
      ? data.errors.map((error: any) => error?.code)
      : [];
    if (!response.ok)
      throw new CloudflareError(`${scope}_http`, response.status, errorCodes);
    if (data?.success === false)
      throw new CloudflareError(
        `${scope}_platform`,
        response.status,
        errorCodes,
      );
    if (data?.success !== true)
      throw new CloudflareError(`${scope}_invalid`, response.status);
    return data.result;
  }
  private async verifyToken(): Promise<void> {
    const result = await this.call(tokenVerifyPath);
    if (result?.status === "expired")
      throw new CloudflareError("token_expired");
    if (result?.status === "disabled")
      throw new CloudflareError("token_disabled");
    if (result?.status !== "active") throw new CloudflareError("token_invalid");
  }
  async accounts(): Promise<{ id: string; name: string }[]> {
    await this.verifyToken();
    const result = await this.call(accountsPath);
    if (Array.isArray(result) && !result.length)
      throw new CloudflareError("accounts_empty");
    if (
      !Array.isArray(result) ||
      result.some((a) => !a || typeof a !== "object" || !id.test(a.id))
    )
      throw new CloudflareError("accounts_invalid");
    if (result.length >= 50) throw new CloudflareError("accounts_limit");
    return result;
  }
  /** Read-only preparation lets the next click request only its exact host. */
  async subdomain(account: string): Promise<string> {
    if (!id.test(account)) throw new CloudflareError("accounts_invalid");
    const domain = await this.call(
      "/accounts/" + account + "/workers/subdomain",
    );
    if (!domain || !/^[a-z0-9-]+$/.test(domain.subdomain))
      throw Error(missingWorkersSubdomain);
    return domain.subdomain;
  }
  /** Code-only update of the installation this extension already owns. */
  async update(
    input: InstallState,
    script: string,
    progress: (text: string) => void,
  ): Promise<void> {
    const s = validateInstall({ ...input });
    if (!s.namespace || !s.origin) throw Error("backend_update_missing");
    if (!script.trim()) throw Error("missing_asset");
    const path = "/accounts/" + s.account + "/workers/scripts/" + s.name;
    progress("1 / 2 · 核对现有个人后台和存储");
    const settings = await this.call(
      path + "/settings",
      "GET",
      undefined,
      true,
      "update",
    );
    if (!settings) throw Error("backend_update_missing");
    const bindings = settings.bindings;
    if (
      !Array.isArray(bindings) ||
      bindings.some(
        (binding) =>
          !binding ||
          typeof binding.name !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(binding.name) ||
          typeof binding.type !== "string" ||
          !binding.type,
      ) ||
      new Set(bindings.map((binding) => binding.name)).size !== bindings.length
    )
      throw Error("backend_update_invalid");
    const binding = (name: string) =>
      bindings.find((item) => item.name === name);
    const ownedText = (name: string, text: string) =>
      binding(name)?.type === "plain_text" && binding(name)?.text === text;
    const kv = binding("ASCROBBLE_STATE");
    const coordinator = binding("SCROBBLE_COORDINATOR");
    if (
      !ownedText("INSTALLATION_ID", s.marker) ||
      !(
        ownedText("INSTALLER_ALGORITHM", algorithmVersion) ||
        ownedText("INSTALLER_ALGORITHM", previousAlgorithm.version)
      ) ||
      !ownedText("DEPLOYMENT_ACCOUNT_ID", s.account) ||
      !ownedText("DEPLOYMENT_WORKER_NAME", s.name) ||
      binding("STATUS_AUTH_KEY")?.type !== "secret_text" ||
      kv?.type !== "kv_namespace" ||
      kv.namespace_id !== s.namespace ||
      coordinator?.type !== "durable_object_namespace" ||
      coordinator.class_name !== "ScrobbleCoordinator" ||
      typeof coordinator.namespace_id !== "string" ||
      !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(
        coordinator.namespace_id,
      ) ||
      (coordinator.script_name !== undefined &&
        coordinator.script_name !== s.name) ||
      (coordinator.environment !== undefined &&
        coordinator.environment !== "production") ||
      coordinator.dispatch_namespace !== undefined
    )
      throw Error("backend_update_conflict");
    if (
      typeof settings.compatibility_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(?:T00:00:00Z)?$/.test(settings.compatibility_date) ||
      (settings.compatibility_flags !== undefined &&
        (!Array.isArray(settings.compatibility_flags) ||
          settings.compatibility_flags.some(
            (flag: unknown) => typeof flag !== "string",
          )))
    )
      throw Error("backend_update_invalid");
    // Advance only the public algorithm marker. Strict inheritance preserves
    // secrets and exact KV/DO namespaces; missing bindings fail the upload.
    // https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
    const metadata: Record<string, unknown> = {
      main_module: "worker.js",
      compatibility_date: settings.compatibility_date.slice(0, 10),
      compatibility_flags: settings.compatibility_flags ?? [],
      bindings: bindings.map(({ name }) =>
        name === "INSTALLER_ALGORITHM"
          ? { type: "plain_text", name, text: algorithmVersion }
          : { type: "inherit", name },
      ),
      keep_assets: true,
    };
    for (const field of [
      "cache_options",
      "limits",
      "logpush",
      "observability",
      "placement",
      "tags",
      "tail_consumers",
    ])
      if (settings[field] !== undefined) metadata[field] = settings[field];
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append(
      "worker.js",
      new Blob([script], { type: "application/javascript+module" }),
      "worker.js",
    );
    progress("2 / 2 · 更新个人后台，保留现有连接与记录");
    await this.call(
      path + "?bindings_inherit=strict",
      "PUT",
      form,
      false,
      "update",
    );
  }
  async install(
    input: InstallState,
    script: string,
    save: (state: InstallState) => Promise<void>,
    progress: (text: string) => void,
    expectedOrigin?: string,
  ) {
    const s = validateInstall({ ...input }),
      base = "/accounts/" + s.account;
    if (!script.trim()) throw Error("安装包缺少后台代码，请重新安装扩展。");
    progress("1 / 4 · 检查账户和服务网址");
    const domain = await this.subdomain(s.account);
    const origin = "https://" + s.name + "." + domain + ".workers.dev";
    // A previously prepared host may have changed since the authorization click.
    // Stop before creating storage or uploading code rather than broadening access.
    if (expectedOrigin && origin !== expectedOrigin)
      throw Error("deployment_origin_changed");
    const settings = await this.call(
      base + "/workers/scripts/" + s.name + "/settings",
      "GET",
      undefined,
      true,
    );
    if (
      settings &&
      !settings.bindings?.some(
        (b: any) => b.name === "INSTALLATION_ID" && b.text === s.marker,
      )
    )
      throw Error("同名服务不属于此次安装，已停止，未覆盖现有服务。");
    if (
      settings &&
      !settings.bindings?.some(
        (b: any) =>
          b.name === "INSTALLER_ALGORITHM" && b.text === algorithmVersion,
      )
    )
      throw Error(
        "已有实例使用旧算法。请通过「重新连接 Cloudflare」升级现有后台，安装恢复未覆盖旧数据。",
      );
    progress("2 / 4 · 准备独立存储");
    const title = s.name + "-state";
    let matches: { id: string; title: string }[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.call(
        base + "/storage/kv/namespaces?per_page=100&page=" + page,
      );
      if (!Array.isArray(rows)) throw Error("无法确认存储列表，请重试。");
      matches.push(...rows.filter((row: any) => row.title === title));
      if (rows.length < 100) break;
      if (page === 100) throw Error("存储列表过长，未继续创建。");
    }
    if (matches.length > 1 || (s.namespace && matches[0]?.id !== s.namespace))
      throw Error("存储状态不一致，未创建或覆盖数据。请检查该账户的 KV。");
    if (!matches.length) {
      if (settings) throw Error("已有服务的存储缺失，已停止以保护数据。");
      const created = await this.call(base + "/storage/kv/namespaces", "POST", {
        title,
      });
      matches = [created];
    }
    if (!id.test(matches[0].id)) throw Error("无法确认存储 ID，请重试。");
    s.namespace = matches[0].id;
    await save(s);
    progress("3 / 4 · 安装后台（默认暂停）");
    if (!settings) {
      const form = new FormData();
      form.append(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2026-09-08",
          bindings: [
            {
              type: "kv_namespace",
              name: "ASCROBBLE_STATE",
              namespace_id: s.namespace,
            },
            {
              type: "durable_object_namespace",
              name: "SCROBBLE_COORDINATOR",
              class_name: "ScrobbleCoordinator",
            },
            { type: "secret_text", name: "STATUS_AUTH_KEY", text: s.key },
            { type: "plain_text", name: "INSTALLATION_ID", text: s.marker },
            {
              type: "plain_text",
              name: "INSTALLER_ALGORITHM",
              text: algorithmVersion,
            },
            {
              type: "plain_text",
              name: "DEPLOYMENT_ACCOUNT_ID",
              text: s.account,
            },
            {
              type: "plain_text",
              name: "DEPLOYMENT_WORKER_NAME",
              text: s.name,
            },
          ],
          migrations: {
            new_tag: "v1",
            steps: [{ new_sqlite_classes: ["ScrobbleCoordinator"] }],
          },
        }),
      );
      form.append(
        "worker.js",
        new Blob([script], { type: "application/javascript+module" }),
        "worker.js",
      );
      await this.call(base + "/workers/scripts/" + s.name, "PUT", form);
    }
    progress("4 / 4 · 开通个人网址");
    await this.call(
      base + "/workers/scripts/" + s.name + "/subdomain",
      "POST",
      { enabled: true, previews_enabled: false },
    );
    s.origin = origin;
    await save(s);
    return s;
  }
}
