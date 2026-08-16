/**
 * Cart rules that belong to the CODE.
 *
 * Anything the shop owner should be able to change without a developer lives in
 * src/data/site.json instead (Admin → Site Settings). Shipping is the obvious
 * case and now sits there under "shipping"; only the structural limits below
 * stay here, because changing them changes cart behaviour rather than policy.
 *
 * Both halves are emitted into /shop/catalog.json at build time and read from
 * there by public/js/cart.js, so the browser and the build always agree.
 */
export const CART_CONFIG = {
  /**
   * Smallest number of items an order may contain in TOTAL, across every line.
   * 1 = no whole-order minimum. The per-product minimum below is the rule that
   * actually bites here; this one stays at 1 so the two cannot contradict.
   */
  MIN_ORDER_QTY: 1,

  /** Guard rail for a single line, so a typo cannot order 10,000 patches. */
  MAX_QTY_PER_LINE: 99,

  /** localStorage key. Versioned so a future shape change can migrate cleanly. */
  STORAGE_KEY: "vp.cart.v1",
} as const;

/** Shape of the "ordering" block in src/data/site.json. */
export interface OrderingSettings {
  /**
   * Smallest quantity of ONE product an order may contain.
   *
   * Applied per line, never to the order total: stock is bought by the box, so
   * one of each of four products does not satisfy a minimum of four. 1 turns
   * the rule off entirely and hides every mention of it from shoppers.
   */
  minQtyPerProduct: number;
}

const ORDERING_FALLBACK: OrderingSettings = { minQtyPerProduct: 1 };

/** Reads the block defensively — a half-edited site.json must not break the cart. */
export function readOrdering(raw: unknown): OrderingSettings {
  const o = (raw ?? {}) as Partial<OrderingSettings>;
  const n = Number(o.minQtyPerProduct);
  // Anything unusable falls back to "no minimum" rather than to a guess: a
  // wrong minimum silently blocks every order in the shop.
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return ORDERING_FALLBACK;
  return { minQtyPerProduct: Math.min(n, CART_CONFIG.MAX_QTY_PER_LINE) };
}

/** Shape of the "shipping" block in src/data/site.json. */
export interface ShippingSettings {
  /**
   * OFF means FREE. There is no "not decided yet" state any more: the cart
   * either charges per pack or says Free, and both are true statements.
   */
  enabled: boolean;
  currency: string;
  /** One charge per pack of items. 2500 = $25.00. Cents, never dollars. */
  perBlockCents: number;
}

const FALLBACK: ShippingSettings = {
  enabled: false,
  currency: "USD",
  perBlockCents: 0,
};

/** Reads the block defensively — a half-edited site.json must not break the cart. */
export function readShipping(raw: unknown): ShippingSettings {
  const s = (raw ?? {}) as Partial<ShippingSettings>;
  const per = Number(s.perBlockCents);
  return {
    // Anything unreadable falls back to OFF, which now means free postage.
    // Charging a figure nobody could parse would be the worse failure.
    enabled: s.enabled === true,
    currency: typeof s.currency === "string" && s.currency ? s.currency : FALLBACK.currency,
    perBlockCents: Number.isFinite(per) ? Math.max(0, Math.round(per)) : 0,
  };
}
