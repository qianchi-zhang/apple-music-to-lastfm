import { safeAlbumArtworkUrl } from "./emil-artwork";
import { algorithmVersion } from "./algorithm-release";
import { artworkLookup } from "../../../packages/contracts/src/artwork-record";
import {
  createEmilService,
  type EmilCopyInfo,
  type EmilSnapshot,
} from "./emil-service";
import { deriveViewModel, type Runtime, type Step } from "./extension-state";
import { animateSpring, installPressFeedback } from "./emil-motion";
import { createThemeController } from "./theme";
import { recordingIssue, recordingIssueError } from "./recording-issue";

/** An original interface: only provider operations and state contracts are shared. */
function element<T = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as unknown as T;
}
function text(id: string, value: string) {
  element(id).textContent = value;
}
function icon(name: string) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(node.namespaceURI, "use");
  use.setAttribute("href", "#i-" + name);
  node.appendChild(use);
  return node;
}
type Page = "journal" | "connections" | "settings";
const pages: Page[] = ["journal", "connections", "settings"];
const recentRecordLimit = 10;
let initialRoutingPending = !pages.includes(location.hash.slice(1) as Page);
let initialLoadFailed = false;
const steps: Step[] = ["cloud", "apple", "lastfm"];
const stepCopy: Record<Step, [string, string]> = {
  cloud: [
    "先给音乐一个落脚点。",
    "先在 Cloudflare 创建访问令牌，再回到这里安装属于你的个人后台。",
  ],
  apple: [
    "把喜欢的音乐，接过来。",
    "从 Apple Music 官网连接，不需要在这里输入账户密码。",
  ],
  lastfm: [
    "让每次聆听，有回响。",
    "准备 Last.fm 应用，再允许你的音乐账户连接。",
  ],
  confirm: ["设置已完成。", "三个连接已经就绪，开启后会自动记录新的聆听。"],
};
const sheet = element<HTMLDialogElement>("setup-sheet");
const sheetScrim = element("setup-scrim");
let currentPage: Page = "journal";
let currentStep: Step = "cloud";
let sheetMode: "setup" | "recording" = "setup";
let snapshot: EmilSnapshot = {
  installation: null,
  connections: null,
  runtime: null,
  verified: false,
  fresh: false,
  busy: true,
  error: null,
};
let service: ReturnType<typeof createEmilService>;
let reconfigureLastfm = false;
let lastfmRecoveryMode = false;
let showCloudForm = false;
let backendUpdateMode = false;
let cloudReconnectMode = false;
let lastRecordsKey = "";
const recordArtworkAttempts = new WeakMap<
  HTMLElement,
  { pending: boolean; retryAt: number }
>();
let latestArtworkKey = "";
let artworkRevision = 0;
let artworkRetryAt = 0;
let lastFocusRefresh = 0;
let focusRefreshPending = false;
let taskLabel = "";
let lastCopy: { kind: EmilCopyInfo; button: HTMLButtonElement } | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let sheetWanted = false;
let pendingPage: { page: Page; updateHash: boolean } | null = null;
let sheetExitAt = 1;
let previousOverflow = "";
let returnFocus: HTMLElement | null = null;
let lastPresentedAppleError: string | null = null;
const navIndicator = document.querySelector<HTMLElement>(".nav-indicator")!;
const navSpring = animateSpring({
  from: 0,
  onUpdate: (value) => {
    navIndicator.style.transform = `translate3d(${value}px,0,0)`;
  },
});
const sheetSpring = animateSpring({
  from: 0,
  response: 0.36,
  onUpdate: (value) => {
    sheet.style.transform = `translate3d(0,${value}px,0)`;
    sheetScrim.style.opacity = String(
      Math.max(0, Math.min(1, 1 - value / sheetExitAt)),
    );
    // The spring's subpixel settling tail is invisible once the panel is offscreen.
    // Release modal interaction there instead of blocking the page until rest.
    if (!sheetWanted && sheet.open && value >= sheetExitAt) finishSheetClose();
  },
  onComplete: finishSheetClose,
});

function finishSheetClose() {
  if (sheetWanted || !sheet.open) return;
  sheetSpring.cancel();
  sheet.close();
  sheetScrim.hidden = true;
  document.body.style.overflow = previousOverflow;
  const nextPage = pendingPage;
  pendingPage = null;
  if (nextPage) goToPage(nextPage.page, nextPage.updateHash);
  returnFocus?.focus();
  render();
}

function measureSheetExit() {
  // Read layout at lifecycle boundaries, never in the animation frame loop.
  const bounds = sheet.getBoundingClientRect();
  sheetExitAt = Math.max(
    1,
    window.innerHeight - bounds.top + sheetSpring.value,
  );
}

