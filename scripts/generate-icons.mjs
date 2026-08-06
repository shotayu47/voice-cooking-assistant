/**
 * Generates the PWA icons as PNGs with no image dependencies.
 *
 * The mark is an induction-hob ring: an orange annulus on black, which reads
 * clearly at 40px on a home screen and matches the app's accent colour.
 *
 * Run with: node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BLACK = [0x00, 0x00, 0x00];
const ACCENT = [0xff, 0x7a, 0x29];

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixelAt) {
  // One filter byte (0 = None) per scanline, then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Ring geometry, with a 1px-ish antialiased edge so it doesn't look jagged. */
function ringPixel(size, outerRatio, innerRatio) {
  const center = (size - 1) / 2;
  const outer = size * outerRatio;
  const inner = size * innerRatio;
  const feather = Math.max(1, size / 128);

  return (x, y) => {
    const distance = Math.hypot(x - center, y - center);
    const outerEdge = clamp01((outer - distance) / feather);
    const innerEdge = clamp01((distance - inner) / feather);
    const alpha = Math.min(outerEdge, innerEdge);
    return blend(BLACK, ACCENT, alpha);
  };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function blend(from, to, alpha) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * alpha),
    Math.round(from[1] + (to[1] - from[1]) * alpha),
    Math.round(from[2] + (to[2] - from[2]) * alpha),
  ];
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  // [filename, size, outer radius ratio, inner radius ratio]
  ['icon-192.png', 192, 0.36, 0.22],
  ['icon-512.png', 512, 0.36, 0.22],
  ['apple-touch-icon.png', 180, 0.36, 0.22],
  // Maskable icons are cropped to a safe zone of ~80%; shrink the mark.
  ['icon-maskable-512.png', 512, 0.28, 0.17],
];

for (const [name, size, outer, inner] of targets) {
  writeFileSync(join(OUT_DIR, name), encodePng(size, ringPixel(size, outer, inner)));
  console.log(`wrote ${name} (${size}x${size})`);
}
