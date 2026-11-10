/**
 * palette.ts 的测试：和谐配色、明度色阶、语义主题、中文色名与色板合并。
 * 重点验证契约要求的数量/顺序/对比度，以及灰阶、纯黑、纯白等边界输入。
 */
import { describe, expect, test } from './_testkit'
import type { GeneratedTheme, PaletteColor } from '../shared/types'
import { THEME_TOKEN_KEYS } from '../shared/types'
import {
  HARMONIES,
  THEME_METHODS,
  TONAL_STEPS,
  colorDisplayName,
  createPaletteColor,
  generateHarmony,
  generateScales,
  generateSemanticTheme,
  generateTonalScale,
  mergeGeneratedPalette,
  nameWithLevel,
  nextColorId,
  suggestPalette,
} from './palette'
import type { HarmonyType } from './palette'
import { contrastRatio, hexToOklch, hueDistance, perceptualLightness, relativeLuminance } from './color'

const HEX_PATTERN = /^#[0-9A-F]{6}$/
const CJK_PATTERN = /[\u4e00-\u9fa5]/
const HARMONY_TYPES: HarmonyType[] = [
  'complementary',
  'analogous',
  'triadic',
  'split-complementary',
  'tetradic',
  'monochromatic',
  'shades',
  'tints',
]
const HARMONY_COUNTS: Record<HarmonyType, number> = {
  complementary: 2,
  analogous: 5,
  triadic: 3,
  'split-complementary': 3,
  tetradic: 4,
  monochromatic: 5,
  shades: 5,
  tints: 5,
}
const METHOD_IDS = ['balanced', 'vivid', 'muted', 'neutral', 'high-contrast'] as const
const TYPICAL_BASES = ['#4F7CFF', '#22C55E', '#FF7A00', '#EC4899', '#8B5CF6', '#0EA5E9']
const EDGE_BASES = ['#000000', '#FFFFFF', '#808080', '#050510', '#FDFDFF', '#FFFF00', '#000080']

function expectPaletteColor(color: PaletteColor): void {
  expect(HEX_PATTERN.test(color.hex)).toBeTruthy()
  expect(typeof color.id === 'string' && color.id.length > 0).toBeTruthy()
  expect(typeof color.name === 'string' && color.name.length > 0).toBeTruthy()
}

function tokenValue(theme: GeneratedTheme, key: string): { light: string; dark: string } {
  const token = theme.tokens.find((item) => item.key === key)
  if (!token) throw new Error(`缺少 token：${key}`)
  return { light: token.light, dark: token.dark }
}

function angularDistance(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 360) % 360)
  return diff > 180 ? 360 - diff : diff
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe('常量', () => {
  test('HARMONIES 恰好 8 种且顺序固定', () => {
    expect(HARMONIES.length).toBe(8)
    expect(HARMONIES.map((item) => item.type)).toEqual(HARMONY_TYPES)
  })

  test('HARMONIES 都有中文名称与说明', () => {
    for (const item of HARMONIES) {
      expect(CJK_PATTERN.test(item.label)).toBeTruthy()
      expect(item.description.length).toBeGreaterThan(4)
    }
  })

  test('TONAL_STEPS 为 50 ~ 950 的 11 档', () => {
    expect(TONAL_STEPS).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950])
  })

  test('THEME_METHODS 为 5 种且 id / label 正确', () => {
    expect(THEME_METHODS.length).toBe(5)
    expect(THEME_METHODS.map((item) => item.id)).toEqual([...METHOD_IDS])
    for (const item of THEME_METHODS) {
      expect(CJK_PATTERN.test(item.label)).toBeTruthy()
      expect(item.description.length).toBeGreaterThan(4)
    }
  })
})

// ---------------------------------------------------------------------------
// id 与色板记录
// ---------------------------------------------------------------------------

