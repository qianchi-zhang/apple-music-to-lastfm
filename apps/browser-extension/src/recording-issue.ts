import type { Runtime } from "./extension-state";
import type { UiError } from "./extension-errors";

export type RecordingIssueCode =
  | "queue_account_changed"
  | "apple_reconnect_required"
  | "apple_unavailable"
  | "lastfm_reconnect_required"
  | "lastfm_unavailable"
  | "recording_unavailable";
export interface RecordingIssue {
  code: RecordingIssueCode;
  queue_owner?: string;
}
const codes = new Set<RecordingIssueCode>([
  "queue_account_changed",
  "apple_reconnect_required",
  "apple_unavailable",
  "lastfm_reconnect_required",
  "lastfm_unavailable",
  "recording_unavailable",
]);

/** Only known codes and a bounded account label may reach the interface. */
export function parseRecordingIssue(value: unknown): RecordingIssue | null {
  if (value === null) return null;
  if (!value || typeof value !== "object")
    return { code: "recording_unavailable" };
  const { code, queue_owner } = value as Record<string, unknown>;
  if (typeof code !== "string" || !codes.has(code as RecordingIssueCode))
    return { code: "recording_unavailable" };
  return {
    code: code as RecordingIssueCode,
    ...(code === "queue_account_changed" &&
    typeof queue_owner === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(queue_owner)
      ? { queue_owner }
      : {}),
  };
}

/** Old backends have only stats. Never expose their upstream error messages. */
export function recordingIssue(runtime: Runtime | null): RecordingIssue | null {
  if (!runtime) return null;
  if (Object.hasOwn(runtime, "recording_issue"))
    return parseRecordingIssue(runtime.recording_issue);
  const stats = runtime.stats;
  const message = stats?.last_error_message;
  if (typeof message !== "string" || !message.trim()) return null;
  const errorAt =
    typeof stats.last_error_iso === "string"
      ? Date.parse(stats.last_error_iso)
      : NaN;
  const successAt =
    typeof stats.last_success_iso === "string"
      ? Date.parse(stats.last_success_iso)
      : NaN;
  if (
    Number.isFinite(successAt) &&
    (!Number.isFinite(errorAt) || successAt > errorAt)
  )
    return null;
  if (/^(apple_token_expired|apple_tokens_missing_in_kv)$/.test(message))
    return { code: "apple_reconnect_required" };
  if (/^api_(4|9|10|13|26):/.test(message))
    return { code: "lastfm_reconnect_required" };
  return null;
}

export function recordingIssueError(
  issue: RecordingIssue | null,
): UiError | null {
  if (!issue) return null;
  switch (issue.code) {
    case "queue_account_changed":
      return {
        title: "有待处理的原账户记录",
        detail:
          (issue.queue_owner
            ? "待提交的歌曲属于 Last.fm 账户「" + issue.queue_owner + "」。"
            : "待提交的歌曲属于原 Last.fm 账户。") +
          "这些歌曲不会提交到新账户。请先在 Last.fm 官网退出当前账户并登录原账户，再回到余音重新授权，完成后手动开始记录。",
        recovery: "lastfm",
        action: "重新连接原 Last.fm 账户",
      };
    case "apple_reconnect_required":
      return {
        title: "Apple Music 需要重新连接",
        detail:
          "Apple Music 授权已失效，暂时无法读取新的聆听。请在同一 Chrome 登录 Apple Music 官网，再重新连接；现有记录会保留。",
        recovery: "apple",
        action: "重新连接 Apple Music",
      };
    case "lastfm_reconnect_required":
      return {
        title: "Last.fm 需要重新授权",
        detail:
          "Last.fm 未接受当前授权或应用配置，暂时无法提交新的聆听。请核对应用配置，再到官网重新授权；待提交歌曲会保留。",
        recovery: "lastfm",
        action: "重新授权 Last.fm",
      };
    case "apple_unavailable":
      return {
        title: "暂时无法读取 Apple Music",
        detail:
          "最近一次读取未能完成。请稍后检查状态，后台会在下一轮继续尝试；无需重新安装或重新授权。",
        recovery: "refresh",
        action: "重新检查状态",
      };
    case "lastfm_unavailable":
      return {
        title: "暂时无法提交到 Last.fm",
        detail:
          "最近一次提交未能完成，待提交歌曲会保留。请稍后检查状态，后台会在下一轮重试；无需重新安装。",
        recovery: "refresh",
        action: "重新检查状态",
      };
    default:
      return {
        title: "记录状态需要检查",
        detail:
          "最近一次后台处理未能完成。请检查状态；现有连接和待提交歌曲会保留。",
        recovery: "refresh",
        action: "检查后台状态",
      };
  }
}
