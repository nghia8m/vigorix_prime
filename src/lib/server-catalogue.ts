/**
 * Builds the pricing catalogue the server trusts, straight from the content
 * collection and site.json. This is the ONLY thing that feeds prices into
 * src/lib/pricing.ts in production.
 */
import { getCollection } from "astro:content";
import site from "../data/site.json";
import { CART_CONFIG, readShipping } from "./cart-config";
import type { Catalogue, PricingContext, ShippingSettings } from "./pricing";

const cents = (n: number) => Math.round(n * 100);

/** Shape of one product entry as far as pricing is concerned. */
type ProductLike = {
  data: {
    slug: string;
    name: string;
    price: number;
    stock: "in" | "out" | "preorder";
    draft: boolean;
    variants: Array<{
      id: string;
      label: string;
      priceDelta: number;
      sku: string;
      stock: "in" | "out" | "preorder";
    }>;
  };
};

/** Pure so it can be exercised with fixtures in the unit tests. */
export function toCatalogue(entries: ProductLike[]): Catalogue {
  const out: Catalogue = {};
  for (const entry of entries) {
    const d = entry.data;
    out[d.slug] = {
      slug: d.slug,
      name: d.name,
      priceCents: cents(d.price),
      stock: d.stock,
      variants: d.variants.map((v) => ({
        id: v.id,
        label: v.label,
        priceDeltaCents: cents(v.priceDelta),
        sku: v.sku,
        stock: v.stock,
      })),
    };
  }
  return out;
}

export function shippingSettings(): ShippingSettings {
  const s = readShipping((site as Record<string, unknown>).shipping);
  return {
    enabled: s.enabled,
    freeOverCents: s.freeOverCents,
    rates: s.rates.map((r) => ({ id: r.id, label: r.label, flatCents: r.flatCents })),
  };
}

/**
 * Production entry point. Draft products are excluded exactly as they are from
 * the shop pages, so a placeholder can never be priced and sold.
 */
export async function loadPricingContext(): Promise<PricingContext> {
  const products = (await getCollection("products", ({ data }) => !data.draft)) as unknown as ProductLike[];
  return {
    catalogue: toCatalogue(products),
    shipping: shippingSettings(),
    limits: {
      minOrderQty: CART_CONFIG.MIN_ORDER_QTY,
      maxQtyPerLine: CART_CONFIG.MAX_QTY_PER_LINE,
    },
  };
}
