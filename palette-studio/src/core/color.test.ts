/**
 * color.ts 色彩基础函数的测试：解析/格式化、HSL / HSV / OKLab / OKLCH、对比度与混合调整。
 * 这些函数是 palette.ts 的地基，因此边界值（纯黑、纯白、灰阶、非法输入）都要覆盖。
 */
import { describe, expect, test } from './_testkit'
import {
  adjustSaturation,
  alphaOf,
  bestTextOn,
  blendOver,
  clamp,
  contrastRatio,
  darken,
  formatColor,
  getContrastResult,
  hexToHsl,
  hexToOklch,
  hexToRgb,
  hslToHex,
  hslToRgb,
  hsvToRgb,
  hueDistance,
  isDark,
  isValidColor,
  lighten,
  linearToRgb,
  mix,
  nearestStep,
  normalizeColor,
  normalizeHex,
  oklabToLinear,
  oklchToHex,
  oklchToRgb,
  parseColor,
  perceptualLightness,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  rgbToLinear,
  rgbToOklab,
  rgbToOklch,
  rotateHue,
  setAlphaHex,
  withAlpha,
  withLightness,
} from './color'

const HEX_PATTERN = /^#[0-9A-F]{6}$/

/** 两个 HEX 在 RGB 通道上的最大差异，用于容忍取整误差 */
function maxChannelDiff(a: string, b: string): number {
  const left = hexToRgb(a)
  const right = hexToRgb(b)
  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b),
  )
}

// ---------------------------------------------------------------------------
// 解析与格式化
// ---------------------------------------------------------------------------

describe('颜色解析与规范化', () => {
  test('clamp 限制数值范围', () => {
    expect(clamp(3, 0, 5)).toBe(3)
    expect(clamp(-1, 0, 5)).toBe(0)
    expect(clamp(9, 0, 5)).toBe(5)
  })

  test('normalizeHex 兼容多种输入', () => {
    expect(normalizeHex('#4f7cff')).toBe('#4F7CFF')
    expect(normalizeHex('#f00')).toBe('#FF0000')
    expect(normalizeHex('rgb(255, 0, 0)')).toBe('#FF0000')
    expect(normalizeHex('hsl(0, 100%, 50%)')).toBe('#FF0000')
    expect(normalizeHex('hsl(120deg, 100%, 50%)')).toBe('#00FF00')
    expect(normalizeHex('not-a-color')).toBeNull()
  })

  test('parseColor 解析 RGBA / 8 位 HEX 时忽略透明度', () => {
    expect(parseColor('#ABCDEF')).toEqual({ r: 171, g: 205, b: 239 })
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(parseColor('#FF000080')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseColor('')).toBeNull()
  })

  test('isValidColor 判断合法性', () => {
    expect(isValidColor('#4F7CFF')).toBeTruthy()
    expect(isValidColor('#abc')).toBeTruthy()
    expect(isValidColor('rgb(0, 0, 0)')).toBeTruthy()
    expect(isValidColor('not-a-color')).toBeFalsy()
  })

  test('rgbToHex / hexToRgb 双向转换', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe('#FF0000')
    expect(rgbToHex({ r: 300, g: -5, b: 128.2 })).toBe('#FF0080')
    expect(hexToRgb('#4F7CFF')).toEqual({ r: 79, g: 124, b: 255 })
    expect(() => hexToRgb('xyz')).toThrow('非法颜色值')
  })

  test('formatColor 输出各种格式', () => {
    expect(formatColor('#4f7cff', 'hex')).toBe('#4F7CFF')
    expect(formatColor('#FF0000', 'rgb')).toBe('rgb(255, 0, 0)')
    expect(formatColor('#FF0000', 'hsl')).toBe('hsl(0, 100%, 50%)')
    expect(/^oklch\(0\.\d{3} 0\.\d{3} \d+\.\d\)$/.test(formatColor('#4F7CFF', 'oklch'))).toBeTruthy()
    expect(formatColor('not-a-color', 'hex')).toBe('not-a-color')
  })
})

