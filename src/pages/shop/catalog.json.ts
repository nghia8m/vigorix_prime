import type { APIRoute } from "astro";
import { getShopProducts } from "../../lib/products";
import { CART_CONFIG, readShipping } from "../../lib/cart-config";
import site from "../../data/site.json";

/**
 * Static product catalogue for the client-side cart.
 *
 * The cart stores only { productSlug, variantId, qty }. Everything a line needs
 * to render — name, price, image, variant label, stock — is looked up here on
 * every render, so a price or name edited in the admin shows up in an open cart
 * on the next load instead of the cart quietly holding a stale copy.
 *
 * Money is emitted as INTEGER CENTS. All cart arithmetic is done on integers and
 * formatted only for display, so 29.99 x 3 cannot drift.
 *
 * Draft products are excluded exactly as they are from the pages themselves
 * (getShopProducts), so a draft can never be added to a cart in production.
 */
export const GET: APIRoute = async () => {
  const products = await getShopProducts();
  const cents = (n: number) => Math.round(n * 100);

  const payload = {
    config: CART_CONFIG,
    // Shipping policy comes from Admin → Site Settings, not from code, so the
    // owner can turn it on and set the rate without a developer.
    shipping: readShipping((site as Record<string, unknown>).shipping),
    products: Object.fromEntries(
      products.map((p) => {
        const d = p.data;
        const cover = d.images[0];
        return [
          d.slug,
          {
            slug: d.slug,
            name: d.name,
            path: `/shop/${d.slug}`,
            priceCents: cents(d.price),
            compareAtCents: d.compareAt === null ? null : cents(d.compareAt),
            currency: d.currency,
            stock: d.stock,
            variantType: d.variantType,
            image: cover?.url ?? "",
            imageAlt: cover?.alt ?? "",
            variants: d.variants.map((v) => ({
              id: v.id,
              label: v.label,
              value: v.value,
              priceDeltaCents: cents(v.priceDelta),
              sku: v.sku,
              stock: v.stock,
              image: d.images[v.imageIndex]?.url ?? cover?.url ?? "",
            })),
          },
        ];
      })
    ),
  };

  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
};
