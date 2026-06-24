// Vercel Serverless Function — Lista ads ATIVOS com criativos (thumbnails, vídeos, links)
// v2 — fechado (CORS + auth + rate limit + multi-account)
//
// Env vars: META_ACCESS_TOKEN, META_AD_ACCOUNT_IDS (ou META_AD_ACCOUNT_ID), MD_API_KEY, ALLOWED_ORIGIN
//
// Query params (opcionais):
//   limit=100             → quantos ads retornar por conta (default: 100, max: 200)
//   include_paused=1      → também inclui ads PAUSED (não só ACTIVE)

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

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
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

  // --- Rate limit ---
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString().split(",")[0].trim();
  if (!checkRate(ip)) return res.status(429).json({ error: "Muitas requisições — tente em 1 min" });

  const token = process.env.META_ACCESS_TOKEN;
  const accountIds = parseAccountIds(process.env.META_AD_ACCOUNT_IDS || process.env.META_AD_ACCOUNT_ID);
  if (!token) return res.status(500).json({ error: "META_ACCESS_TOKEN não configurado" });
  if (!accountIds.length) return res.status(500).json({ error: "META_AD_ACCOUNT_IDS não configurado" });

  const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10), 1), 200);
  const includePaused = req.query.include_paused === "1";

  const statusFilter = includePaused
    ? `[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]`
    : `[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]`;

  try {
    // Roda todas as contas em paralelo
    const perAccount = await Promise.all(accountIds.map(async (accountId) => {
      const fields = [
        "id", "name", "status", "effective_status",
        "created_time", "updated_time", "campaign_id", "adset_id",
        "creative{id,name,thumbnail_url,image_url,video_id,instagram_permalink_url,effective_object_story_id,object_story_spec,asset_feed_spec}",
        "insights.date_preset(last_30d){spend,impressions,reach,clicks,actions}",
      ].join(",");

      const ads = await metaFetchAllPages(`${GRAPH_URL}/${accountId}/ads`, {
        fields,
        filtering: statusFilter,
        limit,
        access_token: token,
      }, 5);

      return ads.map(ad => {
        const c = ad.creative || {};
        let thumbnail = c.thumbnail_url || c.image_url;
        if (!thumbnail && c.asset_feed_spec?.images?.length) {
          thumbnail = c.asset_feed_spec.images[0]?.url;
        }
        if (!thumbnail && c.object_story_spec) {
          const oss = c.object_story_spec;
          thumbnail = oss.photo_data?.url || oss.video_data?.image_url || oss.link_data?.picture;
        }

        const insights = ad.insights?.data?.[0] || {};
        const actions = insights.actions || [];
        const msgsAction = actions.find(a => a.action_type === "onsite_conversion.messaging_conversation_started_7d");
        const leadsAction = actions.find(a => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped");

        return {
          id: ad.id,
          name: ad.name,
          status: ad.status,
          effective_status: ad.effective_status,
          created_time: ad.created_time,
          updated_time: ad.updated_time,
          account_id: accountId,
          campaign_id: ad.campaign_id,
          adset_id: ad.adset_id,
          creative: {
            id: c.id,
            name: c.name,
            thumbnail_url: thumbnail,
            video_id: c.video_id,
            instagram_permalink_url: c.instagram_permalink_url,
            effective_object_story_id: c.effective_object_story_id,
          },
          insights_30d: {
            spend: parseFloat(insights.spend || 0),
            impressions: parseInt(insights.impressions || 0, 10),
            reach: parseInt(insights.reach || 0, 10),
            clicks: parseInt(insights.clicks || 0, 10),
            messages: msgsAction ? parseInt(msgsAction.value || 0, 10) : 0,
            leads: leadsAction ? parseInt(leadsAction.value || 0, 10) : 0,
          },
        };
      });
    }));

    const processed = perAccount.flat();

    res.setHeader("Cache-Control", "private, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({
      success: true,
      total: processed.length,
      ads: processed,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Erro ao consultar Meta API",
      details: err.details || null,
    });
  }
}

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

async function metaFetchAllPages(url, params, maxPages = 5) {
  const out = [];
  let next = null;
  const qs = new URLSearchParams(params).toString();
  let page = 0;
  while (page < maxPages) {
    const fullUrl = next || `${url}?${qs}`;
    const r = await fetch(fullUrl);
    const json = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
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
