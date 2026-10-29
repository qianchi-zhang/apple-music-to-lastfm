import { CloudflareError } from "./cloudflare";
import { algorithmVersion, previousAlgorithm } from "./algorithm-release";

export interface UiError {
  title: string;
  detail: string;
  openAppleMusic?: true;
  recovery:
    | "retry"
    | "retry-copy"
    | "cloud"
    | "apple"
    | "lastfm"
    | "backend_update"
    | "refresh"
    | "settings";
  action: string;
}

export class ServiceError extends Error {
  constructor(
    public code: string,
    public status?: number,
  ) {
    super(code);
    this.name = "ServiceError";
  }
}

const messages: Record<string, UiError> = {
  apple_tab_missing: {
    title: "请先打开 Apple Music",
    detail:
      "没有找到 Apple Music 官网标签页。请在同一 Chrome 打开 music.apple.com 并登录，等音乐内容加载完成后，回到这里重新连接。",
    recovery: "apple",
    action: "打开 Apple Music 后重新连接",
    openAppleMusic: true,
  },
  wrong_tab: {
    title: "Apple Music 页面已离开",
    detail:
      "连接时原标签页已离开 Apple Music 官网。请在同一 Chrome 重新打开 music.apple.com 并登录，等音乐内容加载完成后再连接。",
    recovery: "apple",
    action: "检查 Apple Music 页面",
    openAppleMusic: true,
  },
  not_signed_in: {
    title: "请先登录 Apple Music",
    detail:
      "在同一 Chrome 打开 Apple Music 官网并登录，等音乐内容出现后回到这里连接。",
    recovery: "apple",
    action: "前往 Apple Music 连接",
    openAppleMusic: true,
  },
  not_ready: {
    title: "Apple Music 还未准备好",
    detail: "请等待 Apple Music 官网加载音乐内容，再回来重新连接。",
    recovery: "apple",
    action: "检查 Apple Music 页面",
    openAppleMusic: true,
  },
  tokens_unavailable: {
    title: "暂时无法读取 Apple Music 连接信息",
    detail:
      "请刷新已登录的 Apple Music 官网，等页面加载完成后重新连接；仍失败时可重新登录再试。",
    recovery: "apple",
    action: "重新连接 Apple Music",
  },
  capture_failed: {
    title: "未能读取 Apple Music 页面",
    detail:
      "请确认同一 Chrome 已打开并登录 Apple Music 官网，刷新页面后回到这里连接。",
    recovery: "apple",
    action: "检查 Apple Music 页面",
  },
  apple_tabs: {
    title: "请保留一个 Apple Music 官网标签页",
    detail:
      "在同一 Chrome 登录 music.apple.com，只保留一个官网标签页，确认是要连接的账户后再试。",
    recovery: "apple",
    action: "检查 Apple Music 标签页",
  },
  cloud_token: {
    title: "请先连接 Cloudflare",
    detail:
      "填写仅限部署账户的有效 API Token，连接后选择账户，再继续安装个人后台。",
    recovery: "cloud",
    action: "连接 Cloudflare",
  },
  deployment_origin_changed: {
    title: "部署账户的网址已变化",
    detail:
      "Cloudflare 账户的 workers.dev 网址与验证时不一致。请重新验证 Token，准备对应网址的访问权限，再安装个人后台。",
    recovery: "cloud",
    action: "重新验证 Token",
  },
  install_busy: {
    title: "另一个扩展页面正在安装",
    detail:
      "请等待另一个页面完成，不要同时安装。完成后回到原页面检查后台状态。",
    recovery: "cloud",
    action: "查看后台设置",
  },
  install_conflict: {
    title: "安装账户与原记录不一致",
    detail:
      "请保留现有服务和安装信息，核对原来的 Cloudflare 账户后继续，不要重新创建服务。",
    recovery: "settings",
    action: "核对安装信息",
  },
  missing_asset: {
    title: "安装包缺少后台代码",
    detail:
      "请重新取得维护者提供的完整扩展安装包。保留现有安装信息，不要删除云端服务或存储。",
    recovery: "settings",
    action: "查看安装包说明",
  },
  clipboard_unavailable: {
    title: "浏览器未允许复制",
    detail:
      "未能将内容复制到剪贴板。请检查浏览器的复制权限，允许后再点击复制；不要把管理钥匙发到聊天中。",
    recovery: "retry-copy",
    action: "重试复制",
  },
  invalid_response: {
    title: "暂时无法确认后台返回结果",
    detail:
      "返回内容不完整或无法读取，操作结果尚未确认。请先检查当前后台状态，再决定是否重试。",
    recovery: "refresh",
    action: "检查后台状态",
  },
  backend_unavailable: {
    title: "个人后台暂时不可用",
    detail:
      "暂时无法确认个人后台状态。请保留现有安装和连接，稍后检查状态，不要重复安装。",
    recovery: "refresh",
    action: "检查后台状态",
  },
  backend_update_required: {
    title: "个人后台需要更新",
    detail:
      "当前后台尚不支持在此完成 Last.fm 连接。请重新验证原部署账户的 Cloudflare Token，再更新现有后台；已有连接和记录会保留。",
    recovery: "backend_update",
    action: "更新个人后台",
  },
  backend_upgrade_required: {
    title: "个人后台需要升级",
    detail: `当前个人后台使用 ${previousAlgorithm.version}。请重新连接 Cloudflare，将现有后台升级到 ${algorithmVersion}；已有账户、连接、存储和聆听记录都会保留。`,
    recovery: "backend_update",
    action: "重新连接 Cloudflare",
  },
  backend_update_pending: {
    title: "正在等待后台更新生效",
    detail:
      "后台代码已上传，暂时还没有读到新版功能。请稍后检查后台状态，已有连接和记录会保留，无需重复安装或重新授权。",
    recovery: "refresh",
    action: "检查后台状态",
  },
  backend_update_missing: {
    title: "未找到原来的个人后台",
    detail:
      "原服务或完整安装信息缺失，尚未更新。请保留本地安装信息，核对原 Cloudflare 账户和服务，不要重新创建后台或存储。",
    recovery: "settings",
    action: "核对原后台",
  },
  backend_update_conflict: {
    title: "后台与原安装信息不一致",
    detail:
      "服务归属、算法或存储绑定与原安装不符，已停止更新。请核对原 Cloudflare 账户和服务，保留现有连接与存储。",
    recovery: "settings",
    action: "核对原后台",
  },
  backend_update_invalid: {
    title: "暂时无法核对后台配置",
    detail:
      "Cloudflare 返回的配置不完整，尚未上传更新。请稍后重试，保留原服务、连接和安装信息。",
    recovery: "backend_update",
    action: "重新核对后台",
  },
  account_changed: {
    title: "Last.fm 账户已变化",
    detail: "请先检查最新连接状态，核对提交账户后再开始记录。",
    recovery: "refresh",
    action: "检查连接状态",
  },
  queue_account_changed: {
    title: "有待处理的原账户记录",
    detail:
      "记录已暂停。请重新连接原 Last.fm 账户，再开始记录。原账户的待提交歌曲会保留，不会提交到新账户。",
    recovery: "lastfm",
    action: "重新连接原 Last.fm 账户",
  },
  connections_required: {
    title: "需要检查音乐账户连接",
    detail:
      "请先检查 Apple Music 和 Last.fm 两个账户；需要重新连接时，从对应步骤继续。",
    recovery: "apple",
    action: "检查账户连接",
  },
  invalid_application: {
    title: "请检查 Last.fm 应用配置",
    detail:
      "需要填写自己的 API Key 和 Shared Secret，不要填写 Last.fm 账户密码。",
    recovery: "lastfm",
    action: "检查 Last.fm 应用",
  },
  lastfm_application_missing: {
    title: "尚未配置 Last.fm 应用",
    detail: "先申请并保存自己的 Last.fm API 应用，再到官网允许账户连接。",
    recovery: "lastfm",
    action: "配置 Last.fm 应用",
  },
  cancelled: {
    title: "Last.fm 授权已取消",
    detail: "尚未完成这次账户连接。准备好后，可从这里重新打开 Last.fm 授权。",
    recovery: "lastfm",
    action: "重新授权 Last.fm",
  },
  invalid_flow: {
    title: "Last.fm 授权流程已失效",
    detail:
      "本次授权与当前连接流程不匹配，或已被新流程替代。请从当前页面重新发起授权，不要继续使用旧授权标签页。",
    recovery: "lastfm",
    action: "重新授权 Last.fm",
  },
  lastfm_expired: {
    title: "Last.fm 临时授权已失效",
    detail:
      "本次临时授权已过期或无法使用。请从这里重新发起授权，并在 Last.fm 官网完成允许。",
    recovery: "lastfm",
    action: "重新授权 Last.fm",
  },
  application_changed: {
    title: "Last.fm 应用配置已变化",
    detail:
      "授权期间的 API 应用与当前保存的配置不一致。请核对当前 API Key 和 Shared Secret，再重新发起授权。",
    recovery: "lastfm",
    action: "检查 Last.fm 应用",
  },
  lastfm_unavailable: {
    title: "Last.fm 暂时无法完成连接",
    detail:
      "请求中断、超时或 Last.fm 服务暂时不可用。请稍后重新授权，无需重新安装个人后台。",
    recovery: "lastfm",
    action: "稍后重新授权",
  },
  lastfm_invalid_application: {
    title: "Last.fm 未接受 API 应用配置",
    detail:
      "请核对同一个 Last.fm API 应用的 API Key 和 Shared Secret，确认应用可用；保存正确配置后重新授权。",
    recovery: "lastfm",
    action: "检查 Last.fm 应用",
  },
  lastfm_not_authorized: {
    title: "Last.fm 尚未允许账户连接",
    detail:
      "Last.fm 未确认本次应用授权。请重新打开授权页面，核对账号并点击允许后继续。",
    recovery: "lastfm",
    action: "重新授权 Last.fm",
  },
  lastfm_invalid_response: {
    title: "暂时无法确认 Last.fm 返回结果",
    detail:
      "Last.fm 返回的账户或会话信息不完整，尚未确认连接。请稍后从这里重新授权。",
    recovery: "lastfm",
    action: "重新授权 Last.fm",
  },
  save_failed: {
    title: "Last.fm 连接未能保存",
    detail:
      "授权已返回，但个人后台未能保存连接信息。请先检查当前连接状态；仍未连接时，再从这里重新授权。",
    recovery: "lastfm",
    action: "检查 Last.fm 连接",
  },
  lastfm_not_connected: {
    title: "Last.fm 连接尚未确认",
    detail:
      "授权页面已返回，但个人后台尚未确认有效的账户连接。请检查当前状态；仍未连接时重新授权。",
    recovery: "lastfm",
    action: "检查 Last.fm 连接",
  },
  lastfm_open_failed: {
    title: "未能打开 Last.fm 授权页",
    detail:
      "浏览器没有打开授权标签页。请保留当前页面，重新点击 Last.fm 授权；尚未开启记录。",
    recovery: "lastfm",
    action: "重新打开授权",
  },
  invalid_credentials: {
    title: "Apple Music 连接信息不完整",
    detail: "请在 Apple Music 官网登录，等音乐内容加载完成后重新连接。",
    recovery: "apple",
    action: "重新连接 Apple Music",
  },
  apple_rejected: {
    title: "Apple Music 未接受这次连接",
    detail:
      "请在 Apple Music 官网重新登录，并确认账户可以使用 Apple Music，然后重新连接。",
    recovery: "apple",
    action: "重新连接 Apple Music",
  },
  apple_unavailable: {
    title: "Apple Music 暂时不可用",
    detail:
      "暂时无法检查 Apple Music 连接。请保留现有连接并稍后重试，无需重新安装后台。",
    recovery: "apple",
    action: "稍后重试 Apple Music",
  },
  apple_invalid_response: {
    title: "暂时无法确认 Apple Music 返回结果",
    detail:
      "Apple Music 返回的信息不完整，暂时无法确认连接状态。请保留现有连接，稍后重试；仍失败时再重新连接。",
    recovery: "apple",
    action: "检查 Apple Music 连接",
  },
  unauthorized: {
    title: "需要重新打开个人后台",
    detail:
      "管理钥匙可能无效，或后台会话已过期。请使用备份的管理钥匙检查后台连接。",
    recovery: "settings",
    action: "检查后台设置",
  },
  invalid_key: {
    title: "请检查管理钥匙",
    detail:
      "未能验证管理钥匙。它不是 Apple Music 或 Last.fm 的登录密码，请使用这个后台对应的备份钥匙。",
    recovery: "settings",
    action: "检查后台设置",
  },
  permission_denied: {
    title: "尚未允许访问服务",
    detail:
      "浏览器尚未允许访问本次连接所需的网站。连接 Cloudflare 时，请重新验证 Token 并允许 Cloudflare API 和个人后台网址；连接 Apple Music 时，请重新点击连接并允许 Apple Music 官网；检查已有后台时，请允许该后台网址。",
    recovery: "refresh",
    action: "允许访问并检查状态",
  },
  version_mismatch: {
    title: "后台版本与扩展不匹配",
    detail:
      "已停止操作。请检查安装包与后台版本；不要通过重复安装覆盖原有服务。",
    recovery: "settings",
    action: "检查后台版本",
  },
  http_429: {
    title: "服务暂时限制了请求次数",
    detail: "请稍后重试，并先检查当前状态。无需更改账户配置或重新安装后台。",
    recovery: "retry",
    action: "稍后重试",
  },
};

