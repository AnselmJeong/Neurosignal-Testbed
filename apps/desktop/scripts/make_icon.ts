// Generates assets/AppIcon.iconset (macOS app icon PNGs) without dependencies:
// a rounded-square tile with a neural spike trace and a sensor node.
// Usage: bun scripts/make_icon.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size); view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

type Vec = [number, number];
// Trace in unit coordinates (0..1), drawn across the tile.
const TRACE: Vec[] = [[0.17, 0.56], [0.33, 0.56], [0.39, 0.47], [0.45, 0.62], [0.52, 0.24], [0.59, 0.78],
  [0.65, 0.5], [0.70, 0.56], [0.83, 0.56]];

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const [px, py] = p; const [ax, ay] = a; const [bx, by] = b;
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function roundedRectDistance(p: Vec, inset: number, radius: number): number {
  const half = 0.5 - inset;
  const qx = Math.abs(p[0] - 0.5) - (half - radius);
  const qy = Math.abs(p[1] - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function blend(dst: number[], src: number[], alpha: number): void {
  for (let i = 0; i < 3; i++) dst[i] = (dst[i] ?? 0) * (1 - alpha) + (src[i] ?? 0) * alpha;
}

export function renderIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const px = 1 / size; // one pixel in unit space, for antialiasing
  const cover = (distance: number) => Math.max(0, Math.min(1, 0.5 - distance / px));
  const stroke = Math.max(0.034, 1.6 * px);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p: Vec = [(x + 0.5) / size, (y + 0.5) / size];
      // macOS tile: ~10% margin, continuous-ish corner radius.
      const tile = cover(roundedRectDistance(p, 0.1, 0.18));
      if (tile <= 0) continue;
      const t = p[1];
      const color = [16 + 14 * t, 30 + 22 * t, 58 + 30 * t]; // deep navy gradient
      // Faint grid lines (signal paper feel), only where they resolve.
      if (size >= 128) {
        const gx = Math.abs(((p[0] - 0.1) * 10) % 1 - 0.5); const gy = Math.abs(((p[1] - 0.1) * 10) % 1 - 0.5);
        const grid = Math.max(cover((0.5 - gx) / 10 - px * 0.4), cover((0.5 - gy) / 10 - px * 0.4));
        blend(color, [70, 96, 140], grid * 0.25);
      }
      let d = Infinity;
      for (let i = 0; i + 1 < TRACE.length; i++) d = Math.min(d, segmentDistance(p, TRACE[i]!, TRACE[i + 1]!));
      blend(color, [47, 181, 165], 0.28 * Math.exp(-((d / (stroke * 2.4)) ** 2))); // soft glow
      blend(color, [86, 226, 204], cover(d - stroke / 2));
      const node = Math.hypot(p[0] - 0.52, p[1] - 0.24);
      blend(color, [255, 214, 102], cover(node - Math.max(0.045, 2 * px)));
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(color[0] ?? 0); rgba[i + 1] = Math.round(color[1] ?? 0); rgba[i + 2] = Math.round(color[2] ?? 0);
      rgba[i + 3] = Math.round(255 * tile);
    }
  }
  return rgba;
}

if (import.meta.main) {
  const out = join(import.meta.dir, '..', 'assets', 'AppIcon.iconset');
  mkdirSync(out, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const size = base * scale;
      const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`;
      writeFileSync(join(out, name), encodePng(size, renderIcon(size)));
      console.log(`${name} ${size}px`);
    }
  }
}
