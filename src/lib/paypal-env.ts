/**
 * Reading PayPal configuration, wherever it happens to live.
 *
 * Local dev  : .env, surfaced by Vite as import.meta.env
 * Cloudflare : Worker bindings, surfaced as locals.runtime.env
 *
 * NOTHING here is ever sent to the browser except client_id and mode — see
 * src/pages/api/paypal/client-config.ts. The secret is read only by server code
 * that talks to PayPal directly.
 */

export type PayPalMode = "sandbox" | "live";

export interface PayPalEnv {
  mode: PayPalMode;
  clientId: string;
  secret: string;
  webhookId: string;
}

type RuntimeLocals = { runtime?: { env?: Record<string, unknown> } };

function readVar(locals: unknown, key: string): string {
  const fromRuntime = (locals as RuntimeLocals | undefined)?.runtime?.env?.[key];
  if (typeof fromRuntime === "string" && fromRuntime) return fromRuntime;

  const fromVite = (import.meta.env as Record<string, unknown>)[key];
  if (typeof fromVite === "string" && fromVite) return fromVite;

  // process is absent on the Worker, so this is guarded rather than assumed.
  const proc = typeof process !== "undefined" ? process : undefined;
  const fromProcess = proc?.env?.[key];
  if (typeof fromProcess === "string" && fromProcess) return fromProcess;

  return "";
}

export function readPayPalEnv(locals?: unknown): PayPalEnv {
  const mode = readVar(locals, "PAYPAL_MODE").toLowerCase() === "live" ? "live" : "sandbox";
  return {
    mode,
    clientId: readVar(locals, "PAYPAL_CLIENT_ID"),
    secret: readVar(locals, "PAYPAL_SECRET"),
    webhookId: readVar(locals, "PAYPAL_WEBHOOK_ID"),
  };
}

/** PayPal REST base for the configured mode. */
export const apiBase = (mode: PayPalMode) =>
  mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

/** Small helper so endpoints answer in one consistent shape. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