const networkError: UiError = {
  title: "操作结果未确认",
  detail:
    "网络请求中断或超时，暂时无法确认操作是否已完成。请先检查后台状态，再决定是否重试；不要反复安装或开启记录。",
  recovery: "refresh",
  action: "先检查当前状态",
};
const unknownError: UiError = {
  title: "暂时无法完成操作",
  detail:
    "操作结果尚未确认。请先检查当前状态；仍无法继续时，保留现有服务和配置，查看恢复说明。",
  recovery: "refresh",
  action: "检查当前状态",
};
const cloudToken: UiError = {
  title: "请检查 Cloudflare Token",
  detail:
    "请使用仅限部署账户的有效 API Token，核对 Workers Scripts 编辑、Workers KV Storage 编辑及 Account Settings 读取权限。",
  recovery: "cloud",
  action: "检查 Cloudflare 配置",
};
const cloudConflict: UiError = {
  title: "安装状态需要核对",
  detail:
    "服务标记或存储状态与本次安装不一致，已停止继续安装。请保留现有服务，核对原账户及安装信息，不要删除存储或重新部署。",
  recovery: "settings",
  action: "检查安装信息",
};

function cloudflareUiError(error: CloudflareError): UiError {
  // Revalidate numeric diagnostics before displaying them; upstream text is ignored.
  const safe = new CloudflareError(error.code, error.status, error.errorCodes);
  if (safe.status === 429) return { ...messages.http_429 };
  let result: UiError;
  switch (safe.code) {
    case "token_format":
      return {
        title: "API Token 格式不完整",
        detail:
          "请复制 Cloudflare 创建成功页的完整 Token 值，去掉 Bearer 前缀或测试命令，再点击「验证 Token」。",
        recovery: "cloud",
        action: "重新填写 Token",
      };
    case "token_expired":
      return {
        title: "Cloudflare Token 已过期",
        detail:
          "Cloudflare 确认此 Token 已过期。请在官网创建一个有效的用户 API Token，直接填入此处，再重新验证。",
        recovery: "cloud",
        action: "更换已过期的 Token",
      };
    case "token_disabled":
      return {
        title: "Cloudflare Token 已停用",
        detail:
          "Cloudflare 确认此 Token 已停用。请在官网检查令牌状态，改用有效的用户 API Token，再重新验证。",
        recovery: "cloud",
        action: "检查 Token 状态",
      };
    case "token_http":
      result =
        safe.status === 401 || safe.status === 403
          ? {
              title: "Cloudflare 未接受此 Token",
              detail:
                "Token 有效性检查被拒绝，尚未进入账户权限检查。请从官网创建成功页重新复制完整的用户 API Token，并检查它是否已撤销或失效。",
              recovery: "cloud",
              action: "检查 Token 本身",
            }
          : {
              title: "Cloudflare Token 检查暂时失败",
              detail:
                "暂时无法取得 Token 的有效状态。请稍后重新验证；当前没有开始安装后台。",
              recovery: "cloud",
              action: "重新验证 Token",
            };
      break;
    case "token_platform":
      result = {
        title: "Cloudflare 未通过 Token 验证",
        detail:
          "Cloudflare 在 Token 有效性检查时返回错误，尚未进入账户查询。请核对官网令牌状态和完整 Token 值，再重新验证。",
        recovery: "cloud",
        action: "检查 Token 本身",
      };
      break;
    case "token_invalid":
      result = {
        title: "暂时无法确认 Token 状态",
        detail:
          "Cloudflare 没有返回可识别的 Token 状态，尚未进入账户查询。请稍后重新验证；当前没有开始安装后台。",
        recovery: "cloud",
        action: "重新验证 Token",
      };
      break;
    case "accounts_empty":
      return {
        title: "Token 没有可用的部署账户",
        detail:
          "Token 有效性检查已通过，但账户查询没有返回可用账户。请核对 Account Resources 包含部署账户，以及 Account Settings 读取权限，再重新验证。",
        recovery: "cloud",
        action: "检查 Token 账户范围",
      };
    case "accounts_limit":
      return {
        title: "Token 包含的账户过多",
        detail:
          "请在 Cloudflare 将 Token 的 Account Resources 限定到本次部署的一个账户，再重新验证。",
        recovery: "cloud",
        action: "检查 Token 账户范围",
      };
    case "accounts_invalid":
      result = {
        title: "Cloudflare 账户响应无法读取",
        detail:
          "账户列表返回的信息不完整，暂时无法确认部署账户。请稍后重新验证 Token。",
        recovery: "cloud",
        action: "重新验证 Token",
      };
      break;
    case "accounts_platform":
      result = {
        title: "Cloudflare 未接受账户查询",
        detail:
          "Token 有效性检查已通过，但平台返回账户查询错误。请核对 Token 的账户范围和 Account Settings 读取权限，再重新验证。",
        recovery: "cloud",
        action: "检查 Cloudflare 配置",
      };
      break;
    case "accounts_http":
      result =
        safe.status === 401 || safe.status === 403
          ? {
              title: "Token 已验证，但无权读取账户",
              detail:
                "Token 有效性检查已通过，但读取部署账户被拒绝。请在官网确认 Account Settings 为读取权限，并在 Account Resources 中包含要部署的账户，再重新验证。",
              recovery: "cloud",
              action: "检查 Token 账户权限",
            }
          : {
              title: "Cloudflare 账户读取失败",
              detail:
                "暂时未能取得部署账户。请稍后重新验证 Token；无需重复安装个人后台。",
              recovery: "cloud",
              action: "重新验证 Token",
            };
      break;
    case "install_http":
      result =
        safe.status === 401 || safe.status === 403
          ? {
              ...cloudToken,
              title: "Cloudflare 拒绝了后台安装请求",
              detail:
                "安装请求被拒绝。请核对所选部署账户、Token 有效期，以及 Workers Scripts 和 Workers KV Storage 的编辑权限。保留本次安装信息，修正后继续。",
            }
          : {
              title: "Cloudflare 后台安装请求失败",
              detail:
                "Cloudflare 未完成当前安装步骤。请保留进度和本次安装信息，根据状态码检查账户服务后继续原安装。",
              recovery: "cloud",
              action: "检查 Cloudflare 配置",
            };
      break;
    case "install_platform":
      result = {
        title: "Cloudflare 未完成后台安装",
        detail:
          "Cloudflare 在安装过程中返回错误。请保留当前进度、平台错误代码和本次安装信息，检查账户服务后继续原安装。",
        recovery: "cloud",
        action: "检查 Cloudflare 配置",
      };
      break;
    case "install_invalid":
      result = {
        title: "后台安装结果尚未确认",
        detail:
          "Cloudflare 返回的信息不完整。请保留本次安装信息并先检查当前状态，再继续原安装。",
        recovery: "refresh",
        action: "检查当前状态",
      };
      break;
    case "update_http":
      result = {
        title:
          safe.status === 401 || safe.status === 403
            ? "Cloudflare 拒绝了后台更新请求"
            : "Cloudflare 后台更新请求失败",
        detail:
          safe.status === 401 || safe.status === 403
            ? "请核对原部署账户、Token 有效期和 Workers Scripts 编辑权限，再更新同一个后台。保留原服务和存储。"
            : "更新结果尚未确认。请先检查当前后台状态，再重试更新；保留原服务和存储。",
        recovery: "backend_update",
        action: "检查后台更新",
      };
      break;
    case "update_platform":
      result = {
        title: "Cloudflare 未完成后台更新",
        detail:
          "Cloudflare 返回更新错误。请保留平台错误代码和原安装信息，核对原服务后重试，不要新建后台或存储。",
        recovery: "backend_update",
        action: "检查后台更新",
      };
      break;
    case "update_invalid":
      result = {
        title: "后台更新结果尚未确认",
        detail:
          "Cloudflare 返回的信息不完整。请先检查现有后台状态，保留连接和原安装信息，再决定是否重试更新。",
        recovery: "refresh",
        action: "检查当前状态",
      };
      break;
    default:
      return { ...unknownError };
  }
  const diagnostics = [
    ...(safe.status === undefined ? [] : ["HTTP " + safe.status]),
    ...(safe.errorCodes.length
      ? ["Cloudflare 代码 " + safe.errorCodes.join("、")]
      : []),
  ];
  if (diagnostics.length) result.detail += "（" + diagnostics.join("；") + "）";
  return result;
}

