// GET /api/polar/entitlements: the signed-in user's plan as JSON. `?sync=1`
// reads through to Polar, which the page does right after a checkout.
import { currentUserId, polar } from "../../_polar";

export const GET = polar.entitlements({ customer: currentUserId });
