/**
 * 配色记录（HistoryView）
 *
 * 保存项目配色快照（主色 / 色板 / 主题 / 控件配色），以时间线方式展示，
 * 支持命名、恢复与删除；并提示当前配色与最新记录的差异。
 */
import React, { useMemo, useState } from 'react'
import type { GeneratedTheme, Project, Snapshot } from '../shared/types'
import { tokenColor } from '../core/resolve'
import { useApp } from '../state/store'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  Panel,
  cx,
  formatTime,
  relativeTime,
  useToast,
} from '../components/ui'
import { ColorDot, CopyableColor, useColorCopy } from '../components/color-ui'
import type { ProjectViewProps } from './types'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 色板签名：只比较色值，用于判断「当前配色是否与记录一致」 */
function paletteSignature(palette: { hex: string }[]): string {
  return palette.map((color) => color.hex.toUpperCase()).join(',')
}

/** 统计控件配色绑定数量 */
function controlBindingCount(styles: Project['controlStyles']): number {
  return Object.values(styles ?? {}).reduce(
    (sum, style) => sum + Object.keys(style ?? {}).length,
    0,
  )
}

/** 快照是否与项目当前状态一致 */
function snapshotMatchesProject(snapshot: Snapshot, project: Project): boolean {
  return (
    snapshot.baseColor === project.baseColor &&
    paletteSignature(snapshot.palette) === paletteSignature(project.palette) &&
    (snapshot.theme?.createdAt ?? 0) === (project.theme?.createdAt ?? 0) &&
    JSON.stringify(snapshot.controlStyles ?? {}) === JSON.stringify(project.controlStyles ?? {})
  )
}

