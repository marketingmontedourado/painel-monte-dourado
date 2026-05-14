// Vercel Serverless Function — Lista ads ATIVOS com criativos (thumbnails, vídeos, links)
// Env vars: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
//
// Query params (opcionais):
//   limit=100             → quantos ads retornar (default: 100, max: 200)
//   include_paused=1      → também inclui ads PAUSED (não só ACTIVE)

const META_API_VERSION = "v22.0";
const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });

  const token = process.env.META_ACCESS_TOKEN;
  const rawAcc = process.env.META_AD_ACCOUNT_ID;
  if (!token) return res.status(500).json({ error: "META_ACCESS_TOKEN não configurado" });
  if (!rawAcc) return res.status(500).json({ error: "META_AD_ACCOUNT_ID não configurado" });

  const accountId = rawAcc.startsWith("act_") ? rawAcc : `act_${rawAcc}`;
  const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10), 1), 200);
  const includePaused = req.query.include_paused === "1";

  const statusFilter = includePaused
    ? `[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]`
    : `[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]`;

  try {
    // Único request grande com tudo via field expansion
    const fields = [
      "id",
      "name",
      "status",
      "effective_status",
      "created_time",
      "updated_time",
      "campaign_id",
      "adset_id",
      "creative{id,name,thumbnail_url,image_url,video_id,instagram_permalink_url,effective_object_story_id,object_story_spec,asset_feed_spec}",
      "insights.date_preset(last_30d){spend,impressions,reach,clicks,actions}",
    ].join(",");

    const ads = await metaFetchAllPages(`${GRAPH_URL}/${accountId}/ads`, {
      fields,
      filtering: statusFilter,
      limit,
      access_token: token,
    }, 5);

    // Processa cada ad pra extrair thumbnail e link público
    const processed = ads.map(ad => {
      const c = ad.creative || {};
      // Tenta achar a melhor URL de imagem disponível
      let thumbnail = c.thumbnail_url || c.image_url;
      // Se for video, usa thumbnail_url (já vem)
      // Se for asset feed (DPA / múltiplas imagens), pega a primeira
      if (!thumbnail && c.asset_feed_spec?.images?.length) {
        thumbnail = c.asset_feed_spec.images[0]?.url;
      }
      // object_story_spec → photo_data.url ou video_data.image_url
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

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
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
