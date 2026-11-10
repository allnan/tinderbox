/**
 * 配色工坊 — 多格式导出
 *
 * 把项目主题、色板与控件配色导出为前端可直接粘贴使用的代码。
 *
 * 约定：
 * - 纯函数，不依赖 React / DOM / Node / 第三方库。
 * - 缩进统一 2 空格；除 JSON 格式外，输出顶部都带中文注释头（项目名、主色、模式）。
 * - 颜色输出大写 HEX：不透明 #RRGGBB，带透明度 #RRGGBBAA；控件配色通过 resolveColorRef 按明暗模式解析。
 * - 项目尚未生成主题（project.theme === null）时只导出项目色板，并在注释中说明。
 */
import type { GeneratedTheme, Project } from '../shared/types'
import { THEME_TOKEN_KEYS } from '../shared/types'
import { normalizeHex } from './color'
import { CONTROL_DEFS, defaultControlStyles } from './controls'
import { resolveColorRef } from './resolve'

/** 导出格式标识 */
export type ExportFormat =
  /** CSS 变量（含 :root 与 [data-theme="dark"]） */
  | 'css'
  /** SCSS 变量 + 映射 */
  | 'scss'
  /** Tailwind v3 配置对象（module.exports） */
  | 'tailwind'
  /** Tailwind v4 @theme 指令 */
  | 'tailwind4'
  /** W3C Design Tokens JSON */
  | 'tokens'
  /** ES Module 常量对象 */
  | 'js'
  /** 便于粘贴到 Figma 变量插件的 JSON（简单 key-value 颜色表） */
  | 'figma'

/** 导出格式选项（供 UI 列出可导出格式） */
export interface ExportOption {
  id: ExportFormat
  /** 中文名称，如「CSS 变量」 */
  label: string
  /** 代码高亮语言：'css' | 'scss' | 'json' | 'js' */
  language: string
  /** 建议文件名后缀：'css' | 'scss' | 'js' | 'json' */
  extension: string
  /** 一句话说明 */
  description: string
}

/** 7 种导出格式（顺序固定） */
export const EXPORT_OPTIONS: ExportOption[] = [
  {
    id: 'css',
    label: 'CSS 变量',
    language: 'css',
    extension: 'css',
    description: '输出 :root 与深色模式的 CSS 自定义属性，原生可用',
  },
  {
    id: 'scss',
    label: 'SCSS 变量',
    language: 'scss',
    extension: 'scss',
    description: '输出 SCSS 变量与色板 / 控件映射，适合 Sass 项目',
  },
  {
    id: 'tailwind',
    label: 'Tailwind 配置',
    language: 'js',
    extension: 'js',
    description: '输出 Tailwind v3 配置对象，可直接粘贴到 tailwind.config.js',
  },
  {
    id: 'tailwind4',
    label: 'Tailwind v4 主题',
    language: 'css',
    extension: 'css',
    description: '输出 @theme 指令，适用于 Tailwind CSS v4',
  },
  {
    id: 'tokens',
    label: '设计 Token',
    language: 'json',
    extension: 'json',
    description: 'W3C Design Tokens 格式，供设计系统与多端复用',
  },
  {
    id: 'js',
    label: 'JS 常量',
    language: 'js',
    extension: 'js',
    description: 'ES Module 颜色常量，适合 TS / JS 项目直接引入',
  },
  {
    id: 'figma',
    label: 'Figma 变量',
    language: 'json',
    extension: 'json',
    description: '输出简单键值颜色表，便于粘贴到 Figma 变量插件',
  },
]

/** 导出选项 */
export interface ExportOptions {
  /** 导出哪一套明暗 */
  mode: 'light' | 'dark' | 'both'
  /** 是否包含 50-950 色阶（默认 true） */
  includeScales: boolean
  /** 是否包含项目色板（默认 false） */
  includePalette: boolean
  /** 是否包含控件配色变量（默认 false） */
  includeControls: boolean
  /** CSS 变量前缀，默认 'color'，例如 --color-primary */
  prefix: string
}

/** 默认导出选项 */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  mode: 'both',
  includeScales: true,
  includePalette: false,
  includeControls: false,
  prefix: 'color',
}

