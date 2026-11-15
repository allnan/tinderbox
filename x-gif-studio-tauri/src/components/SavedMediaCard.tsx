import React, { useEffect, useState } from 'react'
import type { SavedMedia } from '../shared/types'
import { formatDuration, formatRelativeTime, formatSize } from '../core/format'
import { savedFormatLabel } from '../core/media-actions'
import { unwrapDisplayUrl } from '../core/ipc'
import { useApp } from '../state/store'
import { Button, ConfirmDialog, Icon, IconButton, cx } from './ui'

/** 已保存原始媒体卡片：图片显示预览，视频显示格式占位；操作走 media:* IPC */
export function SavedMediaCard({
  saved,
  compact,
  layout = 'card',
}: {
  saved: SavedMedia
  compact?: boolean
  /** card：历史页统一小卡；row：解析页产出区行式小卡 */
  layout?: 'card' | 'row'
}) {
  const { openSavedMedia, revealSavedMedia, exportSavedMedia, copySavedMediaPath, removeSavedMedia } = useApp()
  const [displayUrl, setDisplayUrl] = useState('')
  const [broken, setBroken] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isImage = saved.format !== 'mp4'

  useEffect(() => {
    let cancelled = false
    setDisplayUrl('')
    setBroken(false)
    const bridge = window.desktop
    if (!bridge) return () => undefined
    const request = isImage
      ? bridge.media.toDisplayUrl(saved.filePath)
      : typeof bridge.media.videoThumbnail === 'function'
        ? bridge.media.videoThumbnail(saved.filePath)
        : Promise.resolve('')
    request
      .then((value) => {
        if (!cancelled) setDisplayUrl(unwrapDisplayUrl(value))
      })
      .catch(() => {
        if (!cancelled) setBroken(true)
      })
    return () => {
      cancelled = true
    }
  }, [saved.filePath, isImage])

  const confirmDialog = (
    <ConfirmDialog
      open={confirmDelete}
      danger
      title="删除已保存的媒体？"
      message={'将从磁盘删除文件并从历史记录中移除该条媒体，此操作不可撤销。\n文件：' + saved.fileName}
      confirmText="删除"
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => {
        setConfirmDelete(false)
        void removeSavedMedia(saved)
      }}
    />
  )

  // 历史页紧凑卡：与 GIF 小卡同尺寸（207×169，预览 138），操作收进 hover 图标
  if (compact) {
    return (
      <article className="saved-card is-compact" data-saved-id={saved.id} title={saved.fileName}>
        <div className="saved-preview">
          {displayUrl && !broken ? (
            <img src={displayUrl} alt={saved.fileName} onError={() => setBroken(true)} />
          ) : (
            <div className="saved-preview-fallback">
              <Icon name={saved.format === 'mp4' ? 'film' : 'image'} size={20} />
              <span className="saved-preview-name mono">{savedFormatLabel(saved.format)}</span>
            </div>
          )}
          <span className="saved-format-badge">{savedFormatLabel(saved.format)}</span>
          {saved.durationSec ? <span className="saved-duration">{formatDuration(saved.durationSec)}</span> : null}
          <div className="saved-hover-actions">
            <IconButton icon="play" label="打开" size={14} onClick={() => void openSavedMedia(saved)} />
            <IconButton icon="folder" label="定位" size={14} onClick={() => void revealSavedMedia(saved)} />
            <IconButton icon="save" label="另存为" size={14} onClick={() => void exportSavedMedia(saved)} />
            <IconButton icon="copy" label="复制路径" size={14} onClick={() => void copySavedMediaPath(saved)} />
            <IconButton icon="trash" label="删除" size={14} variant="danger" onClick={() => setConfirmDelete(true)} />
          </div>
        </div>
        <div className="saved-compact-bar" title={saved.filePath}>
          <span className="saved-format-chip">{savedFormatLabel(saved.format)}</span>
          <span className="saved-file mono">{saved.fileName}</span>
          <span className="saved-compact-meta">
            {saved.width && saved.height ? saved.width + '×' + saved.height : '尺寸未知'} · {formatSize(saved.sizeBytes)}
          </span>
        </div>
        {confirmDialog}
      </article>
    )
  }

  if (layout === 'row') {
    return (
      <article className="saved-row" data-saved-id={saved.id}>
        <div className="saved-row-thumb">
          {displayUrl && !broken ? (
            <img src={displayUrl} alt="" onError={() => setBroken(true)} />
          ) : (
            <Icon name={saved.format === 'mp4' ? 'film' : 'image'} size={17} />
          )}
        </div>
        <div className="saved-row-main">
          <div className="saved-row-title">
            <span className="saved-format-chip">{savedFormatLabel(saved.format)}</span>
            <span className="saved-file mono" title={saved.filePath}>
              {saved.fileName}
            </span>
            <span className="saved-time">{formatRelativeTime(saved.createdAt)}</span>
          </div>
          <div className="saved-meta">
            <span>{saved.width && saved.height ? saved.width + ' × ' + saved.height : '尺寸未知'}</span>
            <span>{formatSize(saved.sizeBytes)}</span>
            {saved.durationSec ? <span>{formatDuration(saved.durationSec)}</span> : null}
          </div>
        </div>
        <div className="saved-row-actions">
          <IconButton icon="play" label="打开" onClick={() => void openSavedMedia(saved)} />
          <IconButton icon="folder" label="定位" onClick={() => void revealSavedMedia(saved)} />
          <IconButton icon="save" label="另存为" onClick={() => void exportSavedMedia(saved)} />
          <IconButton icon="copy" label="复制路径" onClick={() => void copySavedMediaPath(saved)} />
          <IconButton icon="trash" label="删除" variant="danger" onClick={() => setConfirmDelete(true)} />
        </div>
        {confirmDialog}
      </article>
    )
  }

  return (
    <article className={cx('saved-card', compact && 'is-compact')} data-saved-id={saved.id}>
      <div className="saved-preview">
        {displayUrl && !broken ? (
          <img src={displayUrl} alt={saved.fileName} onError={() => setBroken(true)} />
        ) : (
          <div className="saved-preview-fallback">
            <Icon name={saved.format === 'mp4' ? 'film' : 'image'} size={24} />
            <span className="saved-preview-name mono">{savedFormatLabel(saved.format)}</span>
          </div>
        )}
        <span className="saved-format-badge">{savedFormatLabel(saved.format)}</span>
        {saved.durationSec ? <span className="saved-duration">{formatDuration(saved.durationSec)}</span> : null}
      </div>
      <div className="saved-body">
        <div className="saved-title-row">
          <span className="saved-file mono" title={saved.filePath}>
            {saved.fileName}
          </span>
          <span className="saved-time" title={saved.createdAt}>
            {formatRelativeTime(saved.createdAt)}
          </span>
        </div>
        <div className="saved-meta">
          <span>{saved.width && saved.height ? saved.width + ' × ' + saved.height : '尺寸未知'}</span>
          <span>{formatSize(saved.sizeBytes)}</span>
          {saved.durationSec ? <span>{formatDuration(saved.durationSec)}</span> : null}
        </div>
        {compact ? (
          <div className="saved-actions is-icons">
            <IconButton icon="play" label="打开" size={14} onClick={() => void openSavedMedia(saved)} />
            <IconButton icon="folder" label="定位" size={14} onClick={() => void revealSavedMedia(saved)} />
            <IconButton icon="save" label="另存为" size={14} onClick={() => void exportSavedMedia(saved)} />
            <IconButton icon="copy" label="复制路径" size={14} onClick={() => void copySavedMediaPath(saved)} />
            <div className="saved-actions-spacer" />
            <IconButton icon="trash" label="删除" size={14} variant="danger" onClick={() => setConfirmDelete(true)} />
          </div>
        ) : (
          <div className="saved-actions">
            <Button size="xs" variant="subtle" icon="play" onClick={() => void openSavedMedia(saved)}>
              打开
            </Button>
            <Button size="xs" variant="ghost" icon="folder" onClick={() => void revealSavedMedia(saved)}>
              定位
            </Button>
            <Button size="xs" variant="ghost" icon="save" onClick={() => void exportSavedMedia(saved)}>
              另存为
            </Button>
            <Button size="xs" variant="ghost" icon="copy" onClick={() => void copySavedMediaPath(saved)}>
              复制路径
            </Button>
            <div className="saved-actions-spacer" />
            <Button size="xs" variant="ghost" icon="trash" className="is-danger" onClick={() => setConfirmDelete(true)}>
              删除
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="删除已保存的媒体？"
        message={'将从磁盘删除文件并从历史记录中移除该条媒体，此操作不可撤销。\n文件：' + saved.fileName}
        confirmText="删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          void removeSavedMedia(saved)
        }}
      />
    </article>
  )
}