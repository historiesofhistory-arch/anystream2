/**
 * GET /api/test/adw?anilistId=&epNo=
 *
 * AnimeDekho server diagnostic — TESTING ONLY.
 * Tries every known trdekho server ID, shows CDN embed URL, and embeds
 * the watch-page HTML snippet so we can spot undiscovered server buttons.
 *
 * Default: Solo Leveling (AniList 170942), episode 1.
 */

import { Router } from "express";
import { fetchWithTimeout } from "../lib/cache.js";

const router = Router();

const DEFAULT_ANILIST_ID = "170942"; // Solo Leveling (2024 anime)
const DEFAULT_EP = "1";

// ── Shared headers ────────────────────────────────────────────────────────────

const ADW_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://animedekho.app/",
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── AniList ───────────────────────────────────────────────────────────────────

interface AniMedia {
  format: string | null;
  title: { english: string | null; romaji: string | null };
  episodes: number | null;
  synonyms: string[];
}

async function fetchAniMedia(id: string): Promise<AniMedia | null> {
  try {
    const res = await fetchWithTimeout(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `query($id:Int){Media(id:$id,type:ANIME){format title{english romaji}episodes synonyms}}`,
          variables: { id: Number(id) },
        }),
      },
      8_000,
    );
    const json = (await res.json()) as { data?: { Media?: AniMedia } };
    return json?.data?.Media ?? null;
  } catch {
    return null;
  }
}

// ── AnimeDekho search → series slug ──────────────────────────────────────────

interface SeriesInfo {
  slug: string;
  type: "series-hindi" | "movie-hindi";
  tmdbId: number | null;
  pageTitle: string | null;
  serverHtml: string | null; // raw server-selection HTML for discovery
}

async function findSeries(titles: string[]): Promise<SeriesInfo | null> {
  for (const title of titles) {
    if (!title || title.trim().length < 4) continue;
    try {
      const res = await fetchWithTimeout(
        `https://animedekho.app/?s=${encodeURIComponent(title)}`,
        { headers: ADW_HEADERS },
        10_000,
      );
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(
        /href="https:\/\/animedekho\.app\/(series-hindi|movie-hindi)\/([^"\/]+)\/"/,
      );
      if (!m) continue;
      const [, type, slug] = m as [string, "series-hindi" | "movie-hindi", string];

      // Fetch series page for tmdbId, title, and raw server HTML
      const sRes = await fetchWithTimeout(
        `https://animedekho.app/${type}/${slug}/`,
        { headers: ADW_HEADERS },
        10_000,
      );
      let tmdbId: number | null = null;
      let pageTitle: string | null = null;
      let serverHtml: string | null = null;

      if (sRes.ok) {
        const sHtml = await sRes.text();
        const tm = sHtml.match(/anilist\.php\?id=(\d+)/);
        if (tm) tmdbId = Number(tm[1]);
        pageTitle =
          sHtml.match(/<h1[^>]*>([^<]+)/i)?.[1]?.trim() ?? null;
        // Grab the server-selector section (usually inside a <ul> with class "server-list" or similar)
        const serverSection =
          sHtml.match(/(<(?:ul|div)[^>]*(?:server|trdekho|player)[^>]*>[\s\S]{0,4000}?<\/(?:ul|div)>)/i)?.[1] ??
          sHtml.match(/(trdekho[\s\S]{0,3000})/i)?.[1]?.slice(0, 2000) ??
          null;
        serverHtml = serverSection;
      }
      return { slug, type, tmdbId, pageTitle, serverHtml };
    } catch { /* try next title */ }
  }
  return null;
}

// ── Cookie flow ───────────────────────────────────────────────────────────────

