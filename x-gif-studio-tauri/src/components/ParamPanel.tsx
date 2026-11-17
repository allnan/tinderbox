import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AnimFormat, EstimateMode, GifParams, GifEstimateRequest } from '../shared/types'
import { clampParams, presetWidthForSource } from '../core/params'
import {
  ESTIMATE_DEBOUNCE_MS,
  buildGifEstimateRequest,
  estimateDisplayText,
  estimateGifBytes,
  type GifSizeCalibration,
} from '../core/estimate'
import { formatCount, formatDuration, formatFps, formatSize } from '../core/format'
import { Button, Icon, Segmented, Switch } from './ui'

export interface ParamSourceSummary {
  kindLabel: string
  kind?: 'gif' | 'video' | 'photo' | string
  /** 源本地文件路径（已保存/已缓存的原始媒体），用于真实采样体积预估 */
  localPath?: string | null
  durationSec: number | null
  frameCount: number | null
  fps: number | null
  fpsMin?: number | null
  fpsMax?: number | null
  sizeBytes: number | null
  thumbnailUrl?: string | null
  count?: number
  mixedKinds?: boolean
  width: number | null
  height: number | null
}

export interface ParamPanelProps {
  params: GifParams
  presetId?: string | null
  onChange: (params: GifParams, presetId: string | null) => void
  sourceWidth?: number | null
  sourceHeight?: number | null
  sourceSummary?: ParamSourceSummary | null
  estimateCalibration?: GifSizeCalibration | null
  fileNamePreview?: string
  compact?: boolean
  defaultAdvancedOpen?: boolean
  animFormat?: AnimFormat
  variant?: 'bar' | 'full'
  /** 抽屉由外部固定摘要区渲染时关闭内嵌摘要 */
  showSummary?: boolean
  /** 当前机器是否有 gifsicle；false 时不显示优化项 */
  gifsicleAvailable?: boolean
  /** 抽屉把编码器放在输出格式卡里时关闭本组件顶部编码器 */
  renderEncoder?: boolean
  /** 体积预估模式（fast 用公式、balanced/precise 采样编码、off 隐藏） */
  estimateMode?: EstimateMode
}

const COLOR_OPTIONS = [256, 192, 128, 64]

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

