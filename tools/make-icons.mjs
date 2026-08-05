// Draws the extension icons and writes them as PNGs.
//
// Chrome's `icons` field only takes raster images, so an SVG won't do. Rather
// than add an image library for four small squares, this encodes the PNGs by
// hand: the format is a zlib stream of raw scanlines plus three chunks, and
// node ships zlib.
//
//   node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

// Handoff tokens, converted to sRGB.
const BG = [37, 43, 51]; // oklch(24% 0.02 250)
const AMBER = [232, 168, 61]; // oklch(72% 0.16 70)
const INNER = [40, 30, 12]; // oklch(18% 0.02 70)

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function png(size, pixel) {
  // One filter byte (0 = none) then RGBA per pixel, per scanline.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded square, used for the background plate. */
function insideRounded(x, y, size, radius) {
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  return Math.hypot(dx, dy) <= radius;
}

/** A diamond is a square rotated 45°, i.e. the L1 ball. */
const inDiamond = (x, y, cx, cy, half) => Math.abs(x - cx) + Math.abs(y - cy) <= half;

for (const size of [16, 32, 48, 128]) {
  const radius = Math.round(size * 0.2);
  const c = (size - 1) / 2;
  const outer = size * 0.34;
  const inner = size * 0.15;

  const buf = png(size, (x, y) => {
    // Sample the centre of the pixel so the diagonals don't look ragged.
    const px = x + 0.5;
    const py = y + 0.5;
    if (!insideRounded(px, py, size, radius)) return [0, 0, 0, 0];
    if (inDiamond(px, py, c, c, inner)) return [...INNER, 255];
    if (inDiamond(px, py, c, c, outer)) return [...AMBER, 255];
    return [...BG, 255];
  });

  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, buf);
  console.log(`  ${file}  ${buf.length} bytes`);
}
