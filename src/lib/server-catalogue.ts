/**
 * Builds the pricing catalogue the server trusts, straight from the content
 * collection and site.json. This is the ONLY thing that feeds prices into
 * src/lib/pricing.ts in production.
 */
import { getShopProducts } from "./products";
import site from "../data/site.json";
import { CART_CONFIG, readShipping, readOrdering } from "./cart-config";
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
    perBlockCents: s.perBlockCents,
    // One charge per pack: the pack is what gets boxed, so it is what gets
    // posted. Reading it from the ordering rules keeps the two from drifting
    // apart — "$25 per 3" cannot survive somebody changing the pack to 4.
    blockSize: readOrdering((site as Record<string, unknown>).ordering).minQtyPerProduct,
  };
}

/**
 * Production entry point.
 *
 * Visibility comes from getShopProducts() — the same rule the shop pages use —
 * so what can be bought is exactly what can be seen. In production that
 * excludes drafts; a build containing one fails outright (scripts/draft-guard),
 * so a placeholder can never be priced and sold. Locally it means a draft you
 * can put in the cart is also a draft you can check out, instead of the server
 * silently refusing every order with "no such product".
 */
export async function loadPricingContext(mode?: "sandbox" | "live"): Promise<PricingContext> {
  let products = (await getShopProducts()) as unknown as ProductLike[];

  // Belt and braces for real money. getShopProducts() lets drafts through in
  // dev and in build:preview; if that output were ever deployed with live
  // credentials, a placeholder product would be sellable. Under live mode
  // drafts are dropped here no matter what ALLOW_DRAFT_PRODUCTS said at build
  // time.
  if (mode === "live") {
    const before = products.length;
    products = products.filter((p) => !p.data.draft);
    if (products.length !== before) {
      console.error(
        "[VP-DRAFT-IN-LIVE] Dropped",
        before - products.length,
        "draft product(s) from a LIVE pricing context — this build should never have been deployed."
      );
    }
  }

  return {
    catalogue: toCatalogue(products),
    shipping: shippingSettings(),
    limits: {
      minOrderQty: CART_CONFIG.MIN_ORDER_QTY,
      maxQtyPerLine: CART_CONFIG.MAX_QTY_PER_LINE,
      minQtyPerLine: readOrdering((site as Record<string, unknown>).ordering).minQtyPerProduct,
    },
  };
}