function clampLongSide(value: number): number {
  return Math.max(64, Math.min(1920, Math.round(value)))
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  hint,
  fineDrag = false,
  fineDragPx = 4,
  onChange,
  disabled,
  testId,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display: React.ReactNode
  hint?: string
  /** 用覆盖层接管拖动：普通拖动按绝对位置，Shift 拖动按相对位移；拖动中可随时切换。 */
  fineDrag?: boolean
  /** 精细拖动时每移动多少像素变化 1 个单位。 */
  fineDragPx?: number
  onChange: (value: number) => void
  disabled?: boolean
  testId: string
}) {
  const percent = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0
  const dragRef = useRef<{
    pointerId: number
    mode: 'coarse' | 'fine'
    anchorX: number
    anchorValue: number
    lastValue: number
    trackLeft: number
    trackWidth: number
  } | null>(null)

  const clampValue = (next: number, valueStep: number = step) => {
    const stepped = valueStep > 0 ? Math.round(next / valueStep) * valueStep : next
    return Math.min(max, Math.max(min, Math.round(stepped)))
  }

  const applyDragValue = (next: number) => {
    const drag = dragRef.current
    if (!drag || next === drag.lastValue) return
    drag.lastValue = next
    onChange(next)
  }

  const absoluteValueAt = (clientX: number, drag: NonNullable<typeof dragRef.current>) => {
    const ratio = drag.trackWidth > 0 ? (clientX - drag.trackLeft) / drag.trackWidth : 0
    return clampValue(min + ratio * (max - min))
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    const host = event.currentTarget.parentElement
    const input = host?.querySelector('input[type="range"]') as HTMLInputElement | null
    input?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = event.currentTarget.getBoundingClientRect()
    const mode = event.shiftKey ? 'fine' : 'coarse'
    const startValue = clampValue(value)
    const drag = {
      pointerId: event.pointerId,
      mode: mode as 'coarse' | 'fine',
      anchorX: event.clientX,
      anchorValue: startValue,
      lastValue: startValue,
      trackLeft: rect.left,
      trackWidth: rect.width,
    }
    dragRef.current = drag
    if (mode === 'coarse') {
      const next = absoluteValueAt(event.clientX, drag)
      drag.anchorValue = next
      drag.lastValue = next
      onChange(next)
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const mode = event.shiftKey ? 'fine' : 'coarse'
    if (mode !== drag.mode) {
      // 拖动过程中按下/松开 Shift：从当前值重新锚定，不需要松开鼠标。
      drag.mode = mode
      drag.anchorX = event.clientX
      drag.anchorValue = drag.lastValue
      return
    }
    if (mode === 'fine') {
      const delta = Math.round((event.clientX - drag.anchorX) / Math.max(1, fineDragPx))
      // 精细拖动固定按 1 个最小单位走，不能被像素模式的正常 step=2 吸附
      applyDragValue(clampValue(drag.anchorValue + delta, 1))
    } else {
      applyDragValue(absoluteValueAt(event.clientX, drag))
    }
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className="param-control-row">
      <div className="param-control-head">
        <span className="param-control-label">{label}</span>
        <span className="param-control-value">{display}</span>
      </div>
      <div className="param-range-shell">
        <input
          className="param-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          data-testid={testId}
          style={{ ['--range-progress' as string]: percent + '%' } as React.CSSProperties}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {hint ? <div className="param-control-hint-line">{hint}</div> : null}
        {fineDrag && !disabled ? (
          <div
            className="param-range-fine-layer"
            aria-hidden="true"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          />
        ) : null}
      </div>
    </div>
  )
}

function SizeValueControl({
  value,
  unit,
  min,
  max,
  onChange,
  testId,
}: {
  value: number
  unit: '%' | 'px'
  min: number
  max: number
  onChange: (value: number) => void
  testId: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const inputRef = useRef<HTMLInputElement | null>(null)
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)))

  useEffect(() => {
    if (!editing) return
    setDraft(String(value))
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing, value])

  const commit = () => {
    const next = Number(draft)
    if (Number.isFinite(next)) onChange(clamp(next))
    setEditing(false)
  }

  return (
    <span className="param-size-stepper" data-testid={testId}>
      <button type="button" className="param-size-step" onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label="减小 1">−</button>
      {editing ? (
        <span className="param-size-edit">
          <input
            ref={inputRef}
            type="number"
            min={min}
            max={max}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(false)
              }
            }}
          />
          <span>{unit}</span>
        </span>
      ) : (
        <button type="button" className="param-size-value" onClick={() => setEditing(true)} title="点击输入精确数值">
          {value}{unit}
        </button>
      )}
      <button type="button" className="param-size-step" onClick={() => onChange(clamp(value + 1))} disabled={value >= max} aria-label="增加 1">+</button>
    </span>
  )
}

function fpsValueText(fps: number | null | undefined): string | null {
  if (!positive(fps)) return null
  const rounded = Math.round(fps * 1000) / 1000
  return String(rounded) + ' fps'
}

function sourceMetaText(summary: ParamSourceSummary | null): string {
  if (!summary) return ''
  const dims = summary.width && summary.height ? summary.width + ' × ' + summary.height : null
  const isImage = summary.kind === 'photo' || (!summary.durationSec && !summary.frameCount && !summary.fps)
  const items = isImage
    ? [dims, summary.sizeBytes ? formatSize(summary.sizeBytes) : null]
    : [
        summary.durationSec ? formatDuration(summary.durationSec) : null,
        summary.frameCount ? formatCount(summary.frameCount) + ' 帧' : null,
        fpsValueText(summary.fps),
        summary.sizeBytes ? formatSize(summary.sizeBytes) : null,
      ]
  const clean = items.filter((item): item is string => Boolean(item))
  if (clean.length === 0) return ''
  // 视频缺少帧率/帧数时补尺寸；图片只显示尺寸与大小
  if (!isImage && clean.length < 2 && dims) clean.push(dims)
  return clean.join(' · ')
}

