// Generates the grey "SAMPLE" placeholders used by the scaffolded shop products.
// Deliberately synthetic: no supplier photography is copied into this repo, and
// nobody can mistake these for the real product shots that must replace them.
//
//   node scripts/generate-sample-images.mjs
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("public/images/shop");

const SETS = [
  { slug: "herbal-warming-patch", captions: ["Front of pack", "Single patch", "Applied to knee", "Pack contents"] },
  { slug: "knee-support-brace", captions: ["Front view", "Side straps", "Worn on knee", "Size guide"] },
  { slug: "self-heating-comfort-pad", captions: ["Front of pack", "Single pad", "Pad detail"] },
];

const svg = (caption, index, total) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800" role="img" aria-label="Sample placeholder image">
  <defs>
    <pattern id="d" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="28" height="28" fill="#dfe6ea"/>
      <rect width="14" height="28" fill="#d5dde2"/>
    </pattern>
  </defs>
  <rect width="800" height="800" fill="url(#d)"/>
  <rect x="40" y="40" width="720" height="720" fill="#eef2f5" stroke="#b9c6ce" stroke-width="3" stroke-dasharray="14 10"/>
  <text x="400" y="360" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="96" font-weight="800" fill="#8fa2af" letter-spacing="6">SAMPLE</text>
  <text x="400" y="424" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="30" font-weight="600" fill="#8fa2af">Replace with a real product photo</text>
  <text x="400" y="486" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="26" fill="#a5b4bf">${caption} — ${index} of ${total}</text>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
let count = 0;
for (const set of SETS) {
  set.captions.forEach((caption, i) => {
    fs.writeFileSync(path.join(OUT, `${set.slug}-${i + 1}.svg`), svg(caption, i + 1, set.captions.length));
    count++;
  });
}
console.log(`Wrote ${count} sample placeholder images to ${OUT}`);
