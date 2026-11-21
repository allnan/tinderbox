export const defaultAutoGroupNameParts = ['provider', 'separator:dot', 'route']

export const autoGroupNamePartLabels: Record<string, string> = {
  provider: '订阅厂商',
  route: '地区 / 全部节点',
  'separator:dot': '·',
  'separator:dash': '—',
  'separator:slash': '/',
  'separator:underscore': '_',
  'separator:space': '空格',
}

export const autoGroupNameSeparators = [
  'separator:dot',
  'separator:dash',
  'separator:slash',
  'separator:underscore',
  'separator:space',
]

const separatorValues: Record<string, string> = {
  'separator:dot': ' · ',
  'separator:dash': ' — ',
  'separator:slash': ' / ',
  'separator:underscore': '_',
  'separator:space': ' ',
}

export function normalizeAutoGroupNameParts(parts: string[] | null | undefined) {
  return Array.isArray(parts) && parts.length ? parts.filter((part) => part in autoGroupNamePartLabels) : [...defaultAutoGroupNameParts]
}

export function isValidAutoGroupNameParts(parts: string[]) {
  const providerIndex = parts.indexOf('provider')
  const routeIndex = parts.indexOf('route')
  const separatorIndexes = parts.map((part, index) => autoGroupNameSeparators.includes(part) ? index : -1).filter((index) => index >= 0)
  return providerIndex >= 0
    && routeIndex >= 0
    && parts.filter((part) => part === 'provider').length === 1
    && parts.filter((part) => part === 'route').length === 1
    && separatorIndexes.length === 1
    && separatorIndexes[0] > Math.min(providerIndex, routeIndex)
    && separatorIndexes[0] < Math.max(providerIndex, routeIndex)
}

export function composeAutoGroupName(parts: string[], provider: string, route: string) {
  return parts.map((part) => {
    if (part === 'provider') return provider
    if (part === 'route') return route
    return separatorValues[part] ?? ''
  }).join('').trim().replace(/\s+/g, ' ')
}