async function getCookie(episodeSlug: string): Promise<string> {
  try {
    const pageRes = await fetchWithTimeout(
      `https://animedekho.app/epi/${episodeSlug}/`,
      { headers: ADW_HEADERS },
      12_000,
    );
    const html = await pageRes.text();
    const verifyUrl =
      html.match(/name="shortlink"[^>]+value="([^"]+)"/)?.[1] ??
      html.match(/value="(https:\/\/animedekho\.app\/24hr\/verify\.php[^"]+)"/)?.[1];

    if (!verifyUrl) return "toronites_server=vidstream";

    const verRes = await fetchWithTimeout(
      verifyUrl,
      {
        headers: { ...ADW_HEADERS, Referer: `https://animedekho.app/epi/${episodeSlug}/` },
        redirect: "manual",
      },
      10_000,
    );
    const rawCookies: string[] =
      typeof (verRes.headers as any).getSetCookie === "function"
        ? (verRes.headers as any).getSetCookie()
        : [verRes.headers.get("set-cookie") ?? ""];
    const found = rawCookies.find((c) => c.startsWith("toronites_server="));
    return found ? found.split(";")[0].trim() : "toronites_server=vidstream";
  } catch {
    return "toronites_server=vidstream";
  }
}

// ── trid (with cookie) ────────────────────────────────────────────────────────

async function getTrid(episodeSlug: string, cookie: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://animedekho.app/epi/${episodeSlug}/`,
      { headers: { ...ADW_HEADERS, Cookie: cookie } },
      12_000,
    );
    const html = await res.text();
    const lmtB64 = html.match(/data-lmt="([^"]+)"/)?.[1];
    if (!lmtB64) return null;
    const payload = JSON.parse(Buffer.from(lmtB64, "base64").toString("utf8")) as {
      lmt?: { id?: number };
    };
    return payload?.lmt?.id ?? null;
  } catch {
    return null;
  }
}

// ── trdekho iframe src ────────────────────────────────────────────────────────

async function getTrdekhoUrl(
  trid: number,
  server: number,
  cookie: string,
): Promise<{ url: string | null; raw: string | null; status: number | null }> {
  try {
    const res = await fetchWithTimeout(
      `https://animedekho.app/?trdekho=${server}&trid=${trid}&trtype=2`,
      { headers: { ...ADW_HEADERS, Cookie: cookie } },
      12_000,
    );
    const html = await res.text();
    const url = html.match(/<iframe[^>]+src="([^"]+)"/i)?.[1] ?? null;
    return { url, raw: html.slice(0, 500), status: res.status };
  } catch (e: any) {
    return { url: null, raw: e?.message ?? "fetch failed", status: null };
  }
}

// ── CDN embed URL ─────────────────────────────────────────────────────────────

