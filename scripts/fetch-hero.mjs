/**
 * Downloads hero-banner candidates listed in scripts/hero-candidates.json,
 * keeps only landscape / high-res ones, resizes to 1920x1080 (cover) and
 * compresses each to under ~300KB, writing to public/images/hero/<name>.jpg.
 *
 *   node scripts/fetch-hero.mjs
 *
 * hero-candidates.json: [{ "name": "...", "url": "https://images.pexels...", "source": "...", "page": "..." }]
 * Prints a ready-to-paste hero.slides snippet + a source manifest at the end.
 */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const MAX_BYTES = 300 * 1024;
const OUT_DIR = resolve(ROOT, "public/images/hero");

// Pexels: request a big version; other hosts: use as-is.
function bigUrl(url) {
  if (/images\.pexels\.com/.test(url)) return url.split("?")[0] + "?auto=compress&cs=tinysrgb&w=2400";
  return url;
}

async function encodeUnder(buf, absPath) {
  for (const q of [80, 74, 68, 62, 56, 50]) {
    const out = await sharp(buf)
      .resize(1920, 1080, { fit: "cover", position: "attention" })
      .jpeg({ quality: q, mozjpeg: true })
      .toBuffer();
    if (out.length <= MAX_BYTES || q === 50) {
      await writeFile(absPath, out);
      return { bytes: out.length, quality: q };
    }
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const cands = JSON.parse(await readFile(resolve(ROOT, "scripts/hero-candidates.json"), "utf8"));
  const slides = [];
  const manifest = [];
  for (const c of cands) {
    try {
      const res = await fetch(bigUrl(c.url), { headers: { "User-Agent": UA, Accept: "image/*" } });
      if (!res.ok) throw new Error("http " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      if (!meta.width || !meta.height) throw new Error("not an image");
      if (meta.width < meta.height) throw new Error(`portrait ${meta.width}x${meta.height} — skipped`);
      if (meta.width < 1600) throw new Error(`too small ${meta.width}x${meta.height} — skipped`);
      const abs = resolve(OUT_DIR, c.name + ".jpg");
      const { bytes, quality } = await encodeUnder(buf, abs);
      console.log(`OK  ${c.name}.jpg  src ${meta.width}x${meta.height} -> 1920x1080  ${Math.round(bytes / 1024)}KB (q${quality})`);
      slides.push({ image: `/images/hero/${c.name}.jpg`, alt: c.alt || c.name.replace(/-/g, " ") });
      manifest.push({ file: `public/images/hero/${c.name}.jpg`, source: c.source, page: c.page });
    } catch (e) {
      console.log(`SKIP ${c.name}: ${e.message}`);
    }
  }
  await writeFile(resolve(ROOT, "scripts/hero-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\n${slides.length} hero images ready.`);
  console.log("\n--- paste into site.json hero.slides ---");
  console.log(JSON.stringify(slides, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
