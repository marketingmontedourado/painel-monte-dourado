// Vercel Serverless Function — Tracking de acessos
// Env var opcional: TRACKING_URL (Google Apps Script Web App URL)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const trackingUrl = process.env.TRACKING_URL;

  // POST — registrar evento
  if (req.method === "POST") {
    const { name, role, event, tab, brand, period } = req.body || {};
    const entry = {
      timestamp: new Date().toISOString(),
      name: name || "—",
      role: role || "—",
      event: event || "—",
      tab: tab || "—",
      brand: brand || "—",
      period: period || "—",
      ua: (req.headers["user-agent"] || "").substring(0, 100),
    };

    // Se tem URL do Google Apps Script, envia
    if (trackingUrl) {
      try {
        await fetch(trackingUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      } catch (e) {
        // Silently fail — tracking não deve bloquear o app
      }
    }

    return res.status(200).json({ ok: true });
  }

  // GET — buscar dados de analytics (para o admin)
  if (req.method === "GET") {
    if (!trackingUrl) return res.status(200).json({ data: [] });
    try {
      const r = await fetch(trackingUrl);
      const j = await r.json();
      return res.status(200).json(j);
    } catch (e) {
      return res.status(200).json({ data: [] });
    }
  }

  return res.status(405).json({ error: "Método não permitido" });
}
