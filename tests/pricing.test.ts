/**
 * Unit tests for the server-side pricing authority.
 *   npm test
 *
 * Run with plain `node --test` — no bundler, no Astro runtime — which is the
 * point: the module under test has no imports, so nothing can smuggle a price
 * in through a dependency.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceOrder, verifyClientTotal } from "../src/lib/pricing.ts";
import type { PricingContext, PriceSuccess, PriceFailure } from "../src/lib/pricing.ts";

const CATALOGUE = {
  "knee-support-brace": {
    slug: "knee-support-brace",
    name: "Adjustable Knee Support Brace",
    priceCents: 2900,
    stock: "in" as const,
    variants: [
      { id: "size-s", label: "S", priceDeltaCents: 0, sku: "VP-KSB-S", stock: "in" as const },
      { id: "size-l", label: "L", priceDeltaCents: 400, sku: "VP-KSB-L", stock: "in" as const },
      { id: "size-xl", label: "XL", priceDeltaCents: 600, sku: "VP-KSB-XL", stock: "preorder" as const },
      { id: "size-xxl", label: "XXL", priceDeltaCents: 800, sku: "VP-KSB-XXL", stock: "out" as const },
    ],
  },
  "herbal-warming-patch": {
    slug: "herbal-warming-patch",
    name: "Mugwort Herbal Warming Patch",
    priceCents: 1900,
    stock: "in" as const,
    variants: [
      { id: "pack-8", label: "8 patches", priceDeltaCents: 0, sku: "VP-HWP-008", stock: "in" as const },
    ],
  },
  "single-item-no-variants": {
    slug: "single-item-no-variants",
    name: "Something With No Variants",
    priceCents: 1250,
    stock: "in" as const,
    variants: [],
  },
};

const LIMITS = { minOrderQty: 1, maxQtyPerLine: 99 };

const ctx = (shipping: PricingContext["shipping"]): PricingContext => ({
  catalogue: structuredClone(CATALOGUE),
  shipping,
  limits: LIMITS,
});

const SHIP_OFF = { enabled: false, freeOverCents: 5000, rates: [] };
const SHIP_ON = {
  enabled: true,
  freeOverCents: 5000,
  rates: [
    { id: "standard", label: "Standard", flatCents: 495 },
    { id: "express", label: "Express", flatCents: 1295 },
  ],
};

const ok = (r: ReturnType<typeof priceOrder>): PriceSuccess => {
  assert.equal(r.ok, true, "expected success, got: " + JSON.stringify(r));
  return r as PriceSuccess;
};
const rejected = (r: ReturnType<typeof priceOrder>): PriceFailure => {
  assert.equal(r.ok, false, "expected rejection, got: " + JSON.stringify(r));
  return r as PriceFailure;
};

describe("prices come only from the catalogue", () => {
  test("a price sent by the client is ignored entirely", () => {
    // The extra fields are what a tampered request would carry.
    const hostile = {
      items: [
        {
          productSlug: "knee-support-brace",
          variantId: "size-s",
          qty: 1,
          unitPriceCents: 1,
          lineTotalCents: 1,
          priceCents: 1,
        } as never,
      ],
      subtotalCents: 1,
      totalCents: 1,
    } as never;
    const r = ok(priceOrder(ctx(SHIP_OFF), hostile));
    assert.equal(r.lines[0].unitPriceCents, 2900);
    assert.equal(r.subtotalCents, 2900);
    assert.equal(r.totalCents, 2900);
  });

  test("variant priceDelta is added to the base price", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-l", qty: 2 }],
    }));
    assert.equal(r.lines[0].unitPriceCents, 3300); // 2900 + 400
    assert.equal(r.lines[0].lineTotalCents, 6600);
    assert.equal(r.subtotalCents, 6600);
  });

  test("several lines add up in integer cents", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [
        { productSlug: "knee-support-brace", variantId: "size-s", qty: 3 },
        { productSlug: "herbal-warming-patch", variantId: "pack-8", qty: 2 },
      ],
    }));
    assert.equal(r.subtotalCents, 2900 * 3 + 1900 * 2);
    assert.equal(r.totalQty, 5);
  });
});

describe("rejections", () => {
  test("unknown product slug", () => {
    const r = rejected(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "khong-ton-tai", variantId: "", qty: 1 }],
    }));
    assert.equal(r.code, "unknown_product");
  });

  test("variantId that belongs to a different product", () => {
    const r = rejected(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "herbal-warming-patch", variantId: "size-l", qty: 1 }],
    }));
    assert.equal(r.code, "unknown_variant");
  });

  test("product with variants but none given", () => {
    const r = rejected(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "", qty: 1 }],
    }));
    assert.equal(r.code, "variant_required");
  });

  test("product without variants but one given", () => {
    const r = rejected(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "single-item-no-variants", variantId: "size-s", qty: 1 }],
    }));
    assert.equal(r.code, "unexpected_variant");
  });

  for (const [label, qty] of [
    ["negative", -1],
    ["zero", 0],
    ["fractional", 1.5],
    ["above the ceiling", 100],
    ["not a number", "3" as never],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as Array<[string, number]>) {
    test(`quantity rejected: ${label} (${String(qty)})`, () => {
      const r = rejected(priceOrder(ctx(SHIP_OFF), {
        items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty }],
      }));
      assert.equal(r.code, "invalid_quantity");
    });
  }

  test("quantity exactly at the ceiling is allowed", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 99 }],
    }));
    assert.equal(r.subtotalCents, 2900 * 99);
  });

  test("out-of-stock variant", () => {
    const r = rejected(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-xxl", qty: 1 }],
    }));
    assert.equal(r.code, "out_of_stock");
  });

  test("preorder variant is allowed", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-xl", qty: 1 }],
    }));
    assert.equal(r.lines[0].unitPriceCents, 3500);
  });

  test("empty order", () => {
    assert.equal(rejected(priceOrder(ctx(SHIP_OFF), { items: [] })).code, "empty_order");
  });

  test("the same line twice", () => {
    const r = rejected(priceOrder(ctx(SHIP_OFF), {
      items: [
        { productSlug: "knee-support-brace", variantId: "size-s", qty: 1 },
        { productSlug: "knee-support-brace", variantId: "size-s", qty: 1 },
      ],
    }));
    assert.equal(r.code, "duplicate_line");
  });

  test("below the minimum order quantity", () => {
    const strict: PricingContext = { ...ctx(SHIP_OFF), limits: { minOrderQty: 3, maxQtyPerLine: 99 } };
    const r = rejected(priceOrder(strict, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 2 }],
    }));
    assert.equal(r.code, "below_minimum");
  });

  test("a shipping rate id that does not exist", () => {
    const r = rejected(priceOrder(ctx(SHIP_ON), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }],
      shippingRateId: "teleport",
    }));
    assert.equal(r.code, "unknown_shipping_rate");
  });
});

describe("shipping", () => {
  test("disabled => shippingCents is null, not zero", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }],
    }));
    assert.equal(r.shippingCents, null);
    assert.equal(r.shippingMethod, null);
    assert.equal(r.totalCents, r.subtotalCents);
  });

  test("subtotal $49.99 pays the flat rate", () => {
    const c = ctx(SHIP_ON);
    c.catalogue["knee-support-brace"].priceCents = 4999;
    const r = ok(priceOrder(c, { items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }] }));
    assert.equal(r.subtotalCents, 4999);
    assert.equal(r.shippingCents, 495);
    assert.equal(r.totalCents, 5494);
  });

  test("subtotal exactly $50.00 STILL pays (threshold is exclusive)", () => {
    const c = ctx(SHIP_ON);
    c.catalogue["knee-support-brace"].priceCents = 5000;
    const r = ok(priceOrder(c, { items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }] }));
    assert.equal(r.subtotalCents, 5000);
    assert.equal(r.shippingCents, 495);
    assert.equal(r.totalCents, 5495);
  });

  test("subtotal $50.01 ships free", () => {
    const c = ctx(SHIP_ON);
    c.catalogue["knee-support-brace"].priceCents = 5001;
    const r = ok(priceOrder(c, { items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }] }));
    assert.equal(r.subtotalCents, 5001);
    assert.equal(r.shippingCents, 0);
    assert.equal(r.totalCents, 5001);
  });

  test("the chosen rate is looked up, not taken from the request", () => {
    const r = ok(priceOrder(ctx(SHIP_ON), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }],
      shippingRateId: "express",
    }));
    assert.equal(r.shippingCents, 1295);
    assert.deepEqual(r.shippingMethod, { id: "express", label: "Express" });
  });

  test("no rate given falls back to the first configured one", () => {
    const r = ok(priceOrder(ctx(SHIP_ON), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 1 }],
    }));
    assert.equal(r.shippingMethod?.id, "standard");
  });
});

describe("client totals are compared, never adopted", () => {
  test("a tampered total does not match", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 2 }],
    }));
    const check = verifyClientTotal(r, 1);
    assert.equal(check.match, false);
    assert.equal(check.serverTotalCents, 5800);
  });

  test("an honest total matches", () => {
    const r = ok(priceOrder(ctx(SHIP_OFF), {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 2 }],
    }));
    assert.equal(verifyClientTotal(r, 5800).match, true);
  });
});
