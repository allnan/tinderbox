import type {
  HistoryEntry,
  MediaKind,
  SavedMedia,
  SavedMediaFormat,
  TweetMedia,
} from '../shared/types'
import { formatDuration, formatSize } from './format'

export const SAVED_FORMAT_LABELS: Record<SavedMediaFormat, string> = {
  mp4: '视频',
  jpg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
}

/** 已保存媒体的格式徽标文案 */
export function savedFormatLabel(format: SavedMediaFormat | null | undefined): string {
  if (!format) return '文件'
  return SAVED_FORMAT_LABELS[format] ?? String(format).toUpperCase()
}

/** 按 mediaId 查找已保存记录（同一媒体只保留最新一条） */
export function findSavedMedia(saved: SavedMedia[] | null | undefined, mediaId: string): SavedMedia | null {
  if (!Array.isArray(saved) || !mediaId) return null
  for (const item of saved) {
    if (item && item.mediaId === mediaId) return item
  }
  return null
}

/** mediaId → 已保存记录 的索引 */
export function indexSavedMedia(saved: SavedMedia[] | null | undefined): Record<string, SavedMedia> {
  const index: Record<string, SavedMedia> = {}
  if (!Array.isArray(saved)) return index
  for (const item of saved) {
    if (item && item.mediaId) index[item.mediaId] = item
  }
  return index
}

/** 已保存状态：saved / saving / unsaved */
export type SavedState = 'saved' | 'saving' | 'unsaved'

export function savedStateOf(
  saved: SavedMedia[] | null | undefined,
  mediaId: string,
  savingMediaIds: string[] | null | undefined = [],
): SavedState {
  if (Array.isArray(savingMediaIds) && savingMediaIds.includes(mediaId)) return 'saving'
  return findSavedMedia(saved, mediaId) ? 'saved' : 'unsaved'
}

/** 已保存媒体的一行摘要：格式 · 尺寸 · 时长 · 体积 */
export function describeSavedMedia(saved: SavedMedia | null | undefined): string {
  if (!saved) return ''
  const parts: string[] = [savedFormatLabel(saved.format)]
  if (saved.width && saved.height) parts.push(saved.width + ' × ' + saved.height)
  if (saved.durationSec && saved.durationSec > 0) parts.push(formatDuration(saved.durationSec))
  parts.push(formatSize(saved.sizeBytes))
  return parts.join(' · ')
}

/** 媒体类型的中文名（保存/转换菜单使用） */
export function mediaKindName(kind: MediaKind | null | undefined): string {
  if (kind === 'gif') return '动图'
  if (kind === 'video') return '视频'
  return '图片'
}

export type MediaActionId = 'save' | 'reveal' | 'convert' | 'copy-source'

export interface MediaActionItem {
  id: MediaActionId
  label: string
  disabled: boolean
  hint?: string
}

export interface MediaActionInput {
  media: Pick<TweetMedia, 'kind'>
  saved: SavedMedia | null
  saving?: boolean
}

/**
 * 媒体右键菜单状态机（纯函数）：
 * - 保存媒体：仅未保存媒体提供；
 * - 打开文件位置：仅已保存媒体提供；
 * - 转换为动图：图片不可转换；未保存时自动保存；
 * - 复制源链接：始终可用。
 */
export function mediaActionMenu(input: MediaActionInput): MediaActionItem[] {
  const { media, saved, saving = false } = input
  const convertible = media.kind === 'gif' || media.kind === 'video'
  const items: MediaActionItem[] = []
  // 已保存媒体不再提供重复的保存入口，改为「打开文件位置」；未保存媒体保留「保存媒体」
  if (saved) {
    items.push({
      id: 'reveal',
      label: '打开文件位置',
      disabled: saving,
      hint: savedFormatLabel(saved.format),
    })
  } else {
    items.push({
      id: 'save',
      label: '保存媒体',
      disabled: saving,
    })
  }
  items.push({
    id: 'convert',
    label: convertible
      ? saved
        ? '转换为动图（使用已保存文件）'
        : '转换为动图（未保存则自动保存）'
      : '图片不支持转换为动图',
    disabled: saving || !convertible,
    hint: convertible ? (saved ? '已保存' : '将自动保存') : '仅动图 / 视频',
  })
  items.push({
    id: 'copy-source',
    label: '复制源链接',
    disabled: false,
  })
  return items
}

/** 历史统计（按推文去重）：推文条数 / 已保存媒体数 / GIF 结果数 */
export function historyMediaCounts(entries: HistoryEntry[] | null | undefined): {
  tweets: number
  savedMedia: number
  gifs: number
} {
  if (!Array.isArray(entries)) return { tweets: 0, savedMedia: 0, gifs: 0 }
  const tweetIds = new Set<string>()
  const savedIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue
    tweetIds.add(entry.id)
    for (const saved of entry.savedMedia ?? []) {
      if (saved && saved.id) savedIds.add(saved.id)
    }
    for (const result of entry.results ?? []) {
      if (result && result.id) resultIds.add(result.id)
    }
  }
  return { tweets: tweetIds.size, savedMedia: savedIds.size, gifs: resultIds.size }
}

/** 把已保存媒体按格式分组统计（输出区/历史页可选展示） */
export function savedFormatSummary(saved: SavedMedia[] | null | undefined): { format: string; count: number }[] {
  if (!Array.isArray(saved) || saved.length === 0) return []
  const counts = new Map<string, number>()
  for (const item of saved) {
    if (!item) continue
    const label = savedFormatLabel(item.format)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return Array.from(counts.entries()).map(([format, count]) => ({ format, count }))
}