function model() {
  return deriveViewModel({
    installed: !!snapshot.installation?.origin,
    verified: snapshot.verified,
    busy: snapshot.busy,
    fresh: snapshot.fresh,
    connections: snapshot.connections,
    runtime: snapshot.runtime,
  });
}
function currentError() {
  return (
    snapshot.error ?? recordingIssueError(recordingIssue(snapshot.runtime))
  );
}
function focusSheetTitle() {
  if (sheet.open && sheetWanted)
    element("sheet-title").focus({ preventScroll: true });
}
function needsConnectionCheck() {
  return snapshot.installation?.origin
    ? !snapshot.verified || !snapshot.fresh || !snapshot.connections
    : !snapshot.installation && initialLoadFailed;
}
function defaultPage(): Page {
  // Only confirmed missing setup is onboarding; an unavailable saved backend
  // must remain a recovery state, never an invitation to install again.
  if (snapshot.error) return "journal";
  if (!snapshot.installation?.origin) return "connections";
  if (
    snapshot.fresh &&
    snapshot.verified &&
    snapshot.connections &&
    (!snapshot.connections.apple.connected ||
      !snapshot.connections.lastfm.connected)
  )
    return "connections";
  return "journal";
}
function updateNavigation(immediate = false) {
  const selected = document.querySelector<HTMLButtonElement>(
    `.main-navigation [data-page="${currentPage}"]`,
  )!;
  const nav = selected.parentElement!;
  const padding = parseFloat(getComputedStyle(nav).paddingLeft) || 0;
  navIndicator.style.width = selected.offsetWidth + "px";
  navSpring.to(selected.offsetLeft - padding, { immediate });
}
function goToPage(page: Page, updateHash = true) {
  if (updateHash) initialRoutingPending = false;
  // Keep the page behind the sheet still, including throughout its exit motion.
  if (sheet.open) {
    pendingPage = { page, updateHash };
    return;
  }
  currentPage = page;
  for (const name of pages) element("page-" + name).hidden = name !== page;
  document
    .querySelectorAll<HTMLButtonElement>("[data-page]")
    .forEach((button) => {
      if (button.dataset.page === page)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  updateNavigation();
  if (updateHash) history.replaceState(null, "", "#" + page);
}
function goToStep(step: Step) {
  if (
    !model().canVisit[step] &&
    !(step === "confirm" && sheetMode === "recording" && model().canPause)
  )
    step = model().nextStep;
  const changed = step !== currentStep;
  if (step !== "cloud" && backendUpdateMode) {
    backendUpdateMode = false;
    cloudReconnectMode = false;
    showCloudForm = false;
  }
  if (step !== "confirm") sheetMode = "setup";
  currentStep = step;
  element("sheet-feedback").textContent = "";
  renderSheet();
  sheet.scrollTo?.({ top: 0 });
  if (changed) focusSheetTitle();
}
function openSetup(
  step: Step = model().nextStep,
  mode: "setup" | "recording" = "setup",
) {
  const wasOpen = sheet.open;
  sheetMode = mode;
  if (!wasOpen) {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    previousOverflow = document.body.style.overflow;
  }
  sheetWanted = true;
  goToStep(step);
  sheetScrim.hidden = false;
  if (!wasOpen) {
    element("global-error").hidden = true;
    sheet.showModal();
    document.body.style.overflow = "hidden";
    element("close-sheet").focus({ preventScroll: true });
  }
  measureSheetExit();
  if (!wasOpen) sheetSpring.jump(sheetExitAt + 20);
  sheetSpring.to(0);
  render();
}
function closeSetup() {
  if (!sheet.open) return;
  measureSheetExit();
  sheetWanted = false;
  sheetSpring.to(sheetExitAt + 20);
}
function continueSetup() {
  if (snapshot.busy) return;
  if (needsConnectionCheck()) {
    void perform("正在检查连接", () =>
      snapshot.installation?.origin
        ? service.refresh({ permission: true })
        : service.load(),
    );
    return;
  }
  if (model().complete.confirm) {
    goToPage("journal");
    return;
  }
  if (model().canStart) {
    startRecording();
    return;
  }
  openSetup();
}
function beginBackendUpdate() {
  if (!snapshot.installation?.origin || snapshot.busy) return;
  backendUpdateMode = true;
  cloudReconnectMode = false;
  showCloudForm = true;
  element<HTMLInputElement>("cloud-token").value = "";
  element<HTMLSelectElement>("cloud-account").replaceChildren();
  element("cloud-account-selection").hidden = true;
  element<HTMLDetailsElement>("cloud-token-guide").open = true;
  openSetup("cloud");
}
function notify(message: string) {
  const toast = element("toast");
  toast.querySelector("span")!.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}
async function perform(
  label: string,
  task: () => Promise<void>,
  success?: () => void,
) {
  if (snapshot.busy) return;
  taskLabel = label;
  try {
    await task();
    success?.();
  } catch {
    /* The service supplies a fixed, actionable error through its snapshot. */
  } finally {
    taskLabel = "";
    render();
  }
}
function pauseRecording(fromSheet = false) {
  if (!model().canPause) return;
  void perform(
    "正在暂停",
    () => service.pauseRecording(),
    () => {
      const paused = snapshot.runtime?.enabled === false;
      if (fromSheet && paused) closeSetup();
      if (fromSheet && !paused)
        text(
          "sheet-feedback",
          "后台状态已更新，记录仍在运行，请核对后再暂停。",
        );
      notify(
        paused
          ? "已暂停，音乐仍可继续"
          : "后台状态已更新，记录仍在运行，请核对后再暂停",
      );
    },
  );
}
function setButton(id: string, disabled: boolean) {
  element<HTMLButtonElement>(id).disabled = disabled;
}
function setServiceState(id: string, complete: boolean, idle: string) {
  const node = element(id);
  node.textContent = complete ? "已连接" : idle;
  node.dataset.complete = String(complete);
}
function renderSetupEntry() {
  const state = model();
  const uncertain = needsConnectionCheck();
  const connected = state.complete.apple && state.complete.lastfm;
  const active = connected && snapshot.runtime?.enabled === true;
  const count = ["cloud", "apple", "lastfm"].filter(
    (step) => state.complete[step as Step],
  ).length;
  text(
    "connections-eyebrow",
    uncertain
      ? snapshot.installation
        ? "已有设置已保留"
        : "连接状态待确认"
      : connected
        ? "一次连接，自然延续"
        : count || snapshot.installation
          ? "继续上次的设置"
          : "欢迎使用余音",
  );
  text(
    "connections-title",
    uncertain
      ? snapshot.installation
        ? "检查一下，\n已有的连接。"
        : "检查一下，\n你的连接设置。"
      : connected
        ? "音乐，\n已经相连。"
        : count || snapshot.installation
          ? "继续完成，\n你的音乐连接。"
          : "开始前，\n连接你的音乐。",
  );
  text(
    "connections-description",
    uncertain
      ? "先确认连接设置，再继续使用余音。"
      : connected
        ? "三个连接已经就绪。你可以在这里查看和管理。"
        : "完成这三个连接，让 Apple Music 的聆听自动记录到 Last.fm。",
  );
  text(
    "setup-summary",
    uncertain ? "连接状态待确认" : `已完成 ${count} / 3 项连接`,
  );
  const nextDescription: Record<Step, string> = {
    cloud: snapshot.installation
      ? "下一步：继续安装个人后台。已有安装信息会保留。"
      : "从 Cloudflare 开始，安装个人后台。无需购买或接入域名。",
    apple: "下一步：连接 Apple Music。请先在当前浏览器登录 Apple Music 网页。",
    lastfm: snapshot.connections?.lastfm.application_configured
      ? "下一步：完成 Last.fm 授权，即可开始记录。"
      : "下一步：创建 Last.fm 应用，并连接你的音乐账户。",
    confirm: "设置已完成，开启后会自动记录新的聆听。",
  };
  text(
    "setup-next-description",
    uncertain
      ? snapshot.installation
        ? "检查已保存后台的状态，确认后继续连接。"
        : "重新读取当前浏览器的设置，确认下一步。"
      : active
        ? "正在记录中，去看看最近留下的聆听记忆。"
        : nextDescription[state.nextStep],
  );
  const button = element<HTMLButtonElement>("continue-setup");
  button.disabled = snapshot.busy;
  button.replaceChildren(
    document.createTextNode(
      snapshot.busy
        ? taskLabel || "正在读取…"
        : uncertain
          ? snapshot.installation
            ? "检查已有连接"
            : "重试读取设置"
          : active
            ? "查看聆听记录"
            : connected
              ? "开始自动记录"
              : count || snapshot.installation
                ? "继续连接"
                : "开始连接",
    ),
    icon("arrow"),
  );
  document.querySelectorAll<HTMLElement>(".connection-row").forEach((row) => {
    const step = row.querySelector<HTMLButtonElement>("[data-setup]")!.dataset
      .setup as Step;
    row.dataset.next = String(
      !uncertain && !connected && step === state.nextStep,
    );
  });
}
function render() {
  // Service snapshots stay current; only the obscured background waits until
  // the sheet has fully closed. The active setup panel still renders every update.
  if (sheet.open) {
    renderSheet();
    return;
  }
  const state = model();
  const runtime = snapshot.runtime;
  const active = runtime?.enabled === true;
  const cloud = state.complete.cloud;
  const apple = state.complete.apple;
  const lastfm = state.complete.lastfm;
  const username = snapshot.connections?.lastfm.username ?? "";
  const issue = recordingIssue(runtime);
  const error = currentError();
  document.body.setAttribute("aria-busy", String(snapshot.busy));
  const stateLabel = snapshot.busy
    ? taskLabel || "正在读取"
    : error || (snapshot.installation?.origin && !snapshot.fresh)
      ? "需要检查"
      : active && apple && lastfm
        ? "正在记录"
        : apple && lastfm
          ? "记录已暂停"
          : cloud
            ? "待完成连接"
            : "等待连接";
  text("top-status-label", stateLabel);
  setButton("top-status", snapshot.busy);
  element("top-status").dataset.state = error
    ? "error"
    : active && apple && lastfm && snapshot.fresh
      ? "active"
      : "idle";
  const recordButton = element<HTMLButtonElement>("recording-action");
  recordButton.replaceChildren(
    icon(active ? "pause" : cloud && apple && lastfm ? "play" : "arrow"),
    Object.assign(document.createElement("span"), {
      textContent: snapshot.busy
        ? taskLabel || "正在读取…"
        : active
          ? "暂停记录"
          : state.canStart
            ? "开始记录"
            : issue
              ? recordingIssueError(issue)!.action
              : needsConnectionCheck()
                ? "检查连接"
                : "连接我的音乐",
    }),
  );
  recordButton.disabled = snapshot.busy || (active && !state.canPause);
  text(
    "recording-status",
    issue
      ? "记录需要检查"
      : active
        ? snapshot.fresh
          ? "正在记录"
          : "等待确认后台状态"
        : cloud
          ? "暂停期间不会提交播放"
          : "等待连接",
  );
  element("recording-status").dataset.active = String(
    active && snapshot.fresh && !error,
  );
  renderLatestAlbum();
  renderHistoryLink();
  setButton("refresh", snapshot.busy || !snapshot.installation?.origin);
  element("refresh").setAttribute("aria-busy", String(snapshot.busy));
  setServiceState(
    "connection-cloud-state",
    cloud,
    snapshot.installation?.origin ? "待验证" : "尚未安装",
  );
  setServiceState("connection-apple-state", apple, "等待连接");
  setServiceState("connection-lastfm-state", lastfm, "等待连接");
  renderSetupEntry();
  text(
    "connection-cloud-detail",
    snapshot.installation?.origin
      ? new URL(snapshot.installation.origin).hostname
      : "一次安装，默认暂停，由你决定何时开始。",
  );
  text(
    "connection-lastfm-detail",
    lastfm ? "记录将提交到 " + username : "配置应用并授权后，即可开始记录。",
  );
  document
    .querySelectorAll<HTMLButtonElement>(".connection-row [data-setup]")
    .forEach((button) => {
      const step = button.dataset.setup as Step;
      const complete = state.complete[step];
      button.disabled = snapshot.busy || !state.canVisit[step];
      button.replaceChildren(
        document.createTextNode(
          step === "cloud" && needsConnectionCheck()
            ? "检查连接"
            : complete
              ? "管理连接"
              : !state.canVisit[step]
                ? "先安装后台"
                : step === "cloud"
                  ? "安装后台"
                  : "连接账户",
        ),
        icon("arrow"),
      );
    });
  text("backend-origin", snapshot.installation?.origin || "尚未安装");
  text("algorithm-version", runtime?.algorithm_version || algorithmVersion);
  setButton("update-backend", snapshot.busy || !snapshot.installation?.origin);
  document
    .querySelectorAll<HTMLButtonElement>('[data-copy="key"]')
    .forEach((button) => {
      button.disabled = !snapshot.installation?.origin;
    });
  element("global-error").hidden = !error || sheet.open;
  if (error) {
    text("error-title", error.title);
    text("error-detail", error.detail);
    text("error-recovery", error.action);
  }
  renderRecords();
  renderSheet();
}
function renderSheet() {
  const state = model();
  if (
    sheetMode === "recording" &&
    !state.canVisit.confirm &&
    !state.canPause &&
    !snapshot.busy
  ) {
    sheetMode = "setup";
    currentStep = state.nextStep;
  }
  const recordingMode = sheetMode === "recording" && currentStep === "confirm";
  const completionMode = currentStep === "confirm";
  const reconnectingCloud =
    currentStep === "cloud" &&
    !!snapshot.installation?.origin &&
    showCloudForm &&
    cloudReconnectMode;
  const updatingBackend =
    backendUpdateMode && currentStep === "cloud" && !reconnectingCloud;
  const active = snapshot.runtime?.enabled === true;
  const issue = recordingIssue(snapshot.runtime);
  const authorizationOnly =
    lastfmRecoveryMode &&
    snapshot.connections?.lastfm.application_configured === true &&
    !reconfigureLastfm;
  const lastfmCompleted =
    currentStep === "lastfm" &&
    state.complete.apple &&
    state.complete.lastfm &&
    !reconfigureLastfm &&
    !issue;
  const [title, description] =
    stepCopy[lastfmCompleted ? "confirm" : currentStep];
  sheet.dataset.mode = recordingMode ? "recording" : "setup";
  text(
    "sheet-label",
    recordingMode ? "记录设置" : completionMode ? "连接已完成" : "连接你的音乐",
  );
  element("setup-progress").hidden = completionMode;
  element("sheet-step-label").hidden = completionMode;
  text(
    "sheet-title",
    currentStep === "confirm" && issue
      ? "记录需要检查。"
      : currentStep === "confirm" && active
        ? "正在记录。"
        : recordingMode
          ? "记录已暂停。"
          : updatingBackend
            ? "让个人后台保持最新。"
            : reconnectingCloud
              ? "重新连接 Cloudflare。"
              : title,
  );
  text(
    "sheet-description",
    currentStep === "confirm" && issue
      ? active
        ? "请按照下面的提示恢复连接；你仍然可以暂停后台记录。"
        : "请按照下面的提示恢复连接，完成后由你决定何时开始记录。"
      : currentStep === "confirm" && active
        ? "新的 Apple Music 聆听会自动记录到 Last.fm，你可以随时暂停。"
        : recordingMode
          ? "重新开启后，只记录新的播放。"
          : currentStep === "lastfm" && authorizationOnly
            ? "重新授权你的 Last.fm 账户，继续使用已保存的应用配置。"
            : updatingBackend
              ? "使用原 Cloudflare 账户更新现有服务，保留连接和聆听记录。"
              : reconnectingCloud
                ? "重新验证 Cloudflare Token，并更新现有个人后台，保留连接和聆听记录。"
                : description,
  );
  text(
    "sheet-step-label",
    completionMode ? "" : "0" + (steps.indexOf(currentStep) + 1) + " / 03",
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-step]")
    .forEach((button) => {
      const step = button.dataset.step as Step;
      button.disabled = !state.canVisit[step];
      button.dataset.complete = String(state.complete[step]);
      const badge = button.querySelector("span")!;
      badge.replaceChildren(
        ...(state.complete[step]
          ? [icon("check")]
          : [document.createTextNode(String(steps.indexOf(step) + 1))]),
      );
      if (step === currentStep) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  document
    .querySelectorAll<HTMLElement>("[data-step-panel]")
    .forEach((panel) => {
      panel.hidden = panel.dataset.stepPanel !== currentStep;
    });
  element("cloud-complete").hidden = !state.complete.cloud || showCloudForm;
  element("cloud-form").hidden = state.complete.cloud && !showCloudForm;
  setButton("show-cloud-form", snapshot.busy);
  text("cloud-origin", snapshot.installation?.origin || "");
  text("lastfm-homepage", snapshot.installation?.origin || "先安装个人后台");
  text(
    "lastfm-callback",
    snapshot.installation?.origin
      ? snapshot.installation.origin + "/api/v1/connections/lastfm/callback"
      : "先安装个人后台",
  );
  setButton("load-accounts", snapshot.busy);
  text(
    "load-accounts",
    snapshot.busy && taskLabel === "正在连接 Cloudflare"
      ? "正在验证…"
      : "验证 Token",
  );
  const account = element<HTMLSelectElement>("cloud-account");
  const updateAccountAvailable = Array.from(account.options).some(
    (option) => option.value === snapshot.installation?.account,
  );
  account.disabled = snapshot.busy || backendUpdateMode;
  setButton(
    "deploy",
    snapshot.busy ||
      !account.value ||
      (backendUpdateMode && !updateAccountAvailable),
  );
  element("deploy").replaceChildren(
    document.createTextNode(
      reconnectingCloud
        ? "连接并继续"
        : backendUpdateMode
          ? "更新个人后台"
          : "安装个人后台",
    ),
    icon("arrow"),
  );
  text(
    "cloud-explanation",
    backendUpdateMode
      ? "Cloudflare 是运行个人后台的平台。使用仅限原部署账户的 API Token 更新现有服务，无需重新安装。"
      : "Cloudflare 是运行个人后台的平台。API Token（访问令牌）是允许余音替你安装后台的凭证，下面会带你一步步创建。",
  );
  text(
    "cloud-guide-intro",
    backendUpdateMode
      ? "更新现有服务，使用原来的部署账户"
      : "首次设置，从下面开始",
  );
  text(
    "cloud-return-heading",
    backendUpdateMode ? "回到余音，验证并更新" : "回到余音，验证并安装",
  );
  text(
    "cloud-return-instruction",
    backendUpdateMode
      ? "把 Token 粘贴到下面，点击「验证 Token」。余音会锁定原部署账户，再点击「" +
          (reconnectingCloud ? "连接并继续" : "更新个人后台") +
          "」。完成后继续连接音乐。"
      : "把 Token 粘贴到下面，点击「验证 Token」。看到部署账户后，选中与第 1 步相同的账户，再点击「安装个人后台」。安装成功会进入 Apple Music 连接。",
  );
  text(
    "cloud-entry-title",
    reconnectingCloud
      ? "验证并连接"
      : backendUpdateMode
        ? "验证并更新"
        : "验证并安装",
  );
  text(
    "cloud-token-purpose",
    backendUpdateMode
      ? "Token 仅在本页内存中用于更新，不会保存。更新成功后可回 Cloudflare 撤销这个 Token。"
      : "Token 仅在本页内存中用于安装，不会保存。安装成功后可回 Cloudflare 撤销这个 Token。",
  );
  const accountStatus = element<HTMLElement>("cloud-account-status");
  const wrongUpdateAccount = backendUpdateMode && !updateAccountAvailable;
  accountStatus.style.color = wrongUpdateAccount ? "var(--danger)" : "";
  accountStatus.replaceChildren(
    icon(wrongUpdateAccount ? "info" : "check"),
    document.createTextNode(
      backendUpdateMode
        ? updateAccountAvailable
          ? "Token 已验证，将更新原部署账户中的现有后台。"
          : "这个 Token 未包含原部署账户，暂时无法更新。"
        : "Token 已验证，接下来选择安装位置。",
    ),
  );
  text(
    "cloud-account-hint",
    backendUpdateMode
      ? updateAccountAvailable
        ? "账户已锁定为原部署账户。更新时保持本页打开；现有连接、记录和暂停状态都会保留。"
        : "请回到 Cloudflare，把 Account Resources 指定为原部署账户，再使用新 Token 重新验证。"
      : "请选择刚才在 Account Resources 中指定的账户。安装时保持本页打开；新后台默认暂停，不会立即开始记录。",
  );
  setButton("connect-apple", snapshot.busy || !state.complete.cloud);
  const appleButton = element("connect-apple");
  appleButton.replaceChildren(
    document.createTextNode(
      snapshot.busy && currentStep === "apple"
        ? "正在连接…"
        : state.complete.apple
          ? "重新连接 Apple Music"
          : "连接 Apple Music",
    ),
    icon("arrow"),
  );
  text(
    "apple-panel-status",
    state.complete.apple
      ? "Apple Music 已连接，可以继续。"
      : "只读取连接所需的音乐授权信息。",
  );
  element("apple-continue").hidden = !state.complete.apple;
  element("lastfm-complete").hidden =
    !state.complete.lastfm || reconfigureLastfm || lastfmRecoveryMode;
  element("lastfm-configuration").hidden =
    state.complete.lastfm && !reconfigureLastfm && !lastfmRecoveryMode;
  for (const id of [
    "lastfm-application-guide",
    "lastfm-application-urls",
    "lastfm-form",
  ])
    element(id).hidden = authorizationOnly;
  element("lastfm-authorization-number").hidden = authorizationOnly;
  element("reconfigure-lastfm-recovery").hidden = !authorizationOnly;
  text(
    "lastfm-authorization-title",
    authorizationOnly ? "重新允许 Last.fm 账户连接" : "允许 Last.fm 账户连接",
  );
  text(
    "lastfm-authorization-description",
    authorizationOnly
      ? issue?.code === "queue_account_changed"
        ? "请先在 Last.fm 官网退出当前账户，并登录" +
          (issue.queue_owner ? "「" + issue.queue_owner + "」" : "原账户") +
          "，再回到余音点击授权。已保存的应用配置会继续使用。"
        : "应用配置已保存。请前往 Last.fm 官网重新允许账户连接，完成后回到余音检查。"
      : "保存应用后，前往 Last.fm 官网同意连接。完成后会自动回到余音，即可开始记录。",
  );
  text("lastfm-complete-title", "Last.fm 已连接");
  text(
    "connected-lastfm-user",
    snapshot.connections?.lastfm.username
      ? "已连接的 Last.fm 账户：" + snapshot.connections.lastfm.username
      : "",
  );
  text(
    "confirm-username",
    snapshot.connections?.lastfm.username || "尚未连接 Last.fm",
  );
  setButton("save-lastfm", snapshot.busy || !state.complete.cloud);
  setButton(
    "authorize-lastfm",
    snapshot.busy || !snapshot.connections?.lastfm.application_configured,
  );
  setButton(
    "check-authorization",
    snapshot.busy || !snapshot.installation?.origin,
  );
  text(
    "save-lastfm",
    snapshot.connections?.lastfm.application_configured
      ? "更新应用配置"
      : "保存应用配置",
  );
  element("recording-start-controls").hidden = active;
  element("recording-pause-controls").hidden = !active;
  setButton("pause-recording", !state.canPause);
  element("pause-recording").replaceChildren(
    icon("pause"),
    document.createTextNode(
      snapshot.busy && taskLabel === "正在暂停" ? "正在暂停…" : "暂停记录",
    ),
  );
  for (const id of ["start-recording", "start-recording-lastfm"]) {
    setButton(id, !state.canStart);
    element(id).replaceChildren(
      document.createTextNode(
        snapshot.runtime?.enabled
          ? "已经在记录了"
          : snapshot.busy && taskLabel === "正在开启记录"
            ? "正在开启…"
            : "开始自动记录",
      ),
      icon("arrow"),
    );
  }
  sheet.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    button.disabled = !snapshot.installation?.origin;
  });
  const error = currentError();
  const appleError = currentStep === "apple" && !snapshot.busy ? error : null;
  const appleAlert = element("apple-error");
  appleAlert.hidden = !appleError;
  element("apple-error-open").hidden = !appleError?.openAppleMusic;
  element("apple-error-recovery").hidden =
    !appleError || appleError.recovery === "apple";
  element("apple-panel-status").hidden = !!appleError;
  if (appleError) {
    text("apple-error-title", appleError.title);
    text("apple-error-detail", appleError.detail);
    text("apple-error-recovery", appleError.action);
    const appleErrorKey = JSON.stringify([appleError.title, appleError.detail]);
    if (
      sheet.open &&
      sheetWanted &&
      appleErrorKey !== lastPresentedAppleError
    ) {
      lastPresentedAppleError = appleErrorKey;
      appleAlert.focus({ preventScroll: true });
      appleAlert.scrollIntoView?.({ block: "nearest" });
    }
  } else {
    lastPresentedAppleError = null;
    text("apple-error-title", "");
    text("apple-error-detail", "");
  }
  element("sheet-error").hidden = !error || currentStep === "apple";
  if (error) {
    element("sheet-error").querySelector("strong")!.textContent = error.title;
    element("sheet-error").querySelector("p")!.textContent = error.detail;
    text("sheet-recovery", error.action);
  }
}
function validDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function dateLabel(date: Date) {
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
function renderLatestAlbum() {
  // The album always follows the newest actual record.
  const latest = snapshot.runtime?.records[0];
  text("latest-track", latest?.track || "暂无记录");
  text("latest-artist", latest?.artist || "");
  text("latest-album", latest?.album || "");
  const key = JSON.stringify([
    snapshot.installation?.origin,
    snapshot.installation?.key,
    snapshot.connections?.lastfm.username,
    latest,
  ]);
  if (key === latestArtworkKey && Date.now() < artworkRetryAt) return;
  latestArtworkKey = key;
  artworkRetryAt = Date.now() + 60000;
  const revision = ++artworkRevision;
  const artworkScope = service?.getArtworkScope();
  let loadedUrl: string | null = null;
  // Separate image nodes keep a late load/error from the previous song isolated.
  const image = document.createElement("img");
  image.id = "latest-artwork";
  image.width = image.height = 600;
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.alt = latest
    ? (latest.album || latest.track) + " · " + latest.artist + "的专辑封面"
    : "";
  image.hidden = true;
  element("latest-artwork").replaceWith(image);
  const placeholder = element("artwork-placeholder");
  const label = placeholder.querySelector("span")!;
  placeholder.hidden = false;
  label.textContent = latest ? "正在获取封面…" : "尚无聆听记录";
  const fallback = () => {
    if (revision !== artworkRevision) return;
    image.hidden = true;
    image.removeAttribute("src");
    placeholder.hidden = false;
    label.textContent = latest ? "暂无专辑封面" : "尚无聆听记录";
    artworkRetryAt = Date.now() + 60000;
  };
  image.addEventListener(
    "load",
    () => {
      if (revision !== artworkRevision) return;
      image.hidden = false;
      placeholder.hidden = true;
      artworkRetryAt = Infinity;
    },
    { once: true },
  );
  image.addEventListener(
    "error",
    () => {
      if (revision !== artworkRevision) return;
      if (latest && loadedUrl && artworkScope)
        void service.forgetArtwork(latest, loadedUrl, artworkScope);
      fallback();
    },
    { once: true },
  );
  if (!latest || !artworkLookup(latest) || !snapshot.verified) {
    fallback();
    return;
  }
  void service
    .getArtwork(latest)
    .then((value) => {
      if (revision !== artworkRevision) return;
      const url = safeAlbumArtworkUrl(value);
      if (url) {
        loadedUrl = url;
        image.src = url;
      } else fallback();
    })
    .catch(fallback);
}

function renderRecordArtwork(
  cover: HTMLElement,
  record: Runtime["records"][number],
) {
  if (!artworkLookup(record) || !snapshot.verified) return;
  const previous = recordArtworkAttempts.get(cover);
  if (
    cover.querySelector("img") ||
    previous?.pending ||
    (previous && previous.retryAt > Date.now())
  )
    return;
  const attempt = { pending: true, retryAt: Date.now() + 60000 };
  recordArtworkAttempts.set(cover, attempt);
  const artworkScope = service.getArtworkScope();
  void service
    .getArtwork(record)
    .then((value) => {
      const url = safeAlbumArtworkUrl(value);
      // A refreshed list owns new nodes; never paint the old row again.
      if (!url || !cover.isConnected) return;
      const image = document.createElement("img");
      image.width = image.height = 80;
      image.alt = "";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.hidden = true;
      image.addEventListener(
        "load",
        () => {
          image.hidden = false;
          cover.dataset.artwork = "true";
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          if (
            cover.isConnected &&
            image.isConnected &&
            image.parentElement === cover
          )
            void service.forgetArtwork(record, url, artworkScope);
          image.remove();
          attempt.retryAt = Date.now() + 60000;
          delete cover.dataset.artwork;
        },
        { once: true },
      );
      cover.appendChild(image);
      image.src = url;
    })
    .catch(() => {})
    .finally(() => {
      attempt.pending = false;
    });
}

function retryMissingArtwork() {
  if (element<HTMLImageElement>("latest-artwork").hidden) {
    latestArtworkKey = "";
    artworkRetryAt = 0;
    artworkRevision++;
  }
  element("records")
    .querySelectorAll<HTMLElement>(".record-cover")
    .forEach((cover) => {
      if (!cover.querySelector("img")) recordArtworkAttempts.delete(cover);
    });
}

function renderHistoryLink() {
  const link = element<HTMLAnchorElement>("more-history");
  link.hidden = true;
  link.removeAttribute("href");
  link.removeAttribute("title");
  const username = snapshot.connections?.lastfm.username;
  if (
    !snapshot.verified ||
    !snapshot.fresh ||
    snapshot.error ||
    !snapshot.connections?.lastfm.connected ||
    typeof username !== "string" ||
    !username.trim() ||
    [".", ".."].includes(username.trim())
  )
    return;
  try {
    link.href =
      "https://www.last.fm/user/" + encodeURIComponent(username.trim());
    link.title = "在 Last.fm 查看 " + username.trim() + " 的主页";
    link.hidden = false;
  } catch {
    /* Invalid username text cannot produce a profile link. */
  }
}

function renderRecords() {
  const records = (snapshot.runtime?.records ?? []).slice(0, recentRecordLimit);
  const key = JSON.stringify([
    snapshot.installation?.origin,
    snapshot.installation?.key,
    snapshot.connections?.lastfm.username,
    dayKey(new Date()),
    records.map((record) => [
      record.artist,
      record.track,
      record.album,
      record.status,
      record.timestamp_iso,
      String(record.track_id ?? ""),
      String(record.catalog_id ?? ""),
    ]),
  ]);
  if (key !== lastRecordsKey) {
    lastRecordsKey = key;
    renderRecordRows(records);
  } else {
    // Retry unavailable artwork without replacing already displayed songs/images.
    element("records")
      .querySelectorAll<HTMLElement>(".record-cover")
      .forEach((cover, index) => {
        if (records[index]) renderRecordArtwork(cover, records[index]);
      });
  }
  element("empty-history").hidden = records.length !== 0;
  element("empty-connect").hidden = !!snapshot.installation;
  const emptyConnect = element<HTMLButtonElement>("empty-connect");
  emptyConnect.disabled = snapshot.busy;
  emptyConnect.replaceChildren(
    document.createTextNode(needsConnectionCheck() ? "检查连接" : "开始连接"),
    icon("arrow"),
  );
  const emptyTitle = element("empty-history").querySelector("h3")!;
  emptyTitle.textContent = snapshot.busy
    ? "正在读取聆听记录"
    : needsConnectionCheck()
      ? "先确认你的连接"
      : "等一首歌的时间";
  text(
    "empty-description",
    needsConnectionCheck()
      ? "读取连接状态后，再查看你的聆听记录。"
      : snapshot.runtime?.enabled
        ? "新的播放被记录后，会自然出现在这里。"
        : model().canStart
          ? "开始记录，再播放你喜欢的音乐。"
          : "完成连接后，新的聆听记录会出现在这里。",
  );
  text(
    "history-footnote",
    records.length
      ? `最近 ${records.length} 首${snapshot.fresh ? "" : " · 当前为上次读取的结果"}`
      : `仅保留最近 ${recentRecordLimit} 首`,
  );
}
function renderRecordRows(records: Runtime["records"]) {
  const target = element("records");
  const fragment = document.createDocumentFragment();
  let previousGroup = "";
  const palette = [
    ["#e4e7dd", "#6e7b63"],
    ["#f4dbd3", "#ae6c56"],
    ["#d8e5ed", "#5b7e96"],
    ["#e7dff0", "#8c71a5"],
    ["#f0e7d4", "#9a8255"],
  ];
  records.forEach((record) => {
    const date = validDate(record.timestamp_iso);
    const group = date ? dateLabel(date) : "时间未提供";
    if (group !== previousGroup) {
      const label = document.createElement("h3");
      label.className = "record-group-label";
      label.textContent = group;
      if (date) {
        const day = document.createElement("span");
        day.textContent = date.toLocaleDateString("zh-CN", { weekday: "long" });
        label.appendChild(day);
      }
      fragment.appendChild(label);
      previousGroup = group;
    }
    const row = document.createElement("article");
    row.className = "record-row";
    const cover = document.createElement("span");
    cover.className = "record-cover";
    cover.setAttribute("aria-hidden", "true");
    const index =
      Array.from(record.artist).reduce(
        (hash, value) => hash + value.charCodeAt(0),
        0,
      ) % palette.length;
    cover.style.setProperty("--cover-bg", palette[index][0]);
    cover.style.setProperty("--cover-fg", palette[index][1]);
    cover.appendChild(icon("music"));
    renderRecordArtwork(cover, record);
    const details = document.createElement("div");
    details.className = "record-track";
    const title = document.createElement("p");
    title.className = "record-title";
    title.textContent = record.track;
    title.title = record.track;
    const subtitle = document.createElement("p");
    subtitle.className = "record-subtitle";
    subtitle.textContent =
      record.artist + (record.album ? " · " + record.album : "");
    subtitle.title = subtitle.textContent;
    details.appendChild(title);
    details.appendChild(subtitle);
    const artist = document.createElement("p");
    artist.className = "record-artist";
    artist.textContent = record.artist;
    artist.title = record.artist;
    const meta = document.createElement("div");
    meta.className = "record-meta";
    if (record.status === "pending") {
      const pending = document.createElement("span");
      pending.className = "record-pending";
      pending.textContent = "待处理";
      meta.appendChild(pending);
    }
    const time = document.createElement("time");
    if (date) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      time.title = date.toLocaleString("zh-CN");
    } else time.textContent = "—";
    meta.appendChild(time);
    row.appendChild(cover);
    row.appendChild(details);
    row.appendChild(artist);
    row.appendChild(meta);
    fragment.appendChild(row);
  });
  target.replaceChildren(fragment);
}

async function copy(button: HTMLButtonElement, kind: EmilCopyInfo) {
  text("sheet-feedback", "");
  text("settings-feedback", "");
  element("toast").hidden = true;
  clearTimeout(toastTimer);
  lastCopy = { kind, button };
  await perform(
    "",
    () => service.copyInfo(kind),
    () => {
      lastCopy = null;
      const message =
        kind === "key"
          ? "管理钥匙已复制，请妥善保管"
          : kind === "homepage"
            ? "Homepage 已复制"
            : "Callback URL 已复制";
      text(sheet.open ? "sheet-feedback" : "settings-feedback", message);
      notify(message);
    },
  );
}
function recover() {
  if (initialLoadFailed && !snapshot.installation) {
    continueSetup();
    return;
  }
  const recovery = currentError()?.recovery;
  if (recovery === "backend_update") {
    beginBackendUpdate();
    return;
  }
  if (recovery === "retry-copy" && lastCopy) {
    void copy(lastCopy.button, lastCopy.kind);
    return;
  }
  if (recovery === "cloud" || recovery === "apple" || recovery === "lastfm") {
    if (recovery === "cloud")
      element<HTMLDetailsElement>("cloud-token-guide").open = true;
    if (recovery === "lastfm" && recordingIssue(snapshot.runtime)) {
      reconfigureLastfm = false;
      lastfmRecoveryMode = true;
    }
    openSetup(recovery);
    return;
  }
  if (recovery === "settings") {
    closeSetup();
    goToPage("settings");
    return;
  }
  void perform("正在检查", () => service.refresh({ permission: true }));
}

document
  .querySelectorAll<HTMLButtonElement>("[data-page]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      goToPage(button.dataset.page as Page),
    ),
  );
document.querySelectorAll<HTMLButtonElement>("[data-setup]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.setup === "cloud" && needsConnectionCheck())
      continueSetup();
    else openSetup(button.dataset.setup as Step);
  }),
);
document
  .querySelectorAll<HTMLButtonElement>("[data-step], [data-continue]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      goToStep((button.dataset.step || button.dataset.continue) as Step),
    ),
  );
