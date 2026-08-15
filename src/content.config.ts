import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Each article is a Markdown file in src/content/articles/.
// All structured data lives in the frontmatter so Sveltia CMS can edit it
// with friendly form widgets. The comparison table and the Product/FAQ
// JSON-LD are generated from `products`/`faqs`, so each piece of data has a
// single source of truth.
const articles = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/articles" }),
  schema: z.object({
    title: z.string(), // H1, e.g. "Best Testosterone Booster Supplements in 2025"
    metaTitle: z.string().max(70),
    metaDescription: z.string().max(165),
    category: z.string(), // "Supplements" | "Performance" | "Vitality" | "Grooming"
    categoryLink: z.string().default("/supplements"),
    ogImage: z.string().optional(), // social share image (defaults to cardImage)
    cardImage: z.string().optional(), // image shown on homepage / category cards
    cardTitle: z.string().optional(), // short title on cards (defaults to title)
    cardSummary: z.string(), // short text for homepage card
    publishedLabel: z.string().default("Updated 2025"),
    readTime: z.string().default("8 min read"),
    intro: z.string(),
    priceNote: z
      .string()
      .default(
        "*Approximate prices for reference only. Confirm the current price on the retailer's page before buying."
      ),
    quickPick: z.object({
      name: z.string(),
      reason: z.string(),
    }),
    products: z
      .array(
        z.object({
          name: z.string(),
          award: z.string(), // "Best Overall", "Best Budget", ...
          // Affiliate link the admin pastes per product (single source of truth).
          // Empty string => button stays inert (href="#"), so we never ship a
          // broken or non-compliant link before approval.
          affiliateUrl: z.string().default(""),
          price: z.string().default("Check latest"), // display label, e.g. "~$40"
          rating: z.string().default(""), // display label, e.g. "4.8 / 5"
          bestFor: z.string().default(""), // comparison-table "Best For" cell
          image: z.string().optional(),
          description: z.string(),
          pros: z.array(z.string()),
          cons: z.array(z.string()),
          // Optional numeric fields that feed Product/aggregateRating JSON-LD.
          priceValue: z.string().default(""), // e.g. "40" (USD)
          ratingValue: z.string().default(""), // e.g. "4.8"
          ratingCount: z.string().default(""), // e.g. "212"
          reviewBody: z.string().default(""), // 1-2 sentence editorial summary
        })
      )
      .min(1),
    faqs: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
    conclusion: z.string(),
    order: z.number().default(99), // homepage ordering (lower = earlier)
    draft: z.boolean().default(false),
  }),
});

// ---------------------------------------------------------------------------
// PRODUCTS — items Vigorix Prime sells itself ("Health Care" range).
// ---------------------------------------------------------------------------
// Deliberately a SEPARATE collection from `articles`. Own-brand stock is never
// mixed into the editorial rankings, the Editor's Best Picks strip, or the
// ItemList/Review JSON-LD of any "Best ..." roundup — see /affiliate-disclosure.
//
// Frontmatter = structured data (edited with form widgets in Sveltia CMS).
// Body        = the long description (headings, images, lists, FAQ), rendered
//               to static HTML at build time so it is in the source HTML.
const products = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/products" }),
  schema: z.object({
    // Route segment: /shop/<slug>. Kept in frontmatter (not derived from the
    // filename) so the CMS owns the URL and it can be changed deliberately.
    slug: z.string(),
    name: z.string(),
    subtitle: z.string().default(""), // one-line description used on cards
    metaTitle: z.string().max(70),
    metaDescription: z.string().max(165),
    category: z.string().default("health-care"),
    categoryLabel: z.string().default("Health Care"),

    // Money is stored as numbers so price + priceDelta * qty is arithmetic in
    // exactly one place, never string surgery.
    price: z.number(),
    compareAt: z.number().nullable().default(null), // struck-through "was" price
    currency: z.string().default("USD"),

    badges: z.array(z.string()).default([]),
    sku: z.string().default(""),

    // Variants. One page per item, never one page per size/colour — near-identical
    // pages compete with each other in search and Google keeps only one.
    variantType: z.enum(["size", "color", "pack"]).nullable().default(null),
    variantLegend: z.string().default(""), // <legend> text, e.g. "Choose a size"
    variants: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(), // shown on the control, e.g. "Medium"
          value: z.string(), // used in the URL query, e.g. "m"
          priceDelta: z.number().default(0), // added to `price`
          sku: z.string().default(""),
          stock: z.enum(["in", "out", "preorder"]).default("in"),
          // Index into `images` to show as the main image for this variant.
          imageIndex: z.number().default(0),
          // Optional per-variant destination; falls back to `purchaseUrl`.
          purchaseUrl: z.string().default(""),
        })
      )
      .default([]),

    images: z
      .array(
        z.object({
          url: z.string(),
          alt: z.string(),
          width: z.number(),
          height: z.number(),
          // Optional modern formats; when present they are emitted as <source>
          // elements ahead of the `url` fallback.
          avif: z.string().default(""),
          webp: z.string().default(""),
        })
      )
      .min(1),
    video: z.object({ url: z.string(), poster: z.string().default("") }).nullable().default(null),

    specs: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    trust: z
      .array(
        z.object({
          icon: z.enum(["shield", "truck", "refresh", "support", "leaf", "lock"]).default("shield"),
          title: z.string(),
          sub: z.string().default(""),
        })
      )
      .default([]),
    shipTo: z.array(z.string()).default([]),
    stock: z.enum(["in", "out", "preorder"]).default("in"),

    // PHASE 1: an external checkout URL. PHASE 2: swap for an internal route.
    // This is the single configuration point for "where does Buy go" — no other
    // component builds a purchase destination.
    purchaseUrl: z.string().default(""),
    // Query parameter names on the destination. Left empty, the matching control
    // is HIDDEN rather than shown as a choice that silently does nothing.
    quantityParam: z.string().default(""), // e.g. "qty"
    variantParam: z.string().default(""), // e.g. "size"

    // Two-way internal linking with the editorial side: article ids (filenames
    // without .md) that are topically related to this product.
    relatedArticles: z.array(z.string()).default([]),

    order: z.number().default(99),
    // Defaults to TRUE: a newly scaffolded product cannot reach production
    // until someone deliberately clears this. See scripts/draft-guard.mjs.
    draft: z.boolean().default(true),
  }),
});

export const collections = { articles, products };
