import type { EstimateMode, GifEstimateRequest, GifParams } from '../shared/types'
import { formatSize } from './format'

/**
 * GIF 体积预估。
 *
 * - 有本地源文件且编码器为 gifski 时：界面会 debounce 调用真实「采样编码预估」
 *   （desktop.gif.estimate，由 Rust 侧按目标参数抽帧编码后外推），见 buildGifEstimateRequest；
 * - 没有源文件 / WebP / ffmpeg 编码 / 预估失败时：回退到本文件的经验公式（仅界面预览）。
 */
export interface GifSizeCalibration {
  width: number
  height: number
  fps: number
  durationSec: number
  sizeBytes: number
}

export interface GifSizeEstimateInput {
  width: number | null | undefined
  height: number | null | undefined
  durationSec: number | null | undefined
  fps: number | null | undefined
  colors: number
  quality: number
  /** 源文件大小、源尺寸/帧率：有源文件时用「源文件体积 × GIF 膨胀系数」估算，
   * 比单纯按像素猜 bpp 准确得多（同一源 MP4/GIF 实际导出约为源文件 22–25 倍）。 */
  sourceBytes?: number | null
  sourceWidth?: number | null
  sourceHeight?: number | null
  sourceFps?: number | null
  sourceFrameCount?: number | null
  calibration?: GifSizeCalibration | null
}

function validPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function colorFactor(colors: number): number {
  const safe = Math.min(256, Math.max(2, Number.isFinite(colors) ? colors : 256))
  return 0.035 + (safe / 256) * 0.07
}

function qualityFactor(quality: number): number {
  const safe = Math.min(100, Math.max(1, Number.isFinite(quality) ? quality : 92))
  return 0.65 + (safe / 100) * 0.7
}

/** 采样编码预估的防抖间隔（毫秒）：拖动滑杆时避免连续触发 ffmpeg/gifski。 */
export const ESTIMATE_DEBOUNCE_MS = 500

export interface GifEstimateSource {
  /** 源本地文件路径（已保存/已缓存的原文件） */
  localPath?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  durationSec?: number | null
  frameCount?: number | null
}

/**
 * 构造采样编码预估请求。只有「GIF + gifski 且关闭 gifsicle 优化 + 有源本地路径 +
 * 有目标尺寸/时长」时才返回请求，其余情况返回 null 由界面回退经验公式。
 */
export function buildGifEstimateRequest(
  params: Pick<GifParams, 'encoder' | 'quality' | 'colors' | 'fps' | 'optimize'>,
  outputWidth: number | null | undefined,
  outputHeight: number | null | undefined,
  source: GifEstimateSource | null | undefined,
  animFormat: 'gif' | 'webp' = 'gif',
  mode: EstimateMode = 'balanced',
): GifEstimateRequest | null {
  // 快速（公式）/ 关闭模式不调用采样编码
  if (mode !== 'balanced' && mode !== 'precise') return null
  if (animFormat !== 'gif') return null
  if (params.encoder !== 'gifski') return null
  if (params.optimize) return null
  const filePath = typeof source?.localPath === 'string' ? source.localPath.trim() : ''
  if (!filePath) return null
  if (!validPositive(outputWidth) || !validPositive(outputHeight)) return null
  if (!validPositive(source?.durationSec)) return null
  const fps = params.fps === 'source' ? source?.fps ?? null : params.fps
  return {
    filePath,
    width: Math.round(outputWidth),
    height: Math.round(outputHeight),
    fps: validPositive(fps) ? fps : null,
    quality: Math.min(100, Math.max(1, Math.round(params.quality))),
    colors: params.colors,
    encoder: 'gifski',
    durationSec: source?.durationSec,
    frameCount: validPositive(source?.frameCount) ? Math.round(source.frameCount) : null,
    mode,
  }
}

/** 预估展示文案：命中真实采样结果时用其字节数，否则用经验公式值。 */
export function estimateDisplayText(liveBytes: number | null | undefined, fallbackBytes: number | null | undefined): string {
  if (validPositive(liveBytes)) return '≈ ' + formatSize(liveBytes)
  if (validPositive(fallbackBytes)) return '≈ ' + formatSize(fallbackBytes)
  return '转换时计算'
}

export function estimateGifBytes(input: GifSizeEstimateInput): number | null {
  const { width, height, durationSec, fps, colors, quality, sourceBytes, sourceWidth, sourceHeight, sourceFps, sourceFrameCount, calibration } = input
  if (!validPositive(width) || !validPositive(height) || !validPositive(durationSec) || !validPositive(fps)) return null
  const frames = Math.max(1, durationSec * fps)
  const pixels = width * height * frames
  let bytes: number
  if (calibration && validPositive(calibration.width) && validPositive(calibration.height) && validPositive(calibration.fps) && validPositive(calibration.durationSec) && validPositive(calibration.sizeBytes)) {
    const calibratedPixels = calibration.width * calibration.height * calibration.fps * calibration.durationSec
    const bpp = calibration.sizeBytes / calibratedPixels
    bytes = pixels * bpp * (qualityFactor(quality) / qualityFactor(92))
  } else if (validPositive(sourceBytes) && validPositive(sourceWidth) && validPositive(sourceHeight) && validPositive(sourceFps)) {
    // 经验值：源视频/GIF 转成高质量 GIF，体积通常约为源文件的 22–25 倍；
    // 再按输出/源的像素比和帧数比缩放。这个模型对动画、实拍都比固定 bpp 稳定。
    const outFrames = Math.max(1, durationSec * fps)
    const sourceFrames = validPositive(sourceFrameCount) ? sourceFrameCount : Math.max(1, sourceFps * durationSec)
    const pixelRatio = (width * height) / (sourceWidth * sourceHeight)
    const frameRatio = outFrames / sourceFrames
    // gifski 质量对体积影响很大：实测同一源 quality 100 约 3.43 MB、quality 3 约 667 KB。
    // 用线性膨胀系数拟合：q100≈22.6×源、q3≈4.4×源；再乘像素/帧数比例。
    const quality = Math.min(100, Math.max(1, Number.isFinite(input.quality) ? input.quality : 92))
    const expansion = 0.1876 * quality + 3.837
    bytes = sourceBytes * expansion * pixelRatio * frameRatio
  } else {
    bytes = pixels * colorFactor(colors) * qualityFactor(quality)
  }
  return Math.max(8 * 1024, Math.round(bytes))
}

/** 占比：当前尺寸/帧率相对源参数的比例，用于展示 -56% 这类提示 */
export function estimateSizeRatio(current: number | null | undefined, source: number | null | undefined): number | null {
  if (!validPositive(current) || !validPositive(source)) return null
  return Math.round((current / source - 1) * 100)
}
