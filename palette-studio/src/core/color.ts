/**
 * 色彩引擎基础：解析、格式转换、OKLab/OKLCH、对比度、混合与明暗调整。
 *
 * 约定：
 * - 对外颜色使用大写 HEX：不透明为 `#RRGGBB`，带透明度为 `#RRGGBBAA`；
 *   输入兼容 #RGB / #RGBA / #RRGGBB / #RRGGBBAA / rgb() / rgba() / hsl() / hsla()。
 * - 所有函数都是纯函数，不抛异常（解析失败返回 null / 回退色）。
 * - OKLab / OKLCH 使用 Björn Ottosson 的标准矩阵，色域外颜色会自动降饱和映射回 sRGB。
 */
import type { ColorFormat } from '../shared/types'

export interface RGB {
  r: number
  g: number
  b: number
}

export interface RGBA extends RGB {
  /** 透明度 0-1 */
  a: number
}

export interface HSL {
  h: number
  s: number
  l: number
}

export interface HSV {
  h: number
  s: number
  v: number
}

export interface OKLCH {
  /** 明度 0-1 */
  l: number
  /** 色度 0-0.4 左右 */
  c: number
  /** 色相角 0-360 */
  h: number
}

export interface ContrastResult {
  /** 对比度 1-21 */
  ratio: number
  /** 正文 WCAG 等级 */
  level: 'AAA' | 'AA' | 'AA-large' | 'fail'
  /** 正文是否达到 AA（≥4.5） */
  aa: boolean
  /** 正文是否达到 AAA（≥7） */
  aaa: boolean
  /** 大字是否达到 AA（≥3） */
  aaLarge: boolean
  /** 大字是否达到 AAA（≥4.5） */
  aaaLarge: boolean
  /** 在该背景上推荐的正文颜色 */
  suggestedText: string
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value)
}

function normalizeHue(hue: number): number {
  const value = hue % 360
  return value < 0 ? value + 360 : value
}

// ---------------------------------------------------------------------------
// 解析与规范化
// ---------------------------------------------------------------------------

/** 解析任意支持的字符串为 RGB；失败返回 null */
export function parseColor(input: string): RGB | null {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase()
  if (!text) return null

  // #RGB / #RGBA
  let match = /^#?([0-9a-f]{3,4})$/.exec(text)
  if (match) {
    const value = match[1]
    return {
      r: parseInt(value[0] + value[0], 16),
      g: parseInt(value[1] + value[1], 16),
      b: parseInt(value[2] + value[2], 16),
    }
  }

  // #RRGGBB / #RRGGBBAA
  match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text)
  if (match) {
    const value = match[1]
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    }
  }

  // rgb(r, g, b) / rgba(r, g, b, a)
  match = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)/.exec(text)
  if (match) {
    const r = Number(match[1])
    const g = Number(match[2])
    const b = Number(match[3])
    if ([r, g, b].some((item) => Number.isNaN(item))) return null
    return { r: clamp(round(r), 0, 255), g: clamp(round(g), 0, 255), b: clamp(round(b), 0, 255) }
  }

  // hsl(h, s%, l%) / hsla(h, s%, l%, a)
  match = /^hsla?\(\s*([0-9.]+)(?:deg)?\s*[, ]\s*([0-9.]+)%\s*[, ]\s*([0-9.]+)%/.exec(text)
  if (match) {
    const h = Number(match[1])
    const s = Number(match[2])
    const l = Number(match[3])
    if ([h, s, l].some((item) => Number.isNaN(item))) return null
    return hslToRgb({ h: normalizeHue(h), s: clamp(s, 0, 100), l: clamp(l, 0, 100) })
  }

  return null
}

/** 是否为合法颜色字符串 */
export function isValidColor(input: string): boolean {
  return parseColor(input) !== null
}

/** 解析任意支持的字符串为 RGBA（alpha 0-1）；失败返回 null */
export function parseColorAlpha(input: string): RGBA | null {
  const rgb = parseColor(input)
  if (!rgb) return null
  const text = input.trim().toLowerCase()
  let alpha = 1

  // #RGBA：最后一位是透明度
  const short = /^#?([0-9a-f]{4})$/.exec(text)
  const long = /^#?([0-9a-f]{6})([0-9a-f]{2})$/.exec(text)
  const fn = /^(?:rgba?|hsla?)\(([^)]*)\)$/.exec(text)
  if (short) {
    const digit = short[1].slice(3)
    alpha = parseInt(digit + digit, 16) / 255
  } else if (long) {
    alpha = parseInt(long[2], 16) / 255
  } else if (fn) {
    const parts = fn[1]
      .split(/[,/]/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length >= 4) {
      const raw = parts[3]
      const parsed = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw)
      if (!Number.isNaN(parsed)) alpha = parsed
    }
  }
  return { ...rgb, a: clamp(alpha, 0, 1) }
}

