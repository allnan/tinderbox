/**
 * 导出模块测试：7 种格式、明暗模式、色板 / 色阶 / 控件开关、无主题回退。
 *
 * 说明：测试使用独立的最小 GeneratedTheme 夹具（tokens 与 scales 手写），
 * 不 import palette.ts，避免与并行开发的其他模块相互阻塞。
 */
import type { GeneratedTheme, Project, ThemeScale, ThemeToken } from '../shared/types'
import { THEME_TOKEN_KEYS } from '../shared/types'
import { describe, expect, test } from './_testkit'
import { CONTROL_DEFS } from './controls'
import type { ExportFormat } from './export'
import { DEFAULT_EXPORT_OPTIONS, EXPORT_OPTIONS, exportProject } from './export'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const TOKEN_LABELS: Record<string, string> = {
  primary: '主色',
  'primary-hover': '主色悬停',
  'primary-active': '主色按下',
  'on-primary': '主色上的文字',
  secondary: '辅助色',
  accent: '强调色',
  background: '背景',
  surface: '表面',
  'surface-raised': '浮层表面',
  border: '边框',
  'border-strong': '强边框',
  'text-primary': '正文',
  'text-secondary': '次要文字',
  'text-disabled': '禁用文字',
  success: '成功',
  warning: '警告',
  error: '错误',
  info: '信息',
}

const LIGHT_COLORS: Record<string, string> = {
  primary: '#4F7CFF',
  'primary-hover': '#3A66E0',
  'primary-active': '#2F55BF',
  'on-primary': '#FFFFFF',
  secondary: '#7B61FF',
  accent: '#F59E0B',
  background: '#F8FAFF',
  surface: '#FFFFFF',
  'surface-raised': '#F1F5FD',
  border: '#D8E0F0',
  'border-strong': '#B8C4DC',
  'text-primary': '#101828',
  'text-secondary': '#475467',
  'text-disabled': '#98A2B3',
  success: '#12B76A',
  warning: '#F79009',
  error: '#F04438',
  info: '#2E90FA',
}

const DARK_COLORS: Record<string, string> = {
  primary: '#6B93FF',
  'primary-hover': '#89A9FF',
  'primary-active': '#A7BEFF',
  'on-primary': '#0B1220',
  secondary: '#9B87FF',
  accent: '#FBBF24',
  background: '#0B1220',
  surface: '#131A2A',
  'surface-raised': '#1B2335',
  border: '#2A344A',
  'border-strong': '#3C4A66',
  'text-primary': '#F2F5FA',
  'text-secondary': '#C3CCDD',
  'text-disabled': '#7A869C',
  success: '#32D583',
  warning: '#FDB022',
  error: '#F97066',
  info: '#53B1FD',
}

interface ScaleSeed {
  key: string
  label: string
  light: [string, string, string]
  dark: [string, string, string]
}

/** 色阶夹具：每套色阶只保留 50 / 500 / 950 三个档位，足够验证顺序与取值 */
const SCALE_SEEDS: ScaleSeed[] = [
  { key: 'primary', label: '主色', light: ['#F0F5FF', '#4F7CFF', '#0A1A3F'], dark: ['#101A33', '#6B93FF', '#DCE6FF'] },
  { key: 'secondary', label: '辅助色', light: ['#F3F0FF', '#7B61FF', '#221A47'], dark: ['#1A1630', '#9B87FF', '#EDE9FF'] },
  { key: 'accent', label: '强调色', light: ['#FFF7E6', '#F59E0B', '#4A2E00'], dark: ['#302208', '#FBBF24', '#FFF3D6'] },
  { key: 'neutral', label: '中性色', light: ['#F8FAFC', '#64748B', '#0F172A'], dark: ['#0B1220', '#94A3B8', '#F2F5FA'] },
  { key: 'success', label: '成功', light: ['#ECFDF3', '#12B76A', '#053B21'], dark: ['#07271A', '#32D583', '#D1FADF'] },
  { key: 'warning', label: '警告', light: ['#FFFAEB', '#F79009', '#4A2B00'], dark: ['#2C1D05', '#FDB022', '#FEF0C7'] },
  { key: 'error', label: '错误', light: ['#FEF3F2', '#F04438', '#4E1D18'], dark: ['#2C0F0C', '#F97066', '#FEE4E2'] },
  { key: 'info', label: '信息', light: ['#EFF8FF', '#2E90FA', '#0A2A4D'], dark: ['#08243D', '#53B1FD', '#D1E9FF'] },
]

