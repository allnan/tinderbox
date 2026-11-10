import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type {
  AppData,
  AppSettings,
  ColorRef,
  GeneratedTheme,
  PaletteColor,
  Project,
  Snapshot,
} from '../shared/types'
import { createInitialData, createProject, makeId, normalizeAppData } from '../shared/defaults'
import { defaultControlStyles } from '../core/controls'

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
  | { type: 'replace'; data: AppData }
  | { type: 'project/create'; project: Project }
  | { type: 'project/update'; id: string; patch: Partial<Project> }
  | { type: 'project/delete'; id: string }
  | { type: 'project/duplicate'; id: string }
  | { type: 'project/setActive'; id: string | null }
  | { type: 'palette/add'; projectId: string; colors: PaletteColor[] }
  | { type: 'palette/update'; projectId: string; colorId: string; patch: Partial<PaletteColor> }
  | { type: 'palette/remove'; projectId: string; colorId: string }
  | { type: 'palette/replace'; projectId: string; colors: PaletteColor[] }
  | { type: 'theme/set'; projectId: string; theme: GeneratedTheme }
  | { type: 'control/set'; projectId: string; controlId: string; partId: string; ref: ColorRef | null }
  | { type: 'controls/replace'; projectId: string; styles: Project['controlStyles'] }
  | { type: 'snapshot/create'; projectId: string; label?: string }
  | { type: 'snapshot/restore'; projectId: string; snapshotId: string }
  | { type: 'snapshot/delete'; projectId: string; snapshotId: string }
  | { type: 'settings/update'; patch: Partial<AppSettings> }

function touch(project: Project): Project {
  return { ...project, updatedAt: Date.now() }
}

function updateProject(data: AppData, id: string, updater: (project: Project) => Project): AppData {
  return {
    ...data,
    projects: data.projects.map((project) => (project.id === id ? touch(updater(project)) : project)),
  }
}

function makeSnapshot(project: Project, label?: string): Snapshot {
  const count = project.snapshots.length + 1
  return {
    id: makeId('s'),
    label: label?.trim() || `配色快照 ${count}`,
    createdAt: Date.now(),
    baseColor: project.baseColor,
    palette: project.palette.map((item) => ({ ...item })),
    theme: project.theme,
    controlStyles: project.controlStyles,
  }
}

function reducer(data: AppData, action: Action): AppData {
  switch (action.type) {
    case 'replace':
      return action.data
    case 'project/create':
      return {
        ...data,
        projects: [action.project, ...data.projects],
        activeProjectId: action.project.id,
      }
    case 'project/update':
      return updateProject(data, action.id, (project) => ({ ...project, ...action.patch }))
    case 'project/delete': {
      const projects = data.projects.filter((project) => project.id !== action.id)
      const activeProjectId =
        data.activeProjectId === action.id ? projects[0]?.id ?? null : data.activeProjectId
      return { ...data, projects, activeProjectId }
    }
    case 'project/duplicate': {
      const source = data.projects.find((project) => project.id === action.id)
      if (!source) return data
      const now = Date.now()
      const copy: Project = {
        ...JSON.parse(JSON.stringify(source)),
        id: makeId('p'),
        name: `${source.name} 副本`,
        createdAt: now,
        updatedAt: now,
        snapshots: source.snapshots.map((item) => ({ ...item, id: makeId('s') })),
      }
      return { ...data, projects: [copy, ...data.projects], activeProjectId: copy.id }
    }
    case 'project/setActive':
      return { ...data, activeProjectId: action.id }
    case 'palette/add':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        palette: [...project.palette, ...action.colors],
      }))
    case 'palette/update':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        palette: project.palette.map((color) =>
          color.id === action.colorId ? { ...color, ...action.patch } : color,
        ),
      }))
    case 'palette/remove':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        palette: project.palette.filter((color) => color.id !== action.colorId),
        controlStyles: removePaletteRefs(project.controlStyles, action.colorId),
      }))
    case 'palette/replace':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        palette: action.colors,
      }))
    case 'theme/set':
      return updateProject(data, action.projectId, (project) => {
        const hasBindings = Object.keys(project.controlStyles ?? {}).length > 0
        return {
          ...project,
          theme: action.theme,
          controlStyles: hasBindings ? project.controlStyles : defaultControlStyles(action.theme),
        }
      })
    case 'control/set':
      return updateProject(data, action.projectId, (project) => {
        const styles = { ...(project.controlStyles ?? {}) }
        const control = { ...(styles[action.controlId] ?? {}) }
        if (action.ref) control[action.partId] = action.ref
        else delete control[action.partId]
        styles[action.controlId] = control
        return { ...project, controlStyles: styles }
      })
    case 'controls/replace':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        controlStyles: action.styles,
      }))
    case 'snapshot/create':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        snapshots: [makeSnapshot(project, action.label), ...project.snapshots].slice(0, 60),
      }))
    case 'snapshot/restore': {
      const source = data.projects
        .find((project) => project.id === action.projectId)
        ?.snapshots.find((item) => item.id === action.snapshotId)
      if (!source) return data
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        baseColor: source.baseColor,
        palette: source.palette.map((item) => ({ ...item })),
        theme: source.theme,
        controlStyles: source.controlStyles,
      }))
    }
    case 'snapshot/delete':
      return updateProject(data, action.projectId, (project) => ({
        ...project,
        snapshots: project.snapshots.filter((item) => item.id !== action.snapshotId),
      }))
    case 'settings/update':
      return { ...data, settings: { ...data.settings, ...action.patch } }
    default:
      return data
  }
}

