import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { type AutoGroupSettings, type PolicyConfig, type PolicyGroup, type PolicyRule, type ProxyNode, type RuleSetItem } from './core/bridge'
import { DropdownSelect } from './components/DropdownSelect'
import { countryGroupDisplayName } from './core/countryFlags'
import { resolveRuleSetPurpose, ruleSetPurposeCategories } from './core/ruleSetPurposes'

type GeneratedGroup = { id: string; sourceId: string; name: string; provider: string; country: string | null; nodes: string[] }
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean>
type DynamicNodeRange = { id: string; label: string }
type VisualPointerDrag = { kind: 'all-nodes' | 'group-order' | 'group-member' | 'group-member-order'; id: string; label: string; groupId?: string; referenceName?: string; referenceKind?: string; generatedGroupId?: string; pointerId: number; startX: number; startY: number; active: boolean }

const dynamicNodeRangePrefix = '__clash_flow_manager_dynamic_node_range_v1__:'
const legacyAutoGroupSeparators = [' · ', ' — ', ' / ', '_', ' ']

function resolveLegacyAutoGroupReference(name: string, groups: GeneratedGroup[]) {
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  const matches = groups.filter((group) => {
    const routeLabels = group.country === null
      ? ['📦 全部节点']
      : ['🌎 ' + group.country, '🌍 ' + group.country, '🌏 ' + group.country, countryGroupDisplayName(group.country)]
    const aliases = new Set(routeLabels)
    for (const routeLabel of routeLabels) {
      aliases.add(group.provider + ' · ' + routeLabel)
      aliases.add(routeLabel + ' · ' + group.provider)
      for (const separator of legacyAutoGroupSeparators) {
        aliases.add(group.provider + separator + routeLabel)
        aliases.add(routeLabel + separator + group.provider)
      }
    }
    return [...aliases].some((alias) => alias.trim().replace(/\s+/g, ' ') === normalizedName)
  })
  return matches.length === 1 ? matches[0] : undefined
}

function dynamicNodeRangeReference(id: string, label: string) {
  return dynamicNodeRangePrefix + JSON.stringify({ id, label })
}

function parseDynamicNodeRange(value: string): DynamicNodeRange | null {
  if (!value.startsWith(dynamicNodeRangePrefix)) return null
  try {
    const parsed = JSON.parse(value.slice(dynamicNodeRangePrefix.length)) as Partial<DynamicNodeRange>
    return typeof parsed.id === 'string' && typeof parsed.label === 'string' ? { id: parsed.id, label: parsed.label } : null
  } catch {
    return null
  }
}

type Props = {
  policy: PolicyConfig
  autoGroupsCollapsed: boolean
  onToggleAutoGroups: () => void
  topbarActionHost: HTMLDivElement | null
  dirty: boolean
  busy: boolean
  nodes: ProxyNode[]
  generatedGroups: GeneratedGroup[]
  ruleSets: RuleSetItem[]
  onChange: (policy: PolicyConfig) => void
  onSave: () => void
  onDiscard: () => void
  confirm: ConfirmAction
}

