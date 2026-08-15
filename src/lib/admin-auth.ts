/**
 * Access control for the Orders screens.
 *
 * These endpoints read real customer data — names, emails, addresses, phone
 * numbers, amounts. An unprotected one is a personal-data leak to anyone who
 * learns the URL, not a UI annoyance. So:
 *
 *   • FAIL CLOSED. Missing configuration means 503, never "allow".
 *   • The session is a cookie signed with HMAC-SHA256 and short-lived.
 *   • Identity is an email + password pair. The password is stored only as a
 *     PBKDF2 hash; nothing can turn it back into the password.
 *
 * Cloudflare Access can and should sit in front of this in production as a
 * second layer. It is not a substitute: on localhost, and on any request that
 * reaches the Worker directly, this is the only gate.
 */

export const SESSION_COOKIE = "vp_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export interface AdminEnv {
  sessionSecret: string;
  email: string;
  passwordHash: string;
  paypalMode: string;
}

type RuntimeLocals = { runtime?: { env?: Record<string, unknown> } };

function readVar(locals: unknown, key: string): string {
  const rt = (locals as RuntimeLocals | undefined)?.runtime?.env?.[key];
  if (typeof rt === "string" && rt) return rt;
  const vite = (import.meta.env as Record<string, unknown>)[key];
  if (typeof vite === "string" && vite) return vite;
  const proc = typeof process !== "undefined" ? process : undefined;
  return proc?.env?.[key] ?? "";
}

export function readAdminEnv(locals: unknown): AdminEnv {
  return {
    sessionSecret: readVar(locals, "ADMIN_SESSION_SECRET"),
    email: readVar(locals, "ADMIN_EMAIL").trim().toLowerCase(),
    passwordHash: readVar(locals, "ADMIN_PASSWORD_HASH"),
    paypalMode: readVar(locals, "PAYPAL_MODE").toLowerCase(),
  };
}

export type ConfigCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Refuses to run at all until protection is configured. There is deliberately
 * no "development mode" that waves requests through: a flag like that is
 * exactly how an admin API ends up public.
 */
export function checkConfigured(env: AdminEnv): ConfigCheck {
  if (env.sessionSecret.length < 32) {
    return { ok: false, reason: "ADMIN_SESSION_SECRET is missing or shorter than 32 characters." };
  }
  if (!env.email) {
    return { ok: false, reason: "ADMIN_EMAIL is not set; nobody is allowed in." };
  }
  if (!env.passwordHash.startsWith("pbkdf2:")) {
    return {
      ok: false,
      reason: "ADMIN_PASSWORD_HASH is missing or not a hash. Run: npm run admin:password -- \"...\"",
    };
  }
  return { ok: true };
}

// --------------------------------------------------------------- signing --

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant-time-ish compare, so a wrong signature leaks no timing hints. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession(env: AdminEnv, login: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${login}.${expires}`;
  return `${payload}.${await hmac(env.sessionSecret, payload)}`;
}

export type SessionCheck =
  | { ok: true; login: string }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" | "not_allowed" };

export async function readSession(env: AdminEnv, cookie: string | undefined): Promise<SessionCheck> {
  if (!cookie) return { ok: false, reason: "missing" };

  // Parsed from the RIGHT: the login is an email address and contains dots, so
  // splitting on "." from the left would shred it. Signature last, expiry
  // second-last, everything before that is the login.
  const lastDot = cookie.lastIndexOf(".");
  if (lastDot < 1) return { ok: false, reason: "malformed" };
  const sig = cookie.slice(lastDot + 1);
  const head = cookie.slice(0, lastDot);

  const secondDot = head.lastIndexOf(".");
  if (secondDot < 1) return { ok: false, reason: "malformed" };
  const expires = head.slice(secondDot + 1);
  const login = head.slice(0, secondDot);

  if (!sig || !expires || !login || !/^\d+$/.test(expires)) {
    return { ok: false, reason: "malformed" };
  }

  const expected = await hmac(env.sessionSecret, `${login}.${expires}`);
  if (!safeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };
  if (Number(expires) * 1000 < Date.now()) return { ok: false, reason: "expired" };
  // The session names the account it was issued for; changing ADMIN_EMAIL ends
  // every session issued to the old one.
  if (login.toLowerCase() !== env.email) return { ok: false, reason: "not_allowed" };

  return { ok: true, login };
}

export function cookieHeader(value: string, maxAge = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Secure",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export const clearCookieHeader = () => cookieHeader("", 0);

// ------------------------------------------------------------- the guard --

export interface Guarded {
  response?: Response;
  login?: string;
}

const deny = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Call at the top of every admin endpoint. Returns a Response to send back when
 * access is refused, or the authenticated login when it is allowed.
 */
export async function requireAdmin(request: Request, locals: unknown): Promise<Guarded> {
  const env = readAdminEnv(locals);

  const configured = checkConfigured(env);
  if (!configured.ok) {
    console.error("[VP-ADMIN-UNCONFIGURED] Refusing admin request:", configured.reason);
    return {
      response: deny(
        { ok: false, error: "admin_not_configured", message: "Admin access is not configured." },
        503
      ),
    };
  }

  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  const session = await readSession(env, match?.[1]);

  if (!session.ok) {
    return {
      response: deny(
        { ok: false, error: "unauthorized", reason: session.reason },
        401
      ),
    };
  }
  return { login: session.login };
}
