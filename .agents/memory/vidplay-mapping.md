---
name: VidPlay mapping
description: How the AniKoto VidPlay/VidTube URL is resolved from episode metadata
---

AniKoto does not derive the VidTube token directly from an AniList ID. Its browser flow is:

1. Request the AniKoto episode list to obtain the episode's `data-ids` value.
2. Request AniKoto's server-list endpoint with that encrypted value.
3. Select the VidPlay server's encrypted `data-link-id`.
4. Request the server endpoint with that link ID; the response returns the final VidTube URL.

The VidTube path token is opaque: one base64 decode produces another encoded-looking value and does not reveal the AniList ID, MAL ID, episode number, or the visible VidTube numeric file ID. The VidTube HTML separately exposes internal `data-id`, `data-realid`, and `data-mediaid` values, but those are not the URL token.

**Why:** Cross-verification showed that a direct token formula would be brittle and that the authoritative mapping is maintained by AniKoto's AJAX resolver.

**How to apply:** Implement VidPlay as a cached AniKoto resolver adapter keyed by AniList ID + episode + audio type, with strict response validation, timeouts, and fallback behavior. Do not attempt to reverse-engineer or synthesize the VidTube token.