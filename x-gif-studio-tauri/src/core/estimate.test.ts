import { describe, expect, test } from './_testkit'
import { estimateGifBytes, estimateSizeRatio } from './estimate'

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

  test('estimateSizeRatio 计算变化幅度', () => {
    expect(estimateSizeRatio(480, 1080)).toBe(-56)
    expect(estimateSizeRatio(1080, 1080)).toBe(0)
    expect(estimateSizeRatio(null, 1080)).toBeNull()
  })
})
