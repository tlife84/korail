/**
 * 트레이·실행파일 아이콘 PNG를 만든다. `npm run icons`로 다시 생성할 수 있다.
 *
 * 외부 이미지 파일을 저장소에 정체불명의 바이너리로 넣지 않으려고 코드로 그린다.
 * 모양: 코레일 파랑 둥근 사각형 + 흰 열차 앞창 + 전조등 두 개.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};

/** rgba: 픽셀당 4바이트 */
const encodePng = (size, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// ---------- 도형 (좌표는 0~1 비율) ----------
const roundedRect = (x0, y0, x1, y1, radius) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 + 1e-9
    || (x >= x0 + radius && x <= x1 - radius)
    || (y >= y0 + radius && y <= y1 - radius);
};

const circle = (cx, cy, radius) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;

const BLUE = [0x15, 0x54, 0xd1];
const WHITE = [0xff, 0xff, 0xff];

const SHAPES = [
  { hit: roundedRect(0.06, 0.06, 0.94, 0.94, 0.22), color: BLUE },
  { hit: roundedRect(0.28, 0.24, 0.72, 0.56, 0.13), color: WHITE }, // 앞창
  { hit: circle(0.38, 0.72, 0.085), color: WHITE },                  // 전조등
  { hit: circle(0.62, 0.72, 0.085), color: WHITE },
];

// 픽셀마다 4x4로 잘라 덮인 비율을 세는 방식으로 계단현상을 줄인다.
const SUB = 4;

const render = (size) => {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = (px + (sx + 0.5) / SUB) / size;
          const y = (py + (sy + 0.5) / SUB) / size;
          let color = null;
          for (const shape of SHAPES) if (shape.hit(x, y)) color = shape.color;
          if (!color) continue;
          red += color[0];
          green += color[1];
          blue += color[2];
          alpha += 255;
        }
      }
      const samples = SUB * SUB;
      const covered = alpha / 255;
      const offset = (py * size + px) * 4;
      if (covered) {
        rgba[offset] = Math.round(red / covered);
        rgba[offset + 1] = Math.round(green / covered);
        rgba[offset + 2] = Math.round(blue / covered);
      }
      rgba[offset + 3] = Math.round(alpha / samples);
    }
  }
  return encodePng(size, rgba);
};

const appDir = dirname(fileURLToPath(import.meta.url));
for (const [name, size] of [['tray-icon.png', 32], ['icon.png', 256]]) {
  const target = join(appDir, name);
  writeFileSync(target, render(size));
  console.log(`${name} (${size}x${size}) 생성`);
}
