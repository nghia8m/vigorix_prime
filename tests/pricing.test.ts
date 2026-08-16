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

const LIMITS = { minOrderQty: 1, maxQtyPerLine: 99, minQtyPerLine: 1 };

const ctx = (shipping: PricingContext["shipping"]): PricingContext => ({
  catalogue: structuredClone(CATALOGUE),
  shipping,
  limits: LIMITS,
});

const SHIP_OFF = { enabled: false, perBlockCents: 2500, blockSize: 3 };
const SHIP_ON = { enabled: true, perBlockCents: 2500, blockSize: 3 };

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
    const strict: PricingContext = {
      ...ctx(SHIP_OFF),
      limits: { minOrderQty: 3, maxQtyPerLine: 99, minQtyPerLine: 1 },
    };
    const r = rejected(priceOrder(strict, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 2 }],
    }));
    assert.equal(r.code, "below_minimum");
  });

  test("a line below the per-product minimum", () => {
    const packs: PricingContext = {
      ...ctx(SHIP_OFF),
      limits: { minOrderQty: 1, maxQtyPerLine: 99, minQtyPerLine: 4 },
    };
    const r = rejected(priceOrder(packs, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 3 }],
    }));
    assert.equal(r.code, "below_line_minimum");
    assert.equal(r.at, 0);
  });

  // The whole point of a per-line minimum. Four items, four lines, one each:
  // the order total says 4, every line says 1, and it must still be refused.
  // Summing the order instead of checking the lines would let this through.
  test("four different products, one each, does NOT satisfy a minimum of four", () => {
    const packs: PricingContext = {
      ...ctx(SHIP_OFF),
      limits: { minOrderQty: 4, maxQtyPerLine: 99, minQtyPerLine: 4 },
    };
    const r = rejected(priceOrder(packs, {
      items: [
        { productSlug: "knee-support-brace", variantId: "size-s", qty: 1 },
        { productSlug: "knee-support-brace", variantId: "size-m", qty: 1 },
        { productSlug: "herbal-warming-patch", variantId: "pack-8", qty: 1 },
        { productSlug: "single-item-no-variants", variantId: "", qty: 1 },
      ],
    }));
    assert.equal(r.code, "below_line_minimum");
  });

  // The stepper only offers multiples, so this can only arrive from a
  // hand-built request — which is exactly why the server has to catch it.
  test("a quantity between two packs is refused", () => {
    const packs: PricingContext = {
      ...ctx(SHIP_OFF),
      limits: { minOrderQty: 1, maxQtyPerLine: 99, minQtyPerLine: 4 },
    };
    const r = rejected(priceOrder(packs, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 6 }],
    }));
    assert.equal(r.code, "not_whole_packs");
  });

  test("two whole packs are accepted", () => {
    const packs: PricingContext = {
      ...ctx(SHIP_OFF),
      limits: { minOrderQty: 1, maxQtyPerLine: 99, minQtyPerLine: 4 },
    };
    const r = priceOrder(packs, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 8 }],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.totalQty, 8);
  });

  test("exactly the per-product minimum is accepted", () => {
    const packs: PricingContext = {
      ...ctx(SHIP_OFF),
      limits: { minOrderQty: 1, maxQtyPerLine: 99, minQtyPerLine: 4 },
    };
    const r = priceOrder(packs, {
      items: [{ productSlug: "knee-support-brace", variantId: "size-s", qty: 4 }],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.totalQty, 4);
  });


  // The campaign must not eat the configured rate: switching it off has to
  // bring the real postage back without anyone retyping it.

});

describe("shipping — one charge per pack", () => {
  const P = (qty: number) => [{ productSlug: "knee-support-brace", variantId: "size-s", qty }];

  test("switched off means FREE, and free is a number not a blank", () => {
    const r = priceOrder(ctx(SHIP_OFF), { items: P(3) });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.shippingCents, 0);
      assert.equal(r.shippingMethod.id, "free");
      assert.equal(r.totalCents, r.subtotalCents);
    }
  });

  test("one pack pays one charge", () => {
    const r = priceOrder(ctx(SHIP_ON), { items: P(3) });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.shippingCents, 2500);
  });

  test("two packs pay two charges", () => {
    const r = priceOrder(ctx(SHIP_ON), { items: P(6) });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.shippingCents, 5000);
  });

  // Packs of different products still count together: postage follows the
  // number of items leaving the warehouse, not the number of product lines.
  test("three of one plus three of another is two charges, not one", () => {
    const r = priceOrder(ctx(SHIP_ON), {
      items: [
        { productSlug: "knee-support-brace", variantId: "size-s", qty: 3 },
        { productSlug: "herbal-warming-patch", variantId: "pack-8", qty: 3 },
      ],
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.totalQty, 6);
      assert.equal(r.shippingCents, 5000);
    }
  });

  // A big order must not silently ship for one charge.
  test("nine items pay three charges", () => {
    const r = priceOrder(ctx(SHIP_ON), { items: P(9) });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.shippingCents, 7500);
  });

  // Packs are enforced elsewhere, so a part pack cannot arrive through the
  // shop. If it ever did, it must round UP — never ship four for the price of
  // three.
  test("a part pack rounds up rather than down", () => {
    const noPacks: PricingContext = {
      ...ctx(SHIP_ON),
      limits: { minOrderQty: 1, maxQtyPerLine: 99, minQtyPerLine: 1 },
    };
    const r = priceOrder(noPacks, { items: P(4) });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.shippingCents, 5000);
  });

  test("the total is subtotal plus postage", () => {
    const r = priceOrder(ctx(SHIP_ON), { items: P(3) });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.totalCents, r.subtotalCents + 2500);
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
