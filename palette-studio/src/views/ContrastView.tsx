/**
 * 对比度检查（ContrastView）
 *
 * 核心能力：
 * - 任意前景 / 背景色的 WCAG 2.1 对比度计算，大号比值 + AA / AAA 判定；
 * - 三种字号的文本示例预览，直观感受实际可读性；
 * - 从主题语义色 / 项目色板快捷取色，支持交换前景与背景、恢复默认组合；
 * - 项目组合体检：自动检查当前主题常用组合，不达标时基于色相搜索最近达标色作为建议。
 *
 * 说明：所有颜色都按 props.mode（工作台当前预览模式）从主题 token 中解析。
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { Project } from '../shared/types'
import {
  bestTextOn,
  clamp,
  contrastRatio,
  getContrastResult,
  hexToOklch,
  isDark,
  oklchToHex,
} from '../core/color'
import { tokenColor } from '../core/resolve'
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Panel,
  Segmented,
  cx,
  useToast,
} from '../components/ui'
import { ColorDot, ColorField, CopyableColor, useColorCopy } from '../components/color-ui'
import type { ProjectViewProps } from './types'

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

type PreviewMode = 'light' | 'dark'
type PickTarget = 'fg' | 'bg'
type LevelTone = 'success' | 'accent' | 'warning' | 'danger'

interface ColorPairState {
  fg: string
  bg: string
  /** 若颜色来自主题 token，记录 key，切换明暗模式时自动重新解析 */
  fgToken: string | null
  bgToken: string | null
}

interface AuditDef {
  id: string
  label: string
  fgKey: string
  bgKey: string
  /** 达标目标：正文 4.5，大字 / 非文本 3 */
  target: number
  note: string
}

interface AuditRow extends AuditDef {
  fgHex: string
  bgHex: string
  ratio: number
  pass: boolean
  suggestion: string | null
}

interface LevelInfo {
  text: string
  tone: LevelTone
}

/** 组合体检项目：覆盖文字、按钮、边框与语义色的常用搭配 */
const AUDIT_ITEMS: AuditDef[] = [
  {
    id: 'text-background',
    label: '正文 / 页面背景',
    fgKey: 'text-primary',
    bgKey: 'background',
    target: 4.5,
    note: 'text-primary · background',
  },
  {
    id: 'secondary-background',
    label: '次要文字 / 页面背景',
    fgKey: 'text-secondary',
    bgKey: 'background',
    target: 4.5,
    note: 'text-secondary · background',
  },
  {
    id: 'text-surface',
    label: '正文 / 卡片表面',
    fgKey: 'text-primary',
    bgKey: 'surface',
    target: 4.5,
    note: 'text-primary · surface',
  },
  {
    id: 'secondary-surface',
    label: '次要文字 / 卡片表面',
    fgKey: 'text-secondary',
    bgKey: 'surface',
    target: 4.5,
    note: 'text-secondary · surface',
  },
  {
    id: 'on-primary',
    label: '按钮文字 / 主色按钮',
    fgKey: 'on-primary',
    bgKey: 'primary',
    target: 4.5,
    note: 'on-primary · primary',
  },
  {
    id: 'border-surface',
    label: '边框 / 卡片表面',
    fgKey: 'border',
    bgKey: 'surface',
    target: 3,
    note: 'border · surface（非文本 3:1）',
  },
  {
    id: 'primary-surface',
    label: '主色图标 / 卡片表面',
    fgKey: 'primary',
    bgKey: 'surface',
    target: 3,
    note: 'primary · surface（非文本 3:1）',
  },
  {
    id: 'error-background',
    label: '错误色 / 页面背景',
    fgKey: 'error',
    bgKey: 'background',
    target: 3,
    note: 'error · background（非文本 3:1）',
  },
]

