/**
 * 配色工坊 — 控件配色定义
 *
 * 控件 id / part id 是 UI 预览与导出共用的稳定标识，必须与
 * docs/CONTRACT_CORE.md「二、src/core/controls.ts」中的表格逐字一致，请勿随意改动。
 *
 * - 纯数据 + 纯函数，不依赖 React / DOM / 第三方库。
 * - 默认配色全部使用语义 token 引用（kind: 'token'），便于随主题明暗自动切换。
 */
import type { ControlStyles, GeneratedTheme } from '../shared/types'

/** 控件分类 */
export type ControlCategory = 'input' | 'display' | 'navigation' | 'feedback' | 'container'

/** 控件的一个可配置属性（如「背景」「文字」「边框」） */
export interface ControlPart {
  id: string
  /** 中文属性名，如「背景」「文字」「边框」 */
  label: string
  /** 可选说明，如「默认状态下的填充色」 */
  hint?: string
}

/** 单个控件的定义 */
export interface ControlDefinition {
  id: string
  /** 中文控件名，如「按钮」 */
  name: string
  /** 一句话说明 */
  description: string
  category: ControlCategory
  parts: ControlPart[]
}

/** 分类清单（顺序固定，供 UI 分组展示使用） */
export const CONTROL_CATEGORIES: { id: ControlCategory; label: string }[] = [
  { id: 'input', label: '表单输入' },
  { id: 'display', label: '展示' },
  { id: 'navigation', label: '导航' },
  { id: 'feedback', label: '反馈' },
  { id: 'container', label: '容器' },
]

/**
 * 24 个控件的定义（顺序固定，与契约表格一致）。
 * parts 的顺序即 UI 与导出中的属性展示顺序。
 */
