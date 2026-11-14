import type { GifParams, GifPreset } from './types'

/** 所有可调参数的安全范围（主进程与界面共同校验） */
export const PARAM_LIMITS = {
  widthMin: 64,
  widthMax: 1920,
  fpsMin: 4,
  fpsMax: 60,
  colorsMin: 16,
  colorsMax: 256,
  qualityMin: 1,
  qualityMax: 100,
  lossyMin: 0,
  lossyMax: 200,
  speedMin: 0.25,
  speedMax: 4,
  // -1 = 不循环（不写 NETSCAPE2.0），0 = 无限循环
  loopMin: -1,
  loopMax: 100,
} as const

export const DEFAULT_PARAMS: GifParams = {
  encoder: 'gifski',
  width: null,
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

/**
 * 预设说明（参数会由主进程再次补全与校验；全部使用 gifski 编码，optimize 一律关闭）：
 *
 * 设计依据（ScreenToGif 参数指南 / Photoshop Save for Web / HandBrake 预设 / gifsicle 实践）：
 * - 分辨率对体积影响最大，其次是色数与帧率；因此不在两个小体积预设里重复「只砍宽度」。
 * - 均衡：保留尺寸与帧率，只降色数（256→192）与质量，作为无损观感的折中。
 * - 轻量：最长边不超过 720px（按横竖方向动态换算宽度），20fps + 128 色，适合网页/聊天。
 * - 极小：最长边不超过 480px（按横竖方向动态换算宽度），15fps + 64 色 + q75，适合表情包。
 *
 * 体积以实际转换结果为准；不同源媒体内容/时长差异很大，预设只保证参数策略一致。
 *
 * gifsicle 的 -O3 --lossy --colors 虽然能再压 40%+，但实测会让高光/浅色毛发出现
 * 绿/黄色斑（PSNR 从约 38dB 掉到约 26dB），因此不属于任何预设；
 * 它只作为「高级：极限压缩（有损，可能偏色）」选项由用户手动开启（optimize=true, lossy>0）。
 */
export const GIF_PRESETS: GifPreset[] = [
  {
    id: 'source',
    name: '最高画质',
    description: '保留原始分辨率与逐帧时序，画质优先',
    params: { ...DEFAULT_PARAMS },
    maxLongSide: null,
  },
  {
    id: 'balanced',
    name: '均衡压缩',
    description: '保留原始分辨率与帧率，192 色，体积更小、观感接近原图',
    params: {
      ...DEFAULT_PARAMS,
      colors: 192,
      quality: 85,
    },
    maxLongSide: null,
  },
  {
    id: 'small',
    name: '轻量体积',
    description: '最长边不超过 720px，20fps、128 色，适合网页与聊天',
    params: {
      ...DEFAULT_PARAMS,
      width: null,
      fps: 20,
      colors: 128,
      quality: 82,
    },
    maxLongSide: 720,
  },
  {
    id: 'mini',
    name: '极小体积',
    description: '最长边不超过 480px，15fps、64 色，适合表情包，体积最小',
    params: {
      ...DEFAULT_PARAMS,
      width: null,
      fps: 15,
      colors: 64,
      quality: 75,
    },
    maxLongSide: 480,
  },
]

export function findPreset(id: string | null | undefined): GifPreset | null {
  if (!id) return null
  return GIF_PRESETS.find((preset) => preset.id === id) ?? null
}

/** 根据参数反推最接近的预设 id（用于界面高亮） */
export function detectPreset(params: GifParams): string | null {
  const keys: (keyof GifParams)[] = [
    'encoder',
    'width',
    'fps',
    'colors',
    'quality',
    'dither',
    'preserveTiming',
    'optimize',
    'lossy',
    'speed',
    'loopCount',
  ]
  for (const preset of GIF_PRESETS) {
    // 最长边预设的输出宽度由每个媒体动态推导，不参与预设识别
    const compareKeys = preset.maxLongSide !== null ? keys.filter((key) => key !== 'width') : keys
    if (compareKeys.every((key) => preset.params[key] === params[key])) return preset.id
  }
  return null
}
