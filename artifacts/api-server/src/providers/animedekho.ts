/**
 * AnimeDekho provider (animedekho.app)
 *
 * Primary path — CDN embed:
 *   URL format: animedekho.app/embed/{tmdbId}/{season}-{ep}
 *   Requires Fribb TMDB mapping.
 *
 * Fallback path — watch-page (HydraX → MirrorBot):
 *   Used when CDN embed is missing (EP_NOT_FOUND / CDN_NOT_FOUND) or when
 *   Fribb has no mapping for the AniList ID.
 *   Flow:
 *     1. Slugify AniList English title → episode slug ({title}-{season}x{ep})
 *     2. Fetch episode page (no auth) → extract data-lmt JWT → trid
 *     3. Ensure verified session cookie (global, refreshed every ~22 h):
 *        fetch episode page → extract shortlink verify URL → call verify.php
 *     4. GET animedekho.app/?trdekho={1|2}&trid={trid}&trtype=2 with cookie
 *        → parse iframe src
 *
 * Episode numbering (CDN path — discovered empirically):
 *   AnimeDekho uses ABSOLUTE episode numbers per TMDB season.
 *   Example: Naruto (TMDB 46260)
 *     S1 episodes 1-52  → accessed as 1-1 … 1-52
 *     S2 episodes 53-104 → accessed as 2-53 … 2-104
 *
 * No external API key required.
 */

import { TtlCache, fetchWithTimeout } from "../lib/cache.js";
import { fetchAniMedia } from "../lib/anilist.js";
import { logger } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface FribbEntry {
  anilist_id?: number;
  themoviedb_id?: number | { tv?: number; movie?: number };
  season?: { tmdb?: number; tvdb?: number };
  thetvdb_season?: number;
}

interface TmdbMapping {
  tmdbId: number;
  isMovie: boolean;
  // null = Fribb had no season field → scan seasons to find the right one
  season: number | null;
}

// ── Fribb map — loaded once ──────────────────────────────────────────────────

let _fribbMap: Map<number, TmdbMapping> | null = null;
let _fribbLoading: Promise<Map<number, TmdbMapping>> | null = null;

async function getFribbMap(): Promise<Map<number, TmdbMapping>> {
  if (_fribbMap) return _fribbMap;
  if (_fribbLoading) return _fribbLoading;

  _fribbLoading = fetchWithTimeout(
    "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
    { headers: { Accept: "application/json" } },
    30_000,
  )
    .then(async (res) => {
      if (!res.ok) throw new Error(`Fribb list fetch failed: HTTP ${res.status}`);
      const data = (await res.json()) as FribbEntry[];
      const map = new Map<number, TmdbMapping>();
      for (const entry of data) {
        if (!entry.anilist_id) continue;
        const raw = entry.themoviedb_id;
        let tmdbId: number | undefined;
        let isMovie = false;
        if (typeof raw === "number") {
          tmdbId = raw;
        } else if (typeof raw === "object" && raw !== null) {
          if (raw.movie) { tmdbId = raw.movie; isMovie = true; }
          else if (raw.tv) { tmdbId = raw.tv; }
        }
        if (!tmdbId) continue;
        const season = entry.season?.tmdb ?? entry.thetvdb_season ?? null;
        map.set(entry.anilist_id, { tmdbId, isMovie, season });
      }
      _fribbMap = map;
      _fribbLoading = null;
      logger.info({ entries: map.size }, "[animedekho] Fribb anime-lists loaded");
      return map;
    })
    .catch((err) => {
      _fribbLoading = null;
      throw err;
    });

  return _fribbLoading;
}

// ── Shared headers ────────────────────────────────────────────────────────────

const ANIMEDEKHO_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://animedekho.app/",
};

// ── CDN embed helpers (primary path) ─────────────────────────────────────────

const CDN_HOSTS = ["as-cdn21.top", "play.zephyrflick.top"];

/** Fetch AnimeDekho TV-series embed page HTML, or null on error. */
async function fetchEmbedHtml(
  tmdbId: number,
  season: number,
  ep: number,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://animedekho.app/embed/${tmdbId}/${season}-${ep}`,
      { headers: ANIMEDEKHO_HEADERS },
      12_000,
    );
    return await res.text();
  } catch {
    return null;
  }
}