/** 对比度刻度条上的关键阈值 */
const METER_TICKS: { value: number; label: string }[] = [
  { value: 3, label: '3:1 · 大字 AA' },
  { value: 4.5, label: '4.5:1 · 正文 AA' },
  { value: 7, label: '7:1 · 正文 AAA' },
]

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/** 初始颜色组合：优先使用当前模式的主题文字 / 背景 token，否则取色板前两个颜色 */
function initialPair(project: Project, mode: PreviewMode): ColorPairState {
  const theme = project.theme
  if (theme) {
    const fg = tokenColor(theme, 'text-primary', mode)
    const bg = tokenColor(theme, 'background', mode)
    if (fg && bg) {
      return { fg, bg, fgToken: 'text-primary', bgToken: 'background' }
    }
  }
  const first = project.palette[0]?.hex ?? '#111827'
  const second = project.palette[1]?.hex ?? '#FFFFFF'
  return { fg: first, bg: second, fgToken: null, bgToken: null }
}

/**
 * 在保持色相 / 饱和度的前提下，沿明度方向搜索最近的可达标颜色。
 * 背景偏亮时向暗处找，背景偏暗时向亮处找；找不到再反向兜底。
 */
function suggestAccessibleColor(fg: string, bg: string, target: number): string | null {
  if (contrastRatio(fg, bg) >= target) return null
  const base = hexToOklch(fg)
  const direction = isDark(bg) ? 1 : -1
  const search = (dir: number): string | null => {
    for (let step = 1; step <= 60; step += 1) {
      const lightness = clamp(base.l + dir * step * 0.016, 0.015, 0.985)
      const candidate = oklchToHex({ l: lightness, c: base.c, h: base.h })
      if (contrastRatio(candidate, bg) >= target) return candidate
      if ((dir > 0 && lightness >= 0.985) || (dir < 0 && lightness <= 0.015)) break
    }
    return null
  }
  return search(direction) ?? search(-direction) ?? bestTextOn(bg)
}

/** 大字（≥24px / 18.66px 粗体）的 WCAG 判定 */
function largeTextLevel(ratio: number): LevelInfo {
  if (ratio >= 4.5) return { text: 'AAA', tone: 'success' }
  if (ratio >= 3) return { text: 'AA', tone: 'accent' }
  return { text: '不达标', tone: 'danger' }
}

