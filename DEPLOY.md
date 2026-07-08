# Vigorix Prime — Deploy & Admin Guide

Static site: **Astro 5** → **Cloudflare Pages**. CMS: **Sveltia** (Decap-compatible) at `/admin`, authenticated by a small **Cloudflare Worker** (`oauth-worker/`) that does the GitHub OAuth handshake.

Nothing here touches any other site — separate GitHub repo, separate Cloudflare project.

---

## One-time deploy (do these in order)

### 1. Create an empty GitHub repo
- Owner: the `nghia8m@gmail.com` GitHub account.
- Suggested name: **`vigorixprime-cms`** (or `vigorixprime`).
- Create it **empty** (no README/.gitignore) so the first push is clean.

### 2. Push the code (assistant runs this)
```bash
git init
git add -A
git commit -m "Initial commit — Vigorix Prime affiliate review site"
git branch -M main
git remote add origin https://github.com/OWNER/vigorixprime-cms.git
git push -u origin main
```

### 3. Cloudflare Pages project
- Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
- Build settings:
  - **Framework preset:** Astro
  - **Build command:** `npm run build`
  - **Build output directory:** `dist`
  - **Node version:** 20 (add env var `NODE_VERSION=20` if needed)
- Deploy. You'll get a `https://vigorixprime-cms.pages.dev` URL.

### 4. GitHub OAuth App (for CMS login)
GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
- **Application name:** Vigorix Prime CMS
- **Homepage URL:** `https://vigorixprime.com`
- **Authorization callback URL:** `https://vigorixprime-cms-auth.<your-workers-subdomain>.workers.dev/callback`
- Save → copy the **Client ID** and generate a **Client Secret**.

### 5. Deploy the OAuth worker (assistant runs `wrangler deploy`)
```bash
cd oauth-worker
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_ID       # paste Client ID
npx wrangler secret put GITHUB_CLIENT_SECRET   # paste Client Secret
```
Note the deployed worker URL (e.g. `https://vigorixprime-cms-auth.<subdomain>.workers.dev`).

### 6. Wire the CMS config
In `public/admin/config.yml` set:
- `repo: OWNER/vigorixprime-cms`
- `base_url: https://vigorixprime-cms-auth.<subdomain>.workers.dev`
Commit + push. Cloudflare redeploys automatically.

### 7. Point the domain
- Cloudflare → the Pages project → **Custom domains** → add `vigorixprime.com` and `www.vigorixprime.com`.
- If the domain's DNS is on Cloudflare, records are added automatically; otherwise follow the shown CNAME.

### 8. Test the CMS
Visit `https://vigorixprime.com/admin` → **Login with GitHub** → you should see the **Articles** and **Site Settings** collections.

### 9. Contact form (Web3Forms)
Create a free account at web3forms.com, create an access key for `info@vigorixprime.com`, then in **Admin → Site Settings → Contact Form** paste the key. (Do not reuse any other site's key.)

### 10. (Optional) Google Analytics 4
Create a GA4 property, copy the Measurement ID (`G-XXXX`), and paste the GA snippet into **Admin → Site Settings → Custom Head Code**. Never hardcode it in the source.

---

## Everyday admin
- Add/edit reviews: **/admin → Articles**. Fill the form; save = a commit = auto redeploy.
- Paste an **affiliate link** into each product's *Affiliate Link* field once approved (empty = inert button, so no broken/non-compliant links ship early).
- Change header/footer/hero/deals: **/admin → Site Settings**.

## Local development
```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # production build into dist/
```

## Regenerating brand assets / images (build-only tooling)
```bash
npm install --no-save sharp
node scripts/generate-assets.mjs   # logo, favicon, OG, placeholder cards
node scripts/fetch-hero.mjs        # hero slideshow images (reads scripts/hero-candidates.json)
node scripts/fetch-cards.mjs       # article card photos (reads scripts/card-images.json)
```
