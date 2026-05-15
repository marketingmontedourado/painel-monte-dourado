// Vercel Serverless Function — Tracking de eventos do painel
// v2 — fechado (sessão obrigatória; GET só pra admin)
//
// Env vars:
//   MD_SESSION_SECRET    → mesmo segredo do api-auth-v2
//   ALLOWED_ORIGIN       → origem permitida no CORS
//   TRACK_STORE_URL      → (opcional) URL externa pra persistir (ex: Supabase REST)
//                           Se ausente, mantém em memória (perde no cold start)
//   TRACK_STORE_KEY      → (opcional) chave de auth pro store externo
//
// Endpoints:
//   POST  → corpo { event, tab, brand, period, ... } → grava evento (usa nome/role da sessão)
//   GET   → admin only → retorna { success, data: [...eventos] }

import crypto from "crypto";

const COOKIE_NAME = "md_session";
const MAX_EVENTS_IN_MEMORY = 500;
const events = []; // ring buffer em memória (fallback se TRACK_STORE_URL ausente)

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://painel-monte-dourado.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Toda chamada exige sessão
  const session = readSession(req);
  if (!session) return res.status(401).json({ success: false, error: "Não autorizado" });

  if (req.method === "POST") return handlePost(req, res, session);
  if (req.method === "GET") return handleGet(req, res, session);
  return res.status(405).json({ success: false, error: "Método não permitido" });
}

async function handlePost(req, res, session) {
  const body = req.body || {};
  const ev = {
    name: session.n,         // sempre da sessão, NUNCA do body (anti-spoofing)
    role: session.r,
    event: String(body.event || "unknown").slice(0, 64),
    tab: body.tab ? String(body.tab).slice(0, 64) : null,
    brand: body.brand ? String(body.brand).slice(0, 64) : null,
    period: body.period ? String(body.period).slice(0, 32) : null,
    ip_partial: maskIp(getIp(req)),
    ts: new Date().toISOString(),
  };

  // Persiste em store externo se configurado
  const storeUrl = process.env.TRACK_STORE_URL;
  const storeKey = process.env.TRACK_STORE_KEY;
  if (storeUrl) {
    try {
      await fetch(storeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(storeKey ? { "Authorization": `Bearer ${storeKey}` } : {}),
        },
        body: JSON.stringify(ev),
      });
    } catch {
      // não bloqueia o request — só loga
      pushInMemory(ev);
    }
  } else {
    pushInMemory(ev);
  }

  return res.status(200).json({ success: true });
}

async function handleGet(req, res, session) {
  // GET é restrito a admin (antes retornava dados pra qualquer um)
  if (session.r !== "admin") {
    return res.status(403).json({ success: false, error: "Apenas administradores" });
  }
  const limit = Math.min(parseInt(req.query.limit || "200", 10), MAX_EVENTS_IN_MEMORY);
  const data = events.slice(-limit).reverse();
  return res.status(200).json({ success: true, count: data.length, data });
}

// ----- Helpers -----

function pushInMemory(ev) {
  events.push(ev);
  if (events.length > MAX_EVENTS_IN_MEMORY) events.shift();
}

function maskIp(ip) {
  if (!ip) return "unknown";
  // mascara último octeto pra privacidade (LGPD): 200.123.45.67 → 200.123.45.x
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".") + ".x";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + ":x";
  return ip.slice(0, 12) + "…";
}

function getIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .toString().split(",")[0].trim();
}

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
