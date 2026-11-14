import React, { useEffect, useMemo, useState } from 'react'
import type { HistoryEntry, TweetMedia } from '../shared/types'
import { useApp } from '../state/store'
import {
  filterHistoryEntries,
  historyPreviewPath,
  sortHistoryEntries,
  sortResults,
  summarizeTweetText,
} from '../core/history'
import { historyMediaCounts } from '../core/media-actions'
import { formatDateTime, formatRelativeTime, formatSize } from '../core/format'
import { historyMediaToTweetMedia } from '../core/tweet'
import { unwrapDisplayUrl } from '../core/ipc'
import { Button, ConfirmDialog, EmptyState, Icon, IconButton, Spinner, useToast } from '../components/ui'
import { ResultCard } from '../components/ResultCard'
import { SavedMediaCard } from '../components/SavedMediaCard'

/** 历史按推文 id 去重（后端按 tweetId 分组，这里防御旧数据/异常数据出现重复条目） */
function dedupeEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>()
  const result: HistoryEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}

/** 一条历史记录关联的文件数量与总体积（用于删除确认文案） */
function entryFileSummary(entry: HistoryEntry | null): { saved: number; gifs: number; bytes: number } {
  if (!entry) return { saved: 0, gifs: 0, bytes: 0 }
  const saved = entry.savedMedia?.length ?? 0
  const gifs = entry.results?.length ?? 0
  let bytes = 0
  for (const item of entry.savedMedia ?? []) {
    if (item && typeof item.sizeBytes === 'number') bytes += item.sizeBytes
  }
  for (const item of entry.results ?? []) {
    if (item && item.info && typeof item.info.sizeBytes === 'number') bytes += item.info.sizeBytes
  }
  return { saved, gifs, bytes }
}

