// Vercel Serverless Function — Gera conclusões via Claude API
// Env var necessária: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  const { data, period, brand, question } = req.body;
  if (!data) return res.status(400).json({ error: "Dados não fornecidos" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada" });

  const systemPrompt = `Você é o analista de marketing digital da Monte Dourado Incorporações, uma incorporadora de alto padrão no litoral do Ceará (Taíba).
Você recebe TODOS os dados históricos da marca organizados por mês (formato AAAA-MM).
Campos dos dados: seg=seguidores, alc=alcance, views=visualizações, inter=interações, vis=visitas ao perfil, inv=investimento total, invMeta=Meta Ads, invGoogle=Google Ads, invSeg=campanha de seguidores, msgs=mensagens recebidas, posts/reels/stories=conteúdo publicado, org=alcance orgânico, pago=alcance pago.
O período selecionado pelo usuário é informado, mas você tem acesso a todos os meses para fazer comparações.
Gere uma conclusão executiva em português do Brasil. Seja direto, use números reais, destaque tendências e dê recomendações práticas.
Máximo 4 parágrafos curtos. Não use markdown, apenas texto corrido.
Empreendimentos: Monte Dourado (marca principal), Vila do Chapéu (vendido, consolidação do bairro), Vila do Morro (sustentação, ADS ativas), Vila da Ilha (marca em criação).`;

  const userMsg = question 
    ? `Dados completos de ${brand} (todos os meses disponíveis):\n${JSON.stringify(data, null, 2)}\n\nPeríodo selecionado no painel: ${period}\n\nPergunta do usuário: ${question}`
    : `Gere uma conclusão analítica para ${brand}. Período selecionado: ${period}.\nDados completos (todos os meses):\n${JSON.stringify(data, null, 2)}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Erro na API: ${err}` });
    }

    const result = await response.json();
    const text = result.content?.map(b => b.text).join("") || "";
    return res.status(200).json({ conclusion: text });
  } catch (err) {
    return res.status(500).json({ error: `Erro interno: ${err.message}` });
  }
}
