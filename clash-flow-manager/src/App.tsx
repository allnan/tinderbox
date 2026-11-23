import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type AppSettings, type AppSnapshot, type PolicyConfig, type ProxyNode, type RuleSetItem, type RuleSetPreview, type SavedPolicy, type Source, type SourceSyncProgress, type SourceSyncResult, type SubscriptionInfo, type UnmatchedConnection, type UsageRow, type UsageSummary } from './core/bridge'
import { defaultPolicyPresetId, findPolicyPreset, findPolicyPresetGroup, policyPresetCount, policyPresetGroups } from './core/presetCatalog'
import { resolveRuleSetPurpose, ruleSetPurposeCategories } from './core/ruleSetPurposes'
import { countryGroupDisplayName } from './core/countryFlags'
import { autoGroupNamePartLabels, autoGroupNameSeparators, composeAutoGroupName, defaultAutoGroupNameParts, isValidAutoGroupNameParts, normalizeAutoGroupNameParts } from './core/autoGroupNaming'
import { PolicyVisualWorkspace, RuleSetDetailsDialog } from './PolicyVisualWorkspace'
import { DropdownSelect } from './components/DropdownSelect'
import { RouteCheckPage } from './RouteCheckPage'

type Page = 'sources' | 'policy' | 'rulesets' | 'profile' | 'usage' | 'settings' | 'routecheck'
type Toast = { type: 'success' | 'error'; text: string }
type RuleSetTask = { kind: 'single'; id: string; sync: boolean } | { kind: 'bulk'; sync: boolean; completed: number; total: number }
type SourceSyncTask = SourceSyncProgress & { pending?: boolean }
type PublicRuleSetSource = 'blackmatrix7' | 'acl4ssr' | 'metacubex' | 'loyalsoldier' | 'sukka'
type RuleSetPurposeCategory = (typeof ruleSetPurposeCategories)[number]
type PublicRuleSetPreset = {
  id: string
  name: string
  description: string
  category: RuleSetPurposeCategory
  filename: string
  source: PublicRuleSetSource
  url: string
  behavior: 'auto' | 'domain' | 'ipcidr' | 'classical'
  format: 'auto' | 'text' | 'yaml'
}
type CommunityBatchResult = { presetId: string; name: string; status: 'added' | 'skipped' | 'failed'; detail?: string }
type CommunityBatchProgress = { completed: number; total: number; current: string[]; results: CommunityBatchResult[] }
type CommunityRuleDetails = { item: RuleSetItem; requestId: number; loading: boolean; error: string }
type RuleSetFormProps = {
  initial: RuleSetItem | null
  existingItems: RuleSetItem[]
  busy: boolean
  preview: (url: string, behavior: string, format: string) => Promise<RuleSetPreview>
  save: (item: RuleSetItem, downloadedAt: string | null) => Promise<void>
  batchAdd: (presets: PublicRuleSetPreset[], report: (progress: CommunityBatchProgress) => void) => Promise<CommunityBatchResult[]>
  cancel: () => void
}
type AppDialogModel = { title: string; message: string; confirmLabel: string; cancelLabel: string | null; destructive: boolean }
type ConfirmOptions = { title?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }
type ConfirmAction = (message: string, options?: ConfirmOptions) => Promise<boolean>
type NoticeAction = (message: string, title?: string) => Promise<void>

const defaultPreset = findPolicyPreset(defaultPolicyPresetId)
const manualRuleKinds = [
  { value: 'DOMAIN-SUFFIX', label: '网站及子域名' },
  { value: 'DOMAIN', label: '单个完整域名' },
  { value: 'DOMAIN-KEYWORD', label: '域名关键词' },
  { value: 'IP-CIDR', label: 'IPv4 网段' },
  { value: 'IP-CIDR6', label: 'IPv6 网段' },
  { value: 'PROCESS-NAME', label: '应用 / 进程名称' },
  { value: 'PROCESS-PATH', label: '应用程序路径' },
  { value: 'GEOSITE', label: '网站分类' },
  { value: 'GEOIP', label: '目标国家 / 地区' },
]
const publicRuleSetSources: Record<PublicRuleSetSource, { label: string; name: string; url: string; base: string; behavior: PublicRuleSetPreset['behavior']; format: PublicRuleSetPreset['format'] }> = {
  blackmatrix7: { label: 'blackmatrix7', name: 'blackmatrix7 / ios_rule_script', url: 'https://github.com/blackmatrix7/ios_rule_script', base: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/', behavior: 'auto', format: 'auto' },
  acl4ssr: { label: 'ACL4SSR', name: 'ACL4SSR', url: 'https://github.com/ACL4SSR/ACL4SSR', base: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/', behavior: 'auto', format: 'auto' },
  metacubex: { label: 'MetaCubeX', name: 'MetaCubeX / meta-rules-dat', url: 'https://github.com/MetaCubeX/meta-rules-dat', base: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/', behavior: 'domain', format: 'text' },
  loyalsoldier: { label: 'Loyalsoldier', name: 'Loyalsoldier / clash-rules', url: 'https://github.com/Loyalsoldier/clash-rules', base: 'https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/', behavior: 'domain', format: 'yaml' },
  sukka: { label: 'Sukka', name: 'Sukka / Surge', url: 'https://ruleset.skk.moe/', base: 'https://ruleset.skk.moe/Clash/', behavior: 'classical', format: 'text' },
}
const publicRuleSetSourceOptions: { source: PublicRuleSetSource | null; label: string }[] = [
  { source: null, label: '全部来源' },
  ...Object.entries(publicRuleSetSources).map(([source, item]) => ({ source: source as PublicRuleSetSource, label: item.label })),
]
type RangePreset = 'today' | '7d' | '30d' | 'custom'
type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks5h' | 'direct'
type ProxyForm = { protocol: ProxyProtocol; host: string; port: string; auth: string }
const nodeNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function sortProxyNodes(nodes: ProxyNode[]): ProxyNode[] {
  return [...nodes].sort((a, b) => {
    const countryA = a.country.trim()
    const countryB = b.country.trim()
    if (!countryA && countryB) return 1
    if (countryA && !countryB) return -1
    return nodeNameCollator.compare(countryA, countryB)
      || nodeNameCollator.compare(a.displayName, b.displayName)
      || a.id.localeCompare(b.id)
  })
}

function parseSubscriptionProxy(value: string): ProxyForm {
  const raw = value.trim()
  const fallback: ProxyForm = { protocol: 'http', host: '127.0.0.1', port: '7897', auth: '' }
  if (!raw || raw.toLowerCase() === 'direct') return { ...fallback, protocol: 'direct' }
  try {
    const url = new URL(raw)
    const protocol = url.protocol.slice(0, -1).toLowerCase() as ProxyProtocol
    if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) return fallback
    const auth = url.username ? `${url.username}${url.password ? ':' + url.password : ''}@` : ''
    return {
      protocol,
      host: url.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
      port: url.port || '7897',
      auth,
    }
  } catch {
    return fallback
  }
}

function formatSubscriptionProxy(form: ProxyForm): string {
  if (form.protocol === 'direct') return 'direct'
  const host = form.host.trim() || '127.0.0.1'
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${form.protocol}://${form.auth}${formattedHost}:${form.port.trim()}`
}

function localDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function backupFileName(date: Date): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join('')
  return `ClashFlowManager-完整备份-${localDateInput(date)}-${time}.json`
}

function freshSource(): Source {
  return { id: crypto.randomUUID(), name: '', prefix: '', url: '', enabled: true, includePrefix: true, includeFlag: true, includeCountry: true, includeOriginalName: true, regionHint: '', nodeCount: 0, lastUpdated: '', lastError: '' }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return value.toFixed(unit > 1 ? 2 : 1) + ' ' + units[unit]
}

function formatAxisBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return Math.round(value) + ' ' + units[unit]
}

