/**
 * VidPlay provider.
 *
 * AniKoto owns the authoritative AniList/season/episode mapping. We mirror
 * its small server-side resolver flow:
 *
 *   AniList metadata -> AniKoto search -> MAL-ID-verified candidate
 *   -> episode data-ids -> AniKoto server list -> VidPlay link -> VidTube URL
 *
 * We return the VidTube embed URL only. Video bytes never pass through this
 * service.
 *
 * Accuracy pipeline (three layers):
 *   1. Title + format + season scoring  (broad filter)
 *   2. MAL ID reverse-verify via episode data-mal (hard confirmation)
 *   3. VidTube data-realid episode-number check (final guard)
 */

import { fetchAniMedia, type AniMedia } from "../lib/anilist.js";
import { fetchWithTimeout, TtlCache } from "../lib/cache.js";

const ANIKOTO = "https://anikoto.cz";
const VIDTUBE_HOSTS = new Set(["vidtube.site", "www.vidtube.site"]);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ANIKOTO_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/html,*/*",
  "X-Requested-With": "XMLHttpRequest",
};

const SEARCH_TTL  = 24 * 60 * 60_000; // 24 h
const EPISODE_TTL = 30 * 60_000;       // 30 min
const STREAM_TTL  = 30 * 60_000;       // 30 min

type AudioType = "sub" | "dub" | "hsub";

interface AniKotoCandidate {
  id: string;
  slug: string;
  title: string;
  japaneseTitle: string;
  format: string;
  episodeCount: number;
  score: number;
}

interface AniKotoEpisode {
  id: string;
  number: number;   // data-num; 0 is treated as episode 1 for movies
  slug: string;     // data-slug (episode slug for mapper)
  malId: number | null; // data-mal (MAL show ID — used for reverse verification)
  timestamp: number;    // data-timestamp
  sub: boolean;
  dub: boolean;
  ids: string;          // data-ids (server list token)
}

class VidPlayError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NO_ANILIST_MEDIA"
      | "NO_ANIKOTO_MATCH"
      | "EPISODE_NOT_FOUND"
      | "SERVER_NOT_FOUND"
      | "INVALID_STREAM",
  ) {
    super(message);
    this.name = "VidPlayError";
  }
}

const searchCache  = new TtlCache<AniKotoCandidate[]>(60_000);
const episodeCache = new TtlCache<AniKotoEpisode[]>(60_000);
const streamCache  = new TtlCache<string>(60_000);

// ─── string helpers ────────────────────────────────────────────────────────

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalise(value: string): string {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigramScore(a: string, b: string): number {
  const left  = normalise(a);
  const right = normalise(b);
  if (left === right) return 1;
  if (!left || !right) return 0;

  const grams = (input: string) => {
    const result = new Map<string, number>();
    for (let i = 0; i < input.length - 1; i++) {
      const gram = input.slice(i, i + 2);
      result.set(gram, (result.get(gram) ?? 0) + 1);
    }
    return result;
  };

  const aGrams = grams(left);
  const bGrams = grams(right);
  let shared = 0;
  let aTotal = 0;
  let bTotal = 0;
  for (const count of aGrams.values()) aTotal += count;
  for (const count of bGrams.values()) bTotal += count;
  for (const [gram, count] of aGrams) {
    shared += Math.min(count, bGrams.get(gram) ?? 0);
  }
  return (2 * shared) / (aTotal + bTotal);
}

const GENERIC_TITLE_WORDS = new Set([
  "a", "an", "and", "cat", "movie", "part",
  "recap", "season", "series", "special", "the", "zero",
]);

function titleTokens(value: string): Set<string> {
  return new Set(
    normalise(value)
      .split(" ")
      .filter((token) => token.length >= 3 && !GENERIC_TITLE_WORDS.has(token)),
  );
}

function hasDistinctiveTitleMatch(
  mediaTitles: string[],
  candidate: AniKotoCandidate,
): boolean {
  const candidateTokens = new Set([
    ...titleTokens(candidate.title),
    ...titleTokens(candidate.japaneseTitle),
  ]);
  return mediaTitles.some((title) => {
    for (const token of titleTokens(title)) {
      if (candidateTokens.has(token)) return true;
    }
    return false;
  });
}

function formatMatches(media: AniMedia, candidate: AniKotoCandidate): boolean {
  const format = normalise(candidate.format);
  if (!format) return false;
  if (media.format === "MOVIE")    return format === "movie";
  if (media.format === "SPECIAL")  return format === "special" || format === "ona";
  if (media.format === "ONA")      return format === "ona" || format === "tv";
  if (media.format === "TV_SHORT") return format === "tv" || format === "ona";
  return format === "tv";
}

function titleVariants(media: AniMedia): string[] {
  return [
    media.title.english,
    media.title.romaji,
    ...media.synonyms,
  ].filter((title): title is string => Boolean(title?.trim()));
}

function stripSeasonWords(value: string): string {
  return value
    .replace(/\b(?:season|series|part|cour)\s*\d+\b/gi, "")
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function seasonNumber(value: string): number | null {
  const text = normalise(value);
  const patterns = [
    /\bseason\s+(\d+)\b/,
    /\bseries\s+(\d+)\b/,
    /\bpart\s+(\d+)\b/,
    /\b(\d+)(?:st|nd|rd|th)\s+season\b/,
    /\b(\d+)\s+season\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  // AniKoto commonly names sequels as "... 3" or "... 5".
  const trailing = text.match(/\s(\d+)$/);
  return trailing ? Number(trailing[1]) : null;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeHtml(match[2]);
  }
  return attrs;
}

// ─── AniKoto search ─────────────────────────────────────────────────────────

function parseSearchResults(html: string): AniKotoCandidate[] {
  const candidates: AniKotoCandidate[] = [];
  const blocks = html.split(/<div class="item\b/i).slice(1);

  for (const block of blocks) {
    const poster = block.match(/<div class="ani poster tip"[^>]*data-tip="(\d+)"[^>]*>/i);
    const href   = block.match(/href="(?:https?:\/\/[^"]+)?\/watch\/([^/"?]+)(?:\/ep-\d+)?"/i);
    const title  = block.match(/class="name d-title"[^>]*>([^<]+)</i);
    if (!poster || !href || !title) continue;

    const japanese = block.match(/class="name d-title"[^>]*data-jp="([^"]*)"/i);
    const total    = block.match(/class="ep-status total"[^>]*>\s*<span>\s*(\d+)/i);
    const format   = block.match(/<div class="right">\s*([^<]+)/i);
    candidates.push({
      id:            poster[1],
      slug:          href[1],
      title:         decodeHtml(title[1]),
      japaneseTitle: decodeHtml(japanese?.[1] ?? ""),
      format:        decodeHtml(format?.[1] ?? ""),
      episodeCount:  Number(total?.[1] ?? 0),
      score:         0,
    });
  }
  return candidates;
}

async function searchAniKoto(query: string): Promise<AniKotoCandidate[]> {
  const key = `search:${normalise(query)}`;
  return searchCache.dedupe(
    key,
    async () => {
      const url = `${ANIKOTO}/filter?keyword=${encodeURIComponent(query)}`;
      const response = await fetchWithTimeout(
        url,
        { headers: { ...ANIKOTO_HEADERS, Referer: `${ANIKOTO}/` } },
        8_000,
      );
      if (!response.ok) return [];
      return parseSearchResults(await response.text());
    },
    SEARCH_TTL,
  );
}

// ─── episode fetching ────────────────────────────────────────────────────────

async function fetchEpisodes(candidate: AniKotoCandidate): Promise<AniKotoEpisode[]> {
  return episodeCache.dedupe(
    `episodes:${candidate.id}`,
    async () => {
      const pageUrl = `${ANIKOTO}/watch/${candidate.slug}/ep-1`;
      const response = await fetchWithTimeout(
        `${ANIKOTO}/ajax/episode/list/${candidate.id}?style=0`,
        { headers: { ...ANIKOTO_HEADERS, Referer: pageUrl } },
        8_000,
      );
      if (!response.ok) return [];
      const json = (await response.json()) as { status?: number; result?: string };
      const html = json.result ?? "";

      const episodes: AniKotoEpisode[] = [];
      for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
        const attrs = parseAttributes(match[1]);
        if (!attrs["data-id"] || !attrs["data-num"]) continue;
        const rawNum = Number(attrs["data-num"]);
        if (!Number.isFinite(rawNum)) continue;
        // data-num=0 is used for movies/specials that are a single entry.
        // Normalise to 1 so callers can always request episode 1.
        const number = rawNum === 0 ? 1 : rawNum;
        episodes.push({
          id:        attrs["data-id"],
          number,
          slug:      attrs["data-slug"] ?? String(rawNum),
          malId:     attrs["data-mal"] ? Number(attrs["data-mal"]) : null,
          timestamp: attrs["data-timestamp"] ? Number(attrs["data-timestamp"]) : 0,
          sub:       attrs["data-sub"] === "1",
          dub:       attrs["data-dub"] === "1",
          ids:       attrs["data-ids"] ?? "",
        });
      }
      return episodes;
    },
    EPISODE_TTL,
  );
}

// ─── MAL-ID reverse verification ─────────────────────────────────────────────

/**
 * Fetch episodes for a candidate and return the MAL ID embedded in the first
 * episode's data-mal attribute. Returns null when the list is empty or the
 * attribute is absent.
 */
