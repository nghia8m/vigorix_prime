/**
 * Generates Vigorix Prime brand assets from inline SVG using `sharp`.
 *
 *   node scripts/generate-assets.mjs
 *
 * Outputs (committed to the repo):
 *   public/logo.png              header/footer logo mark (icon only)
 *   public/favicon.png           browser-tab / apple-touch icon
 *   public/assets/og-default.jpg default social-share image (1200x630)
 *   public/images/deals.jpg      homepage "deals" card
 *   public/images/<slug>.jpg     placeholder card/hero image per article
 *
 * These are BRAND-COLORED PLACEHOLDERS — no third-party/Amazon imagery is used
 * or hotlinked. Real product/lifestyle photos are wired in by the image scripts
 * (fetch-stock / wire-product-images) or later via the CMS.
 *
 * sharp is a build-only tool installed with `npm install --no-save sharp`;
 * it is intentionally NOT a runtime dependency of the site.
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Brand palette (matches src/styles/global.css)
// Azure blue is the dominant brand color; orange is the complementary accent so
// the logo arrow pops. NAVY here is the deep-azure surface shade.
const NAVY = "#0c6f9e";
const NAVY_DARK = "#084f73";
const NAVY_LIGHT = "#16a6e0";
const ORANGE = "#ff7a1a";
const WHITE = "#ffffff";

const out = (p) => resolve(ROOT, p);
async function ensureDir(file) {
  await mkdir(dirname(file), { recursive: true });
}
async function svgToPng(svg, file, w, h) {
  await ensureDir(file);
  await sharp(Buffer.from(svg)).resize(w, h).png().toFile(file);
  console.log("wrote", file);
}
async function svgToJpg(svg, file) {
  await ensureDir(file);
  await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(file);
  console.log("wrote", file);
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Logo mark: rounded navy square with a bold upward "vigor" arrow ---------
// Upward arrow = energy, rise, performance. Orange arrowhead on a navy shield.
function iconSvg(size = 512) {
  const r = size * 0.22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY_LIGHT}"/>
      <stop offset="1" stop-color="${NAVY_DARK}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="${r}" fill="url(#g)"/>
  <!-- upward arrow shaft (white) -->
  <rect x="228" y="250" width="56" height="150" rx="18" fill="${WHITE}"/>
  <!-- upward arrowhead (orange) -->
  <path d="M256 104 L392 262 Q400 272 386 272 L126 272 Q112 272 120 262 Z" fill="${ORANGE}"/>
  <!-- energy spark base -->
  <circle cx="256" cy="404" r="20" fill="${ORANGE}"/>
</svg>`;
}

// ---- Text card placeholder ---------------------------------------------------
function cardSvg(label, title, w = 1200, h = 680) {
  const words = title.split(" ");
  const lines = [];
  let cur = "";
  const max = title.length > 22 ? 14 : 18;
  for (const word of words) {
    if ((cur + " " + word).trim().length > max && cur) {
      lines.push(cur.trim());
      cur = word;
    } else {
      cur = (cur + " " + word).trim();
    }
  }
  if (cur) lines.push(cur);
  const startY = h / 2 - (lines.length - 1) * 44 + 8;
  const tspans = lines
    .map(
      (ln, i) =>
        `<text x="80" y="${startY + i * 90}" font-family="Segoe UI, Arial, sans-serif" font-size="76" font-weight="800" fill="${WHITE}">${escapeXml(
          ln
        )}</text>`
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY}"/>
      <stop offset="1" stop-color="${NAVY_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="80" y="${startY - 118}" width="70" height="12" rx="6" fill="${ORANGE}"/>
  <text x="80" y="${startY - 66}" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="700" letter-spacing="3" fill="${ORANGE}">${escapeXml(
    label.toUpperCase()
  )}</text>
  ${tspans}
  <text x="80" y="${h - 54}" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="700" fill="rgba(255,255,255,0.85)">Vigorix<tspan fill="${ORANGE}">Prime</tspan></text>
</svg>`;
}

// ---- OG default --------------------------------------------------------------
function ogSvg(w = 1200, h = 630) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY_LIGHT}"/>
      <stop offset="1" stop-color="${NAVY_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="90" y="250" width="90" height="14" rx="7" fill="${ORANGE}"/>
  <text x="90" y="360" font-family="Segoe UI, Arial, sans-serif" font-size="92" font-weight="800" fill="${WHITE}">Vigorix<tspan fill="${ORANGE}">Prime</tspan></text>
  <text x="92" y="430" font-family="Segoe UI, Arial, sans-serif" font-size="38" font-weight="600" fill="rgba(255,255,255,0.9)">Independent men's supplement, performance &amp; grooming reviews</text>
</svg>`;
}

const cards = [
  ["best-testosterone-booster-supplements", "Supplements", "Best Testosterone Boosters"],
  ["best-multivitamins-for-men", "Supplements", "Best Multivitamins for Men"],
  ["best-magnesium-supplements-for-men", "Supplements", "Best Magnesium Supplements"],
  ["best-ashwagandha-supplements", "Supplements", "Best Ashwagandha Supplements"],
  ["best-prostate-health-supplements", "Supplements", "Best Prostate Supplements"],
  ["best-omega-3-fish-oil-supplements", "Supplements", "Best Omega-3 Fish Oil"],
  ["best-pre-workout-supplements", "Performance", "Best Pre-Workout Supplements"],
  ["best-whey-protein-powders-for-men", "Performance", "Best Whey Protein for Men"],
  ["best-creatine-monohydrate", "Performance", "Best Creatine Monohydrate"],
  ["best-greens-powders-for-men", "Performance", "Best Greens Powders"],
  ["best-eaa-recovery-supplements", "Performance", "Best EAA & Recovery"],
  ["best-male-libido-supplements", "Vitality", "Best Male Libido Supplements"],
  ["best-nitric-oxide-boosters", "Vitality", "Best Nitric Oxide Boosters"],
  ["best-supplements-for-erectile-health", "Vitality", "Best Erectile Health Support"],
  ["best-beard-growth-products", "Grooming", "Best Beard Growth Products"],
  ["best-hair-loss-treatments-for-men", "Grooming", "Best Hair Loss Treatments"],
  ["best-electric-shavers-for-men", "Grooming", "Best Electric Shavers"],
  ["best-beard-trimmers", "Grooming", "Best Beard Trimmers"],
];

async function main() {
  await svgToPng(iconSvg(), out("public/logo.png"), 160, 160);
  await svgToPng(iconSvg(), out("public/favicon.png"), 512, 512);
  await svgToJpg(ogSvg(), out("public/assets/og-default.jpg"));
  await svgToJpg(cardSvg("Deals", "This Week's Best Deals"), out("public/images/deals.jpg"));
  // Card images are real stock photos now — only (re)generate brand-placeholder
  // cards for slugs whose stock photo failed to download (kept a placeholder).
  const PLACEHOLDER_ONLY = new Set(process.env.PLACEHOLDER_SLUGS?.split(",").filter(Boolean));
  for (const [slug, label, title] of cards) {
    if (!PLACEHOLDER_ONLY.has(slug)) continue;
    await svgToJpg(cardSvg(label, title), out(`public/images/${slug}.jpg`));
  }
  console.log("\nBrand assets generated (logo, favicon, OG, deals" + (PLACEHOLDER_ONLY.size ? ", placeholder cards" : "") + ").");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
