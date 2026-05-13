// Vercel Serverless Function — Puxa dados ORGÂNICOS do Instagram via Graph API
// Env vars necessárias:
//   META_ACCESS_TOKEN     → mesmo token do System User painelmd
//
// Como funciona:
//   1. Lista as Páginas do Facebook que o System User tem acesso
//   2. Para cada Página, descobre o Instagram Business Account vinculado
//   3. Para cada IG account, puxa seguidores, métricas e mídia recente
//
// Query params (opcionais):
//   ig_user_id=...        → filtra por uma conta específica do IG
//   days=28               → janela de insights (default: 28; máx prático com period=days_28: 28)
//   include_media=1       → também retorna mídia recente com insights individuais
//
// Retorna JSON: { success, accounts: [...com seguidores, insights, media opcional] }

const META_API_VERSION = "v22.0";
const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: "META_ACCESS_TOKEN não configurado" });

  const filterIg = req.query.ig_user_id || null;
  const days = Math.min(parseInt(req.query.days || "28", 10), 90);
  const includeMedia = req.query.include_media === "1";

  try {
    // 1) Lista Páginas do Facebook acessíveis pelo token
    const pages = await metaFetchAllPages(`${GRAPH_URL}/me/accounts`, {
      fields: "id,name,instagram_business_account",
      access_token: token,
      limit: 100,
    });

    const accounts = [];

    for (const page of pages) {
      const igRef = page.instagram_business_account;
      if (!igRef?.id) continue;
      if (filterIg && igRef.id !== filterIg) continue;

      // 2) Dados básicos da conta IG
      const igInfo = await metaFetch(`${GRAPH_URL}/${igRef.id}`, {
        fields: "id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website",
        access_token: token,
      });

      const since = Math.floor((Date.now() - days * 86400 * 1000) / 1000);
      const until = Math.floor(Date.now() / 1000);

      // 3) Insights agregados — Meta v22 deprecou `impressions`, agora é `views`.
      //    Métricas válidas com period=day: reach, profile_views, follower_count, website_clicks
      //    Métricas com period=days_28: reach (com total_value)
      //    Métricas com metric_type=total_value: views, reach, total_interactions, accounts_engaged
      const summaryByMetric = {};
      const seriesByMetric = {};
      const insightErrors = {};

      // 3a) Métricas que aceitam period=day e retornam série temporal
      const dailyMetrics = ["reach", "profile_views", "follower_count", "website_clicks"];
      for (const m of dailyMetrics) {
        try {
          const r = await metaFetch(`${GRAPH_URL}/${igRef.id}/insights`, {
            metric: m,
            period: "day",
            since,
            until,
            access_token: token,
          });
          const arr = r.data?.[0]?.values || [];
          seriesByMetric[m] = arr.map(v => ({
            date: v.end_time?.slice(0, 10),
            value: parseInt(v.value, 10) || 0,
          }));
          summaryByMetric[m] = arr.reduce((s, v) => s + (parseInt(v.value, 10) || 0), 0);
        } catch (e) {
          insightErrors[m] = e.message;
        }
      }

      // 3b) Métricas com metric_type=total_value (views agregadas, etc.)
      const totalValueMetrics = ["views", "total_interactions", "accounts_engaged", "likes", "comments", "shares", "saves", "replies"];
      for (const m of totalValueMetrics) {
        try {
          const r = await metaFetch(`${GRAPH_URL}/${igRef.id}/insights`, {
            metric: m,
            metric_type: "total_value",
            period: "day",
            since,
            until,
            access_token: token,
          });
          const v = r.data?.[0]?.total_value?.value;
          if (v != null) summaryByMetric[m] = parseInt(v, 10) || 0;
        } catch (e) {
          insightErrors[m] = e.message;
        }
      }

      const account = {
        ig_user_id: igInfo.id,
        username: igInfo.username,
        name: igInfo.name,
        profile_picture_url: igInfo.profile_picture_url,
        followers_count: igInfo.followers_count,
        follows_count: igInfo.follows_count,
        media_count: igInfo.media_count,
        biography: igInfo.biography,
        website: igInfo.website,
        page: { id: page.id, name: page.name },
        period_days: days,
        insights_summary: summaryByMetric,
        insights_series: seriesByMetric,
        insights_errors: Object.keys(insightErrors).length ? insightErrors : undefined,
      };

      // 4) Mídia recente com insights individuais (opcional)
      if (includeMedia) {
        try {
          const mediaItems = await metaFetchAllPages(`${GRAPH_URL}/${igRef.id}/media`, {
            fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp,like_count,comments_count",
            access_token: token,
            limit: 50,
          }, 3);

          const enriched = [];
          for (const m of mediaItems) {
            const mediaMetrics = mediaMetricsByType(m.media_type, m.media_product_type);
            if (!mediaMetrics) {
              enriched.push(m);
              continue;
            }
            try {
              const mins = await metaFetch(`${GRAPH_URL}/${m.id}/insights`, {
                metric: mediaMetrics.join(","),
                access_token: token,
              });
              const map = {};
              (mins.data || []).forEach(x => { map[x.name] = x.values?.[0]?.value || 0; });
              enriched.push({ ...m, insights: map });
            } catch (e) {
              enriched.push({ ...m, insights_error: e.message });
            }
          }
          account.media = enriched;
        } catch (e) {
          account.media_error = e.message;
        }
      }

      accounts.push(account);
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ success: true, count: accounts.length, accounts });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Erro ao consultar Meta API",
      details: err.details || null,
    });
  }
}

// ----- Helpers -----

function mediaMetricsByType(mediaType, productType) {
  // Meta v22 — algumas métricas foram deprecadas e substituídas por `views`
  if (productType === "REELS") {
    return ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"];
  }
  if (mediaType === "VIDEO") {
    return ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"];
  }
  if (mediaType === "CAROUSEL_ALBUM") {
    return ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"];
  }
  if (mediaType === "IMAGE") {
    return ["reach", "views", "likes", "comments", "shares", "saved", "total
