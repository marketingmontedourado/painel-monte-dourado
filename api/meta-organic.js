// Vercel Serverless Function — Puxa dados ORGÂNICOS do Instagram via Graph API
// Versão 4 — corrige erro #100 movendo profile_views pra metric_type=total_value
//
// Env vars necessárias: META_ACCESS_TOKEN
//
// Query params (opcionais):
//   ig_user_id=...        → filtra por uma conta específica do IG
//   days=28               → janela de insights (default: 28, max: 90)
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
  const days = Math.min(Math.max(parseInt(req.query.days || "28", 10), 1), 90);
  const includeMedia = req.query.include_media === "1";

  try {
    // 1) Lista Páginas do Facebook acessíveis pelo token
    const pages = await metaFetch(`${GRAPH_URL}/me/accounts`, {
      fields: "id,name,instagram_business_account",
      access_token: token,
      limit: 50,
    });

    const pageList = (pages.data || []).filter(p => p.instagram_business_account?.id && (!filterIg || p.instagram_business_account.id === filterIg));

    // 2) Para cada IG conta, busca em PARALELO: info básica + insights
    const accounts = await Promise.all(pageList.map(async (page) => {
      const igId = page.instagram_business_account.id;
      const since = Math.floor((Date.now() - days * 86400 * 1000) / 1000);
      const until = Math.floor(Date.now() / 1000);

      // Paralelo: info + 2 chamadas de insights (separadas pelo tipo de métrica que a Meta exige)
      const [infoRes, dailyRes, totalRes] = await Promise.allSettled([
        metaFetch(`${GRAPH_URL}/${igId}`, {
          fields: "id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website",
          access_token: token,
        }),
        // Métricas com period=day SEM metric_type (retornam série temporal direto)
        // Importante: profile_views NÃO entra aqui (Meta v22 exige total_value pra ela)
        metaFetch(`${GRAPH_URL}/${igId}/insights`, {
          metric: "reach,follower_count",
          period: "day",
          since,
          until,
          access_token: token,
        }),
        // Métricas com metric_type=total_value (retornam valor agregado do período)
        // profile_views entra aqui agora
        metaFetch(`${GRAPH_URL}/${igId}/insights`, {
          metric: "views,accounts_engaged,total_interactions,profile_views",
          metric_type: "total_value",
          period: "day",
          since,
          until,
          access_token: token,
        }),
      ]);

      const info = infoRes.status === "fulfilled" ? infoRes.value : {};
      const summary = {};
      const series = {};
      const errors = {};

      if (dailyRes.status === "fulfilled") {
        (dailyRes.value.data || []).forEach(m => {
          const vals = m.values || [];
          series[m.name] = vals.map(v => ({ date: v.end_time?.slice(0, 10), value: parseInt(v.value, 10) || 0 }));
          summary[m.name] = vals.reduce((s, v) => s + (parseInt(v.value, 10) || 0), 0);
        });
      } else {
        errors.daily = dailyRes.reason?.message;
      }

      if (totalRes.status === "fulfilled") {
        (totalRes.value.data || []).forEach(m => {
          const v = m.total_value?.value;
          if (v != null) summary[m.name] = parseInt(v, 10) || 0;
        });
      } else {
        errors.total_value = totalRes.reason?.message;
      }

      const account = {
        ig_user_id: info.id || igId,
        username: info.username,
        name: info.name,
        profile_picture_url: info.profile_picture_url,
        followers_count: info.followers_count,
        follows_count: info.follows_count,
        media_count: info.media_count,
        biography: info.biography,
        website: info.website,
        page: { id: page.id, name: page.name },
        period_days: days,
        insights_summary: summary,
        insights_series: series,
        insights_errors: Object.keys(errors).length ? errors : undefined,
      };

      // 3) Opcional: mídia recente
      if (includeMedia) {
        try {
          const m = await metaFetch(`${GRAPH_URL}/${igId}/media`, {
            fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp,like_count,comments_count",
            access_token: token,
            limit: 20,
          });
          account.media = m.data || [];
        } catch (e) {
          account.media_error = e.message;
        }
      }

      return account;
    }));

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

async function metaFetch(url, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${url}?${qs}`);
  const json = await r.json().catch(() => ({ error: { message: `Resposta não é JSON (HTTP ${r.status})` } }));
  if (!r.ok || json.error) {
    const e = new Error(json.error?.message || `HTTP ${r.status}`);
    e.details = json.error || null;
    throw e;
  }
  return json;
}
