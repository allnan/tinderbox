import React, { useEffect, useMemo, useState } from 'react'
import type { Project } from '../shared/types'
import { generateSemanticTheme, suggestPalette } from '../core/palette'
import { bestTextOn, normalizeHex } from '../core/color'
import { PRESET_BASE_COLORS } from '../shared/defaults'
import { useApp } from '../state/store'
import { Button, Field, Icon, Input, Modal, Switch, cx } from './ui'
import { ColorField, HexInput } from './color-ui'
import { ColorPicker } from './ColorPicker'

/** 新建项目弹窗：主色 + 名称，实时预览生成的色板 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated?: (project: Project) => void
}) {
  const { actions } = useApp()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [baseColor, setBaseColor] = useState('#4F7CFF')
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setBaseColor('#4F7CFF')
    setTouched(false)
  }, [open])

  const previewPalette = useMemo(() => {
    const safe = normalizeHex(baseColor) ?? '#4F7CFF'
    return suggestPalette(safe)
  }, [baseColor])

  const theme = useMemo(() => generateSemanticTheme(normalizeHex(baseColor) ?? '#4F7CFF'), [baseColor])

  const submit = () => {
    const safe = normalizeHex(baseColor) ?? '#4F7CFF'
    const project = actions.createProject({
      name: name.trim() || `项目 ${new Date().toLocaleDateString('zh-CN')}`,
      description: description.trim(),
      baseColor: safe,
    })
    onCreated?.(project)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建项目"
      subtitle="输入项目名称，并选择一个主色，配色工坊会自动生成推荐色板与语义主题。"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon="plus" onClick={submit} disabled={touched ? false : false}>
            创建项目
          </Button>
        </>
      }
    >
      <div className="new-project-form">
        <Field label="项目名称">
          <Input
            value={name}
            placeholder="例如：官网 2026 · 后台管理系统"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
            maxLength={48}
          />
        </Field>

        <Field label="项目说明（可选）">
          <Input
            value={description}
            placeholder="一句话描述这个项目的配色用途"
            onChange={(event) => setDescription(event.target.value)}
            maxLength={120}
          />
        </Field>

        <div className="preset-row">
          <span className="preset-label">品牌主色</span>
          <div className="preset-colors">
            {PRESET_BASE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                className={cx('preset-swatch', baseColor.toUpperCase() === color && 'is-active')}
                style={{ background: color }}
                onClick={() => setBaseColor(color)}
              />
            ))}
            <div className="preset-custom">
              <ColorPicker
                value={normalizeHex(baseColor) ?? '#4F7CFF'}
                size={28}
                onChange={setBaseColor}
              />
              <HexInput value={baseColor} onChange={setBaseColor} size="sm" />
            </div>
          </div>
        </div>

        <div className="create-preview">
          <div className="create-preview-head">
            <span className="create-preview-title">配色预览</span>
            <span className="faint small">根据主色 {normalizeHex(baseColor) ?? baseColor} 自动生成</span>
          </div>
          <div className="create-preview-strip">
            {previewPalette.slice(0, 12).map((color) => (
              <div
                key={color.id}
                className="create-preview-cell"
                style={{ background: color.hex }}
                title={`${color.name} ${color.hex}`}
              />
            ))}
          </div>
          <div className="create-preview-tokens">
            {['primary', 'secondary', 'accent', 'background', 'surface', 'text-primary'].map((key) => {
              const token = theme.tokens.find((item) => item.key === key)
              if (!token) return null
              return (
                <div className="create-token" key={key}>
                  <span className="create-token-color" style={{ background: token.light }} />
                  <span className="create-token-label">{token.label}</span>
                </div>
              )
            })}
          </div>
          <div
            className="create-preview-banner"
            style={{ background: theme.tokens.find((t) => t.key === 'primary')?.light ?? '#4F7CFF' }}
          >
            <span style={{ color: bestTextOn(theme.tokens.find((t) => t.key === 'primary')?.light ?? '#4F7CFF') }}>
              主色按钮预览
            </span>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** 编辑项目基本信息；可勾选是否按新主色重新生成主题 */
export function EditProjectDialog({
  open,
  project,
  onClose,
}: {
  open: boolean
  project: Project
  onClose: () => void
}) {
  const { actions } = useApp()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [baseColor, setBaseColor] = useState(project.baseColor)
  const [regenerate, setRegenerate] = useState(true)

  useEffect(() => {
    if (!open) return
    setName(project.name)
    setDescription(project.description)
    setBaseColor(project.baseColor)
    setRegenerate(true)
  }, [open, project])

  const submit = () => {
    const safe = normalizeHex(baseColor) ?? project.baseColor
    const baseChanged = safe !== project.baseColor
    if (baseChanged && regenerate) {
      const theme = generateSemanticTheme(safe)
      actions.setTheme(project.id, theme)
      actions.replacePalette(project.id, suggestPalette(safe))
    }
    actions.updateProject(project.id, {
      name: name.trim() || project.name,
      description: description.trim(),
      baseColor: safe,
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="项目设置"
      width={560}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="new-project-form">
        <Field label="项目名称">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={48} />
        </Field>
        <Field label="项目说明">
          <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={120} />
        </Field>
        <Field label="品牌主色">
          <ColorField value={normalizeHex(baseColor) ?? project.baseColor} onChange={setBaseColor} />
        </Field>
        {baseColor.toUpperCase() !== project.baseColor.toUpperCase() ? (
          <div className="inline-switch">
            <Switch
              checked={regenerate}
              onChange={setRegenerate}
              label="按新主色重新生成推荐色板与语义主题"
            />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

/** 项目信息展示小卡（总览页用） */
export function ProjectMetaLine({ project }: { project: Project }) {
  return (
    <div className="project-meta-line">
      <span>
        <Icon name="palette" size={12} /> {project.palette.length} 色
      </span>
      <span>
        <Icon name="layers" size={12} /> {project.theme ? project.theme.tokens.length : 0} 语义色
      </span>
      <span>
        <Icon name="history" size={12} /> {project.snapshots.length} 记录
      </span>
    </div>
  )
}