element("top-status").addEventListener("click", () =>
  recordingIssue(snapshot.runtime) && model().canPause
    ? openSetup("confirm", "recording")
    : currentError()
      ? recover()
      : needsConnectionCheck()
        ? continueSetup()
        : model().canVisit.confirm
          ? openSetup("confirm", "recording")
          : openSetup(),
);
element("continue-setup").addEventListener("click", continueSetup);
element("empty-connect").addEventListener("click", continueSetup);
element("close-sheet").addEventListener("click", closeSetup);
sheet.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSetup();
});
sheet.addEventListener("click", (event) => {
  if (event.target !== sheet) return;
  const bounds = sheet.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    closeSetup();
});
element("recording-action").addEventListener("click", () => {
  if (snapshot.runtime?.enabled) pauseRecording();
  else if (model().canStart) startRecording();
  else if (recordingIssue(snapshot.runtime)) recover();
  else continueSetup();
});
element("pause-recording").addEventListener("click", () =>
  pauseRecording(true),
);
element("refresh").addEventListener("click", () => {
  void perform(
    "正在检查",
    () => service.refresh({ permission: true }),
    () => notify("连接状态已更新"),
  );
});
element("error-recovery").addEventListener("click", recover);
element("sheet-recovery").addEventListener("click", recover);
element("apple-error-recovery").addEventListener("click", recover);
element("skip-token-guide").addEventListener("click", () => {
  element<HTMLDetailsElement>("cloud-token-guide").open = false;
  element<HTMLInputElement>("cloud-token").focus();
  element("cloud-token-entry").scrollIntoView?.({ block: "center" });
});
element("load-accounts").addEventListener("click", () => {
  void perform("正在连接 Cloudflare", async () => {
    const input = element<HTMLInputElement>("cloud-token");
    const accounts = await service.cloudAccounts(input.value);
    input.value = "";
    const select = element<HTMLSelectElement>("cloud-account");
    select.replaceChildren(
      ...accounts.map((account) => new Option(account.name, account.id)),
    );
    if (backendUpdateMode) {
      select.value = snapshot.installation?.account ?? "";
      for (const option of Array.from(select.options))
        option.disabled = option.value !== snapshot.installation?.account;
    }
    element("cloud-account-selection").hidden = false;
    element<HTMLDetailsElement>("cloud-token-guide").open = false;
    text(
      "sheet-feedback",
      backendUpdateMode
        ? select.value === snapshot.installation?.account
          ? "Token 已验证。已锁定原部署账户，点击「" +
            (cloudReconnectMode ? "连接并继续" : "更新个人后台") +
            "」继续。"
          : "这个 Token 未包含原部署账户。请在 Cloudflare 核对 Account Resources 后重新验证。"
        : "Token 已验证。请选择与官网 Account Resources 相同的账户，再点击「安装个人后台」。",
    );
    renderSheet();
    if (backendUpdateMode) {
      if (select.value === snapshot.installation?.account)
        element<HTMLButtonElement>("deploy").focus();
      else input.focus();
    } else select.focus();
    element("cloud-account-selection").scrollIntoView?.({ block: "center" });
  });
});
element<HTMLFormElement>("cloud-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const updating = backendUpdateMode;
  const reconnecting = cloudReconnectMode;
  void perform(updating ? "正在更新后台" : "正在安装后台", async () => {
    const account = element<HTMLSelectElement>("cloud-account").value;
    if (updating) await service.updateBackend("", account);
    else await service.deploy("", account);
    retryMissingArtwork();
    element("cloud-account-selection").hidden = true;
    element("install-progress").hidden = true;
    showCloudForm = false;
    backendUpdateMode = false;
    cloudReconnectMode = false;
    goToStep(updating ? model().nextStep : "apple");
    notify(
      reconnecting
        ? "Cloudflare 已重新连接，个人后台已更新"
        : updating
          ? "个人后台已更新，继续连接音乐"
          : "个人后台已安装，继续连接音乐",
    );
  });
});
element("show-cloud-form").addEventListener("click", () => {
  if (snapshot.busy) return;
  backendUpdateMode = !!snapshot.installation?.origin;
  cloudReconnectMode = backendUpdateMode;
  showCloudForm = true;
  element<HTMLInputElement>("cloud-token").value = "";
  element<HTMLSelectElement>("cloud-account").replaceChildren();
  element("cloud-account-selection").hidden = true;
  element("install-progress").hidden = true;
  element("sheet-feedback").textContent = "";
  element<HTMLDetailsElement>("cloud-token-guide").open = true;
  renderSheet();
  sheet.scrollTo?.({ top: 0 });
  focusSheetTitle();
});
element("update-backend").addEventListener("click", beginBackendUpdate);
element("connect-apple").addEventListener("click", () => {
  void perform(
    "正在连接 Apple Music",
    () => service.connectApple(),
    () => {
      notify("Apple Music 已连接");
      goToStep("lastfm");
    },
  );
});
element<HTMLFormElement>("lastfm-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void perform("正在保存应用", async () => {
    const key = element<HTMLInputElement>("lastfm-key");
    const secret = element<HTMLInputElement>("lastfm-secret");
    await service.saveLastfmApplication(key.value, secret.value);
    key.value = "";
    secret.value = "";
    text("sheet-feedback", "应用配置已保存，接下来允许 Last.fm 账户连接。");
    notify("Last.fm 应用配置已保存");
  });
});
for (const id of ["reconfigure-lastfm", "reconfigure-lastfm-recovery"])
  element(id).addEventListener("click", () => {
    reconfigureLastfm = true;
    lastfmRecoveryMode = false;
    renderSheet();
    focusSheetTitle();
  });