async function peekMalId(candidate: AniKotoCandidate): Promise<number | null> {
  try {
    const episodes = await fetchEpisodes(candidate);
    return episodes[0]?.malId ?? null;
  } catch {
    return null;
  }
}

// ─── candidate resolution ────────────────────────────────────────────────────

async function resolveAniKotoCandidate(
  anilistId: string,
  media: AniMedia,
): Promise<AniKotoCandidate> {
  const variants = titleVariants(media);
  const queries = [
    variants[0],
    variants[1],
    variants[0] ? stripSeasonWords(variants[0]) : "",
  ].filter(
    (q, idx, all): q is string => Boolean(q) && all.indexOf(q) === idx,
  );

  const batches = await Promise.all(queries.map(searchAniKoto));
  const bySlug  = new Map<string, AniKotoCandidate>();
  for (const batch of batches) {
    for (const c of batch) {
      if (!bySlug.has(c.slug)) bySlug.set(c.slug, c);
    }
  }

  const requestedSeason  = variants.map(seasonNumber).find((v): v is number => v !== null) ?? null;
  const requestedTitles  = variants.slice(0, 5);

  // ── Layer 1: title + format + season scoring ──
  const ranked = [...bySlug.values()]
    .filter((c) => formatMatches(media, c))
    .filter((c) => hasDistinctiveTitleMatch(requestedTitles, c))
    .map((c) => {
      const titleScore = Math.max(
        ...requestedTitles.map((t) =>
          Math.max(bigramScore(t, c.title), bigramScore(t, c.japaneseTitle)),
        ),
      );
      const candidateSeason = seasonNumber(c.title) ?? seasonNumber(c.slug);
      const seasonMatches   = requestedSeason === null || candidateSeason === requestedSeason;
      const episodeMatches  =
        !media.episodes || !c.episodeCount ||
        Math.abs(c.episodeCount - media.episodes) <= 1;

      return {
        ...c,
        score:
          titleScore +
          (seasonMatches  ? 0.35 : -0.6) +
          (episodeMatches ? 0.15 : -0.15),
      };
    })
    .filter((c) => {
      const cs = seasonNumber(c.title) ?? seasonNumber(c.slug);
      return requestedSeason === null || cs === requestedSeason;
    })
    .sort((a, b) => b.score - a.score);

  // ── Layer 2: MAL-ID reverse verification ──
  // When AniList gives us a MAL ID, peek at the top candidates (up to 5) in
  // parallel to find the one whose episode list advertises the same MAL ID.
  // A MAL-confirmed hit is promoted over any title-only winner.
  if (media.idMal) {
    const pool = ranked.slice(0, 5);
    const malIds = await Promise.all(pool.map((c) => peekMalId(c)));

    const confirmedIdx = malIds.findIndex((id) => id === media.idMal);
    if (confirmedIdx !== -1) {
      // MAL-confirmed candidate — trust it regardless of title score.
      return pool[confirmedIdx];
    }

    // No MAL match among top 5. If every peeked candidate returned a non-null
    // MAL ID (meaning they all answered correctly and none matched), it means
    // this title genuinely isn't on AniKoto under those search queries.
    const allAnswered = malIds.every((id) => id !== null);
    if (allAnswered && pool.length > 0) {
      throw new VidPlayError(
        `MAL ID ${media.idMal} not found in top AniKoto candidates for AniList ID ${anilistId}`,
        "NO_ANIKOTO_MATCH",
      );
    }
  }

  // ── Fallback: use title-score winner (no MAL ID to verify against) ──
  const best = ranked[0];
  if (!best || best.score < 0.95) {
    throw new VidPlayError(
      `No confident AniKoto season match for AniList ID ${anilistId}`,
      "NO_ANIKOTO_MATCH",
    );
  }
  return best;
}

