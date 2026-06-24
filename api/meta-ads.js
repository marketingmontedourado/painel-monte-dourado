// Vercel Serverless Function — Puxa dados de campanhas via Meta Marketing API
// v3 — fechado (CORS + auth + rate limit + multi-account)
//
// Env vars necessárias:
//   META_ACCESS_TOKEN     → token do System User painelmd (nunca expira)
//   META_AD_ACCOUNT_IDS   → lista separada por vírgula (ex: "act_1234,act_5678")
//                           ou usar META_AD_ACCOUNT_ID (legado, conta única)
//   MD_API_KEY            → chave compartilhada que o front envia no header x-md-key
//   ALLOWED_ORIGIN        → origem permitida no CORS (ex: "https://painel-monte-dourado.vercel.app")
//                           use "*" só em dev, NUNCA em produção
//
// Query params (opcionais):
//   since=YYYY-MM-DD      → data inicial (default: 6 meses atrás)
//   until=YYYY-MM-DD      → data final (default: hoje)
//   level=campaign|adset|ad   → granularidade (default: campaign)

import crypto from "crypto";

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

const META_API_VERSION = "v22.0";
const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// Rate limit em memória (reseta a cada cold start — bom o suficiente pra um painel interno)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60; // 60 req/min por IP
const rateBucket = new Map();

export default async function handler(req, res) {
  // --- CORS fechado ---
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://painel-monte-dourado.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-md-key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });

  // --- Auth (sessão por cookie HttpOnly; antes era x-md-key exposto no bundle Vite) ---
  if (!readSession(req)) return res.status(401).json({ error: "Não autorizado" });

  // --- Rate limit por IP ---
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString().split(",")[0].trim();
  if (!checkRate(ip)) return res.status(429).json({ error: "Muitas requisições — tente em 1 min" });

  // --- Env Meta ---
  const token = process.env.META_ACCESS_TOKEN;
  const accountIds = parseAccountIds(process.env.META_AD_ACCOUNT_IDS || process.env.META_AD_ACCOUNT_ID);
  if (!token) return res.status(500).json({ error: "META_ACCESS_TOKEN não configurado" });
  if (!accountIds.length) return res.status(500).json({ error: "META_AD_ACCOUNT_IDS não configurado" });

  // --- Período ---
  const today = new Date();
  const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const since = req.query.since || fmt(sixMonthsAgo);
  const until = req.query.until || fmt(today);
  const level = req.query.level || "campaign";

  try {
    // Processa todas as contas em paralelo
    const perAccount = await Promise.all(accountIds.map(async (accountId) => {
      const accountInfo = await metaFetch(`${GRAPH_URL}/${accountId}`, {
        fields: "name,currency,timezone_name,account_status,business",
        access_token: token,
      });

      const insightsFields = [
        "campaign_id", "campaign_name", "adset_id", "adset_name",
        "spend", "impressions", "reach", "frequency",
        "clicks", "ctr", "cpc", "cpm",
        "actions", "action_values", "date_start", "date_stop",
      ].join(",");

      const insights = await metaFetchAllPages(`${GRAPH_URL}/${accountId}/insights`, {
        fields: insightsFields,
        level,
        time_increment: "monthly",
        time_range: JSON.stringify({ since, until }),
        access_token: token,
        limit: 500,
      });

      const campaigns = await metaFetchAllPages(`${GRAPH_URL}/${accountId}/campaigns`, {
        fields: "id,name,status,objective,start_time,stop_time",
        access_token: token,
        limit: 500,
      });

      const campaignMap = {};
      campaigns.forEach(c => { campaignMap[c.id] = c; });

      const data = insights.map(row => {
        const monthKey = row.date_start ? row.date_start.slice(0, 7) : "?";
        const msgs = extractAction(row.actions, [
          "onsite_conversion.messaging_conversation_started_7d",
          "onsite_conversion.total_messaging_connection",
        ]);
        const leads = extractAction(row.actions, ["lead", "onsite_conversion.lead_grouped"]);
        const camp = campaignMap[row.campaign_id] || {};

        return {
          month: monthKey,
          account_id: accountId,
          campaign_id: row.campaign_id,
          campaign_name: row.campaign_name,
          campaign_status: camp.status,
          campaign_objective: camp.objective,
          adset_id: row.adset_id,
          adset_name: row.adset_name,
          spend: parseFloat(row.spend || 0),
          impressions: parseInt(row.impressions || 0, 10),
          reach: parseInt(row.reach || 0, 10),
          frequency: parseFloat(row.frequency || 0),
          clicks: parseInt(row.clicks || 0, 10),
          ctr: parseFloat(row.ctr || 0),
          cpc: parseFloat(row.cpc || 0),
          cpm: parseFloat(row.cpm || 0),
          messages: msgs,
          leads,
          date_start: row.date_start,
          date_stop: row.date_stop,
        };
      });

      return {
        account: {
          id: accountId,
          name: accountInfo.name,
          currency: accountInfo.currency,
          timezone: accountInfo.timezone_name,
          status: accountInfo.account_status,
        },
        data,
      };
    }));

    // Mescla dados de todas as contas
    const allData = perAccount.flatMap(p => p.data);
    const accounts = perAccount.map(p => p.account);

    // Cache reduzido (60s) enquanto o sistema novo tá em rodagem
    res.setHeader("Cache-Control", "private, s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      success: true,
      accounts,
      period: { since, until },
      level,
      total_rows: allData.length,
      data: allData,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Erro ao consultar Meta API",
      details: err.details || null,
    });
  }
}

// ----- Helpers -----

function parseAccountIds(raw) {
  if (!raw) return [];
  return raw.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(id => id.startsWith("act_") ? id : `act_${id}`);
}

function checkRate(ip) {
  const now = Date.now();
  const entry = rateBucket.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

async function metaFetch(url, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${url}?${qs}`);
  const json = await r.json();
  if (!r.ok || json.error) {
    const e = new Error(json.error?.message || `HTTP ${r.status}`);
    e.details = json.error || null;
    throw e;
  }
  return json;
}

async function metaFetchAllPages(url, params, maxPages = 20) {
  const out = [];
  let next = null;
  const qs = new URLSearchParams(params).toString();
  let page = 0;
  while (page < maxPages) {
    const fullUrl = next || `${url}?${qs}`;
    const r = await fetch(fullUrl);
    const json = await r.json();
    if (!r.ok || json.error) {
      const e = new Error(json.error?.message || `HTTP ${r.status}`);
      e.details = json.error || null;
      throw e;
    }
    if (Array.isArray(json.data)) out.push(...json.data);
    next = json.paging?.next || null;
    if (!next) break;
    page++;
  }
  return out;
}

function extractAction(actions, types) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter(a => types.includes(a.action_type))
    .reduce((sum, a) => sum + parseInt(a.value || 0, 10), 0);
}
