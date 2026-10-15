// GET /api/session: who is signed in. POST signs in (demo), DELETE signs out.
import { clearedSessionCookie, readSession, sessionCookie } from "../_session";

type Context = { env: Record<string, unknown> };

export async function GET(request: Request, { env }: Context) {
  return Response.json(await readSession(request, env), { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request, { env }: Context) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(name)) return new Response("Pick a name of 2-32 letters, digits, - or _", { status: 400 });
  // Prefixed so demo ids never collide with real ones in the same Polar org.
  const cookie = await sessionCookie(`demo:${name}`, env);
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie } });
}

export async function DELETE() {
  return new Response(null, { status: 204, headers: { "set-cookie": clearedSessionCookie } });
}