/** Fetch AnimeDekho movie embed page HTML, or null on error. */
async function fetchMovieEmbedHtml(tmdbId: number): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://animedekho.app/embed/${tmdbId}`,
      { headers: ANIMEDEKHO_HEADERS },
      12_000,
    );
    return await res.text();
  } catch {
    return null;
  }
}

/** True when the embed page HTML represents a found (non-404) episode. */
function htmlIsFound(html: string): boolean {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
  return title.length > 0 && !title.toLowerCase().includes("not found");
}

// ── Season scan (no external API needed) ─────────────────────────────────────

const seasonScanCache = new TtlCache<number>(5 * 60_000);
const SEASON_SCAN_TTL = 60 * 60 * 1000; // 1 h

/**
 * Scan seasons 1-15 in parallel to find which one contains absolute episode
 * absEp. Caches result 1 h.
 */
async function findSeasonForEpisode(tmdbId: number, absEp: number): Promise<number> {
  const cacheKey = `${tmdbId}:${absEp}`;
  return seasonScanCache.dedupe(
    cacheKey,
    async () => {
      const MAX_SEASONS = 15;
      logger.debug(
        { tmdbId, absEp, maxSeasons: MAX_SEASONS },
        "[animedekho] Season scan start",
      );

      const probes = await Promise.all(
        Array.from({ length: MAX_SEASONS }, (_, i) => i + 1).map(async (season) => {
          const html = await fetchEmbedHtml(tmdbId, season, absEp);
          return { season, found: html !== null && htmlIsFound(html) };
        }),
      );

      const match = probes.find((p) => p.found);
      logger.debug({ tmdbId, absEp, results: probes }, "[animedekho] Season scan results");

      if (!match) {
        throw Object.assign(
          new Error(
            `Episode ${absEp} not found on AnimeDekho (TMDB ${tmdbId} — scanned seasons 1-${MAX_SEASONS})`,
          ),
          { code: "EP_NOT_FOUND" },
        );
      }

      logger.info(
        { tmdbId, absEp, season: match.season },
        "[animedekho] Season resolved via scan",
      );
      return match.season;
    },
    SEASON_SCAN_TTL,
  );
}

// ── CDN URL extraction ────────────────────────────────────────────────────────

const cdnCache = new TtlCache<string>(5 * 60_000);
const CDN_TTL = 5 * 60_000;

/** Extract first CDN iframe src from an embed page HTML, or null. */
function extractCdnUrl(html: string): string | null {
  const iframeRe = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = iframeRe.exec(html)) !== null) {
    try {
      const url = new URL(m[1]);
      if (CDN_HOSTS.includes(url.hostname)) return m[1];
    } catch { /* malformed URL */ }
  }
  return null;
}

// ── Movie CDN resolver ────────────────────────────────────────────────────────

async function resolveMovieCdnUrl(tmdbId: number, anilistId: string): Promise<string> {
  const cacheKey = `movie:${tmdbId}`;
  return cdnCache.dedupe(
    cacheKey,
    async () => {
      logger.debug({ tmdbId, anilistId }, "[animedekho] Fetching movie embed");
      const html = await fetchMovieEmbedHtml(tmdbId);
      if (html === null) {
        throw Object.assign(
          new Error(`AnimeDekho movie request failed (TMDB movie ${tmdbId})`),
          { code: "UPSTREAM_ERROR" },
        );
      }
      if (!htmlIsFound(html)) {
        throw Object.assign(
          new Error(`Movie not found on AnimeDekho (TMDB movie ${tmdbId})`),
          { code: "EP_NOT_FOUND" },
        );
      }
      const cdnUrl = extractCdnUrl(html);
      if (!cdnUrl) {
        throw Object.assign(
          new Error(`No CDN iframe in AnimeDekho movie embed (TMDB movie ${tmdbId})`),
          { code: "CDN_NOT_FOUND" },
        );
      }
      logger.info({ tmdbId, anilistId, cdnUrl }, "[animedekho] Movie CDN URL resolved");
      return cdnUrl;
    },
    CDN_TTL,
  );
}

// ── Watch-page fallback (HydraX / MirrorBot) ─────────────────────────────────
//
// Used when the CDN embed is unavailable.  Three lightweight requests on first
// miss (episode page → verify.php → trdekho); all results cached.

