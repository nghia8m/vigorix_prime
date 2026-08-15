/**
 * Webhook signature verification and event mapping.
 *
 * A webhook endpoint that does not verify signatures is an endpoint where
 * anyone who learns the URL can mark orders as paid. Verification is therefore
 * unconditional in live mode — see `verificationPolicy` below — and the bypass
 * that exists for local work refuses to engage against live credentials.
 */
import { apiBase, type PayPalEnv } from "./paypal-env";

/** Events this shop acts on, and the order status each one implies. */
export const EVENT_STATUS: Record<string, string> = {
  "PAYMENT.CAPTURE.COMPLETED": "paid",
  "PAYMENT.CAPTURE.DENIED": "denied",
  "PAYMENT.CAPTURE.REFUNDED": "refunded",
  "PAYMENT.CAPTURE.REVERSED": "reversed",
  "CUSTOMER.DISPUTE.CREATED": "disputed",
  "CUSTOMER.DISPUTE.UPDATED": "disputed",
  "CUSTOMER.DISPUTE.RESOLVED": "dispute_resolved",
};

export const HANDLED_EVENTS = Object.keys(EVENT_STATUS);

export interface VerificationPolicy {
  /** Whether the signature must be checked. */
  required: boolean;
  /** Set when verification is being skipped, for the warning log. */
  skipReason?: string;
  /** Set when a skip was requested but refused. */
  refusedSkip?: boolean;
}

/**
 * Decides whether this request's signature must be verified.
 *
 * The ONLY way to skip is PAYPAL_WEBHOOK_ALLOW_UNVERIFIED=1 together with
 * sandbox mode. Under PAYPAL_MODE=live the flag is ignored outright — a live
 * shop must never accept an unverified "this order is paid" message, whatever
 * an environment variable says.
 */
export function verificationPolicy(env: PayPalEnv, allowUnverified: string): VerificationPolicy {
  const wants = allowUnverified === "1";
  if (!wants) return { required: true };
  if (env.mode === "live") return { required: true, refusedSkip: true };
  return {
    required: false,
    skipReason: "PAYPAL_WEBHOOK_ALLOW_UNVERIFIED=1 in sandbox mode",
  };
}

export interface VerifyInput {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
  webhookId: string;
  /** The raw body, parsed. PayPal wants the event object, not a string. */
  event: unknown;
}

export type VerifyResult =
  | { ok: true; status: "SUCCESS" }
  | { ok: false; status: string; detail?: unknown };

/** Calls PayPal's own verification API — we never re-implement the crypto. */
export async function verifySignature(
  env: PayPalEnv,
  accessToken: string,
  input: VerifyInput
): Promise<VerifyResult> {
  const res = await fetch(`${apiBase(env.mode)}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transmission_id: input.transmissionId,
      transmission_time: input.transmissionTime,
      cert_url: input.certUrl,
      auth_algo: input.authAlgo,
      transmission_sig: input.transmissionSig,
      webhook_id: input.webhookId,
      webhook_event: input.event,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as { verification_status?: string };
  if (!res.ok) return { ok: false, status: "HTTP_" + res.status, detail: body };
  const status = body.verification_status ?? "UNKNOWN";
  return status === "SUCCESS" ? { ok: true, status } : { ok: false, status, detail: body };
}

/** Header names PayPal sends, read case-insensitively. */
export function readSignatureHeaders(headers: Headers) {
  return {
    transmissionId: headers.get("paypal-transmission-id") ?? "",
    transmissionTime: headers.get("paypal-transmission-time") ?? "",
    transmissionSig: headers.get("paypal-transmission-sig") ?? "",
    certUrl: headers.get("paypal-cert-url") ?? "",
    authAlgo: headers.get("paypal-auth-algo") ?? "",
  };
}

export interface ExtractedEvent {
  eventType: string;
  eventId: string;
  status: string | null;
  /** Our order id, taken from invoice_id or custom_id. */
  orderId: string;
  captureId: string;
  paypalOrderId: string;
  amountCents: number | null;
  currency: string;
}

const toCents = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};

/**
 * Pulls the identifiers out of an event. Dispute events nest things
 * differently from capture events, so both shapes are handled.
 */
export function extractEvent(event: any): ExtractedEvent {
  const type = String(event?.event_type ?? "");
  const r = event?.resource ?? {};

  // Capture events carry invoice_id directly; disputes hide it under
  // disputed_transactions[].
  const disputed = r?.disputed_transactions?.[0] ?? {};
  const orderId =
    r?.invoice_id || r?.custom_id || disputed?.invoice_id || disputed?.custom_id || "";

  const captureId = r?.id || disputed?.seller_transaction_id || "";
  const paypalOrderId =
    r?.supplementary_data?.related_ids?.order_id || disputed?.seller_transaction_id || "";

  const amount = r?.amount?.value ?? r?.dispute_amount?.value ?? null;
  const currency = r?.amount?.currency_code ?? r?.dispute_amount?.currency_code ?? "";

  return {
    eventType: type,
    eventId: String(event?.id ?? ""),
    status: EVENT_STATUS[type] ?? null,
    orderId: String(orderId),
    captureId: String(captureId),
    paypalOrderId: String(paypalOrderId),
    amountCents: toCents(amount),
    currency: String(currency),
  };
}