const INDENT = '  '
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

type Mode = 'light' | 'dark'

/** 单个语义 token 的导出数据 */
interface TokenData {
  key: string
  label: string
  value: string
}

/** 单套色阶的导出数据 */
interface ScaleData {
  key: string
  label: string
  steps: { step: string; value: string }[]
}

/** 某一明暗模式下整理好的主题数据 */
interface ModeData {
  tokens: TokenData[]
  scales: ScaleData[]
}

/** 项目色板中的一项 */
interface PaletteData {
  index: number
  name: string
  hex: string
}

/** 解析后的单个控件属性配色 */
interface ControlData {
  controlId: string
  controlName: string
  partId: string
  partLabel: string
  value: string
}

interface ControlGroup {
  controlId: string
  controlName: string
  parts: ControlData[]
}

// ---------------------------------------------------------------------------
// 选项与通用工具
// ---------------------------------------------------------------------------

/** 规范化前缀：去掉开头的 --，非法字符转成 -，为空时回退到 color */
function normalizePrefix(prefix: string): string {
  const raw = (prefix ?? '').trim().replace(/^--+/, '')
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || DEFAULT_EXPORT_OPTIONS.prefix
}

/** 合并用户选项与默认选项 */
function resolveOptions(options?: Partial<ExportOptions>): ExportOptions {
  return {
    mode: options?.mode ?? DEFAULT_EXPORT_OPTIONS.mode,
    includeScales: options?.includeScales ?? DEFAULT_EXPORT_OPTIONS.includeScales,
    includePalette: options?.includePalette ?? DEFAULT_EXPORT_OPTIONS.includePalette,
    includeControls: options?.includeControls ?? DEFAULT_EXPORT_OPTIONS.includeControls,
    prefix: normalizePrefix(options?.prefix ?? DEFAULT_EXPORT_OPTIONS.prefix),
  }
}

/** 按导出模式列出需要处理的明暗模式 */
function selectedModes(mode: ExportOptions['mode']): Mode[] {
  return mode === 'both' ? ['light', 'dark'] : [mode]
}

/** 明暗模式的中文名 */
function modeLabel(mode: ExportOptions['mode']): string {
  if (mode === 'light') return '浅色'
  if (mode === 'dark') return '深色'
  return '浅色 + 深色'
}

/** 规范化为大写 HEX，非法时尽量保留原值 */
function safeHex(value: string | undefined): string {
  const raw = (value ?? '').trim()
  return normalizeHex(raw) ?? (raw ? raw.toUpperCase() : '#808080')
}

/** 色阶档位排序：数字档位按大小，其它按字典序 */
function compareStep(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b)
}

/** 转义为中文单行注释内容，避免换行或注释结束符破坏注释结构 */
function commentText(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim()
  return cleaned || '颜色'
}

/** JS 单引号字符串 */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** JS 对象字面量键名：合法标识符原样输出，否则加引号 */
function jsKey(key: string): string {
  return IDENTIFIER.test(key) ? key : quote(key)
}

/** JS 对象字面量键名（数字档位不加引号） */
function jsProp(key: string): string {
  return /^\d+$/.test(key) ? key : jsKey(key)
}

/** 生成带缩进的括号块，如 colors: { ... }, */
function braceLines(open: string, body: string[], close: string): string[] {
  return [open, ...body.map((line) => (line ? INDENT + line : '')), close]
}

/** 生成 /** 风格的中文注释头 */
function blockComment(lines: string[]): string {
  return ['/**', ...lines.map((line) => ` * ${line}`), ' */'].join('\n')
}

/** 生成 // 风格的中文注释头（SCSS） */
function lineComments(lines: string[]): string {
  return lines.map((line) => `// ${line}`).join('\n')
}

/** 导出文件头部注释行 */
function headerLines(
  title: string,
  project: Project,
  options: ExportOptions,
  extra: string[] = [],
): string[] {
  const lines = [
    `配色工坊 · ${title}`,
    `项目：${project.name.trim() || '未命名项目'}`,
    `主色：${safeHex(project.baseColor)}`,
    '由「配色工坊」生成，可直接粘贴到项目中使用。',
  ]
  if (project.theme) {
    lines.push(`模式：${modeLabel(options.mode)}`)
  } else {
    lines.push('说明：项目尚未生成主题，仅导出项目色板。')
  }
  lines.push(...extra)
  return lines
}

