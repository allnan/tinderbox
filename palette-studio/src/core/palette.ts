/**
 * 配色生成引擎：和谐配色、明度色阶、语义主题（token）、中文色名与色板合并。
 *
 * 设计约定：
 * - 所有色彩计算都复用 `src/core/color.ts` 的 OKLCH / 对比度函数，本文件只做“设计决策”；
 * - 全部为纯函数，不依赖 DOM / Node / 第三方库；
 * - 输出颜色统一为大写 `#RRGGBB`，输入兼容 color.ts 支持的任意格式；
 * - 明度使用 OKLCH 的 L（感知均匀），因此各档位之间的明暗过渡自然。
 */
import type {
  GeneratedTheme,
  PaletteColor,
  ThemeMethod,
  ThemeMethodId,
  ThemeScale,
  ThemeToken,
} from '../shared/types'
import { THEME_TOKEN_KEYS } from '../shared/types'
import { clamp, contrastRatio, hexToOklch, nearestStep, normalizeHex, oklchToHex } from './color'

// ---------------------------------------------------------------------------
// 公开类型与常量
// ---------------------------------------------------------------------------

export type HarmonyType =
  | 'complementary' // 互补色
  | 'analogous' // 相邻色
  | 'triadic' // 三角配色
  | 'split-complementary' // 分裂互补
  | 'tetradic' // 四角配色
  | 'monochromatic' // 单色明暗
  | 'shades' // 暗调（加深）
  | 'tints' // 亮调（减淡）

export interface HarmonyInfo {
  type: HarmonyType
  label: string
  description: string
}

/** 8 种和谐配色，顺序固定（UI 依赖这个顺序渲染选择器） */
export const HARMONIES: HarmonyInfo[] = [
  { type: 'complementary', label: '互补色', description: '色轮正对面，视觉冲击最强' },
  { type: 'analogous', label: '相邻色', description: '色相左右相邻，过渡柔和统一' },
  { type: 'triadic', label: '三角配色', description: '色轮三等分，色彩平衡又活泼' },
  { type: 'split-complementary', label: '分裂互补', description: '取互补色两侧，对比更柔和' },
  { type: 'tetradic', label: '四角配色', description: '两对互补色，层次丰富耐看' },
  { type: 'monochromatic', label: '单色明暗', description: '同一色相的明暗变化，克制高级' },
  { type: 'shades', label: '暗调', description: '主色逐步加深，沉稳厚重' },
  { type: 'tints', label: '亮调', description: '主色逐步减淡，轻盈通透' },
]

