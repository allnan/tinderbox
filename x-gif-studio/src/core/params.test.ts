import { describe, expect, test } from './_testkit'
import { DEFAULT_PARAMS, GIF_PRESETS, PARAM_LIMITS, findPreset } from '../shared/presets'
import {
  animFormatLabel,
  clampParams,
  detectPresetId,
  ditherLabel,
  encoderLabel,
  fpsLabel,
  getPreset,
  loopLabel,
  normalizeParams,
  paramsEqual,
  presetWidthForSource,
  percentFromWidth,
  presetName,
  roundEvenWidth,
  speedLabel,
  widthFromPercent,
  summarizeParams,
  widthLabel,
} from './params'

describe('normalizeParams', () => {
  test('空对象补全为 DEFAULT_PARAMS', () => {
    expect(normalizeParams({})).toEqual(DEFAULT_PARAMS)
    expect(normalizeParams(null)).toEqual(DEFAULT_PARAMS)
    expect(normalizeParams(undefined)).toEqual(DEFAULT_PARAMS)
  })

  test('未知字段被忽略，合法字段保留', () => {
    const params = normalizeParams({ quality: 60, width: 480, foo: 'bar' } as never)
    expect(params.quality).toBe(60)
    expect(params.width).toBe(480)
    expect('foo' in params).toBeFalsy()
  })

  test('越界数值自动收敛到安全范围', () => {
    expect(normalizeParams({ width: 99999 }).width).toBe(PARAM_LIMITS.widthMax)
    expect(normalizeParams({ width: 1 }).width).toBe(PARAM_LIMITS.widthMin)
    expect(normalizeParams({ fps: 999 }).fps).toBe(PARAM_LIMITS.fpsMax)
    expect(normalizeParams({ fps: 0 }).fps).toBe(PARAM_LIMITS.fpsMin)
    expect(normalizeParams({ colors: 0 }).colors).toBe(PARAM_LIMITS.colorsMin)
    expect(normalizeParams({ colors: 999 }).colors).toBe(PARAM_LIMITS.colorsMax)
    expect(normalizeParams({ quality: 0 }).quality).toBe(PARAM_LIMITS.qualityMin)
    expect(normalizeParams({ lossy: 500 }).lossy).toBe(PARAM_LIMITS.lossyMax)
    expect(normalizeParams({ speed: 10 }).speed).toBe(PARAM_LIMITS.speedMax)
    expect(normalizeParams({ loopCount: -999 }).loopCount).toBe(PARAM_LIMITS.loopMin)
    expect(normalizeParams({ loopCount: 500 }).loopCount).toBe(PARAM_LIMITS.loopMax)
  })

  test('非法枚举回退默认值', () => {
    const params = normalizeParams({ encoder: 'bad' as never, dither: 'bad' as never, fps: 'nope' as never })
    expect(params.encoder).toBe(DEFAULT_PARAMS.encoder)
    expect(params.dither).toBe(DEFAULT_PARAMS.dither)
    expect(params.fps).toBe(30)
  })

  test('支持 fps=source 与 width=null', () => {
    const params = normalizeParams({ fps: 'source', width: null })
    expect(params.fps).toBe('source')
    expect(params.width).toBeNull()
  })
})

describe('clampParams', () => {
  test('传入源宽度时不放大', () => {
    const params = clampParams({ ...DEFAULT_PARAMS, width: 800 }, 640)
    expect(params.width).toBe(640)
    const same = clampParams({ ...DEFAULT_PARAMS, width: 480 }, 1920)
    expect(same.width).toBe(480)
  })

  test('源宽度小于下限时收敛到下限', () => {
    expect(clampParams({ ...DEFAULT_PARAMS, width: 100 }, 32).width).toBe(64)
  })
})

describe('detectPresetId / 预设查询', () => {
  test('每个预设都能被识别', () => {
    for (const preset of GIF_PRESETS) {
      expect(detectPresetId(preset.params)).toBe(preset.id)
    }
  })

  test('自定义参数返回 null', () => {
    expect(detectPresetId({ ...DEFAULT_PARAMS, quality: 50 })).toBeNull()
  })

  test('getPreset / presetName', () => {
    expect(getPreset('balanced')?.name).toBe(GIF_PRESETS.find((preset) => preset.id === 'balanced')?.name)
    expect(getPreset('missing')).toBeNull()
    expect(presetName('small')).toBe(GIF_PRESETS.find((preset) => preset.id === 'small')?.name)
    expect(presetName(null)).toBe('自定义参数')
  })
})

describe('参数文案', () => {
  test('宽度 / 帧率 / 循环 / 速度 / 编码器 / 抖动', () => {
    expect(widthLabel(null)).toBe('原始宽度')
    expect(widthLabel(480)).toBe('480px')
    expect(fpsLabel('source')).toBe('源帧率')
    expect(fpsLabel(24)).toBe('24 fps')
    expect(loopLabel(0)).toBe('无限循环')
    expect(loopLabel(-1)).toBe('不循环（只播放一次）')
    expect(loopLabel(1)).toBe('播放 1 次')
    expect(loopLabel(3)).toBe('循环 3 次')
    expect(speedLabel(1)).toBe('原速')
    expect(speedLabel(1.5)).toBe('1.5× 速度')
    expect(encoderLabel('ffmpeg')).toContain('ffmpeg')
    expect(ditherLabel('none')).toBe('无抖动')
    expect(ditherLabel('bayer')).toContain('Bayer')
  })
})

