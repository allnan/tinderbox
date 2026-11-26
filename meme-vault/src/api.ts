import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  ApiError,
  BackupInfo,
  CopyResult,
  HistoryPage,
  ImportBackupReport,
  ImportReport,
  RevertResult,
  SettingsView,
  StateView,
  Sticker,
  SystemInfo,
  StickerGroup,
  Category,
  Proposal,
} from "./types";

function normalizeError(error: unknown): ApiError {
  if (error && typeof error === "object" && "message" in error) {
    const candidate = error as Partial<ApiError> & { message?: string };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "error",
      message: typeof candidate.message === "string" ? candidate.message : "操作失败",
      conflicts: Array.isArray(candidate.conflicts) ? candidate.conflicts : undefined,
    };
  }
  return { code: "error", message: typeof error === "string" ? error : "操作失败" };
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

export const api = {
  getState: () => call<StateView>("get_state"),
  getSystem: () => call<SystemInfo>("get_system"),
  importPaths: (paths: string[]) => call<ImportReport>("import_paths", { paths }),
  importFolder: (path: string) => call<ImportReport>("import_folder", { path }),
  importBytes: (name: string, data: string) => call<ImportReport>("import_bytes", { name, data }),
  updateItem: (id: string, patch: Record<string, unknown>) => call<Sticker>("update_item", { id, patch }),
  batchUpdate: (ids: string[], patch: Record<string, unknown>) =>
    call<{ updated: number; ids: string[] }>("batch_update", { ids, patch }),
  deleteItems: (ids: string[]) => call<number>("delete_items", { ids }),
  restoreItems: (ids: string[]) => call<number>("restore_items", { ids }),
  copyItem: (id: string, mode: "image" | "file") => call<CopyResult>("copy_item", { id, mode }),
  createCategory: (name: string, color?: string) => call<Category>("create_category", { name, color }),
  updateCategory: (id: string, name?: string, color?: string) =>
    call<Category>("update_category", { id, name, color }),
  deleteCategory: (id: string) => call<number>("delete_category", { id }),
  createGroup: (name: string, color?: string, note?: string) =>
    call<StickerGroup>("create_group", { name, color, note }),
  updateGroup: (id: string, name?: string, color?: string, note?: string) =>
    call<StickerGroup>("update_group", { id, name, color, note }),
  deleteGroup: (id: string) => call<number>("delete_group", { id }),
  proposeRules: (ids?: string[]) => call<Proposal>("propose_rules", { ids }),
  updateProposal: (id: string, entries: unknown[]) => call<Proposal>("update_proposal", { id, entries }),
  applyProposal: (id: string, entryIds?: string[]) => call<ApplyResult>("apply_proposal", { id, entryIds }),
  dismissProposal: (id: string) => call<Proposal>("dismiss_proposal", { id }),
  revertProposal: (id: string, force?: boolean) => call<RevertResult>("revert_proposal", { id, force }),
  getHistory: (params: { limit?: number; offset?: number; typeFilter?: string; actor?: string }) =>
    call<HistoryPage>("get_history", params),
  undoHistory: (id: string, force?: boolean) => call<RevertResult>("undo_history", { id, force }),
  exportBackup: () => call<BackupInfo>("export_backup"),
  listBackups: () => call<BackupInfo[]>("list_backups"),
  importBackup: (path: string) => call<ImportBackupReport>("import_backup", { path }),
  restoreBackup: (fileName: string) => call<ImportBackupReport>("restore_backup", { fileName }),
  deleteBackup: (fileName: string) => call<void>("delete_backup", { fileName }),
  openDataDir: () => call<void>("open_data_dir"),
  showQuick: () => call<void>("show_quick"),
  setQuickAlwaysOnTop: (value: boolean) => call<boolean>("set_quick_always_on_top", { value }),
  saveSettings: (patch: Record<string, unknown>) => call<SettingsView>("save_settings", { patch }),
};

export function mediaUrl(kind: "image" | "thumb", sha256: string): string {
  return `http://meme.localhost/${kind}/${sha256}`;
}