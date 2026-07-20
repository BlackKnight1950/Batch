import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SMARTSHEET_TOKEN;
const SHEET_ID = process.env.SHEET_ID || "8431524360703876";
const GATE = process.env.ACCESS_CODE || "";
const API = "https://api.smartsheet.com/2.0";

if (!TOKEN) {
  console.error("SMARTSHEET_TOKEN is not set. Add it in Render → Environment.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));

// Malformed JSON must not surface a stack trace.
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ message: "The request body wasn't valid JSON." });
  }
  next(err);
});

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* ---------- simple in-memory rate limit ---------- */
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  const now = Date.now();
  const win = 60_000;
  const max = 40;
  const rec = hits.get(ip) || { start: now, n: 0 };
  if (now - rec.start > win) { rec.start = now; rec.n = 0; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  if (rec.n > max) return res.status(429).json({ message: "Too many requests. Wait a minute and try again." });
  next();
}

/* ---------- access gate ---------- */
function gate(req, res, next) {
  if (!GATE) return next();
  const sent = req.get("X-Access-Code") || "";
  const a = Buffer.from(sent);
  const b = Buffer.from(GATE);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ message: "That access code isn't right." });
  next();
}

app.get("/api/config", (_req, res) => {
  res.json({ sheetId: SHEET_ID, gated: Boolean(GATE) });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- schema ---------- */
app.get("/api/columns", rateLimit, gate, async (_req, res) => {
  try {
    const r = await fetch(`${API}/sheets/${SHEET_ID}/columns?includeAll=true`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ message: describe(r.status, body) });
    res.json(body);
  } catch (e) {
    res.status(502).json({ message: "Couldn't reach Smartsheet. Try again in a moment." });
  }
});

/* ---------- write rows ---------- */
app.post("/api/rows", rateLimit, gate, async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ message: "No rows were sent." });
  }
  if (rows.length > 50) {
    return res.status(400).json({ message: "Send at most 50 rows per request." });
  }
  try {
    const r = await fetch(`${API}/sheets/${SHEET_ID}/rows`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(rows)
    });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ message: describe(r.status, body) });
    const submitter = (req.body?.submittedBy || "").slice(0, 120);
    console.log(`[submit] ${body.result?.length ?? rows.length} rows${submitter ? ` by ${submitter}` : ""}`);
    res.json(body);
  } catch (e) {
    res.status(502).json({ message: "Couldn't reach Smartsheet. Try again in a moment." });
  }
});

function describe(status, body) {
  if (status === 401) return "The server's Smartsheet token was rejected. It may have expired — an administrator needs to rotate it.";
  if (status === 403) return "The server's Smartsheet account doesn't have access to this sheet.";
  if (status === 404) return "Sheet not found. Check the SHEET_ID setting.";
  if (status === 429) return "Smartsheet is rate limiting. Wait a minute and try again.";
  return body?.message || `Smartsheet returned ${status}.`;
}

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Nothing internal should ever reach the client.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Something went wrong on the server." });
});

app.listen(PORT, () => console.log(`Listening on ${PORT} → sheet ${SHEET_ID}`));