/** 取颜色的透明度（0-1，不透明为 1） */
export function alphaOf(input: string): number {
  return parseColorAlpha(input)?.a ?? 1
}

/** RGBA → 大写 HEX：不透明返回 #RRGGBB，半透明返回 #RRGGBBAA */
export function rgbaToHex(rgba: RGBA): string {
  const base = rgbToHex(rgba)
  const alphaByte = clamp(Math.round(clamp(rgba.a, 0, 1) * 255), 0, 255)
  if (alphaByte >= 255) return base
  return `${base}${alphaByte.toString(16).padStart(2, '0').toUpperCase()}`
}

/** 规范化为大写 HEX（不透明 #RRGGBB / 半透明 #RRGGBBAA）；失败返回 null */
export function normalizeColor(input: string): string | null {
  const rgba = parseColorAlpha(input)
  return rgba ? rgbaToHex(rgba) : null
}

/** 设置颜色的透明度，返回规范化 HEX（alpha=1 时返回 6 位） */
export function setAlphaHex(input: string, alpha: number): string {
  const rgba = parseColorAlpha(input) ?? { r: 0, g: 0, b: 0, a: 1 }
  return rgbaToHex({ ...rgba, a: clamp(alpha, 0, 1) })
}

/** 规范化为大写 HEX；失败返回 null。与 normalizeColor 等价（保留透明度）。 */
export function normalizeHex(input: string): string | null {
  return normalizeColor(input)
}

// ---------------------------------------------------------------------------
// HEX / RGB
// ---------------------------------------------------------------------------

export function rgbToHex(rgb: RGB): string {
  const toHex = (value: number) => clamp(round(value), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase()
}

/** 输入非法时抛出错误，调用方应先用 normalizeHex 校验 */
export function hexToRgb(hex: string): RGB {
  const rgb = parseColor(hex)
  if (!rgb) throw new Error(`非法颜色值：${hex}`)
  return rgb
}

// ---------------------------------------------------------------------------
// HSL
// ---------------------------------------------------------------------------

export function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  const l = (max + min) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))

  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
  }
  return { h: normalizeHue(h), s: clamp(s * 100, 0, 100), l: clamp(l * 100, 0, 100) }
}

export function hslToRgb(hsl: HSL): RGB {
  const h = normalizeHue(hsl.h)
  const s = clamp(hsl.s, 0, 100) / 100
  const l = clamp(hsl.l, 0, 100) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: round((r + m) * 255), g: round((g + m) * 255), b: round((b + m) * 255) }
}

export function hexToHsl(hex: string): HSL {
  return rgbToHsl(hexToRgb(hex))
}

export function hslToHex(hsl: HSL): string {
  return rgbToHex(hslToRgb(hsl))
}

// ---------------------------------------------------------------------------
// HSL / HSV 辅助
// ---------------------------------------------------------------------------

export function rgbToHsv(rgb: RGB): HSV {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
  }
  return {
    h: normalizeHue(h),
    s: max === 0 ? 0 : clamp((delta / max) * 100, 0, 100),
    v: clamp(max * 100, 0, 100),
  }
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = normalizeHue(hsv.h)
  const s = clamp(hsv.s, 0, 100) / 100
  const v = clamp(hsv.v, 0, 100) / 100
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: round((r + m) * 255), g: round((g + m) * 255), b: round((b + m) * 255) }
}

// ---------------------------------------------------------------------------
// OKLab / OKLCH（感知均匀色彩空间）
// ---------------------------------------------------------------------------

function srgbChannelToLinear(channel: number): number {
  const value = clamp(channel, 0, 255) / 255
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
}

function linearToSrgbChannel(channel: number): number {
  const value = channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055
  return clamp(value, 0, 1) * 255
}

/** RGB → 线性 sRGB */
export function rgbToLinear(rgb: RGB): [number, number, number] {
  return [srgbChannelToLinear(rgb.r), srgbChannelToLinear(rgb.g), srgbChannelToLinear(rgb.b)]
}

/** 线性 sRGB → RGB（自动钳制到 0-255） */
export function linearToRgb(linear: [number, number, number]): RGB {
  return {
    r: clamp(round(linearToSrgbChannel(linear[0])), 0, 255),
    g: clamp(round(linearToSrgbChannel(linear[1])), 0, 255),
    b: clamp(round(linearToSrgbChannel(linear[2])), 0, 255),
  }
}

