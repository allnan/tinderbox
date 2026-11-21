const countryFlags: Record<string, string> = {
  香港: '🇨🇳', 香港特别行政区: '🇨🇳', 'hong kong': '🇨🇳', hongkong: '🇨🇳', hk: '🇨🇳',
  台湾: '🇨🇳', 台灣: '🇨🇳', 臺灣: '🇨🇳', 'taiwan': '🇨🇳', tw: '🇨🇳',
  中国: '🇨🇳', 中国大陆: '🇨🇳', china: '🇨🇳', cn: '🇨🇳',
  日本: '🇯🇵', japan: '🇯🇵', jp: '🇯🇵', 新加坡: '🇸🇬', singapore: '🇸🇬', sg: '🇸🇬',
  美国: '🇺🇸', 'united states': '🇺🇸', usa: '🇺🇸', us: '🇺🇸', 英国: '🇬🇧', 'united kingdom': '🇬🇧', uk: '🇬🇧',
  韩国: '🇰🇷', 'south korea': '🇰🇷', kr: '🇰🇷', 德国: '🇩🇪', germany: '🇩🇪', de: '🇩🇪', 法国: '🇫🇷', france: '🇫🇷', fr: '🇫🇷',
  加拿大: '🇨🇦', canada: '🇨🇦', ca: '🇨🇦', 澳大利亚: '🇦🇺', australia: '🇦🇺', au: '🇦🇺', 荷兰: '🇳🇱', netherlands: '🇳🇱', nl: '🇳🇱',
  俄罗斯: '🇷🇺', russia: '🇷🇺', ru: '🇷🇺', 泰国: '🇹🇭', thailand: '🇹🇭', th: '🇹🇭', 越南: '🇻🇳', vietnam: '🇻🇳', vn: '🇻🇳',
  马来西亚: '🇲🇾', malaysia: '🇲🇾', my: '🇲🇾', 菲律宾: '🇵🇭', philippines: '🇵🇭', ph: '🇵🇭', 印度: '🇮🇳', india: '🇮🇳', in: '🇮🇳',
  瑞士: '🇨🇭', switzerland: '🇨🇭', ch: '🇨🇭', 土耳其: '🇹🇷', turkey: '🇹🇷', tr: '🇹🇷', 巴西: '🇧🇷', brazil: '🇧🇷', br: '🇧🇷',
}

export function countryFlagForDisplay(country: string) {
  return countryFlags[country.trim().toLocaleLowerCase('zh-CN')] ?? '🌏'
}

export function countryGroupDisplayName(country: string, provider?: string) {
  return `${countryFlagForDisplay(country)} ${country}${provider ? ` · ${provider}` : ''}`
}
