/**
 * 控件配色视图
 *
 * 左侧：按分类浏览 24 个控件；中间：所选控件的大号实时预览；
 * 右侧：逐属性（part）绑定主题 Token / 项目色板 / 自定义颜色，并展示解析后的 HEX。
 *
 * 约定：
 * - 数据修改只走 useApp().actions；
 * - 所有控件属性颜色都经过 resolveColorRef()，未绑定（或引用失效）的属性回退到中性灰，
 *   并在右侧面板标注「未设置」，预览画布底部也会提示；
 * - 预览画布的底色取主题 background token，所以会跟随 props.mode 在明暗之间切换。
 */
import React, { useMemo, useState } from 'react'
import type { ColorRef, Project } from '../shared/types'
import { CONTROL_CATEGORIES, CONTROL_DEFS, defaultControlStyles } from '../core/controls'
import type { ControlDefinition } from '../core/controls'
import { resolveColorRef, tokenColor } from '../core/resolve'
import { bestTextOn, contrastRatio, mix, normalizeHex, withAlpha } from '../core/color'
import { ColorDot, ColorRefPicker, useColorCopy } from '../components/color-ui'
import { Button, ConfirmDialog, Icon, IconButton, cx, useToast } from '../components/ui'
import { useApp } from '../state/store'
import type { ProjectViewProps } from './types'

type Mode = 'light' | 'dark'

// ---------------------------------------------------------------------------
// 常量与回退色
// ---------------------------------------------------------------------------

/** 未绑定属性时的中性灰回退色（按属性语义区分明暗层次，保证预览仍可辨识） */
const PART_FALLBACKS: Record<string, string> = {
  // 大面积背景
  bg: '#C3C7CF',
  headerBg: '#D4D7DD',
  activeBg: '#AFB4BE',
  selectedBg: '#AFB4BE',
  track: '#B7BCC5',
  // 文字
  text: '#767D89',
  title: '#6C7380',
  placeholder: '#9AA0AB',
  activeText: '#F4F6F9',
  selectedText: '#F4F6F9',
  current: '#6C7380',
  // 线条 / 图标 / 强调
  border: '#A9AFB9',
  separator: '#A9AFB9',
  icon: '#8C929D',
  check: '#F4F6F9',
  dot: '#F4F6F9',
  thumb: '#F4F6F9',
  fill: '#9298A3',
  bar: '#9298A3',
  indicator: '#9298A3',
}
const DEFAULT_FALLBACK = '#B4B9C2'

function fallbackFor(partId: string): string {
  return PART_FALLBACKS[partId] ?? DEFAULT_FALLBACK
}

/** 主题缺失时用于辅助场景（标签、说明文字等）的中性色 */
const NEUTRAL = {
  light: {
    bg: '#F1F3F7',
    surface: '#FFFFFF',
    raised: '#FFFFFF',
    text: '#1A2231',
    muted: '#5B6675',
    border: '#DDE2EA',
    disabled: '#98A2B3',
  },
  dark: {
    bg: '#0F131A',
    surface: '#171C25',
    raised: '#1C222D',
    text: '#EAEEF5',
    muted: '#9AA6B8',
    border: '#2A3140',
    disabled: '#5C6879',
  },
}

/** 预览场景的辅助色：画布、标签文字、装饰等（不参与控件属性绑定） */
interface AuxColors {
  bg: string
  surface: string
  raised: string
  text: string
  muted: string
  border: string
  disabled: string
  strong: string
  onStrong: string
  accent: string
  success: string
  warning: string
  error: string
  info: string
}

interface PartState {
  id: string
  label: string
  hint?: string
  /** 当前绑定（可能为空） */
  ref?: ColorRef
  /** 该控件的默认绑定（theme 为空时 undefined） */
  defaultRef?: ColorRef
  /** 实际用于预览的 HEX（未绑定时为中性灰回退色） */
  hex: string
  /** 是否成功解析到真实颜色 */
  resolved: boolean
  /** 是否与默认绑定不同（用户自定义过） */
  custom: boolean
}

interface PreviewProps {
  c: Record<string, string>
  aux: AuxColors
  mode: Mode
  project: Project
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 安全取色：非法值回退到 fallback，避免数据异常导致预览崩溃 */
function safeColor(value: string | null | undefined, fallback: string): string {
  return normalizeHex(value ?? '') ?? fallback
}

/** 两个颜色引用是否等价 */
function sameRef(a?: ColorRef, b?: ColorRef): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'hex' && b.kind === 'hex') return a.value.toUpperCase() === b.value.toUpperCase()
  if (a.kind === 'palette' && b.kind === 'palette') return a.id === b.id
  if (a.kind === 'token' && b.kind === 'token') return a.key === b.key
  return false
}

/** 绑定来源的中文描述（用于右侧面板） */
function describeRef(ref: ColorRef | undefined, project: Project): string {
  if (!ref) return '未设置'
  if (ref.kind === 'hex') return '自定义颜色'
  if (ref.kind === 'palette') {
    const color = project.palette.find((item) => item.id === ref.id)
    return `色板 · ${color?.name ?? '已删除的颜色'}`
  }
  const token = project.theme?.tokens.find((item) => item.key === ref.key)
  return `主题 · ${token?.label ?? ref.key}`
}

/** 计算预览场景辅助色（跟随明暗模式） */
function buildAux(project: Project, mode: Mode): AuxColors {
  const theme = project.theme
  const neutral = NEUTRAL[mode]
  const strong = safeColor(tokenColor(theme, 'primary', mode) ?? project.baseColor, '#7C8798')
  return {
    bg: safeColor(tokenColor(theme, 'background', mode), neutral.bg),
    surface: safeColor(tokenColor(theme, 'surface', mode), neutral.surface),
    raised: safeColor(tokenColor(theme, 'surface-raised', mode), neutral.raised),
    text: safeColor(tokenColor(theme, 'text-primary', mode), neutral.text),
    muted: safeColor(tokenColor(theme, 'text-secondary', mode), neutral.muted),
    border: safeColor(tokenColor(theme, 'border', mode), neutral.border),
    disabled: safeColor(tokenColor(theme, 'text-disabled', mode), neutral.disabled),
    strong,
    onStrong: safeColor(tokenColor(theme, 'on-primary', mode), bestTextOn(strong)),
    accent: safeColor(tokenColor(theme, 'accent', mode) ?? tokenColor(theme, 'secondary', mode), strong),
    success: safeColor(tokenColor(theme, 'success', mode), '#2FBF71'),
    warning: safeColor(tokenColor(theme, 'warning', mode), '#F5A524'),
    error: safeColor(tokenColor(theme, 'error', mode), '#F0555F'),
    info: safeColor(tokenColor(theme, 'info', mode), '#38BDF8'),
  }
}