function HistoryThumb({ entry }: { entry: HistoryEntry }) {
  const preview = historyPreviewPath(entry)
  const [src, setSrc] = useState('')

  useEffect(() => {
    let cancelled = false
    setSrc('')
    if (!preview) return () => undefined
    if (/^https?:\/\//i.test(preview)) {
      setSrc(preview)
      return () => undefined
    }
    const bridge = window.desktop
    if (!bridge) return () => undefined
    bridge.media
      .toDisplayUrl(preview)
      .then((value) => {
        if (!cancelled) setSrc(unwrapDisplayUrl(value))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [preview])

  return (
    <span className="history-thumb">
      {src ? <img src={src} alt="" loading="lazy" onError={() => setSrc('')} /> : <span className="history-thumb-fallback"><Icon name="image" size={18} /></span>}
      {entry.results.length + (entry.savedMedia?.length ?? 0) > 0 ? (
        <span className="history-thumb-count">{entry.results.length + (entry.savedMedia?.length ?? 0)}</span>
      ) : null}
    </span>
  )
}

export default function HistoryView() {
  const {
    history,
    historyLoading,
    historyError,
    desktopAvailable,
    refreshHistory,
    openParseWithUrl,
    removeHistoryEntry,
    clearHistory,
    openOutputDir,
    setView,
  } = useApp()
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<HistoryEntry | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const sorted = useMemo(() => sortHistoryEntries(dedupeEntries(history)), [history])
  const filtered = useMemo(() => filterHistoryEntries(sorted, query), [sorted, query])
  const stats = useMemo(() => historyMediaCounts(sorted), [sorted])
  const totalSize = useMemo(
    () =>
      sorted.reduce(
        (sum, entry) =>
          sum +
          (entry.savedMedia ?? []).reduce((inner, item) => inner + (item.sizeBytes ?? 0), 0) +
          (entry.results ?? []).reduce((inner, item) => inner + (item.info?.sizeBytes ?? 0), 0),
        0,
      ),
    [sorted],
  )

  const toggleExpand = (tweetId: string) => {
    setExpandedId((current) => (current === tweetId ? null : tweetId))
  }

  const mediaOf = (entry: HistoryEntry, resultId: string): TweetMedia | null => {
    const result = entry.results.find((item) => item.id === resultId)
    if (!result) return null
    const media = entry.media.find((item) => item.id === result.mediaId)
    return media ? historyMediaToTweetMedia(media) : null
  }

  const mediaIndex = (entry: HistoryEntry, resultId: string): number => {
    const result = entry.results.find((item) => item.id === resultId)
    if (!result) return 1
    const index = entry.media.findIndex((item) => item.id === result.mediaId)
    return index >= 0 ? index + 1 : 1
  }

  const goParseWithUrl = (url: string) => {
    // 携带链接进入解析流程：解析页消费 pendingParseUrl 后自动填入并自动解析
    openParseWithUrl(url)
  }

  return (
    <div className="view history-view" data-view="history">
      <header className="page-header">
        <div>
          <h1 className="page-title">
            历史记录
            {sorted.length > 0 ? <span className="page-title-badge">{sorted.length} 条推文</span> : null}
          </h1>
          <p className="page-subtitle">按推文链接分组，媒体与动图输出统一小卡展示</p>
        </div>
        <div className="page-actions">
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refreshHistory()} disabled={!desktopAvailable}>
            刷新
          </Button>
          <Button size="sm" variant="secondary" icon="folder" onClick={() => void openOutputDir()} disabled={!desktopAvailable}>
            打开输出目录
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            onClick={() => setConfirmClear(true)}
            disabled={sorted.length === 0 || !desktopAvailable}
          >
            清空历史
          </Button>
        </div>
      </header>

      {!desktopAvailable ? (
        <div className="notice is-warning">
          <Icon name="warning" size={16} />
          <div>当前为浏览器预览模式，历史记录无法读取；此页面仅用于界面预览。</div>
        </div>
      ) : null}

      <div className="history-toolbar">
        <div className="search-box">
          <Icon name="search" size={15} className="search-icon" />
          <input
            className="input search-input"
            type="text"
            value={query}
            placeholder="搜索作者、正文或推文链接"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索历史记录"
          />
          {query ? <IconButton icon="close" label="清除搜索" onClick={() => setQuery('')} /> : null}
        </div>
        <div className="history-stats">
          <span className="history-stat">
            <strong>{stats.tweets}</strong> 条推文
          </span>
          <span className="history-stat-sep" aria-hidden="true">
            ·
          </span>
          <span className="history-stat">
            <strong>{stats.savedMedia}</strong> 个媒体
          </span>
          <span className="history-stat-sep" aria-hidden="true">
            ·
          </span>
          <span className="history-stat">
            <strong>{stats.gifs}</strong> 个动图
          </span>
          <span className="history-stat-sep" aria-hidden="true">
            ·
          </span>
          <span className="history-stat">
            共 <strong>{formatSize(totalSize)}</strong>
          </span>
        </div>
      </div>

      {historyLoading && sorted.length === 0 ? (
        <div className="loading-inline">
          <Spinner size={18} />
          正在读取历史记录…
        </div>
      ) : null}

      {historyError ? (
        <div className="notice is-danger">
          <Icon name="error" size={16} />
          <div>{historyError}</div>
          <Button size="xs" variant="subtle" onClick={() => void refreshHistory()}>
            重试
          </Button>
        </div>
      ) : null}

      {!historyLoading && sorted.length === 0 && !historyError ? (
        <div className="history-empty">
          <EmptyState
            icon="history"
            title="还没有历史记录"
            description="解析 X 推文并保存媒体或导出动图后，记录会自动出现在这里，方便按推文找回文件。"
            action={
              <Button variant="primary" icon="parse" onClick={() => setView('parse')}>
                解析推文
              </Button>
            }
          />
        </div>
      ) : null}

      {sorted.length > 0 && filtered.length === 0 ? (
        <div className="history-empty">
          <EmptyState
            icon="search"
            title="没有匹配的历史记录"
            description={'没有找到与「' + query + '」相关的推文，试试作者名、正文关键词或链接片段。'}
            action={
              <Button variant="secondary" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            }
          />
        </div>
      ) : null}

      <div className="history-list">
        {filtered.map((entry) => {
          const expanded = expandedId === entry.id
          const results = sortResults(entry.results)
          return (
            <article key={entry.id} className={expanded ? 'history-group is-expanded' : 'history-group'} data-tweet-id={entry.id}>
              <div
                className="history-head"
                role="button"
                tabIndex={0}
                onClick={() => toggleExpand(entry.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleExpand(entry.id)
                  }
                }}
                aria-expanded={expanded}
              >
                <HistoryThumb entry={entry} />
                <div className="history-main">
                  <div className="history-head-line">
                    <span className="history-author-name">{entry.author.name}</span>
                    <span className="history-author-handle">@{entry.author.screenName}</span>
                    {entry.author.verified ? (
                      <span className="tweet-verified" title="已验证账号">
                        <Icon name="check" size={9} strokeWidth={2.6} />
                      </span>
                    ) : null}
                    <span className="history-head-sep">·</span>
                    <span className="history-head-text">{summarizeTweetText(entry.text) || '（该推文没有正文）'}</span>
                  </div>
                  <div className="history-meta-row">
                    {entry.savedMedia?.length > 0 ? (
                      <span className="history-result-count" title={'已保存 ' + entry.savedMedia.length + ' 个原始媒体'}>
                        <Icon name="download" size={11} />
                        {entry.savedMedia.length} 个媒体
                      </span>
                    ) : null}
                    <span className="history-result-count">
                      <Icon name="sparkles" size={11} />
                      {entry.results.length} 个动图
                    </span>
                    {entry.savedMedia?.length > 0 || entry.results.length > 0 ? (
                      <span>
                        {formatSize(
                          (entry.savedMedia ?? []).reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) +
                            entry.results.reduce((sum, item) => sum + item.info.sizeBytes, 0),
                        )}
                      </span>
                    ) : null}
                    <span title={entry.tweetUrl} className="history-url mono">
                      {entry.tweetUrl}
                    </span>
                    {entry.tweetCreatedAt ? <span>发布于 {formatDateTime(entry.tweetCreatedAt)}</span> : null}
                    <span className="history-time">更新于 {formatRelativeTime(entry.lastOpenedAt)}</span>
                  </div>
                </div>
                <div className="history-actions" onClick={(event) => event.stopPropagation()}>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="refresh"
                    className="history-reopen-btn"
                    onClick={() => goParseWithUrl(entry.tweetUrl)}
                  >
                    重新操作
                  </Button>
                  <IconButton
                    icon={expanded ? 'chevron-down' : 'chevron-right'}
                    label={expanded ? '收起结果' : '展开结果'}
                    onClick={() => toggleExpand(entry.id)}
                  />
                  <IconButton
                    icon="trash"
                    variant="danger"
                    label="从历史中移除该推文（按住 Shift 直接删除记录和文件）"
                    data-testid="history-remove-button"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        void removeHistoryEntry(entry.id, { deleteFiles: true })
                      } else {
                        setPendingRemove(entry)
                      }
                    }}
                  />
                </div>
              </div>

              {expanded ? (
                <div className="history-results">
                  <div className="output-subsection" data-subsection="media">
                    <h3 className="output-subtitle">
                      <Icon name="image" size={13} />
                      媒体（{entry.savedMedia?.length ?? 0} 个）
                    </h3>
                    {entry.savedMedia && entry.savedMedia.length > 0 ? (
                      <div className="history-card-grid">
                        {entry.savedMedia.map((saved) => (
                          <SavedMediaCard key={saved.id} saved={saved} compact />
                        ))}
                      </div>
                    ) : (
                      <div className="history-results-empty">
                        <Icon name="info" size={14} />
                        该推文还没有保存原始媒体；重新操作后可在解析页保存。
                        <Button size="xs" variant="ghost" onClick={() => goParseWithUrl(entry.tweetUrl)}>
                          重新操作
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="output-subsection" data-subsection="gifs">
                    <h3 className="output-subtitle">
                      <Icon name="sparkles" size={13} />
                      动图输出（{results.length} 个）
                    </h3>
                    {results.length > 0 ? (
                      <div className="gif-card-grid">
                        {results.map((result) => {
                          const media = mediaOf(entry, result.id)
                          return (
                            <ResultCard
                              key={result.id}
                              compact
                              result={result}
                              media={media}
                              authorName={entry.author.screenName}
                              mediaIndex={mediaIndex(entry, result.id)}
                            />
                          )
                        })}
                      </div>
                    ) : (
                      <div className="history-results-empty">
                        <Icon name="info" size={14} />
                        该推文还没有动图输出；重新操作后可重新选择媒体并导出。
                        <Button size="xs" variant="ghost" onClick={() => goParseWithUrl(entry.tweetUrl)}>
                          重新操作
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      <ConfirmDialog
        open={Boolean(pendingRemove)}
        danger
        title="从历史中移除？"
        message={
          pendingRemove
            ? (() => {
                const summary = entryFileSummary(pendingRemove)
                const files = '该记录关联 ' + summary.saved + ' 个原始媒体、' + summary.gifs + ' 个动图' + (summary.bytes > 0 ? '，合计 ' + formatSize(summary.bytes) : '')
                return '将从历史记录中移除「@' + pendingRemove.author.screenName + '」的这条推文记录（' + files + '）。\n\n「仅移除记录」会保留输出目录里的文件；「移除记录并删除文件」会同时删除这些媒体与动图文件，删除后无法恢复。\n\n提示：按住 Shift 点击垃圾桶可直接删除记录和文件，不再弹出本确认。'
              })()
            : undefined
        }
        confirmText="移除记录并删除文件"
        extraAction={{
          label: '仅移除记录',
          onClick: () => {
            const entry = pendingRemove
            setPendingRemove(null)
            if (!entry) return
            setBusy(true)
            void removeHistoryEntry(entry.id, { deleteFiles: false }).finally(() => setBusy(false))
          },
        }}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const entry = pendingRemove
          setPendingRemove(null)
          if (!entry) return
          setBusy(true)
          void removeHistoryEntry(entry.id, { deleteFiles: true }).finally(() => setBusy(false))
        }}
        busy={busy}
      />

      <ConfirmDialog
        open={confirmClear}
        danger
        title="清空全部历史记录？"
        message="将清空所有推文的历史记录（包括导出设置），已导出的动图文件仍保留在输出目录。此操作不可撤销。"
        confirmText="清空历史"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false)
          setBusy(true)
          void clearHistory().finally(() => setBusy(false))
        }}
        busy={busy}
      />
    </div>
  )
}