import React from 'react'
import type { Project, ProjectTab } from '../shared/types'
import type { SaveStatus } from '../state/store'
import { Icon } from './ui'

export const TAB_LABELS: Record<ProjectTab, string> = {
  palette: '色板',
  theme: '主题',
  controls: '控件配色',
  contrast: '对比度',
  export: '导出',
  history: '记录',
}

export function TitleBar({
  view,
  tab,
  project,
  saveStatus,
  desktop,
}: {
  view: 'projects' | 'workspace' | 'settings'
  tab: ProjectTab
  project: Project | null
  saveStatus: SaveStatus
  desktop: boolean
}) {
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!window.desktop) return
    void window.desktop.window.isMaximized().then(setMaximized)
    return window.desktop.window.onMaximizedChange(setMaximized)
  }, [])

  const statusText =
    saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存失败' : saveStatus === 'saved' ? '已自动保存' : ''

  return (
    <header
      className="titlebar"
      onDoubleClick={() => {
        if (window.desktop) void window.desktop.window.toggleMaximize()
      }}
    >
      <div className="titlebar-brand">
        <span className="brand-mark">
          <Icon name="palette" size={15} />
        </span>
        <div>
          <div className="brand-name">配色工坊</div>
          <div className="brand-sub">前端配色管理工具</div>
        </div>
      </div>

      <div className="titlebar-crumbs">
        <span
          className="crumb-link"
          onClick={() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'projects' }))}
        >
          项目
        </span>
        {view === 'settings' ? (
          <>
            <span className="sep">/</span>
            <span className="crumb-current">设置</span>
          </>
        ) : view === 'workspace' && project ? (
          <>
            <span className="sep">/</span>
            <span className="crumb-current ellipsis" style={{ maxWidth: 220 }}>
              {project.name}
            </span>
            <span className="sep">/</span>
            <span className="crumb-current">{TAB_LABELS[tab]}</span>
          </>
        ) : (
          <>
            <span className="sep">/</span>
            <span className="crumb-current">全部项目</span>
          </>
        )}
      </div>

      <div className="titlebar-spacer" />

      {desktop && statusText ? (
        <div className="titlebar-status">
          <Icon
            name={saveStatus === 'error' ? 'warning' : saveStatus === 'saving' ? 'refresh' : 'check'}
            size={12}
          />
          {statusText}
        </div>
      ) : null}

      <div className="window-controls">
        <button
          type="button"
          className="window-btn"
          title="最小化"
          onClick={() => window.desktop?.window.minimize()}
        >
          <Icon name="minimize" size={15} />
        </button>
        <button
          type="button"
          className="window-btn"
          title={maximized ? '还原' : '最大化'}
          onClick={() => window.desktop?.window.toggleMaximize()}
        >
          <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
        </button>
        <button
          type="button"
          className="window-btn is-close"
          title="关闭"
          onClick={() => window.desktop?.window.close()}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </header>
  )
}
