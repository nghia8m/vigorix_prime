// @ts-check
import { defineConfig } from "astro/config";

// Static site (default output). Deploys to Cloudflare Pages as static assets.
export default defineConfig({
  site: "https://vigorixprime.com",
  trailingSlash: "ignore",
});
