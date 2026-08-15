import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { getShopProducts, productPath } from "../lib/products";

const SITE = "https://vigorixprime.com";

const STATIC_PATHS = [
  "/",
  "/supplements",
  "/performance",
  "/vitality",
  "/grooming",
  "/about",
  "/contact",
  "/affiliate-disclosure",
  "/privacy-policy",
  "/shop",
];

export const GET: APIRoute = async () => {
  const articles = await getCollection("articles", ({ data }) => !data.draft);
  const products = await getShopProducts();
  const urls = [
    ...STATIC_PATHS,
    ...articles.map((a) => `/${a.id}`),
    ...products.map((p) => productPath(p.data)),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}
</urlset>
`;

  return new Response(body, {
    headers: { "Content-Type": "application/xml" },
  });
};
