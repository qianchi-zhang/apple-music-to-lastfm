export interface ArtworkLookup {
  kind: "track_id" | "catalog_id";
  id: string;
}

export function isAppleTrackId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^[1-9]\d{0,19}$/.test(value) || /^i\.[A-Za-z0-9_-]{1,126}$/.test(value))
  );
}

/** Prefer the source ID preserved by the recording queue, before matched metadata. */
export function artworkLookup(value: unknown): ArtworkLookup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (isAppleTrackId(record.track_id))
    return { kind: "track_id", id: record.track_id };
  // Older records and clients may only have a catalog ID.
  const catalog = String(record.catalog_id ?? "");
  return /^[1-9]\d{0,19}$/.test(catalog)
    ? { kind: "catalog_id", id: catalog }
    : null;
}
