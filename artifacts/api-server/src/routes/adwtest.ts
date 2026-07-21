/**
 * GET /api/test/adw?anilistId=&epNo=
 *
 * AnimeDekho server diagnostic — TESTING ONLY.
 * Tries every known trdekho server ID, shows CDN embed URL, and embeds
 * the watch-page HTML snippet so we can spot undiscovered server buttons.
 *
 * For fallback servers (skipping HydraX=1, MirrorBot=6) it also attempts
 * to extract a direct HLS m3u8 URL from the embed page and plays it
 * in a native <video> element via HLS.js — no proxy required if accessible.
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
  serverHtml: string | null;
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
        pageTitle = sHtml.match(/<h1[^>]*>([^<]+)/i)?.[1]?.trim() ?? null;
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

// ── HLS extraction from embed page ───────────────────────────────────────────
//
// Servers skipped (as instructed):
//   0 = dead
//   1 = HydraX (skip)
//   6 = GD MirrorBot (skip)
//   VidStream CDN = primary path, not fallback
//
// Tried for HLS extraction: 2=Pixeldrain, 3=SRuby, 4=VidCloud, 5=VidMoly, 7=MirrorXerver

const HLS_SKIP_SERVERS = new Set([0, 1, 6]);

const HLS_PATTERNS: RegExp[] = [
  // JW Player / standard players: "file":"...m3u8"
  /["']file["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8(?:\?[^"']*)?)['"]/gi,
  // sources array: {src:"...m3u8"}
  /["']src["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8(?:\?[^"']*)?)['"]/gi,
  // <source> tag
  /<source[^>]+src=["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
  // hls: "..." or hlsUrl: "..."
  /hls(?:Url)?\s*[=:]\s*["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*)/gi,
  // Generic m3u8 URL in quotes
  /["'`](https?:\/\/[^"'`\s]+\.m3u8(?:\?[^"'`\s]*)?)['"` ]/gi,
];

function extractM3u8(html: string): string | null {
  for (const pat of HLS_PATTERNS) {
    pat.lastIndex = 0;
    const m = pat.exec(html);
    if (m) {
      const url = (m[1] ?? "").trim();
      if (/^https?:\/\/.+\.m3u8/i.test(url)) return url;
    }
  }
  return null;
}

async function fetchEmbedAndExtractHls(
  embedUrl: string,
): Promise<{ m3u8: string; proxyNeeded: boolean; workingReferer: string } | null> {
  const referers = [
    "",                           // 1. Empty — ideal (no hotlink check)
    "https://animedekho.app/",    // 2. AnimeDekho parent
    (() => { try { return new URL(embedUrl).origin + "/"; } catch { return null; } })(), // 3. Self-origin
  ].filter(Boolean) as string[];

  for (const referer of referers) {
    try {
      const res = await fetchWithTimeout(
        embedUrl,
        {
          headers: {
            "User-Agent": ADW_HEADERS["User-Agent"],
            Accept: "text/html,*/*",
            Referer: referer,
          },
        },
        12_000,
      );
      if (!res.ok) continue;
      const html = await res.text();
      const m3u8 = extractM3u8(html);
      if (!m3u8) continue;

      // HEAD-test direct access (no referer)
      let proxyNeeded = true;
      let workingReferer = referer;
      try {
        const headRes = await fetchWithTimeout(m3u8, {
          method: "HEAD",
          headers: { "User-Agent": ADW_HEADERS["User-Agent"], Referer: "" },
        }, 6_000);
        if (headRes.ok || headRes.status === 206) {
          proxyNeeded = false;
          workingReferer = "";
        } else {
          // Try with animedekho referer
          const headRes2 = await fetchWithTimeout(m3u8, {
            method: "HEAD",
            headers: { "User-Agent": ADW_HEADERS["User-Agent"], Referer: "https://animedekho.app/" },
          }, 6_000);
          if (headRes2.ok || headRes2.status === 206) {
            proxyNeeded = true;
            workingReferer = "https://animedekho.app/";
          }
        }
      } catch { /* head test failed — assume proxy needed */ }

      return { m3u8, proxyNeeded, workingReferer };
    } catch { /* try next referer */ }
  }
  return null;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function badge(ok: boolean, label: string): string {
  const color = ok ? "#22c55e" : "#ef4444";
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700">${esc(label)}</span>`;
}

