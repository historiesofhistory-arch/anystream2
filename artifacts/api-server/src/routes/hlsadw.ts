/**
 * AnimeDekho fallback HLS proxy — TEST support
 *
 * GET /api/hlsadw?url=<encoded_url>&ref=<encoded_referer>
 *
 * Proxies HLS manifests (.m3u8) AND segment files (.ts / .aac / .mp4 frag)
 * from AnimeDekho's fallback player hosts with a custom Referer header set
 * server-side (browsers cannot set Referer via XHR/fetch).
 *
 * For .m3u8 files:
 *   - Rewrites relative URIs to absolute
 *   - Routes sub-playlist lines through this proxy (preserving referer)
 *   - Routes segment lines through this proxy (preserving referer)
 *   - Returns with CORS + correct Content-Type
 *
 * For segment files (.ts, .aac, fmp4 init, etc.):
 *   - Streams binary body through with CORS headers
 */

import { Router } from "express";
import { fetchWithTimeout } from "../lib/cache.js";

const router = Router();

// Hosts allowed for AnimeDekho fallback HLS proxying
const ALLOWED_HOSTS = new Set([
  // trdekho fallback players
  "vidmoly.biz",
  "vidmoly.to",
  "cdn.vidmoly.biz",
  "cdn.vidmoly.to",
  "vidcloud.upns.ink",
  "rubystm.com",
  "cdn.rubystm.com",
  "mirror.xerver.xyz",
  "animedekho.app",
  // CDN segment hosts (discovered from manifests — add as needed)
  "cdn.vidcloud.cc",
  "s1.vidmoly.biz",
  "s2.vidmoly.biz",
  "stream.vidmoly.biz",
]);

/** Extend allowed hosts at runtime when we see CDN segment URLs in manifests. */
function isAllowed(hostname: string): boolean {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  // Allow any subdomain of known base domains
  const ALLOWED_BASES = [
    "vidmoly.biz", "vidmoly.to", "vidcloud.upns.ink",
    "rubystm.com", "xerver.xyz", "animedekho.app",
  ];
  return ALLOWED_BASES.some((base) => hostname === base || hostname.endsWith("." + base));
}

function proxyUrl(target: string, ref: string): string {
  return `/api/hlsadw?url=${encodeURIComponent(target)}&ref=${encodeURIComponent(ref)}`;
}

function resolveAbsolute(line: string, base: string): string {
  if (/^https?:\/\//i.test(line)) return line;
  if (line.startsWith("/")) {
    try { const u = new URL(base); return `${u.protocol}//${u.host}${line}`; } catch { return line; }
  }
  return base + line;
}

router.get("/hlsadw", async (req, res) => {
  const targetUrl = req.query.url as string;
  const referer   = (req.query.ref as string) || "https://animedekho.app/";

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

  if (!isAllowed(parsed.hostname)) {
    res.status(403).json({
      error: `Host not allowed: ${parsed.hostname}`,
    });
    return;
  }

  try {
    const upstream = await fetchWithTimeout(
      targetUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: referer,
          Origin: new URL(referer).origin,
        },
      },
      15_000,
    );

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const isManifest =
      targetUrl.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    // CORS headers for all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (isManifest) {
      // Manifest: rewrite all URIs through this proxy
      const raw = await upstream.text();
      const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

      const rewritten = raw
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          const absolute = resolveAbsolute(trimmed, base);
          return proxyUrl(absolute, referer);
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=60");
      res.send(rewritten);
    } else {
      // Binary segment: stream through
      const contentLength = upstream.headers.get("content-length");
      const segContentType = upstream.headers.get("content-type") ?? "video/MP2T";
      res.setHeader("Content-Type", segContentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      // Stream the body
      const buffer = await upstream.arrayBuffer();
      res.end(Buffer.from(buffer));
    }
  } catch (err: any) {
    res.status(502).json({ error: "HLS proxy failed", detail: err?.message });
  }
});

export default router;
