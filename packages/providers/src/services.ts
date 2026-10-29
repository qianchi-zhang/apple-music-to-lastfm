import type {
  Clock,
  AppleCredentials,
  JsonStore,
  RawKv,
  Resource,
  ResolvedTrack,
  Services,
  SubmissionRecord,
  Track,
} from "../../contracts/src/index";
import { verifyAppleAccess } from "./verify-apple";
import { lastfmApp, fingerprint, type LastfmConnection } from "./lastfm-auth";
import { createProviderRuntime } from "./runtime";
import {
  choosePreferredAppleTrack,
  filterMusicBrainzConfirmedAppleVariants,
} from "../../core/src/apple-evidence";
import { shouldDeferIdentityNormalizationFailure } from "../../core/src/text";
export interface Credentials {
  LASTFM_API_KEY: string;
  LASTFM_SHARED_SECRET: string;
  LASTFM_SESSION_KEY: string;
  LISTENBRAINZ_TOKEN?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  NOTIFY_WEBHOOK_URL?: string;
}
export function createServices(
  kv: RawKv,
  credentials: Credentials,
  options: {
    fetch?: typeof fetch;
    clock?: Clock;
    credentialStore?: JsonStore;
  } = {},
): Services {
  const api = createProviderRuntime(options);
  let tokens: { dev: string; user: string } | null = null;
  async function getTokens() {
    const connection = await options.credentialStore?.get<AppleCredentials>(
      "apple-connection:v1",
    );
    let dev = connection?.apple_dev_token ?? (await kv.get("apple_dev_token"));
    const user =
      connection?.apple_user_token ?? (await kv.get("apple_user_token"));
    if (!dev || !user) throw new Error("apple_tokens_missing_in_kv");
    if (api.appleDeveloperTokenNeedsRefresh(dev)) {
      try {
        dev = await api.refreshAppleDeveloperToken(
          { ASCROBBLE_STATE: kv },
          dev,
        );
      } catch {
        /* Continue with current token; a 401 triggers the explicit recovery path. */
      }
    }
    if (connection && dev !== connection.apple_dev_token)
      await options.credentialStore!.put("apple-connection:v1", {
        ...connection,
        apple_dev_token: dev,
      });
    return (tokens = { dev, user });
  }
  const toNames = (t: Resource) => ({
    artist: t.artist,
    album_artist: t.album_artist ?? t.artist,
    track: t.name,
    album: t.album ?? "",
  });
  return {
    verifyApple: (credentials) =>
      verifyAppleAccess(credentials, options.fetch ?? fetch),
    async recent() {
      let t = await getTokens();
      try {
        return await api.fetchRecentlyPlayed(t.dev, t.user);
      } catch (error) {
        if ((error as Error).name !== "TokenExpiredError") throw error;
        const fresh = await api.refreshAppleDeveloperToken(
          { ASCROBBLE_STATE: kv },
          t.dev,
          true,
        );
        if (fresh === t.dev) throw error;
        const connection = await options.credentialStore?.get<AppleCredentials>(
          "apple-connection:v1",
        );
        if (connection)
          await options.credentialStore!.put("apple-connection:v1", {
            ...connection,
            apple_dev_token: fresh,
          });
        tokens = { ...t, dev: fresh };
        return api.fetchRecentlyPlayed(fresh, t.user);
      }
    },
    async playCount(track) {
      if (!track.isrc) return null;
      const t = tokens ?? (await getTokens());
      return api.fetchTrackPlayCount(t.dev, t.user, track.isrc);
    },
    async resolve(source: Track): Promise<ResolvedTrack> {
      const t = tokens ?? (await getTokens());
      let identity: Resource | null = null;
      let result: Resource = source;
      try {
        const variants = await api.getAppleCatalogVariants(
          source,
          t.dev,
          t.user,
          kv,
        );
        const provisional = choosePreferredAppleTrack(source, variants);
        identity = await api.resolveMusicBrainzIdentity(
          provisional,
          variants.length ? variants : [provisional],
          kv,
        );
        const confirmed = filterMusicBrainzConfirmedAppleVariants(
          variants,
          identity,
        );
        const preferred = choosePreferredAppleTrack(source, confirmed);
        const spotify = await api
          .getConditionalSpotifyEvidence(
            preferred,
            confirmed.length ? confirmed : [preferred],
            identity,
            credentials,
          )
          .catch(() => null);
        result = await api.mapConfirmedIdentityToLastFm(
          preferred,
          confirmed.length ? confirmed : [preferred],
          identity,
          spotify,
          (await lastfmApp(options.credentialStore, credentials))?.api_key ??
            credentials.LASTFM_API_KEY,
        );
      } catch (error) {
        if (shouldDeferIdentityNormalizationFailure(error)) throw error;
        result = { ...source, _identity_source: "apple_fallback" };
      }
      return {
        source: structuredClone(source),
        identity: {
          artist_mbid: identity?.artist_mbid,
          recording_mbid: identity?.recording_mbid,
          release_mbid: identity?.release_mbid,
          release_group_mbid: identity?.release_group_mbid,
          apple_track_id: source.catalog_id ?? source.id,
          apple_album_id: source._apple_album_id,
        },
        canonical: toNames(result),
        evidence: {
          method: result._identity_source,
          artwork_match: result._lastfm_artwork_match === true,
          lastfm_album_mbid: result._lastfm_album_mbid,
          identity,
        },
      };
    },
    async submit(items) {
      const app = await lastfmApp(options.credentialStore, credentials);
      const connection = await options.credentialStore?.get<LastfmConnection>(
        "lastfm-connection:v1",
      );
      const customApp = await options.credentialStore?.get("lastfm-app:v1");
      let sessionKey = credentials.LASTFM_SESSION_KEY;
      if (connection || customApp) {
        if (
          !app ||
          !connection ||
          connection.app_fingerprint !== (await fingerprint(app))
        )
          throw new Error("lastfm_not_connected");
        sessionKey = connection.session_key;
      }
      const result = await api.scrobbleBatch(
        items.map((i) => ({ ...i, timestamp: new Date(i.timestamp_iso) })),
        app?.api_key ?? credentials.LASTFM_API_KEY,
        app?.shared_secret ?? credentials.LASTFM_SHARED_SECRET,
        sessionKey,
      );
      return result.items.map((r: Resource, i: number) => ({
        event_id: items[i].event_id,
        status: r.status,
        returned: r.returned,
        error: r.error,
      }));
    },
    async secondary(items: SubmissionRecord[]) {
      if (!credentials.LISTENBRAINZ_TOKEN) return;
      await api.submitBatch(
        items.map((i) => ({
          ...i,
          ...(i.prepared?.listenbrainz ?? {}),
          timestamp: new Date(i.timestamp_iso),
        })),
        credentials.LISTENBRAINZ_TOKEN,
      );
    },
  };
}
