import type {
  AppleCredentials,
  AppleAccessResult,
} from "../../contracts/src/index";
/** Verify read access only: never scrobble, scrape, refresh, or persist. */
export async function verifyAppleAccess(
  credentials: AppleCredentials,
  request: typeof fetch = fetch,
): Promise<AppleAccessResult> {
  try {
    const response = await request(
      "https://api.music.apple.com/v1/me/recent/played/tracks?limit=1&types=songs,library-songs",
      {
        headers: {
          Authorization: `Bearer ${credentials.apple_dev_token}`,
          "Music-User-Token": credentials.apple_user_token,
          Origin: "https://music.apple.com",
          Referer: "https://music.apple.com/",
        },
        // Observe and reject redirects without forwarding credentials elsewhere.
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      },
    );
    // Fixed fields only: never log request headers, tokens or response bodies.
    console.info("apple_connection_verification", {
      phase: "http",
      status: response.status,
    });
    if (response.status === 401 || response.status === 403)
      return { ok: false, code: "apple_rejected" };
    if (!response.ok) return { ok: false, code: "apple_unavailable" };
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data)
      ? { ok: true }
      : { ok: false, code: "apple_invalid_response" };
  } catch (error) {
    console.info("apple_connection_verification", {
      phase: "transport_or_parse",
      kind:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : error instanceof SyntaxError
            ? "invalid_json"
            : "network",
    });
    return { ok: false, code: "apple_unavailable" };
  }
}
