/**
 * Integration check: the same pricing module, run against the REAL product
 * data rather than fixtures.
 *
 * dist/shop/catalog.json is generated at build time from the content
 * collection, so it is a faithful projection of what is in src/content/products.
 * Using it here proves the arithmetic is right on the actual catalogue, without
 * needing the Astro runtime inside a plain `node --test` process.
 *
 * Skips itself when there is no build to read.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { priceOrder } from "../src/lib/pricing.ts";
import type { Catalogue, PricingContext } from "../src/lib/pricing.ts";

const CATALOG_FILE = path.resolve("dist/shop/catalog.json");
const built = fs.existsSync(CATALOG_FILE);

describe("real catalogue", { skip: built ? false : "no build found — run `npm run build:preview` first" }, () => {
  const raw = built ? JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")) : { products: {}, shipping: {} };

  const catalogue: Catalogue = Object.fromEntries(
    Object.entries(raw.products as Record<string, any>).map(([slug, p]) => [
      slug,
      {
        slug: p.slug,
        name: p.name,
        priceCents: p.priceCents,
        stock: p.stock,
        variants: p.variants.map((v: any) => ({
          id: v.id,
          label: v.label,
          priceDeltaCents: v.priceDeltaCents,
          sku: v.sku,
          stock: v.stock,
        })),
      },
    ])
  );

  const ctx = (shippingOverride?: Partial<PricingContext["shipping"]>): PricingContext => ({
    catalogue,
    shipping: {
      enabled: raw.shipping.enabled,
      perBlockCents: raw.shipping.perBlockCents,
      blockSize: raw.shipping.blockSize,
      ...shippingOverride,
    },
    limits: {
      minOrderQty: raw.config.MIN_ORDER_QTY,
      maxQtyPerLine: raw.config.MAX_QTY_PER_LINE,
      minQtyPerLine: raw.config.MIN_QTY_PER_PRODUCT ?? 1,
    },
  });

  test("the sample products are all priced in whole cents", () => {
    for (const p of Object.values(catalogue)) {
      assert.ok(Number.isInteger(p.priceCents), `${p.slug} price is not an integer`);
      for (const v of p.variants) {
        assert.ok(Number.isInteger(v.priceDeltaCents), `${p.slug}/${v.id} delta is not an integer`);
      }
    }
  });

  test("a real mixed order totals correctly", () => {
    const r = priceOrder(ctx(), {
      items: [
        { productSlug: "knee-support-brace", variantId: "size-l", qty: 3 },
        { productSlug: "herbal-warming-patch", variantId: "pack-8", qty: 3 },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;

    /* Expectations are DERIVED from the catalogue, not written in. Prices are
       the owner's to change from the admin — one was dropped to $1 for a live
       test — and a test that hard-codes 2900 fails on that edit while proving
       nothing about the arithmetic. What the code owes is that a unit is the
       base plus its variant delta, a line is the unit times the quantity, and
       the subtotal is the sum. Those hold at any price. */
    const expectUnit = (slug: string, variantId: string) => {
      const p = catalogue[slug];
      const v = p.variants.find((x) => x.id === variantId)!;
      return p.priceCents + v.priceDeltaCents;
    };
    const braceUnit = expectUnit("knee-support-brace", "size-l");
    const patchUnit = expectUnit("herbal-warming-patch", "pack-8");

    assert.equal(r.lines[0].unitPriceCents, braceUnit);
    assert.equal(r.lines[0].lineTotalCents, braceUnit * 3);
    assert.equal(r.subtotalCents, braceUnit * 3 + patchUnit * 3);
    assert.equal(r.totalQty, 6);
  });

  test("the out-of-stock variant in the real data is refused", () => {
    const r = priceOrder(ctx(), {
      items: [{ productSlug: "herbal-warming-patch", variantId: "pack-24", qty: 1 }],
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "out_of_stock");
  });

  // Overrides the switch rather than reading it. Whether postage is currently
  // charged is the owner's decision, changed from the admin whenever a campaign
  // starts; a test that asserts today's value fails the moment they use the
  // setting as intended, which is not a defect worth reporting.
  test("switched off, real orders ship FREE", () => {
    const r = priceOrder(ctx({ enabled: false }), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 3 }],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // 0, never null: switched off means free, and the cart says so.
    assert.equal(r.shippingCents, 0);
    assert.equal(r.shippingMethod.id, "free");
  });

  test("switched on, the real settings charge once per pack", () => {
    const on = ctx({ enabled: true });
    const pack = raw.shipping.blockSize;
    const per = raw.shipping.perBlockCents;

    const one = priceOrder(on, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: pack }],
    });
    assert.equal(one.ok, true);
    if (one.ok) assert.equal(one.shippingCents, per);

    const two = priceOrder(on, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: pack * 2 }],
    });
    assert.equal(two.ok, true);
    if (two.ok) assert.equal(two.shippingCents, per * 2);
  });
});
