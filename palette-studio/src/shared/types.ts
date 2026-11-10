/**
 * 配色工坊 — 全局数据模型（主进程与渲染进程共享）
 * 所有持久化结构都从这里出发，修改时注意保持向后兼容（见 AppData.version 与迁移逻辑）。
 */

/** 颜色展示/复制格式 */
export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch'

/** 色板中的单个颜色记录 */
export interface PaletteColor {
  id: string
  /** 用户可编辑的名称，例如「品牌主色」「天蓝 500」 */
  name: string
  /** 归一化的大写 HEX：不透明 #RRGGBB，带透明度 #RRGGBBAA */
  hex: string
  /** 备注说明 */
  note?: string
  /** 锁定后，重新生成配色方案时不会被覆盖 */
  locked?: boolean
  /** 来源，仅用于展示 */
  source?: 'manual' | 'harmony' | 'scale' | 'theme' | 'imported'
}

/** 主题生成方式 */
export type ThemeMethodId = 'balanced' | 'vivid' | 'muted' | 'neutral' | 'high-contrast'

export interface ThemeMethod {
  id: ThemeMethodId
  label: string
  description: string
}

/** 语义色 Token：浅色/深色两套值 */
export interface ThemeToken {
  /** 唯一键，例如 primary / surface / text-primary */
  key: string
  /** 中文名称，例如「主色」 */
  label: string
  /** 浅色模式下的颜色 HEX（#RRGGBB 或 #RRGGBBAA） */
  light: string
  /** 深色模式下的颜色 HEX（#RRGGBB 或 #RRGGBBAA） */
  dark: string
  description: string
}

/** 色阶：50 ~ 950 */
export interface ThemeScale {
  key: string
  label: string
  light: Record<string, string>
  dark: Record<string, string>
}

/** 由主色生成的完整语义主题 */
export interface GeneratedTheme {
  /** 生成时的主色 */
  baseColor: string
  method: ThemeMethodId
  /** 语义 token 列表 */
  tokens: ThemeToken[]
  /** 色阶列表（primary / secondary / accent / neutral / success / warning / error / info） */
  scales: ThemeScale[]
  createdAt: number
}

/** 控件配色引用：可以引用色板、主题 token 或自定义颜色 */
export type ColorRef =
  | { kind: 'hex'; value: string }
  | { kind: 'palette'; id: string }
  | { kind: 'token'; key: string }

/** 单个控件的配色：属性 id -> 颜色引用 */
export type ControlStyle = Record<string, ColorRef | undefined>

/** 控件配色绑定表：控件 id -> 属性 id -> 颜色引用 */
export type ControlStyles = Record<string, ControlStyle>

/** 项目快照（「记录」功能）：一键保存/恢复某个时刻的配色状态 */
export interface Snapshot {
  id: string
  label: string
  createdAt: number
  baseColor: string
  palette: PaletteColor[]
  theme: GeneratedTheme | null
  controlStyles: ControlStyles
}

/** 项目 */
export interface Project {
  id: string
  name: string
  description: string
  /** 主色（品牌色）HEX */
  baseColor: string
  /** 项目色板 */
  palette: PaletteColor[]
  /** 最近一次生成的语义主题 */
  theme: GeneratedTheme | null
  /** 控件配色绑定 */
  controlStyles: ControlStyles
  /** 历史记录 / 快照 */
  snapshots: Snapshot[]
  createdAt: number
  updatedAt: number
}

/** 界面预览的设备形态 */
export type PreviewDevice = 'desktop' | 'mobile'

/** 应用设置 */
export interface AppSettings {
  /** 应用界面主题 */
  theme: 'dark' | 'light'
  /** 颜色代码复制格式 */
  colorFormat: ColorFormat
  /** 默认查看的明暗模式（影响主题/控件预览） */
  previewMode: 'light' | 'dark'
  /** 界面预览的设备形态（桌面网页 / 手机） */
  previewDevice: PreviewDevice
  /** 重新生成主题时自动保存快照 */
  autoSnapshot: boolean
  /** 侧栏是否收起 */
  sidebarCollapsed: boolean
}

/** 主窗口 → 独立预览窗口同步的载荷 */
export interface PreviewPayload {
  /** 当前项目（无项目时为 null） */
  project: Project | null
  /** 预览的明暗模式 */
  mode: 'light' | 'dark'
  /** 预览设备形态 */
  device: PreviewDevice
  /** 应用界面主题（预览窗口自身的深/浅外观） */
  appTheme: 'dark' | 'light'
}

/** 持久化的完整应用数据 */
export interface AppData {
  version: number
  projects: Project[]
  activeProjectId: string | null
  settings: AppSettings
}

/** 项目工作台内的标签页 */
export type ProjectTab = 'palette' | 'theme' | 'controls' | 'contrast' | 'export' | 'history'

/** 文字复制格式 */
export type CopyStyle = 'hex' | 'rgb' | 'hsl' | 'oklch' | 'css-var'

/** 主题 token 预设键（用于默认控件绑定） */
export const THEME_TOKEN_KEYS = [
  'primary',
  'primary-hover',
  'primary-active',
  'on-primary',
  'secondary',
  'accent',
  'background',
  'surface',
  'surface-raised',
  'border',
  'border-strong',
  'text-primary',
  'text-secondary',
  'text-disabled',
  'success',
  'warning',
  'error',
  'info',
] as const

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number]