// ---------------------------------------------------------------------------
// 数据整理
// ---------------------------------------------------------------------------

/** 按 THEME_TOKEN_KEYS 的固定顺序整理某一明暗模式下的语义 token */
function collectModeData(theme: GeneratedTheme, mode: Mode, includeScales: boolean): ModeData {
  const knownKeys = THEME_TOKEN_KEYS as readonly string[]
  const extraKeys = theme.tokens
    .map((item) => item.key)
    .filter((key) => !knownKeys.includes(key))
  const orderedKeys = [...knownKeys, ...extraKeys]
  const seen = new Set<string>()
  const tokens: TokenData[] = []
  for (const key of orderedKeys) {
    if (seen.has(key)) continue
    seen.add(key)
    const token = theme.tokens.find((item) => item.key === key)
    if (!token) continue
    tokens.push({
      key,
      label: token.label || key,
      value: safeHex(mode === 'dark' ? token.dark : token.light),
    })
  }

  const scales: ScaleData[] = includeScales
    ? theme.scales
        .map((scale) => {
          const lightSteps = scale.light ?? {}
          const darkSteps = scale.dark ?? {}
          const stepKeys = Array.from(new Set([...Object.keys(lightSteps), ...Object.keys(darkSteps)]))
          stepKeys.sort(compareStep)
          const steps = stepKeys.map((step) => {
            const raw = mode === 'dark' ? darkSteps[step] ?? lightSteps[step] : lightSteps[step] ?? darkSteps[step]
            return { step, value: safeHex(raw) }
          })
          return { key: scale.key, label: scale.label || scale.key, steps }
        })
        .filter((scale) => scale.steps.length > 0)
    : []

  return { tokens, scales }
}

/** 整理项目色板 */
function collectPalette(project: Project): PaletteData[] {
  return project.palette.map((item, index) => ({
    index: index + 1,
    name: item.name.trim() || `色板 ${index + 1}`,
    hex: safeHex(item.hex),
  }))
}

/**
 * 解析项目控件配色：优先使用用户自定义引用，失效时回退到默认 token 绑定。
 * 项目没有主题时无法解析默认绑定，直接返回空数组。
 */
function collectControls(project: Project, mode: Mode): ControlData[] {
  const theme = project.theme
  if (!theme) return []

  const context = { palette: project.palette, theme, mode }
  const defaults = defaultControlStyles(theme)
  const result: ControlData[] = []
  for (const def of CONTROL_DEFS) {
    const custom = project.controlStyles[def.id] ?? {}
    const fallback = defaults[def.id] ?? {}
    for (const part of def.parts) {
      const value =
        resolveColorRef(custom[part.id], context) ?? resolveColorRef(fallback[part.id], context)
      if (!value) continue
      result.push({
        controlId: def.id,
        controlName: def.name,
        partId: part.id,
        partLabel: part.label,
        value,
      })
    }
  }
  return result
}

