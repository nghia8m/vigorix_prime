import type { APIRoute } from "astro";
import { requireAdmin, readAdminEnv } from "../../../lib/admin-auth";

export const prerender = false;

/* ===========================================================================
   Single sign-on for the content CMS.
   ---------------------------------------------------------------------------
   Sveltia is a git-backed CMS: to save a page it must commit to the repository,
   which needs a GitHub token. Our password cookie cannot become one. So instead
   of sending the owner to GitHub, this endpoint plays the part of the OAuth
   provider: it checks the admin session that the password login already
   created, and hands Sveltia a token the SERVER holds.

   The result is one email + password for both admin screens, and the owner
   never sees GitHub.

   The trade-off, stated plainly: GITHUB_CONTENT_TOKEN can write to the
   repository, and anyone who learns the admin password can now reach it. That
   is why the password is hashed, the session is short, and this endpoint
   refuses every request that is not already signed in.
   =========================================================================== */

function readVar(locals: unknown, key: string): string {
  const rt = (locals as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env?.[key];
  if (typeof rt === "string" && rt) return rt;
  const vite = (import.meta.env as Record<string, unknown>)[key];
  if (typeof vite === "string" && vite) return vite;
  const proc = typeof process !== "undefined" ? process : undefined;
  return proc?.env?.[key] ?? "";
}

/** The handshake Sveltia/Decap expect from an OAuth popup. */
function handshakeHTML(provider: string, payload: Record<string, unknown>, state: "success" | "error") {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font:14px system-ui;padding:24px;color:#14212a">
<p>${state === "success" ? "Signed in. You can close this window." : "Sign-in failed — see the message in the CMS window."}</p>
<script>
  (() => {
    window.addEventListener('message', ({ origin }) => {
      window.opener?.postMessage('authorization:${provider}:${state}:${json}', origin);
    });
    window.opener?.postMessage('authorizing:${provider}', '*');
  })();
</script>
</body></html>`;
}

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" },
  });

export const GET: APIRoute = async ({ request, locals, url }) => {
  const provider = url.searchParams.get("provider") || "github";

  // 1. Must already be signed in with the admin password. requireAdmin also
  //    fails closed when the admin itself is unconfigured.
  const guard = await requireAdmin(request, locals);
  if (guard.response) {
    const status = guard.response.status;
    return html(
      handshakeHTML(
        provider,
        {
          provider,
          error:
            status === 503
              ? "Admin access is not configured on this server."
              : "Sign in at /admin/orders first, then try again.",
          errorCode: status === 503 ? "NOT_CONFIGURED" : "NOT_SIGNED_IN",
        },
        "error"
      ),
      status
    );
  }

  // 2. The server's own repository token.
  const token = readVar(locals, "GITHUB_CONTENT_TOKEN");
  if (!token) {
    console.error(
      "[VP-CMS-SSO-UNCONFIGURED] GITHUB_CONTENT_TOKEN is not set —",
      "the content CMS cannot sign in without it."
    );
    return html(
      handshakeHTML(
        provider,
        {
          provider,
          error:
            "GITHUB_CONTENT_TOKEN is not set on the server, so the CMS cannot save changes. " +
            "Add it to the environment, or use “Work with Local Repository” instead.",
          errorCode: "NO_CONTENT_TOKEN",
        },
        "error"
      ),
      503
    );
  }

  const env = readAdminEnv(locals);
  console.info("[VP-CMS-SSO] Issued a content token to", guard.login, "in", env.paypalMode || "unknown", "mode");

  return html(handshakeHTML(provider, { provider, token }, "success"));
};
