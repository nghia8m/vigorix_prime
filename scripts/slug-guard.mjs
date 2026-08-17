// ===========================================================================
// Slug guard — two products must never claim the same /shop/<slug>.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL, given getShopProducts() already looks for clashes:
// that check can never fire. Astro's glob loader derives a collection entry's
// id from the `slug` field in frontmatter when there is one, and the content
// store is keyed by id — so two files declaring the same slug collapse into a
// SINGLE entry inside the loader, before any of our code runs. The later file
// wins and the earlier product disappears from the site.
//
// Proven on this project: a second product declaring `slug: knee-support-brace`
// produced a build that exited 0, printed no warning, and served the new
// product's name, price and photos at the real brace's URL. Nothing in the
// build log said a product had gone missing.
//
// So the check has to happen on the FILES, before the loader flattens them.
// That is what this does.
//
// Unlike the draft guard, this one has NO escape hatch. A duplicate slug is
// never a thing anyone wants, in any environment: it silently deletes a
// product and hands its URL, its search ranking and its inbound links to
// something else.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";

const PRODUCT_DIR = "src/content/products";

/** Every product file paired with the slug it declares. */
export function readProductSlugs(root = process.cwd()) {
  const dir = path.resolve(root, PRODUCT_DIR);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => /\.mdx?$/i.test(f))
    .sort()
    .map((file) => {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const frontmatter = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const slug = frontmatter?.[1].match(/^slug:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1];
      return { file, slug: slug ?? null };
    });
}

/** Groups the files by slug and keeps only the slugs claimed more than once. */
export function findSlugClashes(root = process.cwd()) {
  const bySlug = new Map();
  for (const { file, slug } of readProductSlugs(root)) {
    if (!slug) continue;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), file]);
  }
  return [...bySlug.entries()].filter(([, files]) => files.length > 1);
}

/**
 * Products with no slug at all. A backstop rather than the main defence: the
 * Zod schema requires `slug`, and content sync runs before astro:build:start,
 * so in practice the schema reports this first and this branch never fires.
 * It stays for the case the schema cannot see — a file whose frontmatter fails
 * to parse at all.
 */
export function findMissingSlugs(root = process.cwd()) {
  return readProductSlugs(root)
    .filter((p) => !p.slug)
    .map((p) => p.file);
}

export function slugGuard() {
  return {
    name: "vigorix:slug-guard",
    hooks: {
      "astro:build:start": ({ logger }) => {
        const clashes = findSlugClashes();
        const missing = findMissingSlugs();
        if (!clashes.length && !missing.length) return;

        const lines = ["", "BUILD BLOCKED — the /shop URLs are not unique:", ""];

        for (const [slug, files] of clashes) {
          lines.push(`  • ${files.length} products claim /shop/${slug}:`);
          files.forEach((f) => lines.push(`      ${PRODUCT_DIR}/${f}`));
          lines.push(
            `    Only the last one would exist. The others would vanish from the`,
            `    site with no error, and their URL would serve the wrong product.`,
            ""
          );
        }

        for (const file of missing) {
          lines.push(
            `  • ${PRODUCT_DIR}/${file} has no slug, so it has no URL and cannot be bought.`,
            ""
          );
        }

        lines.push(
          'Give each product its own "URL slug" in Admin -> Shop Products, then build again.',
          ""
        );

        // Printed and exited rather than thrown, to match the draft guard: a
        // clean non-zero status and a readable message in the CI log.
        logger.error(lines.join("\n"));
        process.exit(1);
      },
    },
  };
}
