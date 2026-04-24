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

    if (!trackingUrl) return res.status(200).json({ ok: true });

    try {
      // Google Apps Script retorna redirect 302 — precisa seguir manualmente
      const r1 = await fetch(trackingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
        redirect: "manual",
      });
      // Se redirect, segue com POST
      if (r1.status >= 300 && r1.status < 400) {
        const loc = r1.headers.get("location");
        if (loc) {
          await fetch(loc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
            redirect: "follow",
          });
        }
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(200).json({ ok: true });
    }
  }

  // GET — buscar dados de analytics
  if (req.method === "GET") {
    if (!trackingUrl) return res.status(200).json({ data: [] });
    try {
      const r = await fetch(trackingUrl, { redirect: "follow" });
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        return res.status(200).json(j);
      } catch (e) {
        // Se recebeu HTML (redirect do Google), tenta extrair JSON
        return res.status(200).json({ data: [] });
      }
    } catch (e) {
      return res.status(200).json({ data: [] });
    }
  }

  return res.status(405).json({ error: "Metodo nao permitido" });
}