describe('summarizeParams', () => {
  test('预设参数摘要包含关键信息', () => {
    const summary = summarizeParams(DEFAULT_PARAMS, 'source')
    expect(summary).toContain(presetName('source'))
    expect(summary).toContain('gifski')
    expect(summary).toContain('原始宽度')
    expect(summary).toContain('源帧率')
    expect(summary).toContain('质量 ' + DEFAULT_PARAMS.quality)
  })

  test('优化、速度、循环等非常规参数会被标注', () => {
    const summary = summarizeParams({
      ...DEFAULT_PARAMS,
      optimize: true,
      lossy: 60,
      speed: 2,
      loopCount: 3,
      preserveTiming: false,
    })
    expect(summary).toContain('极限压缩')
    expect(summary).toContain('lossy 60')
    expect(summary).toContain('2× 速度')
    expect(summary).toContain('循环 3 次')
    expect(summary).toContain('不还原逐帧时序')
  })

  test('自定义参数标注为自定义', () => {
    expect(summarizeParams({ ...DEFAULT_PARAMS, quality: 50 })).toContain('自定义参数')
  })
})

describe('paramsEqual', () => {
  test('相同参数为 true，不同为 false', () => {
    expect(paramsEqual(DEFAULT_PARAMS, { ...DEFAULT_PARAMS })).toBeTruthy()
    expect(paramsEqual(DEFAULT_PARAMS, { ...DEFAULT_PARAMS, quality: 80 })).toBeFalsy()
  })
})
describe('宽度像素/百分比换算', () => {
  test('596 × 50% = 298（偶数、不超源宽）', () => {
    expect(widthFromPercent(596, 50)).toBe(298)
  })

  test('百分比越界收敛到 10-100，结果四舍五入到偶数且不超过源宽', () => {
    expect(widthFromPercent(596, 5)).toBe(PARAM_LIMITS.widthMin)
    expect(widthFromPercent(596, 200)).toBe(596)
    expect(widthFromPercent(596, 37)).toBe(220)
    expect(widthFromPercent(597, 100)).toBe(596)
  })

  test('percentFromWidth 按源宽反推并收敛', () => {
    expect(percentFromWidth(298, 596)).toBe(50)
    expect(percentFromWidth(null, 596)).toBe(100)
    expect(percentFromWidth(596, null)).toBe(100)
    expect(percentFromWidth(10, 596)).toBe(10)
  })

  test('roundEvenWidth 限制范围并取偶', () => {
    expect(roundEvenWidth(301, 596)).toBe(302)
    expect(roundEvenWidth(10, 596)).toBe(PARAM_LIMITS.widthMin)
    expect(roundEvenWidth(9999, 596)).toBe(596)
  })
})
describe('animFormatLabel', () => {
  test('GIF / WebP 与旧数据缺省', () => {
    expect(animFormatLabel('gif')).toBe('GIF')
    expect(animFormatLabel('webp')).toBe('WebP')
    expect(animFormatLabel(undefined)).toBe('GIF')
    expect(animFormatLabel(null)).toBe('GIF')
  })
})
describe('summarizeParams 按格式改写', () => {
  test('WebP 摘要不含 gifski/颜色数/极限压缩', () => {
    const summary = summarizeParams({ ...DEFAULT_PARAMS, optimize: true, lossy: 40 }, 'source', 'webp')
    expect(summary).toContain('WebP')
    expect(summary).toContain('质量 ')
    expect(summary.includes('gifski')).toBeFalsy()
    expect(summary.includes('色')).toBeFalsy()
    expect(summary.includes('极限压缩')).toBeFalsy()
  })

  test('GIF 摘要保留编码器与颜色数', () => {
    const summary = summarizeParams(DEFAULT_PARAMS, 'source', 'gif')
    expect(summary).toContain('gifski')
    expect(summary).toContain('色')
  })
})

describe('最长边预设', () => {
  test('轻量 / 极小预设的最长边与参数', () => {
    const small = findPreset('small')
    expect(small?.maxLongSide).toBe(720)
    expect(small?.params.fps).toBe(20)
    expect(small?.params.colors).toBe(128)
    const mini = findPreset('mini')
    expect(mini?.maxLongSide).toBe(480)
    expect(mini?.params.fps).toBe(15)
    expect(mini?.params.colors).toBe(64)
    expect(mini?.params.width).toBeNull()
  })

  test('presetWidthForSource 横图按最长边 480 换算', () => {
    expect(presetWidthForSource(1080, 720, 480)).toBe(480)
  })

  test('presetWidthForSource 竖图按最长边 480 换算', () => {
    expect(presetWidthForSource(720, 1080, 480)).toBe(320)
  })

  test('presetWidthForSource 不放大源媒体', () => {
    expect(presetWidthForSource(640, 360, 720)).toBe(640)
    expect(presetWidthForSource(360, 640, 720)).toBe(360)
  })

  test('最长边预设识别时忽略动态宽度', () => {
    const small = findPreset('small')
    const mini = findPreset('mini')
    expect(small === null).toBeFalsy()
    expect(mini === null).toBeFalsy()
    if (!small || !mini) return
    expect(detectPresetId({ ...small.params, width: 360 })).toBe('small')
    expect(detectPresetId({ ...mini.params, width: 320 })).toBe('mini')
  })
})
