import { Router } from "express";

const router = Router();

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Encoding": "identity",
  Referer: "https://anix.at/",
};

async function aniGet(path: string) {
  const res = await fetch(`https://anix.at/${path}`, { headers: HEADERS });
  return res.json() as Promise<{ status: number; result: any }>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseSearchHtml(html: string) {
  const results: any[] = [];
  const itemRe =
    /<a class="aitem[^"]*"\s+href="https:\/\/anichi\.to\/anime\/([^"]+)"\s+data-tip="(\d+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const [, slug, id, inner] = m;
    const imgM = inner.match(/src="([^"]+)"/);
    const titleM = inner.match(/data-en="([^"]+)"/);
    const yearM = inner.match(/<span>(\d{4})<\/span>/);
    const typeM = inner.match(/<b>([^<]+)<\/b>/);
    const subM = inner.match(/class="sub"[^>]*><[^>]+><\/[^>]+>(\d+)/);
    const dubM = inner.match(/class="dub"[^>]*><[^>]+><\/[^>]+>(\d+)/);
    results.push({
      id,
      slug,
      title: titleM ? titleM[1] : slug,
      thumbnail: imgM ? imgM[1] : null,
      year: yearM ? yearM[1] : null,
      type: typeM ? typeM[1] : null,
      subCount: subM ? parseInt(subM[1]) : 0,
      dubCount: dubM ? parseInt(dubM[1]) : 0,
    });
  }
  return results;
}

function parseEpisodeHtml(html: string) {
  const results: any[] = [];
  const epRe =
    /<a[^>]+data-id="(\d+)"[^>]+data-num="([^"]+)"[^>]+data-slug="([^"]*)"[^>]+data-sub="(\d)"[^>]+data-dub="(\d)"[^>]+data-ids="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = epRe.exec(html)) !== null) {
    const [, id, num, , sub, dub, ids, inner] = m;
    const titleM = inner.match(/class="d-title"[^>]*>([^<]+)</);
    results.push({
      id,
      num: parseFloat(num),
      title: titleM ? titleM[1].trim() : `Episode ${num}`,
      sub: sub === "1",
      dub: dub === "1",
      ids,
    });
  }
  return results.sort((a, b) => a.num - b.num);
}

function parseServerHtml(html: string) {
  const servers: any[] = [];
  // Structure: <div class="type" data-type="sub|dub"> ... <li data-link-id="...">Name</li>
  const typeSectionRe = /<div[^>]+data-type="([^"]+)"[^>]*>([\s\S]*?)<\/ul>/g;
  let tm;
  while ((tm = typeSectionRe.exec(html)) !== null) {
    const [, type, sectionHtml] = tm;
    const liRe = /data-link-id="([^"]+)"[^>]*>([^<]+)</g;
    let lm;
    while ((lm = liRe.exec(sectionHtml)) !== null) {
      const [, linkId, name] = lm;
      servers.push({ linkId, type, name: name.trim() });
    }
  }
  return servers;
}

// ── routes ───────────────────────────────────────────────────────────────────

// GET /api/anime/search?q=naruto
router.get("/anime/search", async (req, res) => {
  const q = (req.query.q as string) || "";
  if (!q.trim()) {
    res.json([]);
    return;
  }
  try {
    const data = await aniGet(`ajax/anime/search?keyword=${encodeURIComponent(q)}`);
    if (data.status !== 200) {
      res.json([]);
      return;
    }
    res.json(parseSearchHtml(data.result.html));
  } catch (err) {
    req.log.error({ err }, "anime search failed");
    res.status(502).json({ error: "Search failed" });
  }
});

// GET /api/anime/:id/episodes
router.get("/anime/:id/episodes", async (req, res) => {
  try {
    const data = await aniGet(`ajax/episode/list/${req.params.id}`);
    if (data.status !== 200) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(parseEpisodeHtml(data.result));
  } catch (err) {
    req.log.error({ err }, "episode list failed");
    res.status(502).json({ error: "Failed to load episodes" });
  }
});

// GET /api/anime/stream?ids=<encodedIds>&type=sub|dub
router.get("/anime/stream", async (req, res) => {
  // Express decodes '+' as space in query strings — restore it for base64 ids
  const ids = ((req.query.ids as string) || "").replace(/ /g, "+");
  const type = (req.query.type as string) || "sub";
  if (!ids) {
    res.status(400).json({ error: "Missing ids" });
    return;
  }
  try {
    // 1. Get server list
    const serverData = await aniGet(`ajax/server/list?servers=${encodeURIComponent(ids)}`);
    if (serverData.status !== 200) {
      res.status(502).json({ error: "No servers" });
      return;
    }
    const servers = parseServerHtml(serverData.result);

    // 2. Pick best server — prefer megaplay-friendly ones, fallback to first
    const preferred = ["VidPlay", "HD", "Vidstream", "VidCloud", "StreamWish"];
    const typeServers = servers.filter(
      (s) => s.type === type || s.type === "sub"
    );
    let chosen =
      typeServers.find((s) => preferred.some((p) => s.name.includes(p))) ||
      typeServers[0] ||
      servers[0];

    if (!chosen) {
      res.status(404).json({ error: "No server available" });
      return;
    }

    // 3. Resolve iframe URL
    const streamData = await aniGet(`ajax/server?get=${chosen.linkId}`);
    const streamUrl = streamData.result?.url || streamData.result?.link;
    if (streamData.status !== 200 || !streamUrl) {
      res.status(502).json({ error: "Could not get stream link" });
      return;
    }

    res.json({
      url: streamUrl,
      server: chosen.name,
      type: chosen.type,
      allServers: servers,
    });
  } catch (err) {
    req.log.error({ err }, "stream resolve failed");
    res.status(502).json({ error: "Stream failed" });
  }
});

export default router;
