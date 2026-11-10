import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColorRef, ControlStyles, GeneratedTheme, PaletteColor, Project } from '../shared/types'
import { formatColor, getContrastResult, normalizeHex, isDark } from '../core/color'
import { paletteColor, resolveColorRef, tokenColor } from '../core/resolve'
import { useApp, useCopyText } from '../state/store'
import { ColorFormat } from '../shared/types'
import { Icon, IconButton, Segmented, cx, useToast } from './ui'
import { ColorPicker } from './ColorPicker'

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

/** 复制颜色（自动应用用户在设置中选择的颜色格式） */
export function useColorCopy() {
  const { data } = useApp()
  const copyText = useCopyText()
  const { toast } = useToast()
  return useCallback(
    async (hex: string, format?: ColorFormat) => {
      const target = format ?? data.settings.colorFormat
      const text = formatColor(hex, target)
      const ok = await copyText(text)
      toast(ok ? `已复制 ${text}` : '复制失败', ok ? 'success' : 'error')
      return ok
    },
    [copyText, data.settings.colorFormat, toast],
  )
}

// ---------------------------------------------------------------------------
// 颜色方块
// ---------------------------------------------------------------------------

export function ColorDot({
  hex,
  size = 16,
  radius = 5,
  border,
  className,
  style,
}: {
  hex: string
  size?: number
  radius?: number
  border?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <span
      className={cx('color-dot', border && 'has-border', className)}
      style={{ width: size, height: size, background: hex, borderRadius: radius, ...style }}
    />
  )
}

/** 可点击复制的颜色块 + 色值 */
export function CopyableColor({
  hex,
  showHex = true,
  size = 16,
  label,
  className,
}: {
  hex: string
  showHex?: boolean
  size?: number
  label?: React.ReactNode
  className?: string
}) {
  const copy = useColorCopy()
  return (
    <button type="button" className={cx('copyable-color', className)} onClick={() => copy(hex)} title="点击复制色值">
      <ColorDot hex={hex} size={size} border />
      {showHex ? <span className="mono copyable-hex">{hex}</span> : null}
      {label ? <span className="copyable-label">{label}</span> : null}
    </button>
  )
}

// ---------------------------------------------------------------------------
// HEX 输入
// ---------------------------------------------------------------------------

export function HexInput({
  value,
  onChange,
  size = 'md',
  placeholder = '#RRGGBB',
  disabled,
  autoFocus,
}: {
  value: string
  onChange: (hex: string) => void
  size?: 'sm' | 'md'
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
}) {
  const [text, setText] = useState(value)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setText(value)
    setInvalid(false)
  }, [value])

  const commit = (next: string) => {
    const normalized = normalizeHex(next)
    if (normalized) {
      onChange(normalized)
      setText(normalized)
      setInvalid(false)
    } else {
      setText(value)
      setInvalid(false)
    }
  }

  return (
    <input
      className={cx('input mono', 'hex-input', size === 'sm' && 'input-sm', invalid && 'is-invalid')}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value
        setText(next)
        const normalized = normalizeHex(next)
        if (normalized) {
          onChange(normalized)
          setInvalid(false)
        } else {
          setInvalid(next.trim().length > 0)
        }
      }}
      onBlur={() => commit(text)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit(text)
          ;(event.target as HTMLInputElement).blur()
        }
        if (event.key === 'Escape') {
          setText(value)
          setInvalid(false)
        }
      }}
      maxLength={32}
    />
  )
}

