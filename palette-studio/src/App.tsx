import React, { useCallback, useEffect, useState } from 'react'
import { AppProvider, useApp } from './state/store'
import { ToastProvider, Icon, useToast } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { bestTextOn } from './core/color'
import { NewProjectDialog } from './components/project-dialogs'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { PreviewDrawer } from './components/PreviewDrawer'
import ProjectsView from './views/ProjectsView'
import ProjectWorkspace from './views/ProjectWorkspace'
import SettingsView from './views/SettingsView'
import type { ProjectTab } from './shared/types'

type AppView = 'projects' | 'workspace' | 'settings'

const TAB_ORDER: ProjectTab[] = ['palette', 'theme', 'controls', 'contrast', 'export', 'history']

function LoadingSplash() {
  return (
    <div className="loading-splash">
      <div className="loading-logo">
        <Icon name="palette" size={28} />
      </div>
      <div className="loading-title">配色工坊</div>
      <div className="loading-desc">正在读取配色数据…</div>
      <span className="spinner" style={{ width: 18, height: 18, marginTop: 14 }} />
    </div>
  )
}

function Shell() {
  const { data, activeProject, ready, saveStatus, actions } = useApp()
  const { toast } = useToast()
  const [view, setView] = useState<AppView>('projects')
  const [tab, setTab] = useState<ProjectTab>('palette')
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewAvailable = Boolean(activeProject?.theme)

  // 应用主题
  useEffect(() => {
    document.documentElement.dataset.appTheme = data.settings.theme
  }, [data.settings.theme])

  // 当前项目主色 → 界面强调色
  useEffect(() => {
    const root = document.documentElement
    const base = activeProject?.baseColor ?? '#4F7CFF'
    root.style.setProperty('--accent', base)
    root.style.setProperty('--accent-text', bestTextOn(base))
  }, [activeProject?.baseColor])

  // 独立预览窗口：把当前项目 / 明暗模式 / 设备形态实时推送给预览窗口
  useEffect(() => {
    window.desktop?.preview.update({
      project: activeProject,
      mode: data.settings.previewMode,
      device: data.settings.previewDevice,
      appTheme: data.settings.theme,
    })
  }, [activeProject, data.settings.previewMode, data.settings.previewDevice, data.settings.theme])

  // 预览窗口里切换明暗/设备 → 回传并更新主窗口设置（主窗口再把新状态推回去）
  useEffect(() => {
    const bridge = window.desktop?.preview
    if (!bridge) return
    const offMode = bridge.onSetMode((next) => actions.updateSettings({ previewMode: next }))
    const offDevice = bridge.onSetDevice((next) => actions.updateSettings({ previewDevice: next }))
    return () => {
      offMode?.()
      offDevice?.()
    }
  }, [actions])

  // 打开停靠式预览面板（主题页按钮 / 工作台顶部按钮都广播此事件）
  useEffect(() => {
    const handler = () => {
      if (!activeProject?.theme) {
        toast('请先生成语义主题，再查看界面预览', 'warning')
        return
      }
      setPreviewOpen(true)
    }
    window.addEventListener('app:open-preview-drawer', handler)
    return () => window.removeEventListener('app:open-preview-drawer', handler)
  }, [activeProject?.theme, toast])

  // 离开工作台 / 项目没有主题时，自动收起预览面板
  useEffect(() => {
    if (view !== 'workspace' || !previewAvailable) setPreviewOpen(false)
  }, [view, previewAvailable])

  const openProject = useCallback(
    (id: string) => {
      actions.setActiveProject(id)
      setView('workspace')
      setTab('palette')
    },
    [actions],
  )

  // 无项目时回到总览
  useEffect(() => {
    if (!ready) return
    if (view === 'workspace' && !activeProject) setView('projects')
  }, [ready, view, activeProject])

  // 标题栏面包屑导航
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail === 'projects' || detail === 'settings') setView(detail)
    }
    window.addEventListener('app:navigate', handler)
    return () => window.removeEventListener('app:navigate', handler)
  }, [])

  // 快捷键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        setNewProjectOpen(true)
        return
      }
      if (view === 'workspace' && /^[1-6]$/.test(key)) {
        event.preventDefault()
        setTab(TAB_ORDER[Number(key) - 1])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view])

  if (!ready) return <LoadingSplash />

  return (
    <div className="app">
      <TitleBar
        view={view}
        tab={tab}
        project={activeProject}
        saveStatus={saveStatus}
        desktop={Boolean(window.desktop)}
      />

      <div className="app-body">
        <Sidebar
          projects={data.projects}
          activeProjectId={activeProject?.id ?? null}
          view={view}
          collapsed={data.settings.sidebarCollapsed || (previewOpen && previewAvailable)}
          onOpenProject={openProject}
          onNewProject={() => setNewProjectOpen(true)}
          onOpenProjects={() => setView('projects')}
          onOpenSettings={() => setView('settings')}
          onToggleCollapse={() =>
            actions.updateSettings({ sidebarCollapsed: !data.settings.sidebarCollapsed })
          }
        />

        <main className="main">
          <ErrorBoundary>
            {view === 'projects' ? <ProjectsView onOpenProject={openProject} /> : null}
            {view === 'settings' ? <SettingsView /> : null}
            {view === 'workspace' ? (
              <ProjectWorkspace tab={tab} onTabChange={setTab} onBack={() => setView('projects')} />
            ) : null}
          </ErrorBoundary>
        </main>
      </div>

      {previewOpen && activeProject?.theme ? (
        <PreviewDrawer
          open
          onClose={() => setPreviewOpen(false)}
          project={activeProject}
          mode={data.settings.previewMode}
          device={data.settings.previewDevice}
          onChangeMode={(next) => actions.updateSettings({ previewMode: next })}
          onChangeDevice={(next) => actions.updateSettings({ previewDevice: next })}
          onOpenWindow={() => {
            void window.desktop?.preview.open()
          }}
          windowAvailable={Boolean(window.desktop?.preview)}
        />
      ) : null}

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(project) => openProject(project.id)}
      />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AppProvider>
  )
}
