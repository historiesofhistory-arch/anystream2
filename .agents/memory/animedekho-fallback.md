---
name: AnimeDekho fallback chain
description: Key rules and quirks for the AnimeDekho Hindi-dub provider in the API server
---

## Sandbox rule
- CDN embed hosts (`as-cdn21.top`, `play.zephyrflick.top`) → **must** be sandboxed (popup ads)
- Trdekho player URLs (`abyssplayer.com`, `rubystm.com`, `cloudy.upns.one`) → **must NOT** be sandboxed — they explicitly detect and reject the sandbox attribute (Error 232011 / "AdBlock/Sandbox" warning)
- Logic is in `stream.ts` AD provider section: check `new URL(cdnUrl).hostname` against `CDN_EMBED_HOSTS`

**Why:** JWPlayer-based trdekho players check `window.parent !== window` under sandboxed conditions and refuse to load.

## trdekho server IDs (live, confirmed)
- `trdekho=0` → HydraX (abyssplayer.com) — JWPlayer, directly embeddable ✅
- `trdekho=1` → SRuby (rubystm.com) — requires POST form, often broken
- `trdekho=2` → MirrorBot (cloudy.upns.one)
- Watch-page uses `TRDEKHO_SERVERS = [0, 1, 2]` — HydraX must be first

## trtype values
- TV episodes: `trtype=2`
- Movies: `trtype=1`

## Cookie / data-lmt rules
- **TV episode pages**: `data-lmt` JWT (containing `trid`) is ONLY present when the verified `toronites_server=vidstream` cookie is set
- **Movie series pages**: `data-lmt` is present WITHOUT any cookie — no cookie/verify flow needed
- Cookie obtained via: episode page → shortlink hidden input → verify.php → Set-Cookie

## Movie path (search fallback)
- Fetch `/movie-hindi/{slug}/` series page → extract `data-lmt` → trid
- Call `?trdekho=0&trid={trid}&trtype=1` (no cookie needed)
- Movie CDN embed `animedekho.app/embed/{tmdbId}` may not exist even when movie is on AnimeDekho

## False search mapping prevention
Two guards in `searchAdwSeries`:
1. **Skip title variants < 6 chars** — e.g. "BLOOM" synonym matches completely wrong anime
2. **Title verification**: fetch AnimeDekho series page H1, check word-overlap (≥4 char words) against AniList titles — rejects mismatches

**Why:** AnimeDekho search is fuzzy; short synonyms and romaji titles often match wrong shows.

## AnimeDekho series page title extraction
- Best source: `<h1>` tag — just the anime name, no suffix
- Fallback: `og:title` meta — includes "Hindi Dubbed – AnimeDekho" suffix (strip it)

## Fribb TMDB array format
- Some Fribb entries have `themoviedb_id: { movie: [504253] }` (array not number)
- The parser tries `raw.movie` which is truthy for arrays; JS coerces `[504253]` → `"504253"` in URL templates so it accidentally works
- Results in CDN embed failing → movie fallback catches → search path takes over

## Search fallback flow (TV)
1. Search AnimeDekho by title → find real series slug + TMDB ID (from `anilist.php?id=`)
2. CDN embed: `animedekho.app/embed/{tmdbId}/{season}-{ep}` → extract CDN URL
3. Cookie + trid from episode page: `fetchTridWithCookie(episodeSlug, cookie)` 
4. HydraX (trdekho=0) → SRuby (trdekho=1)
