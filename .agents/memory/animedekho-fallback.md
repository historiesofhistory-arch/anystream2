---
name: AnimeDekho fallback chain
description: Server IDs, cookie behavior, and tertiary search-fallback implementation details for animedekho.ts
---

## Key Findings

### data-lmt JWT requires cookie
`data-lmt` JWT (contains `trid`) is ONLY injected into episode page HTML when the
`toronites_server=vidstream` cookie is present. Without cookie the episode page
shows the ads-skip wall with no player data. The existing `fetchTrid()` fetches
without cookie — this works when the server IP has been recently verified via
verify.php (shared IP state on AnimeDekho's side).

**Why:** Cookie is a session gate. AnimeDekho serves full player data only to
verified IPs. The existing code works because `ensureVerifiedCookie` runs in
parallel and often the IP is already verified from a prior request.

**How to apply:** For the tertiary search fallback, always fetch the trid WITH the
cookie explicitly (`fetchTridWithCookie`). This is more reliable.

### Live trdekho server ID mapping (verified 2026-07-19)
```
trdekho=0 → HydraX   (abyssplayer.com — JWPlayer/iamcdn)
trdekho=1 → SRuby    (rubystm.com — StreamRuby)
trdekho=2 → VidCloud
trdekho=3 → MirrorBot
trdekho=4 → Omega
trdekho=5 → VidSrc-480p
trdekho=6 → VidSrc-720p
trdekho=7 → VidSrc
```
Existing watch-page code uses trdekho=1 and trdekho=2 (labeled HydraX/MirrorBot
by original dev — labels are stale; trdekho=1 now serves SRuby).

### embed URL uses TMDB ID
`animedekho.app/embed/{tmdbId}/{season}-{ep}` — `tmdbId` confirmed via user.
AnimeDekho stores TMDB ID in the series page badge link:
`anilist.php?id={tmdbId}` — this is extractable via scraping.

### Three-level fallback chain
1. Fribb CDN embed (`embed/{tmdbId}/{season}-{ep}`) — PRIMARY, DO NOT TOUCH
2. Watch-page via slugified title (`resolveWatchPageUrl`) — EXISTING, DO NOT TOUCH
3. Search-based (`resolveViaSearchFallback`) — NEW:
   - Search `animedekho.app/?s={title}` → find series slug
   - Extract TMDB ID from `anilist.php?id=` on series page
   - Try VidStream CDN embed with found TMDB ID
   - Try HydraX (trdekho=0) with cookie+trid
   - Try SRuby (trdekho=1) with cookie+trid

### Search URL pattern
`animedekho.app/?s={encoded_title}` → links like `/series-hindi/{slug}/` or `/movie-hindi/{slug}/`
