export const ruleSetPurposeCategories = [
  'AI 服务',
  '搜索与开发',
  '社交与通信',
  '影音与音乐',
  '游戏平台',
  '云服务与支付',
  '国内服务',
  '网络与广告',
  '其他用途',
] as const

export function resolveRuleSetPurpose(category: string | undefined, name: string, description: string, url: string) {
  if (category && ruleSetPurposeCategories.includes(category as (typeof ruleSetPurposeCategories)[number])) return category

  const text = `${name} ${description} ${url}`.toLocaleLowerCase()
  if (/openai|chatgpt|claude|anthropic|gemini|copilot|perplexity|deepseek|hugging\s?face|apple intelligence|category-ai|\bai\b/.test(text)) return 'AI 服务'
  if (/steam|epic|playstation|sony|nintendo|origin|xbox|game|游戏平台|游戏下载/.test(text)) return '游戏平台'
  if (/telegram|twitter|\bx\b|facebook|tiktok|discord|instagram|reddit|whatsapp|signal|slack|zoom|proton.?mail|通信|社交/.test(text)) return '社交与通信'
  if (/youtube|netflix|spotify|disney|prime.?video|twitch|hulu|proxy.?media|stream|bilibili|media|影音|媒体|流媒体|音乐/.test(text)) return '影音与音乐'
  if (/china|中国大陆|国内|cncidr|googlecn|google.?cn|google.?fcm|apple.?cn|microsoft.?cn|cn.?media|bilibili|国内服务/.test(text)) return '国内服务'
  if (/apple|icloud|microsoft|onedrive|dropbox|paypal|adobe|notion|cloudflare|cloud|支付|云服务/.test(text)) return '云服务与支付'
  if (/github|gitlab|bing|google|docker|scholar|cursor|search|搜索|开发/.test(text)) return '搜索与开发'
  if (/local.?area|private|lan|ban.?ad|advert|adblock|proxy.?gfw|\bgfw\b|tld|speedtest|download|application|tailscale|广告|局域网|保留地址|测速/.test(text)) return '网络与广告'
  return '其他用途'
}
