// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import cloudflare from "@astrojs/cloudflare";
import { draftGuard } from "./scripts/draft-guard.mjs";
import { cloudflareRoutes } from "./scripts/cf-routes.mjs";

// STILL A STATIC SITE. The adapter is here only so individual API routes can
// opt into running on the server with `export const prerender = false`.
// Every page stays prerendered at build time — that is what keeps SEO 100 and
// CLS 0 — and nothing else becomes dynamic by adding this.
export default defineConfig({
  site: "https://vigorixprime.com",
  trailingSlash: "ignore",
  output: "static",
  adapter: cloudflare({ imageService: "passthrough" }),
  // mdx        -> long-form product descriptions live in the body of
  //               src/content/products/*.mdx (rendered to static HTML).
  // draftGuard -> aborts a production build while any product is draft: true.
  integrations: [mdx(), draftGuard(), cloudflareRoutes()],
});