export const CONTROL_DEFS: ControlDefinition[] = [
  {
    id: 'button',
    name: '按钮',
    description: '触发操作的主要交互元素',
    category: 'input',
    parts: [
      { id: 'bg', label: '背景', hint: '默认状态下的填充色' },
      { id: 'text', label: '文字', hint: '按钮文案颜色' },
      { id: 'border', label: '边框', hint: '描边颜色' },
    ],
  },
  {
    id: 'input',
    name: '输入框',
    description: '单行文本输入控件',
    category: 'input',
    parts: [
      { id: 'bg', label: '背景', hint: '输入区域填充色' },
      { id: 'text', label: '文字', hint: '输入文字颜色' },
      { id: 'border', label: '边框', hint: '描边颜色' },
      { id: 'placeholder', label: '占位文字', hint: '未输入时的提示文字颜色' },
    ],
  },
  {
    id: 'textarea',
    name: '文本域',
    description: '多行文本输入控件',
    category: 'input',
    parts: [
      { id: 'bg', label: '背景', hint: '输入区域填充色' },
      { id: 'text', label: '文字', hint: '输入文字颜色' },
      { id: 'border', label: '边框', hint: '描边颜色' },
      { id: 'placeholder', label: '占位文字', hint: '未输入时的提示文字颜色' },
    ],
  },
  {
    id: 'select',
    name: '下拉选择',
    description: '从选项列表中选择一项',
    category: 'input',
    parts: [
      { id: 'bg', label: '背景', hint: '选择器填充色' },
      { id: 'text', label: '文字', hint: '选中项文字颜色' },
      { id: 'border', label: '边框', hint: '描边颜色' },
    ],
  },
  {
    id: 'checkbox',
    name: '复选框',
    description: '多选场景下的勾选控件',
    category: 'input',
    parts: [
      { id: 'bg', label: '选中背景', hint: '选中后的填充色' },
      { id: 'border', label: '边框', hint: '未选中时的描边颜色' },
      { id: 'check', label: '勾选符号', hint: '对勾图标的颜色' },
    ],
  },
  {
    id: 'radio',
    name: '单选框',
    description: '单选场景下的圆点选择控件',
    category: 'input',
    parts: [
      { id: 'bg', label: '选中背景', hint: '选中后的填充色' },
      { id: 'border', label: '边框', hint: '未选中时的描边颜色' },
      { id: 'dot', label: '选中圆点', hint: '圆点标记的颜色' },
    ],
  },
  {
    id: 'switch',
    name: '开关',
    description: '表示开启 / 关闭状态的切换控件',
    category: 'input',
    parts: [
      { id: 'track', label: '轨道', hint: '开关底槽的颜色' },
      { id: 'thumb', label: '滑块', hint: '可拖动小圆点的颜色' },
    ],
  },
  {
    id: 'slider',
    name: '滑块',
    description: '在数值区间内拖动取值',
    category: 'input',
    parts: [
      { id: 'track', label: '轨道', hint: '未选区的轨道颜色' },
      { id: 'fill', label: '已选进度', hint: '已选择区间的填充色' },
      { id: 'thumb', label: '滑块', hint: '拖动按钮的颜色' },
    ],
  },
  {
    id: 'upload',
    name: '上传',
    description: '拖拽或点击上传文件的区域',
    category: 'input',
    parts: [
      { id: 'bg', label: '背景', hint: '上传区域填充色' },
      { id: 'border', label: '虚线边框', hint: '虚线描边颜色' },
      { id: 'text', label: '文字', hint: '提示文字颜色' },
    ],
  },
  {
    id: 'datepicker',
    name: '日期选择',
    description: '选择日期或日期区间的面板',
    category: 'input',
    parts: [
      { id: 'bg', label: '背景', hint: '面板填充色' },
      { id: 'text', label: '文字', hint: '日期文字颜色' },
      { id: 'border', label: '边框', hint: '面板描边颜色' },
      { id: 'selectedBg', label: '选中背景', hint: '选中日期的背景色' },
      { id: 'selectedText', label: '选中文字', hint: '选中日期的文字颜色' },
    ],
  },
  {
    id: 'card',
    name: '卡片',
    description: '承载信息的独立内容块',
    category: 'container',
    parts: [
      { id: 'bg', label: '背景', hint: '卡片填充色' },
      { id: 'title', label: '标题', hint: '标题文字颜色' },
      { id: 'text', label: '正文', hint: '正文文字颜色' },
      { id: 'border', label: '边框', hint: '卡片描边颜色' },
    ],
  },
  {
    id: 'table',
    name: '表格',
    description: '以行列展示结构化数据',
    category: 'display',
    parts: [
      { id: 'bg', label: '背景', hint: '表格填充色' },
      { id: 'headerBg', label: '表头背景', hint: '表头行的填充色' },
      { id: 'text', label: '文字', hint: '单元格文字颜色' },
      { id: 'border', label: '边框', hint: '分割线颜色' },
    ],
  },
  {
    id: 'tag',
    name: '标签',
    description: '标记分类或状态的轻量元素',
    category: 'display',
    parts: [
      { id: 'bg', label: '背景', hint: '标签填充色' },
      { id: 'text', label: '文字', hint: '标签文字颜色' },
      { id: 'border', label: '边框', hint: '标签描边颜色' },
    ],
  },
  {
    id: 'badge',
    name: '徽章',
    description: '展示数量或状态的小圆点标记',
    category: 'display',
    parts: [
      { id: 'bg', label: '背景', hint: '徽章填充色' },
      { id: 'text', label: '文字', hint: '徽章文字颜色' },
    ],
  },
  {
    id: 'avatar',
    name: '头像',
    description: '展示用户或对象形象的圆形区域',
    category: 'display',
    parts: [
      { id: 'bg', label: '背景', hint: '头像底色' },
      { id: 'text', label: '文字', hint: '首字母 / 文字颜色' },
    ],
  },
  {
    id: 'progress',
    name: '进度条',
    description: '展示任务完成进度',
    category: 'display',
    parts: [
      { id: 'track', label: '轨道', hint: '未完成部分的轨道颜色' },
      { id: 'bar', label: '进度', hint: '已完成部分的填充色' },
    ],
  },
  {
    id: 'nav',
    name: '导航栏',
    description: '页面顶部的全局导航容器',
    category: 'navigation',
    parts: [
      { id: 'bg', label: '背景', hint: '导航栏填充色' },
      { id: 'text', label: '文字', hint: '普通导航项文字颜色' },
      { id: 'activeBg', label: '选中背景', hint: '当前导航项的背景色' },
      { id: 'activeText', label: '选中文字', hint: '当前导航项的文字颜色' },
    ],
  },
  {
    id: 'tabs',
    name: '标签页',
    description: '在同一区域内切换多个视图',
    category: 'navigation',
    parts: [
      { id: 'bg', label: '背景', hint: '标签页容器填充色' },
      { id: 'text', label: '文字', hint: '普通标签文字颜色' },
      { id: 'indicator', label: '指示条', hint: '当前标签的指示条颜色' },
      { id: 'activeText', label: '选中文字', hint: '当前标签的文字颜色' },
    ],
  },
  {
    id: 'breadcrumb',
    name: '面包屑',
    description: '展示当前页面在层级结构中的位置',
    category: 'navigation',
    parts: [
      { id: 'text', label: '文字', hint: '普通层级文字颜色' },
      { id: 'current', label: '当前页', hint: '当前页面文字颜色' },
      { id: 'separator', label: '分隔符', hint: '层级之间的分隔符颜色' },
    ],
  },
  {
    id: 'pagination',
    name: '分页',
    description: '在多个页面之间切换',
    category: 'navigation',
    parts: [
      { id: 'bg', label: '背景', hint: '页码按钮填充色' },
      { id: 'text', label: '文字', hint: '页码文字颜色' },
      { id: 'activeBg', label: '选中背景', hint: '当前页码的背景色' },
      { id: 'activeText', label: '选中文字', hint: '当前页码的文字颜色' },
    ],
  },
  {
    id: 'alert',
    name: '提示条',
    description: '在页面内强调重要提示信息',
    category: 'feedback',
    parts: [
      { id: 'bg', label: '背景', hint: '提示条填充色' },
      { id: 'text', label: '文字', hint: '提示文字颜色' },
      { id: 'border', label: '边框', hint: '提示条描边颜色' },
      { id: 'icon', label: '图标', hint: '状态图标颜色' },
    ],
  },
  {
    id: 'modal',
    name: '对话框',
    description: '浮层展示需要用户确认的内容',
    category: 'feedback',
    parts: [
      { id: 'bg', label: '背景', hint: '对话框填充色' },
      { id: 'title', label: '标题', hint: '对话框标题颜色' },
      { id: 'text', label: '正文', hint: '对话框正文颜色' },
      { id: 'border', label: '边框', hint: '对话框描边颜色' },
    ],
  },
  {
    id: 'tooltip',
    name: '气泡提示',
    description: '悬停时出现的小型文字提示',
    category: 'feedback',
    parts: [
      { id: 'bg', label: '背景', hint: '气泡填充色' },
      { id: 'text', label: '文字', hint: '气泡文字颜色' },
    ],
  },
  {
    id: 'toast',
    name: '轻提示',
    description: '操作后短暂出现的结果反馈',
    category: 'feedback',
    parts: [
      { id: 'bg', label: '背景', hint: '轻提示填充色' },
      { id: 'text', label: '文字', hint: '轻提示文字颜色' },
    ],
  },
]