describe('nextColorId / createPaletteColor', () => {
  test('id 形如 c-xxxx-xxxx 且连续调用不重复', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 500; index += 1) {
      const id = nextColorId()
      expect(/^c-[0-9a-z]+-[0-9a-z]+$/.test(id)).toBeTruthy()
      ids.add(id)
    }
    expect(ids.size).toBe(500)
  })

  test('createPaletteColor 自动规范化 HEX 并生成 id', () => {
    const color = createPaletteColor('#4f7cff')
    expect(color.hex).toBe('#4F7CFF')
    expect(color.id.length > 0).toBeTruthy()
    expect(color.source).toBe('manual')
    expect(color.name).toBe(nameWithLevel('#4F7CFF'))
  })

  test('支持 #RGB 简写与自定义名称 / 来源', () => {
    const short = createPaletteColor('#fff')
    expect(short.hex).toBe('#FFFFFF')
    expect(short.name.startsWith('白色')).toBeTruthy()

    const custom = createPaletteColor('#22C55E', '品牌绿', 'harmony')
    expect(custom.name).toBe('品牌绿')
    expect(custom.source).toBe('harmony')
  })

  test('非法输入不抛异常并回退为中性灰', () => {
    const color = createPaletteColor('not-a-color')
    expect(HEX_PATTERN.test(color.hex)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 和谐配色
// ---------------------------------------------------------------------------

describe('generateHarmony', () => {
  test('8 种类型的数量、首元素与合法色值', () => {
    for (const type of HARMONY_TYPES) {
      for (const base of TYPICAL_BASES) {
        const colors = generateHarmony(base, type)
        expect(colors.length).toBe(HARMONY_COUNTS[type])
        expect(colors[0].name).toBe('主色')
        expect(colors[0].source).toBe('harmony')
        expect(colors[0].hex).toBe(base.toUpperCase())
        for (const color of colors) expectPaletteColor(color)
      }
    }
  })

  test('彩色主色的和谐配色互不重复', () => {
    for (const type of HARMONY_TYPES) {
      for (const base of ['#4F7CFF', '#22C55E', '#FF7A00']) {
        const colors = generateHarmony(base, type)
        expect(new Set(colors.map((item) => item.hex)).size).toBe(colors.length)
      }
    }
  })

  test('灰阶 / 纯黑 / 纯白等边界输入不崩溃且数量正确', () => {
    for (const type of HARMONY_TYPES) {
      for (const base of EDGE_BASES) {
        const colors = generateHarmony(base, type)
        expect(colors.length).toBe(HARMONY_COUNTS[type])
        expect(colors[0].hex).toBe(base.toUpperCase())
        expect(colors[0].name).toBe('主色')
        for (const color of colors) expectPaletteColor(color)
      }
    }
  })

  test('互补色与主色色相相差约 180°', () => {
    for (const base of TYPICAL_BASES) {
      const colors = generateHarmony(base, 'complementary')
      const distance = hueDistance(colors[0].hex, colors[1].hex)
      expect(Math.abs(distance - 180) < 10).toBeTruthy()
    }
  })

  test('相邻色 / 三角 / 分裂互补 / 四角的色相关系正确', () => {
    for (const base of TYPICAL_BASES) {
      const analogous = generateHarmony(base, 'analogous')
      expect(Math.abs(hueDistance(base, analogous[1].hex) - 30) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, analogous[2].hex) - 60) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, analogous[3].hex) - 30) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, analogous[4].hex) - 60) < 6).toBeTruthy()

      const triadic = generateHarmony(base, 'triadic')
      expect(Math.abs(hueDistance(base, triadic[1].hex) - 120) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, triadic[2].hex) - 120) < 6).toBeTruthy()

      const split = generateHarmony(base, 'split-complementary')
      expect(Math.abs(hueDistance(base, split[1].hex) - 150) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, split[2].hex) - 150) < 6).toBeTruthy()

      const tetradic = generateHarmony(base, 'tetradic')
      expect(Math.abs(hueDistance(base, tetradic[1].hex) - 90) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, tetradic[2].hex) - 180) < 6).toBeTruthy()
      expect(Math.abs(hueDistance(base, tetradic[3].hex) - 90) < 6).toBeTruthy()
    }
  })

  test('单色明暗保持色相并覆盖多档明度', () => {
    const colors = generateHarmony('#4F7CFF', 'monochromatic')
    expect(colors.length).toBe(5)
    for (const color of colors.slice(1)) {
      expect(hueDistance(colors[0].hex, color.hex) < 8).toBeTruthy()
    }
    expect(new Set(colors.map((color) => perceptualLightness(color.hex))).size).toBe(5)
  })

  test('暗调逐步变暗、亮调逐步变亮', () => {
    for (const base of TYPICAL_BASES) {
      const shades = generateHarmony(base, 'shades').map((color) => perceptualLightness(color.hex))
      for (let index = 1; index < shades.length; index += 1) {
        expect(shades[index] < shades[index - 1] - 0.02).toBeTruthy()
      }
      const tints = generateHarmony(base, 'tints').map((color) => perceptualLightness(color.hex))
      for (let index = 1; index < tints.length; index += 1) {
        expect(tints[index] > tints[index - 1] + 0.02).toBeTruthy()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 色阶
// ---------------------------------------------------------------------------

describe('generateTonalScale', () => {
  test('默认生成 11 档且键为档位字符串', () => {
    const scale = generateTonalScale('#4F7CFF')
    expect(Object.keys(scale)).toEqual(TONAL_STEPS.map(String))
    for (const value of Object.values(scale)) {
      expect(HEX_PATTERN.test(value)).toBeTruthy()
    }
  })

  test('明度从 50 到 950 严格递减', () => {
    for (const base of ['#4F7CFF', '#22C55E', '#FFD700', '#000000', '#808080']) {
      const values = Object.values(generateTonalScale(base))
      const lightness = values.map((value) => perceptualLightness(value))
      for (let index = 1; index < lightness.length; index += 1) {
        expect(lightness[index] < lightness[index - 1]).toBeTruthy()
      }
    }
  })

  test('亮端与暗端的色度自然收敛', () => {
    for (const base of ['#4F7CFF', '#22C55E', '#FF7A00', '#8B5CF6']) {
      const scale = generateTonalScale(base)
      const chroma = Object.values(scale).map((value) => hexToOklch(value).c)
      const lightEnd = chroma[0]
      const middle = chroma[5]
      const darkEnd = chroma[chroma.length - 1]
      expect(middle > 0.04).toBeTruthy()
      expect(lightEnd < middle * 0.5).toBeTruthy()
      expect(darkEnd < middle * 0.9).toBeTruthy()
    }
  })

  test('色相全程稳定', () => {
    for (const base of ['#4F7CFF', '#22C55E', '#8B5CF6']) {
      for (const value of Object.values(generateTonalScale(base))) {
        expect(hueDistance(base, value) < 6).toBeTruthy()
      }
    }
  })

  test('支持自定义 steps / chromaScale / lightnessRange', () => {
    const custom = generateTonalScale('#4F7CFF', { steps: [100, 400, 700] })
    expect(Object.keys(custom)).toEqual(['100', '400', '700'])

    const gray = generateTonalScale('#4F7CFF', { chromaScale: 0 })
    for (const value of Object.values(gray)) {
      expect(hexToOklch(value).c < 0.005).toBeTruthy()
    }

    const narrowed = generateTonalScale('#4F7CFF', { lightnessRange: [0.95, 0.3] })
    const values = Object.values(narrowed)
    expect(Math.abs(perceptualLightness(values[0]) - 0.95) < 0.02).toBeTruthy()
    expect(Math.abs(perceptualLightness(values[values.length - 1]) - 0.3) < 0.02).toBeTruthy()
  })

  test('非法输入回退为默认主色', () => {
    const scale = generateTonalScale('')
    expect(Object.keys(scale)).toEqual(TONAL_STEPS.map(String))
  })
})

describe('generateScales', () => {
  test('固定 8 组色阶且 key / label 正确', () => {
    const scales = generateScales('#4F7CFF')
    expect(scales.length).toBe(8)
    expect(scales.map((scale) => scale.key)).toEqual([
      'primary',
      'secondary',
      'accent',
      'neutral',
      'success',
      'warning',
      'error',
      'info',
    ])
    expect(scales.map((scale) => scale.label)).toEqual([
      '主色',
      '辅助色',
      '强调色',
      '中性色',
      '成功',
      '警告',
      '错误',
      '信息',
    ])
  })

  test('每组都有 light / dark 两套 50~950 的色阶', () => {
    for (const scale of generateScales('#4F7CFF')) {
      expect(Object.keys(scale.light)).toEqual(TONAL_STEPS.map(String))
      expect(Object.keys(scale.dark)).toEqual(TONAL_STEPS.map(String))
      for (const value of [...Object.values(scale.light), ...Object.values(scale.dark)]) {
        expect(HEX_PATTERN.test(value)).toBeTruthy()
      }
    }
  })

  test('主色色阶与 generateTonalScale 一致，深色模式色阶有轻微差异', () => {
    const scales = generateScales('#4F7CFF')
    expect(scales[0].light).toEqual(generateTonalScale('#4F7CFF'))
    expect(JSON.stringify(scales[0].light) === JSON.stringify(scales[0].dark)).toBeFalsy()
  })

  test('深色模式色阶保持与浅色模式相同的色相', () => {
    const scales = generateScales('#8B5CF6')
    for (const scale of scales.slice(0, 3)) {
      for (const step of TONAL_STEPS.map(String)) {
        expect(hueDistance(scale.light[step], scale.dark[step]) < 8).toBeTruthy()
      }
    }
  })

  test('中性色色阶接近灰阶', () => {
    const neutral = generateScales('#4F7CFF')[3]
    for (const value of Object.values(neutral.light)) {
      expect(hexToOklch(value).c < 0.03).toBeTruthy()
    }
  })

  test('语义色使用约定俗成的色相', () => {
    const scales = generateScales('#4F7CFF')
    const expected: Record<string, number> = { success: 152, warning: 72, error: 27, info: 250 }
    for (const [key, hue] of Object.entries(expected)) {
      const scale = scales.find((item) => item.key === key)
      if (!scale) throw new Error(`缺少色阶：${key}`)
      const actual = hexToOklch(scale.light['500']).h
      expect(angularDistance(actual, hue) < 20).toBeTruthy()
    }
  })

  test('灰阶主色也能生成完整色阶', () => {
    for (const base of ['#808080', '#000000', '#FFFFFF']) {
      const scales = generateScales(base)
      expect(scales.length).toBe(8)
      for (const value of Object.values(scales[3].light)) {
        expect(hexToOklch(value).c < 0.01).toBeTruthy()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 语义主题
// ---------------------------------------------------------------------------

describe('generateSemanticTheme', () => {
  test('主题结构与 token 数量 / 顺序符合契约', () => {
    const theme = generateSemanticTheme('#4F7CFF')
    expect(theme.baseColor).toBe('#4F7CFF')
    expect(theme.method).toBe('balanced')
    expect(theme.tokens.length).toBe(18)
    expect(theme.tokens.map((token) => token.key)).toEqual([...THEME_TOKEN_KEYS])
    expect(theme.scales.length).toBe(8)
    expect(Math.abs(theme.createdAt - Date.now()) < 5000).toBeTruthy()
  })

  test('每个 token 都有中文名称、说明与合法色值', () => {
    for (const method of METHOD_IDS) {
      const theme = generateSemanticTheme('#4F7CFF', method)
      for (const token of theme.tokens) {
        expect(CJK_PATTERN.test(token.label)).toBeTruthy()
        expect(token.description.length).toBeGreaterThan(4)
        expect(HEX_PATTERN.test(token.light)).toBeTruthy()
        expect(HEX_PATTERN.test(token.dark)).toBeTruthy()
      }
    }
  })

  test('text-primary / background 对比度 ≥ 7:1，on-primary / primary ≥ 4.5:1', () => {
    for (const base of [...TYPICAL_BASES, ...EDGE_BASES]) {
      for (const method of METHOD_IDS) {
        const theme = generateSemanticTheme(base, method)
        const textPrimary = tokenValue(theme, 'text-primary')
        const background = tokenValue(theme, 'background')
        const onPrimary = tokenValue(theme, 'on-primary')
        const primary = tokenValue(theme, 'primary')
        expect(contrastRatio(textPrimary.light, background.light) >= 7).toBeTruthy()
        expect(contrastRatio(textPrimary.dark, background.dark) >= 7).toBeTruthy()
        expect(contrastRatio(onPrimary.light, primary.light) >= 4.5).toBeTruthy()
        expect(contrastRatio(onPrimary.dark, primary.dark) >= 4.5).toBeTruthy()
      }
    }
  })

  test('背景：浅色接近白色且带轻微色偏，深色不是纯黑', () => {
    for (const base of ['#4F7CFF', '#22C55E', '#FF7A00', '#808080']) {
      const theme = generateSemanticTheme(base)
      const background = tokenValue(theme, 'background')
      expect(relativeLuminance(background.light) > 0.85).toBeTruthy()
      expect(relativeLuminance(background.dark) < 0.12).toBeTruthy()
      expect(background.light === '#000000').toBeFalsy()
      expect(background.dark === '#000000').toBeFalsy()
      // 对主色有色偏：浅色背景不是纯灰
      expect(hexToOklch(background.light).c > 0.0005).toBeTruthy()
      expect(hexToOklch(background.light).c < 0.03).toBeTruthy()
    }
  })

  test('文字对比度之外，hover / active 状态仍然可读且互不相同', () => {
    for (const base of ['#4F7CFF', '#000000', '#FFFFFF', '#FFFF00', '#808080']) {
      const theme = generateSemanticTheme(base)
      const primary = tokenValue(theme, 'primary')
      const hover = tokenValue(theme, 'primary-hover')
      const active = tokenValue(theme, 'primary-active')
      const onPrimary = tokenValue(theme, 'on-primary')
      expect(hover.light === primary.light).toBeFalsy()
      expect(active.light === primary.light).toBeFalsy()
      expect(hover.light === active.light).toBeFalsy()
      expect(hover.dark === primary.dark).toBeFalsy()
      expect(active.dark === primary.dark).toBeFalsy()
      expect(hover.dark === active.dark).toBeFalsy()
      expect(contrastRatio(onPrimary.light, hover.light) >= 4.5).toBeTruthy()
      expect(contrastRatio(onPrimary.dark, hover.dark) >= 4.5).toBeTruthy()
      expect(contrastRatio(onPrimary.light, active.light) >= 4.5).toBeTruthy()
      expect(contrastRatio(onPrimary.dark, active.dark) >= 4.5).toBeTruthy()
    }
  })

  test('辅助色上的 on-primary 依然可读', () => {
    for (const base of ['#4F7CFF', '#22C55E', '#FF7A00', '#000000', '#FFFFFF', '#808080']) {
      const theme = generateSemanticTheme(base)
      const secondary = tokenValue(theme, 'secondary')
      const onPrimary = tokenValue(theme, 'on-primary')
      expect(contrastRatio(onPrimary.light, secondary.light) >= 4.4).toBeTruthy()
      expect(contrastRatio(onPrimary.dark, secondary.dark) >= 4.4).toBeTruthy()
    }
  })

  test('次要文字对背景保持可读（≥ 4.5:1）', () => {
    for (const method of METHOD_IDS) {
      const theme = generateSemanticTheme('#4F7CFF', method)
      const secondary = tokenValue(theme, 'text-secondary')
      const background = tokenValue(theme, 'background')
      expect(contrastRatio(secondary.light, background.light) >= 4.5).toBeTruthy()
      expect(contrastRatio(secondary.dark, background.dark) >= 4.5).toBeTruthy()
    }
  })

  test('5 种生成方式产生不同的主题基调', () => {
    const signatures = METHOD_IDS.map((method) =>
      JSON.stringify(generateSemanticTheme('#4F7CFF', method).tokens),
    )
    expect(new Set(signatures).size).toBe(5)
  })

  test('vivid 比 muted 更饱和，high-contrast 文字对比更强', () => {
    const vivid = generateSemanticTheme('#4F7CFF', 'vivid')
    const muted = generateSemanticTheme('#4F7CFF', 'muted')
    const vividChroma = hexToOklch(tokenValue(vivid, 'primary').light).c
    const mutedChroma = hexToOklch(tokenValue(muted, 'primary').light).c
    expect(vividChroma >= mutedChroma).toBeTruthy()

    const balanced = generateSemanticTheme('#4F7CFF', 'balanced')
    const highContrast = generateSemanticTheme('#4F7CFF', 'high-contrast')
    const balancedText = contrastRatio(
      tokenValue(balanced, 'text-primary').light,
      tokenValue(balanced, 'background').light,
    )
    const highText = contrastRatio(
      tokenValue(highContrast, 'text-primary').light,
      tokenValue(highContrast, 'background').light,
    )
    expect(highText > balancedText).toBeTruthy()
  })

  test('灰阶 / 纯黑 / 纯白主色不会生成非法 token', () => {
    for (const base of EDGE_BASES) {
      const theme = generateSemanticTheme(base)
      expect(theme.tokens.length).toBe(18)
      for (const token of theme.tokens) {
        expect(HEX_PATTERN.test(token.light)).toBeTruthy()
        expect(HEX_PATTERN.test(token.dark)).toBeTruthy()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 推荐色板
// ---------------------------------------------------------------------------

describe('suggestPalette', () => {
  test('返回 12~18 个颜色且第一个是主色', () => {
    const palette = suggestPalette('#4F7CFF')
    expect(palette.length >= 12 && palette.length <= 18).toBeTruthy()
    expect(palette[0].name).toBe('主色')
    expect(palette[0].hex).toBe('#4F7CFF')
    expect(palette[0].source).toBe('harmony')
  })

  test('名称全部为中文、色值合法、id 唯一', () => {
    const palette = suggestPalette('#22C55E')
    expect(new Set(palette.map((item) => item.id)).size).toBe(palette.length)
    for (const color of palette) {
      expect(CJK_PATTERN.test(color.name)).toBeTruthy()
      expectPaletteColor(color)
      expect(['manual', 'harmony', 'scale', 'theme', 'imported'].includes(String(color.source))).toBeTruthy()
    }
    const names = palette.map((item) => item.name)
    for (const required of ['主色', '辅助色', '强调色', '成功', '警告', '错误', '信息', '边框']) {
      expect(names.includes(required)).toBeTruthy()
    }
  })

  test('边界主色也能给出完整推荐色板', () => {
    for (const base of ['#000000', '#FFFFFF', '#808080', '#FFFF00']) {
      const palette = suggestPalette(base)
      expect(palette.length >= 12 && palette.length <= 18).toBeTruthy()
      for (const color of palette) expectPaletteColor(color)
    }
  })
})

// ---------------------------------------------------------------------------
// 中文色名
// ---------------------------------------------------------------------------

describe('colorDisplayName / nameWithLevel', () => {
  test('契约示例色名正确', () => {
    expect(colorDisplayName('#4F7CFF')).toBe('靛蓝')
    expect(colorDisplayName('#FF7A00')).toBe('朱橙')
    expect(colorDisplayName('#22C55E')).toBe('翠绿')
  })

  test('主要色系命名正确', () => {
    expect(colorDisplayName('#FF0000')).toBe('赤红')
    expect(colorDisplayName('#F43F5E')).toBe('赤红')
    expect(colorDisplayName('#FFD700')).toBe('明黄')
    expect(colorDisplayName('#84CC16')).toBe('草绿')
    expect(colorDisplayName('#10B981')).toBe('翠绿')
    expect(colorDisplayName('#06B6D4')).toBe('青碧')
    expect(colorDisplayName('#00AEEF')).toBe('天蓝')
    expect(colorDisplayName('#8B5CF6')).toBe('紫罗兰')
    expect(colorDisplayName('#A855F7')).toBe('紫棠')
    expect(colorDisplayName('#EC4899')).toBe('玫红')
    expect(colorDisplayName('#4f7cff')).toBe('靛蓝')
  })

  test('低饱和颜色按明度返回灰阶名称', () => {
    expect(colorDisplayName('#000000')).toBe('黑色')
    expect(colorDisplayName('#333333')).toBe('深灰')
    expect(colorDisplayName('#777777')).toBe('中灰')
    expect(colorDisplayName('#6B7280')).toBe('中灰')
    expect(colorDisplayName('#DDDDDD')).toBe('浅灰')
    expect(colorDisplayName('#FFFFFF')).toBe('白色')
  })

  test('所有色名都是 2~3 个汉字的色系名', () => {
    const samples = [
      '#4F7CFF',
      '#FF7A00',
      '#22C55E',
      '#FF0000',
      '#FFD700',
      '#00AEEF',
      '#8B5CF6',
      '#EC4899',
      '#333333',
      '#777777',
      '#DDDDDD',
    ]
    for (const sample of samples) {
      expect(/^[\u4e00-\u9fa5]{2,3}$/.test(colorDisplayName(sample))).toBeTruthy()
    }
  })

  test('nameWithLevel 由色名 + 色阶档位组成', () => {
    expect(nameWithLevel('#4F7CFF')).toBe('靛蓝 500')
    for (const sample of ['#4F7CFF', '#22C55E', '#777777', '#DDDDDD', '#000000']) {
      const name = nameWithLevel(sample)
      expect(name.startsWith(colorDisplayName(sample))).toBeTruthy()
      const matched = TONAL_STEPS.some((step) => name.endsWith(` ${step}`))
      expect(matched).toBeTruthy()
    }
    expect(nameWithLevel('#DDDDDD').startsWith('浅灰')).toBeTruthy()
    expect(nameWithLevel('#777777').startsWith('中灰')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 合并锁定颜色
// ---------------------------------------------------------------------------

describe('mergeGeneratedPalette', () => {
  const existing: PaletteColor[] = [
    { id: 'e1', name: '锁定品牌色', hex: '#FF0000', locked: true },
    { id: 'e2', name: '普通色', hex: '#00FF00' },
    { id: 'e3', name: '锁定辅助', hex: '#0000FF', locked: true },
  ]
  const generated: PaletteColor[] = [
    { id: 'g1', name: '与锁定色重复', hex: '#FF0000' },
    { id: 'g2', name: '新颜色', hex: '#123456' },
    { id: 'g3', name: '重复生成色', hex: '#123456' },
  ]

  test('锁定色排在最前，生成色去重后补齐', () => {
    const merged = mergeGeneratedPalette(existing, generated)
    expect(merged.length).toBe(3)
    expect(merged[0].id).toBe('e1')
    expect(merged[1].id).toBe('e3')
    expect(merged[0].hex).toBe('#FF0000')
    expect(merged[2].hex).toBe('#123456')
    expect(new Set(merged.map((item) => item.hex)).size).toBe(merged.length)
  })

  test('不修改入参且返回全新数组', () => {
    const existingSnapshot = JSON.stringify(existing)
    const generatedSnapshot = JSON.stringify(generated)
    const merged = mergeGeneratedPalette(existing, generated)
    expect(JSON.stringify(existing)).toBe(existingSnapshot)
    expect(JSON.stringify(generated)).toBe(generatedSnapshot)
    expect(merged === existing).toBeFalsy()
    expect(merged === generated).toBeFalsy()
  })

  test('没有锁定色时只保留生成色，没有生成色时只保留锁定色', () => {
    const unlocked = existing.filter((color) => !color.locked)
    expect(mergeGeneratedPalette(unlocked, generated).length).toBe(2)
    expect(mergeGeneratedPalette(existing, []).length).toBe(2)
    expect(mergeGeneratedPalette([], generated).length).toBe(2)
  })
})
