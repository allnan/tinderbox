/**
 * OKLCH 全彩色域图（sRGB gamut slice）的纯计算部分。
 *
 * 设计要点（完整说明见 `docs/全彩取色算法.md`）：
 * - 横轴是色相 H（0°→360°，左右两端都是红，环绕闭合）；
 * - 纵轴是感知明度 L（顶部 1 = 白，底部 0 = 黑）；
 * - 每个像素取该 (L, H) 下 sRGB 能表示的最大色度 C，因此整张图都是「该明度下最鲜艳的颜色」，
 *   不存在色域外的灰块，也不需要额外画色域边界。
 *
 * 为什么用 OKLCH 而不是 HSV 色带：OKLab/OKLCH 是感知均匀色彩空间，明度轴的含义稳定，
 * 扫过整张图时不会像 HSV 那样中段突然变亮/变暗；同时 OKLCH 是 CSS Color 4 的标准空间。
 *
 * 本文件不依赖 DOM，可在 Node / 测试 / 其他渲染器中复用；
 * 真正把像素画到 canvas 上的部分在 `src/spectrum-image.ts`。
 */
import { clamp, oklabToLinear, oklchToRgb } from './color'

/** 色域图内部渲染宽度（远高于约 300px 的显示宽度，放大或截图时不易看出格子） */
export const SPECTRUM_WIDTH = 720

/** 色域图内部渲染高度 */
export const SPECTRUM_HEIGHT = 360

/** 最大色度场平滑半径（色相方向环绕、明度方向夹取） */
export const SPECTRUM_SMOOTH_RADIUS = 8

/** Bayer 抖动幅度（0-255 单位）。用于消除 8 位色深在平滑渐变上的条带 */
export const SPECTRUM_DITHER = 0.9

/** 4×4 Bayer 抖动矩阵 */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

function linearInSrgb(line: [number, number, number]): boolean {
  return line.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4)
}

/**
 * 指定 (L, H) 下 sRGB 能显示的最大色度 C。
 *
 * 色度上界取 0.4（远大于 sRGB 实际可达值，作为二分上界）；若该上界已在 sRGB 内则直接返回，
 * 否则对 C 做 18 次二分，找到仍在线性 sRGB 内的最大色度。18 次约为 0.4 / 2^18 ≈ 1.5e-6 的精度，
 * 对 8 位渲染足够。
 */
export function maxChromaAt(l: number, h: number): number {
  const rad = (h * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const upper = 0.4
  let linear = oklabToLinear(l, upper * cos, upper * sin)
  if (linearInSrgb(linear)) return upper
  let low = 0
  let high = upper
  for (let i = 0; i < 18; i += 1) {
    const mid = (low + high) / 2
    const test = oklabToLinear(l, mid * cos, mid * sin)
    if (linearInSrgb(test)) {
      low = mid
      linear = test
    } else {
      high = mid
    }
  }
  return low
}

/** 逐像素计算最大色度场，返回按行优先排列的 `width × height` 数组 */
export function computeChromaField(width = SPECTRUM_WIDTH, height = SPECTRUM_HEIGHT): Float32Array {
  const field = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const l = 1 - y / (height - 1)
    for (let x = 0; x < width; x += 1) {
      field[y * width + x] = maxChromaAt(l, (x / (width - 1)) * 360)
    }
  }
  return field
}

/**
 * 对最大色度场做轻微平滑（色相方向环绕、明度方向夹取）。
 *
 * sRGB 在蓝紫区（约 hue 250–290°）有一个真实的色域凹口，最大色度曲线在这里变化很快，
 * 直接按 maxC 渲染会看到一道折痕；轻微平滑后过渡自然，同时每个点仍由 OKLCH→sRGB 的
 * 色域映射保证落在 sRGB 内。平滑只作用于「色度场」，不改变最终取色公式。
 */
export function smoothChromaField(
  field: Float32Array,
  width: number,
  height: number,
  radius = SPECTRUM_SMOOTH_RADIUS,
): Float32Array {
  const span = radius * 2 + 1
  const pass1 = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let d = -radius; d <= radius; d += 1) {
        sum += field[row + ((x + d + width) % width)]
      }
      pass1[row + x] = sum / span
    }
  }
  const blurred = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let d = -radius; d <= radius; d += 1) {
        const yy = clamp(y + d, 0, height - 1)
        sum += pass1[yy * width + x]
        count += 1
      }
      blurred[y * width + x] = sum / count
    }
  }
  return blurred
}

/**
 * 生成可直接写入 canvas 的 RGBA 像素（行优先，每像素 4 字节）。
 *
 * 流程与配色工坊中的实现保持一致：
 * 1. 逐像素算最大色度场；
 * 2. 对色度场做半径 8 的平滑；
 * 3. 逐像素 OKLCH→sRGB，并叠加 Bayer 4×4 抖动；
 * 4. 顶部/底部极端行强制纯白/纯黑，避免 OKLab 逆变换在 L≈0/1 时的矩阵舍入误差
 *    产生 `010000` / `000002` 这类杂色。
 */
export function computeSpectrumRgba(width = SPECTRUM_WIDTH, height = SPECTRUM_HEIGHT): Uint8ClampedArray {
  const chroma = computeChromaField(width, height)
  const smooth = smoothChromaField(chroma, width, height)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const l = 1 - y / (height - 1)
    const extreme = l <= 0.008 ? 0 : l >= 0.992 ? 255 : null
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      if (extreme !== null) {
        rgba[index] = extreme
        rgba[index + 1] = extreme
        rgba[index + 2] = extreme
        rgba[index + 3] = 255
        continue
      }
      const h = (x / (width - 1)) * 360
      const c = smooth[y * width + x]
      const { r, g, b } = oklchToRgb({ l, c, h })
      const dither = (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * SPECTRUM_DITHER
      rgba[index] = clamp(Math.round(r + dither), 0, 255)
      rgba[index + 1] = clamp(Math.round(g + dither), 0, 255)
      rgba[index + 2] = clamp(Math.round(b + dither), 0, 255)
      rgba[index + 3] = 255
    }
  }
  return rgba
}
