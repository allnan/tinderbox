export type UrlProtocol = 'https' | 'http'

export function composeRouteCheckUrl(protocol: UrlProtocol, address: string) {
  const normalizedAddress = address.trim()
  if (!normalizedAddress) return ''
  const explicitProtocol = normalizedAddress.match(/^([a-z][a-z\d+.-]*):\/\//i)?.[1].toLowerCase()
  if (explicitProtocol && explicitProtocol !== 'http' && explicitProtocol !== 'https') return ''
  const target = explicitProtocol
    ? normalizedAddress
    : `${protocol}://${normalizedAddress.replace(/^\/\//, '')}`
  try {
    const parsed = new URL(target)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname ? parsed.href : ''
  } catch {
    return ''
  }
}
