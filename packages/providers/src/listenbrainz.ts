// General matching behavior preserved from aScrobble 0.3.49.
import { BATCH_SIZE2, API_URL2 } from "../../core/src/constants";
import type { ProviderContext } from "./runtime";
export function createListenbrainz(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;

  async function submitBatch(plays?: any, userToken?: any): Promise<any> {
    const result: any = { accepted: 0, errors: 0 };
    if (plays.length === 0) return result;
    const entries: any = plays
      .filter((p?: any) => p.artist && p.track)
      .map((p?: any) => ({
        listened_at: Math.floor(p.timestamp.getTime() / 1e3),
        track_metadata: {
          artist_name: p.artist,
          track_name: p.track,
          release_name: p.album || void 0,
          additional_info: {
            submission_client: "aScrobble-scrobbler",
            submission_client_version: "0.2.0",
            music_service: "music.apple.com",
            duration_ms: p.duration_ms || void 0,
          },
        },
      }));
    for (
      let chunkStart: any = 0;
      chunkStart < entries.length;
      chunkStart += BATCH_SIZE2
    ) {
      const chunk: any = entries.slice(chunkStart, chunkStart + BATCH_SIZE2);
      const body: any = {
        listen_type: chunk.length === 1 ? "single" : "import",
        payload: chunk,
      };
      let response: any;
      try {
        response = await fetch(API_URL2, {
          method: "POST",
          headers: {
            Authorization: `Token ${userToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (e: any) {
        console.error("ListenBrainz HTTP error:", e);
        result.errors += chunk.length;
        continue;
      }
      if (response.ok) {
        result.accepted += chunk.length;
      } else if (response.status === 401) {
        console.error(
          "ListenBrainz 401 \u2014 LISTENBRAINZ_TOKEN invalid. Get a new one at https://listenbrainz.org/profile/",
        );
        result.errors += chunk.length;
        break;
      } else {
        const text: any = await response.text();
        console.error(`ListenBrainz ${response.status}: ${text.slice(0, 300)}`);
        result.errors += chunk.length;
      }
    }
    return result;
  }
  return { submitBatch };
}
