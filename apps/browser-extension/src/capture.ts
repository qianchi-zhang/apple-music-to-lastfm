/** Serialized into the Apple top frame. Keep self-contained: no outer closures.
 * No password/cookie access, polling, DOM messaging or network requests.
 */
export function captureAppleCredentials() {
  if (location.origin !== "https://music.apple.com")
    return { error: "wrong_tab" } as const;
  try {
    const kit = (
      window as unknown as {
        MusicKit?: {
          getInstance?: () => {
            isAuthorized?: boolean;
            developerToken?: unknown;
            musicUserToken?: unknown;
          };
        };
      }
    ).MusicKit?.getInstance?.();
    if (!kit) return { error: "not_ready" } as const;
    if (!kit.isAuthorized) return { error: "not_signed_in" } as const;
    if (
      typeof kit.developerToken !== "string" ||
      typeof kit.musicUserToken !== "string" ||
      !kit.developerToken ||
      !kit.musicUserToken
    )
      return { error: "tokens_unavailable" } as const;
    return {
      credentials: {
        apple_dev_token: kit.developerToken,
        apple_user_token: kit.musicUserToken,
      },
    };
  } catch {
    return { error: "tokens_unavailable" } as const;
  }
}
/** Readiness probe returns no token values to the extension. */
export function inspectAppleConnection() {
  if (location.origin !== "https://music.apple.com")
    return { error: "wrong_tab" };
  try {
    const kit = (
      window as unknown as {
        MusicKit?: {
          getInstance?: () => {
            isAuthorized?: boolean;
            developerToken?: unknown;
            musicUserToken?: unknown;
          };
        };
      }
    ).MusicKit?.getInstance?.();
    if (!kit) return { error: "not_ready" };
    if (!kit.isAuthorized) return { error: "not_signed_in" };
    if (
      typeof kit.developerToken !== "string" ||
      !kit.developerToken ||
      typeof kit.musicUserToken !== "string" ||
      !kit.musicUserToken
    )
      return { error: "tokens_unavailable" };
    return { ready: true };
  } catch {
    return { error: "tokens_unavailable" };
  }
}