/** WordPress-style slug: lowercase, non-alphanumeric runs → single hyphen. */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Session cookie (one shared instance, refreshed every ~22 h) ──────────────

let _adwCookie: string | null = null;
let _adwCookieExpiry = 0;
let _adwCookieInflight: Promise<string | null> | null = null;
const ADW_COOKIE_TTL_MS = 22 * 60 * 60_000; // 22 h (server issues for 24 h)

/**
 * Return the cached verified cookie, or obtain a fresh one.
 * Singleflight: concurrent callers share the same refresh promise.
 *
 * Flow:
 *   1. Fetch episode page (no auth) → extract hidden `shortlink` value
 *      (contains a server-generated verify.php URL with HMAC token)
 *   2. GET verify.php → server sets `toronites_server` cookie in response
 */
async function ensureVerifiedCookie(episodeSlug: string): Promise<string | null> {
  if (_adwCookie && Date.now() < _adwCookieExpiry) return _adwCookie;
  if (_adwCookieInflight) return _adwCookieInflight;

  _adwCookieInflight = (async (): Promise<string | null> => {
    try {
      // Step 1 — get a fresh server-signed verify URL from the episode page
      const pageRes = await fetchWithTimeout(
        `https://animedekho.app/epi/${episodeSlug}/`,
        { headers: ANIMEDEKHO_HEADERS },
        12_000,
      );
      const html = await pageRes.text();

      // shortlink hidden input carries the pre-signed verify.php URL
      const verifyUrl =
        html.match(/name="shortlink"[^>]+value="([^"]+)"/)?.[1] ??
        html.match(/value="(https:\/\/animedekho\.app\/24hr\/verify\.php[^"]+)"/)?.[1];

      if (!verifyUrl) {
        // shortlink not in page — site may have already verified this IP, or
        // page structure changed. Use the known default value and proceed.
        logger.debug({ episodeSlug }, "[animedekho-wp] shortlink not found, using default cookie");
        const fallback = "toronites_server=vidstream";
        _adwCookie = fallback;
        _adwCookieExpiry = Date.now() + ADW_COOKIE_TTL_MS;
        return fallback;
      }

      // Step 2 — call verify.php; server sets Set-Cookie: toronites_server=...
      const verRes = await fetchWithTimeout(
        verifyUrl,
        {
          headers: {
            ...ANIMEDEKHO_HEADERS,
            Referer: `https://animedekho.app/epi/${episodeSlug}/`,
          },
          redirect: "manual", // capture Set-Cookie before any redirect
        },
        10_000,
      );

      // Node.js 18+ exposes getSetCookie(); fall back to get() for older runtimes
      const rawCookies: string[] =
        typeof (verRes.headers as any).getSetCookie === "function"
          ? (verRes.headers as any).getSetCookie()
          : [verRes.headers.get("set-cookie") ?? ""];

      const toroniCookie = rawCookies.find((c) => c.startsWith("toronites_server="));
      // If verify.php didn't set a cookie but returned the success page, use the
      // known default value the server always assigns on success.
      const cookieValue = toroniCookie
        ? toroniCookie.split(";")[0].trim()
        : "toronites_server=vidstream";

      _adwCookie = cookieValue;
      _adwCookieExpiry = Date.now() + ADW_COOKIE_TTL_MS;
      logger.info({ cookieValue }, "[animedekho-wp] Session cookie refreshed");
      return cookieValue;
    } catch (err) {
      logger.warn({ err }, "[animedekho-wp] Cookie refresh failed");
      return null;
    } finally {
      _adwCookieInflight = null;
    }
  })();

  return _adwCookieInflight;
}

// ── trid lookup (cached 6 h; post IDs never change) ──────────────────────────

const tridCache = new TtlCache<number>(5 * 60_000);
const TRID_TTL = 6 * 60 * 60_000;

/**
 * Fetch the AnimeDekho internal post ID (trid) for an episode slug.
 * The `data-lmt` JWT is present in the unauthenticated episode page HTML.
 * No cookie required for this step.
 */
