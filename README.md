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

## Two different admins

They are separate tools and do not share a login:

| | What it edits | Where | Storage |
| --- | --- | --- | --- |
| **Sveltia CMS** | products, articles, site settings | `/admin/index.html` | files in git |
| **Orders** | order status, tracking | `/admin/orders` | D1 database |

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

Both go in `.env` locally (already gitignored) and in Cloudflare's environment
variables in production. Neither belongs in `site.json` or the CMS: anything
saved there is committed to the repo forever.

```
ADMIN_SESSION_SECRET=<64 hex characters>
ADMIN_GITHUB_LOGINS=nghia8m
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ADMIN_GITHUB_LOGINS` is a comma-separated allowlist of GitHub usernames. Being
able to sign in to GitHub is not by itself permission to read customer
addresses — the account must be on this list.

With either missing, every admin endpoint answers `503 admin_not_configured`.
There is no development flag that waves requests through.

### 2. The database

```bash
npx wrangler d1 migrations apply vigorix_orders --local
```

Local only: the data lives in `.wrangler/state`, and `astro dev` reaches it
through the adapter's platform proxy. Nothing touches a Cloudflare account.

### 3. Signing in

1. `npm run dev`
2. Open **http://localhost:4321/admin/orders**
3. Paste a **GitHub personal access token** and press *Sign in*.
   A token with **no scopes at all** is enough — it is used once to read your
   username, then discarded. Create one at
   [github.com/settings/tokens](https://github.com/settings/tokens).
4. Sign out with the button in the header.

The session is a signed cookie valid for 8 hours. Changing
`ADMIN_SESSION_SECRET` immediately invalidates every existing session — that is
the way to lock everyone out if a laptop goes missing.

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