export function rgbToOklab(rgb: RGB): { L: number; a: number; b: number } {
  const [r, g, b] = rgbToLinear(rgb)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function rgbToOklch(rgb: RGB): OKLCH {
  const { L, a, b } = rgbToOklab(rgb)
  const c = Math.sqrt(a * a + b * b)
  const h = c < 1e-6 ? 0 : normalizeHue((Math.atan2(b, a) * 180) / Math.PI)
  return { l: clamp(L, 0, 1), c, h }
}

export function hexToOklch(hex: string): OKLCH {
  return rgbToOklch(hexToRgb(hex))
}

function linearInGamut(linear: [number, number, number]): boolean {
  return linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4)
}

/** OKLCH → RGB，自动做色域映射（降低色度直到进入 sRGB） */
export function oklchToRgb(oklch: OKLCH): RGB {
  const l = clamp(oklch.l, 0, 1)
  let c = Math.max(0, oklch.c)
  const h = normalizeHue(oklch.h)
  const rad = (h * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  let linear = oklabToLinear(l, c * cos, c * sin)
  if (!linearInGamut(linear)) {
    let low = 0
    let high = c
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2
      const test = oklabToLinear(l, mid * cos, mid * sin)
      if (linearInGamut(test)) {
        low = mid
        linear = test
      } else {
        high = mid
      }
    }
  }
  return linearToRgb(linear)
}

