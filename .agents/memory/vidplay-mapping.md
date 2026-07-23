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

**How to apply:** Use slug matching only to select and validate the AniKoto page. Then call the public episode/server AJAX chain to obtain the token. Validate VidTube `data-realid` against a punctuation-normalized canonical slug and episode; never synthesize the token from a slug or legacy ID.

The current AniKoto page still exposes the reliable legacy AJAX chain: episode list -> server list -> `VidPlay-1` link -> final server resolver. VidTube canonicalizes punctuation in some slugs, such as `re-zero` becoming `rezero`, so strict raw-string comparison rejects valid matches.

**Why:** Exact season protection is required, but provider slugs and VidTube real IDs do not always preserve punctuation identically.

**How to apply:** Keep provider resolution behind a cached, singleflight lookup and fail closed when the canonical slug or episode does not match. Return only the small VidTube iframe HTML; do not proxy video bytes.

AniList movie IDs must not be matched to unrelated AniKoto TV/ONA search results. A title with only generic overlap such as “Zero” is not a valid match; format and distinctive title-token checks must pass or the resolver returns no-match.

**Why:** A movie lookup returned an unrelated Edens Zero recap entry for an Aldnoah.Zero movie, which would have produced a playable but incorrect iframe.

**How to apply:** Treat `MOVIE`, `TV`, `ONA`, and special formats as separate matching classes and fail closed when the exact AniKoto title is not present.