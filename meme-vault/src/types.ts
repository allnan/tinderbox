export interface Category {
  id: string;
  name: string;
  color: string;
  order: number;
  createdAt: number;
}

export interface StickerGroup {
  id: string;
  name: string;
  color: string;
  note: string;
  order: number;
  createdAt: number;
}

export type StickerStatus = "inbox" | "sorted";

export interface Sticker {
  id: string;
  sha256: string;
  ext: string;
  mime: string;
  thumbMime: string;
  width: number;
  height: number;
  bytes: number;
  phash: string;
  name: string;
  note: string;
  categoryId: string | null;
  groupIds: string[];
  tags: string[];
  favorite: boolean;
  status: StickerStatus;
  deleted: boolean;
  deletedAt: number | null;
  importedAt: number;
  createdAt: number;
  usageCount: number;
  lastUsedAt: number | null;
  origin: string;
  aiNote: string;
}

export interface ProposalAction {
  categoryId: string | null;
  newCategoryName: string;
  addGroupIds: string[];
  newGroupNames: string[];
  addTags: string[];
  name: string;
  favorite: boolean | null;
}

export interface ProposalEntry {
  id: string;
  itemId: string;
  action: ProposalAction;
  reason: string;
  confidence: number;
  skipped: boolean;
  source: string;
  applied: boolean;
  skipReason: string | null;
}

export type ProposalStatus = "pending" | "applied" | "dismissed" | "reverted" | "superseded";

export interface Proposal {
  id: string;
  kind: "rules" | "ai";
  status: ProposalStatus;
  summary: string;
  createdAt: number;
  appliedAt: number | null;
  appliedBy: string;
  dismissedAt: number | null;
  revertedAt: number | null;
  supersededAt: number | null;
  historyId: string | null;
  entries: ProposalEntry[];
  meta: Record<string, unknown>;
}

export interface Snapshot {
  name: string;
  note: string;
  categoryId: string | null;
  groupIds: string[];
  tags: string[];
  favorite: boolean;
  status: StickerStatus;
  deleted: boolean;
  aiNote: string;
}

export interface HistoryChange {
  itemId: string;
  before: Snapshot | null;
  after: Snapshot | null;
}

export interface HistoryEntry {
  id: string;
  at: number;
  type: string;
  actor: "user" | "ai" | "rules" | "system" | string;
  summary: string;
  undoable: boolean;
  undoneAt: number | null;
  changes: HistoryChange[];
  meta: Record<string, unknown>;
}

export interface HistoryItemView extends HistoryEntry {
  canUndo: boolean;
}

export interface HistoryPage {
  total: number;
  items: HistoryItemView[];
}

export interface AiSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  vision: boolean;
  batchSize: number;
  timeoutMs: number;
  hasApiKey: boolean;
}

export interface SettingsView {
  ai: AiSettings;
  copyMode: "image" | "file";
  cardSize: number;
  autoBackup: boolean;
  quickAlwaysOnTop: boolean;
}

export interface AiPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  vision: boolean;
}

export interface SystemInfo {
  version: string;
  platform: string;
  dataDir: string;
  aiPresets: AiPreset[];
}

export interface LibraryMeta {
  lastBackupAt: number;
  lastImportAt: number;
}

export interface StateView {
  categories: Category[];
  groups: StickerGroup[];
  items: Sticker[];
  proposals: Proposal[];
  settings: SettingsView;
  meta: LibraryMeta;
  historyCount: number;
}

export interface ImportReport {
  added: number;
  duplicates: number;
  failed: string[];
  items: Sticker[];
}

export interface BackupInfo {
  fileName: string;
  bytes: number;
  createdAt: number;
  items: number;
}

export interface ImportBackupReport {
  added: number;
  duplicates: number;
  missingFiles: number;
  categoriesAdded: number;
  groupsAdded: number;
  historyArchived: string | null;
  historyEntryId: string | null;
}

export interface AiProposeResult {
  proposal: Proposal;
  requested: number;
  remaining: number;
  model: string;
  usage: unknown;
}

export interface RevertResult {
  undone: boolean;
  entryId: string;
  conflicts: string[];
  restoredCatalogs: string[];
  changes: number;
}

export interface ApplyResult {
  applied: number;
  changes: number;
  historyId: string;
  proposal: Proposal;
}

export interface CopyResult {
  ok: boolean;
  mode: string;
}

export interface ApiError {
  code: string;
  message: string;
  conflicts?: string[];
}