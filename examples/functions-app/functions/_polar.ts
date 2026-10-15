// A colocated helper: the leading underscore keeps it out of the route table.
import { createPolar } from "spacefast-polar/functions";
import { readSession } from "./_session";

export const polar = createPolar();

type Env = Record<string, unknown>;

/** The signed-in user's id. It becomes Polar's `external_customer_id`. */
export async function currentUserId(request: Request, env: Env): Promise<string | null> {
  return (await readSession(request, env))?.userId ?? null;
}

/** The product sold here, set with `sf env set POLAR_PRO_PRODUCT_ID <id> --no-secret`. */
export function proProductId(env: Env): string {
  const id = env.POLAR_PRO_PRODUCT_ID;
  if (typeof id !== "string" || !id) throw new Error("Set POLAR_PRO_PRODUCT_ID");
  return id;
}
