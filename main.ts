// "The Whale in the Teacup" — ai-excited-01 entry.
//
// A colossal whale breaches out of a tiny teacup on a wooden table while a
// tiny onlooker throws their arms up. Scale twist + huge diagonal focal
// point + flat poster style, drawn procedurally with a small 2D canvas
// (pixel buffer, shape primitives, tiny bitmap font) and a pure-stdlib PNG
// writer. Fully deterministic: fixed seed, no timestamps, no I/O besides
// writing /output/entry.png. Runs on Node 22+, standard library only.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — only used for star/droplet placement.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261116);

// ---------------------------------------------------------------------------
// Colour helpers: colours are [r, g, b].
// ---------------------------------------------------------------------------
type RGB = [number, number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix = (c0: RGB, c1: RGB, t: number): RGB => [
  Math.round(lerp(c0[0], c1[0], t)),
  Math.round(lerp(c0[1], c1[1], t)),
  Math.round(lerp(c0[2], c1[2], t)),
];

// ---------------------------------------------------------------------------
// Canvas: RGB pixel buffer with shape primitives.
// ---------------------------------------------------------------------------
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly buf: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 3);
  }

  set(x: number, y: number, c: RGB): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return;
    const o = (iy * this.w + ix) * 3;
    this.buf[o] = c[0];
    this.buf[o + 1] = c[1];
    this.buf[o + 2] = c[2];
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const xa = Math.max(0, Math.floor(Math.min(x0, x1)));
    const xb = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1)));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1)));
    const yb = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1)));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const o = (y * this.w + x) * 3;
        this.buf[o] = c[0];
        this.buf[o + 1] = c[1];
        this.buf[o + 2] = c[2];
      }
    }
  }

  // Vertical gradient band.
  vgrad(y0: number, y1: number, top: RGB, bottom: RGB): void {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) {
      const c = mix(top, bottom, (y - y0) / (y1 - y0));
      this.rect(0, y, this.w - 1, y, c);
    }
  }

  disc(cx: number, cy: number, r: number, c: RGB): void {
    const r2 = r * r;
    const xa = Math.max(0, Math.floor(cx - r));
    const xb = Math.min(this.w - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r));
    const yb = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) {
      const dy = y - cy;
      for (let x = xa; x <= xb; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) {
          const o = (y * this.w + x) * 3;
          this.buf[o] = c[0];
          this.buf[o + 1] = c[1];
          this.buf[o + 2] = c[2];
        }
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
    const xa = Math.max(0, Math.floor(cx - rx));
    const xb = Math.min(this.w - 1, Math.ceil(cx + rx));
    const ya = Math.max(0, Math.floor(cy - ry));
    const yb = Math.min(this.h - 1, Math.ceil(cy + ry));
    for (let y = ya; y <= yb; y++) {
      const dy = (y - cy) / ry;
      for (let x = xa; x <= xb; x++) {
        const dx = (x - cx) / rx;
        if (dx * dx + dy * dy <= 1) {
          const o = (y * this.w + x) * 3;
          this.buf[o] = c[0];
          this.buf[o + 1] = c[1];
          this.buf[o + 2] = c[2];
        }
      }
    }
  }

  // Filled polygon, even-odd scanline fill. pts: flat [x0,y0,x1,y1,...].
  poly(pts: number[], c: RGB): void {
    const n = pts.length / 2;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minY = Math.min(minY, pts[i * 2 + 1]);
      maxY = Math.max(maxY, pts[i * 2 + 1]);
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.h - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = pts[i * 2];
        const yA = pts[i * 2 + 1];
        const x1 = pts[j * 2];
        const yB = pts[j * 2 + 1];
        if ((yA <= y && yB > y) || (yB <= y && yA > y)) {
          xs.push(x0 + ((y - yA) / (yB - yA)) * (x1 - x0));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k]));
        const xb = Math.min(this.w - 1, Math.floor(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          const o = (y * this.w + x) * 3;
          this.buf[o] = c[0];
          this.buf[o + 1] = c[1];
          this.buf[o + 2] = c[2];
        }
      }
    }
  }

  // Thick line drawn as a quad.
  line(x0: number, y0: number, x1: number, y1: number, wdt: number, c: RGB): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (wdt / 2);
    const ny = (dx / len) * (wdt / 2);
    this.poly([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], c);
  }

  // Quadratic bezier point.
  static qbez(p0: number[], p1: number[], p2: number[], t: number): [number, number] {
    const u = 1 - t;
    return [
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ];
  }
}