element("authorize-lastfm").addEventListener("click", () => {
  lastFocusRefresh = 0;
  void perform(
    "正在打开授权",
    () => service.authorizeLastfm(),
    () =>
      text(
        "sheet-feedback",
        "请在 Last.fm 官网同意连接，完成后会自动回到余音。",
      ),
  );
});
element("check-authorization").addEventListener("click", () => {
  void perform(
    "正在检查授权",
    () => service.refresh({ permission: true }),
    () => {
      if (recordingIssue(snapshot.runtime)?.code === "queue_account_changed") {
        lastfmRecoveryMode = true;
        renderSheet();
        text(
          "sheet-feedback",
          "授权已返回，原账户的待提交歌曲仍需处理。请按照下方提示连接原 Last.fm 账户。",
        );
      } else if (snapshot.connections?.lastfm.connected) {
        reconfigureLastfm = false;
        goToStep("confirm");
        notify(
          model().canVisit.confirm
            ? "设置已完成，可以开始记录"
            : "Last.fm 已连接，请继续完成其他连接",
        );
      } else
        text(
          "sheet-feedback",
          "还没有读到授权结果，请在 Last.fm 官网同意连接后再检查。",
        );
    },
  );
});
document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) =>
  button.addEventListener("click", () => {
    void copy(button, button.dataset.copy as EmilCopyInfo);
  }),
);
function startRecording() {
  if (!model().canStart) return;
  const username = snapshot.connections?.lastfm.username;
  if (!username) return;
  void perform(
    "正在开启记录",
    () => service.startRecording(username),
    () => {
      if (!snapshot.runtime?.enabled) {
        text(
          "sheet-feedback",
          "已读取最新后台状态，记录仍处于暂停。请重试开启。",
        );
        return;
      }
      closeSetup();
      goToPage("journal");
      notify("记录已开启，去听点喜欢的音乐吧");
    },
  );
}
for (const id of ["start-recording", "start-recording-lastfm"])
  element(id).addEventListener("click", startRecording);

