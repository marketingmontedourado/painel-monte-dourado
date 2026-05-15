// Vercel Serverless Function — Logout: limpa o cookie de sessão
// v2
//
// Env vars: ALLOWED_ORIGIN, COOKIE_DOMAIN (opcional)

const COOKIE_NAME = "md_session";

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://painel-monte-dourado.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido" });

  const cookieOptions = [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Strict`,
    `Max-Age=0`,
  ];
  if (process.env.COOKIE_DOMAIN) cookieOptions.push(`Domain=${process.env.COOKIE_DOMAIN}`);
  res.setHeader("Set-Cookie", cookieOptions.join("; "));

  return res.status(200).json({ success: true });
}
