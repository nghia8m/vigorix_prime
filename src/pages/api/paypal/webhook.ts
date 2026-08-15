import type { APIRoute } from "astro";
import { readPayPalEnv, json } from "../../../lib/paypal-env";
import { getAccessToken } from "../../../lib/paypal-api";
import {
  verifySignature, readSignatureHeaders, verificationPolicy,
  extractEvent, EVENT_STATUS,
} from "../../../lib/paypal-webhook";
import { upsertOrder, recordEvent } from "../../../lib/order-store";
import type { OrderStoreDb, OrderRecord } from "../../../lib/order-store";

export const prerender = false;

/* ===========================================================================
   PayPal webhook.

   This is the second safety net. If a capture succeeded but the database write
   failed, the order row does not exist — so this endpoint CREATES it from the
   event rather than only updating a row it expects to find.

   Signature verification is not optional in live mode. The one bypass that
   exists for local work refuses to engage when PAYPAL_MODE=live, because an
   unverified webhook is a stranger being able to mark orders as paid.
   =========================================================================== */

function db(locals: unknown): OrderStoreDb | null {
  const env = (locals as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;
  return (env?.ORDERS_DB as OrderStoreDb) ?? null;
}

function readFlag(locals: unknown, key: string): string {
  const runtime = (locals as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env?.[key];
  if (typeof runtime === "string") return runtime;
  const vite = (import.meta.env as Record<string, unknown>)[key];
  if (typeof vite === "string") return vite;
  const proc = typeof process !== "undefined" ? process : undefined;
  return proc?.env?.[key] ?? "";
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = readPayPalEnv(locals);
  const database = db(locals);

  const raw = await request.text();
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const info = extractEvent(event);
  const policy = verificationPolicy(env, readFlag(locals, "PAYPAL_WEBHOOK_ALLOW_UNVERIFIED"));

  if (policy.refusedSkip) {
    console.error(
      "[VP-WEBHOOK-SKIP-REFUSED] PAYPAL_WEBHOOK_ALLOW_UNVERIFIED is set while PAYPAL_MODE=live.",
      "Ignoring it and verifying anyway — remove that variable from the live environment."
    );
  }

  // ---- 1. verify ----------------------------------------------------------
  if (policy.required) {
    if (!env.webhookId) {
      console.error("[VP-WEBHOOK-UNCONFIGURED] PAYPAL_WEBHOOK_ID is not set; refusing the event.");
      return json({ ok: false, error: "webhook_not_configured" }, 503);
    }
    const headers = readSignatureHeaders(request.headers);
    const token = await getAccessToken(env);
    if (!token.ok) return json({ ok: false, error: "paypal_auth_failed" }, 502);

    const verdict = await verifySignature(env, token.body.access_token, {
      ...headers,
      webhookId: env.webhookId,
      event,
    });

    if (!verdict.ok) {
      console.warn(
        "[VP-WEBHOOK-REJECTED] signature verification returned",
        verdict.status,
        "for event",
        info.eventType,
        info.eventId
      );
      await recordEvent(database, {
        orderId: info.orderId || null, source: "webhook", type: "signature_rejected",
        paypalId: info.eventId, status: "rejected",
        payload: { eventType: info.eventType, verification: verdict.status },
      });
      // 401 so PayPal marks the delivery as failed rather than retrying forever
      // against an endpoint that is answering happily.
      return json({ ok: false, error: "invalid_signature", verification: verdict.status }, 401);
    }
  } else {
    console.warn(
      "[VP-WEBHOOK-UNVERIFIED] ⚠ Accepting a webhook WITHOUT signature verification —",
      policy.skipReason,
      "— event:",
      info.eventType,
      info.eventId
    );
  }

  // ---- 2. only events we act on ------------------------------------------
  if (!EVENT_STATUS[info.eventType]) {
    await recordEvent(database, {
      orderId: info.orderId || null, source: "webhook", type: "ignored",
      paypalId: info.eventId, status: "ignored", payload: { eventType: info.eventType },
    });
    return json({ ok: true, ignored: true, eventType: info.eventType });
  }

  const status = EVENT_STATUS[info.eventType];

  await recordEvent(database, {
    orderId: info.orderId || null, source: "webhook", type: info.eventType,
    paypalId: info.eventId, status, payload: event,
  });

  if (!database) {
    console.error("[VP-WEBHOOK-NO-DB] No ORDERS_DB binding; event", info.eventType, "not applied.");
    return json({ ok: false, error: "no_database" }, 503);
  }
  if (!info.orderId) {
    console.warn("[VP-WEBHOOK-NO-ORDER-ID] event", info.eventType, "carried no invoice_id/custom_id.");
    return json({ ok: true, applied: false, reason: "no_order_id" });
  }

  // ---- 3. apply, creating the order if it is missing ----------------------
  const existing = (await database
    .prepare(`SELECT order_id FROM orders WHERE order_id = ?`)
    .bind(info.orderId)
    .first?.()) as { order_id?: string } | null | undefined;

  if (existing?.order_id) {
    await database
      .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`)
      .bind(status, new Date().toISOString(), info.orderId)
      .run();
    return json({ ok: true, applied: true, created: false, orderId: info.orderId, status });
  }

  // The row is missing — most likely a capture that succeeded while the
  // database write failed. Reconstruct what the event knows. Amounts come from
  // PayPal here, not from a browser, and lines are unknown, so the record is
  // marked as reconstructed rather than pretending to be complete.
  console.error(
    "[VP-WEBHOOK-CREATED-MISSING-ORDER] Creating an order that capture never recorded:",
    JSON.stringify({
      orderId: info.orderId, captureId: info.captureId,
      paypalOrderId: info.paypalOrderId, amountCents: info.amountCents, status,
    })
  );

  const record: OrderRecord = {
    orderId: info.orderId,
    paypalOrderId: info.paypalOrderId,
    captureId: info.captureId,
    status,
    currency: info.currency || "USD",
    subtotalCents: info.amountCents ?? 0,
    shippingCents: null,
    totalCents: info.amountCents ?? 0,
    shippingMethod: null,
    customer: { email: "", firstName: "", lastName: "" },
    address: { line1: "", city: "", country: "" },
    lines: [], // not in the event; recovered by hand from the capture record
    raw: event,
  };

  try {
    await upsertOrder(database, record);
  } catch (err) {
    console.error("[VP-WEBHOOK-CREATE-FAILED]", info.orderId, String(err));
    return json({ ok: false, error: "create_failed" }, 500);
  }

  return json({ ok: true, applied: true, created: true, orderId: info.orderId, status });
};
