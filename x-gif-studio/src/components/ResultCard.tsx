import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GifResult, TweetMedia } from '../shared/types'
import { formatCount, formatDuration, formatFps, formatRelativeTime, formatSize, formatSizeRatio } from '../core/format'
import { buildGifFileName, fileBaseName } from '../core/filename'
import { unwrapDisplayUrl } from '../core/ipc'
import { animFormatLabel, clampParams, presetName, summarizeParams } from '../core/params'
import { useApp } from '../state/store'
import { Button, ConfirmDialog, Icon, IconButton, cx } from './ui'
import { ParamPanel } from './ParamPanel'

export interface ResultCardProps {
  result: GifResult
  /** 源媒体；改参数重新导出时传给主进程 */
  media: TweetMedia | null
  authorName?: string | null
  mediaIndex?: number
  compact?: boolean
}

/** 单个 GIF 结果卡片：预览、体积/尺寸、文件操作与「调整参数再导出」 */
export function ResultCard({ result, media, authorName, mediaIndex, compact }: ResultCardProps) {
  const { openGif, revealGif, exportGif, copyGifPath, deleteResult, reencodeResult } = useApp()
  const [displayUrl, setDisplayUrl] = useState('')
  const [previewBroken, setPreviewBroken] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draftParams, setDraftParams] = useState(result.params)
  const [draftPresetId, setDraftPresetId] = useState<string | null>(result.presetId)
  const format = result.format ?? 'gif'

  useEffect(() => {
    let cancelled = false
    setDisplayUrl('')
    setPreviewBroken(false)
    const bridge = window.desktop
    if (!bridge) return () => undefined
    bridge.media
      .toDisplayUrl(result.gifPath)
      .then((value) => {
        if (!cancelled) setDisplayUrl(unwrapDisplayUrl(value))
      })
      .catch(() => {
        if (!cancelled) setPreviewBroken(true)
      })
    return () => {
      cancelled = true
    }
  }, [result.gifPath])

  const sizeRatio = formatSizeRatio(result.info.sizeBytes, result.sourceProbe?.sizeBytes ?? null)
  const summary = summarizeParams(result.params, result.presetId, format)

  const openAdjust = () => {
    setDraftParams(clampParams(result.params))
    setDraftPresetId(result.presetId)
    setAdjustOpen((value) => !value)
  }

  const targetWidth = draftParams.width ?? result.info.width
  const targetHeight =
    draftParams.width && result.info.width > 0
      ? Math.round((result.info.height * draftParams.width) / result.info.width)
      : result.info.height
  const fileNamePreview = buildGifFileName({
    screenName: authorName ?? '',
    tweetId: result.tweetId,
    mediaIndex: mediaIndex ?? 1,
    width: targetWidth,
    height: targetHeight,
    presetId: draftPresetId,
  })

  const submitReencode = () => {
    if (!media) return
    reencodeResult(result, media, draftParams, draftPresetId, format)
    setAdjustOpen(false)
  }

  if (compact) {
    return (
      <article className="result-card is-compact" data-result-id={result.id} title={result.info.fileName}>
        <div className="result-preview">
          {displayUrl && !previewBroken ? (
            <img src={displayUrl} alt={result.info.fileName} onError={() => setPreviewBroken(true)} />
          ) : (
            <div className="result-preview-fallback">
              <Icon name={previewBroken ? 'warning' : 'image'} size={20} />
            </div>
          )}
          <span className="result-preset-badge">{presetName(result.presetId)}</span>
          <div className="result-hover-actions">
            <IconButton icon="play" label="打开" size={14} onClick={() => void openGif(result)} />
            <IconButton icon="folder" label="定位" size={14} onClick={() => void revealGif(result)} />
            <IconButton icon="save" label="另存为" size={14} onClick={() => void exportGif(result)} />
            <IconButton icon="copy" label="复制路径" size={14} onClick={() => void copyGifPath(result)} />
            <IconButton
              icon="sliders"
              label={media ? '调整参数后重新转换' : '缺少源媒体信息，无法重新转换'}
              size={14}
              onClick={openAdjust}
            />
            <IconButton icon="trash" label="删除" size={14} variant="danger" onClick={() => setConfirmDelete(true)} />
          </div>
        </div>
        <div
          className="result-compact-bar"
          title={
            formatSize(result.info.sizeBytes) +
            ' · ' +
            result.info.width +
            '×' +
            result.info.height +
            ' · ' +
            formatDuration(result.info.durationSec) +
            ' · ' +
            formatCount(result.info.frameCount) +
            ' 帧 · ' +
            formatFps(result.info.fps)
          }
        >
          <span className={cx('result-format-badge', format === 'webp' && 'is-webp')}>{animFormatLabel(format)}</span>
          <span className="result-compact-size">{formatSize(result.info.sizeBytes)}</span>
          <span className="result-compact-dim">
            {result.info.width}×{result.info.height}
          </span>
          <span className="result-compact-frames">{formatCount(result.info.frameCount)} 帧</span>
          <span className="result-compact-duration">{formatDuration(result.info.durationSec)}</span>
        </div>

        {adjustOpen
          ? createPortal(
              <div className="adjust-backdrop" onMouseDown={() => setAdjustOpen(false)}>
                <aside className="adjust-drawer" onMouseDown={(event) => event.stopPropagation()}>
                  <header className="adjust-drawer-head">
                    <Icon name="sliders" size={15} />
                    <span className="adjust-drawer-title">调整参数再导出</span>
                    <span className="adjust-format-note">{animFormatLabel(format)} · 沿用原结果</span>
                    <span className="adjust-drawer-file mono">{result.info.fileName}</span>
                    <IconButton icon="close" label="关闭" size={15} onClick={() => setAdjustOpen(false)} />
                  </header>
                  <div className="adjust-drawer-body">
                    <ParamPanel
                      variant="bar"
                      defaultAdvancedOpen
                      animFormat={format}
                      params={draftParams}
                      presetId={draftPresetId}
                      sourceWidth={result.sourceProbe?.width ?? result.info.width}
                      sourceHeight={result.sourceProbe?.height ?? result.info.height}
                      fileNamePreview={fileNamePreview}
                      onChange={(params, preset) => {
                        setDraftParams(params)
                        setDraftPresetId(preset)
                      }}
                    />
                  </div>
                  <footer className="adjust-drawer-footer">
                    {!media ? <span className="adjust-drawer-warning">缺少源媒体信息，无法重新导出</span> : null}
                    <Button size="sm" variant="ghost" onClick={() => setAdjustOpen(false)}>
                      取消
                    </Button>
                    <Button size="sm" variant="primary" icon="refresh" onClick={submitReencode} disabled={!media}>
                      按新参数重新导出
                    </Button>
                  </footer>
                </aside>
              </div>,
              document.body,
            )
          : null}

        <ConfirmDialog
          open={confirmDelete}
          danger
          title="删除这个动图？"
          message={'将删除该动图文件并从历史记录中移除该结果。此操作不可撤销。\n文件：' + result.info.fileName}
          confirmText="删除"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void deleteResult(result)
          }}
        />
      </article>
    )
  }

  return (
    <article className={cx('result-card', compact && 'is-compact')} data-result-id={result.id}>
      <div className="result-preview">
        {displayUrl && !previewBroken ? (
          <img src={displayUrl} alt={result.info.fileName} onError={() => setPreviewBroken(true)} />
        ) : (
          <div className="result-preview-fallback">
            <Icon name={previewBroken ? 'warning' : 'image'} size={22} />
            <span className="mono">{fileBaseName(result.gifPath) || '动图'}</span>
            {previewBroken ? <span className="result-preview-note">预览不可用，可用「打开」查看</span> : null}
          </div>
        )}
        <span className="result-preset-badge">{presetName(result.presetId)}</span>
        <span className={cx('result-format-badge is-normal', format === 'webp' && 'is-webp')}>
          {animFormatLabel(format)}
        </span>
      </div>

      <div className="result-body">
        <div className="result-title-row">
          <span className="result-file mono" title={result.gifPath}>
            {result.info.fileName || fileBaseName(result.gifPath)}
          </span>
          <span className="result-time" title={result.createdAt}>
            {formatRelativeTime(result.createdAt)}
          </span>
        </div>

        {compact ? (
          <div className="result-compact-meta" title={sizeRatio ?? undefined}>
            <span>{formatSize(result.info.sizeBytes)}</span>
            <span>
              {result.info.width} × {result.info.height}
            </span>
            <span>{formatDuration(result.info.durationSec)}</span>
            <span className="is-muted">
              {formatCount(result.info.frameCount)} 帧 · {formatFps(result.info.fps)}
            </span>
          </div>
        ) : (
          <div className="result-hero">
            <div className="result-hero-stat">
              <span className="hero-label">体积</span>
              <span className="hero-value">{formatSize(result.info.sizeBytes)}</span>
              {sizeRatio ? <span className="hero-sub">{sizeRatio}</span> : null}
            </div>
            <div className="result-hero-stat">
              <span className="hero-label">尺寸</span>
              <span className="hero-value">
                {result.info.width} × {result.info.height}
              </span>
              <span className="hero-sub">
                {formatCount(result.info.frameCount)} 帧 · {formatFps(result.info.fps)}
              </span>
            </div>
            <div className="result-hero-stat is-muted">
              <span className="hero-label">时长</span>
              <span className="hero-value">{formatDuration(result.info.durationSec)}</span>
              <span className="hero-sub">{result.params.fps === 'source' ? '逐帧时序还原' : '按目标帧率重采样'}</span>
            </div>
          </div>
        )}

        <div className="result-actions">
          {compact ? (
            <>
              <IconButton icon="play" label="打开" size={14} onClick={() => void openGif(result)} />
              <IconButton icon="folder" label="定位" size={14} onClick={() => void revealGif(result)} />
              <IconButton icon="save" label="另存为" size={14} onClick={() => void exportGif(result)} />
              <IconButton icon="copy" label="复制路径" size={14} onClick={() => void copyGifPath(result)} />
              <div className="result-actions-spacer" />
              <IconButton
                icon="sliders"
                label={media ? '调整参数后重新转换' : '缺少源媒体信息，无法重新转换'}
                size={14}
                active={adjustOpen}
                onClick={openAdjust}
              />
              <IconButton icon="trash" label="删除" size={14} variant="danger" onClick={() => setConfirmDelete(true)} />
            </>
          ) : (
            <>
              <Button size="xs" variant="subtle" icon="play" onClick={() => void openGif(result)}>
                打开
              </Button>
              <Button size="xs" variant="ghost" icon="folder" onClick={() => void revealGif(result)}>
                定位
              </Button>
              <Button size="xs" variant="ghost" icon="save" onClick={() => void exportGif(result)}>
                另存为
              </Button>
              <Button size="xs" variant="ghost" icon="copy" onClick={() => void copyGifPath(result)}>
                复制路径
              </Button>
              <div className="result-actions-spacer" />
              <Button
                size="xs"
                variant={adjustOpen ? 'subtle' : 'ghost'}
                icon="sliders"
                onClick={openAdjust}
                title={media ? '调整参数后重新转换' : '缺少源媒体信息，无法重新转换'}
              >
                调整参数
              </Button>
              <Button size="xs" variant="ghost" icon="trash" className="is-danger" onClick={() => setConfirmDelete(true)}>
                删除
              </Button>
            </>
          )}
        </div>

        <button type="button" className="result-summary-toggle" onClick={() => setSummaryOpen((value) => !value)}>
          <Icon name={summaryOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          导出参数摘要
          <span className="result-summary-preview">{summary}</span>
        </button>
        {summaryOpen ? <div className="result-summary-detail">{summary}</div> : null}

        {adjustOpen ? (
          <div className="result-adjust">
            <div className="result-adjust-head">
              <Icon name="sliders" size={14} />
              <span>调整参数再导出</span>
              <span className="result-adjust-hint">会重新执行转换并写入历史</span>
            </div>
            <ParamPanel
              compact
              animFormat={format}
              params={draftParams}
              presetId={draftPresetId}
              sourceWidth={result.sourceProbe?.width ?? result.info.width}
                      sourceHeight={result.sourceProbe?.height ?? result.info.height}
              fileNamePreview={fileNamePreview}
              onChange={(params, preset) => {
                setDraftParams(params)
                setDraftPresetId(preset)
              }}
            />
            <div className="result-adjust-actions">
              {!media ? <span className="result-adjust-warning">缺少源媒体信息，无法重新导出</span> : null}
              <Button size="sm" variant="ghost" onClick={() => setAdjustOpen(false)}>
                收起
              </Button>
              <Button size="sm" variant="primary" icon="refresh" onClick={submitReencode} disabled={!media}>
                按新参数重新导出
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="删除这个动图？"
        message={
          '将删除该动图文件并从历史记录中移除该结果。此操作不可撤销。\n文件：' + result.info.fileName
        }
        confirmText="删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          void deleteResult(result)
        }}
      />
    </article>
  )
}