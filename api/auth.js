// Vercel Serverless Function — Autenticação por PIN com cookie HttpOnly
// v2 — substitui token-em-localStorage por cookie HttpOnly Secure SameSite=Strict
//
// Env vars:
//   MD_PINS              → JSON com mapeamento PIN → user, ex:
//                          '{"1234":{"name":"Vitória Rocha","role":"admin"},"5678":{"name":"Sócio Diretor","role":"socio"}}'
//   MD_SESSION_SECRET    → segredo (32+ caracteres) usado pra HMAC do cookie
//   ALLOWED_ORIGIN       → origem permitida (ex: "https://painel-monte-dourado.vercel.app")
//   COOKIE_DOMAIN        → (opcional) domínio do cookie. Se vazio, usa host atual
//   SESSION_TTL_HOURS    → (opcional) tempo de vida do cookie em horas. Default: 12
//
// Endpoints:
//   POST /api/auth        — corpo { pin } → valida e seta cookie. Retorna { success, name, role }
//   GET  /api/auth        — lê cookie e retorna { success, name, role } ou 401

import crypto from "crypto";

const COOKIE_NAME = "md_session";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_TRIES = 8; // 8 tentativas/min por IP
const rateBucket = new Map();

export default async function handler(req, res) {
  // CORS travado
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://painel-monte-dourado.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret = process.env.MD_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    return res.status(500).json({ success: false, error: "MD_SESSION_SECRET não configurada (>=16 chars)" });
  }

  if (req.method === "GET") return handleCheck(req, res, secret);
  if (req.method === "POST") return handleLogin(req, res, secret);
  return res.status(405).json({ success: false, error: "Método não permitido" });
}

// ----- Login (POST) -----
async function handleLogin(req, res, secret) {
  const ip = getIp(req);
  if (!checkRate(ip)) {
    return res.status(429).json({ success: false, error: "Muitas tentativas — aguarde 1 min" });
  }

  const { pin } = req.body || {};
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ success: false, error: "PIN obrigatório" });
  }

  const users = parsePins(process.env.MD_PINS);
  if (!users) {
    return res.status(500).json({ success: false, error: "MD_PINS não configurado" });
  }

  // Comparação em tempo constante (evita timing attack)
  let match = null;
  for (const [validPin, user] of Object.entries(users)) {
    if (timingSafeEq(pin, validPin)) {
      match = user;
      // não dá break — completa o loop pra manter timing
    }
  }

  if (!match) {
    return res.status(401).json({ success: false, error: "PIN inválido" });
  }

  // Cria sessão e cookie
  const ttlHours = parseInt(process.env.SESSION_TTL_HOURS || "12", 10);
  const ttlMs = ttlHours * 3600 * 1000;
  const payload = {
    n: match.name,
    r: match.role,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const cookieValue = signPayload(payload, secret);

  const cookieOptions = [
    `${COOKIE_NAME}=${cookieValue}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Strict`,
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (process.env.COOKIE_DOMAIN) cookieOptions.push(`Domain=${process.env.COOKIE_DOMAIN}`);
  res.setHeader("Set-Cookie", cookieOptions.join("; "));

  return res.status(200).json({
    success: true,
    name: match.name,
    role: match.role,
  });
}

// ----- Check (GET) -----
async function handleCheck(req, res, secret) {
  const cookieValue = readCookie(req, COOKIE_NAME);
  if (!cookieValue) return res.status(401).json({ success: false, error: "Sem sessão" });

  const payload = verifyPayload(cookieValue, secret);
  if (!payload) return res.status(401).json({ success: false, error: "Sessão inválida" });
  if (payload.exp && payload.exp < Date.now()) return res.status(401).json({ success: false, error: "Sessão expirada" });

  return res.status(200).json({
    success: true,
    name: payload.n,
    role: payload.r,
  });
}

// ----- Helpers -----

function parsePins(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || !obj) return null;
    return obj;
  } catch {
    return null;
  }
}

function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyPayload(cookieValue, secret) {
  if (typeof cookieValue !== "string" || !cookieValue.includes(".")) return null;
  const [body, sig] = cookieValue.split(".");
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!timingSafeEq(sig, expectedSig)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  }
  return null;
}

function getIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .toString().split(",")[0].trim();
}

function checkRate(ip) {
  const now = Date.now();
  const entry = rateBucket.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX_TRIES;
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // ainda gasta tempo proporcional
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}
