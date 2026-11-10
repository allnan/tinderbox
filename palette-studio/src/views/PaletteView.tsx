import React, { useMemo, useRef, useState } from 'react'
import type { PaletteColor } from '../shared/types'
import {
  HARMONIES,
  TONAL_STEPS,
  colorDisplayName,
  createPaletteColor,
  generateHarmony,
  generateSemanticTheme,
  generateTonalScale,
  mergeGeneratedPalette,
  nameWithLevel,
  suggestPalette,
} from '../core/palette'
import type { HarmonyType } from '../core/palette'
import { bestTextOn, formatColor, normalizeHex } from '../core/color'
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
  useToast,
} from '../components/ui'
import { ColorField, CopyableColor, useColorCopy } from '../components/color-ui'
import type { ProjectViewProps } from './types'

/** 色板颜色来源的中文标签 */
const SOURCE_LABELS: Record<NonNullable<PaletteColor['source']>, string> = {
  manual: '手动添加',
  harmony: '和谐配色',
  scale: '明暗色阶',
  theme: '语义主题',
  imported: '导入',
}

/**
 * 色板视图：以「主色 → 8 种方案 → 色板管理 → 50-950 色阶」为核心。
 * 所有生成逻辑都来自 core/palette，写操作统一走 useApp().actions。
 */
