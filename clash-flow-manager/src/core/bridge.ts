export type SubscriptionInfo = {
  packageName: string
  uploadBytes: number | null
  downloadBytes: number | null
  totalBytes: number | null
  remainingBytes: number | null
  remainingLabel: string
  expiresAt: string
  resetAfterDays: number | null
  officialUrl: string
}

export type Source = {
  id: string
  name: string
  prefix: string
  url: string
  enabled: boolean
  includePrefix: boolean
  includeFlag: boolean
  includeCountry: boolean
  includeOriginalName: boolean
  regionHint: string
  nodeCount: number
  lastUpdated: string
  lastError: string
  subscriptionInfo?: SubscriptionInfo | null
}

export type SourceSyncResult = {
  sources: Source[]
  nodeCount: number
  errors: string[]
  updatedAt: string
}

export type ProxyNode = {
  id: string
  sourceId: string
  sourceName: string
  sourcePrefix: string
  originalName: string
  displayName: string
  country: string
  config: Record<string, unknown>
}

export type PolicyGroup = {
  id: string
  name: string
  kind: string
  allNodes: boolean
  sourceIds: string[]
  countries: string[]
  nodeIds: string[]
  includeNodeIds?: string[]
  excludeNodeIds?: string[]
  groupNames: string[]
  filter: string
  url: string
  interval: number
  options: Record<string, unknown>
}

export type PolicyRule = { kind: string; value: string; target: string }
export type AutoGroupSettings = { kind: string; url: string; interval: number; defaultSelected?: string }
export type PolicyConfig = {
  templateName: string
  templateUrl: string
  templateContent: string
  ruleProviders: Record<string, unknown>
  groups: PolicyGroup[]
  rules: PolicyRule[]
  autoGroupSettings?: Record<string, AutoGroupSettings>
}

export type SavedPolicy = {
  id: string
  name: string
  config: PolicyConfig
  updatedAt: string
  pinned: boolean
}

export type PolicyLibrary = {
  activeId: string
  items: SavedPolicy[]
}

export type RuleSetItem = {
  id: string
  name: string
  category?: string
  provider: Record<string, unknown>
  description: string
  remoteEntries: string[]
  localAdditions: string[]
  excludedEntries: string[]
  entryCount: number | null
  sample: string[]
  checkedAt: string
  syncedAt: string
  updateAvailable: boolean | null
  mrsHash: string
  updatedAt: string
}

export type RuleSetLibrary = { items: RuleSetItem[] }
export type RuleSetPreview = {
  entryCount: number | null
  sample: string[]
  summary: string
  behavior: string
  format: string
  entries: string[]
  downloadedAt: string
  mrsHash: string
}

export type PolicySaveResult = {
  library: PolicyLibrary
  savedId: string
}

export type AppSettings = {
  controllerUrl: string
  controllerSecret: string
  subscriptionProxy: string
  useSubscriptionProxy: boolean
  collectEnabled: boolean
  autoUpdateEnabled: boolean
  updateMinutes: number
  profilePort: number
  mixedPort: number
  profileName: string
  profileTrafficSourceId: string
  autoGroupNameParts: string[]
}

export type UsageRow = {
  key: string
  provider: string
  node: string
  group: string
  site: string
  rule: string
  upload: number
  download: number
}

export type UsageSummary = {
  upload: number
  download: number
  byNode: UsageRow[]
  bySite: UsageRow[]
  byProvider: UsageRow[]
  byGroup: UsageRow[]
  byRule: UsageRow[]
  byDetail: UsageRow[]
  byDay: UsageDay[]
}

export type UsageDay = { date: string; upload: number; download: number }

export type UnmatchedConnection = {
  connectionId: string
  detectedAt: string
  startedAt: string
  site: string
  destinationIp: string
  destinationPort: string
  sourceIp: string
  sourcePort: string
  network: string
  process: string
  processPath: string
  inbound: string
  fallbackTarget: string
  proxyChain: string[]
}

export type RouteCheckResult = {
  host: string
  captured: boolean
  rule: string
  rulePayload: string
  routeGroup: string
  node: string
  proxyChain: string[]
  statusCode: number | null
  elapsedMs: number
  message: string
}

