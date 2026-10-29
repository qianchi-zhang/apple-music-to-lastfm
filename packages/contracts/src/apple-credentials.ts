import type { AppleCredentials } from "./index";
export function parseAppleCredentials(value: unknown): AppleCredentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["apple_dev_token", "apple_user_token"].includes(k),
    )
  )
    return null;
  const valid = (s: unknown): s is string =>
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 16000 &&
    !/[\s\x00-\x1f\x7f]/.test(s);
  if (!valid(v.apple_dev_token) || !valid(v.apple_user_token)) return null;
  return {
    apple_dev_token: v.apple_dev_token,
    apple_user_token: v.apple_user_token,
  };
}
