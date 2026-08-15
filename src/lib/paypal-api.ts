/**
 * Thin PayPal REST client. Server-only: this file reads PAYPAL_SECRET and must
 * never be imported by anything that ships to the browser.
 */
import { apiBase, type PayPalEnv } from "./paypal-env";

export interface PayPalError {
  ok: false;
  status: number;
  body: unknown;
}
export type PayPalOk<T> = { ok: true; body: T };
export type PayPalResult<T> = PayPalOk<T> | PayPalError;

/** OAuth2 client-credentials token. Not cached: Workers are short-lived. */
export async function getAccessToken(env: PayPalEnv): Promise<PayPalResult<{ access_token: string }>> {
  const creds = btoa(`${env.clientId}:${env.secret}`);
  const res = await fetch(`${apiBase(env.mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, body: body as { access_token: string } };
}

/** Reads an order back from PayPal — the amount PayPal thinks is owed. */
export async function getOrder(
  env: PayPalEnv,
  token: string,
  paypalOrderId: string
): Promise<PayPalResult<Record<string, unknown>>> {
  const res = await fetch(`${apiBase(env.mode)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * Captures the money. `requestId` becomes PayPal-Request-Id, which makes the
 * call idempotent: a retry with the same id cannot charge twice.
 */
export async function captureOrder(
  env: PayPalEnv,
  token: string,
  paypalOrderId: string,
  requestId: string
): Promise<PayPalResult<Record<string, unknown>>> {
  const res = await fetch(
    `${apiBase(env.mode)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
      body: "{}",
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, body: body as Record<string, unknown> };
}

/** Pulls the capture id and status out of a capture response. */
export function readCapture(body: Record<string, unknown>): {
  captureId: string;
  status: string;
  amountValue: string;
  currency: string;
} {
  const unit = (body.purchase_units as Array<Record<string, any>> | undefined)?.[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    captureId: capture?.id ?? "",
    status: String(capture?.status ?? body.status ?? ""),
    amountValue: String(capture?.amount?.value ?? ""),
    currency: String(capture?.amount?.currency_code ?? ""),
  };
}

/** "12.34" -> 1234. Returns NaN for anything that is not a plain amount. */
export function amountToCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return Number.NaN;
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