async function fetchTrid(episodeSlug: string): Promise<number> {
  return tridCache.dedupe(
    `trid:${episodeSlug}`,
    async () => {
      const res = await fetchWithTimeout(
        `https://animedekho.app/epi/${episodeSlug}/`,
        { headers: ANIMEDEKHO_HEADERS },
        12_000,
      );
      const html = await res.text();

      const pageTitle = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
      if (pageTitle.toLowerCase().includes("not found")) {
        throw Object.assign(
          new Error(`Episode not on AnimeDekho watch page: ${episodeSlug}`),
          { code: "EP_NOT_FOUND" },
        );
      }

      const lmtB64 = html.match(/data-lmt="([^"]+)"/)?.[1];
      if (!lmtB64) {
        throw Object.assign(
          new Error(`No data-lmt JWT on AnimeDekho watch page: ${episodeSlug}`),
          { code: "EP_NOT_FOUND" },
        );
      }

      let trid: number | undefined;
      try {
        const payload = JSON.parse(
          Buffer.from(lmtB64, "base64").toString("utf8"),
        ) as { lmt?: { id?: number } };
        trid = payload?.lmt?.id;
      } catch {
        /* malformed JWT */
      }

      if (!trid) {
        throw Object.assign(
          new Error(`data-lmt JWT had no id field: ${lmtB64}`),
          { code: "EP_NOT_FOUND" },
        );
      }

      logger.debug({ episodeSlug, trid }, "[animedekho-wp] trid resolved");
      return trid;
    },
    TRID_TTL,
  );
}

// ── trdekho iframe URL (cached 30 min) ───────────────────────────────────────

const watchIframeCache = new TtlCache<string>(5 * 60_000);
const WATCH_IFRAME_TTL = 30 * 60_000;

/** Server IDs to try in order: 0=HydraX (abyssplayer), 1=SRuby, 2=MirrorBot. */
const TRDEKHO_SERVERS = [0, 1, 2] as const;

async function fetchWatchIframeUrl(
  trid: number,
  server: 0 | 1 | 2,
  cookie: string,
): Promise<string> {
  return watchIframeCache.dedupe(
    `wp:${trid}:${server}`,
    async () => {
      const res = await fetchWithTimeout(
        `https://animedekho.app/?trdekho=${server}&trid=${trid}&trtype=2`,
        {
          headers: {
            ...ANIMEDEKHO_HEADERS,
            Cookie: cookie,
          },
        },
        12_000,
      );
      const html = await res.text();
      const iframeSrc = html.match(/<iframe[^>]+src="([^"]+)"/i)?.[1];
      if (!iframeSrc) {
        throw Object.assign(
          new Error(`No iframe src in trdekho=${server} response (trid=${trid})`),
          { code: "CDN_NOT_FOUND" },
        );
      }
      return iframeSrc;
    },
    WATCH_IFRAME_TTL,
  );
}

/**
 * Resolve episode slug → iframe URL via AnimeDekho watch page.
 * Fetches trid and refreshes cookie in parallel (both cached).
 * Tries HydraX first, then MirrorBot.
 */
async function resolveWatchPageUrl(
  episodeSlug: string,
  anilistId: string,
): Promise<string> {
  // trid fetch and cookie refresh are independent — run in parallel
  const [trid, cookie] = await Promise.all([
    fetchTrid(episodeSlug),
    ensureVerifiedCookie(episodeSlug),
  ]);

  if (!cookie) {
    throw Object.assign(
      new Error(`AnimeDekho watch-page session cookie unavailable (slug=${episodeSlug})`),
      { code: "UPSTREAM_ERROR" },
    );
  }

  let lastErr: unknown;
  for (const server of TRDEKHO_SERVERS) {
    try {
      const url = await fetchWatchIframeUrl(trid, server, cookie);
      logger.info(
        { anilistId, episodeSlug, trid, server },
        "[animedekho-wp] Resolved via watch-page",
      );
      return url;
    } catch (err) {
      lastErr = err;
      logger.debug(
        { server, err: (err as any)?.message },
        "[animedekho-wp] Server failed, trying next",
      );
    }
  }

  throw lastErr ?? Object.assign(
    new Error(`All watch-page servers exhausted for ${episodeSlug}`),
    { code: "CDN_NOT_FOUND" },
  );
}