const theme = createThemeController({
  onChange: (value) => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-theme-choice]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.themeChoice === value.preference),
        ),
      );
    text(
      "theme-feedback",
      value.persistence === "unavailable"
        ? "已应用于本页，浏览器暂时无法保存偏好。"
        : "外观偏好仅保存在当前浏览器。",
    );
  },
});
document
  .querySelectorAll<HTMLButtonElement>("[data-theme-choice]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      void theme.setPreference(
        button.dataset.themeChoice as "system" | "light" | "dark",
      );
    }),
  );
document
  .querySelectorAll<HTMLElement>(
    "button:not([data-page]):not([data-theme-choice]), .brand",
  )
  .forEach((button) => {
    button.dataset.pressable = "";
  });
const cleanupPress = installPressFeedback(document.body);
service = createEmilService({
  onChange: (value) => {
    const priorIssue = recordingIssue(snapshot.runtime);
    const recoveredLastfm =
      lastfmRecoveryMode &&
      priorIssue &&
      ["queue_account_changed", "lastfm_reconnect_required"].includes(
        priorIssue.code,
      ) &&
      !recordingIssue(value.runtime);
    const authorizationCompleted =
      sheet.open &&
      sheetWanted &&
      currentStep === "lastfm" &&
      (!snapshot.connections?.lastfm.connected || recoveredLastfm) &&
      value.fresh &&
      value.verified &&
      value.connections?.apple.connected &&
      value.connections.lastfm.connected &&
      !recordingIssue(value.runtime);
    const editingApplication = element("lastfm-form").contains(
      document.activeElement,
    );
    // An authorization tab may finish after the user opens a new application form.
    // Keep that form and its focus intact instead of hiding their current work.
    if (authorizationCompleted && editingApplication) reconfigureLastfm = true;
    const setupCompleted =
      authorizationCompleted &&
      !editingApplication &&
      (!reconfigureLastfm || lastfmRecoveryMode);
    if (setupCompleted) {
      reconfigureLastfm = false;
      lastfmRecoveryMode = false;
      currentStep = "confirm";
      sheetMode = "setup";
      element("sheet-feedback").textContent = "";
    }
    snapshot = value;
    if (!value.error) initialLoadFailed = false;
    render();
    if (setupCompleted) {
      sheet.scrollTo?.({ top: 0 });
      focusSheetTitle();
    }
  },
  onProgress: (message) => {
    element("install-progress").hidden = false;
    text("install-progress", message);
  },
});
void service.ready
  .catch(() => {
    initialLoadFailed = true;
  })
  .finally(() => {
    if (initialRoutingPending) goToPage(defaultPage(), false);
    initialRoutingPending = false;
    element("startup-state").hidden = true;
    document.body.removeAttribute("data-initializing");
    updateNavigation(true);
    render();
  });
