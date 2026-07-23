# AniStream API

A lightweight, self-hosted anime streaming embed API.  
Drop a single `<iframe>` into any page to get a working video player — no frontend required.

## Quick start

```bash
# Docker (recommended)
docker build -t anistream-api .
docker run -p 3000:3000 anistream-api

# Or locally with pnpm
pnpm install
pnpm --filter @workspace/api-server run dev
```

The API is now available at `http://localhost:3000`.

---

## Embed endpoint

```
GET /api/stream/anix.at/:anilistId/:epNo/:type
```

| Param | Values | Notes |
|---|---|---|
| `anilistId` | AniList numeric ID | e.g. `20` for Naruto |
| `epNo` | Episode number | `1`, `2`, … |
| `type` | `sub` · `dub` · `hsub` | `hsub` = hard-subbed; only for `?p=am` |

**Optional query param `?p=`**

| Value | Provider | Notes |
|---|---|---|
| *(none)* | Megaplay (default) | Best compatibility |
| `hd` | Megaplay HD-1 | |
| `vs` | Megaplay VidStream | |
| `vw` | VidWish / VidCloud | |
| `vp` | VidPlay / VidTube | AniList ID → exact AniKoto season/episode |
| `am` | AniNeko | Supports `hsub` |
| `ad` | AnimeDekho | Hindi dub — fallback chain: VidMoly → HydraX → Pixeldrain |

### Example

```html
<!-- Naruto ep 1 sub (default Megaplay) -->
<iframe
  src="https://your-domain.com/api/stream/anix.at/20/1/sub"
  allowfullscreen
  allow="autoplay; encrypted-media; fullscreen"
  style="width:100%;aspect-ratio:16/9;border:none"
></iframe>

<!-- Solo Leveling ep 1 Hindi dub (AnimeDekho) -->
<iframe
  src="https://your-domain.com/api/stream/anix.at/170942/1/sub?p=ad"
  allowfullscreen
  allow="autoplay; encrypted-media; fullscreen"
  style="width:100%;aspect-ratio:16/9;border:none"
></iframe>

<!-- VidPlay / VidTube: same AniList ID + episode contract -->
<iframe
  src="https://your-domain.com/api/stream/anix.at/207141/1/sub?p=vp"
  allowfullscreen
  allow="autoplay; encrypted-media; fullscreen"
  style="width:100%;aspect-ratio:16/9;border:none"
></iframe>
```

---

## Other endpoints

| Route | Description |
|---|---|
| `GET /` or `GET /api` | Interactive API docs / embed generator |
| `GET /api/health` | Health check — returns `{ status: "ok" }` |
| `GET /api/m3u8?url=` | HLS m3u8 proxy (CORS fix for supported CDNs) |
| `GET /api/proxy?url=` | Embed page proxy with ad-script stripping |
| `GET /api/anime/search?q=` | AniList title → ID lookup |

---

## Scalability

| Concern | How it's handled |
|---|---|
| Burst traffic (same episode) | Singleflight cache — 500 concurrent requests fire **one** upstream fetch |
| Repeated requests | In-memory TTL cache (5–30 min per resource) |
| Large upstream responses | `fetchWithTimeout` with AbortController — no hung connections |
| Transfer size | gzip compression on all text responses (~70% reduction) |
| Horizontal scaling | Fully stateless — run N instances behind any load balancer |
| AniList rate limit (90 req/min) | 6 h in-memory cache per AniList ID |
| AnimeDekho Fribb map (~50 MB) | Loaded once per process on first request, then cached in-memory |

For 1 M daily users, run **3–5 instances** behind Cloudflare or nginx.  
No database, no Redis required.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Set to `production` in Docker |

---

## Architecture

```
pnpm monorepo
└── artifacts/api-server/   ← Express API (this service)
    ├── src/
    │   ├── providers/
    │   │   ├── animedekho.ts     CDN + watch-page + search fallback resolver
    │   │   ├── animedekho-hls.ts Direct HLS extractor (test/experimental)
    │   │   ├── anineko.ts        AniNeko embed resolver
    │   │   └── vidplay.ts        AniKoto → VidPlay/VidTube resolver
    │   ├── routes/
    │   │   ├── stream.ts         Main /api/stream/… handler
    │   │   ├── proxy.ts          Embed proxy + ad stripping
    │   │   ├── hls.ts            M3U8 CORS proxy
    │   │   └── …
    │   └── lib/
    │       ├── cache.ts          TtlCache + singleflight
    │       └── anilist.ts        AniList GraphQL helper
    └── build.mjs                 esbuild bundler → dist/index.mjs
```

## License

MIT
