'use strict'

/**
 * 主进程侧默认参数（与 src/shared/presets.ts 保持一致，改动时两处同步）。
 * 由于主进程不能直接 import TS，这里维护一份运行期默认值。
 *
 * 注意：默认 encoder 固定为 gifski，optimize=false / lossy=0。
 * 基准实测 gifsicle 的 --lossy/--colors 会造成明显偏色（PSNR 38dB → 26dB），
 * 只作为用户手动开启的「极限压缩」高级选项，任何预设都不得默认开启。
 */

const DEFAULT_PARAMS = {
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

const PARAM_LIMITS = {
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
  // -1 表示不循环（不写 NETSCAPE2.0 扩展），0 表示无限循环
  loopMin: -1,
  loopMax: 100,
}

const DEFAULT_PROXY = {
  mode: 'system',
  url: '',
  bypass: 'localhost;127.0.0.1;<local>',
  username: '',
  password: '',
}

const DEFAULT_SETTINGS = {
  outputDir: null,
  cacheDir: null,
  defaultParams: { ...DEFAULT_PARAMS },
  defaultPresetId: 'source',
  keepOriginalMp4: true,
  maxCacheSizeMb: 4096,
  proxy: { ...DEFAULT_PROXY },
  theme: 'dark',
}

/** 把外部传入参数收敛到安全范围；缺省字段补默认值 */
function normalizeParams(input) {
  const params = { ...DEFAULT_PARAMS, ...(input && typeof input === 'object' ? input : {}) }
  const number = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  params.encoder = params.encoder === 'ffmpeg' ? 'ffmpeg' : 'gifski'
  const width = Number(params.width)
  params.width = Number.isFinite(width) && width > 0 ? Math.round(number(width, 1080, PARAM_LIMITS.widthMin, PARAM_LIMITS.widthMax)) : null
  params.fps = params.fps === 'source' ? 'source' : Math.round(number(params.fps, 15, PARAM_LIMITS.fpsMin, PARAM_LIMITS.fpsMax))
  params.colors = Math.round(number(params.colors, 256, PARAM_LIMITS.colorsMin, PARAM_LIMITS.colorsMax))
  params.quality = Math.round(number(params.quality, 90, PARAM_LIMITS.qualityMin, PARAM_LIMITS.qualityMax))
  params.dither = ['sierra2_4a', 'bayer', 'none'].includes(params.dither) ? params.dither : 'sierra2_4a'
  params.preserveTiming = Boolean(params.preserveTiming)
  params.optimize = Boolean(params.optimize)
  params.lossy = Math.round(number(params.lossy, 0, PARAM_LIMITS.lossyMin, PARAM_LIMITS.lossyMax))
  params.speed = Math.min(PARAM_LIMITS.speedMax, Math.max(PARAM_LIMITS.speedMin, Number(params.speed) || 1))
  params.loopCount = Math.round(number(params.loopCount, 0, PARAM_LIMITS.loopMin, PARAM_LIMITS.loopMax))
  return params
}

module.exports = { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_PROXY, PARAM_LIMITS, normalizeParams }
