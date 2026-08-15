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

export interface ShippingRate {
  id: string;
  label: string;
  flatCents: number;
}

export interface ShippingSettings {
  enabled: boolean;
  freeOverCents: number;
  rates: ShippingRate[];
}

export interface PricingLimits {
  minOrderQty: number;
  maxQtyPerLine: number;
}

/** Everything the client is allowed to influence. Note: no prices. */
export interface PriceRequestItem {
  productSlug: string;
  variantId: string;
  qty: number;
}

export interface PriceRequest {
  items: PriceRequestItem[];
  /** Which shipping rate the shopper picked; the AMOUNT is looked up here. */
  shippingRateId?: string | null;
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
    | "unknown_shipping_rate"
    | "below_minimum";
  message: string;
  at?: number;
};

export type PriceSuccess = {
  ok: true;
  lines: PricedLine[];
  subtotalCents: number;
  /** null when no shipping policy is switched on — not zero, which means free. */
  shippingCents: number | null;
  totalCents: number;
  shippingMethod: { id: string; label: string } | null;
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

    const stock = variant ? variant.stock : product.stock;
    if (stock === "out") {
      return fail(
        "out_of_stock",
        `${product.name}${variant ? ` (${variant.label})` : ""} is out of stock.`,
        i
      );
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

  // ---- shipping, also looked up rather than accepted -----------------------
  let shippingCents: number | null = null;
  let shippingMethod: { id: string; label: string } | null = null;

  if (ctx.shipping.enabled) {
    const rates = ctx.shipping.rates;
    const wanted = request.shippingRateId;
    let rate: ShippingRate | undefined;
    if (wanted) {
      rate = rates.find((r) => r.id === wanted);
      if (!rate) return fail("unknown_shipping_rate", `No such shipping rate: ${wanted}.`);
    } else {
      rate = rates[0];
    }
    if (!rate) return fail("unknown_shipping_rate", "Shipping is enabled but no rates are configured.");

    shippingMethod = { id: rate.id, label: rate.label };
    // STRICTLY above: a $50.00 order still pays postage, $50.01 does not.
    shippingCents = subtotalCents > ctx.shipping.freeOverCents ? 0 : rate.flatCents;
  }

  return {
    ok: true,
    lines,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + (shippingCents ?? 0),
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