/** Only fixed, known messages reach the UI. Never echo upstream error text. */
export function toUiError(error: unknown): UiError {
  if (error instanceof CloudflareError) return cloudflareUiError(error);
  const code = error instanceof ServiceError ? error.code : undefined;
  if (code && Object.hasOwn(messages, code)) return { ...messages[code] };
  if (error instanceof ServiceError && error.status === 429)
    return { ...messages.http_429 };

  if (error instanceof Error) {
    if (
      error instanceof TypeError ||
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      error.message === "network_error"
    )
      return { ...networkError };

    if (Object.hasOwn(messages, error.message))
      return { ...messages[error.message] };

    // These strings are emitted by the local installer, not displayed verbatim.
    if (/^Cloudflare 操作失败（HTTP 429）。/.test(error.message))
      return { ...messages.http_429 };
    if (/^Cloudflare 操作失败（HTTP 403）。/.test(error.message))
      return { ...cloudToken };
    if (
      [
        "请填写完整的 Cloudflare API Token。",
        "未找到可用账户，请检查 Token 的 Account Settings 读取权限。",
        "账户过多，请把 Token 限制到要部署的一个账户后重试。",
      ].includes(error.message)
    )
      return { ...cloudToken };
    if (
      error.message ===
      "请先在 Cloudflare 的 Workers & Pages 设置 workers.dev 子域名，再回来重试。"
    )
      return {
        title: "先准备 Cloudflare 服务网址",
        detail:
          "此账户尚未配置 workers.dev 子域名。请在 Cloudflare 的 Workers & Pages 完成设置，再回到这里继续原安装。",
        recovery: "cloud",
        action: "前往 Cloudflare 设置",
      };
    if (
      [
        "同名服务不属于此次安装，已停止，未覆盖现有服务。",
        "存储状态不一致，未创建或覆盖数据。请检查该账户的 KV。",
        "已有服务的存储缺失，已停止以保护数据。",
        "保存的安装信息无效，未修改云端资源。",
      ].includes(error.message)
    )
      return { ...cloudConflict };
    if (
      error.message ===
      "已有实例使用旧算法，不能把升级当作安装恢复。请先备份并迁移，安装器未覆盖旧数据。"
    )
      return { ...messages.version_mismatch };
  }
  return { ...unknownError };
}
