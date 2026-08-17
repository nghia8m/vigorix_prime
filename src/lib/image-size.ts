/**
 * Pixel dimensions read from the file itself, at build time.
 *
 * Width and height used to be typed in by hand next to every photograph. Four
 * inputs per image, seven images to a product, and a typo produced no error at
 * all — just a page that jumps as the picture loads, which is the kind of fault
 * nobody reports and everybody feels.
 *
 * Only the header is parsed: a JPEG's SOF marker, a PNG's IHDR chunk or a
 * WebP's RIFF chunk, all within the first few hundred bytes. Nothing decodes
 * the pixels, so this stays cheap even across a large catalogue.
 *
 * The format is decided by what is INSIDE the file, never by the extension.
 * Supplier photos routinely arrive as WebP named .jpg — dropshipping exports
 * do it as a matter of course — and trusting the name there would silently put
 * the wrong dimensions on every one of them.
 *
 * Build-time only. It reads from disk, so it must never be reached from a route
 * that renders per request.
 */
import fs from "node:fs";
import path from "node:path";

export interface ImageSize {
  width: number;
  height: number;
}

/** Sensible shape for a product photo when the real one cannot be read. */
const FALLBACK: ImageSize = { width: 1000, height: 1250 };

const cache = new Map<string, ImageSize>();

function readPng(buf: Buffer): ImageSize | null {
  // 89 50 4E 47 … then IHDR: width and height as big-endian uint32 at 16 and 20.
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpeg(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0–SOF15 carry the frame size. C4, C8 and CC are other things that
    // happen to sit in the range and must be stepped over.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const segment = buf.readUInt16BE(i + 2);
    if (segment < 2) return null; // malformed; refuse rather than loop forever
    i += 2 + segment;
  }
  return null;
}

function readWebp(buf: Buffer): ImageSize | null {
  // RIFF <4-byte size> WEBP <fourcc> — the shape of the fourcc decides where
  // the dimensions live, and the three variants disagree completely.
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;

  switch (buf.toString("ascii", 12, 16)) {
    case "VP8 ": {
      // Lossy. Frame tag at 20, sync code 9d 01 2a at 23, then two 14-bit
      // values; the top two bits of each are a scale factor, not size.
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    case "VP8L": {
      // Lossless. One 32-bit little-endian word holds both, each minus one,
      // packed 14 bits apiece.
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    case "VP8X": {
      // Extended (animation, alpha, metadata). Canvas size as two 24-bit
      // little-endian values, again each stored minus one.
      const at = (i: number) => buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
      return { width: at(24) + 1, height: at(27) + 1 };
    }
    default:
      return null;
  }
}

/**
 * `url` is a site-relative path such as /images/shop/brace-1.jpg, i.e. the
 * public/ directory with the prefix removed — the same string that reaches the
 * browser.
 */
export function imageSize(url: string): ImageSize {
  const cached = cache.get(url);
  if (cached) return cached;

  let size: ImageSize | null = null;
  try {
    const file = path.join(process.cwd(), "public", url.replace(/^\//, ""));
    // 64 KB is far more than any header needs and bounds the read on a file
    // that turns out not to be an image at all.
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      size = readPng(buf) ?? readJpeg(buf) ?? readWebp(buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    size = null;
  }

  if (!size || !size.width || !size.height) {
    // Loud, because the consequence is silent: without real numbers the page
    // reserves the wrong space and shifts under the reader.
    console.warn(
      `[VP-IMAGE-SIZE] Could not read the dimensions of ${url}. ` +
        `Using ${FALLBACK.width}x${FALLBACK.height}; the layout may shift as it loads.`
    );
    size = FALLBACK;
  }

  cache.set(url, size);
  return size;
}

/** Describes a photo for a screen reader when no caption was written for it. */
export const autoAlt = (productName: string, index: number, total: number): string =>
  total > 1 ? `${productName} — photo ${index + 1} of ${total}` : productName;