function refreshOnReturn() {
  if (
    document.hidden ||
    snapshot.busy ||
    focusRefreshPending ||
    Date.now() - lastFocusRefresh < 3000
  )
    return;
  focusRefreshPending = true;
  lastFocusRefresh = Date.now();
  void service
    .refresh()
    .catch(() => {})
    .finally(() => {
      focusRefreshPending = false;
    });
}
// Check for new records while this page is visible; metadata reads never start recording.
const journalRefreshTimer = setInterval(() => {
  if (currentPage === "journal" && !sheet.open) refreshOnReturn();
}, 30000);
window.addEventListener("focus", refreshOnReturn);
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("resize", () => updateNavigation(true));
window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);
  if (pages.includes(page as Page)) {
    initialRoutingPending = false;
    goToPage(page as Page, false);
  }
});
window.addEventListener(
  "pagehide",
  () => {
    service.dispose();
    cleanupPress();
    navSpring.cancel();
    sheetSpring.cancel();
    theme.destroy();
    clearTimeout(toastTimer);
    clearInterval(journalRefreshTimer);
    artworkRevision++;
  },
  { once: true },
);
const initialPage = location.hash.slice(1);
goToPage(
  pages.includes(initialPage as Page) ? (initialPage as Page) : "journal",
  false,
);
updateNavigation(true);
render();