// ---------------------------------------------------------------------------
// Tiny 5x7 bitmap font (only the glyphs we need). Rows are 5 bits, MSB left.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
};

function drawText(cv: Canvas, text: string, x: number, y: number, scale: number, c: RGB): void {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) {
      cx += 6 * scale;
      continue;
    }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row] & (1 << (4 - col))) {
          cv.rect(cx + col * scale, y + row * scale, cx + (col + 1) * scale - 1, y + (row + 1) * scale - 1, c);
        }
      }
    }
    cx += 6 * scale;
  }
}

// ---------------------------------------------------------------------------
// Palette — flat poster colours, high contrast.
// ---------------------------------------------------------------------------
const SKY_TOP: RGB = [8, 22, 48]; // deep midnight blue
const SKY_BOT: RGB = [16, 66, 102]; // deep teal-blue
const MOON: RGB = [255, 238, 196];
const MOON_SHADE: RGB = [232, 205, 150];
const STAR: RGB = [214, 232, 255];
const TABLE_TOP: RGB = [146, 94, 44]; // warm amber wood
const TABLE_BOT: RGB = [84, 48, 20];
const TABLE_EDGE: RGB = [190, 128, 62];
const WHALE: RGB = [86, 164, 232]; // bright sky blue — pops on dark sky
const WHALE_DARK: RGB = [43, 102, 168];
const BELLY: RGB = [255, 232, 190]; // warm cream belly
const SPRAY: RGB = [240, 248, 255]; // near-white spray
const SPRAY_BLUE: RGB = [168, 208, 240];
const CUP: RGB = [255, 250, 238];
const CUP_STRIPE: RGB = [30, 140, 140]; // teal stripe
const SAUCER: RGB = [238, 226, 205];
const PERSON: RGB = [16, 24, 40];
const BURST: RGB = [255, 210, 63]; // golden starburst
const BURST_INK: RGB = [24, 28, 52];
const SPEED: RGB = [150, 196, 235];