/** 计算单个控件所有属性的绑定状态 */
function buildPartStates(
  project: Project,
  def: ControlDefinition,
  mode: Mode,
  defaults: Record<string, Record<string, ColorRef | undefined>>,
): PartState[] {
  const current = project.controlStyles?.[def.id] ?? {}
  const base = defaults[def.id] ?? {}
  const ctx = { palette: project.palette, theme: project.theme, mode }
  return def.parts.map((part) => {
    const ref = current[part.id]
    const defaultRef = base[part.id]
    const resolvedHex = resolveColorRef(ref, ctx)
    return {
      id: part.id,
      label: part.label,
      hint: part.hint,
      ref,
      defaultRef,
      hex: resolvedHex ?? fallbackFor(part.id),
      resolved: resolvedHex !== null,
      custom: !sameRef(ref, defaultRef),
    }
  })
}

// ---------------------------------------------------------------------------
// 控件列表图标（自绘小图形，保持与 Icon 一致的描边风格）
// ---------------------------------------------------------------------------

const CONTROL_GLYPHS: Record<string, React.ReactNode> = {
  button: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="4" />
      <path d="M9 12h6" />
    </>
  ),
  input: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="3" />
      <path d="M7.5 10v4M11 12h5" />
    </>
  ),
  textarea: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M7 9.5h10M7 13h10M7 16.5h6" />
    </>
  ),
  select: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="3" />
      <path d="M7 12h6M14.5 10.5l2 2 2-2" />
    </>
  ),
  checkbox: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M8 12l2.8 2.8L16 9" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </>
  ),
  switch: (
    <>
      <rect x="2.5" y="7" width="19" height="10" rx="5" />
      <circle cx="16" cy="12" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  slider: (
    <>
      <path d="M3 12h18" />
      <circle cx="9" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  datepicker: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18M7 13h6M7 16h4" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14.5h18M9 9v11" />
    </>
  ),
  tag: (
    <>
      <path d="M20 12l-8 8-8-8V4h8z" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  badge: (
    <>
      <rect x="2.5" y="8" width="14" height="8" rx="4" />
      <circle cx="19.5" cy="8" r="2.6" />
    </>
  ),
  avatar: (
    <>
      <circle cx="12" cy="9" r="3.6" />
      <path d="M5 20c1.7-3.5 4.1-5.2 7-5.2s5.3 1.7 7 5.2" />
    </>
  ),
  progress: (
    <>
      <rect x="3" y="9" width="18" height="6" rx="3" />
      <path d="M6 12h7" />
    </>
  ),
  nav: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h2M12 6.5h2" />
    </>
  ),
  tabs: (
    <>
      <path d="M7 9V5h5v4M12 5h5v4" />
      <path d="M3 9h18v10H3z" />
    </>
  ),
  breadcrumb: (
    <>
      <path d="M3 12h4.5" />
      <path d="M9.5 8l4 4-4 4" />
      <path d="M17 12h4" />
    </>
  ),
  pagination: (
    <>
      <rect x="2.5" y="8" width="5" height="8" rx="1.6" />
      <rect x="9.5" y="8" width="5" height="8" rx="1.6" />
      <rect x="16.5" y="8" width="5" height="8" rx="1.6" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h.01" />
    </>
  ),
  modal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect x="8" y="9" width="8" height="6.5" rx="1.5" />
    </>
  ),
  tooltip: (
    <>
      <path d="M4 5h16v10h-8l-4 4v-4H4z" />
    </>
  ),
  toast: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="5" />
      <path d="M8 12l2.2 2.2L16 9.5" />
    </>
  ),
}

function ControlGlyph({ controlId, size = 16 }: { controlId: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {CONTROL_GLYPHS[controlId] ?? <rect x="3" y="3" width="18" height="18" rx="4" />}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 文本辅助
// ---------------------------------------------------------------------------

function mutedText(hex: string, bg: string): string {
  return mix(hex, bg, 0.42)
}

// ---------------------------------------------------------------------------
// 24 个控件的实时预览（全部颜色来自解析结果 c / aux）
// ---------------------------------------------------------------------------

function ButtonPreview({ c, aux }: PreviewProps) {
  const ratio = contrastRatio(c.text, c.bg)
  return (
    <div className="controls-ct-button">
      <div className="controls-ct-button-row">
        <button
          type="button"
          className="controls-ct-button-main"
          style={{
            background: c.bg,
            color: c.text,
            borderColor: c.border,
            boxShadow: `0 16px 32px -18px ${withAlpha(c.bg, 0.9)}`,
          }}
        >
          保存更改
        </button>
        <button
          type="button"
          className="controls-ct-button-secondary"
          style={{ background: withAlpha(aux.text, 0.05), color: aux.text, borderColor: c.border }}
        >
          取消
        </button>
      </div>
      <div className="controls-ct-button-meta" style={{ color: aux.muted }}>
        <span>
          文字 / 背景对比度 <strong style={{ color: aux.text }}>{ratio.toFixed(2)}:1</strong>
        </span>
        <span className="controls-ct-dot" style={{ background: aux.border }} />
        <span>主按钮 · 次要按钮</span>
      </div>
    </div>
  )
}

function InputPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-form">
      <div className="controls-ct-field">
        <label className="controls-ct-field-label" style={{ color: aux.muted }}>
          工作邮箱
        </label>
        <div
          className="controls-ct-input"
          style={{ background: c.bg, borderColor: c.border, color: c.text }}
        >
          <span>lin@palette.studio</span>
          <span className="controls-ct-caret" style={{ background: c.text }} />
        </div>
      </div>
      <div className="controls-ct-field">
        <label className="controls-ct-field-label" style={{ color: aux.muted }}>
          显示名称
        </label>
        <div
          className="controls-ct-input"
          style={{ background: c.bg, borderColor: c.border, color: c.text }}
        >
          <span style={{ color: c.placeholder }}>请输入团队或你的名称</span>
        </div>
      </div>
    </div>
  )
}

function TextareaPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-form">
      <div className="controls-ct-field">
        <label className="controls-ct-field-label" style={{ color: aux.muted }}>
          项目说明
        </label>
        <div
          className="controls-ct-textarea"
          style={{ background: c.bg, borderColor: c.border, color: c.text }}
        >
          <p style={{ color: c.text }}>为「极光蓝」生成的控件配色，用于后台管理系统。</p>
          <p style={{ color: mutedText(c.text, c.bg) }}>所有颜色都可以绑定到主题 Token，随明暗模式自动切换。</p>
        </div>
      </div>
      <div className="controls-ct-field">
        <div
          className="controls-ct-textarea is-empty"
          style={{ background: c.bg, borderColor: c.border }}
        >
          <p style={{ color: c.placeholder }}>补充说明（选填）</p>
          <span className="controls-ct-textarea-count" style={{ color: mutedText(c.text, c.bg) }}>
            0 / 200
          </span>
        </div>
      </div>
    </div>
  )
}

function SelectPreview({ c, aux }: PreviewProps) {
  const options = ['靛蓝 · 500', '天蓝 · 500', '翠绿 · 500']
  return (
    <div className="controls-ct-form controls-ct-select-wrap">
      <div className="controls-ct-field">
        <label className="controls-ct-field-label" style={{ color: aux.muted }}>
          主题色阶
        </label>
        <div
          className="controls-ct-select"
          style={{ background: c.bg, borderColor: c.border, color: c.text }}
        >
          <span>靛蓝 · 500</span>
          <Icon name="chevron-down" size={14} style={{ color: aux.muted }} />
        </div>
      </div>
      <div
        className="controls-ct-select-menu"
        style={{ background: aux.raised, borderColor: aux.border, boxShadow: `0 20px 40px -22px ${withAlpha('#000000', 0.6)}` }}
      >
        {options.map((option, index) => {
          const active = index === 0
          return (
            <div
              key={option}
              className="controls-ct-menu-item"
              style={
                active
                  ? { background: aux.strong, color: aux.onStrong }
                  : { color: aux.muted }
              }
            >
              <span>{option}</span>
              {active ? <Icon name="check" size={12} style={{ color: aux.onStrong }} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CheckboxPreview({ c, aux }: PreviewProps) {
  const items = [
    { label: '接收版本更新通知', checked: true },
    { label: '每周发送配色使用摘要', checked: true },
    { label: '参与产品体验改进计划', checked: false },
  ]
  return (
    <div className="controls-ct-choices">
      {items.map((item) => (
        <div key={item.label} className="controls-ct-choice">
          <span
            className="controls-ct-box"
            style={
              item.checked
                ? { background: c.bg, borderColor: c.border }
                : { background: 'transparent', borderColor: c.border }
            }
          >
            {item.checked ? <Icon name="check" size={12} strokeWidth={2.6} style={{ color: c.check }} /> : null}
          </span>
          <span style={{ color: aux.text }}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

function RadioPreview({ c, aux }: PreviewProps) {
  const items = [
    { label: '深色模式', checked: true },
    { label: '浅色模式', checked: false },
    { label: '跟随系统外观', checked: false },
  ]
  return (
    <div className="controls-ct-choices">
      {items.map((item) => (
        <div key={item.label} className="controls-ct-choice">
          <span
            className="controls-ct-radio"
            style={
              item.checked
                ? { background: c.bg, borderColor: c.bg }
                : { background: 'transparent', borderColor: c.border }
            }
          >
            {item.checked ? <span className="controls-ct-radio-dot" style={{ background: c.dot }} /> : null}
          </span>
          <span style={{ color: aux.text }}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

function SwitchPreview({ c, aux }: PreviewProps) {
  const offTrack = mix(c.track, aux.bg, 0.62)
  return (
    <div className="controls-ct-switches">
      <div className="controls-ct-switch-row">
        <span className="controls-ct-switch is-on" style={{ background: c.track }}>
          <span className="controls-ct-switch-thumb" style={{ background: c.thumb }} />
        </span>
        <div>
          <div style={{ color: aux.text }}>自动同步主题</div>
          <div className="controls-ct-switch-desc" style={{ color: aux.muted }}>
            修改主色后自动应用到全部控件
          </div>
        </div>
      </div>
      <div className="controls-ct-switch-row">
        <span
          className="controls-ct-switch"
          style={{ background: offTrack, border: `1px solid ${withAlpha(c.track, 0.4)}` }}
        >
          <span className="controls-ct-switch-thumb" style={{ background: c.thumb }} />
        </span>
        <div>
          <div style={{ color: aux.text }}>邮件通知</div>
          <div className="controls-ct-switch-desc" style={{ color: aux.muted }}>
            配色记录更新时发送提醒
          </div>
        </div>
      </div>
    </div>
  )
}

function SliderPreview({ c, aux }: PreviewProps) {
  const percent = 68
  return (
    <div className="controls-ct-slider-wrap">
      <div className="controls-ct-slider-head">
        <span style={{ color: aux.text }}>画布缩放</span>
        <span className="mono" style={{ color: aux.muted }}>
          {percent}%
        </span>
      </div>
      <div className="controls-ct-slider">
        <span className="controls-ct-slider-track" style={{ background: c.track }} />
        <span className="controls-ct-slider-fill" style={{ background: c.fill, width: `${percent}%` }} />
        <span className="controls-ct-slider-thumb" style={{ background: c.thumb, left: `${percent}%` }} />
        <span
          className="controls-ct-slider-bubble"
          style={{ background: c.fill, color: bestTextOn(c.fill), left: `${percent}%` }}
        >
          {percent}
        </span>
      </div>
      <div className="controls-ct-slider-scale" style={{ color: aux.muted }}>
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
    </div>
  )
}

function UploadPreview({ c }: PreviewProps) {
  return (
    <div
      className="controls-ct-upload"
      style={{ background: c.bg, borderColor: c.border, color: c.text }}
    >
      <span className="controls-ct-upload-icon" style={{ background: withAlpha(c.text, 0.12), color: c.text }}>
        <Icon name="upload" size={18} />
      </span>
      <div className="controls-ct-upload-title" style={{ color: c.text }}>
        点击或拖拽文件到此处
      </div>
      <div className="controls-ct-upload-hint" style={{ color: mutedText(c.text, c.bg) }}>
        支持 PNG / JPG / SVG，单个文件不超过 5 MB
      </div>
    </div>
  )
}

const DP_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
/** 2026 年 6 月 1 日是周一，所以不需要留空位 */
const DP_OFFSET = 0
const DP_DAYS = 30
const DP_SELECTED = 18
const DP_TODAY = 26

function DatepickerPreview({ c }: PreviewProps) {
  const cells: React.ReactNode[] = []
  for (let index = 0; index < DP_OFFSET; index += 1) {
    cells.push(<span key={`blank-${index}`} className="controls-ct-dp-cell is-out" />)
  }
  for (let day = 1; day <= DP_DAYS; day += 1) {
    const selected = day === DP_SELECTED
    const today = day === DP_TODAY
    cells.push(
      <span
        key={`day-${day}`}
        className={cx('controls-ct-dp-cell', selected && 'is-selected', today && 'is-today')}
        style={
          selected
            ? { background: c.selectedBg, color: c.selectedText }
            : { color: c.text, boxShadow: today ? `inset 0 0 0 1px ${withAlpha(c.text, 0.4)}` : undefined }
        }
      >
        {day}
      </span>,
    )
  }
  return (
    <div className="controls-ct-datepicker" style={{ background: c.bg, borderColor: c.border }}>
      <div className="controls-ct-dp-head">
        <Icon name="chevron-left" size={14} style={{ color: c.text }} />
        <span style={{ color: c.text }}>2026 年 6 月</span>
        <Icon name="chevron-right" size={14} style={{ color: c.text }} />
      </div>
      <div className="controls-ct-dp-week">
        {DP_WEEKDAYS.map((day) => (
          <span key={day} style={{ color: mutedText(c.text, c.bg) }}>
            {day}
          </span>
        ))}
      </div>
      <div className="controls-ct-dp-grid">{cells}</div>
      <div className="controls-ct-dp-foot" style={{ borderTopColor: c.border }}>
        <span style={{ color: mutedText(c.text, c.bg) }}>今天 · 6 月 {DP_TODAY} 日</span>
        <span className="controls-ct-dp-actions">
          <button type="button" className="controls-ct-dp-btn" style={{ color: c.text }}>
            取消
          </button>
          <button
            type="button"
            className="controls-ct-dp-btn is-primary"
            style={{ background: c.selectedBg, color: c.selectedText }}
          >
            确定
          </button>
        </span>
      </div>
    </div>
  )
}

function CardPreview({ c, aux }: PreviewProps) {
  const onCover = aux.onStrong
  return (
    <article className="controls-ct-card" style={{ background: c.bg, borderColor: c.border }}>
      <div
        className="controls-ct-card-cover"
        style={{ background: `linear-gradient(135deg, ${aux.strong} 0%, ${mix(aux.strong, '#0B1220', 0.34)} 100%)` }}
      >
        <span
          className="controls-ct-card-chip"
          style={{ background: withAlpha(onCover, 0.16), color: onCover, borderColor: withAlpha(onCover, 0.32) }}
        >
          品牌规范
        </span>
        <span className="controls-ct-card-cover-title" style={{ color: onCover }}>
          极光蓝
        </span>
      </div>
      <div className="controls-ct-card-body">
        <h4 className="controls-ct-card-title" style={{ color: c.title }}>
          极光蓝 · 设计规范
        </h4>
        <p className="controls-ct-card-text" style={{ color: c.text }}>
          一套可直接用于后台系统的控件配色，覆盖表单、导航、反馈与容器四大类。
        </p>
        <div className="controls-ct-card-foot">
          <span
            className="controls-ct-card-tag"
            style={{ borderColor: c.border, color: mutedText(c.text, c.bg) }}
          >
            v1.2
          </span>
          <span
            className="controls-ct-card-btn"
            style={{ background: aux.strong, color: aux.onStrong }}
          >
            查看详情
          </span>
        </div>
      </div>
    </article>
  )
}

function TablePreview({ c, aux, project }: PreviewProps) {
  const rows = [
    { name: '主色', hex: project.palette[0]?.hex ?? aux.strong, usage: '42%' },
    { name: '辅助色', hex: project.palette[1]?.hex ?? aux.accent, usage: '26%' },
    { name: '强调色', hex: project.palette[2]?.hex ?? aux.success, usage: '18%' },
  ]
  return (
    <div className="controls-ct-table" style={{ background: c.bg, borderColor: c.border }}>
      <div className="controls-ct-tr is-head" style={{ background: c.headerBg, color: bestTextOn(c.headerBg) }}>
        <span>颜色</span>
        <span>色值</span>
        <span>用量</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.name}
          className="controls-ct-tr"
          style={{ color: c.text, borderTop: `1px solid ${c.border}` }}
        >
          <span className="controls-ct-tr-name">
            <span className="controls-ct-tr-dot" style={{ background: row.hex }} />
            {row.name}
          </span>
          <span className="mono" style={{ color: mutedText(c.text, c.bg) }}>
            {row.hex}
          </span>
          <span style={{ color: mutedText(c.text, c.bg) }}>{row.usage}</span>
        </div>
      ))}
    </div>
  )
}

function TagPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-tags">
      <div className="controls-ct-tag-row">
        {['主色', '品牌升级', '可导出'].map((label) => (
          <span
            key={label}
            className="controls-ct-tag"
            style={{ background: c.bg, color: c.text, borderColor: c.border }}
          >
            {label}
          </span>
        ))}
        <span
          className="controls-ct-tag"
          style={{ background: c.bg, color: c.text, borderColor: c.border }}
        >
          测试中
          <Icon name="x" size={10} />
        </span>
      </div>
      <div className="controls-ct-tag-row">
        <span
          className="controls-ct-tag is-outline"
          style={{ background: 'transparent', color: c.text, borderColor: c.border }}
        >
          + 添加标签
        </span>
        <span style={{ color: aux.muted }}>标签用于轻量分类与状态标记</span>
      </div>
    </div>
  )
}

function BadgePreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-badges">
      <div className="controls-ct-badge-row">
        <span className="controls-ct-badge-pill" style={{ background: c.bg, color: c.text }}>
          12
        </span>
        <span className="controls-ct-badge-pill" style={{ background: c.bg, color: c.text }}>
          99+
        </span>
        <span className="controls-ct-badge-dot" style={{ background: c.bg }} />
        <span className="controls-ct-badge-label" style={{ color: aux.muted }}>
          数字 / 圆点 / 溢出计数
        </span>
      </div>
      <div className="controls-ct-badge-host" style={{ background: aux.surface, borderColor: aux.border }}>
        <span className="controls-ct-badge-host-icon" style={{ background: aux.raised, color: aux.muted }}>
          <Icon name="info" size={15} />
        </span>
        <span className="controls-ct-badge-host-text" style={{ color: aux.text }}>
          消息中心
        </span>
        <span className="controls-ct-badge-floating" style={{ background: c.bg, color: c.text }}>
          5
        </span>
      </div>
    </div>
  )
}

function AvatarPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-avatars">
      <div className="controls-ct-avatar-row">
        <span className="controls-ct-avatar is-lg" style={{ background: c.bg, color: c.text }}>
          极
          <span className="controls-ct-avatar-status" style={{ background: aux.success }} />
        </span>
        <span className="controls-ct-avatar is-md" style={{ background: c.bg, color: c.text }}>
          LC
        </span>
        <span className="controls-ct-avatar is-sm" style={{ background: c.bg, color: c.text }}>
          AB
        </span>
        <span
          className="controls-ct-avatar is-sm is-more"
          style={{ background: withAlpha(c.bg, 0.32), color: aux.text }}
        >
          +6
        </span>
      </div>
      <div className="controls-ct-avatar-meta">
        <span style={{ color: aux.text }}>林澈</span>
        <span style={{ color: aux.muted }}>产品设计 · 正在编辑「极光蓝」</span>
      </div>
    </div>
  )
}

function ProgressPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-progress">
      <div className="controls-ct-progress-head">
        <span style={{ color: aux.text }}>同步全局配色</span>
        <span className="mono" style={{ color: aux.muted }}>
          72%
        </span>
      </div>
      <div className="controls-ct-progress-track" style={{ background: c.track }}>
        <span className="controls-ct-progress-bar" style={{ background: c.bar, width: '72%' }} />
      </div>
      <div className="controls-ct-progress-foot" style={{ color: aux.muted }}>
        正在同步 18 / 25 个控件…
      </div>
    </div>
  )
}

function NavPreview({ c, aux }: PreviewProps) {
  const links = ['工作台', '色板', '主题', '控件配色']
  return (
    <div className="controls-ct-nav" style={{ background: c.bg, borderColor: aux.border }}>
      <div className="controls-ct-nav-brand">
        <span className="controls-ct-nav-logo" style={{ background: aux.strong, color: aux.onStrong }}>
          配
        </span>
        <span style={{ color: aux.text }}>配色工坊</span>
      </div>
      <div className="controls-ct-nav-links">
        {links.map((link, index) => {
          const active = index === 3
          return (
            <span
              key={link}
              className={cx('controls-ct-nav-link', active && 'is-active')}
              style={active ? { background: c.activeBg, color: c.activeText } : { color: c.text }}
            >
              {link}
            </span>
          )
        })}
      </div>
      <span className="controls-ct-nav-avatar" style={{ background: aux.strong, color: aux.onStrong }}>
        L
      </span>
    </div>
  )
}

function TabsPreview({ c, aux }: PreviewProps) {
  const tabs = ['色板', '主题', '控件配色', '导出']
  return (
    <div className="controls-ct-tabs-wrap">
      <div className="controls-ct-tabs" style={{ background: c.bg, borderBottomColor: aux.border }}>
        {tabs.map((tab, index) => {
          const active = index === 2
          return (
            <span
              key={tab}
              className={cx('controls-ct-tab', active && 'is-active')}
              style={active ? { color: c.activeText } : { color: c.text }}
            >
              {tab}
              {active ? (
                <span className="controls-ct-tab-indicator" style={{ background: c.indicator }} />
              ) : null}
            </span>
          )
        })}
      </div>
      <div className="controls-ct-tabs-body" style={{ background: aux.surface, borderColor: aux.border }}>
        <span className="controls-ct-tabs-line" style={{ background: withAlpha(aux.text, 0.1) }} />
        <span className="controls-ct-tabs-line is-short" style={{ background: withAlpha(aux.text, 0.07) }} />
      </div>
    </div>
  )
}

function BreadcrumbPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-breadcrumb">
      <div className="controls-ct-breadcrumb-row">
        <span style={{ color: c.text }}>项目总览</span>
        <span style={{ color: c.separator }}>/</span>
        <span style={{ color: c.text }}>极光蓝 · 示例项目</span>
        <span style={{ color: c.separator }}>/</span>
        <span style={{ color: c.current, fontWeight: 600 }}>控件配色</span>
      </div>
      <div className="controls-ct-breadcrumb-row">
        <span style={{ color: c.text }}>工作台</span>
        <Icon name="chevron-right" size={12} style={{ color: c.separator }} />
        <span style={{ color: c.text }}>色板</span>
        <Icon name="chevron-right" size={12} style={{ color: c.separator }} />
        <span style={{ color: c.current, fontWeight: 600 }}>靛蓝 500</span>
      </div>
      <div className="controls-ct-breadcrumb-note" style={{ color: aux.muted }}>
        分隔符颜色独立于普通层级文字，可单独调淡
      </div>
    </div>
  )
}

function PaginationPreview({ c, aux }: PreviewProps) {
  const pages = [1, 2, 3, 4, 5]
  return (
    <div className="controls-ct-pagination">
      <div className="controls-ct-pagination-row">
        <span
          className="controls-ct-page is-nav"
          style={{ background: c.bg, color: c.text, borderColor: c.border }}
        >
          <Icon name="chevron-left" size={13} />
        </span>
        {pages.map((page) => {
          const active = page === 2
          return (
            <span
              key={page}
              className={cx('controls-ct-page', active && 'is-active')}
              style={
                active
                  ? { background: c.activeBg, color: c.activeText, borderColor: 'transparent' }
                  : { background: c.bg, color: c.text, borderColor: c.border }
              }
            >
              {page}
            </span>
          )
        })}
        <span className="controls-ct-page is-plain" style={{ color: c.text }}>
          …
        </span>
        <span
          className="controls-ct-page"
          style={{ background: c.bg, color: c.text, borderColor: c.border }}
        >
          12
        </span>
        <span
          className="controls-ct-page is-nav"
          style={{ background: c.bg, color: c.text, borderColor: c.border }}
        >
          <Icon name="chevron-right" size={13} />
        </span>
      </div>
      <div className="controls-ct-pagination-note" style={{ color: aux.muted }}>
        共 118 条记录 · 每页 10 条
      </div>
    </div>
  )
}

function AlertPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-alert" style={{ background: c.bg, borderColor: c.border }}>
      <span className="controls-ct-alert-icon" style={{ background: withAlpha(c.icon, 0.16), color: c.icon }}>
        <Icon name="info" size={16} />
      </span>
      <div className="controls-ct-alert-body">
        <div className="controls-ct-alert-title" style={{ color: c.text }}>
          主题已更新
        </div>
        <p style={{ color: mutedText(c.text, c.bg) }}>
          新的语义 Token 已应用到 24 个控件，需要回滚时可在「记录」中恢复上一版配色。
        </p>
      </div>
      <Icon name="x" size={13} style={{ color: mutedText(c.text, c.bg), flex: '0 0 auto' }} />
      <span className="controls-ct-alert-note" style={{ color: aux.muted }}>
        提示条
      </span>
    </div>
  )
}

function ModalPreview({ c, aux, mode }: PreviewProps) {
  const backdrop = withAlpha('#000000', mode === 'dark' ? 0.5 : 0.3)
  return (
    <div className="controls-ct-modal-scene">
      <div className="controls-ct-modal-page" style={{ background: aux.surface, borderColor: aux.border }}>
        <span style={{ background: withAlpha(aux.text, 0.12) }} />
        <span style={{ background: withAlpha(aux.text, 0.08) }} />
        <span style={{ background: withAlpha(aux.text, 0.08) }} />
      </div>
      <div className="controls-ct-modal-backdrop" style={{ background: backdrop }} />
      <div
        className="controls-ct-modal"
        style={{
          background: c.bg,
          borderColor: c.border,
          boxShadow: `0 30px 60px -24px ${withAlpha('#000000', 0.55)}`,
        }}
      >
        <div className="controls-ct-modal-head">
          <h4 style={{ color: c.title }}>删除这个色板？</h4>
          <Icon name="x" size={13} style={{ color: mutedText(c.text, c.bg) }} />
        </div>
        <p className="controls-ct-modal-text" style={{ color: c.text }}>
          删除后，绑定到该颜色的控件属性会自动回退到默认主题 Token，此操作不可撤销。
        </p>
        <div className="controls-ct-modal-foot">
          <span
            className="controls-ct-modal-btn"
            style={{
              background: withAlpha(c.text, 0.06),
              color: c.text,
              border: `1px solid ${c.border}`,
            }}
          >
            取消
          </span>
          <span className="controls-ct-modal-btn is-primary" style={{ background: aux.strong, color: aux.onStrong }}>
            确认删除
          </span>
        </div>
      </div>
    </div>
  )
}

function TooltipPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-tooltip-scene">
      <div className="controls-ct-tooltip-bubble" style={{ background: c.bg, color: c.text }}>
        绑定到主题 Token 后，会自动适配浅色与深色模式
        <span className="controls-ct-tooltip-arrow" style={{ background: c.bg }} />
      </div>
      <div className="controls-ct-tooltip-trigger">
        <span
          className="controls-ct-tooltip-btn"
          style={{ background: aux.surface, color: aux.text, borderColor: aux.border }}
        >
          <Icon name="info" size={13} /> 悬停查看提示
        </span>
        <span className="controls-ct-tooltip-note" style={{ color: aux.muted }}>
          气泡提示 · 深色反色的默认搭配
        </span>
      </div>
    </div>
  )
}

