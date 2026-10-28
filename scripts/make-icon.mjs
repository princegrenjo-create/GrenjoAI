#!/usr/bin/env node
/**
 * Generates build/icon.png (256x256) and build/icon.ico from procedural pixels.
 *
 * Hand-rolled PNG + ICO encoders: a 20-line zlib/CRC implementation avoids
 * pulling an image library (and its transitive tree) into the build just to draw
 * one icon. The mark is a four-point spark on a dark rounded square — the same
 * visual language as the app's tokens, not a stock glyph.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIZE = 256;
const SS = 3; // supersample factor for anti-aliasing

/* --------------------------------------------------------------- palette --- */

const BG_TOP = [27, 28, 34];
const BG_BOTTOM = [16, 17, 21];
const ACCENT = [139, 124, 255];
const ACCENT_SOFT = [178, 168, 255];
const SPARK = [232, 232, 234];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectSdf(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - halfW + r;
  const qy = Math.abs(y) - halfH + r;
  const outer = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outer + Math.min(Math.max(qx, qy), 0) - r;
}

/** Four-point star (astroid): |u|^(2/3) + |v|^(2/3) <= 1. */
function insideSpark(u, v, scale) {
  const a = Math.abs(u) / scale;
  const b = Math.abs(v) / scale;
  return Math.pow(a, 2 / 3) + Math.pow(b, 2 / 3) <= 1;
}

function sample(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const dx = x - cx;
  const dy = y - cy;

  const sdf = roundedRectSdf(dx, dy, SIZE / 2 - 4, SIZE / 2 - 4, 54);
  if (sdf > 0) return [0, 0, 0, 0];

  // Background: vertical gradient with a faint accent glow from the bottom left.
  const t = Math.min(1, Math.max(0, (y - 4) / (SIZE - 8)));
  let color = mix(BG_TOP, BG_BOTTOM, t);
  const glow = Math.max(0, 1 - Math.hypot(dx + 40, dy - 46) / 150);
  color = mix(color, ACCENT, glow * 0.06);

  // Spark: main four-point star plus a smaller offset companion.
  const main = insideSpark(dx, dy + 2, 86);
  const companion = insideSpark(dx - 52, dy + 54, 30);
  if (main) {
    const shade = 0.82 + 0.18 * (1 - Math.min(1, Math.hypot(dx, dy) / 90));
    color = mix(SPARK, ACCENT_SOFT, 1 - shade);
  } else if (companion) {
    color = mix(ACCENT, ACCENT_SOFT, 0.35);
  }

  return [Math.round(color[0]), Math.round(color[1]), Math.round(color[2]), 255];
}

/* ------------------------------------------------------------------ PNG ---- */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ ICO ---- */

function encodeIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 is encoded as 0
  entry[1] = 0; // height 256 is encoded as 0
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6 + 16

  return Buffer.concat([header, entry, pngBuffer]);
}

/* ----------------------------------------------------------------- main ---- */

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const [pr, pg, pb, pa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const offset = (y * SIZE + x) * 4;
      if (alpha > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
      }
      rgba[offset + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const rgba = render();
const png = encodePng(SIZE, SIZE, rgba);
fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(png));

process.stdout.write(
  `[icon] wrote build/icon.png (${png.length} bytes) and build/icon.ico (${png.length + 22} bytes)\n`,
);
