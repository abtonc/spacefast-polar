// GET /api/polar/portal: opens Polar's customer portal for the signed-in user.
import { currentUserId, polar } from "../../_polar";

export const GET = polar.portal({ customer: currentUserId, returnUrl: "/" });