// ── Search-based fallback (tertiary) ─────────────────────────────────────────
//
// Triggered when BOTH the Fribb CDN path AND the watch-page title-slug path fail.
// Searches AnimeDekho directly by title → finds real series slug + TMDB ID, then:
//   Priority 1: VidStream CDN embed  animedekho.app/embed/{tmdbId}/{season}-{ep}
//   Priority 2: HydraX              ?trdekho=0&trid={trid}&trtype=2
//   Priority 3: SRuby               ?trdekho=1&trid={trid}&trtype=2
//
// The TMDB ID is extracted from the series page badge link:
//   <a href="animedekho.app/download/map/anilist.php?id={tmdbId}">AniList</a>
// (AnimeDekho stores TMDB ID in this param, which redirects to the AniList page.)
//
// trid (internal episode post ID) is only visible in the page HTML when the
// verified session cookie is present — fetched WITH cookie here.

interface AdwSeriesInfo {
  seriesSlug: string;
  tmdbId: number | null;
  isMovie: boolean;
}

const adwSearchCache = new TtlCache<AdwSeriesInfo | null>(5 * 60_000);
const ADW_SEARCH_TTL = 6 * 60 * 60_000; // 6 h

/**
 * Return significant words (≥ 4 chars) from a title string, normalised to lowercase.
 * Used to cross-check AnimeDekho search results against known AniList titles.
 */
function titleWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

/**
 * Check whether an AnimeDekho page title is a plausible match for at least one
 * of the known AniList title variants.  Returns true when the two share at least
 * one significant word (≥ 4 chars) — enough to reject "BLOOM" → wrong anime.
 */
function titlesOverlap(adwPageTitle: string, anilistTitles: string[]): boolean {
  const adwWords = new Set(titleWords(adwPageTitle));
  for (const t of anilistTitles) {
    if (!t) continue;
    const tw = titleWords(t);
    if (tw.some((w) => adwWords.has(w))) return true;
  }
  return false;
}

/**
 * Search AnimeDekho by title and return series slug + TMDB ID.
 * Tries all title variants in order; caches result 6 h per AniList ID.
 *
 * Safeguards against false matches:
 *   1. Skips title variants shorter than 6 chars (e.g. "BLOOM") — too generic.
 *   2. Verifies the AnimeDekho series H1 title shares ≥ 1 significant word with
 *      the AniList title before accepting the result.
 */
async function searchAdwSeries(
  anilistId: string,
  titles: string[],
): Promise<AdwSeriesInfo | null> {
  const cacheKey = `adwsearch:${anilistId}`;
  return adwSearchCache.dedupe(
    cacheKey,
    async () => {
      for (const title of titles) {
        // ── Guard 1: skip trivially-short titles (too many false matches) ───────
        if (!title || title.trim().length < 6) continue;

        const res = await fetchWithTimeout(
          `https://animedekho.app/?s=${encodeURIComponent(title)}`,
          { headers: ANIMEDEKHO_HEADERS },
          10_000,
        ).catch(() => null);
        if (!res?.ok) continue;

        const html = await res.text();
        // Match /series-hindi/{slug}/ or /movie-hindi/{slug}/ content links
        // (skip nav-level hrefs which only end in /series-hindi/ or /movies-hindi/)
        const match = html.match(
          /href="https:\/\/animedekho\.app\/(series-hindi|movie-hindi)\/([^"\/]+)\/"/,
        );
        if (!match) continue;

        const [, type, slug] = match;
        const isMovie = type === "movie-hindi";

        // Fetch series page to extract TMDB ID + page title for verification
        const sRes = await fetchWithTimeout(
          `https://animedekho.app/${type}/${slug}/`,
          { headers: ANIMEDEKHO_HEADERS },
          10_000,
        ).catch(() => null);

        let tmdbId: number | null = null;
        let adwTitle: string | null = null;
        if (sRes?.ok) {
          const sHtml = await sRes.text();
          const m = sHtml.match(/anilist\.php\?id=(\d+)/);
          if (m) tmdbId = Number(m[1]);
          // H1 is the cleanest source: "Chainsmoker Cat" — no site suffix
          adwTitle =
            sHtml.match(/<h1[^>]*>([^<]+)/i)?.[1]?.trim() ??
            sHtml.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]?.trim() ??
            null;
        }

        // ── Guard 2: title verification — reject results that share no words ────
        if (adwTitle && !titlesOverlap(adwTitle, titles)) {
          logger.info(
            { anilistId, slug, adwTitle, titles },
            "[animedekho-search] Title mismatch — rejecting result, trying next variant",
          );
          continue;
        }

        logger.info(
          { anilistId, title, slug, tmdbId, isMovie, adwTitle },
          "[animedekho-search] Series found via AnimeDekho search",
        );
        return { seriesSlug: slug, tmdbId, isMovie };
      }
      logger.info({ anilistId }, "[animedekho-search] No match found in AnimeDekho search");
      return null;
    },
    ADW_SEARCH_TTL,
  );
}

