/**
 * 控件定义与默认配色绑定测试。
 *
 * 契约来源：docs/CONTRACT_CORE.md「二、src/core/controls.ts」。
 * 控件 id / parts 是 UI 预览与导出共用的稳定标识，这里逐字校验，防止被意外改动。
 */
import type { GeneratedTheme } from '../shared/types'
import { THEME_TOKEN_KEYS } from '../shared/types'
import { describe, expect, test } from './_testkit'
import type { ControlCategory } from './controls'
import { CONTROL_CATEGORIES, CONTROL_DEFS, defaultControlStyles } from './controls'

/** 契约中的控件顺序 */
const EXPECTED_IDS = [
  'button',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'upload',
  'datepicker',
  'card',
  'table',
  'tag',
  'badge',
  'avatar',
  'progress',
  'nav',
  'tabs',
  'breadcrumb',
  'pagination',
  'alert',
  'modal',
  'tooltip',
  'toast',
]

/** 契约中的中文控件名 */
const EXPECTED_NAMES: Record<string, string> = {
  button: '按钮',
  input: '输入框',
  textarea: '文本域',
  select: '下拉选择',
  checkbox: '复选框',
  radio: '单选框',
  switch: '开关',
  slider: '滑块',
  upload: '上传',
  datepicker: '日期选择',
  card: '卡片',
  table: '表格',
  tag: '标签',
  badge: '徽章',
  avatar: '头像',
  progress: '进度条',
  nav: '导航栏',
  tabs: '标签页',
  breadcrumb: '面包屑',
  pagination: '分页',
  alert: '提示条',
  modal: '对话框',
  tooltip: '气泡提示',
  toast: '轻提示',
}

/** 契约中的控件分类 */
const EXPECTED_CATEGORIES: Record<string, ControlCategory> = {
  button: 'input',
  input: 'input',
  textarea: 'input',
  select: 'input',
  checkbox: 'input',
  radio: 'input',
  switch: 'input',
  slider: 'input',
  upload: 'input',
  datepicker: 'input',
  card: 'container',
  table: 'display',
  tag: 'display',
  badge: 'display',
  avatar: 'display',
  progress: 'display',
  nav: 'navigation',
  tabs: 'navigation',
  breadcrumb: 'navigation',
  pagination: 'navigation',
  alert: 'feedback',
  modal: 'feedback',
  tooltip: 'feedback',
  toast: 'feedback',
}

/** 契约中的 parts（id:中文名，按顺序拼接） */
const EXPECTED_PARTS: Record<string, string> = {
  button: 'bg:背景,text:文字,border:边框',
  input: 'bg:背景,text:文字,border:边框,placeholder:占位文字',
  textarea: 'bg:背景,text:文字,border:边框,placeholder:占位文字',
  select: 'bg:背景,text:文字,border:边框',
  checkbox: 'bg:选中背景,border:边框,check:勾选符号',
  radio: 'bg:选中背景,border:边框,dot:选中圆点',
  switch: 'track:轨道,thumb:滑块',
  slider: 'track:轨道,fill:已选进度,thumb:滑块',
  upload: 'bg:背景,border:虚线边框,text:文字',
  datepicker: 'bg:背景,text:文字,border:边框,selectedBg:选中背景,selectedText:选中文字',
  card: 'bg:背景,title:标题,text:正文,border:边框',
  table: 'bg:背景,headerBg:表头背景,text:文字,border:边框',
  tag: 'bg:背景,text:文字,border:边框',
  badge: 'bg:背景,text:文字',
  avatar: 'bg:背景,text:文字',
  progress: 'track:轨道,bar:进度',
  nav: 'bg:背景,text:文字,activeBg:选中背景,activeText:选中文字',
  tabs: 'bg:背景,text:文字,indicator:指示条,activeText:选中文字',
  breadcrumb: 'text:文字,current:当前页,separator:分隔符',
  pagination: 'bg:背景,text:文字,activeBg:选中背景,activeText:选中文字',
  alert: 'bg:背景,text:文字,border:边框,icon:图标',
  modal: 'bg:背景,title:标题,text:正文,border:边框',
  tooltip: 'bg:背景,text:文字',
  toast: 'bg:背景,text:文字',
}

/** 最小主题夹具：只需要 18 个语义 token，色阶对默认绑定无影响 */
function makeTheme(): GeneratedTheme {
  return {
    baseColor: '#4F7CFF',
    method: 'balanced',
    tokens: THEME_TOKEN_KEYS.map((key) => ({
      key,
      label: `测试-${key}`,
      light: '#4F7CFF',
      dark: '#6B93FF',
      description: `${key} 测试 token`,
    })),
    scales: [],
    createdAt: 0,
  }
}

