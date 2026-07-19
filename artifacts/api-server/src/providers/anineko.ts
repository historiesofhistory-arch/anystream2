/**
 * AniNeko provider (anineko.to)
 *
 * Resolves AniList ID → anineko.to slug using:
 *   1. AniList GraphQL → all title variants
 *   2. Multi-query search on anineko.to
 *   3. Dice coefficient scoring (bigram similarity)
 *   4. Episode count cross-validation (finished shows)
 *   5. 24h in-memory cache
 *
 * Then scrapes the episode watch page for the embed URL
 * matching the requested audio type (hsub / sub / dub).
 */

import { fetchWithTimeout } from "../lib/cache.js";
import { fetchAniMedia as fetchAniListMedia, type AniMedia } from "../lib/anilist.js";

const BASE = "https://anineko.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Proxy-allowed embed hosts, in preference order
const EMBED_HOSTS = ["vivibebe.site", "bibiemb.xyz", "otakuhg.site"];

// ── Cache ────────────────────────────────────────────────────────────────────

const slugCache  = new Map<string, { slug: string; ts: number }>();
const embedCache = new Map<string, { url: string; ts: number }>();   // ep embed URL
const CACHE_TTL  = 24 * 60 * 60 * 1000; // 24 h — slug
const EMBED_TTL  =  2 * 60 * 60 * 1000; //  2 h — embed URL per ep+type

