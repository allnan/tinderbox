'use strict'

/**
 * 简单任务管理器：登记 jobId，提供进度回调、取消检查与子进程终止钩子。
 * engine 侧每个长任务创建一个 Job，并周期性调用 throwIfCancelled()。
 */

const { randomUUID } = require('node:crypto')

const registry = new Map()

class Job {
  constructor(jobId, scope, onProgress) {
    this.jobId = jobId || randomUUID()
    this.scope = scope || 'gif'
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    this.cancelled = false
    this.children = new Set()
    this.startedAt = Date.now()
    registry.set(this.jobId, this)
  }

  progress(phase, percent, message) {
    this.onProgress({
      jobId: this.jobId,
      scope: this.scope,
      phase,
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : -1,
      message: message || '',
    })
  }

  /** 注册可被取消时终止的子进程；返回的清理函数用于在进程结束后解除登记 */
  track(child) {
    this.children.add(child)
    return () => this.children.delete(child)
  }

  throwIfCancelled() {
    if (this.cancelled) {
      const error = new Error('任务已取消')
      error.code = 'CANCELLED'
      throw error
    }
  }

  cancel() {
    this.cancelled = true
    for (const child of this.children) {
      try {
        if (child && !child.killed) child.kill()
      } catch {
        /* 忽略 */
      }
    }
    this.children.clear()
    registry.delete(this.jobId)
  }

  finish() {
    registry.delete(this.jobId)
  }
}

function cancel(jobId) {
  const job = registry.get(jobId)
  if (job) job.cancel()
  return true
}

function isCancelled(jobId) {
  const job = registry.get(jobId)
  return Boolean(job && job.cancelled)
}

module.exports = { Job, cancel, isCancelled }