function sourceTitle(summary: ParamSourceSummary | null): string {
  if (!summary) return ''
  const count = summary.count ?? 1
  if (summary.mixedKinds && count > 1) return '已选 ' + count + ' 个可转换 · 第 1 项参考'
  if (count > 1) return summary.kindLabel + ' · 已选 ' + count + ' 个可转换 · 第 1 项参考'
  return summary.kindLabel
}

function summaryFpsText(params: GifParams, sourceSummary: ParamSourceSummary | null): string | null {
  const sourceFps = sourceSummary?.fps ?? null
  if (params.fps === 'source') return sourceFps ? fpsValueText(sourceFps) + '（源）' : null
  return Math.round(params.fps) + ' fps'
}

interface SummaryGeometry {
  srcW: number | null
  srcH: number | null
  outW: number | null
  outH: number | null
  sourceFps: number | null
  targetFps: number
}

function resolveSummaryGeometry(
  params: GifParams,
  sourceWidth?: number | null,
  sourceHeight?: number | null,
  sourceSummary?: ParamSourceSummary | null,
): SummaryGeometry {
  const srcW = positive(sourceWidth) ? sourceWidth : null
  const srcH = positive(sourceHeight) ? sourceHeight : null
  const sourceLong = srcW !== null && srcH !== null ? Math.max(srcW, srcH) : null
  const currentLong = params.maxLongSide ?? (srcW && params.width != null ? Math.round((params.width / srcW) * (sourceLong || srcW)) : sourceLong)
  let outW: number | null = srcW
  let outH: number | null = srcH
  if (srcW !== null && srcH !== null && currentLong) {
    const width = presetWidthForSource(srcW, srcH, currentLong)
    if (width !== null) {
      outW = width
      outH = Math.max(2, even((width * srcH) / srcW))
    }
  }
  const sourceFps = sourceSummary?.fps ?? null
  const targetFps = params.fps === 'source' ? (sourceFps ?? 30) : params.fps
  return { srcW, srcH, outW, outH, sourceFps, targetFps }
}

/** 经验公式估算（无本地源 / WebP / ffmpeg / 预估失败时作为兜底展示） */
function formulaEstimate(
  params: GifParams,
  geometry: SummaryGeometry,
  sourceSummary: ParamSourceSummary | null | undefined,
  estimateCalibration: GifSizeCalibration | null | undefined,
): number | null {
  if (!geometry.srcW || !geometry.srcH || !geometry.outW || !geometry.outH || !sourceSummary?.durationSec) return null
  return estimateGifBytes({
    width: geometry.outW,
    height: geometry.outH,
    durationSec: sourceSummary.durationSec,
    fps: params.fps === 'source' ? geometry.sourceFps : geometry.targetFps,
    colors: params.colors,
    quality: params.quality,
    sourceBytes: sourceSummary?.sizeBytes,
    sourceWidth: sourceSummary?.width,
    sourceHeight: sourceSummary?.height,
    sourceFps: sourceSummary?.fps,
    sourceFrameCount: sourceSummary?.frameCount,
    calibration: estimateCalibration,
  })
}

export interface ParamEstimateState {
  /** 等待真实采样预估返回（debounce + 抽帧编码中） */
  pending: boolean
  /** 真实采样预估字节数；null 表示尚未成功（回退经验公式） */
  bytes: number | null
}

/**
 * 参数变化时 debounce 500ms 调用 Rust 侧真实「采样编码预估」。
 * 通过请求序号 + 清理标记避免拖动滑杆时旧请求覆盖新结果，且不使用任何全局可变状态。
 */
