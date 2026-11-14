import { describe, expect, test } from './_testkit'
import type { JobPhase } from '../shared/types'
import {
  averageProgress,
  createJobId,
  isActiveJobStatus,
  isFinishedJobStatus,
  jobProgressText,
  jobStatusLabel,
  phaseLabel,
} from './jobs'

const PHASES: JobPhase[] = [
  'queued',
  'download',
  'probe',
  'thumbnail',
  'extract',
  'encode',
  'optimize',
  'finalize',
  'done',
  'error',
  'cancelled',
]

describe('phaseLabel', () => {
  test('每个阶段都有中文文案', () => {
    for (const phase of PHASES) {
      expect(phaseLabel(phase).length).toBeGreaterThan(1)
    }
    expect(phaseLabel('encode')).toBe('编码 GIF')
    expect(phaseLabel('download')).toBe('下载媒体')
    expect(phaseLabel(null)).toBe('处理中')
  })
})

describe('任务状态', () => {
  test('状态中文文案', () => {
    expect(jobStatusLabel('queued')).toBe('排队中')
    expect(jobStatusLabel('running')).toBe('转换中')
    expect(jobStatusLabel('success')).toBe('已完成')
    expect(jobStatusLabel('error')).toBe('失败')
    expect(jobStatusLabel('cancelled')).toBe('已取消')
  })

  test('活跃 / 结束状态判断', () => {
    expect(isActiveJobStatus('queued')).toBeTruthy()
    expect(isActiveJobStatus('running')).toBeTruthy()
    expect(isActiveJobStatus('success')).toBeFalsy()
    expect(isFinishedJobStatus('success')).toBeTruthy()
    expect(isFinishedJobStatus('error')).toBeTruthy()
    expect(isFinishedJobStatus('cancelled')).toBeTruthy()
    expect(isFinishedJobStatus('running')).toBeFalsy()
  })
})

describe('createJobId', () => {
  test('生成稳定格式的 jobId 且不重复', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 50; index += 1) {
      const id = createJobId()
      expect(id.length).toBeGreaterThan(8)
      ids.add(id)
    }
    expect(ids.size).toBe(50)
  })
})

describe('averageProgress / jobProgressText', () => {
  test('平均进度忽略未知值', () => {
    expect(averageProgress([{ status: 'running', percent: 40 }, { status: 'success', percent: 100 }])).toBe(70)
    expect(averageProgress([{ status: 'running', percent: -1 }, { status: 'queued', percent: -1 }])).toBe(-1)
    expect(averageProgress([])).toBe(-1)
  })

  test('进度文案', () => {
    expect(jobProgressText('encode', 42.6)).toBe('编码 GIF · 43%')
    expect(jobProgressText('encode', -1)).toBe('编码 GIF')
    expect(jobProgressText('done', 100)).toBe('完成')
  })
})
