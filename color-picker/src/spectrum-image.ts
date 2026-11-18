/**
 * 把 OKLCH 全彩色域图画成 PNG dataURL。
 *
 * 像素计算在 `core/spectrum.ts`（纯函数、可测试），这里只负责 canvas 与缓存：
 * 图像生成成本较高（720×360 逐像素二分 + 平滑），按模块级缓存，整个会话只算一次。
 * 没有 DOM / canvas 时返回空字符串，取色器会退化为 CSS 色相渐变背景。
 */
import { computeSpectrumRgba, SPECTRUM_HEIGHT, SPECTRUM_WIDTH } from './core/spectrum'

let spectrumCache: string | null = null

/** 生成（或复用）全彩色域图 dataURL */
export function buildSpectrumImage(): string {
  if (spectrumCache) return spectrumCache
  if (typeof document === 'undefined') return ''
  const canvas = document.createElement('canvas')
  canvas.width = SPECTRUM_WIDTH
  canvas.height = SPECTRUM_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const image = ctx.createImageData(SPECTRUM_WIDTH, SPECTRUM_HEIGHT)
  image.data.set(computeSpectrumRgba(SPECTRUM_WIDTH, SPECTRUM_HEIGHT))
  ctx.putImageData(image, 0, 0)
  spectrumCache = canvas.toDataURL('image/png')
  return spectrumCache
}

/** 清空缓存（测试或需要重新生成时使用） */
export function resetSpectrumImageCache(): void {
  spectrumCache = null
}
