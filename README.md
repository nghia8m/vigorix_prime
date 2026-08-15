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
