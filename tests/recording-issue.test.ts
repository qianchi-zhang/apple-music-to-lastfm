import { expect, it } from "vitest";
import {
  ledgerRecordingIssue,
  queueAccountIssue,
} from "../apps/worker/src/recording-issue";

it.each([
  ["apple_token_expired", "apple_reconnect_required"],
  ["apple_tokens_missing_in_kv", "apple_reconnect_required"],
  ["apple_api_error: secret upstream body", "apple_unavailable"],
  ["api_9: secret session body", "lastfm_reconnect_required"],
  ["api_10: secret key body", "lastfm_reconnect_required"],
  ["api_29: secret upstream body", "lastfm_unavailable"],
  ["http_503: secret upstream body", "lastfm_unavailable"],
  ["network_error: secret upstream body", "lastfm_unavailable"],
  ["non_json_response", "lastfm_unavailable"],
  ["incomplete_response: secret body", "lastfm_unavailable"],
  ["secret unknown failure", "recording_unavailable"],
])("maps %s to a fixed safe code", (message, code) => {
  expect(
    ledgerRecordingIssue({ stats: { last_error_message: message } }),
  ).toEqual({ code });
});

it("suppresses old failures after a newer success and accepts empty ledgers", () => {
  expect(ledgerRecordingIssue({})).toBeNull();
  expect(
    ledgerRecordingIssue({ stats: { last_error_message: null } }),
  ).toBeNull();
  expect(
    ledgerRecordingIssue({
      stats: {
        last_error_message: "apple_token_expired",
        last_error_iso: "2026-10-27T00:00:00Z",
        last_success_iso: "2026-10-27T00:01:00Z",
      },
    }),
  ).toBeNull();
});

it("blocks either pending queue across accounts, accepts username case differences and bounds the owner", () => {
  for (const field of ["pending_enrichments", "pending_scrobbles"]) {
    const ledger = { [field]: [{}] };
    expect(queueAccountIssue(ledger, "OldUser", "NewUser")).toEqual({
      code: "queue_account_changed",
      queue_owner: "OldUser",
    });
    expect(queueAccountIssue(ledger, "OldUser", "olduser")).toBeNull();
    expect(queueAccountIssue(ledger, "bad\nprivate", "NewUser")).toEqual({
      code: "queue_account_changed",
    });
    expect(queueAccountIssue(ledger, "a".repeat(129), "NewUser")).toEqual({
      code: "queue_account_changed",
    });
  }
  expect(queueAccountIssue({}, "OldUser", "NewUser")).toBeNull();
});

it("clears only old authentication issues after the relevant credentials were successfully verified again", () => {
  const stats = {
    last_error_iso: "2026-10-27T00:00:00Z",
    last_error_message: "apple_token_expired",
  };
  const later = "2026-10-27T00:01:00Z";
  expect(ledgerRecordingIssue({ stats }, { apple: later })).toBeNull();
  expect(ledgerRecordingIssue({ stats }, { lastfm: later })).toEqual({
    code: "apple_reconnect_required",
  });
  expect(
    ledgerRecordingIssue(
      { stats: { ...stats, last_error_message: "api_9: private" } },
      { lastfm: later },
    ),
  ).toBeNull();
  expect(
    ledgerRecordingIssue(
      { stats: { ...stats, last_error_message: "api_9: private" } },
      { apple: later },
    ),
  ).toEqual({ code: "lastfm_reconnect_required" });
  expect(
    ledgerRecordingIssue(
      { stats: { ...stats, last_error_message: "apple_api_error: private" } },
      { apple: later },
    ),
  ).toEqual({ code: "apple_unavailable" });
  expect(
    ledgerRecordingIssue(
      { stats: { ...stats, last_error_message: "http_503: private" } },
      { lastfm: later },
    ),
  ).toEqual({ code: "lastfm_unavailable" });
});
