import React from 'react'
import { useApp } from '../state/store'
import { Icon } from './ui'
import { JobList } from './JobList'

/**
 * 侧边栏任务区：集中显示 GIF 转换任务（保存任务不在其中）。
 * 解析、历史、设置各页面都能看到；没有任务时不占位。
 */
export function SidebarTasks() {
  const { jobs, cancelJob, dismissJob, clearFinishedJobs } = useApp()
  const gifJobs = jobs.filter((job) => job.kind !== 'save')
  if (gifJobs.length === 0) return null
  const activeCount = gifJobs.filter((job) => job.status === 'queued' || job.status === 'running').length

  return (
    <section className="sidebar-tasks" data-testid="sidebar-tasks" aria-label="转换任务">
      <header className="sidebar-tasks-head">
        <Icon name="bolt" size={13} />
        <span className="sidebar-tasks-title">任务</span>
        <span className={activeCount > 0 ? 'sidebar-tasks-count is-active' : 'sidebar-tasks-count'}>
          {activeCount > 0 ? activeCount + ' 个进行中' : '已完成'}
        </span>
      </header>
      <div className="sidebar-tasks-body">
        <JobList
          compact
          hideHeader
          iconOnlyActions
          jobs={gifJobs}
          onCancel={(id) => void cancelJob(id)}
          onDismiss={dismissJob}
          onClearFinished={() => clearFinishedJobs(['convert', 'reencode'])}
        />
      </div>
    </section>
  )
}
