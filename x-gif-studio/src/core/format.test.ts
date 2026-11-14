import { describe, expect, test } from './_testkit'
import {
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatFps,
  formatPercent,
  formatRelativeTime,
  formatSize,
  formatSizeRatio,
} from './format'

describe('formatSize', () => {
  test('字节、KB、MB、GB 换算', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1048576)).toBe('1 MB')
    expect(formatSize(1024 * 1024 * 1024)).toBe('1 GB')
  })

  test('大数值压缩小数位', () => {
    expect(formatSize(123 * 1024 * 1024)).toBe('123 MB')
    expect(formatSize(1234567890)).toBe('1.15 GB')
  })

  test('非法输入返回占位符', () => {
    expect(formatSize(null)).toBe('—')
    expect(formatSize(undefined)).toBe('—')
    expect(formatSize(Number.NaN)).toBe('—')
    expect(formatSize(-1)).toBe('—')
  })
})

describe('formatDuration', () => {
  test('毫秒、秒、分钟、小时', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(0.5)).toBe('500 毫秒')
    expect(formatDuration(1.5)).toBe('1.5 秒')
    expect(formatDuration(3.04)).toBe('3 秒')
    expect(formatDuration(60)).toBe('1 分钟')
    expect(formatDuration(75)).toBe('1 分 15 秒')
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDuration(3660)).toBe('1 小时 1 分')
  })

  test('非法输入返回占位符', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatDuration(-2)).toBe('—')
  })
})

describe('formatFps / formatCount / formatPercent / formatClock', () => {
  test('帧率', () => {
    expect(formatFps(25)).toBe('25 fps')
    expect(formatFps(29.97)).toBe('29.97 fps')
    expect(formatFps(0)).toBe('—')
    expect(formatFps(null)).toBe('—')
  })

  test('千分位数量', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(-1234)).toBe('-1,234')
    expect(formatCount(Number.NaN)).toBe('—')
  })

  test('百分比截断在 0-100', () => {
    expect(formatPercent(42.4)).toBe('42%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(150)).toBe('100%')
    expect(formatPercent(-1)).toBe('—')
    expect(formatPercent(null)).toBe('—')
  })

  test('紧凑时钟', () => {
    expect(formatClock(3.5)).toBe('0:04')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(null)).toBe('—')
  })
})

describe('日期格式化', () => {
  test('formatDateTime / formatDate', () => {
    const value = '2026-11-11T01:10:57+08:00'
    expect(formatDateTime(value)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatDate(value)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(formatDateTime('not-a-date')).toBe('—')
    expect(formatDateTime(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
  })

  test('相对时间基于 now 计算', () => {
    const now = Date.parse('2026-11-11T04:00:00.000Z')
    const ago = (ms: number) => new Date(now - ms).toISOString()
    expect(formatRelativeTime(ago(30_000), now)).toBe('刚刚')
    expect(formatRelativeTime(ago(30 * 60_000), now)).toBe('30 分钟前')
    expect(formatRelativeTime(ago(3 * 3_600_000), now)).toBe('3 小时前')
    expect(formatRelativeTime(ago(2 * 86_400_000), now)).toBe('2 天前')
    expect(formatRelativeTime(ago(30 * 86_400_000), now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(formatRelativeTime(null, now)).toBe('—')
  })
})
describe('formatSizeRatio', () => {
  test('生成相对源文件倍数文案', () => {
    expect(formatSizeRatio(10240, 1024)).toBe('约为源视频的 10 倍')
    expect(formatSizeRatio(1048576, 102400)).toBe('约为源视频的 10.2 倍')
    expect(formatSizeRatio(2048, 1024)).toBe('约为源视频的 2 倍')
    expect(formatSizeRatio(100, 10)).toBe('约为源视频的 10 倍')
    expect(formatSizeRatio(1024, 1024, '原始视频')).toBe('约为原始视频的 1 倍')
  })

  test('数据缺失或非法时返回 null', () => {
    expect(formatSizeRatio(1024, null)).toBeNull()
    expect(formatSizeRatio(null, 1024)).toBeNull()
    expect(formatSizeRatio(1024, 0)).toBeNull()
    expect(formatSizeRatio(-1, 10)).toBeNull()
  })
})