/** 正文（< 24px）的 WCAG 判定 */
function bodyTextLevel(ratio: number): LevelInfo {
  if (ratio >= 7) return { text: 'AAA', tone: 'success' }
  if (ratio >= 4.5) return { text: 'AA', tone: 'accent' }
  if (ratio >= 3) return { text: '仅大字 AA', tone: 'warning' }
  return { text: '不达标', tone: 'danger' }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export default function ContrastView({ project, mode }: ProjectViewProps) {
  const copy = useColorCopy()
  const { toast } = useToast()

  const [pair, setPair] = useState<ColorPairState>(() => initialPair(project, mode))
  /** 快捷取色的目标：应用到前景色还是背景色 */
  const [target, setTarget] = useState<PickTarget>('fg')

  // 切换深浅模式时，来自主题 token 的颜色自动跟随刷新
  useEffect(() => {
    setPair((current) => {
      let next = current
      if (current.fgToken) {
        const resolved = tokenColor(project.theme, current.fgToken, mode)
        if (resolved && resolved !== next.fg) next = { ...next, fg: resolved }
      }
      if (current.bgToken) {
        const resolved = tokenColor(project.theme, current.bgToken, mode)
        if (resolved && resolved !== next.bg) next = { ...next, bg: resolved }
      }
      return next
    })
  }, [mode, project.theme])

  const result = getContrastResult(pair.fg, pair.bg)
  const modeName = mode === 'dark' ? '深色' : '浅色'

  const tokenLabel = (key: string | null): string => {
    if (!key) return ''
    return project.theme?.tokens.find((token) => token.key === key)?.label ?? key
  }

  const pointerPercent = clamp((result.ratio - 1) / 20, 0, 1) * 100

  const verdictClass =
    result.level === 'AAA'
      ? 'is-aaa'
      : result.level === 'AA'
        ? 'is-aa'
        : result.level === 'AA-large'
          ? 'is-large'
          : 'is-fail'
  const verdictText =
    result.level === 'AAA'
      ? 'AAA'
      : result.level === 'AA'
        ? 'AA'
        : result.level === 'AA-large'
          ? 'AA 大字'
          : '不达标'
  const verdictSub =
    result.level === 'AAA'
      ? '正文与大字均达最高级别'
      : result.level === 'AA'
        ? '正文达标，大字可达 AAA'
        : result.level === 'AA-large'
          ? '仅大字文本可读'
          : '正文与大字均不达标'

  const criteria = [
    { label: '正文 AA', requirement: '≥ 4.5:1', passed: result.aa },
    { label: '正文 AAA', requirement: '≥ 7:1', passed: result.aaa },
    { label: '大字 AA', requirement: '≥ 3:1', passed: result.aaLarge },
    { label: '大字 AAA', requirement: '≥ 4.5:1', passed: result.aaaLarge },
  ]

  const tokenItems = useMemo(
    () =>
      (project.theme?.tokens ?? []).map((token) => ({
        key: token.key,
        label: token.label,
        hex: mode === 'dark' ? token.dark : token.light,
      })),
    [project.theme, mode],
  )

  // ---- 交互 ----

  const swapPair = () => {
    setPair((current) => ({
      fg: current.bg,
      bg: current.fg,
      fgToken: current.bgToken,
      bgToken: current.fgToken,
    }))
  }

  const resetPair = () => {
    setPair(initialPair(project, mode))
    toast('已恢复默认的前景 / 背景组合')
  }

  const applyPick = (hex: string, tokenKey: string | null) => {
    setPair((current) =>
      target === 'fg'
        ? { ...current, fg: hex, fgToken: tokenKey }
        : { ...current, bg: hex, bgToken: tokenKey },
    )
    toast(`已设为${target === 'fg' ? '前景色' : '背景色'} ${hex}`, 'success')
  }

  // ---- 组合体检 ----

  const auditRows = useMemo<AuditRow[]>(() => {
    const theme = project.theme
    if (!theme) return []
    const rows: AuditRow[] = []
    for (const item of AUDIT_ITEMS) {
      const fgHex = tokenColor(theme, item.fgKey, mode)
      const bgHex = tokenColor(theme, item.bgKey, mode)
      if (!fgHex || !bgHex) continue
      const ratio = contrastRatio(fgHex, bgHex)
      const pass = ratio >= item.target
      rows.push({
        ...item,
        fgHex,
        bgHex,
        ratio,
        pass,
        suggestion: pass ? null : suggestAccessibleColor(fgHex, bgHex, item.target),
      })
    }
    return rows
  }, [project.theme, mode])

  const auditPassed = auditRows.filter((row) => row.pass).length

  const loadAuditCombo = (row: AuditRow) => {
    setPair({ fg: row.fgHex, bg: row.bgHex, fgToken: row.fgKey, bgToken: row.bgKey })
    toast(`已载入「${row.label}」组合`)
  }

  const applySuggestion = (row: AuditRow) => {
    const suggestion = row.suggestion
    if (!suggestion) return
    setPair({ fg: suggestion, bg: row.bgHex, fgToken: null, bgToken: row.bgKey })
    toast(`已应用建议色 ${suggestion}`, 'success')
  }

  const largeLevel = largeTextLevel(result.ratio)
  const bodyLevel = bodyTextLevel(result.ratio)

  return (
    <div className="tools-view page-enter">
      <header className="tools-view-head">
        <div className="tools-view-heading">
          <span className="tools-view-icon">
            <Icon name="contrast" size={18} />
          </span>
          <div>
            <h2 className="tools-view-title">
              对比度检查
              <Badge tone="accent">WCAG 2.1</Badge>
            </h2>
            <p className="tools-view-desc">
              检查任意前景色与背景色的 WCAG 对比度，评估正文 / 大字的 AA、AAA 达标情况，并体检当前主题的常用配色组合。
            </p>
          </div>
        </div>
        <div className="tools-view-actions">
          <Badge tone="info">{modeName}模式</Badge>
          <Button size="sm" icon="refresh" onClick={resetPair}>
            恢复默认组合
          </Button>
        </div>
      </header>

      {/* 顶部：颜色选择 + 大号对比度结果 */}
      <div className="contrast-top">
        <Panel title="颜色组合" subtitle="前景色用于文字与图标，背景色为它们所在的底色">
          <div className="contrast-pickers">
            <ColorField
              label="前景色 · 文字 / 图标"
              value={pair.fg}
              onChange={(hex) => setPair((current) => ({ ...current, fg: hex, fgToken: null }))}
              hint={
                pair.fgToken
                  ? `主题语义色 · ${tokenLabel(pair.fgToken)}（跟随${modeName}模式）`
                  : '自定义颜色'
              }
              actions={
                <IconButton icon="copy" label="复制前景色" onClick={() => void copy(pair.fg)} />
              }
            />

            <div className="contrast-swap-row">
              <span className="contrast-swap-line" />
              <IconButton icon="swap" label="交换前景色与背景色" onClick={swapPair} />
              <span className="contrast-swap-line" />
            </div>

            <ColorField
              label="背景色"
              value={pair.bg}
              onChange={(hex) => setPair((current) => ({ ...current, bg: hex, bgToken: null }))}
              hint={
                pair.bgToken
                  ? `主题语义色 · ${tokenLabel(pair.bgToken)}（跟随${modeName}模式）`
                  : '自定义颜色'
              }
              actions={
                <IconButton icon="copy" label="复制背景色" onClick={() => void copy(pair.bg)} />
              }
            />

            <div className="contrast-tips">
              <span>
                <Icon name="info" size={12} /> 正文 AA ≥ 4.5:1 · AAA ≥ 7:1
              </span>
              <span>
                <Icon name="text" size={12} /> 大字（≥24px 或 18.66px 加粗）AA ≥ 3:1 · AAA ≥ 4.5:1
              </span>
            </div>
          </div>
        </Panel>

        <section className="panel contrast-score">
          <div className="contrast-score-body">
            <div className="contrast-score-head">
              <div>
                <div className="contrast-score-label">对比度</div>
                <div className="contrast-ratio-row">
                  <span className="contrast-ratio">{result.ratio.toFixed(2)}</span>
                  <span className="contrast-ratio-unit">: 1</span>
                </div>
              </div>
              <div className={cx('contrast-verdict', verdictClass)}>
                <span className="contrast-verdict-main">{verdictText}</span>
                <span className="contrast-verdict-sub">{verdictSub}</span>
              </div>
            </div>

            <div className="contrast-meter">
              <div className="contrast-meter-track">
                <span className="contrast-meter-fill" style={{ width: `${pointerPercent}%` }} />
                {METER_TICKS.map((tick) => (
                  <span
                    key={tick.value}
                    className="contrast-meter-tick"
                    style={{ left: `${((tick.value - 1) / 20) * 100}%` }}
                    title={tick.label}
                  />
                ))}
                <span
                  className="contrast-meter-marker"
                  style={{ left: `${pointerPercent}%` }}
                  title={`当前对比度 ${result.ratio.toFixed(2)}:1`}
                />
              </div>
              <div className="contrast-meter-legend">
                <span>1:1</span>
                <span>3:1 大字 AA</span>
                <span>4.5:1 正文 AA</span>
                <span>7:1 正文 AAA</span>
                <span>21:1</span>
              </div>
            </div>

            <div className="contrast-criteria">
              {criteria.map((item) => (
                <div
                  key={item.label}
                  className={cx('contrast-criterion-row', item.passed ? 'is-pass' : 'is-fail')}
                >
                  <span className="contrast-criterion-status">
                    <Icon name={item.passed ? 'check' : 'x'} size={12} />
                  </span>
                  <span className="contrast-criterion-name">{item.label}</span>
                  <span className="contrast-criterion-req">{item.requirement}</span>
                  <span className="contrast-criterion-state">{item.passed ? '通过' : '未通过'}</span>
                </div>
              ))}
            </div>

            {!result.aa ? (
              <div className="contrast-suggest">
                <Icon name="sparkles" size={14} />
                <span>正文不达标，推荐文字色</span>
                <CopyableColor hex={result.suggestedText} size={13} />
              </div>
            ) : null}

            <div className="contrast-score-note">
              对比度越高文字越清晰；正文与大字的 WCAG 阈值不同，请按实际字号判定。
            </div>
          </div>
        </section>
      </div>

      {/* 中部：文本示例预览 + 快捷取色 */}
      <div className="contrast-mid">
        <Panel title="文本示例预览" subtitle="同一组颜色在三种字号下的实际阅读效果">
          <div className="contrast-preview">
            <div className="contrast-preview-canvas" style={{ background: pair.bg }}>
              <div style={{ color: pair.fg }}>
                <div className="contrast-preview-title">页面标题 · 大标题 24px</div>
                <div className="contrast-preview-body">
                  正文 14px —— 清晰的文字与背景对比，是界面可读性的第一道保障。
                </div>
                <div className="contrast-preview-small">
                  辅助说明 12px · 更小的字号需要更高的对比度
                </div>
              </div>
              <div className="contrast-preview-ui">
                <span
                  className="contrast-preview-btn"
                  style={{ background: pair.fg, color: pair.bg }}
                >
                  主要按钮
                </span>
                <span
                  className="contrast-preview-chip"
                  style={{ borderColor: pair.fg, color: pair.fg }}
                >
                  标签
                </span>
              </div>
            </div>

            <div className="contrast-legend">
              <div className="contrast-legend-row">
                <span className="contrast-legend-size">大标题 24px</span>
                <Badge tone={largeLevel.tone}>{largeLevel.text}</Badge>
                <span className="contrast-legend-req">AA ≥ 3:1 · AAA ≥ 4.5:1</span>
              </div>
              <div className="contrast-legend-row">
                <span className="contrast-legend-size">正文 14px</span>
                <Badge tone={bodyLevel.tone}>{bodyLevel.text}</Badge>
                <span className="contrast-legend-req">AA ≥ 4.5:1 · AAA ≥ 7:1</span>
              </div>
              <div className="contrast-legend-row">
                <span className="contrast-legend-size">小字 12px</span>
                <Badge tone={bodyLevel.tone}>{bodyLevel.text}</Badge>
                <span className="contrast-legend-req">按正文标准判定</span>
              </div>
            </div>
          </div>
        </Panel>

        <Panel
          title="快捷取色"
          subtitle="点击主题语义色或色板颜色，快速应用到前景 / 背景"
        >
          <div className="contrast-quick">
            <div className="contrast-quick-head">
              <span className="contrast-quick-label">点击颜色应用到</span>
              <Segmented
                size="sm"
                value={target}
                onChange={setTarget}
                options={[
                  { value: 'fg', label: '前景色' },
                  { value: 'bg', label: '背景色' },
                ]}
              />
              <span className="contrast-quick-mode">跟随{modeName}模式</span>
            </div>

            <div className="contrast-quick-group-title">
              <Icon name="layers" size={12} /> 主题语义色
              {project.theme ? null : <span className="faint">（未生成主题）</span>}
            </div>
            {tokenItems.length > 0 ? (
              <div className="contrast-token-grid">
                {tokenItems.map((token) => {
                  const activeHex = target === 'fg' ? pair.fg : pair.bg
                  const active = activeHex.toUpperCase() === token.hex.toUpperCase()
                  return (
                    <button
                      key={token.key}
                      type="button"
                      className={cx('contrast-token', active && 'is-active')}
                      title={`${token.label} · ${token.hex}`}
                      onClick={() => applyPick(token.hex, token.key)}
                    >
                      <ColorDot hex={token.hex} size={14} />
                      <span className="contrast-token-name">{token.label}</span>
                      <span className="contrast-token-hex mono">{token.hex}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="contrast-quick-empty">
                当前项目尚未生成语义主题，可先在「主题」标签页生成后再按语义色取色。
              </div>
            )}

            <div className="contrast-quick-group-title">
              <Icon name="palette" size={12} /> 项目色板
              {project.palette.length > 0 ? (
                <span className="faint">（{project.palette.length}）</span>
              ) : null}
            </div>
            {project.palette.length > 0 ? (
              <div className="contrast-token-grid">
                {project.palette.map((color) => {
                  const activeHex = target === 'fg' ? pair.fg : pair.bg
                  const active = activeHex.toUpperCase() === color.hex.toUpperCase()
                  return (
                    <button
                      key={color.id}
                      type="button"
                      className={cx('contrast-token', active && 'is-active')}
                      title={`${color.name} · ${color.hex}`}
                      onClick={() => applyPick(color.hex, null)}
                    >
                      <ColorDot hex={color.hex} size={14} />
                      <span className="contrast-token-name">{color.name}</span>
                      <span className="contrast-token-hex mono">{color.hex}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="contrast-quick-empty">项目色板为空，可先到「色板」标签页添加颜色。</div>
            )}
          </div>
        </Panel>
      </div>

      {/* 项目组合体检 */}
      <Panel
        title="项目组合体检"
        subtitle={
          project.theme
            ? `自动检查当前主题在${modeName}模式下的 ${AUDIT_ITEMS.length} 组常用组合`
            : '生成语义主题后，可自动体检常用配色组合'
        }
        actions={
          project.theme && auditRows.length > 0 ? (
            <span className="contrast-audit-pass-count">
              通过
              <Badge tone={auditPassed === auditRows.length ? 'success' : 'warning'}>
                {auditPassed} / {auditRows.length}
              </Badge>
            </span>
          ) : null
        }
      >
        {project.theme && auditRows.length > 0 ? (
          <div className="contrast-audit-list">
            {auditRows.map((row) => (
              <div
                key={row.id}
                className={cx('contrast-audit-row', row.pass ? 'is-pass' : 'is-fail')}
              >
                <div className="contrast-audit-main">
                  <div className="contrast-audit-title-row">
                    <span className="contrast-audit-status">
                      <Icon name={row.pass ? 'check' : 'warning'} size={11} />
                    </span>
                    <span className="contrast-audit-title">{row.label}</span>
                    <Badge tone={row.pass ? 'success' : 'warning'}>
                      {row.pass ? '达标' : '不达标'} · 目标 {row.target}:1
                    </Badge>
                  </div>
                  <div className="contrast-audit-combo">
                    <CopyableColor hex={row.fgHex} size={12} />
                    <Icon name="arrow-right" size={12} className="contrast-audit-arrow" />
                    <CopyableColor hex={row.bgHex} size={12} />
                    <span className="contrast-audit-note">{row.note}</span>
                  </div>
                </div>

                <div className="contrast-audit-side">
                  <span className="contrast-audit-ratio">{row.ratio.toFixed(2)}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="target"
                    onClick={() => loadAuditCombo(row)}
                    title="把这组颜色载入上方对比度检查"
                  >
                    载入
                  </Button>
                </div>

                {!row.pass && row.suggestion ? (
                  <div className="contrast-audit-suggestion">
                    <Icon name="sparkles" size={13} />
                    <span className="contrast-audit-suggestion-label">建议改用</span>
                    <CopyableColor hex={row.suggestion} size={12} />
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => applySuggestion(row)}
                      title="把建议色应用为前景色"
                    >
                      应用
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="contrast-audit-empty">
            <span className="contrast-audit-empty-icon">
              <Icon name="layers" size={17} />
            </span>
            <div>
              <div className="contrast-audit-empty-title">还没有语义主题</div>
              <div className="faint">
                先在「主题」标签页根据主色生成语义主题，这里会自动体检正文、按钮、边框等常用组合，并给出整改建议。
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}
