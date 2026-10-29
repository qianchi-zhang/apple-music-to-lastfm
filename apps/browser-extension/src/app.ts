import { createThemeController, type ThemePreference } from "./theme";
import { algorithmVersion, algorithmHash } from "./algorithm-release";
import { Cloudflare, validateInstall, type InstallState } from "./cloudflare";
import { captureAppleCredentials } from "./capture";
import { connectApple } from "./connection";
import {
  deriveViewModel,
  type Connections,
  type Runtime,
  type Step,
} from "./extension-state";
import { createRefreshCoordinator } from "./refresh-coordinator";
import { ServiceError, toUiError, type UiError } from "./extension-errors";
const el = (id: string) => document.getElementById(id)!;
const input = (id: string) => el(id) as HTMLInputElement;
const button = (id: string) => el(id) as HTMLButtonElement;
const coralRoot = document.querySelector<HTMLElement>("[data-coral-app]");
// Disclosure is presentation only. No service state changes when it is opened.
if (coralRoot && window.matchMedia("(max-width: 959px)").matches) {
  coralRoot
    .querySelectorAll<HTMLDetailsElement>("[data-responsive-detail]")
    .forEach((detail) => {
      detail.open = false;
    });
}
const compactSetup = window.matchMedia("(max-width: 700px)");
function syncStepPicker() {
  const picker = document.getElementById(
    "setup-step-picker",
  ) as HTMLDetailsElement | null;
  if (picker) picker.open = !compactSetup.matches;
}
syncStepPicker();
compactSetup.addEventListener("change", syncStepPicker);
const disclosureStates = new Map<string, string>();
function syncDisclosure(id: string, stateKey: string, open: boolean) {
  if (disclosureStates.get(id) === stateKey) return;
  (el(id) as HTMLDetailsElement).open = open;
  disclosureStates.set(id, stateKey);
}
function clearCopyStatuses() {
  for (const id of [
    "copy-key-status",
    "copy-key-lastfm-status",
    "copy-callback-status",
    "copy-homepage-status",
  ])
    document.getElementById(id)?.replaceChildren();
}
function closeStepPicker() {
  if (compactSetup.matches && coralRoot)
    (el("setup-step-picker") as HTMLDetailsElement).open = false;
}
// Appearance is local UI state and never changes installation or recording state.
const theme = createThemeController({
  onChange(snapshot) {
    document
      .querySelectorAll<HTMLInputElement>('input[name="appearance"]')
      .forEach((control) => {
        control.checked = control.value === snapshot.preference;
      });
    const label = snapshot.resolved === "dark" ? "深色" : "浅色";
    el("theme-status").classList.toggle(
      "theme-warning",
      snapshot.persistence === "unavailable",
    );
    el("theme-status").textContent =
      snapshot.persistence === "unavailable"
        ? "外观仅在本页生效，偏好未能保存。"
        : snapshot.persistence === "pending"
          ? "正在保存外观偏好…"
          : snapshot.preference === "system"
            ? "跟随系统 · " + label
            : label + "外观";
  },
});
document
  .querySelectorAll<HTMLInputElement>('input[name="appearance"]')
  .forEach((control) => {
    control.addEventListener("change", () => {
      if (control.checked)
        void theme.setPreference(control.value as ThemePreference);
    });
  });
let state: InstallState | undefined, cf: Cloudflare | undefined;
let accounts: { id: string; name: string }[] = [];
let connections: Connections | null = null,
  runtime: Runtime | null = null;
let busy = false,
  fresh = false,
  verified = false,
  step: Step = "cloud";
let view = "connections",
  confirmedUser = "",
  authorizing = false;
let currentError: UiError | null = null,
  retryAction: (() => Promise<void>) | null = null;