// ---------------------------------------------------------------------------
// Scene.
// ---------------------------------------------------------------------------
function draw(): Canvas {
  const cv = new Canvas(W, H);

  // --- Night sky ---
  cv.vgrad(0, 860, SKY_TOP, SKY_BOT);

  // --- Stars (fixed seed) ---
  for (let i = 0; i < 130; i++) {
    const x = rnd() * W;
    const y = rnd() * 700;
    const r = rnd() < 0.12 ? 2.6 : rnd() < 0.4 ? 1.8 : 1.1;
    // Keep the moon area clear.
    if (Math.hypot(x - 838, y - 168) < 110) continue;
    cv.disc(x, y, r, STAR);
  }

  // --- Moon, upper right ---
  cv.disc(838, 168, 74, MOON);
  cv.disc(812, 148, 14, MOON_SHADE);
  cv.disc(862, 190, 10, MOON_SHADE);
  cv.disc(846, 138, 7, MOON_SHADE);

  // --- Speed lines: momentum, radiating behind the whale ---
  const speedLines: [number, number, number, number][] = [
    [120, 640, 300, 560],
    [90, 740, 280, 690],
    [700, 300, 560, 330],
    [760, 420, 610, 420],
    [180, 420, 330, 380],
    [640, 180, 520, 230],
  ];
  for (const [x0, y0, x1, y1] of speedLines) cv.line(x0, y0, x1, y1, 7, SPEED);

  // --- Table ---
  cv.vgrad(830, H, TABLE_TOP, TABLE_BOT);
  cv.rect(0, 830, W - 1, 838, TABLE_EDGE);

  // --- The whale: a great arc breaching out of the cup ---
  // Spine: quadratic bezier from the cup up to the upper left.
  const p0: number[] = [512, 810];
  const p1: number[] = [400, 540];
  const p2: number[] = [310, 250];
  // Radius along the spine: tail narrow, belly fat, head staying broad
  // so the head reads as a rounded whale head, not a point.
  const radiusAt = (t: number): number => {
    if (t < 0.1) return 26 + (t / 0.1) * 44;
    if (t < 0.45) return 70 + Math.sin(((t - 0.1) / 0.35) * Math.PI * 0.5) * 80;
    return 150 - ((t - 0.45) / 0.55) * 55;
  };
  // Body: overlapping discs along the spine (140 steps -> smooth silhouette).
  for (let i = 0; i <= 140; i++) {
    const t = i / 140;
    const [x, y] = Canvas.qbez(p0, p1, p2, t);
    cv.disc(x, y, radiusAt(t), WHALE);
  }
  // Head: a broad rounded disc at the end of the spine.
  const [hx, hy] = p2;
  cv.disc(hx, hy, 102, WHALE);
  // Dorsal shading: a NARROW darker stripe along the upper-left edge.
  for (let i = 0; i <= 90; i++) {
    const t = 0.08 + (i / 90) * 0.8;
    const [x, y] = Canvas.qbez(p0, p1, p2, t);
    const [x2, y2] = Canvas.qbez(p0, p1, p2, Math.min(1, t + 0.02));
    const dx = x2 - x;
    const dy = y2 - y;
    const len = Math.hypot(dx, dy) || 1;
    const ox = (dy / len) * radiusAt(t) * 0.62;
    const oy = (-dx / len) * radiusAt(t) * 0.62;
    cv.disc(x + ox, y + oy, radiusAt(t) * 0.32, WHALE_DARK);
  }
  // Belly: a NARROW cream band along the lower-right side of the body.
  for (let i = 0; i <= 90; i++) {
    const t = 0.15 + (i / 90) * 0.7;
    const [x, y] = Canvas.qbez(p0, p1, p2, t);
    const [x2, y2] = Canvas.qbez(p0, p1, p2, Math.min(1, t + 0.02));
    const dx = x2 - x;
    const dy = y2 - y;
    const len = Math.hypot(dx, dy) || 1;
    const ox = (-dy / len) * radiusAt(t) * 0.5;
    const oy = (dx / len) * radiusAt(t) * 0.5;
    cv.disc(x + ox, y + oy, radiusAt(t) * 0.36, BELLY);
  }
  // Cream jaw under the head.
  cv.disc(hx + 30, hy + 60, 42, BELLY);

  // Pectoral fin, swept back.
  cv.poly([452, 560, 560, 640, 470, 600], WHALE_DARK);

  // Eye on the head + joyful open mouth below it.
  cv.disc(hx - 30, hy - 22, 12, [12, 20, 36]);
  cv.disc(hx - 26, hy - 26, 4, SPRAY);
  cv.line(hx - 62, hy + 34, hx - 10, hy + 52, 7, WHALE_DARK);
  cv.line(hx - 10, hy + 52, hx + 42, hy + 44, 7, WHALE_DARK);

  // --- Water exploding out of the cup (behind the cup itself) ---
  const cupX = 512;
  const cupY = 800;
  // Big splash crown around the cup.
  cv.ellipse(cupX, cupY + 18, 150, 34, SPRAY);
  cv.ellipse(cupX, cupY + 6, 118, 26, SPRAY_BLUE);
  cv.ellipse(cupX, cupY + 2, 92, 20, SPRAY);
  // Splash crown: a jagged foam silhouette behind the cup, peaks of
  // varying height so it reads as exploding water, not sticks.
  cv.poly(
    [
      430, 824, 430, 786, 448, 752, 468, 780, 486, 744, 506, 776,
      524, 748, 544, 778, 562, 754, 580, 784, 585, 824,
    ],
    SPRAY,
  );
  // A few droplets above the crown.
  for (let i = 0; i < 22; i++) {
    const x = 430 + rnd() * 155;
    const y = 700 + rnd() * 40 - (rnd() < 0.3 ? 26 : 0);
    cv.disc(x, y, 2 + rnd() * 4, rnd() < 0.5 ? SPRAY : SPRAY_BLUE);
  }
  // Droplets flying off the whale and the splash (fixed seed).
  for (let i = 0; i < 80; i++) {
    const t = rnd();
    const [x, y] = Canvas.qbez(p0, p1, p2, t);
    const ang = rnd() * Math.PI * 2;
    const dist = radiusAt(t) + 8 + rnd() * 60;
    const dx = x + Math.cos(ang) * dist;
    const dy = y + Math.sin(ang) * dist * 0.8;
    cv.disc(dx, dy, 2 + rnd() * 4, rnd() < 0.5 ? SPRAY : SPRAY_BLUE);
  }
  // (No streaks on the body: they read as scratches. Droplets carry it.)

  // --- Teacup, drawn LAST over the whale's tail base so the joke reads:
  // a tiny cup, and the whole whale is coming out of it. ---
  cv.ellipse(cupX, cupY + 32, 112, 18, SAUCER);
  cv.ellipse(cupX, cupY + 30, 92, 14, CUP);
  // Cup body: tall trapezoid with a wide rim, clearly visible in front
  // of the tail. The rim ellipse is bisected by the whale's tail, which
  // is exactly the joke: the whale is coming out of the cup.
  cv.poly([cupX - 70, cupY - 34, cupX + 70, cupY - 34, cupX + 50, cupY + 28, cupX - 50, cupY + 28], CUP);
  cv.ellipse(cupX, cupY - 34, 70, 10, CUP);
  // Teal stripe.
  cv.poly([cupX - 66, cupY - 16, cupX + 66, cupY - 16, cupX + 60, cupY - 4, cupX - 60, cupY - 4], CUP_STRIPE);
  // Handle: a bigger squared C on the right side.
  cv.line(cupX + 70, cupY - 20, cupX + 96, cupY - 20, 10, CUP);
  cv.line(cupX + 96, cupY - 20, cupX + 104, cupY + 0, 10, CUP);
  cv.line(cupX + 104, cupY + 0, cupX + 96, cupY + 18, 10, CUP);
  cv.line(cupX + 96, cupY + 18, cupX + 70, cupY + 18, 10, CUP);
  // A tiny spoon on the table beside the cup — scale cue.
  cv.ellipse(668, 818, 12, 8, [198, 200, 206]);
  cv.line(678, 818, 714, 830, 5, [198, 200, 206]);

  // --- Tiny onlooker, far right, arms thrown up ---
  const px = 872;
  const py = 800;
  // Legs.
  cv.line(px - 6, py + 28, px - 10, py + 62, 7, PERSON);
  cv.line(px + 6, py + 28, px + 12, py + 62, 7, PERSON);
  // Body.
  cv.poly([px - 12, py - 6, px + 12, py - 6, px + 9, py + 30, px - 9, py + 30], PERSON);
  // Arms up in amazement.
  cv.line(px - 10, py - 2, px - 30, py - 34, 7, PERSON);
  cv.line(px + 10, py - 2, px + 32, py - 32, 7, PERSON);
  // Head.
  cv.disc(px, py - 18, 11, PERSON);

  // --- "WOW!" starburst above the onlooker ---
  const bx = 788;
  const by = 618;
  const burstPts: number[] = [];
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 96 : 58;
    burstPts.push(bx + Math.cos(ang) * r, by + Math.sin(ang) * r);
  }
  cv.poly(burstPts, BURST);
  // Dark outline: re-draw the star as a stroked polyline approximation.
  for (let i = 0; i < 24; i++) {
    const j = (i + 1) % 24;
    cv.line(burstPts[i * 2], burstPts[i * 2 + 1], burstPts[j * 2], burstPts[j * 2 + 1], 5, BURST_INK);
  }
  drawText(cv, 'WOW!', bx - 60, by - 17, 5, BURST_INK);

  return cv;
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG writer (RGB, 8-bit, filter 0, zlib level 9).
// ---------------------------------------------------------------------------
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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePNG(cv: Canvas): Uint8Array {
  const raw = new Uint8Array((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) {
    raw[y * (cv.w * 3 + 1)] = 0; // filter: none
    raw.set(cv.buf.subarray(y * cv.w * 3, (y + 1) * cv.w * 3), y * (cv.w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, cv.w);
  dv.setUint32(4, cv.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 9 });
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
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

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const png = encodePNG(draw());
writeFileSync(join(outDir, 'entry.png'), png);
