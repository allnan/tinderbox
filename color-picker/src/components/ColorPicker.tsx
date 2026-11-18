/**
 * 紧凑型现代取色器（独立库版本）。
 *
 * 这个组件从「配色工坊」的 `components/ColorPicker.tsx` 独立而来，交互、尺寸与视觉保持不变，
 * 只做了库化改造：
 * - 去掉对配色工坊 UI 组件、图标和 `palette.ts` 的依赖，改为本库内部实现；
 * - localStorage 键前缀、强调色、默认方式、主题等改为 Props；
 * - 颜色数学与全彩算法移到 `core/`，本文件只负责界面与交互；
 * - 修正确认模式下 RGB 读数没有跟随内部预览的问题。
 *
 * 完整设计说明见 `docs/设计方案.md`，全彩算法见 `docs/全彩取色算法.md`。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  alphaOf,
  bestTextOn,
  clamp,
  hexToOklch,
  hexToRgb,
  hsvToRgb,
  normalizeHex,
  oklchToHex,
  rgbToHex,
  rgbToHsv,
  rgbaToHex,
} from '../core/color'
import { colorDisplayName } from '../core/color-names'
import { buildSpectrumImage } from '../spectrum-image'
import { PickerIcon } from './icons'
import { cx } from './cx'

/** 常用高饱和色（默认色板「常用」） */
export const PRESET_VIVID: readonly string[] = [
  '#EF4444',
  '#F97316',
  '#F59E0B',
  '#EAB308',
  '#84CC16',
  '#22C55E',
  '#14B8A6',
  '#06B6D4',
  '#3B82F6',
  '#6366F1',
  '#8B5CF6',
  '#EC4899',
]

/** 中性色（默认色板「中性」：灰阶 + 黑白） */
export const PRESET_NEUTRAL: readonly string[] = [
  '#111827',
  '#1F2937',
  '#374151',
  '#6B7280',
  '#9CA3AF',
  '#D1D5DB',
  '#E5E7EB',
  '#F3F4F6',
  '#FFFFFF',
  '#000000',
]

/** 默认 localStorage 键前缀；同一个页面里可以给不同取色器传不同前缀隔离偏好 */
export const DEFAULT_STORAGE_PREFIX = 'color-picker'

/** 最近颜色默认上限 */
const MAX_RECENT = 12

/** 色板标签页 */
export type PickerTab = 'vivid' | 'neutral' | 'recent'

/** 取色方式：面板（精细微调）/ 全彩（OKLCH 色域图）/ 色块（格子单击选色） */
export type PickerMode = 'panel' | 'full' | 'grid'

/** 应用方式：立即同步 / 确认后同步 */
export type ApplyMode = 'live' | 'confirm'

/** 外观：auto 跟随系统，light / dark 强制；宿主已定义自己的主题变量时以宿主为准 */
export type PickerTheme = 'auto' | 'light' | 'dark'

/** 取色方式名称（用于「下次打开默认用…」文案） */
const MODE_LABELS: Record<PickerMode, string> = { panel: '面板', full: '全彩', grid: '色块' }

/** 色块网格：12 个色相 × 5 档明度 + 12 档灰阶，单击即选 */
const GRID_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
const GRID_ROWS = [
  { s: 100, v: 100 },
  { s: 92, v: 82 },
  { s: 84, v: 64 },
  { s: 76, v: 46 },
  { s: 68, v: 28 },
]
const GRID_NEUTRALS = [
  '#FFFFFF',
  '#F9FAFB',
  '#F3F4F6',
  '#E5E7EB',
  '#D1D5DB',
  '#9CA3AF',
  '#6B7280',
  '#4B5563',
  '#374151',
  '#1F2937',
  '#111827',
  '#000000',
]

// ---------------------------------------------------------------------------
// localStorage 读写（不可用时静默降级）
// ---------------------------------------------------------------------------

function modeKey(prefix: string): string {
  return `${prefix}:color-picker-default-mode`
}

function applyModeKey(prefix: string): string {
  return `${prefix}:color-picker-apply-mode`
}

function recentKey(prefix: string): string {
  return `${prefix}:recent-colors`
}

