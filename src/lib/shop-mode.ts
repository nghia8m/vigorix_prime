/**
 * Is the shop live for real, or standing up for a test run?
 *
 * Read at BUILD time, not per request: /shop and every product page are
 * prerendered, so there is no request context to ask. Cloudflare Pages exposes
 * the project's environment variables to the build, which is enough — deploy
 * with sandbox keys and the pages are built in test mode; set live keys and
 * redeploy and they are not. Nothing to remember, nothing to switch off by
 * hand.
 *
 * Two independent reasons a shop is not really open, and either one is enough:
 *
 *   ALLOW_DRAFT_PRODUCTS=1  the products on display are samples — borrowed
 *                           photographs, placeholder prices, specifications
 *                           still reading TODO.
 *   PAYPAL_MODE != live     no real payment can complete. A shopper with a real
 *                           PayPal account cannot pay a sandbox application at
 *                           all; they would reach the button and fail.
 *
 * Saying so on the page is not decoration. A shop that looks open and cannot
 * take money spends the visitor's time and its own credibility, and product
 * pages carrying sample data have no business in a search index.
 */

const env = (key: string): string => {
  const fromVite = (import.meta.env as Record<string, unknown>)[key];
  if (typeof fromVite === "string" && fromVite) return fromVite;
  const proc = typeof process !== "undefined" ? process : undefined;
  return proc?.env?.[key] ?? "";
};

/** Sample products are being rendered rather than blocked. */
export const showingSampleData = (): boolean =>
  env("ALLOW_DRAFT_PRODUCTS") === "1" || import.meta.env.DEV;

/** Payments cannot actually complete. */
export const paymentsAreTest = (): boolean => env("PAYPAL_MODE").toLowerCase() !== "live";

/** Either reason. When true the shop is demonstrable, not open. */
export const shopIsTesting = (): boolean => showingSampleData() || paymentsAreTest();

/**
 * What to tell a visitor, in their words rather than ours. Empty when the shop
 * is genuinely open.
 */
export function testNotice(): string {
  const samples = showingSampleData();
  const payments = paymentsAreTest();
  if (!samples && !payments) return "";

  if (samples && payments) {
    return "This shop is being tested. The products below are samples — the photographs and details are placeholders — and payment is not switched on, so no order placed here is real.";
  }
  if (samples) {
    return "The products below are samples. Photographs and details are placeholders while the real range is prepared.";
  }
  return "Payment is not switched on yet, so no order placed here is real. Nothing will be charged and nothing will be sent.";
}
