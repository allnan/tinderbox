import type { GifResult, HistoryEntry } from '../shared/types'

/** 文本压缩：折叠空白并按长度截断 */
export function summarizeTweetText(text: string | null | undefined, max = 120): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

/** 历史分组搜索：匹配作者昵称、@用户名、正文、推文链接（大小写不敏感） */
export function filterHistoryEntries(entries: HistoryEntry[], query: string): HistoryEntry[] {
  const keyword = String(query ?? '').trim().toLowerCase()
  if (!keyword) return entries
  return entries.filter((entry) => {
    const haystack = [
      entry.author?.name,
      entry.author?.screenName,
      entry.text,
      entry.tweetUrl,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return haystack.includes(keyword)
  })
}

/** 按最后打开时间倒序（无效时间回退到抓取时间） */
export function sortHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const timestamp = (entry: HistoryEntry): number => {
    const opened = Date.parse(entry.lastOpenedAt)
    if (Number.isFinite(opened)) return opened
    const fetched = Date.parse(entry.fetchedAt)
    return Number.isFinite(fetched) ? fetched : 0
  }
  return [...entries].sort((a, b) => timestamp(b) - timestamp(a))
}

export function countHistoryResults(entries: HistoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.results?.length ?? 0), 0)
}

export function totalHistorySize(entries: HistoryEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.results ?? []).reduce((inner, result) => inner + (result.info?.sizeBytes ?? 0), 0),
    0,
  )
}

/** 最新的一个结果（用于分组缩略图与元信息） */
export function latestResult(entry: HistoryEntry): GifResult | null {
  const results = entry.results ?? []
  if (results.length === 0) return null
  return [...results].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
}

/** 分组首图：优先最新 GIF 缩略地址，其次推文媒体缩略图 */
export function historyPreviewPath(entry: HistoryEntry): string | null {
  const latest = latestResult(entry)
  if (latest) return latest.gifPath
  const thumbnail = (entry.media ?? []).find((item) => item.thumbnailUrl)?.thumbnailUrl
  return thumbnail ?? null
}

/** 分组内结果按创建时间倒序 */
export function sortResults(results: GifResult[]): GifResult[] {
  return [...results].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}
