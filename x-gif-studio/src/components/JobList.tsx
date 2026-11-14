import React from 'react'
import type { JobRecord } from '../state/store'
import { formatPercent } from '../core/format'
import { jobStatusLabel } from '../core/jobs'
import { Button, Icon, Spinner, cx } from './ui'

const STATUS_ICON = {
  queued: 'clock',
  running: 'refresh',
  success: 'success',
  error: 'error',
  cancelled: 'x',
} as const

/** 转换任务列表：进度条、阶段文案、取消与清除 */
export function JobList({
  jobs,
  onCancel,
  onDismiss,
  onClearFinished,
  compact,
  hideHeader,
  iconOnlyActions,
}: {
  jobs: JobRecord[]
  onCancel: (jobId: string) => void
  onDismiss: (jobId: string) => void
  onClearFinished: () => void
  /** 解析页右栏窄条模式：更小的行高/字号/按钮 */
  compact?: boolean
  /** 侧边栏使用：外层已有标题，不再渲染组件自带表头 */
  hideHeader?: boolean
  /** 侧边栏使用：取消/移除只显示图标，节省窄栏宽度 */
  iconOnlyActions?: boolean
}) {
  if (jobs.length === 0) return null
  const activeCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
  const finishedCount = jobs.length - activeCount

  // 只有已结束任务时，一行紧凑摘要即可，不展开列表
  if (activeCount === 0) {
    const failedCount = jobs.filter((job) => job.status === 'error').length
    return (
      <div className={cx('job-summary', compact && 'is-narrow', failedCount > 0 ? 'is-error' : 'is-success')} data-testid="job-summary">
        <Icon name={failedCount > 0 ? 'warning' : 'success'} size={14} />
        <span className="job-summary-text">
          最近 {jobs.length} 个任务{failedCount > 0 ? `已结束（${failedCount} 个失败）` : '已完成'}
        </span>
        <button type="button" className="job-summary-clear" onClick={onClearFinished}>
          清除
        </button>
      </div>
    )
  }

  return (
    <section className={cx('job-list', 'panel', compact && 'is-narrow')} aria-label="转换任务">
      {hideHeader ? null : (
      <header className="job-list-head">
        <h2 className="job-list-title">
          <Icon name="bolt" size={15} />
          转换任务
          {activeCount > 0 ? <span className="job-list-count">{activeCount} 个进行中</span> : null}
        </h2>
        <div className="job-list-actions">
          {finishedCount > 0 ? (
            <Button size="xs" variant="ghost" onClick={onClearFinished}>
              清除已结束（{finishedCount}）
            </Button>
          ) : null}
        </div>
      </header>
      )}
      <div className="job-list-body">
        {jobs.map((job) => {
          const active = job.status === 'queued' || job.status === 'running'
          const indeterminate = job.status === 'running' && job.percent < 0
          const width = job.status === 'success' ? 100 : active ? Math.max(0, Math.min(100, job.percent)) : 100
          return (
            <div key={job.jobId} data-job-id={job.jobId} className={cx('job-row', `is-${job.status}`)}>
              <div className="job-type-icon">
                {job.status === 'running' ? <Spinner size={15} /> : <Icon name={STATUS_ICON[job.status]} size={15} />}
              </div>
              <div className="job-main">
                <div className="job-line">
                  <span className="job-label">{job.label}</span>
                  <span className={cx('job-status', `is-${job.status}`)}>{jobStatusLabel(job.status)}</span>
                  {job.status === 'running' || job.status === 'success' ? (
                    <span className="job-percent mono">{formatPercent(job.percent)}</span>
                  ) : null}
                </div>
                <div className={cx('job-sub', job.status === 'error' && 'is-error')} title={job.error ?? job.message}>
                  {job.status === 'error' ? job.error || job.message : job.message}
                </div>
                <div className={cx('progress-track', indeterminate && 'is-indeterminate')}>
                  <div
                    className={cx('progress-bar', `is-${job.status}`, indeterminate && 'is-indeterminate')}
                    style={indeterminate ? undefined : { width: `${width}%` }}
                  />
                </div>
              </div>
              <div className="job-actions">
                {active ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="x"
                    onClick={() => onCancel(job.jobId)}
                    title={job.status === 'queued' ? '移除' : '取消'}
                    aria-label={job.status === 'queued' ? '移除任务' : '取消任务'}
                  >
                    {iconOnlyActions ? null : job.status === 'queued' ? '移除' : '取消'}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="close"
                    onClick={() => onDismiss(job.jobId)}
                    title="从列表移除"
                    aria-label="从列表移除"
                  >
                    {iconOnlyActions ? null : '移除'}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}