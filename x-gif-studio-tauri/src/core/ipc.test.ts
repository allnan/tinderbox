import { describe, expect, test } from './_testkit'
import { isOperationResult, unwrapDisplayUrl } from './ipc'

describe('isOperationResult', () => {
  test('识别统一结果包装', () => {
    expect(isOperationResult({ ok: true, data: 1 })).toBeTruthy()
    expect(isOperationResult({ ok: false, error: 'x' })).toBeTruthy()
    expect(isOperationResult({ ok: 'yes' })).toBeFalsy()
    expect(isOperationResult('xgif://a')).toBeFalsy()
    expect(isOperationResult(null)).toBeFalsy()
    expect(isOperationResult(undefined)).toBeFalsy()
  })
})

describe('unwrapDisplayUrl', () => {
  test('兼容裸字符串返回值', () => {
    expect(unwrapDisplayUrl('xgif://display/?path=a.gif')).toBe('xgif://display/?path=a.gif')
    expect(unwrapDisplayUrl('  xgif://a  ')).toBe('xgif://a')
  })

  test('兼容 OperationResult<string> 返回值', () => {
    expect(unwrapDisplayUrl({ ok: true, data: 'xgif://b' })).toBe('xgif://b')
    expect(unwrapDisplayUrl({ ok: false, error: 'no' })).toBe('')
    expect(unwrapDisplayUrl({ ok: true, data: 42 })).toBe('')
  })

  test('非法输入返回空字符串', () => {
    expect(unwrapDisplayUrl(null)).toBe('')
    expect(unwrapDisplayUrl(undefined)).toBe('')
    expect(unwrapDisplayUrl({})).toBe('')
  })
})
