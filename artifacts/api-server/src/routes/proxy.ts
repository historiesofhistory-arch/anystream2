import { Router } from "express";
import { TtlCache, fetchWithTimeout } from "../lib/cache.js";

const router = Router();

// Cache embed HTML pages for 5 minutes — pages are static per URL.
// Singleflight ensures only 1 upstream fetch fires per unique URL,
// even if 500 users request the same episode simultaneously.
const proxyCache = new TtlCache<string>(2 * 60_000);
const PROXY_TTL  = 5 * 60_000; // 5 min

// Allowed domains to proxy
const ALLOWED_HOSTS = new Set([
  "megaplay.buzz",
  "vivibebe.site",
  "bibiemb.xyz",
  "otakuhg.site",
  // AnimeDekho CDN hosts — fetched server-side with Referer: animedekho.app
  "as-cdn21.top",
  "play.zephyrflick.top",
]);

// Per-host Referer override — defaults to anineko.to for other hosts
const HOST_REFERER: Record<string, string> = {
  "as-cdn21.top": "https://animedekho.app/",
  "play.zephyrflick.top": "https://animedekho.app/",
};

// Per-host ad script patterns to strip
const AD_PATTERNS: Record<string, RegExp[]> = {
  "vivibebe.site": [
    /\(function\(s\)\{s\.dataset\.zone=[^}]+\}\)\([^)]+\)/g,
    /<script[^>]*al5sm\.com[^>]*>[\s\S]*?<\/script>/gi,
    /<script[^>]*al5sm\.com[^>]*\/>/gi,
  ],
  "megaplay.buzz": [
    /<script[^>]*app\.main\.js[^>]*><\/script>/gi,
  ],
  "bibiemb.xyz": [
    /\(function\(s\)\{s\.dataset\.zone=[^}]+\}\)\([^)]+\)/g,
    /<script[^>]*al5sm\.com[^>]*>[\s\S]*?<\/script>/gi,
  ],
  "otakuhg.site": [
    /\(function\(s\)\{s\.dataset\.zone=[^}]+\}\)\([^)]+\)/g,
    /<script[^>]*al5sm\.com[^>]*>[\s\S]*?<\/script>/gi,
  ],
};

// Fix relative asset URLs → absolute for a given host
function fixRelativeUrls(html: string, origin: string): string {
  return html
    .replace(/(src|href)="\/((?!\/)[^"]+)"/g, `$1="${origin}/$2"`)
    .replace(/(src|href)='\/([^']+)'/g, `$1='${origin}/$2'`);
}

// Inject popup blocker before </head>
const POPUP_BLOCKER = `<script>
  window.open = function(){ return null; };
  window.alert = function(){};
</script>`;

/**
 * GET /api/proxy?url=<encodedUrl>
 *
 * Server-side proxies an embed page, strips known ad scripts,
 * fixes relative asset URLs, and blocks popup ads.
 * Responses are cached 5 min + singleflight deduplicated.
 */
router.get("/proxy", async (req, res) => {
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

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    res.status(403).json({
      error: `Host not allowed. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`,
    });
    return;
  }

  try {
    const origin = `${parsed.protocol}//${parsed.hostname}`;

    const html = await proxyCache.dedupe(
      targetUrl,
      async () => {
        const upstream = await fetchWithTimeout(
          targetUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Referer: HOST_REFERER[parsed.hostname] ?? "https://anineko.to/",
              Origin: HOST_REFERER[parsed.hostname]
                ? new URL(HOST_REFERER[parsed.hostname]).origin
                : "https://anineko.to",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
            },
          },
          10_000,
        );
        if (!upstream.ok)
          throw Object.assign(new Error("upstream"), { status: upstream.status });

        let raw = await upstream.text();

        // Strip known ad scripts
        for (const pattern of AD_PATTERNS[parsed.hostname] ?? []) {
          raw = raw.replace(pattern, "<!-- ad removed -->");
        }
        // Fix relative URLs so player assets still load
        raw = fixRelativeUrls(raw, origin);
        // Rewrite M3U8 URLs → go through /api/m3u8 for CORS
        raw = raw.replace(
          /(['"`])(https?:\/\/[^'"`]+\.m3u8[^'"`]*)\1/g,
          (_, quote, m3u8Url) =>
            `${quote}/api/m3u8?url=${encodeURIComponent(m3u8Url)}${quote}`,
        );
        // Inject popup blocker
        raw = raw.replace("</head>", `${POPUP_BLOCKER}\n</head>`);
        return raw;
      },
      PROXY_TTL,
    );

    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    res.setHeader("Content-Type", "text/html; charset=UTF-8");
    res.setHeader("Cache-Control", "public, max-age=300"); // 5 min browser/CDN cache
    res.send(html);
  } catch (err: any) {
    req.log.error({ err }, "Proxy fetch failed");
    if (err?.status) {
      res.status(err.status).json({ error: "Upstream error" });
    } else {
      res.status(502).json({ error: "Upstream fetch failed" });
    }
  }
});

export default router;