describe('controls.ts 控件定义', () => {
  test('CONTROL_DEFS 共 24 个，id 顺序与契约一致', () => {
    expect(CONTROL_DEFS.length).toBe(24)
    expect(CONTROL_DEFS.map((def) => def.id).join(',')).toBe(EXPECTED_IDS.join(','))
  })

  test('控件中文名与契约一致且非空', () => {
    for (const def of CONTROL_DEFS) {
      expect(def.name).toBe(EXPECTED_NAMES[def.id])
      expect(def.name.length).toBeGreaterThan(0)
      expect(def.description.length).toBeGreaterThan(0)
    }
  })

  test('控件分类与契约一致', () => {
    for (const def of CONTROL_DEFS) {
      expect(def.category).toBe(EXPECTED_CATEGORIES[def.id])
    }
  })

  test('parts 的 id / 中文名 / 顺序与契约逐字一致', () => {
    for (const def of CONTROL_DEFS) {
      const signature = def.parts.map((part) => `${part.id}:${part.label}`).join(',')
      expect(signature).toBe(EXPECTED_PARTS[def.id])
    }
  })

  test('每个控件的 part 数量与 id 不重复', () => {
    for (const def of CONTROL_DEFS) {
      const ids = def.parts.map((part) => part.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.length).toBeGreaterThan(0)
    }
  })

  test('CONTROL_CATEGORIES 为 5 个分类且顺序固定', () => {
    expect(CONTROL_CATEGORIES.map((item) => item.id).join(',')).toBe(
      'input,display,navigation,feedback,container',
    )
    expect(CONTROL_CATEGORIES.map((item) => item.label).join(',')).toBe(
      '表单输入,展示,导航,反馈,容器',
    )
  })

  test('所有 part 都有非空中文名和可选提示说明', () => {
    for (const def of CONTROL_DEFS) {
      for (const part of def.parts) {
        expect(part.label.length).toBeGreaterThan(0)
        // hint 为可选字段，但本实现为每个 part 都提供了说明
        expect(part.hint).toBeDefined()
      }
    }
  })
})

describe('controls.ts 默认配色绑定', () => {
  test('theme 为 null 时返回空对象', () => {
    expect(defaultControlStyles(null)).toEqual({})
    expect(Object.keys(defaultControlStyles(null)).length).toBe(0)
  })

  test('为 24 个控件 / 77 个属性全部生成默认绑定', () => {
    const styles = defaultControlStyles(makeTheme())
    expect(Object.keys(styles).length).toBe(24)

    const totalParts = CONTROL_DEFS.reduce((sum, def) => sum + def.parts.length, 0)
    expect(totalParts).toBe(77)

    for (const def of CONTROL_DEFS) {
      const style = styles[def.id]
      expect(style).toBeDefined()
      expect(Object.keys(style).length).toBe(def.parts.length)
      for (const part of def.parts) {
        expect(style[part.id]).toBeDefined()
      }
    }
  })

  test('每个绑定都是 token 引用且 token key 存在于主题', () => {
    const theme = makeTheme()
    const validKeys = new Set(theme.tokens.map((token) => token.key))
    const styles = defaultControlStyles(theme)

    for (const def of CONTROL_DEFS) {
      for (const part of def.parts) {
        const ref = styles[def.id]?.[part.id]
        expect(ref).toBeDefined()
        if (!ref || ref.kind !== 'token') {
          throw new Error(`${def.id}.${part.id} 应为 token 引用`)
        }
        expect(validKeys.has(ref.key)).toBeTruthy()
      }
    }
  })

  test('关键默认绑定符合契约规范', () => {
    const styles = defaultControlStyles(makeTheme())
    const tokenKeys = (controlId: string): string[] =>
      Object.values(styles[controlId] ?? {})
        .filter((ref) => ref !== undefined && ref.kind === 'token')
        .map((ref) => (ref && ref.kind === 'token' ? ref.key : ''))

    expect(tokenKeys('button')).toEqual(['primary', 'on-primary', 'primary'])
    expect(tokenKeys('input')).toEqual(['surface', 'text-primary', 'border', 'text-secondary'])
    expect(tokenKeys('checkbox')).toEqual(['primary', 'primary', 'on-primary'])
    expect(tokenKeys('switch')).toEqual(['border-strong', 'surface-raised'])
    expect(tokenKeys('slider')).toEqual(['border', 'primary', 'primary'])
    expect(tokenKeys('card')).toEqual(['surface', 'text-primary', 'text-secondary', 'border'])
    expect(tokenKeys('tooltip')).toEqual(['text-primary', 'background'])
    expect(tokenKeys('toast')).toEqual(['surface-raised', 'text-primary'])
    expect(tokenKeys('datepicker')).toEqual([
      'surface',
      'text-primary',
      'border',
      'primary',
      'on-primary',
    ])
    expect(tokenKeys('alert')).toEqual(['surface-raised', 'text-primary', 'border', 'info'])
  })

  test('不会返回契约之外的控件', () => {
    const styles = defaultControlStyles(makeTheme())
    expect(Object.keys(styles).sort().join(',')).toBe([...EXPECTED_IDS].sort().join(','))
  })
})