export function useGifEstimate(
  params: Pick<GifParams, 'encoder' | 'quality' | 'colors' | 'fps' | 'optimize'>,
  outputWidth: number | null,
  outputHeight: number | null,
  source: ParamSourceSummary | null | undefined,
  animFormat: AnimFormat,
  enabled: boolean,
  estimateMode: EstimateMode = 'balanced',
): ParamEstimateState {
  const request = enabled
    ? buildGifEstimateRequest(params, outputWidth, outputHeight, source, animFormat, estimateMode)
    : null
  const requestKey = request ? JSON.stringify(request) : ''
  const requestRef = useRef<GifEstimateRequest | null>(request)
  requestRef.current = request
  const sequenceRef = useRef(0)
  const [pending, setPending] = useState(false)
  const [bytes, setBytes] = useState<number | null>(null)

  useEffect(() => {
    const sequence = ++sequenceRef.current
    const current = requestRef.current
    const bridge = typeof window !== 'undefined' ? window.desktop : undefined
    if (!enabled || !current || !bridge || !bridge.gif || typeof bridge.gif.estimate !== 'function') {
      setPending(false)
      setBytes(null)
      return
    }
    setPending(true)
    setBytes(null)
    let disposed = false
    const timer = window.setTimeout(() => {
      void bridge.gif
        .estimate(current)
        .then((response) => {
          if (disposed || sequence !== sequenceRef.current) return
          if (response && response.ok === true && response.data && response.data.estimatedBytes > 0) {
            setBytes(response.data.estimatedBytes)
          } else {
            setBytes(null)
          }
          setPending(false)
        })
        .catch(() => {
          if (disposed || sequence !== sequenceRef.current) return
          setBytes(null)
          setPending(false)
        })
    }, ESTIMATE_DEBOUNCE_MS)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
    // requestKey 已覆盖全部请求参数；enabled/尺寸变化都会改变 key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requestKey])

  return { pending, bytes }
}

/** 供抽屉固定摘要区复用的实时摘要文本（同步经验公式版，供无 React 上下文复用） */
export function buildParamLiveSummary(params: GifParams, sourceWidth?: number | null, sourceHeight?: number | null, sourceSummary?: ParamSourceSummary | null, estimateCalibration?: GifSizeCalibration | null, estimateMode: EstimateMode = 'balanced'): string {
  const geometry = resolveSummaryGeometry(params, sourceWidth, sourceHeight, sourceSummary)
  const items: string[] = []
  if (geometry.srcW !== null && geometry.srcH !== null && geometry.outW && geometry.outH) items.push(geometry.outW + ' × ' + geometry.outH)
  const fpsText = summaryFpsText(params, sourceSummary ?? null)
  if (fpsText) items.push(fpsText)
  if (estimateMode !== 'off') {
    items.push(estimateDisplayText(null, formulaEstimate(params, geometry, sourceSummary, estimateCalibration)))
  }
  return items.join(' · ')
}

export interface ParamLiveSummaryProps {
  params: GifParams
  sourceWidth?: number | null
  sourceHeight?: number | null
  sourceSummary?: ParamSourceSummary | null
  estimateCalibration?: GifSizeCalibration | null
  animFormat?: AnimFormat
  estimateMode?: EstimateMode
}

/**
 * 抽屉固定摘要区：按预估模式显示——
 * - balanced/precise：有源本地路径时先「估算中…」再换成真实采样结果；
 * - fast：直接用经验公式（立即显示）；
 * - off：不显示体积估算。
 * 仅对 GIF + gifski 生效。
 */
export function ParamLiveSummary({
  params,
  sourceWidth,
  sourceHeight,
  sourceSummary = null,
  estimateCalibration = null,
  animFormat = 'gif',
  estimateMode = 'balanced',
}: ParamLiveSummaryProps) {
  const geometry = resolveSummaryGeometry(params, sourceWidth, sourceHeight, sourceSummary)
  const formula = formulaEstimate(params, geometry, sourceSummary, estimateCalibration)
  const enabled = animFormat === 'gif' && params.encoder === 'gifski' && !params.optimize && Boolean(sourceSummary?.localPath)
  const state = useGifEstimate(params, geometry.outW, geometry.outH, sourceSummary, animFormat, enabled, estimateMode)
  const items: string[] = []
  if (geometry.srcW !== null && geometry.srcH !== null && geometry.outW && geometry.outH) {
    items.push(geometry.outW + ' × ' + geometry.outH)
  }
  const fpsText = summaryFpsText(params, sourceSummary)
  if (fpsText) items.push(fpsText)
  const isOff = estimateMode === 'off'
  const isFast = estimateMode === 'fast'
  let estimateState = isOff ? 'off' : 'fallback'
  if (!isOff) {
    if (isFast) {
      if (formula !== null) items.push(estimateDisplayText(null, formula))
      estimateState = 'formula'
    } else if (state.pending) {
      items.push('估算中…')
      estimateState = 'pending'
    } else if (state.bytes !== null || formula !== null) {
      items.push(estimateDisplayText(state.bytes, formula))
      estimateState = state.bytes !== null ? 'live' : 'fallback'
    }
  }
  const text = items.length > 0 ? items.join(' · ') : '转换时计算'
  return (
    <span
      className="convert-drawer-summary-text"
      data-testid="param-estimate-text"
      data-estimate-state={estimateState}
      data-estimate-mode={estimateMode}
      data-estimate-bytes={state.bytes !== null ? String(state.bytes) : ''}
    >
      {text}
    </span>
  )
}

export function ParamPanel({
  params,
  onChange,
  sourceWidth,
  sourceHeight,
  sourceSummary = null,
  estimateCalibration = null,
  fileNamePreview,
  compact = false,
  defaultAdvancedOpen = false,
  animFormat = 'gif',
  variant = 'full',
  showSummary = true,
  gifsicleAvailable = true,
  renderEncoder = true,
  estimateMode = 'balanced',
}: ParamPanelProps) {
  const [sizeMode, setSizeMode] = useState<'percent' | 'px'>('percent')
  // 按住 Shift 时尺寸滑杆使用 1px/1% 精细步进。
  const [shiftFine, setShiftFine] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftFine(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftFine(false)
    }
    const onBlur = () => setShiftFine(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  const srcW = positive(sourceWidth) ? sourceWidth : null
  const srcH = positive(sourceHeight) ? sourceHeight : null
  const hasSource = srcW !== null && srcH !== null

  const isWebP = animFormat === 'webp'
  const isGif = !isWebP
  const isGifski = isGif && params.encoder === 'gifski'
  const isFfmpeg = isGif && params.encoder === 'ffmpeg'
  // 颜色数只对 ffmpeg 的 GIF 调色板生效；gifski 本身没有颜色数参数，不显示该项
  const showColors = isGif && isFfmpeg
  // dither 仅 ffmpeg 路径生效
  const showDither = isGif && isFfmpeg
  const showGifsicle = isGif && gifsicleAvailable
  const isFull = variant === 'full'
  const sizeBadge = '01'
  const qualityBadge = '02'
  const fpsBadge = '03'

  const update = (patch: Partial<GifParams>) => {
    onChange(clampParams({ ...params, loopCount: 0, ...patch }, srcW), null)
  }

  const legacyLong = hasSource && params.width != null && srcW ? Math.round((params.width / srcW) * (Math.max(srcW, srcH) || srcW)) : null
  const currentLong = params.maxLongSide ?? legacyLong ?? (hasSource ? Math.max(srcW, srcH) : null)
  const derived = useMemo(() => {
    if (!hasSource || !currentLong || !srcW || !srcH) return null
    const width = presetWidthForSource(srcW, srcH, currentLong)
    if (width === null) return null
    return { width, height: Math.max(2, even((width * srcH) / srcW)) }
  }, [hasSource, currentLong, srcW, srcH])
  const outputWidth = derived?.width ?? srcW
  const outputHeight = derived?.height ?? srcH
  // 实际输出宽高会被编码器友好地取偶数；像素输入框显示实际长边，避免 239 而结果 240 的不一致。
  const outputLongSide = outputWidth && outputHeight ? Math.max(outputWidth, outputHeight) : null
  const percent = hasSource && currentLong ? Math.max(10, Math.min(100, Math.round((currentLong / Math.max(srcW, srcH)) * 100))) : (params.maxLongSide != null ? Math.max(10, Math.min(100, Math.round((params.maxLongSide / 1920) * 100))) : 100)
  const shrinkPercent = srcW !== null && outputWidth ? Math.round((outputWidth / srcW - 1) * 100) : null

  const sourceFps = sourceSummary?.fps ?? null
  const sourceFpsRange = sourceSummary?.fpsMin && sourceSummary?.fpsMax && sourceSummary.fpsMin !== sourceSummary.fpsMax
    ? fpsValueText(sourceSummary.fpsMin) + '–' + fpsValueText(sourceSummary.fpsMax)
    : null
  const fpsIsSource = params.fps === 'source'
  const targetFps: number = params.fps === 'source' ? (sourceFps ?? 30) : params.fps
  const targetFpsText = fpsIsSource
    ? (sourceFps ? fpsValueText(sourceFps) + '（源）' : '保持源帧率')
    : Math.round(targetFps) + ' fps'
  const originalFpsText = sourceFpsRange ?? fpsValueText(sourceFps)
  const fpsReadout = hasSource && originalFpsText
    ? '原 ' + originalFpsText + ' → ' + targetFpsText
    : hasSource
      ? targetFpsText
      : fpsIsSource ? '导出时保持源帧率' : '输出 ' + targetFpsText

  const estimateGeometry: SummaryGeometry = {
    srcW,
    srcH,
    outW: outputWidth,
    outH: outputHeight,
    sourceFps,
    targetFps,
  }
  const estimate = formulaEstimate(params, estimateGeometry, sourceSummary, estimateCalibration)
  // 只有内嵌摘要区真的会渲染时才启动采样预估，避免抽屉里 ParamPanel(showSummary=false) 重复调用。
  const inlineEstimateVisible = variant === 'bar' && showSummary
  const liveEstimate = useGifEstimate(
    params,
    outputWidth,
    outputHeight,
    sourceSummary,
    animFormat,
    Boolean(sourceSummary?.localPath) && inlineEstimateVisible,
    estimateMode,
  )
  const isEstimateOff = estimateMode === 'off'
  const isEstimateFast = estimateMode === 'fast'
  let estimateText: string | null = null
  let estimateState = isEstimateOff ? 'off' : 'fallback'
  if (!isEstimateOff) {
    if (isEstimateFast) {
      estimateText = estimate !== null ? estimateDisplayText(null, estimate) : null
      estimateState = 'formula'
    } else if (liveEstimate.pending) {
      estimateText = '估算中…'
      estimateState = 'pending'
    } else if (liveEstimate.bytes !== null || estimate !== null) {
      estimateText = estimateDisplayText(liveEstimate.bytes, estimate)
      estimateState = liveEstimate.bytes !== null ? 'live' : 'fallback'
    }
  }
  const summaryItems = [
    hasSource && outputWidth ? outputWidth + ' × ' + outputHeight : null,
    summaryFpsText(params, sourceSummary),
    estimateText,
  ].filter((item): item is string => Boolean(item))
  const summaryText = summaryItems.length > 0 ? summaryItems.join(' · ') : '转换时计算'

  const setPercent = (value: number) => {
    if (hasSource && srcW && srcH) {
      const nextLong = value >= 100 ? null : clampLongSide((Math.max(srcW, srcH) * value) / 100)
      update({ maxLongSide: nextLong, width: null })
    } else {
      update({ maxLongSide: value >= 100 ? null : clampLongSide((1920 * value) / 100), width: null })
    }
  }
  const setPixelLong = (value: number) => {
    if (hasSource && srcW && srcH && value >= Math.max(srcW, srcH)) update({ maxLongSide: null, width: null })
    else update({ maxLongSide: clampLongSide(value), width: null })
  }
  const resetParams = () => {
    const defaults: GifParams = {
      ...params,
      encoder: 'gifski',
      width: null,
      maxLongSide: null,
      fps: 'source',
      colors: 256,
      quality: 92,
      dither: 'sierra2_4a',
      preserveTiming: true,
      optimize: false,
      lossy: 0,
      speed: 1,
      loopCount: 0,
    }
    onChange(clampParams(defaults, srcW), null)
  }

  useEffect(() => {
    if (params.loopCount !== 0) update({ loopCount: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sizeSlider = sizeMode === 'percent'
    ? { min: 10, max: 100, step: 1, fineStep: 1, value: percent, display: percent + '%' }
    : { min: 64, max: hasSource && srcW && srcH ? Math.max(64, Math.max(srcW, srcH)) : 1920, step: 2, fineStep: 1, value: outputLongSide ? Math.round(outputLongSide) : (hasSource && srcW && srcH ? Math.max(srcW, srcH) : 1920), display: outputLongSide ? Math.round(outputLongSide) + 'px' : '自动' }
  const sizeStep = shiftFine ? sizeSlider.fineStep : sizeSlider.step

  return (
    <div className={'param-editor' + (compact ? ' is-compact' : '') + ' is-' + variant} data-testid="param-editor">
      {hasSource && sourceSummary ? (
        <div className="param-source-summary" data-testid="param-source-summary">
          <div className="param-source-thumb">
            {sourceSummary.thumbnailUrl ? <img src={sourceSummary.thumbnailUrl} alt="" /> : <Icon name="film" size={18} />}
          </div>
          <div className="param-source-main">
            <div className="param-source-title">{sourceTitle(sourceSummary)}</div>
            {sourceMetaText(sourceSummary) ? <div className="param-source-meta">{sourceMetaText(sourceSummary)}</div> : null}
          </div>
        </div>
      ) : null}

      {isGif && renderEncoder ? (
        <section className="param-group param-main-group param-encoder-card" data-group="encoder">
          <div className="param-main-head">
            <h4 className="param-main-title">编码器</h4>
          </div>
          <div className="param-card-body">
            <div className="param-set">
              <div className="param-set-row">
                <span className="param-set-label">GIF 编码器</span>
                <Segmented
                  size="sm"
                  value={params.encoder}
                  options={[
                    { value: 'gifski', label: 'gifski', title: '高质量 GIF 编码' },
                    { value: 'ffmpeg', label: 'ffmpeg', title: '可调色板 / 抖动' },
                  ]}
                  onChange={(value) => update({ encoder: value })}
                />
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="param-core">
        <section className="param-group param-main-group param-size-card" data-group="size">
          <div className="param-main-head">
            <span className="param-main-index">{sizeBadge}</span>
            <h4 className="param-main-title">尺寸</h4>
            <Segmented size="sm" value={sizeMode} options={[{ value: 'percent', label: '百分比' }, { value: 'px', label: '像素' }]} onChange={(value) => setSizeMode(value)} />
          </div>
          <div className="param-card-body">
            <div className="param-set">
              <RangeControl
                label={sizeMode === 'percent' ? '按比例缩放' : '最长边'}
                hint="拖动可快速调整；按住 Shift 微调，点击数值可直接输入"
                value={sizeSlider.value}
                min={sizeSlider.min}
                max={sizeSlider.max}
                step={sizeStep}
                display={
                  <SizeValueControl
                    value={sizeSlider.value}
                    unit={sizeMode === 'percent' ? '%' : 'px'}
                    min={sizeSlider.min}
                    max={sizeSlider.max}
                    onChange={sizeMode === 'percent' ? setPercent : setPixelLong}
                    testId="param-size-value-input"
                  />
                }
                onChange={sizeMode === 'percent' ? setPercent : setPixelLong}
                fineDrag
                fineDragPx={sizeMode === 'percent' ? 4 : 8}
                testId="param-size-slider"
              />
              <div className="param-readonly-dims" data-testid="param-size-readout">
                {hasSource ? (
                  <>
                    <span className="param-dim-flow">{srcW} × {srcH} <span className="param-arrow">→</span> <strong>{outputWidth} × {outputHeight}</strong></span>
                    {shrinkPercent !== null && shrinkPercent !== 0 ? <span className="param-dim-delta">{shrinkPercent > 0 ? '+' : ''}{shrinkPercent}%</span> : null}
                  </>
                ) : sizeMode === 'percent' ? (
                  <span className="param-dim-flow">按各媒体原始尺寸的比例导出</span>
                ) : (
                  <span className="param-dim-flow">最长边 <strong>{params.maxLongSide != null ? Math.round(params.maxLongSide) + 'px' : '自动'}</strong><span className="param-dim-note"> · 转换时按各媒体换算</span></span>
                )}
                {sizeMode === 'px' && !hasSource ? (
                  <button type="button" className={'param-auto-btn' + (params.maxLongSide == null ? ' is-active' : '')} onClick={() => update({ maxLongSide: null })}>自动</button>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className="param-group param-main-group param-fps-card" data-group="fps">
          <div className="param-main-head">
            <span className="param-main-index">{fpsBadge}</span>
            <h4 className="param-main-title">帧率与速度</h4>
          </div>
          <div className="param-card-body">
            <div className="param-set">
              <div className="param-set-row">
                <span className="param-set-label">帧率</span>
                <Switch
                  checked={fpsIsSource}
                  onChange={(value) => update({ fps: value ? 'source' : (sourceFps ? Math.round(sourceFps) : 30) })}
                />
              </div>
              <div className="param-set-value" data-testid="param-fps-readout">{fpsReadout}</div>
              {!fpsIsSource ? (
                <input
                  className="param-range"
                  type="range"
                  min={4}
                  max={60}
                  step={1}
                  value={Math.round(targetFps)}
                  style={{ ['--range-progress' as string]: Math.max(0, Math.min(100, ((Math.round(targetFps) - 4) / 56) * 100)) + '%' } as React.CSSProperties}
                  onChange={(event) => update({ fps: Number(event.target.value) })}
                  data-testid="param-fps-slider"
                />
              ) : null}
            </div>

            <div className="param-set">
              <div className="param-set-row">
                <span className="param-set-label">还原逐帧时序</span>
                <Switch checked={params.preserveTiming} onChange={(value) => update({ preserveTiming: value })} />
              </div>
              <div className="param-set-desc">开启时不重采样，按源媒体每帧时间戳还原播放节奏</div>
            </div>

            <div className="param-set">
              <RangeControl label="播放速度" value={params.speed} min={0.25} max={4} step={0.25} display={params.speed + '×'} onChange={(value) => update({ speed: value })} testId="param-speed-slider" />
            </div>
          </div>
        </section>

        <section className="param-group param-main-group param-quality-card" data-group="quality">
          <div className="param-main-head">
            <span className="param-main-index">{qualityBadge}</span>
            <h4 className="param-main-title">画质</h4>
          </div>
          <div className="param-card-body">
            <div className="param-set">
              <RangeControl label="质量" value={params.quality} min={1} max={100} display={<span className="param-quality-value">{params.quality}</span>} onChange={(value) => update({ quality: value })} testId="param-quality-slider" />
            </div>

            {isGifski ? (
              <div className="param-set">
                <div className="param-set-row">
                  <span className="param-set-label">颜色设置</span>
                </div>
                <div className="param-set-desc">颜色由 gifski 自动优化</div>
              </div>
            ) : null}

            {showColors ? (
              <div className="param-set">
                <div className="param-set-row">
                  <span className="param-set-label">颜色数</span>
                  <Segmented size="sm" value={String(params.colors)} options={COLOR_OPTIONS.map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => update({ colors: Number(value) })} />
                </div>
              </div>
            ) : null}

            {showDither ? (
              <div className="param-set">
                <div className="param-set-row">
                  <span className="param-set-label">平滑渐变</span>
                  <Switch checked={params.dither !== 'none'} onChange={(value) => update({ dither: value ? 'sierra2_4a' : 'none' })} />
                </div>
                <div className="param-set-desc">减少色带，仅 ffmpeg 编码生效</div>
              </div>
            ) : null}

            {showGifsicle ? (
              <div className="param-set">
                <div className="param-set-row">
                  <span className="param-set-label">优化体积</span>
                  <Switch checked={params.optimize} onChange={(value) => update({ optimize: value })} />
                </div>
                <div className="param-set-desc">gifsicle 二次压缩，可能产生轻微色偏</div>
                {params.optimize ? (
                  <div className="param-set-option-detail">
                    <RangeControl label="有损强度" value={params.lossy} min={0} max={200} display={String(params.lossy)} onChange={(value) => update({ lossy: value })} testId="param-lossy-slider" />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {variant === 'full' ? (
        <div className="param-settings-footer" data-testid="param-settings-footer">
          <span className="param-settings-note">默认参数用于新建导出任务，修改后保存设置生效。</span>
          <button type="button" className="param-settings-reset" onClick={resetParams} data-testid="param-reset-button">恢复默认</button>
        </div>
      ) : showSummary ? (
        <div className="param-edit-summarybar" data-testid="param-live-summary">
          <span className="param-edit-summary-text" data-testid="param-estimate-text" data-estimate-state={estimateState} data-estimate-mode={estimateMode} data-estimate-bytes={liveEstimate.bytes !== null ? String(liveEstimate.bytes) : ''}>{summaryText}</span>
          <Button size="xs" variant="ghost" icon="refresh" onClick={resetParams} data-testid="param-reset-button">恢复原参数</Button>
        </div>
      ) : null}
    </div>
  )
}