async function getCdnUrl(
  tmdbId: number,
  season: number,
  ep: number,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://animedekho.app/embed/${tmdbId}/${season}-${ep}`,
      { headers: ADW_HEADERS },
      12_000,
    );
    const html = await res.text();
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
    if (title.toLowerCase().includes("not found")) return null;
    const CDN_HOSTS = ["as-cdn21.top", "play.zephyrflick.top"];
    const iframeRe = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = iframeRe.exec(html)) !== null) {
      try {
        if (CDN_HOSTS.includes(new URL(m[1]).hostname)) return m[1];
      } catch { /* skip */ }
    }
    return null;
  } catch {
    return null;
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function badge(ok: boolean, label: string): string {
  const color = ok ? "#22c55e" : "#ef4444";
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700">${esc(label)}</span>`;
}

function buildHtml(opts: {
  anilistId: string;
  epNo: string;
  media: AniMedia | null;
  series: SeriesInfo | null;
  episodeSlug: string;
  cookie: string;
  trid: number | null;
  cdnUrl: string | null;
  servers: Array<{ id: number; label: string; url: string | null; raw: string | null }>;
  elapsed: number;
}): string {
  const title = opts.media?.title?.english ?? opts.media?.title?.romaji ?? `AniList ${opts.anilistId}`;

  const serverRows = opts.servers
    .map((s) => {
      const hasUrl = !!s.url;
      const hostname = s.url ? (() => { try { return new URL(s.url!).hostname; } catch { return s.url; } })() : "—";
      return `
      <div class="card" id="server-${s.id}">
        <div class="card-header">
          <span class="server-id">trdekho=${s.id}</span>
          <span class="server-label">${esc(s.label)}</span>
          ${badge(hasUrl, hasUrl ? "✓ URL found" : "✗ no URL")}
        </div>
        ${hasUrl ? `
        <div class="url-row">
          <code>${esc(s.url!)}</code>
          <a href="${esc(s.url!)}" target="_blank" class="btn">Open ↗</a>
        </div>
        <div class="host-row">Host: <b>${esc(hostname ?? "")}</b></div>
        <div class="iframe-wrap">
          <iframe src="${esc(s.url!)}" referrerpolicy="unsafe-url" allow="autoplay;fullscreen" allowfullscreen loading="lazy"></iframe>
        </div>
        ` : `<div class="null-row">Response snippet: <code>${esc(s.raw?.slice(0, 200) ?? "—")}</code></div>`}
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ADW Test — ${esc(title)} Ep ${esc(opts.epNo)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f13; color: #e2e2e2; font-family: system-ui,sans-serif; padding: 24px; }
  h1 { font-size: 1.4rem; color: #fff; margin-bottom: 4px; }
  .meta { color: #888; font-size: 13px; margin-bottom: 20px; }
  .meta b { color: #aaa; }
  .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin: 24px 0 10px; }
  .card { background: #1a1a24; border: 1px solid #2a2a38; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .card-header { display: flex; gap: 10px; align-items: center; padding: 12px 16px; background: #16161e; border-bottom: 1px solid #2a2a38; flex-wrap: wrap; }
  .server-id { font-family: monospace; font-size: 13px; color: #7c83d6; font-weight: 700; }
  .server-label { font-size: 13px; color: #aaa; flex: 1; }
  .url-row { padding: 10px 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: #12121a; }
  .url-row code { font-size: 11px; color: #9de8a8; word-break: break-all; flex: 1; }
  .host-row { padding: 4px 16px 8px; font-size: 12px; color: #888; background: #12121a; }
  .null-row { padding: 10px 16px; font-size: 12px; color: #888; }
  .null-row code { color: #ef4444; font-size: 11px; }
  .iframe-wrap { width: 100%; aspect-ratio: 16/9; background: #000; }
  .iframe-wrap iframe { width: 100%; height: 100%; border: none; }
  .btn { background: #7c83d6; color: #fff; padding: 4px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; white-space: nowrap; }
  .cdn-card { background: #0d1f12; border: 1px solid #2a4a2e; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .cdn-card .label { font-size: 12px; color: #4ade80; font-weight: 700; margin-bottom: 6px; }
  .cdn-card code { font-size: 11px; color: #9de8a8; word-break: break-all; display: block; margin: 6px 0; }
  .cdn-iframe { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 6px; overflow: hidden; margin-top: 10px; }
  .cdn-iframe iframe { width: 100%; height: 100%; border: none; }
  .info-grid { display: grid; grid-template-columns: 120px 1fr; gap: 4px 12px; font-size: 12px; margin-bottom: 14px; }
  .info-grid dt { color: #666; }
  .info-grid dd { color: #ccc; font-family: monospace; word-break: break-all; }
  .raw-html { background: #0a0a10; border: 1px solid #2a2a38; border-radius: 6px; padding: 12px; font-size: 11px; color: #888; font-family: monospace; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; margin-top: 8px; }
  .elapsed { color: #555; font-size: 11px; margin-top: 20px; }
</style>
</head>
<body>
<h1>AnimeDekho Server Test 🔬</h1>
<div class="meta">
  <b>${esc(title)}</b> · Episode ${esc(opts.epNo)} · AniList ID: ${esc(opts.anilistId)}
  ${opts.media ? `· Format: ${esc(opts.media.format ?? "?")} · Episodes: ${opts.media.episodes ?? "?"}` : ""}
</div>

<div class="section-title">Resolved Info</div>
<dl class="info-grid">
  <dt>Series slug</dt><dd>${esc(opts.series?.slug ?? "not found")}</dd>
  <dt>Type</dt><dd>${esc(opts.series?.type ?? "—")}</dd>
  <dt>TMDB ID</dt><dd>${opts.series?.tmdbId ?? "—"}</dd>
  <dt>ADW title</dt><dd>${esc(opts.series?.pageTitle ?? "—")}</dd>
  <dt>Episode slug</dt><dd>${esc(opts.episodeSlug)}</dd>
  <dt>Cookie</dt><dd>${esc(opts.cookie)}</dd>
  <dt>trid</dt><dd>${opts.trid ?? "not found ⚠️"}</dd>
</dl>

${opts.series?.serverHtml ? `
<div class="section-title">AnimeDekho Server Selection HTML (raw)</div>
<div class="raw-html">${esc(opts.series.serverHtml)}</div>
` : ""}

<div class="section-title">CDN Embed (Primary Path — VidStream)</div>
${opts.cdnUrl ? `
<div class="cdn-card">
  <div class="label">✅ CDN URL found — ${esc((() => { try { return new URL(opts.cdnUrl!).hostname; } catch { return opts.cdnUrl!; } })())}</div>
  <code>${esc(opts.cdnUrl)}</code>
  <a href="${esc(opts.cdnUrl)}" target="_blank" class="btn" style="display:inline-block;margin-top:6px">Open ↗</a>
  <div class="cdn-iframe">
    <iframe src="${esc(opts.cdnUrl)}"
      referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
      allow="autoplay;fullscreen" allowfullscreen></iframe>
  </div>
</div>
` : `<div class="card" style="padding:12px 16px;color:#888;font-size:13px">CDN embed not available for ep ${esc(opts.epNo)} — Fribb TMDB: ${opts.series?.tmdbId ?? "unknown"}</div>`}

<div class="section-title">Watch-Page Servers (trdekho=0…7)</div>
${opts.trid ? serverRows : `<div class="card" style="padding:14px 16px;color:#ef4444;font-size:13px">⚠️ trid not found — cannot test trdekho servers. Episode slug may be wrong: <code>${esc(opts.episodeSlug)}</code></div>`}

<div class="elapsed">Total time: ${opts.elapsed}ms</div>
</body>
</html>`;
}

// ── Known server labels (extend as discovered) ────────────────────────────────

const SERVER_LABELS: Record<number, string> = {
  0: "HydraX (abyssplayer.com)",
  1: "SRuby (rubystm.com)",
  2: "MirrorBot (cloudy.upns.one)",
  3: "Server 3 — unknown",
  4: "Server 4 — unknown",
  5: "Server 5 — unknown",
  6: "Server 6 — unknown",
  7: "Server 7 — unknown",
};

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/test/adw", async (req, res) => {
  const start = Date.now();
  const anilistId = ((req.query["anilistId"] as string) || DEFAULT_ANILIST_ID).trim();
  const epNo = ((req.query["epNo"] as string) || DEFAULT_EP).trim();
  const absEp = Number(epNo);

  if (!/^\d+$/.test(anilistId) || isNaN(absEp)) {
    res.status(400).send("Bad request: anilistId and epNo must be numbers");
    return;
  }

  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  res.setHeader("Content-Type", "text/html; charset=UTF-8");

  // Fetch AniList + AnimeDekho search in parallel
  const [media, series] = await Promise.all([
    fetchAniMedia(anilistId),
    (async () => {
      const m = await fetchAniMedia(anilistId);
      if (!m) return null;
      const titles = [
        m.title.english,
        m.title.romaji,
        ...m.synonyms,
      ].filter(Boolean) as string[];
      return findSeries(titles);
    })(),
  ]);

  // Build episode slug — use series slug if found, else slugify AniList title
  const baseSlug = series?.slug ??
    (media?.title.english ? slugify(media.title.english) :
     media?.title.romaji ? slugify(media.title.romaji) : `anime-${anilistId}`);
  const episodeSlug = `${baseSlug}-1x${absEp}`;

  // Cookie + CDN URL in parallel
  const [cookie, cdnUrl] = await Promise.all([
    getCookie(episodeSlug),
    series?.tmdbId
      ? getCdnUrl(series.tmdbId, 1, absEp)
      : Promise.resolve(null),
  ]);

  // trid (needs cookie)
  const trid = await getTrid(episodeSlug, cookie);

  // Try all trdekho servers 0-7 (in parallel for speed)
  const serverResults = trid
    ? await Promise.all(
        Array.from({ length: 8 }, (_, i) => i).map(async (id) => {
          const result = await getTrdekhoUrl(trid, id, cookie);
          return { id, label: SERVER_LABELS[id] ?? `Server ${id}`, ...result };
        }),
      )
    : [];

  const html = buildHtml({
    anilistId,
    epNo,
    media,
    series,
    episodeSlug,
    cookie,
    trid,
    cdnUrl,
    servers: serverResults,
    elapsed: Date.now() - start,
  });

  res.send(html);
});

export default router;
