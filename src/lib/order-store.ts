/**
 * Writing orders to D1.
 *
 * Split out of the capture endpoint so the failure path can be tested without
 * a payment: the worst outcome in this whole system is PayPal taking a
 * customer's money while our database write fails, leaving no record of what
 * they bought. When that happens the money is already gone, so the only useful
 * response is a log loud enough to reconcile by hand, and a second chance to
 * write the row later (the webhook).
 */

/** A prepared, bound statement — what D1's batch() accepts. */
export interface BoundStatement {
  run: () => Promise<unknown>;
  first?: () => Promise<unknown>;
}

export interface OrderStoreDb {
  prepare: (sql: string) => { bind: (...args: unknown[]) => BoundStatement };
  /** D1 runs a batch inside a single implicit transaction. */
  batch?: (statements: BoundStatement[]) => Promise<unknown>;
}

export interface OrderLineRow {
  productSlug: string;
  variantId: string;
  name: string;
  variantLabel: string;
  sku: string;
  unitPriceCents: number;
  qty: number;
  lineTotalCents: number;
}

export interface OrderRecord {
  orderId: string;
  paypalOrderId: string;
  captureId: string;
  status: string;
  currency: string;
  subtotalCents: number;
  shippingCents: number | null;
  totalCents: number;
  shippingMethod: { id: string; label: string } | null;
  customer: { email?: string; firstName?: string; lastName?: string; phone?: string };
  address: {
    line1?: string; line2?: string; city?: string;
    region?: string; postalCode?: string; country?: string;
  };
  lines: OrderLineRow[];
  raw: unknown;
}

