/**
 * 中文色名。
 *
 * 从「配色工坊」的 `core/palette.ts` 独立而来，只保留取色器「颜色小窗」需要的能力：
 * 根据颜色的 OKLCH 色相与色度给出 12 个色系名，低色度按明度给出灰阶名。
 * 纯函数、零依赖。
 */
import { hexToOklch, normalizeHex } from './color'

/** OKLCH 色度低于该值时视为灰阶（与配色工坊契约中的 0.03 一致） */
const GRAY_CHROMA = 0.03

/** 12 个色相色系（OKLCH 色相角度，单位度）；0~8 度归入玫红 */
export const COLOR_FAMILIES: ReadonlyArray<{ name: string; from: number; to: number }> = [
  { name: '赤红', from: 8, to: 35 },
  { name: '朱橙', from: 35, to: 62 },
  { name: '橙黄', from: 62, to: 85 },
  { name: '明黄', from: 85, to: 120 },
  { name: '草绿', from: 120, to: 143 },
  { name: '翠绿', from: 143, to: 185 },
  { name: '青碧', from: 185, to: 225 },
  { name: '天蓝', from: 225, to: 250 },
  { name: '靛蓝', from: 250, to: 280 },
  { name: '紫罗兰', from: 280, to: 300 },
  { name: '紫棠', from: 300, to: 330 },
  { name: '玫红', from: 330, to: 360 },
]

/**
 * 根据颜色给出中文色名。
 * 低饱和（OKLCH chroma < 0.03）时按明度返回「黑色 / 白色 / 深灰 / 中灰 / 浅灰」。
 */
export function colorDisplayName(hex: string): string {
  const normalized = normalizeHex(hex) ?? '#808080'
  const { l, c, h } = hexToOklch(normalized)
  if (c < GRAY_CHROMA) {
    // 纯黑/纯白单独命名，不要叫「深灰 / 浅灰」
    if (l <= 0.03) return '黑色'
    if (l >= 0.97) return '白色'
    if (l < 0.42) return '深灰'
    if (l < 0.75) return '中灰'
    return '浅灰'
  }
  const hue = ((h % 360) + 360) % 360
  for (const family of COLOR_FAMILIES) {
    if (hue >= family.from && hue < family.to) return family.name
  }
  // 0~8 度的偏品红区域
  return '玫红'
}