/** 颜色输入行：取色器 + HEX 输入 */
export function ColorField({
  label,
  value,
  onChange,
  hint,
  disabled,
  actions,
}: {
  label?: React.ReactNode
  value: string
  onChange: (hex: string) => void
  hint?: React.ReactNode
  disabled?: boolean
  actions?: React.ReactNode
}) {
  return (
    <div className="color-field">
      <div className="color-field-main">
        <ColorPicker value={value} onChange={onChange} disabled={disabled} />
        <div className="color-field-text">
          {label ? <div className="color-field-label">{label}</div> : null}
          <div className="color-field-row">
            <HexInput value={value} onChange={onChange} disabled={disabled} size="sm" />
            {actions}
          </div>
          {hint ? <div className="field-hint">{hint}</div> : null}
        </div>
      </div>
      <div className="color-field-preview" style={{ background: value }}>
        <span style={{ color: isDark(value) ? '#ffffff' : '#111827', fontSize: 11, fontWeight: 600 }}>
          {value}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 颜色引用选择（控件配色使用）
// ---------------------------------------------------------------------------

export type ColorRefSource = 'token' | 'palette' | 'custom'

export function ColorRefPicker({
  value,
  onChange,
  project,
  mode,
  label,
}: {
  value: ColorRef | undefined
  onChange: (ref: ColorRef | null) => void
  project: Project
  mode: 'light' | 'dark'
  label?: React.ReactNode
}) {
  const tokens = project.theme?.tokens ?? []
  const palette = project.palette ?? []
  const resolved = resolveColorRef(value, { palette, theme: project.theme, mode }) ?? '#7d7d7d'
  const source: ColorRefSource | 'none' = !value
    ? 'none'
    : value.kind === 'token'
      ? 'token'
      : value.kind === 'palette'
        ? 'palette'
        : 'custom'
  const customHex = value?.kind === 'hex' ? value.value : resolved

  const applySource = (next: string) => {
    if (next === 'none') return onChange(null)
    if (next === 'custom') return onChange({ kind: 'hex', value: customHex })
    if (next === 'token') {
      const first = tokens[0]
      return onChange(first ? { kind: 'token', key: first.key } : null)
    }
    const first = palette[0]
    return onChange(first ? { kind: 'palette', id: first.id } : null)
  }

  return (
    <div className="ref-picker">
      {label ? <div className="ref-picker-label">{label}</div> : null}
      <div className="ref-picker-row">
        <ColorDot hex={resolved} size={20} radius={6} border />
        <select
          className="select ref-picker-select"
          value={
            source === 'none'
              ? 'none'
              : source === 'custom'
                ? 'custom'
                : source === 'token'
                  ? `token:${(value as { key: string }).key}`
                  : `palette:${(value as { id: string }).id}`
          }
          onChange={(event) => {
            const next = event.target.value
            if (next === 'none' || next === 'custom' || next === 'token' || next === 'palette') {
              applySource(next)
              return
            }
            const [kind, key] = next.split(':')
            if (kind === 'token') onChange({ kind: 'token', key })
            else onChange({ kind: 'palette', id: key })
          }}
        >
          <option value="none">未设置</option>
          <option value="custom">自定义颜色</option>
          <optgroup label="主题配色">
            {tokens.map((token) => (
              <option key={token.key} value={`token:${token.key}`}>
                {token.label}（{mode === 'dark' ? token.dark : token.light}）
              </option>
            ))}
          </optgroup>
          <optgroup label="项目色板">
            {palette.map((color) => (
              <option key={color.id} value={`palette:${color.id}`}>
                {color.name}（{color.hex}）
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      {source === 'custom' ? (
        <div className="ref-picker-custom">
          <ColorPicker
            value={customHex}
            size={28}
            onChange={(hex) => onChange({ kind: 'hex', value: hex })}
          />
          <HexInput
            value={customHex}
            size="sm"
            onChange={(hex) => onChange({ kind: 'hex', value: hex })}
          />
        </div>
      ) : null}
      {source === 'none' ? (
        <button type="button" className="ref-picker-remove" onClick={() => onChange(null)}>
          <Icon name="x" size={12} /> 不设置该属性
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 色阶展示
// ---------------------------------------------------------------------------

export function ScaleStrip({
  label,
  light,
  dark,
  mode,
  onCopy,
}: {
  label?: React.ReactNode
  light: Record<string, string>
  dark: Record<string, string>
  mode: 'light' | 'dark'
  onCopy?: (hex: string) => void
}) {
  const scale = mode === 'dark' ? dark : light
  const steps = Object.keys(scale)
  return (
    <div className="scale-strip">
      {label ? <div className="scale-strip-label">{label}</div> : null}
      <div className="scale-strip-cells">
        {steps.map((step) => (
          <button
            key={step}
            type="button"
            className="scale-cell"
            title={`${step} · ${scale[step]}（点击复制）`}
            onClick={() => onCopy?.(scale[step])}
          >
            <span className="scale-cell-color" style={{ background: scale[step] }} />
            <span className="scale-cell-step mono">{step}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 明暗模式切换
// ---------------------------------------------------------------------------

export function ModeToggle({
  value,
  onChange,
  size = 'md',
}: {
  value: 'light' | 'dark'
  onChange: (mode: 'light' | 'dark') => void
  size?: 'sm' | 'md'
}) {
  return (
    <Segmented
      size={size}
      value={value}
      onChange={onChange}
      options={[
        { value: 'light', label: '浅色', icon: 'sun', title: '浅色模式配色' },
        { value: 'dark', label: '深色', icon: 'moon', title: '深色模式配色' },
      ]}
    />
  )
}

// ---------------------------------------------------------------------------
// 其他小工具
// ---------------------------------------------------------------------------

/** 对比度等级徽章 */
export function ContrastBadge({ fg, bg }: { fg: string; bg: string }) {
  const result = getContrastResult(fg, bg)
  const tone =
    result.level === 'AAA' ? 'success' : result.level === 'AA' ? 'accent' : result.level === 'AA-large' ? 'warning' : 'danger'
  return (
    <span className={cx('badge', `badge-${tone}`)} title="WCAG 对比度等级">
      {result.level === 'fail' ? '不达标' : result.level} · {result.ratio.toFixed(2)}
    </span>
  )
}

/** 主题 token 的当前模式颜色 */
export function useTokenColor(theme: GeneratedTheme | null, key: string, mode: 'light' | 'dark'): string | null {
  return useMemo(() => tokenColor(theme, key, mode), [theme, key, mode])
}

/** 色板颜色查找 */
export function usePaletteColor(palette: PaletteColor[], id: string): string | null {
  return useMemo(() => paletteColor(palette, id), [palette, id])
}

/** 解析一组控件属性颜色（供预览使用） */
export function useControlColors(
  project: Project,
  controlId: string,
  mode: 'light' | 'dark',
): Record<string, string | null> {
  return useMemo(() => {
    const styles = project.controlStyles?.[controlId] ?? {}
    const result: Record<string, string | null> = {}
    for (const [partId, ref] of Object.entries(styles)) {
      result[partId] = resolveColorRef(ref, { palette: project.palette, theme: project.theme, mode })
    }
    return result
  }, [project, controlId, mode])
}
