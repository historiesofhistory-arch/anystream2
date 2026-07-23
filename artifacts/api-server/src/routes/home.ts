import { Router } from "express";

const router = Router();

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AniStream API</title>
  <meta name="description" content="Free, open anime streaming embed API. Drop a single iframe into any site." />
  <style>
    :root {
      --bg: #0b0b14;
      --bg2: #13131f;
      --bg3: #1a1a2e;
      --border: #2a2a40;
      --accent: #6c5ce7;
      --accent2: #a29bfe;
      --text: #e2e2f0;
      --muted: #8888aa;
      --green: #00b894;
      --red: #e17055;
      --yellow: #fdcb6e;
      --radius: 10px;
      --font: 'Inter', system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { background: var(--bg); color: var(--text); font-family: var(--font); line-height: 1.6; }

    /* ── NAV ── */
    nav {
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 20px; height: 56px;
      background: rgba(11,11,20,.92); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .nav-brand { font-size: 1.1rem; font-weight: 700; letter-spacing: -.01em; }
    .nav-brand span { color: var(--accent2); }
    .nav-docs {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 14px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--bg2);
      color: var(--text); font-size: .82rem; font-weight: 500;
      text-decoration: none; transition: border-color .15s;
    }
    .nav-docs:hover { border-color: var(--accent2); }
    .nav-docs svg { width: 13px; height: 13px; flex-shrink: 0; }

    /* ── HERO ── */
    .hero { padding: 52px 20px 36px; text-align: center; max-width: 680px; margin: 0 auto; }
    .hero h1 { font-size: clamp(1.6rem, 5vw, 2.4rem); font-weight: 800; letter-spacing: -.03em; margin-bottom: 12px; }
    .hero h1 em { font-style: normal; color: var(--accent2); }
    .hero p { color: var(--muted); font-size: .95rem; max-width: 500px; margin: 0 auto 22px; }
    .hero-url {
      display: inline-block;
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 9px 18px;
      font-family: monospace; font-size: .82rem; color: var(--accent2);
      word-break: break-all; max-width: 100%;
    }

    /* ── LAYOUT ── */
    .container { max-width: 900px; margin: 0 auto; padding: 0 20px 80px; }
    .section { margin-top: 36px; }
    .section-title {
      font-size: .7rem; font-weight: 700; letter-spacing: .1em;
      text-transform: uppercase; color: var(--muted); margin-bottom: 12px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .card {
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 18px;
    }

    /* ── ENDPOINT DOCS ── */
    .endpoint {
      background: var(--bg3); border: 1px solid var(--border);
      border-radius: var(--radius); overflow: hidden;
    }
    .endpoint-header {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 12px 16px; border-bottom: 1px solid var(--border);
    }
    .method {
      background: var(--accent); color: #fff;
      font-size: .7rem; font-weight: 700; letter-spacing: .05em;
      padding: 3px 8px; border-radius: 4px; flex-shrink: 0;
    }
    .endpoint-path {
      font-family: monospace; font-size: .85rem; color: var(--accent2);
      word-break: break-all;
    }
    .endpoint-body { padding: 14px 16px; }
    .endpoint-desc { color: var(--muted); font-size: .88rem; margin-bottom: 14px; }
    .params { display: grid; gap: 10px; }
    .param {
      display: grid;
      grid-template-columns: 130px 100px 1fr;
      gap: 10px; align-items: start;
    }
    .param-name { font-family: monospace; font-size: .83rem; color: #fff; word-break: break-all; }
    .param-type { font-size: .76rem; color: var(--green); font-weight: 600; word-break: break-all; }
    .param-desc { font-size: .83rem; color: var(--muted); }

    /* ── PROVIDERS TABLE ── */
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: .83rem; min-width: 500px; }
    thead tr { border-bottom: 1px solid var(--border); }
    th { text-align: left; padding: 7px 10px; color: var(--muted); font-weight: 600; white-space: nowrap; }
    td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .badge {
      display: inline-block; font-size: .68rem; font-weight: 700;
      padding: 2px 7px; border-radius: 4px; letter-spacing: .04em;
    }
    .badge-purple { background: rgba(108,92,231,.2); color: var(--accent2); }
    .badge-green  { background: rgba(0,184,148,.15); color: var(--green); }

    /* ── PLAYGROUND ── */
    .playground { display: grid; gap: 14px; }
    label { display: block; font-size: .7rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    input, select {
      width: 100%; padding: 9px 12px;
      background: var(--bg3); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text); font-size: .88rem;
      outline: none; transition: border-color .15s;
      appearance: none; -webkit-appearance: none;
    }
    input:focus, select:focus { border-color: var(--accent2); }
    input::placeholder { color: var(--muted); }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 4px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 10px 14px; border-radius: 8px; font-size: .85rem; font-weight: 600;
      cursor: pointer; border: none; transition: opacity .15s, transform .1s;
      white-space: nowrap;
    }
    .btn:active { transform: scale(.97); }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { opacity: .88; }
    .btn-secondary {
      background: transparent; border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-secondary:hover { border-color: var(--accent2); }
    .btn-ghost {
      background: rgba(108,92,231,.12); border: 1px solid rgba(108,92,231,.3);
      color: var(--accent2);
    }
    .btn-ghost:hover { background: rgba(108,92,231,.22); }
    .hsub-note {
      font-size: .75rem; color: var(--muted); margin-top: 6px;
      padding: 6px 10px; background: rgba(253,203,110,.07);
      border: 1px solid rgba(253,203,110,.15); border-radius: 6px;
      display: none;
    }
    .hsub-note.visible { display: block; }

    /* ── OUTPUT ── */
    #output { display: none; }
    .embed-block {
      background: var(--bg3); border: 1px solid var(--border);
      border-radius: 8px; overflow: hidden;
    }
    .embed-block-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; border-bottom: 1px solid var(--border);
      font-size: .68rem; font-weight: 700; letter-spacing: .1em;
      text-transform: uppercase; color: var(--muted);
    }
    .copy-btn {
      background: none; border: none; cursor: pointer; color: var(--muted);
      padding: 2px 6px; border-radius: 4px; font-size: .73rem;
      transition: color .15s;
    }
    .copy-btn:hover { color: var(--accent2); }
    .embed-code {
      padding: 12px; font-family: monospace; font-size: .8rem;
      color: var(--accent2); word-break: break-all; white-space: pre-wrap;
      line-height: 1.5; cursor: text;
    }
    .preview-wrap {
      position: relative; border-radius: 8px; overflow: hidden;
      background: #000; aspect-ratio: 16/9;
    }
    .preview-wrap iframe { width: 100%; height: 100%; border: none; display: block; }
    .preview-hint { font-size: .76rem; color: var(--muted); margin-top: 8px; text-align: center; }

    /* ── EXAMPLES ── */
    .examples { display: grid; gap: 8px; }
    .example {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px 12px; background: var(--bg3); border: 1px solid var(--border);
      border-radius: 8px;
    }
    .example-label { font-size: .83rem; color: var(--muted); min-width: 160px; flex-shrink: 0; }
    .example-url { font-family: monospace; font-size: .76rem; color: var(--accent2); word-break: break-all; flex: 1; min-width: 0; }
    .example-try {
      background: none; border: 1px solid var(--border); color: var(--text);
      font-size: .73rem; padding: 4px 10px; border-radius: 6px;
      cursor: pointer; white-space: nowrap; transition: border-color .15s; flex-shrink: 0;
    }
    .example-try:hover { border-color: var(--accent2); }

    /* ── HOW IT WORKS ── */
    .steps { display: grid; gap: 14px; }
    .step { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start; }
    .step-num {
      width: 28px; height: 28px; background: var(--accent); border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: .78rem; font-weight: 700; flex-shrink: 0;
    }

    /* ── FOOTER ── */
    footer { text-align: center; padding: 28px 20px; color: var(--muted); font-size: .8rem; border-top: 1px solid var(--border); }

    /* ── MOBILE ── */
    @media (max-width: 600px) {
      .row { grid-template-columns: 1fr; }
      .btn-row { grid-template-columns: 1fr 1fr; }
      .btn-row .btn:last-child { grid-column: 1 / -1; }
      .param { grid-template-columns: 1fr; gap: 2px; }
      .param-type { margin-bottom: 2px; }
      .example { gap: 6px; }
      .example-label { min-width: 0; width: 100%; }
      .example-url { width: 100%; }
    }
    @media (max-width: 400px) {
      .btn-row { grid-template-columns: 1fr; }
      .btn-row .btn:last-child { grid-column: auto; }
    }
  </style>
</head>
<body>

<nav>
  <div class="nav-brand">AniStream <span>API</span></div>
  <a class="nav-docs" href="#docs">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    Docs
  </a>
</nav>

<div class="hero">
  <h1>Anime Streaming<br/><em>Embed API</em></h1>
  <p>One URL. Drop it in any iframe. Works on any site, any framework, any device.</p>
  <div class="hero-url">/api/stream/anix.at/{anilistId}/{episode}/{sub|dub|hsub|hin}</div>
</div>

<div class="container">

  <!-- ── TEST YOUR EMBED ── -->
  <div class="section">
    <div class="section-title">🎮 Test Your Embed</div>
    <div class="card">
      <div class="playground">
        <div class="row">
          <div>
            <label>AniList ID</label>
            <input id="aniId" type="number" placeholder="e.g. 20 (Naruto)" value="20" min="1" />
          </div>
          <div>
            <label>Episode Number</label>
            <input id="epNo" type="number" placeholder="e.g. 1" value="1" min="1" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>Language / Type</label>
            <select id="lang" onchange="onLangChange()">
              <option value="sub">Sub (Subtitled)</option>
              <option value="dub">Dub (Dubbed)</option>
              <option value="hsub">HSub (Hard Subtitle)</option>
              <option value="hin">Hindi Dub 🇮🇳</option>
            </select>
          </div>
          <div>
            <label>Provider</label>
            <select id="provider" onchange="onProviderChange()">
              <option value="">Default (Megaplay)</option>
              <option value="hd">HD-1 · Megaplay s-5</option>
              <option value="vs">Vidstream · Megaplay s-2</option>
              <option value="vw">VidWish · vidwish.live</option>
              <option value="vp">VP · VidPlay / VidTube</option>
              <option value="am">AM · AniNeko (anineko.to)</option>
              <option value="ad">AD · AnimeDekho (Hindi)</option>
            </select>
            <div style="margin-top:7px;font-size:.72rem;color:var(--muted);">
              VidPlay के लिए <strong style="color:var(--accent2)">VP · VidPlay / VidTube</strong> चुनें।
              Default provider बिना <code>?p=</code> के Megaplay रहता है।
            </div>
          </div>
        </div>
        <div class="hsub-note" id="hsubNote">
          ⚠️ HSub is only available with the <strong>AM · AniNeko</strong> provider. Provider will be set automatically.
        </div>
        <div class="hsub-note" id="hinNote">
          🇮🇳 Hindi Dub is only available with the <strong>AD · AnimeDekho</strong> provider. Provider will be set automatically.
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="generate()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Generate
          </button>
          <button class="btn btn-secondary" onclick="generateBoth()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Sub + Dub
          </button>
          <button class="btn btn-ghost" onclick="generateAll()">
            ⊕ All Types
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── OUTPUT ── -->
  <div id="output" class="section">
    <div class="section-title">📋 Embed Code</div>
    <div style="display:grid;gap:14px;">
      <div id="embedBlocks"></div>
      <div class="preview-wrap">
        <iframe id="previewFrame" allowfullscreen
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          referrerpolicy="unsafe-url"></iframe>
      </div>
      <p class="preview-hint">Click code block to select · Use ⧉ Copy for full iframe HTML</p>
      <p id="generatedUrl" class="preview-hint" style="overflow-wrap:anywhere;"></p>
    </div>
  </div>

  <!-- ── DOCS ── -->
  <div id="docs" class="section">
    <div class="section-title">📖 API Reference</div>

    <!-- Main stream endpoint -->
    <div class="endpoint" style="margin-bottom:14px;">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-path">/api/stream/anix.at/:anilistId/:episode/:type[?p=provider]</span>
      </div>
      <div class="endpoint-body">
        <p class="endpoint-desc">
          Returns a self-contained HTML player page. Embed it directly in any
          <code style="color:var(--accent2)">&lt;iframe&gt;</code> — no JS needed on your end.
          The referrer trick is baked in so the player skips popup/redirect ads automatically.
        </p>
        <div class="params">
          <div class="param">
            <span class="param-name">anilistId</span>
            <span class="param-type">number</span>
            <span class="param-desc">AniList anime ID — find it in the URL on anilist.co/anime/{id}</span>
          </div>
          <div class="param">
            <span class="param-name">episode</span>
            <span class="param-type">number</span>
            <span class="param-desc">Episode number starting from 1</span>
          </div>
          <div class="param">
            <span class="param-name">type</span>
            <span class="param-type">sub | dub | hsub | hin</span>
            <span class="param-desc">
              Audio/subtitle type. <code style="color:var(--accent2)">sub</code> = soft subtitle,
              <code style="color:var(--accent2)">dub</code> = English dubbed,
              <code style="color:var(--accent2)">hsub</code> = hard-burned subtitle (AM only),
              <code style="color:var(--accent2)">hin</code> = Hindi dub (AD / AnimeDekho only)
            </span>
          </div>
          <div class="param">
            <span class="param-name">?p=</span>
            <span class="param-type">string</span>
            <span class="param-desc">Optional provider slug. Omit for default Megaplay. See table below.</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Providers table -->
    <div class="card" style="margin-bottom:14px;">
      <div style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;">
        Providers (?p=)
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>?p=</th>
              <th>Provider</th>
              <th>Source</th>
              <th>Types</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code style="color:var(--accent2)">(none)</code></td>
              <td>Megaplay Default</td>
              <td style="color:var(--muted)">megaplay.buzz</td>
              <td><span class="badge badge-green">sub dub</span></td>
              <td style="color:var(--muted)">No extra fetch — fastest</td>
            </tr>
            <tr>
              <td><code style="color:var(--accent2)">hd</code></td>
              <td>HD-1</td>
              <td style="color:var(--muted)">megaplay.buzz/s-5</td>
              <td><span class="badge badge-green">sub dub</span></td>
              <td style="color:var(--muted)">Megaplay HD server</td>
            </tr>
            <tr>
              <td><code style="color:var(--accent2)">vs</code></td>
              <td>Vidstream</td>
              <td style="color:var(--muted)">megaplay.buzz/s-2</td>
              <td><span class="badge badge-green">sub dub</span></td>
              <td style="color:var(--muted)">Megaplay Vidstream</td>
            </tr>
            <tr>
              <td><code style="color:var(--accent2)">vw</code></td>
              <td>VidWish</td>
              <td style="color:var(--muted)">vidwish.live</td>
              <td><span class="badge badge-green">sub dub</span></td>
              <td style="color:var(--muted)">Alternate CDN</td>
            </tr>
            <tr>
              <td><code style="color:var(--accent2)">vp</code></td>
              <td>VidPlay</td>
              <td style="color:var(--muted)">AniKoto → vidtube.site</td>
              <td><span class="badge badge-green">sub dub hsub</span></td>
              <td style="color:var(--muted)">
                AniList ID → exact AniKoto season and episode → VidTube embed.
                Matching is validated before the iframe is returned; cached and singleflight.
              </td>
            </tr>
            <tr>
              <td><code style="color:var(--accent2)">am</code></td>
              <td>AniNeko</td>
              <td style="color:var(--muted)">anineko.to → vivibebe.site</td>
              <td><span class="badge badge-purple">sub dub hsub</span></td>
              <td style="color:var(--muted)">
                AniList ID → fuzzy title match + episode count → embed.
                First call ~1–2 s (resolves + caches slug 24 h).
              </td>
            </tr>
            <tr>
              <td><code style="color:var(--accent2)">ad</code></td>
              <td>AnimeDekho 🇮🇳 <span class="badge badge-purple" style="margin-left:4px">NEW</span></td>
              <td style="color:var(--muted)">animedekho.app → as-cdn21.top</td>
              <td><span class="badge badge-purple">hin</span></td>
              <td style="color:var(--muted)">
                Hindi dub only. AniList ID → TMDB ID (via Fribb map) → AnimeDekho embed → CDN URL.
                Season auto-discovered in ~1–2 s on first call, cached 1 h.
                Sandbox iframe blocks popup &amp; redirect ads.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style="margin-top:10px;font-size:.78rem;color:var(--muted);">
        Providers <code style="color:var(--accent2)">hd</code>, <code style="color:var(--accent2)">vs</code>,
        <code style="color:var(--accent2)">vw</code> resolve a stream ID from Megaplay — adds ~300–600 ms on first load.
        Providers <code style="color:var(--accent2)">vp</code> and <code style="color:var(--accent2)">am</code>
        resolve and cache an embed URL on the first call. No video bytes pass through this server.
      </p>
    </div>

    <!-- AniList proxy -->
    <div class="endpoint" style="margin-bottom:14px;">
      <div class="endpoint-header">
        <span class="method">POST</span>
        <span class="endpoint-path">/api/anilist</span>
      </div>
      <div class="endpoint-body">
        <p class="endpoint-desc">
          Proxy for the AniList GraphQL API — avoids CORS issues when calling from a browser.
          Send any valid AniList GraphQL query in the request body.
        </p>
      </div>
    </div>

    <!-- Search -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-path">/api/anime/search?q={title}</span>
      </div>
      <div class="endpoint-body">
        <p class="endpoint-desc">Search anime by title. Returns id, slug, title, thumbnail, year, sub/dub count.</p>
      </div>
    </div>
  </div>

  <!-- ── EXAMPLES ── -->
  <div class="section">
    <div class="section-title">⚡ Quick Examples</div>
    <div class="examples">
      <div class="example">
        <span class="example-label">Naruto Ep 1 · Sub</span>
        <span class="example-url">/api/stream/anix.at/20/1/sub</span>
        <button class="example-try" onclick="tryExample(20,1,'sub','')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">Demon Slayer Ep 1 · Sub</span>
        <span class="example-url">/api/stream/anix.at/101922/1/sub</span>
        <button class="example-try" onclick="tryExample(101922,1,'sub','')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">Solo Leveling Ep 1 · HSub <span class="badge badge-purple" style="font-size:.65rem">AM</span></span>
        <span class="example-url">/api/stream/anix.at/151807/1/hsub?p=am</span>
        <button class="example-try" onclick="tryExample(151807,1,'hsub','am')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">Solo Leveling Ep 1 · Sub <span class="badge badge-purple" style="font-size:.65rem">AM</span></span>
        <span class="example-url">/api/stream/anix.at/151807/1/sub?p=am</span>
        <button class="example-try" onclick="tryExample(151807,1,'sub','am')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">Attack on Titan Ep 1 · Sub</span>
        <span class="example-url">/api/stream/anix.at/16498/1/sub</span>
        <button class="example-try" onclick="tryExample(16498,1,'sub','')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">Re:ZERO Ep 1 · HSub <span class="badge badge-purple" style="font-size:.65rem">AM</span></span>
        <span class="example-url">/api/stream/anix.at/21355/1/hsub?p=am</span>
        <button class="example-try" onclick="tryExample(21355,1,'hsub','am')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">Naruto Ep 1 · Hindi 🇮🇳 <span class="badge badge-purple" style="font-size:.65rem">AD</span></span>
        <span class="example-url">/api/stream/anix.at/20/1/hin?p=ad</span>
        <button class="example-try" onclick="tryExample(20,1,'hin','ad')">Try →</button>
      </div>
      <div class="example">
        <span class="example-label">JJK 0 Movie · Hindi 🇮🇳 <span class="badge badge-purple" style="font-size:.65rem">AD</span></span>
        <span class="example-url">/api/stream/anix.at/120978/1/hin?p=ad</span>
        <button class="example-try" onclick="tryExample(120978,1,'hin','ad')">Try →</button>
      </div>
    </div>
  </div>

  <!-- ── HOW IT WORKS ── -->
  <div class="section">
    <div class="section-title">🔍 How It Works</div>
    <div class="card">
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div>
            <strong>Your page embeds our URL</strong><br/>
            <span style="color:var(--muted);font-size:.86rem;">
              Your iframe src points to <code style="color:var(--accent2)">/api/stream/anix.at/{id}/{ep}/{type}</code>
            </span>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div>
            <strong>Our server returns a player page</strong><br/>
            <span style="color:var(--muted);font-size:.86rem;">
              Default/Megaplay: instant iframe. AM provider: resolves AniList ID → anineko slug → vivibebe.site embed (cached 24 h).
            </span>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div>
            <strong>Player sees a trusted referrer</strong><br/>
            <span style="color:var(--muted);font-size:.86rem;">
              <code style="color:var(--accent2)">referrerPolicy="unsafe-url"</code> sends the full URL as Referer — popup ads are skipped automatically.
            </span>
          </div>
        </div>
        <div class="step">
          <div class="step-num">4</div>
          <div>
            <strong>Zero video bandwidth on our server</strong><br/>
            <span style="color:var(--muted);font-size:.86rem;">
              Only small HTML/M3U8 text files pass through. Video segments stream directly from the CDN to the viewer.
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>

</div>

<footer>
  AniStream API &mdash; Open source anime streaming embed
</footer>

<script>
  function getOrigin() { return window.location.origin; }

  function effectiveProvider() {
    const lang = document.getElementById('lang').value;
    const p    = document.getElementById('provider').value;
    if (lang === 'hsub') return 'am';   // HSub only works with AM
    return p;
  }

  function buildUrl(id, ep, type, provider) {
    const base = getOrigin() + '/api/stream/anix.at/' + id + '/' + ep + '/' + type;
    return provider ? base + '?p=' + provider : base;
  }

  function buildCode(id, ep, type, provider) {
    const url = buildUrl(id, ep, type, provider);
    return '<iframe src="' + url + '" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen referrerpolicy="unsafe-url"></iframe>';
  }

  function makeEmbedBlock(label, code, url) {
    const id = 'code_' + Math.random().toString(36).slice(2);
    return \`<div class="embed-block" style="margin-bottom:10px;">
      <div class="embed-block-header">
        <span>EMBED (\${label.toUpperCase()})</span>
        <button class="copy-btn" onclick="copyCode('\${id}')">⧉ Copy</button>
      </div>
      <div class="embed-code" id="\${id}" onclick="selectCode('\${id}')">\${escHtml(code)}</div>
    </div>\`;
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function selectCode(id) {
    const el = document.getElementById(id);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function copyCode(id) {
    const el = document.getElementById(id);
    navigator.clipboard.writeText(el.textContent).then(() => {
      const btn = el.parentElement.querySelector('.copy-btn');
      btn.textContent = '✓ Copied';
      setTimeout(() => btn.textContent = '⧉ Copy', 1800);
    });
  }

  function showOutput(blocks, previewUrl) {
    document.getElementById('output').style.display = 'block';
    document.getElementById('embedBlocks').innerHTML = blocks;
    document.getElementById('previewFrame').src = previewUrl;
    document.getElementById('generatedUrl').innerHTML =
      'Request URL: <code style="color:var(--accent2)">' + escHtml(previewUrl) + '</code>';
    document.getElementById('output').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function onLangChange() {
    const lang = document.getElementById('lang').value;
    document.getElementById('hsubNote').classList.toggle('visible', lang === 'hsub');
    document.getElementById('hinNote').classList.toggle('visible',  lang === 'hin');
    if (lang === 'hsub') document.getElementById('provider').value = 'am';
    if (lang === 'hin')  document.getElementById('provider').value = 'ad';
  }

  function onProviderChange() {
    const p = document.getElementById('provider').value;
    const lang = document.getElementById('lang').value;
    if (p !== 'am' && lang === 'hsub') {
      document.getElementById('lang').value = 'sub';
      document.getElementById('hsubNote').classList.remove('visible');
    }
    if (p !== 'ad' && lang === 'hin') {
      document.getElementById('lang').value = 'sub';
      document.getElementById('hinNote').classList.remove('visible');
    }
  }

  function generate() {
    const id   = document.getElementById('aniId').value || '20';
    const ep   = document.getElementById('epNo').value  || '1';
    const type = document.getElementById('lang').value;
    const p    = effectiveProvider();
    const label = type + (p ? ' · ' + p : '');
    showOutput(makeEmbedBlock(label, buildCode(id, ep, type, p), buildUrl(id, ep, type, p)),
               buildUrl(id, ep, type, p));
  }

  function generateBoth() {
    const id = document.getElementById('aniId').value || '20';
    const ep = document.getElementById('epNo').value  || '1';
    const p  = effectiveProvider() || document.getElementById('provider').value;
    const blocks =
      makeEmbedBlock('sub' + (p ? ' · '+p : ''), buildCode(id, ep, 'sub', p), buildUrl(id, ep, 'sub', p)) +
      makeEmbedBlock('dub' + (p ? ' · '+p : ''), buildCode(id, ep, 'dub', p), buildUrl(id, ep, 'dub', p));
    showOutput(blocks, buildUrl(id, ep, 'sub', p));
  }

  function generateAll() {
    const id = document.getElementById('aniId').value || '20';
    const ep = document.getElementById('epNo').value  || '1';
    const p  = 'am';   // all types only make sense for AM
    const blocks =
      makeEmbedBlock('hsub · am', buildCode(id, ep, 'hsub', p), buildUrl(id, ep, 'hsub', p)) +
      makeEmbedBlock('sub · am',  buildCode(id, ep, 'sub',  p), buildUrl(id, ep, 'sub',  p)) +
      makeEmbedBlock('dub · am',  buildCode(id, ep, 'dub',  p), buildUrl(id, ep, 'dub',  p));
    showOutput(blocks, buildUrl(id, ep, 'hsub', p));
  }

  function tryExample(id, ep, type, provider) {
    document.getElementById('aniId').value     = id;
    document.getElementById('epNo').value      = ep;
    document.getElementById('lang').value      = type;
    document.getElementById('provider').value  = provider;
    onLangChange();
    generate();
    document.getElementById('output').scrollIntoView({ behavior: 'smooth' });
  }
</script>

</body>
</html>`;

router.get("/", (_req, res) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.send(HTML);
});

export default router;
