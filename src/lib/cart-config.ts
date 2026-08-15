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
   * Smallest number of items an order may contain.
   * 1 = no minimum (the "below minimum" branch never shows for shoppers).
   * The reference project used 3; that suits a repeat-purchase gel, not knee
   * braces and patches, so it is deliberately not copied here.
   */
  MIN_ORDER_QTY: 1,

  /** Guard rail for a single line, so a typo cannot order 10,000 patches. */
  MAX_QTY_PER_LINE: 99,

  /** localStorage key. Versioned so a future shape change can migrate cleanly. */
  STORAGE_KEY: "vp.cart.v1",
} as const;

/** Shape of the "shipping" block in src/data/site.json. */
export interface ShippingRate {
  id: string;
  label: string;
  flatCents: number;
  etaDays: string;
}

export interface ShippingSettings {
  /** false until a real shipping policy exists — the cart then shows displayNote
   *  instead of inventing a number. */
  enabled: boolean;
  displayNote: string;
  currency: string;
  /** Free shipping applies STRICTLY ABOVE this amount: 5000 means $50.00 still
   *  pays postage, $50.01 does not. */
  freeOverCents: number;
  rates: ShippingRate[];
}

const FALLBACK: ShippingSettings = {
  enabled: false,
  displayNote: "Shipping calculated at checkout",
  currency: "USD",
  freeOverCents: 0,
  rates: [],
};

/** Reads the block defensively — a half-edited site.json must not break the cart. */
export function readShipping(raw: unknown): ShippingSettings {
  const s = (raw ?? {}) as Partial<ShippingSettings>;
  const rates = Array.isArray(s.rates) ? s.rates : [];
  return {
    enabled: s.enabled === true,
    displayNote:
      typeof s.displayNote === "string" && s.displayNote.trim()
        ? s.displayNote
        : FALLBACK.displayNote,
    currency: typeof s.currency === "string" && s.currency ? s.currency : FALLBACK.currency,
    freeOverCents: Number.isFinite(Number(s.freeOverCents))
      ? Math.max(0, Math.round(Number(s.freeOverCents)))
      : 0,
    rates: rates
      .filter((r) => r && typeof r.id === "string" && r.id)
      .map((r) => ({
        id: r.id,
        label: typeof r.label === "string" ? r.label : r.id,
        flatCents: Number.isFinite(Number(r.flatCents)) ? Math.max(0, Math.round(Number(r.flatCents))) : 0,
        etaDays: typeof r.etaDays === "string" ? r.etaDays : "",
      })),
  };
}
