// ===========================================================================
// Draft guard — build-time safety rail for the Shop collection.
// ---------------------------------------------------------------------------
// Sample/placeholder products must NEVER reach production silently. Every
// scaffolded product ships with `draft: true`, and this integration aborts a
// production build while any such record still exists, naming the files.
//
//   npm run build          -> fails if any product is draft: true  (production)
//   npm run build:preview  -> ALLOW_DRAFT_PRODUCTS=1, drafts render (local QA)
//   npm run dev            -> drafts always render
//
// The escape hatch is deliberately an explicit, separate script: you cannot hit
// it by accident from a CI "npm run build".
// ===========================================================================
import fs from "node:fs";
import path from "node:path";

const PRODUCT_DIR = "src/content/products";

/** True when drafts are allowed to render (local preview only). */
export const draftsAllowed = () => process.env.ALLOW_DRAFT_PRODUCTS === "1";

/** Returns the filenames of every product record still marked `draft: true`. */
export function findDraftProducts(root = process.cwd()) {
  const dir = path.resolve(root, PRODUCT_DIR);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => /\.mdx?$/i.test(f))
    .filter((file) => {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const frontmatter = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontmatter) return false;
      return /^draft:\s*true\s*$/m.test(frontmatter[1]);
    })
    .sort();
}

export function draftGuard() {
  return {
    name: "vigorix:draft-guard",
    hooks: {
      "astro:build:start": ({ logger }) => {
        const drafts = findDraftProducts();

        if (draftsAllowed()) {
          if (drafts.length) {
            logger.warn(
              `ALLOW_DRAFT_PRODUCTS=1 — building ${drafts.length} DRAFT product(s). ` +
                `This output must not be deployed: ${drafts.join(", ")}`
            );
          }
          return;
        }

        if (!drafts.length) return;

        // Printed and exited rather than thrown: the build must stop with a
        // clean non-zero status and a readable message in the CI log, not with
        // a stack trace pointing at this file.
        logger.error(
          [
            "",
            "PRODUCTION BUILD BLOCKED — sample/draft products are still present:",
            "",
            ...drafts.map((f) => `  • ${PRODUCT_DIR}/${f}   (draft: true)`),
            "",
            "Replace the placeholder copy, images, prices and specs with real data,",
            'then switch Draft off in each file (Admin → Shop Products → "Draft").',
            "",
            "To render drafts locally for UI testing instead, run:",
            "  npm run build:preview     (never deploy that output)",
            "",
          ].join("\n")
        );
        process.exit(1);
      },
    },
  };
}
