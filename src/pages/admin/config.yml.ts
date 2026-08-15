import type { APIRoute } from "astro";
import raw from "../../data/cms-config.yml?raw";

export const prerender = false;

/**
 * Serves the CMS configuration with `base_url` set to whatever origin the
 * request arrived on.
 *
 * It has to be dynamic: the OAuth base URL now points back at this same site
 * (see /api/admin/git-auth), and that is http://localhost:4321 in development
 * and https://vigorixprime.com in production. A hard-coded value would work in
 * exactly one of the two.
 */
export const GET: APIRoute = async ({ url }) => {
  const body = raw.replace("SITE_ORIGIN_PLACEHOLDER", url.origin);

  return new Response(body, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