/** 按控件分组，保持 CONTROL_DEFS 的顺序 */
function groupControls(controls: ControlData[]): ControlGroup[] {
  const groups: ControlGroup[] = []
  for (const item of controls) {
    const existing = groups.find((group) => group.controlId === item.controlId)
    if (existing) {
      existing.parts.push(item)
    } else {
      groups.push({ controlId: item.controlId, controlName: item.controlName, parts: [item] })
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** CSS 色板变量行 */
function cssPaletteLines(palette: PaletteData[], options: ExportOptions): string[] {
  const lines = ['/* 项目色板 */']
  for (const item of palette) {
    lines.push(
      `--${options.prefix}-palette-${item.index}: ${item.hex}; /* ${commentText(item.name)} */`,
    )
  }
  return lines
}

/** CSS 控件变量行 */
function cssControlLines(controls: ControlData[], options: ExportOptions): string[] {
  const lines = ['/* 控件配色 */']
  for (const item of controls) {
    lines.push(
      `--${options.prefix}-control-${item.controlId}-${item.partId}: ${item.value}; /* ${commentText(
        item.controlName,
      )} · ${commentText(item.partLabel)} */`,
    )
  }
  return lines
}

function buildCss(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const header = blockComment(headerLines('CSS 变量', project, options))

  if (!theme) {
    const body = palette.length ? cssPaletteLines(palette, options) : ['/* 项目暂无配色数据 */']
    return `${header}\n\n${braceLines(':root {', body, '}').join('\n')}\n`
  }

  const both = options.mode === 'both'
  const blocks: string[] = []
  for (const mode of selectedModes(options.mode)) {
    const selector = both ? (mode === 'light' ? ':root' : ':root[data-theme="dark"]') : ':root'
    const body: string[] = []
    if (both && mode === 'dark') body.push('/* 深色模式 */')

    const data = collectModeData(theme, mode, options.includeScales)
    body.push('/* 语义色 */')
    for (const token of data.tokens) {
      body.push(
        `--${options.prefix}-${token.key}: ${token.value}; /* ${commentText(token.label)} */`,
      )
    }
    if (data.scales.length) {
      for (const scale of data.scales) {
        body.push('')
        body.push(`/* 色阶：${commentText(scale.label)} */`)
        for (const step of scale.steps) {
          body.push(`--${options.prefix}-${scale.key}-${step.step}: ${step.value};`)
        }
      }
    }

    const includePaletteHere =
      options.includePalette && palette.length > 0 && (!both || mode === 'light')
    if (includePaletteHere) {
      body.push('')
      body.push(...cssPaletteLines(palette, options))
    }

    if (options.includeControls) {
      const controls = collectControls(project, mode)
      if (controls.length) {
        body.push('')
        body.push(...cssControlLines(controls, options))
      }
    }

    blocks.push(braceLines(`${selector} {`, body, '}').join('\n'))
  }
  return `${header}\n\n${blocks.join('\n\n')}\n`
}

// ---------------------------------------------------------------------------
// SCSS
// ---------------------------------------------------------------------------

/** SCSS 色板映射（$palette） */
function scssPaletteBlock(palette: PaletteData[]): string {
  const used = new Set<string>()
  const lines = ['// 项目色板', '$palette: (']
  palette.forEach((item, index) => {
    let name = item.name
    if (used.has(name)) name = `${item.name} ${item.index}`
    used.add(name)
    const comma = index === palette.length - 1 ? '' : ','
    lines.push(`${INDENT}${quote(name)}: ${item.hex}${comma}`)
  })
  lines.push(');')
  return lines.join('\n')
}

/** SCSS 控件映射（$controls） */
function scssControlsBlock(controls: ControlData[], darkVariant: boolean): string {
  const title = darkVariant ? '// 控件配色（深色模式）' : '// 控件配色'
  const name = darkVariant ? '$controls-dark' : '$controls'
  const lines = [title, `${name}: (`]
  controls.forEach((item, index) => {
    const comma = index === controls.length - 1 ? '' : ','
    lines.push(
      `${INDENT}${item.controlId}-${item.partId}: ${item.value}${comma} // ${commentText(
        item.controlName,
      )} · ${commentText(item.partLabel)}`,
    )
  })
  lines.push(');')
  return lines.join('\n')
}

function buildScss(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const header = lineComments(headerLines('SCSS 变量', project, options))
  const blocks: string[] = []

  if (!theme) {
    blocks.push(palette.length ? scssPaletteBlock(palette) : '// 项目暂无配色数据')
    return `${header}\n\n${blocks.join('\n\n')}\n`
  }

  const both = options.mode === 'both'
  for (const mode of selectedModes(options.mode)) {
    const darkVariant = both && mode === 'dark'
    const suffix = darkVariant ? '-dark' : ''
    const data = collectModeData(theme, mode, options.includeScales)
    const lines: string[] = [`// ── 语义色${darkVariant ? '（深色模式）' : ''} ──`]
    for (const token of data.tokens) {
      lines.push(
        `$${options.prefix}-${token.key}${suffix}: ${token.value}; // ${commentText(token.label)}`,
      )
    }
    if (data.scales.length) {
      for (const scale of data.scales) {
        lines.push('')
        lines.push(`// 色阶：${commentText(scale.label)}${darkVariant ? '（深色模式）' : ''}`)
        for (const step of scale.steps) {
          lines.push(`$${options.prefix}-${scale.key}-${step.step}${suffix}: ${step.value};`)
        }
      }
    }
    blocks.push(lines.join('\n'))
  }

  if (options.includePalette && palette.length) blocks.push(scssPaletteBlock(palette))

  if (options.includeControls) {
    for (const mode of selectedModes(options.mode)) {
      const controls = collectControls(project, mode)
      if (controls.length) blocks.push(scssControlsBlock(controls, both && mode === 'dark'))
    }
  }

  return `${header}\n\n${blocks.join('\n\n')}\n`
}

// ---------------------------------------------------------------------------
// Tailwind CSS（v3 配置对象）
// ---------------------------------------------------------------------------

function tailwindPaletteLines(palette: PaletteData[]): string[] {
  const inner = palette.map(
    (item) => `${item.index}: ${quote(item.hex)}, // ${commentText(item.name)}`,
  )
  return ['// 项目色板', ...braceLines('palette: {', inner, '},')]
}

function tailwindControlLines(
  project: Project,
  options: ExportOptions,
  both: boolean,
): string[] {
  const mode: Mode = options.mode === 'dark' ? 'dark' : 'light'
  const controls = collectControls(project, mode)
  if (!controls.length) return []
  const inner: string[] = []
  for (const group of groupControls(controls)) {
    for (const part of group.parts) {
      const name = `${group.controlId}-${part.partId}`
      const value = both ? quote(`var(--${options.prefix}-control-${name})`) : quote(part.value)
      inner.push(
        `${jsKey(name)}: ${value}, // ${commentText(group.controlName)} · ${commentText(
          part.partLabel,
        )}`,
      )
    }
  }
  return ['// 控件配色', ...braceLines('control: {', inner, '},')]
}

function buildTailwind(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const both = options.mode === 'both'
  const extra = both
    ? ['深浅色切换说明：本配置通过 CSS 变量读取颜色，请配合「CSS 变量」导出一并使用。']
    : []
  const header = blockComment(headerLines('Tailwind CSS 配置（v3）', project, options, extra))
  const colorLines: string[] = []

  if (theme) {
    const mode: Mode = options.mode === 'dark' ? 'dark' : 'light'
    const data = collectModeData(theme, mode, options.includeScales)
    const tokenByKey = new Map(data.tokens.map((token) => [token.key, token]))
    const consumed = new Set<string>()

    const scaleLines: string[] = []
    for (const scale of data.scales) {
      const token = tokenByKey.get(scale.key)
      if (token) consumed.add(token.key)
      const inner: string[] = []
      if (token) {
        const defaultValue = both
          ? quote(`var(--${options.prefix}-${token.key})`)
          : quote(token.value)
        inner.push(`DEFAULT: ${defaultValue}, // ${commentText(token.label)}`)
      }
      for (const step of scale.steps) {
        const value = both
          ? quote(`var(--${options.prefix}-${scale.key}-${step.step})`)
          : quote(step.value)
        inner.push(`${jsProp(step.step)}: ${value},`)
      }
      scaleLines.push(`// ${commentText(scale.label)}`)
      scaleLines.push(...braceLines(`${jsKey(scale.key)}: {`, inner, '},'))
    }

    const flatTokens = data.tokens.filter((token) => !consumed.has(token.key))
    const flatLines = flatTokens.map((token) => {
      const value = both
        ? quote(`var(--${options.prefix}-${token.key})`)
        : quote(token.value)
      return `${jsKey(token.key)}: ${value}, // ${commentText(token.label)}`
    })

    if (scaleLines.length) colorLines.push('// 色阶与同名语义色', ...scaleLines)
    if (flatLines.length) {
      if (colorLines.length) colorLines.push('')
      colorLines.push('// 语义色', ...flatLines)
    }
  }

  const paletteLines =
    (options.includePalette || !theme) && palette.length ? tailwindPaletteLines(palette) : []
  if (paletteLines.length) {
    if (colorLines.length) colorLines.push('')
    colorLines.push(...paletteLines)
  }

  const controlLines =
    options.includeControls && theme ? tailwindControlLines(project, options, both) : []
  if (controlLines.length) {
    if (colorLines.length) colorLines.push('')
    colorLines.push(...controlLines)
  }

  const colorsBlock = colorLines.length ? braceLines('colors: {', colorLines, '},') : ['colors: {},']
  const themeBlock = braceLines(
    'theme: {',
    braceLines('extend: {', colorsBlock, '},'),
    '},',
  )
  const configLines: string[] = []
  if (both && theme) configLines.push(`darkMode: 'class',`)
  configLines.push(...themeBlock)

  const code = `/** @type {import('tailwindcss').Config} */\nmodule.exports = ${braceLines(
    '{',
    configLines,
    '}',
  ).join('\n')}\n`
  return `${header}\n\n${code}`
}

// ---------------------------------------------------------------------------
// Tailwind CSS（v4 @theme 指令）
// ---------------------------------------------------------------------------

function tailwind4ThemeLines(
  project: Project,
  options: ExportOptions,
  mode: Mode,
  palette: PaletteData[],
): string[] {
  const theme = project.theme
  const lines: string[] = []
  if (!theme) {
    if (palette.length) {
      lines.push('/* 项目色板 */')
      for (const item of palette) {
        lines.push(
          `--${options.prefix}-palette-${item.index}: ${item.hex}; /* ${commentText(item.name)} */`,
        )
      }
    } else {
      lines.push('/* 项目暂无配色数据 */')
    }
    return lines
  }

  const data = collectModeData(theme, mode, options.includeScales)
  lines.push('/* 语义色 */')
  for (const token of data.tokens) {
    lines.push(
      `--${options.prefix}-${token.key}: ${token.value}; /* ${commentText(token.label)} */`,
    )
  }
  if (data.scales.length) {
    for (const scale of data.scales) {
      lines.push('')
      lines.push(`/* 色阶：${commentText(scale.label)} */`)
      for (const step of scale.steps) {
        lines.push(`--${options.prefix}-${scale.key}-${step.step}: ${step.value};`)
      }
    }
  }
  if (options.includePalette && palette.length) {
    lines.push('')
    lines.push(...cssPaletteLines(palette, options))
  }
  if (options.includeControls) {
    const controls = collectControls(project, mode)
    if (controls.length) {
      lines.push('')
      lines.push(...cssControlLines(controls, options))
    }
  }
  return lines
}

function buildTailwind4(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const both = options.mode === 'both'
  const extra = both
    ? ['深色模式：在 <html> 或 :root 上设置 data-theme="dark" 即可覆盖下列变量。']
    : []
  const header = blockComment(headerLines('Tailwind CSS v4 主题', project, options, extra))

  const mainMode: Mode = options.mode === 'dark' ? 'dark' : 'light'
  const themeLines = tailwind4ThemeLines(project, options, mainMode, palette)
  let output = `${header}\n\n@import "tailwindcss";\n\n${braceLines(
    '@theme {',
    themeLines,
    '}',
  ).join('\n')}\n`

  if (both && theme) {
    const darkLines = tailwind4ThemeLines(project, options, 'dark', palette)
    output += `\n${braceLines(':root[data-theme="dark"] {', darkLines, '}').join('\n')}\n`
  }
  return output
}

// ---------------------------------------------------------------------------
// W3C Design Tokens（JSON）
// ---------------------------------------------------------------------------

function tokenNode(label: string, value: string, darkValue?: string): Record<string, unknown> {
  const node: Record<string, unknown> = { $value: value, $type: 'color', $description: label }
  if (darkValue && darkValue !== value) {
    node.$extensions = { paletteStudio: { dark: darkValue } }
  }
  return node
}

function buildTokens(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const both = options.mode === 'both'
  const name = project.name.trim() || '未命名项目'
  const baseColor = safeHex(project.baseColor)

  const data: Record<string, unknown> = {}
  data.$description = theme
    ? `由「配色工坊」生成 · 项目：${name} · 主色：${baseColor} · 模式：${modeLabel(options.mode)}`
    : `由「配色工坊」生成 · 项目：${name} · 主色：${baseColor} · 说明：项目尚未生成主题，仅导出项目色板`

  if (theme) {
    const mainMode: Mode = options.mode === 'dark' ? 'dark' : 'light'
    const mainData = collectModeData(theme, mainMode, options.includeScales)
    const darkData = both ? collectModeData(theme, 'dark', options.includeScales) : null

    if (options.includeScales && mainData.scales.length) {
      const colorGroup: Record<string, unknown> = {}
      for (const scale of mainData.scales) {
        const darkScale = darkData?.scales.find((item) => item.key === scale.key)
        const steps: Record<string, unknown> = { $description: scale.label }
        for (const step of scale.steps) {
          const darkStep = darkScale?.steps.find((item) => item.step === step.step)
          steps[step.step] = tokenNode(`${scale.label} ${step.step}`, step.value, darkStep?.value)
        }
        colorGroup[scale.key] = steps
      }
      data.color = colorGroup
    }

    const semantic: Record<string, unknown> = {}
    for (const token of mainData.tokens) {
      const darkToken = darkData?.tokens.find((item) => item.key === token.key)
      semantic[token.key] = tokenNode(token.label, token.value, darkToken?.value)
    }
    data.semantic = semantic
  }

  if ((options.includePalette || !theme) && palette.length) {
    const paletteGroup: Record<string, unknown> = {}
    for (const item of palette) {
      paletteGroup[String(item.index)] = tokenNode(item.name, item.hex)
    }
    data.palette = paletteGroup
  }

  if (options.includeControls && theme) {
    const mainMode: Mode = options.mode === 'dark' ? 'dark' : 'light'
    const mainControls = collectControls(project, mainMode)
    const darkControls = both ? collectControls(project, 'dark') : null
    if (mainControls.length) {
      const controlGroup: Record<string, unknown> = {}
      for (const group of groupControls(mainControls)) {
        const parts: Record<string, unknown> = { $description: group.controlName }
        for (const part of group.parts) {
          const darkPart = darkControls?.find(
            (item) => item.controlId === group.controlId && item.partId === part.partId,
          )
          parts[part.partId] = tokenNode(part.partLabel, part.value, darkPart?.value)
        }
        controlGroup[group.controlId] = parts
      }
      data.control = controlGroup
    }
  }

  return `${JSON.stringify(data, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// ES Module 常量
// ---------------------------------------------------------------------------

function jsSectionComment(title: string): string {
  return `/** ${title} */`
}

function jsPaletteSection(palette: PaletteData[]): string {
  const lines = [jsSectionComment('项目色板'), 'export const palette = [']
  for (const item of palette) {
    lines.push(`${INDENT}{ name: ${quote(item.name)}, hex: ${quote(item.hex)} },`)
  }
  lines.push('] as const')
  return lines.join('\n')
}

function jsColorsSection(tokens: TokenData[], variable: string, modeName: string): string {
  const lines = tokens.map(
    (token) => `${jsKey(token.key)}: ${quote(token.value)}, // ${commentText(token.label)}`,
  )
  const body = braceLines('{', lines, '} as const')
  return `${jsSectionComment(`语义色 Token（${modeName}）`)}\nexport const ${variable} = ${body.join('\n')}`
}

function jsScalesSection(scales: ScaleData[], variable: string, modeName: string): string {
  const groupLines: string[] = []
  for (const scale of scales) {
    const inner = scale.steps.map((step) => `${jsProp(step.step)}: ${quote(step.value)},`)
    groupLines.push(...braceLines(`${jsKey(scale.key)}: {`, inner, '},'))
  }
  const body = braceLines('{', groupLines, '} as const')
  return `${jsSectionComment(`色阶 50-950（${modeName}）`)}\nexport const ${variable} = ${body.join('\n')}`
}

function jsControlsSection(
  project: Project,
  mode: Mode,
  variable: string,
): string | null {
  const controls = collectControls(project, mode)
  if (!controls.length) return null
  const groupLines: string[] = []
  for (const group of groupControls(controls)) {
    const inner = group.parts.map(
      (part) => `${jsKey(part.partId)}: ${quote(part.value)}, // ${commentText(part.partLabel)}`,
    )
    groupLines.push(...braceLines(`${jsKey(group.controlId)}: {`, inner, '},'))
  }
  const body = braceLines('{', groupLines, '} as const')
  return `${jsSectionComment(`控件配色（${mode === 'dark' ? '深色' : '浅色'}）`)}\nexport const ${variable} = ${body.join('\n')}`
}

function buildJs(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const header = blockComment(headerLines('ES Module 颜色常量', project, options))
  const sections: string[] = []

  if (!theme) {
    sections.push(jsPaletteSection(palette))
    return `${header}\n\n${sections.join('\n\n')}\n`
  }

  const both = options.mode === 'both'
  const modes = selectedModes(options.mode)
  for (const mode of modes) {
    const modeName = mode === 'dark' ? '深色' : '浅色'
    const isDarkVariant = both && mode === 'dark'
    const data = collectModeData(theme, mode, options.includeScales)
    sections.push(
      jsColorsSection(data.tokens, isDarkVariant ? 'darkColors' : 'colors', modeName),
    )
    if (data.scales.length) {
      sections.push(
        jsScalesSection(data.scales, isDarkVariant ? 'darkScales' : 'scales', modeName),
      )
    }
  }

  if (options.includePalette && palette.length) sections.push(jsPaletteSection(palette))

  if (options.includeControls) {
    for (const mode of modes) {
      const isDarkVariant = both && mode === 'dark'
      const section = jsControlsSection(
        project,
        mode,
        isDarkVariant ? 'darkControls' : 'controls',
      )
      if (section) sections.push(section)
    }
  }

  return `${header}\n\n${sections.join('\n\n')}\n`
}

// ---------------------------------------------------------------------------
// Figma 变量（简单键值表）
// ---------------------------------------------------------------------------

/** Figma 变量名中的非法字符替换 */
function figmaName(text: string): string {
  const cleaned = text.replace(/\//g, '·').replace(/\s+/g, ' ').trim()
  return cleaned || '未命名'
}

/** 保证 Figma 键名唯一 */
function uniqueKey(map: Record<string, string>, base: string): string {
  if (!(base in map)) return base
  let index = 2
  while (`${base} (${index})` in map) index += 1
  return `${base} (${index})`
}

function buildFigma(project: Project, options: ExportOptions): string {
  const theme = project.theme
  const palette = collectPalette(project)
  const map: Record<string, string> = {}

  if (theme) {
    const both = options.mode === 'both'
    for (const mode of selectedModes(options.mode)) {
      const prefix = both ? (mode === 'dark' ? '深色/' : '浅色/') : ''
      const data = collectModeData(theme, mode, options.includeScales)
      for (const token of data.tokens) {
        map[uniqueKey(map, `颜色/${prefix}${figmaName(token.label || token.key)}`)] = token.value
      }
      for (const scale of data.scales) {
        for (const step of scale.steps) {
          map[
            uniqueKey(map, `颜色/${prefix}${figmaName(scale.label)}/${figmaName(step.step)}`)
          ] = step.value
        }
      }
      if (options.includeControls) {
        for (const item of collectControls(project, mode)) {
          map[
            uniqueKey(map, `控件/${prefix}${figmaName(item.controlName)}/${figmaName(item.partLabel)}`)
          ] = item.value
        }
      }
    }
  }

  if ((options.includePalette || !theme) && palette.length) {
    for (const item of palette) {
      map[uniqueKey(map, `颜色/色板/${item.index}-${figmaName(item.name)}`)] = item.hex
    }
  }

  return `${JSON.stringify(map, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

const BUILDERS: Record<ExportFormat, (project: Project, options: ExportOptions) => string> = {
  css: buildCss,
  scss: buildScss,
  tailwind: buildTailwind,
  tailwind4: buildTailwind4,
  tokens: buildTokens,
  js: buildJs,
  figma: buildFigma,
}

/**
 * 把项目导出为指定格式的代码字符串。
 *
 * @param project 项目快照
 * @param format 导出格式，见 EXPORT_OPTIONS
 * @param options 部分导出选项，未提供的项使用 DEFAULT_EXPORT_OPTIONS
 */
export function exportProject(
  project: Project,
  format: ExportFormat,
  options?: Partial<ExportOptions>,
): string {
  return BUILDERS[format](project, resolveOptions(options))
}
