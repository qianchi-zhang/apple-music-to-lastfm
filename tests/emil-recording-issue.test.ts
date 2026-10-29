import { expect, it } from "vitest";
import {
  parseRecordingIssue,
  recordingIssue,
  recordingIssueError,
} from "../apps/browser-extension/src/recording-issue";
import type { Runtime } from "../apps/browser-extension/src/extension-state";

const runtime: Runtime = {
  enabled: true,
  algorithm_version: "fixture",
  pending_identity: 0,
  pending_submission: 0,
  records: [],
  stats: { total_scrobbled: 0 },
};

it("treats an explicit healthy backend diagnosis as authoritative over historical stats", () => {
  expect(
    recordingIssue({
      ...runtime,
      recording_issue: null,
      stats: {
        total_scrobbled: 0,
        last_error_message: "apple_token_expired",
        last_error_iso: "2026-10-27T12:00:00Z",
      },
    }),
  ).toBeNull();
});

it.each([
  "apple_token_expired",
  "apple_tokens_missing_in_kv",
  "api_9:invalid session",
  "api_26:suspended",
])(
  "recognizes old backend authentication failure %s without echoing upstream details",
  (message) => {
    const issue = recordingIssue({
      ...runtime,
      stats: { total_scrobbled: 0, last_error_message: message },
    });
    expect(issue?.code).toBe(
      message.startsWith("apple")
        ? "apple_reconnect_required"
        : "lastfm_reconnect_required",
    );
    expect(JSON.stringify(recordingIssueError(issue))).not.toContain(message);
  },
);

it.each([
  "network_error:private url",
  "unexpected-secret",
  "apple_api_error:503",
])(
  "does not infer old-backend health from ambiguous historical text %s",
  (message) => {
    expect(
      recordingIssue({
        ...runtime,
        stats: { total_scrobbled: 0, last_error_message: message },
      }),
    ).toBeNull();
  },
);

it("ignores an old authentication error once the backend reports a newer success", () => {
  expect(
    recordingIssue({
      ...runtime,
      stats: {
        total_scrobbled: 0,
        last_error_message: "apple_token_expired",
        last_error_iso: "2026-10-27T12:00:00Z",
        last_success_iso: "2026-10-27T12:01:00Z",
      },
    }),
  ).toBeNull();
});

it.each([
  undefined,
  false,
  "private-upstream-text",
  { code: "unknown-private-text" },
  { code: "__proto__" },
])("safely warns for an invalid new diagnosis %j", (value) => {
  expect(parseRecordingIssue(value)).toEqual({ code: "recording_unavailable" });
  expect(
    JSON.stringify(recordingIssueError(parseRecordingIssue(value))),
  ).not.toContain("private");
});

it("retains only a safe bounded queue owner and describes switching the website account first", () => {
  const issue = parseRecordingIssue({
    code: "queue_account_changed",
    queue_owner: "OriginalListener",
    token: "secret",
  });
  expect(issue).toEqual({
    code: "queue_account_changed",
    queue_owner: "OriginalListener",
  });
  expect(recordingIssueError(issue)?.detail).toContain("OriginalListener");
  expect(recordingIssueError(issue)?.detail).toContain(
    "退出当前账户并登录原账户",
  );
  for (const owner of ["<script>secret</script>", "x\nsecret", "x".repeat(129)])
    expect(
      parseRecordingIssue({
        code: "queue_account_changed",
        queue_owner: owner,
      }),
    ).toEqual({ code: "queue_account_changed" });
});
