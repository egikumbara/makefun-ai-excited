// "The Whale in the Teacup" — ai-excited-01 entry.
//
// A giant whale bursts diagonally out of a tiny teacup on a wooden table
// while a tiny onlooker throws their arms up. The joke is scale: the whole
// whale is coming out of the cup. Flat poster style, high contrast, drawn
// procedurally with a tiny software rasteriser (pixel buffer + shape
// primitives + a 5x7 bitmap font) and a hand-rolled PNG writer. Standard
// library only, fully deterministic: one fixed seed, no clocks, no I/O
// other than writing /output/entry.png. Runs on Node 22.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;

type RGB = [number, number, number];

// --- Seeded PRNG (xorshift32). Only used for stars and droplets. --------
function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    return (s >>> 0) / 4294967296;
  };
}
const rand = xorshift32(0xC0FFEE);

// --- Colour mixing --------------------------------------------------------
function blend(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// --- Image buffer + drawing primitives ------------------------------------
interface Img {
  w: number;
  h: number;
  data: Uint8Array;
}

function newImg(w: number, h: number): Img {
  return { w, h, data: new Uint8Array(w * h * 3) };
}

function put(img: Img, x: number, y: number, c: RGB): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) return;
  const o = (iy * img.w + ix) * 3;
  img.data[o] = c[0];
  img.data[o + 1] = c[1];
  img.data[o + 2] = c[2];
}

function fillRect(img: Img, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const xa = Math.max(0, Math.floor(Math.min(x0, x1)));
  const xb = Math.min(img.w - 1, Math.ceil(Math.max(x0, x1)));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1)));
  const yb = Math.min(img.h - 1, Math.ceil(Math.max(y0, y1)));
  for (let y = ya; y <= yb; y++) {
    let o = (y * img.w + xa) * 3;
    for (let x = xa; x <= xb; x++, o += 3) {
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
    }
  }
}

function vGradient(img: Img, y0: number, y1: number, top: RGB, bottom: RGB): void {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    fillRect(img, 0, y, img.w - 1, y, blend(top, bottom, (y - y0) / (y1 - y0)));
  }
}

function circle(img: Img, cx: number, cy: number, r: number, c: RGB): void {
  const r2 = r * r;
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(img.w - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(img.h - 1, Math.ceil(cy + r));
  for (let y = ya; y <= yb; y++) {
    const dy = y - cy;
    for (let x = xa; x <= xb; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) put(img, x, y, c);
    }
  }
}

function ellipse(img: Img, cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  const xa = Math.max(0, Math.floor(cx - rx));
  const xb = Math.min(img.w - 1, Math.ceil(cx + rx));
  const ya = Math.max(0, Math.floor(cy - ry));
  const yb = Math.min(img.h - 1, Math.ceil(cy + ry));
  for (let y = ya; y <= yb; y++) {
    const dy = (y - cy) / ry;
    for (let x = xa; x <= xb; x++) {
      const dx = (x - cx) / rx;
      if (dx * dx + dy * dy <= 1) put(img, x, y, c);
    }
  }
}

// Even-odd scanline fill. pts is a flat [x0,y0,x1,y1,...] list.
function polygon(img: Img, pts: number[], c: RGB): void {
  const n = pts.length / 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, pts[i * 2 + 1]);
    hi = Math.max(hi, pts[i * 2 + 1]);
  }
  for (let y = Math.max(0, Math.floor(lo)); y <= Math.min(img.h - 1, Math.ceil(hi)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2];
      const ay = pts[i * 2 + 1];
      const bx = pts[j * 2];
      const by = pts[j * 2 + 1];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      fillRect(img, Math.ceil(xs[k]), y, Math.floor(xs[k + 1]), y, c);
    }
  }
}

// A thick segment rendered as a quad.
function thickLine(img: Img, x0: number, y0: number, x1: number, y1: number, w: number, c: RGB): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  polygon(
    img,
    [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny],
    c,
  );
}

