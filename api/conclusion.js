// Vercel Serverless Function — Gera conclusões via Claude API
// Env var necessária: ANTHROPIC_API_KEY

export default async function handler(req, res) {
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
Analise os dados fornecidos e gere uma conclusão executiva em português do Brasil.
Seja direto, use números reais dos dados, destaque tendências (crescimento/queda), e dê recomendações práticas quando pertinente.
Máximo 4 parágrafos curtos. Não use markdown, apenas texto corrido.
Empreendimentos:
- Monte Dourado: marca principal da incorporadora
- Vila do Chapéu: empreendimento vendido, fase de consolidação do bairro
- Vila do Morro: lançamento recente, fase de sustentação, campanhas ADS ativas
- Vila da Ilha: marca em criação, sem dados ainda`;

  const userMsg = question 
    ? `Dados do período ${period} para ${brand}:\n${JSON.stringify(data, null, 2)}\n\nPergunta do usuário: ${question}`
    : `Gere uma conclusão analítica para ${brand} no período ${period}:\n${JSON.stringify(data, null, 2)}`;

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
        max_tokens: 600,
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