function loadRecent(prefix: string, limit: number): string[] {
  try {
    const raw = localStorage.getItem(recentKey(prefix))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => (typeof item === 'string' ? normalizeHex(item) : null))
      .filter((item): item is string => Boolean(item))
      .slice(0, Math.max(0, limit))
  } catch {
    return []
  }
}

function saveRecent(prefix: string, colors: string[]): void {
  try {
    localStorage.setItem(recentKey(prefix), JSON.stringify(colors))
  } catch {
    /* 忽略 localStorage 不可用 */
  }
}

function loadDefaultMode(prefix: string, fallback: PickerMode): PickerMode {
  try {
    const saved = localStorage.getItem(modeKey(prefix))
    // 兼容旧版本保存的 'wheel'：映射到新的全彩色板
    if (saved === 'wheel') return 'full'
    // 没有保存过偏好时使用调用方给的默认值
    return saved === 'panel' || saved === 'grid' || saved === 'full' ? saved : fallback
  } catch {
    return fallback
  }
}

function loadApplyMode(prefix: string, fallback: ApplyMode): ApplyMode {
  try {
    return localStorage.getItem(applyModeKey(prefix)) === 'live' ? 'live' : fallback
  } catch {
    return fallback
  }
}

/** SSR 环境没有 document：退化为 useEffect，避免 useLayoutEffect 警告 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export interface ColorPickerProps {
  /** 当前颜色，`#RRGGBB` 或 `#RRGGBBAA`（大写规范） */
  value: string
  /** 颜色变化回调：立即模式拖动即触发；确认模式点「应用」时触发 */
  onChange: (hex: string) => void
  /** 禁用触发色块 */
  disabled?: boolean
  /** 触发色块边长（像素），默认 46 */
  size?: number
  /** 附加到触发按钮的类名 */
  className?: string
  /** 触发按钮是否在色块右侧显示 HEX 文本 */
  showTriggerLabel?: boolean
  /** localStorage 键前缀，默认 `color-picker`；配色工坊使用 `palette-studio` 保持旧偏好 */
  storagePrefix?: string
  /** 锁定强调色；缺省读取 `--accent`，再回退 `#4F7CFF` */
  accentColor?: string
  /** 首次渲染就打开取色器（演示 / 截图用） */
  defaultOpen?: boolean
  /** 打开 / 关闭回调 */
  onOpenChange?: (open: boolean) => void
  /** 没有保存过偏好时的默认取色方式，默认 `full`（全彩） */
  defaultMode?: PickerMode
  /** 没有保存过偏好时的默认应用方式，默认 `confirm`（确认后） */
  defaultApplyMode?: ApplyMode
  /** 外观，默认 `auto`（跟随系统）；宿主自定义主题变量时以宿主为准 */
  theme?: PickerTheme
  /** 自定义「常用」色板 */
  vividColors?: readonly string[]
  /** 自定义「中性」色板 */
  neutralColors?: readonly string[]
  /** 最近颜色上限，默认 12 */
  maxRecent?: number
}