function shortTime(value: string): string {
  if (!value) return '尚未更新'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function relativeTime(value: string): string {
  if (!value) return '尚未更新'
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return value
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

function suggestedPolicyName(policies: SavedPolicy[]): string {
  const names = new Set(policies.map((policy) => policy.name.trim().toLocaleLowerCase()))
  const base = '自定义策略'
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${base} ${suffix}`
}

function rowsFor(summary: UsageSummary, mode: string): UsageRow[] {
  if (mode === 'detail') return summary.byDetail ?? []
  if (mode === 'node') return summary.byNode
  if (mode === 'provider') return summary.byProvider
  if (mode === 'group') return summary.byGroup
  if (mode === 'rule') return summary.byRule
  return summary.bySite
}

function csvCell(value: string): string {
  const safeValue = /^[\t\r=+\-@]/.test(value) ? `'${value}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}

function exportUnmatchedConnections(records: UnmatchedConnection[], from: string, to: string) {
  const columns = [
    ['发现时间', (record: UnmatchedConnection) => record.detectedAt],
    ['连接开始时间', (record: UnmatchedConnection) => record.startedAt],
    ['站点', (record: UnmatchedConnection) => record.site],
    ['目标 IP', (record: UnmatchedConnection) => record.destinationIp],
    ['目标端口', (record: UnmatchedConnection) => record.destinationPort],
    ['来源 IP', (record: UnmatchedConnection) => record.sourceIp],
    ['来源端口', (record: UnmatchedConnection) => record.sourcePort],
    ['网络', (record: UnmatchedConnection) => record.network],
    ['应用', (record: UnmatchedConnection) => record.process],
    ['应用路径', (record: UnmatchedConnection) => record.processPath],
    ['入站', (record: UnmatchedConnection) => record.inbound],
    ['匹配规则', () => 'MATCH'],
    ['兜底去向', (record: UnmatchedConnection) => record.fallbackTarget],
    ['代理链', (record: UnmatchedConnection) => record.proxyChain.join(' → ')],
    ['连接 ID', (record: UnmatchedConnection) => record.connectionId],
  ] as const
  const lines = [
    columns.map(([label]) => csvCell(label)).join(','),
    ...records.map((record) => columns.map(([, value]) => csvCell(value(record))).join(',')),
  ]
  const blobUrl = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = `mihomo-unmatched-${from || localDateInput(new Date())}_to_${to || localDateInput(new Date())}.csv`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
}

export function App() {
  const [page, setPage] = useState<Page>('sources')
  const contentRef = useRef<HTMLElement | null>(null)
  const [topbarActionHost, setTopbarActionHost] = useState<HTMLDivElement | null>(null)
  const [topbarInfoHost, setTopbarInfoHost] = useState<HTMLDivElement | null>(null)
  const dialogConfirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogCancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const latestSnapshotRequest = useRef(0)
  const ruleSetBatchLock = useRef(false)
  const sourceSyncCancelRequested = useRef(new Set<string>())
  const activeSourceRefreshIds = useRef(new Set<string>())
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [dialog, setDialog] = useState<AppDialogModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [ruleSetTask, setRuleSetTask] = useState<RuleSetTask | null>(null)
  const [ruleSetEditor, setRuleSetEditor] = useState<{ initial: RuleSetItem | null } | null>(null)
  const [sourceSyncTasks, setSourceSyncTasks] = useState<SourceSyncTask[]>([])
  const [drafts, setDrafts] = useState<Record<string, Source>>({})
  const [collapsedSources, setCollapsedSources] = useState<Record<string, boolean>>({})
  const [newSource, setNewSource] = useState<Source | null>(null)
  const [policyDraft, setPolicyDraft] = useState<PolicyConfig | null>(null)
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null)
  const [collapsedAutoGroupsByPolicy, setCollapsedAutoGroupsByPolicy] = useState<Record<string, boolean>>({})
  const [policyEditorOpen, setPolicyEditorOpen] = useState(false)
  const [presetName, setPresetName] = useState(defaultPreset?.name ?? 'ACL4SSR 全分组 多模式')
  const [presetUrl, setPresetUrl] = useState(defaultPreset?.url ?? '')
  const [presetCatalogId, setPresetCatalogId] = useState(defaultPolicyPresetId)
  const [presetCandidate, setPresetCandidate] = useState<PolicyConfig | null>(null)
  const [policyImportOpen, setPolicyImportOpen] = useState(false)
  const [presetPreviewTab, setPresetPreviewTab] = useState<'groups' | 'rules' | 'providers' | 'raw'>('groups')
  const [presetPreviewOpen, setPresetPreviewOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [controllerMessage, setControllerMessage] = useState('')
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [rangePreset, setRangePreset] = useState<RangePreset>('7d')
  const [usageTab, setUsageTab] = useState('detail')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [unmatchedConnections, setUnmatchedConnections] = useState<UnmatchedConnection[]>([])
  const [trafficStatus, setTrafficStatus] = useState('等待连接 Mihomo')

  useEffect(() => {
    let mounted = true
    const updateMaximizedState = () => {
      void api.isWindowMaximized().then((value) => {
        if (mounted) setWindowMaximized(value)
      }).catch(() => {})
    }
    updateMaximizedState()
    const timer = window.setInterval(updateMaximizedState, 1000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])

  function requestConfirmation(message: string, options: ConfirmOptions = {}): Promise<boolean> {
    return new Promise((resolve) => {
      dialogResolverRef.current?.(false)
      dialogResolverRef.current = resolve
      setDialog({
        title: options.title ?? '确认操作',
        message,
        confirmLabel: options.confirmLabel ?? '确认',
        cancelLabel: options.cancelLabel ?? '取消',
        destructive: options.destructive ?? false,
      })
    })
  }

  function requestNotice(message: string, title = '提示'): Promise<void> {
    return new Promise((resolve) => {
      dialogResolverRef.current?.(false)
      dialogResolverRef.current = () => resolve()
      setDialog({ title, message, confirmLabel: '知道了', cancelLabel: null, destructive: false })
    })
  }

  function finishDialog(confirmed: boolean) {
    const resolve = dialogResolverRef.current
    dialogResolverRef.current = null
    setDialog(null)
    resolve?.(confirmed)
  }

  useEffect(() => {
    if (!dialog) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog.cancelLabel) {
        event.preventDefault()
        finishDialog(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dialog])

  useLayoutEffect(() => {
    if (!dialog) return
    const initialFocus = dialog.cancelLabel ? dialogCancelButtonRef.current : dialogConfirmButtonRef.current
    initialFocus?.focus()
  }, [dialog])

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => event.preventDefault()
    document.addEventListener('contextmenu', preventNativeContextMenu, true)
    return () => document.removeEventListener('contextmenu', preventNativeContextMenu, true)
  }, [])

  async function refreshSnapshot() {
    const request = ++latestSnapshotRequest.current
    const data = await api.snapshot()
    if (request === latestSnapshotRequest.current) setSnapshot(data)
    return data
  }

  async function reload(hydratePolicy = false) {
    const data = await refreshSnapshot()
    setDrafts(Object.fromEntries(data.sources.map((source) => [source.id, { ...source }])))
    if (hydratePolicy) {
      const active = data.policyLibrary?.items.find((item) => item.id === data.policyLibrary.activeId)
      setPolicyDraft(active?.config ?? data.policy)
      setSelectedPolicyId(active?.id ?? null)
    }
    setSettingsDraft(data.settings)
    if (!fromDate || !toDate) {
      const range = await api.defaultRange()
      setFromDate(range[0])
      setToDate(range[1])
      const [summary, unmatched] = await Promise.all([
        api.summary(range[0], range[1]),
        api.unmatchedConnections(range[0], range[1]),
      ])
      setUsage(summary)
      setUnmatchedConnections(unmatched)
      setRangePreset('7d')
    }
  }

  useEffect(() => {
    void reload(true).catch((error) => setToast({ type: 'error', text: String(error) }))
    const refresh = () => { void refreshSnapshot().catch(() => {}) }
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    const poll = () => {
      void api.sourceSyncProgress().then((progress) => {
        if (!active) return
        const activeTaskIds = new Set(progress.map((task) => task.taskId))
        setSourceSyncTasks((current) => [
          ...progress,
          ...current.filter((task) => task.pending && !activeTaskIds.has(task.taskId)),
        ])
      }).catch(() => {})
    }
    poll()
    const timer = window.setInterval(poll, 400)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (page !== 'usage') return
    let active = true
    const refreshStatus = () => {
      void api.trafficStatus().then((status) => { if (active) setTrafficStatus(status) }).catch(() => {})
    }
    refreshStatus()
    const timer = window.setInterval(refreshStatus, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [page])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useLayoutEffect(() => {
    if (page === 'policy') contentRef.current?.scrollTo(0, 0)
  }, [page, policyEditorOpen])

  const totalNodes = snapshot?.nodes.length ?? 0
  const totalUsage = (usage?.upload ?? 0) + (usage?.download ?? 0)
  const enabledSources = snapshot?.sources.filter((source) => source.enabled).length ?? 0
  const generatedGroups = useMemo(() => generatedPolicyGroups(snapshot?.nodes ?? [], snapshot?.sources ?? [], snapshot?.settings.autoGroupNameParts ?? defaultAutoGroupNameParts), [snapshot?.nodes, snapshot?.sources, snapshot?.settings.autoGroupNameParts])
  const selectedSavedPolicy = snapshot?.policyLibrary.items.find((item) => item.id === selectedPolicyId)
  const policyViewKey = selectedPolicyId ?? 'new-policy-draft'
  const autoGroupsCollapsed = collapsedAutoGroupsByPolicy[policyViewKey] ?? false
  const policyDirty = !policyDraft || !selectedPolicyId || !selectedSavedPolicy
    ? Boolean(policyDraft)
    : JSON.stringify(selectedSavedPolicy.config) !== JSON.stringify(policyDraft)
  const heading = useMemo(() => {
    const values: Record<Page, string> = {
      sources: '订阅来源',
      policy: '策略方案',
      rulesets: '规则集库',
      profile: '导入配置',
      usage: '流量分析',
      settings: '设置',
      routecheck: '线路验证',
    }
    return values[page]
  }, [page])
  const workflowVisible = page === 'sources' || page === 'profile' || page === 'usage' || (page === 'policy' && !policyEditorOpen)

  async function runAction(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      await reload()
      setToast({ type: 'success', text: success })
      return true
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function persistRuleSet(item: RuleSetItem, downloadedAt: string | null) {
    const saved = await api.saveRuleSet(item, downloadedAt)
    ++latestSnapshotRequest.current
    setSnapshot((current) => {
      if (!current) return current
      const items = current.ruleSetLibrary.items
      const updated = items.some((item) => item.id === saved.id)
        ? items.map((item) => item.id === saved.id ? saved : item)
        : [...items, saved]
      return { ...current, ruleSetLibrary: { items: updated } }
    })
    return saved
  }

  async function saveRuleSet(item: RuleSetItem, downloadedAt: string | null) {
    setBusy(true)
    try {
      await persistRuleSet(item, downloadedAt)
      setRuleSetEditor(null)
      void refreshSnapshot().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  async function addCommunityRuleSets(presets: PublicRuleSetPreset[], report: (progress: CommunityBatchProgress) => void) {
    if (busy || ruleSetBatchLock.current || presets.length === 0) return []
    ruleSetBatchLock.current = true
    setBusy(true)
    const results: Array<CommunityBatchResult | undefined> = Array.from({ length: presets.length })
    const savedItems = snapshot?.ruleSetLibrary.items ?? []
    const knownUrls = new Set(savedItems.map((item) => typeof item.provider.url === 'string' ? item.provider.url.trim() : '').filter(Boolean))
    const knownNames = new Set(savedItems.map((item) => item.name.trim().toLocaleLowerCase()).filter(Boolean))
    const reservedUrls = new Set(knownUrls)
    const reservedNames = new Set(knownNames)
    const pending: number[] = []
    const active = new Set<string>()
    let completed = 0

    const publish = () => report({
      completed,
      total: presets.length,
      current: [...active],
      results: results.filter((result): result is CommunityBatchResult => Boolean(result)),
    })

    presets.forEach((preset, index) => {
      const normalizedUrl = preset.url.trim()
      const normalizedName = preset.name.trim().toLocaleLowerCase()
      if (reservedUrls.has(normalizedUrl)) {
        results[index] = { presetId: preset.id, name: preset.name, status: 'skipped', detail: '相同网址的规则集已存在。' }
        completed += 1
        return
      }
      if (reservedNames.has(normalizedName)) {
        results[index] = { presetId: preset.id, name: preset.name, status: 'skipped', detail: '同名规则集已存在。' }
        completed += 1
        return
      }
      reservedUrls.add(normalizedUrl)
      reservedNames.add(normalizedName)
      pending.push(index)
    })
    publish()

    let cursor = 0
    async function worker() {
      while (cursor < pending.length) {
        const index = cursor++
        const preset = presets[index]
        active.add(preset.name)
        publish()
        try {
          const preview = await api.previewRuleSet(preset.url, preset.behavior, preset.format)
          const item: RuleSetItem = {
            id: '',
            name: preset.name,
            category: preset.category,
            provider: { type: 'http', url: preset.url, behavior: preview.behavior, format: preview.format, interval: 86400 },
            description: preset.description,
            remoteEntries: preview.entries,
            localAdditions: [],
            excludedEntries: [],
            entryCount: preview.entryCount,
            sample: preview.sample,
            checkedAt: '',
            syncedAt: '',
            updateAvailable: null,
            mrsHash: preview.mrsHash,
            updatedAt: '',
          }
          await persistRuleSet(item, preview.downloadedAt || null)
          results[index] = { presetId: preset.id, name: preset.name, status: 'added' }
        } catch (cause) {
          const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/, '')
          results[index] = { presetId: preset.id, name: preset.name, status: 'failed', detail }
        } finally {
          active.delete(preset.name)
          completed += 1
          publish()
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
      await refreshSnapshot().catch(() => {})
      return results.filter((result): result is CommunityBatchResult => Boolean(result))
    } finally {
      ruleSetBatchLock.current = false
      setBusy(false)
    }
  }

  async function refreshRuleSet(item: RuleSetItem, sync: boolean) {
    if (busy) return
    setBusy(true)
    setRuleSetTask({ kind: 'single', id: item.id, sync })
    try {
      const changed = await api.refreshRuleSet(item.id, sync)
      await refreshSnapshot().catch(() => {})
      if (sync) setToast({ type: 'success', text: changed === false ? '同步完成，规则内容没有变化' : '规则集已同步' })
    } catch (error) {
      setToast({ type: 'error', text: (sync ? '同步更新失败：' : '检查更新失败：') + String(error) })
    } finally {
      setRuleSetTask(null)
      setBusy(false)
    }
  }

  async function refreshAllRuleSets(sync: boolean) {
    if (busy || !snapshot) return
    const targets = snapshot.ruleSetLibrary.items.filter(canRefreshRuleSet)
    if (targets.length === 0) {
      setToast({ type: 'error', text: '当前没有可检查的在线规则集。' })
      return
    }

    setBusy(true)
    setRuleSetTask({ kind: 'bulk', sync, completed: 0, total: targets.length })
    let completed = 0
    let succeeded = 0
    let failed = 0
    let changedCount = 0
    try {
      for (const item of targets) {
        try {
          const changed = await api.refreshRuleSet(item.id, sync)
          succeeded += 1
          if (changed === true) changedCount += 1
        } catch {
          failed += 1
        }
        completed += 1
        setRuleSetTask({ kind: 'bulk', sync, completed, total: targets.length })
      }
      await refreshSnapshot().catch(() => {})
      const summary = sync
        ? `全部同步完成：${succeeded}/${targets.length} 个在线规则集，${changedCount} 个内容有变化。`
        : `全部检查完成：检查了 ${succeeded}/${targets.length} 个在线规则集，发现 ${changedCount} 个有更新。`
      setToast({ type: failed ? 'error' : 'success', text: failed ? `${summary}另有 ${failed} 个失败，可在列表中单项重试。` : summary })
    } finally {
      setRuleSetTask(null)
      setBusy(false)
    }
  }

  function runWindowCommand(action: () => Promise<unknown>) {
    void action().catch((error) => setToast({ type: 'error', text: `窗口操作失败：${String(error)}` }))
  }

  function startWindowDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button === 0) runWindowCommand(api.startDragging)
  }

  function startSourceSyncTracking(
    kind: SourceSyncTask['kind'],
    total: number,
    sourceId: string | null,
    sourceName: string,
    taskId: string,
    origin: SourceSyncTask['origin'],
  ) {
    const task: SourceSyncTask = {
      id: taskId,
      taskId,
      kind,
      origin,
      sourceId,
      active: true,
      cancelRequested: false,
      completed: 0,
      total,
      sourceName,
      phase: '正在准备刷新',
      pending: true,
    }
    setSourceSyncTasks((current) => [...current.filter((item) => item.taskId !== taskId), task])
    return () => setSourceSyncTasks((current) => current.filter((item) => item.taskId !== taskId))
  }

  async function stopSourceSync(taskId: string) {
    if (sourceSyncCancelRequested.current.has(taskId) || sourceSyncTasks.some((task) => task.taskId === taskId && task.pending)) return
    sourceSyncCancelRequested.current.add(taskId)
    setSourceSyncTasks((current) => current.map((task) => task.taskId === taskId ? { ...task, cancelRequested: true, phase: '正在停止刷新…' } : task))
    try {
      await api.cancelSourceSync(taskId)
    } catch (error) {
      sourceSyncCancelRequested.current.delete(taskId)
      setToast({ type: 'error', text: `停止刷新失败：${String(error)}` })
    }
  }

  async function runSyncAction(action: (taskId: string) => Promise<SourceSyncResult>, title: string) {
    if (busy || activeSourceRefreshIds.current.size > 0 || sourceSyncTasks.some((task) => task.active)) return
    const total = snapshot?.sources.filter((source) => source.enabled).length ?? 0
    if (total === 0) {
      setToast({ type: 'error', text: '没有启用的订阅来源，本次未更新节点。' })
      return
    }
    const taskId = `manual-all-${crypto.randomUUID()}`
    const stopTracking = startSourceSyncTracking('all', total, null, '', taskId, 'manual')
    setBusy(true)
    try {
      const result = await action(taskId)
      await reload()
      if (result.errors.length > 0) {
        setToast({
          type: 'error',
          text: `${title}未完全成功：${result.errors.length} 个来源报错，当前节点池有 ${result.nodeCount} 个节点。失败详情见各来源卡片。`,
        })
      } else if (result.sources.some((source) => source.enabled)) {
        setToast({ type: 'success', text: `${title}完成，共 ${result.nodeCount} 个节点。` })
      } else {
        setToast({ type: 'error', text: '没有启用的订阅来源，本次未更新节点。' })
      }
    } catch (error) {
      const message = String(error)
      if (sourceSyncCancelRequested.current.has(taskId) || /已停止刷新/.test(message)) {
        setToast({ type: 'success', text: '订阅刷新已停止；本次结果未写入，原有节点数据已保留。' })
        await refreshSnapshot().catch(() => {})
      } else {
        setToast({ type: 'error', text: message })
      }
    } finally {
      stopTracking()
      sourceSyncCancelRequested.current.delete(taskId)
      setBusy(false)
    }
  }

  async function runSourceSyncAction(source: Source, saveBeforeRefresh = false, closeNewSource = false) {
    if (busy || activeSourceRefreshIds.current.has(source.id) || sourceSyncTasks.some((task) => task.active && task.sourceId === source.id)) return
    activeSourceRefreshIds.current.add(source.id)
    const taskId = `single-${source.id}-${crypto.randomUUID()}`
    const stopTracking = startSourceSyncTracking('single', 1, source.id, source.name, taskId, 'manual')
    try {
      if (saveBeforeRefresh) await api.saveSource(source)
      if (closeNewSource) setNewSource(null)
      const result = await api.syncSource(source.id, taskId)
      await reload()
      const updatedSource = result.sources.find((item) => item.id === source.id)
      if (result.errors.length > 0) {
        setToast({ type: 'error', text: `${source.name} 刷新失败；详情见该订阅卡片。` })
      } else {
        setToast({ type: 'success', text: `${source.name} 刷新完成，共 ${updatedSource?.nodeCount ?? 0} 个节点。` })
      }
    } catch (error) {
      const message = String(error)
      if (sourceSyncCancelRequested.current.has(taskId) || /已停止刷新/.test(message)) {
        setToast({ type: 'success', text: `${source.name} 刷新已停止；原有节点数据已保留。` })
        await refreshSnapshot().catch(() => {})
      } else {
        setToast({ type: 'error', text: message })
      }
    } finally {
      stopTracking()
      activeSourceRefreshIds.current.delete(source.id)
      sourceSyncCancelRequested.current.delete(taskId)
    }
  }

  async function copyTrafficSite(site: string) {
    const value = site.trim()
    if (!value) return
    const address = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
    try {
      await navigator.clipboard.writeText(address)
      setToast({ type: 'success', text: `网站链接已复制：${address}` })
    } catch {
      setToast({ type: 'error', text: '复制失败，请检查剪贴板权限' })
    }
  }

  function updateDraft(id: string, key: keyof Source, value: string | boolean) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }))
  }

  async function refreshUsage(from = fromDate, to = toDate) {
    if (!from || !to) return
    setBusy(true)
    try {
      const [summary, unmatched] = await Promise.all([
        api.summary(from, to),
        api.unmatchedConnections(from, to),
      ])
      setUsage(summary)
      setUnmatchedConnections(unmatched)
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function applyRangePreset(preset: RangePreset) {
    setRangePreset(preset)
    if (preset === 'custom') return
    const end = new Date()
    const start = new Date(end)
    if (preset === '7d') start.setDate(start.getDate() - 6)
    if (preset === '30d') start.setDate(start.getDate() - 29)
    const from = localDateInput(start)
    const to = localDateInput(end)
    setFromDate(from)
    setToDate(to)
    await refreshUsage(from, to)
  }

  async function addSource() {
    if (!newSource) return
    await runSourceSyncAction(newSource, true, true)
  }

  async function savePolicy() {
    if (!policyDraft) return
    const savingActivePolicy = Boolean(selectedPolicyId && selectedPolicyId === snapshot?.policyLibrary.activeId)
    setBusy(true)
    try {
      const result = await api.savePolicy(policyDraft, selectedPolicyId, false)
      const data = await refreshSnapshot()
      setSelectedPolicyId(result.savedId)
      setPolicyDraft(data.policyLibrary.items.find((item) => item.id === result.savedId)?.config ?? policyDraft)
      const savedPolicy = data.policyLibrary.items.find((item) => item.id === result.savedId)
      setToast({ type: 'success', text: savingActivePolicy ? `「${savedPolicy?.name ?? policyDraft.templateName}」已保存并更新当前配置` : `「${savedPolicy?.name ?? policyDraft.templateName}」已保存；当前启用方案未改变` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function saveSettings(nextSettings = settingsDraft, success = '设置已保存') {
    if (!nextSettings) return
    await runAction(() => api.saveSettings(nextSettings), success)
  }

  async function saveProfileName(name: string) {
    if (!snapshot) return
    await runAction(() => api.saveSettings({ ...snapshot.settings, profileName: name }), '配置名称已保存')
  }

  async function setProfileTrafficSource(sourceId: string) {
    if (!snapshot) return
    await runAction(() => api.saveSettings({ ...snapshot.settings, profileTrafficSourceId: sourceId }), sourceId ? 'Clash Verge 流量信息已切换' : '已关闭流量信息显示')
  }

  async function clearTrafficHistory() {
    if (!await requestConfirmation('这会清除本机全部日期的流量统计和未命中记录，无法撤销。继续吗？', { title: '清空流量统计', confirmLabel: '继续', destructive: true })) return
    if (!await requestConfirmation('再次确认：永久删除所有流量统计与未命中历史？', { title: '最终确认清空', confirmLabel: '永久清空', destructive: true })) return
    setBusy(true)
    try {
      const removedFiles = await api.clearTrafficHistory()
      if (fromDate && toDate) {
        const [summary, unmatched] = await Promise.all([api.summary(fromDate, toDate), api.unmatchedConnections(fromDate, toDate)])
        setUsage(summary)
        setUnmatchedConnections(unmatched)
      }
      setToast({ type: 'success', text: `流量统计和未命中记录已清空（删除 ${removedFiles} 个历史文件）` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function exportBackup() {
    setBusy(true)
    try {
      const fileName = backupFileName(new Date())
      const filePath = await saveFileDialog({
        title: '保存 ClashFlowManager 完整备份',
        defaultPath: fileName,
        filters: [{ name: 'ClashFlowManager 完整备份', extensions: ['json'] }],
      })
      if (!filePath) return
      await api.exportBackupTo(filePath)
      const savedName = filePath.split(/[\\/]/).pop() || fileName
      setToast({ type: 'success', text: `完整备份已保存：${savedName}` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function importBackup(file: File) {
    let backup: unknown
    try {
      backup = JSON.parse(await file.text())
    } catch {
      setToast({ type: 'error', text: '备份文件不是有效的 JSON' })
      return
    }
    if (!await requestConfirmation('恢复会覆盖当前所有设置、订阅、节点、策略方案、规则集和流量历史。建议先导出当前备份。继续吗？', { title: '恢复备份', confirmLabel: '继续检查', destructive: true })) return
    if (!await requestConfirmation(`将从「${file.name}」覆盖本机数据，旧数据会被备份内容替换。确定恢复？`, { title: '确认覆盖本机数据', confirmLabel: '恢复并覆盖', destructive: true })) return
    setBusy(true)
    try {
      await api.restoreBackup(backup)
      await reload(true)
      const data = await api.snapshot()
      if (fromDate && toDate) {
        const [summary, unmatched] = await Promise.all([api.summary(fromDate, toDate), api.unmatchedConnections(fromDate, toDate)])
        setUsage(summary)
        setUnmatchedConnections(unmatched)
      }
      setToast({ type: 'success', text: `备份已恢复：${data.sources.length} 个订阅、${data.policyLibrary.items.length} 个方案` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  function openSettings() { setPage('settings') }
  function openDataDirectory() {
    void api.openData().catch((error) => setToast({ type: 'error', text: String(error) }))
  }

  async function fetchPreset() {
    setBusy(true)
    try {
      const policy = await api.fetchPreset(presetName, presetUrl)
      setPresetCandidate(policy)
      setPolicyImportOpen(true)
      setToast({ type: 'success', text: '方案已下载并解析；当前使用配置尚未改变' })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  function selectPresetCatalog(id: string) {
    setPresetCatalogId(id)
    setPresetCandidate(null)
    const preset = findPolicyPreset(id)
    if (!preset) return
    setPresetName(preset.name)
    setPresetUrl(preset.url)
  }

  function updatePresetName(value: string) {
    setPresetName(value)
    setPresetCandidate(null)
  }

  function updatePresetUrl(value: string) {
    if (value !== presetUrl) setPresetCandidate(null)
    setPresetUrl(value)
    const preset = findPolicyPreset(presetCatalogId)
    if (preset && value.trim() !== preset.url) setPresetCatalogId('')
  }

  async function selectSavedPolicy(id: string) {
    if (!snapshot) return false
    const item = snapshot.policyLibrary.items.find((candidate) => candidate.id === id)
    if (!item) return false
    if (item.id === selectedPolicyId) return true
    const current = snapshot.policyLibrary.items.find((candidate) => candidate.id === selectedPolicyId)
    const dirty = !selectedPolicyId || !current || JSON.stringify(current.config) !== JSON.stringify(policyDraft)
    if (dirty && !await requestConfirmation('当前方案有未保存的修改。切换方案会放弃这些修改，是否继续？', { title: '放弃未保存修改', confirmLabel: '继续切换' })) return false
    setSelectedPolicyId(item.id)
    setPolicyDraft(item.config)
    setPresetCandidate(null)
    return true
  }

  async function startBlankPolicy(name: string) {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setToast({ type: 'error', text: '请先填写方案名称' })
      return false
    }
    if (snapshot?.policyLibrary.items.some((item) => item.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
      setToast({ type: 'error', text: '方案名称已存在，请换一个名称' })
      return false
    }
    const current = snapshot?.policyLibrary.items.find((candidate) => candidate.id === selectedPolicyId)
    const dirty = !selectedPolicyId || !current || JSON.stringify(current.config) !== JSON.stringify(policyDraft)
    if (dirty && !await requestConfirmation('当前方案有未保存的修改。新建空白方案会放弃这些修改，是否继续？', { title: '放弃未保存修改', confirmLabel: '继续新建' })) return false
    const blankPolicy: PolicyConfig = { templateName: trimmedName, templateUrl: '', templateContent: '', ruleProviders: {}, groups: [], rules: [], ruleGroupOrder: [], autoGroupSettings: {} }
    setBusy(true)
    try {
      const result = await api.savePolicy(blankPolicy, null, false)
      const savedPolicy = result.library.items.find((item) => item.id === result.savedId)
      if (!savedPolicy) throw new Error('方案已提交保存，但未能读取新建的方案')
      setSnapshot((currentSnapshot) => currentSnapshot ? { ...currentSnapshot, policyLibrary: result.library } : currentSnapshot)
      setSelectedPolicyId(savedPolicy.id)
      setPolicyDraft(savedPolicy.config)
      setPresetCandidate(null)
      setToast({ type: 'success', text: `已创建「${savedPolicy.name}」；当前启用方案未改变` })
      return true
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  function discardPolicyChanges() {
    const selected = snapshot?.policyLibrary.items.find((candidate) => candidate.id === selectedPolicyId)
    if (selected) {
      setPolicyDraft(selected.config)
    } else {
      const active = snapshot?.policyLibrary.items.find((candidate) => candidate.id === snapshot.policyLibrary.activeId)
      setSelectedPolicyId(active?.id ?? null)
      setPolicyDraft(active?.config ?? snapshot?.policy ?? null)
    }
    setPresetCandidate(null)
  }

  async function closePolicyEditor() {
    if (policyDirty && !await requestConfirmation('放弃当前未保存的策略方案修改并返回方案列表？', { title: '返回方案列表', confirmLabel: '放弃修改并返回' })) return
    setPolicyEditorOpen(false)
    setPage('policy')
  }

  async function usePresetCandidate() {
    if (!presetCandidate) return
    const current = snapshot?.policyLibrary.items.find((candidate) => candidate.id === selectedPolicyId)
    const dirty = !selectedPolicyId || !current || JSON.stringify(current.config) !== JSON.stringify(policyDraft)
    if (dirty && !await requestConfirmation('载入线上方案会放弃当前未保存修改，是否继续？', { title: '放弃未保存修改', confirmLabel: '继续载入' })) return
    setBusy(true)
    try {
      const result = await api.savePolicy(presetCandidate, null, false)
      const savedPolicy = result.library.items.find((item) => item.id === result.savedId)
      if (!savedPolicy) throw new Error('方案已提交保存，但未能读取新建的方案')
      setSnapshot((currentSnapshot) => currentSnapshot ? { ...currentSnapshot, policyLibrary: result.library } : currentSnapshot)
      setPolicyDraft(savedPolicy.config)
      setSelectedPolicyId(savedPolicy.id)
      setPresetCandidate(null)
      setPolicyImportOpen(false)
      setPresetPreviewOpen(false)
      setPolicyEditorOpen(true)
      setToast({ type: 'success', text: `已创建「${savedPolicy.name}」；当前启用方案未改变` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function activatePolicy(id: string) {
    if (!snapshot) return
    const item = snapshot.policyLibrary.items.find((candidate) => candidate.id === id)
    if (!item) return
    if (policyDirty && id !== selectedPolicyId && !await requestConfirmation('当前方案有未保存的修改。启用其他方案会放弃这些修改，是否继续？', { title: '放弃未保存修改', confirmLabel: '启用其他方案' })) return
    setBusy(true)
    try {
      await api.activatePolicy(id)
      await refreshSnapshot()
      setSelectedPolicyId(id)
      setPolicyDraft(item.config)
      setToast({ type: 'success', text: `已启用「${item.name}」并更新配置` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function renamePolicy(id: string, name: string): Promise<boolean> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setToast({ type: 'error', text: '方案名称不能为空' })
      return false
    }
    if (selectedPolicyId === id && policyDirty) {
      setToast({ type: 'error', text: '当前方案有未保存修改，请先保存或放弃修改，再重命名' })
      return false
    }
    setBusy(true)
    try {
      await api.renamePolicy(id, trimmedName)
      const data = await refreshSnapshot()
      const renamed = data.policyLibrary.items.find((item) => item.id === id)
      if (selectedPolicyId === id && renamed) setPolicyDraft(renamed.config)
      setToast({ type: 'success', text: `已将方案改名为「${trimmedName}」` })
      return true
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function setPolicyPinned(id: string, pinned: boolean) {
    const item = snapshot?.policyLibrary.items.find((candidate) => candidate.id === id)
    if (!item) return
    setBusy(true)
    try {
      await api.setPolicyPinned(id, pinned)
      await refreshSnapshot()
      setToast({ type: 'success', text: pinned ? `已置顶「${item.name}」` : `已取消置顶「${item.name}」` })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deletePolicy(id: string, skipConfirmation = false) {
    const item = snapshot?.policyLibrary.items.find((candidate) => candidate.id === id)
    if (!item) return
    const selectedChangesWillBeLost = selectedPolicyId === id && policyDirty
    const message = selectedChangesWillBeLost
      ? `删除「${item.name}」并放弃当前未保存修改？\n提示：下次可按住 Shift 点击删除按钮，跳过确认直接删除。`
      : `删除本机方案「${item.name}」？\n提示：下次可按住 Shift 点击删除按钮，跳过确认直接删除。`
    if (!skipConfirmation && !await requestConfirmation(message, { title: '删除策略方案', confirmLabel: '删除方案', destructive: true })) return
    setBusy(true)
    try {
      await api.deletePolicy(id)
      const data = await refreshSnapshot()
      if (selectedPolicyId === id) {
        const active = data.policyLibrary.items.find((candidate) => candidate.id === data.policyLibrary.activeId)
        setSelectedPolicyId(active?.id ?? null)
        setPolicyDraft(active?.config ?? data.policy)
      }
      setToast({ type: 'success', text: '本机方案已删除' })
    } catch (error) {
      setToast({ type: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function checkController() {
    setControllerMessage('正在连接…')
    try {
      const version = await api.controllerCheck(settingsDraft?.controllerUrl ?? '', settingsDraft?.controllerSecret ?? '')
      setControllerMessage('已连接 Mihomo ' + version)
    } catch (error) {
      setControllerMessage(String(error))
    }
  }

  const currentSources = snapshot?.sources ?? []
  async function copyProfileUrl() {
    if (!snapshot?.profileUrl) {
      setToast({ type: 'error', text: '本机配置地址尚未就绪' })
      return
    }
    try {
      await navigator.clipboard.writeText(snapshot.profileUrl)
      setToast({ type: 'success', text: 'Clash Verge 配置地址已复制' })
    } catch {
      setToast({ type: 'error', text: '复制失败，请检查剪贴板权限' })
    }
  }

  return (
    <div className="app-shell">
      <div className="window-titlebar">
        <div className="window-titlebar-brand" onMouseDown={startWindowDrag}>
          <img className="window-titlebar-mark" src="./icon.png" alt="" aria-hidden="true" />
          <span>Clash 订阅与流量管理</span>
        </div>
        <div className="window-titlebar-main">
          <div className="window-titlebar-drag" onMouseDown={startWindowDrag} />
          <div className="window-titlebar-controls">
            <button className="window-titlebar-control" type="button" aria-label="最小化" title="最小化" onClick={() => runWindowCommand(api.minimizeWindow)}><span className="window-control-glyph minimize" /></button>
            <button className="window-titlebar-control" type="button" aria-label={windowMaximized ? '还原' : '最大化'} title={windowMaximized ? '还原' : '最大化'} onClick={() => runWindowCommand(async () => setWindowMaximized(await api.toggleMaximizeWindow()))}><span className={'window-control-glyph ' + (windowMaximized ? 'restore' : 'maximize')} /></button>
            <button className="window-titlebar-control close" type="button" aria-label="关闭到托盘" title="关闭到托盘" onClick={() => runWindowCommand(api.closeWindow)}><span className="window-control-glyph close" /></button>
          </div>
        </div>
      </div>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="./icon.png" alt="" aria-hidden="true" />
          <div><strong>Clash 管家</strong><small>本机订阅与流量</small></div>
        </div>
        <div className="side-label">工作区</div>
        <nav className="nav-list">
          <NavButton active={page === 'sources'} icon="↗" label="订阅来源" count={snapshot?.sources.length} onClick={() => setPage('sources')} />
          <NavButton active={page === 'policy' && !policyEditorOpen} icon="▤" label="策略方案" onClick={() => { if (policyEditorOpen && page === 'policy') void closePolicyEditor(); else setPage('policy') }} />
          <NavButton active={page === 'profile'} icon="⇢" label="导入配置" onClick={() => setPage('profile')} />
          <NavButton active={page === 'usage'} icon="▥" label="流量分析" onClick={() => setPage('usage')} />
        </nav>
        <div className="side-label side-label-bottom">应用</div>
        <nav className="nav-list">
          <NavButton active={page === 'routecheck'} icon="⌕" label="线路验证" onClick={() => setPage('routecheck')} />
          <NavButton active={page === 'rulesets'} icon="▧" label="规则集库" count={snapshot?.ruleSetLibrary.items.length} onClick={() => setPage('rulesets')} />
          <NavButton active={page === 'settings'} icon="⚙" label="设置" onClick={() => setPage('settings')} />
        </nav>
        <div className="sidebar-bottom-stack">
          {policyEditorOpen && policyDraft && <button className={'sidebar-editing-status' + (page === 'policy' ? ' active' : '')} type="button" onClick={() => setPage('policy')} aria-label={`返回编辑方案 ${selectedSavedPolicy?.name ?? policyDraft.templateName ?? ''}`}>
            <span className="sidebar-editing-status-label">编辑状态 <em className={policyDirty ? 'is-dirty' : 'is-editing'}>{policyDirty ? '未保存修改' : '编辑中'}</em></span>
            <strong>{selectedSavedPolicy?.name ?? policyDraft.templateName ?? '未命名方案'}</strong>
            <small>点击返回方案编辑</small>
            <b aria-hidden="true">↗</b>
          </button>}
          <div className="sidebar-footer"><div className="local-pill"><i />本地转换服务运行中</div><span>数据保存在 exe 同级目录</span></div>
        </div>
      </aside>

      <main className="main">
        <header className={'topbar' + (workflowVisible ? ' topbar-with-workflow' : '')}>
          {!workflowVisible && <div className="topbar-main">
            <div className="topbar-leading">
              {page === 'policy' && policyEditorOpen && <button className="button secondary topbar-back-button" type="button" disabled={busy} onClick={() => void closePolicyEditor()}>← 返回方案列表</button>}
              <div className="breadcrumbs"><span>Clash 管家</span><b>/</b><strong>{page === 'policy' && policyEditorOpen ? (selectedSavedPolicy?.name ?? policyDraft?.templateName ?? '策略方案') : heading}</strong>{page === 'policy' && policyEditorOpen && <span className={'topbar-policy-state' + (policyDirty ? ' dirty' : selectedPolicyId === snapshot?.policyLibrary.activeId ? ' active' : '')}>{policyDirty ? '未保存修改' : selectedPolicyId === snapshot?.policyLibrary.activeId ? '当前启用' : '编辑中'}</span>}</div>
              <div className="topbar-info" ref={setTopbarInfoHost} />
            </div>
            <div className="topbar-page-actions" ref={setTopbarActionHost} />
          </div>}
          {workflowVisible && <div className="topbar-workflow"><WorkflowNav page={page} snapshot={snapshot} totalNodes={totalNodes} onNavigate={(nextPage) => setPage(nextPage)} /></div>}
        </header>

        <section className={`content${page === 'policy' && policyEditorOpen ? ' content-policy-editor' : ''}${page === 'sources' ? ' content-sources' : ''}`} ref={contentRef}>
          {page === 'settings' && <div className="page-heading">
            <div><div className="eyebrow">CLASH CONFIGURATION WORKSPACE</div><h1>{heading}</h1></div>
          </div>}

          {page === 'sources' && <SourcePage
            snapshot={snapshot}
            settings={settingsDraft}
            savedSettings={snapshot?.settings ?? null}
            onAutoGroupNamePartsChange={(parts) => setSettingsDraft((current) => current ? { ...current, autoGroupNameParts: parts } : current)}
            saveAutoGroupNameParts={(parts) => {
              const base = snapshot?.settings
              if (base) void runAction(() => api.saveSettings({ ...base, autoGroupNameParts: parts }), '自动地区线路命名风格已保存')
            }}
            generatedGroups={generatedGroups}
            currentSources={currentSources}
            totalNodes={totalNodes}
            enabledSources={enabledSources}
            newSource={newSource}
            busy={busy || sourceSyncTasks.some((task) => task.kind === 'all' && task.active)}
            sourceSyncTasks={sourceSyncTasks}
            stopSourceSync={(taskId) => void stopSourceSync(taskId)}
            onRefreshAll={(mode) => void runSyncAction((taskId) => api.syncSourcesWithMode(mode, taskId), mode === 'direct' ? '直连更新节点' : '代理更新节点')}
            onNewSource={setNewSource}
            onNewSourceChange={(key, value) => setNewSource((source) => source ? { ...source, [key]: value } : source)}
            onAdd={() => void addSource()}
            drafts={drafts}
            updateDraft={updateDraft}
            collapsedSources={collapsedSources}
            toggleSource={(id) => setCollapsedSources((current) => ({ ...current, [id]: !(current[id] ?? true) }))}
            saveSource={(source) => void runAction(() => api.saveSource(source), '来源已保存')}
            reorderSources={(sourceIds) => runAction(() => api.reorderSources(sourceIds), '订阅顺序已保存')}
            refreshSource={(source) => void runSourceSyncAction(source, true)}
            deleteSource={(source, skipConfirmation) => { void (async () => {
              if (skipConfirmation || await requestConfirmation(`删除「${source.name}」来源及其节点？\n提示：下次可按住 Shift 点击删除按钮，跳过确认直接删除。`, { title: '删除订阅来源', confirmLabel: '删除来源', destructive: true })) {
                await runAction(() => api.deleteSource(source.id), '来源和节点已删除')
              }
            })() }}
          />}

          {page === 'policy' && snapshot && policyEditorOpen && policyDraft ? <PolicyVisualWorkspace
            policy={policyDraft}
            autoGroupsCollapsed={autoGroupsCollapsed}
            onToggleAutoGroups={() => setCollapsedAutoGroupsByPolicy((current) => ({ ...current, [policyViewKey]: !autoGroupsCollapsed }))}
            topbarActionHost={topbarActionHost}
            dirty={policyDirty}
            busy={busy}
            nodes={snapshot.nodes}
            generatedGroups={generatedGroups}
            ruleSets={snapshot.ruleSetLibrary.items}
            onChange={setPolicyDraft}
            onSave={() => void savePolicy()}
            onDiscard={() => void (async () => {
              if (await requestConfirmation('放弃当前未保存的策略方案修改？', { title: '放弃修改', confirmLabel: '放弃修改' })) discardPolicyChanges()
            })()}
            confirm={requestConfirmation}
          /> : null}
          {page === 'policy' && snapshot && !policyEditorOpen ? <PolicySchemeManager
            templateOpen={policyImportOpen}
            templateContent={<PolicyImportDialog
              open={policyImportOpen}
              setOpen={setPolicyImportOpen}
              presetName={presetName}
              setPresetName={updatePresetName}
              presetUrl={presetUrl}
              setPresetUrl={updatePresetUrl}
              presetCatalogId={presetCatalogId}
              presetCatalogGroups={policyPresetGroups}
              presetCount={policyPresetCount}
              selectPresetCatalog={selectPresetCatalog}
              presetCandidate={presetCandidate}
              setPresetCandidate={setPresetCandidate}
              usePresetCandidate={() => void usePresetCandidate()}
              fetchPreset={() => void fetchPreset()}
              busy={busy}
              previewTab={presetPreviewTab}
              setPreviewTab={setPresetPreviewTab}
              previewOpen={presetPreviewOpen}
              setPreviewOpen={setPresetPreviewOpen}
            />}
            policies={snapshot.policyLibrary.items}
            activePolicyId={snapshot.policyLibrary.activeId}
            selectedPolicyId={selectedPolicyId}
            policyDirty={policyDirty}
            busy={busy}
            onCreateBlank={(name) => { void (async () => { if (await startBlankPolicy(name)) { setPolicyImportOpen(false); setPolicyEditorOpen(true) } })() }}
            onImportTemplate={() => { setPresetCandidate(null); setPresetPreviewOpen(false); setPolicyImportOpen(true) }}
            onEditPolicy={(id) => { void (async () => { if (await selectSavedPolicy(id)) setPolicyEditorOpen(true) })() }}
            onRenamePolicy={(id, name) => renamePolicy(id, name)}
            onSetPolicyPinned={(id, pinned) => { void setPolicyPinned(id, pinned) }}
            onActivatePolicy={(id) => void activatePolicy(id)}
            onDeletePolicy={(id, skipConfirmation) => void deletePolicy(id, skipConfirmation)}
          /> : null}

          {page === 'rulesets' && snapshot && <RuleSetLibraryPage
            topbarActionHost={topbarActionHost}
            topbarInfoHost={topbarInfoHost}
            items={snapshot.ruleSetLibrary.items}
            policies={snapshot.policyLibrary.items}
            busy={busy}
            task={ruleSetTask}
            onRefresh={(item, sync) => void refreshRuleSet(item, sync)}
            onRefreshAll={(sync) => void refreshAllRuleSets(sync)}
            remove={async (item, skipConfirmation) => {
              const usedByDraft = policyDraft?.rules.some((rule) => rule.kind.toUpperCase() === 'RULE-SET' && rule.value === item.id)
              if (usedByDraft) {
                await requestNotice('当前方案草稿正在引用此规则集。先从策略组移除该规则，再删除。', '规则集正在使用')
                return
              }
              const usedBy = snapshot.policyLibrary.items.flatMap((saved) => saved.config.rules.filter((rule) => rule.kind.toUpperCase() === 'RULE-SET' && rule.value === item.id).map(() => saved.name))
              if (usedBy.length) {
                await requestNotice(`此规则集当前被 ${usedBy.length} 条规则引用。请先在对应策略组中移除，再删除。`, '规则集正在使用')
                return
              }
              if (skipConfirmation || await requestConfirmation(`删除规则集「${item.name}」？\n提示：下次可按住 Shift 点击删除按钮，跳过确认直接删除。`, { title: '删除规则集', confirmLabel: '删除规则集', destructive: true })) {
                await runAction(() => api.deleteRuleSet(item.id), '规则集已删除')
              }
            }}
            onCreate={() => setRuleSetEditor({ initial: null })}
            onEdit={(item) => setRuleSetEditor({ initial: item })}
          />}

          {page === 'profile' && <ProfilePage
            snapshot={snapshot}
            copyProfile={() => void copyProfileUrl()}
            saveName={(name) => void saveProfileName(name)}
            setTrafficSource={(sourceId) => void setProfileTrafficSource(sourceId)}
            openSettings={openSettings}
            openUsage={() => setPage('usage')}
            busy={busy}
          />}

          {page === 'usage' && <UsagePage
            snapshot={snapshot}
            trafficStatus={trafficStatus}
            fromDate={fromDate}
            toDate={toDate}
            setFromDate={(value) => { setFromDate(value); setRangePreset('custom') }}
            setToDate={(value) => { setToDate(value); setRangePreset('custom') }}
            rangePreset={rangePreset}
            applyRangePreset={(preset) => void applyRangePreset(preset)}
            usage={usage}
            unmatchedConnections={unmatchedConnections}
            exportUnmatched={() => exportUnmatchedConnections(unmatchedConnections, fromDate, toDate)}
            usageTab={usageTab}
            setUsageTab={setUsageTab}
            query={() => void refreshUsage()}
            copySite={(site) => void copyTrafficSite(site)}
            clearHistory={() => void clearTrafficHistory()}
            openSettings={openSettings}
            busy={busy}
          />}
          {page === 'settings' && settingsDraft && <SettingsPage
            topbarActionHost={topbarActionHost}
            snapshot={snapshot}
            settings={settingsDraft}
            setSettings={setSettingsDraft}
            save={(nextSettings) => void saveSettings(nextSettings)}
            check={() => void checkController()}
            openData={openDataDirectory}
            controllerMessage={controllerMessage}
            busy={busy}
            exportBackup={() => void exportBackup()}
            importBackup={(file) => void importBackup(file)}
          />}
          {page === 'routecheck' && <RouteCheckPage settings={snapshot?.settings ?? null} />}
        </section>
      </main>
      {toast && <div className={'toast ' + toast.type}><b>{toast.type === 'success' ? '✓' : '!'}</b><span>{toast.text}</span></div>}
      {ruleSetEditor && <RuleSetEditorDialog initial={ruleSetEditor.initial} existingItems={snapshot?.ruleSetLibrary.items ?? []} busy={busy} preview={api.previewRuleSet} save={saveRuleSet} batchAdd={addCommunityRuleSets} cancel={() => setRuleSetEditor(null)} />}
      {dialog && createPortal(<div className="app-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && dialog.cancelLabel) finishDialog(false) }}>
        <section className="app-dialog" role={dialog.cancelLabel ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message">
          <h2 id="app-dialog-title">{dialog.title}</h2>
          <p id="app-dialog-message">{dialog.message.split('\n').map((line, index) => <span key={`${index}-${line}`} className={index > 0 ? 'app-dialog-hint' : undefined}>{line}</span>)}</p>
          <div className="app-dialog-actions">
            {dialog.cancelLabel && <button ref={dialogCancelButtonRef} className="button secondary" type="button" onClick={() => finishDialog(false)}>{dialog.cancelLabel}</button>}
            <button ref={dialogConfirmButtonRef} className={'button ' + (dialog.destructive ? 'danger' : 'primary')} type="button" onClick={() => finishDialog(true)}>{dialog.confirmLabel}</button>
          </div>
        </section>
      </div>, document.body)}
    </div>
  )
}

function NavButton(props: { active: boolean; icon: string; label: string; count?: number; onClick: () => void }) {
  return <button className={'nav-button ' + (props.active ? 'active' : '')} onClick={props.onClick}><span className="nav-icon">{props.icon}</span><span>{props.label}</span>{props.count !== undefined && <small>{props.count}</small>}</button>
}

function TopbarActionPortal(props: { host: HTMLDivElement | null; children: ReactNode }) {
  return props.host ? createPortal(props.children, props.host) : null
}

type SummaryMetricIcon = 'total' | 'download' | 'upload' | 'average'

function SummaryMetric(props: { label: string; value: string; detail: string; icon: SummaryMetricIcon }) {
  return <div className="summary-card"><div className={'summary-icon ' + props.icon} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {props.icon === 'total' && <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5V12h8.5" /></>}
    {props.icon === 'download' && <><path d="M12 4v10m0 0 4-4m-4 4-4-4" /><path d="M5 16.5v3h14v-3" /></>}
    {props.icon === 'upload' && <><path d="M12 14V4m0 0L8 8m4-4 4 4" /><path d="M5 16.5v3h14v-3" /></>}
    {props.icon === 'average' && <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>}
  </svg></div><div className="summary-copy"><span>{props.label}</span><strong>{props.value}</strong><small>{props.detail}</small></div></div>
}

function WorkflowNav(props: { page: Page; snapshot: AppSnapshot | null; totalNodes: number; onNavigate: (page: Page) => void }) {
  const activePolicy = props.snapshot?.policyLibrary.items.find((item) => item.id === props.snapshot?.policyLibrary.activeId)
  const trafficStatus = props.snapshot?.trafficStatus ?? ''
  const trafficConnected = trafficStatus.startsWith('已连接')
  const trafficPaused = trafficStatus.includes('暂停') || props.snapshot?.settings.collectEnabled === false
  const sources = props.snapshot?.sources ?? []
  const sourceHasError = sources.some((source) => Boolean(source.lastError))
  const profileReady = Boolean(props.snapshot?.profileUrl)
  const profileLastRequestedAt = props.snapshot?.profileLastRequestedAt ?? null
  const profileNeedsUpdate = props.snapshot?.profileNeedsUpdate ?? false
  const profileRequestTime = profileLastRequestedAt ? new Date(profileLastRequestedAt).toISOString() : ''
  const steps: { page: Page; title: string; detail: string; state: string; status: 'ready' | 'action' | 'neutral' | 'error' }[] = [
    {
      page: 'sources',
      title: '订阅来源',
      detail: `${sources.length} 个服务商 · ${props.totalNodes} 个节点`,
      state: sourceHasError ? '部分失败' : props.totalNodes ? '已就绪' : sources.length ? '待刷新' : '未配置',
      status: sourceHasError ? 'error' : props.totalNodes ? 'ready' : sources.length ? 'action' : 'neutral',
    },
    {
      page: 'policy',
      title: '策略方案',
      detail: activePolicy?.name ?? props.snapshot?.policy.templateName ?? '尚未配置',
      state: activePolicy ? '已启用' : '待配置',
      status: activePolicy ? 'ready' : 'action',
    },
    {
      page: 'profile',
      title: '导入配置',
      detail: profileNeedsUpdate
        ? '配置已更新 · 请在 Clash Verge 刷新'
        : profileLastRequestedAt
          ? `配置地址最近被请求 · ${relativeTime(profileRequestTime)}`
          : '复制本机地址到 Clash Verge',
      state: profileNeedsUpdate ? '待更新' : profileLastRequestedAt ? '已拉取' : profileReady ? '待导入' : '未生成',
      status: profileNeedsUpdate ? 'action' : profileLastRequestedAt ? 'ready' : profileReady ? 'action' : 'neutral',
    },
    {
      page: 'usage',
      title: '流量分析',
      detail: trafficConnected && !trafficPaused ? 'Mihomo 控制器已连接' : trafficPaused ? '流量采集已暂停' : '连接 Mihomo 后采集',
      state: trafficConnected && !trafficPaused ? '采集中' : trafficPaused ? '已暂停' : '待连接',
      status: trafficConnected && !trafficPaused ? 'ready' : 'action',
    },
  ]
  const flowPage = props.page
  return <nav className="journey-nav" aria-label="使用流程">
      {steps.map((step, index) => {
        const active = flowPage === step.page
        return <div className="journey-slot" key={step.page}>
          <button className={`journey-step ${step.status}`} aria-current={active ? 'step' : undefined} title={step.page === 'profile' ? '此状态根据本机配置地址的请求记录判断，只能确认配置被读取，不能确认 Clash Verge 是否已选中或启用。' : undefined} onClick={() => props.onNavigate(step.page)}>
            <b className="journey-number">{String(index + 1).padStart(2, '0')}</b>
            <span className="journey-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
            <span className={`journey-state ${step.status}`}>{step.state}</span>
          </button>
          {index < steps.length - 1 && <i aria-hidden="true">›</i>}
        </div>
      })}
    </nav>
}

function SourceFields(props: { source: Source; update: (key: keyof Source, value: string | boolean) => void }) {
  const source = props.source
  const update = props.update
  const urlField = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = urlField.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [source.url])
  return <div className="source-fields">
    <label><span>服务商显示名称</span><input value={source.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：来源 A" /></label>
    <label><span>节点前缀</span><input value={source.prefix} onChange={(event) => update('prefix', event.target.value)} placeholder={source.name || '留空则使用显示名称'} /></label>
    <label><span>默认地区提示（可选）</span><input value={source.regionHint} onChange={(event) => update('regionHint', event.target.value)} placeholder="节点名称未写国家时使用" /></label>
    <label className="url-field"><span>服务商原始订阅链接</span><textarea ref={urlField} rows={1} wrap="soft" value={source.url} onChange={(event) => update('url', event.target.value)} spellCheck={false} placeholder="https://..." /></label>
  </div>
}

function SourceNodeNameFormat(props: { source: Source; update: (key: keyof Source, value: string | boolean) => void }) {
  const { source, update } = props
  const fields: Array<{ key: 'includePrefix' | 'includeFlag' | 'includeCountry' | 'includeOriginalName'; label: string }> = [
    { key: 'includePrefix', label: '前缀' },
    { key: 'includeFlag', label: '国旗' },
    { key: 'includeCountry', label: '国家/地区' },
    { key: 'includeOriginalName', label: '原节点名' },
  ]
  return <span className="node-format-controls" aria-label="节点名称格式">
    <span className="node-format-label">节点格式</span>
    {fields.map(({ key, label }) => <button
      className={'node-format-toggle' + (source[key] ? ' is-enabled' : '')}
      type="button"
      key={key}
      aria-pressed={source[key]}
      aria-label={`${label}，当前${source[key] ? '启用' : '关闭'}，点击${source[key] ? '关闭' : '启用'}`}
      title={`${label}：${source[key] ? '已启用' : '已关闭'}`}
      onClick={() => update(key, !source[key])}
    >{label}</button>)}
  </span>
}

type AutoGroupNameZone = 'chosen' | 'available'
type AutoGroupNameDrag = { part: string; source: AutoGroupNameZone; pointerId: number; startX: number; startY: number; active: boolean }
type AutoGroupNameDrop = { zone: AutoGroupNameZone; targetPart: string | null; after: boolean } | null
type AutoGroupNameDragGhost = { part: string; x: number; y: number }

function AutoGroupNameStyle(props: {
  parts: string[]
  savedParts: string[]
  disabled: boolean
  hideHeading?: boolean
  onChange: (parts: string[]) => void
  onSave: (parts: string[]) => void
}) {
  const parts = normalizeAutoGroupNameParts(props.parts)
  const savedParts = normalizeAutoGroupNameParts(props.savedParts)
  const [draggingPart, setDraggingPart] = useState('')
  const [drop, setDrop] = useState<AutoGroupNameDrop>(null)
  const [previewParts, setPreviewParts] = useState<string[] | null>(null)
  const [dragGhost, setDragGhost] = useState<AutoGroupNameDragGhost | null>(null)
  const dragRef = useRef<AutoGroupNameDrag | null>(null)
  const suppressClickRef = useRef(false)
  const chosenZoneRef = useRef<HTMLDivElement | null>(null)
  const availableZoneRef = useRef<HTMLDivElement | null>(null)
  const chosenRectsRef = useRef<Map<string, DOMRect> | null>(null)
  const motionFrameRef = useRef<number | null>(null)
  const motionTimerRef = useRef<number | null>(null)
  const visibleParts = previewParts ?? parts
  const valid = isValidAutoGroupNameParts(parts)
  const availableSeparators = autoGroupNameSeparators.filter((part) => !parts.includes(part))
  const changed = parts.join('|') !== savedParts.join('|')
  const nodePreview = composeAutoGroupName(parts, 'Seele', '🇺🇸 美国')
  const allPreview = composeAutoGroupName(parts, 'Seele', '全部节点')

  function captureChosenRects() {
    const container = chosenZoneRef.current
    if (!container) return
    chosenRectsRef.current = new Map([...container.querySelectorAll<HTMLElement>('[data-auto-group-name-part]')]
      .map((element) => [element.dataset.autoGroupNamePart ?? '', element.getBoundingClientRect()]))
  }

  function reorderNamePart(currentParts: string[], draggedPart: string, location: Exclude<AutoGroupNameDrop, null>) {
    const nameParts = currentParts.filter((part) => !autoGroupNameSeparators.includes(part))
    const fromIndex = nameParts.indexOf(draggedPart)
    if (fromIndex < 0 || location.zone !== 'chosen' || location.targetPart === draggedPart) return currentParts
    let targetIndex = nameParts.length
    if (location.targetPart && !autoGroupNameSeparators.includes(location.targetPart)) {
      const targetNameIndex = nameParts.indexOf(location.targetPart)
      if (targetNameIndex >= 0) targetIndex = targetNameIndex + (location.after ? 1 : 0)
    } else if (location.targetPart && autoGroupNameSeparators.includes(location.targetPart)) {
      targetIndex = location.after ? nameParts.length : 0
    } else if (nameParts.length > 1 && !location.targetPart) {
      targetIndex = location.after ? nameParts.length : 0
    }
    const nextNames = [...nameParts]
    nextNames.splice(fromIndex, 1)
    const adjustedIndex = Math.max(0, Math.min(nextNames.length, targetIndex - (fromIndex < targetIndex ? 1 : 0)))
    nextNames.splice(adjustedIndex, 0, draggedPart)
    const separator = currentParts.find((part) => autoGroupNameSeparators.includes(part))
    const nextParts = separator ? [nextNames[0], separator, nextNames[1]] : nextNames
    return nextParts.join('|') === currentParts.join('|') ? currentParts : nextParts
  }

  function insertSeparator(currentParts: string[], separatorPart: string) {
    const nameParts = currentParts.filter((part) => !autoGroupNameSeparators.includes(part))
    if (nameParts.length >= 2) return [nameParts[0], separatorPart, ...nameParts.slice(1)]
    const nextParts = currentParts.filter((part) => !autoGroupNameSeparators.includes(part))
    const routeIndex = nextParts.indexOf('route')
    nextParts.splice(routeIndex >= 0 ? routeIndex : nextParts.length, 0, separatorPart)
    return nextParts
  }

  function setPreviewWithMotion(nextParts: string[] | null) {
    if ((nextParts?.join('|') ?? null) === (previewParts?.join('|') ?? null)) return
    captureChosenRects()
    setPreviewParts(nextParts)
  }

  function commitParts(nextParts: string[]) {
    captureChosenRects()
    setPreviewParts(null)
    props.onChange(nextParts)
  }

  useLayoutEffect(() => {
    const before = chosenRectsRef.current
    chosenRectsRef.current = null
    const container = chosenZoneRef.current
    if (!before || !container) return

    if (motionFrameRef.current !== null) cancelAnimationFrame(motionFrameRef.current)
    if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current)

    const elements = [...container.querySelectorAll<HTMLElement>('[data-auto-group-name-part]')]
    for (const element of elements) {
      element.style.transition = 'none'
      element.style.transform = ''
    }

    const moving: HTMLElement[] = []
    for (const element of elements) {
      const previous = before.get(element.dataset.autoGroupNamePart ?? '')
      if (!previous) continue
      const next = element.getBoundingClientRect()
      const deltaX = previous.left - next.left
      const deltaY = previous.top - next.top
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue
      element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`
      moving.push(element)
    }

    if (moving.length === 0) return
    void container.offsetWidth
    motionFrameRef.current = requestAnimationFrame(() => {
      for (const element of moving) {
        element.style.transition = 'transform 190ms cubic-bezier(0.2, 0.75, 0.25, 1)'
        element.style.transform = 'translate3d(0, 0, 0)'
      }
    })
    motionTimerRef.current = window.setTimeout(() => {
      for (const element of moving) {
        element.style.transition = ''
        element.style.transform = ''
      }
      motionFrameRef.current = null
      motionTimerRef.current = null
    }, 220)
  }, [previewParts, parts.join('|')])

  useEffect(() => () => {
    if (motionFrameRef.current !== null) cancelAnimationFrame(motionFrameRef.current)
    if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current)
  }, [])

  function dropLocationAt(x: number, y: number): AutoGroupNameDrop {
    const point = document.elementFromPoint(x, y)
    const pointZone = point?.closest<HTMLElement>('[data-auto-group-name-zone]')
    let zone = pointZone?.dataset.autoGroupNameZone
    if (zone !== 'chosen' && zone !== 'available') {
      const chosenRect = chosenZoneRef.current?.getBoundingClientRect()
      const availableRect = availableZoneRef.current?.getBoundingClientRect()
      if (chosenRect && x >= chosenRect.left && x <= chosenRect.right && y >= chosenRect.top && y <= chosenRect.bottom) zone = 'chosen'
      else if (availableRect && x >= availableRect.left && x <= availableRect.right && y >= availableRect.top && y <= availableRect.bottom) zone = 'available'
    }
    if (zone !== 'chosen' && zone !== 'available') return null
    if (zone === 'chosen') {
      const draggedPart = dragRef.current?.part
      const token = point?.closest<HTMLElement>('[data-auto-group-name-part]')
      if (token && token.dataset.autoGroupNamePart !== draggedPart && token.closest('[data-auto-group-name-zone]') === chosenZoneRef.current) {
        const rect = token.getBoundingClientRect()
        return { zone, targetPart: token.dataset.autoGroupNamePart ?? null, after: x > rect.left + rect.width / 2 }
      }
      const candidates = [...(chosenZoneRef.current?.querySelectorAll<HTMLElement>('[data-auto-group-name-part]') ?? [])]
        .filter((element) => element.dataset.autoGroupNamePart !== draggedPart)
      if (candidates.length === 0) return { zone, targetPart: null, after: false }
      const nearest = candidates.reduce((best, candidate) => {
        const rect = candidate.getBoundingClientRect()
        const bestRect = best.getBoundingClientRect()
        const distance = (rect.left + rect.width / 2 - x) ** 2 + (rect.top + rect.height / 2 - y) ** 2
        const bestDistance = (bestRect.left + bestRect.width / 2 - x) ** 2 + (bestRect.top + bestRect.height / 2 - y) ** 2
        return distance < bestDistance ? candidate : best
      })
      const rect = nearest.getBoundingClientRect()
      return { zone, targetPart: nearest.dataset.autoGroupNamePart ?? null, after: x > rect.left + rect.width / 2 }
    }
    const token = point?.closest<HTMLElement>('[data-auto-group-name-part]')
    if (!token || token.closest('[data-auto-group-name-zone]') !== pointZone) return { zone, targetPart: null, after: false }
    const rect = token.getBoundingClientRect()
    const after = y > rect.top + rect.height / 2 || (Math.abs(y - (rect.top + rect.height / 2)) < rect.height / 2 && x > rect.left + rect.width / 2)
    return { zone, targetPart: token.dataset.autoGroupNamePart ?? null, after }
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, part: string, source: AutoGroupNameZone) {
    if (props.disabled || event.button !== 0) return
    dragRef.current = { part, source, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { dragRef.current = null }
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return
    if (!drag.active) { drag.active = true; setDraggingPart(drag.part) }
    event.preventDefault()
    setDragGhost({ part: drag.part, x: event.clientX, y: event.clientY })
    const location = dropLocationAt(event.clientX, event.clientY)
    setDrop(location)
    if (drag.source === 'chosen' && location?.zone === 'chosen' && !autoGroupNameSeparators.includes(drag.part)) {
      setPreviewWithMotion(reorderNamePart(previewParts ?? parts, drag.part, location))
    } else if (drag.source === 'available' && location?.zone === 'chosen') {
      setPreviewWithMotion(insertSeparator(previewParts ?? parts, drag.part))
    } else if (previewParts) {
      setPreviewWithMotion(null)
    }
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const location = !cancelled && drag.active ? dropLocationAt(event.clientX, event.clientY) : null
    dragRef.current = null
    setDraggingPart('')
    setDrop(null)
    setDragGhost(null)
    if (!location || !drag.active || props.disabled) {
      if (previewParts) setPreviewWithMotion(null)
      return
    }
    suppressClickRef.current = true
    window.setTimeout(() => { suppressClickRef.current = false }, 0)
    if (drag.source === 'chosen' && location.zone === 'available' && !autoGroupNameSeparators.includes(drag.part)) {
      if (previewParts) setPreviewWithMotion(null)
      return
    }
    if (location.zone === 'available') {
      if (drag.source === 'chosen') commitParts(parts.filter((part) => part !== drag.part))
      else if (previewParts) setPreviewWithMotion(null)
      return
    }
    if (drag.source === 'available') {
      const nextParts = previewParts ?? insertSeparator(parts, drag.part)
      if (nextParts.join('|') !== parts.join('|')) commitParts(nextParts)
      else if (previewParts) setPreviewWithMotion(null)
      return
    }
    if (autoGroupNameSeparators.includes(drag.part)) {
      if (previewParts) setPreviewWithMotion(null)
      return
    }
    const nextParts = reorderNamePart(previewParts ?? parts, drag.part, location)
    if (nextParts.join('|') !== parts.join('|')) commitParts(nextParts)
    else if (previewParts) setPreviewWithMotion(null)
  }

  function addSeparator(part: string) {
    if (suppressClickRef.current || props.disabled) return
    const index = parts.findIndex((value) => autoGroupNameSeparators.includes(value))
    if (index >= 0) commitParts(parts.map((value, current) => current === index ? part : value))
    else {
      const routeIndex = parts.indexOf('route')
      const next = [...parts]
      next.splice(Math.max(0, routeIndex), 0, part)
      commitParts(next)
    }
  }

  return <section className={'panel auto-group-naming-panel' + (props.hideHeading ? ' auto-group-name-modal-editor' : '')} aria-label="自动地区线路命名风格">
    {!props.hideHeading && <header className="auto-group-naming-heading">
      <div><span className="section-kicker">AUTO ROUTE NAMES</span><h2>自动地区线路命名</h2><p>统一调整“地区线路”和“全部节点”线路的名称顺序与分隔符。</p></div>
      <button className="button primary" type="button" disabled={props.disabled || !changed || !valid} onClick={() => props.onSave(parts)}>保存命名风格</button>
    </header>}
    <div className="auto-group-name-composer">
      <strong>命名拼凑</strong>
      <div className="auto-group-name-parts" data-auto-group-name-zone="chosen" aria-label="当前命名元素，可拖动排序" ref={chosenZoneRef}>
        {visibleParts.map((part) => <div key={part} className={'auto-group-name-part' + (draggingPart === part ? ' is-dragging' : '') + (drop?.zone === 'chosen' && drop.targetPart === part ? drop.after ? ' drop-after' : ' drop-before' : '')} data-auto-group-name-part={part}>
          <button type="button" className="auto-group-name-part-drag" aria-label={`拖动${autoGroupNamePartLabels[part] ?? part}调整顺序`} title="按住拖动排序" onPointerDown={(event) => startDrag(event, part, 'chosen')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={(event) => finishDrag(event, true)}>{autoGroupNamePartLabels[part] ?? part}<span aria-hidden="true">⠿</span></button>
          {autoGroupNameSeparators.includes(part) && <button className="auto-group-name-part-remove" type="button" aria-label={`移除分隔符 ${autoGroupNamePartLabels[part]}`} disabled={props.disabled} onClick={() => commitParts(parts.filter((value) => value !== part))}>×</button>}
        </div>)}
      </div>
      <div className="auto-group-name-available-wrap">
        <span>待选分隔符</span>
        <div className="auto-group-name-available" data-auto-group-name-zone="available" aria-label="待选分隔符，可拖到上方" ref={availableZoneRef}>
          {availableSeparators.map((part) => <button key={part} type="button" className={'auto-group-name-option' + (draggingPart === part ? ' is-dragging' : '') + (drop?.zone === 'available' && drop.targetPart === part ? drop.after ? ' drop-after' : ' drop-before' : '')} data-auto-group-name-part={part} title="拖到上方命名拼凑中" onClick={() => addSeparator(part)} onPointerDown={(event) => startDrag(event, part, 'available')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={(event) => finishDrag(event, true)}>{autoGroupNamePartLabels[part] ?? part}<span aria-hidden="true">⠿</span></button>)}
          {availableSeparators.length === 0 && <small>所有分隔符已用完</small>}
        </div>
      </div>
      {!valid && <small className="auto-group-name-error">厂商、线路标识和一个分隔符都要保留；分隔符必须放在两个名称元素之间。</small>}
      {valid && <div className="auto-group-name-preview"><span>示例</span><code>{nodePreview}</code><code>{allPreview}</code></div>}
    </div>
    {dragGhost && createPortal(<div className="auto-group-name-drag-ghost" aria-hidden="true" style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}>{autoGroupNamePartLabels[dragGhost.part] ?? dragGhost.part}</div>, document.body)}
  </section>
}

function SourceSubscriptionInfo({ info }: { info: SubscriptionInfo | null | undefined }) {
  if (!info) return <div className="subscription-info" aria-label="套餐信息"><strong>套餐信息</strong><span>尚未获取套餐信息</span></div>
  const hasUsage = info.uploadBytes !== null || info.downloadBytes !== null
  const usedBytes = (info.uploadBytes ?? 0) + (info.downloadBytes ?? 0)
  const totalBytes = info.totalBytes
  const usageLabel = hasUsage && totalBytes !== null
    ? `已用：${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`
    : ''
  const usagePercent = usageLabel && totalBytes !== null && totalBytes > 0
    && Number.isFinite(totalBytes) && Number.isFinite(usedBytes)
    ? Math.max(0, Math.min(100, usedBytes / totalBytes * 100))
    : null
  const remaining = info.remainingBytes !== null
    ? formatBytes(info.remainingBytes)
    : info.remainingLabel
  const hasDetails = Boolean(info.packageName || remaining || info.totalBytes !== null || hasUsage || info.expiresAt || info.resetAfterDays !== null || info.officialUrl)
  if (!hasDetails) return <div className="subscription-info" aria-label="套餐信息"><strong>套餐信息</strong><span>服务商未返回套餐信息</span></div>
  return <div className="subscription-info" aria-label="套餐信息">
    <strong>套餐信息</strong>
    {info.packageName && <span>套餐：{info.packageName}</span>}
    {remaining && <span>剩余流量：{remaining}</span>}
    {usageLabel && (usagePercent !== null
      ? <span className="subscription-usage-meter" role="meter" aria-label="套餐流量用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usagePercent} aria-valuetext={usageLabel} title={`${usageLabel}（${Number(usagePercent.toFixed(1))}%）`}>
        <span className="subscription-usage-fill" style={{ width: `${usagePercent}%` }} aria-hidden="true" />
        <span className="subscription-usage-text">{usageLabel}</span>
      </span>
      : <span>{usageLabel}</span>)}
    {info.totalBytes !== null && !hasUsage && !remaining && <span>套餐总量：{formatBytes(info.totalBytes)}</span>}
    {info.totalBytes === null && hasUsage && <span>上传：{formatBytes(info.uploadBytes ?? 0)} · 下载：{formatBytes(info.downloadBytes ?? 0)}</span>}
    {info.expiresAt && <span>到期：{info.expiresAt}</span>}
    {info.resetAfterDays !== null && <span>下次重置：{info.resetAfterDays} 天</span>}
    {info.officialUrl && <span>官网：{info.officialUrl}</span>}
  </div>
}

function SourcePage(props: {
  snapshot: AppSnapshot | null
  settings: AppSettings | null
  savedSettings: AppSettings | null
  onAutoGroupNamePartsChange: (parts: string[]) => void
  saveAutoGroupNameParts: (parts: string[]) => void
  generatedGroups: GeneratedPolicyGroup[]
  currentSources: Source[]
  totalNodes: number
  enabledSources: number
  newSource: Source | null
  busy: boolean
  sourceSyncTasks: SourceSyncTask[]
  stopSourceSync: (taskId: string) => void
  onRefreshAll: (mode: 'direct' | 'proxy') => void
  onNewSource: (source: Source | null) => void
  onNewSourceChange: (key: keyof Source, value: string | boolean) => void
  onAdd: () => void
  drafts: Record<string, Source>
  updateDraft: (id: string, key: keyof Source, value: string | boolean) => void
  collapsedSources: Record<string, boolean>
  toggleSource: (id: string) => void
  saveSource: (source: Source) => void
  reorderSources: (sourceIds: string[]) => Promise<boolean>
  refreshSource: (source: Source) => void
  deleteSource: (source: Source, skipConfirmation?: boolean) => void
}) {
  const snapshot = props.snapshot
  const activeBatchTask = props.sourceSyncTasks.find((task) => task.active && task.kind === 'all') ?? null
  const activeSingleTasks = props.sourceSyncTasks.filter((task) => task.active && task.kind === 'single')
  const hiddenSingleTask = activeSingleTasks.find((task) => !props.currentSources.some((source) => source.id === task.sourceId)) ?? null
  const overviewTask = activeBatchTask ?? hiddenSingleTask
  const showSyncInOverview = Boolean(overviewTask)
  const anyActiveSync = props.sourceSyncTasks.some((task) => task.active)
  const syncOriginLabel = (origin: SourceSyncTask['origin']) => origin === 'clashVerge' ? 'Clash Verge' : origin === 'auto' ? '自动刷新' : '手动刷新'
  const [autoRoutesPanelOpen, setAutoRoutesPanelOpen] = useState(false)
  const [autoGroupNamingOpen, setAutoGroupNamingOpen] = useState(false)
  const [proxyAvailability, setProxyAvailability] = useState<'checking' | 'available' | 'unavailable'>('checking')
  const activeNameParts = normalizeAutoGroupNameParts(props.settings?.autoGroupNameParts ?? defaultAutoGroupNameParts)
  const savedNameParts = normalizeAutoGroupNameParts(props.savedSettings?.autoGroupNameParts ?? defaultAutoGroupNameParts)
  const nameStyleChanged = activeNameParts.join('|') !== savedNameParts.join('|')
  const nameStyleValid = isValidAutoGroupNameParts(activeNameParts)
  const configuredProxy = snapshot?.settings.subscriptionProxy ?? ''
  useEffect(() => {
    let active = true
    let checking = false
    const checkProxy = async () => {
      if (checking) return
      checking = true
      try {
        const available = await api.checkSubscriptionProxy()
        if (active) setProxyAvailability(available ? 'available' : 'unavailable')
      } catch {
        if (active) setProxyAvailability('unavailable')
      } finally {
        checking = false
      }
    }
    setProxyAvailability(configuredProxy ? 'checking' : 'unavailable')
    if (configuredProxy) void checkProxy()
    const interval = window.setInterval(() => void checkProxy(), 5000)
    return () => { active = false; window.clearInterval(interval) }
  }, [configuredProxy])
  useEffect(() => {
    if (!autoGroupNamingOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAutoGroupNamingOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [autoGroupNamingOpen])
  type SourcePointerDrag = { sourceId: string; pointerId: number; startX: number; startY: number; active: boolean }
  type SourceDragPreview = { sourceId: string; name: string; nodeCount: number; x: number; y: number }
  const [draggingSourceId, setDraggingSourceId] = useState('')
  const [dropTargetSourceId, setDropTargetSourceId] = useState('')
  const [sourceOrderPreview, setSourceOrderPreview] = useState<string[] | null>(null)
  const [sourceDragPreview, setSourceDragPreview] = useState<SourceDragPreview | null>(null)
  const sourcePointerDragRef = useRef<SourcePointerDrag | null>(null)
  const sourceOrderPreviewRef = useRef<string[] | null>(null)
  const sourceCardElementsRef = useRef(new Map<string, HTMLElement>())
  const pendingSourceRectsRef = useRef<Map<string, DOMRect> | null>(null)

  const sourceById = new Map(props.currentSources.map((source) => [source.id, source]))
  const displayedSources = sourceOrderPreview
    ? [...sourceOrderPreview.map((id) => sourceById.get(id)).filter((source): source is Source => Boolean(source)), ...props.currentSources.filter((source) => !sourceOrderPreview.includes(source.id))]
    : props.currentSources

  function setPreviewOrder(order: string[] | null) {
    sourceOrderPreviewRef.current = order
    setSourceOrderPreview(order)
  }

  function captureSourceCardRects() {
    pendingSourceRectsRef.current = new Map([...sourceCardElementsRef.current].map(([id, element]) => [id, element.getBoundingClientRect()]))
  }

  useLayoutEffect(() => {
    const previousRects = pendingSourceRectsRef.current
    pendingSourceRectsRef.current = null
    if (!previousRects) return
    const moving: { element: HTMLElement; x: number; y: number }[] = []
    for (const [id, element] of sourceCardElementsRef.current) {
      const previous = previousRects.get(id)
      if (!previous) continue
      const next = element.getBoundingClientRect()
      const x = previous.left - next.left
      const y = previous.top - next.top
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue
      element.style.transition = 'none'
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`
      moving.push({ element, x, y })
    }
    if (moving.length === 0) return
    void moving[0].element.offsetWidth
    requestAnimationFrame(() => {
      for (const { element } of moving) {
        element.style.transition = 'transform 220ms cubic-bezier(0.2, 0.75, 0.25, 1)'
        element.style.transform = 'translate3d(0, 0, 0)'
      }
    })
    const timer = window.setTimeout(() => {
      for (const { element } of moving) {
        element.style.transition = ''
        element.style.transform = ''
      }
    }, 260)
    return () => {
      window.clearTimeout(timer)
      for (const { element } of moving) {
        element.style.transition = ''
        element.style.transform = ''
      }
    }
  }, [sourceOrderPreview])

  useEffect(() => {
    const preview = sourceOrderPreviewRef.current
    if (!preview) return
    const currentIds = props.currentSources.map((source) => source.id)
    if (currentIds.length === preview.length && currentIds.every((id, index) => id === preview[index])) setPreviewOrder(null)
  }, [props.currentSources])

  function startSourcePointerDrag(event: ReactPointerEvent<HTMLButtonElement>, sourceId: string) {
    if (props.busy || props.currentSources.length < 2 || event.button !== 0 || event.pointerType === 'touch') return
    sourcePointerDragRef.current = { sourceId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      sourcePointerDragRef.current = null
    }
  }

  function moveSourcePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = sourcePointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return
    if (!drag.active) {
      drag.active = true
      setDraggingSourceId(drag.sourceId)
    }
    event.preventDefault()
    const source = props.currentSources.find((item) => item.id === drag.sourceId)
    if (source) {
      const left = Math.max(12, Math.min(event.clientX + 16, window.innerWidth - 292))
      const top = Math.max(12, Math.min(event.clientY + 16, window.innerHeight - 74))
      setSourceDragPreview({ sourceId: source.id, name: source.name, nodeCount: source.nodeCount, x: left, y: top })
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-source-card-id]')
    const targetId = target?.dataset.sourceCardId ?? ''
    setDropTargetSourceId(targetId && targetId !== drag.sourceId ? targetId : '')
  }

  function finishSourcePointerDrag(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = sourcePointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const target = !cancelled && drag.active
      ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-source-card-id]')
      : null
    const targetId = target?.dataset.sourceCardId ?? ''
    sourcePointerDragRef.current = null
    setDropTargetSourceId('')
    setDraggingSourceId('')
    setSourceDragPreview(null)
    if (cancelled || !drag.active || !targetId || props.busy) {
      if (sourceOrderPreviewRef.current) {
        captureSourceCardRects()
        setPreviewOrder(null)
      }
      return
    }
    const sourceIds = props.currentSources.map((source) => source.id)
    const from = sourceIds.indexOf(drag.sourceId)
    const to = sourceIds.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    sourceIds.splice(to, 0, ...sourceIds.splice(from, 1))
    captureSourceCardRects()
    setPreviewOrder(sourceIds)
    void props.reorderSources([...sourceIds]).then((saved) => {
      if (saved) return
      captureSourceCardRects()
      setPreviewOrder(null)
    })
  }

  return <>
    <div className={'source-overview' + (showSyncInOverview ? ' source-overview-syncing' : '')}>
      <div className="source-overview-details">
        <strong>{props.enabledSources}<small> / {props.currentSources.length} 个来源已启用</small></strong>
        <span className="source-overview-divider" />
        <strong>{props.totalNodes}<small> 个可用节点</small></strong>
        <span className="source-overview-divider" />
        <span className={'sync-note ' + (/失败|错误|fail/i.test(snapshot?.syncStatus ?? '') ? 'error' : '')}>{overviewTask ? `${syncOriginLabel(overviewTask.origin)} 正在刷新订阅` : snapshot?.syncStatus || '等待手动刷新'}</span>
        <span className="source-overview-time">{snapshot?.lastSync ? '最近更新 ' + shortTime(snapshot.lastSync) : '尚未刷新'}</span>
      </div>
      <div className={'source-page-actions' + (showSyncInOverview ? ' source-page-actions-syncing' : '')}>
        {overviewTask ? <div className="source-sync-progress" role="status" aria-live="polite">
          <div className="source-sync-progress-copy"><strong>{syncOriginLabel(overviewTask.origin)}进度 {overviewTask.completed}/{overviewTask.total}</strong><small>{overviewTask.cancelRequested ? '正在停止刷新…' : [overviewTask.sourceName, overviewTask.phase].filter(Boolean).join(' · ') || '正在准备刷新'}</small></div>
          <progress value={overviewTask.completed} max={Math.max(1, overviewTask.total)} />
          <button className="button danger small" type="button" disabled={overviewTask.cancelRequested || overviewTask.pending} onClick={() => props.stopSourceSync(overviewTask.taskId)}>{overviewTask.pending ? '正在准备…' : overviewTask.cancelRequested ? '正在停止…' : '停止刷新'}</button>
        </div> : <>
          <button className="button secondary" disabled={props.busy || anyActiveSync || !snapshot?.sources.some((source) => source.enabled)} onClick={() => props.onRefreshAll('direct')}>⟳ 更新节点（直连）</button>
          <button className="button secondary" disabled={props.busy || anyActiveSync || !snapshot?.sources.some((source) => source.enabled) || proxyAvailability !== 'available'} title={proxyAvailability === 'checking' ? '正在检测设置中的代理连接。' : proxyAvailability === 'unavailable' ? '代理当前不可连接，请检查设置中的代理地址和代理程序。' : '使用设置中的代理刷新所有已启用订阅。'} onClick={() => props.onRefreshAll('proxy')}>⟳ 更新节点（代理）</button>
        </>}
        <button className="button primary" disabled={props.busy} onClick={() => props.onNewSource(freshSource())}>＋ 添加订阅</button>
      </div>
    </div>
    {props.newSource && <section className="panel new-source-panel">
      <div className="panel-title"><div><span className="section-kicker">NEW PROVIDER</span><h2>添加订阅来源</h2></div><button className="plain-button" onClick={() => props.onNewSource(null)}>关闭</button></div>
      <SourceFields source={props.newSource} update={props.onNewSourceChange} />
      <div className="form-actions"><span className="hint">原始订阅地址只保存在本机。</span><button className="button primary" disabled={props.busy} onClick={props.onAdd}>保存并刷新节点</button></div>
    </section>}
    {props.currentSources.length === 0 && !props.newSource ? <div className="empty-state">
      <div className="empty-icon">↗</div><h3>还没有订阅来源</h3><button className="button primary" onClick={() => props.onNewSource(freshSource())}>添加第一个来源</button>
    </div> : <div className="source-list">
      {props.currentSources.length > 1 && <p className="source-order-hint">拖动订阅卡片左侧手柄调整顺序；策略方案中的自动线路会同步排序。</p>}
      {displayedSources.map((source) => {
        const draft = props.drafts[source.id] ?? source
        const collapsed = props.collapsedSources[source.id] ?? true
        const dirty = draft.name !== source.name || draft.prefix !== source.prefix || draft.regionHint !== source.regionHint || draft.url !== source.url || draft.enabled !== source.enabled || draft.includePrefix !== source.includePrefix || draft.includeFlag !== source.includeFlag || draft.includeCountry !== source.includeCountry || draft.includeOriginalName !== source.includeOriginalName
        const providerNodes = sortProxyNodes((snapshot?.nodes ?? []).filter((node) => node.sourceId === source.id))
        const sourceGroups = props.generatedGroups.filter((group) => group.sourceId === source.id && group.country !== null)
        const sourceTasks = props.sourceSyncTasks
          .filter((task) => task.active && task.kind !== 'all' && task.sourceId === source.id)
          .sort((left, right) => Number(right.kind === 'single') - Number(left.kind === 'single'))
        const activeSourceTask = sourceTasks[0]
        const manualSourceTask = sourceTasks.find((task) => task.kind === 'single')
        return <article
          className={'panel source-card' + (source.enabled ? '' : ' source-disabled') + (draggingSourceId === source.id ? ' is-dragging' : '') + (dropTargetSourceId === source.id ? ' is-drop-target' : '')}
          key={source.id}
          data-source-card-id={source.id}
          ref={(element) => { if (element) sourceCardElementsRef.current.set(source.id, element); else sourceCardElementsRef.current.delete(source.id) }}
        >
          <div className="source-card-head">
            <div className="source-card-head-leading">
              <button
                className="source-order-handle"
                type="button"
                disabled={props.busy || props.currentSources.length < 2}
                aria-label={`拖动调整${source.name}订阅顺序`}
                title="拖动调整订阅顺序"
                onPointerDown={(event) => startSourcePointerDrag(event, source.id)}
                onPointerMove={moveSourcePointerDrag}
                onPointerUp={finishSourcePointerDrag}
                onPointerCancel={(event) => finishSourcePointerDrag(event, true)}
                onLostPointerCapture={(event) => finishSourcePointerDrag(event, true)}
              >⠿</button>
              <button className="source-identity-toggle" type="button" aria-expanded={!collapsed} aria-controls={`source-extra-${source.id}`} aria-label={`${collapsed ? '展开' : '收起'}${source.name}订阅详情`} onClick={() => props.toggleSource(source.id)}>
                <span className="source-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="4.5" y="5" width="15" height="5.5" rx="1.8" /><rect x="4.5" y="13.5" width="15" height="5.5" rx="1.8" /><circle cx="7.5" cy="7.75" r=".7" /><circle cx="7.5" cy="16.25" r=".7" /><path d="M10 7.75h6M10 16.25h6" /></svg></span>
                <span className="source-identity-copy"><span className="source-identity-name">{source.name}</span><span className="source-meta"><span>{source.nodeCount} 个节点</span><span className={'source-updated' + (source.lastUpdated ? ' is-updated' : ' is-pending')} title={`具体时间：${shortTime(source.lastUpdated)}`}>{source.lastUpdated ? `上次更新 · ${relativeTime(source.lastUpdated)}` : '尚未更新'}</span></span></span>
              </button>
            </div>
            <div className="source-card-head-actions">
              {dirty && <span className="source-dirty-badge">未保存修改</span>}
              <label className="switch-label"><input type="checkbox" checked={draft.enabled} onChange={(event) => props.updateDraft(source.id, 'enabled', event.target.checked)} /><span className="switch" />{draft.enabled ? '已启用' : '已暂停'}</label>
              {activeSourceTask ? <>
                <button className="button secondary small source-refresh-button" type="button" disabled>{activeSourceTask.cancelRequested ? '正在停止…' : activeSourceTask.phase === '等待刷新' ? '等待刷新…' : '刷新中…'}</button>
                {manualSourceTask && <button className="button danger small source-refresh-button" type="button" disabled={manualSourceTask.cancelRequested || manualSourceTask.pending} onClick={() => props.stopSourceSync(manualSourceTask.taskId)}>{manualSourceTask.pending ? '正在准备…' : manualSourceTask.cancelRequested ? '正在停止…' : '停止刷新'}</button>}
              </> : <button className="button secondary small source-refresh-button" disabled={props.busy || !draft.url.trim()} onClick={() => props.refreshSource(draft)}>⟳ 刷新订阅</button>}
              <button className="button secondary small source-collapse-button" type="button" aria-expanded={!collapsed} aria-controls={`source-extra-${source.id}`} onClick={() => props.toggleSource(source.id)}>{collapsed ? '展开' : '收起'}<i className={'source-collapse-chevron ' + (collapsed ? 'down' : 'up')} aria-hidden="true" /></button>
            </div>
          </div>
          <SourceSubscriptionInfo info={source.subscriptionInfo} />
          {sourceTasks.map((task) => <div className={'source-sync-card-status' + (task.origin === 'clashVerge' ? ' external-sync' : '')} key={task.id} role="status" aria-live="polite">
            <span>{syncOriginLabel(task.origin)} · {task.sourceName || source.name}</span>
            <span>{task.cancelRequested ? '正在停止刷新…' : task.phase}</span>
            {task.phase === '等待刷新' ? <progress value={0} max={Math.max(1, task.total)} /> : <progress value={task.completed >= task.total ? task.total : undefined} max={Math.max(1, task.total)} />}
          </div>)}
          {source.lastError && <div className="inline-error">上次更新失败：{source.lastError}</div>}
          <div className="source-card-content" id={`source-extra-${source.id}`} hidden={collapsed}>
            {!collapsed && <>
              <section className="source-settings-section" aria-label={`${source.name}订阅设置`}>
                <div className="source-settings-heading"><strong>订阅设置</strong></div>
                <SourceFields source={draft} update={(key, value) => props.updateDraft(source.id, key, value)} />
              </section>
              {providerNodes.length > 0 && <SourceNodeInformation sourceId={source.id} sourceName={source.name} groups={sourceGroups} nodes={providerNodes} />}
              <div className="source-card-foot">
                <SourceNodeNameFormat source={draft} update={(key, value) => props.updateDraft(source.id, key, value)} />
                <div>
                  <button className="plain-button danger-text" title="删除来源；按住 Shift 点击可直接删除" onClick={(event) => props.deleteSource(source, event.shiftKey)}>删除</button>
                  <button className="button secondary small" disabled={!dirty || props.busy} onClick={() => props.saveSource(draft)}>保存</button>
                </div>
              </div>
            </>}
          </div>
        </article>
      })}
    </div>}
    <div className={'auto-routes-drawer' + (autoRoutesPanelOpen ? ' is-expanded' : '')}>
      <div className="auto-routes-drawer-inner">
        <div className="auto-routes-drawer-header">
          <button
            className="auto-routes-drawer-toggle"
            type="button"
            aria-expanded={autoRoutesPanelOpen}
            aria-controls="auto-routes-drawer-content"
            onClick={() => setAutoRoutesPanelOpen((open) => !open)}
          >
            <span className="auto-routes-drawer-title"><strong>合并订阅</strong><small>节点分组</small></span>
            <span className="auto-routes-drawer-counts"><span>{props.totalNodes} 个节点</span><span>{props.generatedGroups.length} 个分组</span></span>
            <i className="auto-routes-drawer-chevron" aria-hidden="true" />
          </button>
          {autoRoutesPanelOpen && <button className="button secondary auto-routes-name-settings" type="button" onClick={() => setAutoGroupNamingOpen(true)}>命名风格</button>}
        </div>
        {autoRoutesPanelOpen && <div className="auto-routes-drawer-content" id="auto-routes-drawer-content">
          <section className="auto-route-groups" aria-label="自动地区线路分组">
            <div className="auto-route-groups-heading"><strong>按订阅查看节点分组</strong><span>{props.generatedGroups.length} 组 · {props.totalNodes} 个节点</span></div>
            {props.generatedGroups.length > 0
              ? <div className="auto-route-provider-list">{props.currentSources.map((source) => {
                const sourceGroups = props.generatedGroups.filter((group) => group.sourceId === source.id)
                if (sourceGroups.length === 0) return null
                return <section className="auto-route-provider-group" key={source.id}>
                  <header><strong>{source.name}</strong><span>{sourceGroups.length} 组 · {sourceGroups.reduce((sum, group) => sum + group.nodes.length, 0)} 个节点</span></header>
                  <div className="auto-route-groups-list">{sourceGroups.map((group) => <article className="auto-route-group-item" key={group.id}>
                    <strong title={group.name}>{group.name}</strong>
                    <small>{group.nodes.length} 个节点</small>
                    <span>{group.country !== null ? '地区线路' : '全部节点线路'}</span>
                  </article>)}</div>
                </section>
              })}</div>
              : <p className="auto-route-groups-empty">当前没有自动线路分组；订阅刷新并识别到节点后会显示在这里。</p>}
          </section>
        </div>}
      </div>
    </div>
    {autoGroupNamingOpen && createPortal(<div className="policy-visual-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAutoGroupNamingOpen(false) }}>
      <section className="policy-visual-settings-dialog auto-route-name-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-route-name-settings-title">
        <header><div><strong id="auto-route-name-settings-title">自动地区线路命名风格</strong><small>拖动元素可实时预览顺序变化，保存后应用到自动线路名称。</small></div><button className="button secondary small" type="button" onClick={() => setAutoGroupNamingOpen(false)}>关闭</button></header>
        <div className="policy-visual-settings-scroll auto-route-name-settings-scroll">
          <AutoGroupNameStyle
            parts={activeNameParts}
            savedParts={savedNameParts}
            disabled={!props.settings || props.busy}
            hideHeading
            onChange={props.onAutoGroupNamePartsChange}
            onSave={props.saveAutoGroupNameParts}
          />
        </div>
        <footer><span>设置全局生效，不修改订阅卡片和原始节点名称。</span><button className="button primary" type="button" disabled={!props.settings || props.busy || !nameStyleChanged || !nameStyleValid} onClick={() => props.saveAutoGroupNameParts(activeNameParts)}>保存命名风格</button></footer>
      </section>
    </div>, document.body)}
    {sourceDragPreview && <div className="source-drag-preview" aria-hidden="true" style={{ left: sourceDragPreview.x, top: sourceDragPreview.y }}><strong>{sourceDragPreview.name}</strong><span>{sourceDragPreview.nodeCount} 个节点 · 松开放置</span></div>}
  </>
}

function ProfilePage(props: { snapshot: AppSnapshot | null; copyProfile: () => void; saveName: (name: string) => void; setTrafficSource: (sourceId: string) => void; openSettings: () => void; openUsage: () => void; busy: boolean }) {
  const snapshot = props.snapshot
  const [profileName, setProfileName] = useState(snapshot?.settings.profileName ?? 'Clash 管家')
  useEffect(() => setProfileName(snapshot?.settings.profileName ?? 'Clash 管家'), [snapshot?.settings.profileName])
  const selectedTrafficSource = snapshot ? snapshot.sources.find((source) => source.id === snapshot.settings.profileTrafficSourceId) : undefined
  const trafficStatus = snapshot?.trafficStatus ?? '等待连接 Mihomo'
  const connected = trafficStatus.startsWith('已连接')
  const paused = trafficStatus.includes('暂停') || snapshot?.settings.collectEnabled === false
  return <div className="profile-page">
    <section className="panel profile-hero">
      <div className="profile-hero-heading"><div><span className="section-kicker">CLASH VERGE PROFILE</span><h2>把合并后的配置添加到 Clash Verge</h2></div><span className="profile-local-badge"><i />仅本机</span></div>
      <div className="profile-address-row"><code title={snapshot?.profileUrl}>{snapshot?.profileUrl ?? '本机配置地址启动中…'}</code><button className="button primary" disabled={!snapshot?.profileUrl} onClick={props.copyProfile}>复制配置地址</button></div>
      <div className="profile-steps">
        <article><b>1</b><div><strong>复制地址</strong><span>复制上方本机地址。</span></div></article>
        <article><b>2</b><div><strong>添加远程配置</strong><span>在 Clash Verge 粘贴并保存地址。</span></div></article>
        <article><b>3</b><div><strong>刷新并启用</strong><span>刷新时同步已启用订阅，再返回最新配置。</span></div></article>
      </div>
      <div className="profile-options">
        <label className="field-label">配置名称<input value={profileName} maxLength={64} onChange={(event) => setProfileName(event.target.value)} placeholder="Clash 管家" /></label>
        <button className="button secondary" type="button" disabled={props.busy || !profileName.trim() || profileName === snapshot?.settings.profileName} onClick={() => props.saveName(profileName.trim())}>保存名称</button>
        <label className="field-label profile-traffic-source">在 Clash Verge 显示订阅流量<DropdownSelect value={snapshot?.settings.profileTrafficSourceId ?? ''} onValueChange={props.setTrafficSource}>
          <option value="">不显示</option>
          {(snapshot?.sources ?? []).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </DropdownSelect></label>
      </div>
      {selectedTrafficSource && <div className="profile-traffic-preview"><strong>{selectedTrafficSource.name} 套餐信息</strong><SourceSubscriptionInfo info={selectedTrafficSource.subscriptionInfo} /></div>}
    </section>
    <div className="profile-explain-grid">
      <section className="panel profile-explain-card">
        <span className="section-kicker">TRAFFIC ROUTE</span><h3>代理流量经过哪里</h3>
        <div className="profile-route"><span>应用生成 profile</span><b>→</b><span>Clash Verge / Mihomo 转发</span><b>→</b><span>目标站点</span></div>
      </section>
      <section className="panel profile-explain-card">
        <span className="section-kicker">COLLECTOR STATUS</span><h3>流量采集状态</h3>
        <div className={'profile-controller-status ' + (connected ? 'connected' : paused ? 'paused' : 'disconnected')}><i />{connected ? trafficStatus : paused ? '采集已暂停' : '尚未连接 Mihomo'}</div>
        <div className="profile-card-actions"><button className="button secondary small" onClick={props.openSettings}>打开设置</button><button className="button secondary small" onClick={props.openUsage}>查看流量分析</button></div>
      </section>
    </div>
    <div className="profile-page-footnote">采集期间请保持本程序运行；关闭窗口后程序会留在系统托盘。</div>
  </div>
}

function PolicySchemeManager(props: {
  templateOpen: boolean
  templateContent: ReactNode
  policies: SavedPolicy[]
  activePolicyId: string
  selectedPolicyId: string | null
  policyDirty: boolean
  busy: boolean
  onCreateBlank: (name: string) => void
  onImportTemplate: () => void
  onEditPolicy: (id: string) => void
  onRenamePolicy: (id: string, name: string) => Promise<boolean>
  onSetPolicyPinned: (id: string, pinned: boolean) => void
  onActivatePolicy: (id: string) => void
  onDeletePolicy: (id: string, skipConfirmation?: boolean) => void
}) {
  const [newName, setNewName] = useState(() => suggestedPolicyName(props.policies))
  const [showCreate, setShowCreate] = useState(false)
  const [renamingId, setRenamingId] = useState('')
  const [renamingName, setRenamingName] = useState('')
  const orderedPolicies = [...props.policies.filter((item) => item.pinned), ...props.policies.filter((item) => !item.pinned)]

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!renamingId || !renamingName.trim()) return
    if (await props.onRenamePolicy(renamingId, renamingName)) setRenamingId('')
  }

  return <>
    <section className="panel policy-scheme-page" aria-labelledby={props.templateOpen ? 'policy-import-title' : 'policy-scheme-library-title'}>
      {props.templateOpen ? props.templateContent : <section className="policy-scheme-library">
      <header className="policy-manager-header">
        <div className="policy-manager-heading"><h2 id="policy-scheme-library-title">方案库</h2><span>{props.policies.length} 套方案</span></div>
        <div className="policy-manager-header-actions">
          <button className="button secondary" disabled={props.busy} onClick={() => { setShowCreate(false); props.onImportTemplate() }}>从在线模板创建</button>
          <button className="button primary" onClick={() => setShowCreate((shown) => !shown)}>{showCreate ? '取消新建' : '＋ 新建空白方案'}</button>
        </div>
      </header>

      {showCreate && <section className="policy-manager-create" aria-labelledby="policy-manager-create-title">
        <div className="policy-manager-create-heading"><div><h3 id="policy-manager-create-title">新建空白方案</h3></div><button className="plain-button" type="button" onClick={() => setShowCreate(false)}>关闭</button></div>
        <div className="policy-manager-create-options">
          <form className="policy-manager-create-option" onSubmit={(event) => { event.preventDefault(); if (newName.trim()) props.onCreateBlank(newName) }}>
            <label className="field-label">方案名称<input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：工作与日常分流" /></label>
            <button className="button primary" type="submit" disabled={props.busy || !newName.trim()}>{props.busy ? '正在创建…' : '创建并编辑内容'}</button>
          </form>
        </div>
      </section>}

      {props.policies.length ? <div className="policy-scheme-list">
        {orderedPolicies.map((item) => {
          const isActive = item.id === props.activePolicyId
          const isSelected = item.id === props.selectedPolicyId
          const selectedDirty = isSelected && props.policyDirty
          return <article className={'policy-scheme-entry' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '')} key={item.id}>
            <div className="policy-scheme-entry-main">
              {renamingId === item.id
                ? <form id={'rename-policy-' + item.id} className="policy-scheme-rename-form" onSubmit={(event) => void saveRename(event)}>
                    <label className="field-label">方案名称<input autoFocus value={renamingName} onChange={(event) => setRenamingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenamingId('') }} /></label>
                  </form>
                : <>
                    <div className="policy-scheme-entry-title"><h3>{item.name}</h3>{item.pinned && <span className="policy-scheme-badge pinned">置顶</span>}{isActive && <span className="policy-scheme-badge active">当前生效</span>}{isSelected && <span className="policy-scheme-badge selected">当前查看</span>}{selectedDirty && <span className="policy-scheme-badge dirty">有未保存修改</span>}</div>
                    <p>{item.config.groups.length} 个策略组 <i>·</i> {item.config.rules.filter((rule) => !['MATCH', 'RULE-SET'].includes(rule.kind.trim().toUpperCase())).length} 条分流规则 <i>·</i> {item.config.rules.filter((rule) => rule.kind.trim().toUpperCase() === 'RULE-SET').length} 条规则集引用 <i>·</i> {item.config.rules.some((rule) => rule.kind.trim().toUpperCase() === 'MATCH') ? '含兜底' : '无兜底'}</p>
                    <small>最近保存：{shortTime(item.updatedAt)}</small>
                  </>}
            </div>
            <div className={'policy-scheme-entry-actions' + (renamingId === item.id ? ' is-renaming' : '')}>
              {renamingId === item.id ? <>
                <button className="button primary small" type="submit" form={'rename-policy-' + item.id} disabled={props.busy || !renamingName.trim()}>保存名称</button>
                <button className="button secondary small" type="button" onClick={() => setRenamingId('')}>取消</button>
              </> : <>
                <button className="button secondary small" disabled={props.busy} onClick={() => props.onEditPolicy(item.id)}>编辑</button>
                <button className={isActive ? 'button secondary small' : 'button primary small'} disabled={props.busy || isActive || selectedDirty} title={selectedDirty ? '请先保存或放弃当前未保存修改' : isActive ? '当前方案已启用' : '启用后更新本机配置'} onClick={() => props.onActivatePolicy(item.id)}>{isActive ? '已启用' : '启用方案'}</button>
                <div className="policy-scheme-maintenance-actions" aria-label="方案维护">
                  <button className={'policy-scheme-icon-button' + (item.pinned ? ' pinned' : '')} type="button" aria-label={(item.pinned ? '取消置顶方案：' : '置顶方案：') + item.name} title={item.pinned ? '取消置顶' : '置顶到方案列表前面'} disabled={props.busy} onClick={() => props.onSetPolicyPinned(item.id, !item.pinned)}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3.5h6l-.6 4 2.6 2.4v1.5H5v-1.5l2.6-2.4L7 3.5Z"/><path d="M10 11.4v5.1"/></svg>
                  </button>
                  <button className="policy-scheme-icon-button" type="button" aria-label={'重命名方案：' + item.name} title={selectedDirty ? '先保存或放弃当前方案修改，再重命名' : '重命名方案'} disabled={props.busy || selectedDirty} onClick={() => { setRenamingId(item.id); setRenamingName(item.name) }}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 13.9 13.7 3.7a1.8 1.8 0 0 1 2.6 0l.1.1a1.8 1.8 0 0 1 0 2.6L6.2 16.6 3 17l.5-3.1Z"/><path d="m11.9 5.5 2.6 2.6M3.7 13.8l2.5 2.5"/></svg>
                  </button>
                  <button className="policy-scheme-icon-button danger" type="button" aria-label={'删除方案：' + item.name} title={isActive ? '先启用其他方案，才能删除当前使用方案' : selectedDirty ? '先保存或放弃当前方案修改，再删除' : '删除方案；按住 Shift 点击可直接删除'} disabled={props.busy || isActive || selectedDirty} onClick={(event) => props.onDeletePolicy(item.id, event.shiftKey)}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.2h11M8 6.2V4.5h4v1.7m-6.2 0 .6 10h7.2l.6-10M8.3 9v4.7m3.4-4.7v4.7"/></svg>
                  </button>
                </div>
              </>}
            </div>
          </article>
        })}
      </div> : <div className="policy-scheme-empty"><strong>还没有保存的方案</strong><span>从上方创建空白方案，或选择在线模板。</span></div>}
      </section>}
    </section>
  </>
}

function ruleProviderDisplay(providers: Record<string, unknown>, id: string) {
  const raw = providers[id]
  const provider = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const url = typeof provider.url === 'string' ? provider.url : ''
  const explicitName = [provider.name, provider.title, provider.label]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
  let filename = ''
  let sourceLabel = ''
  if (url) {
    try {
      const parsed = new URL(url)
      filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
      sourceLabel = parsed.hostname + parsed.pathname
    } catch {
      filename = url.split(/[\\/]/).filter(Boolean).pop() ?? ''
      sourceLabel = url
    }
  }
  const readableFilename = filename.replace(/\.(yaml|yml|txt|list|mrs|dat)$/i, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  const aclRule = /^acl-rule-(\d+)$/i.exec(id)
  const customName = /^custom-(.+)$/i.exec(id)?.[1]?.replace(/[-_]+/g, ' ').trim()
  return {
    label: explicitName || customName || readableFilename || (aclRule ? `模板规则集 ${Number(aclRule[1]) + 1}` : id),
    sourceLabel,
    sourceUrl: url,
  }
}

function PolicyImportDialog(props: {
  open: boolean
  setOpen: (open: boolean) => void
  presetName: string
  setPresetName: (value: string) => void
  presetUrl: string
  setPresetUrl: (value: string) => void
  presetCatalogId: string
  presetCatalogGroups: typeof policyPresetGroups
  presetCount: number
  selectPresetCatalog: (id: string) => void
  presetCandidate: PolicyConfig | null
  setPresetCandidate: (policy: PolicyConfig | null) => void
  usePresetCandidate: () => void
  fetchPreset: () => void
  busy: boolean
  previewTab: 'groups' | 'rules' | 'providers' | 'raw'
  setPreviewTab: (tab: 'groups' | 'rules' | 'providers' | 'raw') => void
  previewOpen: boolean
  setPreviewOpen: (open: boolean) => void
}) {
  const selectedCatalogPreset = findPolicyPreset(props.presetCatalogId)
  const selectedCatalogGroup = findPolicyPresetGroup(props.presetCatalogId)
  useEffect(() => props.setPreviewOpen(false), [props.presetCandidate])

  return props.open ? <div className="policy-import-inline">
        <div className="policy-import-heading"><div><span className="section-kicker">在线模板</span><h2 id="policy-import-title">从在线模板创建</h2></div><div className="policy-import-heading-actions"><span className="editor-count">{props.presetCount} 套模板</span><button className="button secondary small" onClick={() => { props.setOpen(false); props.setPreviewOpen(false) }}>返回方案列表</button></div></div>
        <div className="policy-catalog-picker">
          <label className="field-label">在线方案
            <DropdownSelect value={props.presetCatalogId} onValueChange={props.selectPresetCatalog}>
              <option value="">自定义模板地址</option>
              {props.presetCatalogGroups.map((group) => <optgroup label={group.label} key={group.label}>
                {group.items.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
              </optgroup>)}
            </DropdownSelect>
          </label>
          <div className="policy-catalog-meta">
            <span>{selectedCatalogPreset ? selectedCatalogPreset.description : '粘贴任意 Clash YAML 或 ACL4SSR / Subconverter INI 地址。'}</span>
            <small>{selectedCatalogGroup ? <>来源：<a href={selectedCatalogGroup.sourceUrl} target="_blank" rel="noreferrer">{selectedCatalogGroup.source}</a> · 选择后本机直接下载模板</> : '自定义链接 · 仅在点击读取时下载'}</small>
          </div>
        </div>
        <div className="policy-import-fields">
          <label className="field-label">导入后的方案名称<input value={props.presetName} onChange={(event) => props.setPresetName(event.target.value)} /></label>
          <label className="field-label">模板地址<input value={props.presetUrl} onChange={(event) => props.setPresetUrl(event.target.value)} /></label>
          <button className="button primary" disabled={props.busy || !props.presetUrl} onClick={props.fetchPreset}>{props.busy ? '正在读取…' : '读取并预览'}</button>
        </div>
        {props.presetCandidate
          ? <div className="preset-candidate">
              <div className="preset-candidate-summary"><strong>{props.presetCandidate.templateName}</strong><span>{props.presetCandidate.groups.length} 个策略组 · {props.presetCandidate.rules.length} 条规则 · {Object.keys(props.presetCandidate.ruleProviders || {}).length} 个规则集</span><button className="button secondary small" onClick={() => { props.setPreviewTab('groups'); props.setPreviewOpen(!props.previewOpen) }}>{props.previewOpen ? '收起预览' : '完整预览'}</button></div>
              <div className="preset-candidate-actions"><button className="button secondary" disabled={props.busy} onClick={() => { props.setOpen(false); props.setPreviewOpen(false) }}>暂不载入</button><button className="button primary" disabled={props.busy} onClick={props.usePresetCandidate}>{props.busy ? '正在创建…' : '创建并编辑方案'}</button></div>
            </div>
          : <div className="preset-note"><span>i</span><p>原始订阅地址不会发送给模板来源。</p></div>}
        {props.presetCandidate && props.previewOpen && <section className="preset-inline-preview" aria-labelledby="preset-preview-title">
          <div className="preset-preview-heading"><div><span className="section-kicker">FULL TEMPLATE PREVIEW</span><h3 id="preset-preview-title">{props.presetCandidate.templateName}</h3><p>{props.presetCandidate.groups.length} 个策略组 · {props.presetCandidate.rules.length} 条规则 · {Object.keys(props.presetCandidate.ruleProviders || {}).length} 个规则集</p></div><button className="button secondary small" onClick={() => props.setPreviewOpen(false)}>收起预览</button></div>
        <div className="preset-preview-tabs" role="tablist" aria-label="模板完整预览">
          {([['groups', '全部策略组', props.presetCandidate.groups.length], ['rules', '全部规则', props.presetCandidate.rules.length], ['providers', '规则集', Object.keys(props.presetCandidate.ruleProviders || {}).length], ['raw', '原始模板', null]] as const).map(([key, label, count]) => <button key={key} className={props.previewTab === key ? 'active' : ''} onClick={() => props.setPreviewTab(key)}>{label}{count !== null && <span>{count}</span>}</button>)}
        </div>
        <div className="preset-inline-preview-body">
          {props.previewTab === 'groups' && <div className="preset-preview-list">{props.presetCandidate.groups.map((group) => <article key={group.id}><strong>{group.name || '未命名策略组'}</strong><span>{group.kind}</span><small>{group.allNodes ? '包含全部节点' : '筛选节点'}{group.sourceIds.length ? ' · 服务商：' + group.sourceIds.join('、') : ''}{group.countries.length ? ' · 地区：' + group.countries.join('、') : ''}{group.filter ? ' · 正则：' + group.filter : ''}{group.groupNames.length ? ' · 引用：' + group.groupNames.join('、') : ''}</small></article>)}</div>}
          {props.previewTab === 'rules' && <div className="preset-preview-list rule-preview-list">{props.presetCandidate.rules.map((rule, index) => {
            const provider = rule.kind.trim().toUpperCase() === 'RULE-SET'
              ? ruleProviderDisplay(props.presetCandidate!.ruleProviders ?? {}, rule.value)
              : null
            return <article key={String(index) + rule.kind + rule.value}><span className="rule-index">{String(index + 1).padStart(3, '0')}</span><strong>{rule.kind}</strong><span title={provider?.sourceUrl || undefined}>{provider?.label ?? (rule.value || '（无匹配值）')}</span><b>→ {rule.target}</b></article>
          })}</div>}
          {props.previewTab === 'providers' && <pre className="preset-raw-content">{JSON.stringify(props.presetCandidate.ruleProviders ?? {}, null, 2)}</pre>}
          {props.previewTab === 'raw' && <pre className="preset-raw-content">{props.presetCandidate.templateContent || '模板未提供原始正文。'}</pre>}
        </div>
        </section>}
  </div> : null
}

type GeneratedPolicyGroup = { id: string; sourceId: string; name: string; provider: string; country: string | null; nodes: string[] }

function isCountryGroupedValue(country: string) {
  const value = country.trim()
  return Boolean(value) && value !== '未识别'
}

function isCountryGroupedNode(node: ProxyNode) {
  return isCountryGroupedValue(node.country)
}

function generatedPolicyGroups(nodes: ProxyNode[], sources: Source[], autoGroupNameParts: string[]): GeneratedPolicyGroup[] {
  const bySource = new Map<string, { provider: string; nodes: string[] }>()
  for (const node of nodes) {
    const sourceNodes = bySource.get(node.sourceId) ?? { provider: node.sourceName, nodes: [] }
    sourceNodes.nodes.push(node.displayName)
    bySource.set(node.sourceId, sourceNodes)
  }
  const orderedSourceIds = [...sources.map((source) => source.id), ...Array.from(bySource.keys()).filter((id) => !sources.some((source) => source.id === id)).sort()]
  const groups: GeneratedPolicyGroup[] = []
  for (const sourceId of orderedSourceIds) {
    const sourceNodes = bySource.get(sourceId)
    if (!sourceNodes) continue
    const provider = sources.find((source) => source.id === sourceId)?.name ?? sourceNodes.provider
    groups.push({ id: 'auto:provider:' + sourceId, sourceId, name: composeAutoGroupName(autoGroupNameParts, provider, '全部节点'), provider, country: null, nodes: [...sourceNodes.nodes].sort((a, b) => nodeNameCollator.compare(a, b)) })
    const countries = new Map<string, string[]>()
    for (const node of nodes) {
      if (node.sourceId !== sourceId || !isCountryGroupedNode(node)) continue
      const countryNodes = countries.get(node.country) ?? []
      countryNodes.push(node.displayName)
      countries.set(node.country, countryNodes)
    }
    for (const [country, countryNodes] of countries) {
      const key = sourceId + '\0' + country
      groups.push({ id: 'auto:country:' + key, sourceId, name: composeAutoGroupName(autoGroupNameParts, provider, countryGroupDisplayName(country)), provider, country, nodes: countryNodes.sort((a, b) => nodeNameCollator.compare(a, b)) })
    }
  }
  return groups
}

function SourceNodeInformation(props: { sourceId: string; sourceName: string; groups: GeneratedPolicyGroup[]; nodes: ProxyNode[] }) {
  const [expanded, setExpanded] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState(`display:provider:${props.sourceId}`)
  const panelId = `source-node-information-${props.sourceId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const unassignedNodes = props.nodes.filter((node) => !isCountryGroupedNode(node))
  const groups: GeneratedPolicyGroup[] = [{
    id: `display:provider:${props.sourceId}`,
    sourceId: props.sourceId,
    name: '📦 ' + props.sourceName + ' · 全部节点',
    provider: props.sourceName,
    country: null,
    nodes: props.nodes.map((node) => node.displayName),
  }, ...props.groups.filter((group) => group.country !== null)]
  const unassignedGroup: GeneratedPolicyGroup = {
    id: `display:unassigned:${props.sourceId}`,
    sourceId: props.sourceId,
    name: '未纳入的节点 · ' + props.sourceName,
    provider: props.sourceName,
    country: '未识别',
    nodes: unassignedNodes.map((node) => node.displayName),
  }
  groups.push(unassignedGroup)
  const selectedGroup = groups.find((group) => group.id === selectedGroupId && group.nodes.length > 0) ?? groups[0]
  const selectedGroupLabel = selectedGroup.country === null ? '📦 全部节点' : isCountryGroupedValue(selectedGroup.country) ? countryGroupDisplayName(selectedGroup.country) : '🌐 未纳入的节点'
  const selectedGroupDescription = selectedGroup.country === null ? '该订阅的全部节点' : isCountryGroupedValue(selectedGroup.country) ? '按地区整理' : '未进入国家分组的节点'
  const nodeByDisplayName = new Map(props.nodes.map((node) => [node.displayName, node]))

  return <section className="source-line-groups" aria-label={`${props.sourceName}节点信息`}>
    <button className="source-node-info-toggle" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}>
      <span className="source-node-info-title"><strong>节点信息</strong><span>{props.nodes.length} 个节点</span></span>
      <span className="source-node-info-action">{expanded ? '收起' : '展开'}<i className={'source-collapse-chevron ' + (expanded ? 'up' : 'down')} aria-hidden="true" /></span>
    </button>
    {expanded && <div id={panelId} className="source-node-info-content">
      <div className="subscription-groups-selector" role="group" aria-label="选择节点分组">
        {groups.map((group) => {
          const label = group.country === null ? '📦 全部节点' : isCountryGroupedValue(group.country) ? countryGroupDisplayName(group.country) : '🌐 未纳入的节点'
          return <button className={'subscription-groups-selector-button' + (group.id === selectedGroup?.id ? ' is-selected' : '')} type="button" aria-pressed={group.id === selectedGroup?.id} disabled={group.nodes.length === 0} key={group.id} onClick={() => setSelectedGroupId(group.id)}><span>{label}</span><b>{group.nodes.length}</b></button>
        })}
      </div>
      {selectedGroup && <section className="subscription-group-detail" aria-label={selectedGroupLabel}>
        <div className="subscription-group-detail-heading"><span><strong>{selectedGroupLabel}</strong><small>{selectedGroupDescription}</small></span><b>{selectedGroup.nodes.length} 个节点</b></div>
        {selectedGroup.nodes.length > 0 ? <div className="subscription-group-members-panel">
          <div className="node-inspector-head"><span>生成后的节点名</span><span>订阅原名</span></div>
          {selectedGroup.nodes.map((displayName) => {
            const node = nodeByDisplayName.get(displayName)
            return <div className="node-inspector-row" key={node?.id ?? displayName}><strong>{displayName}</strong><span>{node?.originalName ?? '—'}</span></div>
          })}
        </div> : <div className="subscription-group-empty">暂无节点</div>}
      </section>}
    </div>}
  </section>
}

function communityRule(
  id: string, name: string, description: string, category: string | undefined,
  filename: string, source: PublicRuleSetPreset['source'], path = filename,
  behavior: PublicRuleSetPreset['behavior'] = publicRuleSetSources[source].behavior,
): PublicRuleSetPreset {
  const { base, format } = publicRuleSetSources[source]
  const purposeCategory: RuleSetPurposeCategory = (ruleSetPurposeCategories as readonly string[]).includes(category ?? '')
    ? category as RuleSetPurposeCategory
    : '其他用途'
  return { id, name, description, category: purposeCategory, filename, source, url: base + path, behavior, format }
}

const publicRuleSetCategories = ruleSetPurposeCategories

const publicRuleSetCatalog: PublicRuleSetPreset[] = [
  communityRule('openai', 'OpenAI', 'ChatGPT 与 OpenAI API 相关域名、地址规则。', 'AI 服务', 'OpenAI.list', 'blackmatrix7', 'OpenAI/OpenAI.list'),
  communityRule('claude', 'Claude', 'Claude 与 Anthropic 服务域名。', 'AI 服务', 'Claude.list', 'blackmatrix7', 'Claude/Claude.list'),
  communityRule('gemini', 'Gemini', 'Gemini 与 Google 生成式 AI 服务。', 'AI 服务', 'Gemini.list', 'blackmatrix7', 'Gemini/Gemini.list'),
  communityRule('copilot', 'Copilot', 'Microsoft Copilot 相关服务。', 'AI 服务', 'Copilot.list', 'blackmatrix7', 'Copilot/Copilot.list'),

  communityRule('google', 'Google', 'Google 搜索及相关服务。', '搜索与开发', 'Google.list', 'blackmatrix7', 'Google/Google.list'),
  communityRule('github', 'GitHub', 'GitHub 网站、代码托管与相关服务。', '搜索与开发', 'GitHub.list', 'blackmatrix7', 'GitHub/GitHub.list'),
  communityRule('bing', 'Bing', 'Bing 搜索服务。', '搜索与开发', 'Bing.list', 'blackmatrix7', 'Bing/Bing.list'),
  communityRule('gitlab', 'GitLab', 'GitLab 代码托管与相关服务。', '搜索与开发', 'GitLab.list', 'blackmatrix7', 'GitLab/GitLab.list'),

  communityRule('telegram', 'Telegram', 'Telegram 通信服务域名与 IP 规则。', '社交与通信', 'Telegram.list', 'acl4ssr'),
  communityRule('twitter', 'X / Twitter', 'X（原 Twitter）网站与服务域名。', '社交与通信', 'Twitter.list', 'blackmatrix7', 'Twitter/Twitter.list'),
  communityRule('facebook', 'Facebook', 'Facebook 社交平台相关域名与地址规则。', '社交与通信', 'Facebook.list', 'blackmatrix7', 'Facebook/Facebook.list'),
  communityRule('tiktok', 'TikTok', 'TikTok 服务域名与相关地址。', '社交与通信', 'TikTok.list', 'blackmatrix7', 'TikTok/TikTok.list'),
  communityRule('discord', 'Discord', 'Discord 通信平台服务域名。', '社交与通信', 'Discord.list', 'blackmatrix7', 'Discord/Discord.list'),
  communityRule('instagram', 'Instagram', 'Instagram 社交平台服务域名。', '社交与通信', 'Instagram.list', 'blackmatrix7', 'Instagram/Instagram.list'),
  communityRule('reddit', 'Reddit', 'Reddit 社区、图片与媒体域名。', '社交与通信', 'Reddit.list', 'blackmatrix7', 'Reddit/Reddit.list'),

  communityRule('youtube', 'YouTube', 'YouTube 视频服务域名与相关规则。', '影音与音乐', 'YouTube.list', 'acl4ssr', 'Ruleset/YouTube.list'),
  communityRule('netflix', 'Netflix', 'Netflix 视频服务域名。', '影音与音乐', 'Netflix.list', 'acl4ssr', 'Ruleset/Netflix.list'),
  communityRule('spotify', 'Spotify', 'Spotify 音乐服务域名与地址。', '影音与音乐', 'Spotify.list', 'blackmatrix7', 'Spotify/Spotify.list'),
  communityRule('disney', 'Disney+', 'Disney+ 与 Disney 媒体服务域名。', '影音与音乐', 'Disney.list', 'blackmatrix7', 'Disney/Disney.list'),
  communityRule('prime-video', 'Prime Video', 'Amazon Prime Video 视频服务域名。', '影音与音乐', 'AmazonPrimeVideo.list', 'blackmatrix7', 'AmazonPrimeVideo/AmazonPrimeVideo.list'),
  communityRule('twitch', 'Twitch', 'Twitch 直播、视频与相关地址。', '影音与音乐', 'Twitch.list', 'blackmatrix7', 'Twitch/Twitch.list'),
  communityRule('hulu', 'Hulu', 'Hulu 视频服务域名。', '影音与音乐', 'Hulu.list', 'blackmatrix7', 'Hulu/Hulu.list'),
  communityRule('proxy-media', '海外媒体集合', 'ACL4SSR 汇总的海外媒体服务规则；范围较广，添加前建议预览。', '影音与音乐', 'ProxyMedia.list', 'acl4ssr'),

  communityRule('steam', 'Steam', 'Steam 平台与游戏下载相关域名和地址。', '游戏平台', 'Steam.list', 'blackmatrix7', 'Steam/Steam.list'),
  communityRule('steam-cn', 'Steam 国内服务', 'Steam 国内下载与相关服务规则。', '游戏平台', 'SteamCN.list', 'acl4ssr', 'Ruleset/SteamCN.list'),
  communityRule('epic', 'Epic Games', 'Epic Games Store 与相关游戏服务。', '游戏平台', 'Epic.list', 'blackmatrix7', 'Epic/Epic.list'),
  communityRule('sony', 'PlayStation / Sony', 'PlayStation Network 与 Sony 相关服务。', '游戏平台', 'Sony.list', 'blackmatrix7', 'Sony/Sony.list'),
  communityRule('nintendo', 'Nintendo', 'Nintendo 游戏与在线服务域名。', '游戏平台', 'Nintendo.list', 'blackmatrix7', 'Nintendo/Nintendo.list'),
  communityRule('origin', 'EA app / Origin', 'EA app 与 Origin 游戏平台规则。', '游戏平台', 'Origin.list', 'acl4ssr', 'Ruleset/Origin.list'),

  communityRule('apple', 'Apple', 'Apple 设备、系统与在线服务域名。', '云服务与支付', 'Apple.list', 'acl4ssr'),
  communityRule('microsoft', 'Microsoft', 'Microsoft 在线服务与相关域名。', '云服务与支付', 'Microsoft.list', 'acl4ssr'),
  communityRule('onedrive', 'OneDrive', 'Microsoft OneDrive 云存储服务。', '云服务与支付', 'OneDrive.list', 'acl4ssr'),
  communityRule('dropbox', 'Dropbox', 'Dropbox 云存储与文件同步服务。', '云服务与支付', 'Dropbox.list', 'blackmatrix7', 'Dropbox/Dropbox.list'),
  communityRule('paypal', 'PayPal', 'PayPal 与 Braintree 支付服务域名。', '云服务与支付', 'PayPal.list', 'blackmatrix7', 'PayPal/PayPal.list'),
  communityRule('adobe', 'Adobe', 'Adobe Creative Cloud 与相关在线服务。', '云服务与支付', 'Adobe.list', 'blackmatrix7', 'Adobe/Adobe.list'),

  communityRule('google-cn', 'Google 国内服务', 'Google 在中国大陆可直连的相关域名。', '国内服务', 'GoogleCN.list', 'acl4ssr'),
  communityRule('google-fcm', 'Google FCM 推送', 'Google Firebase Cloud Messaging 推送服务。', '国内服务', 'GoogleFCM.list', 'acl4ssr', 'Ruleset/GoogleFCM.list'),
  communityRule('cn-domains', '国内常用域名', '国内常见网站域名与 CDN。', '国内服务', 'ChinaDomain.list', 'acl4ssr'),
  communityRule('cn-company-ip', '国内公司 IP', '国内公司与云服务厂商的 IP 网段。', '国内服务', 'ChinaCompanyIp.list', 'acl4ssr'),
  communityRule('cn-media', '国内媒体', '国内常用媒体服务域名。', '国内服务', 'ChinaMedia.list', 'acl4ssr'),
  communityRule('bilibili', '哔哩哔哩', '哔哩哔哩网站与相关服务。', '国内服务', 'Bilibili.list', 'acl4ssr', 'Ruleset/Bilibili.list'),
  communityRule('bilibili-hmt', '哔哩哔哩港澳台', '哔哩哔哩港澳台地区相关服务。', '国内服务', 'BilibiliHMT.list', 'acl4ssr', 'Ruleset/BilibiliHMT.list'),
  communityRule('netease-music', '网易云音乐', '网易云音乐服务规则。', '国内服务', 'NetEaseMusic.list', 'acl4ssr', 'Ruleset/NetEaseMusic.list'),
  communityRule('lan', '局域网与私有地址', '本地、路由器域名及私有 IP 网段，通常设为直连。', '网络与广告', 'LocalAreaNetwork.list', 'acl4ssr'),
  communityRule('ad', '常见广告拦截', '常见广告关键词与广告联盟域名。', '网络与广告', 'BanAD.list', 'acl4ssr'),
  communityRule('app-ad', '应用广告规则', '常用应用的广告规则，可能影响部分应用功能。', '网络与广告', 'BanProgramAD.list', 'acl4ssr'),
  communityRule('proxy-gfw', '常见代理域名', 'ACL4SSR 汇总的常见代理访问域名，条目较多。', '网络与广告', 'ProxyGFWlist.list', 'acl4ssr'),

  communityRule('meta-ai', 'AI 平台域名合集', 'OpenAI、Claude、Gemini、Perplexity 等常用 AI 服务域名。', 'AI 服务', 'category-ai-!cn.list', 'metacubex'),
  communityRule('meta-perplexity', 'Perplexity', 'Perplexity 搜索和文件服务相关域名。', 'AI 服务', 'perplexity.list', 'metacubex'),
  communityRule('meta-huggingface', 'Hugging Face', '模型仓库、模型文件和 Spaces 相关域名。', 'AI 服务', 'huggingface.list', 'metacubex'),
  communityRule('meta-deepseek', 'DeepSeek', 'DeepSeek 网站与服务域名。', 'AI 服务', 'deepseek.list', 'metacubex'),
  communityRule('meta-cursor', 'Cursor', 'Cursor 编辑器、更新与 API 相关域名。', '搜索与开发', 'cursor.list', 'metacubex'),
  communityRule('meta-scholar', '海外学术站点', '学术搜索、论文数据库和学术出版资源相关域名。', '搜索与开发', 'category-scholar-!cn.list', 'metacubex'),
  communityRule('meta-docker', 'Docker', 'Docker Hub、镜像分发与 Docker 相关域名。', '搜索与开发', 'docker.list', 'metacubex'),
  communityRule('meta-notion', 'Notion', 'Notion 工作区、静态文件和发布页面相关域名。', '云服务与支付', 'notion.list', 'metacubex'),
  communityRule('meta-cloudflare', 'Cloudflare', 'Cloudflare CDN、DNS、Workers 和其他平台服务域名。', '云服务与支付', 'cloudflare.list', 'metacubex'),
  communityRule('meta-whatsapp', 'WhatsApp', 'WhatsApp 通信服务相关域名。', '社交与通信', 'whatsapp.list', 'metacubex'),
  communityRule('meta-signal', 'Signal', 'Signal 消息与通话服务相关域名。', '社交与通信', 'signal.list', 'metacubex'),
  communityRule('meta-slack', 'Slack', 'Slack 工作区、消息和文件服务相关域名。', '社交与通信', 'slack.list', 'metacubex'),
  communityRule('meta-zoom', 'Zoom', 'Zoom 视频会议相关域名。', '社交与通信', 'zoom.list', 'metacubex'),
  communityRule('meta-proton-mail', 'Proton Mail', 'Proton 邮件及相关服务域名。', '社交与通信', 'protonmail.list', 'metacubex'),
  communityRule('meta-xbox', 'Xbox', 'Xbox、Game Pass 与相关游戏和在线服务域名。', '游戏平台', 'xbox.list', 'metacubex'),
  communityRule('meta-tailscale', 'Tailscale', 'Tailscale 网络服务及 ts.net 域名。', '网络与广告', 'tailscale.list', 'metacubex'),

  communityRule('loyal-apple', 'Apple 域名合集', 'Loyalsoldier 维护的 Apple 服务域名。', '云服务与支付', 'apple.txt', 'loyalsoldier'),
  communityRule('loyal-icloud', 'iCloud', 'iCloud 云同步及相关服务域名。', '云服务与支付', 'icloud.txt', 'loyalsoldier'),
  communityRule('loyal-lan-domain', '本地与路由器域名', '路由器管理地址与常见本地网络域名。', '网络与广告', 'private.txt', 'loyalsoldier'),
  communityRule('loyal-lan-ip', '局域网与保留 IP 网段', '局域网、回环与其他保留地址网段。', '网络与广告', 'lancidr.txt', 'loyalsoldier', 'lancidr.txt', 'ipcidr'),
  communityRule('loyal-cn-ip', '中国大陆 IP 网段', '按目的 IP 匹配中国大陆地址。', '国内服务', 'cncidr.txt', 'loyalsoldier', 'cncidr.txt', 'ipcidr'),
  communityRule('loyal-telegram-ip', 'Telegram IP 网段', 'Telegram 服务所使用的 IP 地址段。', '社交与通信', 'telegramcidr.txt', 'loyalsoldier', 'telegramcidr.txt', 'ipcidr'),
  communityRule('loyal-tld', '境外常用顶级域名', '按顶级域名匹配，适合覆盖范围较广的分流。', '网络与广告', 'tld-not-cn.txt', 'loyalsoldier'),
  communityRule('loyal-apps', '常见直连应用', '按进程名匹配常见应用，上游示例用于直连。', '网络与广告', 'applications.txt', 'loyalsoldier', 'applications.txt', 'classical'),

  communityRule('sukka-ai', '常用 AI 服务域名', 'Sukka 维护的 OpenAI、Claude、Gemini 和其他 AI 服务域名。', 'AI 服务', 'ai.txt', 'sukka', 'non_ip/ai.txt'),
  communityRule('sukka-apple-intelligence', 'Apple Intelligence', 'Apple Intelligence 服务相关域名。', 'AI 服务', 'apple_intelligence.txt', 'sukka', 'non_ip/apple_intelligence.txt'),
  communityRule('sukka-stream-us', '北美流媒体域名', 'Sukka 收录的北美地区流媒体平台域名。', '影音与音乐', 'stream_us.txt', 'sukka', 'non_ip/stream_us.txt'),
  communityRule('sukka-stream-eu', '欧洲流媒体域名', 'Sukka 收录的欧洲地区流媒体平台域名。', '影音与音乐', 'stream_eu.txt', 'sukka', 'non_ip/stream_eu.txt'),
  communityRule('sukka-stream-jp', '日本流媒体域名', 'Sukka 收录的日本地区流媒体平台域名。', '影音与音乐', 'stream_jp.txt', 'sukka', 'non_ip/stream_jp.txt'),
  communityRule('sukka-stream-kr', '韩国流媒体域名', 'Sukka 收录的韩国地区流媒体平台域名。', '影音与音乐', 'stream_kr.txt', 'sukka', 'non_ip/stream_kr.txt'),
  communityRule('sukka-stream-hk', '香港流媒体域名', 'Sukka 收录的香港地区流媒体平台域名。', '影音与音乐', 'stream_hk.txt', 'sukka', 'non_ip/stream_hk.txt'),
  communityRule('sukka-stream-tw', '台湾流媒体域名', 'Sukka 收录的台湾地区流媒体平台域名。', '影音与音乐', 'stream_tw.txt', 'sukka', 'non_ip/stream_tw.txt'),
  communityRule('sukka-apple-cn', 'Apple 国内专用服务', '云上贵州 iCloud 和 Apple 地图等国内服务域名。', '国内服务', 'apple_cn.txt', 'sukka', 'non_ip/apple_cn.txt'),
  communityRule('sukka-apple-cdn', 'Apple 国内 CDN', 'Apple 在中国大陆的 CDN 和下载域名。', '国内服务', 'apple_cdn.txt', 'sukka', 'domainset/apple_cdn.txt', 'domain'),
  communityRule('sukka-ms-cdn', 'Microsoft 国内 CDN', 'Microsoft 在中国大陆的 CDN 和下载域名。', '国内服务', 'microsoft_cdn.txt', 'sukka', 'non_ip/microsoft_cdn.txt'),
  communityRule('sukka-download', '软件与大文件下载', '软件更新、容器镜像和常见大文件托管域名。', '网络与广告', 'download.txt', 'sukka', 'domainset/download.txt', 'domain'),
  communityRule('sukka-game-download', '游戏下载 CDN', 'Steam、Epic、EA 等平台的游戏下载域名。', '游戏平台', 'game-download.txt', 'sukka', 'domainset/game-download.txt', 'domain'),
  communityRule('sukka-speedtest', '测速服务', '常见测速网站及测速服务器域名。', '网络与广告', 'speedtest.txt', 'sukka', 'domainset/speedtest.txt', 'domain'),
  communityRule('sukka-icloud-relay', 'iCloud Private Relay', 'iCloud Private Relay 服务端域名。', '云服务与支付', 'icloud_private_relay.txt', 'sukka', 'domainset/icloud_private_relay.txt', 'domain'),
  communityRule('sukka-sogouinput', '搜狗输入法相关域名', '搜狗输入法的遥测、账号和在线功能域名，拦截后可能影响部分功能。', '网络与广告', 'sogouinput.txt', 'sukka', 'non_ip/sogouinput.txt'),
]

function savedCommunityRuleSetCatalog(items: RuleSetItem[]): PublicRuleSetPreset[] {
  const knownUrls = new Set(publicRuleSetCatalog.map((preset) => preset.url.trim()))
  const addedUrls = new Set<string>()
  const sources = Object.entries(publicRuleSetSources) as [PublicRuleSetSource, (typeof publicRuleSetSources)[PublicRuleSetSource]][]

  return items.flatMap((item) => {
    const url = typeof item.provider.url === 'string' ? item.provider.url.trim() : ''
    const sourceEntry = sources.find(([, source]) => url.startsWith(source.base))
    if (!url || !sourceEntry || knownUrls.has(url) || addedUrls.has(url)) return []

    addedUrls.add(url)
    const [source, sourceConfig] = sourceEntry
    const pathname = url.split(/[?#]/, 1)[0]
    const filename = pathname.slice(sourceConfig.base.length).split('/').filter(Boolean).pop() || item.name
    const providerBehavior = item.provider.behavior
    const providerFormat = item.provider.format
    const behavior: PublicRuleSetPreset['behavior'] = providerBehavior === 'domain' || providerBehavior === 'ipcidr' || providerBehavior === 'classical' || providerBehavior === 'auto'
      ? providerBehavior
      : sourceConfig.behavior
    const format: PublicRuleSetPreset['format'] = providerFormat === 'text' || providerFormat === 'yaml' || providerFormat === 'auto'
      ? providerFormat
      : sourceConfig.format

    return [{
      id: `saved-${item.id}`,
      name: item.name,
      description: item.description.trim() || `已保存在规则集库中的 ${sourceConfig.label} 规则集。`,
      category: resolveRuleSetPurpose(item.category, item.name, item.description, url) as RuleSetPurposeCategory,
      filename,
      source,
      url,
      behavior,
      format,
    }]
  })
}

function ruleKindLabel(kind: string) {
  return manualRuleKinds.find((item) => item.value === kind.toUpperCase())?.label ?? kind
}

function parseManualRule(value: string) {
  const [kind, ...rest] = value.split(',')
  return { kind: kind.trim().toUpperCase(), value: rest.join(',').trim() }
}

const rulePageSize = 20

function RuleSetForm(props: RuleSetFormProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const initialProvider = props.initial?.provider ?? {}
  const [mode, setMode] = useState<'http' | 'inline'>(() => initialProvider.type === 'inline' ? 'inline' : 'http')
  const [name, setName] = useState(props.initial?.name ?? '')
  const [description, setDescription] = useState(props.initial?.description ?? '')
  const [category, setCategory] = useState(() => resolveRuleSetPurpose(props.initial?.category, props.initial?.name ?? '', props.initial?.description ?? '', typeof initialProvider.url === 'string' ? initialProvider.url : ''))
  const [url, setUrl] = useState(typeof initialProvider.url === 'string' ? initialProvider.url : '')
  const [behavior, setBehavior] = useState(typeof initialProvider.behavior === 'string' ? initialProvider.behavior : 'auto')
  const [format, setFormat] = useState(typeof initialProvider.format === 'string' ? initialProvider.format : 'auto')
  const [intervalHours, setIntervalHours] = useState(initialProvider.interval === 0 ? '0' : String(Math.max(1, Math.round(Number(initialProvider.interval ?? 86400) / 3600))))
  const [entries, setEntries] = useState<string[]>(() => Array.isArray(initialProvider.payload) ? initialProvider.payload.filter((entry): entry is string => typeof entry === 'string') : [])
  const [remoteEntries, setRemoteEntries] = useState<string[]>(props.initial?.remoteEntries ?? [])
  const [localAdditions, setLocalAdditions] = useState<string[]>(props.initial?.localAdditions ?? [])
  const [excludedEntries, setExcludedEntries] = useState<string[]>(props.initial?.excludedEntries ?? [])
  const [ruleKind, setRuleKind] = useState('DOMAIN-SUFFIX')
  const [ruleValue, setRuleValue] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  const [rulePage, setRulePage] = useState(0)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogSource, setCatalogSource] = useState<PublicRuleSetPreset['source'] | null>(null)
  const [catalogCategory, setCatalogCategory] = useState<string | null>(null)
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<string[]>([])
  const [batchProgress, setBatchProgress] = useState<CommunityBatchProgress | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [communityDetails, setCommunityDetails] = useState<CommunityRuleDetails | null>(null)
  const communityDetailsRequestId = useRef(0)
  const [previewResult, setPreviewResult] = useState<RuleSetPreview | null>(() => props.initial?.checkedAt ? {
    entryCount: props.initial.entryCount,
    sample: props.initial.sample,
    summary: props.initial.entryCount === null ? 'MRS 在线规则已登记；二进制内容不能逐条查看。' : `已保存 ${props.initial.remoteEntries?.length ?? props.initial.entryCount} 条远端规则。`,
    behavior: typeof initialProvider.behavior === 'string' ? initialProvider.behavior : 'classical',
    format: typeof initialProvider.format === 'string' ? initialProvider.format : 'text',
    entries: props.initial.remoteEntries ?? [],
    downloadedAt: '',
    mrsHash: props.initial.mrsHash,
  } : null)
  const initialUrl = typeof initialProvider.url === 'string' ? initialProvider.url : ''
  const initialBehavior = typeof initialProvider.behavior === 'string' ? initialProvider.behavior : 'classical'
  const initialFormat = typeof initialProvider.format === 'string' ? initialProvider.format : 'text'
  const initialSourceKey = `${initialUrl.trim()}|${initialBehavior}|${initialFormat}`
  const currentPreviewKey = `${url.trim()}|${behavior}|${format}`
  const [previewKey, setPreviewKey] = useState(() => props.initial?.checkedAt && ((props.initial.remoteEntries?.length ?? 0) > 0 || initialFormat === 'mrs') ? initialSourceKey : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [catalogOpen, mode])

  useEffect(() => () => {
    communityDetailsRequestId.current += 1
  }, [])

  const working = saving || Boolean(props.busy)
  const previewReady = mode === 'http' && previewKey === currentPreviewKey
  const isMRS = mode === 'http' && format === 'mrs'
  const sourceChanged = props.initial !== null && currentPreviewKey !== initialSourceKey
  const hasOverlay = localAdditions.length > 0 || excludedEntries.length > 0
  const needsPreview = mode === 'http' && (!props.initial || sourceChanged || hasOverlay)
  const excludedKeys = new Set(excludedEntries.map(normalizeRuleEntry))
  const baseRules = remoteEntries.filter((entry) => !excludedKeys.has(normalizeRuleEntry(entry)))
  const ruleQuery = ruleSearch.trim().toLocaleLowerCase()
  const matchingRules = ruleQuery
    ? baseRules.filter((entry) => displayRuleEntry(entry, behavior).toLocaleLowerCase().includes(ruleQuery))
    : baseRules
  const rulePageCount = Math.max(1, Math.ceil(matchingRules.length / rulePageSize))
  const currentRulePage = Math.min(rulePage, rulePageCount - 1)
  const pageStart = currentRulePage * rulePageSize
  const pageRules = matchingRules.slice(pageStart, pageStart + rulePageSize)
  const catalogQuery = catalogSearch.trim().toLocaleLowerCase()
  const communityCatalog = [...publicRuleSetCatalog, ...savedCommunityRuleSetCatalog(props.existingItems)]
  const matchingCatalogRules = communityCatalog.filter((item) => {
    if (catalogSource !== null && item.source !== catalogSource) return false
    if (catalogCategory !== null && item.category !== catalogCategory) return false
    if (!catalogQuery) return true
    const searchText = `${item.name} ${item.description} ${item.category} ${item.filename} ${publicRuleSetSources[item.source].name}`
    return searchText.toLocaleLowerCase().includes(catalogQuery)
  })
  const visibleCatalogGroups = publicRuleSetCategories.map((category) => ({
    category,
    items: matchingCatalogRules.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0)
  const visibleCatalogCount = visibleCatalogGroups.reduce((total, group) => total + group.items.length, 0)
  const existingRuleSetUrls = new Set(props.existingItems.map((item) => typeof item.provider.url === 'string' ? item.provider.url.trim() : '').filter(Boolean))
  const existingRuleSetNames = new Set(props.existingItems.map((item) => item.name.trim().toLocaleLowerCase()).filter(Boolean))
  const selectedCatalogPresets = communityCatalog.filter((preset) => selectedCatalogIds.includes(preset.id) && !existingRuleSetUrls.has(preset.url.trim()) && !existingRuleSetNames.has(preset.name.trim().toLocaleLowerCase()))
  const selectableCurrentCatalogPresets = matchingCatalogRules.filter((preset) => !existingRuleSetUrls.has(preset.url.trim()) && !existingRuleSetNames.has(preset.name.trim().toLocaleLowerCase()))
  const allCurrentCatalogSelected = selectableCurrentCatalogPresets.length > 0 && selectableCurrentCatalogPresets.every((preset) => selectedCatalogIds.includes(preset.id))
  const rulePayload = entries.map(parseManualRule)

  async function readRemote(sourceUrl = url, requestedBehavior = behavior, requestedFormat = format) {
    setSaving(true)
    setError('')
    try {
      const normalizedUrl = sourceUrl.trim()
      const result = await props.preview(normalizedUrl, requestedBehavior, requestedFormat)
      setPreviewResult(result)
      setRemoteEntries(result.entries)
      setRulePage(0)
      setBehavior(result.behavior)
      setFormat(result.format)
      setPreviewKey(`${normalizedUrl}|${result.behavior}|${result.format}`)
    } catch (cause) {
      setError(String(cause))
      setPreviewResult(null)
      setPreviewKey('')
    } finally {
      setSaving(false)
    }
  }

  async function choosePublicRuleSet(preset: PublicRuleSetPreset) {
    setMode('http')
    setCatalogOpen(false)
    setName(preset.name)
    setDescription(preset.description)
    setCategory(preset.category)
    setUrl(preset.url)
    setBehavior(preset.behavior)
    setFormat(preset.format)
    setIntervalHours('24')
    setRemoteEntries([])
    setLocalAdditions([])
    setExcludedEntries([])
    setPreviewResult(null)
    setPreviewKey('')
    await readRemote(preset.url, preset.behavior, preset.format)
  }

  function openCommunityRuleDetails(preset: PublicRuleSetPreset) {
    const requestId = ++communityDetailsRequestId.current
    const savedItem = props.existingItems.find((item) => typeof item.provider.url === 'string' && item.provider.url.trim() === preset.url.trim())
    const item: RuleSetItem = savedItem
      ? { ...savedItem, id: `community-detail-${preset.id}`, name: preset.name, category: preset.category, description: preset.description, provider: { ...savedItem.provider, url: preset.url } }
      : {
        id: `community-detail-${preset.id}`,
        name: preset.name,
        category: preset.category,
        provider: { type: 'http', url: preset.url, behavior: preset.behavior, format: preset.format },
        description: preset.description,
        remoteEntries: [],
        localAdditions: [],
        excludedEntries: [],
        entryCount: null,
        sample: [],
        checkedAt: '',
        syncedAt: '',
        updateAvailable: null,
        mrsHash: '',
        updatedAt: '',
      }
    setCommunityDetails({ item, requestId, loading: !savedItem, error: '' })
    if (savedItem) return

    void props.preview(preset.url, preset.behavior, preset.format).then((preview) => {
      setCommunityDetails((current) => current?.requestId === requestId ? {
        ...current,
        loading: false,
        item: {
          ...current.item,
          provider: { ...current.item.provider, behavior: preview.behavior, format: preview.format },
          remoteEntries: preview.entries,
          entryCount: preview.entryCount,
          sample: preview.sample,
          mrsHash: preview.mrsHash,
          updatedAt: preview.downloadedAt,
        },
      } : current)
    }).catch((cause: unknown) => {
      const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/, '')
      setCommunityDetails((current) => current?.requestId === requestId ? { ...current, loading: false, error: detail } : current)
    })
  }

  function closeCommunityRuleDetails() {
    communityDetailsRequestId.current += 1
    setCommunityDetails(null)
  }

  function toggleCatalogPreset(preset: PublicRuleSetPreset) {
    setSelectedCatalogIds((current) => current.includes(preset.id)
      ? current.filter((id) => id !== preset.id)
      : [...current, preset.id])
  }

  function toggleCurrentCatalogSelection() {
    const currentIds = new Set(selectableCurrentCatalogPresets.map((preset) => preset.id))
    setSelectedCatalogIds((current) => allCurrentCatalogSelected
      ? current.filter((id) => !currentIds.has(id))
      : [...new Set([...current, ...currentIds])])
  }

  async function addSelectedCatalogPresets() {
    if (working || selectedCatalogPresets.length === 0) return
    const presets = selectedCatalogPresets
    setBatchRunning(true)
    try {
      const results = await props.batchAdd(presets, setBatchProgress)
      const handled = new Set(results.filter((result) => result.status !== 'failed').map((result) => result.presetId))
      setSelectedCatalogIds((current) => current.filter((id) => !handled.has(id)))
    } catch (cause) {
      const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/, '')
      setBatchProgress({
        completed: 0,
        total: presets.length,
        current: [],
        results: presets.map((preset) => ({ presetId: preset.id, name: preset.name, status: 'failed', detail })),
      })
    } finally {
      setBatchRunning(false)
    }
  }

  function validateRule(raw: string): string | null {
    if (!raw || raw.includes(',') || /[\r\n]/.test(raw)) return '每条规则填写一个值，不要加入逗号或换行。'
    if (['DOMAIN', 'DOMAIN-SUFFIX'].includes(ruleKind) || (mode === 'http' && behavior === 'domain')) {
      try {
        const address = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\*\./, '')}`)
        const value = address.hostname.toLowerCase().replace(/\.$/, '')
        if (!value.includes('.')) throw new Error('domain')
        return null
      } catch { return '请输入有效域名，例如 example.com。' }
    }
    if (ruleKind === 'IP-CIDR' || (mode === 'http' && behavior === 'ipcidr' && !raw.includes(':'))) {
      const [address, prefix] = raw.split('/')
      const octets = address?.split('.').map(Number) ?? []
      if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) || !/^\d+$/.test(prefix ?? '') || Number(prefix) > 32) return 'IPv4 网段格式应为 192.168.1.0/24。'
    }
    if (ruleKind === 'IP-CIDR6' || (mode === 'http' && behavior === 'ipcidr' && raw.includes(':'))) {
      const [address, prefix] = raw.split('/')
      if (!address?.includes(':') || !/^[\da-f:]+$/i.test(address) || !/^\d+$/.test(prefix ?? '') || Number(prefix) > 128) return 'IPv6 网段格式应为 2001:db8::/32。'
    }
    return null
  }

  function addRule() {
    const raw = ruleValue.trim()
    const validationError = validateRule(raw)
    if (validationError) { setError(validationError); return }
    let value = raw
    if (['DOMAIN', 'DOMAIN-SUFFIX'].includes(ruleKind) || (mode === 'http' && behavior === 'domain')) {
      value = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\*\./, '')}`).hostname.toLowerCase().replace(/\.$/, '')
    }
    const addition = mode === 'inline' || behavior === 'classical' ? `${ruleKind},${value}` : value
    const list = mode === 'inline' ? entries : localAdditions
    if (list.some((entry) => normalizeRuleEntry(entry) === normalizeRuleEntry(addition))) { setError('这条规则已在列表中。'); return }
    if (mode === 'inline') setEntries((current) => [...current, addition])
    else {
      setLocalAdditions((current) => [...current, addition])
      setExcludedEntries((current) => current.filter((entry) => normalizeRuleEntry(entry) !== normalizeRuleEntry(addition)))
    }
    setRuleValue('')
    setError('')
  }

  function toggleExcluded(entry: string) {
    setExcludedEntries((current) => current.some((item) => normalizeRuleEntry(item) === normalizeRuleEntry(entry))
      ? current.filter((item) => normalizeRuleEntry(item) !== normalizeRuleEntry(entry))
      : [...current, entry])
  }

  async function saveItem() {
    const trimmedName = name.trim()
    if (!trimmedName) { setError('请填写规则集名称。'); return }
    if (mode === 'http' && !props.initial && !previewReady) { setError('先拉取在线规则并预览，再保存规则集。'); return }
    if (mode === 'http' && (hasOverlay || sourceChanged) && !previewReady) { setError('来源地址或类型有变化，或正在维护本地改动；请先拉取当前在线规则。'); return }
    if (mode === 'http' && hasOverlay && remoteEntries.length === 0) { setError('本地追加或屏蔽规则前，请先拉取可逐条编辑的在线规则。'); return }
    if (mode === 'http' && isMRS && hasOverlay) { setError('MRS 是二进制规则集，无法逐条追加或屏蔽规则。'); return }
    if (mode === 'inline' && entries.length === 0) { setError('至少添加一条规则。'); return }
    const provider: Record<string, unknown> = mode === 'inline'
      ? { type: 'inline', behavior: 'classical', payload: entries }
      : { ...initialProvider, type: 'http', behavior, format, interval: intervalHours === '0' ? 0 : Math.max(3600, Number(intervalHours) * 3600 || 86400), url: url.trim() }
    const savedRemoteEntries = mode === 'http' ? (previewReady ? remoteEntries : props.initial?.remoteEntries ?? []) : []
    const downloadedAt = previewReady ? previewResult?.downloadedAt || null : null
    const remoteInfo = downloadedAt ? previewResult : props.initial
    const item: RuleSetItem = {
      id: props.initial?.id ?? '',
      name: trimmedName,
      category,
      description: description.trim(),
      provider,
      remoteEntries: savedRemoteEntries,
      localAdditions: mode === 'http' ? localAdditions : [],
      excludedEntries: mode === 'http' ? excludedEntries : [],
      entryCount: mode === 'inline' ? entries.length : remoteInfo?.entryCount ?? null,
      sample: mode === 'inline' ? entries.slice(0, 5) : remoteInfo?.sample ?? [],
      checkedAt: '',
      syncedAt: '',
      updateAvailable: null,
      mrsHash: isMRS ? remoteInfo?.mrsHash ?? '' : '',
      updatedAt: props.initial?.updatedAt ?? '',
    }
    setSaving(true)
    setError('')
    try {
      await props.save(item, downloadedAt)
    } catch (cause) { setError(String(cause)) }
    finally { setSaving(false) }
  }

  const remoteEffectiveCount = new Set([...baseRules, ...localAdditions].map(normalizeRuleEntry)).size
  const editorKinds = mode === 'http' && behavior === 'domain'
    ? [{ value: 'DOMAIN-SUFFIX', label: '网站域名' }]
    : mode === 'http' && behavior === 'ipcidr'
      ? [{ value: 'IP-CIDR', label: 'IP 网段' }, { value: 'IP-CIDR6', label: 'IPv6 网段' }]
      : manualRuleKinds

  return <>
  <section className="ruleset-form ruleset-editor-page" aria-label={props.initial ? '编辑规则集' : '新建规则集'}>
    <header className="ruleset-form-heading"><h2 id="ruleset-editor-title">{props.initial ? `编辑规则集：${props.initial.name}` : '新增规则集'}</h2><button className="button secondary small" type="button" disabled={working} onClick={props.cancel}>关闭</button></header>
    <div className="ruleset-form-content" ref={contentRef}>
      {!props.initial && <div className="ruleset-mode-switch" role="group" aria-label="规则集创建方式"><button type="button" disabled={working} aria-pressed={mode === 'http' && !catalogOpen} className={mode === 'http' && !catalogOpen ? 'active' : ''} onClick={() => { setMode('http'); setCatalogOpen(false); setError('') }}>从网址下载</button><button type="button" disabled={working} aria-pressed={mode === 'http' && catalogOpen} className={mode === 'http' && catalogOpen ? 'active' : ''} onClick={() => { setMode('http'); setCatalogOpen(true); setError('') }}>社区规则</button><button type="button" disabled={working} aria-pressed={mode === 'inline'} className={mode === 'inline' ? 'active' : ''} onClick={() => { setMode('inline'); setCatalogOpen(false); setError('') }}>手动创建</button></div>}
      {!props.initial && catalogOpen && <section className="ruleset-detail-section ruleset-public-catalog">
        <header><div><strong>社区规则目录 <span className="ruleset-catalog-count" aria-live="polite">{visibleCatalogCount} 项</span></strong><small>按常见服务分类，常用网站排在前面。已保存在规则集库中的社区来源规则也会显示并标记为已添加。</small></div><label className="ruleset-search">搜索<input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="搜索服务、用途或来源" /></label></header>
        <div className="ruleset-catalog-filters">
          <div className="ruleset-catalog-filter-row">
            <span>来源</span>
            <div className="ruleset-mode-switch" role="group" aria-label="社区规则来源">
              {publicRuleSetSourceOptions.map(({ source, label }) => <button
                key={source ?? 'all'}
                type="button"
                className={catalogSource === source ? 'active' : ''}
                aria-pressed={catalogSource === source}
                disabled={working}
                onClick={() => setCatalogSource(source)}
              >{label}</button>)}
            </div>
          </div>
          <div className="ruleset-catalog-filter-row">
            <span>分类</span>
            <div className="ruleset-mode-switch" role="group" aria-label="社区规则分类">
              {[{ category: null, label: '全部分类' }, ...publicRuleSetCategories.map((category) => ({ category, label: category }))].map(({ category, label }) => <button
                key={category ?? 'all'}
                type="button"
                className={catalogCategory === category ? 'active' : ''}
                aria-pressed={catalogCategory === category}
                disabled={working}
                onClick={() => setCatalogCategory(category)}
              >{label}</button>)}
            </div>
          </div>
        </div>
        <section className="ruleset-catalog-batchbar" aria-label="批量添加社区规则">
          <div className="ruleset-catalog-batchbar-head"><strong>批量添加</strong><span>已选 {selectedCatalogPresets.length} 项 · 当前筛选 {selectableCurrentCatalogPresets.length} 项可添加</span></div>
          <div className="ruleset-catalog-batchbar-actions">
            <button className="button secondary small" type="button" disabled={working || selectableCurrentCatalogPresets.length === 0} onClick={toggleCurrentCatalogSelection}>{allCurrentCatalogSelected ? '取消全选当前结果' : '全选当前结果'}</button>
            <button className="button secondary small" type="button" disabled={working || selectedCatalogIds.length === 0} onClick={() => setSelectedCatalogIds([])}>清空选择</button>
            <button className="button primary small" type="button" disabled={working || selectedCatalogPresets.length === 0} onClick={() => void addSelectedCatalogPresets()}>{batchRunning ? '正在批量添加…' : `批量添加 ${selectedCatalogPresets.length} 项`}</button>
          </div>
          {batchProgress && <div className="ruleset-catalog-batch-progress" aria-live="polite">
            <div className="ruleset-catalog-batch-progress-summary"><strong>完成 {batchProgress.completed}/{batchProgress.total}</strong><span>成功 {batchProgress.results.filter((result) => result.status === 'added').length} · 已跳过 {batchProgress.results.filter((result) => result.status === 'skipped').length} · 失败 {batchProgress.results.filter((result) => result.status === 'failed').length}</span>{batchProgress.current.length > 0 && <span>正在读取并保存：{batchProgress.current.join('、')}</span>}</div>
            {batchProgress.results.some((result) => result.status === 'failed') && <ul className="ruleset-catalog-batch-failures">{batchProgress.results.filter((result) => result.status === 'failed').map((result) => <li key={result.presetId}><strong>{result.name}</strong><span>{result.detail || '添加失败。'}</span></li>)}</ul>}
            {batchProgress.completed === batchProgress.total && batchProgress.total > 0 && <span className="ruleset-catalog-batch-complete">{batchProgress.results.some((result) => result.status === 'failed') ? '批量处理已结束；失败项仍保持勾选，可再次点击批量添加重试。' : '批量处理已结束；成功和已跳过项已从选择中移除。'}</span>}
            <button className="ruleset-catalog-batch-dismiss" type="button" disabled={working} onClick={() => setBatchProgress(null)}>清除结果</button>
          </div>}
        </section>
        <p className="ruleset-catalog-ranking">收录参考项目关注度与常见服务范围。项目 GitHub Star 仅作关注度参考，不能代表每条规则的实际使用量；目录不提供统一的真实用户使用统计。</p>
        {visibleCatalogGroups.length ? <div className="ruleset-catalog-groups">{visibleCatalogGroups.map((group) => <section className="ruleset-catalog-category" key={group.category}>
          <header><h3>{group.category}</h3><span>{group.items.length} 项</span></header>
          <div className="ruleset-public-catalog-grid">{group.items.map((preset) => {
            const source = publicRuleSetSources[preset.source]
            const existingLabel = existingRuleSetUrls.has(preset.url.trim()) ? '已添加' : existingRuleSetNames.has(preset.name.trim().toLocaleLowerCase()) ? '同名已存在' : ''
            const selected = selectedCatalogIds.includes(preset.id) && !existingLabel
            return <article key={preset.id} className={`${selected ? 'is-selected' : ''}${existingLabel ? ' is-existing' : ''}`}>
              <div className="ruleset-public-catalog-title"><div className="ruleset-catalog-title-main"><button className="ruleset-catalog-select" type="button" aria-label={`${selected ? '取消选择' : '选择'} ${preset.name}`} aria-pressed={selected} disabled={working || Boolean(existingLabel)} onClick={() => toggleCatalogPreset(preset)}>{existingLabel ? '·' : selected ? '✓' : '+'}</button><strong>{preset.name}</strong></div><span>{preset.filename}</span></div>
              <p>{preset.description}</p>
              <div className="ruleset-catalog-card-footer"><a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a><div className="ruleset-catalog-card-actions"><button className="button secondary small" type="button" disabled={working} aria-label={`查看 ${preset.name} 详情`} onClick={() => openCommunityRuleDetails(preset)}>详情</button><button className="button secondary small" type="button" disabled={working || Boolean(existingLabel)} onClick={() => void choosePublicRuleSet(preset)}>{existingLabel || (working ? '正在读取…' : '选用并预览')}</button></div></div>
            </article>
          })}</div>
        </section>)}</div> : <div className="ruleset-entry-empty">当前筛选下没有匹配的社区规则。</div>}
        <small className="ruleset-catalog-attribution">
          来源项目：{Object.values(publicRuleSetSources).map((source, index) => <span key={source.url}>{index > 0 && '、'}<a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></span>)}。远端内容由对应项目维护，添加前可查看预览。
        </small>
      </section>}
      {!catalogOpen && <>
      <section className="ruleset-detail-section">
        <header><strong>基本信息</strong><small>给规则集起一个容易识别的名称，并说明它包含什么内容。</small></header>
        <div className="ruleset-detail-fields">
          <label>规则集名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：AI 服务网站" /></label>
          <label>用途说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：常用 AI 网站及其子域名" /></label>
          <label>用途类别<DropdownSelect value={category} onValueChange={setCategory}>{ruleSetPurposeCategories.map((item) => <option key={item} value={item}>{item}</option>)}</DropdownSelect></label>
        </div>
      </section>

      {mode === 'http' ? <>
        <section className="ruleset-detail-section">
          <header><strong>在线来源</strong><small>{hasOverlay ? '应用时使用远端规则与本地调整合并后的快照；更新后本地追加和屏蔽项仍保留。' : '未添加本地调整时，Mihomo 会按配置间隔更新在线内容。'}</small></header>
          <div className="ruleset-detail-fields ruleset-source-fields">
            <label className="ruleset-url-field">规则集网址<input value={url} onChange={(event) => { setUrl(event.target.value); setError('') }} placeholder="https://example.com/rules.list" /></label>
            <label>内容类型<DropdownSelect value={behavior} onValueChange={(nextBehavior) => { setBehavior(nextBehavior); if (nextBehavior === 'domain') setRuleKind('DOMAIN-SUFFIX'); if (nextBehavior === 'ipcidr') setRuleKind('IP-CIDR') }}><option value="auto">自动识别</option><option value="domain">网站域名</option><option value="ipcidr">IP 地址段</option><option value="classical">网站、IP 与应用混合规则</option></DropdownSelect></label>
            <label>文件格式<DropdownSelect value={format} onValueChange={setFormat}><option value="auto">自动识别</option><option value="text">文本列表</option><option value="yaml">YAML 文件</option><option value="mrs" disabled={hasOverlay}>MRS 二进制（不支持本地调整）</option></DropdownSelect></label>
            {!hasOverlay && <label>在线更新间隔<DropdownSelect value={intervalHours} onValueChange={setIntervalHours}><option value="6">每 6 小时</option><option value="12">每 12 小时</option><option value="24">每天</option><option value="48">每 2 天</option><option value="168">每周</option><option value="0">不自动更新</option></DropdownSelect></label>}
          </div>
          <div className="ruleset-download-preview">
            <button className="button secondary" type="button" disabled={working || !url.trim()} onClick={() => void readRemote()}>{working ? '正在读取…' : props.initial ? '拉取在线最新规则' : '下载并读取规则'}</button>
            {hasOverlay && <small className="ruleset-update-note">本地调整启用后，在线更新间隔暂不生效；需要更新时，请拉取最新规则并保存。撤销所有本地调整后，Mihomo 恢复按间隔更新。</small>}
            {previewResult && previewReady && <div className="ruleset-preview-result"><strong>{previewResult.summary}</strong>{format !== 'mrs' && <span>当前有效 {remoteEffectiveCount} 条 · 本地追加 {localAdditions.length} 条 · 屏蔽 {excludedEntries.length} 条</span>}</div>}
          </div>
        </section>
        {isMRS ? <div className="ruleset-opaque-note">MRS 是二进制规则集，无法逐条查看、追加或屏蔽；来源与在线更新仍可正常使用。</div> : <>
          <section className="ruleset-detail-section ruleset-overlay-section">
            <header>
              <div><strong>规则明细</strong><small>远端当前提供 {remoteEntries.length} 条；点“屏蔽”只影响本机合并结果，不会修改原网址内容。</small></div>
              <label className="ruleset-search">筛选<input value={ruleSearch} onChange={(event) => {
                setRuleSearch(event.target.value)
                setRulePage(0)
              }} placeholder="搜索域名或规则" /></label>
            </header>
            {rulePageCount > 1 && <div className="ruleset-list-pages">
              <button className="button secondary small" type="button" disabled={currentRulePage === 0} onClick={() => setRulePage(currentRulePage - 1)}>上一页</button>
              <span aria-live="polite">第 {currentRulePage + 1} / {rulePageCount} 页</span>
              <button className="button secondary small" type="button" disabled={currentRulePage + 1 === rulePageCount} onClick={() => setRulePage(currentRulePage + 1)}>下一页</button>
            </div>}
            {pageRules.length > 0 ? <div className="ruleset-entry-list">
              {pageRules.map((entry, index) => <article key={`${pageStart + index}-${entry}`}>
                <code>{displayRuleEntry(entry, behavior)}</code>
                <button className="button secondary small" type="button" onClick={() => toggleExcluded(entry)}>屏蔽</button>
              </article>)}
            </div> : <div className="ruleset-entry-empty">{remoteEntries.length ? '暂无符合条件的在线规则。' : '先拉取在线规则，规则内容会显示在这里。'}</div>}
          </section>
          <section className="ruleset-detail-section ruleset-overlay-section">
            <header><div><strong>本地追加</strong><small>只保存在此规则集中；下次拉取远端更新时会继续保留。</small></div></header>
            <div className="ruleset-manual-add">
              <label>匹配类型<DropdownSelect value={ruleKind} onValueChange={setRuleKind}>{editorKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</DropdownSelect></label>
              <label>匹配内容<input value={ruleValue} onChange={(event) => setRuleValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addRule() }} placeholder={ruleKind.startsWith('PROCESS-') ? '例如：chrome.exe' : ruleKind.includes('CIDR') || behavior === 'ipcidr' ? '例如：192.168.1.0/24' : '例如：example.com'} /></label>
              <button className="button secondary" type="button" disabled={!ruleValue.trim()} onClick={addRule}>添加规则</button>
            </div>
            {localAdditions.length ? <div className="ruleset-entry-list additions">{localAdditions.map((entry) => <article key={entry}><code>{displayRuleEntry(entry, behavior)}</code><button className="button secondary small" type="button" onClick={() => setLocalAdditions((current) => current.filter((item) => item !== entry))}>移除</button></article>)}</div> : <div className="ruleset-entry-empty compact">暂无本地追加规则。</div>}
          </section>
          <section className="ruleset-detail-section ruleset-overlay-section">
            <header><div><strong>屏蔽规则</strong><small>远端列表更新后，匹配到的这些条目仍会被屏蔽。</small></div></header>
            {excludedEntries.length > 0 ? <div className="ruleset-entry-list excluded-list">
              {excludedEntries.map((entry) => <article key={entry}>
                <code>{displayRuleEntry(entry, behavior)}</code>
                <button className="button secondary small" type="button" onClick={() => toggleExcluded(entry)}>恢复</button>
              </article>)}
            </div> : <div className="ruleset-entry-empty compact">暂无屏蔽规则。</div>}
          </section>
        </>}
      </> : <section className="ruleset-detail-section">
        <header><strong>规则内容</strong><small>添加网站、IP 网段或应用规则；保存后可分配给一个策略组。</small></header>
        <div className="ruleset-manual-add">
          <label>匹配类型<DropdownSelect value={ruleKind} onValueChange={setRuleKind}>{manualRuleKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</DropdownSelect></label>
          <label>匹配内容<input value={ruleValue} onChange={(event) => setRuleValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addRule() }} placeholder={ruleKind.startsWith('PROCESS-') ? '例如：chrome.exe' : ruleKind.includes('CIDR') ? '例如：192.168.1.0/24' : '例如：example.com'} /></label>
          <button className="button secondary" type="button" disabled={!ruleValue.trim()} onClick={addRule}>添加规则</button>
        </div>
        {entries.length ? <div className="ruleset-entry-list additions">{rulePayload.map((rule, index) => <article key={`${entries[index]}-${index}`}><code>{ruleKindLabel(rule.kind)} · {rule.value}</code><button className="button secondary small" type="button" onClick={() => setEntries((current) => current.filter((_, position) => position !== index))}>移除</button></article>)}</div> : <div className="ruleset-entry-empty">添加的规则会逐条显示在这里。</div>}
        <p className="ruleset-manual-explain">应用规则按进程名称或程序路径匹配；线程级别没有对应的 Mihomo 路由规则。</p>
      </section>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      </>}
    </div>
    {!catalogOpen && <footer className="ruleset-form-actions"><button className="button secondary" type="button" disabled={working} onClick={props.cancel}>取消</button><button className="button primary" type="button" disabled={working || (needsPreview && !previewReady) || (mode === 'inline' && entries.length === 0)} onClick={() => void saveItem()}>{working ? '正在保存…' : '保存规则集'}</button></footer>}
  </section>
  {communityDetails && <RuleSetDetailsDialog
    key={communityDetails.item.id}
    item={communityDetails.item}
    loading={communityDetails.loading}
    error={communityDetails.error}
    onClose={closeCommunityRuleDetails}
  />}
  </>
}

function RuleSetEditorDialog(props: RuleSetFormProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  return <dialog ref={dialogRef} className="ruleset-editor-dialog" aria-labelledby="ruleset-editor-title" onCancel={(event) => {
    event.preventDefault()
    if (!props.busy) props.cancel()
  }}>
    <RuleSetForm {...props} />
  </dialog>
}

function canRefreshRuleSet(item: RuleSetItem) {
  return item.provider.type === 'http' && typeof item.provider.url === 'string' && Boolean(item.provider.url.trim())
}

function RuleSetLibraryPage(props: {
  topbarActionHost: HTMLDivElement | null
  topbarInfoHost: HTMLDivElement | null
  items: RuleSetItem[]
  policies: SavedPolicy[]
  busy: boolean
  task: RuleSetTask | null
  onRefresh: (item: RuleSetItem, sync: boolean) => void
  onRefreshAll: (sync: boolean) => void
  remove: (item: RuleSetItem, skipConfirmation?: boolean) => Promise<void>
  onCreate: () => void
  onEdit: (item: RuleSetItem) => void
}) {
  const [search, setSearch] = useState('')
  const rows = props.items.filter((item) => !search.trim() || (item.name + ' ' + item.description + ' ' + String(item.provider.url ?? '')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const refreshableCount = props.items.filter(canRefreshRuleSet).length
  const bulkTask = props.task?.kind === 'bulk' ? props.task : null
  function referenceNames(item: RuleSetItem) {
    return props.policies.flatMap((policy) => policy.config.rules.some((rule) => rule.kind.toUpperCase() === 'RULE-SET' && rule.value === item.id) ? [policy.name] : [])
  }

  return <div className="ruleset-library-page">
    <TopbarActionPortal host={props.topbarInfoHost}><span className="topbar-count">{props.items.length} 个规则集</span></TopbarActionPortal>
    <TopbarActionPortal host={props.topbarActionHost}>
      <button className="button secondary" type="button" disabled={props.busy || refreshableCount === 0} title="检查全部在线规则集的远端内容" onClick={() => props.onRefreshAll(false)}>{bulkTask && !bulkTask.sync ? `检查中 ${bulkTask.completed}/${bulkTask.total}` : '全部检查更新'}</button>
      <button className="button secondary" type="button" disabled={props.busy || refreshableCount === 0} title="同步全部在线规则集并保留本地追加与屏蔽" onClick={() => props.onRefreshAll(true)}>{bulkTask?.sync ? `同步中 ${bulkTask.completed}/${bulkTask.total}` : '同步更新全部'}</button>
      <button className="button primary" type="button" disabled={props.busy} onClick={props.onCreate}>＋ 新增规则集</button>
    </TopbarActionPortal>
    <section className="panel ruleset-library-intro"><div><span className="section-kicker">RULE SET LIBRARY</span><h2>规则集库</h2><p>维护可复用规则集。在线来源、本地追加与本地屏蔽分区管理；规则集更新时，保留本地调整。</p></div></section>
    <section className="panel ruleset-library-list">
      <header className="ruleset-list-heading"><div><h2>已保存的规则集</h2><small>策略组可以从这里多选规则集，再一次性加入当前组。</small></div><label className="ruleset-search">搜索规则集<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称或来源网址" /></label></header>
      {rows.length ? <div className="ruleset-card-list">{rows.map((item) => {
        const provider = item.provider
        const refs = referenceNames(item)
        const isManual = provider.type === 'inline'
        const isOnline = provider.type === 'http'
        const canRefresh = isOnline && typeof provider.url === 'string' && Boolean(provider.url.trim())
        const task = props.task?.kind === 'single' && props.task.id === item.id ? props.task : null
        const hasBaseline = provider.format === 'mrs' ? Boolean(item.mrsHash) : item.remoteEntries.length > 0
        const updateStatus = item.updateAvailable === true ? '有新内容'
          : item.updateAvailable === false ? '未发现更新'
            : item.checkedAt && !hasBaseline ? '待首次同步' : '未检查更新'
        return <article className="ruleset-card" key={item.id}>
          <div className="ruleset-card-main">
            <div className="ruleset-card-title"><strong>{item.name}</strong><span>{isManual ? '手动规则' : isOnline ? '在线规则' : '文件规则'}</span></div>
            <p>{ruleSetSummary(item)}{!isManual && ` · ${providerFormatLabel(String(provider.format ?? 'text'))}`}</p>
            {isOnline && <div className="ruleset-card-remote" aria-live="polite">
              {item.syncedAt
                ? <time className="source-updated" dateTime={item.syncedAt} title={new Date(item.syncedAt).toLocaleString('zh-CN')}>上次更新 · {relativeTime(item.syncedAt)}</time>
                : <span className="source-updated is-pending">尚未更新</span>}
              <span className={item.updateAvailable === true ? 'ruleset-update-status available' : 'ruleset-update-status'} title={item.checkedAt ? '上次检查 ' + new Date(item.checkedAt).toLocaleString('zh-CN') : undefined}>{updateStatus}</span>
            </div>}
            {item.localAdditions.length > 0 || item.excludedEntries.length > 0 ? <small className="ruleset-card-description">本地追加 {item.localAdditions.length} 条 · 屏蔽远端 {item.excludedEntries.length} 条</small> : null}
            <small title={String(provider.url ?? '')}>{String(provider.url ?? (isManual ? '规则由你逐条维护' : provider.path ?? '缺少来源网址'))}</small>
          </div>
          <div className="ruleset-card-usage">{refs.length ? <><strong>{refs.length} 份方案在用</strong><small>{refs.join('、')}</small></> : <span>尚未被策略组引用</span>}</div>
          <div className="ruleset-card-actions">
            {canRefresh && <>
              <button className="button secondary small" type="button" disabled={props.busy} onClick={() => props.onRefresh(item, false)}>{task && !task.sync ? '检查中…' : '检查更新'}</button>
              <button className={'button small ' + (item.updateAvailable === true ? 'primary' : 'secondary')} type="button" disabled={props.busy} onClick={() => props.onRefresh(item, true)}>{task?.sync ? '同步中…' : '同步更新'}</button>
            </>}
            <button className="button secondary small" type="button" disabled={props.busy} onClick={() => props.onEdit(item)}>编辑</button>
            <button className="button danger small" type="button" disabled={props.busy || refs.length > 0} title={refs.length ? '先从策略组移除该规则集' : '删除规则集；按住 Shift 点击可直接删除'} onClick={(event) => void props.remove(item, event.shiftKey)}>删除</button>
          </div>
        </article>
      })}</div> : <div className="ruleset-empty"><strong>{props.items.length ? '没有符合搜索条件的规则集' : '规则集库还是空的'}</strong><span>{props.items.length ? '换个名称或网址搜索。' : '从社区规则目录、网址下载规则，或手动添加网站、IP 和应用规则。'}</span>{!props.items.length && <button className="button secondary" type="button" disabled={props.busy} onClick={props.onCreate}>新增第一个规则集</button>}</div>}
    </section>
  </div>
}

function providerBehaviorLabel(value: string) {
  return value === 'domain' ? '网站域名' : value === 'ipcidr' ? 'IP 地址段' : '网站、IP 与应用混合规则'
}

function normalizeRuleEntry(entry: string) {
  return entry.split(/\s+/).filter(Boolean).join(' ').toLocaleLowerCase()
}

function displayRuleEntry(entry: string, behavior: string) {
  if (entry.includes(',') || behavior === 'classical' || behavior === 'domain') return entry
  return `${entry.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${entry}`
}

function ruleSetEffectiveEntries(item: RuleSetItem) {
  const source = item.provider.type === 'http'
    ? item.remoteEntries ?? []
    : Array.isArray(item.provider.payload) ? item.provider.payload.filter((entry): entry is string => typeof entry === 'string') : []
  const excluded = new Set((item.excludedEntries ?? []).map(normalizeRuleEntry))
  return [...source.filter((entry) => !excluded.has(normalizeRuleEntry(entry))), ...(item.localAdditions ?? [])]
    .filter((entry, index, all) => all.findIndex((candidate) => normalizeRuleEntry(candidate) === normalizeRuleEntry(entry)) === index)
}

function ruleSetAppliedProvider(item: RuleSetItem) {
  if (item.provider.type !== 'http' || (!(item.localAdditions?.length) && !(item.excludedEntries?.length)) || !(item.remoteEntries?.length)) return item.provider
  return { type: 'inline', behavior: item.provider.behavior ?? 'classical', payload: ruleSetEffectiveEntries(item) }
}

function ruleSetSummary(item: RuleSetItem) {
  const count = item.entryCount ?? ruleSetEffectiveEntries(item).length
  const content = item.description.trim() || providerBehaviorLabel(String(item.provider.behavior ?? 'classical'))
  return `${content} · ${count} 条规则`
}

function providerFormatLabel(value: string) {
  return value === 'yaml' ? 'YAML 文件' : value === 'mrs' ? 'MRS 二进制' : '文本列表'
}

function UsagePage(props: {
  snapshot: AppSnapshot | null
  trafficStatus: string
  fromDate: string
  toDate: string
  setFromDate: (value: string) => void
  setToDate: (value: string) => void
  rangePreset: RangePreset
  applyRangePreset: (preset: RangePreset) => void
  usage: UsageSummary | null
  unmatchedConnections: UnmatchedConnection[]
  exportUnmatched: () => void
  usageTab: string
  setUsageTab: (value: string) => void
  query: () => void
  copySite: (site: string) => void
  clearHistory: () => void
  openSettings: () => void
  busy: boolean
}) {
  const usage = props.usage
  const total = (usage?.upload ?? 0) + (usage?.download ?? 0)
  const dates = [props.fromDate, props.toDate].map((value) => new Date(value).getTime())
  const days = Number.isFinite(dates[0]) && Number.isFinite(dates[1]) ? Math.max(1, Math.round((dates[1] - dates[0]) / 86400000) + 1) : 1
  const status = props.trafficStatus || props.snapshot?.trafficStatus || '等待连接 Mihomo'
  const connected = status.startsWith('已连接')
  const hasHistory = total > 0 || (usage?.byDay ?? []).some((day) => day.upload + day.download > 0)
  const paused = status.includes('暂停')
  const metricsTotal = !connected && !hasHistory ? '—' : formatBytes(total)
  const metricsDetail = !connected && !hasHistory ? '连接 Mihomo 后开始统计' : 'Mihomo 累计流量'
  const statusText = connected ? status : paused ? '流量采集已暂停' : status.startsWith('等待') ? '正在连接 Mihomo' : 'Mihomo 未连接'
  return <>
    <div className="usage-header-row">
      <div><span className="section-kicker">TRAFFIC OVERVIEW</span><h2>流量概览</h2></div>
      <div className="usage-header-actions"><span className={'usage-connection ' + (connected ? 'connected' : paused ? 'paused' : 'disconnected')}><i />{statusText}</span><button className="button secondary small" type="button" disabled={props.busy || !props.fromDate || !props.toDate} onClick={props.query}>{props.busy ? '刷新中…' : '⟳ 刷新数据'}</button><button className="button danger small" type="button" disabled={props.busy} onClick={props.clearHistory}>清空统计</button></div>
    </div>
    <div className="usage-range-toolbar">
      <strong>统计范围</strong>
      <div className="usage-range-controls">
        {([['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['custom', '自定义']] as [RangePreset, string][]).map(([key, label]) => <button key={key} type="button" className={'button secondary small' + (props.rangePreset === key ? ' active' : '')} onClick={() => props.applyRangePreset(key)}>{label}</button>)}
        {props.rangePreset === 'custom' && <>
          <label><span>从</span><input aria-label="起始日期" type="date" value={props.fromDate} onChange={(event) => props.setFromDate(event.target.value)} /></label>
          <label><span>至</span><input aria-label="结束日期" type="date" value={props.toDate} onChange={(event) => props.setToDate(event.target.value)} /></label>
          <button className="button primary small" disabled={props.busy || !props.fromDate || !props.toDate} onClick={props.query}>{props.busy ? '查询中…' : '应用'}</button>
        </>}
      </div>
    </div>
    {!connected && <section className={'traffic-alert ' + (paused ? 'paused' : '')}>
      <span className="traffic-alert-icon">{paused ? 'Ⅱ' : '!'}</span>
      <div><strong>{paused ? '流量采集已暂停' : '当前没有连上 Mihomo 控制器'}</strong><p>{paused ? '历史记录保留；恢复采集后继续记录。' : '未连接期间不会新增记录；请检查设置中的 Mihomo 控制器。'}</p>
        {status !== '等待连接 Mihomo' && <details><summary>查看连接错误</summary><code>{status}</code></details>}
      </div>
      <button className="button secondary" onClick={props.openSettings}>打开设置</button>
    </section>}
    <div className="usage-metrics">
      <SummaryMetric label="总流量" value={metricsTotal} detail={metricsDetail} icon="total" />
      <SummaryMetric label="下载" value={!connected && !hasHistory ? '—' : formatBytes(usage?.download ?? 0)} detail="Mihomo 下行累计" icon="download" />
      <SummaryMetric label="上传" value={!connected && !hasHistory ? '—' : formatBytes(usage?.upload ?? 0)} detail="Mihomo 上行累计" icon="upload" />
      <SummaryMetric label="日均流量" value={!connected && !hasHistory ? '—' : formatBytes(Math.round(total / days))} detail="该范围总量 ÷ 自然日" icon="average" />
    </div>
    <UsageTrend days={usage?.byDay ?? []} connected={connected} hasHistory={hasHistory} />
    <section className="panel usage-panel">
      <div className="usage-panel-head"><div><h2>流量去向</h2></div>
        <div className="tabs">{[
          ['detail', '组合明细'], ['site', '站点'], ['node', '节点'], ['provider', '服务商'], ['group', '策略组'], ['rule', '命中规则'], ['unmatched', '未命中'],
        ].map(([key, label]) => <button key={key} className={props.usageTab === key ? 'active' : ''} onClick={() => props.setUsageTab(key)}>{label}</button>)}</div>
      </div>
      {props.usageTab === 'unmatched' ? <>
        <div className="usage-unmatched-toolbar"><span>记录落到 MATCH 兜底的连接，按当前日期范围筛选。</span><div><b>{props.unmatchedConnections.length} 条</b><button className="button secondary small" type="button" disabled={props.busy} onClick={props.query}>{props.busy ? '刷新中…' : '刷新记录'}</button><button className="button secondary small" type="button" disabled={props.busy || props.unmatchedConnections.length === 0} onClick={props.exportUnmatched}>导出 CSV</button></div></div>
        <UnmatchedConnectionTable records={props.unmatchedConnections} />
      </> : <UsageTable rows={usage ? rowsFor(usage, props.usageTab) : []} mode={props.usageTab} copySite={props.copySite} />}
    </section>
    <div className="usage-footnote">流量分类按秒采样，短连接可能漏记；未命中记录也来自每秒活跃连接快照，连接过短时可能无法捕获。未命中明细记录在本机，可导出 CSV。</div>
  </>
}

function UsageTrend(props: { days: UsageSummary['byDay']; connected: boolean; hasHistory: boolean }) {
  const max = Math.max(0, ...props.days.map((day) => Math.max(day.upload, day.download)))
  const hasBars = max > 0
  const labelIndexes = Array.from(new Set([0, Math.floor((props.days.length - 1) / 3), Math.floor((props.days.length - 1) * 2 / 3), props.days.length - 1])).filter((index) => index >= 0)
  const labelDates = labelIndexes.map((index) => props.days[index]?.date).filter((date): date is string => Boolean(date))
  return <section className="panel usage-trend-panel">
    <div className="usage-trend-head"><div className="usage-trend-title"><span className="usage-trend-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5v14h16" /><path d="m7 14 3.5-3.5 3 2.5L19 7" /><path d="M16 7h3v3" /></svg></span><div><h2>每日流量趋势</h2><p>{props.days.length ? props.days.length + ' 个自然日' : '当前范围'}</p></div></div><div className="trend-legend"><span><i className="download" />下载</span><span><i className="upload" />上传</span></div></div>
    {hasBars
      ? <div className="usage-trend-chart" role="img" aria-label="每日下载和上传并列柱状图" onMouseDown={(event) => event.preventDefault()}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={props.days} accessibilityLayer={false} margin={{ top: 20, right: 16, left: 0, bottom: 0 }} barGap={3} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="#dfe6ef" />
            <XAxis dataKey="date" ticks={labelDates} tickFormatter={(date: string) => date.slice(5)} interval={0} height={34} axisLine={false} tickLine={false} tick={{ fill: '#586c86', fontFamily: "'DM Sans', 'Microsoft YaHei UI', sans-serif", fontSize: 14 }} />
            <YAxis width={86} domain={[0, max]} ticks={[0, max / 3, max * 2 / 3, max]} tickFormatter={formatAxisBytes} axisLine={false} tickLine={false} tick={{ fill: '#586c86', fontFamily: "'DM Sans', 'Microsoft YaHei UI', sans-serif", fontSize: 14 }} />
            <Tooltip shared={false} cursor={false} trigger="hover" isAnimationActive={false} content={({ active, payload, label }) => {
              const item = payload?.[0]
              if (!active || !item) return null
              const direction = item.dataKey === 'upload' ? '上传' : '下载'
              const value = typeof item.value === 'number' ? item.value : Number(item.value ?? 0)
              return <div className={'usage-trend-tooltip ' + (direction === '上传' ? 'upload' : 'download')}><i aria-hidden="true" /><span><b>{String(label ?? '')}</b><small>{direction} · {formatBytes(value)}</small></span></div>
            }} />
            <Bar className="trend-download" dataKey="download" name="下载" fill="#6394ef" maxBarSize={14} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            <Bar className="trend-upload" dataKey="upload" name="上传" fill="#53bd93" maxBarSize={14} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      : <div className="trend-empty"><span>⌁</span><strong>{props.hasHistory ? '这个范围没有可绘制的日汇总' : props.connected ? '这个范围还没有流量记录' : '连接 Mihomo 后显示每日趋势'}</strong></div>}
  </section>
}

function UsageTable(props: { rows: UsageRow[]; mode: string; copySite: (site: string) => void }) {
  const [siteMenu, setSiteMenu] = useState<{ x: number; y: number; site: string; address: string } | null>(null)
  const siteMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!siteMenu) return
    const dismissOutside = (event: PointerEvent) => {
      if (!siteMenuRef.current?.contains(event.target as Node)) setSiteMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSiteMenu(null)
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [siteMenu])
  if (props.rows.length === 0) return <div className="usage-empty"><div>▥</div><strong>这个时期还没有可分类记录</strong><span>连接 Mihomo 并产生流量后显示。</span></div>
  function title(row: UsageRow) {
    if (props.mode === 'node') return row.node
    if (props.mode === 'provider') return row.provider
    if (props.mode === 'group') return row.key
    if (props.mode === 'rule') return row.rule
    return row.site
  }
  const max = Math.max(1, props.rows[0].upload + props.rows[0].download)
  function openSiteMenu(event: React.MouseEvent<HTMLElement>, value: string) {
    const site = value.trim()
    if (!site || /^(未知|未知站点|—|-)$/.test(site)) return
    event.preventDefault()
    event.stopPropagation()
    const address = /^[a-z][a-z\d+.-]*:\/\//i.test(site) ? site : `https://${site}`
    setSiteMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 280)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 90)), site, address })
  }
  return <div className="usage-table">
    <div className="usage-table-head"><span>#</span><span>{props.mode === 'detail' ? '站点 · 服务商 · 节点 · 策略组 · 命中规则' : props.mode === 'site' ? '站点 / 域名' : props.mode === 'node' ? '节点' : props.mode === 'provider' ? '服务商' : props.mode === 'group' ? '策略组' : '命中规则'}</span><span>上传</span><span>下载</span><span>合计</span></div>
    {props.rows.map((row, index) => {
      const total = row.upload + row.download
      const width = Math.max(2, total / max * 100)
      return <div className="usage-table-row" key={row.key + '-' + String(index)}>
        <span className="rank">{String(index + 1).padStart(2, '0')}</span>
        <span className={'usage-item' + ((props.mode === 'detail' || props.mode === 'site') && row.site ? ' usage-item-site-menu' : '')} onContextMenu={(event) => { if (props.mode === 'detail' || props.mode === 'site') openSiteMenu(event, row.site) }}><strong>{title(row) || '未知'}</strong>{props.mode === 'detail' && <small>{[row.provider, row.node, row.group, row.rule].filter(Boolean).join(' · ') || '未知来源 · 未识别节点 · 未识别策略组'}</small>}<i style={{ width: String(width) + '%' }} /></span>
        <span>{formatBytes(row.upload)}</span><span>{formatBytes(row.download)}</span><b>{formatBytes(total)}</b>
      </div>
    })}
    {siteMenu && createPortal(<div className="usage-site-context-menu-layer" role="presentation"><div ref={siteMenuRef} className="usage-site-context-menu" role="menu" aria-label={`复制 ${siteMenu.site} 的网站链接`} style={{ left: siteMenu.x, top: siteMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => { props.copySite(siteMenu.address); setSiteMenu(null) }}><span>复制网站链接</span><small>{siteMenu.address}</small></button>
    </div></div>, document.body)}
  </div>
}

function UnmatchedConnectionTable(props: { records: UnmatchedConnection[] }) {
  if (props.records.length === 0) return <div className="usage-empty"><div>⌁</div><strong>这个时期没有落到 MATCH 兜底的连接</strong><span>流量采集开启并连接 Mihomo 后，会记录新发现的未命中连接。</span></div>
  return <div className="usage-table unmatched-connection-table">
    <div className="usage-table-head unmatched-connection-head"><span>发现时间</span><span>站点 / 目标地址</span><span>应用 / 入站</span><span>MATCH 兜底去向</span></div>
    {props.records.map((record) => {
      const destinationHost = record.destinationIp.includes(':') ? `[${record.destinationIp}]` : record.destinationIp
      const destination = [destinationHost, record.destinationPort].filter(Boolean).join(':')
      return <div className="usage-table-row unmatched-connection-row" key={record.connectionId}>
        <span>{new Date(record.detectedAt).toLocaleString('zh-CN')}</span>
        <span className="unmatched-connection-cell"><strong>{record.site || '未知站点'}</strong><small>{[record.network, destination].filter(Boolean).join(' · ') || '目标地址未知'}</small></span>
        <span className="unmatched-connection-cell"><strong>{record.process || '未识别应用'}</strong><small title={record.processPath}>{[record.inbound, record.processPath].filter(Boolean).join(' · ') || '未提供进程信息'}</small></span>
        <span className="unmatched-connection-cell"><strong>{record.fallbackTarget || '未提供兜底目标'}</strong><small>{record.proxyChain.join(' → ') || '代理链未提供'}</small></span>
      </div>
    })}
  </div>
}

function SettingsPage(props: {
  topbarActionHost: HTMLDivElement | null
  snapshot: AppSnapshot | null
  settings: AppSettings
  setSettings: (settings: AppSettings) => void
  save: (settings: AppSettings) => void
  check: () => void
  openData: () => void
  controllerMessage: string
  busy: boolean
  exportBackup: () => void
  importBackup: (file: File) => void
}) {
  const settings = props.settings
  const backupFileRef = useRef<HTMLInputElement | null>(null)
  const [proxyForm, setProxyForm] = useState(() => parseSubscriptionProxy(settings.subscriptionProxy))
  useEffect(() => setProxyForm(parseSubscriptionProxy(settings.subscriptionProxy)), [settings.subscriptionProxy])
  const update = <K extends keyof AppSettings,>(key: K, value: AppSettings[K]) => props.setSettings({ ...settings, [key]: value })
  const proxyPort = Number(proxyForm.port)
  const proxyPortValid = proxyForm.protocol === 'direct' || (Number.isInteger(proxyPort) && proxyPort >= 1 && proxyPort <= 65535)
  const savedSettings = props.snapshot?.settings
  const savedProxy = savedSettings ? formatSubscriptionProxy(parseSubscriptionProxy(savedSettings.subscriptionProxy)) : null
  const settingsDirty = Boolean(savedSettings) && (
    settings.controllerUrl !== savedSettings?.controllerUrl
    || settings.controllerSecret !== savedSettings?.controllerSecret
    || settings.collectEnabled !== savedSettings?.collectEnabled
    || settings.autoUpdateEnabled !== savedSettings?.autoUpdateEnabled
    || settings.syncSubscriptionsOnProfileRefresh !== savedSettings?.syncSubscriptionsOnProfileRefresh
    || settings.useSubscriptionProxy !== savedSettings?.useSubscriptionProxy
    || settings.updateMinutes !== savedSettings?.updateMinutes
    || settings.profilePort !== savedSettings?.profilePort
    || settings.mixedPort !== savedSettings?.mixedPort
    || settings.profileName !== savedSettings?.profileName
    || settings.profileTrafficSourceId !== savedSettings?.profileTrafficSourceId
    || normalizeAutoGroupNameParts(settings.autoGroupNameParts).join('|') !== normalizeAutoGroupNameParts(savedSettings?.autoGroupNameParts).join('|')
    || formatSubscriptionProxy(proxyForm) !== savedProxy
  )
  const saveSettings = () => { if (proxyPortValid) props.save({ ...settings, subscriptionProxy: formatSubscriptionProxy(proxyForm) }) }
  return <div className="settings-grid">
    <TopbarActionPortal host={props.topbarActionHost}><button className="button secondary" onClick={props.check}>测试连接</button><button className="button primary" disabled={!proxyPortValid || !settingsDirty} onClick={saveSettings}>保存设置</button></TopbarActionPortal>
    <section className="panel settings-panel">
      <div className="panel-title"><div><span className="section-kicker">MIHOMO CONTROLLER</span><h2>流量采集连接</h2></div><div className="preset-icon">⌁</div></div>
      <p className="muted">填写 Clash Verge 的 Mihomo external-controller 地址和密钥。</p>
      <label className="field-label">控制器地址<input value={settings.controllerUrl} onChange={(event) => update('controllerUrl', event.target.value)} placeholder="http://127.0.0.1:9090" /></label>
      <label className="field-label">控制器密钥<input type="text" value={settings.controllerSecret} onChange={(event) => update('controllerSecret', event.target.value)} autoComplete="off" placeholder="如果没有设置密钥，可留空" /></label>
          <label className="field-label">混合端口<input className="port-number-input" type="number" min={1} max={65535} value={settings.mixedPort} onChange={(event) => update('mixedPort', Number(event.target.value))} /></label>
      <label className="auto-update-row collect-history-row">
        <input type="checkbox" checked={settings.collectEnabled} onChange={(event) => update('collectEnabled', event.target.checked)} />
        <span className="switch" />
        <span className="auto-update-copy"><b>启用流量历史采集</b><small>{settings.collectEnabled ? '程序运行时每秒读取 Mihomo 连接；落到 MATCH 兜底的连接也会记录。' : '采集已暂停；已有流量和未命中记录会保留。'}</small></span>
      </label>
      {props.controllerMessage && <div className={props.controllerMessage.startsWith('已连接') ? 'inline-success' : 'inline-error'}>{props.controllerMessage}</div>}
    </section>
    <section className="panel settings-panel">
      <div className="panel-title"><div><span className="section-kicker">SUBSCRIPTION FETCH</span><h2>订阅刷新</h2></div><div className="preset-icon">↻</div></div>
      <p className="muted">代理配置也用于模板下载和在线规则预览；订阅刷新是否走代理由下方开关控制。</p>
      <div className="proxy-fields">
        <label className="field-label">协议<DropdownSelect value={proxyForm.protocol} onValueChange={(protocol) => setProxyForm({ ...proxyForm, protocol: protocol as ProxyProtocol })}>
          <option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option><option value="socks5h">SOCKS5H</option><option value="direct">直连</option>
        </DropdownSelect></label>
        {proxyForm.protocol !== 'direct' && <>
          <label className="field-label">IP 地址<input value={proxyForm.host} onChange={(event) => setProxyForm({ ...proxyForm, host: event.target.value })} placeholder="127.0.0.1" /></label>
          <label className="field-label">端口<input className="port-number-input" type="number" min={1} max={65535} value={proxyForm.port} onChange={(event) => setProxyForm({ ...proxyForm, port: event.target.value })} placeholder="7897" /></label>
        </>}
      </div>
      <small className={proxyPortValid ? 'proxy-hint' : 'proxy-hint proxy-error'}>{proxyForm.protocol === 'direct' ? '直连下载订阅，不经过本地代理。' : proxyPortValid ? 'IP 地址留空时按 127.0.0.1 保存。' : '端口必须是 1 到 65535 之间的整数。'}</small>
      <label className="auto-update-row">
        <input type="checkbox" checked={settings.useSubscriptionProxy} onChange={(event) => update('useSubscriptionProxy', event.target.checked)} />
        <span className="switch" />
        <span className="auto-update-copy"><b>走代理刷新订阅</b><small>{!settings.useSubscriptionProxy ? '刷新订阅时直接连接订阅服务器。' : proxyForm.protocol === 'direct' ? '上方代理协议为直连；刷新请求会直接连接订阅服务器。' : '刷新订阅时使用上方代理配置。'}</small></span>
      </label>
      <label className="auto-update-row">
        <input type="checkbox" checked={settings.syncSubscriptionsOnProfileRefresh} onChange={(event) => update('syncSubscriptionsOnProfileRefresh', event.target.checked)} />
        <span className="switch" />
        <span className="auto-update-copy"><b>Clash Verge 刷新时同步订阅</b><small>{settings.syncSubscriptionsOnProfileRefresh ? '刷新配置前先更新所有已启用订阅，再返回最新 profile。' : '关闭后直接返回本机现有 profile，不请求订阅服务器。'}</small></span>
      </label>
      <label className="auto-update-row">
        <input type="checkbox" checked={settings.autoUpdateEnabled} onChange={(event) => update('autoUpdateEnabled', event.target.checked)} />
        <span className="switch" />
        <span className="auto-update-copy"><b>自动更新订阅</b><small>{settings.autoUpdateEnabled ? '按设定间隔刷新已启用来源。' : '已关闭；可在订阅来源页手动刷新。'}</small></span>
      </label>
      <label className={'field-label update-interval-field ' + (!settings.autoUpdateEnabled ? 'disabled' : '')}>自动更新间隔（分钟）<input type="number" min={15} max={1440} disabled={!settings.autoUpdateEnabled} value={settings.updateMinutes} onChange={(event) => update('updateMinutes', Number(event.target.value))} /></label>
    </section>
    <section className="panel settings-panel storage-panel">
      <div className="panel-title"><div><span className="section-kicker">PORTABLE STORAGE</span><h2>数据位置与备份恢复</h2></div></div>
      <p className="muted">数据保存在 exe 同级的 userdata 文件夹。</p>
      <div className="storage-location-row"><code className="path-code">{props.snapshot?.dataDir ?? '读取中…'}</code><button className="button secondary" type="button" onClick={props.openData}>打开数据目录</button></div>
      <div className="backup-actions"><button className="button primary" type="button" disabled={props.busy} onClick={props.exportBackup}>导出完整备份</button><button className="button secondary" type="button" disabled={props.busy} onClick={() => backupFileRef.current?.click()}>从备份恢复</button><input ref={backupFileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) props.importBackup(file); event.currentTarget.value = '' }} /></div>
      <div className="inline-info">备份包含订阅地址、节点凭据、策略方案、规则集、应用设置及流量历史；文件未加密，请妥善保管。恢复会覆盖本机这些数据，并要求二次确认。</div>
    </section>
  </div>
}
