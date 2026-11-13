// Erzeugt die PNG-Icons ohne externe Abhängigkeiten (Node zlib).
import { deflateSync, crc32 } from 'node:zlib';

const BG = [11, 87, 208];
const TILES = [
  [255, 255, 255],
  [250, 144, 62],
  [24, 128, 56],
  [161, 66, 244],
];

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function makeIcon(size) {
  const r = size * 0.22; // Eckenradius
  const pad = size * 0.2;
  const gap = Math.max(1, size * 0.07);
  const tile = (size - 2 * pad - gap) / 2;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      if (!inside) continue;
      let col = BG;
      const tx = x + 0.5 - pad;
      const ty = y + 0.5 - pad;
      const ix = tx < tile ? 0 : tx >= tile + gap && tx < 2 * tile + gap ? 1 : -1;
      const iy = ty < tile ? 0 : ty >= tile + gap && ty < 2 * tile + gap ? 1 : -1;
      if (tx >= 0 && ty >= 0 && ix >= 0 && iy >= 0) col = TILES[iy * 2 + ix];
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bit-Tiefe
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