export type LocalRouteCheckResult = {
  host: string
  policyId: string
  policyName: string
  status: 'matched' | 'uncertain' | 'unmatched'
  rule: string
  rulePayload: string
  target: string
  targetKind: string
  groupKind: string
  members: string[]
  memberCount: number
  membersComplete: boolean
  message: string
}

export type AppSnapshot = {
  sources: Source[]
  nodes: ProxyNode[]
  policy: PolicyConfig
  policyLibrary: PolicyLibrary
  ruleSetLibrary: RuleSetLibrary
  settings: AppSettings
  profileUrl: string
  profileLastRequestedAt: number | null
  profileNeedsUpdate: boolean
  dataDir: string
  syncStatus: string
  lastSync: string
  trafficStatus: string
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
    }
  }
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = window.__TAURI_INTERNALS__
  if (!api) throw new Error('请在 Clash Flow Manager 桌面程序中运行')
  return api.invoke<T>(command, args)
}

export const api = {
  snapshot: () => invoke<AppSnapshot>('app_snapshot'),
  saveSource: (source: Source) => invoke<Source[]>('source_save', { source }),
  reorderSources: (sourceIds: string[]) => invoke<Source[]>('source_reorder', { sourceIds }),
  deleteSource: (sourceId: string) => invoke<Source[]>('source_delete', { sourceId }),
  syncSources: () => invoke<SourceSyncResult>('source_sync'),
  syncSourcesWithMode: (mode: 'direct' | 'proxy') => invoke<SourceSyncResult>('source_sync_mode', { mode }),
  syncSource: (sourceId: string) => invoke<SourceSyncResult>('source_sync_one', { sourceId }),
  checkSubscriptionProxy: () => invoke<boolean>('subscription_proxy_check'),
  savePolicy: (policy: PolicyConfig, policyId: string | null, activate: boolean) => invoke<PolicySaveResult>('policy_save', { policy, policyId, activate }),
  activatePolicy: (id: string) => invoke<void>('policy_activate', { id }),
  renamePolicy: (id: string, name: string) => invoke<void>('policy_rename', { id, name }),
  setPolicyPinned: (id: string, pinned: boolean) => invoke<void>('policy_set_pinned', { id, pinned }),
  deletePolicy: (id: string) => invoke<void>('policy_delete', { id }),
  fetchPreset: (name: string, url: string) => invoke<PolicyConfig>('preset_fetch', { name, url }),
  previewRuleSet: (url: string, behavior: string, format: string) => invoke<RuleSetPreview>('rule_set_preview', { url, behavior, format }),
  refreshRuleSet: (id: string, sync: boolean) => invoke<boolean | null>('rule_set_refresh', { id, sync }),
  saveRuleSet: (item: RuleSetItem, downloadedAt: string | null) => invoke<RuleSetItem>('rule_set_save', { item, downloadedAt }),
  deleteRuleSet: (id: string) => invoke<RuleSetLibrary>('rule_set_delete', { id }),
  saveSettings: (settings: AppSettings) => invoke<void>('settings_save', { settings }),
  regenerate: () => invoke<string>('profile_regenerate'),
  summary: (from: string, to: string) => invoke<UsageSummary>('usage_summary', { from, to }),
  unmatchedConnections: (from: string, to: string) => invoke<UnmatchedConnection[]>('usage_unmatched_connections', { from, to }),
  clearTrafficHistory: () => invoke<number>('usage_clear_history'),
  exportBackupTo: (path: string) => invoke<void>('backup_export_to', { path }),
  restoreBackup: (backup: unknown) => invoke<void>('backup_restore', { backup }),
  controllerCheck: (url: string, secret: string) => invoke<string>('controller_check', { url, secret }),
  routeCheck: (url: string) => invoke<RouteCheckResult>('route_check', { url }),
  localRouteCheck: (policyId: string, url: string) => invoke<LocalRouteCheckResult>('route_check_local', { policyId, url }),
  openData: () => invoke<void>('app_open_data_dir'),
  defaultRange: () => invoke<[string, string]>('usage_default_range'),
  minimizeWindow: () => invoke<void>('window_minimize'),
  toggleMaximizeWindow: () => invoke<boolean>('window_toggle_maximize'),
  isWindowMaximized: () => invoke<boolean>('window_is_maximized'),
  startDragging: () => invoke<void>('window_start_dragging'),
  closeWindow: () => invoke<void>('window_close'),
}
