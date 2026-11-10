import type { AppData, AppSettings, Project } from './types'
import { generateSemanticTheme, suggestPalette } from '../core/palette'
import { defaultControlStyles } from '../core/controls'

/** 当前数据版本，结构不兼容变更时 +1 并编写迁移 */
export const CURRENT_DATA_VERSION = 2

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  colorFormat: 'hex',
  previewMode: 'light',
  previewDevice: 'desktop',
  autoSnapshot: true,
  sidebarCollapsed: false,
}

const PROJECT_COLORS = ['#4F7CFF', '#7C5CFF', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6']

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 新建项目：自动生成推荐色板与语义主题 */
export function createProject(input: { name: string; description?: string; baseColor: string }): Project {
  const now = Date.now()
  const baseColor = input.baseColor.toUpperCase()
  const palette = suggestPalette(baseColor)
  const theme = generateSemanticTheme(baseColor)
  return {
    id: makeId('p'),
    name: input.name.trim() || '未命名项目',
    description: input.description?.trim() ?? '',
    baseColor,
    palette,
    theme,
    controlStyles: defaultControlStyles(theme),
    snapshots: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 首次启动的示例项目：让用户一进来就能看到完整能力 */
export function createDemoProject(): Project {
  const project = createProject({
    name: '极光蓝 · 示例项目',
    description: '示例项目：包含推荐色板、浅色/深色主题与控件配色，可直接修改或删除。',
    baseColor: '#4F7CFF',
  })
  project.snapshots = [
    {
      id: makeId('s'),
      label: '初始配色',
      createdAt: project.createdAt,
      baseColor: project.baseColor,
      palette: project.palette.map((item) => ({ ...item })),
      theme: project.theme,
      controlStyles: project.controlStyles,
    },
  ]
  return project
}

/** 初始数据 */
export function createInitialData(): AppData {
  const demo = createDemoProject()
  return {
    version: CURRENT_DATA_VERSION,
    projects: [demo],
    activeProjectId: demo.id,
    settings: { ...DEFAULT_SETTINGS },
  }
}

/** 预设品牌色（新建项目弹窗用） */
export const PRESET_BASE_COLORS = PROJECT_COLORS

/**
 * 容错：把磁盘上可能过期/不完整的数据补齐成当前结构。
 * 用于版本升级与手工编辑数据文件后的恢复。
 */
export function normalizeAppData(raw: unknown): AppData {
  const fallback = createInitialData()
  if (!raw || typeof raw !== 'object') return fallback
  const data = raw as Partial<AppData>
  if (!Array.isArray(data.projects)) return fallback

  const projects: Project[] = data.projects
    .filter((item): item is Project => Boolean(item && typeof item === 'object' && item.id && item.name))
    .map((project) => ({
      id: project.id,
      name: project.name || '未命名项目',
      description: project.description ?? '',
      baseColor: project.baseColor || '#4F7CFF',
      palette: Array.isArray(project.palette) ? project.palette : [],
      theme: project.theme ?? null,
      controlStyles: project.controlStyles ?? {},
      snapshots: Array.isArray(project.snapshots) ? project.snapshots : [],
      createdAt: project.createdAt || Date.now(),
      updatedAt: project.updatedAt || Date.now(),
    }))

  const activeProjectId =
    data.activeProjectId && projects.some((item) => item.id === data.activeProjectId)
      ? data.activeProjectId
      : projects[0]?.id ?? null

  return {
    version: CURRENT_DATA_VERSION,
    projects,
    activeProjectId,
    settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
  }
}
