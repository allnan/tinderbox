import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alphaOf,
  colorDisplayName,
  computeSpectrumRgba,
  contrastRatio,
  formatColor,
  hexToOklch,
  hexToRgb,
  maxChromaAt,
  normalizeHex,
  oklchToHex,
  rgbToHex,
  SPECTRUM_HEIGHT,
  SPECTRUM_WIDTH,
} from '../dist/core.mjs'

test('normalizeHex 兼容常见输入并输出大写', () => {
  assert.equal(normalizeHex('#0097bb'), '#0097BB')
  assert.equal(normalizeHex('#0097bb80'), '#0097BB80')
  assert.equal(normalizeHex('#abc'), '#AABBCC')
  assert.equal(normalizeHex('#abcd'), '#AABBCCDD')
  assert.equal(normalizeHex('rgb(0, 151, 187)'), '#0097BB')
  assert.equal(normalizeHex('not-a-color'), null)
})

test('透明度解析与 8 位输出', () => {
  assert.equal(alphaOf('#0097BB80'), 128 / 255)
  assert.equal(alphaOf('#0097BB'), 1)
  assert.equal(normalizeHex('#0097BB80'), '#0097BB80')
  assert.equal(normalizeHex('#0097BBFF'), '#0097BB')
})

test('HEX ↔ RGB 往返稳定', () => {
  for (const hex of ['#0097BB', '#FFFFFF', '#000000', '#4F7CFF', '#EC4899']) {
    assert.equal(rgbToHex(hexToRgb(hex)), hex)
  }
})

test('OKLCH 端点与色域映射', () => {
  const blue = hexToOklch('#0000FF')
  assert.ok(blue.l > 0.4 && blue.l < 0.5, `L=${blue.l}`)
  assert.ok(blue.h > 255 && blue.h < 275, `H=${blue.h}`)
  assert.ok(blue.c > 0.3, `C=${blue.c}`)
  assert.equal(oklchToHex({ l: 1, c: 0.4, h: 120 }), '#FFFFFF')
  assert.equal(oklchToHex({ l: 0, c: 0.4, h: 120 }), '#000000')
})

test('WCAG 对比度与中文色名', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21)
  assert.equal(colorDisplayName('#000000'), '黑色')
  assert.equal(colorDisplayName('#FFFFFF'), '白色')
  assert.equal(colorDisplayName('#808080'), '中灰')
  assert.equal(colorDisplayName('#0000FF'), '靛蓝')
  assert.equal(colorDisplayName('#FF0000'), '赤红')
})

test('最大色度：白色端点接近 0，纯蓝附近可达到高色度', () => {
  assert.ok(maxChromaAt(1, 0) < 0.001)
  assert.ok(maxChromaAt(0.5, 264) > 0.2, `${maxChromaAt(0.5, 264)}`)
})

test('全彩色域图：顶部纯白、底部纯黑、像素长度正确', () => {
  assert.equal(SPECTRUM_WIDTH, 720)
  assert.equal(SPECTRUM_HEIGHT, 360)
  const width = 16
  const height = 8
  const rgba = computeSpectrumRgba(width, height)
  assert.equal(rgba.length, width * height * 4)
  assert.deepEqual([...rgba.slice(0, 4)], [255, 255, 255, 255])
  assert.deepEqual([...rgba.slice(-4)], [0, 0, 0, 255])
  for (let i = 3; i < rgba.length; i += 4) assert.equal(rgba[i], 255)
})

test('formatColor 输出各格式', () => {
  assert.equal(formatColor('#0097BB', 'hex'), '#0097BB')
  assert.equal(formatColor('#0097BB', 'rgb'), 'rgb(0, 151, 187)')
  assert.equal(formatColor('#0097BB80', 'rgb'), 'rgba(0, 151, 187, 0.502)')
  assert.match(formatColor('#0097BB', 'oklch'), /^oklch\(/)
})
