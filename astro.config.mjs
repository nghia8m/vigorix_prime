// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import { draftGuard } from "./scripts/draft-guard.mjs";

// Static site (default output). Deploys to Cloudflare Pages as static assets.
export default defineConfig({
  site: "https://vigorixprime.com",
  trailingSlash: "ignore",
  // mdx        -> long-form product descriptions live in the body of
  //               src/content/products/*.mdx (rendered to static HTML).
  // draftGuard -> aborts a production build while any product is draft: true.
  integrations: [mdx(), draftGuard()],
});
