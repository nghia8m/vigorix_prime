// ===========================================================================
// Keep Cloudflare Pages serving this site as static files.
// ---------------------------------------------------------------------------
// The adapter generates _routes.json as include:["/*"] plus an exclude list of
// every static asset — but Cloudflare caps that list at 100 entries. This site
// has far more than 100 assets, so the list is truncated and every HTML page
// falls through to the Worker: a static site paying Worker invocations on every
// request, with the latency that brings.
//
// Inverted here: the Worker is invoked ONLY for routes that actually opted out
// of prerendering (`export const prerender = false`). Everything else is served
// straight from the CDN, which is what the site was before the adapter existed.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";

/** Turns an Astro route pattern into a Cloudflare route pattern. */
function toCfPattern(route) {
  // Dynamic segments become a wildcard; Cloudflare only understands trailing *.
  const p = route.route.replace(/\[\.\.\..+?\]/g, "*").replace(/\[.+?\]/g, "*");
  return p.startsWith("/") ? p : "/" + p;
}

export function cloudflareRoutes() {
  return {
    name: "vigorix:cf-routes",
    hooks: {
      "astro:build:done": ({ routes, dir, logger }) => {
        const outDir = dir?.pathname
          ? decodeURIComponent(dir.pathname.replace(/^\/([A-Za-z]:)/, "$1"))
          : "dist";
        const file = path.join(outDir, "_routes.json");
        if (!fs.existsSync(file)) return;

        const dynamic = (routes || [])
          .filter((r) => r.prerender === false && r.type !== "redirect")
          .map(toCfPattern);

        const include = Array.from(new Set(dynamic)).sort();
        fs.writeFileSync(
          file,
          JSON.stringify({ version: 1, include, exclude: [] }, null, 2) + "\n"
        );

        logger.info(
          include.length
            ? `_routes.json rewritten — Worker handles only: ${include.join(", ")}`
            : "_routes.json rewritten — no dynamic routes, everything served statically"
        );
      },
    },
  };
}
