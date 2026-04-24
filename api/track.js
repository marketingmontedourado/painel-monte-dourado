// Vercel Serverless Function — Tracking de acessos
// Env var: TRACKING_URL (Google Apps Script Web App URL)

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
      name: name || "",
      role: role || "",
      event: event || "",
      tab: tab || "",
      brand: brand || "",
      period: period || "",
      ua: (req.headers["user-agent"] || "").substring(0, 100),
    };

    if (!trackingUrl) {
      console.log("TRACKING_URL nao configurada");
      return res.status(200).json({ ok: true, note: "no_url" });
    }

    try {
      const r = await fetch(trackingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
        redirect: "follow",
      });
      const txt = await r.text();
      console.log("Track OK:", r.status, txt.substring(0, 200));
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.log("Track ERRO:", e.message);
      return res.status(200).json({ ok: true, error: e.message });
    }
  }

  // GET — buscar dados de analytics
  if (req.method === "GET") {
    if (!trackingUrl) return res.status(200).json({ data: [], note: "no_url" });
    try {
      const r = await fetch(trackingUrl, { redirect: "follow" });
      const j = await r.json();
      return res.status(200).json(j);
    } catch (e) {
      return res.status(200).json({ data: [], error: e.message });
    }
  }

  return res.status(405).json({ error: "Metodo nao permitido" });
}
