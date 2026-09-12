#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'web', 'assets');

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(width, height, rgba, filePath) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const scanlineStart = y * (width * 4 + 1);
    scanlines[scanlineStart] = 0;
    rgba.copy(scanlines, scanlineStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const png = Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);

  fs.writeFileSync(filePath, png);
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function blend(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function roundedRectContains(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

const iconBackground = '#111315';
const iconBars = [
  { x: 15, y: 30, width: 8, height: 23, fill: '#356ae6' },
  { x: 28, y: 17, width: 8, height: 36, fill: '#e45f50' },
  { x: 41, y: 25, width: 8, height: 28, fill: '#f8f8f4' }
];

function drawIcon(size, fileName) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const total = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) * 64 / size;
          const py = (y + (sy + 0.5) / samples) * 64 / size;
          if (!roundedRectContains(px, py, 0, 0, 64, 64, 14)) continue;
          let color = iconBackground;
          for (const bar of iconBars) {
            if (roundedRectContains(px, py, bar.x, bar.y, bar.width, bar.height, 4)) color = bar.fill;
          }
          hexToRgb(color).forEach((value, i) => { total[i] += value; });
          covered += 1;
        }
      }
      const offset = (y * size + x) * 4;
      if (covered) total.forEach((value, i) => { rgba[offset + i] = Math.round(value / covered); });
      rgba[offset + 3] = Math.round(255 * covered / (samples * samples));
    }
  }
  writePng(size, size, rgba, path.join(assets, fileName));
}

fs.mkdirSync(assets, { recursive: true });
drawIcon(180, 'apple-touch-icon.png');
drawIcon(192, 'icon-192.png');
drawIcon(512, 'icon-512.png');

fs.writeFileSync(path.join(assets, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Gama Music">
  <rect width="64" height="64" rx="14" fill="${iconBackground}"/>
${iconBars.map((bar) => `  <rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="4" fill="${bar.fill}"/>`).join('\n')}
</svg>\n`);

console.log('Generated Gama Music app icons.');
