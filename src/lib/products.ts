import { getCollection, type CollectionEntry } from "astro:content";

export type Product = CollectionEntry<"products">;
export type ProductData = Product["data"];
export type Variant = ProductData["variants"][number];

export const SHOP_PATH = "/shop";

/**
 * Drafts render in `astro dev` and in `npm run build:preview`, never in a
 * production build — that build is aborted outright by scripts/draft-guard.mjs,
 * so this filter is the second of two independent rails.
 */
const showDrafts =
  import.meta.env.DEV || process.env.ALLOW_DRAFT_PRODUCTS === "1";

/** Every shop product that may be rendered, in display order. */
export async function getShopProducts(): Promise<Product[]> {
  const products = await getCollection("products", ({ data }) => showDrafts || !data.draft);

  const seen = new Map<string, string>();
  for (const p of products) {
    const clash = seen.get(p.data.slug);
    if (clash) {
      throw new Error(
        `Duplicate product slug "${p.data.slug}" in ${clash} and ${p.id}. ` +
          `Each product needs its own /shop/<slug> URL.`
      );
    }
    seen.set(p.data.slug, p.id);
  }

  return products.sort((a, b) => a.data.order - b.data.order || a.data.name.localeCompare(b.data.name));
}

export const productPath = (data: Pick<ProductData, "slug">) => `${SHOP_PATH}/${data.slug}`;

/** Money formatting — one implementation, mirrored by the same call in client JS. */
export const formatMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);

/** The variant rendered in the static HTML: the first one that is in stock. */
export const defaultVariant = (data: ProductData): Variant | null =>
  data.variants.find((v) => v.stock === "in") ?? data.variants[0] ?? null;

/** Effective stock state given the selected variant (variant wins when present). */
export const stockOf = (data: ProductData, variant: Variant | null) =>
  variant ? variant.stock : data.stock;

/** Effective price given the selected variant. */
export const priceOf = (data: ProductData, variant: Variant | null) =>
  data.price + (variant?.priceDelta ?? 0);

/** Effective SKU given the selected variant. */
export const skuOf = (data: ProductData, variant: Variant | null) =>
  variant?.sku || data.sku;

/**
 * Where the buy button points. `purchaseUrl` (or a per-variant override) is the
 * ONLY place a destination is configured; quantity and variant are appended only
 * when the destination is known to accept them.
 */
export function buildPurchaseUrl(
  data: ProductData,
  variant: Variant | null,
  qty = 1
): string {
  const base = variant?.purchaseUrl || data.purchaseUrl;
  if (!base) return "";

  try {
    const url = new URL(base, "https://vigorixprime.com");
    if (data.variantParam && variant) url.searchParams.set(data.variantParam, variant.value);
    if (data.quantityParam && qty > 1) url.searchParams.set(data.quantityParam, String(qty));
    return url.href;
  } catch {
    return base;
  }
}

/** The external host shoppers will be handed off to, or "" when the link is internal. */
export function externalHost(url: string): string {
  if (!url) return "";
  try {
    const host = new URL(url, "https://vigorixprime.com").hostname.replace(/^www\./, "");
    return host === "vigorixprime.com" ? "" : host;
  } catch {
    return "";
  }
}
