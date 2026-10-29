/** Public diagnostics contain fixed codes, never upstream error messages. */
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
export const sameLastfmAccount = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

export function queueAccountIssue(
  ledger: any,
  owner: unknown,
  username: unknown,
): RecordingIssue | null {
  if (
    typeof owner !== "string" ||
    typeof username !== "string" ||
    sameLastfmAccount(owner, username) ||
    !(
      (ledger.pending_enrichments?.length ?? 0) +
      (ledger.pending_scrobbles?.length ?? 0)
    )
  )
    return null;
  return {
    code: "queue_account_changed",
    ...(owner.length > 0 &&
    owner.length <= 128 &&
    !/[\x00-\x1f\x7f]/.test(owner)
      ? { queue_owner: owner }
      : {}),
  };
}

export function ledgerRecordingIssue(
  ledger: any,
  verified: { apple?: string | null; lastfm?: string | null } = {},
): RecordingIssue | null {
  const message = ledger.stats?.last_error_message;
  if (typeof message !== "string" || !message) return null;
  const errorAt = Date.parse(ledger.stats?.last_error_iso ?? ""),
    successAt = Date.parse(ledger.stats?.last_success_iso ?? "");
  if (
    Number.isFinite(errorAt) &&
    Number.isFinite(successAt) &&
    successAt > errorAt
  )
    return null;
  const verifiedAfterError = (iso?: string | null) => {
    const at = Date.parse(iso ?? "");
    return Number.isFinite(errorAt) && Number.isFinite(at) && at > errorAt;
  };
  if (["apple_token_expired", "apple_tokens_missing_in_kv"].includes(message))
    return verifiedAfterError(verified.apple)
      ? null
      : { code: "apple_reconnect_required" };
  if (message.startsWith("apple_api_error:"))
    return { code: "apple_unavailable" };
  if (/^api_(?:4|9|10|13|26):/.test(message))
    return verifiedAfterError(verified.lastfm)
      ? null
      : { code: "lastfm_reconnect_required" };
  if (
    /^(?:network_error:|http_\d+:|api_\d+:|non_json_response|incomplete_response:|ignored_\d+:)/.test(
      message,
    )
  )
    return { code: "lastfm_unavailable" };
  return { code: "recording_unavailable" };
}
