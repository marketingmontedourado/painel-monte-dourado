// api/ig-list.js
// Endpoint de debug: lista todas as contas Instagram conectadas ao Business Manager via o token do System User.
// Use 1x pra descobrir o ig_user_id de uma conta nova, depois pode deletar.
//
// Chamada: GET /api/ig-list  (header x-md-key obrigatório)

import crypto from "crypto";

const ALLOWED_ORIGINS = [
  "https://painel-monte-dourado.vercel.app",
  "http://localhost:5173"
];

const COOKIE_NAME = "md_session";
function readSession(req) {
  const secret = process.env.MD_SESSION_SECRET;
  if (!secret) return null;
  const header = req.headers.cookie || "";
  let cookieValue = null;
  for (const p of header.split(";").map((s) => s.trim())) {
    if (p.startsWith(`${COOKIE_NAME}=`)) { cookieValue = p.slice(COOKIE_NAME.length + 1); break; }
  }
  if (!cookieValue || !cookieValue.includes(".")) return null;
  const [body, sig] = cookieValue.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-md-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  // Auth: sessão por cookie HttpOnly (antes era x-md-key exposto no bundle Vite)
  if (!readSession(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: "no_token" });

  try {
    // Lista TODAS as páginas que o System User pode acessar, expandindo o IG vinculado a cada uma.
    const url = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count}&limit=100&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.error) {
      return res.status(400).json({ error: "graph_api_error", details: data.error });
    }

    const pages = data.data || [];
    const igs = pages
      .filter(p => p.instagram_business_account)
      .map(p => ({
        page_id: p.id,
        page_name: p.name,
        ig_user_id: p.instagram_business_account.id,
        ig_username: p.instagram_business_account.username,
        ig_name: p.instagram_business_account.name,
        followers: p.instagram_business_account.followers_count,
        media_count: p.instagram_business_account.media_count
      }));

    return res.status(200).json({
      pages_total: pages.length,
      igs_total: igs.length,
      pages_without_ig: pages.filter(p => !p.instagram_business_account).map(p => ({ id: p.id, name: p.name })),
      accounts: igs
    });
  } catch (err) {
    return res.status(500).json({ error: "fetch_failed", message: err.message });
  }
}
