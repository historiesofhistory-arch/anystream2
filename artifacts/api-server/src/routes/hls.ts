import { Router } from "express";
import { TtlCache, fetchWithTimeout } from "../lib/cache.js";

const router = Router();

// M3U8 playlists for VOD anime don't change — safe to cache 10 minutes.
// Singleflight collapses burst duplicate requests into one upstream hit.
const m3u8Cache = new TtlCache<string>(3 * 60_000);
const M3U8_TTL  = 10 * 60_000; // 10 min

// Only allow proxying M3U8 files from these hosts
const ALLOWED_M3U8_HOSTS = new Set([
  "vivibebe.site",
  "bibiemb.xyz",
  "otakuhg.site",
  "megaplay.buzz",
]);

/**
 * GET /api/m3u8?url=<encodedM3U8Url>
 *
 * Proxies an HLS M3U8 playlist, adding CORS headers so JWPlayer/HLS.js
 * can fetch it from any origin. Rewrites relative sub-playlist URLs to
 * also go through this proxy so CORS is consistent across all levels.
 *
 * Segment (.ts) URLs are left as-is — the CDN already serves them with
 * Access-Control-Allow-Origin: * so they load fine cross-origin.
 * Responses are cached 10 min + singleflight deduplicated.
 */
router.get("/m3u8", async (req, res) => {
  const targetUrl = req.query.url as string;

  if (!targetUrl) {
    res.status(400).json({ error: "Missing url param" });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  if (!ALLOWED_M3U8_HOSTS.has(parsed.hostname)) {
    res.status(403).json({
      error: `Host not allowed. Allowed: ${[...ALLOWED_M3U8_HOSTS].join(", ")}`,
    });
    return;
  }

  try {
    const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    const m3u8 = await m3u8Cache.dedupe(
      targetUrl,
      async () => {
        const upstream = await fetchWithTimeout(
          targetUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Referer: `${parsed.protocol}//${parsed.hostname}/`,
            },
          },
          10_000,
        );
        if (!upstream.ok)
          throw Object.assign(new Error("upstream"), { status: upstream.status });

        let raw = await upstream.text();

        // Rewrite relative sub-playlist or segment refs → absolute,
        // then route sub-playlists (.m3u8) through our proxy for CORS.
        // Segment files (.ts) go CDN-direct (already CORS-open).
        raw = raw
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;

            let absolute = trimmed;
            if (!trimmed.startsWith("http")) absolute = base + trimmed;

            if (absolute.includes(".m3u8")) {
              return `/api/m3u8?url=${encodeURIComponent(absolute)}`;
            }
            return absolute;
          })
          .join("\n");

        return raw;
      },
      M3U8_TTL,
    );

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "public, max-age=600"); // 10 min browser/CDN cache
    res.send(m3u8);
  } catch (err: any) {
    req.log.error({ err }, "M3U8 proxy failed");
    if (err?.status) {
      res.status(err.status).json({ error: "Upstream M3U8 error" });
    } else {
      res.status(502).json({ error: "M3U8 proxy failed" });
    }
  }
});

export default router;
