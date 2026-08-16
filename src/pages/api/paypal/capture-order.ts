import type { APIRoute } from "astro";
import { readPayPalEnv, json } from "../../../lib/paypal-env";
import { getAccessToken, getOrder, captureOrder, readCapture, amountToCents } from "../../../lib/paypal-api";
import { loadPricingContext } from "../../../lib/server-catalogue";
import { priceOrder, verifyClientTotal } from "../../../lib/pricing";
import { persistCapturedOrder, recordEvent } from "../../../lib/order-store";
import type { OrderRecord } from "../../../lib/order-store";
import { readShipping } from "../../../lib/cart-config";
import site from "../../../data/site.json";

const shopCurrency = () =>
  readShipping((site as Record<string, unknown>).shipping).currency || "USD";

export const prerender = false;

/* ===========================================================================
   Capture a PayPal order.
   ---------------------------------------------------------------------------
   THE CLIENT SENDS: paypalOrderId, orderId, items (slug + variant + qty),
   customer, address. That is all. Postage is computed from the quantities.

   THE SERVER DECIDES: every amount, by re-pricing those items from the content
   collection. `claimedTotalCents`, if present, is only compared — a mismatch
   refuses the order and is logged. It is never adopted.

   The money is not captured until the server's figure matches what PayPal was
   asked to charge. Capturing first and checking afterwards would mean taking
   money for a total nobody agreed to.
   =========================================================================== */

type Db = import("../../../lib/order-store").OrderStoreDb;

function db(locals: unknown): Db | null {
  const env = (locals as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;
  return (env?.ORDERS_DB as Db) ?? null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = readPayPalEnv(locals);
  const database = db(locals);

  if (!env.clientId || !env.secret) {
    return json({ ok: false, error: "paypal_not_configured" }, 503);
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request", message: "Body must be JSON." }, 400);
  }

  const paypalOrderId = typeof payload?.paypalOrderId === "string" ? payload.paypalOrderId : "";
  const orderId = typeof payload?.orderId === "string" ? payload.orderId : "";
  if (!paypalOrderId || !orderId) {
    return json({ ok: false, error: "bad_request", message: "Missing order identifiers." }, 400);
  }

  // ---- 1. price the order ourselves ---------------------------------------
  const ctx = await loadPricingContext(env.mode);
  const priced = priceOrder(ctx, {
    items: Array.isArray(payload?.items) ? payload.items : [],
  });

  if (!priced.ok) {
    await recordEvent(database, {
      orderId, source: "capture", type: "rejected_pricing", paypalId: paypalOrderId,
      status: "rejected", payload: { code: priced.code, message: priced.message, sent: payload?.items },
    });
    return json({ ok: false, error: priced.code, message: priced.message }, 409);
  }

  // ---- 2. compare anything the client claimed ------------------------------
  if (payload?.claimedTotalCents !== undefined) {
    const check = verifyClientTotal(priced, payload.claimedTotalCents);
    if (!check.match) {
      await recordEvent(database, {
        orderId, source: "capture", type: "rejected_total_mismatch", paypalId: paypalOrderId,
        status: "rejected", payload: check,
      });
      return json(
        {
          ok: false,
          error: "total_mismatch",
          message: "The order total does not match our records. Nothing has been charged.",
          serverTotalCents: check.serverTotalCents,
        },
        409
      );
    }
  }

  // ---- 3. token + read the order back from PayPal --------------------------
  const token = await getAccessToken(env);
  if (!token.ok) {
    await recordEvent(database, {
      orderId, source: "capture", type: "oauth_failed", paypalId: paypalOrderId,
      status: "failed", payload: token.body,
    });
    return json({ ok: false, error: "paypal_auth_failed", message: "Could not reach PayPal." }, 502);
  }
  const access = token.body.access_token;

  const remote = await getOrder(env, access, paypalOrderId);
  if (!remote.ok) {
    return json({ ok: false, error: "paypal_order_unreadable", message: "Could not read that order." }, 502);
  }

  // ---- 4. does PayPal's amount match ours? --------------------------------
  const unit = (remote.body.purchase_units as Array<Record<string, any>> | undefined)?.[0];
  const remoteCents = amountToCents(String(unit?.amount?.value ?? ""));
  const remoteCurrency = String(unit?.amount?.currency_code ?? "");
  // The currency we sell in comes from site.json, never from the request.
  const expectedCurrency = shopCurrency();

  if (!Number.isFinite(remoteCents) || remoteCents !== priced.totalCents) {
    await recordEvent(database, {
      orderId, source: "capture", type: "rejected_amount_mismatch", paypalId: paypalOrderId,
      status: "rejected", payload: { paypalCents: remoteCents, serverCents: priced.totalCents },
    });
    // NOT captured: refusing before the money moves.
    return json(
      {
        ok: false,
        error: "amount_mismatch",
        message: "The amount PayPal was asked to charge does not match this order. Nothing has been charged.",
        serverTotalCents: priced.totalCents,
      },
      409
    );
  }
  if (remoteCurrency && expectedCurrency && remoteCurrency !== expectedCurrency) {
    return json({ ok: false, error: "currency_mismatch", message: "Currency mismatch." }, 409);
  }

  // ---- 5. capture ---------------------------------------------------------
  const captured = await captureOrder(env, access, paypalOrderId, orderId);
  if (!captured.ok) {
    await recordEvent(database, {
      orderId, source: "capture", type: "capture_failed", paypalId: paypalOrderId,
      status: "failed", payload: captured.body,
    });
    const alreadyCaptured =
      JSON.stringify(captured.body).includes("ORDER_ALREADY_CAPTURED");
    return json(
      {
        ok: false,
        error: alreadyCaptured ? "already_captured" : "capture_failed",
        message: alreadyCaptured
          ? "This order was already paid. You have not been charged again."
          : "PayPal could not complete the payment. You have not been charged.",
      },
      alreadyCaptured ? 409 : 502
    );
  }

  const info = readCapture(captured.body);
  const capturedCents = amountToCents(info.amountValue);
  const status = info.status === "COMPLETED" ? "paid" : info.status === "PENDING" ? "pending" : "failed";

  // ---- 6. persist ---------------------------------------------------------
  // The money has moved. A failure here cannot be undone by refusing anything,
  // so it is logged loudly with every id needed to reconcile by hand, and the
  // webhook gets a second chance to create the row.
  const record: OrderRecord = {
    orderId,
    paypalOrderId,
    captureId: info.captureId,
    status,
    currency: info.currency || remoteCurrency,
    subtotalCents: priced.subtotalCents,
    shippingCents: priced.shippingCents,
    totalCents: priced.totalCents,
    shippingMethod: priced.shippingMethod,
    customer: payload?.customer ?? {},
    address: payload?.shippingAddress ?? {},
    lines: priced.lines,
    raw: captured.body,
  };

  const saved = await persistCapturedOrder(database, record);

  await recordEvent(database, {
    orderId, source: "capture", type: "capture_completed", paypalId: info.captureId,
    status, payload: { capturedCents, serverCents: priced.totalCents, persisted: saved.persisted },
  });

  return json({
    ok: true,
    orderId,
    status,
    paypalCaptureId: info.captureId,
    subtotalCents: priced.subtotalCents,
    shippingCents: priced.shippingCents,
    totalCents: priced.totalCents,
    currency: info.currency || remoteCurrency,
    // Told the truth rather than hidden: the payment succeeded either way, but
    // support needs to know if the order row is missing.
    recorded: saved.persisted,
  });
};
