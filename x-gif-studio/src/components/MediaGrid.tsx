import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SavedMedia, TweetInfo, TweetMedia } from '../shared/types'
import { formatClock } from '../core/format'
import { isConvertibleKind, mediaKindLabel, mediaSizeLabel } from '../core/tweet'
import { findSavedMedia, mediaActionMenu, savedFormatLabel } from '../core/media-actions'
import { Button, Icon, Spinner, cx } from './ui'

const KIND_ICON = { gif: 'sparkles', video: 'film', photo: 'image' } as const

export interface MediaGridProps {
  tweet: TweetInfo
  selectedIds: string[]
  savedMedia: SavedMedia[]
  savingMediaIds: string[]
  onToggle: (mediaId: string) => void
  onSave: (media: TweetMedia) => void
  onReveal: (saved: SavedMedia) => void
  onConvert: (media: TweetMedia) => void
  onCopySource: (media: TweetMedia) => void
}

interface MenuState {
  media: TweetMedia
  x: number
  y: number
}

/** 推文媒体网格：所有类型可勾选保存；动图/视频可转换；未保存 hover 快捷保存 / 已保存 hover 打开文件位置 + 右键菜单 */
export function MediaGrid({
  tweet,
  selectedIds,
  savedMedia,
  savingMediaIds,
  onToggle,
  onSave,
  onReveal,
  onConvert,
  onCopySource,
}: MediaGridProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  const openMenu = (event: React.MouseEvent, media: TweetMedia) => {
    event.preventDefault()
    const x = Math.min(event.clientX, Math.max(8, (window.innerWidth || 1200) - 246))
    const y = Math.min(event.clientY, Math.max(8, (window.innerHeight || 800) - 160))
    setMenu({ media, x, y })
  }

  const savedOf = (mediaId: string): SavedMedia | null => findSavedMedia(savedMedia, mediaId)

  const menuItems = menu
    ? mediaActionMenu({
        media: menu.media,
        saved: savedOf(menu.media.id),
        saving: savingMediaIds.includes(menu.media.id),
      })
    : []

  const handleMenuAction = (id: string) => {
    if (!menu) return
    const media = menu.media
    setMenu(null)
    if (id === 'save') onSave(media)
    else if (id === 'reveal') {
      const saved = savedOf(media.id)
      if (saved) onReveal(saved)
    } else if (id === 'convert') onConvert(media)
    else if (id === 'copy-source') onCopySource(media)
  }

  return (
    <div className="media-grid">
      {tweet.media.map((media, index) => {
        const convertible = isConvertibleKind(media.kind)
        const selected = selectedIds.includes(media.id)
        const saved = savedOf(media.id)
        const saving = savingMediaIds.includes(media.id)
        return (
          <div
            key={media.id}
            role="button"
            tabIndex={0}
            data-media-id={media.id}
            data-saved-id={saved ? saved.id : undefined}
            className={cx('media-card', 'kind-' + media.kind, selected && 'is-selected', saving && 'is-saving')}
            onClick={() => onToggle(media.id)}
            onContextMenu={(event) => openMenu(event, media)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onToggle(media.id)
              }
            }}
            title={convertible ? '点击勾选；右键可保存 / 转换' : '点击勾选保存；图片仅支持保存'}
          >
            <span className="media-thumb">
              <span className="media-thumb-fallback">
                <Icon name={KIND_ICON[media.kind]} size={22} />
              </span>
              {media.thumbnailUrl ? (
                <img
                  src={media.thumbnailUrl}
                  alt={`媒体 ${index + 1} 缩略图`}
                  loading="lazy"
                  onError={(event) => {
                    event.currentTarget.style.display = 'none'
                  }}
                />
              ) : null}
              <span className={`media-kind-badge kind-${media.kind}`}>
                <Icon name={KIND_ICON[media.kind]} size={11} />
                {mediaKindLabel(media.kind)}
              </span>
              {media.durationSec ? <span className="media-duration">{formatClock(media.durationSec)}</span> : null}
              {saving ? (
                <span className="media-saved-icon is-saving" title="正在保存…">
                  <Spinner size={10} />
                </span>
              ) : saved ? (
                <span className="media-saved-icon" title={'已保存：' + saved.fileName + '（' + savedFormatLabel(saved.format) + '）'}>
                  <Icon name="check" size={11} strokeWidth={3} />
                </span>
              ) : null}
              <span className={selected ? 'media-check is-checked' : 'media-check'}>
                {selected ? <Icon name="check" size={12} strokeWidth={2.8} /> : null}
              </span>
              <span className="media-quick-actions">
                {saving ? (
                  <span className="media-quick-saving">
                    <Spinner size={10} />
                    保存中…
                  </span>
                ) : (
                  <>
                    {saved ? (
                      <button
                        type="button"
                        className="media-quick-reveal"
                        title={'打开文件位置：' + saved.fileName}
                        onClick={(event) => {
                          event.stopPropagation()
                          onReveal(saved)
                        }}
                      >
                        <Icon name="folder" size={11} />
                        打开位置
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="media-quick-save"
                        onClick={(event) => {
                          event.stopPropagation()
                          onSave(media)
                        }}
                      >
                        <Icon name="download" size={11} />
                        保存
                      </button>
                    )}
                    {convertible ? (
                      <button
                        type="button"
                        className="media-quick-convert"
                        title="打开转换设置"
                        onClick={(event) => {
                          event.stopPropagation()
                          onConvert(media)
                        }}
                      >
                        <Icon name="sparkles" size={11} />
                        转换
                      </button>
                    ) : null}
                  </>
                )}
              </span>
            </span>
            <span className="media-meta">
              <span className="media-size">{mediaSizeLabel(media.width, media.height)}</span>
              <span className={saving ? 'media-tag is-saving' : convertible ? 'media-tag is-ok' : 'media-tag is-muted'}>
                {saving ? '保存中…' : convertible ? '可转换' : '图片'}
              </span>
            </span>
          </div>
        )
      })}

      {menu
        ? createPortal(
            <div
              className="media-context-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="media-context-title">
                {mediaKindLabel(menu.media.kind)} · {mediaSizeLabel(menu.media.width, menu.media.height)}
              </div>
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="media-context-item"
                  disabled={item.disabled}
                  onClick={() => handleMenuAction(item.id)}
                >
                  <Icon
                    name={
                      item.id === 'save'
                        ? 'download'
                        : item.id === 'convert'
                          ? 'sparkles'
                          : item.id === 'reveal'
                            ? 'folder'
                            : 'link'
                    }
                    size={14}
                  />
                  <span className="media-context-label">{item.label}</span>
                  {item.hint ? <span className="media-context-hint">{item.hint}</span> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}