interface ServerResult {
  id: number;
  label: string;
  url: string | null;
  raw: string | null;
  status: number | null;
  hls?: { m3u8: string; proxyNeeded: boolean; workingReferer: string } | null;
  hlsSkipped?: boolean;
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
  servers: ServerResult[];
  elapsed: number;
}): string {
  const title = opts.media?.title?.english ?? opts.media?.title?.romaji ?? `AniList ${opts.anilistId}`;

  let playerIdx = 0;

  const serverRows = opts.servers
    .map((s) => {
      const hasUrl = !!s.url;
      const hostname = s.url ? (() => { try { return new URL(s.url!).hostname; } catch { return s.url; } })() : "—";

      let hlsSection = "";
      if (s.hls) {
        const pid = `player-${s.id}-${playerIdx++}`;
        const proxyBadge = s.hls.proxyNeeded
          ? `<span style="background:#f59e0b;color:#000;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">⚠ proxy needed (referer: ${esc(s.hls.workingReferer || "unknown")})</span>`
          : `<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">✅ direct (no proxy)</span>`;
        hlsSection = `
        <div class="hls-section">
          <div class="hls-header">
            <span class="hls-tag">HLS m3u8</span>
            ${proxyBadge}
          </div>
          <code class="hls-url">${esc(s.hls.m3u8)}</code>
          <div class="video-wrap">
            <video id="${pid}" controls playsinline style="width:100%;height:100%;background:#000"></video>
          </div>
          <script>
            (function(){
              var src = "${s.hls.m3u8.replace(/"/g, '\\"')}";
              var vid = document.getElementById("${pid}");
              if (Hls.isSupported()) {
                var hls = new Hls({ xhrSetup: function(xhr){ xhr.setRequestHeader("Referer",""); } });
                hls.loadSource(src);
                hls.attachMedia(vid);
                hls.on(Hls.Events.MANIFEST_PARSED, function(){ vid.play().catch(function(){}); });
                hls.on(Hls.Events.ERROR, function(e,d){
                  if(d.fatal){
                    console.warn("HLS.js error, trying native",d);
                    vid.src = src;
                  }
                });
              } else if (vid.canPlayType("application/vnd.apple.mpegurl")) {
                vid.src = src;
                vid.addEventListener("loadedmetadata", function(){ vid.play().catch(function(){}); });
              } else {
                vid.parentElement.innerHTML = '<p style="color:#ef4444;padding:12px">HLS not supported in this browser</p>';
              }
            })();
          </script>
        </div>`;
      } else if (hasUrl && !s.hlsSkipped) {
        hlsSection = `<div class="hls-section" style="color:#888;font-size:12px;padding:8px 0">⚠ No m3u8 found in embed page — iframe only</div>`;
      } else if (s.hlsSkipped) {
        hlsSection = `<div class="hls-section" style="color:#555;font-size:12px;padding:8px 0">⊘ HLS extraction skipped for this server (HydraX/MirrorBot)</div>`;
      }

      return `
      <div class="card" id="server-${s.id}">
        <div class="card-header">
          <span class="server-id">trdekho=${s.id}</span>
          <span class="server-label">${esc(s.label)}</span>
          ${badge(hasUrl, hasUrl ? "✓ URL found" : "✗ no URL")}
          ${s.hls ? badge(true, "🎬 HLS") : ""}
        </div>
        ${hasUrl ? `
        <div class="url-row">
          <code>${esc(s.url!)}</code>
          <a href="${esc(s.url!)}" target="_blank" class="btn">Open ↗</a>
        </div>
        <div class="host-row">Host: <b>${esc(hostname ?? "")}</b></div>
        ${hlsSection}
        <details class="iframe-details">
          <summary style="cursor:pointer;padding:8px 16px;font-size:12px;color:#666;background:#12121a;user-select:none">▶ Show iframe embed</summary>
          <div class="iframe-wrap">
            <iframe src="${esc(s.url!)}" referrerpolicy="unsafe-url" allow="autoplay;fullscreen" allowfullscreen loading="lazy"></iframe>
          </div>
        </details>
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
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f13; color: #e2e2e2; font-family: system-ui,sans-serif; padding: 24px; }
  h1 { font-size: 1.4rem; color: #fff; margin-bottom: 4px; }
  .meta { color: #888; font-size: 13px; margin-bottom: 20px; }
  .meta b { color: #aaa; }
  form { display:flex; gap:10px; align-items:center; margin-bottom:24px; flex-wrap:wrap; }
  form input { background:#1a1a24; border:1px solid #3a3a50; border-radius:6px; color:#e2e2e2; padding:8px 12px; font-size:13px; width:160px; }
  form button { background:#7c83d6; color:#fff; border:none; border-radius:6px; padding:8px 18px; font-size:13px; cursor:pointer; font-weight:600; }
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
  .iframe-details { border-top: 1px solid #2a2a38; }
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
  .hls-section { padding: 10px 16px; border-top: 1px solid #2a2a38; }
  .hls-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  .hls-tag { background: #312e7a; color: #a5b4fc; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: monospace; }
  .hls-url { font-size: 11px; color: #818cf8; word-break: break-all; display: block; margin-bottom: 8px; }
  .video-wrap { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 6px; overflow: hidden; }
</style>
</head>
<body>
<h1>AnimeDekho Server Test 🔬</h1>
<form method="GET" action="/api/test/adw">
  <input name="anilistId" value="${esc(opts.anilistId)}" placeholder="AniList ID" />
  <input name="epNo" value="${esc(opts.epNo)}" placeholder="Episode No" />
  <button type="submit">Test →</button>
</form>

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
      referrerpolicy="unsafe-url"
      allow="autoplay;fullscreen;encrypted-media" allowfullscreen></iframe>
  </div>
</div>
` : `<div class="card" style="padding:12px 16px;color:#888;font-size:13px">CDN embed not available for ep ${esc(opts.epNo)} — Fribb TMDB: ${opts.series?.tmdbId ?? "unknown"}</div>`}

<div class="section-title">Watch-Page Servers — Fallback (trdekho=0…7) · HLS extracted for servers 2,3,4,5,7</div>
${opts.trid ? serverRows : `<div class="card" style="padding:14px 16px;color:#ef4444;font-size:13px">⚠️ trid not found — cannot test trdekho servers. Episode slug may be wrong: <code>${esc(opts.episodeSlug)}</code></div>`}

<div class="elapsed">Total time: ${opts.elapsed}ms</div>
</body>
</html>`;
}

// ── Known server labels ────────────────────────────────────────────────────────

const SERVER_LABELS: Record<number, string> = {
  0: "⚠️ Server Down (dead — skip)",
  1: "HydraX — abyssplayer.com (JW ads, direct iframe)",
  2: "Pixeldrain — animedekho.app/aaa/pixel/ (ZERO ads ✅ sandbox safe)",
  3: "SRuby — rubystm.com",
  4: "VidCloud — vidcloud.upns.ink (CF only, looks clean ✅)",
  5: "VidMoly — vidmoly.biz (AdSense + adblock detection)",
  6: "GD MirrorBot — gdmirrorbot.nl (no obvious ads ✅)",
  7: "Mirror Xerver — mirror.xerver.xyz",
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
      const titles = [m.title.english, m.title.romaji, ...m.synonyms].filter(Boolean) as string[];
      return findSeries(titles);
    })(),
  ]);

  // Build episode slug
  const baseSlug = series?.slug ??
    (media?.title.english ? slugify(media.title.english) :
     media?.title.romaji  ? slugify(media.title.romaji)  : `anime-${anilistId}`);
  const episodeSlug = `${baseSlug}-1x${absEp}`;

  // Cookie + CDN URL in parallel
  const [cookie, cdnUrl] = await Promise.all([
    getCookie(episodeSlug),
    series?.tmdbId ? getCdnUrl(series.tmdbId, 1, absEp) : Promise.resolve(null),
  ]);

  // trid (needs cookie)
  const trid = await getTrid(episodeSlug, cookie);

  // Try all trdekho servers 0-7 in parallel, then extract HLS for non-skipped ones
  const serverResults: ServerResult[] = trid
    ? await Promise.all(
        Array.from({ length: 8 }, (_, i) => i).map(async (id) => {
          const result = await getTrdekhoUrl(trid, id, cookie);
          const base: ServerResult = {
            id,
            label: SERVER_LABELS[id] ?? `Server ${id}`,
            ...result,
            hls: null,
            hlsSkipped: false,
          };

          if (!result.url) return base;

          // Skip HLS extraction for HydraX(1), MirrorBot(6), dead(0)
          if (HLS_SKIP_SERVERS.has(id)) {
            return { ...base, hlsSkipped: true };
          }

          // Extract HLS from embed page
          const hlsResult = await fetchEmbedAndExtractHls(result.url);
          return { ...base, hls: hlsResult ?? null };
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
