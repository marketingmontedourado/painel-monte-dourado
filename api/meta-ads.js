// Vercel Serverless Function — Puxa dados de campanhas via Meta Marketing API
// Env vars necessárias:
//   META_ACCESS_TOKEN     → token do System User painelmd (nunca expira)
//   META_AD_ACCOUNT_ID    → ID da conta de anúncios (formato act_XXXXXXXXXXX OU só os dígitos)
//
// Query params (opcionais):
//   since=YYYY-MM-DD      → data inicial (default: 6 meses atrás)
//   until=YYYY-MM-DD      → data final (default: hoje)
//   level=campaign|adset|ad   → granularidade (default: campaign)
//
// Retorna JSON: { success, account, period, data: [...meses por campanha] }

const META_API_VERSION = "v22.0";
const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });

  const token = process.env.META_ACCESS_TOKEN;
  const rawAcc = process.env.META_AD_ACCOUNT_ID;

  if (!token) return res.status(500).json({ error: "META_ACCESS_TOKEN não configurado" });
  if (!rawAcc) return res.status(500).json({ error: "META_AD_ACCOUNT_ID não configurado" });

  // Normaliza ID: aceita "act_123..." ou só "123..."
  const accountId = rawAcc.startsWith("act_") ? rawAcc : `act_${rawAcc}`;

  // Período padrão: últimos 6 meses até hoje
  const today = new Date();
  const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const since = req.query.since || fmt(sixMonthsAgo);
  const until = req.query.until || fmt(today);
  const level = req.query.level || "campaign";

  try {
    // 1) Dados gerais da conta
    const accountInfo = await metaFetch(`${GRAPH_URL}/${accountId}`, {
      fields: "name,currency,timezone_name,account_status,business",
      access_token: token,
    });

    // 2) Insights mensais por campanha
    const insightsFields = [
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "spend",
      "impressions",
      "reach",
      "frequency",
      "clicks",
      "ctr",
      "cpc",
      "cpm",
      "actions",
      "action_values",
      "date_start",
      "date_stop",
    ].join(",");

    const insights = await metaFetchAllPages(`${GRAPH_URL}/${accountId}/insights`, {
      fields: insightsFields,
      level,
      time_increment: "monthly",
      time_range: JSON.stringify({ since, until }),
      access_token: token,
      limit: 500,
    });

    // 3) Lista de campanhas (para pegar status e objetivo)
    const campaigns = await metaFetchAllPages(`${GRAPH_URL}/${accountId}/campaigns`, {
      fields: "id,name,status,objective,start_time,stop_time",
      access_token: token,
      limit: 500,
    });

    const campaignMap = {};
    campaigns.forEach(c => { campaignMap[c.id] = c; });

    // 4) Processa insights — adiciona mês legível e extrai mensagens iniciadas
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

    // Cacheia no edge por 5 minutos (reduz chamadas e custo)
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    return res.status(200).json({
      success: true,
      account: {
        id: accountId,
        name: accountInfo.name,
        currency: accountInfo.currency,
        timezone: accountInfo.timezone_name,
        status: accountInfo.account_status,
      },
      period: { since, until },
      level,
      total_rows: data.length,
      data,
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
  let qs = new URLSearchParams(params).toString();
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