let lastBackgroundCheck = 0;
let lastCopySource: string | null = null;
const steps: Step[] = ["cloud", "apple", "lastfm", "confirm"];
const hex = (length: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const model = (includeBusy = true) =>
  deriveViewModel({
    installed: !!state?.origin,
    verified,
    fresh,
    busy: includeBusy && busy,
    connections,
    runtime,
  });
const currentPanel = () => el(view === "connections" ? step : view);
function show(
  title: string,
  detail = "",
  error: UiError | null = null,
  focusError = true,
) {
  currentError = error;
  el("feedback-title").textContent = title;
  el("feedback-detail").textContent = detail;
  button("recovery").hidden = !error;
  button("recovery").textContent = error?.action || "";
  el("feedback").classList.toggle("success", !error);
  currentPanel().querySelector(".feedback-slot")!.appendChild(el("feedback"));
  el("feedback").hidden = false;
  if (error && focusError) el("feedback").focus();
}
function navigate(next: string, focus = false) {
  if (["records", "settings", "connections"].includes(next)) view = next;
  else if (steps.includes(next as Step)) {
    if (!model().canVisit[next as Step]) return;
    view = "connections";
    step = next as Step;
  } else return;
  el("feedback").hidden = true;
  clearCopyStatuses();
  closeStepPicker();
  render();
  if (focus) currentPanel().querySelector<HTMLElement>("h1")?.focus();
}
function text(id: string, value: string) {
  el(id).textContent = value;
}
function date(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return "尚未检查";
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未检查";
}
function renderRecords() {
  const list = el("record-list");
  list.replaceChildren();
  const records = runtime?.records || [];
  el("empty-records").hidden = records.length > 0;
  el("record-header").hidden = !!coralRoot || records.length === 0;
  let previousDay = "";
  for (const [index, r] of records.entries()) {
    if (coralRoot) {
      const timestamp = r.timestamp_iso ? new Date(r.timestamp_iso) : null;
      const day =
        timestamp && Number.isFinite(timestamp.getTime())
          ? timestamp.toLocaleDateString("zh-CN", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })
          : "日期待确认";
      if (day !== previousDay) {
        const heading = document.createElement("h2");
        heading.className = "record-day";
        heading.textContent = day;
        list.appendChild(heading);
        previousDay = day;
      }
    }
    const row = document.createElement("article");
    row.className = "record-row";
    row.dataset.status = r.status === "accepted" ? "accepted" : "unknown";
    const art = document.createElement("div");
    art.className = "record-art";
    const musicIcon = document.createElement("img");
    musicIcon.src = "icons/music-note.svg";
    musicIcon.alt = "";
    if (coralRoot) {
      art.textContent = String(index + 1).padStart(2, "0");
      art.setAttribute("aria-hidden", "true");
    } else art.appendChild(musicIcon);
    const name = document.createElement("div"),
      title = document.createElement("strong"),
      artist = document.createElement("span");
    name.className = "record-name";
    artist.className = "record-artist";
    title.textContent = r.track;
    artist.textContent = r.artist;
    name.appendChild(title);

    const album = document.createElement("span");
    album.className = "record-album";
    album.textContent = r.album || "未提供专辑";
    const meta = document.createElement("div");
    meta.className = "record-meta";
    const status = document.createElement("small"),
      time = document.createElement("small");
    status.textContent = r.status === "accepted" ? "已提交" : "状态待确认";
    time.textContent = r.timestamp_iso ? date(r.timestamp_iso) : "";
    meta.appendChild(status);
    meta.appendChild(time);
    for (const child of [art, name, artist, album, meta])
      row.appendChild(child);
    list.appendChild(row);
  }
}
function render() {
  const m = model();
  if (coralRoot) {
    coralRoot.dataset.currentView = view;
    const installed = !!state?.origin;
    const appleConnected = !!connections?.apple.connected;
    const appConfigured = !!connections?.lastfm.application_configured;
    const lastfmConnected = !!connections?.lastfm.connected;
    coralRoot.dataset.installed = String(installed);
    coralRoot.dataset.appleConnected = String(appleConnected);
    syncDisclosure("cloud-installation", state?.origin || "new", !installed);
    syncDisclosure("apple-reconnect", String(appleConnected), !appleConnected);
    syncDisclosure("lastfm-config", String(appConfigured), !appConfigured);
    syncDisclosure(
      "lastfm-reconnect",
      `${appConfigured}:${lastfmConnected}`,
      appConfigured && !lastfmConnected,
    );
    el("cloud-installation-summary").hidden = !installed;
    el("apple-reconnect-summary").hidden = !appleConnected;
    el("apple-connected-note").hidden = !appleConnected;
    text(
      "apple-description",
      appleConnected
        ? "连接已保存，可继续连接 Last.fm；需要更换账户时重新连接。"
        : "在浏览器登录 Apple Music，再连接你要记录的账户。",
    );
    text("application-homepage", state?.origin || "请先完成个人后台设置");
    button("copy-homepage").disabled = busy || !state?.origin;
    button("apple-connect").classList.toggle("primary", !appleConnected);
    button("continue-apple").classList.toggle("primary", appleConnected);
    text("cloud-title", installed ? "个人后台已准备好" : "准备你的个人后台");
    text(
      "cloud-description",
      installed
        ? "你的后台地址已保存。检查连接后继续，无需重复安装。"
        : "播放记录在你的 Cloudflare 后台处理。先创建一枚部署令牌，再回到这里安装。",
    );
    text("deploy", installed ? "重新部署此后台" : "安装个人后台");
    text("lastfm-config-state", appConfigured ? "已配置" : "待配置");
    el("lastfm-config-state").classList.toggle(
      "complete-status",
      appConfigured,
    );
    coralRoot
      .querySelectorAll<HTMLElement>("[data-configured-only]")
      .forEach((node) => {
        node.hidden = !appConfigured;
      });
    el("lastfm-authorize").hidden = !appConfigured;
    el("lastfm-prerequisite").hidden = appConfigured;
    text(
      "lastfm-authorize-label",
      lastfmConnected ? "重新授权 Last.fm 账户" : "授权 Last.fm 账户",
    );
    text(
      "lastfm-authorize-state",
      lastfmConnected ? "已连接" : appConfigured ? "当前任务" : "等待应用配置",
    );
    el("lastfm-authorize-state").classList.toggle(
      "complete-status",
      lastfmConnected,
    );
    text(
      "lastfm-description",
      lastfmConnected
        ? "账户连接已保存。接下来核对接收记录的账户。"
        : appConfigured
          ? "应用已配置。现在到个人后台授权你的 Last.fm 账户。"
          : "先完成 3.1 的应用配置，再进行 3.2 的账户授权。",
    );
    const stepNames = {
      cloud: "准备个人后台",
      apple: "连接 Apple Music",
      lastfm: "授权 Last.fm",
      confirm: "核对并开始",
    };
    text(
      "compact-step-label",
      `步骤 ${steps.indexOf(step) + 1} / 4：${stepNames[step]}`,
    );
    text(
      "confirm-title",
      fresh && runtime?.enabled ? "连接已完成" : "核对账户，开始记录",
    );
    text(
      "confirm-description",
      fresh && runtime?.enabled
        ? "Apple Music 与 Last.fm 已连接，个人后台正在自动记录。"
        : "核对接收记录的 Last.fm 账户，然后开启自动记录。",
    );
    coralRoot.dataset.recording = !state?.origin
      ? "unconfigured"
      : !fresh
        ? "unknown"
        : runtime?.enabled
          ? "running"
          : "paused";
    const fill = (selector: string, value: string) =>
      coralRoot.querySelectorAll<HTMLElement>(selector).forEach((node) => {
        node.textContent = value;
      });
    fill(
      "[data-account-name]",
      connections?.lastfm.username || "尚未连接 Last.fm",
    );
    fill(
      "[data-apple-status]",
      !fresh
        ? "状态待确认"
        : connections?.apple.connected
          ? "连接已保存"
          : "尚未连接",
    );
    fill(
      "[data-lastfm-status]",
      !fresh ? "状态待确认" : connections?.lastfm.username || "尚未连接",
    );
  }
  text(
    "toolbar-title",
    view === "records" ? "最近记录" : view === "settings" ? "设置" : "连接向导",
  );
  document
    .querySelector(".app-shell")!
    .classList.toggle("connecting", view === "connections");
  for (const id of [...steps, "records", "settings"])
    el(id).hidden = id !== (view === "connections" ? step : view);
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => {
    const s = b.dataset.step as Step;
    b.disabled = busy || !m.canVisit[s];
    b.classList.toggle("complete", m.complete[s]);
    if (s === step) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
    const dot = b.querySelector(".step-dot")!;
    dot.replaceChildren();
    const icon = document.createElement("img");
    const stepIcons = {
      cloud: "cloud",
      apple: "music-notes",
      lastfm: "link",
      confirm: "check",
    };
    icon.src = "icons/" + (m.complete[s] ? "check" : stepIcons[s]) + ".svg";
    icon.alt = "";
    dot.appendChild(icon);
    text(
      "step-" + s + "-status",
      m.complete[s]
        ? "已完成"
        : s === step
          ? "正在设置"
          : s === "cloud"
            ? "待验证"
            : s === "confirm"
              ? "等待确认"
              : "尚未连接",
    );
  });
  el("confirm-step").hidden = !coralRoot && !m.canVisit.confirm;
  document
    .querySelector(".app-shell")!
    .classList.toggle("confirm-available", m.canVisit.confirm);
  currentPanel().setAttribute("aria-busy", String(busy));
  text("backend", state?.origin || "尚未安装");
  text("backend-summary", state?.origin || "");
  text(
    "callback",
    state?.origin
      ? state.origin + "/api/v1/connections/lastfm/callback"
      : "请先完成个人后台设置",
  );
  el("cloud-ready").hidden = !state?.origin;
  text("verify", verified ? "继续连接音乐账户" : "检查后台并继续");
  el("account-selection").hidden = !accounts.length;
  button("accounts").disabled = busy;
  button("deploy").disabled = busy || !cf || !accounts.length;
  button("verify").disabled = busy || !state?.origin;
  button("apple-connect").disabled = busy || !m.canVisit.apple;
  text(
    "apple-connect",
    connections?.apple.connected
      ? "重新连接 Apple Music"
      : "连接已登录的 Apple Music",
  );
  button("continue-apple").hidden = !m.complete.apple;
  button("lf-save").disabled = busy || !m.canVisit.lastfm;
  button("console").disabled =
    busy || !connections?.lastfm.application_configured;
  button("copy-callback").disabled = busy || !state?.origin;
  button("check-lastfm").disabled = busy || !state?.origin;
  for (const id of ["copy-key", "copy-key-lastfm", "open-backend"])
    button(id).disabled = busy || !state?.origin;
  for (const id of ["refresh", "recovery"]) button(id).disabled = busy;
  button("refresh").disabled = busy || !state?.origin;
  text("lastfm-user", connections?.lastfm.username || "");
  el("lastfm-connected").hidden = !connections?.lastfm.connected;
  text(
    "lastfm-app-status",
    connections?.lastfm.application_configured
      ? "应用配置已保存。接下来在个人后台完成账户授权。"
      : "请先保存应用配置。",
  );
  text("confirm-user", connections?.lastfm.username || "尚未确认账户");
  input("account-confirmed").checked =
    !!confirmedUser && confirmedUser === connections?.lastfm.username;
  input("account-confirmed").disabled = busy || !!runtime?.enabled;
  button("start").disabled =
    !m.canStart || confirmedUser !== connections?.lastfm.username;
  button("start").hidden = !!runtime?.enabled;
  button("go-records").hidden = !runtime?.enabled;
  button("pause").disabled = !m.canPause;
  button("pause").hidden = !runtime?.enabled;
  button("resume").hidden = !!runtime?.enabled && fresh;
  button("resume").disabled = busy;
  text("resume", m.canVisit.confirm ? "核对账户并开始" : "继续设置");
  text(
    "runtime",
    !state?.origin
      ? "尚未准备个人后台"
      : !fresh
        ? "后台状态待检查"
        : runtime?.enabled
          ? "自动记录已开启"
          : "记录已暂停",
  );
  text(
    "connections",
    connections
      ? "Apple Music：" +
          (connections.apple.connected ? "连接已保存" : "尚未连接") +
          " · Last.fm：" +
          (connections.lastfm.username || "尚未连接")
      : "完成服务连接后，在这里查看记录。",
  );
  text(
    "last-run",
    runtime?.last_run_iso ? date(runtime.last_run_iso) : "尚未检查",
  );
  text(
    "next-run",
    runtime?.enabled && runtime.next_run_ms
      ? date(runtime.next_run_ms) + " 左右"
      : "尚未安排",
  );
  text("submitted", runtime ? String(runtime.stats.total_scrobbled) : "—");
  text(
    "pending",
    runtime
      ? String(runtime.pending_identity + runtime.pending_submission)
      : "—",
  );
  el("runtime-error").hidden = !runtime?.stats.last_error_message;
  text(
    "runtime-error",
    "最近运行报告过异常。请检查服务连接；历史错误不一定代表当前仍在失败。详细原因可在个人后台查看。",
  );
  text(
    "empty-detail",
    runtime?.enabled
      ? "正常播放一首新歌后，等待 Apple 更新播放历史和下一轮自动检查。"
      : "开始前先核对音乐账户。首次开始只建立基线，不会补传旧历史。",
  );
  renderRecords();
}
async function save(s: InstallState) {
  await chrome.storage.local.set({ installation: s });
  state = s;
  render();
}
async function permission(origin: string) {
  if (!(await chrome.permissions.request({ origins: [origin + "/*"] })))
    throw new ServiceError("permission_denied");
}
async function api(path: string, method = "GET", body?: unknown) {
  if (!state?.origin) throw new ServiceError("connections_required");
  const origin = state.origin,
    key = state.key;
  if (method !== "GET") {
    fresh = false;
    render();
  }
  const h = await fetch(origin + "/health", {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const health = (await h.json()) as {
    version?: string;
    algorithm_sha256?: string;
  };
  if (
    !h.ok ||
    health.version !== algorithmVersion ||
    health.algorithm_sha256 !== algorithmHash
  ) {
    throw new ServiceError("version_mismatch");
  }
  const res = await fetch(origin + path, {
    method,
    headers: { "x-ascrobble-auth": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ServiceError("invalid_response", res.status);
  }
  if (!res.ok)
    throw new ServiceError(
      res.status === 401 || res.status === 403
        ? "unauthorized"
        : typeof data?.error === "string"
          ? data.error
          : "backend_error",
      res.status,
    );
  return data;
}
const refreshCoordinator = createRefreshCoordinator(
  async () => {
    const c = (await api("/api/v1/connections")) as Connections;
    const d = (await api("/api/v1/recording")) as Runtime;
    if (
      typeof c?.apple?.connected !== "boolean" ||
      typeof c?.lastfm?.connected !== "boolean" ||
      typeof d?.enabled !== "boolean" ||
      !Array.isArray(d.records) ||
      typeof d.stats?.total_scrobbled !== "number"
    )
      throw new ServiceError("invalid_response");
    return { c, d };
  },
  ({ c, d }) => {
    if (connections?.lastfm.username !== c.lastfm.username) confirmedUser = "";
    connections = c;
    runtime = d;
    verified = true;
    fresh = true;
    if (authorizing && c.lastfm.connected) {
      authorizing = false;
      step = "confirm";
      view = "connections";
    }
    render();
  },
);
async function refresh() {
  try {
    await refreshCoordinator.run();
  } catch (e) {
    fresh = false;
    if (e instanceof ServiceError && e.code === "version_mismatch")
      verified = false;
    render();
    throw e;
  }
}
async function operation(fn: () => Promise<void>) {
  if (busy) return;
  refreshCoordinator.invalidate();
  busy = true;
  clearCopyStatuses();
  el("feedback").hidden = true;
  render();
  try {
    await fn();
  } catch (e) {
    if (
      e instanceof TypeError ||
      (e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name))
    )
      fresh = false;
    const failure = toUiError(e);
    show(failure.title, failure.detail, failure);
  } finally {
    busy = false;
    render();
  }
}
function action(id: string, fn: () => Promise<void>) {
  button(id).addEventListener("click", () => {
    retryAction = fn;
    void operation(fn);
  });
}
function advance() {
  closeStepPicker();
  step = model().nextStep;
  view = "connections";
  render();
  currentPanel().querySelector<HTMLElement>("h1")?.focus();
}
async function verify() {
  if (!state?.origin) throw new ServiceError("connections_required");
  await permission(state.origin);
  await refresh();
  advance();
  show("后台连接已确认", "按步骤继续连接音乐账户；当前不会自动开始记录。");
}
action("verify", verify);
action("accounts", async () => {
  await permission("https://api.cloudflare.com");
  cf = undefined;
  accounts = [];
  cf = new Cloudflare(input("token").value.trim());
  accounts = await cf.accounts();
  input("token").value = "";
  const select = el("account") as unknown as HTMLSelectElement;
  select.replaceChildren();
  for (const a of accounts) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = a.name;
    select.appendChild(o);
  }
  if (state) select.value = state.account;
  show("已连接 Cloudflare", "请选择安装账户，再点击安装个人后台。");
});
action("deploy", async () => {
  if (!cf) throw new ServiceError("cloud_token");
  await navigator.locks.request(
    "scrobbler-install",
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new ServiceError("install_busy");
      const account = (el("account") as unknown as HTMLSelectElement).value;
      if (!accounts.some((a) => a.id === account))
        throw new ServiceError("cloud_token");
      const saved = await chrome.storage.local.get("installation");
      if (saved.installation)
        state = validateInstall(saved.installation as InstallState);
      if (state && state.account !== account)
        throw new ServiceError("install_conflict");
      if (!state)
        await save({
          account,
          name: "ams-" + hex(12),
          marker: hex(16),
          key: hex(32),
        });
      const asset = await fetch(chrome.runtime.getURL("worker.bundle.txt"));
      if (!asset.ok) throw new ServiceError("missing_asset");
      await cf!.install(state!, await asset.text(), save, (message) => {
        text("install-status", message);
        el("install-status").hidden = false;
      });
      cf = undefined;
      accounts = [];
      input("token").value = "";
      await permission(state!.origin!);
      await refresh();
      advance();
      show(
        "个人后台已准备好",
        "安装 Token 已清除，后台默认暂停。现在连接 Apple Music。",
      );
    },
  );
});
action("refresh", async () => {
  if (!state?.origin) {
    navigate("cloud");
    return;
  }
  await permission(state.origin);
  await refresh();
  show("已读取最新状态", "状态查询不会采集或提交播放。");
});
action("check-lastfm", async () => {
  await permission(state!.origin!);
  authorizing = true;
  await refresh();
  if (connections?.lastfm.connected) {
    advance();
    show("Last.fm 授权已确认", "核对账户后，你可以开始记录。");
  } else
    show(
      "还没有确认账户授权",
      "请在个人后台完成 Last.fm 官方授权，再返回这里检查。",
    );
});
action("apple-connect", async () => {
  if (!model().canVisit.apple) throw new ServiceError("connections_required");
  if (
    !(await chrome.permissions.request({
      origins: ["https://music.apple.com/*", state!.origin + "/*"],
    }))
  )
    throw new ServiceError("permission_denied");
  const tabs = await chrome.tabs.query({ url: "https://music.apple.com/*" });
  if (tabs.length !== 1 || !tabs[0].id) throw new ServiceError("apple_tabs");
  const result = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    world: "MAIN",
    func: captureAppleCredentials,
  });
  const value = result[0]?.result;
  if (!value) throw new ServiceError("tokens_unavailable");
  if ("error" in value)
    throw new ServiceError(value.error || "tokens_unavailable");
  fresh = false;
  render();
  try {
    await connectApple(state!.origin!, state!.key, value.credentials);
  } finally {
    value.credentials.apple_dev_token = "";
    value.credentials.apple_user_token = "";
  }
  await refresh();
  if (coralRoot) (el("apple-reconnect") as HTMLDetailsElement).open = false;
  advance();
  show("Apple Music 连接已保存", "继续连接 Last.fm；自动记录还没有开启。");
});
action("lf-save", async () => {
  await permission(state!.origin!);
  const api_key = input("lf-key").value.trim(),
    shared_secret = input("lf-secret").value.trim();
  if (!/^[a-f\d]{32}$/i.test(api_key) || !/^[a-f\d]{32}$/i.test(shared_secret))
    throw new ServiceError("invalid_application");
  await api("/api/v1/connections/lastfm/application", "PUT", {
    api_key,
    shared_secret,
  });
  input("lf-key").value = "";
  input("lf-secret").value = "";
  await refresh();
  (el("lastfm-config") as HTMLDetailsElement).open = false;
  show(
    "应用配置已保存",
    "下一步：复制管理钥匙，打开个人后台并解锁，然后允许 Last.fm 连接。",
  );
  if (coralRoot)
    el("lastfm-reconnect").querySelector<HTMLElement>("summary")?.focus();
});
async function copyKey(source: "copy-key" | "copy-key-lastfm") {
  lastCopySource = source;
  if (!state?.key) throw new ServiceError("connections_required");
  try {
    await navigator.clipboard.writeText(state.key);
  } catch {
    throw new ServiceError("clipboard_unavailable");
  }
  if (coralRoot) text(source + "-status", "已复制");
  else
    show(
      "管理钥匙已复制",
      "请只粘贴到自己的后台或密码管理器，不要发到聊天或截图中。",
    );
}
action("copy-key", () => copyKey("copy-key"));
action("copy-key-lastfm", () => copyKey("copy-key-lastfm"));
if (coralRoot)
  action("copy-homepage", async () => {
    lastCopySource = "copy-homepage";
    if (!state?.origin) throw new ServiceError("connections_required");
    try {
      await navigator.clipboard.writeText(state.origin);
    } catch {
      throw new ServiceError("clipboard_unavailable");
    }
    text("copy-homepage-status", "已复制");
  });