/** 色板颜色被删除后，清理控件里指向它的引用 */
function removePaletteRefs(styles: Project['controlStyles'], colorId: string): Project['controlStyles'] {
  const next: Project['controlStyles'] = {}
  for (const [controlId, control] of Object.entries(styles ?? {})) {
    const cleaned: Record<string, ColorRef> = {}
    for (const [partId, ref] of Object.entries(control ?? {})) {
      if (ref && ref.kind === 'palette' && ref.id === colorId) continue
      if (ref) cleaned[partId] = ref
    }
    next[controlId] = cleaned
  }
  return next
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

const LOCAL_KEY = 'palette-studio:data'

async function loadFromDisk(): Promise<AppData | null> {
  if (window.desktop) {
    const result = await window.desktop.loadState()
    return result.data ? normalizeAppData(result.data) : null
  }
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    return raw ? normalizeAppData(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

async function saveToDisk(data: AppData): Promise<void> {
  if (window.desktop) {
    const result = await window.desktop.saveState(data)
    if (!result.ok) throw new Error(result.error || '保存失败')
    return
  }
  localStorage.setItem(LOCAL_KEY, JSON.stringify(data))
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AppActions {
  createProject: (input: { name: string; description?: string; baseColor: string }) => Project
  updateProject: (id: string, patch: Partial<Project>) => void
  deleteProject: (id: string) => void
  duplicateProject: (id: string) => void
  setActiveProject: (id: string | null) => void
  addPaletteColors: (projectId: string, colors: PaletteColor[]) => void
  updatePaletteColor: (projectId: string, colorId: string, patch: Partial<PaletteColor>) => void
  removePaletteColor: (projectId: string, colorId: string) => void
  replacePalette: (projectId: string, colors: PaletteColor[]) => void
  setTheme: (projectId: string, theme: GeneratedTheme) => void
  setControlColor: (projectId: string, controlId: string, partId: string, ref: ColorRef | null) => void
  replaceControlStyles: (projectId: string, styles: Project['controlStyles']) => void
  createSnapshot: (projectId: string, label?: string) => void
  restoreSnapshot: (projectId: string, snapshotId: string) => void
  deleteSnapshot: (projectId: string, snapshotId: string) => void
  updateSettings: (patch: Partial<AppSettings>) => void
  replaceData: (data: AppData) => void
}

export interface AppContextValue {
  data: AppData
  activeProject: Project | null
  ready: boolean
  saveStatus: SaveStatus
  actions: AppActions
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [data, dispatch] = useReducer(reducer, undefined as unknown as AppData, createInitialData)
  const [ready, setReady] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const dataRef = useRef(data)
  dataRef.current = data
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyRef = useRef(false)

  // 初次加载
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const loaded = await loadFromDisk()
        if (!cancelled && loaded) dispatch({ type: 'replace', data: loaded })
      } catch (err) {
        console.error('加载数据失败', err)
      } finally {
        if (!cancelled) {
          readyRef.current = true
          setReady(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 自动保存（防抖 500ms）
  useEffect(() => {
    if (!readyRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    setSaveStatus('saving')
    timerRef.current = setTimeout(() => {
      saveToDisk(dataRef.current)
        .then(() => setSaveStatus('saved'))
        .catch((err) => {
          console.error('保存数据失败', err)
          setSaveStatus('error')
        })
    }, 500)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [data])

  // 首次运行：即使没有任何修改，也把初始数据（示例项目）落盘，保证数据目录创建、下次启动一致
  const initialSaveDone = useRef(false)
  useEffect(() => {
    if (!ready || initialSaveDone.current) return
    initialSaveDone.current = true
    setSaveStatus('saving')
    saveToDisk(dataRef.current)
      .then(() => setSaveStatus('saved'))
      .catch((err) => {
        console.error('初始化数据保存失败', err)
        setSaveStatus('error')
      })
  }, [ready])

  // 关闭前尽力保存
  useEffect(() => {
    const flush = () => {
      if (readyRef.current) void saveToDisk(dataRef.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const actions = useMemo<AppActions>(
    () => ({
      createProject: (input) => {
        const project = createProject(input)
        dispatch({ type: 'project/create', project })
        return project
      },
      updateProject: (id, patch) => dispatch({ type: 'project/update', id, patch }),
      deleteProject: (id) => dispatch({ type: 'project/delete', id }),
      duplicateProject: (id) => dispatch({ type: 'project/duplicate', id }),
      setActiveProject: (id) => dispatch({ type: 'project/setActive', id }),
      addPaletteColors: (projectId, colors) => dispatch({ type: 'palette/add', projectId, colors }),
      updatePaletteColor: (projectId, colorId, patch) =>
        dispatch({ type: 'palette/update', projectId, colorId, patch }),
      removePaletteColor: (projectId, colorId) =>
        dispatch({ type: 'palette/remove', projectId, colorId }),
      replacePalette: (projectId, colors) => dispatch({ type: 'palette/replace', projectId, colors }),
      setTheme: (projectId, theme) => dispatch({ type: 'theme/set', projectId, theme }),
      setControlColor: (projectId, controlId, partId, ref) =>
        dispatch({ type: 'control/set', projectId, controlId, partId, ref }),
      replaceControlStyles: (projectId, styles) =>
        dispatch({ type: 'controls/replace', projectId, styles }),
      createSnapshot: (projectId, label) => dispatch({ type: 'snapshot/create', projectId, label }),
      restoreSnapshot: (projectId, snapshotId) =>
        dispatch({ type: 'snapshot/restore', projectId, snapshotId }),
      deleteSnapshot: (projectId, snapshotId) =>
        dispatch({ type: 'snapshot/delete', projectId, snapshotId }),
      updateSettings: (patch) => dispatch({ type: 'settings/update', patch }),
      replaceData: (next) => dispatch({ type: 'replace', data: normalizeAppData(next) }),
    }),
    [],
  )

  const activeProject = useMemo(
    () => data.projects.find((project) => project.id === data.activeProjectId) ?? null,
    [data.projects, data.activeProjectId],
  )

  const value = useMemo<AppContextValue>(
    () => ({ data, activeProject, ready, saveStatus, actions }),
    [data, activeProject, ready, saveStatus, actions],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp 必须在 AppProvider 内部使用')
  return context
}

/** 读取指定项目（找不到返回 null） */
export function useProject(projectId: string | null | undefined): Project | null {
  const { data } = useApp()
  return useMemo(
    () => (projectId ? data.projects.find((project) => project.id === projectId) ?? null : null),
    [data.projects, projectId],
  )
}

/** 让多个视图复用的复制能力 */
export function useCopyText() {
  return useCallback(async (text: string) => {
    try {
      if (window.desktop) await window.desktop.writeClipboard(text)
      else await navigator.clipboard.writeText(text)
      return true
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        return true
      } catch {
        return false
      }
    }
  }, [])
}