export type Logger = { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

const nowIso = () => new Date().toISOString();

/**
 * Insert or update. The webhook uses the same call, so an order that failed to
 * write at capture time can still be created later from the webhook payload —
 * that is the second safety net, not just a status update.
 */
export async function upsertOrder(db: OrderStoreDb, o: OrderRecord): Promise<void> {
  const stamp = nowIso();

  // ONE transaction. The order row, the clearing of its old lines and the new
  // lines all land together or not at all. Run separately, a delete that
  // succeeded followed by an insert that failed would leave the order with no
  // lines at all — worse than the duplicate rows this replaced, because then
  // nobody knows what the customer bought.
  const statements: BoundStatement[] = [];

  statements.push(
    db
      .prepare(
      `INSERT INTO orders (
        order_id, paypal_order_id, paypal_capture_id, status, currency,
        subtotal_cents, shipping_cents, total_cents,
        shipping_method_id, shipping_method_label,
        email, first_name, last_name, phone,
        address_line1, address_line2, city, region, postal_code, country,
        paypal_raw, created_at, updated_at
      ) VALUES (?,?,?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET
        paypal_order_id   = COALESCE(excluded.paypal_order_id, orders.paypal_order_id),
        paypal_capture_id = COALESCE(excluded.paypal_capture_id, orders.paypal_capture_id),
        status            = excluded.status,
        paypal_raw        = excluded.paypal_raw,
        updated_at        = excluded.updated_at`
    )
    .bind(
      o.orderId, o.paypalOrderId || null, o.captureId || null, o.status, o.currency,
      o.subtotalCents, o.shippingCents, o.totalCents,
      o.shippingMethod?.id ?? null, o.shippingMethod?.label ?? null,
      o.customer.email ?? "", o.customer.firstName ?? "", o.customer.lastName ?? "",
      o.customer.phone || null,
      o.address.line1 ?? "", o.address.line2 || null, o.address.city ?? "",
      o.address.region || null, o.address.postalCode || null, o.address.country ?? "",
      JSON.stringify(o.raw).slice(0, 60000), stamp, stamp
    )
  );

  // Replace, do not append. A capture can legitimately be replayed (PayPal
  // returns the same capture for a repeated PayPal-Request-Id, and the webhook
  // may arrive for an order that already exists); appending would double the
  // lines and a fulfilment screen would show twice the goods to ship.
  statements.push(db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).bind(o.orderId));

  for (const line of o.lines) {
    statements.push(
      db
        .prepare(
          `INSERT INTO order_lines (order_id, product_slug, variant_id, name, variant_label, sku,
            unit_price_cents, qty, line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          o.orderId, line.productSlug, line.variantId, line.name,
          line.variantLabel || null, line.sku || null,
          line.unitPriceCents, line.qty, line.lineTotalCents
        )
    );
  }

  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }

  // No batch support (a stub, or a driver without it). Running these one by one
  // is NOT atomic, so it is announced rather than done quietly.
  console.warn(
    "[VP-NO-BATCH] Database has no batch(); order",
    o.orderId,
    "written without a transaction — a partial failure can leave it with no lines."
  );
  for (const stmt of statements) await stmt.run();
}

export async function recordEvent(
  db: OrderStoreDb | null,
  row: {
    orderId: string | null; source: string; type: string;
    paypalId: string; status: string; payload: unknown;
  },
  log?: Logger
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO order_events (order_id, source, event_type, paypal_id, status_after, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.orderId, row.source, row.type, row.paypalId, row.status,
        JSON.stringify(row.payload).slice(0, 20000), nowIso()
      )
      .run();
  } catch (err) {
    // Never let bookkeeping break a payment path, but never swallow it either.
    (log ?? console).warn("[VP-EVENT-WRITE-FAILED]", row.type, row.orderId, String(err));
  }
}

export interface PersistOutcome {
  persisted: boolean;
  /** Set when the money moved but the row did not get written. */
  reconcile?: {
    orderId: string;
    paypalOrderId: string;
    paypalCaptureId: string;
    totalCents: number;
    currency: string;
    email: string;
    error: string;
  };
}

/**
 * Persist an order whose payment ALREADY SUCCEEDED.
 *
 * A failure here cannot be undone by refusing anything — the charge has
 * happened. So it is logged with every identifier needed to find the payment in
 * the PayPal dashboard and rebuild the row by hand, and reported back so the
 * caller can tell the customer the truth.
 */
export async function persistCapturedOrder(
  db: OrderStoreDb | null,
  order: OrderRecord,
  log: Logger = console
): Promise<PersistOutcome> {
  if (!db) {
    const reconcile = {
      orderId: order.orderId,
      paypalOrderId: order.paypalOrderId,
      paypalCaptureId: order.captureId,
      totalCents: order.totalCents,
      currency: order.currency,
      email: order.customer.email ?? "",
      error: "no_database_binding",
    };
    log.error(
      "[VP-ORDER-NOT-SAVED] PAYMENT TAKEN BUT ORDER NOT RECORDED —",
      "reconcile manually in the PayPal dashboard:",
      JSON.stringify(reconcile)
    );
    return { persisted: false, reconcile };
  }

  try {
    await upsertOrder(db, order);
    return { persisted: true };
  } catch (err) {
    const reconcile = {
      orderId: order.orderId,
      paypalOrderId: order.paypalOrderId,
      paypalCaptureId: order.captureId,
      totalCents: order.totalCents,
      currency: order.currency,
      email: order.customer.email ?? "",
      error: String(err),
    };
    // Deliberately one line, with a searchable marker and every id needed.
    log.error(
      "[VP-ORDER-NOT-SAVED] PAYMENT TAKEN BUT ORDER NOT RECORDED —",
      "reconcile manually in the PayPal dashboard:",
      JSON.stringify(reconcile)
    );
    // Best-effort breadcrumb; may also fail, which is why the log above exists.
    await recordEvent(
      db,
      {
        orderId: order.orderId, source: "capture", type: "persist_failed",
        paypalId: order.captureId, status: order.status, payload: reconcile,
      },
      log
    );
    return { persisted: false, reconcile };
  }
}
