import { Router } from "express";
import {
  resolveSlug,
  scrapeEmbed,
  type AninekoType,
} from "../providers/anineko.js";
import { resolveAnimeDekhoUrl } from "../providers/animedekho.js";
import { resolveAnimeDekhoHls } from "../providers/animedekho-hls.js";
import { TtlCache, fetchWithTimeout } from "../lib/cache.js";
import { fetchAniMedia } from "../lib/anilist.js";
import { resolveVidPlay, type AudioType } from "../providers/vidplay.js";

const router = Router();

// Cache Megaplay realId lookups — same episode ID doesn't change.
const realIdCache = new TtlCache<string>(5 * 60_000);
const REALID_TTL  = 30 * 60_000; // 30 min

const MEGAPLAY_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://anix.at/",
};

/**
 * Providers that use Megaplay data-realid:
 *   hd  — Megaplay HD-1      megaplay.buzz/stream/s-5/{realId}/{type}
 *   vs  — Megaplay Vidstream  megaplay.buzz/stream/s-2/{realId}/{type}
 *   vw  — VidWish / VidCloud  vidwish.live/stream/s-2/{realId}/{type}
 */
const PROVIDERS: Record<string, (id: string, t: string) => string> = {
  hd: (id, t) => `https://megaplay.buzz/stream/s-5/${id}/${t}`,
  vs: (id, t) => `https://megaplay.buzz/stream/s-2/${id}/${t}`,
  vw: (id, t) => `https://vidwish.live/stream/s-2/${id}/${t}`,
};

async function fetchRealId(
  anilistId: string,
  epNo: string,
  type: string,
  malId?: number,
  malEpNo?: string, // episode to use on the mal path; defaults to "1" (movies)
): Promise<string | null> {
  // mal path: used for movies (always ep 1) and vs provider (actual epNo)
  const probeUrl = malId
    ? `https://megaplay.buzz/stream/mal/${malId}/${malEpNo ?? "1"}/${type}`
    : `https://megaplay.buzz/stream/ani/${anilistId}/${epNo}/${type}`;
  const cacheKey = malId
    ? `mal:${malId}:${malEpNo ?? "1"}:${type}`
    : `${anilistId}:${epNo}:${type}`;
  return realIdCache.dedupe(
    cacheKey,
    async () => {
      const res = await fetchWithTimeout(
        probeUrl,
        { headers: MEGAPLAY_HEADERS },
        10_000,
      );
      const html = await res.text();
      const id = html.match(/data-realid="(\d+)"/)?.[1];
      if (!id) throw new Error("realid not found");
      return id;
    },
    REALID_TTL,
  ).catch(() => null);
}

