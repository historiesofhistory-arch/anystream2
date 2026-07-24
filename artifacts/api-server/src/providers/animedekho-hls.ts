/**
 * AnimeDekho HLS extractor — TEST provider (?p=adt)
 *
 * Works exclusively in AnimeDekho's fallback / watch-page system.
 * Does NOT touch the primary CDN embed path (VidStream CDN).
 *
 * Servers tried (in order):
 *   5 = VidMoly      vidmoly.biz          ← most likely HLS
 *   4 = VidCloud     vidcloud.upns.ink
 *   3 = SRuby        rubystm.com
 *   7 = MirrorXerver mirror.xerver.xyz
 *   2 = Pixeldrain   animedekho.app/aaa/pixel/
 *
 * Skipped (as instructed):
 *   1 = HydraX       abyssplayer.com
 *   6 = GD MirrorBot gdmirrorbot.nl
 *   VidStream CDN    as-cdn21.top / play.zephyrflick.top
 *
 * Referrer strategy:
 *   1. Fetch embed page with empty Referer
 *   2. If fails, retry with animedekho.app Referer
 *   3. HEAD-test extracted m3u8 with no Referer to detect if proxy is needed
 *
 * animedekho.ts is NOT imported or modified — all required logic is
 * re-implemented here independently so the existing ?p=ad provider is
 * completely unaffected.
 */

import { fetchWithTimeout } from "../lib/cache.js";
import { fetchAdw } from "../lib/proxy.js";
import { fetchAniMedia } from "../lib/anilist.js";
import { logger } from "../lib/logger.js";

// ── Shared headers ────────────────────────────────────────────────────────────

const ADW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ADW_HEADERS: Record<string, string> = {
  "User-Agent": ADW_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://animedekho.app/",
};

// ── Servers to probe ─────────────────────────────────────────────────────────

// trdekho server IDs (same numbering as animedekho.ts comment block)
const HLS_SERVERS = [5, 4, 3, 7, 2] as const;
type HlsServer = (typeof HLS_SERVERS)[number];

const SERVER_NAMES: Record<HlsServer, string> = {
  5: "VidMoly",
  4: "VidCloud",
  3: "SRuby",
  7: "MirrorXerver",
  2: "Pixeldrain",
};

// ── Helper: WP-style slug (same algorithm as animedekho.ts) ──────────────────

