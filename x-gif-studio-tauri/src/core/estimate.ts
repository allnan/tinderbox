/**
 * GIF 体积经验估算（仅用于界面预览，不代表最终结果）。
 * 以像素 × 帧数 × 颜色/质量系数估算 bpp；有同一媒体的历史结果时用其校准。
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

export function estimateGifBytes(input: GifSizeEstimateInput): number | null {
  const { width, height, durationSec, fps, colors, quality, calibration } = input
  if (!validPositive(width) || !validPositive(height) || !validPositive(durationSec) || !validPositive(fps)) return null
  const frames = Math.max(1, durationSec * fps)
  const pixels = width * height * frames
  let bytes: number
  if (calibration && validPositive(calibration.width) && validPositive(calibration.height) && validPositive(calibration.fps) && validPositive(calibration.durationSec) && validPositive(calibration.sizeBytes)) {
    const calibratedPixels = calibration.width * calibration.height * calibration.fps * calibration.durationSec
    const bpp = calibration.sizeBytes / calibratedPixels
    bytes = pixels * bpp * (qualityFactor(quality) / qualityFactor(92))
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