function ToastPreview({ c, aux }: PreviewProps) {
  return (
    <div className="controls-ct-toast-scene">
      <div
        className="controls-ct-toast"
        style={{
          background: c.bg,
          color: c.text,
          borderColor: withAlpha(c.text, 0.12),
          boxShadow: `0 22px 44px -26px ${withAlpha('#000000', 0.5)}`,
        }}
      >
        <span className="controls-ct-toast-icon" style={{ color: aux.success }}>
          <Icon name="success" size={16} />
        </span>
        <span style={{ color: c.text }}>已复制 #4F7CFF 到剪贴板</span>
        <Icon name="x" size={12} style={{ color: mutedText(c.text, c.bg) }} />
      </div>
      <div
        className="controls-ct-toast is-secondary"
        style={{
          background: c.bg,
          color: c.text,
          borderColor: withAlpha(c.text, 0.12),
          boxShadow: `0 22px 44px -26px ${withAlpha('#000000', 0.5)}`,
        }}
      >
        <span className="controls-ct-toast-icon" style={{ color: aux.info }}>
          <Icon name="info" size={16} />
        </span>
        <span style={{ color: c.text }}>配色已自动保存到本地</span>
      </div>
      <div className="controls-ct-toast-note" style={{ color: aux.muted }}>
        轻提示在操作后短暂出现，2.4 秒自动消失
      </div>
    </div>
  )
}

