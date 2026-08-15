import type { APIRoute } from "astro";
import {
  readAdminEnv, checkConfigured, createSession,
  cookieHeader, clearCookieHeader, requireAdmin,
} from "../../../lib/admin-auth";
import { verifyPassword } from "../../../lib/admin-password";

export const prerender = false;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

/** Who am I? Used by the pages to decide whether to show the sign-in form. */
export const GET: APIRoute = async ({ request, locals }) => {
  const guard = await requireAdmin(request, locals);
  if (guard.response) return guard.response;
  return json({ ok: true, login: guard.login });
};

/**
 * Sign in with email + password.
 *
 * The password is compared against a PBKDF2 hash; the plaintext exists only for
 * the length of this request. Both a wrong email and a wrong password give the
 * same answer and take the same work, so this cannot be used to find out which
 * email is the real one.
 */
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
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

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return json({ ok: false, error: "missing_credentials" }, 400);
  }

  // Always run the hash comparison, even when the email is wrong, so the reply
  // takes the same time either way.
  const passwordOk = await verifyPassword(password, env.passwordHash);
  const emailOk = email === env.email;

  if (!emailOk || !passwordOk) {
    console.warn(
      "[VP-ADMIN-LOGIN-FAILED] from",
      clientAddress ?? "unknown",
      "— wrong",
      !emailOk && !passwordOk ? "email and password" : !emailOk ? "email" : "password"
    );
    // Deliberately vague to the caller: naming which half was wrong tells an
    // attacker when they have found the right email.
    return json({ ok: false, error: "invalid_credentials" }, 401);
  }

  const session = await createSession(env, env.email);
  return json({ ok: true, login: env.email }, 200, { "Set-Cookie": cookieHeader(session) });
};

/** Log out. */
export const DELETE: APIRoute = async () =>
  json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
