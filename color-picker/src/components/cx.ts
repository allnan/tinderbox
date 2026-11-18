/** 拼接类名，过滤 false / null / undefined。 */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}
