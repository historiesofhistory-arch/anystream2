/**
 * Shared AniList GraphQL helper.
 *
 * Fetches basic media metadata (format, titles, episode count, synonyms)
 * for a given AniList ID.  Result cached 6 h in memory.
 *
 * format values (subset): TV | TV_SHORT | MOVIE | SPECIAL | OVA | ONA | MUSIC
 */

import { fetchWithTimeout } from "./cache.js";
import { logger } from "./logger.js";

export type AniFormat =
  | "TV"
  | "TV_SHORT"
  | "MOVIE"
  | "SPECIAL"
  | "OVA"
  | "ONA"
  | "MUSIC";

export interface AniMedia {
  idMal: number | null;
  format: AniFormat | null;
  title: { english: string | null; romaji: string | null };
  episodes: number | null;
  synonyms: string[];
}

const cache = new Map<string, { media: AniMedia; ts: number }>();
const TTL = 6 * 60 * 60 * 1000; // 6 h

export async function fetchAniMedia(anilistId: string): Promise<AniMedia | null> {
  const hit = cache.get(anilistId);
  if (hit && Date.now() - hit.ts < TTL) return hit.media;

  try {
    const res = await fetchWithTimeout(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `query($id:Int){Media(id:$id,type:ANIME){idMal format title{english romaji}episodes synonyms}}`,
          variables: { id: Number(anilistId) },
        }),
      },
      8_000,
    );
    const json = (await res.json()) as { data?: { Media?: AniMedia } };
    const media = json?.data?.Media ?? null;
    if (media) {
      cache.set(anilistId, { media, ts: Date.now() });
      logger.debug({ anilistId, format: media.format }, "[anilist] fetched media");
    }
    return media;
  } catch (err) {
    logger.warn({ anilistId, err }, "[anilist] fetch failed");
    return null;
  }
}
