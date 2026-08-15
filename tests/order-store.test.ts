/**
 * The failure that matters most: PayPal took the money, our database write
 * failed. Nothing can be undone at that point, so the test asserts the log
 * carries every identifier needed to find the payment and rebuild the row.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { persistCapturedOrder, upsertOrder } from "../src/lib/order-store.ts";
import type { OrderRecord, OrderStoreDb, Logger, BoundStatement } from "../src/lib/order-store.ts";

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

/**
 * Stands in for D1. `batch` commits all-or-nothing, like the real thing:
 * `failStatement` makes one statement throw, and nothing is kept.
 */
function fakeDb(opts: { failStatement?: RegExp; noBatch?: boolean } = {}) {
  const committed: Array<{ sql: string; args: unknown[] }> = [];
  const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];

  const make = (sql: string, args: unknown[]): BoundStatement & { __sql: string; __args: unknown[] } => ({
    __sql: sql,
    __args: args,
    async run() {
      if (opts.failStatement && opts.failStatement.test(sql)) throw new Error("D1_ERROR: constraint failed");
      committed.push({ sql, args });
      return {};
    },
  });

  const db: OrderStoreDb = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => make(sql, args) };
    },
  };

  if (!opts.noBatch) {
    db.batch = async (stmts) => {
      const staged: Array<{ sql: string; args: unknown[] }> = [];
      for (const s of stmts as Array<ReturnType<typeof make>>) {
        // All-or-nothing: a throw here discards everything staged.
        if (opts.failStatement && opts.failStatement.test(s.__sql)) {
          throw new Error("D1_ERROR: constraint failed");
        }
        staged.push({ sql: s.__sql, args: s.__args });
      }
      committed.push(...staged);
      batches.push(staged);
      return {};
    };
  }

  return { db, committed, batches };
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
  test("order, line clearing and lines all go in ONE transaction", async () => {
    const { db, batches } = fakeDb();
    const { log } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);

    assert.equal(out.persisted, true);
    assert.equal(batches.length, 1, "must be a single batch, not separate writes");
    const sqls = batches[0].map((c) => c.sql);
    assert.equal(sqls.length, 3);
    assert.match(sqls[0], /INSERT INTO orders/);
    assert.match(sqls[1], /DELETE FROM order_lines/);
    assert.match(sqls[2], /INSERT INTO order_lines/);
    assert.deepEqual(batches[0][1].args, [ORDER.orderId], "the delete is scoped to this order");
  });

  test("replaying a capture replaces the lines instead of doubling them", async () => {
    const { db, committed } = fakeDb();
    await upsertOrder(db, ORDER);
    await upsertOrder(db, ORDER);
    const inserts = committed.filter((c) => /INSERT INTO order_lines/.test(c.sql));
    const deletes = committed.filter((c) => /DELETE FROM order_lines/.test(c.sql));
    assert.equal(deletes.length, 2);
    assert.equal(inserts.length, 2, "one line per write, not accumulating");
  });

  test("upsert can create an order the webhook has never seen", async () => {
    const { db, committed } = fakeDb();
    await upsertOrder(db, ORDER);
    assert.match(committed[0].sql, /ON CONFLICT\(order_id\) DO UPDATE/);
  });
});

describe("the delete/insert pair is atomic", () => {
  test("an insert that fails after the delete leaves NO partial write", async () => {
    const { db, committed } = fakeDb({ failStatement: /INSERT INTO order_lines/ });
    const { log } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);

    assert.equal(out.persisted, false);
    // The whole point: the delete must not have been kept on its own, which
    // would leave a paid order with no lines and no record of what was bought.
    assert.equal(
      committed.filter((c) => /DELETE FROM order_lines/.test(c.sql)).length,
      0,
      "the delete must roll back with the failed insert"
    );
    assert.equal(committed.filter((c) => /INSERT INTO orders/.test(c.sql)).length, 0);
  });

  test("a database without batch() says so instead of writing non-atomically in silence", async () => {
    const { db } = fakeDb({ noBatch: true });
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
    try {
      await upsertOrder(db, ORDER);
    } finally {
      console.warn = realWarn;
    }
    assert.match(warned.join(" "), /\[VP-NO-BATCH\]/);
  });
});

describe("payment taken, database write failed", () => {
  test("reports the failure instead of claiming success", async () => {
    const { db } = fakeDb({ failStatement: /INSERT INTO orders/ });
    const { log } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);
    assert.equal(out.persisted, false);
    assert.ok(out.reconcile, "must return reconciliation details");
  });

  test("the log carries everything needed to find the payment by hand", async () => {
    const { db } = fakeDb({ failStatement: /INSERT INTO orders/ });
    const { log, errors } = fakeLog();
    await persistCapturedOrder(db, ORDER, log);

    assert.equal(errors.length, 1, "exactly one loud line, not a stack of noise");
    const line = errors[0];

    assert.match(line, /\[VP-ORDER-NOT-SAVED\]/);
    assert.match(line, /PAYMENT TAKEN BUT ORDER NOT RECORDED/);

    for (const needed of [
      ORDER.orderId,
      ORDER.paypalOrderId,
      ORDER.captureId,
      String(ORDER.totalCents),
      ORDER.currency,
      ORDER.customer.email!,
    ]) {
      assert.ok(line.includes(needed), `log is missing ${needed}\nlog was: ${line}`);
    }
    assert.match(line, /constraint failed/);
  });

  test("a missing database binding is treated the same way", async () => {
    const { log, errors } = fakeLog();
    const out = await persistCapturedOrder(null, ORDER, log);
    assert.equal(out.persisted, false);
    assert.equal(out.reconcile?.error, "no_database_binding");
    assert.match(errors[0], /\[VP-ORDER-NOT-SAVED\]/);
    assert.ok(errors[0].includes(ORDER.captureId));
  });

  test("a breadcrumb event is attempted even after the write failed", async () => {
    const { db, committed } = fakeDb({ failStatement: /INSERT INTO orders/ });
    const { log } = fakeLog();
    await persistCapturedOrder(db, ORDER, log);
    assert.ok(
      committed.some((c) => /INSERT INTO order_events/.test(c.sql)),
      "should still try to write an order_events row"
    );
  });

  test("when even the breadcrumb fails, it warns and does not throw", async () => {
    const { db } = fakeDb({ failStatement: /INSERT INTO/ });
    const { log, errors, warnings } = fakeLog();
    const out = await persistCapturedOrder(db, ORDER, log);
    assert.equal(out.persisted, false);
    assert.equal(errors.length, 1);
    assert.match(warnings[0], /\[VP-EVENT-WRITE-FAILED\]/);
  });
});