export default function PaletteView({ project, mode }: ProjectViewProps) {
  const { data, actions } = useApp()
  const { toast } = useToast()
  const copy = useColorCopy()

  // ---- 本地交互状态 ----
  const [harmonyType, setHarmonyType] = useState<HarmonyType>('analogous')
  const [addOpen, setAddOpen] = useState(false)
  const [draftHex, setDraftHex] = useState(project.baseColor)
  const [draftName, setDraftName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [deleting, setDeleting] = useState<PaletteColor | null>(null)
  const skipRenameRef = useRef(false)

  const baseColor = normalizeHex(project.baseColor) ?? '#4F7CFF'
  const lockedCount = project.palette.filter((color) => color.locked).length

  // ---- 由主色派生的数据（全部为纯函数，随主色/模式实时更新）----
  const formats = useMemo(
    () => ({
      rgb: formatColor(baseColor, 'rgb'),
      hsl: formatColor(baseColor, 'hsl'),
      oklch: formatColor(baseColor, 'oklch'),
    }),
    [baseColor],
  )

  /** 8 种方案的实时预览（每种方案同时生成小色条，便于一眼比较） */
  const harmonies = useMemo(
    () => HARMONIES.map((item) => ({ ...item, colors: generateHarmony(baseColor, item.type) })),
    [baseColor],
  )
  const activeHarmony = harmonies.find((item) => item.type === harmonyType) ?? harmonies[0]

  /** 明暗色阶：深色模式下按主题约定略微提高色度（与主题色阶保持一致） */
  const tonalScale = useMemo(
    () => generateTonalScale(baseColor, mode === 'dark' ? { chromaScale: 1.07 } : {}),
    [baseColor, mode],
  )

  /** 统计某个色板颜色被多少个控件属性引用（删除前提示用） */
  const countPaletteRefs = (colorId: string): number => {
    let count = 0
    for (const style of Object.values(project.controlStyles ?? {})) {
      for (const ref of Object.values(style ?? {})) {
        if (ref && ref.kind === 'palette' && ref.id === colorId) count += 1
      }
    }
    return count
  }

  // ---- 主色相关 ----
  const updateBaseColor = (hex: string) => {
    const safe = normalizeHex(hex)
    if (!safe || safe === project.baseColor) return
    actions.updateProject(project.id, { baseColor: safe })
  }

  /** 一键应用推荐色板：保留锁定色，其余替换为 suggestPalette 的结果 */
  const applySuggestedPalette = () => {
    const merged = mergeGeneratedPalette(project.palette, suggestPalette(baseColor))
    actions.replacePalette(project.id, merged)
    toast(
      lockedCount > 0
        ? `已应用推荐色板（保留 ${lockedCount} 个锁定色，共 ${merged.length} 色）`
        : `已应用推荐色板，共 ${merged.length} 个颜色`,
      'success',
    )
  }

  /** 按当前主色重新生成语义主题（遵循设置中的自动快照开关） */
  const regenerateTheme = () => {
    if (data.settings.autoSnapshot) actions.createSnapshot(project.id, '重新生成主题前')
    const theme = generateSemanticTheme(baseColor, project.theme?.method ?? 'balanced')
    actions.setTheme(project.id, theme)
    toast(`已重新生成 ${theme.tokens.length} 个语义色与 ${theme.scales.length} 组色阶`, 'success')
  }

  // ---- 配色方案 ----
  /** 把当前方案写入色板：锁定色保留在最前，方案色去重后追加 */
  const applyHarmonyToPalette = () => {
    if (!activeHarmony) return
    const merged = mergeGeneratedPalette(project.palette, activeHarmony.colors)
    actions.replacePalette(project.id, merged)
    toast(
      lockedCount > 0
        ? `已应用「${activeHarmony.label}」，保留 ${lockedCount} 个锁定色`
        : `已应用「${activeHarmony.label}」配色`,
      'success',
    )
  }

  // ---- 色板管理 ----
  /** 追加单个颜色（若色板中已有相同 HEX 则给出提示，不重复添加） */
  const addColorToPalette = (hex: string, name?: string, source: PaletteColor['source'] = 'scale') => {
    const safe = normalizeHex(hex)
    if (!safe) {
      toast('颜色值不合法，无法添加', 'error')
      return
    }
    if (project.palette.some((color) => color.hex === safe)) {
      toast('该颜色已在色板中', 'warning')
      return
    }
    const color = createPaletteColor(safe, name, source)
    actions.addPaletteColors(project.id, [color])
    toast(`已添加「${color.name}」`, 'success')
  }

  /** 打开「添加颜色」弹窗时重置表单，默认取当前主色 */
  const openAddDialog = () => {
    setDraftHex(baseColor)
    setDraftName('')
    setAddOpen(true)
  }

  const submitAddColor = () => {
    const safe = normalizeHex(draftHex)
    if (!safe) {
      toast('请输入合法的 HEX 颜色值', 'error')
      return
    }
    if (project.palette.some((color) => color.hex === safe)) {
      toast('该颜色已在色板中', 'warning')
      return
    }
    const color = createPaletteColor(safe, draftName.trim() || undefined, 'manual')
    actions.addPaletteColors(project.id, [color])
    setAddOpen(false)
    toast(`已添加「${color.name}」`, 'success')
  }

  const startRename = (color: PaletteColor) => {
    skipRenameRef.current = false
    setEditingId(color.id)
    setNameDraft(color.name)
  }

  /** 提交重命名（失焦 / 回车触发；Esc 取消时不提交） */
  const finishRename = () => {
    if (skipRenameRef.current) {
      skipRenameRef.current = false
      return
    }
    if (!editingId) return
    const color = project.palette.find((item) => item.id === editingId)
    const nextName = nameDraft.trim()
    if (color && nextName && nextName !== color.name) {
      actions.updatePaletteColor(project.id, color.id, { name: nextName })
      toast('已重命名颜色', 'success')
    }
    setEditingId(null)
  }

  const cancelRename = () => {
    skipRenameRef.current = true
    setEditingId(null)
    setNameDraft('')
  }

  const toggleLock = (color: PaletteColor) => {
    actions.updatePaletteColor(project.id, color.id, { locked: !color.locked })
    toast(color.locked ? `已解锁「${color.name}」` : `已锁定「${color.name}」，重新生成时将保留`, 'success')
  }

  /** 删除：被控件引用的颜色先弹确认，避免破坏控件配色绑定 */
  const requestDelete = (color: PaletteColor) => {
    if (countPaletteRefs(color.id) > 0) setDeleting(color)
    else removeColor(color)
  }

  const removeColor = (color: PaletteColor) => {
    actions.removePaletteColor(project.id, color.id)
    toast(`已删除「${color.name}」`)
  }

  const confirmDelete = () => {
    if (deleting) removeColor(deleting)
    setDeleting(null)
  }

  // ---- 色阶 ----
  const addScaleColor = (step: number, hex: string) => {
    addColorToPalette(hex, `主色 ${step}`, 'scale')
  }

  const addAllScaleColors = () => {
    const existing = new Set(project.palette.map((color) => color.hex))
    const colors: PaletteColor[] = []
    for (const step of TONAL_STEPS) {
      const hex = tonalScale[String(step)]
      if (!hex || existing.has(hex)) continue
      colors.push(createPaletteColor(hex, `主色 ${step}`, 'scale'))
      existing.add(hex)
    }
    if (colors.length === 0) {
      toast('色阶中的颜色已全部在色板中', 'warning')
      return
    }
    actions.addPaletteColors(project.id, colors)
    toast(`已添加 ${colors.length} 个色阶档位`, 'success')
  }

  const draftSafeHex = normalizeHex(draftHex) ?? baseColor
  const draftNameHint = draftName.trim() || nameWithLevel(draftSafeHex)

  return (
    <div className="palette-view fade-in">
      {/* ================= 主色卡 ================= */}
      <section className="palette-hero">
        <div className="palette-hero-glow" style={{ background: baseColor }} aria-hidden="true" />

        <button
          type="button"
          className="palette-hero-swatch"
          style={{ background: baseColor }}
          title={`点击复制主色 ${baseColor}`}
          onClick={() => void copy(baseColor, 'hex')}
        >
          <span className="palette-hero-swatch-name" style={{ color: bestTextOn(baseColor) }}>
            {colorDisplayName(baseColor)}
          </span>
          <span className="palette-hero-swatch-icon" style={{ color: bestTextOn(baseColor) }}>
            <Icon name="palette" size={20} />
          </span>
        </button>

        <div className="palette-hero-main">
          <div className="palette-hero-eyebrow">品牌主色 · BASE COLOR</div>
          <button
            type="button"
            className="palette-hero-hex"
            title="点击复制 HEX"
            onClick={() => void copy(baseColor, 'hex')}
          >
            <span className="mono">{baseColor}</span>
            <Icon name="copy" size={16} />
          </button>
          <div className="palette-hero-formats">
            <button type="button" className="palette-format-chip" onClick={() => void copy(baseColor, 'rgb')}>
              <span className="palette-format-label">RGB</span>
              <span className="mono">{formats.rgb}</span>
            </button>
            <button type="button" className="palette-format-chip" onClick={() => void copy(baseColor, 'hsl')}>
              <span className="palette-format-label">HSL</span>
              <span className="mono">{formats.hsl}</span>
            </button>
            <button type="button" className="palette-format-chip" onClick={() => void copy(baseColor, 'oklch')}>
              <span className="palette-format-label">OKLCH</span>
              <span className="mono">{formats.oklch}</span>
            </button>
          </div>
          <div className="palette-hero-stats">
            <Badge tone="accent">
              <Icon name="palette" size={11} /> {project.palette.length} 个色板颜色
            </Badge>
            <Badge tone={lockedCount > 0 ? 'warning' : 'default'}>
              <Icon name={lockedCount > 0 ? 'lock' : 'unlock'} size={11} /> {lockedCount} 个锁定
            </Badge>
            <Badge tone={project.theme ? 'success' : 'default'}>
              <Icon name="layers" size={11} /> {project.theme ? `${project.theme.tokens.length} 个语义色` : '未生成主题'}
            </Badge>
            <Badge>
              <Icon name="history" size={11} /> {project.snapshots.length} 条记录
            </Badge>
          </div>
        </div>

        <div className="palette-hero-side">
          <ColorField
            label="主色 HEX"
            value={baseColor}
            onChange={updateBaseColor}
            hint="取色器或输入 HEX，配色方案与色阶实时更新"
          />
          <div className="palette-hero-actions">
            <Button variant="primary" size="sm" icon="sparkles" onClick={applySuggestedPalette}>
              应用推荐色板
            </Button>
            <Button size="sm" icon="refresh" onClick={regenerateTheme}>
              重新生成主题
            </Button>
          </div>
          <p className="palette-hero-note">
            <Icon name="info" size={12} />
            {lockedCount > 0
              ? `有 ${lockedCount} 个锁定色，生成配色时会在最前保留`
              : '锁定喜欢的颜色，重新生成配色时即可保留'}
          </p>
        </div>
      </section>

      {/* ================= 配色方案生成 ================= */}
      <Panel
        title="配色方案生成"
        subtitle="选择一种和谐配色方式，实时预览后一次写入色板"
        actions={<Badge tone="accent">{HARMONIES.length} 种方式</Badge>}
      >
        <div className="palette-harmony-grid">
          {harmonies.map((item) => (
            <button
              key={item.type}
              type="button"
              className={cx('palette-harmony-card', item.type === harmonyType && 'is-active')}
              onClick={() => setHarmonyType(item.type)}
            >
              <span className="palette-harmony-head">
                <span className="palette-harmony-name">{item.label}</span>
                <span className="palette-harmony-count">{item.colors.length} 色</span>
              </span>
              <span className="palette-harmony-desc">{item.description}</span>
              <span className="palette-harmony-mini" aria-hidden="true">
                {item.colors.map((color, index) => (
                  <span key={`${item.type}-${index}`} style={{ background: color.hex }} />
                ))}
              </span>
            </button>
          ))}
        </div>

        {activeHarmony ? (
          <div className="palette-scheme">
            <div className="palette-scheme-head">
              <div className="palette-scheme-info">
                <div className="palette-scheme-title">
                  {activeHarmony.label}
                  <span className="faint small"> · {activeHarmony.colors.length} 个颜色</span>
                </div>
                <p className="palette-scheme-desc">
                  {activeHarmony.description}
                  {lockedCount > 0 ? `；应用时将保留 ${lockedCount} 个锁定色` : '；应用时会替换当前色板中的非锁定色'}
                </p>
              </div>
              <div className="palette-scheme-actions">
                <Button variant="primary" size="sm" icon="plus" onClick={applyHarmonyToPalette}>
                  添加到色板
                </Button>
              </div>
            </div>
            <div className="palette-scheme-strip">
              {activeHarmony.colors.map((color, index) => (
                <button
                  key={`${color.hex}-${index}`}
                  type="button"
                  className="palette-scheme-cell"
                  style={{ background: color.hex }}
                  title={`${color.name} · ${color.hex}（点击复制）`}
                  onClick={() => void copy(color.hex)}
                >
                  <span className="palette-scheme-cell-top" style={{ color: bestTextOn(color.hex) }}>
                    <span className="palette-scheme-cell-name">{color.name}</span>
                    <Icon name="copy" size={12} className="palette-scheme-cell-copy" />
                  </span>
                  <span className="mono palette-scheme-cell-hex" style={{ color: bestTextOn(color.hex) }}>
                    {color.hex}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>

      {/* ================= 项目色板管理 ================= */}
      <Panel
        title="项目色板"
        subtitle="双击名称可重命名；锁定的颜色会在重新生成配色时保留"
        actions={
          <>
            <Badge>{project.palette.length} 色</Badge>
            <Button size="sm" icon="plus" onClick={openAddDialog}>
              添加颜色
            </Button>
          </>
        }
      >
        {project.palette.length === 0 ? (
          <EmptyState
            icon="palette"
            title="色板还没有颜色"
            description="可以从主色一键生成整套推荐色板，也可以手动添加指定颜色；推荐色板包含品牌主色、明暗阶与语义色。"
            action={
              <div className="palette-empty-actions">
                <Button variant="primary" icon="sparkles" onClick={applySuggestedPalette}>
                  应用推荐色板
                </Button>
                <Button icon="plus" onClick={openAddDialog}>
                  手动添加
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <div className="palette-cover-strip" title="色板掠影">
              {project.palette.map((color) => (
                <span key={color.id} style={{ background: color.hex }} title={`${color.name} ${color.hex}`} />
              ))}
            </div>
            <div className="palette-color-grid">
              {project.palette.map((color) => (
                <article key={color.id} className={cx('palette-color-card', color.locked && 'is-locked')}>
                  <button
                    type="button"
                    className="palette-color-swatch"
                    style={{ background: color.hex }}
                    title={`${SOURCE_LABELS[color.source ?? 'manual']} · 点击复制 ${color.hex}`}
                    onClick={() => void copy(color.hex)}
                  >
                    <span className="palette-color-copy" style={{ color: bestTextOn(color.hex) }}>
                      <Icon name="copy" size={12} /> 复制
                    </span>
                    {color.locked ? (
                      <span className="palette-color-lock" style={{ color: bestTextOn(color.hex) }}>
                        <Icon name="lock" size={12} />
                      </span>
                    ) : null}
                  </button>
                  <div className="palette-color-body">
                    <div className="palette-color-name-row">
                      {editingId === color.id ? (
                        <Input
                          className="palette-color-name-input"
                          value={nameDraft}
                          autoFocus
                          maxLength={24}
                          onChange={(event) => setNameDraft(event.target.value)}
                          onBlur={finishRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              ;(event.currentTarget as HTMLInputElement).blur()
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelRename()
                            }
                          }}
                        />
                      ) : (
                        <span
                          className="palette-color-name"
                          title="双击重命名"
                          onDoubleClick={() => startRename(color)}
                        >
                          {color.name}
                        </span>
                      )}
                      {editingId === color.id ? null : (
                        <IconButton
                          className="palette-color-edit"
                          icon="edit"
                          label="重命名"
                          size={13}
                          onClick={() => startRename(color)}
                        />
                      )}
                    </div>
                    <div className="palette-color-foot">
                      <CopyableColor hex={color.hex} size={11} />
                      <span className="palette-color-actions">
                        <IconButton
                          icon={color.locked ? 'lock' : 'unlock'}
                          label={color.locked ? '解锁颜色' : '锁定颜色'}
                          size={13}
                          active={Boolean(color.locked)}
                          onClick={() => toggleLock(color)}
                        />
                        <IconButton
                          icon="trash"
                          label="删除颜色"
                          size={13}
                          variant="danger"
                          onClick={() => requestDelete(color)}
                        />
                      </span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Panel>

      {/* ================= 明暗色阶 ================= */}
      <Panel
        title="主色明暗色阶"
        subtitle="OKLCH 感知均匀明度，50 最浅、950 最深；点击色块复制，或逐档加入色板"
        actions={
          <>
            <Badge tone={mode === 'dark' ? 'info' : 'default'}>
              <Icon name={mode === 'dark' ? 'moon' : 'sun'} size={11} />
              {mode === 'dark' ? '深色模式色阶' : '浅色模式色阶'}
            </Badge>
            <Badge>{TONAL_STEPS.length} 档位</Badge>
            <Button size="sm" icon="plus" onClick={addAllScaleColors}>
              全部加入色板
            </Button>
          </>
        }
      >
        <div className="palette-scale-grid">
          {TONAL_STEPS.map((step) => {
            const hex = tonalScale[String(step)] ?? baseColor
            return (
              <div key={step} className="palette-scale-cell">
                <button
                  type="button"
                  className="palette-scale-color"
                  style={{ background: hex }}
                  title={`${step} · ${hex}（点击复制）`}
                  onClick={() => void copy(hex)}
                >
                  <span className="palette-scale-copy" style={{ color: bestTextOn(hex) }}>
                    <Icon name="copy" size={12} />
                  </span>
                </button>
                <div className="palette-scale-meta">
                  <span className="mono palette-scale-step">{step}</span>
                  <button
                    type="button"
                    className="palette-scale-add"
                    title={`把 ${hex} 加入色板`}
                    onClick={() => addScaleColor(step, hex)}
                  >
                    <Icon name="plus" size={11} />
                  </button>
                </div>
                <button
                  type="button"
                  className="mono palette-scale-hex"
                  title="点击复制色值"
                  onClick={() => void copy(hex)}
                >
                  {hex}
                </button>
              </div>
            )
          })}
        </div>
      </Panel>

      {/* ================= 添加颜色弹窗 ================= */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加颜色"
        subtitle="把颜色加入项目色板，之后可在「控件配色」中绑定使用。"
        width={480}
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>取消</Button>
            <Button variant="primary" icon="plus" onClick={submitAddColor}>
              添加颜色
            </Button>
          </>
        }
      >
        <div className="palette-dialog-form">
          <ColorField label="颜色值" value={draftHex} onChange={setDraftHex} />
          <Field
            label="颜色名称"
            hint={`留空将自动命名，例如「${nameWithLevel(draftSafeHex)}」。`}
          >
            <Input
              value={draftName}
              placeholder={nameWithLevel(draftSafeHex)}
              maxLength={24}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitAddColor()
              }}
            />
          </Field>
          <div className="palette-dialog-quick">
            <span className="palette-dialog-quick-label">快捷取色</span>
            <div className="palette-dialog-quick-row">
              <button
                type="button"
                className="palette-quick-swatch is-primary"
                style={{ background: baseColor }}
                title={`主色 ${baseColor}`}
                onClick={() => setDraftHex(baseColor)}
              />
              {activeHarmony?.colors.slice(1).map((color) => (
                <button
                  key={color.hex}
                  type="button"
                  className="palette-quick-swatch"
                  style={{ background: color.hex }}
                  title={`${color.name} ${color.hex}`}
                  onClick={() => setDraftHex(color.hex)}
                />
              ))}
              {Object.entries(tonalScale)
                .filter(([step]) => step === '100' || step === '500' || step === '900')
                .map(([step, hex]) => (
                  <button
                    key={step}
                    type="button"
                    className="palette-quick-swatch"
                    style={{ background: hex }}
                    title={`主色 ${step} ${hex}`}
                    onClick={() => setDraftHex(hex)}
                  />
                ))}
            </div>
          </div>
          <div className="palette-dialog-preview" style={{ background: draftSafeHex }}>
            <span className="mono" style={{ color: bestTextOn(draftSafeHex) }}>
              {draftSafeHex} · {draftNameHint}
            </span>
          </div>
        </div>
      </Modal>

      {/* 被控件引用的颜色删除前二次确认 */}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除颜色"
        message={
          deleting
            ? `「${deleting.name}」正被 ${countPaletteRefs(deleting.id)} 个控件属性引用，删除后这些属性会被清空并需要重新绑定。确定删除吗？`
            : ''
        }
        confirmText="删除颜色"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
