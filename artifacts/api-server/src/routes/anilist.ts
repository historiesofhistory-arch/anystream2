import { Router } from "express";

const router = Router();

// Proxy AniList GraphQL to avoid CORS issues from the browser
router.post("/anilist", async (req, res) => {
  try {
    const upstream = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "AniList proxy failed");
    res.status(502).json({ error: "AniList request failed" });
  }
});

export default router;
