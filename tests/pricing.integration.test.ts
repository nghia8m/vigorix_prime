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
      freeOverCents: raw.shipping.freeOverCents,
      rates: (raw.shipping.rates ?? []).map((r: any) => ({ id: r.id, label: r.label, flatCents: r.flatCents })),
      ...shippingOverride,
    },
    limits: { minOrderQty: raw.config.MIN_ORDER_QTY, maxQtyPerLine: raw.config.MAX_QTY_PER_LINE },
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
        { productSlug: "knee-support-brace", variantId: "size-l", qty: 2 },
        { productSlug: "herbal-warming-patch", variantId: "pack-8", qty: 1 },
      ],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // 2900 + 400 = 3300 each, plus a 1900 patch pack
    assert.equal(r.lines[0].unitPriceCents, 3300);
    assert.equal(r.subtotalCents, 3300 * 2 + 1900);
    assert.equal(r.totalQty, 3);
  });

  test("the out-of-stock variant in the real data is refused", () => {
    const r = priceOrder(ctx(), {
      items: [{ productSlug: "herbal-warming-patch", variantId: "pack-24", qty: 1 }],
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "out_of_stock");
  });

  test("shipping is currently switched off, so real orders return null", () => {
    const r = priceOrder(ctx(), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(raw.shipping.enabled, false);
    assert.equal(r.shippingCents, null);
  });

  test("with the real rate switched on, the threshold still excludes $50.00", () => {
    const on = ctx({ enabled: true });
    // 2 braces at $29.00 = $58.00 -> above $50.00, ships free
    const above = priceOrder(on, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 2 }],
    });
    assert.equal(above.ok, true);
    if (above.ok) {
      assert.equal(above.subtotalCents, 5800);
      assert.equal(above.shippingCents, 0);
    }
    // 1 brace at $29.00 -> below, pays the configured flat rate
    const below = priceOrder(on, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }],
    });
    assert.equal(below.ok, true);
    if (below.ok) {
      assert.equal(below.shippingCents, raw.shipping.rates[0].flatCents);
    }
  });
});
