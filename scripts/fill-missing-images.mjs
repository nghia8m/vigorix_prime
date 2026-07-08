/**
 * Fills the handful of products that still lack an image. Reads scripts/fill5.json:
 *   [{ "slug": "...", "index": 3, "urls": ["https://...", "https://...", ...] }, ...]
 * Tries each candidate URL in order until one downloads & decodes, saves to
 * public/images/products/<slug>-<index>.jpg, and inserts the `image:` line into
 * the matching product (only if it doesn't already have one). Amazon URLs refused.
 *
 *   node scripts/fill-missing-images.mjs
 */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const AMAZON = /amazon\.|media-amazon|images-amazon|ssl-images-amazon/i;
const sized = (url) => (/images\.pexels\.com/.test(url) ? url.split("?")[0] + "?auto=compress&cs=tinysrgb&w=1200" : url);

async function tryDownload(url) {
  if (AMAZON.test(url)) throw new Error("amazon refused");
  const origin = new URL(url).origin;
  const res = await fetch(sized(url), {
    headers: { "User-Agent": UA, Accept: "image/*,*/*", Referer: origin + "/" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("http " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  if (!meta.width || meta.width < 200) throw new Error("too small");
  return { buf, meta };
}

async function main() {
  const items = JSON.parse(await readFile(resolve(ROOT, "scripts/fill5.json"), "utf8"));
  await mkdir(resolve(ROOT, "public/images/products"), { recursive: true });
  const done = [], failed = [];

  for (const it of items) {
    const mdPath = resolve(ROOT, "src/content/articles", it.slug + ".md");
    const md = await readFile(mdPath, "utf8");
    const lines = md.split("\n");
    const nameLineIdx = lines.map((l, i) => (/^  - name: /.test(l) ? i : -1)).filter((i) => i >= 0);
    const li = nameLineIdx[it.index - 1];
    if (li == null) { failed.push(`${it.slug} #${it.index} (product line not found)`); continue; }
    if (/^    image: /.test(lines[li + 1] || "")) { done.push(`${it.slug} #${it.index} (already had image)`); continue; }

    let ok = false;
    for (const url of it.urls) {
      try {
        const { buf, meta } = await tryDownload(url);
        const outRel = `/images/products/${it.slug}-${it.index}.jpg`;
        await sharp(buf).resize(760, 600, { fit: "cover", position: "attention" }).jpeg({ quality: 82 })
          .toFile(resolve(ROOT, "public" + outRel));
        lines.splice(li + 1, 0, `    image: "${outRel}"`);
        await writeFile(mdPath, lines.join("\n"));
        done.push(`${it.slug} #${it.index} <- ${meta.width}x${meta.height}`);
        ok = true;
        break;
      } catch (e) {
        // try next candidate
      }
    }
    if (!ok) failed.push(`${it.slug} #${it.index} (all ${it.urls.length} candidates failed)`);
  }

  console.log("FILLED:");
  done.forEach((d) => console.log("  + " + d));
  if (failed.length) { console.log("\nSTILL MISSING:"); failed.forEach((f) => console.log("  - " + f)); }
  console.log(`\n${done.length} filled, ${failed.length} still missing.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
