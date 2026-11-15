import React, { useEffect, useMemo, useState } from 'react'
import type { AnimFormat, GifParams } from '../shared/types'
import { clampParams, presetWidthForSource } from '../core/params'
import { estimateGifBytes, type GifSizeCalibration } from '../core/estimate'
import { formatCount, formatDuration, formatFps, formatSize } from '../core/format'
import { Button, Icon, Segmented, Switch } from './ui'

export interface ParamSourceSummary {
  kindLabel: string
  kind?: 'gif' | 'video' | 'photo' | string
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
  onChange: (value: number) => void
  disabled?: boolean
  testId: string
}) {
  const percent = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0
  return (
    <div className="param-control-row">
      <div className="param-control-head">
        <span className="param-control-label">{label}</span>
        <span className="param-control-value">{display}</span>
      </div>
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
    </div>
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

/** 供抽屉固定摘要区复用的实时摘要文本 */
export function buildParamLiveSummary(params: GifParams, sourceWidth?: number | null, sourceHeight?: number | null, sourceSummary?: ParamSourceSummary | null, estimateCalibration?: GifSizeCalibration | null): string {
  const srcW = positive(sourceWidth) ? sourceWidth : null
  const srcH = positive(sourceHeight) ? sourceHeight : null
  const sourceLong = srcW !== null && srcH !== null ? Math.max(srcW, srcH) : null
  const currentLong = params.maxLongSide ?? (srcW && params.width != null ? Math.round((params.width / srcW) * (sourceLong || srcW)) : sourceLong)
  let outW = srcW
  let outH = srcH
  if (srcW !== null && srcH !== null && currentLong) {
    const width = presetWidthForSource(srcW, srcH, currentLong)
    if (width !== null) {
      outW = width
      outH = Math.max(2, even((width * srcH) / srcW))
    }
  }
  const sourceFps = sourceSummary?.fps ?? null
  const targetFps = params.fps === 'source' ? (sourceFps ?? 30) : params.fps
  const items: string[] = []
  if (srcW !== null && srcH !== null && outW && outH) items.push(outW + ' × ' + outH)
  const fpsText = summaryFpsText(params, sourceSummary ?? null)
  if (fpsText) items.push(fpsText)
  const estimate = srcW !== null && srcH !== null && outW && outH && sourceSummary?.durationSec
    ? estimateGifBytes({
        width: outW,
        height: outH,
        durationSec: sourceSummary.durationSec,
        fps: params.fps === 'source' ? sourceFps : targetFps,
        colors: params.colors,
        quality: params.quality,
        calibration: estimateCalibration,
      })
    : null
  items.push(estimate ? '≈ ' + formatSize(estimate) : '转换时计算')
  return items.join(' · ')
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
}: ParamPanelProps) {
  const [sizeMode, setSizeMode] = useState<'percent' | 'px'>('percent')
  const srcW = positive(sourceWidth) ? sourceWidth : null
  const srcH = positive(sourceHeight) ? sourceHeight : null
  const hasSource = srcW !== null && srcH !== null

  const isWebP = animFormat === 'webp'
  const isGif = !isWebP
  const isGifski = isGif && params.encoder === 'gifski'
  const isFfmpeg = isGif && params.encoder === 'ffmpeg'
  // 颜色数只对 ffmpeg 的 GIF 调色板生效；gifski 自动优化调色板
  const showColors = isGif && isFfmpeg
  // dither 仅 ffmpeg 路径生效
  const showDither = isGif && isFfmpeg
  const showGifsicle = isGif && gifsicleAvailable

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

  const estimate = hasSource && outputWidth && outputHeight && sourceSummary?.durationSec
    ? estimateGifBytes({
        width: outputWidth,
        height: outputHeight,
        durationSec: sourceSummary.durationSec,
        fps: fpsIsSource ? sourceFps : targetFps,
        colors: params.colors,
        quality: params.quality,
        calibration: estimateCalibration,
      })
    : null
  const estimateText = estimate ? '≈ ' + formatSize(estimate) : '转换时计算'
  const summaryItems = [
    hasSource && outputWidth ? outputWidth + ' × ' + outputHeight : null,
    summaryFpsText(params, sourceSummary),
    estimate ? '≈ ' + formatSize(estimate) : null,
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
    onChange(clampParams({ ...params, width: null, maxLongSide: null, fps: 'source', colors: 256, quality: 92, dither: 'sierra2_4a', preserveTiming: true, optimize: false, lossy: 0, speed: 1, loopCount: 0 }, srcW), null)
  }

  useEffect(() => {
    if (params.loopCount !== 0) update({ loopCount: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sizeSlider = sizeMode === 'percent'
    ? { min: 10, max: 100, step: 1, value: percent, display: percent + '%' }
    : { min: 64, max: hasSource && srcW && srcH ? Math.max(64, Math.max(srcW, srcH)) : 1920, step: 2, value: currentLong ? Math.round(currentLong) : (hasSource && srcW && srcH ? Math.max(srcW, srcH) : 1920), display: currentLong ? Math.round(currentLong) + 'px' : '自动' }

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
        <section className="param-group param-main-group param-output-encoder" data-group="encoder">
          <div className="param-main-head">
            <span className="param-main-index">OUT</span>
            <h4 className="param-main-title">编码器</h4>
            <span className="param-encoder-hint">GIF 编码方式</span>
          </div>
          <Segmented
            size="sm"
            value={params.encoder}
            options={[
              { value: 'gifski', label: 'gifski', title: '高质量 GIF 编码' },
              { value: 'ffmpeg', label: 'ffmpeg', title: '可调色板 / 抖动' },
            ]}
            onChange={(value) => update({ encoder: value })}
          />
        </section>
      ) : null}

      <div className="param-core">
        <section className="param-group param-main-group" data-group="size">
          <div className="param-main-head">
            <span className="param-main-index">01</span>
            <h4 className="param-main-title">尺寸</h4>
            <Segmented size="sm" value={sizeMode} options={[{ value: 'percent', label: '百分比' }, { value: 'px', label: '像素' }]} onChange={(value) => setSizeMode(value)} />
          </div>
          <RangeControl
            label={sizeMode === 'percent' ? '按比例缩放' : '最长边'}
            value={sizeSlider.value}
            min={sizeSlider.min}
            max={sizeSlider.max}
            step={sizeSlider.step}
            display={sizeSlider.display}
            onChange={sizeMode === 'percent' ? setPercent : setPixelLong}
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
        </section>

        <div className="param-pair-grid">
          <section className="param-group param-main-group" data-group="fps">
            <div className="param-main-head">
              <span className="param-main-index">02</span>
              <h4 className="param-main-title">帧率与速度</h4>
              <Switch
                checked={fpsIsSource}
                label="源帧率"
                onChange={(value) => update({ fps: value ? 'source' : (sourceFps ? Math.round(sourceFps) : 30) })}
              />
            </div>
            <div className="param-fps-readout" data-testid="param-fps-readout">{fpsReadout}</div>
            {fpsIsSource ? (
              <div className="param-inline-note">保持源帧率与逐帧时序，导出时不重采样</div>
            ) : (
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
            )}
            <div className="param-fps-speed">
              <RangeControl label="播放速度" value={params.speed} min={0.25} max={4} step={0.25} display={params.speed + '×'} onChange={(value) => update({ speed: value })} testId="param-speed-slider" />
            </div>
            <div className="param-switch-row param-compact-switch">
              <div><div className="param-control-label">还原逐帧时序</div><div className="param-control-sub">开启时不重采样，按源媒体每帧时间戳还原播放节奏</div></div>
              <Switch checked={params.preserveTiming} onChange={(value) => update({ preserveTiming: value })} />
            </div>
          </section>

          <section className="param-group param-main-group" data-group="quality">
            <div className="param-main-head">
              <span className="param-main-index">03</span>
              <h4 className="param-main-title">画质</h4>
            </div>
            <RangeControl label="质量" value={params.quality} min={1} max={100} display={<span className="param-quality-value">{params.quality}</span>} onChange={(value) => update({ quality: value })} testId="param-quality-slider" />
            {showColors ? (
              <div className="param-colors-row">
                <span className="param-control-label">颜色数</span>
                <Segmented size="sm" value={String(params.colors)} options={COLOR_OPTIONS.map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => update({ colors: Number(value) })} />
              </div>
            ) : isGifski ? (
              <div className="param-inline-note">调色板由 gifski 自动优化</div>
            ) : null}
            {showDither ? (
              <div className="param-switch-row param-quality-dither">
                <div><div className="param-control-label">平滑渐变</div><div className="param-control-sub">减少色带，仅 ffmpeg 编码生效</div></div>
                <Switch checked={params.dither !== 'none'} onChange={(value) => update({ dither: value ? 'sierra2_4a' : 'none' })} />
              </div>
            ) : null}
            {showGifsicle ? (
              <div className="param-switch-row param-quality-optimize">
                <div><div className="param-control-label">优化体积</div><div className="param-control-sub">gifsicle 二次压缩，可能产生轻微色偏</div></div>
                <Switch checked={params.optimize} onChange={(value) => update({ optimize: value })} />
              </div>
            ) : null}
            {showGifsicle && params.optimize ? (
              <RangeControl label="有损强度" value={params.lossy} min={0} max={200} display={String(params.lossy)} onChange={(value) => update({ lossy: value })} testId="param-lossy-slider" />
            ) : null}
          </section>
        </div>
      </div>

      {showSummary ? (
        <div className="param-edit-summarybar" data-testid="param-live-summary">
          <span className="param-edit-summary-text">{summaryText}</span>
          <Button size="xs" variant="ghost" icon="refresh" onClick={resetParams} data-testid="param-reset-button">恢复原参数</Button>
        </div>
      ) : null}
    </div>
  )
}
