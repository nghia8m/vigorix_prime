# Vigorix Prime

Men's health review site (Astro 5, static) with a Health Care shop at `/shop`.
Deploy instructions live in [DEPLOY.md](DEPLOY.md); this file covers day-to-day
local work.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on http://localhost:4321 — draft products render |
| `npm run build` | **Production build. Fails on purpose while any product is `draft: true`.** |
| `npm run build:preview` | Local QA build that renders drafts. **Never deploy this output.** |
| `npm run preview` | Serves the last build on http://localhost:4321 |

### Why `npm run build` fails

`scripts/draft-guard.mjs` aborts the production build while any file in
`src/content/products/` still has `draft: true`, and names the offending files.
Sample/placeholder products must never reach production silently.

To look at draft products locally, use `npm run build:preview` — it sets
`ALLOW_DRAFT_PRODUCTS=1` and prints a warning that the output must not be
deployed. The `dist/` produced by that command contains placeholder copy, "SAMPLE"
images and `TODO` specs; publishing it would put fake data in front of readers.

## The admin, in one place

Two screens, **one login**:

| | What it edits | Where | Storage |
| --- | --- | --- | --- |
| **Orders** | order status, tracking | `/admin/orders` | D1 database |
| **Content CMS** | products, articles, site settings | `/admin/index.html` | files in git |

Sign in once at `/admin/orders` with the email and password below. The CMS then
signs in from that same session: pressing **Sign In with GitHub** there does not
go to GitHub at all — it calls `/api/admin/git-auth`, which checks the admin
cookie and hands the CMS a repository token the server holds.

That token, `GITHUB_CONTENT_TOKEN`, can write to the repository. Anyone who
learns the admin password can therefore change site content, which is the price
of not having to manage a second login. The password is hashed, the session
lasts 8 hours, and `/api/admin/git-auth` refuses anyone who is not already
signed in.

Locally you can skip all of it and press **Work with Local Repository** instead,
picking this project’s root folder — the one containing `.git`.

## Editing content in the admin, locally

The CMS is **Sveltia** (Decap-compatible), configured in
[public/admin/config.yml](public/admin/config.yml). It can write straight to the
files on this machine — no deploy, no commit, no proxy server.

1. `npm run dev`
2. Open **http://localhost:4321/admin/index.html** in **Chrome, Edge or Brave**
   (the local-repository mode uses the File System Access API, so Firefox and
   Safari cannot do this).
3. Click **"Work with Local Repository"** and pick this project's root folder.
   Grant write access when the browser asks.
4. Edit and Save. Changes are written directly to `src/content/**` and
   `public/images/**`. The dev server picks them up immediately.
5. Sveltia performs **no git operations** — review with `git diff` and commit
   yourself.

Brave additionally needs the API enabled at `brave://flags/#file-system-access-api`.

> On the deployed site the same admin runs at `/admin` against the GitHub
> backend, where saving creates a commit and triggers a rebuild.

## The Orders screen, locally

`/admin/orders` reads paid orders out of D1 — real customer names, emails,
addresses and amounts. It is protected separately from the CMS, and **refuses to
serve anything until that protection is configured**.

### 1. Environment variables

All three go in `.env` locally (already gitignored) and in Cloudflare’s
environment variables in production. None belongs in `site.json` or the CMS:
anything saved there is committed to the repo forever.

```
ADMIN_SESSION_SECRET=<64 hex characters>
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD_HASH=pbkdf2:210000:<salt>:<hash>
GITHUB_CONTENT_TOKEN=<a GitHub token with repo write access>
```

`GITHUB_CONTENT_TOKEN` is only needed for the content CMS. Leave it empty and
Orders still works; the CMS then says so and you can use “Work with Local
Repository” instead.

Generate the session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate the password hash — it prints the lines to paste:

```bash
npm run admin:password -- "a long password you will remember"
```

The password itself is never written anywhere: `.env` holds only a PBKDF2 hash,
which cannot be turned back into the password. Twelve characters minimum,
enforced by the script. To change it later, run the script again and replace the
line.

The hash is separated by `:` and never by the dollar sign — Vite expands
`$NAME` inside `.env`, so a dollar sign in the value is silently eaten and every
login then fails with no visible reason.

With any of the three missing, every admin endpoint answers
`503 admin_not_configured`. There is no development flag that waves requests
through.

### 2. The database

```bash
npx wrangler d1 migrations apply vigorix_orders --local
```

Local only: the data lives in `.wrangler/state`, and `astro dev` reaches it
through the adapter's platform proxy. Nothing touches a Cloudflare account.

### 3. Signing in

1. `npm run dev`
2. Open **http://localhost:4321/admin/orders**
3. Enter the email and password from step 1 and press *Sign in*.
4. Sign out with the button in the header.

The session is a signed cookie valid for 8 hours. Changing
`ADMIN_SESSION_SECRET` — or `ADMIN_EMAIL` — invalidates every existing session
immediately, which is how to lock everyone out if a laptop goes missing.

A wrong email and a wrong password give the same answer and take the same time,
so the form cannot be used to work out which email is the real one.

### What the screen can and cannot change

Editable: the **Status** column (pending / paid / processing / shipped /
delivered / cancelled / refunded) and the tracking number. Every change is
appended to the order's history with the old and new value and who made it.

Not editable: the **Server** column. That is written only by the payment capture
and by signature-verified PayPal webhooks. A hand-typed "paid" must never be
indistinguishable from a payment that actually happened. Orders cannot be
deleted either — cancelling is a status.

An order with no lines and no customer details is expected, not a bug: it means
a payment succeeded while the database write failed, and the webhook rebuilt
what it could. Those are flagged **needs manual reconciliation** with the PayPal
capture ID to look up.

### In production

Put both variables in the Cloudflare environment, and consider putting
Cloudflare Access in front of `/admin*` and `/api/admin/*` as a second layer.
It is a layer, not a replacement: the cookie check above is what protects the
Worker itself.

### What the admin blocks before you can save

Enforced by `config.yml`:

- a product with **no images** (`required: true`, `min: 1`)
- an image with **no alt text**
- meta title over 70 characters, meta description over 165
- a slug that is not lowercase-hyphenated

Enforced by the validation script in [public/admin/index.html](public/admin/index.html):

- two variants sharing an **id**, or sharing a **SKU**
- a variant pointing at an image index that does not exist

Warnings that do **not** block the save:

- no buy link set (allowed in phase 1 — the buy button ships disabled) — shown on save
- an image over 400 KB — shown **after** the save, because a newly picked image is
  only written to disk at save time and cannot be measured before that

Product images uploaded from the Images field land in `public/images/shop/`.

## Shop phase 1 scope

Header entry, homepage strip, `/shop`, `/shop/<slug>`. No cart and no checkout:
`purchaseUrl` in the product frontmatter is the single place a buy destination is
configured, and it points at an external checkout for now.
