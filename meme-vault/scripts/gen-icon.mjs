// 生成应用图标源图（1024×1024 PNG）：深色底上的黄色贴纸笑脸。
import fs from "node:fs";
import zlib from "node:zlib";

const SIZE = 1024;
const SS = 3;
const rgba = Buffer.alloc(SIZE * SIZE * 4);

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
function roundedRectSdf(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
}
function circleSdf(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

const body = { cx: 512, cy: 512, halfW: 408, halfH: 408, r: 190 };

function shade(x, y) {
  // 返回 [r,g,b,a] 0..1，透明背景
  let out = [0, 0, 0, 0];
  const dBody = roundedRectSdf(x, y, body.cx, body.cy, body.halfW, body.halfH, body.r);
  const bodyCov = 1 - smoothstep(-1.2, 1.2, dBody);
  if (bodyCov > 0.001) {
    const t = (y - 96) / 832;
    const top = [255, 209, 84];
    const bottom = [244, 154, 58];
    const base = top.map((c, i) => c + (bottom[i] - c) * t);
    // 柔和左上高光
    const glow = Math.max(0, 1 - Math.hypot(x - 330, y - 260) / 520) * 0.16;
    let color = base.map((c) => c + (255 - c) * glow);
    // 内描边
    const inner = Math.abs(roundedRectSdf(x, y, body.cx, body.cy, body.halfW - 26, body.halfH - 26, body.r - 26));
    const ring = 1 - smoothstep(3, 6, inner);
    color = color.map((c) => c * (1 - 0.1 * ring) + 255 * 0.1 * ring);
    out = [color[0] / 255, color[1] / 255, color[2] / 255, bodyCov];
  }
  const dark = [0.19, 0.13, 0.08];
  const alphaBlend = (cov, color) => {
    if (cov <= 0.001) return;
    const a = Math.min(1, out[3] + cov);
    const w = cov / (a || 1);
    out[0] = out[0] * (1 - w) + color[0] * w;
    out[1] = out[1] * (1 - w) + color[1] * w;
    out[2] = out[2] * (1 - w) + color[2] * w;
    out[3] = a;
  };
  const eyeL = 1 - smoothstep(-1.1, 1.1, circleSdf(x, y, 382, 402, 62));
  const eyeR = 1 - smoothstep(-1.1, 1.1, circleSdf(x, y, 642, 402, 62));
  alphaBlend(eyeL, dark);
  alphaBlend(eyeR, dark);
  // 腮红
  const blushL = 1 - smoothstep(-20, 30, circleSdf(x, y, 330, 566, 58));
  const blushR = 1 - smoothstep(-20, 30, circleSdf(x, y, 694, 566, 58));
  alphaBlend(blushL * 0.35, [0.95, 0.45, 0.36]);
  alphaBlend(blushR * 0.35, [0.95, 0.45, 0.36]);
  // 嘴：圆弧下半段
  const dMouth = Math.abs(Math.hypot(x - 512, y - 418) - 232) - 27;
  const mouthCov = (1 - smoothstep(-1.2, 1.2, dMouth)) * smoothstep(492, 512, y) * (1 - smoothstep(690, 706, y));
  alphaBlend(mouthCov, dark);
  // 高光点
  const spark = 1 - smoothstep(-1, 1, circleSdf(x, y, 700, 250, 16));
  alphaBlend(spark * 0.9, [1, 1, 1]);
  return out;
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const [cr, cg, cb, ca] = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += cr * ca;
        g += cg * ca;
        b += cb * ca;
        a += ca;
      }
    }
    const n = SS * SS;
    const alpha = a / n;
    const idx = (y * SIZE + x) * 4;
    if (alpha > 0.001) {
      rgba[idx] = Math.round((r / a) * 255);
      rgba[idx + 1] = Math.round((g / a) * 255);
      rgba[idx + 2] = Math.round((b / a) * 255);
    }
    rgba[idx + 3] = Math.round(alpha * 255);
  }
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const crcTable = (() => {
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
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync("app-icon.png", png);
console.log("wrote app-icon.png", png.length, "bytes");
