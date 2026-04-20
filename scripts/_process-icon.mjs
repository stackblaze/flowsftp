import sharp from "sharp";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Source RGBA/RGB PNG (e.g. from image generation). Pass as argv[1] or default next to this script. */
const SRC = process.argv[2] ?? join(__dirname, "flowsftp-src.png");
const OUT = join(__dirname, "..", "resources", "icon.png");
const SIZE = 1024;
const BG_THRESHOLD = 200;

const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const w = info.width;
const h = info.height;

for (let i = 0; i < data.length; i += 4) {
  if (data[i] >= BG_THRESHOLD && data[i + 1] >= BG_THRESHOLD && data[i + 2] >= BG_THRESHOLD) {
    data[i + 3] = 0;
  }
}

let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const bbW = maxX - minX + 1;
const bbH = maxY - minY + 1;
console.log("bbox", bbW + "x" + bbH);

const square = Math.max(bbW, bbH);
const padded = Math.round(square * 1.12);
const offX = Math.round((padded - bbW) / 2);
const offY = Math.round((padded - bbH) / 2);

/* Pipeline 1: extract + extend → padded square buffer. */
const squarePng = await sharp(data, {
  raw: { width: w, height: h, channels: 4 },
})
  .extract({ left: minX, top: minY, width: bbW, height: bbH })
  .extend({
    top: offY,
    bottom: padded - bbH - offY,
    left: offX,
    right: padded - bbW - offX,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

const sqMeta = await sharp(squarePng).metadata();
console.log("square buffer", sqMeta.width + "x" + sqMeta.height);

/* Pipeline 2: resize the already-square buffer to exactly SIZE. */
const finalPng = await sharp(squarePng)
  .resize(SIZE, SIZE, { fit: "fill" })
  .png({ compressionLevel: 9 })
  .toBuffer();

writeFileSync(OUT, finalPng);
const meta = await sharp(OUT).metadata();
console.log("written", meta.width + "x" + meta.height, "alpha=" + meta.hasAlpha);
