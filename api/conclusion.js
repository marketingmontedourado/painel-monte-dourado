// Vercel Serverless Function — Gera conclusão analítica via Anthropic API
// v2 — fechado (CORS travado + exige cookie de sessão válido)
//
// Env vars:
//   ANTHROPIC_API_KEY    → chave da API da Anthropic (NUNCA expor no client)
//   MD_SESSION_SECRET    → mesmo segredo do api-auth-v2 (pra validar cookie)
//   ALLOWED_ORIGIN       → origem permitida no CORS
//   ANTHROPIC_MODEL      → (opcional) default: "claude-haiku-4-5-20251001"
//
// Body POST: { data, period, brand, question }
// Retorna: { success, conclusion } ou { success: false, error }

import crypto from "crypto";

const COOKIE_NAME = "md_session";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30; // 30 chamadas/min por IP (Anthropic API tem custo)
const rateBucket = new Map();

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export default async function handler(req, res) {
  // CORS travado
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://painel-monte-dourado.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido" });

  // Exige sessão válida via cookie
  const session = readSession(req);
  if (!session) return res.status(401).json({ success: false, error: "Não autorizado" });

  // Rate limit
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .toString().split(",")[0].trim();
  if (!checkRate(ip)) return res.status(429).json({ success: false, error: "Muitas requisições — aguarde 1 min" });

  // Aceita tanto ANTHROPIC_API_KEY (padrão indústria) quanto CHAVE_API_ANTROPICA (var existente do Vitória)
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CHAVE_API_ANTROPICA;
  if (!apiKey) return res.status(500).json({ success: false, error: "ANTHROPIC_API_KEY (ou CHAVE_API_ANTROPICA) não configurada" });

  const { data, period, brand, question } = req.body || {};
  if (!data) return res.status(400).json({ success: false, error: "Campo 'data' obrigatório" });

  // Sanitiza tamanho do payload pra evitar abuso (dashboards têm payloads grandes mas finitos)
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  if (dataStr.length > 500_000) {
    return res.status(413).json({ success: false, error: "Payload muito grande (>500KB)" });
  }

  const systemPrompt = `Você é um analista sênior de marketing digital da Monte Dourado Incorporações (Fortaleza/CE).
Analise os dados em PORTUGUÊS, direto e objetivo (sem floreios). Foque em:
- Insight prático (não descreva números, INTERPRETE)
- Recomendação acionável
- Comparação MoM/YoY quando relevante
- Mencione a marca como "${brand || "marca"}" e o período "${period || "atual"}"
Limite: 4-6 parágrafos curtos.`;

  const userPrompt = question
    ? `Pergunta específica: ${question}\n\nDados:\n${dataStr}`
    : `Gere a conclusão analítica para os dados:\n${dataStr}`;

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    const json = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        error: json?.error?.message || `Anthropic API erro HTTP ${r.status}`,
      });
    }

    const conclusion = (json.content || [])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("\n\n")
      .trim();

    return res.status(200).json({
      success: true,
      conclusion,
      model,
      user: session.n, // pra log/auditoria
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Erro ao chamar Anthropic API",
    });
  }
}

// ----- Helpers -----

function readSession(req) {
  const secret = process.env.MD_SESSION_SECRET;
  if (!secret) return null;
  const header = req.headers.cookie || "";
  const parts = header.split(";").map(s => s.trim());
  let cookieValue = null;
  for (const p of parts) {
    if (p.startsWith(`${COOKIE_NAME}=`)) {
      cookieValue = p.slice(COOKIE_NAME.length + 1);
      break;
    }
  }
  if (!cookieValue || !cookieValue.includes(".")) return null;
  const [body, sig] = cookieValue.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function checkRate(ip) {
  const now = Date.now();
  const entry = rateBucket.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}
