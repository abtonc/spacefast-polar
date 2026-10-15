// GET /api/polar/checkout: creates a Polar checkout for the Pro product and redirects to it.
import { currentUserId, polar, proProductId } from "../../_polar";

export const GET = polar.checkout({
  successUrl: "/?checkout=success",
  returnUrl: "/",
  customer: async (request, env) => {
    const userId = await currentUserId(request, env);
    return userId ? { externalId: userId } : null;
  },
  requireCustomer: true,
  // Decided on the server, so the URL cannot pick a different product.
  prepare: (_request, env) => ({ products: [proProductId(env)] }),
});