/**
 * Fetch the trid (internal episode post ID) from the episode page WITH cookie.
 * data-lmt JWT is only injected into the TV episode page when the verified cookie is present.
 */
async function fetchTridWithCookie(
  episodeSlug: string,
  cookie: string,
): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://animedekho.app/epi/${episodeSlug}/`,
      { headers: { ...ANIMEDEKHO_HEADERS, Cookie: cookie } },
      12_000,
    );
    const html = await res.text();
    const lmtB64 = html.match(/data-lmt="([^"]+)"/)?.[1];
    if (!lmtB64) return null;
    const payload = JSON.parse(
      Buffer.from(lmtB64, "base64").toString("utf8"),
    ) as { lmt?: { id?: number } };
    return payload?.lmt?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch trid from a movie series page.
 * data-lmt is present on the movie page WITHOUT cookie (unlike TV episodes).
 * Movies use trtype=1; no cookie/verify flow required.
 */
async function fetchTridFromMoviePage(
  moviePageUrl: string,
): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      moviePageUrl,
      { headers: ANIMEDEKHO_HEADERS },
      12_000,
    );
    const html = await res.text();
    const lmtB64 = html.match(/data-lmt="([^"]+)"/)?.[1];
    if (!lmtB64) return null;
    const payload = JSON.parse(
      Buffer.from(lmtB64, "base64").toString("utf8"),
    ) as { lmt?: { id?: number } };
    return payload?.lmt?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Call trdekho endpoint and extract iframe src from the response.
 *   trdekho=0 → HydraX   trdekho=1 → SRuby
 *   trtype=2 → TV series  trtype=1 → Movie
 *   TV episodes require the verified cookie; movies do not.
 */