action("copy-callback", async () => {
  lastCopySource = "copy-callback";
  if (!state?.origin) throw new ServiceError("connections_required");
  try {
    await navigator.clipboard.writeText(
      state.origin + "/api/v1/connections/lastfm/callback",
    );
  } catch {
    throw new ServiceError("clipboard_unavailable");
  }
  if (coralRoot) text("copy-callback-status", "已复制");
  else show("回调地址已复制", "粘贴到 Last.fm 应用申请页的 Callback URL。");
});
action("console", async () => {
  confirmedUser = "";
  lastBackgroundCheck = 0;
  authorizing = true;
  await chrome.tabs.create({ url: state!.origin + "/setup#lastfm-section" });
  show(
    "已打开个人后台",
    "在后台解锁并完成官方授权。返回此页后会自动检查连接。",
  );
});
action("open-backend", async () => {
  await chrome.tabs.create({ url: state!.origin + "/setup" });
});
action("start", async () => {
  if (!model(false).canStart || confirmedUser !== connections?.lastfm.username)
    throw new ServiceError("account_changed");
  await permission(state!.origin!);
  const c = (await api("/api/v1/connections")) as Connections;
  if (c.lastfm.username !== confirmedUser) {
    confirmedUser = "";
    await refresh();
    throw new ServiceError("account_changed");
  }
  if (!c.apple.connected || !c.lastfm.connected)
    throw new ServiceError("connections_required");
  await api("/api/v1/recording/start", "POST", { username: confirmedUser });
  await refresh();
  view = "records";
  render();
  if (runtime?.enabled)
    show(
      "自动记录已开启",
      "现在可以播放新歌。后台约每三分钟检查，Apple 更新播放历史也可能需要等待。",
    );
  else
    show(
      "已读取最新运行状态",
      "后台目前显示暂停，可能已被其他控制台更改。请核对后再决定是否开始。",
    );
});
action("pause", async () => {
  await permission(state!.origin!);
  await api("/api/v1/recording/pause", "POST", {});
  await refresh();
  if (runtime?.enabled === false)
    show(
      "记录已暂停",
      "已有队列保留。恢复时会建立新基线，跳过暂停期间的历史。",
    );
  else
    show(
      "已读取最新运行状态",
      "后台目前仍显示开启，可能已被其他控制台更改。请核对后再决定是否暂停。",
    );
});
button("recovery").addEventListener("click", () => {
  if (busy || !currentError) return;
  const recovery = currentError.recovery;
  if (recovery === "retry-copy" && retryAction) {
    const retryCopy = retryAction;
    const copySource = lastCopySource;
    let copied = false;
    void operation(async () => {
      await retryCopy();
      copied = true;
    }).then(() => {
      // operation() has rendered the buttons enabled again before restoring focus.
      if (copied && copySource) button(copySource).focus();
    });
    return;
  }
  if (recovery === "retry" && state?.origin && !fresh) {
    void operation(async () => {
      await permission(state!.origin!);
      await refresh();
      show("已检查当前状态", "请先核对结果，再主动选择下一步操作。");
    });
    return;
  }
  if (recovery === "retry" && retryAction) {
    void operation(retryAction);
    return;
  }
  if (recovery === "refresh" && state?.origin) {
    void operation(async () => {
      await permission(state!.origin!);
      await refresh();
      show("已检查后台状态", "请核对当前结果后继续。");
    });
    return;
  }
  const destination =
    recovery === "settings"
      ? "settings"
      : model().canVisit[recovery as Step]
        ? recovery
        : "cloud";
  navigate(destination, true);
  if (destination === "cloud") openCloudHelp();
});
for (const id of [
  "continue-apple",
  "continue-lastfm",
  "back-to-connections",
  "resume",
]) {
  button(id).addEventListener("click", () => {
    navigate("connections");
    advance();
  });
}
button("go-records").addEventListener("click", () => navigate("records", true));
function openCloudHelp() {
  if (coralRoot) (el("cloud-installation") as HTMLDetailsElement).open = true;
  (el("cloud-help") as HTMLDetailsElement).open = true;
  el("cloud-help").scrollIntoView({ block: "nearest" });
}
button("token-help").addEventListener("click", openCloudHelp);
input("account-confirmed").addEventListener("change", () => {
  confirmedUser = input("account-confirmed").checked
    ? connections?.lastfm.username || ""
    : "";
  render();
});
document.querySelectorAll<HTMLElement>("[data-view]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (busy) return;
    if (a.hasAttribute("data-guide-entry")) {
      view = "connections";
      advance();
      currentPanel().querySelector<HTMLElement>("h1")?.focus();
    } else navigate(a.dataset.view!, true);
  }),
);
document
  .querySelectorAll<HTMLButtonElement>("[data-step]")
  .forEach((b) =>
    b.addEventListener("click", () => navigate(b.dataset.step!, true)),
  );
