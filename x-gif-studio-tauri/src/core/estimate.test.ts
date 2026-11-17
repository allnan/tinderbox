import { describe, expect, test } from './_testkit'
import { buildGifEstimateRequest, estimateDisplayText, estimateGifBytes, estimateSizeRatio } from './estimate'

describe('estimateGifBytes', () => {
  test('有效输入返回正数且随尺寸/帧率增加', () => {
    const base = { width: 480, height: 480, durationSec: 3, fps: 30, colors: 256, quality: 92 }
    const small = estimateGifBytes(base)
    const large = estimateGifBytes({ ...base, width: 960, height: 960 })
    expect(small !== null).toBeTruthy()
    expect(large !== null).toBeTruthy()
    if (small === null || large === null) return
    expect(large > small).toBeTruthy()
    const lowFps = estimateGifBytes({ ...base, fps: 15 })
    expect(lowFps !== null && lowFps < small).toBeTruthy()
  })

  test('有源文件大小时按源体积估算（动画案例 152KB→约 3.4MB）', () => {
    const estimate = estimateGifBytes({ width: 498, height: 498, durationSec: 3, fps: 10, colors: 256, quality: 100, sourceBytes: 155_648, sourceWidth: 498, sourceHeight: 498, sourceFps: 10, sourceFrameCount: 30 })
    expect(estimate !== null).toBeTruthy()
    if (estimate === null) return
    const mb = estimate / 1024 / 1024
    expect(mb > 2.8 && mb < 4.2).toBeTruthy()
  })

  test('低质量时按 gifski 质量曲线缩小估算', () => {
    const estimate = estimateGifBytes({ width: 498, height: 498, durationSec: 3, fps: 10, colors: 256, quality: 3, sourceBytes: 155_648, sourceWidth: 498, sourceHeight: 498, sourceFps: 10, sourceFrameCount: 30 })
    expect(estimate !== null).toBeTruthy()
    if (estimate === null) return
    const kb = estimate / 1024
    expect(kb > 500 && kb < 900).toBeTruthy()
  })

  test('缺失/非法输入返回 null', () => {
    expect(estimateGifBytes({ width: null, height: 480, durationSec: 3, fps: 30, colors: 256, quality: 92 })).toBeNull()
    expect(estimateGifBytes({ width: 480, height: 480, durationSec: 0, fps: 30, colors: 256, quality: 92 })).toBeNull()
  })

  test('历史结果可校准估算', () => {
    const base = { width: 480, height: 480, durationSec: 3, fps: 30, colors: 256, quality: 92 }
    const raw = estimateGifBytes(base)
    const calibrated = estimateGifBytes({ ...base, calibration: { width: 480, height: 480, fps: 30, durationSec: 3, sizeBytes: 2_000_000 } })
    expect(raw !== null && calibrated !== null).toBeTruthy()
    if (raw === null || calibrated === null) return
    expect(calibrated).toBe(2_000_000)
  })

  test('有源本地路径 + gifski 时构造采样预估请求', () => {
    const request = buildGifEstimateRequest(
      { encoder: 'gifski', quality: 92, colors: 256, fps: 'source', optimize: false },
      498,
      498,
      { localPath: 'C:\\media\\source.mp4', width: 498, height: 498, fps: 10, durationSec: 3, frameCount: 30 },
      'gif',
    )
    expect(request !== null).toBeTruthy()
    if (!request) return
    expect(request.filePath).toBe('C:\\media\\source.mp4')
    expect(request.width).toBe(498)
    expect(request.height).toBe(498)
    expect(request.fps).toBe(10)
    expect(request.quality).toBe(92)
    expect(request.encoder).toBe('gifski')
    expect(request.frameCount).toBe(30)
  })

  test('显式目标帧率优先于源帧率', () => {
    const request = buildGifEstimateRequest(
      { encoder: 'gifski', quality: 50, colors: 256, fps: 15, optimize: false },
      240,
      240,
      { localPath: 'C:\\m.mp4', fps: 30, durationSec: 2, frameCount: 60 },
      'gif',
    )
    expect(request?.fps).toBe(15)
    expect(request?.width).toBe(240)
  })

  test('WebP / ffmpeg / gifsicle 优化 / 无路径 / 无尺寸时回退经验公式', () => {
    const params = { encoder: 'gifski' as const, quality: 92, colors: 256, fps: 'source' as const, optimize: false }
    const source = { localPath: 'C:\\m.mp4', fps: 10, durationSec: 3, frameCount: 30 }
    expect(buildGifEstimateRequest(params, 100, 100, source, 'webp')).toBeNull()
    expect(buildGifEstimateRequest({ ...params, encoder: 'ffmpeg' as const }, 100, 100, source, 'gif')).toBeNull()
    expect(buildGifEstimateRequest({ ...params, optimize: true }, 100, 100, source, 'gif')).toBeNull()
    expect(buildGifEstimateRequest(params, 100, 100, { ...source, localPath: null }, 'gif')).toBeNull()
    expect(buildGifEstimateRequest(params, null, 100, source, 'gif')).toBeNull()
    expect(buildGifEstimateRequest(params, 100, 100, { localPath: 'C:\\m.mp4', durationSec: 0 }, 'gif')).toBeNull()
  })

  test('预估模式：fast/off 不调用采样，precise 透传 mode', () => {
    const params = { encoder: 'gifski' as const, quality: 92, colors: 256, fps: 'source' as const, optimize: false }
    const source = { localPath: 'C:\\m.mp4', fps: 10, durationSec: 3, frameCount: 30 }
    expect(buildGifEstimateRequest(params, 100, 100, source, 'gif', 'fast')).toBeNull()
    expect(buildGifEstimateRequest(params, 100, 100, source, 'gif', 'off')).toBeNull()
    expect(buildGifEstimateRequest(params, 100, 100, source, 'gif', 'balanced')?.mode).toBe('balanced')
    expect(buildGifEstimateRequest(params, 100, 100, source, 'gif', 'precise')?.mode).toBe('precise')
  })

  test('预估文案优先真实采样结果，其次经验公式值', () => {
    expect(estimateDisplayText(3_600_000, 3_100_000)).toBe('≈ ' + '3.43 MB')
    expect(estimateDisplayText(null, 3_100_000)).toContain('≈')
    expect(estimateDisplayText(null, null)).toBe('转换时计算')
  })

  test('estimateSizeRatio 计算变化幅度', () => {
    expect(estimateSizeRatio(480, 1080)).toBe(-56)
    expect(estimateSizeRatio(1080, 1080)).toBe(0)
    expect(estimateSizeRatio(null, 1080)).toBeNull()
  })
})