async function fetchTrdekhoIframeSrc(
  trid: number,
  trdekho: 0 | 1,
  cookie: string | null,
  trtype: 1 | 2 = 2,
): Promise<string | null> {
  try {
    const headers: Record<string, string> = { ...ANIMEDEKHO_HEADERS };
    if (cookie) headers.Cookie = cookie;
    const res = await fetchWithTimeout(
      `https://animedekho.app/?trdekho=${trdekho}&trid=${trid}&trtype=${trtype}`,
      { headers },
      12_000,
    );
    const html = await res.text();
    return html.match(/<iframe[^>]+src="([^"]+)"/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Full search-based fallback resolver.
 * Called only when Fribb CDN path + title-slug watch-page path both fail.
 */
async function resolveViaSearchFallback(
  anilistId: string,
  epNo: string,
  titles: string[],
  isMovieHint: boolean,
): Promise<string> {
  const absEp = Number(epNo);

  const info = await searchAdwSeries(anilistId, titles);
  if (!info) {
    throw Object.assign(
      new Error(
        `AnimeDekho search found no match for AniList ID ${anilistId}`,
      ),
      { code: "NO_MAPPING" },
    );
  }

  const { seriesSlug, tmdbId, isMovie } = info;

  // ── Movie path ──────────────────────────────────────────────────────────────
  if (isMovie || isMovieHint) {
    // Priority 1: VidStream CDN embed (needs TMDB ID)
    if (tmdbId) {
      const html = await fetchMovieEmbedHtml(tmdbId);
      if (html && htmlIsFound(html)) {
        const cdnUrl = extractCdnUrl(html);
        if (cdnUrl) {
          logger.info({ anilistId, tmdbId, cdnUrl }, "[animedekho-search] Movie CDN via search");
          return cdnUrl;
        }
      }
    }

    // Priority 2 & 3: trdekho via movie series page (trtype=1, no cookie needed)
    // data-lmt is present on the movie page without cookie; movies use trtype=1.
    const moviePageUrl = `https://animedekho.app/movie-hindi/${seriesSlug}/`;
    const trid = await fetchTridFromMoviePage(moviePageUrl);
    if (!trid) {
      throw Object.assign(
        new Error(`trid not found on movie page ${moviePageUrl}`),
        { code: "EP_NOT_FOUND" },
      );
    }

    for (const trdekho of [0, 1] as const) {
      const src = await fetchTrdekhoIframeSrc(trid, trdekho, null, 1);
      if (src) {
        logger.info({ anilistId, moviePageUrl, trid, trdekho, src }, "[animedekho-search] Movie via trdekho");
        return src;
      }
    }
    throw Object.assign(new Error("All servers failed for movie"), { code: "CDN_NOT_FOUND" });
  }

  // ── TV series path ──────────────────────────────────────────────────────────

  // Priority 1: VidStream CDN embed (needs TMDB ID + correct season)
  if (tmdbId) {
    let resolvedSeason = 1;
    try {
      resolvedSeason = await findSeasonForEpisode(tmdbId, absEp);
    } catch {
      // Season scan failed — use season 1 (AnimeDekho default for most shows)
    }
    const html = await fetchEmbedHtml(tmdbId, resolvedSeason, absEp);
    if (html && htmlIsFound(html)) {
      const cdnUrl = extractCdnUrl(html);
      if (cdnUrl) {
        logger.info(
          { anilistId, tmdbId, resolvedSeason, absEp, cdnUrl },
          "[animedekho-search] TV CDN via search",
        );
        return cdnUrl;
      }
    }
  }

  // Priority 2 & 3: HydraX then SRuby via trid (requires cookie)
  const episodeSlug = `${seriesSlug}-1x${absEp}`;
  const cookie = await ensureVerifiedCookie(episodeSlug);
  if (!cookie) {
    throw Object.assign(
      new Error("AnimeDekho session cookie unavailable"),
      { code: "UPSTREAM_ERROR" },
    );
  }

  const trid = await fetchTridWithCookie(episodeSlug, cookie);
  if (!trid) {
    throw Object.assign(
      new Error(`trid not found for episode slug ${episodeSlug} — episode may not exist`),
      { code: "EP_NOT_FOUND" },
    );
  }

  // trdekho=0 → HydraX, trdekho=1 → SRuby
  for (const trdekho of [0, 1] as const) {
    const src = await fetchTrdekhoIframeSrc(trid, trdekho, cookie);
    if (src) {
      logger.info(
        { anilistId, episodeSlug, trid, trdekho, src },
        "[animedekho-search] TV via trdekho server",
      );
      return src;
    }
  }

  throw Object.assign(
    new Error(`All servers (HydraX, SRuby) exhausted for ${episodeSlug}`),
    { code: "CDN_NOT_FOUND" },
  );
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Resolves AniList ID + episode number to a playable iframe URL from AnimeDekho.
 *
 * Primary path (CDN embed):
 *   animedekho.app/embed/{tmdbId}/{season}-{ep}  — requires Fribb TMDB mapping
 *
 * Fallback path (watch page — HydraX → MirrorBot):
 *   Triggered when the CDN embed returns EP_NOT_FOUND or CDN_NOT_FOUND, or
 *   when Fribb has no mapping at all for the AniList ID.
 *
 * Tertiary path (search-based — HydraX → SRuby):
 *   Triggered when the watch-page path also fails.
 *   Searches AnimeDekho by title → finds real slug + TMDB ID.
 *   Tries VidStream CDN first, then HydraX (trdekho=0), then SRuby (trdekho=1).
 *
 * Movies always use the CDN embed path only (no watch-page fallback).
 *
 * Error codes:
 *   NO_MAPPING    — AniList ID not in Fribb and watch page also unavailable
 *   EP_NOT_FOUND  — episode not available on AnimeDekho (both paths)
 *   CDN_NOT_FOUND — found on watch page but all servers failed
 *   UPSTREAM_ERROR — network failure
 */
export async function resolveAnimeDekhoUrl(
  anilistId: string,
  epNo: string,
): Promise<string> {
  const absEp = Number(epNo);
  const map = await getFribbMap();
  const mapping = map.get(Number(anilistId));

  // ── Movie: CDN embed first, then search-based fallback ──────────────────────
  if (mapping?.isMovie) {
    try {
      return await resolveMovieCdnUrl(mapping.tmdbId, anilistId);
    } catch (err: any) {
      if (err?.code === "UPSTREAM_ERROR") throw err;
      logger.info(
        { anilistId, tmdbId: mapping.tmdbId, code: err?.code },
        "[animedekho] Movie CDN not found — trying search fallback",
      );
      const aniMedia = await fetchAniMedia(anilistId).catch(() => null);
      const titles = [
        aniMedia?.title?.english,
        aniMedia?.title?.romaji,
        ...(aniMedia?.synonyms ?? []),
      ].filter(Boolean) as string[];
      return resolveViaSearchFallback(anilistId, "1", titles, true);
    }
  }

  // ── TV series: attempt CDN embed first ─────────────────────────────────────
  let resolvedSeason: number | null = null;
  let embedErr: (Error & { code?: string }) | null = null;

  if (mapping) {
    try {
      resolvedSeason =
        mapping.season !== null
          ? mapping.season
          : await findSeasonForEpisode(mapping.tmdbId, absEp);

      const embedKey = `tv:${mapping.tmdbId}:${resolvedSeason}:${absEp}`;
      const cdnUrl = await cdnCache.dedupe(
        embedKey,
        async () => {
          const html = await fetchEmbedHtml(mapping.tmdbId, resolvedSeason!, absEp);
          if (html === null) {
            throw Object.assign(
              new Error("AnimeDekho embed request failed"),
              { code: "UPSTREAM_ERROR" },
            );
          }
          if (!htmlIsFound(html)) {
            throw Object.assign(
              new Error(
                `Episode not found on AnimeDekho embed (TMDB ${mapping.tmdbId} S${resolvedSeason}E${absEp})`,
              ),
              { code: "EP_NOT_FOUND" },
            );
          }
          const url = extractCdnUrl(html);
          if (!url) {
            throw Object.assign(
              new Error(
                `No CDN iframe in AnimeDekho embed (TMDB ${mapping.tmdbId} S${resolvedSeason}E${absEp})`,
              ),
              { code: "CDN_NOT_FOUND" },
            );
          }
          logger.debug(
            { anilistId, epNo, season: resolvedSeason, url },
            "[animedekho] CDN URL extracted",
          );
          return url;
        },
        CDN_TTL,
      );
      return cdnUrl;
    } catch (err: any) {
      embedErr = err;
      // Hard network failure — don't attempt fallback, surface immediately
      if (err?.code === "UPSTREAM_ERROR") throw err;
      logger.info(
        { anilistId, epNo, code: err?.code },
        "[animedekho] CDN embed unavailable — trying watch-page fallback",
      );
    }
  } else {
    embedErr = Object.assign(
      new Error(`No TMDB mapping for AniList ID ${anilistId}`),
      { code: "NO_MAPPING" },
    );
    logger.info(
      { anilistId },
      "[animedekho] No Fribb mapping — trying watch-page fallback",
    );
  }

  // ── Watch-page fallback ─────────────────────────────────────────────────────
  // Build episode slug from AniList English title (falls back to romaji).
  const aniMedia = await fetchAniMedia(anilistId).catch(() => null);
  const title = aniMedia?.title?.english ?? aniMedia?.title?.romaji;
  if (!title) {
    // Cannot build a slug without a title — surface the original error
    throw embedErr!;
  }

  const season = resolvedSeason ?? 1; // default season 1 when Fribb had no mapping
  const epSlug = `${slugifyTitle(title)}-${season}x${absEp}`;

  try {
    return await resolveWatchPageUrl(epSlug, anilistId);
  } catch (wpErr: any) {
    // ── Search-based fallback (tertiary) ─────────────────────────────────────
    logger.info(
      { anilistId, epNo, wpErr: wpErr?.message },
      "[animedekho] Watch-page fallback failed — trying AnimeDekho search fallback",
    );
    const allTitles = [
      title,
      aniMedia?.title?.romaji,
      ...(aniMedia?.synonyms ?? []),
    ].filter(Boolean) as string[];
    const isMovieHint = aniMedia?.format === "MOVIE";
    return resolveViaSearchFallback(anilistId, epNo, allTitles, isMovieHint);
  }
}
