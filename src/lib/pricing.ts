/* ===========================================================================
   Server-side order pricing — the authority on what an order costs.
   ---------------------------------------------------------------------------
   THE ONE RULE: money is never an input.

   `PriceRequest` below has no field that can carry an amount. Prices come from
   the catalogue the server built from the content collection, shipping comes
   from the server's copy of site.json. If a client sends a total it can only be
   COMPARED (see `verifyClientTotal`) — never used.

   Deliberately dependency-free so it can be unit tested with plain `node --test`
   and cannot quietly reach for request data through some import.
   =========================================================================== */

export interface CatalogueVariant {
  id: string;
  label: string;
  priceDeltaCents: number;
  sku: string;
  stock: "in" | "out" | "preorder";
}

export interface CatalogueProduct {
  slug: string;
  name: string;
  priceCents: number;
  stock: "in" | "out" | "preorder";
  variants: CatalogueVariant[];
}

export type Catalogue = Record<string, CatalogueProduct>;

export interface ShippingSettings {
  /**
   * OFF means FREE, not "unknown". There is no third state any more: either the
   * order is charged per pack, or it ships free and the cart says so.
   */
  enabled: boolean;
  /** Charged once per pack of `blockSize` items. 2500 = $25.00. */
  perBlockCents: number;
  /**
   * Items covered by one charge. Follows the per-product pack size, because a
   * pack is the unit the warehouse actually boxes and posts — 3 items in, one
   * parcel out.
   */
  blockSize: number;
}

export interface PricingLimits {
  minOrderQty: number;
  maxQtyPerLine: number;
  /**
   * Smallest quantity of ONE product an order may contain, applied per line.
   * Four different products, one each, does NOT satisfy a minimum of 4 — the
   * rule exists because stock is bought by the box, so it has to bite on the
   * line rather than on the order.
   */
  minQtyPerLine: number;
}

/** Everything the client is allowed to influence. Note: no prices. */
export interface PriceRequestItem {
  productSlug: string;
  variantId: string;
  qty: number;
}

export interface PriceRequest {
  items: PriceRequestItem[];
}

export interface PricedLine {
  productSlug: string;
  variantId: string;
  name: string;
  variantLabel: string;
  sku: string;
  unitPriceCents: number;
  qty: number;
  lineTotalCents: number;
}

export type PriceFailure = {
  ok: false;
  code:
    | "empty_order"
    | "invalid_item"
    | "unknown_product"
    | "unknown_variant"
    | "variant_required"
    | "unexpected_variant"
    | "invalid_quantity"
    | "out_of_stock"
    | "duplicate_line"
    | "below_minimum"
    | "below_line_minimum"
    | "not_whole_packs";
  message: string;
  at?: number;
};

export type PriceSuccess = {
  ok: true;
  lines: PricedLine[];
  subtotalCents: number;
  /** Always a number. 0 means free — there is no "undecided" shipping state. */
  shippingCents: number;
  totalCents: number;
  shippingMethod: { id: string; label: string };
  totalQty: number;
};

export type PriceResult = PriceSuccess | PriceFailure;

export interface PricingContext {
  catalogue: Catalogue;
  shipping: ShippingSettings;
  limits: PricingLimits;
}

const fail = (code: PriceFailure["code"], message: string, at?: number): PriceFailure => ({
  ok: false,
  code,
  message,
  ...(at === undefined ? {} : { at }),
});

/** Whole number, at least 1, no more than the per-line ceiling. */
function checkQty(qty: unknown, max: number): string | null {
  if (typeof qty !== "number" || !Number.isFinite(qty)) return "Quantity must be a number.";
  if (!Number.isInteger(qty)) return "Quantity must be a whole number.";
  if (qty < 1) return "Quantity must be at least 1.";
  if (qty > max) return `Quantity must not exceed ${max}.`;
  return null;
}

