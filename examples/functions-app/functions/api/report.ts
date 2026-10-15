// GET /api/report: a Pro-only API route, gated on the stored entitlements.
import { hasActiveSubscription } from "spacefast-polar";
import { currentUserId, polar, proProductId } from "../_polar";

export async function GET(request: Request, { env }: { env: Record<string, unknown> }) {
  const userId = await currentUserId(request, env);
  if (!userId) return new Response("Sign in first", { status: 401 });

  // Read from env.DB; Polar is asked only when nothing is stored yet.
  const entitlements = await polar.getEntitlements(env, userId);
  if (!hasActiveSubscription(entitlements, proProductId(env))) {
    return new Response("Upgrade to Pro to see the report", { status: 403 });
  }
  return Response.json({ generatedAt: new Date().toISOString(), rows: [{ metric: "signups", value: 42 }] });
}
