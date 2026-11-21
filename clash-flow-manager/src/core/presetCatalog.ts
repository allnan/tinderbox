export type PolicyPreset = {
  id: string
  name: string
  description: string
  url: string
}

export type PolicyPresetGroup = {
  label: string
  source: string
  sourceUrl: string
  items: PolicyPreset[]
}

const aclOnline = (file: string) => `https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/${file}.ini`
const aclSubconverter = (file: string) => `https://raw.githubusercontent.com/tindy2013/subconverter/master/base/config/${file}.ini`
const sleepy = (path: string) => `https://raw.githubusercontent.com/SleepyHeeead/subconverter-config/master/remote-config/${path}.ini`

export const policyPresetGroups: PolicyPresetGroup[] = [
  {
    label: 'ACL4SSR · 在线规则（GitHub 同步）',
    source: 'ACL4SSR/ACL4SSR',
    sourceUrl: 'https://github.com/ACL4SSR/ACL4SSR/tree/master/Clash/config',
    items: [
      { id: 'acl-online', name: 'ACL4SSR 默认版 分组比较全', description: '常用分流组，自动测速，含广告拦截、微软和苹果分流。', url: aclOnline('ACL4SSR_Online') },
      { id: 'acl-online-adblock', name: 'ACL4SSR 更多去广告', description: '默认版基础上增加广告拦截规则。', url: aclOnline('ACL4SSR_Online_AdblockPlus') },
      { id: 'acl-online-multicountry', name: 'ACL4SSR 多国家分组', description: '按国家地区提供节点分组。', url: aclOnline('ACL4SSR_Online_MultiCountry') },
      { id: 'acl-online-noauto', name: 'ACL4SSR 无自动测速', description: '不创建自动测速组。', url: aclOnline('ACL4SSR_Online_NoAuto') },
      { id: 'acl-online-noreject', name: 'ACL4SSR 无广告拦截规则', description: '移除 REJECT 广告拦截规则。', url: aclOnline('ACL4SSR_Online_NoReject') },
      { id: 'acl-online-mini', name: 'ACL4SSR 精简版', description: '较少的策略组和分流规则。', url: aclOnline('ACL4SSR_Online_Mini') },
      { id: 'acl-online-mini-adblock', name: 'ACL4SSR 精简版 更多去广告', description: '精简分组并增加广告拦截规则。', url: aclOnline('ACL4SSR_Online_Mini_AdblockPlus') },
      { id: 'acl-online-mini-noauto', name: 'ACL4SSR 精简版 无自动测速', description: '精简分组，不创建自动测速组。', url: aclOnline('ACL4SSR_Online_Mini_NoAuto') },
      { id: 'acl-online-mini-fallback', name: 'ACL4SSR 精简版 故障转移', description: '精简分组，包含自动测速和故障转移。', url: aclOnline('ACL4SSR_Online_Mini_Fallback') },
      { id: 'acl-online-mini-multimode', name: 'ACL4SSR 精简版 多模式', description: '精简分组，包含自动测速、故障转移和负载均衡。', url: aclOnline('ACL4SSR_Online_Mini_MultiMode') },
      { id: 'acl-online-mini-multicountry', name: 'ACL4SSR 精简版 多国家分组', description: '精简分组，包含港、美、日等国家分组。', url: aclOnline('ACL4SSR_Online_Mini_MultiCountry') },
      { id: 'acl-online-full', name: 'ACL4SSR 全分组', description: '较完整的应用、媒体、游戏和地区策略组。', url: aclOnline('ACL4SSR_Online_Full') },
      { id: 'acl-online-full-multimode', name: 'ACL4SSR 全分组 多模式', description: '完整分组，包含测速、故障转移和负载均衡。', url: aclOnline('ACL4SSR_Online_Full_MultiMode') },
      { id: 'acl-online-full-noauto', name: 'ACL4SSR 全分组 无自动测速', description: '完整分组，不创建自动测速组。', url: aclOnline('ACL4SSR_Online_Full_NoAuto') },
      { id: 'acl-online-full-adblock', name: 'ACL4SSR 全分组 更多去广告', description: '完整分组并增加广告拦截规则。', url: aclOnline('ACL4SSR_Online_Full_AdblockPlus') },
      { id: 'acl-online-full-netflix', name: 'ACL4SSR 全分组 Netflix', description: '完整分组，加入奈飞相关规则和策略组。', url: aclOnline('ACL4SSR_Online_Full_Netflix') },
      { id: 'acl-online-full-google', name: 'ACL4SSR 全分组 Google', description: '完整分组，细分 Google 相关规则。', url: aclOnline('ACL4SSR_Online_Full_Google') },
    ],
  },
  {
    label: 'ACL4SSR · 本地版模板',
    source: 'tindy2013/subconverter 与 ACL4SSR/ACL4SSR',
    sourceUrl: 'https://github.com/tindy2013/subconverter/tree/master/base/config',
    items: [
      { id: 'acl-local', name: 'ACL4SSR 本地默认版 分组比较全', description: 'Subconverter 本地配置模板；相对规则地址会转换为 ACL4SSR GitHub 规则链接。', url: aclSubconverter('ACL4SSR') },
      { id: 'acl-local-mini', name: 'ACL4SSR 本地精简版', description: 'Subconverter 本地精简配置模板。', url: aclSubconverter('ACL4SSR_Mini') },
      { id: 'acl-local-mini-noauto', name: 'ACL4SSR 本地精简版 无自动测速', description: '精简配置，不创建自动测速组。', url: aclSubconverter('ACL4SSR_Mini_NoAuto') },
      { id: 'acl-local-mini-fallback', name: 'ACL4SSR 本地精简版 Fallback', description: '精简配置，含故障转移组。', url: aclSubconverter('ACL4SSR_Mini_Fallback') },
      { id: 'acl-local-backcn', name: 'ACL4SSR 本地回国分流', description: '适用于回国节点的分流配置。', url: aclSubconverter('ACL4SSR_BackCN') },
      { id: 'acl-local-noapple', name: 'ACL4SSR 本地无苹果分流', description: '不创建 Apple 专属分流组。', url: aclSubconverter('ACL4SSR_NoApple') },
      { id: 'acl-local-noauto', name: 'ACL4SSR 本地无自动测速', description: '保留分组，不创建自动测速组。', url: aclSubconverter('ACL4SSR_NoAuto') },
      { id: 'acl-local-noauto-noapple', name: 'ACL4SSR 本地无测速无苹果分流', description: '同时移除自动测速和 Apple 分流。', url: aclSubconverter('ACL4SSR_NoAuto_NoApple') },
      { id: 'acl-local-nomicrosoft', name: 'ACL4SSR 本地无微软分流', description: '不创建 Microsoft 专属分流组。', url: aclSubconverter('ACL4SSR_NoMicrosoft') },
      { id: 'acl-local-withgfw', name: 'ACL4SSR 本地 GFW 列表', description: '使用 GFW 列表的本地规则模板。', url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_WithGFW.ini' },
    ],
  },
  {
    label: '通用规则 · SleepyHeeead',
    source: 'SleepyHeeead/subconverter-config',
    sourceUrl: 'https://github.com/SleepyHeeead/subconverter-config/tree/master/remote-config',
    items: [
      { id: 'sleepy-no-urltest', name: '通用 No-Urltest', description: '通用分流组，不创建自动测速组。', url: sleepy('universal/no-urltest') },
      { id: 'sleepy-urltest', name: '通用 Urltest', description: '通用分流组，按地区筛选节点并自动测速。', url: sleepy('universal/urltest') },
    ],
  },
  {
    label: '服务商定制方案 · SleepyHeeead',
    source: 'SleepyHeeead/subconverter-config',
    sourceUrl: 'https://github.com/SleepyHeeead/subconverter-config/tree/master/remote-config/customized',
    items: [
      { id: 'sleepy-maying', name: 'Maying 定制方案', description: '针对 Maying 节点命名的策略模板。', url: sleepy('customized/maying') },
      { id: 'sleepy-ytoo', name: 'Ytoo 定制方案', description: '针对 Ytoo 节点命名的策略模板。', url: sleepy('customized/ytoo') },
      { id: 'sleepy-flowercloud', name: 'FlowerCloud 定制方案', description: '针对 FlowerCloud 节点命名的策略模板。', url: sleepy('customized/flowercloud') },
      { id: 'sleepy-socloud', name: 'SoCloud 定制方案', description: '针对 SoCloud 节点命名的策略模板。', url: sleepy('customized/socloud') },
      { id: 'sleepy-ark', name: 'ARK 定制方案', description: '针对 ARK 节点命名的策略模板。', url: sleepy('customized/ark') },
      { id: 'sleepy-ssrcloud', name: 'ssrCloud 定制方案', description: '针对 ssrCloud 节点命名的策略模板。', url: sleepy('customized/ssrcloud') },
    ],
  },
  {
    label: '特殊用途 · SleepyHeeead',
    source: 'SleepyHeeead/subconverter-config',
    sourceUrl: 'https://github.com/SleepyHeeead/subconverter-config/tree/master/remote-config/special',
    items: [
      { id: 'sleepy-netease', name: 'NeteaseUnblock 规则', description: '网易云音乐相关规则和策略组。', url: sleepy('special/netease') },
      { id: 'sleepy-basic', name: 'Basic 基础规则', description: '精简配置，仅包含 GEOIP CN 和最终匹配规则。', url: sleepy('special/basic') },
    ],
  },
]

export const policyPresetCount = policyPresetGroups.reduce((count, group) => count + group.items.length, 0)
export const defaultPolicyPresetId = 'acl-online-full-multimode'

export function findPolicyPreset(id: string): PolicyPreset | undefined {
  return policyPresetGroups.flatMap((group) => group.items).find((preset) => preset.id === id)
}

export function findPolicyPresetGroup(id: string): PolicyPresetGroup | undefined {
  return policyPresetGroups.find((group) => group.items.some((preset) => preset.id === id))
}
