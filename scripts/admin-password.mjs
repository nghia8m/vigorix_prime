/**
 * Turns a password into the ADMIN_PASSWORD_HASH line for .env.
 *
 *   npm run admin:password -- "your password here"
 *
 * The password is never written to a file — only the hash is, and the hash
 * cannot be reversed. Quote it if it contains spaces or symbols.
 */
const password = process.argv.slice(2).join(" ").trim();

if (!password) {
  console.error("Usage: npm run admin:password -- \"your password here\"");
  process.exit(1);
}
if (password.length < 12) {
  console.error(
    `That password is ${password.length} characters. Use at least 12 —\n` +
      "this login sits on the public internet and guards customer addresses."
  );
  process.exit(1);
}

const ITERATIONS = 210_000;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  { name: "PBKDF2" },
  false,
  ["deriveBits"]
);
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  key,
  256
);

console.log("\nAdd these two lines to .env (and to the Cloudflare environment when you deploy):\n");
console.log(`ADMIN_EMAIL=you@example.com`);
console.log(`ADMIN_PASSWORD_HASH=pbkdf2:${ITERATIONS}:${b64(salt)}:${b64(new Uint8Array(bits))}`);
console.log("\nThe password itself is not stored anywhere. Keep it in a password manager.\n");
