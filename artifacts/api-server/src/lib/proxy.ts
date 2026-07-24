/**
 * CF Proxy helpers
 *
 * One CF Worker URL (CF_PROXY_URL) serves two route prefixes:
 *
 *   /adw/*   → animedekho.app   (permanent — data-centre IPs are WAF-blocked)
 *   /akoto/* → anikoto.cz       (fallback — only used when AniKoto returns 429)
 *
 * The url.replace() approach in fetchAdw means any animedekho.app URL,
 * including those dynamically extracted from HTML (e.g. verify.php links),
 * is automatically routed through the proxy.
 */

import { fetchWithTimeout } from "./cache.js";

const CF_PROXY_URL = (process.env["CF_PROXY_URL"] ?? "").replace(/\/$/, "");

/**
 * Fetch any animedekho.app URL through the CF proxy (permanent).
 * Falls back to a direct fetch when CF_PROXY_URL is not set.
 */
export async function fetchAdw(
  url: string,
  options: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const target = CF_PROXY_URL
    ? url.replace("https://animedekho.app", `${CF_PROXY_URL}/adw`)
    : url;
  return fetchWithTimeout(target, options, timeoutMs);
}

/**
 * Fetch any anikoto.cz URL, retrying through the CF proxy on HTTP 429.
 * Direct path is always tried first to keep latency low.
 */
export async function fetchAniKoto(
  url: string,
  options: RequestInit,
  timeoutMs = 8_000,
): Promise<Response> {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (res.status === 429 && CF_PROXY_URL) {
    const proxyUrl = url.replace("https://anikoto.cz", `${CF_PROXY_URL}/akoto`);
    return fetchWithTimeout(proxyUrl, options, timeoutMs);
  }
  return res;
}