function quadBezier(p0: [number, number], p1: [number, number], p2: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

// --- 5x7 bitmap font (glyphs we need; rows are 5 bits, MSB on the left) ---
const GLYPHS: Record<string, number[]> = {
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
};

function drawText(img: Img, text: string, x: number, y: number, scale: number, c: RGB): void {
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (g[row] & (1 << (4 - col))) {
            fillRect(
              img,
              cx + col * scale,
              y + row * scale,
              cx + (col + 1) * scale - 1,
              y + (row + 1) * scale - 1,
              c,
            );
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

// --- Palette: flat poster colours, high contrast ---------------------------
const SKY_TOP: RGB = [10, 24, 50];
const SKY_BOTTOM: RGB = [18, 64, 100];
const MOON: RGB = [255, 239, 198];
const MOON_SPOT: RGB = [230, 203, 148];
const STAR: RGB = [216, 233, 255];
const WOOD_TOP: RGB = [150, 96, 46];
const WOOD_BOTTOM: RGB = [86, 50, 22];
const WOOD_EDGE: RGB = [192, 130, 64];
const WHALE: RGB = [88, 166, 234];
const WHALE_DARK: RGB = [44, 104, 170];
const BELLY: RGB = [255, 233, 192];
const FOAM: RGB = [242, 249, 255];
const FOAM_BLUE: RGB = [170, 210, 242];
const CUP: RGB = [255, 251, 240];
const CUP_TEAL: RGB = [28, 142, 142];
const SAUCER: RGB = [240, 228, 207];
const SPOON: RGB = [198, 200, 206];
const PERSON: RGB = [18, 26, 42];
const INK: RGB = [12, 20, 36];
const GOLD: RGB = [255, 211, 64];
const GOLD_INK: RGB = [26, 30, 54];
const STREAK: RGB = [152, 198, 236];

// --- The scene --------------------------------------------------------------
function paint(): Img {
  const img = newImg(W, H);

  // Night sky.
  vGradient(img, 0, 840, SKY_TOP, SKY_BOTTOM);

  // Stars, keeping the moon's corner clear.
  for (let i = 0; i < 130; i++) {
    const x = rand() * W;
    const y = rand() * 700;
    if (Math.hypot(x - 835, y - 165) < 115) continue;
    const r = rand() < 0.12 ? 2.6 : rand() < 0.4 ? 1.8 : 1.1;
    circle(img, x, y, r, STAR);
  }

  // Moon, upper right, with craters.
  circle(img, 835, 165, 72, MOON);
  circle(img, 810, 145, 13, MOON_SPOT);
  circle(img, 858, 188, 10, MOON_SPOT);
  circle(img, 844, 135, 7, MOON_SPOT);

  // Speed lines: the burst of motion behind the whale.
  const streaks: [number, number, number, number][] = [
    [118, 640, 298, 562],
    [92, 742, 282, 692],
    [702, 298, 562, 328],
    [762, 422, 612, 422],
    [182, 418, 332, 378],
    [642, 178, 522, 228],
  ];
  for (const [x0, y0, x1, y1] of streaks) thickLine(img, x0, y0, x1, y1, 7, STREAK);

  // Wooden table.
  vGradient(img, 840, H, WOOD_TOP, WOOD_BOTTOM);
  fillRect(img, 0, 840, W - 1, 848, WOOD_EDGE);

  // The whale: one great arc breaching out of the cup.
  // Spine runs from the cup (500, 792) up to the head (292, 238).
  const spine0: [number, number] = [500, 792];
  const spine1: [number, number] = [392, 522];
  const spine2: [number, number] = [292, 238];

  // Body width along the spine: narrow tail, fat belly, broad head.
  function widthAt(t: number): number {
    if (t < 0.12) return 28 + (t / 0.12) * 42;
    if (t < 0.45) return 70 + Math.sin(((t - 0.12) / 0.33) * Math.PI * 0.5) * 78;
    return 148 - ((t - 0.45) / 0.55) * 52;
  }

  // Body: overlapping discs along the spine.
  for (let i = 0; i <= 140; i++) {
    const t = i / 140;
    const [x, y] = quadBezier(spine0, spine1, spine2, t);
    circle(img, x, y, widthAt(t), WHALE);
  }
  // Broad rounded head.
  const [hx, hy] = spine2;
  circle(img, hx, hy, 100, WHALE);

  // Dark dorsal shading along the upper-left edge of the body.
  for (let i = 0; i <= 90; i++) {
    const t = 0.08 + (i / 90) * 0.8;
    const [x, y] = quadBezier(spine0, spine1, spine2, t);
    const [nx, ny] = quadBezier(spine0, spine1, spine2, Math.min(1, t + 0.02));
    const dx = nx - x;
    const dy = ny - y;
    const len = Math.hypot(dx, dy) || 1;
    const w = widthAt(t);
    circle(img, x + (dy / len) * w * 0.6, y - (dx / len) * w * 0.6, w * 0.32, WHALE_DARK);
  }

  // Cream belly band along the lower-right side of the body.
  for (let i = 0; i <= 90; i++) {
    const t = 0.15 + (i / 90) * 0.7;
    const [x, y] = quadBezier(spine0, spine1, spine2, t);
    const [nx, ny] = quadBezier(spine0, spine1, spine2, Math.min(1, t + 0.02));
    const dx = nx - x;
    const dy = ny - y;
    const len = Math.hypot(dx, dy) || 1;
    const w = widthAt(t);
    circle(img, x - (dy / len) * w * 0.5, y + (dx / len) * w * 0.5, w * 0.36, BELLY);
  }
  // Cream jaw under the head.
  circle(img, hx + 28, hy + 58, 40, BELLY);

  // Pectoral fin, swept back.
  polygon(img, [450, 562, 558, 642, 468, 602], WHALE_DARK);

  // Eye + joyful open mouth on the head.
  circle(img, hx - 28, hy - 20, 12, INK);
  circle(img, hx - 24, hy - 24, 4, FOAM);
  thickLine(img, hx - 60, hy + 36, hx - 8, hy + 54, 7, WHALE_DARK);
  thickLine(img, hx - 8, hy + 54, hx + 44, hy + 46, 7, WHALE_DARK);

  // --- Water exploding out of the cup (drawn before the cup itself) ---
  const cupX = 500;
  const cupY = 800;
  // Splash pool and crown.
  ellipse(img, cupX, cupY + 18, 150, 34, FOAM);
  ellipse(img, cupX, cupY + 6, 118, 26, FOAM_BLUE);
  ellipse(img, cupX, cupY + 2, 92, 20, FOAM);
  // Jagged foam crown: peaks of varying height read as exploding water.
  polygon(
    img,
    [
      418, 824, 418, 786, 436, 740, 456, 780, 474, 730, 494, 776,
      512, 736, 532, 778, 550, 742, 568, 784, 574, 824,
    ],
    FOAM,
  );
  // Droplets just above the crown.
  for (let i = 0; i < 22; i++) {
    const x = 418 + rand() * 156;
    const y = 700 + rand() * 40 - (rand() < 0.3 ? 26 : 0);
    circle(img, x, y, 2 + rand() * 4, rand() < 0.5 ? FOAM : FOAM_BLUE);
  }
  // Droplets flung off the whale's body.
  for (let i = 0; i < 80; i++) {
    const t = rand();
    const [x, y] = quadBezier(spine0, spine1, spine2, t);
    const ang = rand() * Math.PI * 2;
    const dist = widthAt(t) + 8 + rand() * 60;
    circle(
      img,
      x + Math.cos(ang) * dist,
      y + Math.sin(ang) * dist * 0.8,
      2 + rand() * 4,
      rand() < 0.5 ? FOAM : FOAM_BLUE,
    );
  }

  // --- The teacup, drawn last so it sits in front of the tail base ---
  // Saucer first, then the cup body, rim, stripe and handle.
  ellipse(img, cupX, cupY + 32, 118, 18, SAUCER);
  ellipse(img, cupX, cupY + 30, 98, 14, CUP);
  polygon(
    img,
    [cupX - 78, cupY - 40, cupX + 78, cupY - 40, cupX + 56, cupY + 30, cupX - 56, cupY + 30],
    CUP,
  );
  ellipse(img, cupX, cupY - 40, 78, 11, CUP);
  polygon(
    img,
    [cupX - 74, cupY - 20, cupX + 74, cupY - 20, cupX + 68, cupY - 6, cupX - 68, cupY - 6],
    CUP_TEAL,
  );
  // Handle: a squared C on the right side.
  thickLine(img, cupX + 78, cupY - 24, cupX + 104, cupY - 24, 10, CUP);
  thickLine(img, cupX + 104, cupY - 24, cupX + 112, cupY, 10, CUP);
  thickLine(img, cupX + 112, cupY, cupX + 104, cupY + 20, 10, CUP);
  thickLine(img, cupX + 104, cupY + 20, cupX + 78, cupY + 20, 10, CUP);
  // A tiny spoon on the table beside the cup — another scale cue.
  ellipse(img, 672, 818, 12, 8, SPOON);
  thickLine(img, 682, 818, 718, 830, 5, SPOON);

  // --- Tiny onlooker, far right, arms thrown up in amazement ---
  const px = 868;
  const py = 800;
  thickLine(img, px - 6, py + 28, px - 10, py + 62, 7, PERSON);
  thickLine(img, px + 6, py + 28, px + 12, py + 62, 7, PERSON);
  polygon(img, [px - 12, py - 6, px + 12, py - 6, px + 9, py + 30, px - 9, py + 30], PERSON);
  thickLine(img, px - 10, py - 2, px - 30, py - 34, 7, PERSON);
  thickLine(img, px + 10, py - 2, px + 32, py - 32, 7, PERSON);
  circle(img, px, py - 18, 11, PERSON);

  // --- Golden "WOW!" starburst above the onlooker ---
  const bx = 780;
  const by = 612;
  const star: number[] = [];
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 96 : 58;
    star.push(bx + Math.cos(ang) * r, by + Math.sin(ang) * r);
  }
  polygon(img, star, GOLD);
  for (let i = 0; i < 24; i++) {
    const j = (i + 1) % 24;
    thickLine(img, star[i * 2], star[i * 2 + 1], star[j * 2], star[j * 2 + 1], 5, GOLD_INK);
  }
  drawText(img, 'WOW!', bx - 60, by - 17, 5, GOLD_INK);

  return img;
}

// --- Minimal deterministic PNG writer (RGB, 8-bit, filter 0) ---------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function toPNG(img: Img): Uint8Array {
  const raw = new Uint8Array((img.w * 3 + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w * 3 + 1)] = 0; // filter: none
    raw.set(
      img.data.subarray(y * img.w * 3, (y + 1) * img.w * 3),
      y * (img.w * 3 + 1) + 1,
    );
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.w);
  dv.setUint32(4, img.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// --- Main -------------------------------------------------------------------
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), toPNG(paint()));