export function slugifyForHls(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Step 1: Fetch trid from episode page ─────────────────────────────────────

async function fetchTrid(episodeSlug: string): Promise<number | null> {
  try {
    const res = await fetchAdw(
      `https://animedekho.app/epi/${episodeSlug}/`,
      { headers: ADW_HEADERS },
      12_000,
    );
    const html = await res.text();

    if (html.match(/<title>[^<]*not found/i)) return null;

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

// ── Step 2: Obtain verified session cookie ───────────────────────────────────

async function fetchVerifiedCookie(episodeSlug: string): Promise<string | null> {
  try {
    const pageRes = await fetchAdw(
      `https://animedekho.app/epi/${episodeSlug}/`,
      { headers: ADW_HEADERS },
      12_000,
    );
    const html = await pageRes.text();

    const verifyUrl =
      html.match(/name="shortlink"[^>]+value="([^"]+)"/)?.[1] ??
      html.match(/value="(https:\/\/animedekho\.app\/24hr\/verify\.php[^"]+)"/)?.[1];

    if (!verifyUrl) {
      // Site may have already verified this IP — use known default
      return "toronites_server=vidstream";
    }

    const verRes = await fetchAdw(
      verifyUrl,
      {
        headers: {
          ...ADW_HEADERS,
          Referer: `https://animedekho.app/epi/${episodeSlug}/`,
        },
        redirect: "manual",
      },
      10_000,
    );

    const rawCookies: string[] =
      typeof (verRes.headers as any).getSetCookie === "function"
        ? (verRes.headers as any).getSetCookie()
        : [verRes.headers.get("set-cookie") ?? ""];

    const match = rawCookies.find((c) => c.startsWith("toronites_server="));
    return match ? match.split(";")[0].trim() : "toronites_server=vidstream";
  } catch {
    return null;
  }
}

// ── Step 3: Get iframe URL from trdekho endpoint ─────────────────────────────

async function getTrdekhoEmbed(
  trid: number,
  server: number,
  cookie: string,
): Promise<string | null> {
  try {
    const res = await fetchAdw(
      `https://animedekho.app/?trdekho=${server}&trid=${trid}&trtype=2`,
      { headers: { ...ADW_HEADERS, Cookie: cookie } },
      12_000,
    );
    const html = await res.text();
    return html.match(/<iframe[^>]+src="([^"]+)"/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ── Step 4: Extract HLS m3u8 URL from an embed page ─────────────────────────

/**
 * Patterns covering JW Player, Plyr, Video.js, and custom players.
 * Each pattern's first capture group is the m3u8 URL.
 */
const HLS_PATTERNS: RegExp[] = [
  // JW Player setup: { file: "...m3u8" }
  /['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/gi,
  // sources array: [{src: "...m3u8"}]
  /src\s*:\s*['"]( https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/gi,
  // source attribute in <source> tags
  /<source[^>]+src=["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
  // Generic m3u8 URLs (last resort — broader)
  /(https?:\/\/(?:[a-z0-9\-]+\.)+[a-z]{2,}\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/gi,
];

function extractM3u8(html: string): string | null {
  for (const pattern of HLS_PATTERNS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(html);
    if (m) {
      const url = (m[1] ?? m[0]).trim();
      // Basic sanity: must start with http and end with m3u8 (optionally query params)
      if (/^https?:\/\/.+\.m3u8/i.test(url)) return url;
    }
  }
  return null;
}

/**
 * Fetch embed page HTML.
 * Strategy:
 *   1. Empty Referer (best: no hotlink protection triggered)
 *   2. animedekho.app Referer
 *   3. Embed's own origin as Referer
 */
async function fetchEmbedHtml(embedUrl: string): Promise<string | null> {
  const attempts: Array<Record<string, string>> = [
    // Attempt 1 — empty Referer
    { "User-Agent": ADW_UA, Accept: "text/html,*/*", Referer: "" },
    // Attempt 2 — animedekho.app as Referer
    { "User-Agent": ADW_UA, Accept: "text/html,*/*", Referer: "https://animedekho.app/" },
  ];

  // Attempt 3 — embed's own origin (e.g. vidmoly.biz/)
  try {
    const origin = new URL(embedUrl).origin + "/";
    attempts.push({ "User-Agent": ADW_UA, Accept: "text/html,*/*", Referer: origin });
  } catch { /* malformed URL — skip */ }

  for (const headers of attempts) {
    try {
      const res = await fetchAdw(embedUrl, { headers }, 12_000);
      if (res.ok) return await res.text();
    } catch { /* try next */ }
  }
  return null;
}

/**
 * HEAD-test an m3u8 URL to see if it's directly accessible.
 * Returns true if HTTP 200 or 206 without Referer.
 */
async function testDirectAccess(url: string): Promise<boolean> {
  try {
    const res = await fetchAdw(
      url,
      {
        method: "HEAD",
        headers: { "User-Agent": ADW_UA, Referer: "" },
      },
      8_000,
    );
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface HlsResult {
  /** Direct HLS playlist URL */
  hls: string;
  /** trdekho server number that yielded the HLS */
  server: number;
  /** Human-readable server name */
  serverName: string;
  /** The embed iframe URL we extracted the HLS from */
  embedUrl: string;
  /**
   * true  → m3u8 is hotlink-protected; you need a proxy (e.g. Cloudflare Worker
   *         with `Referer: https://animedekho.app/` header forwarding).
   * false → m3u8 is publicly accessible; embed/play directly.
   */
  proxyNeeded: boolean;
  /** Referer value that makes the m3u8 accessible (useful when proxyNeeded=true) */
  workingReferer: string;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Resolve AniList ID + episode number → direct HLS stream URL from
 * AnimeDekho's fallback / watch-page server system.
 *
 * Flow:
 *   1. Fetch AniList title to build the AnimeDekho episode slug.
 *   2. Fetch trid + verified cookie in parallel (independent requests).
 *   3. For each candidate server: get trdekho iframe URL → fetch embed
 *      page → extract m3u8 → HEAD-test for direct access.
 *   4. Return on first successful extraction.
 */
export async function resolveAnimeDekhoHls(
  anilistId: string,
  epNo: string,
): Promise<HlsResult> {
  // ── Build episode slug ───────────────────────────────────────────────────
  const aniMedia = await fetchAniMedia(anilistId).catch(() => null);
  const title = aniMedia?.title?.english ?? aniMedia?.title?.romaji;
  if (!title) {
    throw Object.assign(
      new Error(`Cannot resolve AniList title for ID ${anilistId}`),
      { code: "NO_TITLE" },
    );
  }

  // Season 1 is the safe default for the fallback slug
  const epSlug = `${slugifyForHls(title)}-1x${epNo}`;
  logger.debug({ anilistId, epNo, epSlug }, "[animedekho-hls] Resolving HLS");

  // ── Fetch trid + cookie in parallel ─────────────────────────────────────
  const [trid, cookie] = await Promise.all([
    fetchTrid(epSlug),
    fetchVerifiedCookie(epSlug),
  ]);

  if (trid === null) {
    throw Object.assign(
      new Error(`Episode not found on AnimeDekho watch page (slug=${epSlug})`),
      { code: "EP_NOT_FOUND" },
    );
  }
  if (!cookie) {
    throw Object.assign(
      new Error("AnimeDekho session cookie unavailable"),
      { code: "UPSTREAM_ERROR" },
    );
  }

  logger.debug({ trid, epSlug }, "[animedekho-hls] trid + cookie ready");

  // ── Try each server ──────────────────────────────────────────────────────
  for (const server of HLS_SERVERS) {
    const serverName = SERVER_NAMES[server];

    const embedUrl = await getTrdekhoEmbed(trid, server, cookie);
    if (!embedUrl) {
      logger.debug({ server, serverName }, "[animedekho-hls] trdekho returned no iframe — skip");
      continue;
    }

    logger.debug({ server, serverName, embedUrl }, "[animedekho-hls] Fetching embed page");

    const html = await fetchEmbedHtml(embedUrl);
    if (!html) {
      logger.debug({ server, serverName }, "[animedekho-hls] Embed page fetch failed — skip");
      continue;
    }

    const m3u8 = extractM3u8(html);
    if (!m3u8) {
      logger.debug({ server, serverName }, "[animedekho-hls] No m3u8 found in embed — skip");
      continue;
    }

    // Determine if proxy is needed
    const directOk = await testDirectAccess(m3u8);
    let proxyNeeded = !directOk;
    let workingReferer = "";

    if (proxyNeeded) {
      // Try animedekho.app as referrer — most CDNs allow the parent site
      workingReferer = "https://animedekho.app/";
    }

    logger.info(
      { anilistId, epNo, server, serverName, m3u8, proxyNeeded, workingReferer },
      "[animedekho-hls] HLS resolved",
    );

    return {
      hls: m3u8,
      server,
      serverName,
      embedUrl,
      proxyNeeded,
      workingReferer,
    };
  }

  throw Object.assign(
    new Error(
      `No HLS stream found in any AnimeDekho fallback server for ${epSlug} ` +
        `(tried: ${HLS_SERVERS.map((s) => `${SERVER_NAMES[s]}(${s})`).join(", ")})`,
    ),
    { code: "CDN_NOT_FOUND" },
  );
}
