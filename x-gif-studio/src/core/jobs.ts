import type { JobPhase } from '../shared/types'

/** 界面侧任务状态（主进程只负责进度事件与结果） */
export type JobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'

const PHASE_LABELS: Record<JobPhase, string> = {
  queued: '排队中',
  download: '下载媒体',
  probe: '分析媒体',
  thumbnail: '生成缩略图',
  extract: '抽取视频帧',
  encode: '编码 GIF',
  optimize: '优化体积',
  finalize: '写入文件',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
}

export function phaseLabel(phase: JobPhase | null | undefined): string {
  return phase ? PHASE_LABELS[phase] ?? '处理中' : '处理中'
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: '排队中',
  running: '转换中',
  success: '已完成',
  error: '失败',
  cancelled: '已取消',
}

export function jobStatusLabel(status: JobStatus): string {
  return STATUS_LABELS[status] ?? '处理中'
}

export function isActiveJobStatus(status: JobStatus): boolean {
  return status === 'queued' || status === 'running'
}

export function isFinishedJobStatus(status: JobStatus): boolean {
  return !isActiveJobStatus(status)
}

/** 生成 jobId（crypto.randomUUID 缺失时使用可读回退格式） */
export function createJobId(): string {
  const cryptoObject = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    try {
      return cryptoObject.randomUUID()
    } catch {
      // 某些环境禁用 randomUUID，继续走回退
    }
  }
  const random = Math.random().toString(36).slice(2, 10)
  return `job-${Date.now().toString(36)}-${random}`
}

/** 多个任务的平均进度；没有任务或全为未知进度时返回 -1 */
export function averageProgress(jobs: Array<{ status: JobStatus; percent: number }>): number {
  const known = jobs.filter((job) => Number.isFinite(job.percent) && job.percent >= 0)
  if (known.length === 0) return -1
  const sum = known.reduce((total, job) => total + job.percent, 0)
  return Math.round(sum / known.length)
}

/** '编码 GIF · 42%' 这类紧凑描述 */
export function jobProgressText(phase: JobPhase, percent: number): string {
  const label = phaseLabel(phase)
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) return label
  return `${label} · ${Math.round(percent)}%`
}