function buildPage(embedUrl: string, anilistId: string, epNo: string, sandbox = false): string {
  const iframeAttrs = sandbox
    // AnimeDekho only: sandbox blocks popup/redirect ads; no-referrer hides origin from CDN
    ? `referrerpolicy="no-referrer"
    sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"`
    // All other providers: full referrer so the player sees anix.at and skips ads
    : `referrerpolicy="unsafe-url"`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Stream · ${anilistId} · Ep ${epNo}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
    iframe { display: block; width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe
    src="${embedUrl}"
    ${iframeAttrs}
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
    allowfullscreen
  ></iframe>
</body>
</html>`;
}

/**
 * GET /api/stream/anix.at/:anilistId/:epNo/:type[?p=provider]
 *
 * Types:  sub | dub | hsub
 *
 * Providers (?p=):
 *   (none) — Default Megaplay (no extra fetch)
 *   hd     — Megaplay HD-1
 *   vs     — Megaplay Vidstream
 *   vw     — VidWish / VidCloud
 *   am     — AniNeko (anineko.to) · supports hsub / sub / dub
 *   vp     — VidPlay/VidTube via AniKoto · exact AniList season matching
 */
router.get(
  "/stream/anix.at/:anilistId/:epNo/:type",
  async (req, res) => {
    const { anilistId, epNo, type } = req.params;
    const provider = ((req.query["p"] as string) || "").toLowerCase();

    if (!/^\d+$/.test(anilistId) || !/^\d+$/.test(epNo)) {
      res.status(400).send("Bad Request: anilistId and epNo must be numbers");
      return;
    }

    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    res.setHeader("Content-Type", "text/html; charset=UTF-8");
    res.setHeader("Cache-Control", "public, max-age=300"); // 5 min — URL is deterministic

    // ── AD provider (AnimeDekho · Hindi dub · type=hin) ──────────────────
    // Resolves CDN URL server-side, then embeds it DIRECTLY in the iframe
    // (no proxy). Ad suppression is handled by iframe sandbox (no allow-popups,
    // no allow-top-navigation) — see buildPage().
    if (provider === "ad") {
      try {
        const cdnUrl = await resolveAnimeDekhoUrl(anilistId, epNo);
        // Embed rules per server:
        //   CDN hosts (as-cdn21.top, play.zephyrflick.top) → sandbox (blocks popup ads)
        //   Pixeldrain (animedekho.app/aaa/pixel/)          → sandbox (zero ads)
        //   VidMoly (vidmoly.biz)                           → sandbox without allow-popups
        //     → blocks ungagedhulloo.com popunder (window.open on first click)
        //     → JW Player works fine without allow-popups
        //   HydraX (abyssplayer.com)                        → direct iframe (JW pre-roll)
        //   All others                                       → direct iframe
        const CDN_SANDBOX_HOSTS = new Set(["as-cdn21.top", "play.zephyrflick.top"]);
        let useSandbox = false;
        let embedUrl = cdnUrl;
        try {
          const parsed = new URL(cdnUrl);
          const { hostname, pathname } = parsed;
          if (CDN_SANDBOX_HOSTS.has(hostname)) {
            useSandbox = true;
          } else if (hostname === "animedekho.app" && pathname.startsWith("/aaa/pixel/")) {
            // Pixeldrain player — zero ads, safe to sandbox
            useSandbox = true;
          } else if (hostname === "vidmoly.biz") {
            // VidMoly — sandbox blocks popunder ad (window.open) without affecting playback
            useSandbox = true;
          }
          // HydraX (abyssplayer.com): direct embed — detects and rejects sandbox
        } catch { /* non-URL, embed as-is */ }
        res.send(buildPage(embedUrl, anilistId, epNo, useSandbox));
      } catch (err: any) {
        if (err?.code === "NO_MAPPING") {
          res.status(404).json({
            error: "Anime not available on AnimeDekho in Hindi dub",
            anilistId,
          });
        } else if (err?.code === "EP_NOT_FOUND") {
          res.status(404).json({
            error: "Episode not found on AnimeDekho",
            detail: err?.message,
          });
        } else if (err?.code === "CDN_NOT_FOUND") {
          res.status(502).json({
            error: "AnimeDekho embed page had no playable CDN iframe",
            detail: err?.message,
          });
        } else {
          res.status(502).json({
            error: "AnimeDekho upstream error",
            detail: err?.message,
          });
        }
      }
      return;
    }

    // ── ADT provider (AnimeDekho HLS — test) ─────────────────────────────
    // Fallback / watch-page system only. Extracts direct HLS m3u8 URL from
    // AnimeDekho's servers (VidMoly → VidCloud → SRuby → MirrorXerver → Pixeldrain).
    // Skips VidStream CDN, HydraX, and MirrorBot as instructed.
    // Returns JSON { hls, server, serverName, embedUrl, proxyNeeded, workingReferer }.
    if (provider === "adt") {
      try {
        const hlsResult = await resolveAnimeDekhoHls(anilistId, epNo);
        res.setHeader("Cache-Control", "public, max-age=120"); // 2 min — m3u8 URLs expire
        res.json(hlsResult);
      } catch (err: any) {
        const status =
          err?.code === "EP_NOT_FOUND" || err?.code === "NO_TITLE" ? 404 :
          err?.code === "CDN_NOT_FOUND" ? 502 : 502;
        res.status(status).json({
          error: err?.message ?? "AnimeDekho HLS extraction failed",
          code: err?.code ?? "UPSTREAM_ERROR",
          anilistId,
          epNo,
        });
      }
      return;
    }

    // ── AM provider (AniNeko) ─────────────────────────────────────────────
    if (provider === "am") {
      // Normalise type: hsub | sub | dub  (default sub)
      const amType: AninekoType =
        type === "hsub" ? "hsub" : type === "dub" ? "dub" : "sub";

      // Movies on anineko.to are always ep-1 regardless of what the caller passes.
      const aniMedia = await fetchAniMedia(anilistId).catch(() => null);
      const isMovie = aniMedia?.format === "MOVIE";
      const effectiveEp = isMovie ? "1" : epNo;

      const slug = await resolveSlug(anilistId).catch(() => null);
      if (!slug) {
        res.status(404).json({
          error:
            "Could not confidently map this AniList ID to anineko.to. No accurate match found.",
          anilistId,
        });
        return;
      }

      const embedUrl = await scrapeEmbed(slug, effectiveEp, amType).catch(() => null);
      if (!embedUrl) {
        res.status(404).json({
          error: `${isMovie ? "Movie" : `Episode ${epNo}`} (${amType}) not found on anineko.to`,
          anilistId,
          slug,
        });
        return;
      }

      // Serve through /api/proxy → strips ads, rewrites M3U8 for CORS
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(embedUrl)}`;
      res.send(buildPage(proxyUrl, anilistId, epNo));
      return;
    }

    // ── VP provider (VidPlay/VidTube) ─────────────────────────────────────
    // Resolves only the small embed URL. The video is loaded directly by the
    // returned iframe, so this API never proxies video bytes.
    if (provider === "vp" || provider === "vidplay") {
      const vpType: AudioType =
        type === "hsub" ? "hsub" : type === "dub" ? "dub" : "sub";
      try {
        const embedUrl = await resolveVidPlay(anilistId, epNo, vpType);
        res.send(buildPage(embedUrl, anilistId, epNo));
      } catch (err: any) {
        const status =
          err?.code === "NO_ANIKOTO_MATCH" || err?.code === "EPISODE_NOT_FOUND"
            ? 404
            : err?.code === "NO_ANILIST_MEDIA"
              ? 404
              : 502;
        res.status(status).json({
          error: err?.message ?? "VidPlay resolution failed",
          code: err?.code ?? "UPSTREAM_ERROR",
          anilistId,
          epNo,
          type: vpType,
        });
      }
      return;
    }

    // ── Megaplay providers (hd / vs / vw) and default ────────────────────

    // hsub is only valid for AM; fall back to sub for Megaplay providers
    const streamType = type === "dub" ? "dub" : "sub";

    // Fetch media info.
    // MAL ID is needed for: movies (all providers) + vs (VidStream, all formats incl. TV)
    const megaMedia = await fetchAniMedia(anilistId).catch(() => null);
    const isMovie   = megaMedia?.format === "MOVIE";
    const needsMal  = isMovie || provider === "vs";
    const malId     = needsMal ? (megaMedia?.idMal ?? null) : null;

    // Movies require a MAL ID on all Megaplay providers
    if (isMovie && !malId) {
      res.status(404).json({
        error:
          "Megaplay movie support requires a MAL ID, but none was found for this AniList ID. Use ?p=am (AniNeko) or ?p=ad (AnimeDekho) instead.",
        anilistId,
        format: "MOVIE",
      });
      return;
    }

    // vs (VidStream) always probes via MAL path — requires a MAL ID even for TV
    if (provider === "vs" && !malId) {
      res.status(404).json({
        error:
          "VidStream (?p=vs) requires a MAL ID but none was found for this AniList ID.",
        anilistId,
      });
      return;
    }

    if (!provider) {
      // Default Megaplay: movies → mal path; TV → ani path
      const embedUrl = isMovie
        ? `https://megaplay.buzz/stream/mal/${malId}/1/${streamType}`
        : `https://megaplay.buzz/stream/ani/${anilistId}/${epNo}/${streamType}`;
      res.send(buildPage(embedUrl, anilistId, epNo));
      return;
    }

    if (!PROVIDERS[provider]) {
      res
        .status(400)
        .send(
          `Unknown provider "${provider}". Available: ${["vp", "am", "ad", ...Object.keys(PROVIDERS)].join(", ")}`,
        );
      return;
    }

    // vs: always probe mal path with actual epNo (TV + movies)
    // movies on other providers: probe mal path with ep 1
    // TV on hd/vw: probe ani path as before
    const realId = await fetchRealId(
      anilistId,
      epNo,
      streamType,
      malId ?? undefined,
      provider === "vs" ? epNo : undefined, // vs passes actual epNo; movies default to "1"
    );
    if (!realId) {
      res.status(502).send("Could not resolve stream ID from Megaplay");
      return;
    }

    res.send(buildPage(PROVIDERS[provider](realId, streamType), anilistId, epNo));
  },
);

export default router;