export function oklchToHex(oklch: OKLCH): string {
  return rgbToHex(oklchToRgb(oklch))
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 按指定格式输出颜色字符串（带透明度时输出 rgba / hsla / oklch(... / A)） */
export function formatColor(input: string, format: ColorFormat): string {
  const rgba = parseColorAlpha(input)
  if (!rgba) return input
  const normalized = rgbaToHex(rgba)
  const translucent = rgba.a < 1
  const alpha = Number(rgba.a.toFixed(3))
  if (format === 'hex') return normalized
  if (format === 'rgb') {
    const { r, g, b } = rgba
    return translucent ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`
  }
  if (format === 'hsl') {
    const { h, s, l } = hexToHsl(normalized)
    return translucent
      ? `hsla(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%, ${alpha})`
      : `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`
  }
  const oklch = hexToOklch(normalized)
  const base = `oklch(${oklch.l.toFixed(3)} ${oklch.c.toFixed(3)} ${oklch.h.toFixed(1)}`
  return translucent ? `${base} / ${alpha})` : `${base})`
}

// ---------------------------------------------------------------------------
// 亮度与对比度
// ---------------------------------------------------------------------------

/** WCAG 相对亮度 0-1 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbToLinear(hexToRgb(hex))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 把半透明颜色按 alpha 叠加到不透明背景上 */
function flattenColor(color: RGBA, backdrop: RGBA): RGBA {
  const alpha = clamp(color.a, 0, 1)
  return {
    r: color.r * alpha + backdrop.r * (1 - alpha),
    g: color.g * alpha + backdrop.g * (1 - alpha),
    b: color.b * alpha + backdrop.b * (1 - alpha),
    a: 1,
  }
}

/**
 * WCAG 对比度 1-21。
 * 半透明前景会先叠加到背景上再计算；半透明背景按白色页面叠加（与浏览器默认一致）。
 */
export function contrastRatio(a: string, b: string): number {
  const fg = parseColorAlpha(a) ?? { r: 0, g: 0, b: 0, a: 1 }
  const bg = parseColorAlpha(b) ?? { r: 255, g: 255, b: 255, a: 1 }
  const white: RGBA = { r: 255, g: 255, b: 255, a: 1 }
  const solidBg = flattenColor(bg, white)
  const solidFg = flattenColor(fg, solidBg)
  const luminanceA = relativeLuminance(rgbToHex(solidFg))
  const luminanceB = relativeLuminance(rgbToHex(solidBg))
  const lighter = Math.max(luminanceA, luminanceB)
  const darker = Math.min(luminanceA, luminanceB)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 判断颜色是否偏暗（相对亮度 < 0.4） */
export function isDark(hex: string): boolean {
  return relativeLuminance(hex) < 0.4
}

/** 在给定背景上推荐可读的正文颜色 */
export function bestTextOn(background: string): string {
  const white = contrastRatio(background, '#FFFFFF')
  const black = contrastRatio(background, '#111827')
  return white >= black ? '#FFFFFF' : '#111827'
}

/** 完整的 WCAG 对比度结果 */
export function getContrastResult(foreground: string, background: string): ContrastResult {
  const ratio = contrastRatio(foreground, background)
  const aa = ratio >= 4.5
  const aaa = ratio >= 7
  const aaLarge = ratio >= 3
  const aaaLarge = ratio >= 4.5
  let level: ContrastResult['level'] = 'fail'
  if (aaa) level = 'AAA'
  else if (aa) level = 'AA'
  else if (aaLarge) level = 'AA-large'
  const fg = parseColorAlpha(foreground)
  return {
    ratio,
    level,
    aa,
    aaa,
    aaLarge,
    aaaLarge,
    // 建议的正文色应不透明，避免半透明文字再次影响可读性
    suggestedText: aa && fg ? rgbaToHex({ ...fg, a: 1 }) : bestTextOn(background),
  }
}

// ---------------------------------------------------------------------------
// 调整与混合
// ---------------------------------------------------------------------------

/** 在 OKLab 空间混合两个颜色，weight=0 取 a，weight=1 取 b */
export function mix(a: string, b: string, weight = 0.5): string {
  const t = clamp(weight, 0, 1)
  const labA = rgbToOklab(hexToRgb(normalizeHex(a) ?? '#000000'))
  const labB = rgbToOklab(hexToRgb(normalizeHex(b) ?? '#000000'))
  const L = labA.L + (labB.L - labA.L) * t
  const aChannel = labA.a + (labB.a - labA.a) * t
  const bChannel = labA.b + (labB.b - labA.b) * t
  return rgbToHex(linearToRgb(oklabToLinear(L, aChannel, bChannel)))
}

/** 提亮（OKLCH 明度 +amount，amount 0-1） */
export function lighten(hex: string, amount: number): string {
  const oklch = hexToOklch(hex)
  return oklchToHex({ ...oklch, l: clamp(oklch.l + amount, 0, 1) })
}

/** 变暗（OKLCH 明度 -amount，amount 0-1） */
export function darken(hex: string, amount: number): string {
  const oklch = hexToOklch(hex)
  return oklchToHex({ ...oklch, l: clamp(oklch.l - amount, 0, 1) })
}

/** 设置绝对明度（OKLCH L 0-1） */
export function withLightness(hex: string, lightness: number): string {
  const oklch = hexToOklch(hex)
  return oklchToHex({ ...oklch, l: clamp(lightness, 0, 1) })
}

/** 旋转色相 */
export function rotateHue(hex: string, degrees: number): string {
  const oklch = hexToOklch(hex)
  return oklchToHex({ ...oklch, h: normalizeHue(oklch.h + degrees) })
}

/** 调整饱和度（delta 为相对倍率，例如 0.2 表示提高 20%，-1 表示降到 0） */
export function adjustSaturation(hex: string, delta: number): string {
  const oklch = hexToOklch(hex)
  const factor = 1 + delta
  return oklchToHex({ ...oklch, c: clamp(oklch.c * factor, 0, 0.4) })
}

/** 转为 rgba() 字符串 */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(normalizeHex(hex) ?? '#000000')
  return `rgba(${r}, ${g}, ${b}, ${Number(clamp(alpha, 0, 1).toFixed(3))})`
}

/** 把带透明度的前景叠加到背景上，返回等效纯色 */
export function blendOver(foreground: string, background: string, alpha: number): string {
  const fg = hexToRgb(normalizeHex(foreground) ?? '#000000')
  const bg = hexToRgb(normalizeHex(background) ?? '#FFFFFF')
  const t = clamp(alpha, 0, 1)
  return rgbToHex({
    r: fg.r * t + bg.r * (1 - t),
    g: fg.g * t + bg.g * (1 - t),
    b: fg.b * t + bg.b * (1 - t),
  })
}

/** 两个颜色的 OKLCH 色相距离（0-180） */
export function hueDistance(a: string, b: string): number {
  const hueA = hexToOklch(a).h
  const hueB = hexToOklch(b).h
  const diff = Math.abs(hueA - hueB) % 360
  return diff > 180 ? 360 - diff : diff
}

/** 感知亮度（OKLab L，0-1） */
export function perceptualLightness(hex: string): number {
  return hexToOklch(hex).l
}

/** 在色阶（如 50-950）中找到最接近的档位键 */
export function nearestStep(hex: string, scale: Record<string, string>): string {
  const target = perceptualLightness(hex)
  let bestKey = Object.keys(scale)[0] ?? ''
  let bestDiff = Number.POSITIVE_INFINITY
  for (const [key, value] of Object.entries(scale)) {
    const diff = Math.abs(perceptualLightness(value) - target)
    if (diff < bestDiff) {
      bestDiff = diff
      bestKey = key
    }
  }
  return bestKey
}