const groupKinds = [
  { value: 'select', label: '手动选择' },
  { value: 'url-test', label: '自动测速' },
  { value: 'fallback', label: '故障切换' },
  { value: 'load-balance', label: '负载均衡' },
]
const strategyGroupEmojiCategories = [
  { id: 'popular', label: '常用', emojis: ['⭐', '🌟', '✨', '🔥', '💎', '🚀', '⚡', '🎯', '💡', '✅', '❌', '❤️', '💙', '💚', '💜', '🧡', '🤍', '🖤', '💬', '📌', '🔔', '🔒', '🔑', '🛡️', '⚙️', '📦', '🧩', '🌐', '🌍', '🌏', '🤖', '🧠', '💼', '📚', '🎮', '🎬', '🎵', '☁️', '🌙', '☀️', '🍀', '🏆', '👑', '💯', '➕', '➖', '❓', '❗', '🔰', '🆕'] },
  { id: 'network', label: '代理网络', emojis: ['🌐', '🌍', '🌎', '🌏', '🕸️', '🔗', '⛓️', '🔀', '🔁', '🔄', '↔️', '↕️', '📡', '🛰️', '📶', '📳', '📴', '🔌', '🪫', '🔋', '🛜', '🛡️', '🔐', '🔒', '🔓', '🗝️', '🧱', '🚧', '🚦', '🧭', '🗺️', '📍', '🧰', '⚙️', '🛠️', '⚡', '💨', '🌪️', '🔥', '🚀', '🛫', '🛬', '🪢', '🧲', '🖧', '💻', '🖥️', '📟', '📠', '🆔', '🆙', '🆗', '🆘', '🔝', '🔜'] },
  { id: 'regions', label: '地区国旗', emojis: ['🌍', '🌎', '🌏', '🏳️', '🏴', '🏁', '🚩', '🇺🇸', '🇨🇦', '🇲🇽', '🇧🇷', '🇦🇷', '🇬🇧', '🇮🇪', '🇫🇷', '🇩🇪', '🇮🇹', '🇪🇸', '🇵🇹', '🇳🇱', '🇧🇪', '🇨🇭', '🇦🇹', '🇸🇪', '🇳🇴', '🇩🇰', '🇫🇮', '🇵🇱', '🇺🇦', '🇷🇺', '🇹🇷', '🇮🇱', '🇸🇦', '🇦🇪', '🇮🇳', '🇵🇰', '🇹🇭', '🇻🇳', '🇲🇾', '🇸🇬', '🇮🇩', '🇵🇭', '🇯🇵', '🇰🇷', '🇨🇳', '🇭🇰', '🇹🇼', '🇲🇴', '🇦🇺', '🇳🇿', '🇿🇦', '🇪🇬', '🇨🇱', '🇨🇴', '🇵🇪', '🇰🇪', '🇳🇬', '🇬🇷', '🇨🇿', '🇭🇺', '🇷🇴', '🇧🇬', '🇭🇷', '🇮🇸', '🇱🇺', '🇱🇮', '🇲🇨', '🇲🇹', '🇨🇾', '🇪🇺', '🇺🇳'] },
  { id: 'ai-tech', label: 'AI 科技', emojis: ['🤖', '🧠', '👾', '👽', '🛸', '🪄', '✨', '🔮', '💬', '🗨️', '🗯️', '💭', '🧬', '🔬', '🔭', '🧪', '⚗️', '🧫', '🦾', '🦿', '⚙️', '🛠️', '🔧', '🔩', '🪛', '🧰', '🧲', '💻', '🖥️', '🖱️', '🖨️', '⌨️', '🖲️', '💾', '💿', '📀', '📱', '📲', '☎️', '📞', '📟', '📡', '🛰️', '🔋', '🔌', '🛜', '📶', '🧩', '📦', '🗃️', '🗂️', '🗄️', '📊', '📈', '📉', '🧮', '🪫', '🪙'] },
  { id: 'office', label: '办公学习', emojis: ['💼', '🗂️', '📂', '📁', '📄', '📃', '📑', '🧾', '📋', '📌', '📍', '🖇️', '📎', '✂️', '🗒️', '📝', '✏️', '✒️', '🖊️', '🖋️', '🖌️', '🖍️', '📐', '📏', '🧮', '📚', '📖', '📕', '📗', '📘', '📙', '📓', '📔', '📒', '🔖', '🏷️', '📦', '🗳️', '🗞️', '📰', '📮', '📬', '📭', '📫', '📤', '📥', '📨', '📩', '✉️', '💌', '📧', '🗓️', '📆', '📅', '⏰', '⏱️', '⏲️', '⌛', '⏳', '🎓', '🏫', '🧑‍🏫', '🧑‍🎓', '🧑‍💻', '🧑‍🔬', '🧑‍🔧', '🧑‍💼', '🧑‍⚖️', '🧑‍🚀'] },
  { id: 'finance', label: '财务支付', emojis: ['💰', '💴', '💵', '💶', '💷', '💸', '💳', '🧾', '🪙', '💹', '📈', '📉', '💱', '🏦', '🏧', '🪪', '🧮', '🔐', '🔒', '🔑', '🛡️', '💎', '🏆', '🎁', '🛍️', '🛒', '🧺', '📦', '🚚', '📊', '📋', '📑', '🗃️', '🧰', '✅', '❎', '⭕', '➕', '➖', '🟰', '🔔', '📅', '⏳', '🧮', '🎟️', '🎫', '💲', '💹', '🏷️', '🧾'] },
  { id: 'social', label: '社交通讯', emojis: ['💬', '🗨️', '🗯️', '💭', '🗣️', '👥', '👤', '🫂', '🤝', '👋', '🖐️', '✋', '🤚', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👏', '🙌', '👐', '🤲', '🙏', '💌', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '💔', '❤️‍🔥', '❤️‍🩹', '💘', '💋', '📱', '📲', '☎️', '📞', '📟', '📧', '✉️', '📨', '📩', '📮', '🔔', '🔕'] },
  { id: 'media', label: '影音媒体', emojis: ['🎬', '🎥', '📽️', '🎞️', '📹', '📼', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '🎤', '🎧', '🎼', '🎵', '🎶', '🎹', '🥁', '🪘', '🪇', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🪈', '📀', '💿', '🔊', '🔉', '🔈', '🔇', '🔔', '🎨', '🖼️', '🖌️', '🖍️', '🖊️', '✏️', '📷', '📸', '📹', '🪞', '🪄', '🌟', '✨', '🎭', '🎟️', '🎫', '📰', '📖', '📚', '💡'] },
  { id: 'games', label: '游戏运动', emojis: ['🎮', '🕹️', '🎲', '🧩', '♟️', '🎯', '🎳', '🎰', '🃏', '🀄', '🎴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '⚽', '⚾', '🥎', '🏀', '🏐', '🏈', '🏉', '🎾', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '⛸️', '🥌', '🛷', '🏂', '⛷️', '🎿', '🤺', '🏋️', '🤸', '🤼', '🤽', '🤾', '🧗', '🚴', '🚵'] },
  { id: 'travel', label: '旅行交通', emojis: ['🌍', '🌎', '🌏', '🗺️', '🧭', '🧳', '🎒', '🛂', '🛃', '🛄', '🛅', '🛫', '🛬', '🛩️', '✈️', '🛸', '🚀', '🛰️', '🚁', '🚟', '🚠', '🚡', '🚃', '🚄', '🚅', '🚆', '🚇', '🚈', '🚉', '🚊', '🚝', '🚞', '🚋', '🚍', '🚌', '🚎', '🚐', '🚑', '🚒', '🚓', '🚔', '🚕', '🚖', '🚗', '🚘', '🚙', '🛻', '🚚', '🚛', '🚜', '🏎️', '🏍️', '🛵', '🛺', '🚲', '🛴', '🛹', '🛼', '⛽', '🚧', '🚦', '🚥', '🛑', '🚏', '🛣️', '🛤️', '🛞', '⚓', '⛵', '🛶', '🚤', '🛥️', '🛳️', '🚢', '🏝️', '🏖️', '🏕️', '🏜️', '🏔️', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠'] },
  { id: 'weather', label: '天气自然', emojis: ['🌞', '🌝', '🌛', '🌜', '🌚', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒', '🌓', '🌔', '🌙', '🌟', '🌠', '☀️', '🌤️', '⛅', '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️', '🌫️', '🌈', '☔', '🌂', '☂️', '⚡', '🔥', '💧', '💦', '🌊', '🫧', '🌱', '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🍄', '🌷', '🌹', '🥀', '🌺', '🌸', '🌼', '🌻', '🌞', '🪷', '🪻', '🌱', '🪹', '🪺', '🪸', '🪨', '🌋', '🏞️', '🏜️', '🏝️', '🏔️'] },
  { id: 'animals', label: '动物', emojis: ['🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🫎', '🫏', '🦄', '🦓', '🦌', '🦬', '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪', '🐫', '🦙', '🦒', '🐘', '🦣', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇', '🐿️', '🦫', '🦔', '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡', '🐾', '🦃', '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐧', '🕊️', '🦅', '🦆', '🦢', '🦉', '🦩', '🦚', '🦜', '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉', '🦕', '🦖', '🐳', '🐋', '🐬', '🦭', '🐟', '🐠', '🐡', '🦈', '🐙', '🪼', '🦀', '🦞', '🦐', '🦑', '🪸', '🐌', '🦋', '🐛', '🐜', '🐝', '🪲', '🐞', '🦗', '🪳', '🕷️', '🕸️', '🦂', '🦟', '🪰', '🪱', '🦠'] },
  { id: 'food', label: '食物饮料', emojis: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍋‍🟩', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🫚', '🫛', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '☕', '🫖', '🍵', '🧃', '🥤', '🧋', '🧉', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧊', '🥢', '🍽️', '🍴', '🥄', '🔪', '🫙'] },
  { id: 'activities', label: '活动爱好', emojis: ['🎨', '🖼️', '🎭', '🎪', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🪇', '🪘', '🎬', '🎟️', '🎫', '🎖️', '🏆', '🏅', '🥇', '🥈', '🥉', '🎗️', '🎁', '🎀', '🎊', '🎉', '🎈', '🪅', '🪩', '🪄', '🧸', '🪆', '🖌️', '🖍️', '🪡', '🧵', '🧶', '🪢', '🧩', '♟️', '🎲', '🃏', '🀄', '🎴', '🪅', '🎯', '🎳', '🎰', '🪁', '🪀', '🛝', '🛹', '🛼', '⛸️', '🛷', '🎿', '⛷️', '🏂', '🏋️', '🤸', '🤼', '🤾', '🤽', '🤺', '🧘', '🧗', '🚴', '🏇', '🏄', '🏊', '🤿', '🧑‍🍳', '🧑‍🎨', '🧑‍🚀'] },
  { id: 'objects', label: '生活物品', emojis: ['⌚', '📱', '📲', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '🖲️', '🕹️', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🔍', '🔎', '🕯️', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰', '🗞️', '📑', '🔖', '🏷️', '💰', '💳', '🪙', '🧾', '🛍️', '🎒', '🧳', '👓', '🕶️', '🥽', '🥼', '🦺', '👔', '👕', '👖', '🧥', '🧣', '🧤', '🧦', '👗', '👘', '🥻', '🩱', '🩳', '👙', '👚', '👛', '👜', '👝', '🛏️', '🛋️', '🪑', '🚪', '🪟', '🪞', '🛁', '🚿', '🧴', '🧹', '🧺', '🧻', '🧼', '🪥', '🧽', '🪣', '🧯', '🛒', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🗜️', '⚖️', '🦯', '🧲', '🪜', '🧪'] },
  { id: 'symbols', label: '状态符号', emojis: ['✅', '☑️', '✔️', '❌', '❎', '✖️', '➕', '➖', '➗', '🟰', '♾️', '‼️', '⁉️', '❓', '❔', '❕', '❗', '💯', '🔅', '🔆', '⚠️', '🚫', '⛔', '🛑', '🚧', '🔰', '♻️', '💱', '〽️', '⚕️', '♿', '🚻', '🚹', '🚺', '🚼', '🚾', '🛂', '🛃', '🛄', '🛅', '🆘', '🆔', '🆕', '🆓', '🆙', '🆒', '🆗', '🆖', '🆚', '🈁', '🈯', '🈳', '🈵', '🈶', '🈚', '🈸', '🈺', '🈷️', '🈴', '㊗️', '㊙️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜', '◾', '◽', '▪️', '▫️', '🔶', '🔷', '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔳', '🔲', '⭐', '🌟', '💫', '✨', '🔥', '💥', '💦', '💨', '🕳️'] },
] as const
const availableStrategyGroupEmojiCategories = strategyGroupEmojiCategories.map((category) => ({
  ...category,
  emojis: [...new Set(category.emojis)],
}))
const strategyGroupEmojiCount = new Set(availableStrategyGroupEmojiCategories.flatMap((category) => category.emojis)).size
const emojiGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const builtinRouteReferences = [
  { id: 'builtin:DIRECT', name: 'DIRECT', displayName: 'DIRECT（直连）', kind: '内置出站', detail: '直接连接，不经过代理' },
  { id: 'builtin:REJECT', name: 'REJECT', displayName: 'REJECT（拦截）', kind: '内置出站', detail: '拦截流量并返回拒绝' },
  { id: 'builtin:REJECT-DROP', name: 'REJECT-DROP', displayName: 'REJECT-DROP（静默拦截）', kind: '内置出站', detail: '静默丢弃请求，不返回拒绝响应' },
  { id: 'builtin:PASS', name: 'PASS', displayName: 'PASS（跳过规则分支）', kind: '内置出站', detail: '跳过当前命中的规则分支，继续匹配后续规则' },
  { id: 'builtin:PASS-RULE', name: 'PASS-RULE', displayName: 'PASS-RULE（跳过当前规则）', kind: '内置出站', detail: '在子规则中跳过当前规则，继续检查后续子规则' },
]
const ruleKinds = [
  { value: 'DOMAIN-SUFFIX', label: '网站及子域名', placeholder: '例如：openai.com', hint: '匹配 openai.com 及其所有子域名，例如 api.openai.com。' },
  { value: 'DOMAIN', label: '单个域名', placeholder: '例如：api.openai.com', hint: '只匹配填写的完整域名，不会匹配它的子域名。' },
  { value: 'DOMAIN-KEYWORD', label: '域名关键词', placeholder: '例如：openai', hint: '域名中包含该关键词就会命中，例如 openai 可匹配 api.openai.com。' },
  { value: 'IP-CIDR', label: 'IPv4 网段', placeholder: '例如：192.168.1.0/24', hint: '填写 IPv4 网段和 CIDR 前缀长度，例如 192.168.1.0/24。' },
  { value: 'IP-CIDR6', label: 'IPv6 网段', placeholder: '例如：2001:db8::/32', hint: '填写 IPv6 网段和 CIDR 前缀长度，例如 2001:db8::/32。' },
  { value: 'PROCESS-NAME', label: '应用进程名', placeholder: '例如：chrome.exe', hint: '填写应用的可执行文件名，通常包含 .exe 扩展名。' },
  { value: 'PROCESS-PATH', label: '应用程序路径', placeholder: '例如：C:\\Program Files\\Example\\app.exe', hint: '填写应用可执行文件的完整 Windows 路径。' },
]

function composeStrategyGroupName(emoji: string, name: string) {
  const trimmedEmoji = emoji.trim()
  const trimmedName = name.trim()
  return trimmedEmoji && trimmedName ? `${trimmedEmoji} ${trimmedName}` : trimmedName
}

function isEmojiGrapheme(value: string) {
  return /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(value) || value.includes('\u20e3')
}

function normalizeStrategyGroupEmoji(value: string) {
  for (const { segment } of emojiGraphemeSegmenter.segment(value)) {
    if (isEmojiGrapheme(segment)) return segment
  }
  return ''
}

function splitStrategyGroupName(value: string) {
  const trimmed = value.trimStart()
  const first = emojiGraphemeSegmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? ''
  const isEmoji = isEmojiGrapheme(first)
  const remainder = trimmed.slice(first.length)
  return isEmoji && /^\s+/.test(remainder)
    ? { emoji: first, name: remainder.trimStart() }
    : { emoji: '', name: value }
}

type EmojiPickerPosition = { top: number; left: number; maxHeight: number }

function StrategyGroupEmojiPicker(props: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [categoryId, setCategoryId] = useState<string>(strategyGroupEmojiCategories[0].id)
  const [position, setPosition] = useState<EmojiPickerPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const activeCategory = availableStrategyGroupEmojiCategories.find((category) => category.id === categoryId) ?? availableStrategyGroupEmojiCategories[0]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const updatePosition = () => {
      const trigger = triggerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) return
      const anchor = trigger.getBoundingClientRect()
      const naturalHeight = popover.getBoundingClientRect().height
      const margin = 12
      const gap = 8
      const viewportMaxHeight = Math.max(140, window.innerHeight - margin * 2)
      const availableBelow = Math.max(0, window.innerHeight - anchor.bottom - gap - margin)
      const availableAbove = Math.max(0, anchor.top - gap - margin)
      const openAbove = naturalHeight > availableBelow && availableAbove > availableBelow
      const availableHeight = openAbove ? availableAbove : availableBelow
      const maxHeight = Math.max(140, Math.min(560, viewportMaxHeight, availableHeight))
      const visibleHeight = Math.min(naturalHeight, maxHeight)
      const panelWidth = Math.min(popover.getBoundingClientRect().width, window.innerWidth - margin * 2)
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - panelWidth))
      const top = openAbove
        ? anchor.top - gap - visibleHeight
        : Math.min(anchor.bottom + gap, window.innerHeight - margin - visibleHeight)
      setPosition({ top, left, maxHeight })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, categoryId])

  return <div className="policy-visual-group-emoji-picker" ref={rootRef}>
    <div className="policy-visual-group-emoji-control">
      <input aria-label="策略组 Emoji（最多一个）" title="可直接输入或粘贴一个 Emoji" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(normalizeStrategyGroupEmoji(event.target.value))} placeholder="😀" />
      <button ref={triggerRef} type="button" aria-label="按类别选择 Emoji" aria-expanded={open} aria-haspopup="dialog" title="按类别选择 Emoji" disabled={props.disabled} onClick={() => setOpen((current) => !current)}><span className="policy-visual-group-emoji-arrow" aria-hidden="true" /></button>
    </div>
    {open && createPortal(<div ref={popoverRef} className="policy-visual-group-emoji-popover" role="dialog" aria-label="选择策略组 Emoji" style={{ top: position?.top ?? 0, left: position?.left ?? 0, maxHeight: position?.maxHeight, visibility: position ? 'visible' : 'hidden' }}>
      <div className="policy-visual-group-emoji-summary"><strong>共 {strategyGroupEmojiCount} 款常用 Emoji</strong><span>{activeCategory.label} · {activeCategory.emojis.length} 款</span></div>
      <div className="policy-visual-group-emoji-categories" role="tablist" aria-label="Emoji 分类">
        {availableStrategyGroupEmojiCategories.map((category) => <button key={category.id} type="button" role="tab" aria-selected={categoryId === category.id} className={categoryId === category.id ? 'active' : ''} onClick={() => setCategoryId(category.id)}><span>{category.label}</span><small>{category.emojis.length}</small></button>)}
      </div>
      <div className="policy-visual-group-emoji-grid" role="group" aria-label={activeCategory.label}>
        {activeCategory.emojis.map((emoji) => <button key={emoji} type="button" aria-label={emoji} aria-pressed={props.value === emoji} className={props.value === emoji ? 'selected' : ''} onClick={() => { props.onChange(emoji); setOpen(false) }}>{emoji}</button>)}
      </div>
      <footer><small>可输入或粘贴一个 Emoji</small><button type="button" disabled={!props.value} onClick={() => { props.onChange(''); setOpen(false) }}>清除</button></footer>
    </div>, document.body)}
  </div>
}
function ruleKindLabel(kind: string) {
  const normalizedKind = kind.trim().toUpperCase()
  return ruleKinds.find((item) => item.value === normalizedKind)?.label ?? kind
}
const healthUrl = 'https://www.gstatic.com/generate_204'
const healthUrls = [
  { value: healthUrl, label: 'Google 测速（204）· gstatic.com' },
  { value: 'https://cp.cloudflare.com/generate_204', label: 'Cloudflare 测速（204）· cloudflare.com' },
]
const healthIntervals = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 180, label: '3 分钟' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
  { value: 1800, label: '30 分钟' },
  { value: 3600, label: '1 小时' },
]
const ruleSetCategories = [
  { value: 'all', label: '全部用途' },
  ...ruleSetPurposeCategories.map((category) => ({ value: category, label: category })),
]
const ruleSetSourceFilters = [
  { value: 'all', label: '全部来源' },
  { value: 'blackmatrix7', label: 'blackmatrix7' },
  { value: 'acl4ssr', label: 'ACL4SSR' },
  { value: 'metacubex', label: 'MetaCubeX' },
  { value: 'loyalsoldier', label: 'Loyalsoldier' },
  { value: 'sukka', label: 'Sukka' },
] as const
type RuleSetSourceFilter = (typeof ruleSetSourceFilters)[number]['value']
type CommunityRuleSetSource = Exclude<RuleSetSourceFilter, 'all'>
const ruleSetSourceByProject: Record<string, CommunityRuleSetSource> = {
  'blackmatrix7/ios_rule_script': 'blackmatrix7',
  'acl4ssr/acl4ssr': 'acl4ssr',
  'metacubex/meta-rules-dat': 'metacubex',
  'loyalsoldier/clash-rules': 'loyalsoldier',
}
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function ruleSetCatalogSource(item: RuleSetItem): CommunityRuleSetSource | null {
  const url = String(item.provider.url ?? '').trim()
  if (!url) return null
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLocaleLowerCase()
    if (host === 'ruleset.skk.moe' || host.endsWith('.ruleset.skk.moe')) return 'sukka'
    const [owner = '', repository = ''] = parsed.pathname.split('/').filter(Boolean).map((part) => part.toLocaleLowerCase())
    const project = `${owner}/${repository}`
    return ruleSetSourceByProject[project] ?? null
  } catch {
    return null
  }
}

function orderedNodes(nodes: ProxyNode[]) {
  return [...nodes].sort((a, b) => collator.compare(a.country, b.country)
    || collator.compare(a.sourceName, b.sourceName)
    || collator.compare(a.displayName, b.displayName)
    || a.id.localeCompare(b.id))
}

function blankGroup(name: string): PolicyGroup {
  return {
    id: crypto.randomUUID(), name, kind: 'select', allNodes: false,
    sourceIds: [], countries: [], nodeIds: [], includeNodeIds: [], excludeNodeIds: [],
    groupNames: [], filter: '', url: '', interval: 300, options: {},
  }
}

function isRuleSet(rule: PolicyRule) {
  return rule.kind.trim().toUpperCase() === 'RULE-SET'
}

function policyWithSelectedRuleSets(policy: PolicyConfig, groupId: string, selectedIds: string[], ruleSets: RuleSetItem[]) {
  const group = policy.groups.find((item) => item.id === groupId)
  if (!group) return policy
  const itemsById = new Map(ruleSets.map((item) => [item.id, item]))
  const currentRules = policy.rules.filter((rule) => rule.target === group.name && isRuleSet(rule) && rule.kind.trim().toUpperCase() !== 'MATCH')
  const currentRulesById = new Map(currentRules.map((rule) => [rule.value, rule]))
  const desiredRules = selectedIds.flatMap((id) => {
    const item = itemsById.get(id)
    if (item) return [{ kind: 'RULE-SET', value: item.id, target: group.name }]
    const unavailableExistingRule = currentRulesById.get(id)
    return unavailableExistingRule ? [unavailableExistingRule] : []
  })
  const providers = Object.fromEntries(selectedIds.flatMap((id) => {
    const item = itemsById.get(id)
    return item ? [[item.id, item.provider]] : []
  }))
  const hasExistingRuleSets = currentRules.length > 0
  const rules: PolicyRule[] = []
  let inserted = false
  for (const rule of policy.rules) {
    const currentGroupRuleSet = rule.target === group.name && isRuleSet(rule) && rule.kind.trim().toUpperCase() !== 'MATCH'
    if (currentGroupRuleSet) {
      if (!inserted) {
        rules.push(...desiredRules)
        inserted = true
      }
      continue
    }
    if (!inserted && !hasExistingRuleSets && rule.target === group.name && rule.kind.trim().toUpperCase() !== 'MATCH') {
      rules.push(...desiredRules)
      inserted = true
    }
    if (!inserted && rule.kind.trim().toUpperCase() === 'MATCH') {
      rules.push(...desiredRules)
      inserted = true
    }
    rules.push(rule)
  }
  if (!inserted) rules.push(...desiredRules)
  return { ...policy, rules, ruleProviders: { ...policy.ruleProviders, ...providers } }
}

function ruleSetPurpose(item: RuleSetItem) {
  return resolveRuleSetPurpose(item.category, item.name, item.description, String(item.provider.url ?? ''))
}

function normalizeRuleSetEntry(entry: string) {
  return entry.split(/\s+/).filter(Boolean).join(' ').toLocaleLowerCase()
}

function ruleSetSearchContent(item: RuleSetItem) {
  const provider = item.provider
  if (provider.type === 'http') {
    const remoteEntries = Array.isArray(item.remoteEntries) ? item.remoteEntries : []
    const localAdditions = Array.isArray(item.localAdditions) ? item.localAdditions : []
    const excluded = new Set((item.excludedEntries ?? []).map(normalizeRuleSetEntry))
    const seen = new Set<string>()
    const entries = [...remoteEntries.filter((entry) => !excluded.has(normalizeRuleSetEntry(entry))), ...localAdditions]
      .filter((entry) => {
        const normalized = normalizeRuleSetEntry(entry)
        if (seen.has(normalized)) return false
        seen.add(normalized)
        return true
      })
    const isMrs = provider.format === 'mrs'
    const complete = !isMrs && (remoteEntries.length > 0 || (item.entryCount === 0 && Boolean(item.syncedAt)))
    return { entries: isMrs ? localAdditions : entries, complete }
  }

  const payload = provider.payload
  return {
    entries: Array.isArray(payload) ? payload.filter((entry): entry is string => typeof entry === 'string') : [],
    complete: Array.isArray(payload),
  }
}

function highlightRuleMatch(entry: string, query: string) {
  const index = entry.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0 || !query) return entry
  return <>{entry.slice(0, index)}<mark>{entry.slice(index, index + query.length)}</mark>{entry.slice(index + query.length)}</>
}

function ruleSetSource(item: RuleSetItem) {
  const url = String(item.provider.url ?? '')
  if (!url) return '本地规则集'
  try { return new URL(url).hostname } catch { return url }
}

function ruleSetPublisher(item: RuleSetItem) {
  const url = String(item.provider.url ?? '').trim()
  if (!url) return '本地自建'
  try {
    const parsed = new URL(url)
    const owner = parsed.pathname.split('/').filter(Boolean)[0]
    const host = parsed.hostname.toLowerCase()
    if (host === 'ruleset.skk.moe' || host.endsWith('.ruleset.skk.moe')) return 'Sukka'
    if (host === 'github.com' || host === 'raw.githubusercontent.com' || host.endsWith('.githubusercontent.com')) return owner ? `GitHub · ${owner}` : 'GitHub'
    if (host === 'gitee.com' || host.endsWith('.gitee.com')) return owner ? `Gitee · ${owner}` : 'Gitee'
    if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) return owner ? `GitLab · ${owner}` : 'GitLab'
    return `自定义 · ${parsed.hostname}`
  } catch {
    return `自定义 · ${url}`
  }
}

type RuleSetDetailsTab = 'remote' | 'additions' | 'excluded'

export type RuleSetDetailsDialogProps = {
  item: RuleSetItem
  onClose: () => void
  loading?: boolean
  error?: string
}

export function RuleSetDetailsDialog(props: RuleSetDetailsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [activeTab, setActiveTab] = useState<RuleSetDetailsTab>('remote')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const isMrs = String(props.item.provider.format ?? '').toLowerCase() === 'mrs'
    || Boolean(props.item.mrsHash && props.item.entryCount === null)
  const tabs = useMemo(() => [
    { value: 'remote' as const, label: '远端规则', entries: props.item.remoteEntries ?? [] },
    { value: 'additions' as const, label: '本地追加', entries: props.item.localAdditions ?? [] },
    { value: 'excluded' as const, label: '本地屏蔽', entries: props.item.excludedEntries ?? [] },
  ], [props.item])
  const active = tabs.find((tab) => tab.value === activeTab) ?? tabs[0]
  const showsSamples = activeTab === 'remote' && active.entries.length === 0 && props.item.sample.length > 0
  const entries = active.entries.length || !showsSamples ? active.entries : props.item.sample
  const query = search.trim().toLocaleLowerCase()
  const filteredEntries = query ? entries.filter((entry) => entry.toLocaleLowerCase().includes(query)) : entries
  const pageSize = 50
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageEntries = filteredEntries.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  return <dialog
    ref={dialogRef}
    className="policy-visual-rule-details-backdrop"
    aria-labelledby="policy-visual-rule-details-title"
    onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }}
    onCancel={(event) => { event.preventDefault(); props.onClose() }}
  >
    <section className="policy-visual-rule-details-dialog" role="document">
      <header><div><span className="eyebrow">RULE SET DETAILS</span><strong id="policy-visual-rule-details-title">{props.item.name}</strong><small>{ruleSetPurpose(props.item)} · {props.loading ? '正在读取远端规则' : props.item.entryCount === null && isMrs ? 'MRS 二进制规则' : `${props.item.entryCount ?? props.item.remoteEntries.length} 条远端规则`}</small></div><button className="button secondary small" type="button" onClick={props.onClose}>关闭</button></header>
      <div className="policy-visual-rule-details-body">
        <section className="policy-visual-rule-details-description"><strong>用途说明</strong><p>{props.item.description?.trim() || '暂无用途说明。'}</p></section>
        <section className="policy-visual-rule-details-source"><strong>来源主体 · {ruleSetPublisher(props.item)}</strong><code>{String(props.item.provider.url ?? '本地自建规则集')}</code></section>
        <section className="policy-visual-rule-browser" aria-label="规则明细">
          <header><div><strong>规则明细</strong><span>{active.label} · {filteredEntries.length}{search ? ` / ${entries.length}` : ''} 条</span></div>{showsSamples && <small>当前只有缓存样例，并非完整规则内容</small>}</header>
          <div className="policy-visual-rule-detail-tabs" role="tablist" aria-label="规则来源">
            {tabs.map((tab) => <button key={tab.value} type="button" role="tab" aria-selected={activeTab === tab.value} className={activeTab === tab.value ? 'active' : ''} onClick={() => { setActiveTab(tab.value); setPage(0); setSearch('') }}><span>{tab.label}</span><b>{tab.value === 'remote' && isMrs ? 'MRS' : tab.entries.length}</b></button>)}
          </div>
          <div className="policy-visual-rule-details-toolbar"><input type="search" aria-label={`搜索${active.label}`} placeholder={`筛选${active.label}`} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} /><span>每页 50 条</span></div>
          {props.loading ? <div className="policy-visual-rule-details-empty" aria-live="polite">正在读取远端规则明细…</div>
            : props.error ? <div className="policy-visual-rule-details-empty" role="alert">读取规则明细失败：{props.error}</div>
              : pageEntries.length ? <ol className="policy-visual-rule-details-list" start={currentPage * pageSize + 1}>{pageEntries.map((entry, index) => <li key={`${activeTab}-${index}-${entry}`}><code>{entry}</code></li>)}</ol>
                : <div className="policy-visual-rule-details-empty">{activeTab === 'remote' && isMrs ? 'MRS 是二进制规则集，当前不支持逐条显示。' : search ? '没有匹配的规则。' : showsSamples ? '没有可显示的规则样例。' : activeTab === 'remote' ? '还没有保存完整的远端规则，请先从规则集库同步。' : activeTab === 'additions' ? '暂无本地追加规则。' : '暂无本地屏蔽规则。'}</div>}
          <footer className="policy-visual-rule-details-pagination"><span>{filteredEntries.length ? `第 ${currentPage + 1} / ${pageCount} 页 · ${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, filteredEntries.length)} 条` : '0 条规则'}</span><div><button className="button secondary small" type="button" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><button className="button secondary small" type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>下一页</button></div></footer>
        </section>
      </div>
      <footer><button className="button primary" type="button" onClick={props.onClose}>关闭详情</button></footer>
    </section>
  </dialog>
}

function ruleSummary(rule: PolicyRule, ruleSets: RuleSetItem[]) {
  if (!isRuleSet(rule)) return rule.value || '所有剩余流量'
  return ruleSets.find((item) => item.id === rule.value)?.name ?? rule.value
}

function policyTargetLabel(target: string) {
  if (target === 'DIRECT') return 'DIRECT（直连）'
  if (target === 'REJECT') return 'REJECT（拦截）'
  return target
}

function groupMatchesNode(group: PolicyGroup, node: ProxyNode) {
  if ((group.excludeNodeIds ?? []).includes(node.id)) return false
  if ((group.includeNodeIds ?? []).includes(node.id)) return true
  if (group.allNodes) return true
  const hasSource = group.sourceIds.length > 0
  const hasCountry = group.countries.length > 0
  const hasNode = group.nodeIds.length > 0
  return (hasSource || hasCountry || hasNode)
    && (!hasSource || group.sourceIds.includes(node.sourceId))
    && (!hasCountry || group.countries.includes(node.country))
    && (!hasNode || group.nodeIds.includes(node.id))
}

function groupDefaultSelected(group: PolicyGroup) {
  const value = group.options?.['default-selected']
  return typeof value === 'string' ? value : ''
}

function uniqueGroupName(name: string, groups: PolicyGroup[], currentId?: string, reservedNames: string[] = []) {
  const normalized = name.trim().toLocaleLowerCase()
  return normalized.length > 0
    && !groups.some((group) => group.id !== currentId && group.name.trim().toLocaleLowerCase() === normalized)
    && !reservedNames.some((reserved) => reserved.trim().toLocaleLowerCase() === normalized)
}

function manualRuleValueError(kind: string, value: string) {
  const normalizedKind = kind.trim().toUpperCase()
  const normalizedValue = value.trim()
  if (!normalizedValue) return '填写规则内容后再添加。'
  if (normalizedValue.includes(',') || /[\r\n]/.test(normalizedValue)) return '内容不能包含逗号或换行。'
  if (normalizedKind === 'DOMAIN' || normalizedKind === 'DOMAIN-SUFFIX') {
    try {
      const parsed = new URL(`http://${normalizedValue}`)
      const host = parsed.hostname.replace(/\.$/, '')
      const labels = host.split('.')
      const validHost = parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.port
        && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
        && labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
      if (!validHost || !labels.length) return '请输入有效的域名，例如：openai.com。'
    } catch {
      return '请输入有效的域名，例如：openai.com。'
    }
  }
  if (normalizedKind === 'IP-CIDR' || normalizedKind === 'IP-CIDR6') {
    const [address, prefix, ...extra] = normalizedValue.split('/')
    const maxPrefix = normalizedKind === 'IP-CIDR' ? 32 : 128
    if (extra.length || !/^\d+$/.test(prefix ?? '') || Number(prefix) > maxPrefix) return normalizedKind === 'IP-CIDR' ? '请输入有效的 IPv4 网段，例如：192.168.1.0/24。' : '请输入有效的 IPv6 网段，例如：2001:db8::/32。'
    if (normalizedKind === 'IP-CIDR') {
      const octets = address.split('.')
      if (octets.length !== 4 || octets.some((octet) => !/^(?:0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255)) return '请输入有效的 IPv4 网段，例如：192.168.1.0/24。'
    } else {
      if (!address.includes(':') || !/^[\da-f:.]+$/i.test(address)) return '请输入有效的 IPv6 网段，例如：2001:db8::/32。'
      try { new URL(`http://[${address}]/`) } catch { return '请输入有效的 IPv6 网段，例如：2001:db8::/32。' }
    }
  }
  return ''
}

function removeRuleAt(policy: PolicyConfig, index: number): PolicyConfig {
  return { ...policy, rules: policy.rules.filter((_, current) => current !== index) }
}

export function PolicyVisualWorkspace(props: Props) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [expandedAutoGroups, setExpandedAutoGroups] = useState<Set<string>>(() => new Set())
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupEmoji, setNewGroupEmoji] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [memberActionMessage, setMemberActionMessage] = useState('')
  const [candidateCategory, setCandidateCategory] = useState<'builtin' | 'strategy' | 'region'>('builtin')
  const [settingsGroupId, setSettingsGroupId] = useState('')
  const [autoGroupSettingsId, setAutoGroupSettingsId] = useState('')
  const [groupRulesPage, setGroupRulesPage] = useState<'single-rules' | 'rule-sets' | null>(null)
  const [ruleSetSourceFilter, setRuleSetSourceFilter] = useState<RuleSetSourceFilter>('all')
  const [ruleSetCategory, setRuleSetCategory] = useState<string>('all')
  const [ruleSetDetailsId, setRuleSetDetailsId] = useState('')
  const [selectedRuleSets, setSelectedRuleSets] = useState<Record<string, Set<string>>>({})
  const [ruleSetQuery, setRuleSetQuery] = useState('')
  const [groupRuleQuery, setGroupRuleQuery] = useState('')
  const [ruleInputs, setRuleInputs] = useState<Record<string, string>>({})
  const [batchRuleInputs, setBatchRuleInputs] = useState<Record<string, string>>({})
  const [batchRuleFeedback, setBatchRuleFeedback] = useState<Record<string, { summary: string; details: string[] }>>({})
  const [ruleEntryModes, setRuleEntryModes] = useState<Record<string, 'single' | 'batch'>>({})
  const [ruleKindsByGroup, setRuleKindsByGroup] = useState<Record<string, string>>({})
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({})
  const [draggingGroupId, setDraggingGroupId] = useState('')
  const [draggingCandidateId, setDraggingCandidateId] = useState('')
  const [dropTargetGroupId, setDropTargetGroupId] = useState('')
  const [draggingGroupMember, setDraggingGroupMember] = useState<{ groupId: string; name: string } | null>(null)
  const [dropTargetGroupMember, setDropTargetGroupMember] = useState<{ groupId: string; name: string } | null>(null)
  const [dragPreview, setDragPreview] = useState<{ kind: 'group' | 'region' | 'builtin' | 'scope' | 'range'; label: string; x: number; y: number } | null>(null)
  const [draggingAutoGroupAsRange, setDraggingAutoGroupAsRange] = useState(false)
  const pointerDragRef = useRef<VisualPointerDrag | null>(null)
  const [showAllMembers, setShowAllMembers] = useState<Set<string>>(() => new Set())
  const [expandedAllNodes, setExpandedAllNodes] = useState<Set<string>>(() => new Set())
  const [settingsGroupName, setSettingsGroupName] = useState('')
  const [settingsGroupEmoji, setSettingsGroupEmoji] = useState('')
  const [settingsNameError, setSettingsNameError] = useState('')

  useEffect(() => {
    const updateShiftDragMode = (event: KeyboardEvent) => {
      const drag = pointerDragRef.current
      if (!drag?.active || !drag.generatedGroupId) return
      const isRange = event.shiftKey
      setDraggingAutoGroupAsRange(isRange)
      setDragPreview((current) => current ? { ...current, kind: isRange ? 'range' : 'group' } : current)
    }
    window.addEventListener('keydown', updateShiftDragMode)
    window.addEventListener('keyup', updateShiftDragMode)
    return () => {
      window.removeEventListener('keydown', updateShiftDragMode)
      window.removeEventListener('keyup', updateShiftDragMode)
    }
  }, [])

  const availableNodes = useMemo(() => orderedNodes(props.nodes), [props.nodes])
  const availableGroupReferences = useMemo(() => {
    const references = new Map<string, { id: string; name: string; displayName: string; kind: string; detail: string; policyGroupId?: string; generatedGroupId?: string }>()
    for (const reference of builtinRouteReferences) if (!props.policy.groups.some((group) => group.name === reference.name)) {
      references.set(reference.name, reference)
    }
    for (const group of props.policy.groups) references.set(group.name, {
      id: `strategy:${group.id}`, name: group.name, displayName: group.name, kind: '策略组',
      detail: `${groupKinds.find((kind) => kind.value === group.kind)?.label ?? group.kind} · ${group.groupNames.length} 个成员`,
      policyGroupId: group.id,
    })
    for (const group of props.generatedGroups) if (!references.has(group.name)) {
      const settings = props.policy.autoGroupSettings?.[group.id]
      references.set(group.name, {
        id: `strategy:auto:${group.id}`, name: group.name, displayName: group.name, kind: '策略组',
        detail: `${groupKinds.find((kind) => kind.value === settings?.kind)?.label ?? '手动选择'} · ${group.provider} · ${group.nodes.length} 个节点`,
        generatedGroupId: group.id,
      })
    }
    return [...references.values()].sort((a, b) => collator.compare(a.kind, b.kind) || collator.compare(a.name, b.name))
  }, [props.policy.groups, props.policy.autoGroupSettings, props.generatedGroups])

  useEffect(() => {
    let changed = false
    const groups = props.policy.groups.map((group) => {
      const groupNames = [...new Set(group.groupNames.map((name) => resolveLegacyAutoGroupReference(name, props.generatedGroups)?.name ?? name))]
      const options = { ...group.options }
      const defaultSelected = typeof options['default-selected'] === 'string'
        ? resolveLegacyAutoGroupReference(options['default-selected'], props.generatedGroups)?.name
        : undefined
      if (defaultSelected && defaultSelected !== options['default-selected']) options['default-selected'] = defaultSelected
      const groupNamesChanged = groupNames.length !== group.groupNames.length || groupNames.some((name, index) => name !== group.groupNames[index])
      const defaultSelectedChanged = defaultSelected !== undefined && defaultSelected !== group.options['default-selected']
      if (!groupNamesChanged && !defaultSelectedChanged) return group
      changed = true
      return { ...group, groupNames, options }
    })
    if (changed) props.onChange({ ...props.policy, groups })
  }, [props.policy, props.generatedGroups, props.onChange])

  const orderedBuiltinReferences = builtinRouteReferences.flatMap((builtin) => {
    const reference = availableGroupReferences.find((candidate) => candidate.id === builtin.id)
    return reference ? [reference] : []
  })
  const strategyGroupReferences = availableGroupReferences.filter((reference) => reference.kind === '策略组')
  const customStrategyGroupReferences = strategyGroupReferences.filter((reference) => Boolean(reference.policyGroupId))
  const autoStrategyGroupReferences = strategyGroupReferences.filter((reference) => Boolean(reference.generatedGroupId))
  const generatedGroupNames = props.generatedGroups.map((group) => group.name)
  const groupNameAvailable = (name: string, currentId?: string) => uniqueGroupName(name, props.policy.groups, currentId, generatedGroupNames)
  const newGroupFullName = composeStrategyGroupName(newGroupEmoji, newGroupName)
  const settingsGroupFullName = composeStrategyGroupName(settingsGroupEmoji, settingsGroupName)
  const strategyGroupNameSet = new Set(strategyGroupReferences.map((reference) => reference.name))
  const candidateCategories = [
    { id: 'builtin', label: '内置项', count: orderedBuiltinReferences.length + 1 },
    { id: 'strategy', label: '策略组', count: customStrategyGroupReferences.length },
    { id: 'region', label: '自动地区线路', count: autoStrategyGroupReferences.length },
  ] as const
  const activeCandidateReferences = candidateCategory === 'builtin'
    ? orderedBuiltinReferences
    : candidateCategory === 'strategy' ? customStrategyGroupReferences : autoStrategyGroupReferences
  const autoCandidateGroups = props.generatedGroups.reduce<Array<{ sourceId: string; provider: string; references: typeof autoStrategyGroupReferences }>>((groups, generatedGroup) => {
    const reference = autoStrategyGroupReferences.find((item) => item.generatedGroupId === generatedGroup.id)
    if (!reference) return groups
    let sourceGroup = groups.find((item) => item.sourceId === generatedGroup.sourceId)
    if (!sourceGroup) {
      sourceGroup = { sourceId: generatedGroup.sourceId, provider: generatedGroup.provider, references: [] }
      groups.push(sourceGroup)
    }
    sourceGroup.references.push(reference)
    return groups
  }, [])
  const renderCandidateReference = (reference: (typeof activeCandidateReferences)[number]) => {
    const candidateName = reference.displayName ?? reference.name
    const toneClass = reference.id.startsWith('builtin:') ? ` tone-${reference.name.toLowerCase()}` : ''
    const candidateDetail = candidateCategory === 'region' && reference.generatedGroupId
      ? `${props.generatedGroups.find((group) => group.id === reference.generatedGroupId)?.nodes.length ?? 0} 个节点`
      : reference.detail
    return <div key={reference.id} role="listitem" className={'policy-visual-candidate' + toneClass + (reference.generatedGroupId ? ' with-settings' : '') + (draggingCandidateId === reference.id ? ' dragging' : '') + (props.busy ? ' disabled' : '')} title={reference.generatedGroupId ? `${candidateName} · ${candidateDetail}；普通拖动加入策略组，按住 Shift 拖动加入动态节点范围` : `${candidateName} · ${candidateDetail}`} onPointerDown={(event) => startVisualPointerDrag(event, 'group-member', reference.id, candidateName, reference.name, reference.kind, undefined, reference.generatedGroupId)} onPointerMove={moveVisualPointerDrag} onPointerUp={finishVisualPointerDrag} onPointerCancel={(event) => finishVisualPointerDrag(event, true)}>
      <span className="policy-visual-node-grip" aria-hidden="true">⠿</span><span className="policy-visual-candidate-copy"><strong>{candidateName}</strong><small>{candidateDetail}</small></span>
      {reference.generatedGroupId && <button className="policy-visual-candidate-settings" type="button" title="设置这条自动线路" aria-label={'设置 ' + candidateName} disabled={props.busy} onPointerDown={(event) => event.stopPropagation()} onClick={() => setAutoGroupSettingsId(reference.generatedGroupId!)}>⚙</button>}
    </div>
  }
  const settingsGroup = props.policy.groups.find((group) => group.id === settingsGroupId)
  const autoSettingsGroup = props.generatedGroups.find((group) => group.id === autoGroupSettingsId)
  const autoSettings = autoSettingsGroup
    ? props.policy.autoGroupSettings?.[autoSettingsGroup.id] ?? { kind: 'select', url: healthUrl, interval: 300 }
    : null
  const selectedRuleKind = ruleKinds.find((kind) => kind.value === (settingsGroup ? ruleKindsByGroup[settingsGroup.id] : '')) ?? ruleKinds[0]
  const ruleEntryMode = settingsGroup ? ruleEntryModes[settingsGroup.id] ?? 'single' : 'single'
  const batchRuleLineCount = settingsGroup ? (batchRuleInputs[settingsGroup.id] ?? '').split(/\r?\n/).filter((line) => line.trim()).length : 0
  const settingsGroupRules = settingsGroup
    ? props.policy.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.target === settingsGroup.name && rule.kind.trim().toUpperCase() !== 'MATCH')
    : []
  const settingsGroupSingleRules = settingsGroupRules.filter(({ rule }) => !isRuleSet(rule))
  const settingsGroupRuleSets = settingsGroupRules.filter(({ rule }) => isRuleSet(rule))
  const settingsGroupMembers = settingsGroup ? availableNodes.filter((node) => groupMatchesNode(settingsGroup, node)) : []
  const currentRuleSetIds = settingsGroupRuleSets.map(({ rule }) => rule.value)
  const desiredRuleSetIds = settingsGroup ? [...(selectedRuleSets[settingsGroup.id] ?? new Set<string>())] : []
  const normalizedRuleSetQuery = ruleSetQuery.trim().toLocaleLowerCase()
  const ruleSetSearchContents = useMemo(() => new Map(props.ruleSets.map((item) => [item.id, ruleSetSearchContent(item)])), [props.ruleSets])
  const ruleSetMatches = useMemo(() => new Map(props.ruleSets.map((item) => {
    const entries = ruleSetSearchContents.get(item.id)?.entries ?? []
    return [item.id, normalizedRuleSetQuery ? entries.filter((entry) => entry.toLocaleLowerCase().includes(normalizedRuleSetQuery)) : []] as const
  })), [props.ruleSets, ruleSetSearchContents, normalizedRuleSetQuery])
  const ruleSetTitleMatches = (item: RuleSetItem) => Boolean(normalizedRuleSetQuery && item.name.toLocaleLowerCase().includes(normalizedRuleSetQuery))
  const ruleSetQueryMatches = (item: RuleSetItem) => !normalizedRuleSetQuery
    || ruleSetTitleMatches(item)
    || (ruleSetMatches.get(item.id)?.length ?? 0) > 0
  const matchesRuleSetSource = (item: RuleSetItem) => ruleSetSourceFilter === 'all' || ruleSetCatalogSource(item) === ruleSetSourceFilter
  const visibleRuleSets = props.ruleSets.filter((item) => matchesRuleSetSource(item)
    && (ruleSetCategory === 'all' || ruleSetPurpose(item) === ruleSetCategory)
    && ruleSetQueryMatches(item))
  const categoryRuleSetCount = (category: string) => {
    const items = props.ruleSets.filter((item) => matchesRuleSetSource(item) && (category === 'all' || ruleSetPurpose(item) === category))
    return normalizedRuleSetQuery ? items.filter(ruleSetQueryMatches).length : items.length
  }
  const visibleMatchCount = visibleRuleSets.reduce((total, item) => total + (ruleSetMatches.get(item.id)?.length ?? 0), 0)
  const visibleIncompleteCount = props.ruleSets.filter((item) => matchesRuleSetSource(item)
    && (ruleSetCategory === 'all' || ruleSetPurpose(item) === ruleSetCategory)
    && !ruleSetSearchContents.get(item.id)?.complete).length
  const groupRuleQueryNormalized = groupRuleQuery.trim().toLocaleLowerCase()
  const currentGroupManualRuleMatches = groupRuleQueryNormalized
    ? settingsGroupSingleRules.filter(({ rule }) => rule.value.toLocaleLowerCase().includes(groupRuleQueryNormalized))
    : []
  const currentGroupRuleSetContents = settingsGroupRuleSets.map(({ rule }) => {
    const item = props.ruleSets.find((candidate) => candidate.id === rule.value)
    return item ? { item, ...ruleSetSearchContent(item) } : null
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  const currentGroupMissingRuleSetCount = settingsGroupRuleSets.length - currentGroupRuleSetContents.length
  const currentGroupIncompleteRuleSetCount = currentGroupRuleSetContents.filter((entry) => !entry.complete).length
  const currentGroupRuleSetMatches = currentGroupRuleSetContents.map((entry) => ({
    ...entry,
    matches: groupRuleQueryNormalized
      ? entry.entries.filter((line) => line.toLocaleLowerCase().includes(groupRuleQueryNormalized))
      : [],
  })).filter((entry) => entry.matches.length > 0)
  const currentGroupRuleSetMatchCount = currentGroupRuleSetMatches.reduce((total, entry) => total + entry.matches.length, 0)
  const desiredRuleSetIdSet = new Set(desiredRuleSetIds)
  const currentRuleSetIdSet = new Set(currentRuleSetIds)
  const addedRuleSetCount = desiredRuleSetIds.filter((id) => !currentRuleSetIdSet.has(id)).length
  const removedRuleSetCount = currentRuleSetIds.filter((id) => !desiredRuleSetIdSet.has(id)).length
  const ruleSetSelectionChanged = currentRuleSetIds.length !== desiredRuleSetIds.length
    || currentRuleSetIds.some((id, index) => id !== desiredRuleSetIds[index])
  const ruleSetDetails = props.ruleSets.find((item) => item.id === ruleSetDetailsId)
  const invalidNameIds = new Set(props.policy.groups.filter((group) => !groupNameAvailable(group.name, group.id)).map((group) => group.id))
  const matchRules = props.policy.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.kind.trim().toUpperCase() === 'MATCH')
  const nonMatchRules = props.policy.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.kind.trim().toUpperCase() !== 'MATCH')

  useEffect(() => {
    const ids = new Set(props.policy.groups.map((group) => group.id))
    setExpandedGroups((current) => new Set([...current].filter((id) => ids.has(id))))
  }, [props.policy.groups])

  useEffect(() => {
    const ids = new Set(props.policy.groups.filter((group) => group.allNodes).map((group) => group.id))
    setExpandedAllNodes((current) => new Set([...current].filter((id) => ids.has(id))))
  }, [props.policy.groups])

  useEffect(() => {
    const ids = new Set(props.generatedGroups.map((group) => group.id))
    setExpandedAutoGroups((current) => new Set([...current].filter((id) => ids.has(id))))
  }, [props.generatedGroups])

  useEffect(() => {
    if (!settingsGroupId && !autoGroupSettingsId) return
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (ruleSetDetailsId) setRuleSetDetailsId('')
        else if (groupRulesPage) setGroupRulesPage(null)
        else if (autoGroupSettingsId) setAutoGroupSettingsId('')
        else closeGroupSettings()
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = originalOverflow
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [settingsGroupId, settingsGroup, settingsGroupName, settingsGroupEmoji, groupRulesPage, ruleSetDetailsId, autoGroupSettingsId])

  function changePolicy(transform: (current: PolicyConfig) => PolicyConfig) {
    props.onChange(transform(props.policy))
  }

  function updateGroup(groupId: string, transform: (group: PolicyGroup) => PolicyGroup) {
    changePolicy((current) => ({ ...current, groups: current.groups.map((group) => group.id === groupId ? transform(group) : group) }))
  }

  function setGroupDefaultSelected(groupId: string, memberName: string) {
    updateGroup(groupId, (current) => {
      const options = { ...current.options }
      if (options['default-selected'] === memberName) delete options['default-selected']
      else options['default-selected'] = memberName
      return { ...current, options }
    })
  }

  function updateAutoGroupSettings(groupId: string, transform: (settings: AutoGroupSettings) => AutoGroupSettings) {
    changePolicy((current) => {
      const settings = current.autoGroupSettings?.[groupId] ?? { kind: 'select', url: healthUrl, interval: 300 }
      return {
        ...current,
        autoGroupSettings: {
          ...(current.autoGroupSettings ?? {}),
          [groupId]: transform(settings),
        },
      }
    })
  }

  function openNewGroup() {
    setNewGroupName('')
    setNewGroupEmoji('')
    setNewGroupOpen(true)
  }

  function openGroupSettings(group: PolicyGroup) {
    const nameParts = splitStrategyGroupName(group.name)
    setSettingsGroupEmoji(nameParts.emoji)
    setSettingsGroupName(nameParts.name)
    setSettingsNameError('')
    setGroupRulesPage(null)
    setRuleSetDetailsId('')
    setRuleSetQuery('')
    setGroupRuleQuery('')
    setSettingsGroupId(group.id)
  }

  function openGroupRules(page: 'single-rules' | 'rule-sets') {
    if (!settingsGroup || !saveSettingsGroupName()) return
    if (page === 'rule-sets') {
      setRuleSetCategory('all')
      setRuleSetQuery('')
      setSelectedRuleSets((current) => ({ ...current, [settingsGroup.id]: new Set(settingsGroupRuleSets.map(({ rule }) => rule.value)) }))
    }
    setGroupRulesPage(page)
  }

  function saveSettingsGroupName() {
    const name = settingsGroupFullName
    if (!settingsGroup || !groupNameAvailable(name, settingsGroup.id)) {
      setSettingsNameError('请输入不重复的策略组名称。')
      return false
    }
    if (name !== settingsGroup.name) renameGroup(settingsGroup.id, name)
    setSettingsNameError('')
    return true
  }

  function closeGroupSettings() {
    if (!saveSettingsGroupName()) {
      const original = splitStrategyGroupName(settingsGroup?.name ?? '')
      setSettingsGroupEmoji(original.emoji)
      setSettingsGroupName(original.name)
    }
    setSettingsNameError('')
    setRuleSetDetailsId('')
    setSettingsGroupId('')
  }

  function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newGroupFullName
    if (!groupNameAvailable(name)) return
    const group = blankGroup(name)
    changePolicy((current) => ({ ...current, groups: [...current.groups, group] }))
    setNewGroupOpen(false)
  }

  function renameGroup(groupId: string, name: string) {
    const prior = props.policy.groups.find((group) => group.id === groupId)
    if (!prior) return
    const oldName = prior.name
    changePolicy((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId
        ? { ...group, name }
        : { ...group, groupNames: group.groupNames.map((reference) => reference === oldName ? name : reference) }),
      rules: current.rules.map((rule) => rule.target === oldName ? { ...rule, target: name } : rule),
    }))
  }

  async function deleteGroup(group: PolicyGroup, shift: boolean) {
    const affectedRules = props.policy.rules.filter((rule) => rule.target === group.name).length
    const affectedGroups = props.policy.groups.filter((item) => item.id !== group.id && item.groupNames.includes(group.name)).length
    if (!shift && !await props.confirm(`删除「${group.name}」？\n同时会从 ${affectedGroups} 个其他策略组移除对它的线路引用，并删除 ${affectedRules} 条去向该组的分流规则。\n提示：下次可按住 Shift 点击删除按钮，跳过确认直接删除。`, { title: '删除策略组', confirmLabel: '删除策略组', destructive: true })) return
    changePolicy((current) => ({
      ...current,
      groups: current.groups.filter((item) => item.id !== group.id).map((item) => ({ ...item, groupNames: item.groupNames.filter((name) => name !== group.name) })),
      rules: current.rules.filter((rule) => rule.target !== group.name),
    }))
    setExpandedGroups((current) => { const next = new Set(current); next.delete(group.id); return next })
  }

  function reorderGroups(fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return
    changePolicy((current) => {
      const groups = [...current.groups]
      const from = groups.findIndex((group) => group.id === fromId)
      const to = groups.findIndex((group) => group.id === toId)
      if (from < 0 || to < 0) return current
      const [moved] = groups.splice(from, 1)
      groups.splice(to, 0, moved)
      return { ...current, groups }
    })
  }

  function reorderGroupMembers(groupId: string, fromName: string, toName: string) {
    if (!groupId || !fromName || !toName || fromName === toName) return
    updateGroup(groupId, (group) => {
      const groupNames = [...group.groupNames]
      const from = groupNames.indexOf(fromName)
      const to = groupNames.indexOf(toName)
      if (from < 0 || to < 0) return group
      const [moved] = groupNames.splice(from, 1)
      groupNames.splice(to, 0, moved)
      return { ...group, groupNames }
    })
  }

  function addAllNodesToGroup(groupId: string) {
    const target = props.policy.groups.find((group) => group.id === groupId)
    if (!target) return
    if (target.allNodes) {
      setMemberActionMessage(`「${target.name}」已自动包含全部可用节点。`)
      return
    }
    updateGroup(groupId, (group) => ({
      ...group,
      allNodes: true,
      sourceIds: [],
      countries: [],
      nodeIds: [],
      includeNodeIds: [],
    }))
    setShowAllMembers((current) => { const next = new Set(current); next.delete(groupId); return next })
    setMemberActionMessage(`已为「${target.name}」启用全部可用节点；订阅刷新后会自动同步。`)
  }

  function toggleExpandedGroup(groupId: string) {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  function groupReferenceBlockReason(targetId: string, referenceName: string) {
    const target = props.policy.groups.find((group) => group.id === targetId)
    if (!target) return '目标策略组已不存在。'
    if (target.groupNames.includes(referenceName)) return `「${referenceName}」已经在「${target.name}」中。`
    if (referenceName === target.name) return '策略组不能加入自身。'
    const targetName = target.name
    const childGroup = props.policy.groups.find((group) => group.name === referenceName)
    if (!childGroup) return ''
    const visited = new Set<string>()
    function reachesTarget(groupName: string): boolean {
      if (groupName === targetName) return true
      if (visited.has(groupName)) return false
      visited.add(groupName)
      const current = props.policy.groups.find((group) => group.name === groupName)
      return current?.groupNames.some(reachesTarget) ?? false
    }
    return reachesTarget(childGroup.name) ? '这样加入会形成循环策略组，不能添加。' : ''
  }

  function addGroupReferenceToGroup(targetId: string, referenceName: string) {
    const reason = groupReferenceBlockReason(targetId, referenceName)
    if (reason) { setMemberActionMessage(reason); return false }
    const target = props.policy.groups.find((group) => group.id === targetId)
    if (!target) return false
    updateGroup(targetId, (group) => ({ ...group, groupNames: [...new Set([...group.groupNames, referenceName])] }))
    setMemberActionMessage(`已将「${referenceName}」加入「${target.name}」。`)
    return true
  }

  function addDynamicNodeRangeToGroup(targetId: string, generatedGroupId: string, label: string) {
    const target = props.policy.groups.find((group) => group.id === targetId)
    if (!target) return false
    const generatedGroup = props.generatedGroups.find((group) => group.id === generatedGroupId)
    if (!generatedGroup) {
      setMemberActionMessage(`「${label}」当前没有可用节点，恢复后可再次拖入。`)
      return false
    }
    if (target.groupNames.some((name) => parseDynamicNodeRange(name)?.id === generatedGroupId)) {
      setMemberActionMessage(`「${label}」的动态节点范围已经在「${target.name}」中。`)
      return false
    }
    const rangeReference = dynamicNodeRangeReference(generatedGroupId, label)
    updateGroup(targetId, (group) => ({ ...group, groupNames: [...group.groupNames, rangeReference] }))
    setMemberActionMessage(`已将「${label}」作为动态节点范围加入「${target.name}」，当前 ${generatedGroup.nodes.length} 个节点；订阅刷新后自动同步。`)
    return true
  }

  function dropGroupAtPoint(x: number, y: number) {
    return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-policy-drop-group]')?.dataset.policyDropGroup ?? ''
  }

  function startVisualPointerDrag(event: ReactPointerEvent<HTMLElement>, kind: VisualPointerDrag['kind'], id: string, label: string, referenceName?: string, referenceKind?: string, groupId?: string, generatedGroupId?: string) {
    if (props.busy || event.button !== 0 || event.pointerType === 'touch') return
    pointerDragRef.current = { kind, id, label, groupId, referenceName, referenceKind, generatedGroupId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    setDraggingAutoGroupAsRange(Boolean(generatedGroupId && event.shiftKey))
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      pointerDragRef.current = null
    }
  }

  function moveVisualPointerDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return
    if (!drag.active) {
      drag.active = true
      if (drag.kind === 'group-member-order') setDraggingGroupMember({ groupId: drag.groupId ?? '', name: drag.id })
      else if (drag.kind === 'group-member' || drag.kind === 'all-nodes') setDraggingCandidateId(drag.id)
      else setDraggingGroupId(drag.id)
    }
    event.preventDefault()
    const isDynamicRangeDrop = Boolean(drag.generatedGroupId && event.shiftKey)
    setDraggingAutoGroupAsRange(isDynamicRangeDrop)
    if (drag.kind === 'group-member-order') {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-policy-member-card]')
      const targetGroupId = target?.dataset.policyMemberGroup ?? ''
      const targetName = target?.dataset.policyMemberName ?? ''
      setDropTargetGroupId('')
      setDropTargetGroupMember(targetGroupId === drag.groupId && targetName && targetName !== drag.id ? { groupId: targetGroupId, name: targetName } : null)
      setDragPreview({ kind: 'group', label: drag.label, x: event.clientX, y: event.clientY })
      return
    }
    setDropTargetGroupId(dropGroupAtPoint(event.clientX, event.clientY))
    const previewKind = isDynamicRangeDrop ? 'range' : drag.kind === 'all-nodes' ? 'scope' : drag.referenceKind === '内置出站' ? 'builtin' : drag.referenceKind === '地区线路' ? 'region' : 'group'
    setDragPreview({ kind: previewKind, label: drag.label, x: event.clientX, y: event.clientY })
  }

  function finishVisualPointerDrag(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const memberTarget = drag.active && !cancelled
      ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-policy-member-card]')
      : null
    const targetId = drag.active && !cancelled ? dropGroupAtPoint(event.clientX, event.clientY) : ''
    pointerDragRef.current = null
    if (drag.active && !cancelled && drag.kind === 'group-member-order') {
      const targetGroupId = memberTarget?.dataset.policyMemberGroup ?? ''
      const targetName = memberTarget?.dataset.policyMemberName ?? ''
      if (drag.groupId && targetGroupId === drag.groupId && targetName) reorderGroupMembers(drag.groupId, drag.id, targetName)
    } else if (drag.active && !cancelled && targetId) {
      if (drag.kind === 'group-member') {
        if (drag.generatedGroupId && event.shiftKey) addDynamicNodeRangeToGroup(targetId, drag.generatedGroupId, drag.label)
        else addGroupReferenceToGroup(targetId, drag.referenceName ?? drag.label)
      } else if (drag.kind === 'all-nodes') {
        addAllNodesToGroup(targetId)
      } else reorderGroups(drag.id, targetId)
    }
    setDraggingGroupId('')
    setDraggingCandidateId('')
    setDropTargetGroupId('')
    setDraggingGroupMember(null)
    setDropTargetGroupMember(null)
    setDragPreview(null)
    setDraggingAutoGroupAsRange(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  async function removeNodeFromGroup(group: PolicyGroup, node: ProxyNode, shift: boolean) {
    if (!shift && !await props.confirm(`从「${group.name}」中移出节点「${node.displayName}」？\n提示：下次可按住 Shift 点击移除按钮，跳过确认直接移出。`, { title: '移出策略组', confirmLabel: '移出节点', destructive: true })) return
    updateGroup(group.id, (current) => ({
      ...current,
      includeNodeIds: (current.includeNodeIds ?? []).filter((id) => id !== node.id),
      excludeNodeIds: [...new Set([...(current.excludeNodeIds ?? []), node.id])],
    }))
  }

  async function clearGroupNodes(group: PolicyGroup, memberCount: number, shift: boolean) {
    if (memberCount === 0 && !group.allNodes) return
    const prompt = group.allNodes
      ? `关闭「${group.name}」的全部可用节点动态范围，并清空节点筛选条件？策略组线路和分流规则会保留。`
      : `从「${group.name}」中清除全部 ${memberCount} 个节点，并清空节点筛选条件？策略组线路和分流规则会保留。`
    if (!shift && !await props.confirm(prompt, { title: '清除组内节点', confirmLabel: '全部清除', destructive: true })) return
    updateGroup(group.id, (current) => ({
      ...current,
      allNodes: false,
      sourceIds: [],
      countries: [],
      nodeIds: [],
      includeNodeIds: [],
      excludeNodeIds: [],
    }))
    setShowAllMembers((current) => { const next = new Set(current); next.delete(group.id); return next })
  }

  async function removeAllNodesRange(group: PolicyGroup, shift: boolean) {
    if (!shift && !await props.confirm(`从「${group.name}」中移除“全部可用节点”动态范围？其他节点筛选条件会保留。`, { title: '移除动态节点范围', confirmLabel: '移除范围', destructive: true })) return
    updateGroup(group.id, (current) => ({ ...current, allNodes: false }))
    setExpandedAllNodes((current) => { const next = new Set(current); next.delete(group.id); return next })
  }

  async function removeGroupReference(group: PolicyGroup, reference: string, shift: boolean) {
    if (!shift && !await props.confirm(`从「${group.name}」中移除线路引用「${reference}」？\n提示：下次可按住 Shift 点击移除按钮，跳过确认直接移除。`, { title: '移除线路引用', confirmLabel: '移除引用', destructive: true })) return
    updateGroup(group.id, (current) => ({ ...current, groupNames: current.groupNames.filter((name) => name !== reference) }))
  }

  function appendRules(target: string, additions: PolicyRule[], providers?: Record<string, unknown>) {
    if (!additions.length) return
    changePolicy((current) => {
      const rules = [...current.rules]
      const existingTarget = rules.findIndex((rule) => rule.target === target)
      const fallback = rules.findIndex((rule) => rule.kind.trim().toUpperCase() === 'MATCH')
      const insertAt = existingTarget >= 0 ? existingTarget : fallback >= 0 ? fallback : rules.length
      rules.splice(insertAt, 0, ...additions)
      return { ...current, rules, ruleProviders: { ...current.ruleProviders, ...(providers ?? {}) } }
    })
  }

  function addManualRule(group: PolicyGroup) {
    const raw = (ruleInputs[group.id] ?? '').trim()
    const kind = ruleKindsByGroup[group.id] ?? ruleKinds[0].value
    const validationError = manualRuleValueError(kind, raw)
    if (validationError) {
      setRuleErrors((current) => ({ ...current, [group.id]: validationError }))
      return
    }
    const target = group.name.trim()
    if (!target) return
    appendRules(target, [{ kind, value: raw, target }])
    setRuleInputs((current) => ({ ...current, [group.id]: '' }))
    setRuleErrors((current) => ({ ...current, [group.id]: '' }))
  }

  function addManualRulesBatch(group: PolicyGroup) {
    const raw = batchRuleInputs[group.id] ?? ''
    const kind = ruleKindsByGroup[group.id] ?? ruleKinds[0].value
    const lines = raw.split(/\r?\n/).map((value, index) => ({ line: index + 1, value: value.trim() })).filter((item) => item.value)
    if (!lines.length) {
      setBatchRuleFeedback((current) => ({ ...current, [group.id]: { summary: '请粘贴要添加的内容，每行一条。', details: [] } }))
      return
    }
    const target = group.name.trim()
    if (!target) return

    const normalizedKind = kind.trim().toUpperCase()
    const duplicateKey = (value: string) => `${normalizedKind}\0${value.trim().toLocaleLowerCase()}`
    const seen = new Set(props.policy.rules
      .filter((rule) => rule.target === target && rule.kind.trim().toUpperCase() === normalizedKind)
      .map((rule) => duplicateKey(rule.value)))
    const additions: PolicyRule[] = []
    const invalid: Array<{ line: number; value: string; error: string }> = []
    let duplicateCount = 0
    for (const item of lines) {
      const validationError = manualRuleValueError(kind, item.value)
      if (validationError) {
        invalid.push({ ...item, error: validationError })
        continue
      }
      const key = duplicateKey(item.value)
      if (seen.has(key)) {
        duplicateCount += 1
        continue
      }
      seen.add(key)
      additions.push({ kind, value: item.value, target })
    }

    appendRules(target, additions)
    setBatchRuleInputs((current) => ({ ...current, [group.id]: invalid.map((item) => item.value).join('\n') }))
    setBatchRuleFeedback((current) => ({
      ...current,
      [group.id]: {
        summary: `新增 ${additions.length} 条 · 重复跳过 ${duplicateCount} 条${invalid.length ? ` · 未添加 ${invalid.length} 行（保留在输入框中）` : ''}`,
        details: invalid.map((item) => `第 ${item.line} 行「${item.value}」：${item.error}`),
      },
    }))
  }

  function deleteRule(index: number, shift: boolean) {
    const { rule } = props.policy.rules.map((rule, current) => ({ rule, index: current })).find((item) => item.index === index) ?? { rule: null, index: -1 }
    if (!rule) return
    void (async () => {
      if (!shift && !await props.confirm(`删除规则「${rule.kind}${rule.value ? ` · ${rule.value}` : ''}」？\n提示：下次可按住 Shift 点击删除按钮，跳过确认直接删除。`, { title: '删除规则', confirmLabel: '删除规则', destructive: true })) return
      props.onChange(removeRuleAt(props.policy, index))
    })()
  }

  function reorderGroupRules(sourceIndex: number, targetIndex: number, groupName: string, ruleSetsOnly: boolean) {
    if (sourceIndex === targetIndex) return
    changePolicy((current) => {
      const slots = current.rules.map((rule, index) => rule.target === groupName && rule.kind.trim().toUpperCase() !== 'MATCH' && isRuleSet(rule) === ruleSetsOnly ? index : -1).filter((index) => index >= 0)
      const source = slots.indexOf(sourceIndex)
      const target = slots.indexOf(targetIndex)
      if (source < 0 || target < 0) return current
      const scoped = slots.map((index) => current.rules[index])
      const [moved] = scoped.splice(source, 1)
      scoped.splice(target, 0, moved)
      const rules = [...current.rules]
      slots.forEach((index, position) => { rules[index] = scoped[position] })
      return { ...current, rules }
    })
  }

  function applySelectedRuleSets(group: PolicyGroup) {
    const selectedIds = [...(selectedRuleSets[group.id] ?? new Set<string>())]
    const nextPolicy = policyWithSelectedRuleSets(props.policy, group.id, selectedIds, props.ruleSets)
    const desiredRules = nextPolicy.rules.filter((rule) => rule.target === nextPolicy.groups.find((item) => item.id === group.id)?.name && isRuleSet(rule))
    changePolicy(() => nextPolicy)
    setSelectedRuleSets((current) => ({ ...current, [group.id]: new Set(desiredRules.map((rule) => rule.value)) }))
  }

  function finishGroupRulesPage() {
    if (groupRulesPage === 'rule-sets' && settingsGroup && ruleSetSelectionChanged) {
      applySelectedRuleSets(settingsGroup)
    }
    setGroupRulesPage(null)
  }

  return <div className="policy-visual-page">
    {props.topbarActionHost && createPortal(<>
      <button className="button secondary" type="button" disabled={props.busy} onClick={openNewGroup}>＋ 新建策略组</button>
      <button className="button secondary" type="button" disabled={props.busy || !props.dirty} onClick={props.onDiscard}>放弃修改</button>
      <button className="button primary" type="button" disabled={props.busy || !props.dirty || invalidNameIds.size > 0} onClick={props.onSave}>{props.busy ? '保存中…' : '保存方案'}</button>
    </>, props.topbarActionHost)}
    <div className="policy-visual-overview">
      <div className="policy-visual-editor-columns">
        <section className="policy-visual-groups" aria-label="策略组">
          {props.policy.groups.length === 0 && props.generatedGroups.length === 0 ? <div className="policy-visual-empty">
            <div className="policy-visual-empty-icon">◇</div><strong>这个方案还没有策略组</strong>
            <span>点击顶部“新建策略组”；添加订阅并刷新后，地区和来源自动策略组也会显示在这里。</span>
          </div> : <>
          {props.policy.groups.map((group) => {
            const isOpen = expandedGroups.has(group.id)
            const members = availableNodes.filter((node) => groupMatchesNode(group, node))
            const defaultSelected = groupDefaultSelected(group)
            const canPinDefault = group.kind.trim().toLowerCase() === 'select'
            const hasDefaultMember = Boolean(defaultSelected && (availableGroupReferences.some((reference) => reference.name === defaultSelected) || members.some((node) => node.displayName === defaultSelected)))
            const missingDefaultMember = canPinDefault && Boolean(defaultSelected && !hasDefaultMember)
            const explicit = new Set(group.includeNodeIds ?? [])
            const groupRuleRows = props.policy.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.target === group.name && rule.kind.trim().toUpperCase() !== 'MATCH')
            const memberLimit = showAllMembers.has(group.id) ? members.length : 12
            const nodeCards = members.slice(0, memberLimit).map((node) => <div className={'policy-visual-member' + (canPinDefault && defaultSelected === node.displayName ? ' is-default-member' : '')} key={node.id}>
              <span className="policy-visual-member-name" title={node.displayName}>{node.displayName}</span><small>{node.sourceName} · {node.country}{explicit.has(node.id) ? ' · 单独加入' : ' · 自动匹配'}</small>
              <div className="policy-visual-member-actions">
                {canPinDefault && <button className={'policy-visual-default-pin' + (defaultSelected === node.displayName ? ' is-default' : '')} type="button" aria-label={defaultSelected === node.displayName ? `取消 ${node.displayName} 的默认成员` : `将 ${node.displayName} 设为默认成员`} aria-pressed={defaultSelected === node.displayName} title={defaultSelected === node.displayName ? '当前默认成员；点击取消固定' : '设为默认成员'} disabled={props.busy} onClick={() => setGroupDefaultSelected(group.id, node.displayName)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3.5 20.5 8l-2.7 1.2-2.6 4.3-.2 2.1-1.3 1.3-2.7-2.7-4.7 4.7-.9-.9 4.7-4.7-2.7-2.7 1.3-1.3 2.1-.2 4.3-2.6L16 3.5Z" /></svg></button>}
                <button className="policy-visual-member-remove" type="button" aria-label={'从 ' + group.name + ' 移出 ' + node.displayName} title="移出节点；按住 Shift 点击可直接移出" disabled={props.busy} onClick={(event) => void removeNodeFromGroup(group, node, event.shiftKey)}>×</button>
              </div>
            </div>)
            const groupNameValid = groupNameAvailable(group.name, group.id)
            return <article key={group.id} data-policy-drop-group={group.id} className={'policy-visual-group-card' + (draggingGroupId === group.id ? ' dragging' : '') + (dropTargetGroupId === group.id ? ' drop-target' : '')}>
              <header className="policy-visual-group-summary">
                <button className="policy-visual-drag-handle" type="button" disabled={props.busy} title="按住拖动调整组顺序" aria-label={'拖动调整 ' + group.name + ' 的顺序'} onPointerDown={(event) => startVisualPointerDrag(event, 'group-order', group.id, group.name)} onPointerMove={moveVisualPointerDrag} onPointerUp={finishVisualPointerDrag} onPointerCancel={(event) => finishVisualPointerDrag(event, true)}>⠿</button>
                <button className="policy-visual-summary-toggle" type="button" aria-label={(isOpen ? '收起' : '展开') + group.name + '策略组'} aria-expanded={isOpen} onClick={() => toggleExpandedGroup(group.id)}>
                  <span className="policy-visual-summary-copy">
                    <strong className="policy-visual-summary-name">{group.name}</strong>
                    {dropTargetGroupId === group.id && <b className="policy-visual-drop-hint">{draggingCandidateId === 'all-nodes' ? '松开即可自动包含全部可用节点' : draggingCandidateId && draggingAutoGroupAsRange ? '松开即可加入动态节点范围' : draggingCandidateId ? '松开即可加入内置出站或策略组' : draggingGroupId ? '松开即可调整组顺序' : '松开即可放入'}</b>}
                  </span>
                  <span className="policy-visual-summary-meta">
                    <span className="policy-visual-summary-line" title={`${groupKinds.find((kind) => kind.value === group.kind)?.label ?? group.kind} · ${members.length} 个节点 · ${group.groupNames.length} 个成员 · ${groupRuleRows.length} 条规则`}>{groupKinds.find((kind) => kind.value === group.kind)?.label ?? group.kind} · {members.length} 个节点 · {group.groupNames.length} 个成员 · {groupRuleRows.length} 条规则</span>
                    {(group.allNodes || (group.sourceIds.length + group.countries.length + group.nodeIds.length) > 0) && <span className="policy-visual-summary-tags">{group.allNodes && <span className="dynamic">自动包含全部节点</span>}{(group.sourceIds.length + group.countries.length + group.nodeIds.length) > 0 && <span>保留自动筛选</span>}</span>}
                  </span>
                </button>
                <button className="button small secondary" type="button" disabled={props.busy} onClick={() => openGroupSettings(group)}>设置</button>
                <button className="button small danger" type="button" disabled={props.busy} title="删除策略组；按住 Shift 点击可直接删除" onClick={(event) => void deleteGroup(group, event.shiftKey)}>删除</button>
                <button className={'policy-visual-expand' + (isOpen ? ' expanded' : '')} type="button" aria-label={(isOpen ? '收起' : '展开') + group.name + '的组内成员'} aria-expanded={isOpen} title={isOpen ? '收起成员' : '展开成员'} onClick={() => toggleExpandedGroup(group.id)}><span aria-hidden="true" /></button>
              </header>
              {!groupNameValid && <div className="policy-visual-inline-error">策略组名称不能为空或与其他组重复。</div>}
              {isOpen && <div className="policy-visual-group-body">
                <section className="policy-visual-members">
                  <header><div><strong>组内成员</strong><span>{canPinDefault ? '拖动排序 · 悬停成员卡片并点击图钉设为默认' : '拖动卡片左侧手柄调整顺序'}</span></div><b>{group.groupNames.length + (group.allNodes ? 1 : members.length)} 项</b></header>
                  {missingDefaultMember && <div className="policy-visual-default-missing"><span>默认成员「{defaultSelected}」当前不在组内，Mihomo 暂用组内首项。</span><button className="policy-visual-clear-default" type="button" disabled={props.busy} onClick={() => setGroupDefaultSelected(group.id, defaultSelected)}>取消默认成员</button></div>}
                  {group.groupNames.length > 0 || group.allNodes ? <div className="policy-visual-reference-grid">{group.groupNames.map((name) => {
                    const reference = availableGroupReferences.find((item) => item.name === name)
                    const nodeRange = parseDynamicNodeRange(name)
                    const rangeGroup = nodeRange ? props.generatedGroups.find((item) => item.id === nodeRange.id) : undefined
                    const memberName = nodeRange ? rangeGroup?.name ?? nodeRange.label : reference?.displayName ?? name
                    const memberKind = nodeRange ? '动态节点范围' : reference?.kind ?? '策略组'
                    const memberDetail = nodeRange
                      ? rangeGroup ? `${rangeGroup.nodes.length} 个节点 · 随订阅更新` : '订阅线路暂不可用 · 恢复后自动同步'
                      : reference?.detail ?? '策略组或地区线路成员'
                    const isDragging = draggingGroupMember?.groupId === group.id && draggingGroupMember.name === name
                    const isDropTarget = dropTargetGroupMember?.groupId === group.id && dropTargetGroupMember.name === name
                    const pinAvailable = canPinDefault && !nodeRange && (Boolean(reference) || (!name.startsWith('🌏 ') && !(name.startsWith('📦 ') && name.endsWith(' · 全部节点'))))
                    return <article className={'policy-visual-reference-card' + (nodeRange ? ' is-dynamic-range' : '') + (canPinDefault && defaultSelected === name ? ' is-default-member' : '') + (isDragging ? ' member-dragging' : '') + (isDropTarget ? ' member-drop-target' : '')} data-policy-member-card data-policy-member-group={group.id} data-policy-member-name={name} key={name}>
                      <button className="policy-visual-reference-drag-handle" type="button" title="按住拖动调整组内成员顺序" aria-label={'拖动调整 ' + memberName + ' 在 ' + group.name + ' 中的顺序'} disabled={props.busy} onPointerDown={(event) => startVisualPointerDrag(event, 'group-member-order', name, memberName, name, memberKind, group.id)} onPointerMove={moveVisualPointerDrag} onPointerUp={finishVisualPointerDrag} onPointerCancel={(event) => finishVisualPointerDrag(event, true)}>⠿</button>
                      <div className="policy-visual-reference-copy"><div className="policy-visual-reference-title"><strong title={memberName}>{memberName}</strong><small>{memberKind}</small></div><span className="policy-visual-reference-detail" title={memberDetail}>{memberDetail}</span></div>
                      <div className="policy-visual-reference-actions">
                        {pinAvailable && <button className={'policy-visual-default-pin' + (defaultSelected === name ? ' is-default' : '')} type="button" aria-label={defaultSelected === name ? `取消 ${reference?.displayName ?? name} 的默认成员` : `将 ${reference?.displayName ?? name} 设为默认成员`} aria-pressed={defaultSelected === name} title={defaultSelected === name ? '当前默认成员；点击取消固定' : '设为默认成员'} disabled={props.busy} onClick={() => setGroupDefaultSelected(group.id, name)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3.5 20.5 8l-2.7 1.2-2.6 4.3-.2 2.1-1.3 1.3-2.7-2.7-4.7 4.7-.9-.9 4.7-4.7-2.7-2.7 1.3-1.3 2.1-.2 4.3-2.6L16 3.5Z" /></svg></button>}
                        {!nodeRange && reference?.generatedGroupId && <button className="policy-visual-reference-settings" type="button" title="设置这条自动线路的切换方式" aria-label={'设置 ' + (reference.displayName ?? name) + ' 的切换方式'} disabled={props.busy} onClick={() => setAutoGroupSettingsId(reference.generatedGroupId!)}>⚙</button>}
                        <button className="policy-visual-reference-remove" type="button" title="移除成员；按住 Shift 点击可直接移除" aria-label={'从 ' + group.name + ' 移除 ' + name} disabled={props.busy} onClick={(event) => void removeGroupReference(group, name, event.shiftKey)}>×</button>
                      </div>
                    </article>
                  })}{group.allNodes && <article className="policy-visual-reference-card is-dynamic-range policy-visual-all-nodes-card" key="all-nodes">
                    <span className="policy-visual-reference-marker" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M6 5.5h8M6 10h8M6 14.5h8" /><circle cx="3.5" cy="5.5" r="1" /><circle cx="3.5" cy="10" r="1" /><circle cx="3.5" cy="14.5" r="1" /></svg></span>
                    <div className="policy-visual-reference-copy"><div className="policy-visual-reference-title"><strong title="全部可用节点">全部可用节点</strong><small>动态节点范围</small></div><span className="policy-visual-reference-detail" title={`${members.length} 个节点 · 随订阅刷新自动同步`}>{members.length} 个节点 · 随订阅刷新自动同步</span></div>
                    <div className="policy-visual-reference-actions">
                      <button className="policy-visual-reference-details-toggle" type="button" aria-label={expandedAllNodes.has(group.id) ? '收起全部可用节点明细' : '展开全部可用节点明细'} aria-expanded={expandedAllNodes.has(group.id)} title={expandedAllNodes.has(group.id) ? '收起节点明细' : '查看节点明细'} onClick={() => setExpandedAllNodes((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
                      <button className="policy-visual-reference-remove" type="button" title="移除全部可用节点范围；按住 Shift 点击可直接移除" aria-label={'从 ' + group.name + ' 移除全部可用节点动态范围'} disabled={props.busy} onClick={(event) => void removeAllNodesRange(group, event.shiftKey)}>×</button>
                    </div>
                  </article>}</div> : null}
                  {group.allNodes && expandedAllNodes.has(group.id) && <section className="policy-visual-all-node-details" aria-label="全部可用节点明细">
                    <header><strong>节点明细</strong><span>{members.length} 个节点，订阅刷新后自动同步</span></header>
                    {members.length > 0 ? <>
                      <div className="policy-visual-member-grid">{nodeCards}</div>
                      {members.length > 12 && <button className="policy-visual-link-button" type="button" onClick={() => setShowAllMembers((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}>{showAllMembers.has(group.id) ? '收起节点' : '显示剩余 ' + (members.length - 12) + ' 个节点'}</button>}
                    </> : <p className="policy-visual-empty-nodes">当前没有可用节点。</p>}
                  </section>}
                  {!group.allNodes && members.length > 0 && <div className="policy-visual-direct-members">
                    <header><div><strong>节点</strong></div><div className="policy-visual-member-actions"><b>{members.length} 个</b><button className="policy-visual-clear-button" type="button" disabled={props.busy} onClick={(event) => void clearGroupNodes(group, members.length, event.shiftKey)}>全部清除</button></div></header>
                    <div className="policy-visual-member-grid">{nodeCards}</div>
                    {members.length > 12 && <button className="policy-visual-link-button" type="button" onClick={() => setShowAllMembers((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}>{showAllMembers.has(group.id) ? '收起节点' : '显示剩余 ' + (members.length - 12) + ' 个节点'}</button>}
                  </div>}
                  {group.groupNames.length === 0 && members.length === 0 && !group.allNodes && <div className="policy-visual-placeholder">此策略组还没有成员；从右侧拖入其他策略组或“全部可用节点”。</div>}
                </section>
              </div>}
            </article>
          })}
          {props.generatedGroups.length > 0 && <section className="policy-visual-auto-groups" aria-label="自动策略组">
            <header className="policy-visual-auto-groups-heading"><button className="policy-visual-auto-groups-toggle" type="button" aria-expanded={!props.autoGroupsCollapsed} aria-controls="policy-visual-auto-groups-content" onClick={props.onToggleAutoGroups}>
              <span className="policy-visual-auto-groups-copy"><strong>自动策略组</strong><span>按订阅来源和地区生成；节点随订阅刷新自动更新</span></span>
              <span className="policy-visual-auto-groups-controls"><b>{props.generatedGroups.length}</b><span className="policy-visual-auto-groups-action">{props.autoGroupsCollapsed ? '展开' : '收起'}</span></span>
            </button></header>
            <div className="policy-visual-auto-groups-content" id="policy-visual-auto-groups-content" hidden={props.autoGroupsCollapsed}>
            {props.generatedGroups.map((generatedGroup) => {
              const isOpen = expandedAutoGroups.has(generatedGroup.id)
              const generatedNodeNames = new Set(generatedGroup.nodes)
              const members = availableNodes.filter((node) => node.sourceId === generatedGroup.sourceId
                && generatedNodeNames.has(node.displayName)
                && (!generatedGroup.country || node.country === generatedGroup.country))
              const mode = groupKinds.find((kind) => kind.value === props.policy.autoGroupSettings?.[generatedGroup.id]?.kind)?.label ?? '手动选择'
              const ruleCount = props.policy.rules.filter((rule) => rule.target === generatedGroup.name && rule.kind.trim().toUpperCase() !== 'MATCH').length
              const visibleMembers = members.slice(0, showAllMembers.has(generatedGroup.id) ? members.length : 12)
              const displayName = generatedGroup.name
              return <article key={generatedGroup.id} className="policy-visual-group-card policy-visual-auto-group-card">
                <header className="policy-visual-group-summary policy-visual-auto-group-summary">
                  <span className="policy-visual-auto-group-marker" aria-hidden="true">↻</span>
                  <button className="policy-visual-summary-toggle" type="button" aria-label={(isOpen ? '收起' : '展开') + displayName + '策略组'} aria-expanded={isOpen} onClick={() => setExpandedAutoGroups((current) => { const next = new Set(current); if (next.has(generatedGroup.id)) next.delete(generatedGroup.id); else next.add(generatedGroup.id); return next })}>
                    <span className="policy-visual-summary-copy"><strong className="policy-visual-summary-name">{displayName}</strong></span>
                    <span className="policy-visual-summary-meta"><span className="policy-visual-summary-line">{mode} · {members.length} 个节点 · {ruleCount} 条规则</span><span className="policy-visual-summary-tags"><span className="dynamic">订阅自动更新</span></span></span>
                  </button>
                  <button className="button small secondary" type="button" disabled={props.busy} onClick={() => setAutoGroupSettingsId(generatedGroup.id)}>设置</button>
                  <button className={'policy-visual-expand' + (isOpen ? ' expanded' : '')} type="button" aria-label={(isOpen ? '收起' : '展开') + displayName + '的组内成员'} aria-expanded={isOpen} title={isOpen ? '收起成员' : '展开成员'} onClick={() => setExpandedAutoGroups((current) => { const next = new Set(current); if (next.has(generatedGroup.id)) next.delete(generatedGroup.id); else next.add(generatedGroup.id); return next })}><span aria-hidden="true" /></button>
                </header>
                {isOpen && <div className="policy-visual-group-body">
                  <section className="policy-visual-members">
                    <header><div><strong>自动节点</strong><span>订阅刷新后自动同步</span></div><b>{members.length} 个节点</b></header>
                    {members.length ? <>
                      <div className="policy-visual-member-grid policy-visual-auto-node-grid">{visibleMembers.map((node) => <div className="policy-visual-auto-node" key={node.id}><strong title={node.displayName}>{node.displayName}</strong><small>{node.sourceName} · {node.country}</small></div>)}</div>
                      {members.length > 12 && <button className="policy-visual-link-button" type="button" onClick={() => setShowAllMembers((current) => { const next = new Set(current); if (next.has(generatedGroup.id)) next.delete(generatedGroup.id); else next.add(generatedGroup.id); return next })}>{showAllMembers.has(generatedGroup.id) ? '收起节点' : '显示剩余 ' + (members.length - 12) + ' 个节点'}</button>}
                    </> : <div className="policy-visual-placeholder">当前订阅中没有符合这个来源和地区的节点；刷新后会自动重新生成。</div>}
                  </section>
                </div>}
              </article>
            })}
            </div>
          </section>}
          </>}

          {nonMatchRules.some(({ rule }) => !strategyGroupNameSet.has(rule.target)) && <details className="policy-visual-other-rules"><summary>其他去向规则 <span>{nonMatchRules.filter(({ rule }) => !strategyGroupNameSet.has(rule.target)).length} 条</span></summary><div>{nonMatchRules.filter(({ rule }) => !strategyGroupNameSet.has(rule.target)).map(({ rule, index }) => <div key={'other-' + index} className="policy-visual-rule-row"><span className="policy-visual-rule-order">{String(index + 1).padStart(2, '0')}</span><span className="policy-visual-rule-type">{rule.kind}</span><span className="policy-visual-rule-detail">{ruleSummary(rule, props.ruleSets)}</span><DropdownSelect aria-label="规则去向" value={rule.target} onValueChange={(target) => changePolicy((current) => ({ ...current, rules: current.rules.map((item, currentIndex) => currentIndex === index ? { ...item, target } : item) }))}><option value={rule.target}>{policyTargetLabel(rule.target)}</option>{['DIRECT', 'REJECT'].filter((target) => target !== rule.target).map((target) => <option key={target} value={target}>{policyTargetLabel(target)}</option>)}{strategyGroupReferences.filter((group) => group.name !== rule.target).map((group) => <option key={group.id} value={group.name}>{group.displayName ?? group.name}</option>)}</DropdownSelect><button className="policy-visual-icon-button" type="button" title="删除规则；按住 Shift 点击可直接删除" onClick={(event) => deleteRule(index, event.shiftKey)}>×</button></div>)}</div></details>}
          <section className="policy-visual-final-route"><div><strong>未命中规则时</strong><span>Mihomo 会按最后一条 MATCH 规则决定其余流量的去向。</span></div><DropdownSelect value={matchRules.at(-1)?.rule.target ?? 'DIRECT'} onValueChange={(target) => {
            const index = matchRules.at(-1)?.index
            if (index === undefined) changePolicy((current) => ({ ...current, rules: [...current.rules, { kind: 'MATCH', value: '', target }] }))
            else changePolicy((current) => ({ ...current, rules: current.rules.map((rule, currentIndex) => currentIndex === index ? { ...rule, target } : rule) }))
          }}><option value="DIRECT">DIRECT（直连）</option><option value="REJECT">REJECT（拦截）</option>{strategyGroupReferences.map((group) => <option key={group.id} value={group.name}>{group.displayName ?? group.name}</option>)}</DropdownSelect></section>
        </section>

        <aside className="policy-visual-candidates" aria-label="可添加成员">
          <header className="policy-visual-candidates-heading"><div><strong>可添加成员</strong><span>{candidateCategory === 'region' ? '拖动加入策略组；按住 Shift 拖动则加入动态节点范围' : '切换分类后拖入目标策略组'}</span></div><b>{availableGroupReferences.length + 1}</b></header>
          {memberActionMessage && <div className="policy-visual-member-feedback" role="status" aria-live="polite">{memberActionMessage}</div>}
          <div className="policy-visual-candidate-tabs" role="tablist" aria-label="候选成员分类">
            {candidateCategories.map(({ id, label, count }) => <button id={`policy-visual-candidate-tab-${id}`} type="button" role="tab" aria-selected={candidateCategory === id} aria-controls="policy-visual-candidate-panel" className={candidateCategory === id ? 'active' : ''} key={id} onClick={() => setCandidateCategory(id)}><span>{label}</span><b>{count}</b></button>)}
          </div>
          <div className="policy-visual-picker-scroll">
            <section className="policy-visual-candidate-panel" id="policy-visual-candidate-panel" role="tabpanel" aria-labelledby={`policy-visual-candidate-tab-${candidateCategory}`}>
              {candidateCategory === 'builtin' || activeCandidateReferences.length ? <div className={'policy-visual-candidate-list' + (candidateCategory === 'builtin' ? ' policy-visual-candidate-list-unified' : '') + (candidateCategory === 'region' ? ' policy-visual-candidate-list-region' : '')} role="list">
                {candidateCategory === 'builtin' && <div role="listitem" className={'policy-visual-candidate tone-dynamic' + (draggingCandidateId === 'all-nodes' ? ' dragging' : '') + (props.busy ? ' disabled' : '')} title="拖入策略组后自动包含当前全部可用节点，并随订阅刷新同步增删" onPointerDown={(event) => startVisualPointerDrag(event, 'all-nodes', 'all-nodes', '全部可用节点')} onPointerMove={moveVisualPointerDrag} onPointerUp={finishVisualPointerDrag} onPointerCancel={(event) => finishVisualPointerDrag(event, true)}>
                  <span className="policy-visual-node-grip" aria-hidden="true">⠿</span><span className="policy-visual-candidate-copy"><strong>全部可用节点</strong><small>随订阅刷新自动增删</small></span>
                </div>}
                {candidateCategory === 'region'
                  ? autoCandidateGroups.map((sourceGroup) => <section className="policy-visual-auto-candidate-source" role="group" aria-label={`${sourceGroup.provider}订阅线路`} key={sourceGroup.sourceId}>
                    <header><strong>{sourceGroup.provider}</strong><span>{sourceGroup.references.length} 个分组</span></header>
                    <div className="policy-visual-auto-candidate-items" role="list">{sourceGroup.references.map(renderCandidateReference)}</div>
                  </section>)
                  : activeCandidateReferences.map(renderCandidateReference)}
              </div> : <div className="policy-visual-empty-candidates">{candidateCategory === 'region' ? '当前没有自动地区线路；添加订阅并刷新节点后会自动生成。' : '还没有可添加的策略组。'}</div>}
            </section>
          </div>
        </aside>
      </div>
    </div>
    {settingsGroup && <div className="policy-visual-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeGroupSettings() }}>
      <section className={`policy-visual-settings-dialog${groupRulesPage === 'rule-sets' ? ' policy-visual-ruleset-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="policy-visual-settings-title">
        <header><div><span className="eyebrow">{groupRulesPage ? 'STRATEGY GROUP RULES' : 'STRATEGY GROUP SETTINGS'}</span><strong id="policy-visual-settings-title">{groupRulesPage === 'single-rules' ? `管理「${settingsGroup.name}」的网站 / IP / 应用规则` : groupRulesPage === 'rule-sets' ? `管理「${settingsGroup.name}」的规则集` : `设置「${settingsGroup.name}」`}</strong><small>{groupRulesPage === 'single-rules' ? '添加、排序或移除网站、IP 和应用规则；命中后流量交给当前策略组。' : groupRulesPage === 'rule-sets' ? '完整显示规则集库；当前组已引用项默认勾选，可在此添加或移除。' : `${settingsGroupMembers.length} 个直接节点 · ${settingsGroup.groupNames.length} 个成员 · ${settingsGroupSingleRules.length} 条单条规则 · ${settingsGroupRuleSets.length} 个规则集`}</small></div><button className="button secondary small" type="button" onClick={() => groupRulesPage ? setGroupRulesPage(null) : closeGroupSettings()}>{groupRulesPage ? '返回设置' : '关闭'}</button></header>
        {!groupRulesPage ? <div className="policy-visual-settings-scroll">
          <section className="policy-visual-settings-section">
            <header><strong>基本设置</strong><span>这些设置只影响当前策略组。</span></header>
            <div className="policy-visual-group-name-field"><label htmlFor="policy-visual-settings-group-name">策略组名称</label><div className="policy-visual-group-name-inputs">
              <StrategyGroupEmojiPicker value={settingsGroupEmoji} disabled={props.busy} onChange={(value) => { setSettingsGroupEmoji(value); setSettingsNameError('') }} />
              <input id="policy-visual-settings-group-name" value={settingsGroupName} disabled={props.busy} onChange={(event) => { setSettingsGroupName(event.target.value); setSettingsNameError('') }} onBlur={() => { if (!settingsGroupName.trim() || !groupNameAvailable(settingsGroupFullName, settingsGroup.id)) setSettingsNameError('请输入不重复的策略组名称。') }} />
            </div></div>
            {settingsNameError && <small className="policy-visual-inline-error">{settingsNameError}</small>}
            <div className="policy-visual-settings-row">
              <div className="policy-visual-kind-control"><span>切换方式</span><div className="policy-visual-segment">{groupKinds.map((kind) => <button key={kind.value} type="button" className={settingsGroup.kind === kind.value ? 'active' : ''} disabled={props.busy} onClick={() => updateGroup(settingsGroup.id, (current) => ({ ...current, kind: kind.value, url: current.url || (kind.value === 'select' ? '' : healthUrl), interval: current.interval || (kind.value === 'select' ? 0 : 300) }))}>{kind.label}</button>)}</div></div>
              {(settingsGroup.kind === 'url-test' || settingsGroup.kind === 'fallback' || settingsGroup.kind === 'load-balance') && <label className="policy-visual-url">测速网址<DropdownSelect value={settingsGroup.url || healthUrl} disabled={props.busy} onValueChange={(url) => updateGroup(settingsGroup.id, (current) => ({ ...current, url }))}>
                <optgroup label="常用测速网址">{healthUrls.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>
                {settingsGroup.url && !healthUrls.some((item) => item.value === settingsGroup.url) && <optgroup label="当前方案已有设置"><option value={settingsGroup.url}>保留当前网址 · {settingsGroup.url}</option></optgroup>}
              </DropdownSelect></label>}
              {(settingsGroup.kind === 'url-test' || settingsGroup.kind === 'fallback' || settingsGroup.kind === 'load-balance') && <label className="policy-visual-interval">测速间隔<DropdownSelect value={String(settingsGroup.interval || 300)} disabled={props.busy} onValueChange={(interval) => updateGroup(settingsGroup.id, (current) => ({ ...current, interval: Number(interval) }))}>
                <optgroup label="常用间隔">{healthIntervals.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>
                {!healthIntervals.some((item) => item.value === (settingsGroup.interval || 300)) && <optgroup label="当前方案已有设置"><option value={settingsGroup.interval}>保留当前间隔 · {settingsGroup.interval} 秒</option></optgroup>}
              </DropdownSelect></label>}
            </div>
            {settingsGroup.filter.trim() && <div className="policy-visual-filter-note">保留的自动筛选条件：<code>{settingsGroup.filter}</code></div>}
          </section>
          <div className="policy-visual-rule-entry-grid">
            <button className="policy-visual-rule-entry" type="button" disabled={props.busy} onClick={() => openGroupRules('single-rules')}>
              <span><strong>网站 / IP / 应用规则</strong><small>添加单条匹配条件并调整顺序</small></span><b>{settingsGroupSingleRules.length} 条规则　›</b>
            </button>
            <button className="policy-visual-rule-entry" type="button" disabled={props.busy} onClick={() => openGroupRules('rule-sets')}>
              <span><strong>规则集</strong><small>从规则集库添加或移除引用</small></span><b>{settingsGroupRuleSets.length} 个规则集　›</b>
            </button>
          </div>
          <section className="policy-visual-rule-manager-section policy-visual-inline-keyword-checker">
            <header><div><strong>关键词验证</strong><span>在当前策略组的自定义规则和已引用规则集中查找匹配内容。</span></div><b>{settingsGroupSingleRules.length} 条自定义规则 · {settingsGroupRuleSets.length} 个规则集</b></header>
            <label className="policy-visual-keyword-input"><span>输入要查找的关键词</span><input type="search" value={groupRuleQuery} placeholder="例如 openai.com" onChange={(event) => setGroupRuleQuery(event.target.value)} /></label>
            {!groupRuleQueryNormalized ? <div className="policy-visual-keyword-hint">输入关键词后同时搜索当前组的单条自定义规则和已引用规则集本地内容。</div> : <>
              <div className="policy-visual-keyword-summary" aria-live="polite">自定义规则命中 {currentGroupManualRuleMatches.length} 条 · 规则集命中 {currentGroupRuleSetMatches.length} 个规则集、{currentGroupRuleSetMatchCount} 条规则</div>
              {(currentGroupIncompleteRuleSetCount > 0 || currentGroupMissingRuleSetCount > 0) && <div className="policy-visual-keyword-warning">{currentGroupIncompleteRuleSetCount > 0 && <span>{currentGroupIncompleteRuleSetCount} 个已引用规则集本地内容未完整同步或为 MRS，未命中结果不代表其中没有该关键词。</span>}{currentGroupMissingRuleSetCount > 0 && <span>{currentGroupMissingRuleSetCount} 个已引用规则集不在本地库中，无法检查其内容。</span>}</div>}
              <div className="policy-visual-keyword-columns">
                <section className="policy-visual-keyword-group"><header><strong>自定义规则</strong><span>{currentGroupManualRuleMatches.length} 条命中</span></header>{currentGroupManualRuleMatches.length ? <div className="policy-visual-keyword-results">{currentGroupManualRuleMatches.map(({ rule, index }) => <article className="policy-visual-keyword-result" key={`${settingsGroup.id}-keyword-rule-${index}`}><code><span>{rule.kind}</span> · {highlightRuleMatch(rule.value, groupRuleQuery.trim())}</code></article>)}</div> : <small>当前组的自定义规则中没有匹配项。</small>}</section>
                <section className="policy-visual-keyword-group"><header><strong>规则集</strong><span>{currentGroupRuleSetMatches.length} 个规则集 · {currentGroupRuleSetMatchCount} 条命中</span></header>{currentGroupRuleSetMatches.length ? <div className="policy-visual-keyword-results">{currentGroupRuleSetMatches.map(({ item, complete, matches }) => <article className="policy-visual-keyword-result" key={item.id}><header><strong>{item.name}</strong><span>{matches.length} 条匹配</span></header><div>{matches.slice(0, 8).map((entry, index) => <code key={`${item.id}-keyword-${index}`}>{highlightRuleMatch(entry, groupRuleQuery.trim())}</code>)}{matches.length > 8 && <small>另有 {matches.length - 8} 条匹配</small>}{!complete && <small>本地内容不完整，以上结果只覆盖可读部分。</small>}</div></article>)}</div> : <small>当前组已引用规则集的本地可读内容中没有匹配项。</small>}</section>
              </div>
            </>}
          </section>
        </div> : <div className={`policy-visual-settings-scroll policy-visual-rule-manager${groupRulesPage === 'rule-sets' ? ' policy-visual-ruleset-page' : ''}`}>
          {groupRulesPage === 'single-rules' ? <>
            <section className="policy-visual-rule-manager-section">
              <header><div><strong>已添加的单条规则</strong><span>这里只显示网站、IP 和应用条件；拖动可调整这些规则的匹配顺序。</span></div><b>{settingsGroupSingleRules.length} 条</b></header>
              {settingsGroupSingleRules.length ? <div className="policy-visual-rule-list">{settingsGroupSingleRules.map(({ rule, index }, position) => <div key={`${settingsGroup.id}-${index}-${rule.kind}-${rule.value}`} className="policy-visual-rule-row policy-visual-rule-row-single" draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-cfm-rule-index', String(index)); event.dataTransfer.setData('text/plain', `cfm-rule:${index}`); event.dataTransfer.effectAllowed = 'move' }} onDragOver={(event) => { const types = Array.from(event.dataTransfer.types); if (types.includes('application/x-cfm-rule-index') || types.includes('text/plain')) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); const payload = event.dataTransfer.getData('text/plain'); const rawIndex = event.dataTransfer.getData('application/x-cfm-rule-index') || (payload.startsWith('cfm-rule:') ? payload.slice('cfm-rule:'.length) : ''); const from = Number(rawIndex); if (Number.isInteger(from)) reorderGroupRules(from, index, settingsGroup.name, false) }}>
                <span className="policy-visual-rule-order">{String(position + 1).padStart(2, '0')}</span><span className="policy-visual-rule-type">{ruleKindLabel(rule.kind)}</span><span className="policy-visual-rule-detail" title={rule.value}>{rule.value}</span>
                <button className="policy-visual-icon-button" type="button" title="删除规则；按住 Shift 点击可直接删除" aria-label="删除规则" disabled={props.busy} onClick={(event) => deleteRule(index, event.shiftKey)}>×</button>
              </div>)}</div> : <div className="policy-visual-placeholder">还没有单条规则。可在下方添加网站、IP 或应用条件。</div>}
            </section>
            <section className="policy-visual-rule-manager-section">
              <header>
                <div><strong>添加规则</strong><span>为「{settingsGroup.name}」添加网站、IP 或应用匹配条件。</span></div>
                <div className="policy-visual-rule-entry-tabs" role="group" aria-label="规则添加方式">
                  <button type="button" aria-pressed={ruleEntryMode === 'single'} className={ruleEntryMode === 'single' ? 'active' : ''} disabled={props.busy} onClick={() => setRuleEntryModes((current) => ({ ...current, [settingsGroup.id]: 'single' }))}>单条</button>
                  <button type="button" aria-pressed={ruleEntryMode === 'batch'} className={ruleEntryMode === 'batch' ? 'active' : ''} disabled={props.busy} onClick={() => setRuleEntryModes((current) => ({ ...current, [settingsGroup.id]: 'batch' }))}>批量</button>
                </div>
              </header>
              <div className={'policy-visual-add-rule' + (ruleEntryMode === 'batch' ? ' is-batch' : '')}>
                <label>规则类型<DropdownSelect value={selectedRuleKind.value} onValueChange={(kind) => {
                  setRuleKindsByGroup((current) => ({ ...current, [settingsGroup.id]: kind }))
                  setRuleErrors((current) => ({ ...current, [settingsGroup.id]: '' }))
                  setBatchRuleFeedback((current) => { const next = { ...current }; delete next[settingsGroup.id]; return next })
                }}>{ruleKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</DropdownSelect></label>
                {ruleEntryMode === 'batch' ? <label className="policy-visual-rule-value policy-visual-rule-batch-value"><span>匹配内容 · 每行一条</span><textarea rows={5} value={batchRuleInputs[settingsGroup.id] ?? ''} disabled={props.busy} spellCheck={false} placeholder={`每行填写一条${selectedRuleKind.label}条件，例如：\n${selectedRuleKind.placeholder.replace(/^例如[：:]\s*/, '')}`} aria-describedby={`policy-visual-rule-hint-${settingsGroup.id}`} onChange={(event) => {
                  setBatchRuleInputs((current) => ({ ...current, [settingsGroup.id]: event.target.value }))
                  setBatchRuleFeedback((current) => { const next = { ...current }; delete next[settingsGroup.id]; return next })
                }} /><small className="policy-visual-rule-hint" id={`policy-visual-rule-hint-${settingsGroup.id}`}>{selectedRuleKind.hint} 空行会忽略，重复项会跳过。</small></label>
                  : <label className="policy-visual-rule-value">匹配内容<input value={ruleInputs[settingsGroup.id] ?? ''} disabled={props.busy} placeholder={selectedRuleKind.placeholder} aria-describedby={`policy-visual-rule-hint-${settingsGroup.id}`} onChange={(event) => setRuleInputs((current) => ({ ...current, [settingsGroup.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addManualRule(settingsGroup) } }} /><small className="policy-visual-rule-hint" id={`policy-visual-rule-hint-${settingsGroup.id}`}>{selectedRuleKind.hint}</small></label>}
                <button className="button secondary" type="button" disabled={props.busy} onClick={() => ruleEntryMode === 'batch' ? addManualRulesBatch(settingsGroup) : addManualRule(settingsGroup)}>{ruleEntryMode === 'batch' ? `批量添加${batchRuleLineCount ? ` ${batchRuleLineCount} 条` : ''}` : '添加规则'}</button>
                {ruleEntryMode === 'batch' && batchRuleFeedback[settingsGroup.id] && <div className="policy-visual-batch-feedback" role="status"><strong>{batchRuleFeedback[settingsGroup.id].summary}</strong>{batchRuleFeedback[settingsGroup.id].details.length > 0 && <ul>{batchRuleFeedback[settingsGroup.id].details.map((detail, index) => <li key={`${settingsGroup.id}-batch-error-${index}`}>{detail}</li>)}</ul>}</div>}
                {ruleEntryMode === 'single' && ruleErrors[settingsGroup.id] && <small className="policy-visual-inline-error">{ruleErrors[settingsGroup.id]}</small>}
              </div>
            </section>
          </> : <>
            <section className="policy-visual-rule-manager-section policy-visual-ruleset-library">
              <header><div><strong>规则集目录</strong><span>显示全部可用规则集；当前组已引用项默认勾选，取消勾选可移除，底部按钮应用勾选变化。</span></div><b>{props.ruleSets.length} 个可用</b></header>
              {props.ruleSets.length ? <>
                <div className="policy-visual-ruleset-content">
                <div className="ruleset-catalog-filter-row policy-visual-ruleset-source-filter" role="group" aria-label="按规则来源筛选">
                  <span>来源</span>
                  <div className="ruleset-mode-switch">
                    {ruleSetSourceFilters.map(({ value, label }) => <button key={value} type="button" className={ruleSetSourceFilter === value ? 'active' : ''} aria-pressed={ruleSetSourceFilter === value} disabled={props.busy} onClick={() => setRuleSetSourceFilter(value)}>{label}</button>)}
                  </div>
                </div>
                <div className="policy-visual-ruleset-categories" role="tablist" aria-label="按规则用途筛选">
                  {ruleSetCategories.map((category) => <button key={category.value} type="button" role="tab" aria-selected={ruleSetCategory === category.value} className={ruleSetCategory === category.value ? 'active' : ''} onClick={() => setRuleSetCategory(category.value)}>{category.label}<span>{categoryRuleSetCount(category.value)}</span></button>)}
                </div>
                <div className="policy-visual-ruleset-search">
                  <label><span>按标题或规则内容筛选</span><input type="search" value={ruleSetQuery} placeholder="输入标题或规则内容，例如 CDN、openai.com" onChange={(event) => setRuleSetQuery(event.target.value)} /></label>
                  {normalizedRuleSetQuery && <div className="policy-visual-ruleset-search-summary" aria-live="polite">
                    <span>标题或规则内容命中 {visibleRuleSets.length} 个规则集 · 规则内容命中 {visibleMatchCount} 条</span>
                    {visibleIncompleteCount > 0 && <small>当前筛选中有 {visibleIncompleteCount} 个规则集内容未完整同步或为 MRS，结果仅覆盖本地可读规则。</small>}
                  </div>}
                </div>
                <div className="policy-visual-ruleset-scroll"><div className="policy-visual-ruleset-list">{visibleRuleSets.map((item) => {
                  const alreadyAdded = settingsGroupRuleSets.some(({ rule }) => rule.value === item.id)
                  const selectedForGroup = selectedRuleSets[settingsGroup.id] ?? new Set<string>()
                  const selected = selectedForGroup.has(item.id)
                  const pendingRemoval = alreadyAdded && !selected
                  const count = item.entryCount ?? item.remoteEntries?.length ?? item.sample?.length
                  const matches = ruleSetMatches.get(item.id) ?? []
                  return <article key={item.id} className={`policy-visual-ruleset-option${selected ? ' selected' : ''}${alreadyAdded && selected ? ' applied' : ''}${pendingRemoval ? ' pending-removal' : ''}`}>
                    <button className="policy-visual-ruleset-select" type="button" disabled={props.busy} aria-pressed={selected} aria-label={`${selected ? '取消选择' : '选择'}规则集 ${item.name}`} onClick={() => setSelectedRuleSets((current) => { const next = new Set(current[settingsGroup.id] ?? []); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return { ...current, [settingsGroup.id]: next } })}>
                      <span className={`policy-visual-option-mark${selected ? ' is-checked' : ''}`} aria-hidden="true" /><span className="policy-visual-ruleset-copy"><strong title={item.name}>{normalizedRuleSetQuery ? highlightRuleMatch(item.name, normalizedRuleSetQuery) : item.name}</strong><small title={`${count ?? '数量未知'} 条 · ${ruleSetPurpose(item)}`}>{count ?? '数量未知'} 条 · {ruleSetPurpose(item)}</small><small className="policy-visual-ruleset-source" title={`来源：${ruleSetPublisher(item)}`}>来源：{ruleSetPublisher(item)}</small></span>
                    </button>
                    <button className="policy-visual-ruleset-details" type="button" aria-label={`查看 ${item.name} 详情`} onClick={() => setRuleSetDetailsId(item.id)}>详情</button>
                    {normalizedRuleSetQuery && matches.length > 0 && <div className="policy-visual-ruleset-match-lines"><small>命中 {matches.length} 条规则</small>{matches.slice(0, 3).map((entry, index) => <code key={`${item.id}-match-${index}`} title={entry}>{highlightRuleMatch(entry, normalizedRuleSetQuery)}</code>)}{matches.length > 3 && <span>还有 {matches.length - 3} 条命中</span>}{!ruleSetSearchContents.get(item.id)?.complete && <span>规则内容不完整，命中仅基于本地可读部分</span>}</div>}
                  </article>
                })}{visibleRuleSets.length === 0 && <div className="policy-visual-ruleset-empty-state"><strong>{normalizedRuleSetQuery ? `当前来源和用途筛选下的规则集标题或本地可读规则中没有找到“${ruleSetQuery.trim()}”` : '当前来源和用途筛选下暂无规则集'}</strong>{normalizedRuleSetQuery && visibleIncompleteCount > 0 && <span>{visibleIncompleteCount} 个规则集内容未完整同步或为 MRS，无法确认其中是否有匹配项。</span>}</div>}</div></div>
                <footer className="policy-visual-ruleset-actions"><div><strong aria-live="polite">{ruleSetSelectionChanged ? `待应用：新增 ${addedRuleSetCount} 个 · 移除 ${removedRuleSetCount} 个${addedRuleSetCount === 0 && removedRuleSetCount === 0 ? ' · 调整顺序' : ''}` : currentRuleSetIds.length ? `当前组已有 ${currentRuleSetIds.length} 个规则集` : '当前未选择规则集'}</strong><span>取消勾选可移除；新勾选按顺序加入，取消后重选可将已有项排到末尾。</span></div></footer>
                </div>
              </> : <div className="policy-visual-ruleset-empty-state"><strong>规则集库目前为空</strong><span>先到左侧“规则集库”添加规则集，再回到这里分配给当前策略组。</span></div>}
            </section>
          </>}
        </div>}
        <footer><span>{groupRulesPage ? '规则修改会应用到当前方案草稿，仍需点击“保存方案”提交。' : '组内成员在工作区管理；关闭窗口后再点击“保存方案”提交修改。'}</span><button className="button primary" type="button" disabled={props.busy || (!groupRulesPage && (!settingsGroupName.trim() || !groupNameAvailable(settingsGroupFullName, settingsGroup.id)))} onClick={() => groupRulesPage ? finishGroupRulesPage() : closeGroupSettings()}>{groupRulesPage === 'single-rules' ? '完成规则管理' : groupRulesPage === 'rule-sets' ? ruleSetSelectionChanged ? '应用并返回设置' : '返回设置' : '完成'}</button></footer>
      </section>
      {ruleSetDetails && <RuleSetDetailsDialog key={ruleSetDetails.id} item={ruleSetDetails} onClose={() => setRuleSetDetailsId('')} />}
    </div>}

    {autoSettingsGroup && autoSettings && <div className="policy-visual-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAutoGroupSettingsId('') }}>
      <section className="policy-visual-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="policy-visual-auto-settings-title">
        <header><div><span className="eyebrow">AUTOMATIC ROUTE SETTINGS</span><strong id="policy-visual-auto-settings-title">设置「{autoSettingsGroup.name}」</strong><small>节点成员按该订阅当前节点自动生成，订阅更新后同步变化。</small></div><button className="button secondary small" type="button" onClick={() => setAutoGroupSettingsId('')}>关闭</button></header>
        <div className="policy-visual-settings-scroll">
          <section className="policy-visual-settings-section">
            <header><strong>线路设置</strong><span>保存到当前策略方案。</span></header>
            <div className="policy-visual-settings-row">
              <div className="policy-visual-kind-control"><span>切换方式</span><div className="policy-visual-segment">{groupKinds.map((kind) => <button key={kind.value} type="button" className={autoSettings.kind === kind.value ? 'active' : ''} disabled={props.busy} onClick={() => updateAutoGroupSettings(autoSettingsGroup.id, (current) => ({ ...current, kind: kind.value, url: current.url || (kind.value === 'select' ? '' : healthUrl), interval: current.interval || (kind.value === 'select' ? 0 : 300) }))}>{kind.label}</button>)}</div></div>
              {(autoSettings.kind === 'url-test' || autoSettings.kind === 'fallback' || autoSettings.kind === 'load-balance') && <label className="policy-visual-url">测速网址<DropdownSelect value={autoSettings.url || healthUrl} disabled={props.busy} onValueChange={(url) => updateAutoGroupSettings(autoSettingsGroup.id, (current) => ({ ...current, url }))}>
                <optgroup label="常用测速网址">{healthUrls.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>
                {autoSettings.url && !healthUrls.some((item) => item.value === autoSettings.url) && <optgroup label="当前方案已有设置"><option value={autoSettings.url}>保留当前网址 · {autoSettings.url}</option></optgroup>}
              </DropdownSelect></label>}
              {(autoSettings.kind === 'url-test' || autoSettings.kind === 'fallback' || autoSettings.kind === 'load-balance') && <label className="policy-visual-interval">测速间隔<DropdownSelect value={String(autoSettings.interval || 300)} disabled={props.busy} onValueChange={(interval) => updateAutoGroupSettings(autoSettingsGroup.id, (current) => ({ ...current, interval: Number(interval) }))}>
                <optgroup label="常用间隔">{healthIntervals.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>
                {!healthIntervals.some((item) => item.value === (autoSettings.interval || 300)) && <optgroup label="当前方案已有设置"><option value={autoSettings.interval}>保留当前间隔 · {autoSettings.interval} 秒</option></optgroup>}
              </DropdownSelect></label>}
              {autoSettings.kind === 'select' && <label className="policy-visual-url policy-visual-auto-default-member">默认成员<DropdownSelect aria-label="自动地区线路默认成员" value={autoSettings.defaultSelected ?? ''} disabled={props.busy} onValueChange={(defaultSelected) => updateAutoGroupSettings(autoSettingsGroup.id, (current) => ({ ...current, defaultSelected: defaultSelected || undefined }))}>
                <option value="">组内首项（Mihomo 默认）</option>
                {autoSettings.defaultSelected && !autoSettingsGroup.nodes.includes(autoSettings.defaultSelected) && <option value={autoSettings.defaultSelected}>暂不在线 · {autoSettings.defaultSelected}</option>}
                <optgroup label="当前节点">{[...new Set(autoSettingsGroup.nodes)].map((name) => <option key={name} value={name}>{name}</option>)}</optgroup>
              </DropdownSelect></label>}
            </div>
            <div className="policy-visual-auto-route-summary"><strong>当前成员</strong><span>{autoSettingsGroup.nodes.length} 个节点 · {autoSettingsGroup.provider}{autoSettingsGroup.country ? ` · ${autoSettingsGroup.country}` : ' · 全部地区'}</span><small>节点列表来自当前订阅数据；方案保存切换方式、测速参数和可选的默认节点。</small></div>
          </section>
        </div>
        <footer><span>设置保存在当前方案草稿；点击“保存方案”提交。</span><button className="button primary" type="button" onClick={() => setAutoGroupSettingsId('')}>完成</button></footer>
      </section>
    </div>}

    {matchRules.length > 1 && <details className="policy-visual-extra-match"><summary>其他 MATCH 规则 <span>{matchRules.length - 1} 条</span></summary><div>{matchRules.slice(0, -1).map(({ rule, index }) => <div className="policy-visual-rule-row" key={`match-${index}`}><span className="policy-visual-rule-order">{String(index + 1).padStart(2, '0')}</span><span className="policy-visual-rule-type">MATCH</span><span className="policy-visual-rule-detail">最终去向：{rule.target}</span><button className="policy-visual-icon-button" type="button" title="删除规则；按住 Shift 点击可直接删除" onClick={(event) => deleteRule(index, event.shiftKey)}>×</button></div>)}</div></details>}

    {dragPreview && <div className="policy-visual-drag-preview" aria-hidden="true" style={{ left: dragPreview.x + 14, top: dragPreview.y + 14 }}><span>{dragPreview.kind === 'range' ? '动态节点范围' : dragPreview.kind === 'scope' ? '动态范围' : dragPreview.kind === 'builtin' ? '内置出站' : dragPreview.kind === 'region' ? '地区线路' : '策略组'}</span>{dragPreview.label}</div>}

    {newGroupOpen && <div className="policy-visual-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewGroupOpen(false) }}><form className="policy-visual-create-dialog" role="dialog" aria-modal="true" aria-labelledby="policy-visual-create-title" onSubmit={createGroup}>
      <header><strong id="policy-visual-create-title">新建策略组</strong><button type="button" aria-label="关闭" onClick={() => setNewGroupOpen(false)}>×</button></header>
      <div className="policy-visual-create-name-field"><label htmlFor="policy-visual-new-group-name">策略组名称</label><div className="policy-visual-group-name-inputs">
        <StrategyGroupEmojiPicker value={newGroupEmoji} onChange={setNewGroupEmoji} />
        <input id="policy-visual-new-group-name" autoFocus value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="例如：AI 服务" />
      </div></div>
      {!groupNameAvailable(newGroupFullName) && <small className="policy-visual-inline-error">请输入不重复的策略组名称。</small>}
      <footer><button className="button secondary" type="button" onClick={() => setNewGroupOpen(false)}>取消</button><button className="button primary" type="submit" disabled={!newGroupName.trim() || !groupNameAvailable(newGroupFullName)}>创建并继续</button></footer>
    </form></div>}
  </div>
}
