import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { computeSpectrumRgba, SPECTRUM_HEIGHT, SPECTRUM_WIDTH } from '../dist/core.mjs'

/**
 * 用取色器真正的算法生成全彩色域图 PNG（720×360），作为设计存档资产。
 * 不依赖任何图形库：手写最小 PNG 编码（RGBA + 无滤波 + zlib）。
 *
 * 用法：node scripts/make-spectrum-png.mjs [输出路径]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'docs', 'assets', 'oklch-spectrum.png')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const offset = y * (stride + 1)
    raw[offset] = 0 // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, offset + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const started = Date.now()
const rgba = computeSpectrumRgba(SPECTRUM_WIDTH, SPECTRUM_HEIGHT)
const png = encodePng(SPECTRUM_WIDTH, SPECTRUM_HEIGHT, rgba)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, png)
console.log(`[spectrum] ${SPECTRUM_WIDTH}×${SPECTRUM_HEIGHT} → ${outPath}（${(png.length / 1024).toFixed(1)} KB，用时 ${Date.now() - started} ms）`)
