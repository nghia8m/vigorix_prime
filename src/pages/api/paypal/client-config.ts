import type { APIRoute } from "astro";
import { readPayPalEnv, json } from "../../../lib/paypal-env";
import { readShipping } from "../../../lib/cart-config";
import site from "../../../data/site.json";

// Runs on the Worker; every other route in this project stays prerendered.
export const prerender = false;

/**
 * What the browser is allowed to know about our PayPal setup.
 *
 * client_id is public by design — it travels in the SDK URL either way.
 * PAYPAL_SECRET is deliberately NOT read here, so there is no code path in
 * which it could be serialised into a response.
 */
export const GET: APIRoute = async ({ locals }) => {
  const env = readPayPalEnv(locals);

  if (!env.clientId) {
    return json(
      { ok: false, error: "paypal_not_configured", message: "PAYPAL_CLIENT_ID is not set." },
      503
    );
  }

  const shipping = readShipping((site as Record<string, unknown>).shipping);

  return json({
    ok: true,
    mode: env.mode,
    client_id: env.clientId,
    currency: shipping.currency || "USD",
  });
};
