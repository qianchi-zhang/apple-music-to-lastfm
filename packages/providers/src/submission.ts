import type { Names, Resource } from "../../contracts/src/index";
import { md5 } from "../../core/src/md5";
export async function submitLastfm(
  plays: Resource[],
  apiKey: string,
  sharedSecret: string,
  sessionKey: string,
  request: typeof fetch,
) {
  const items: Array<{
    accepted: boolean;
    status: "accepted" | "ignored" | "failed" | "uncertain";
    returned?: Partial<Names>;
    error?: string;
  }> = [];
  for (let offset = 0; offset < plays.length; offset += 50) {
    const chunk = plays.slice(offset, offset + 50);
    const params: Record<string, string> = {
      method: "track.scrobble",
      api_key: apiKey,
      sk: sessionKey,
    };
    chunk.forEach((p, i) => {
      params[`artist[${i}]`] = p.artist;
      params[`track[${i}]`] = p.track;
      params[`timestamp[${i}]`] = String(
        Math.floor(new Date(p.timestamp).getTime() / 1000),
      );
      for (const [k, v] of Object.entries({
        album: p.album,
        albumArtist: p.album_artist,
        mbid: p.mbid,
        duration: Math.floor(p.duration_ms / 1000),
      }))
        if (v) params[`${k}[${i}]`] = String(v);
    });
    params.api_sig = md5(
      Object.keys(params)
        .sort()
        .map((k) => k + params[k])
        .join("") + sharedSecret,
    );
    params.format = "json";
    const fill = (status: "failed" | "uncertain", error: string) => {
      items.push(...chunk.map(() => ({ accepted: false, status, error })));
    };
    let response: Response;
    try {
      response = await request("https://ws.audioscrobbler.com/2.0/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      });
    } catch {
      fill("uncertain", "network_response_unknown");
      continue;
    }
    if (!response.ok) {
      fill(
        response.status === 503 || response.status === 429
          ? "failed"
          : "uncertain",
        `http_${response.status}`,
      );
      continue;
    }
    let data: Resource;
    try {
      data = (await response.json()) as Resource;
    } catch {
      fill("uncertain", "non_json_response");
      continue;
    }
    if (data.error) {
      fill("failed", `api_${data.error}: ${data.message ?? ""}`);
      continue;
    }
    const rows = Array.isArray(data.scrobbles?.scrobble)
      ? data.scrobbles.scrobble
      : data.scrobbles?.scrobble
        ? [data.scrobbles.scrobble]
        : [];
    const reported = Number(data.scrobbles?.["@attr"]?.accepted);
    const ignored = Number(data.scrobbles?.["@attr"]?.ignored);
    const explicitAccepted = rows.filter(
      (r: Resource) => String(r?.ignoredMessage?.code) === "0",
    ).length;
    const consistent =
      Number.isInteger(reported) &&
      Number.isInteger(ignored) &&
      reported === explicitAccepted &&
      reported + ignored === rows.length &&
      rows.length <= chunk.length;
    chunk.forEach((_p, i) => {
      const row = rows[i];
      const code = row?.ignoredMessage?.code;
      if (!consistent || code === undefined) {
        items.push({
          accepted: false,
          status: "uncertain",
          error: "incomplete_or_inconsistent_response",
        });
        return;
      }
      const returned: Partial<Names> = {};
      for (const [field, key] of Object.entries({
        artist: "artist",
        track: "track",
        album: "album",
        album_artist: "albumArtist",
      }))
        if (typeof row[key]?.["#text"] === "string")
          returned[field as keyof Names] = row[key]["#text"];
      const accepted = String(code) === "0";
      items.push({
        accepted,
        status: accepted ? "accepted" : "ignored",
        returned,
        error: accepted
          ? undefined
          : `ignored_${code}: ${row.ignoredMessage["#text"] ?? ""}`,
      });
    });
  }
  return {
    items,
    accepted: items.filter((i) => i.accepted).length,
    ignored: items.filter((i) => i.status === "ignored").length,
    errors: items.filter(
      (i) => i.status === "failed" || i.status === "uncertain",
    ).length,
    last_error: items.find((i) => i.error)?.error ?? null,
  };
}
