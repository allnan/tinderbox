import type { OperationResult } from '../shared/types'

/** 判断一个 IPC 返回值是否统一结果包装（{ok,data} | {ok:false,error}） */
export function isOperationResult<T = unknown>(value: unknown): value is OperationResult<T> {
  return Boolean(value) && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean'
}

/**
 * media.toDisplayUrl 在 DesktopApi 契约中返回 string，
 * 但主进程当前实现经由统一 guard 返回 OperationResult<string>。
 * 这里两种形态都兼容，避免真实 Electron 里把对象塞进 img.src。
 */
export function unwrapDisplayUrl(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (isOperationResult<string>(value)) {
    return value.ok && typeof value.data === 'string' ? value.data.trim() : ''
  }
  return ''
}
