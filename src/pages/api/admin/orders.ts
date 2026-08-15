import type { APIRoute } from "astro";
import { requireAdmin } from "../../../lib/admin-auth";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** Statuses the operator may set by hand. The server's own status is separate. */
export const MANUAL_STATUSES = [
  "pending", "paid", "processing", "shipped", "delivered", "cancelled", "refunded",
];

type Db = {
  prepare: (sql: string) => { bind: (...a: unknown[]) => { all: () => Promise<any>; first: () => Promise<any> } };
};

const db = (locals: unknown): Db | null =>
  ((locals as any)?.runtime?.env?.ORDERS_DB as Db) ?? null;

export const GET: APIRoute = async ({ request, locals, url }) => {
  const guard = await requireAdmin(request, locals);
  if (guard.response) return guard.response;

  const database = db(locals);
  if (!database) return json({ ok: false, error: "no_database" }, 503);

  const q = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(100, Math.max(5, parseInt(url.searchParams.get("perPage") ?? "25", 10) || 25));
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const args: unknown[] = [];

  if (q) {
    // Search covers what an operator actually has to hand: the id from an
    // email, or the customer's address details.
    where.push("(o.order_id LIKE ? OR o.email LIKE ? OR (o.first_name || ' ' || o.last_name) LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  if (status) {
    // Matches either side deliberately: the operator thinks in one vocabulary,
    // and "show me everything refunded" should not miss a server-set refund.
    where.push("(COALESCE(o.manual_status, '') = ? OR o.status = ?)");
    args.push(status, status);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await database
    .prepare(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`)
    .bind(...args)
    .first();

  const rows = await database
    .prepare(
      `SELECT o.order_id, o.status, o.manual_status, o.tracking_number,
              o.currency, o.total_cents, o.subtotal_cents, o.shipping_cents,
              o.email, o.first_name, o.last_name, o.created_at,
              o.paypal_capture_id,
              (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.order_id) AS line_count,
              (SELECT COALESCE(SUM(l.qty), 0) FROM order_lines l WHERE l.order_id = o.order_id) AS item_count
         FROM orders o
         ${whereSql}
         ORDER BY o.created_at DESC
         LIMIT ? OFFSET ?`
    )
    .bind(...args, perPage, offset)
    .all();

  const orders = (rows?.results ?? []).map((r: any) => ({
    ...r,
    // shipping_cents comes back as the string "null" from some drivers; the
    // difference between "no shipping policy" and "free" must survive.
    shipping_cents: r.shipping_cents === null || r.shipping_cents === "null" ? null : Number(r.shipping_cents),
    // Flagged for the screen: an order the webhook built has no lines and no
    // customer, and needs reconciling by hand rather than looking merely empty.
    needs_reconciliation: Number(r.line_count) === 0 || !r.email,
  }));

  return json({
    ok: true,
    orders,
    page,
    perPage,
    total: Number(totalRow?.n ?? 0),
    manualStatuses: MANUAL_STATUSES,
  });
};