/** 控件 part → 默认语义 token 的绑定表（内部使用，保证 24 个控件 / 77 个属性全部有默认值） */
const DEFAULT_TOKEN_BINDINGS: Record<string, Record<string, string>> = {
  button: { bg: 'primary', text: 'on-primary', border: 'primary' },
  input: { bg: 'surface', text: 'text-primary', border: 'border', placeholder: 'text-secondary' },
  textarea: { bg: 'surface', text: 'text-primary', border: 'border', placeholder: 'text-secondary' },
  select: { bg: 'surface', text: 'text-primary', border: 'border' },
  checkbox: { bg: 'primary', border: 'primary', check: 'on-primary' },
  radio: { bg: 'primary', border: 'primary', dot: 'on-primary' },
  switch: { track: 'border-strong', thumb: 'surface-raised' },
  slider: { track: 'border', fill: 'primary', thumb: 'primary' },
  upload: { bg: 'surface', border: 'border-strong', text: 'text-secondary' },
  datepicker: {
    bg: 'surface',
    text: 'text-primary',
    border: 'border',
    selectedBg: 'primary',
    selectedText: 'on-primary',
  },
  card: { bg: 'surface', title: 'text-primary', text: 'text-secondary', border: 'border' },
  table: { bg: 'surface', headerBg: 'surface-raised', text: 'text-primary', border: 'border' },
  tag: { bg: 'surface-raised', text: 'text-secondary', border: 'border' },
  badge: { bg: 'primary', text: 'on-primary' },
  avatar: { bg: 'secondary', text: 'on-primary' },
  progress: { track: 'border', bar: 'primary' },
  nav: { bg: 'surface', text: 'text-secondary', activeBg: 'primary', activeText: 'on-primary' },
  tabs: { bg: 'surface', text: 'text-secondary', indicator: 'primary', activeText: 'text-primary' },
  breadcrumb: { text: 'text-secondary', current: 'text-primary', separator: 'text-disabled' },
  pagination: { bg: 'surface', text: 'text-secondary', activeBg: 'primary', activeText: 'on-primary' },
  alert: { bg: 'surface-raised', text: 'text-primary', border: 'border', icon: 'info' },
  modal: { bg: 'surface', title: 'text-primary', text: 'text-secondary', border: 'border' },
  tooltip: { bg: 'text-primary', text: 'background' },
  toast: { bg: 'surface-raised', text: 'text-primary' },
}

/**
 * 生成全部控件的默认配色绑定。
 * 对 CONTROL_DEFS 中每个控件、每个 part 都给出 kind:'token' 的引用；
 * theme 为 null（项目尚未生成主题）时返回空对象 {}。
 */
export function defaultControlStyles(theme: GeneratedTheme | null): ControlStyles {
  if (!theme) return {}

  const styles: ControlStyles = {}
  for (const def of CONTROL_DEFS) {
    const bindings = DEFAULT_TOKEN_BINDINGS[def.id] ?? {}
    const style: ControlStyles[string] = {}
    for (const part of def.parts) {
      const tokenKey = bindings[part.id]
      if (!tokenKey) continue
      style[part.id] = { kind: 'token', key: tokenKey }
    }
    styles[def.id] = style
  }
  return styles
}
