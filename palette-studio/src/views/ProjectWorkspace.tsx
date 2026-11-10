import React, { useState } from 'react'
import type { ProjectTab } from '../shared/types'
import { generateSemanticTheme } from '../core/palette'
import { bestTextOn } from '../core/color'
import { useApp } from '../state/store'
import {
  Button,
  ConfirmDialog,
  Dropdown,
  Icon,
  IconButton,
  Tabs,
  relativeTime,
  useToast,
} from '../components/ui'
import { ModeToggle } from '../components/color-ui'
import { EditProjectDialog } from '../components/project-dialogs'
import PaletteView from './PaletteView'
import ThemeView from './ThemeView'
import ControlsView from './ControlsView'
import ContrastView from './ContrastView'
import ExportView from './ExportView'
import HistoryView from './HistoryView'

const TAB_ITEMS: { value: ProjectTab; label: string; icon: 'palette' | 'layers' | 'grid' | 'contrast' | 'export' | 'history' }[] = [
  { value: 'palette', label: '色板', icon: 'palette' },
  { value: 'theme', label: '主题', icon: 'layers' },
  { value: 'controls', label: '控件配色', icon: 'grid' },
  { value: 'contrast', label: '对比度', icon: 'contrast' },
  { value: 'export', label: '导出', icon: 'export' },
  { value: 'history', label: '记录', icon: 'history' },
]

export default function ProjectWorkspace({
  tab,
  onTabChange,
  onBack,
}: {
  tab: ProjectTab
  onTabChange: (tab: ProjectTab) => void
  onBack: () => void
}) {
  const { activeProject: project, data, actions } = useApp()
  const { toast } = useToast()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const mode = data.settings.previewMode

  if (!project) {
    return (
      <div className="main-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">未选择项目</h1>
            <p className="page-subtitle">请从左侧项目列表中选择一个项目，或返回项目总览。</p>
          </div>
          <Button icon="arrow-left" onClick={onBack}>
            返回项目总览
          </Button>
        </div>
      </div>
    )
  }

  const regenerateTheme = () => {
    const method = project.theme?.method ?? 'balanced'
    if (data.settings.autoSnapshot) actions.createSnapshot(project.id, '重新生成主题前')
    const theme = generateSemanticTheme(project.baseColor, method)
    actions.setTheme(project.id, theme)
    toast('已根据主色重新生成语义主题', 'success')
  }

  const saveSnapshot = () => {
    actions.createSnapshot(project.id)
    toast('已保存当前配色记录', 'success')
  }

  const tabsWithBadge = TAB_ITEMS.map((item) =>
    item.value === 'palette'
      ? { ...item, badge: project.palette.length }
      : item.value === 'history'
        ? { ...item, badge: project.snapshots.length }
        : item,
  )

  return (
    <div className="workspace page-enter">
      <div className="workspace-header">
        <div className="workspace-title-row">
          <button type="button" className="workspace-back" title="返回项目总览" onClick={onBack}>
            <Icon name="arrow-left" size={16} />
          </button>
          <span
            className="workspace-color"
            style={{ background: project.baseColor, cursor: 'pointer' }}
            title={`品牌主色 ${project.baseColor}（点击编辑项目）`}
            onClick={() => setEditOpen(true)}
          />
          <div style={{ minWidth: 0 }}>
            <div className="workspace-title">
              <span className="name" title={project.name}>
                {project.name}
              </span>
              <IconButton icon="edit" label="编辑项目信息" size={14} onClick={() => setEditOpen(true)} />
            </div>
            <div className="workspace-meta">
              <span className="mono" style={{ color: project.baseColor }}>
                {project.baseColor}
              </span>
              <span>·</span>
              <span>{project.palette.length} 个颜色</span>
              <span>·</span>
              <span>{project.snapshots.length} 条记录</span>
              <span>·</span>
              <span>{relativeTime(project.updatedAt)}更新</span>
              {project.theme ? (
                <>
                  <span>·</span>
                  <span className="badge badge-accent" style={{ height: 18 }}>
                    {project.theme.tokens.length} 语义色
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="workspace-actions">
            {tab === 'theme' ? (
              <Button
                size="sm"
                icon="maximize"
                title="放大查看当前主题的界面预览（桌面端 / 手机端）"
                onClick={() => window.dispatchEvent(new CustomEvent('app:open-preview-drawer'))}
              >
                界面预览
              </Button>
            ) : null}
            <ModeToggle value={mode} onChange={(next) => actions.updateSettings({ previewMode: next })} />
            <Button size="sm" icon="save" onClick={saveSnapshot} title="保存当前色板与主题为一条记录">
              保存记录
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="sparkles"
              onClick={regenerateTheme}
              title="根据主色重新生成浅色/深色语义主题"
            >
              重新生成主题
            </Button>
            <Dropdown
              trigger={<IconButton icon="more" label="更多项目操作" />}
              items={[
                { label: '编辑项目信息', icon: 'edit', onClick: () => setEditOpen(true) },
                {
                  label: '复制项目',
                  icon: 'copy',
                  onClick: () => {
                    actions.duplicateProject(project.id)
                    toast('已复制项目', 'success')
                  },
                },
                { label: '删除项目', icon: 'trash', danger: true, onClick: () => setDeleteOpen(true) },
              ]}
            />
          </div>
        </div>

        <Tabs items={tabsWithBadge} value={tab} onChange={onTabChange} />
      </div>

      <div className="workspace-body">
        {tab === 'palette' ? <PaletteView project={project} mode={mode} /> : null}
        {tab === 'theme' ? <ThemeView project={project} mode={mode} /> : null}
        {tab === 'controls' ? <ControlsView project={project} mode={mode} /> : null}
        {tab === 'contrast' ? <ContrastView project={project} mode={mode} /> : null}
        {tab === 'export' ? <ExportView project={project} mode={mode} /> : null}
        {tab === 'history' ? <HistoryView project={project} mode={mode} /> : null}
      </div>

      {editOpen ? <EditProjectDialog open project={project} onClose={() => setEditOpen(false)} /> : null}
      <ConfirmDialog
        open={deleteOpen}
        title="删除项目"
        message={`确定要删除「${project.name}」吗？项目中的色板、主题与记录都会被删除，此操作不可撤销。`}
        confirmText="删除项目"
        danger
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          actions.deleteProject(project.id)
          setDeleteOpen(false)
          toast('项目已删除')
          onBack()
        }}
      />

      {/* 品牌主色预览角标，帮助视觉定位当前项目 */}
      <div className="workspace-accent-glow" style={{ background: `radial-gradient(600px 200px at 85% -30%, ${project.baseColor}22, transparent 70%)` }}>
        <span style={{ color: bestTextOn(project.baseColor) }} />
      </div>
    </div>
  )
}