document.querySelector(".brand")!.addEventListener("click", (e) => {
  // The new application brand is its records destination, handled above.
  if ((e.currentTarget as HTMLElement).dataset.view) return;
  e.preventDefault();
  navigate("connections", true);
});
async function backgroundRefresh(force = false) {
  if (
    !state?.origin ||
    busy ||
    document.visibilityState === "hidden" ||
    (!force && Date.now() - lastBackgroundCheck < 3000)
  )
    return;
  lastBackgroundCheck = Date.now();
  try {
    if (
      !(await chrome.permissions.contains({ origins: [state.origin + "/*"] }))
    ) {
      fresh = false;
      render();
      return;
    }
    await refresh();
  } catch (e) {
    const failure = toUiError(e);
    show(failure.title, failure.detail, failure, false);
  }
}
window.addEventListener("focus", () => void backgroundRefresh());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void backgroundRefresh();
});
void chrome.storage.local
  .get("installation")
  .then(async (saved) => {
    if (saved.installation)
      state = validateInstall(saved.installation as InstallState);
    render();
    if (state?.origin) {
      await backgroundRefresh(true);
      step = model().nextStep;
      if (fresh && runtime?.enabled) view = "records";
      render();
    }
  })
  .catch((e) => {
    const failure = toUiError(e);
    show(failure.title, failure.detail, failure);
  });
render();