// ─── VidPlay link resolution ─────────────────────────────────────────────────

async function resolveVidPlayLink(
  candidate: AniKotoCandidate,
  episode: AniKotoEpisode,
  type: AudioType,
): Promise<string> {
  if (!episode.ids) {
    throw new VidPlayError("AniKoto episode has no server mapping", "SERVER_NOT_FOUND");
  }

  const pageUrl  = `${ANIKOTO}/watch/${candidate.slug}/ep-${episode.number}`;
  const response = await fetchWithTimeout(
    `${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(episode.ids)}`,
    { headers: { ...ANIKOTO_HEADERS, Referer: pageUrl } },
    8_000,
  );
  if (!response.ok) {
    throw new VidPlayError("AniKoto server list failed", "SERVER_NOT_FOUND");
  }
  const json   = (await response.json()) as { status?: number; result?: string };
  const html   = json.result ?? "";

  // Find the audio-type section then the VidPlay server entry inside it.
  const section = html.match(
    new RegExp(
      `<div[^>]+class="type"[^>]+data-type="${type}"[^>]*>([\\s\\S]*?)(?=<div[^>]+class="type"|$)`,
      "i",
    ),
  )?.[1] ?? "";

  const server = [...section.matchAll(/<li\b([^>]*)>([^<]*)<\/li>/gi)]
    .map((m) => ({ attrs: parseAttributes(m[1]), name: decodeHtml(m[2]) }))
    .find((entry) => /^vidplay(?:-\d+)?$/i.test(entry.name));

  if (!server?.attrs["data-link-id"]) {
    throw new VidPlayError(
      `VidPlay server is unavailable for episode ${episode.number} (${type})`,
      "SERVER_NOT_FOUND",
    );
  }

  const finalResponse = await fetchWithTimeout(
    `${ANIKOTO}/ajax/server?get=${encodeURIComponent(server.attrs["data-link-id"])}`,
    { headers: { ...ANIKOTO_HEADERS, Referer: pageUrl } },
    8_000,
  );
  if (!finalResponse.ok) {
    throw new VidPlayError("VidPlay link resolver failed", "INVALID_STREAM");
  }
  const finalJson = (await finalResponse.json()) as {
    status?: number;
    result?: { url?: string; link?: string };
  };
  const streamUrl = finalJson.result?.url ?? finalJson.result?.link ?? "";

  let parsed: URL;
  try {
    parsed = new URL(streamUrl);
  } catch {
    throw new VidPlayError("VidPlay returned an invalid URL", "INVALID_STREAM");
  }

  if (
    !VIDTUBE_HOSTS.has(parsed.hostname) ||
    !/^\/stream\/[^/]+\/(?:sub|dub|hsub)$/.test(parsed.pathname)
  ) {
    throw new VidPlayError("VidPlay did not return a VidTube stream URL", "INVALID_STREAM");
  }

  // ── Layer 3: VidTube data-realid episode-number check ──
  const vidTubeResponse = await fetchWithTimeout(
    parsed.toString(),
    { headers: { "User-Agent": UA, Referer: pageUrl } },
    8_000,
  );
  if (!vidTubeResponse.ok) {
    throw new VidPlayError("VidTube stream page is unavailable", "INVALID_STREAM");
  }
  const vidTubeHtml = await vidTubeResponse.text();
  const realId      = vidTubeHtml.match(/data-realid="([^"]+)"/i)?.[1] ?? "";
  const realEpisode = realId.match(/\/ep-(\d+(?:\.\d+)?)$/i)?.[1];

  // AniKoto slugs carry a short disambiguation suffix; VidTube's data-realid
  // uses the canonical slug without that suffix.  Some titles also normalise
  // punctuation differently (e.g. re-zero → rezero).
  const slugKey = (value: string) =>
    value
      .replace(/-[a-z0-9]{5}$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();

  const expectedSlugKeys = new Set(
    [candidate.slug, candidate.title, candidate.japaneseTitle]
      .filter(Boolean)
      .map(slugKey),
  );
  const realSlugKey = realId
    .replace(/\/ep-\d+(?:\.\d+)?$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();

  if (
    !realEpisode ||
    Number(realEpisode) !== episode.number ||
    !expectedSlugKeys.has(realSlugKey)
  ) {
    throw new VidPlayError(
      "VidTube returned a different season or episode than requested",
      "INVALID_STREAM",
    );
  }

  return parsed.toString();
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function resolveVidPlay(
  anilistId: string,
  epNo: string,
  type: AudioType,
): Promise<string> {
  const key = `vidplay:${anilistId}:${epNo}:${type}`;
  return streamCache.dedupe(
    key,
    async () => {
      const media = await fetchAniMedia(anilistId);
      if (!media) {
        throw new VidPlayError("AniList media was not found", "NO_ANILIST_MEDIA");
      }

      const candidate = await resolveAniKotoCandidate(anilistId, media);
      const episodes  = await fetchEpisodes(candidate);

      // Support movies/specials where AniKoto stores a single entry as ep-0.
      // Both ep-0 and ep-1 are normalised to number=1 during parsing, so the
      // caller can always request episode 1 for such titles.
      const episode = episodes.find((item) => item.number === Number(epNo));
      if (!episode) {
        throw new VidPlayError(
          `Episode ${epNo} is not available on AniKoto`,
          "EPISODE_NOT_FOUND",
        );
      }
      if ((type === "sub" && !episode.sub) || (type === "dub" && !episode.dub)) {
        throw new VidPlayError(
          `Episode ${epNo} has no ${type} audio on AniKoto`,
          "EPISODE_NOT_FOUND",
        );
      }

      return resolveVidPlayLink(candidate, episode, type);
    },
    STREAM_TTL,
  );
}

export type { AudioType };
