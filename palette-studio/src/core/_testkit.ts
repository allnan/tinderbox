/**
 * 极简测试工具（仅用于 core 纯函数模块，不进入应用打包产物）。
 * 测试文件在被 scripts/test.mjs 加载时自动注册用例，随后统一执行。
 */

export interface TestCase {
  name: string
  fn: () => void
}

declare global {
  // eslint-disable-next-line no-var
  var __PALETTE_TESTS__: TestCase[] | undefined
}

function registry(): TestCase[] {
  if (!globalThis.__PALETTE_TESTS__) globalThis.__PALETTE_TESTS__ = []
  return globalThis.__PALETTE_TESTS__
}

/** 注册一个同步测试用例 */
export function test(name: string, fn: () => void): void {
  registry().push({ name, fn })
}

/** 分组（前缀拼到用例名上） */
export function describe(group: string, fn: () => void): void {
  const before = registry().length
  fn()
  const added = registry().slice(before)
  registry().splice(before, added.length)
  for (const item of added) registry().push({ name: `${group} › ${item.name}`, fn: item.fn })
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 极简断言器 */
export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`期望 ${stringify(expected)}，实际 ${stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      const a = stringify(actual)
      const b = stringify(expected)
      if (a !== b) throw new Error(`期望 ${b}，实际 ${a}`)
    },
    toBeTruthy() {
      if (!actual) throw new Error(`期望为真，实际 ${stringify(actual)}`)
    },
    toBeFalsy() {
      if (actual) throw new Error(`期望为假，实际 ${stringify(actual)}`)
    },
    toBeNull() {
      if (actual !== null) throw new Error(`期望 null，实际 ${stringify(actual)}`)
    },
    toBeDefined() {
      if (actual === undefined) throw new Error('期望已定义，实际 undefined')
    },
    toBeCloseTo(expected: number, digits = 2) {
      const diff = Math.abs(Number(actual) - expected)
      const tolerance = Math.pow(10, -digits) / 2
      if (!(diff <= tolerance)) throw new Error(`期望约等于 ${expected}（${digits} 位），实际 ${String(actual)}`)
    },
    toBeGreaterThan(expected: number) {
      if (!(Number(actual) > expected)) throw new Error(`期望大于 ${expected}，实际 ${String(actual)}`)
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (!(Number(actual) >= expected)) throw new Error(`期望大于等于 ${expected}，实际 ${String(actual)}`)
    },
    toBeLessThan(expected: number) {
      if (!(Number(actual) < expected)) throw new Error(`期望小于 ${expected}，实际 ${String(actual)}`)
    },
    toBeLessThanOrEqual(expected: number) {
      if (!(Number(actual) <= expected)) throw new Error(`期望小于等于 ${expected}，实际 ${String(actual)}`)
    },
    toContain(expected: unknown) {
      if (typeof actual === 'string') {
        if (!actual.includes(String(expected))) throw new Error(`期望包含 ${String(expected)}，实际 ${actual}`)
        return
      }
      if (Array.isArray(actual)) {
        if (!actual.includes(expected)) throw new Error(`期望数组包含 ${stringify(expected)}，实际 ${stringify(actual)}`)
        return
      }
      throw new Error('toContain 只支持字符串或数组')
    },
    toMatch(pattern: RegExp) {
      if (!pattern.test(String(actual))) throw new Error(`期望匹配 ${pattern}，实际 ${String(actual)}`)
    },
    toThrow(matcher?: string | RegExp) {
      let thrown: unknown = null
      try {
        ;(actual as () => void)()
      } catch (err) {
        thrown = err
      }
      if (thrown === null) throw new Error('期望抛出异常，实际没有抛出')
      if (matcher !== undefined) {
        const message = thrown instanceof Error ? thrown.message : String(thrown)
        const ok = typeof matcher === 'string' ? message.includes(matcher) : matcher.test(message)
        if (!ok) throw new Error(`异常信息不匹配：期望 ${String(matcher)}，实际 ${message}`)
      }
    },
  }
}
