// Генерирует assets/icon.png (256) и assets/tray.png (32): тёмный квадрат с четырьмя цветными плитками.
// Без зависимостей: PNG собирается вручную через zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 бит на канал
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // фильтр: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Расстояние со знаком до скруглённого прямоугольника (отрицательное — внутри)
function roundedRectSdf(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
  const pad = size * 0.04;
  const full = size - pad * 2;
  const gap = size * 0.07;
  const inner = size * 0.2;
  const tile = (full - inner * 2 - gap) / 2;
  const tiles = [
    { x: pad + inner, y: pad + inner, color: [255, 204, 0] },
    { x: pad + inner + tile + gap, y: pad + inner, color: [76, 201, 240] },
    { x: pad + inner, y: pad + inner + tile + gap, color: [247, 37, 133] },
    { x: pad + inner + tile + gap, y: pad + inner + tile + gap, color: [128, 237, 153] },
  ];

  const out = Buffer.alloc(size * size * 4);
  const SS = 3; // сглаживание: 3x3 подвыборки на пиксель
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedRectSdf(px, py, pad, pad, full, full, size * 0.22) > 0) continue;
          let color = [34 + (py / size) * -12, 36 + (py / size) * -12, 52 + (py / size) * -16];
          for (const t of tiles) {
            if (roundedRectSdf(px, py, t.x, t.y, tile, tile, size * 0.07) <= 0) color = t.color;
          }
          r += color[0]; g += color[1]; b += color[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return encodePng(size, out);
}

const dir = path.join(__dirname, '../assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), render(256));
fs.writeFileSync(path.join(dir, 'tray.png'), render(32));
console.log('Иконки записаны в', dir);