export function priceOrder(ctx: PricingContext, request: PriceRequest): PriceResult {
  const items = request?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return fail("empty_order", "The order contains no items.");
  }

  const seen = new Set<string>();
  const lines: PricedLine[] = [];
  let subtotalCents = 0;
  let totalQty = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") return fail("invalid_item", "Malformed order line.", i);

    const slug = item.productSlug;
    const variantId = typeof item.variantId === "string" ? item.variantId : "";
    if (typeof slug !== "string" || !slug) {
      return fail("invalid_item", "Order line is missing a product.", i);
    }

    const key = slug + "::" + variantId;
    if (seen.has(key)) {
      return fail("duplicate_line", `The same item appears twice: ${key}.`, i);
    }
    seen.add(key);

    const product = ctx.catalogue[slug];
    if (!product) {
      return fail("unknown_product", `No such product: ${slug}.`, i);
    }

    let variant: CatalogueVariant | null = null;
    if (product.variants.length > 0) {
      if (!variantId) {
        return fail("variant_required", `${product.name} requires a variant.`, i);
      }
      variant = product.variants.find((v) => v.id === variantId) ?? null;
      if (!variant) {
        return fail("unknown_variant", `${product.name} has no variant "${variantId}".`, i);
      }
    } else if (variantId) {
      return fail("unexpected_variant", `${product.name} has no variants.`, i);
    }

    const qtyError = checkQty(item.qty, ctx.limits.maxQtyPerLine);
    if (qtyError) return fail("invalid_quantity", qtyError, i);

    // Stock first. "Buy 3 of these" is useless advice about something we cannot
    // send at all, so the pack rules below only run once we know the item can
    // actually be shipped.
    const stock = variant ? variant.stock : product.stock;
    if (stock === "out") {
      return fail(
        "out_of_stock",
        `${product.name}${variant ? ` (${variant.label})` : ""} is out of stock.`,
        i
      );
    }

    // Per-line minimum, checked here rather than against the order total: four
    // different products at one each must NOT pass a minimum of four.
    const minLine = ctx.limits.minQtyPerLine;
    if (minLine > 1) {
      const label = `${product.name}${variant ? ` (${variant.label})` : ""}`;
      if (item.qty < minLine) {
        return fail(
          "below_line_minimum",
          `${label} is sold in packs of ${minLine}; this order has ${item.qty}. ` +
            `Different products cannot be combined to reach it.`,
          i
        );
      }
      // Whole packs only. Without this the rule is decoration: the stepper
      // offers 4, 8, 12, but a request built by hand could still ask for 6 and
      // be charged for a quantity the warehouse cannot pick.
      if (item.qty % minLine !== 0) {
        return fail(
          "not_whole_packs",
          `${label} is sold in packs of ${minLine}, so the quantity must be a multiple of ` +
            `${minLine}; this order has ${item.qty}.`,
          i
        );
      }
    }

    // The only place a unit price is ever produced: catalogue + variant delta.
    const unitPriceCents = product.priceCents + (variant ? variant.priceDeltaCents : 0);
    const lineTotalCents = unitPriceCents * item.qty;

    lines.push({
      productSlug: slug,
      variantId,
      name: product.name,
      variantLabel: variant ? variant.label : "",
      sku: variant ? variant.sku : "",
      unitPriceCents,
      qty: item.qty,
      lineTotalCents,
    });

    subtotalCents += lineTotalCents;
    totalQty += item.qty;
  }

  if (totalQty < ctx.limits.minOrderQty) {
    return fail(
      "below_minimum",
      `Orders must contain at least ${ctx.limits.minOrderQty} item(s); this one has ${totalQty}.`
    );
  }

  // ---- shipping, computed here and never accepted from the client ----------
  //
  // One charge per pack, rounded UP: 3 items is one charge, 4 would be two.
  // With packs enforced above, the total is always a whole number of packs, so
  // the rounding never actually bites — it is here so that turning packs off
  // cannot silently start shipping four items for the price of three.
  //
  // Switched off means FREE (0), never null. There is no "we have not decided"
  // state left to render.
  const blockSize = Math.max(1, Math.floor(ctx.shipping.blockSize) || 1);
  const blocks = Math.ceil(totalQty / blockSize);
  const shippingCents = ctx.shipping.enabled
    ? blocks * Math.max(0, Math.round(ctx.shipping.perBlockCents))
    : 0;
  const shippingMethod = ctx.shipping.enabled
    ? { id: "per-pack", label: `${blocks} × pack postage` }
    : { id: "free", label: "Free shipping" };

  return {
    ok: true,
    lines,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    shippingMethod,
    totalQty,
  };
}

/**
 * Compares a total the client claimed against the server's own figure.
 * Used only to detect tampering and refuse the order — the client number is
 * never adopted, whatever it says.
 */
export function verifyClientTotal(
  server: PriceSuccess,
  claimedTotalCents: unknown
): { match: boolean; serverTotalCents: number; claimed: unknown } {
  return {
    match: typeof claimedTotalCents === "number" && claimedTotalCents === server.totalCents,
    serverTotalCents: server.totalCents,
    claimed: claimedTotalCents,
  };
}