function makeTheme(): GeneratedTheme {
  const tokens: ThemeToken[] = THEME_TOKEN_KEYS.map((key) => ({
    key,
    label: TOKEN_LABELS[key] ?? key,
    light: LIGHT_COLORS[key] ?? '#FFFFFF',
    dark: DARK_COLORS[key] ?? '#000000',
    description: `${TOKEN_LABELS[key] ?? key} 语义色`,
  }))
  const scales: ThemeScale[] = SCALE_SEEDS.map((seed) => ({
    key: seed.key,
    label: seed.label,
    light: { 50: seed.light[0], 500: seed.light[1], 950: seed.light[2] },
    dark: { 50: seed.dark[0], 500: seed.dark[1], 950: seed.dark[2] },
  }))
  return { baseColor: '#4F7CFF', method: 'balanced', tokens, scales, createdAt: 0 }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-export-test',
    name: '示例项目',
    description: '导出模块测试项目',
    baseColor: '#4F7CFF',
    palette: [
      { id: 'c-1', name: '品牌主色', hex: '#4F7CFF' },
      { id: 'c-2', name: '点缀橙', hex: '#FF7A00' },
    ],
    theme: makeTheme(),
    controlStyles: {},
    snapshots: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

/** 带自定义控件引用的项目：覆盖 hex / palette / token 三种引用与失效回退 */
function makeCustomControlsProject(): Project {
  return makeProject({
    controlStyles: {
      button: { bg: { kind: 'hex', value: '#123456' } },
      card: { bg: { kind: 'palette', id: 'c-2' } },
      alert: { icon: { kind: 'token', key: 'success' } },
      input: { border: { kind: 'token', key: 'missing-token' } },
    },
  })
}

function parseJson(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** 反向断言：期望输出中不出现某段内容（测试工具未提供 .not，这里自行实现） */
function expectNotContain(text: string, needle: string): void {
  if (text.includes(needle)) {
    throw new Error(`期望输出中不包含 ${needle}，但实际出现了`)
  }
}

const ALL_FORMATS: ExportFormat[] = ['css', 'scss', 'tailwind', 'tailwind4', 'tokens', 'js', 'figma']

// ---------------------------------------------------------------------------
// 导出选项
// ---------------------------------------------------------------------------

describe('export.ts 导出选项', () => {
  test('EXPORT_OPTIONS 覆盖 7 种格式且顺序固定', () => {
    expect(EXPORT_OPTIONS.length).toBe(7)
    expect(EXPORT_OPTIONS.map((option) => option.id).join(',')).toBe(
      'css,scss,tailwind,tailwind4,tokens,js,figma',
    )
  })

  test('EXPORT_OPTIONS 元信息完整', () => {
    const languages = new Set(['css', 'scss', 'json', 'js'])
    const extensions = new Set(['css', 'scss', 'js', 'json'])
    for (const option of EXPORT_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.description.length).toBeGreaterThan(0)
      expect(languages.has(option.language)).toBeTruthy()
      expect(extensions.has(option.extension)).toBeTruthy()
    }
  })

  test('DEFAULT_EXPORT_OPTIONS 默认值正确', () => {
    expect(DEFAULT_EXPORT_OPTIONS.mode).toBe('both')
    expect(DEFAULT_EXPORT_OPTIONS.includeScales).toBe(true)
    expect(DEFAULT_EXPORT_OPTIONS.includePalette).toBe(false)
    expect(DEFAULT_EXPORT_OPTIONS.includeControls).toBe(false)
    expect(DEFAULT_EXPORT_OPTIONS.prefix).toBe('color')
  })

  test('未传 options 时等价于传入默认选项', () => {
    const project = makeProject()
    expect(exportProject(project, 'css')).toBe(exportProject(project, 'css', DEFAULT_EXPORT_OPTIONS))
  })
})

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

describe('export.ts CSS 变量', () => {
  test('默认同时输出浅色与深色变量块', () => {
    const css = exportProject(makeProject(), 'css')
    expect(css).toContain('配色工坊')
    expect(css).toContain('项目：示例项目')
    expect(css).toContain('主色：#4F7CFF')
    expect(css).toContain('模式：浅色 + 深色')
    expect(css).toContain(':root {')
    expect(css).toContain(':root[data-theme="dark"] {')
    expect(css).toContain('--color-primary: #4F7CFF; /* 主色 */')
    expect(css).toContain('--color-primary: #6B93FF; /* 主色 */')
    expect(css).toContain('--color-primary-500: #4F7CFF;')
    expect(css).toContain('--color-primary-500: #6B93FF;')
  })

  test('浅色模式只输出 :root 且使用浅色值', () => {
    const css = exportProject(makeProject(), 'css', { mode: 'light' })
    expect(css).toContain(':root {')
    expectNotContain(css, 'data-theme')
    expect(css).toContain('--color-background: #F8FAFF;')
    expectNotContain(css, '#0B1220')
  })

  test('深色模式只输出一份变量且选择器用 :root', () => {
    const css = exportProject(makeProject(), 'css', { mode: 'dark' })
    expect(css).toContain(':root {')
    expectNotContain(css, 'data-theme')
    expect(css).toContain('--color-background: #0B1220;')
    expect(css).toContain('--color-text-primary: #F2F5FA;')
    expectNotContain(css, '#F8FAFF')
  })

  test('includeScales 关闭时不输出色阶变量', () => {
    const css = exportProject(makeProject(), 'css', { includeScales: false })
    expectNotContain(css, '--color-primary-500')
    expect(css).toContain('--color-primary: #4F7CFF;')
  })

  test('includePalette 控制项目色板变量', () => {
    const withoutPalette = exportProject(makeProject(), 'css')
    expectNotContain(withoutPalette, '--color-palette-')
    expectNotContain(withoutPalette, '品牌主色')

    const withPalette = exportProject(makeProject(), 'css', { includePalette: true })
    expect(withPalette).toContain('--color-palette-1: #4F7CFF; /* 品牌主色 */')
    expect(withPalette).toContain('--color-palette-2: #FF7A00; /* 点缀橙 */')
  })

  test('includeControls 输出控件变量并解析自定义引用', () => {
    const css = exportProject(makeCustomControlsProject(), 'css', {
      mode: 'light',
      includeControls: true,
    })
    expect(css).toContain('--color-control-button-bg: #123456; /* 按钮 · 背景 */')
    expect(css).toContain('--color-control-card-bg: #FF7A00; /* 卡片 · 背景 */')
    expect(css).toContain('--color-control-alert-icon: #12B76A; /* 提示条 · 图标 */')
    // 失效的 token 引用回退到默认绑定（input.border -> border token）
    expect(css).toContain('--color-control-input-border: #D8E0F0; /* 输入框 · 边框 */')
  })

  test('控件默认绑定覆盖 77 个属性，both 模式输出两套', () => {
    const light = exportProject(makeProject(), 'css', { mode: 'light', includeControls: true })
    const both = exportProject(makeProject(), 'css', { includeControls: true })
    const totalParts = CONTROL_DEFS.reduce((sum, def) => sum + def.parts.length, 0)
    expect(totalParts).toBe(77)
    expect(countOccurrences(light, '--color-control-')).toBe(totalParts)
    expect(countOccurrences(both, '--color-control-')).toBe(totalParts * 2)
  })

  test('自定义前缀生效并做规范化', () => {
    const css = exportProject(makeProject(), 'css', { mode: 'light', prefix: 'brand' })
    expect(css).toContain('--brand-primary: #4F7CFF;')
    expect(css).toContain('--brand-primary-500: #4F7CFF;')
    expectNotContain(css, '--color-primary:')

    const normalized = exportProject(makeProject(), 'css', { mode: 'light', prefix: '--my brand' })
    expect(normalized).toContain('--my-brand-primary: #4F7CFF;')
  })
})

// ---------------------------------------------------------------------------
// SCSS
// ---------------------------------------------------------------------------

describe('export.ts SCSS 变量', () => {
  test('输出 SCSS 变量与色阶变量', () => {
    const scss = exportProject(makeProject(), 'scss')
    expect(scss).toContain('// 配色工坊 · SCSS 变量')
    expect(scss).toContain('$color-primary: #4F7CFF; // 主色')
    expect(scss).toContain('$color-primary-500: #4F7CFF;')
    expect(scss).toContain('$color-primary-50: #F0F5FF;')
    expectNotContain(scss, '--color-primary')
  })

  test('both 模式输出深色变量', () => {
    const both = exportProject(makeProject(), 'scss')
    expect(both).toContain('$color-primary-dark: #6B93FF; // 主色')
    expect(both).toContain('$color-primary-500-dark: #6B93FF;')

    const light = exportProject(makeProject(), 'scss', { mode: 'light' })
    expectNotContain(light, '$color-primary-dark')
  })

  test('includePalette / includeControls 输出 SCSS 映射', () => {
    const scss = exportProject(makeProject(), 'scss', {
      mode: 'light',
      includePalette: true,
      includeControls: true,
    })
    expect(scss).toContain('$palette: (')
    expect(scss).toContain("'品牌主色': #4F7CFF,")
    expect(scss).toContain('$controls: (')
    expect(scss).toContain('button-bg: #4F7CFF, // 按钮 · 背景')
  })
})

// ---------------------------------------------------------------------------
// Tailwind v3
// ---------------------------------------------------------------------------

describe('export.ts Tailwind 配置', () => {
  test('默认输出双模式（CSS 变量引用）配置', () => {
    const config = exportProject(makeProject(), 'tailwind')
    expect(config).toContain("/** @type {import('tailwindcss').Config} */")
    expect(config).toContain('module.exports = {')
    expect(config).toContain("darkMode: 'class',")
    expect(config).toContain('theme: {')
    expect(config).toContain('extend: {')
    expect(config).toContain('colors: {')
    expect(config).toContain("DEFAULT: 'var(--color-primary)', // 主色")
    expect(config).toContain("50: 'var(--color-primary-50)',")
    expect(config).toContain("'on-primary': 'var(--color-on-primary)', // 主色上的文字")
  })

  test('单模式输出具体 HEX', () => {
    const light = exportProject(makeProject(), 'tailwind', { mode: 'light' })
    expect(light).toContain("DEFAULT: '#4F7CFF', // 主色")
    expectNotContain(light, 'var(--color-')
    expectNotContain(light, 'darkMode')

    const dark = exportProject(makeProject(), 'tailwind', { mode: 'dark' })
    expect(dark).toContain("DEFAULT: '#6B93FF', // 主色")
  })

  test('includeScales 关闭时不输出色阶', () => {
    const config = exportProject(makeProject(), 'tailwind', {
      mode: 'light',
      includeScales: false,
    })
    expectNotContain(config, '--color-primary-50')
    expectNotContain(config, '50: ')
    expect(config).toContain("primary: '#4F7CFF', // 主色")
  })

  test('includePalette / includeControls 输出对应分组', () => {
    const config = exportProject(makeProject(), 'tailwind', {
      mode: 'light',
      includePalette: true,
      includeControls: true,
    })
    expect(config).toContain('palette: {')
    expect(config).toContain("1: '#4F7CFF', // 品牌主色")
    expect(config).toContain('control: {')
    expect(config).toContain("'button-bg': '#4F7CFF', // 按钮 · 背景")
  })
})

// ---------------------------------------------------------------------------
// Tailwind v4
// ---------------------------------------------------------------------------

describe('export.ts Tailwind v4 主题', () => {
  test('输出 @import 与 @theme 指令', () => {
    const css = exportProject(makeProject(), 'tailwind4')
    expect(css).toContain('@import "tailwindcss";')
    expect(css).toContain('@theme {')
    expect(css).toContain('--color-primary: #4F7CFF; /* 主色 */')
    expect(css).toContain('--color-primary-500: #4F7CFF;')
  })

  test('both 模式输出深色覆盖块', () => {
    const css = exportProject(makeProject(), 'tailwind4')
    expect(css).toContain(':root[data-theme="dark"] {')
    expect(css).toContain('--color-primary: #6B93FF; /* 主色 */')

    const light = exportProject(makeProject(), 'tailwind4', { mode: 'light' })
    expectNotContain(light, 'data-theme')
  })

  test('includePalette / includeControls 输出变量', () => {
    const css = exportProject(makeProject(), 'tailwind4', {
      mode: 'light',
      includePalette: true,
      includeControls: true,
    })
    expect(css).toContain('--color-palette-1: #4F7CFF; /* 品牌主色 */')
    expect(css).toContain('--color-control-button-bg: #4F7CFF; /* 按钮 · 背景 */')
  })
})

// ---------------------------------------------------------------------------
// W3C Design Tokens
// ---------------------------------------------------------------------------

describe('export.ts 设计 Token JSON', () => {
  test('W3C 结构包含色阶与语义 token', () => {
    const data = parseJson(exportProject(makeProject(), 'tokens'))
    expect(data.$description).toContain('示例项目')
    expect(data.$description).toContain('#4F7CFF')
    expect(data.color.primary['500'].$value).toBe('#4F7CFF')
    expect(data.color.primary['500'].$type).toBe('color')
    expect(data.color.primary['500'].$description).toBe('主色 500')
    expect(data.semantic.primary.$value).toBe('#4F7CFF')
    expect(data.semantic.primary.$type).toBe('color')
    expect(data.semantic['on-primary'].$value).toBe('#FFFFFF')
    expect(data.semantic['text-primary'].$value).toBe('#101828')
  })

  test('both 模式通过 $extensions 附带深色值', () => {
    const data = parseJson(exportProject(makeProject(), 'tokens'))
    expect(data.semantic.primary.$extensions.paletteStudio.dark).toBe('#6B93FF')
    expect(data.color.primary['500'].$extensions.paletteStudio.dark).toBe('#6B93FF')

    const light = parseJson(exportProject(makeProject(), 'tokens', { mode: 'light' }))
    expect(light.semantic.primary.$extensions).toBe(undefined)
  })

  test('includePalette / includeControls 输出对应分组', () => {
    const data = parseJson(
      exportProject(makeProject(), 'tokens', { includePalette: true, includeControls: true }),
    )
    expect(data.palette['1'].$value).toBe('#4F7CFF')
    expect(data.palette['1'].$description).toBe('品牌主色')
    expect(data.control.button.bg.$value).toBe('#4F7CFF')
    expect(data.control.button.bg.$description).toBe('背景')
    expect(data.control.input.bg.$extensions.paletteStudio.dark).toBe('#131A2A')
  })
})

// ---------------------------------------------------------------------------
// ES Module 常量
// ---------------------------------------------------------------------------

describe('export.ts JS 常量', () => {
  test('输出 colors / scales 常量', () => {
    const js = exportProject(makeProject(), 'js', { mode: 'light' })
    expect(js).toContain('export const colors = {')
    expect(js).toContain("primary: '#4F7CFF', // 主色")
    expect(js).toContain("'on-primary': '#FFFFFF', // 主色上的文字")
    expect(js).toContain('export const scales = {')
    expect(js).toContain("    50: '#F0F5FF',")
    expect(js).toContain('} as const')
  })

  test('both 模式输出 darkColors / darkScales', () => {
    const js = exportProject(makeProject(), 'js')
    expect(js).toContain('export const colors = {')
    expect(js).toContain('export const darkColors = {')
    expect(js).toContain('export const darkScales = {')
    expect(js).toContain("primary: '#6B93FF', // 主色")
  })

  test('includePalette / includeControls 输出对应常量', () => {
    const js = exportProject(makeProject(), 'js', {
      mode: 'light',
      includePalette: true,
      includeControls: true,
    })
    expect(js).toContain('export const palette = [')
    expect(js).toContain("{ name: '品牌主色', hex: '#4F7CFF' },")
    expect(js).toContain('export const controls = {')
    expect(js).toContain("bg: '#4F7CFF', // 背景")
  })
})

// ---------------------------------------------------------------------------
// Figma 变量
// ---------------------------------------------------------------------------

describe('export.ts Figma 变量', () => {
  test('输出「颜色/主色」形式的键值表', () => {
    const map = parseJson(exportProject(makeProject(), 'figma', { mode: 'light' }))
    expect(map['颜色/主色']).toBe('#4F7CFF')
    expect(map['颜色/主色/500']).toBe('#4F7CFF')
    expect(map['颜色/主色/50']).toBe('#F0F5FF')
    expect(map['颜色/正文']).toBe('#101828')
  })

  test('both 模式按浅色 / 深色分组', () => {
    const map = parseJson(exportProject(makeProject(), 'figma'))
    expect(map['颜色/浅色/主色']).toBe('#4F7CFF')
    expect(map['颜色/深色/主色']).toBe('#6B93FF')
    expect(map['颜色/浅色/主色/500']).toBe('#4F7CFF')
    expect(map['颜色/深色/主色/500']).toBe('#6B93FF')
  })

  test('includePalette / includeControls 输出对应键', () => {
    const map = parseJson(
      exportProject(makeProject(), 'figma', {
        mode: 'light',
        includePalette: true,
        includeControls: true,
      }),
    )
    expect(map['颜色/色板/1-品牌主色']).toBe('#4F7CFF')
    expect(map['控件/按钮/背景']).toBe('#4F7CFF')
  })
})

// ---------------------------------------------------------------------------
// 无主题（project.theme === null）
// ---------------------------------------------------------------------------

describe('export.ts 无主题项目', () => {
  const bareProject = makeProject({ theme: null })

  test('CSS 只导出色板并注明未生成主题', () => {
    const css = exportProject(bareProject, 'css')
    expect(css).toContain('尚未生成主题')
    expect(css).toContain('--color-palette-1: #4F7CFF; /* 品牌主色 */')
    expect(css).toContain('--color-palette-2: #FF7A00; /* 点缀橙 */')
    expectNotContain(css, '--color-primary')
    expectNotContain(css, 'data-theme')
  })

  test('SCSS 只输出色板映射', () => {
    const scss = exportProject(bareProject, 'scss')
    expect(scss).toContain('$palette: (')
    expect(scss).toContain("'品牌主色': #4F7CFF,")
    expectNotContain(scss, '$color-primary')
  })

  test('Tailwind / Tailwind v4 只输出色板', () => {
    const tailwind = exportProject(bareProject, 'tailwind')
    expect(tailwind).toContain('module.exports = {')
    expect(tailwind).toContain('palette: {')
    expectNotContain(tailwind, 'darkMode')

    const tailwind4 = exportProject(bareProject, 'tailwind4')
    expect(tailwind4).toContain('@theme {')
    expect(tailwind4).toContain('--color-palette-1: #4F7CFF; /* 品牌主色 */')
    expectNotContain(tailwind4, '--color-primary:')
  })

  test('设计 Token / JS / Figma 只导出色板', () => {
    const tokens = parseJson(exportProject(bareProject, 'tokens'))
    expect(tokens.palette['1'].$value).toBe('#4F7CFF')
    expect(tokens.color).toBe(undefined)
    expect(tokens.semantic).toBe(undefined)

    const js = exportProject(bareProject, 'js')
    expect(js).toContain('export const palette = [')
    expectNotContain(js, 'export const colors')

    const figma = parseJson(exportProject(bareProject, 'figma'))
    expect(figma['颜色/色板/1-品牌主色']).toBe('#4F7CFF')
    expect(figma['颜色/色板/2-点缀橙']).toBe('#FF7A00')
    expect(Object.keys(figma).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 边界与一致性
// ---------------------------------------------------------------------------

describe('export.ts 边界与一致性', () => {
  test('7 种格式都能返回非空字符串', () => {
    const project = makeProject()
    for (const format of ALL_FORMATS) {
      const output = exportProject(project, format)
      expect(typeof output).toBe('string')
      expect(output.length).toBeGreaterThan(20)
    }
  })

  test('相同输入得到完全相同的输出', () => {
    const project = makeProject()
    for (const format of ALL_FORMATS) {
      expect(exportProject(project, format)).toBe(exportProject(project, format))
    }
  })

  test('mode 参数会影响所有格式的输出', () => {
    const project = makeProject()
    for (const format of ALL_FORMATS) {
      const light = exportProject(project, format, { mode: 'light' })
      const dark = exportProject(project, format, { mode: 'dark' })
      const both = exportProject(project, format, { mode: 'both' })
      expect(light === dark).toBe(false)
      expect(light === both).toBe(false)
      expect(dark === both).toBe(false)
    }
  })

  test('代码格式头部包含项目名与主色', () => {
    const project = makeProject()
    for (const format of ['css', 'scss', 'tailwind', 'tailwind4', 'js'] as ExportFormat[]) {
      const output = exportProject(project, format)
      expect(output).toContain('配色工坊')
      expect(output).toContain('示例项目')
      expect(output).toContain('#4F7CFF')
    }
  })

  test('无主题时有控件选项也不会报错', () => {
    const bare = makeProject({ theme: null })
    const css = exportProject(bare, 'css', { includeControls: true })
    expectNotContain(css, '--color-control-')
    exportProject(bare, 'js', { includeControls: true })
  })
})
