/**
 * Downloads license-cleared stock photos for article CARD images and, optionally,
 * per-product images, writing web-sized cropped JPEGs into public/images/.
 *
 *   node scripts/fetch-cards.mjs
 *
 * Reads scripts/card-images.json:
 *   [
 *     { "slug": "best-...", "url": "https://images.pexels.com/photos/ID/..jpeg", "page": "..." },
 *     ...
 *   ]
 * A card entry overwrites public/images/<slug>.jpg (the brand placeholder), so no
 * article frontmatter change is needed. Failed/blocked URLs are skipped and the
 * brand placeholder is kept. All images are generic CATEGORY illustrations — they
 * do not claim to depict a specific reviewed model. Amazon-hosted URLs are refused.
 */
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const AMAZON = /amazon\.|media-amazon|images-amazon|ssl-images-amazon/i;
const sized = (base) => (/images\.pexels\.com/.test(base) ? base.split("?")[0] + "?auto=compress&cs=tinysrgb&w=1800" : base);

async function main() {
  const items = JSON.parse(await readFile(resolve(ROOT, "scripts/card-images.json"), "utf8"));
  const manifest = [];
  let ok = 0;
  for (const it of items) {
    const outPath = resolve(ROOT, "public/images", it.slug + ".jpg");
    if (AMAZON.test(it.url || "")) { console.log(`REFUSE ${it.slug}: amazon url`); continue; }
    try {
      const res = await fetch(sized(it.url), { headers: { "User-Agent": UA, Accept: "image/*" } });
      if (!res.ok) throw new Error("http " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      if (!meta.width || meta.width < 600) throw new Error("too small / not an image");
      await sharp(buf).resize(800, 450, { fit: "cover", position: "attention" }).jpeg({ quality: 80 }).toFile(outPath);
      console.log(`OK  ${it.slug}.jpg  (src ${meta.width}x${meta.height})`);
      manifest.push({ file: `public/images/${it.slug}.jpg`, license: "Pexels License (free commercial, no attribution)", source: it.page });
      ok++;
    } catch (e) {
      console.log(`FAIL ${it.slug}: ${e.message} (kept brand placeholder)`);
    }
  }
  await writeFile(resolve(ROOT, "scripts/card-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nDone: ${ok}/${items.length} card images. Manifest -> scripts/card-manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
