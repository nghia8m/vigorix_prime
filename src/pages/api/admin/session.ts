import type { APIRoute } from "astro";
import {
  readAdminEnv, checkConfigured, githubLogin, createSession,
  cookieHeader, clearCookieHeader, requireAdmin,
} from "../../../lib/admin-auth";

export const prerender = false;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

/** Who am I? Used by the pages to decide whether to show a login prompt. */
export const GET: APIRoute = async ({ request, locals }) => {
  const guard = await requireAdmin(request, locals);
  if (guard.response) return guard.response;
  return json({ ok: true, login: guard.login });
};

/**
 * Exchange a GitHub token for a session cookie.
 *
 * The token comes from the same OAuth worker the CMS already uses. It is
 * verified against GitHub and the resulting login must be on the allowlist —
 * being able to log in to GitHub is not by itself permission to read customer
 * addresses. The token is never stored.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = readAdminEnv(locals);
  const configured = checkConfigured(env);
  if (!configured.ok) {
    console.error("[VP-ADMIN-UNCONFIGURED]", configured.reason);
    return json({ ok: false, error: "admin_not_configured", message: configured.reason }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return json({ ok: false, error: "missing_token" }, 400);

  const who = await githubLogin(token);
  if (!who.ok) {
    console.warn("[VP-ADMIN-LOGIN-FAILED] GitHub rejected the token, status", who.status);
    return json({ ok: false, error: "github_rejected" }, 401);
  }

  if (!env.allowedLogins.includes(who.login.toLowerCase())) {
    console.warn("[VP-ADMIN-LOGIN-DENIED] GitHub user", who.login, "is not on ADMIN_GITHUB_LOGINS.");
    return json({ ok: false, error: "not_allowed", login: who.login }, 403);
  }

  const session = await createSession(env, who.login);
  return json({ ok: true, login: who.login }, 200, { "Set-Cookie": cookieHeader(session) });
};

/** Log out. */
export const DELETE: APIRoute = async () =>
  json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
