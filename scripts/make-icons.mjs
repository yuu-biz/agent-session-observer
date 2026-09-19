#!/usr/bin/env node
/**
 * Generates the application icons from `icon-spec.mjs`.
 *
 * Writes `web/public/favicon.svg` (the browser tab icon, also embedded in the
 * single executable along with the rest of the UI) and `build/icons/app.ico`
 * (the Windows executable icon, stamped in by `build-sea.mjs`).
 *
 * The rasteriser is deliberately hand-rolled. Every mark in the icon is a
 * rounded rectangle, so a supersampled coverage test is all that is needed —
 * far less to trust than an image library, and this repository ships no runtime
 * dependencies for exactly that reason. PNG encoding uses `node:zlib`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHAPES, SIZE, toSvg } from './icon-spec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Windows picks the closest entry; these cover every shell surface. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function parseHex(hex) {
  const v = hex.replace('#', '');
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** Signed distance from a point to a rounded rectangle, negative inside. */
function insideRoundRect(px, py, s) {
  const r = Math.min(s.r, s.w / 2, s.h / 2);
  const cx = Math.min(Math.max(px, s.x + r), s.x + s.w - r);
  const cy = Math.min(Math.max(py, s.y + r), s.y + s.h - r);
  const dx = px - cx;
  const dy = py - cy;
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Renders the mark at `size` pixels into straight (non-premultiplied) RGBA.
 * 4x4 supersampling is enough: the shapes are axis aligned, so only the
 * corner arcs need the extra samples.
 */
function render(size) {
  const scale = size / SIZE;
  const sub = 4;
  const px = new Uint8ClampedArray(size * size * 4);

  for (const shape of SHAPES) {
    const [r, g, b] = parseHex(shape.fill);
    const minX = Math.max(0, Math.floor(shape.x * scale) - 1);
    const maxX = Math.min(size - 1, Math.ceil((shape.x + shape.w) * scale) + 1);
    const minY = Math.max(0, Math.floor(shape.y * scale) - 1);
    const maxY = Math.min(size - 1, Math.ceil((shape.y + shape.h) * scale) + 1);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        let hits = 0;
        for (let sy = 0; sy < sub; sy += 1) {
          for (let sx = 0; sx < sub; sx += 1) {
            const ux = (x + (sx + 0.5) / sub) / scale;
            const uy = (y + (sy + 0.5) / sub) / scale;
            if (insideRoundRect(ux, uy, shape)) hits += 1;
          }
        }
        if (hits === 0) continue;
        const a = hits / (sub * sub);
        const i = (y * size + x) * 4;
        // Source-over on straight alpha.
        const da = px[i + 3] / 255;
        const outA = a + da * (1 - a);
        for (let c = 0; c < 3; c += 1) {
          const src = [r, g, b][c];
          const dst = px[i + c];
          px[i + c] = outA === 0 ? 0 : (src * a + dst * da * (1 - a)) / outA;
        }
        px[i + 3] = Math.round(outA * 255);
      }
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA PNG, one filter byte per scanline (filter type 0). */
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Packs PNG frames into an `.ico`. PNG-compressed entries have been understood
 * by Windows since Vista, which is far below anything this app runs on, and
 * they keep the 256px frame from costing a quarter of a megabyte.
 */
function encodeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;
  frames.forEach((frame, i) => {
    const at = i * 16;
    directory[at] = frame.size >= 256 ? 0 : frame.size;
    directory[at + 1] = frame.size >= 256 ? 0 : frame.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(frame.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([header, directory, ...frames.map((f) => f.data)]);
}

export function buildIco() {
  return encodeIco(
    ICO_SIZES.map((size) => ({ size, data: encodePng(size, render(size)) })),
  );
}

export function icoPath() {
  return path.join(root, 'build', 'icons', 'app.ico');
}

function main() {
  const svgPath = path.join(root, 'web', 'public', 'favicon.svg');
  mkdirSync(path.dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, toSvg(), 'utf8');
  console.log(`• ${path.relative(root, svgPath)}`);

  const ico = buildIco();
  mkdirSync(path.dirname(icoPath()), { recursive: true });
  writeFileSync(icoPath(), ico);
  console.log(
    `• ${path.relative(root, icoPath())} (${ICO_SIZES.join(', ')} px, ${(ico.length / 1024).toFixed(1)} KB)`,
  );

  // A 256px PNG is handy for READMEs and for Linux desktop entries.
  const pngPath = path.join(root, 'build', 'icons', 'app-256.png');
  writeFileSync(pngPath, encodePng(256, render(256)));
  console.log(`• ${path.relative(root, pngPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
