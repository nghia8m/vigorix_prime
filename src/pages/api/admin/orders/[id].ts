import type { APIRoute } from "astro";
import { requireAdmin } from "../../../../lib/admin-auth";
import { MANUAL_STATUSES } from "../orders";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

type Db = {
  prepare: (sql: string) => {
    bind: (...a: unknown[]) => { all: () => Promise<any>; first: () => Promise<any>; run: () => Promise<any> };
  };
};
const db = (locals: unknown): Db | null => ((locals as any)?.runtime?.env?.ORDERS_DB as Db) ?? null;

/** Order ids can contain characters that must be percent-encoded in a URL
 *  (the webhook-built ones contain a colon), and Astro hands the param over
 *  still encoded. Decoding here keeps the lookup honest. */
function orderIdFrom(params: Record<string, string | undefined>): string {
  const raw = params.id ?? "";
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function loadOrder(database: Db, id: string) {
  const order = await database.prepare(`SELECT * FROM orders WHERE order_id = ?`).bind(id).first();
  if (!order) return null;

  const lines = await database
    .prepare(
      `SELECT product_slug, variant_id, name, variant_label, sku,
              unit_price_cents, qty, line_total_cents
         FROM order_lines WHERE order_id = ? ORDER BY id`
    )
    .bind(id)
    .all();

  const events = await database
    .prepare(
      `SELECT source, event_type, paypal_id, status_after, payload, created_at
         FROM order_events WHERE order_id = ? ORDER BY id DESC LIMIT 50`
    )
    .bind(id)
    .all();

  const lineRows = lines?.results ?? [];
  return {
    ...order,
    shipping_cents:
      order.shipping_cents === null || order.shipping_cents === "null" ? null : Number(order.shipping_cents),
    lines: lineRows,
    events: events?.results ?? [],
    // Why this order cannot be trusted to be complete — shown on screen rather
    // than left for someone to work out from blank rows.
    reconciliation: buildReconciliation(order, lineRows),
  };
}

function buildReconciliation(order: any, lines: any[]) {
  const reasons: string[] = [];
  if (lines.length === 0) reasons.push("No order lines were recorded — the items bought are not known here.");
  if (!order.email) reasons.push("No customer details were recorded.");
  if (!order.address_line1) reasons.push("No delivery address was recorded.");
  if (reasons.length === 0) return null;
  return {
    reasons,
    // What to look the payment up by in the PayPal dashboard.
    paypalCaptureId: order.paypal_capture_id || null,
    paypalOrderId: order.paypal_order_id || null,
    hint:
      "This order was reconstructed from a PayPal webhook after the capture succeeded but the database write did not. " +
      "Look the capture up in the PayPal dashboard to recover the missing details.",
  };
}

export const GET: APIRoute = async ({ request, locals, params }) => {
  const guard = await requireAdmin(request, locals);
  if (guard.response) return guard.response;

  const database = db(locals);
  if (!database) return json({ ok: false, error: "no_database" }, 503);

  const order = await loadOrder(database, orderIdFrom(params));
  if (!order) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true, order, manualStatuses: MANUAL_STATUSES });
};

/**
 * The only writes this screen is allowed: the operator's own status and a
 * tracking number. `status` — what the server confirmed — is never touched
 * here, and orders can never be deleted; a cancellation is a status.
 */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const guard = await requireAdmin(request, locals);
  if (guard.response) return guard.response;

  const database = db(locals);
  if (!database) return json({ ok: false, error: "no_database" }, 503);

  const id = orderIdFrom(params);
  const current = await database
    .prepare(`SELECT order_id, manual_status, tracking_number FROM orders WHERE order_id = ?`)
    .bind(id)
    .first();
  if (!current) return json({ ok: false, error: "not_found" }, 404);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const changes: string[] = [];
  const args: unknown[] = [];
  const audit: Array<{ field: string; from: unknown; to: unknown }> = [];

  if (body.manualStatus !== undefined) {
    const next = String(body.manualStatus || "");
    if (next && !MANUAL_STATUSES.includes(next)) {
      return json({ ok: false, error: "bad_status", allowed: MANUAL_STATUSES }, 400);
    }
    if (next !== (current.manual_status ?? "")) {
      changes.push("manual_status = ?");
      args.push(next || null);
      audit.push({ field: "manual_status", from: current.manual_status ?? null, to: next || null });
    }
  }

  if (body.trackingNumber !== undefined) {
    const next = String(body.trackingNumber || "").trim().slice(0, 120);
    if (next !== (current.tracking_number ?? "")) {
      changes.push("tracking_number = ?");
      args.push(next || null);
      audit.push({ field: "tracking_number", from: current.tracking_number ?? null, to: next || null });
    }
  }

  if (!changes.length) return json({ ok: true, unchanged: true });

  const stamp = new Date().toISOString();
  await database
    .prepare(`UPDATE orders SET ${changes.join(", ")}, updated_at = ? WHERE order_id = ?`)
    .bind(...args, stamp, id)
    .run();

  // Append to the history, never rewrite it: who changed what, from what to
  // what. This is the record when a customer disputes what they were told.
  for (const change of audit) {
    await database
      .prepare(
        `INSERT INTO order_events (order_id, source, event_type, paypal_id, status_after, payload, created_at)
         VALUES (?, 'admin', ?, NULL, ?, ?, ?)`
      )
      .bind(
        id,
        `${change.field}_changed`,
        String(change.to ?? ""),
        JSON.stringify({ by: guard.login, field: change.field, from: change.from, to: change.to }),
        stamp
      )
      .run();
  }

  const order = await loadOrder(database, id);
  return json({ ok: true, order, changed: audit });
};