/** 色阶档位，与 Tailwind / Material 的习惯保持一致 */
export const TONAL_STEPS: number[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

/** 5 种主题生成方式 */
export const THEME_METHODS: ThemeMethod[] = [
  { id: 'balanced', label: '均衡', description: '自然平衡的默认方案，大多数项目首选' },
  { id: 'vivid', label: '鲜艳', description: '提高饱和度与色彩存在感，更有冲击力' },
  { id: 'muted', label: '柔和', description: '降低饱和度，含蓄耐看，适合长时间阅读' },
  { id: 'neutral', label: '中性', description: '背景更中性，让品牌主色成为唯一焦点' },
  { id: 'high-contrast', label: '高对比', description: '文字与边框对比更强，可读性优先' },
]

// ---------------------------------------------------------------------------
// id 与色板记录
// ---------------------------------------------------------------------------

let colorIdSeed = 0

/**
 * 生成颜色记录的唯一 id，形如 `c-lq3k2-8f1a`。
 * 时间戳 + 自增序号 + 随机串，保证同一毫秒内连续调用也不重复。
 */
export function nextColorId(): string {
  colorIdSeed = (colorIdSeed + 1) % 46656
  const time = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  const seq = colorIdSeed.toString(36).padStart(3, '0')
  return `c-${time}-${seq}${random}`
}

/**
 * 创建一个标准色板颜色：自动规范化 HEX、生成唯一 id。
 * name 缺省时使用「中文色名 + 色阶级别」，例如「靛蓝 500」。
 */
export function createPaletteColor(
  hex: string,
  name?: string,
  source: PaletteColor['source'] = 'manual',
): PaletteColor {
  const normalized = normalizeHex(hex) ?? '#808080'
  const trimmedName = name?.trim()
  return {
    id: nextColorId(),
    name: trimmedName ? trimmedName : nameWithLevel(normalized),
    hex: normalized,
    source: source ?? 'manual',
  }
}

// ---------------------------------------------------------------------------
// 中文色名
// ---------------------------------------------------------------------------

/** OKLCH 色度低于该值时视为灰阶（与契约中的 0.03 一致） */
const GRAY_CHROMA = 0.03

/** 12 个色相色系（OKLCH 色相角度，单位度）；0~8 度归入玫红 */
const COLOR_FAMILIES: Array<{ name: string; from: number; to: number }> = [
  { name: '赤红', from: 8, to: 35 },
  { name: '朱橙', from: 35, to: 62 },
  { name: '橙黄', from: 62, to: 85 },
  { name: '明黄', from: 85, to: 120 },
  { name: '草绿', from: 120, to: 143 },
  { name: '翠绿', from: 143, to: 185 },
  { name: '青碧', from: 185, to: 225 },
  { name: '天蓝', from: 225, to: 250 },
  { name: '靛蓝', from: 250, to: 280 },
  { name: '紫罗兰', from: 280, to: 300 },
  { name: '紫棠', from: 300, to: 330 },
  { name: '玫红', from: 330, to: 360 },
]

/**
 * 根据颜色给出中文色名。
 * 低饱和（OKLCH chroma < 0.03）时按明度返回「深灰 / 中灰 / 浅灰」。
 */
export function colorDisplayName(hex: string): string {
  const normalized = normalizeHex(hex) ?? '#808080'
  const { l, c, h } = hexToOklch(normalized)
  if (c < GRAY_CHROMA) {
    // 纯黑/纯白单独命名，不要叫「深灰 / 浅灰」
    if (l <= 0.03) return '黑色'
    if (l >= 0.97) return '白色'
    if (l < 0.42) return '深灰'
    if (l < 0.75) return '中灰'
    return '浅灰'
  }
  const hue = ((h % 360) + 360) % 360
  for (const family of COLOR_FAMILIES) {
    if (hue >= family.from && hue < family.to) return family.name
  }
  // 0~8 度的偏品红区域
  return '玫红'
}

/**
 * 色名 + 最接近的色阶级别，例如「靛蓝 500」「浅灰 100」。
 * 色阶以该颜色自身为基准生成，因此级别反映的是明度所在位置。
 */
export function nameWithLevel(hex: string): string {
  const normalized = normalizeHex(hex) ?? '#808080'
  const level = nearestStep(normalized, generateTonalScale(normalized))
  return `${colorDisplayName(normalized)} ${level}`
}

// ---------------------------------------------------------------------------
// OKLCH 内部小工具
// ---------------------------------------------------------------------------

interface Seed {
  l: number
  c: number
  h: number
}

function seedOf(hex: string): Seed {
  const { l, c, h } = hexToOklch(hex)
  return { l, c, h }
}

/** Seed → HEX（自动钳制并做色域映射） */
function fromSeed(seed: Seed): string {
  return oklchToHex({ l: clamp(seed.l, 0, 1), c: Math.max(0, seed.c), h: seed.h })
}

/** 基于原色相/色度做色相旋转、明暗偏移与色度缩放 */
function shiftSeed(seed: Seed, options: { dh?: number; dl?: number; cf?: number } = {}): Seed {
  return {
    l: clamp(seed.l + (options.dl ?? 0), 0.01, 0.995),
    c: Math.max(0, seed.c * (options.cf ?? 1)),
    h: seed.h + (options.dh ?? 0),
  }
}

/** 颜色是否接近灰阶（色相无意义） */
function isGrayish(chroma: number): boolean {
  return chroma < 0.02
}

/**
 * 保证生成的 HEX 不与已用颜色重复：优先上下微调明度，实在不行再微调色度。
 * 用于灰阶主色、纯黑/纯白等色相旋转无效的边界情况。
 */
function ensureUniqueHex(hex: string, used: Set<string>): string {
  const normalized = normalizeHex(hex) ?? '#808080'
  if (!used.has(normalized)) return normalized
  const seed = seedOf(normalized)
  for (let step = 1; step <= 24; step += 1) {
    const delta = step * 0.035
    for (const direction of [1, -1]) {
      const candidate = oklchToHex({
        l: clamp(seed.l + direction * delta, 0.02, 0.992),
        c: seed.c,
        h: seed.h,
      })
      if (!used.has(candidate)) return candidate
    }
  }
  return normalized
}

/**
 * 状态色明度微调（hover / active）：
 * - 明度贴近端点时自动反向，避免“继续提亮白色”这类无效操作；
 * - 端点附近加大步幅，保证深色/浅色主色的状态变化仍然可见；
 * - 量化后与原色相同则继续加大步长，保证一定产生差异。
 */
function nudgeLightness(hex: string, delta: number): string {
  const source = normalizeHex(hex) ?? '#808080'
  const seed = seedOf(source)
  let magnitude = clamp(Math.abs(delta) || 0.04, 0.02, 0.4)
  // 接近纯黑时小步长几乎不可见，适当加大到能看出差别的程度
  if (seed.l < 0.1) magnitude = Math.max(magnitude, 0.14)
  let direction: 1 | -1 = delta >= 0 ? 1 : -1
  if (seed.l + direction * magnitude > 0.99 || seed.l + direction * magnitude < 0.02) {
    direction = direction === 1 ? -1 : 1
  }
  for (let step = 1; step <= 24; step += 1) {
    const candidate = oklchToHex({
      l: clamp(seed.l + direction * magnitude * step, 0.02, 0.995),
      c: seed.c,
      h: seed.h,
    })
    if (candidate !== source) return candidate
  }
  return source
}

/**
 * 交互状态（hover / active）的明度方向：
 * 亮色变暗、暗色变亮；中间明度朝“提高 on-primary 对比度”的方向偏移，
 * 这样悬停/按下之后按钮文字依旧清晰。
 */
function stateDirection(lightness: number, onPrimary: string): 1 | -1 {
  if (lightness > 0.86) return -1
  if (lightness < 0.16) return 1
  return onPrimary === '#FFFFFF' ? -1 : 1
}

/**
 * 逐步调整明度，直到与指定背景达到目标对比度；仍不达标时退回纯黑/纯白兜底。
 * direction 为 -1 表示向暗处走（浅色背景上的深色文字），+1 表示向亮处走。
 */
function certifyOnBackground(
  seed: Seed,
  background: string,
  target: number,
  direction: 1 | -1,
): string {
  let current: Seed = { ...seed }
  let hex = fromSeed(current)
  let guard = 0
  while (contrastRatio(hex, background) < target && guard < 100) {
    current = { ...current, l: clamp(current.l + direction * 0.02, 0.02, 0.995) }
    hex = fromSeed(current)
    guard += 1
    if ((direction < 0 && current.l <= 0.02) || (direction > 0 && current.l >= 0.995)) break
  }
  if (contrastRatio(hex, background) >= target) return hex
  const black = contrastRatio('#000000', background)
  const white = contrastRatio('#FFFFFF', background)
  return black >= white ? '#000000' : '#FFFFFF'
}

/**
 * 主色上的前景色：优先在「白 / 深板岩」中挑对比度更高者。
 * 中明度主色存在两者都不足 4.5:1 的窄带，此时用纯黑（必定 ≥ 4.5:1）。
 */
function pickOnPrimary(background: string): string {
  const white = contrastRatio('#FFFFFF', background)
  const dark = contrastRatio('#111827', background)
  if (white >= 4.5 || dark >= 4.5) return white >= dark ? '#FFFFFF' : '#111827'
  return '#000000'
}

/** 让辅助色上的 on-primary 仍然可读（≥ 4.5:1）：远离前景明度方向调整 */
function certifyAgainstForeground(seed: Seed, foreground: string, target = 4.5): string {
  const foregroundIsLight = foreground === '#FFFFFF'
  let current: Seed = { ...seed }
  let hex = fromSeed(current)
  let guard = 0
  while (contrastRatio(hex, foreground) < target && guard < 30) {
    current = {
      ...current,
      l: clamp(current.l + (foregroundIsLight ? -0.025 : 0.025), 0.1, 0.94),
    }
    hex = fromSeed(current)
    guard += 1
  }
  return hex
}

// ---------------------------------------------------------------------------
// 色阶
// ---------------------------------------------------------------------------

/** 色度沿档位的变化曲线：亮端克制、中段饱满、暗端适度收敛 */
const CHROMA_PROFILE = [0.12, 0.24, 0.42, 0.63, 0.83, 1, 1.02, 0.96, 0.86, 0.73, 0.58]

function chromaProfile(position: number): number {
  const scaled = clamp(position, 0, 1) * (CHROMA_PROFILE.length - 1)
  const lower = Math.floor(scaled)
  const upper = Math.min(CHROMA_PROFILE.length - 1, lower + 1)
  const ratio = scaled - lower
  return CHROMA_PROFILE[lower] + (CHROMA_PROFILE[upper] - CHROMA_PROFILE[lower]) * ratio
}

interface TonalOptions {
  steps?: number[]
  chromaScale?: number
  lightnessRange?: [number, number]
}

/**
 * 从 OKLCH 种子生成一组色阶（内部实现）。
 * 明度按 `p^1.28` 曲线分布：亮端档位间距小、暗端略大，整体接近 Tailwind 的观感。
 */
function tonalFromSeed(seed: Seed, options: TonalOptions = {}): Record<string, string> {
  const steps = options.steps && options.steps.length > 0 ? options.steps : TONAL_STEPS
  const range = options.lightnessRange ?? [0.975, 0.19]
  const lightest = clamp(Math.max(range[0], range[1]), 0, 1)
  const darkest = clamp(Math.min(range[0], range[1]), 0, 1)
  const chromaScale = options.chromaScale ?? 1
  const scale: Record<string, string> = {}
  steps.forEach((step, index) => {
    const position = steps.length <= 1 ? 0 : index / (steps.length - 1)
    const lightness = lightest - (lightest - darkest) * Math.pow(position, 1.28)
    const chroma = Math.max(0, seed.c) * chromaProfile(position) * chromaScale
    scale[String(step)] = oklchToHex({ l: lightness, c: chroma, h: seed.h })
  })
  return scale
}

/**
 * 基于 OKLCH 生成色阶：50 最亮、950 最暗，键为档位字符串。
 *
 * - 明度分布参考 Tailwind / Material，均匀且有节奏；
 * - 色度在亮端与暗端自然收敛，色相全程保持稳定；
 * - `chromaScale` 可整体缩放饱和度（0 得到灰阶），`lightnessRange` 可自定义最亮/最暗端明度。
 */
export function generateTonalScale(baseHex: string, options: TonalOptions = {}): Record<string, string> {
  const normalized = normalizeHex(baseHex) ?? '#4F7CFF'
  const seed = seedOf(normalized)
  return tonalFromSeed(seed, options)
}

/** 色阶的稳定元信息（顺序固定） */
const SCALE_META: Array<{ key: string; label: string }> = [
  { key: 'primary', label: '主色' },
  { key: 'secondary', label: '辅助色' },
  { key: 'accent', label: '强调色' },
  { key: 'neutral', label: '中性色' },
  { key: 'success', label: '成功' },
  { key: 'warning', label: '警告' },
  { key: 'error', label: '错误' },
  { key: 'info', label: '信息' },
]

/** 深色模式色阶的色度倍率：同色相下略提饱和，在深色背景上更有存在感 */
const DARK_SCALE_CHROMA = 1.07

/**
 * 生成 8 组色阶：primary / secondary / accent / neutral / success / warning / error / info。
 * 每组包含 light 与 dark 两套 50~950 的色阶；深色模式只轻微提高色度，色相保持不变。
 */
export function generateScales(baseHex: string): ThemeScale[] {
  const normalized = normalizeHex(baseHex) ?? '#4F7CFF'
  const base = seedOf(normalized)
  const chroma = base.c

  // 每种色阶的种子色彩：主色派生辅助/强调，语义色使用约定俗成的色相
  const seeds: Seed[] = [
    { l: base.l, c: chroma, h: base.h },
    { l: base.l, c: chroma * 0.88, h: base.h + 32 },
    { l: base.l, c: chroma * 1.02, h: base.h + 180 },
    { l: base.l, c: Math.min(chroma, 0.012), h: base.h },
    { l: 0.6, c: 0.155, h: 152 },
    { l: 0.72, c: 0.16, h: 72 },
    { l: 0.6, c: 0.185, h: 27 },
    { l: 0.6, c: 0.15, h: 250 },
  ]

  return SCALE_META.map((meta, index) => ({
    key: meta.key,
    label: meta.label,
    light: tonalFromSeed(seeds[index]),
    dark: tonalFromSeed(seeds[index], { chromaScale: DARK_SCALE_CHROMA }),
  }))
}

// ---------------------------------------------------------------------------
// 和谐配色
// ---------------------------------------------------------------------------

/** 以主色为起点，按指定明度方向做等差明暗变化 */
function buildRamp(
  normalized: string,
  seed: Seed,
  count: number,
  direction: 1 | -1,
): string[] {
  const lightest = 0.985
  const darkest = 0.02
  let dir = direction
  let step = 0.085
  const room = dir > 0 ? lightest - seed.l : seed.l - darkest
  if (room < step * (count - 1)) {
    step = room / (count - 1)
    // 主色已经贴近端点时反向生成，保证 5 个颜色仍然可区分
    if (step < 0.05) {
      dir = (dir === 1 ? -1 : 1) as 1 | -1
      const backRoom = dir > 0 ? lightest - seed.l : seed.l - darkest
      step = Math.min(0.085, Math.max(0.06, backRoom / (count - 1)))
    }
  }
  const hexes: string[] = [normalized]
  for (let index = 1; index < count; index += 1) {
    const lightness = clamp(seed.l + dir * step * index, darkest, lightest)
    hexes.push(oklchToHex({ l: lightness, c: seed.c, h: seed.h }))
  }
  return hexes
}

/** 按和谐类型计算原始 HEX 列表（第一个永远是主色） */
function harmonyHexes(normalized: string, seed: Seed, type: HarmonyType): string[] {
  const rotate = (degrees: number): string => fromSeed({ ...seed, h: seed.h + degrees })
  switch (type) {
    case 'complementary':
      return [normalized, rotate(180)]
    case 'analogous':
      return [normalized, rotate(30), rotate(60), rotate(-30), rotate(-60)]
    case 'triadic':
      return [normalized, rotate(120), rotate(240)]
    case 'split-complementary':
      return [normalized, rotate(150), rotate(210)]
    case 'tetradic':
      return [normalized, rotate(90), rotate(180), rotate(270)]
    case 'monochromatic':
      return [
        normalized,
        fromSeed(shiftSeed(seed, { dl: 0.16 })),
        fromSeed(shiftSeed(seed, { dl: -0.16 })),
        fromSeed(shiftSeed(seed, { dl: 0.32 })),
        fromSeed(shiftSeed(seed, { dl: -0.32 })),
      ]
    case 'shades':
      return buildRamp(normalized, seed, 5, -1)
    case 'tints':
      return buildRamp(normalized, seed, 5, 1)
    default:
      return [normalized]
  }
}

/** 和谐配色的元素数量（契约固定） */
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

/**
 * 按指定和谐类型生成配色方案。
 * 第一个元素固定为主色（name 为「主色」），其余元素使用「中文色名 + 色阶」命名；
 * 灰阶主色等边界输入会通过明度微调避免完全重复。
 */
export function generateHarmony(baseHex: string, type: HarmonyType): PaletteColor[] {
  const normalized = normalizeHex(baseHex) ?? '#4F7CFF'
  const seed = seedOf(normalized)
  const count = HARMONY_COUNTS[type] ?? 1
  const hexes = harmonyHexes(normalized, seed, type).slice(0, count)
  const used = new Set<string>()
  return hexes.map((hex, index) => {
    const uniqueHex = ensureUniqueHex(hex, used)
    used.add(uniqueHex)
    return {
      id: nextColorId(),
      name: index === 0 ? '主色' : nameWithLevel(uniqueHex),
      hex: uniqueHex,
      source: 'harmony',
    }
  })
}

// ---------------------------------------------------------------------------
// 语义主题
// ---------------------------------------------------------------------------

interface ThemeMethodConfig {
  /** 主色饱和度倍率 */
  chroma: number
  /** 背景取主色色相的比例 */
  bgTintFactor: number
  /** 背景色度上限 */
  bgTintMax: number
  /** 灰阶主色时背景保留的最小色度（让深色模式带一点冷调，不落入纯灰/纯黑） */
  minTint: number
  bgLightL: number
  bgDarkL: number
  surfaceLightL: number
  surfaceDarkL: number
  raisedLightL: number
  raisedDarkL: number
  textLightL: number
  textDarkL: number
  textTarget: number
  secondaryTextLightL: number
  secondaryTextDarkL: number
  secondaryTextTarget: number
  disabledLightL: number
  disabledDarkL: number
  disabledTarget: number
  borderLightL: number
  borderStrongLightL: number
  borderDarkL: number
  borderStrongDarkL: number
  semanticLightStart: number
  semanticDarkStart: number
  semanticTarget: number
}

/** 5 种生成方式的“设计参数”：明暗基调、饱和度、文字对比目标 */
const METHOD_CONFIG: Record<ThemeMethodId, ThemeMethodConfig> = {
  balanced: {
    chroma: 1,
    bgTintFactor: 0.045,
    bgTintMax: 0.007,
    minTint: 0.0025,
    bgLightL: 0.977,
    bgDarkL: 0.205,
    surfaceLightL: 0.993,
    surfaceDarkL: 0.242,
    raisedLightL: 1,
    raisedDarkL: 0.29,
    textLightL: 0.26,
    textDarkL: 0.93,
    textTarget: 7,
    secondaryTextLightL: 0.46,
    secondaryTextDarkL: 0.72,
    secondaryTextTarget: 4.8,
    disabledLightL: 0.62,
    disabledDarkL: 0.52,
    disabledTarget: 2.8,
    borderLightL: 0.885,
    borderStrongLightL: 0.71,
    borderDarkL: 0.335,
    borderStrongDarkL: 0.45,
    semanticLightStart: 0.55,
    semanticDarkStart: 0.66,
    semanticTarget: 4.5,
  },
  vivid: {
    chroma: 1.16,
    bgTintFactor: 0.06,
    bgTintMax: 0.009,
    minTint: 0.003,
    bgLightL: 0.976,
    bgDarkL: 0.195,
    surfaceLightL: 0.992,
    surfaceDarkL: 0.238,
    raisedLightL: 1,
    raisedDarkL: 0.288,
    textLightL: 0.24,
    textDarkL: 0.94,
    textTarget: 7,
    secondaryTextLightL: 0.44,
    secondaryTextDarkL: 0.73,
    secondaryTextTarget: 4.8,
    disabledLightL: 0.6,
    disabledDarkL: 0.5,
    disabledTarget: 2.8,
    borderLightL: 0.88,
    borderStrongLightL: 0.7,
    borderDarkL: 0.33,
    borderStrongDarkL: 0.44,
    semanticLightStart: 0.56,
    semanticDarkStart: 0.66,
    semanticTarget: 4.5,
  },
  muted: {
    chroma: 0.72,
    bgTintFactor: 0.04,
    bgTintMax: 0.005,
    minTint: 0.002,
    bgLightL: 0.97,
    bgDarkL: 0.218,
    surfaceLightL: 0.988,
    surfaceDarkL: 0.25,
    raisedLightL: 0.998,
    raisedDarkL: 0.3,
    textLightL: 0.3,
    textDarkL: 0.9,
    textTarget: 7,
    secondaryTextLightL: 0.48,
    secondaryTextDarkL: 0.7,
    secondaryTextTarget: 4.8,
    disabledLightL: 0.66,
    disabledDarkL: 0.55,
    disabledTarget: 2.8,
    borderLightL: 0.895,
    borderStrongLightL: 0.74,
    borderDarkL: 0.35,
    borderStrongDarkL: 0.47,
    semanticLightStart: 0.55,
    semanticDarkStart: 0.64,
    semanticTarget: 4.5,
  },
  neutral: {
    chroma: 0.85,
    bgTintFactor: 0.008,
    bgTintMax: 0.0016,
    minTint: 0.001,
    bgLightL: 0.985,
    bgDarkL: 0.2,
    surfaceLightL: 0.997,
    surfaceDarkL: 0.238,
    raisedLightL: 1,
    raisedDarkL: 0.285,
    textLightL: 0.26,
    textDarkL: 0.93,
    textTarget: 7,
    secondaryTextLightL: 0.45,
    secondaryTextDarkL: 0.72,
    secondaryTextTarget: 4.8,
    disabledLightL: 0.63,
    disabledDarkL: 0.52,
    disabledTarget: 2.8,
    borderLightL: 0.9,
    borderStrongLightL: 0.74,
    borderDarkL: 0.33,
    borderStrongDarkL: 0.44,
    semanticLightStart: 0.55,
    semanticDarkStart: 0.66,
    semanticTarget: 4.5,
  },
  'high-contrast': {
    chroma: 1,
    bgTintFactor: 0.02,
    bgTintMax: 0.004,
    minTint: 0.0015,
    bgLightL: 0.995,
    bgDarkL: 0.14,
    surfaceLightL: 1,
    surfaceDarkL: 0.175,
    raisedLightL: 1,
    raisedDarkL: 0.215,
    textLightL: 0.12,
    textDarkL: 0.985,
    textTarget: 12,
    secondaryTextLightL: 0.32,
    secondaryTextDarkL: 0.82,
    secondaryTextTarget: 7,
    disabledLightL: 0.55,
    disabledDarkL: 0.5,
    disabledTarget: 2.8,
    borderLightL: 0.76,
    borderStrongLightL: 0.52,
    borderDarkL: 0.4,
    borderStrongDarkL: 0.58,
    semanticLightStart: 0.5,
    semanticDarkStart: 0.7,
    semanticTarget: 7,
  },
}

/** 语义 token 的中文名与说明（键与 THEME_TOKEN_KEYS 一一对应） */
const TOKEN_META: Record<string, { label: string; description: string }> = {
  primary: { label: '主色', description: '品牌主色，用于主要按钮与强调操作' },
  'primary-hover': { label: '主色悬停', description: '鼠标悬停时的主色，明度略微偏移' },
  'primary-active': { label: '主色按下', description: '按下状态的主色，反馈更明显' },
  'on-primary': { label: '主色前景', description: '主色上的文字与图标颜色，保证可读性' },
  secondary: { label: '辅助色', description: '辅助品牌色，用于次要强调与头像等' },
  accent: { label: '强调色', description: '与主色形成对比的点缀色' },
  background: { label: '页面背景', description: '页面最底层的背景色' },
  surface: { label: '表面', description: '卡片、输入框等容器的背景色' },
  'surface-raised': { label: '浮起表面', description: '弹层、菜单等更高层级的表面' },
  border: { label: '边框', description: '常规分隔线与边框颜色' },
  'border-strong': { label: '强边框', description: '需要强调的输入框、选中态边框' },
  'text-primary': { label: '正文字色', description: '标题与正文的主文字颜色' },
  'text-secondary': { label: '次要文字', description: '辅助说明文字的颜色' },
  'text-disabled': { label: '禁用文字', description: '禁用态文字的颜色' },
  success: { label: '成功', description: '成功状态的颜色' },
  warning: { label: '警告', description: '警告状态的颜色' },
  error: { label: '错误', description: '错误状态的颜色' },
  info: { label: '信息', description: '提示与信息状态的颜色' },
}

/**
 * 生成语义 token（light / dark 两套）与 8 组色阶。
 *
 * 关键策略：
 * - 浅色背景接近白色但带极轻微主色色相；深色背景为深灰蓝（不是纯黑）；
 * - `text-primary` 对背景对比度 ≥ 7:1（高对比方式目标 12:1），`on-primary` 对主色 ≥ 4.5:1；
 * - 主色尽量忠实于用户输入；仅当深色模式下主色过暗、会“隐形”时自动提亮；
 * - `primary-hover/active` 永远朝提高 on-primary 对比度的方向偏移，状态切换后文字依旧清晰。
 */
export function generateSemanticTheme(baseHex: string, method: ThemeMethodId = 'balanced'): GeneratedTheme {
  const config = METHOD_CONFIG[method] ?? METHOD_CONFIG.balanced
  const normalized = normalizeHex(baseHex) ?? '#4F7CFF'
  const base = seedOf(normalized)
  const grayBase = isGrayish(base.c)
  const hue = grayBase ? 250 : base.h
  const chroma = clamp(base.c * config.chroma, 0, 0.36)

  // ---- 背景与表面：对主色有极轻微色偏 ----
  const tint = (factor: number, max: number): number =>
    Math.min(Math.max(chroma * factor, config.minTint), max)
  const backgroundLight = oklchToHex({
    l: config.bgLightL,
    c: tint(config.bgTintFactor, config.bgTintMax),
    h: hue,
  })
  const backgroundDark = oklchToHex({
    l: config.bgDarkL,
    c: tint(config.bgTintFactor * 1.7, config.bgTintMax * 1.5),
    h: hue,
  })
  const surfaceLight = oklchToHex({
    l: config.surfaceLightL,
    c: tint(config.bgTintFactor * 0.7, config.bgTintMax),
    h: hue,
  })
  const surfaceDark = oklchToHex({
    l: config.surfaceDarkL,
    c: tint(config.bgTintFactor * 1.9, config.bgTintMax * 1.6),
    h: hue,
  })
  const raisedLight = oklchToHex({
    l: config.raisedLightL,
    c: tint(config.bgTintFactor * 0.6, config.bgTintMax),
    h: hue,
  })
  const raisedDark = oklchToHex({
    l: config.raisedDarkL,
    c: tint(config.bgTintFactor * 2.2, config.bgTintMax * 1.8),
    h: hue,
  })

  // ---- 文字：按对比度目标自动寻找合适明度 ----
  const textSeed = (lightness: number, chromaFactor: number, chromaMax: number): Seed => ({
    l: lightness,
    c: Math.min(chroma * chromaFactor, chromaMax),
    h: hue,
  })
  const textPrimaryLight = certifyOnBackground(
    textSeed(config.textLightL, 0.22, 0.03),
    backgroundLight,
    config.textTarget,
    -1,
  )
  const textPrimaryDark = certifyOnBackground(
    textSeed(config.textDarkL, 0.12, 0.024),
    backgroundDark,
    config.textTarget,
    +1,
  )
  const textSecondaryLight = certifyOnBackground(
    textSeed(config.secondaryTextLightL, 0.16, 0.026),
    backgroundLight,
    config.secondaryTextTarget,
    -1,
  )
  const textSecondaryDark = certifyOnBackground(
    textSeed(config.secondaryTextDarkL, 0.1, 0.022),
    backgroundDark,
    config.secondaryTextTarget,
    +1,
  )
  const textDisabledLight = certifyOnBackground(
    textSeed(config.disabledLightL, 0.1, 0.02),
    backgroundLight,
    config.disabledTarget,
    -1,
  )
  const textDisabledDark = certifyOnBackground(
    textSeed(config.disabledDarkL, 0.08, 0.018),
    backgroundDark,
    config.disabledTarget,
    +1,
  )

  // ---- 主色：浅色模式忠实输入；深色模式过暗时提亮，避免按钮“隐形” ----
  const primaryLightSeed: Seed = { l: base.l, c: chroma, h: base.h }
  let primaryDarkSeed: Seed = { l: base.l, c: chroma, h: base.h }
  let darkGuard = 0
  while (contrastRatio(fromSeed(primaryDarkSeed), backgroundDark) < 2.2 && darkGuard < 40) {
    primaryDarkSeed = { ...primaryDarkSeed, l: clamp(primaryDarkSeed.l + 0.025, 0.02, 0.94) }
    darkGuard += 1
  }
  const primaryLight = fromSeed(primaryLightSeed)
  const primaryDark = fromSeed(primaryDarkSeed)

  // ---- on-primary 与交互状态：状态色始终提升文字对比度 ----
  const onPrimaryLight = pickOnPrimary(primaryLight)
  const onPrimaryDark = pickOnPrimary(primaryDark)
  const hoverStep = method === 'high-contrast' ? 0.06 : 0.05
  const activeStep = method === 'high-contrast' ? 0.12 : 0.1
  const lightDirection = stateDirection(hexToOklch(primaryLight).l, onPrimaryLight)
  const darkDirection = stateDirection(hexToOklch(primaryDark).l, onPrimaryDark)
  const primaryHoverLight = nudgeLightness(primaryLight, lightDirection * hoverStep)
  let primaryActiveLight = nudgeLightness(primaryLight, lightDirection * activeStep)
  if (primaryActiveLight === primaryHoverLight) {
    primaryActiveLight = nudgeLightness(primaryHoverLight, lightDirection * activeStep)
  }
  const primaryHoverDark = nudgeLightness(primaryDark, darkDirection * hoverStep)
  let primaryActiveDark = nudgeLightness(primaryDark, darkDirection * activeStep)
  if (primaryActiveDark === primaryHoverDark) {
    primaryActiveDark = nudgeLightness(primaryHoverDark, darkDirection * activeStep)
  }

  // ---- 辅助色：与主色同色系错位，并保证 on-primary 在头像等场景仍可读 ----
  const primaryDarkLightness = hexToOklch(primaryDark).l
  const secondarySeedLight: Seed = grayBase
    ? { l: clamp(base.l + 0.24, 0.32, 0.82), c: 0, h: hue }
    : { l: clamp(base.l - 0.05, 0.5, 0.68), c: chroma * 0.85, h: base.h + 32 }
  const secondarySeedDark: Seed = grayBase
    ? { l: clamp(primaryDarkLightness - 0.16, 0.22, 0.62), c: 0, h: hue }
    : { l: clamp(primaryDarkLightness + 0.06, 0.56, 0.8), c: chroma * 0.85, h: base.h + 32 }
  const secondaryLight = certifyAgainstForeground(secondarySeedLight, onPrimaryLight)
  const secondaryDark = certifyAgainstForeground(secondarySeedDark, onPrimaryDark)

  // ---- 强调色：与主色互补的色相，明度取在中亮区间以保证有存在感 ----
  const accentLight = fromSeed(
    grayBase
      ? { l: clamp(base.l - 0.24, 0.2, 0.62), c: 0, h: hue }
      : { l: 0.7, c: chroma * 1.02, h: base.h + 180 },
  )
  const accentDark = fromSeed(
    grayBase
      ? { l: clamp(primaryDarkLightness + 0.22, 0.4, 0.88), c: 0, h: hue }
      : { l: 0.78, c: chroma * 1.02, h: base.h + 180 },
  )

  // ---- 边框：与背景保持“看得见但不抢眼”的弱对比 ----
  const structuralTint = clamp(
    Math.max(chroma * 0.06, grayBase ? config.minTint : 0),
    0,
    0.012,
  )
  const borderLight = oklchToHex({ l: config.borderLightL, c: structuralTint, h: hue })
  const borderStrongLight = oklchToHex({
    l: config.borderStrongLightL,
    c: structuralTint * 1.2,
    h: hue,
  })
  const borderDark = oklchToHex({ l: config.borderDarkL, c: structuralTint * 1.4, h: hue })
  const borderStrongDark = oklchToHex({
    l: config.borderStrongDarkL,
    c: structuralTint * 1.4,
    h: hue,
  })

  // ---- 语义色：固定色相，按背景对比度自动选明度 ----
  const semanticChroma = (value: number): number => clamp(value * Math.sqrt(config.chroma), 0, 0.32)
  const semanticColor = (semanticHue: number, chromaBase: number, mode: 'light' | 'dark'): string => {
    const background = mode === 'light' ? backgroundLight : backgroundDark
    const chromaValue = semanticChroma(chromaBase)
    let lightness = mode === 'light' ? config.semanticLightStart : config.semanticDarkStart
    let hex = oklchToHex({ l: lightness, c: chromaValue, h: semanticHue })
    let guard = 0
    while (contrastRatio(hex, background) < config.semanticTarget && guard < 80) {
      lightness = clamp(lightness + (mode === 'light' ? -0.015 : 0.015), 0.18, 0.93)
      hex = oklchToHex({ l: lightness, c: chromaValue, h: semanticHue })
      guard += 1
      if ((mode === 'light' && lightness <= 0.18) || (mode === 'dark' && lightness >= 0.93)) break
    }
    if (contrastRatio(hex, background) >= config.semanticTarget) return hex
    return contrastRatio('#000000', background) >= contrastRatio('#FFFFFF', background)
      ? '#000000'
      : '#FFFFFF'
  }

  // ---- 组装 token（顺序严格跟随 THEME_TOKEN_KEYS） ----
  const tokenValues: Record<string, { light: string; dark: string }> = {
    primary: { light: primaryLight, dark: primaryDark },
    'primary-hover': { light: primaryHoverLight, dark: primaryHoverDark },
    'primary-active': { light: primaryActiveLight, dark: primaryActiveDark },
    'on-primary': { light: onPrimaryLight, dark: onPrimaryDark },
    secondary: { light: secondaryLight, dark: secondaryDark },
    accent: { light: accentLight, dark: accentDark },
    background: { light: backgroundLight, dark: backgroundDark },
    surface: { light: surfaceLight, dark: surfaceDark },
    'surface-raised': { light: raisedLight, dark: raisedDark },
    border: { light: borderLight, dark: borderDark },
    'border-strong': { light: borderStrongLight, dark: borderStrongDark },
    'text-primary': { light: textPrimaryLight, dark: textPrimaryDark },
    'text-secondary': { light: textSecondaryLight, dark: textSecondaryDark },
    'text-disabled': { light: textDisabledLight, dark: textDisabledDark },
    success: { light: semanticColor(152, 0.155, 'light'), dark: semanticColor(152, 0.155, 'dark') },
    warning: { light: semanticColor(72, 0.16, 'light'), dark: semanticColor(72, 0.16, 'dark') },
    error: { light: semanticColor(27, 0.185, 'light'), dark: semanticColor(27, 0.185, 'dark') },
    info: { light: semanticColor(250, 0.15, 'light'), dark: semanticColor(250, 0.15, 'dark') },
  }

  const tokens: ThemeToken[] = THEME_TOKEN_KEYS.map((key) => {
    const value = tokenValues[key]
    const meta = TOKEN_META[key]
    return {
      key,
      label: meta.label,
      light: value.light,
      dark: value.dark,
      description: meta.description,
    }
  })

  return {
    baseColor: normalized,
    method,
    tokens,
    scales: generateScales(normalized),
    createdAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// 推荐色板
// ---------------------------------------------------------------------------

/**
 * 一键推荐整套色板（12~18 个颜色）：
 * 主色及其关键明暗阶、辅助色、强调色、语义色，以及中性背景 / 表面 / 文字 / 边框。
 * 名称全部为中文，可直接用于项目色板展示。
 */
export function suggestPalette(baseHex: string): PaletteColor[] {
  const normalized = normalizeHex(baseHex) ?? '#4F7CFF'
  const theme = generateSemanticTheme(normalized, 'balanced')
  const primaryScale = theme.scales.find((scale) => scale.key === 'primary')
  const tokenLight = (key: string): string =>
    theme.tokens.find((token) => token.key === key)?.light ?? normalized
  const scaleLight = (step: number): string => primaryScale?.light[String(step)] ?? normalized

  const items: Array<{ hex: string; name: string; source: PaletteColor['source'] }> = [
    { hex: normalized, name: '主色', source: 'harmony' },
    { hex: scaleLight(100), name: '主色 100', source: 'scale' },
    { hex: scaleLight(300), name: '主色 300', source: 'scale' },
    { hex: scaleLight(500), name: '主色 500', source: 'scale' },
    { hex: scaleLight(700), name: '主色 700', source: 'scale' },
    { hex: scaleLight(900), name: '主色 900', source: 'scale' },
    { hex: tokenLight('secondary'), name: '辅助色', source: 'theme' },
    { hex: tokenLight('accent'), name: '强调色', source: 'theme' },
    { hex: tokenLight('success'), name: '成功', source: 'theme' },
    { hex: tokenLight('warning'), name: '警告', source: 'theme' },
    { hex: tokenLight('error'), name: '错误', source: 'theme' },
    { hex: tokenLight('info'), name: '信息', source: 'theme' },
    { hex: tokenLight('background'), name: '页面背景', source: 'theme' },
    { hex: tokenLight('surface'), name: '卡片表面', source: 'theme' },
    { hex: tokenLight('text-primary'), name: '正文字色', source: 'theme' },
    { hex: tokenLight('text-secondary'), name: '次要文字', source: 'theme' },
    { hex: tokenLight('border'), name: '边框', source: 'theme' },
  ]
  return items.map((item) => createPaletteColor(item.hex, item.name, item.source))
}

// ---------------------------------------------------------------------------
// 重新生成时合并锁定颜色
// ---------------------------------------------------------------------------

/**
 * 重新生成配色时合并色板：保留 existing 中 locked=true 的颜色（放最前），
 * 其余位置填入 generated 中未与锁定色重复的颜色。不修改入参，返回全新数组。
 */
export function mergeGeneratedPalette(
  existing: PaletteColor[],
  generated: PaletteColor[],
): PaletteColor[] {
  const locked = existing.filter((color) => color && color.locked)
  const usedHex = new Set<string>()
  const usedIds = new Set<string>()
  const merged: PaletteColor[] = []

  for (const color of locked) {
    const hex = normalizeHex(color.hex) ?? '#808080'
    const copy: PaletteColor = { ...color, hex }
    merged.push(copy)
    usedHex.add(hex)
    if (copy.id) usedIds.add(copy.id)
  }

  for (const color of generated) {
    if (!color) continue
    const hex = normalizeHex(color.hex) ?? '#808080'
    if (usedHex.has(hex)) continue
    // generated 自身也去重，避免出现同名同色的重复项
    if (color.id && usedIds.has(color.id)) continue
    merged.push({ ...color, hex })
    usedHex.add(hex)
    if (color.id) usedIds.add(color.id)
  }

  return merged
}
