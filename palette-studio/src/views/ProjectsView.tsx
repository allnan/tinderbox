import React, { useMemo, useState } from 'react'
import type { Project } from '../shared/types'
import { useApp } from '../state/store'
import {
  Button,
  ConfirmDialog,
  Dropdown,
  EmptyState,
  Icon,
  IconButton,
  IconName,
  Input,
  relativeTime,
  useToast,
} from '../components/ui'
import { EditProjectDialog, NewProjectDialog, ProjectMetaLine } from '../components/project-dialogs'
import { ColorDot } from '../components/color-ui'

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: IconName
  label: string
  value: React.ReactNode
  accent?: boolean
}) {
  return (
    <div className={accent ? 'stat-card is-accent' : 'stat-card'}>
      <span className="stat-icon">
        <Icon name={icon} size={17} />
      </span>
      <div className="stat-text">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  project: Project
  onOpen: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const colors = project.palette.slice(0, 9)
  const coverColors = colors.length > 0 ? colors.map((item) => item.hex) : [project.baseColor]
  return (
    <article className="project-card" onClick={onOpen}>
      <div className="project-cover">
        <div className="project-cover-strip">
          {coverColors.map((hex, index) => (
            <span
              key={`${hex}-${index}`}
              className="project-cover-cell"
              style={{ background: hex }}
            />
          ))}
        </div>
        <div className="project-cover-actions" onClick={(event) => event.stopPropagation()}>
          <Dropdown
            trigger={<IconButton icon="more" label="更多操作" size={16} />}
            items={[
              { label: '编辑项目信息', icon: 'edit', onClick: onEdit },
              { label: '复制项目', icon: 'copy', onClick: onDuplicate },
              { label: '删除项目', icon: 'trash', danger: true, onClick: onDelete },
            ]}
          />
        </div>
        <div className="project-cover-badge">
          <ColorDot hex={project.baseColor} size={12} radius={4} border />
          <span className="mono">{project.baseColor}</span>
        </div>
      </div>

      <div className="project-card-body">
        <div className="project-card-title-row">
          <h3 className="project-card-title">{project.name}</h3>
          {project.theme ? (
            <span className="project-tag">
              <Icon name="layers" size={11} /> 主题就绪
            </span>
          ) : (
            <span className="project-tag is-muted">未生成主题</span>
          )}
        </div>
        <p className="project-card-desc">{project.description || '暂无项目说明'}</p>
        <ProjectMetaLine project={project} />
      </div>

      <footer className="project-card-footer">
        <span className="faint small">
          <Icon name="clock" size={12} /> {relativeTime(project.updatedAt)}更新
        </span>
        <span className="project-open">
          打开 <Icon name="arrow-right" size={13} />
        </span>
      </footer>
    </article>
  )
}

export default function ProjectsView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { data, actions } = useApp()
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const list = [...data.projects].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!keyword) return list
    return list.filter(
      (project) =>
        project.name.toLowerCase().includes(keyword) ||
        project.description.toLowerCase().includes(keyword) ||
        project.baseColor.toLowerCase().includes(keyword),
    )
  }, [data.projects, query])

  const stats = useMemo(() => {
    const colorCount = data.projects.reduce((sum, project) => sum + project.palette.length, 0)
    const themeCount = data.projects.filter((project) => project.theme).length
    const latest = data.projects.reduce((max, project) => Math.max(max, project.updatedAt), 0)
    return { colorCount, themeCount, latest }
  }, [data.projects])

  return (
    <div className="page-enter">
      <div className="main-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">
              我的项目
              <span className="page-title-count">{data.projects.length}</span>
            </h1>
            <p className="page-subtitle">
              为每个前端产品维护独立的色板、语义主题与控件配色；从主色一键生成整套方案。
            </p>
          </div>
          <div className="page-actions">
            <div className="search-box">
              <Icon name="search" size={14} className="search-icon" />
              <Input
                value={query}
                placeholder="搜索项目名称 / 主色…"
                onChange={(event) => setQuery(event.target.value)}
                style={{ paddingLeft: 30 }}
              />
            </div>
            <Button variant="primary" icon="plus" onClick={() => setNewOpen(true)}>
              新建项目
            </Button>
          </div>
        </div>

        <div className="stats-row">
          <StatCard icon="folder" label="项目" value={data.projects.length} accent />
          <StatCard icon="palette" label="颜色记录" value={stats.colorCount} />
          <StatCard icon="layers" label="已生成主题" value={stats.themeCount} />
          <StatCard icon="clock" label="最近更新" value={stats.latest ? relativeTime(stats.latest) : '—'} />
        </div>

        {data.projects.length === 0 ? (
          <EmptyState
            icon="palette"
            title="开始第一个配色项目"
            description="创建项目并选一个品牌主色，配色工坊会自动生成推荐色板、浅色/深色语义主题和控件配色。"
            action={
              <Button variant="primary" icon="plus" onClick={() => setNewOpen(true)}>
                新建项目
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon="search" title="没有匹配的项目" description={`没有找到与「${query}」相关的项目。`} />
        ) : (
          <div className="project-grid">
            {filtered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => onOpenProject(project.id)}
                onEdit={() => setEditing(project)}
                onDuplicate={() => {
                  actions.duplicateProject(project.id)
                  toast('已复制项目', 'success')
                }}
                onDelete={() => setDeleting(project)}
              />
            ))}
          </div>
        )}

        <div className="quickstart">
          <div className="quickstart-title">
            <Icon name="sparkles" size={15} /> 快速上手
          </div>
          <div className="quickstart-steps">
            <div className="quickstart-step">
              <span className="quickstart-index">1</span>
              <div>
                <div className="quickstart-step-title">选择主色，生成配色</div>
                <p>在「色板」里输入品牌主色，用互补、相邻、三角等 8 种方式生成配色，并生成 50–950 明暗色阶。</p>
              </div>
            </div>
            <div className="quickstart-step">
              <span className="quickstart-index">2</span>
              <div>
                <div className="quickstart-step-title">分配到控件与主题</div>
                <p>一键生成浅色/深色语义主题，在「控件配色」中把每个控件属性绑定到主题色或项目色板，实时预览。</p>
              </div>
            </div>
            <div className="quickstart-step">
              <span className="quickstart-index">3</span>
              <div>
                <div className="quickstart-step-title">导出到前端项目</div>
                <p>导出 CSS 变量、SCSS、Tailwind 配置、W3C Design Tokens 等 7 种格式，直接粘贴进你的前端工程。</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <NewProjectDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(project) => {
          toast(`项目「${project.name}」已创建`, 'success')
          onOpenProject(project.id)
        }}
      />
      {editing ? <EditProjectDialog open project={editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除项目"
        message={`确定要删除「${deleting?.name ?? ''}」吗？项目中的色板、主题与记录都会被删除，此操作不可撤销。`}
        confirmText="删除"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            actions.deleteProject(deleting.id)
            toast('项目已删除')
          }
          setDeleting(null)
        }}
      />
    </div>
  )
}
