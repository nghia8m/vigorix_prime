// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import cloudflare from "@astrojs/cloudflare";
import { draftGuard } from "./scripts/draft-guard.mjs";
import { slugGuard } from "./scripts/slug-guard.mjs";
import { cloudflareRoutes } from "./scripts/cf-routes.mjs";

// STILL A STATIC SITE. The adapter is here only so individual API routes can
// opt into running on the server with `export const prerender = false`.
// Every page stays prerendered at build time — that is what keeps SEO 100 and
// CLS 0 — and nothing else becomes dynamic by adding this.
export default defineConfig({
  site: "https://vigorixprime.com",
  trailingSlash: "ignore",
  output: "static",
  // platformProxy gives `astro dev` the same runtime bindings the Worker gets
  // in production (D1 and friends), backed by local miniflare state in
  // .wrangler/state — no Cloudflare account and no remote database involved.
  adapter: cloudflare({
    imageService: "passthrough",
    platformProxy: { enabled: true },
  }),
  // mdx        -> long-form product descriptions live in the body of
  //               src/content/products/*.mdx (rendered to static HTML).
  // draftGuard -> aborts a production build while any product is draft: true.
  // slugGuard  -> aborts ANY build when two products claim the same /shop URL,
  //               which the content loader would otherwise resolve by silently
  //               dropping one of them.
  integrations: [mdx(), slugGuard(), draftGuard(), cloudflareRoutes()],

  vite: {
    server: {
      // PayPal webhooks cannot reach localhost, so testing them means exposing
      // the dev server through a temporary cloudflared tunnel. Vite refuses
      // unknown Host headers by default, which blocks exactly that. Dev-server
      // setting only — it has no effect on the built site.
      allowedHosts: [".trycloudflare.com"],
    },
  },
});
