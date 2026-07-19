import { Router } from "express";

const router = Router();

// Returns the exact Referer header received — for debugging
router.get("/echo-referer", (req, res) => {
  const referer = req.headers["referer"] || req.headers["referrer"] || "(none)";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  // Also serve as a minimal HTML page so it works both as iframe src and as JSON
  const accept = req.headers["accept"] || "";
  if (accept.includes("text/html")) {
    res.send(`<!DOCTYPE html><html><body style="background:#111;color:#4ade80;font-family:monospace;padding:20px;font-size:16px;">
      <strong>Referer received:</strong><br/><br/>
      <span id="r">${referer}</span>
      <script>
        window.parent.postMessage({ referer: ${JSON.stringify(referer)} }, "*");
      </script>
    </body></html>`);
  } else {
    res.json({ referer });
  }
});

export default router;
