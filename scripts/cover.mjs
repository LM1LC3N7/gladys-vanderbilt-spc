// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a deep blue gradient, an
// alarm keypad with its display and keys, a shield with a lock, linked by a
// network line. Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const NAVY = [14, 26, 48];
const TEAL = [16, 72, 92];
const WHITE = [242, 244, 248];
const STEEL = [190, 198, 210];
const DARK = [22, 30, 44];
const SCREEN = [20, 34, 52];
const CYAN = [80, 205, 230];
const ORANGE = [255, 138, 36];
const GREEN = [70, 200, 110];
const RED = [228, 66, 58];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance to a segment. */
function segment(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

function pixel(x, y) {
  let color = mix(NAVY, TEAL, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);

  // The network line between the keypad and the shield.
  color = mix(color, CYAN, smooth(2, segment(x, y, 330, 267, 470, 267)) * 0.7);
  for (const dx of [360, 400, 440]) {
    color = mix(color, CYAN, smooth(4, Math.hypot(x - dx, y - 267)));
  }

  // The keypad: a cabinet, a display with two LEDs, a 3×4 grid of keys.
  const pad = roundedBox(x, y, 210, 267, 110, 170, 18);
  color = mix(color, STEEL, smooth(0, Math.abs(pad) - 2));
  color = mix(color, WHITE, smooth(0, pad + 2));
  const display = roundedBox(x, y, 210, 157, 80, 30, 6);
  color = mix(color, SCREEN, smooth(0, display));
  color = mix(color, CYAN, smooth(2, segment(x, y, 150, 157, 250, 157)) * 0.8);
  color = mix(color, GREEN, smooth(6, Math.hypot(x - 160, y - 210)));
  color = mix(color, RED, smooth(6, Math.hypot(x - 185, y - 210)));
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const key = roundedBox(x, y, 160 + col * 50, 255 + row * 44, 18, 14, 5);
      color = mix(color, DARK, smooth(0, key));
    }
  }

  // The shield with a padlock.
  const sx = (x - 600) / 120;
  const sy = (y - 240) / 150;
  const shieldEdge = sy < 0 ? Math.max(Math.abs(sx), -sy) : Math.abs(sx) + sy * sy * 1.0;
  const shield = (shieldEdge - 1) * 120;
  color = mix(color, STEEL, smooth(0, Math.abs(shield) - 3));
  color = mix(color, ORANGE, smooth(0, shield + 3));
  const body = roundedBox(x, y, 600, 290, 46, 38, 8);
  color = mix(color, WHITE, smooth(0, body));
  const shackle = Math.abs(Math.hypot(x - 600, y - 250) - 30);
  if (y < 262) color = mix(color, WHITE, smooth(5, shackle));
  color = mix(color, DARK, smooth(8, Math.hypot(x - 600, y - 284)));
  color = mix(color, DARK, smooth(0, roundedBox(x, y, 600, 302, 4, 14, 2)));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
