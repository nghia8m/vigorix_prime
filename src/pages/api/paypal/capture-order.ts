import type { APIRoute } from "astro";
import { readPayPalEnv, json } from "../../../lib/paypal-env";
import { getAccessToken, getOrder, captureOrder, readCapture, amountToCents } from "../../../lib/paypal-api";
import { loadPricingContext } from "../../../lib/server-catalogue";
import { priceOrder, verifyClientTotal } from "../../../lib/pricing";
import type { PriceSuccess } from "../../../lib/pricing";
import { readShipping } from "../../../lib/cart-config";
import site from "../../../data/site.json";

const shopCurrency = () =>
  readShipping((site as Record<string, unknown>).shipping).currency || "USD";

export const prerender = false;

/* ===========================================================================
   Capture a PayPal order.
   ---------------------------------------------------------------------------
   THE CLIENT SENDS: paypalOrderId, orderId, items (slug + variant + qty),
   shippingRateId, customer, address. That is all.

   THE SERVER DECIDES: every amount, by re-pricing those items from the content
   collection. `claimedTotalCents`, if present, is only compared — a mismatch
   refuses the order and is logged. It is never adopted.

   The money is not captured until the server's figure matches what PayPal was
   asked to charge. Capturing first and checking afterwards would mean taking
   money for a total nobody agreed to.
   =========================================================================== */

type Db = { prepare: (sql: string) => any; batch: (stmts: any[]) => Promise<unknown> };

function db(locals: unknown): Db | null {
  const env = (locals as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;
  return (env?.ORDERS_DB as Db) ?? null;
}

const nowIso = () => new Date().toISOString();

async function recordEvent(
  database: Db | null,
  row: { orderId: string | null; source: string; type: string; paypalId: string; status: string; payload: unknown }
) {
  if (!database) return;
  try {
    await database
      .prepare(
        `INSERT INTO order_events (order_id, source, event_type, paypal_id, status_after, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.orderId, row.source, row.type, row.paypalId, row.status, JSON.stringify(row.payload).slice(0, 20000), nowIso())
      .run();
  } catch {
    /* logging must never break a payment path */
  }
}

async function saveOrder(
  database: Db,
  args: {
    orderId: string;
    paypalOrderId: string;
    captureId: string;
    status: string;
    currency: string;
    priced: PriceSuccess;
    customer: Record<string, string>;
    address: Record<string, string>;
    raw: unknown;
  }
) {
  const { priced, customer, address } = args;
  const stamp = nowIso();

  await database
    .prepare(
      `INSERT INTO orders (
        order_id, paypal_order_id, paypal_capture_id, status, currency,
        subtotal_cents, shipping_cents, total_cents,
        shipping_method_id, shipping_method_label,
        email, first_name, last_name, phone,
        address_line1, address_line2, city, region, postal_code, country,
        paypal_raw, created_at, updated_at
      ) VALUES (?,?,?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?)`
    )
    .bind(
      args.orderId, args.paypalOrderId, args.captureId, args.status, args.currency,
      priced.subtotalCents, priced.shippingCents, priced.totalCents,
      priced.shippingMethod?.id ?? null, priced.shippingMethod?.label ?? null,
      customer.email, customer.firstName, customer.lastName, customer.phone || null,
      address.line1, address.line2 || null, address.city, address.region || null,
      address.postalCode || null, address.country,
      JSON.stringify(args.raw).slice(0, 60000), stamp, stamp
    )
    .run();

  for (const line of priced.lines) {
    await database
      .prepare(
        `INSERT INTO order_lines (order_id, product_slug, variant_id, name, variant_label, sku,
          unit_price_cents, qty, line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        args.orderId, line.productSlug, line.variantId, line.name,
        line.variantLabel || null, line.sku || null,
        line.unitPriceCents, line.qty, line.lineTotalCents
      )
      .run();
  }
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
  const ctx = await loadPricingContext();
  const priced = priceOrder(ctx, {
    items: Array.isArray(payload?.items) ? payload.items : [],
    shippingRateId: payload?.shippingRateId ?? null,
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
  if (database) {
    try {
      await saveOrder(database, {
        orderId,
        paypalOrderId,
        captureId: info.captureId,
        status,
        currency: info.currency || remoteCurrency,
        priced,
        customer: payload?.customer ?? {},
        address: payload?.shippingAddress ?? {},
        raw: captured.body,
      });
    } catch (err) {
      // The money HAS moved. Losing the row must be loud, not silent.
      await recordEvent(database, {
        orderId, source: "capture", type: "persist_failed", paypalId: info.captureId,
        status, payload: { error: String(err) },
      });
    }
  }

  await recordEvent(database, {
    orderId, source: "capture", type: "capture_completed", paypalId: info.captureId,
    status, payload: { capturedCents, serverCents: priced.totalCents },
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
  });
};