export function ColorPicker({
  value,
  onChange,
  disabled,
  size = 46,
  className,
  showTriggerLabel,
  storagePrefix = DEFAULT_STORAGE_PREFIX,
  accentColor,
  defaultOpen = false,
  onOpenChange,
  defaultMode = 'full',
  defaultApplyMode = 'confirm',
  theme = 'auto',
  vividColors = PRESET_VIVID,
  neutralColors = PRESET_NEUTRAL,
  maxRecent = MAX_RECENT,
}: ColorPickerProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [mode, setMode] = useState<PickerMode>(() => loadDefaultMode(storagePrefix, defaultMode))
  const [preferredMode, setPreferredMode] = useState<PickerMode>(() => loadDefaultMode(storagePrefix, defaultMode))
  const [applyMode, setApplyMode] = useState<ApplyMode>(() => loadApplyMode(storagePrefix, defaultApplyMode))
  const [spectrumImage, setSpectrumImage] = useState('')
  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(normalizeHex(value) ?? '#000000')))
  /** 打开取色器时带入的颜色，用于「回到最初」 */
  const [initialHex, setInitialHex] = useState(() => normalizeHex(value) ?? value)
  /** 打开瞬间锁定强调色：取色器是控件，不应跟随正在编辑的颜色变化 */
  const [lockedAccent, setLockedAccent] = useState(() => accentColor ?? '#4F7CFF')
  /** 全彩光标位置：直接记录指针的色相/明度，避免从近黑/近白颜色反推导致跳动 */
  const [spectrumPos, setSpectrumPos] = useState<{ h: number; l: number }>(() => {
    const lch = hexToOklch((normalizeHex(value) ?? '#000000').slice(0, 7))
    return { h: lch.h, l: lch.l }
  })
  const latestHexRef = useRef(value)
  /** 点击当前颜色块展开的「颜色小窗」（中文色名 + HEX） */
  const [showColorInfo, setShowColorInfo] = useState(false)
  const [alpha, setAlpha] = useState(() => alphaOf(value))
  const [text, setText] = useState(value)
  const [tab, setTab] = useState<PickerTab>('vivid')
  const [recent, setRecent] = useState<string[]>(() => loadRecent(storagePrefix, maxRecent))
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [colorInfoPos, setColorInfoPos] = useState<{ left: number; top: number } | null>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const alphaRef = useRef<HTMLDivElement>(null)
  const spectrumRef = useRef<HTMLDivElement>(null)
  const spectrumDraggingRef = useRef(false)

  /** 读取当前强调色：显式传入 > 宿主 --accent > 默认值 */
  const resolveAccent = useCallback(() => {
    if (accentColor) return accentColor
    if (typeof document === 'undefined') return '#4F7CFF'
    const current = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return current || '#4F7CFF'
  }, [accentColor])

  /** 把指定取色方式设为下次默认打开的方式 */
  const markDefault = (next: PickerMode) => {
    setPreferredMode(next)
    try {
      localStorage.setItem(modeKey(storagePrefix), next)
    } catch {
      /* 忽略 localStorage 不可用 */
    }
  }

  /** 把颜色值同步到取色器内部状态（外部值 / 打开面板 / 取消时使用） */
  const syncFromValue = useCallback((nextValue: string) => {
    const normalized = normalizeHex(nextValue) ?? '#000000'
    const next = rgbToHsv(hexToRgb(normalized))
    setHsv((prev) => ({
      h: next.s === 0 || next.v === 0 ? prev.h : next.h,
      s: next.s,
      v: next.v,
    }))
    setAlpha(alphaOf(normalized))
    setText(normalized)
    latestHexRef.current = normalized
    // 非拖动状态下，全彩光标要跟随颜色值（例如点「恢复」、重新打开、外部改色）
    if (!spectrumDraggingRef.current) {
      const lch = hexToOklch(normalized.slice(0, 7))
      setSpectrumPos({ h: lch.h, l: lch.l })
    }
  }, [])

  // 外部值变化时同步 HSV / 透明度；饱和度为 0 时保留原色相，避免拖到灰阶后色相丢失
  useEffect(() => {
    syncFromValue(value)
  }, [value, syncFromValue])

  // 默认打开（演示 / 截图）时，挂载后再锁定一次强调色
  useEffect(() => {
    if (defaultOpen) setLockedAccent(resolveAccent())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const remember = useCallback(
    (hex: string) => {
      setRecent((prev) => {
        const next = [hex, ...prev.filter((item) => item !== hex)].slice(0, Math.max(0, maxRecent))
        saveRecent(storagePrefix, next)
        return next
      })
    },
    [maxRecent, storagePrefix],
  )

  /** 用当前 HSV + alpha 生成颜色 */
  const colorOf = useCallback((next: HSV, nextAlpha: number) => {
    const rgb = hsvToRgb(next)
    return rgbaToHex({ ...rgb, a: clamp(nextAlpha, 0, 1) })
  }, [])

  const commit = useCallback(
    (next: HSV, nextAlpha = alpha, rememberIt = false) => {
      const hex = colorOf(next, nextAlpha)
      latestHexRef.current = hex
      setHsv(next)
      setAlpha(clamp(nextAlpha, 0, 1))
      setText(hex)
      // 立即同步模式才在拖动过程中写回外部；确认模式只改取色器内部预览
      if (applyMode === 'live') {
        onChange(hex)
        if (rememberIt) remember(hex)
      }
    },
    [alpha, applyMode, colorOf, onChange, remember],
  )

  /** 关闭取色器：确认模式下丢弃未应用的改动 */
  const closePicker = useCallback(() => {
    if (applyMode === 'confirm') syncFromValue(value)
    setOpen(false)
  }, [applyMode, syncFromValue, value])

  /** 打开取色器：记录初始颜色、锁定强调色、进入默认取色方式 */
  const openPicker = useCallback(() => {
    syncFromValue(value)
    setInitialHex(normalizeHex(value) ?? value)
    // 锁定当前主题强调色，避免编辑项目主色时取色器控件颜色也跟着变
    setLockedAccent(resolveAccent())
    setMode(preferredMode)
    setOpen(true)
  }, [preferredMode, resolveAccent, syncFromValue, value])

  /** 确认模式：应用当前选择并关闭 */
  const applyPending = useCallback(() => {
    const hex = normalizeHex(text) ?? colorOf(hsv, alpha)
    onChange(hex)
    remember(hex)
    setOpen(false)
  }, [alpha, colorOf, hsv, onChange, remember, text])

  /** 回到打开取色器时带入的颜色（立即模式下同时写回外部） */
  const revertToInitial = useCallback(() => {
    syncFromValue(initialHex)
    if (applyMode === 'live') onChange(initialHex)
  }, [applyMode, initialHex, onChange, syncFromValue])

  /** 切换应用方式：从「确认后」切回「立即」时，把当前选择立即同步出去 */
  const changeApplyMode = useCallback(
    (next: ApplyMode) => {
      setApplyMode(next)
      try {
        localStorage.setItem(applyModeKey(storagePrefix), next)
      } catch {
        /* 忽略 localStorage 不可用 */
      }
      if (next === 'live' && applyMode === 'confirm') {
        const hex = normalizeHex(text) ?? colorOf(hsv, alpha)
        onChange(hex)
      }
    },
    [alpha, applyMode, colorOf, hsv, onChange, storagePrefix, text],
  )

  const pendingHex = normalizeHex(text) ?? colorOf(hsv, alpha)
  /** 取色器内部当前颜色（不含透明度），用于 RGB 读数、网格高亮 / 光标位置 */
  const pendingOpaqueHex = (normalizeHex(pendingHex) ?? '#000000').slice(0, 7)

  // 定位：优先在触发色块下方展开，空间不足时向上翻转；越界时自动收边
  useIsomorphicLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current
      const pop = popRef.current
      if (!trigger || !pop) return
      const rect = trigger.getBoundingClientRect()
      const width = pop.offsetWidth
      const height = pop.offsetHeight
      const margin = 10
      let left = rect.left
      if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - width - margin)
      let top = rect.bottom + 8
      if (top + height > window.innerHeight - margin) {
        top = rect.top - height - 8
        if (top < margin) top = margin
      }
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // 颜色小窗定位：和取色器同款的小弹窗，浮在左侧、顶部与取色器对齐；左侧空间不足时放右侧
  useIsomorphicLayoutEffect(() => {
    if (!open || !showColorInfo) return
    const place = () => {
      const pop = popRef.current
      if (!pop) return
      const panel = pop.getBoundingClientRect()
      const width = 138
      const height = 138
      const gap = 12
      let left = panel.left - width - gap
      if (left < 8) left = panel.right + gap
      const top = clamp(panel.top, 8, window.innerHeight - height - 8)
      setColorInfoPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showColorInfo, pos])

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      closePicker()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closePicker()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, closePicker])

  const applySv = useCallback(
    (clientX: number, clientY: number) => {
      const pad = svRef.current
      if (!pad) return
      const rect = pad.getBoundingClientRect()
      const s = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100)
      const v = clamp((1 - (clientY - rect.top) / rect.height) * 100, 0, 100)
      commit({ h: hsv.h, s, v })
    },
    [commit, hsv.h],
  )

  const applyHue = useCallback(
    (clientX: number) => {
      const bar = hueRef.current
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      const h = clamp(((clientX - rect.left) / rect.width) * 360, 0, 359.9)
      commit({ ...hsv, h })
    },
    [commit, hsv],
  )

  const applyAlpha = useCallback(
    (clientX: number) => {
      const bar = alphaRef.current
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      const next = clamp((clientX - rect.left) / rect.width, 0, 1)
      commit(hsv, next)
    },
    [commit, hsv],
  )

  /** 全彩（OKLCH 色域图）取色：横向色相、纵向明度 */
  const applySpectrum = useCallback(
    (clientX: number, clientY: number) => {
      const board = spectrumRef.current
      if (!board) return
      const rect = board.getBoundingClientRect()
      const h = clamp(((clientX - rect.left) / rect.width) * 360, 0, 359.9)
      let l = clamp(1 - (clientY - rect.top) / rect.height, 0, 1)
      // 最上/最下两像素吸附纯黑纯白，避免边缘出现 010000 / 000002 这类杂色
      if (rect.bottom - clientY <= 2) l = 0
      else if (clientY - rect.top <= 2) l = 1
      // 光标直接跟随指针；若用颜色反推，接近黑/白时色相不稳定会跳
      setSpectrumPos({ h, l })
      const hex = l === 0 ? '#000000' : l === 1 ? '#FFFFFF' : oklchToHex({ l, c: 0.4, h })
      commit({ ...rgbToHsv(hexToRgb(hex)) })
    },
    [commit],
  )

  // 打开/进入全彩模式时，把光标同步到当前颜色一次（之后只跟随指针）
  useEffect(() => {
    if (!open || mode !== 'full') return
    const lch = hexToOklch(pendingOpaqueHex)
    setSpectrumPos({ h: lch.h, l: lch.l })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode])

  // 打开全彩模式时按需生成 OKLCH 色域图（模块级缓存，只算一次）
  useEffect(() => {
    if (!open || mode !== 'full' || spectrumImage) return
    setSpectrumImage(buildSpectrumImage())
  }, [open, mode, spectrumImage])

  // 关闭取色器时收起颜色小窗
  useEffect(() => {
    if (!open) setShowColorInfo(false)
  }, [open])

  const rgb = useMemo(() => hexToRgb(pendingOpaqueHex), [pendingOpaqueHex])
  const gridColors = useMemo(
    () =>
      GRID_ROWS.map((row) =>
        GRID_HUES.map((h) => ({ h, s: row.s, v: row.v, hex: rgbToHex(hsvToRgb({ h, s: row.s, v: row.v })) })),
      ),
    [],
  )
  const dirty = pendingHex !== normalizeHex(value)
  /** 是否已偏离打开取色器时的颜色（用于显示「回到最初」） */
  const changedFromInitial = pendingHex !== initialHex
  const pendingOklch = useMemo(() => hexToOklch(pendingOpaqueHex), [pendingOpaqueHex])
  const eyeDropperAvailable = useMemo(
    () => typeof window !== 'undefined' && Boolean((window as unknown as { EyeDropper?: unknown }).EyeDropper),
    [],
  )

  const pickWithEyeDropper = async () => {
    const Ctor = (window as unknown as {
      EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
    }).EyeDropper
    if (!Ctor) return
    try {
      const result = await new Ctor().open()
      const hex = normalizeHex(result.sRGBHex)
      if (!hex) return
      const nextAlpha = alphaOf(hex)
      setAlpha(nextAlpha)
      setText(hex)
      commit({ ...rgbToHsv(hexToRgb(hex)) }, nextAlpha, true)
    } catch {
      /* 用户取消吸管 */
    }
  }

  const commitText = (raw: string) => {
    const hex = normalizeHex(raw)
    if (!hex) {
      setText(normalizeHex(value) ?? value)
      return
    }
    const nextAlpha = alphaOf(hex)
    setAlpha(nextAlpha)
    setText(hex)
    commit({ ...rgbToHsv(hexToRgb(hex)) }, nextAlpha, true)
  }

  const updateChannel = (channel: 'r' | 'g' | 'b', raw: string) => {
    const numeric = clamp(Number.parseInt(raw || '0', 10) || 0, 0, 255)
    const nextRgb = { ...rgb, [channel]: numeric }
    commit({ ...rgbToHsv(nextRgb) }, alpha)
  }

  const updateAlphaChannel = (raw: string) => {
    const percent = clamp(Number.parseInt(raw || '0', 10) || 0, 0, 100)
    commit(hsv, percent / 100)
  }

  const swatches = tab === 'vivid' ? vividColors : tab === 'neutral' ? neutralColors : recent
  const alphaGradient = `linear-gradient(to right, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0), rgb(${rgb.r}, ${rgb.g}, ${rgb.b}))`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx('cp-trigger cp-checker', showTriggerLabel && 'has-label', className)}
        style={{ width: size, height: size }}
        data-cp-theme={theme}
        disabled={disabled}
        title="打开取色器"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closePicker()
            return
          }
          openPicker()
        }}
      >
        <span className="cp-trigger-fill" style={{ background: value }} />
        <span className="cp-trigger-pipette">
          <PickerIcon name="pipette" size={12} />
        </span>
        {showTriggerLabel ? <span className="cp-trigger-label cp-mono">{value}</span> : null}
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popRef}
              className="cp-popover"
              data-cp-theme={theme}
              style={
                {
                  left: pos.left,
                  top: pos.top,
                  // 取色器内部固定使用打开时的强调色，不跟随正在编辑的颜色
                  '--cp-accent': lockedAccent,
                  '--cp-accent-text': bestTextOn(lockedAccent),
                } as CSSProperties
              }
              role="dialog"
              aria-label="取色器"
            >
              {/* 当前颜色（可编辑）→ 初始颜色（参考，含色块+色值）→ 恢复按钮 → 吸管 */}
              <div className="cp-head">
                <div className="cp-color-field" title={`OKLCH L ${pendingOklch.l.toFixed(2)} · C ${pendingOklch.c.toFixed(2)} · H ${Math.round(pendingOklch.h)}°`}>
                  <button
                    type="button"
                    className="cp-field-swatch cp-checker"
                    style={{ '--swatch-color': pendingHex } as CSSProperties}
                    title="查看颜色信息"
                    aria-label="查看颜色信息"
                    aria-expanded={showColorInfo}
                    onClick={() => setShowColorInfo((visible) => !visible)}
                  />
                  <input
                    className="cp-hex cp-mono"
                    value={text}
                    spellCheck={false}
                    maxLength={9}
                    aria-label="颜色 HEX 值"
                    onChange={(event) => setText(event.target.value)}
                    onBlur={() => commitText(text)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        commitText(text)
                        ;(event.currentTarget as HTMLInputElement).blur()
                      }
                    }}
                  />
                  {/* 颜色小窗：和取色器同款的小弹窗，浮在左侧、顶部对齐，再点色块收起 */}
                  {showColorInfo && colorInfoPos ? (
                    <div className="cp-color-preview" style={{ left: colorInfoPos.left, top: colorInfoPos.top }}>
                      <div className="cp-color-preview-swatch" style={{ backgroundColor: pendingHex }}>
                        <span className="cp-color-preview-name" style={{ color: bestTextOn(pendingOpaqueHex) }}>
                          {colorDisplayName(pendingOpaqueHex)}
                        </span>
                        <span className="cp-color-preview-hex cp-mono" style={{ color: bestTextOn(pendingOpaqueHex) }}>
                          {pendingHex}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="cp-initial" title={`进入取色器时的颜色 ${initialHex}`}>
                  <span className="cp-field-swatch cp-checker" style={{ '--swatch-color': initialHex } as CSSProperties} />
                  <span className="cp-initial-hex cp-mono">{initialHex}</span>
                </div>
                <button
                  type="button"
                  className={cx('cp-restore-btn', changedFromInitial && 'is-active')}
                  disabled={!changedFromInitial}
                  title={changedFromInitial ? `恢复到初始颜色 ${initialHex}` : '颜色未改动'}
                  aria-label={changedFromInitial ? `恢复到初始颜色 ${initialHex}` : '颜色未改动'}
                  onClick={revertToInitial}
                >
                  <PickerIcon name="refresh" size={13} />
                  <span>恢复</span>
                </button>
                {eyeDropperAvailable ? (
                  <button type="button" className="cp-eye" title="屏幕吸管：从屏幕任意位置取色" onClick={() => void pickWithEyeDropper()}>
                    <PickerIcon name="pipette" size={13} />
                  </button>
                ) : null}
              </div>

              {/* 取色方式：每个 tab 上方有 pin，点击可把该方式设为下次默认 */}
              <div className="cp-mode-switch" role="tablist" aria-label="取色方式">
                {(['panel', 'full', 'grid'] as const).map((item) => (
                  <div
                    key={item}
                    className={cx(
                      'cp-mode-item',
                      mode === item && 'is-active',
                      preferredMode === item && 'is-pinned',
                    )}
                  >
                    {mode === item || preferredMode === item ? (
                      <button
                        type="button"
                        className="cp-mode-pin"
                        title={
                          preferredMode === item
                            ? `「${MODE_LABELS[item]}」是默认取色方式`
                            : `将「${MODE_LABELS[item]}」设为默认取色方式`
                        }
                        aria-label={`将「${MODE_LABELS[item]}」设为默认取色方式`}
                        aria-pressed={preferredMode === item}
                        onClick={() => markDefault(item)}
                      >
                        <PickerIcon name="pin" size={11} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={mode === item}
                      className="cp-mode-tab"
                      onClick={() => setMode(item)}
                    >
                      {MODE_LABELS[item]}
                    </button>
                  </div>
                ))}
              </div>

              {/* 取色画布：面板 / 全彩矩形 / 色块网格 */}
              <div className="cp-canvas">
                {mode === 'panel' ? (
                  <>
                    <div
                      ref={svRef}
                      className="cp-sv"
                      style={{ background: `hsl(${Math.round(hsv.h)} 100% 50%)` }}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        event.currentTarget.setPointerCapture(event.pointerId)
                        applySv(event.clientX, event.clientY)
                      }}
                      onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) applySv(event.clientX, event.clientY)
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId)
                          if (applyMode === 'live') remember(latestHexRef.current)
                        }
                      }}
                    >
                      <span className="cp-sv-white" />
                      <span className="cp-sv-black" />
                      <span className="cp-sv-cursor" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: pendingOpaqueHex }} />
                    </div>

                    <div
                      ref={hueRef}
                      className="cp-hue"
                      onPointerDown={(event) => {
                        event.preventDefault()
                        event.currentTarget.setPointerCapture(event.pointerId)
                        applyHue(event.clientX)
                      }}
                      onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) applyHue(event.clientX)
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId)
                          if (applyMode === 'live') remember(latestHexRef.current)
                        }
                      }}
                    >
                      <span className="cp-hue-cursor" style={{ left: `${(hsv.h / 360) * 100}%` }} />
                    </div>
                  </>
                ) : mode === 'full' ? (
                  <div
                    className="cp-spectrum-wrap"
                    onPointerDown={(event) => {
                      event.preventDefault()
                      spectrumDraggingRef.current = true
                      try {
                        event.currentTarget.setPointerCapture(event.pointerId)
                      } catch {
                        /* 某些环境不支持指针捕获，按下标记已足够继续拖动 */
                      }
                      applySpectrum(event.clientX, event.clientY)
                    }}
                    onPointerMove={(event) => {
                      if (spectrumDraggingRef.current) {
                        applySpectrum(event.clientX, event.clientY)
                      }
                    }}
                    onPointerUp={(event) => {
                      spectrumDraggingRef.current = false
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId)
                      }
                      if (applyMode === 'live') remember(latestHexRef.current)
                    }}
                    onPointerCancel={() => {
                      spectrumDraggingRef.current = false
                    }}
                  >
                    <div
                      ref={spectrumRef}
                      className="cp-spectrum"
                      style={spectrumImage ? { backgroundImage: `url(${spectrumImage})` } : undefined}
                    >
                      <span
                        className="cp-spectrum-cursor"
                        style={{
                          left: `${(spectrumPos.h / 360) * 100}%`,
                          top: `${(1 - spectrumPos.l) * 100}%`,
                          background: pendingHex,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="cp-grid">
                    {gridColors.map((row, rowIndex) => (
                      <div className="cp-grid-row" key={`grid-row-${rowIndex}`}>
                        {row.map((cell) => (
                          <button
                            key={`${cell.h}-${rowIndex}`}
                            type="button"
                            className={cx('cp-grid-cell', pendingOpaqueHex === cell.hex && 'is-active')}
                            style={{ background: cell.hex }}
                            title={cell.hex}
                            onClick={() => commit({ h: cell.h, s: cell.s, v: cell.v }, alpha)}
                          />
                        ))}
                      </div>
                    ))}
                    <div className="cp-grid-row is-neutral">
                      {GRID_NEUTRALS.map((hex, index) => (
                        <button
                          key={`neutral-${index}-${hex}`}
                          type="button"
                          className={cx('cp-grid-cell', pendingOpaqueHex === hex && 'is-active')}
                          style={{ background: hex }}
                          title={hex}
                          onClick={() => commit({ ...rgbToHsv(hexToRgb(hex)) }, alpha)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 透明度 */}
              <div
                ref={alphaRef}
                className="cp-alpha cp-checker"
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  applyAlpha(event.clientX)
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) applyAlpha(event.clientX)
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                    if (applyMode === 'live') remember(latestHexRef.current)
                  }
                }}
              >
                <span className="cp-alpha-gradient" style={{ backgroundImage: alphaGradient }} />
                <span className="cp-alpha-cursor" style={{ left: `${alpha * 100}%` }} />
              </div>

              {/* RGB / A 数值 */}
              <div className="cp-rgb">
                {(['r', 'g', 'b'] as const).map((channel) => (
                  <label key={channel} className="cp-rgb-item">
                    <span className="cp-rgb-label">{channel.toUpperCase()}</span>
                    <input
                      className="cp-rgb-input cp-mono"
                      type="number"
                      min={0}
                      max={255}
                      value={rgb[channel]}
                      onChange={(event) => updateChannel(channel, event.target.value)}
                    />
                  </label>
                ))}
                <label className="cp-rgb-item">
                  <span className="cp-rgb-label">A</span>
                  <input
                    className="cp-rgb-input cp-mono"
                    type="number"
                    min={0}
                    max={100}
                    value={Math.round(alpha * 100)}
                    onChange={(event) => updateAlphaChannel(event.target.value)}
                  />
                  <span className="cp-rgb-unit">%</span>
                </label>
              </div>

              {/* 色板：常用 / 中性 / 最近，单行标签切换 */}
              <div className="cp-foot">
                <div className="cp-tabs">
                  <button
                    type="button"
                    className={cx('cp-tab', tab === 'vivid' && 'is-active')}
                    onClick={() => setTab('vivid')}
                  >
                    常用
                  </button>
                  <button
                    type="button"
                    className={cx('cp-tab', tab === 'neutral' && 'is-active')}
                    onClick={() => setTab('neutral')}
                  >
                    中性
                  </button>
                  <button
                    type="button"
                    className={cx('cp-tab', tab === 'recent' && 'is-active')}
                    onClick={() => setTab('recent')}
                  >
                    最近
                  </button>
                </div>
                <div className="cp-swatches">
                  {swatches.length ? (
                    swatches.map((hex) => (
                      <button
                        key={`${tab}-${hex}`}
                        type="button"
                        className={cx('cp-swatch', pendingHex === hex && 'is-active')}
                        title={hex}
                        onClick={() => commit({ ...rgbToHsv(hexToRgb(hex)) }, alphaOf(hex), true)}
                      >
                        <span style={{ background: hex }} />
                      </button>
                    ))
                  ) : (
                    <span className="cp-empty">选过的颜色会出现在这里</span>
                  )}
                </div>
              </div>

              {/* 偏好设置：应用方式（在底部操作栏之前） */}
              <div className="cp-settings">
                <span className="cp-settings-label">应用方式</span>
                <div className="cp-apply-toggle">
                  <button
                    type="button"
                    className={cx('cp-apply-btn', applyMode === 'live' && 'is-active')}
                    title="选择时立即同步到外部（默认）"
                    onClick={() => changeApplyMode('live')}
                  >
                    立即
                  </button>
                  <button
                    type="button"
                    className={cx('cp-apply-btn', applyMode === 'confirm' && 'is-active')}
                    title="先在取色器里选，点「应用」后再同步"
                    onClick={() => changeApplyMode('confirm')}
                  >
                    确认后
                  </button>
                </div>
                <span className="cp-settings-hint">
                  {applyMode === 'live' ? '选色即同步' : '点「应用」后同步'}
                </span>
              </div>

              {/* 确认模式的底部操作栏：放在最下方收尾 */}
              {applyMode === 'confirm' ? (
                <div className="cp-actions">
                  <button type="button" className="cp-btn-ghost" onClick={closePicker}>
                    取消
                  </button>
                  <button type="button" className="cp-btn-primary" disabled={!dirty} onClick={applyPending}>
                    应用
                  </button>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

type HSV = { h: number; s: number; v: number }
