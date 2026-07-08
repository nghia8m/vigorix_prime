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

export const collections = { articles };