// ---------------------------------------------------------------------------
// HSL / HSV
// ---------------------------------------------------------------------------

describe('HSL / HSV 转换', () => {
  test('HEX → HSL 的典型值', () => {
    expect(hexToHsl('#FF0000')).toEqual({ h: 0, s: 100, l: 50 })
    const gray = hexToHsl('#808080')
    expect(gray.h).toBe(0)
    expect(gray.s).toBe(0)
    expect(gray.l).toBeCloseTo(50.2, 1)
  })

  test('HSL → HEX 往返误差不超过 1 个色阶', () => {
    for (const hex of ['#4F7CFF', '#22C55E', '#FF7A00', '#808080']) {
      expect(maxChannelDiff(hslToHex(hexToHsl(hex)), hex) <= 1).toBeTruthy()
    }
    expect(hslToHex({ h: 0, s: 100, l: 50 })).toBe('#FF0000')
  })

  test('RGB → HSV 与 HSV → RGB 互逆', () => {
    const white = rgbToHsv(hexToRgb('#FFFFFF'))
    expect(white.s).toBe(0)
    expect(white.v).toBe(100)
    for (const hex of ['#4F7CFF', '#22C55E', '#FF7A00']) {
      expect(maxChannelDiff(rgbToHex(hsvToRgb(rgbToHsv(hexToRgb(hex)))), hex) <= 1).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// OKLab / OKLCH
// ---------------------------------------------------------------------------

describe('OKLab / OKLCH', () => {
  test('纯黑 / 纯白 / 灰阶的感知明度', () => {
    const white = hexToOklch('#FFFFFF')
    expect(white.l).toBeCloseTo(1, 3)
    expect(white.c < 0.001).toBeTruthy()

    const black = hexToOklch('#000000')
    expect(black.l).toBeCloseTo(0, 3)
    expect(black.c < 0.001).toBeTruthy()

    const gray = hexToOklch('#808080')
    expect(gray.l).toBeCloseTo(0.6, 2)
    expect(gray.c < 0.001).toBeTruthy()
  })

  test('OKLCH → HEX 往返保持在 1 个色阶内', () => {
    for (const hex of ['#4F7CFF', '#22C55E', '#FF7A00', '#808080', '#000000', '#FFFFFF']) {
      expect(maxChannelDiff(oklchToHex(hexToOklch(hex)), hex) <= 1).toBeTruthy()
    }
  })

  test('rgbToOklch 与 hexToOklch 结果一致', () => {
    expect(rgbToOklch(hexToRgb('#4F7CFF'))).toEqual(hexToOklch('#4F7CFF'))
  })

  test('中性灰在 OKLab 中 a / b 接近 0', () => {
    const lab = rgbToOklab(hexToRgb('#808080'))
    expect(Math.abs(lab.a) < 0.002).toBeTruthy()
    expect(Math.abs(lab.b) < 0.002).toBeTruthy()
    expect(lab.L).toBeCloseTo(0.6, 2)
  })

  test('oklchToRgb 会把超色域颜色映射回 sRGB', () => {
    const mapped = oklchToHex({ l: 0.7, c: 0.4, h: 30 })
    expect(HEX_PATTERN.test(mapped)).toBeTruthy()
    expect(hexToOklch(mapped).c < 0.4).toBeTruthy()
    expect(oklchToHex({ l: 0.7, c: 0.4, h: 30 })).toBe(rgbToHex(oklchToRgb({ l: 0.7, c: 0.4, h: 30 })))
  })

  test('rgbToLinear / linearToRgb 互逆', () => {
    const white = rgbToLinear({ r: 255, g: 255, b: 255 })
    for (const channel of white) expect(channel).toBeCloseTo(1, 5)
    expect(linearToRgb([0, 0, 0])).toEqual({ r: 0, g: 0, b: 0 })
    expect(linearToRgb(oklabToLinear(0.5, 0, 0))).toEqual({ r: 99, g: 99, b: 99 })
    for (const hex of ['#4F7CFF', '#22C55E', '#FF7A00']) {
      const rgb = hexToRgb(hex)
      expect(maxChannelDiff(rgbToHex(linearToRgb(rgbToLinear(rgb))), hex) <= 1).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// 亮度与对比度
// ---------------------------------------------------------------------------

describe('亮度与对比度', () => {
  test('relativeLuminance 的边界值', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3)
  })

  test('contrastRatio 的边界与对称性', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 3)
    expect(contrastRatio('#4F7CFF', '#4F7CFF')).toBeCloseTo(1, 3)
    expect(contrastRatio('#4F7CFF', '#FFFFFF')).toBe(contrastRatio('#FFFFFF', '#4F7CFF'))
  })

  test('getContrastResult 返回 WCAG 等级与建议文字色', () => {
    const aaa = getContrastResult('#000000', '#FFFFFF')
    expect(aaa.ratio).toBeCloseTo(21, 2)
    expect(aaa.level).toBe('AAA')
    expect(aaa.aa).toBeTruthy()
    expect(aaa.aaa).toBeTruthy()
    expect(aaa.suggestedText).toBe('#000000')

    const aa = getContrastResult('#767676', '#FFFFFF')
    expect(aa.level).toBe('AA')
    expect(aa.aa).toBeTruthy()
    expect(aa.aaa).toBeFalsy()

    const fail = getContrastResult('#AAAAAA', '#FFFFFF')
    expect(fail.level).toBe('fail')
    expect(fail.aa).toBeFalsy()
  })

  test('bestTextOn / isDark', () => {
    expect(bestTextOn('#000000')).toBe('#FFFFFF')
    expect(bestTextOn('#FFFFFF')).toBe('#111827')
    expect(isDark('#000000')).toBeTruthy()
    expect(isDark('#FFFFFF')).toBeFalsy()
    expect(isDark('#4F7CFF')).toBeTruthy()
  })

  test('perceptualLightness 顺序正确', () => {
    expect(perceptualLightness('#FFFFFF')).toBeCloseTo(1, 3)
    expect(perceptualLightness('#000000')).toBeCloseTo(0, 3)
    expect(perceptualLightness('#333333') < perceptualLightness('#777777')).toBeTruthy()
    expect(perceptualLightness('#777777') < perceptualLightness('#DDDDDD')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 调整与混合
// ---------------------------------------------------------------------------

describe('调整与混合', () => {
  test('mix 端点与中点', () => {
    expect(mix('#000000', '#FFFFFF', 0)).toBe('#000000')
    expect(mix('#000000', '#FFFFFF', 1)).toBe('#FFFFFF')
    const middle = mix('#000000', '#FFFFFF', 0.5)
    expect(HEX_PATTERN.test(middle)).toBeTruthy()
    const rgb = hexToRgb(middle)
    expect(rgb.r === rgb.g && rgb.g === rgb.b).toBeTruthy()
    expect(perceptualLightness(middle)).toBeCloseTo(0.5, 1)
  })

  test('lighten / darken 调整感知明度并钳制端点', () => {
    const seed = 0.6
    expect(perceptualLightness(lighten('#808080', 0.1))).toBeCloseTo(seed + 0.1, 2)
    expect(perceptualLightness(darken('#808080', 0.1))).toBeCloseTo(seed - 0.1, 2)
    expect(lighten('#FFFFFF', 0.5)).toBe('#FFFFFF')
    expect(darken('#000000', 0.5)).toBe('#000000')
  })

  test('withLightness 设置绝对明度', () => {
    expect(perceptualLightness(withLightness('#4F7CFF', 0.8))).toBeCloseTo(0.8, 2)
    expect(withLightness('#4F7CFF', 2)).toBe(withLightness('#4F7CFF', 1))
  })

  test('rotateHue 旋转色相', () => {
    const rotated = rotateHue('#4F7CFF', 120)
    expect(Math.abs(hueDistance('#4F7CFF', rotated) - 120) < 1).toBeTruthy()
    expect(hueDistance('#4F7CFF', rotateHue('#4F7CFF', 360)) < 1).toBeTruthy()
  })

  test('adjustSaturation 调整色度', () => {
    const source = hexToOklch('#4F7CFF').c
    expect(hexToOklch(adjustSaturation('#4F7CFF', -1)).c < 0.002).toBeTruthy()
    const lowChroma = hexToOklch('#6B7280').c
    expect(hexToOklch(adjustSaturation('#6B7280', 1)).c > lowChroma).toBeTruthy()
    expect(hexToOklch(adjustSaturation('#4F7CFF', 1)).c >= source).toBeTruthy()
  })

  test('withAlpha / blendOver', () => {
    expect(withAlpha('#FF0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
    expect(withAlpha('#FF0000', 2)).toBe('rgba(255, 0, 0, 1)')
    expect(withAlpha('#FF0000', -1)).toBe('rgba(255, 0, 0, 0)')
    expect(blendOver('#000000', '#FFFFFF', 0)).toBe('#FFFFFF')
    expect(blendOver('#000000', '#FFFFFF', 1)).toBe('#000000')
    expect(blendOver('#000000', '#FFFFFF', 0.5)).toBe('#808080')
  })

  test('hueDistance 对称且不超过 180', () => {
    expect(hueDistance('#4F7CFF', '#4F7CFF')).toBeCloseTo(0, 3)
    expect(hueDistance('#FF0000', '#00FF00')).toBe(hueDistance('#00FF00', '#FF0000'))
    const distance = hueDistance('#FF0000', '#00FF00')
    expect(distance > 110 && distance < 117).toBeTruthy()
    expect(hueDistance('#FF0000', '#00FFFF') <= 180).toBeTruthy()
  })

  test('nearestStep 找到最接近的色阶档位', () => {
    const scale = { '50': '#F9FAFB', '500': '#6B7280', '900': '#111827' }
    expect(nearestStep('#FFFFFF', scale)).toBe('50')
    expect(nearestStep('#000000', scale)).toBe('900')
    expect(nearestStep('#6B7280', scale)).toBe('500')
    expect(nearestStep('#111827', scale)).toBe('900')
  })

  test('透明度解析 / 归一化 / 格式化', () => {
    expect(normalizeColor('#FF000080')).toBe('#FF000080')
    expect(normalizeColor('rgba(255, 0, 0, 0.5)')).toBe('#FF000080')
    expect(normalizeColor('#f008')).toBe('#FF000088')
    expect(normalizeHex('#FF0000FF')).toBe('#FF0000')
    expect(alphaOf('#FF000080')).toBeCloseTo(0.502, 3)
    expect(alphaOf('#FF0000')).toBe(1)
    expect(alphaOf('rgba(0, 0, 0, 0.25)')).toBeCloseTo(0.25, 3)
    expect(setAlphaHex('#FF0000', 0.5)).toBe('#FF000080')
    expect(setAlphaHex('#FF000080', 1)).toBe('#FF0000')
    expect(formatColor('#FF000080', 'hex')).toBe('#FF000080')
    expect(formatColor('#FF000080', 'rgb')).toBe('rgba(255, 0, 0, 0.502)')
  })

  test('半透明前景的对比度先叠加到背景再计算', () => {
    const transparentBlack = contrastRatio('#00000080', '#FFFFFF')
    expect(transparentBlack > 3 && transparentBlack < 4.5).toBeTruthy()
    expect(contrastRatio('rgba(0, 0, 0, 0)', '#FFFFFF')).toBeCloseTo(1, 3)
  })
})
