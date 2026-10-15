// DEMO ONLY: a signed cookie holding whatever name the visitor typed. It shows
// where your real auth plugs in; it does not prove who anyone is. Replace
// readSession with your own session or token check before taking payments.

type Env = Record<string, unknown>;
export type Session = { userId: string };

const COOKIE = "demo_session";
const encoder = new TextEncoder();

async function sign(value: string, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 16) throw new Error("Set SESSION_SECRET (16+ characters)");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return btoa(String.fromCharCode(...signature)).replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
}

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  if (!cookie) return null;
  const [userId, signature] = decodeURIComponent(cookie.slice(COOKIE.length + 1)).split(".");
  if (!userId || !signature || signature !== (await sign(userId, env))) return null;
  return { userId };
}

export async function sessionCookie(userId: string, env: Env): Promise<string> {
  const value = encodeURIComponent(`${userId}.${await sign(userId, env)}`);
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

export const clearedSessionCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
