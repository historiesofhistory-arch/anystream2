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

Testing Re:Zero's five returned seasons and The Daily Life of the Immortal King's five returned seasons showed that AniKoto slugs consistently map to `data-realid="<slug>/ep-N"` across sampled first, middle, and last episodes. VidPlay tokens also share a series-family-looking prefix across those title groups, but the prefix does not decode to a readable slug or ID and no public token-generation endpoint was found. The public `anikotoapi.site/series/{id}` API exposes legacy HiAnime-compatible `episode_embed_id` values for MegaPlay, not VidTube tokens.

**Why:** Cross-verification showed that a direct token formula would be brittle and that the authoritative mapping is maintained by AniKoto's AJAX resolver.

**How to apply:** Use slug matching only to select and validate the AniKoto page. Then call the public episode/server AJAX chain to obtain the token. Validate the returned VidTube page's `data-realid` against the requested slug and episode; never synthesize the token from a slug or legacy ID.