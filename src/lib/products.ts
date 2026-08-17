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

  // There used to be a duplicate-slug check here. It could never fire, and
  // measuring it was the only way to find that out: Astro's glob loader takes
  // an entry's id from the `slug` frontmatter field, and the content store is
  // keyed by id, so two files with the same slug arrive here already merged
  // into one. The loop saw six products where seven files existed and reported
  // everything as fine while a real product had been overwritten.
  //
  // The check now runs on the files, before the loader collapses them:
  // scripts/slug-guard.mjs, wired into astro.config.mjs. Do not reinstate a
  // version of it in this function — it reads as protection and is not.

  return products.sort((a, b) => a.data.order - b.data.order || a.data.name.localeCompare(b.data.name));
}

export const productPath = (data: Pick<ProductData, "slug">) => `${SHOP_PATH}/${data.slug}`;

export type ShopGroup = {
  id: string;
  label: string;
  note: string;
  products: Product[];
  /** True when no group in site.json claims these products. */
  undeclared: boolean;
};

/**
 * Shop products split into the groups declared in site.json → shop.groups,
 * in the order they are declared there.
 *
 * A product whose `category` matches no declared group is NOT dropped. Deleting
 * a group in the CMS, or renaming its id, would otherwise silently remove
 * products from the shop — stock that exists, is priced, and can still be
 * reached by its own URL would simply stop being listed. Those products are
 * collected into a trailing group instead, labelled from their own
 * categoryLabel, and reported by the caller.
 */
export function groupShopProducts(
  products: Product[],
  declared: { id: string; label: string; note?: string }[]
): ShopGroup[] {
  const remaining = new Map(products.map((p) => [p.id, p]));

  const groups: ShopGroup[] = declared.map((g) => {
    const mine = products.filter((p) => p.data.category === g.id);
    mine.forEach((p) => remaining.delete(p.id));
    return { id: g.id, label: g.label, note: g.note ?? "", products: mine, undeclared: false };
  });

  // Leftovers, bucketed by the category they claim so two orphaned groups do
  // not get merged into one.
  const orphans = new Map<string, Product[]>();
  for (const p of remaining.values()) {
    const key = p.data.category || "uncategorised";
    orphans.set(key, [...(orphans.get(key) ?? []), p]);
  }
  for (const [id, mine] of orphans) {
    console.warn(
      `[VP-SHOP-GROUP] ${mine.length} product(s) have category "${id}", which is not declared in ` +
        `site.json → shop.groups. They are still listed, under their own heading. ` +
        `Add the group in Site settings, or change the products' group.`
    );
    groups.push({
      id,
      label: mine[0].data.categoryLabel || id,
      note: "",
      products: mine,
      undeclared: true,
    });
  }

  return groups.filter((g) => g.products.length > 0);
}

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
