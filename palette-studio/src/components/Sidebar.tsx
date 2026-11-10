import React from 'react'
import type { Project } from '../shared/types'
import { relativeTime } from './ui'
import { Icon } from './ui'

export function Sidebar({
  projects,
  activeProjectId,
  view,
  collapsed,
  onOpenProject,
  onNewProject,
  onOpenProjects,
  onOpenSettings,
  onToggleCollapse,
}: {
  projects: Project[]
  activeProjectId: string | null
  view: 'projects' | 'workspace' | 'settings'
  collapsed: boolean
  onOpenProject: (id: string) => void
  onNewProject: () => void
  onOpenProjects: () => void
  onOpenSettings: () => void
  onToggleCollapse: () => void
}) {
  return (
    <aside className={collapsed ? 'sidebar is-collapsed' : 'sidebar'}>
      <div className="sidebar-section">
        {!collapsed ? <span className="sidebar-section-title">项目</span> : null}
        <button type="button" className="icon-btn" title="新建项目" onClick={onNewProject} style={{ marginLeft: collapsed ? 'auto' : undefined }}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      {!collapsed ? (
        <button
          type="button"
          className={view === 'projects' ? 'sidebar-item is-active' : 'sidebar-item'}
          onClick={onOpenProjects}
          title="全部项目"
        >
          <span className="item-dot" style={{ background: 'var(--text-3)' }} />
          <span className="item-name">全部项目</span>
          <span className="item-meta">{projects.length}</span>
        </button>
      ) : null}

      <nav className="sidebar-nav">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={
              view === 'workspace' && activeProjectId === project.id ? 'sidebar-item is-active' : 'sidebar-item'
            }
            onClick={() => onOpenProject(project.id)}
            title={`${project.name} · ${project.palette.length} 个颜色`}
          >
            <span
              className="item-dot"
              style={{ background: project.baseColor, ['--dot-color' as string]: project.baseColor }}
            />
            {!collapsed ? (
              <>
                <span className="item-name">{project.name}</span>
                <span className="item-meta">{relativeTime(project.updatedAt)}</span>
              </>
            ) : null}
          </button>
        ))}
        {projects.length === 0 && !collapsed ? (
          <div className="sidebar-empty faint small">还没有项目</div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className={view === 'settings' ? 'sidebar-foot-btn is-active' : 'sidebar-foot-btn'}
          onClick={onOpenSettings}
          title="设置"
        >
          <Icon name="settings" size={16} />
          {!collapsed ? <span>设置</span> : null}
        </button>
        <button
          type="button"
          className="sidebar-foot-btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
          {!collapsed ? <span>收起侧栏</span> : null}
        </button>
        {!collapsed ? (
          <div className="sidebar-foot-hint">
            <Icon name="sparkles" size={12} />
            <span>从主色出发，生成整套前端配色</span>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
