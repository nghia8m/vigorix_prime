/**
 * Downloads product photos listed in scripts/product-images.json, normalizes each
 * onto a clean white product frame, saves to public/images/products/<slug>-<index>.jpg,
 * and inserts an `image:` field into the matching product in each article's frontmatter.
 *
 *   node scripts/wire-product-images.mjs
 *
 * product-images.json: [{ "slug": "...", "index": 1, "url": "https://..." }, ...]
 * (url === "NONE" or "" is skipped, leaving that product's designed panel in place.)
 *
 * Amazon-hosted URLs are refused on principle (protects the Associates account).
 * Idempotent: a product that already has an image line is left untouched.
 */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const AMAZON = /amazon\.|media-amazon|images-amazon|ssl-images-amazon/i;
// Pexels: request a reasonable size.
const sized = (url) => (/images\.pexels\.com/.test(url) ? url.split("?")[0] + "?auto=compress&cs=tinysrgb&w=1200" : url);

async function download(url) {
  const origin = new URL(url).origin;
  const res = await fetch(sized(url), {
    headers: { "User-Agent": UA, Accept: "image/*,*/*", Referer: origin + "/" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("http " + res.status);
  const ct = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (/text\/html/.test(ct)) throw new Error("got HTML, not an image");
  return buf;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(ROOT, "scripts/product-images.json"), "utf8"));
  await mkdir(resolve(ROOT, "public/images/products"), { recursive: true });

  // group by slug
  const bySlug = {};
  for (const e of manifest) (bySlug[e.slug] ||= []).push(e);

  const done = [];
  const skipped = [];

  for (const [slug, entries] of Object.entries(bySlug)) {
    const mdPath = resolve(ROOT, "src/content/articles", slug + ".md");
    let md;
    try {
      md = await readFile(mdPath, "utf8");
    } catch {
      skipped.push(`${slug} (article file not found)`);
      continue;
    }
    const lines = md.split("\n");
    // index of each product `- name:` line, in order
    const nameLineIdx = lines.map((l, i) => (/^  - name: /.test(l) ? i : -1)).filter((i) => i >= 0);

    // process highest line-index first so insertions don't shift earlier indices
    const sorted = [...entries].sort((a, b) => b.index - a.index);
    for (const e of sorted) {
      if (!e.url || e.url === "NONE") { skipped.push(`${slug} #${e.index} (no url)`); continue; }
      if (AMAZON.test(e.url)) { skipped.push(`${slug} #${e.index} (amazon url refused)`); continue; }
      const li = nameLineIdx[e.index - 1];
      if (li == null) { skipped.push(`${slug} #${e.index} (product line not found)`); continue; }
      if (/^    image: /.test(lines[li + 1] || "")) { skipped.push(`${slug} #${e.index} (already has image)`); continue; }

      const outRel = `/images/products/${slug}-${e.index}.jpg`;
      const outAbs = resolve(ROOT, "public" + outRel);
      try {
        const buf = await download(e.url);
        const meta = await sharp(buf).metadata();
        if (!meta.width || meta.width < 200) throw new Error("too small");
        await sharp(buf)
          .resize(760, 600, { fit: "cover", position: "attention" })
          .jpeg({ quality: 82 })
          .toFile(outAbs);
        lines.splice(li + 1, 0, `    image: "${outRel}"`);
        done.push(`${slug} #${e.index} <- ${meta.width}x${meta.height}`);
      } catch (err) {
        skipped.push(`${slug} #${e.index} (${err.message})`);
      }
    }
    md = lines.join("\n");
    await writeFile(mdPath, md);
  }

  console.log("WIRED:");
  done.forEach((d) => console.log("  + " + d));
  console.log("\nSKIPPED:");
  skipped.forEach((s) => console.log("  - " + s));
  console.log(`\n${done.length} images wired, ${skipped.length} skipped.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