/** 快照中的主题缩略色：主色 / 背景 / 表面 / 正文字色（跟随当前预览模式） */
function themePreviewDots(
  theme: GeneratedTheme | null,
  mode: 'light' | 'dark',
): { key: string; label: string; hex: string }[] {
  if (!theme) return []
  const keys = ['primary', 'background', 'surface', 'text-primary']
  const dots: { key: string; label: string; hex: string }[] = []
  for (const key of keys) {
    const hex = tokenColor(theme, key, mode)
    if (!hex) continue
    dots.push({
      key,
      label: theme.tokens.find((token) => token.key === key)?.label ?? key,
      hex,
    })
  }
  return dots
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export default function HistoryView({ project, mode }: ProjectViewProps) {
  const { actions } = useApp()
  const { toast } = useToast()
  const copy = useColorCopy()

  const [saveOpen, setSaveOpen] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [restoring, setRestoring] = useState<Snapshot | null>(null)
  const [deleting, setDeleting] = useState<Snapshot | null>(null)

  const snapshots = useMemo(
    () => [...project.snapshots].sort((a, b) => b.createdAt - a.createdAt),
    [project.snapshots],
  )
  const latest = snapshots[0] ?? null
  const modeName = mode === 'dark' ? '深色' : '浅色'
  const currentMatchesLatest = latest ? snapshotMatchesProject(latest, project) : false

  // 当前状态与最新记录的差异项
  const changes = useMemo(() => {
    if (!latest || currentMatchesLatest) return []
    const list: string[] = []
    if (project.baseColor !== latest.baseColor) list.push('主色')
    if (paletteSignature(project.palette) !== paletteSignature(latest.palette)) list.push('色板')
    if ((project.theme?.createdAt ?? 0) !== (latest.theme?.createdAt ?? 0)) list.push('主题')
    if (
      JSON.stringify(project.controlStyles ?? {}) !== JSON.stringify(latest.controlStyles ?? {})
    ) {
      list.push('控件配色')
    }
    return list
  }, [latest, currentMatchesLatest, project])

  // ---- 保存记录 ----

  const openSave = () => {
    setSaveLabel('')
    setSaveOpen(true)
  }

  const submitSave = () => {
    actions.createSnapshot(project.id, saveLabel.trim() || undefined)
    setSaveOpen(false)
    setSaveLabel('')
    toast('已保存当前配色记录', 'success')
  }

  // ---- 重命名 ----

  const startRename = (snapshot: Snapshot) => {
    setRenamingId(snapshot.id)
    setRenameText(snapshot.label)
  }

  const commitRename = (snapshot: Snapshot) => {
    if (renamingId !== snapshot.id) return
    const nextLabel = renameText.trim()
    if (!nextLabel || nextLabel === snapshot.label) {
      setRenamingId(null)
      return
    }
    actions.updateProject(project.id, {
      snapshots: project.snapshots.map((item) =>
        item.id === snapshot.id ? { ...item, label: nextLabel } : item,
      ),
    })
    setRenamingId(null)
    toast('记录已重命名', 'success')
  }

  const cancelRename = (snapshot: Snapshot) => {
    setRenameText(snapshot.label)
    setRenamingId(null)
  }

  // ---- 恢复 / 删除 ----

  const confirmRestore = () => {
    if (!restoring) return
    actions.restoreSnapshot(project.id, restoring.id)
    toast(`已恢复到「${restoring.label}」`, 'success')
    setRestoring(null)
  }

  const confirmDelete = () => {
    if (!deleting) return
    actions.deleteSnapshot(project.id, deleting.id)
    toast(`已删除记录「${deleting.label}」`)
    setDeleting(null)
  }

  return (
    <div className="tools-view page-enter">
      <header className="tools-view-head">
        <div className="tools-view-heading">
          <span className="tools-view-icon">
            <Icon name="history" size={18} />
          </span>
          <div>
            <h2 className="tools-view-title">
              配色记录
              {snapshots.length > 0 ? <Badge tone="default">{snapshots.length} 条</Badge> : null}
            </h2>
            <p className="tools-view-desc">
              保存当前配色快照，随时回滚到任意历史版本；每条记录包含主色、色板、语义主题与控件配色。
            </p>
          </div>
        </div>
        <div className="tools-view-actions">
          <Badge tone="info">{modeName}模式</Badge>
          <Button variant="primary" icon="save" onClick={openSave}>
            保存当前配色
          </Button>
        </div>
      </header>

      {/* 当前状态摘要 */}
      <section className="history-current">
        <div className="history-current-main">
          <ColorDot hex={project.baseColor} size={42} radius={12} border />
          <div className="history-current-text">
            <div className="history-current-title">
              当前配色
              <span className="mono" style={{ color: project.baseColor }}>
                {project.baseColor}
              </span>
              <CopyableColor hex={project.baseColor} showHex={false} size={12} />
            </div>
            <div className="history-current-meta">
              <span>
                <Icon name="palette" size={12} /> {project.palette.length} 个颜色
              </span>
              <span>
                <Icon name="layers" size={12} />{' '}
                {project.theme ? `${project.theme.tokens.length} 个语义色` : '未生成主题'}
              </span>
              <span>
                <Icon name="grid" size={12} /> 控件绑定 {controlBindingCount(project.controlStyles)} 项
              </span>
              <span>
                <Icon name="clock" size={12} /> {relativeTime(project.updatedAt)}更新
              </span>
            </div>
          </div>
        </div>
        <div className="history-current-side">
          {latest ? (
            currentMatchesLatest ? (
              <Badge tone="success">
                <Icon name="check" size={11} /> 与最新记录一致
              </Badge>
            ) : (
              <span className="history-diff">
                <span className="faint">较最新记录：</span>
                {changes.length > 0 ? (
                  changes.map((item) => (
                    <Badge key={item} tone="warning">
                      {item}有改动
                    </Badge>
                  ))
                ) : (
                  <Badge tone="warning">有改动</Badge>
                )}
              </span>
            )
          ) : (
            <span className="faint">暂无历史记录</span>
          )}
          <Button size="sm" icon="plus" onClick={openSave}>
            另存为记录
          </Button>
        </div>
      </section>

      {/* 时间线 */}
      {snapshots.length === 0 ? (
        <Panel className="history-empty-panel">
          <EmptyState
            icon="history"
            title="还没有配色记录"
            description="把当前配色保存为一条记录，之后即可随时恢复到任意历史状态。重新生成主题前会自动保存快照（可在设置中关闭）。"
            action={
              <Button variant="primary" icon="save" onClick={openSave}>
                保存当前配色
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="history-timeline">
          {snapshots.map((snapshot, index) => {
            const isCurrent = snapshotMatchesProject(snapshot, project)
            const dots = themePreviewDots(snapshot.theme, mode)
            const bindingCount = controlBindingCount(snapshot.controlStyles)
            const paletteColors = snapshot.palette.slice(0, 8)
            return (
              <article
                key={snapshot.id}
                className={cx('history-item', isCurrent && 'is-current')}
              >
                <span className="history-dot" style={{ background: snapshot.baseColor }} />
                <div className="history-card">
                  <header className="history-card-head">
                    <div className="history-card-title">
                      <span className="history-index mono">#{snapshots.length - index}</span>
                      {renamingId === snapshot.id ? (
                        <Input
                          className="history-rename-input"
                          value={renameText}
                          autoFocus
                          maxLength={40}
                          onChange={(event) => setRenameText(event.target.value)}
                          onBlur={() => commitRename(snapshot)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename(snapshot)
                            if (event.key === 'Escape') cancelRename(snapshot)
                          }}
                        />
                      ) : (
                        <h3 className="history-label" title={snapshot.label}>
                          {snapshot.label}
                        </h3>
                      )}
                      {isCurrent ? (
                        <Badge tone="success">
                          <Icon name="check" size={11} /> 当前状态
                        </Badge>
                      ) : null}
                    </div>
                    <div className="history-card-actions">
                      <span className="history-time">
                        <Icon name="clock" size={12} />
                        {formatTime(snapshot.createdAt)}
                        <span className="faint"> · {relativeTime(snapshot.createdAt)}</span>
                      </span>
                      {renamingId === snapshot.id ? null : (
                        <IconButton
                          icon="edit"
                          label="重命名记录"
                          size={15}
                          onClick={() => startRename(snapshot)}
                        />
                      )}
                      <IconButton
                        icon="trash"
                        label="删除记录"
                        size={15}
                        variant="danger"
                        onClick={() => setDeleting(snapshot)}
                      />
                      <Button
                        size="xs"
                        icon="restore"
                        disabled={isCurrent}
                        title={isCurrent ? '当前配色与该记录一致，无需恢复' : '恢复到此记录的配色'}
                        onClick={() => setRestoring(snapshot)}
                      >
                        恢复
                      </Button>
                    </div>
                  </header>

                  <div className="history-card-body">
                    <div className="history-strip">
                      {paletteColors.length > 0 ? (
                        paletteColors.map((color) => (
                          <button
                            key={color.id}
                            type="button"
                            className="history-strip-cell"
                            style={{ background: color.hex }}
                            title={`${color.name} · ${color.hex}（点击复制）`}
                            onClick={() => void copy(color.hex)}
                          />
                        ))
                      ) : (
                        <span className="history-strip-empty">色板为空</span>
                      )}
                    </div>
                    <div className="history-meta">
                      <span className="history-meta-item">
                        <CopyableColor hex={snapshot.baseColor} size={12} />
                      </span>
                      <span className="history-meta-item">
                        <Icon name="palette" size={12} />
                        {snapshot.palette.length} 个颜色
                      </span>
                      <span className="history-meta-item">
                        <Icon name="layers" size={12} />
                        {snapshot.theme ? `${snapshot.theme.tokens.length} 个语义色` : '未生成主题'}
                      </span>
                      <span className="history-meta-item">
                        <Icon name="grid" size={12} />
                        控件绑定 {bindingCount} 项
                      </span>
                      {dots.length > 0 ? (
                        <span className="history-theme-dots" title={`主题缩略（${modeName}模式）`}>
                          <span className="faint">主题</span>
                          {dots.map((dot) => (
                            <span
                              key={dot.key}
                              className="history-theme-dot"
                              style={{ background: dot.hex }}
                              title={`${dot.label} · ${dot.hex}`}
                            />
                          ))}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <div className="history-footnote">
        <Icon name="info" size={12} />
        <span>
          最多保留最近 60 条记录；重新生成主题前是否自动保存快照，可在「设置」中调整。
        </span>
      </div>

      {/* 保存记录弹窗 */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="保存当前配色"
        subtitle="记录当前的主色、色板、主题与控件配色，之后可一键恢复。"
        width={480}
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)}>取消</Button>
            <Button variant="primary" icon="save" onClick={submitSave}>
              保存记录
            </Button>
          </>
        }
      >
        <div className="history-save-form">
          <Field
            label="记录名称"
            hint={`留空将自动命名为「配色快照 ${project.snapshots.length + 1}」`}
          >
            <Input
              value={saveLabel}
              autoFocus
              maxLength={40}
              placeholder="例如：官网改版前 / 客户确认版本"
              onChange={(event) => setSaveLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSave()
              }}
            />
          </Field>

          <div className="history-save-preview">
            <div className="history-save-swatches">
              {(project.palette.length > 0 ? project.palette.slice(0, 10) : []).map((color) => (
                <span key={color.id} style={{ background: color.hex }} title={color.hex} />
              ))}
              {project.palette.length === 0 ? (
                <span style={{ background: project.baseColor }} />
              ) : null}
            </div>
            <div className="history-save-meta">
              主色 {project.baseColor} · {project.palette.length} 个颜色 ·{' '}
              {project.theme ? `${project.theme.tokens.length} 个语义色` : '未生成主题'} · 控件绑定{' '}
              {controlBindingCount(project.controlStyles)} 项
            </div>
          </div>
        </div>
      </Modal>

      {/* 恢复确认 */}
      <ConfirmDialog
        open={Boolean(restoring)}
        title="恢复配色记录"
        message={
          restoring
            ? `将把项目恢复到「${restoring.label}」的配色状态：主色 ${restoring.baseColor}、${restoring.palette.length} 个颜色、${restoring.theme ? '含语义主题' : '不含语义主题'}。当前未保存的修改会被覆盖，确定继续吗？`
            : ''
        }
        confirmText="确认恢复"
        onCancel={() => setRestoring(null)}
        onConfirm={confirmRestore}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除配色记录"
        message={
          deleting
            ? `确定要删除「${deleting.label}」吗？删除后无法恢复，但不会影响项目当前配色。`
            : ''
        }
        confirmText="删除记录"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
