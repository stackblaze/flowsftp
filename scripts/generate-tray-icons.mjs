#!/usr/bin/env node
/**
 * Generates the FlowSFTP tray icons:
 *   resources/tray-iconTemplate.png      (22x22, used by macOS — alpha only)
 *   resources/tray-iconTemplate@2x.png   (44x44, retina variant for macOS)
 *   resources/tray-icon.png              (22x22 dark glyph for Windows/Linux)
 *
 * Drawn pixel-by-pixel with no external deps (uses only `zlib` from Node core)
 * because we don't want to add `sharp`/`canvas` just for a 1KB PNG. The glyph
 * is a stylized "two-arrows transfer" mark (up-left arrow + down-right arrow).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "..", "resources");
mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* Tiny grayscale+alpha PNG encoder (color type 4, 8 bits per sample) */
/* ------------------------------------------------------------------ */
function crc32(buf) {
  let c;
  const table = (crc32.table ||= (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let k = n;
      for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
      t[n] = k >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** pixels: Uint8Array of size width*height*2 (gray, alpha pairs). */
function encodePNG(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(4, 9); // color type: grayscale + alpha
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const stride = width * 2;
  const raw = Buffer.alloc((stride + 1) * height);
  const pixBuf = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixBuf.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Glyph: two diagonal arrows (transfer)                              */
/* ------------------------------------------------------------------ */
/**
 * Renders the glyph at the requested size.
 *   gray  = 0   (full black, looks correct for both template & dark UIs)
 *   alpha = 0..255  (anti-aliased coverage)
 */
function renderGlyph(size) {
  const px = new Uint8Array(size * size * 2);
  // Default: transparent black
  for (let i = 0; i < size * size; i++) {
    px[i * 2] = 0;
    px[i * 2 + 1] = 0;
  }

  const setPx = (x, y, alpha) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 2;
    if (alpha > px[i + 1]) px[i + 1] = alpha;
  };

  // Anti-aliased filled circle (used as stroke brush dot)
  const dot = (cx, cy, r) => {
    const r2 = r * r;
    const minX = Math.floor(cx - r - 1);
    const maxX = Math.ceil(cx + r + 1);
    const minY = Math.floor(cy - r - 1);
    const maxY = Math.ceil(cy + r + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) {
          setPx(x, y, 255);
        } else {
          // soft edge of ~1px
          const d = Math.sqrt(d2) - r;
          if (d < 1) setPx(x, y, Math.round(255 * (1 - d)));
        }
      }
    }
  };

  // Stroke a line from (x0,y0) to (x1,y1) by stamping dots.
  const line = (x0, y0, x1, y1, thickness) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      dot(x0 + dx * t, y0 + dy * t, thickness / 2);
    }
  };

  // Geometry scales with size (designed against a 22x22 reference).
  const s = size / 22;
  const t = Math.max(1.6, 1.8 * s); // stroke thickness

  // Up arrow on the left
  // shaft
  line(7 * s, 17 * s, 7 * s, 5 * s, t);
  // arrow head
  line(7 * s, 5 * s, 4 * s, 8 * s, t);
  line(7 * s, 5 * s, 10 * s, 8 * s, t);

  // Down arrow on the right
  line(15 * s, 5 * s, 15 * s, 17 * s, t);
  line(15 * s, 17 * s, 12 * s, 14 * s, t);
  line(15 * s, 17 * s, 18 * s, 14 * s, t);

  return px;
}

/* ------------------------------------------------------------------ */
/* Build the variants                                                 */
/* ------------------------------------------------------------------ */
function writeIcon(filename, size) {
  const pixels = renderGlyph(size);
  const png = encodePNG(size, size, pixels);
  const path = resolve(outDir, filename);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes, ${size}x${size})`);
}

writeIcon("tray-iconTemplate.png", 22);
writeIcon("tray-iconTemplate@2x.png", 44);
writeIcon("tray-icon.png", 22);
