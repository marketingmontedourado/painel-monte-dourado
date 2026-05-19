// api/ig-list.js
// Endpoint de debug: lista todas as contas Instagram conectadas ao Business Manager via o token do System User.
// Use 1x pra descobrir o ig_user_id de uma conta nova, depois pode deletar.
//
// Chamada: GET /api/ig-list  (header x-md-key obrigatório)

const ALLOWED_ORIGINS = [
  "https://painel-monte-dourado.vercel.app",
  "http://localhost:5173"
];

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

  // Auth: x-md-key header (mesma chave usada nas outras APIs)
  const apiKey = req.headers["x-md-key"];
  if (!apiKey || apiKey !== process.env.MD_API_KEY) {
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
