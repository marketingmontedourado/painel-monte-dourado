// Vercel Serverless Function — Autenticação por PIN
// Env vars: PINS = JSON com PINs e roles
// Ex: PINS = {"1234":{"name":"Vitória","role":"admin"},"5678":{"name":"Sócio 1","role":"socio"}}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  const { pin } = req.body;
  if (!pin || pin.length !== 4) return res.status(400).json({ error: "PIN inválido" });

  const pinsRaw = process.env.PINS;
  if (!pinsRaw) return res.status(500).json({ error: "PINs não configurados" });

  try {
    const pins = JSON.parse(pinsRaw);
    const user = pins[pin];
    if (!user) return res.status(401).json({ error: "PIN incorreto" });

    // Gera um token simples (hash do PIN + timestamp)
    const token = Buffer.from(`${pin}:${user.role}:${Date.now()}`).toString("base64");
    
    return res.status(200).json({ 
      success: true, 
      name: user.name, 
      role: user.role,
      token 
    });
  } catch (err) {
    return res.status(500).json({ error: "Erro interno" });
  }
}
