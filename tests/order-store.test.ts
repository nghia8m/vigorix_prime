/**
 * The failure that matters most: PayPal took the money, our database write
 * failed. Nothing can be undone at that point, so the test asserts the log
 * carries every identifier needed to find the payment and rebuild the row.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { persistCapturedOrder, upsertOrder } from "../src/lib/order-store.ts";
import type { OrderRecord, OrderStoreDb, Logger } from "../src/lib/order-store.ts";

const ORDER: OrderRecord = {
  orderId: "VP-20260815-ABC123XY",
  paypalOrderId: "5O190127TN364715T",
  captureId: "3C679366HH908993F",
  status: "paid",
  currency: "USD",
  subtotalCents: 6600,
  shippingCents: null,
  totalCents: 6600,
  shippingMethod: null,
  customer: { email: "buyer@example.com", firstName: "A", lastName: "B", phone: "" },
  address: { line1: "1 Main St", city: "Hanoi", country: "VN" },
  lines: [
    {
      productSlug: "knee-support-brace", variantId: "size-l", name: "Adjustable Knee Support Brace",
      variantLabel: "L", sku: "VP-KSB-L", unitPriceCents: 3300, qty: 2, lineTotalCents: 6600,
    },
  ],
  raw: { id: "5O190127TN364715T" },
};

/** Records every statement so tests can assert what was written. */
function fakeDb(opts: { failOn?: RegExp } = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db: OrderStoreDb = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (opts.failOn && opts.failOn.test(sql)) {
                throw new Error("D1_ERROR: database is locked");
              }
              calls.push({ sql, args });
              return {};
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

function fakeLog() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const log: Logger = {
    error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
    warn: (...a: unknown[]) => warnings.push(a.map(String).join(" ")),
  };
  return { log, errors, warnings };
}

describe("a successful write", () => {
  test("inserts the order and every line", async () => {
    const { db, calls } = fakeDb();
    const { log } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);

    assert.equal(out.persisted, true);
    assert.equal(out.reconcile, undefined);
    // order upsert, clear any previous lines, then one insert per line
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /INSERT INTO orders/);
    assert.match(calls[1].sql, /DELETE FROM order_lines/);
    assert.match(calls[2].sql, /INSERT INTO order_lines/);
  });

  test("replaying a capture replaces the lines instead of doubling them", async () => {
    const { db, calls } = fakeDb();
    await upsertOrder(db, ORDER);
    await upsertOrder(db, ORDER); // same capture arriving twice

    const deletes = calls.filter((c) => /DELETE FROM order_lines/.test(c.sql));
    const inserts = calls.filter((c) => /INSERT INTO order_lines/.test(c.sql));
    assert.equal(deletes.length, 2, "each write must clear the previous lines first");
    assert.equal(inserts.length, 2, "one line inserted per call, not accumulating");
    // The delete must be scoped to this order, never a blanket wipe.
    assert.deepEqual(deletes[0].args, [ORDER.orderId]);
  });

  test("upsert can create an order the webhook has never seen", async () => {
    const { db, calls } = fakeDb();
    await upsertOrder(db, ORDER);
    // ON CONFLICT means the webhook can call this for an order that was never
    // written at capture time, instead of updating a row that is not there.
    assert.match(calls[0].sql, /ON CONFLICT\(order_id\) DO UPDATE/);
  });
});

describe("payment taken, database write failed", () => {
  test("reports the failure instead of claiming success", async () => {
    const { db } = fakeDb({ failOn: /INSERT INTO orders/ });
    const { log } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);
    assert.equal(out.persisted, false);
    assert.ok(out.reconcile, "must return reconciliation details");
  });

  test("the log carries everything needed to find the payment by hand", async () => {
    const { db } = fakeDb({ failOn: /INSERT INTO orders/ });
    const { log, errors } = fakeLog();
    await persistCapturedOrder(db, ORDER, log);

    assert.equal(errors.length, 1, "exactly one loud line, not a stack of noise");
    const line = errors[0];

    // A marker that can be alerted on.
    assert.match(line, /\[VP-ORDER-NOT-SAVED\]/);
    assert.match(line, /PAYMENT TAKEN BUT ORDER NOT RECORDED/);

    // Everything needed to reconcile against the PayPal dashboard.
    for (const needed of [
      ORDER.orderId,          // our id == PayPal invoice_id
      ORDER.paypalOrderId,    // PayPal order id
      ORDER.captureId,        // capture id, what a refund needs
      String(ORDER.totalCents),
      ORDER.currency,
      ORDER.customer.email!,  // who to contact
    ]) {
      assert.ok(line.includes(needed), `log is missing ${needed}\nlog was: ${line}`);
    }

    // And the underlying cause, so it is fixable rather than mysterious.
    assert.match(line, /database is locked/);
  });

  test("a missing database binding is treated the same way", async () => {
    const { log, errors } = fakeLog();
    const out = await persistCapturedOrder(null, ORDER, log);
    assert.equal(out.persisted, false);
    assert.equal(out.reconcile?.error, "no_database_binding");
    assert.match(errors[0], /\[VP-ORDER-NOT-SAVED\]/);
    assert.ok(errors[0].includes(ORDER.captureId));
  });

  test("a breadcrumb event is attempted even after the order insert failed", async () => {
    const { db, calls } = fakeDb({ failOn: /INSERT INTO orders/ });
    const { log } = fakeLog();
    await persistCapturedOrder(db, ORDER, log);
    assert.ok(
      calls.some((c) => /INSERT INTO order_events/.test(c.sql)),
      "should still try to write an order_events row"
    );
  });

  test("when even the breadcrumb fails, it warns and does not throw", async () => {
    const { db } = fakeDb({ failOn: /INSERT INTO/ }); // everything fails
    const { log, errors, warnings } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);
    assert.equal(out.persisted, false);
    assert.equal(errors.length, 1);
    assert.match(warnings[0], /\[VP-EVENT-WRITE-FAILED\]/);
  });
});