/** 控件 id → 预览组件 */
const CONTROL_PREVIEWS: Record<string, React.ComponentType<PreviewProps>> = {
  button: ButtonPreview,
  input: InputPreview,
  textarea: TextareaPreview,
  select: SelectPreview,
  checkbox: CheckboxPreview,
  radio: RadioPreview,
  switch: SwitchPreview,
  slider: SliderPreview,
  upload: UploadPreview,
  datepicker: DatepickerPreview,
  card: CardPreview,
  table: TablePreview,
  tag: TagPreview,
  badge: BadgePreview,
  avatar: AvatarPreview,
  progress: ProgressPreview,
  nav: NavPreview,
  tabs: TabsPreview,
  breadcrumb: BreadcrumbPreview,
  pagination: PaginationPreview,
  alert: AlertPreview,
  modal: ModalPreview,
  tooltip: TooltipPreview,
  toast: ToastPreview,
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export default function ControlsView({ project, mode }: ProjectViewProps) {
  const { actions } = useApp()
  const { toast } = useToast()
  const copy = useColorCopy()
  const [selectedId, setSelectedId] = useState<string>(CONTROL_DEFS[0].id)
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  /** 默认绑定（theme 为空时为空对象） */
  const defaults = useMemo(() => defaultControlStyles(project.theme), [project.theme])

  /** 每个控件、每个属性的绑定状态 */
  const controlStates = useMemo(() => {
    const result: Record<string, PartState[]> = {}
    for (const def of CONTROL_DEFS) {
      result[def.id] = buildPartStates(project, def, mode, defaults)
    }
    return result
  }, [project, mode, defaults])

  /** 自定义属性数量统计 */
  const customized = useMemo(() => {
    const byControl: Record<string, number> = {}
    let total = 0
    for (const def of CONTROL_DEFS) {
      const count = (controlStates[def.id] ?? []).filter((state) => state.custom).length
      byControl[def.id] = count
      total += count
    }
    return { byControl, total }
  }, [controlStates])

  /** 预览场景辅助色（跟随 props.mode） */
  const aux = useMemo(() => buildAux(project, mode), [project, mode])

  const selectedDef = CONTROL_DEFS.find((def) => def.id === selectedId) ?? CONTROL_DEFS[0]
  const selectedStates = controlStates[selectedDef.id] ?? []
  const selectedCustom = customized.byControl[selectedDef.id] ?? 0
  const selectedCategory = CONTROL_CATEGORIES.find((item) => item.id === selectedDef.category)?.label ?? ''

  /** 预览颜色：属性 id → 实际 HEX（未绑定用中性灰） */
  const preview = useMemo(() => {
    const colors: Record<string, string> = {}
    const fallbackIds: string[] = []
    for (const state of selectedStates) {
      colors[state.id] = state.hex
      if (!state.resolved) fallbackIds.push(state.id)
    }
    return { colors, fallbackIds }
  }, [selectedStates])

  const Preview = CONTROL_PREVIEWS[selectedDef.id]
  const totalParts = CONTROL_DEFS.reduce((sum, def) => sum + def.parts.length, 0)
  const themeReady = Boolean(project.theme)

  const updatePart = (partId: string, ref: ColorRef | null) => {
    actions.setControlColor(project.id, selectedDef.id, partId, ref)
  }

  const resetControl = () => {
    if (!project.theme) {
      toast('请先生成语义主题，才能恢复默认绑定', 'warning')
      return
    }
    const base = defaults[selectedDef.id] ?? {}
    actions.replaceControlStyles(project.id, {
      ...(project.controlStyles ?? {}),
      [selectedDef.id]: { ...base },
    })
    toast(`「${selectedDef.name}」已重置为默认配色`, 'success')
  }

  const resetPart = (partId: string, defaultRef: ColorRef | undefined) => {
    actions.setControlColor(project.id, selectedDef.id, partId, defaultRef ?? null)
    toast(defaultRef ? '已恢复该属性的默认绑定' : '已清除该属性的绑定')
  }

  const resetAll = () => {
    if (!project.theme) {
      toast('请先生成语义主题，才能恢复默认绑定', 'warning')
      return
    }
    actions.replaceControlStyles(project.id, defaultControlStyles(project.theme))
    setConfirmResetAll(false)
    toast(`已把 ${CONTROL_DEFS.length} 个控件重置为默认配色`, 'success')
  }

  return (
    <div className="controls-view page-enter">
      {!themeReady ? (
        <div className="controls-banner">
          <Icon name="info" size={15} />
          <span>
            当前项目还没有生成语义主题：仍可把属性绑定到项目色板或自定义颜色；生成主题后即可获得每个控件的默认
            Token 绑定与「重置为默认」能力。
          </span>
        </div>
      ) : null}

      <div className="controls-head">
        <div className="controls-head-text">
          <h2 className="controls-head-title">控件配色</h2>
          <p className="controls-head-sub">
            为每个控件属性绑定主题 Token、项目色板或自定义颜色，中间实时预览，右侧逐项微调。
          </p>
        </div>
        <div className="controls-head-actions">
          <div className="controls-head-stats">
            <span>
              <strong>{CONTROL_DEFS.length}</strong> 控件
            </span>
            <span>
              <strong>{totalParts}</strong> 属性
            </span>
            <span className={cx('controls-head-stat', customized.total > 0 && 'is-accent')}>
              <strong>{customized.total}</strong> 已自定义
            </span>
          </div>
          <Button
            size="sm"
            icon="refresh"
            disabled={!themeReady || customized.total === 0}
            title={!themeReady ? '生成主题后可恢复默认绑定' : '把所有控件恢复为默认主题绑定'}
            onClick={() => setConfirmResetAll(true)}
          >
            全部重置为默认
          </Button>
        </div>
      </div>

      <div className="controls-layout">
        {/* ---------- 左侧：控件列表 ---------- */}
        <aside className="panel controls-rail">
          <header className="panel-header controls-rail-head">
            <div className="panel-heading">
              <h3 className="panel-title">控件</h3>
              <p className="panel-subtitle">按分类浏览 · 共 {CONTROL_DEFS.length} 个</p>
            </div>
          </header>
          <div className="controls-rail-scroll">
            {CONTROL_CATEGORIES.map((category) => {
              const defs = CONTROL_DEFS.filter((def) => def.category === category.id)
              if (defs.length === 0) return null
              return (
                <div key={category.id} className="controls-rail-group">
                  <div className="controls-rail-group-title">{category.label}</div>
                  {defs.map((def) => {
                    const count = customized.byControl[def.id] ?? 0
                    const active = def.id === selectedDef.id
                    return (
                      <button
                        key={def.id}
                        type="button"
                        className={cx('controls-nav-item', active && 'is-active')}
                        aria-current={active ? 'true' : undefined}
                        title={def.description}
                        onClick={() => setSelectedId(def.id)}
                      >
                        <span className="controls-nav-glyph">
                          <ControlGlyph controlId={def.id} size={15} />
                        </span>
                        <span className="controls-nav-name">{def.name}</span>
                        {count > 0 ? <span className="controls-nav-count">{count}</span> : null}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </aside>

        {/* ---------- 中间：实时预览 ---------- */}
        <section className="panel controls-preview">
          <header className="panel-header controls-preview-head">
            <div className="controls-preview-title">
              <span className="controls-preview-glyph">
                <ControlGlyph controlId={selectedDef.id} size={18} />
              </span>
              <div className="controls-preview-title-text">
                <h3 className="panel-title">
                  {selectedDef.name}
                  <span className="badge">{selectedCategory}</span>
                </h3>
                <p className="panel-subtitle">{selectedDef.description}</p>
              </div>
            </div>
            <div className="controls-preview-meta">
              <span className="controls-mode-chip">
                <Icon name={mode === 'dark' ? 'moon' : 'sun'} size={12} />
                {mode === 'dark' ? '深色预览' : '浅色预览'}
              </span>
              <span className={cx('controls-custom-chip', selectedCustom > 0 && 'is-accent')}>
                {selectedCustom > 0 ? `${selectedCustom} 项自定义` : '全部默认'}
              </span>
            </div>
          </header>

          <div className="controls-preview-body">
            <div className="controls-stage" style={{ background: aux.bg }}>
              <div
                className="controls-stage-decor"
                style={{
                  backgroundImage: `radial-gradient(${withAlpha(aux.text, 0.085)} 1px, transparent 1px)`,
                }}
              />
              <div
                className="controls-stage-glow"
                style={{
                  background: `radial-gradient(560px 260px at 50% -12%, ${withAlpha(
                    aux.strong,
                    mode === 'dark' ? 0.22 : 0.12,
                  )}, transparent 70%)`,
                }}
              />
              <span className="controls-stage-tag" style={{ color: aux.disabled }}>
                实时预览
              </span>
              <span className="controls-stage-tag is-right mono" style={{ color: aux.disabled }}>
                {selectedDef.id}
              </span>
              <div className="controls-preview-root">
                {Preview ? <Preview c={preview.colors} aux={aux} mode={mode} project={project} /> : null}
              </div>
              {preview.fallbackIds.length > 0 ? (
                <div className="controls-stage-note" style={{ color: aux.disabled }}>
                  <Icon name="warning" size={12} />
                  {preview.fallbackIds.length} 个属性未设置，预览以中性灰回退
                </div>
              ) : null}
            </div>

            <div className="controls-preview-foot">
              <span className="controls-preview-foot-item">
                <Icon name="palette" size={12} />
                画布取主题 <code className="mono">background</code> 色，随明暗模式切换
              </span>
              <span className="controls-preview-foot-item">
                <Icon name="layers" size={12} />
                {selectedStates.length} 个属性
              </span>
            </div>
          </div>
        </section>

        {/* ---------- 右侧：属性配色 ---------- */}
        <aside className="panel controls-props">
          <header className="panel-header controls-props-head">
            <div className="panel-heading">
              <h3 className="panel-title">属性配色</h3>
              <p className="panel-subtitle">
                {selectedDef.name} · {selectedStates.length} 个属性
              </p>
            </div>
            <div className="panel-actions">
              <Button
                size="xs"
                variant="secondary"
                icon="refresh"
                disabled={!themeReady || selectedCustom === 0}
                title={!themeReady ? '生成主题后可恢复默认绑定' : '把这个控件恢复为默认主题绑定'}
                onClick={resetControl}
              >
                重置此控件
              </Button>
            </div>
          </header>

          <div className="controls-props-scroll">
            {selectedStates.map((state) => {
              const stateLabel = !state.ref
                ? '未设置'
                : !state.resolved
                  ? '引用失效'
                  : state.custom
                    ? '已自定义'
                    : '默认'
              return (
                <div
                  key={state.id}
                  className={cx(
                    'controls-prop',
                    !state.ref && 'is-unset',
                    state.ref && !state.resolved && 'is-invalid',
                  )}
                >
                  <div className="controls-prop-head">
                    <div className="controls-prop-title">
                      <span className="controls-prop-name">{state.label}</span>
                      <span
                        className={cx(
                          'controls-prop-state',
                          !state.ref && 'is-unset',
                          state.ref && !state.resolved && 'is-invalid',
                          state.ref && state.resolved && state.custom && 'is-custom',
                        )}
                      >
                        {stateLabel}
                      </span>
                    </div>
                    {state.custom && themeReady ? (
                      <IconButton
                        icon="refresh"
                        label="恢复默认绑定"
                        size={13}
                        onClick={() => resetPart(state.id, state.defaultRef)}
                      />
                    ) : null}
                  </div>

                  <ColorRefPicker
                    value={state.ref}
                    onChange={(ref) => updatePart(state.id, ref)}
                    project={project}
                    mode={mode}
                  />

                  <div className="controls-prop-resolved">
                    <ColorDot hex={state.hex} size={14} radius={4} border />
                    <button
                      type="button"
                      className={cx('controls-prop-hex mono', !state.resolved && 'is-fallback')}
                      title={state.resolved ? '点击复制色值' : '该属性未设置，当前显示中性灰回退色'}
                      onClick={() => void copy(state.hex)}
                    >
                      {state.hex}
                    </button>
                    <span className="controls-prop-origin">{describeRef(state.ref, project)}</span>
                    <IconButton
                      icon="copy"
                      label="复制解析后的色值"
                      size={13}
                      onClick={() => void copy(state.hex)}
                    />
                  </div>

                  {state.hint ? <div className="controls-prop-hint">{state.hint}</div> : null}
                </div>
              )
            })}
          </div>

          <footer className="controls-props-foot">
            <Icon name="info" size={12} />
            <span>未绑定的属性以中性灰回退；点击 HEX 可直接复制解析结果。</span>
          </footer>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmResetAll}
        title="全部重置为默认"
        message={`将把 ${CONTROL_DEFS.length} 个控件的全部 ${totalParts} 个属性恢复为默认主题绑定，你手动绑定的色板与自定义颜色会丢失。确定继续吗？`}
        confirmText="全部重置"
        danger
        onCancel={() => setConfirmResetAll(false)}
        onConfirm={resetAll}
      />
    </div>
  )
}
