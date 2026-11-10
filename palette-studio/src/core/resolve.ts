import type { ColorRef, GeneratedTheme, PaletteColor } from '../shared/types'
import { normalizeHex } from './color'

export interface ResolveContext {
  palette: PaletteColor[]
  theme: GeneratedTheme | null
  mode: 'light' | 'dark'
}

/** 从主题中取某个 token 的颜色 */
export function tokenColor(theme: GeneratedTheme | null, key: string, mode: 'light' | 'dark'): string | null {
  if (!theme) return null
  const token = theme.tokens.find((item) => item.key === key)
  if (!token) return null
  return normalizeHex(mode === 'dark' ? token.dark : token.light)
}

/** 从色板中取某个颜色 */
export function paletteColor(palette: PaletteColor[], id: string): string | null {
  const found = palette.find((item) => item.id === id)
  return found ? normalizeHex(found.hex) : null
}

/**
 * 解析控件配色引用为具体 HEX。
 * 依次尝试：hex → palette → token；引用失效时返回 null（调用方可回退到默认值）。
 */
export function resolveColorRef(ref: ColorRef | undefined | null, ctx: ResolveContext): string | null {
  if (!ref) return null
  if (ref.kind === 'hex') return normalizeHex(ref.value)
  if (ref.kind === 'palette') return paletteColor(ctx.palette, ref.id)
  if (ref.kind === 'token') return tokenColor(ctx.theme, ref.key, ctx.mode)
  return null
}

/** 解析并给出回退色：引用失效时使用 fallback（默认中性灰） */
export function resolveColorRefOr(ref: ColorRef | undefined | null, ctx: ResolveContext, fallback = '#808080'): string {
  return resolveColorRef(ref, ctx) ?? fallback
}