// ── Dice Coefficient (bigram similarity) ─────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const n = norm(s);
  const m = new Map<string, number>();
  for (let i = 0; i < n.length - 1; i++) {
    const bg = n.slice(i, i + 2);
    if (bg.trim().length === 2) m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

export function diceCoeff(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  const ta = [...A.values()].reduce((s, v) => s + v, 0);
  const tb = [...B.values()].reduce((s, v) => s + v, 0);
  if (!ta || !tb) return 0;
  let shared = 0;
  for (const [bg, cnt] of A) shared += Math.min(cnt, B.get(bg) ?? 0);
  return (2 * shared) / (ta + tb);
}

// ── AniList ──────────────────────────────────────────────────────────────────

// AniMedia is imported from ../lib/anilist.js — see import at top of file

// ── anineko Search ───────────────────────────────────────────────────────────

async function searchAnineko(query: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      `${BASE}/browser?keyword=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": UA, Accept: "text/html" } },
      8_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const slugs: string[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(/href="\/watch\/([a-z0-9][a-z0-9-]*[a-z0-9])"/g)) {
      const slug = m[1];
      if (!seen.has(slug)) {
        seen.add(slug);
        slugs.push(slug);
      }
    }
    return slugs;
  } catch {
    return [];
  }
}

// ── Episode Count (for validation) ──────────────────────────────────────────

async function fetchEpCount(slug: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${BASE}/watch/${slug}`, {
      headers: { "User-Agent": UA },
    }, 8_000);
    if (!res.ok) return 0;
    const html = await res.text();
    // All ep-N links on the series page
    const nums = [...html.matchAll(/\/watch\/[^"]+\/ep-(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    if (nums.length) return Math.max(...nums);
    // Fallback: "X Episodes" text
    const m = html.match(/(\d+)\s*Episodes?/i);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

// ── Search Query Builder ─────────────────────────────────────────────────────

function buildQueries(titles: string[]): string[] {
  const qs = new Set<string>();
  for (const t of titles.slice(0, 3)) {
    if (!t) continue;
    qs.add(t);
    const words = t.trim().split(/\s+/);
    if (words.length > 4) qs.add(words.slice(0, 4).join(" "));
    if (words.length > 3) qs.add(words.slice(0, 3).join(" "));
    // Strip season / part / ordinals
    const stripped = t
      .replace(/\b(season|part|cour)\s*\d+\b/gi, "")
      .replace(/\b\d+(st|nd|rd|th)\s*(?:season)?\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped && stripped !== t && stripped.length >= 3) qs.add(stripped);
  }
  return [...qs].filter((q) => q.length >= 3);
}

// ── Slug Resolution (main export) ────────────────────────────────────────────

export async function resolveSlug(anilistId: string): Promise<string | null> {
  // Cache hit
  const cached = slugCache.get(anilistId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.slug;

  const media = await fetchAniListMedia(anilistId);
  if (!media) return null;

  const isMovie = media.format === "MOVIE";

  const titles = [
    media.title.english,
    media.title.romaji,
    ...media.synonyms,
  ].filter(Boolean) as string[];

  if (!titles.length) return null;

  // Collect unique candidates from all queries in parallel
  const queries = buildQueries(titles);
  const allSlugs = new Set<string>();
  const results = await Promise.all(queries.map((q) => searchAnineko(q)));
  for (const batch of results) for (const slug of batch) allSlugs.add(slug);

  if (!allSlugs.size) return null;

  // Score: best Dice between any title and the slug-as-title.
  // For movies, give a +0.15 bonus when the slug contains "movie" — anineko
  // appends "-movie" to movie slugs (e.g. "jujutsu-kaisen-0-movie").
  const scored = [...allSlugs]
    .map((slug) => {
      const slugTitle = slug.replace(/-/g, " ");
      const base = Math.max(
        ...titles.slice(0, 3).map((t) => diceCoeff(t, slugTitle)),
      );
      const movieBonus = isMovie && slug.includes("movie") ? 0.15 : 0;
      return { slug, score: base + movieBonus };
    })
    .filter((c) => c.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!scored.length) return null;

  // Fast path: very high title similarity → skip episode count fetch
  if (scored[0].score >= 0.92) {
    slugCache.set(anilistId, { slug: scored[0].slug, ts: Date.now() });
    return scored[0].slug;
  }

  // Movies: ep count is 1; validate and use ep count bonus normally
  const expected = media.episodes;

  if (expected) {
    // Validate top 3 with episode count (parallel)
    const validated = await Promise.all(
      scored.slice(0, 3).map(async (c) => {
        const epCount = await fetchEpCount(c.slug);
        const bonus =
          epCount === expected ? 0.3 : Math.abs(epCount - expected) <= 1 ? 0.1 : 0;
        return { ...c, final: c.score + bonus };
      }),
    );
    const best = validated.sort((a, b) => b.final - a.final)[0];
    if (best.final >= 0.65) {
      slugCache.set(anilistId, { slug: best.slug, ts: Date.now() });
      return best.slug;
    }
    return null;
  } else {
    // Ongoing — require higher title confidence
    if (scored[0].score >= 0.75) {
      slugCache.set(anilistId, { slug: scored[0].slug, ts: Date.now() });
      return scored[0].slug;
    }
    return null;
  }
}

// ── Episode Embed Scraper ────────────────────────────────────────────────────

export type AninekoType = "hsub" | "sub" | "dub";

export async function scrapeEmbed(
  slug: string,
  epNo: string,
  type: AninekoType,
): Promise<string | null> {
  // Cache embed URL per slug+ep+type for 2 h — same episode page doesn't change.
  // This is the most important cache: without it every user triggers a fresh
  // anineko.to fetch, and 1M users/day = 1M requests from one IP → instant ban.
  const embedKey = `${slug}:${epNo}:${type}`;
  const cached = embedCache.get(embedKey);
  if (cached && Date.now() - cached.ts < EMBED_TTL) return cached.url;

  try {
    const res = await fetchWithTimeout(`${BASE}/watch/${slug}/ep-${epNo}`, {
      headers: { "User-Agent": UA, Referer: `${BASE}/` },
    }, 8_000);
    if (!res.ok) return null;
    const html = await res.text();

    // Find the lang-group CONTENT div (not the tab button) for this audio type.
    // The content div always has the class "lang-group" in the same opening tag
    // as data-id="<type>". Tab buttons are <button> elements, not <div>s.
    //
    // Pattern: <div ... class="...lang-group..." ... data-id="<type>" ...>
    //       or <div ... data-id="<type>" ... class="...lang-group..." ...>
    const divTagRe = new RegExp(
      `<div[^>]*class="[^"]*lang-group[^"]*"[^>]*data-id="${type}"[^>]*>` +
      `|<div[^>]*data-id="${type}"[^>]*class="[^"]*lang-group[^"]*"[^>]*>`,
      "i",
    );
    const divM = divTagRe.exec(html);
    if (!divM) return null;

    const sectionStart = divM.index + divM[0].length;

    // Section ends at the next lang-group div or end of string
    const nextDivRe =
      /<div[^>]*class="[^"]*lang-group[^"]*"[^>]*data-id="|<div[^>]*data-id="[^"]*"[^>]*class="[^"]*lang-group/i;
    const rest = html.slice(sectionStart);
    const nextM = nextDivRe.exec(rest);
    const section = nextM
      ? rest.slice(0, nextM.index)
      : rest;

    // Return first data-video from an allowed (proxy-whitelisted) host
    for (const m of section.matchAll(/data-video="(https?:\/\/[^"]+)"/g)) {
      try {
        if (EMBED_HOSTS.includes(new URL(m[1]).hostname)) {
          const url = m[1];
          embedCache.set(embedKey, { url, ts: Date.now() });
          return url;
        }
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}
