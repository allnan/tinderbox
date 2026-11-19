use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::ai;
use crate::backup;
use crate::clipboard;
use crate::history::{is_supported, revert, snapshot};
use crate::models::*;
use crate::organize::{self, create_proposal, EntryPatch};
use crate::rules;
use crate::store::{lock_store, AppState, Store};
use crate::util::*;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileImportReport {
    pub added: usize,
    pub duplicates: usize,
    pub failed: Vec<String>,
    pub items: Vec<Sticker>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub updated: usize,
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItemView {
    #[serde(flatten)]
    pub entry: HistoryEntry,
    pub can_undo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub total: usize,
    pub items: Vec<HistoryItemView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposeResult {
    pub proposal: Proposal,
    pub requested: usize,
    pub remaining: usize,
    pub model: String,
    pub usage: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub ok: bool,
    pub mode: String,
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_state(state: State<'_, AppState>) -> ApiResult<StateView> {
    Ok(lock_store(&state)?.state_view())
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_system(state: State<'_, AppState>) -> ApiResult<SystemInfo> {
    let store = lock_store(&state)?;
    Ok(SystemInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        data_dir: store.data_dir.to_string_lossy().to_string(),
        ai_presets: ai::presets(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_paths(state: State<'_, AppState>, paths: Vec<String>) -> ApiResult<FileImportReport> {
    let mut store = lock_store(&state)?;
    import_paths_inner(&mut store, paths)
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_folder(state: State<'_, AppState>, path: String) -> ApiResult<FileImportReport> {
    let mut store = lock_store(&state)?;
    let mut files: Vec<PathBuf> = Vec::new();
    collect_images(Path::new(&path), 0, &mut files);
    if files.is_empty() {
        return Err(AppError::new("empty", "这个文件夹里没有找到支持的图片"));
    }
    import_paths_inner(
        &mut store,
        files
            .into_iter()
            .map(|file| file.to_string_lossy().to_string())
            .collect(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_bytes(
    state: State<'_, AppState>,
    name: String,
    data: String,
) -> ApiResult<FileImportReport> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| AppError::new("invalid_data", "粘贴的图片数据无法读取"))?;
    let ext = normalize_ext(&name)
        .or_else(|| {
            image::guess_format(&bytes).ok().map(|format| {
                match format {
                    image::ImageFormat::Png => "png",
                    image::ImageFormat::Jpeg => "jpg",
                    image::ImageFormat::Gif => "gif",
                    image::ImageFormat::WebP => "webp",
                    image::ImageFormat::Bmp => "bmp",
                    _ => "png",
                }
                .to_string()
            })
        })
        .unwrap_or_else(|| "png".to_string());
    let mut store = lock_store(&state)?;
    let mut report = FileImportReport::default();
    match import_image_bytes(&mut store, &name, &bytes, &ext) {
        Ok(Some(item)) => {
            let change = Change {
                item_id: item.id.clone(),
                before: None,
                after: Some(snapshot(&item)),
            };
            report.items.push(item);
            report.added = 1;
            store.log(
                "items.import",
                "user",
                "从剪贴板导入 1 张表情包".to_string(),
                true,
                vec![change],
                json!({}),
            );
            store.library.meta.last_import_at = now_ms();
            store.persist_library()?;
        }
        Ok(None) => report.duplicates = 1,
        Err(error) => report.failed.push(error.message),
    }
    Ok(report)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_item(state: State<'_, AppState>, id: String, patch: Value) -> ApiResult<Sticker> {
    let mut store = lock_store(&state)?;
    let item_index = store
        .library
        .items
        .iter()
        .position(|item| item.id == id && !item.deleted)
        .ok_or_else(|| AppError::new("not_found", "素材不存在"))?;
    let before = snapshot(&store.library.items[item_index]);
    let categories = store.library.categories.clone();
    let groups = store.library.groups.clone();
    apply_item_patch(&categories, &groups, &mut store.library.items[item_index], &patch)?;
    let after = snapshot(&store.library.items[item_index]);
    if before != after {
        let item_name = store.library.items[item_index].name.clone();
        store.log(
            "items.update",
            "user",
            format!("编辑「{}」", item_name),
            true,
            vec![Change {
                item_id: id.clone(),
                before: Some(before),
                after: Some(after),
            }],
            Value::Null,
        );
        store.persist_library()?;
    }
    Ok(store.library.items[item_index].clone())
}

#[tauri::command(rename_all = "camelCase")]
pub fn batch_update(
    state: State<'_, AppState>,
    ids: Vec<String>,
    patch: Value,
) -> ApiResult<BatchResult> {
    let mut store = lock_store(&state)?;
    let mut changes: Vec<Change> = Vec::new();
    let mut updated: Vec<String> = Vec::new();
    let categories = store.library.categories.clone();
    let groups = store.library.groups.clone();
    for id in ids.into_iter().take(2000) {
        let Some(index) = store
            .library
            .items
            .iter()
            .position(|item| item.id == id && !item.deleted)
        else {
            continue;
        };
        let before = snapshot(&store.library.items[index]);
        apply_item_patch(&categories, &groups, &mut store.library.items[index], &patch)?;
        let after = snapshot(&store.library.items[index]);
        if before != after {
            changes.push(Change {
                item_id: id.clone(),
                before: Some(before),
                after: Some(after),
            });
            updated.push(id);
        }
    }
    if !changes.is_empty() {
        store.log(
            "items.batch",
            "user",
            format!("批量整理 {} 张", changes.len()),
            true,
            changes,
            json!({ "patchKeys": patch.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() }),
        );
        store.persist_library()?;
    }
    Ok(BatchResult {
        updated: updated.len(),
        ids: updated,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_items(state: State<'_, AppState>, ids: Vec<String>) -> ApiResult<usize> {
    let mut store = lock_store(&state)?;
    let mut changes: Vec<Change> = Vec::new();
    for id in ids.into_iter().take(2000) {
        let Some(item) = store
            .library
            .items
            .iter_mut()
            .find(|item| item.id == id && !item.deleted)
        else {
            continue;
        };
        let before = snapshot(item);
        item.deleted = true;
        item.deleted_at = Some(now_ms());
        changes.push(Change {
            item_id: id,
            before: Some(before),
            after: Some(snapshot(item)),
        });
    }
    let total = changes.len();
    if !changes.is_empty() {
        store.log(
            "items.delete",
            "user",
            format!("删除 {} 张表情包（可在整理记录中撤回）", total),
            true,
            changes,
            Value::Null,
        );
        store.persist_library()?;
    }
    Ok(total)
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_items(state: State<'_, AppState>, ids: Vec<String>) -> ApiResult<usize> {
    let mut store = lock_store(&state)?;
    let mut changes: Vec<Change> = Vec::new();
    for id in ids.into_iter().take(2000) {
        let Some(item) = store
            .library
            .items
            .iter_mut()
            .find(|item| item.id == id && item.deleted)
        else {
            continue;
        };
        let before = snapshot(item);
        item.deleted = false;
        item.deleted_at = None;
        changes.push(Change {
            item_id: id,
            before: Some(before),
            after: Some(snapshot(item)),
        });
    }
    if !changes.is_empty() {
        let total = changes.len();
        store.log(
            "items.restore",
            "user",
            format!("恢复 {} 张表情包", total),
            true,
            changes,
            Value::Null,
        );
        store.persist_library()?;
        return Ok(total);
    }
    Ok(0)
}

#[tauri::command(rename_all = "camelCase")]
pub fn copy_item(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mode: String,
) -> ApiResult<CopyResult> {
    let (path, mode) = {
        let store = lock_store(&state)?;
        let item = store
            .visible_item(&id)
            .ok_or_else(|| AppError::new("not_found", "素材不存在"))?;
        let path = store.image_path(item);
        if !path.is_file() {
            return Err(AppError::new("missing_file", "原图文件缺失，无法复制"));
        }
        (path, if mode == "file" { "file".to_string() } else { "image".to_string() })
    };
    if mode == "file" {
        clipboard::copy_file_to_clipboard(&path)?;
    } else {
        clipboard::copy_image_to_clipboard(&app, &path)?;
    }
    let mut store = lock_store(&state)?;
    if let Some(item) = store.library.items.iter_mut().find(|item| item.id == id) {
        item.usage_count = item.usage_count.saturating_add(1);
        item.last_used_at = Some(now_ms());
    }
    store.persist_library()?;
    Ok(CopyResult { ok: true, mode })
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_category(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> ApiResult<Category> {
    let mut store = lock_store(&state)?;
    let name = clean_text(&name, 24);
    if name.is_empty() {
        return Err(AppError::new("invalid", "分类名称不能为空"));
    }
    if store.category_by_name(&name).is_some() {
        return Err(AppError::new("duplicate", "已经有同名分类了"));
    }
    let category = Category {
        id: new_id("cat"),
        name,
        color: normalize_color(color.as_deref().unwrap_or("")),
        order: store.library.categories.len() as i64,
        created_at: now_ms(),
    };
    store.library.categories.push(category.clone());
    store.log(
        "catalog.createCategory",
        "user",
        format!("新增分类「{}」", category.name),
        true,
        Vec::new(),
        json!({ "record": category }),
    );
    store.persist_library()?;
    Ok(category)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_category(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> ApiResult<Category> {
    let mut store = lock_store(&state)?;
    let Some(index) = store
        .library
        .categories
        .iter()
        .position(|category| category.id == id)
    else {
        return Err(AppError::new("not_found", "分类不存在"));
    };
    let before = {
        let category = &store.library.categories[index];
        json!({ "name": category.name, "color": category.color })
    };
    if let Some(name) = name {
        let clean = clean_text(&name, 24);
        if clean.is_empty() {
            return Err(AppError::new("invalid", "分类名称不能为空"));
        }
        if store
            .library
            .categories
            .iter()
            .any(|category| category.id != id && category.name.to_lowercase() == clean.to_lowercase())
        {
            return Err(AppError::new("duplicate", "已经有同名分类了"));
        }
        store.library.categories[index].name = clean;
    }
    if let Some(color) = color {
        store.library.categories[index].color = normalize_color(&color);
    }
    let after = {
        let category = &store.library.categories[index];
        json!({ "name": category.name, "color": category.color })
    };
    if before != after {
        let category_name = store.library.categories[index].name.clone();
        store.log(
            "catalog.updateCategory",
            "user",
            format!("更新分类「{}」", category_name),
            true,
            Vec::new(),
            json!({ "entityId": id, "before": before, "after": after }),
        );
        store.persist_library()?;
    }
    Ok(store.library.categories[index].clone())
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_category(state: State<'_, AppState>, id: String) -> ApiResult<usize> {
    let mut store = lock_store(&state)?;
    let Some(index) = store
        .library
        .categories
        .iter()
        .position(|category| category.id == id)
    else {
        return Err(AppError::new("not_found", "分类不存在"));
    };
    let record = store.library.categories.remove(index);
    let mut changes: Vec<Change> = Vec::new();
    for item in store.library.items.iter_mut() {
        if item.category_id.as_deref() != Some(&record.id) {
            continue;
        }
        let before = snapshot(item);
        item.category_id = None;
        if item.group_ids.is_empty() {
            item.status = "inbox".to_string();
        }
        changes.push(Change {
            item_id: item.id.clone(),
            before: Some(before),
            after: Some(snapshot(item)),
        });
    }
    store.log(
        "catalog.deleteCategory",
        "user",
        format!("删除分类「{}」（{} 张素材回到未归类）", record.name, changes.len()),
        true,
        changes,
        json!({ "record": record }),
    );
    store.persist_library()?;
    Ok(store.library.categories.len())
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_group(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
    note: Option<String>,
) -> ApiResult<Group> {
    let mut store = lock_store(&state)?;
    let name = clean_text(&name, 24);
    if name.is_empty() {
        return Err(AppError::new("invalid", "分组名称不能为空"));
    }
    if store.group_by_name(&name).is_some() {
        return Err(AppError::new("duplicate", "已经有同名分组了"));
    }
    let group = Group {
        id: new_id("grp"),
        name,
        color: normalize_color(color.as_deref().unwrap_or("")),
        note: clean_text(note.as_deref().unwrap_or(""), 120),
        order: store.library.groups.len() as i64,
        created_at: now_ms(),
    };
    store.library.groups.push(group.clone());
    store.log(
        "catalog.createGroup",
        "user",
        format!("新增分组「{}」", group.name),
        true,
        Vec::new(),
        json!({ "record": group }),
    );
    store.persist_library()?;
    Ok(group)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_group(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    note: Option<String>,
) -> ApiResult<Group> {
    let mut store = lock_store(&state)?;
    let Some(index) = store.library.groups.iter().position(|group| group.id == id) else {
        return Err(AppError::new("not_found", "分组不存在"));
    };
    let before = {
        let group = &store.library.groups[index];
        json!({ "name": group.name, "color": group.color, "note": group.note })
    };
    if let Some(name) = name {
        let clean = clean_text(&name, 24);
        if clean.is_empty() {
            return Err(AppError::new("invalid", "分组名称不能为空"));
        }
        if store
            .library
            .groups
            .iter()
            .any(|group| group.id != id && group.name.to_lowercase() == clean.to_lowercase())
        {
            return Err(AppError::new("duplicate", "已经有同名分组了"));
        }
        store.library.groups[index].name = clean;
    }
    if let Some(color) = color {
        store.library.groups[index].color = normalize_color(&color);
    }
    if let Some(note) = note {
        store.library.groups[index].note = clean_text(&note, 120);
    }
    let after = {
        let group = &store.library.groups[index];
        json!({ "name": group.name, "color": group.color, "note": group.note })
    };
    if before != after {
        let group_name = store.library.groups[index].name.clone();
        store.log(
            "catalog.updateGroup",
            "user",
            format!("更新分组「{}」", group_name),
            true,
            Vec::new(),
            json!({ "entityId": id, "before": before, "after": after }),
        );
        store.persist_library()?;
    }
    Ok(store.library.groups[index].clone())
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_group(state: State<'_, AppState>, id: String) -> ApiResult<usize> {
    let mut store = lock_store(&state)?;
    let Some(index) = store.library.groups.iter().position(|group| group.id == id) else {
        return Err(AppError::new("not_found", "分组不存在"));
    };
    let record = store.library.groups.remove(index);
    let mut changes: Vec<Change> = Vec::new();
    for item in store.library.items.iter_mut() {
        if !item.group_ids.contains(&record.id) {
            continue;
        }
        let before = snapshot(item);
        item.group_ids.retain(|group_id| group_id != &record.id);
        if item.category_id.is_none() && item.group_ids.is_empty() {
            item.status = "inbox".to_string();
        }
        changes.push(Change {
            item_id: item.id.clone(),
            before: Some(before),
            after: Some(snapshot(item)),
        });
    }
    store.log(
        "catalog.deleteGroup",
        "user",
        format!("删除分组「{}」（{} 张素材移出）", record.name, changes.len()),
        true,
        changes,
        json!({ "record": record }),
    );
    store.persist_library()?;
    Ok(store.library.groups.len())
}

#[tauri::command(rename_all = "camelCase")]
pub fn propose_rules(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> ApiResult<Proposal> {
    let mut store = lock_store(&state)?;
    let candidates = candidates(&store, ids);
    if candidates.is_empty() {
        return Err(AppError::new("empty", "待整理区里没有素材"));
    }
    let entries = rules::build_rule_entries(&candidates, &store.library.categories, &store.library.groups);
    if entries.is_empty() {
        return Err(AppError::new(
            "empty",
            "这些素材没有可识别的特征，可以手动整理或试试 AI 整理",
        ));
    }
    let summary = format!("本地规则 · {} 条建议", entries.len());
    create_proposal(&mut store, "rules", &summary, entries, json!({}))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn propose_ai(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> ApiResult<AiProposeResult> {
    let (settings, categories, groups, batch, total, data_dir) = {
        let store = lock_store(&state)?;
        if !store.settings.ai.enabled {
            return Err(AppError::new("ai_disabled", "还没有开启 AI 整理，请先在设置中启用"));
        }
        let candidates = candidates(&store, ids);
        if candidates.is_empty() {
            return Err(AppError::new("empty", "没有需要整理的素材"));
        }
        let total = candidates.len();
        let batch: Vec<Sticker> = candidates
            .into_iter()
            .take(store.settings.ai.batch_size as usize)
            .collect();
        (
            store.settings.clone(),
            store.library.categories.clone(),
            store.library.groups.clone(),
            batch,
            total,
            store.data_dir.clone(),
        )
    };
    let mut items: Vec<(Sticker, String)> = Vec::new();
    for item in batch {
        let mut image = String::new();
        if settings.ai.vision {
            if let Ok(bytes) = fs::read(data_dir.join("thumbs").join(&item.sha256)) {
                let mime = if item.thumb_mime.is_empty() {
                    "image/webp"
                } else {
                    item.thumb_mime.as_str()
                };
                image = format!(
                    "data:{};base64,{}",
                    mime,
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
            }
        }
        items.push((item, image));
    }
    let outcome = ai::request_ai(&settings, &categories, &groups, &items).await?;
    let plain_items: Vec<Sticker> = items.iter().map(|(item, _)| item.clone()).collect();
    let entries = ai::parse_ai_response(&outcome.content, &plain_items, &categories, &groups)?;
    if entries.is_empty() {
        return Err(AppError::new(
            "ai_empty",
            "AI 没有给出新的整理建议，可能这些素材已经足够整理好了",
        ));
    }
    let requested = items.len();
    let summary = format!("AI 整理 · {} 条建议 · {}", entries.len(), outcome.model);
    let mut store = lock_store(&state)?;
    let proposal = create_proposal(
        &mut store,
        "ai",
        &summary,
        entries,
        json!({
            "model": outcome.model,
            "usage": outcome.usage,
            "requested": requested,
        }),
    )?;
    Ok(AiProposeResult {
        proposal,
        requested,
        remaining: total.saturating_sub(requested),
        model: outcome.model,
        usage: outcome.usage,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_proposal(
    state: State<'_, AppState>,
    id: String,
    entries: Vec<EntryPatch>,
) -> ApiResult<Proposal> {
    let mut store = lock_store(&state)?;
    organize::update_proposal_entries(&mut store, &id, entries)
}

#[tauri::command(rename_all = "camelCase")]
pub fn apply_proposal(
    state: State<'_, AppState>,
    id: String,
    entry_ids: Option<Vec<String>>,
) -> ApiResult<organize::ApplyResult> {
    let mut store = lock_store(&state)?;
    organize::apply_proposal(&mut store, &id, entry_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn dismiss_proposal(state: State<'_, AppState>, id: String) -> ApiResult<Proposal> {
    let mut store = lock_store(&state)?;
    organize::dismiss_proposal(&mut store, &id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn revert_proposal(
    state: State<'_, AppState>,
    id: String,
    force: Option<bool>,
) -> ApiResult<crate::history::RevertResult> {
    let mut store = lock_store(&state)?;
    let history_id = store
        .library
        .proposals
        .iter()
        .find(|proposal| proposal.id == id)
        .and_then(|proposal| proposal.history_id.clone())
        .ok_or_else(|| AppError::new("not_found", "这条提案还没有应用，无法撤回"))?;
    revert(&mut store, &history_id, force.unwrap_or(false))
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
    offset: Option<u32>,
    type_filter: Option<String>,
    actor: Option<String>,
) -> ApiResult<HistoryPage> {
    let store = lock_store(&state)?;
    let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
    let offset = offset.unwrap_or(0) as usize;
    let mut rows: Vec<&HistoryEntry> = store
        .history
        .iter()
        .filter(|entry| {
            type_filter
                .as_deref()
                .map(|value| value.is_empty() || entry.kind == value)
                .unwrap_or(true)
                && actor
                    .as_deref()
                    .map(|value| value.is_empty() || entry.actor == value)
                    .unwrap_or(true)
        })
        .collect();
    rows.sort_by(|left, right| right.at.cmp(&left.at));
    let total = rows.len();
    let items = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|entry| HistoryItemView {
            can_undo: entry.undoable && entry.undone_at.is_none() && is_supported(entry),
            entry: entry.clone(),
        })
        .collect();
    Ok(HistoryPage { total, items })
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_history(
    state: State<'_, AppState>,
    id: String,
    force: Option<bool>,
) -> ApiResult<crate::history::RevertResult> {
    let mut store = lock_store(&state)?;
    revert(&mut store, &id, force.unwrap_or(false))
}

#[tauri::command(rename_all = "camelCase")]
pub fn export_backup(state: State<'_, AppState>) -> ApiResult<backup::BackupInfo> {
    let mut store = lock_store(&state)?;
    backup::export_backup(&mut store)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_backups(state: State<'_, AppState>) -> ApiResult<Vec<backup::BackupInfo>> {
    let store = lock_store(&state)?;
    backup::list_backups(&store)
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_backup(state: State<'_, AppState>, path: String) -> ApiResult<backup::ImportReport> {
    let mut store = lock_store(&state)?;
    backup::import_backup(&mut store, Path::new(&path))
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_backup(
    state: State<'_, AppState>,
    file_name: String,
) -> ApiResult<backup::ImportReport> {
    let mut store = lock_store(&state)?;
    let path = backup::backup_path(&store, &file_name)?;
    backup::import_backup(&mut store, &path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_backup(state: State<'_, AppState>, file_name: String) -> ApiResult<()> {
    let mut store = lock_store(&state)?;
    backup::delete_backup(&mut store, &file_name)
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> ApiResult<()> {
    let data_dir = lock_store(&state)?.data_dir.clone();
    std::process::Command::new("explorer")
        .arg(&data_dir)
        .spawn()
        .map_err(|error| AppError::new("open_failed", format!("无法打开数据目录：{}", error)))?;
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn show_quick(app: AppHandle) {
    crate::show_quick_window(&app);
}

#[tauri::command]
pub fn quick_visible(app: AppHandle) -> bool {
    app.get_webview_window("quick")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_quick_always_on_top(app: AppHandle, state: State<'_, AppState>, value: bool) -> ApiResult<bool> {
    let mut store = lock_store(&state)?;
    store.settings.quick_always_on_top = value;
    store.persist_settings()?;
    if let Some(window) = app.get_webview_window("quick") {
        window
            .set_always_on_top(value)
            .map_err(|error| AppError::new("quick_pin", format!("无法设置窗口置顶：{}", error)))?;
    }
    Ok(value)
}

#[tauri::command]
pub fn quick_hotkey_registered(app: AppHandle) -> bool {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().is_registered("Ctrl+Shift+Space")
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_settings(state: State<'_, AppState>, patch: Value) -> ApiResult<SettingsView> {
    let mut store = lock_store(&state)?;
    apply_settings_patch(&mut store.settings, &patch);
    store.settings.normalize();
    store.persist_settings()?;
    store.log(
        "settings.update",
        "user",
        "更新设置".to_string(),
        false,
        Vec::new(),
        json!({ "keys": patch.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() }),
    );
    Ok(SettingsView::from(&store.settings))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn test_ai(state: State<'_, AppState>, overrides: Option<Value>) -> ApiResult<String> {
    let settings = {
        let store = lock_store(&state)?;
        let mut settings = store.settings.clone();
        if let Some(overrides) = overrides {
            let mut patch = serde_json::Map::new();
            patch.insert("ai".to_string(), overrides);
            apply_settings_patch(&mut settings, &Value::Object(patch));
        }
        settings.normalize();
        settings
    };
    ai::test_connection(&settings).await
}

// ------------------------------------------------------------------ helpers

fn candidates(store: &Store, ids: Option<Vec<String>>) -> Vec<Sticker> {
    match ids {
        Some(ids) if !ids.is_empty() => store
            .library
            .items
            .iter()
            .filter(|item| !item.deleted && ids.contains(&item.id))
            .cloned()
            .collect(),
        _ => store
            .library
            .items
            .iter()
            .filter(|item| !item.deleted && item.status == "inbox")
            .cloned()
            .collect(),
    }
}

fn import_paths_inner(store: &mut Store, paths: Vec<String>) -> ApiResult<FileImportReport> {
    let mut report = FileImportReport::default();
    let mut changes: Vec<Change> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for path in paths.into_iter().take(2000) {
        let candidate = PathBuf::from(path);
        if candidate.is_dir() {
            collect_images(&candidate, 0, &mut files);
        } else {
            files.push(candidate);
        }
        if files.len() >= 2000 {
            break;
        }
    }
    for file_path in files.into_iter().take(2000) {
        let name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("image")
            .to_string();
        let ext = match normalize_ext(&name) {
            Some(ext) => ext,
            None => {
                report.failed.push(format!("{}：不支持的文件格式", name));
                continue;
            }
        };
        let bytes = match fs::read(&file_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                report.failed.push(format!("{}：{}", name, error));
                continue;
            }
        };
        match import_image_bytes(store, &name, &bytes, &ext) {
            Ok(Some(item)) => {
                report.items.push(item.clone());
                report.added += 1;
                changes.push(Change {
                    item_id: item.id.clone(),
                    before: None,
                    after: Some(snapshot(&item)),
                });
            }
            Ok(None) => report.duplicates += 1,
            Err(error) => report.failed.push(format!("{}：{}", name, error.message)),
        }
    }
    if !changes.is_empty() {
        store.log(
            "items.import",
            "user",
            format!("导入 {} 张表情包", changes.len()),
            true,
            changes,
            json!({}),
        );
        store.library.meta.last_import_at = now_ms();
        store.persist_library()?;
    }
    Ok(report)
}

fn import_image_bytes(
    store: &mut Store,
    name: &str,
    bytes: &[u8],
    ext: &str,
) -> ApiResult<Option<Sticker>> {
    let sha = sha256_hex(bytes);
    if let Some(existing) = store
        .library
        .items
        .iter_mut()
        .find(|item| item.sha256 == sha)
    {
        if existing.deleted {
            existing.deleted = false;
            existing.deleted_at = None;
            return Ok(Some(existing.clone()));
        }
        return Ok(None);
    }
    let (width, height, phash, thumb) = if ext == "avif" {
        (0, 0, String::new(), None)
    } else {
        match image::load_from_memory(bytes) {
            Ok(image) => {
                let thumb = build_thumbnail(&image).ok();
                (
                    image.width(),
                    image.height(),
                    dhash(&image),
                    thumb,
                )
            }
            Err(_) => (0, 0, String::new(), None),
        }
    };
    store.save_image(&sha, ext, bytes)?;
    let thumb_mime = if let Some((thumb_bytes, mime)) = thumb {
        store.save_thumb(&sha, &thumb_bytes)?;
        mime.to_string()
    } else {
        String::new()
    };
    let item = Sticker {
        id: new_id("item"),
        sha256: sha,
        ext: ext.to_string(),
        mime: mime_for_ext(ext).to_string(),
        thumb_mime,
        width,
        height,
        bytes: bytes.len() as u64,
        phash,
        name: display_name(name, "未命名表情"),
        note: String::new(),
        category_id: None,
        group_ids: Vec::new(),
        tags: Vec::new(),
        favorite: false,
        status: "inbox".to_string(),
        deleted: false,
        deleted_at: None,
        imported_at: now_ms(),
        created_at: now_ms(),
        usage_count: 0,
        last_used_at: None,
        origin: "import".to_string(),
        ai_note: String::new(),
    };
    store.library.items.push(item.clone());
    Ok(Some(item))
}

fn build_thumbnail(image: &image::DynamicImage) -> Result<(Vec<u8>, &'static str), AppError> {
    let thumb = image.thumbnail(360, 360);
    if thumb.color().has_alpha() {
        let mut cursor = Cursor::new(Vec::new());
        thumb
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|error| AppError::new("thumbnail", format!("生成缩略图失败：{}", error)))?;
        Ok((cursor.into_inner(), "image/png"))
    } else {
        let mut cursor = Cursor::new(Vec::new());
        {
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 82);
            thumb
                .write_with_encoder(encoder)
                .map_err(|error| AppError::new("thumbnail", format!("生成缩略图失败：{}", error)))?;
        }
        Ok((cursor.into_inner(), "image/jpeg"))
    }
}

fn dhash(image: &image::DynamicImage) -> String {
    let small = image
        .resize_exact(9, 8, image::imageops::FilterType::Triangle)
        .to_luma8();
    let mut bits: u64 = 0;
    for y in 0..8u32 {
        for x in 0..8u32 {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            bits = (bits << 1) | u64::from(left > right);
        }
    }
    format!("{:016x}", bits)
}

fn collect_images(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() >= 2000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, depth + 1, out);
        } else if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
            if safe_ext(ext).is_some() {
                out.push(path);
            }
        }
        if out.len() >= 2000 {
            return;
        }
    }
}

fn apply_item_patch(
    categories: &[Category],
    groups: &[Group],
    item: &mut Sticker,
    patch: &Value,
) -> Result<(), AppError> {
    if let Some(name) = patch.get("name").and_then(Value::as_str) {
        let name = clean_text(name, 40);
        if !name.is_empty() {
            item.name = name;
        }
    }
    if let Some(note) = patch.get("note").and_then(Value::as_str) {
        item.note = clean_text(note, 200);
    }
    if let Some(value) = patch.get("categoryId") {
        if value.is_null() {
            item.category_id = None;
        } else if let Some(id) = value.as_str() {
            if id.is_empty() {
                item.category_id = None;
            } else if categories.iter().any(|category| category.id == id) {
                item.category_id = Some(id.to_string());
            }
        }
    }
    if let Some(value) = patch.get("groupIds").and_then(Value::as_array) {
        let mut next: Vec<String> = Vec::new();
        for group_id in value.iter().filter_map(Value::as_str) {
            if groups.iter().any(|group| group.id == group_id)
                && !next.contains(&group_id.to_string())
            {
                next.push(group_id.to_string());
            }
        }
        item.group_ids = next;
    }
    if let Some(value) = patch.get("addGroupIds").and_then(Value::as_array) {
        for group_id in value.iter().filter_map(Value::as_str) {
            if groups.iter().any(|group| group.id == group_id)
                && !item.group_ids.contains(&group_id.to_string())
            {
                item.group_ids.push(group_id.to_string());
            }
        }
    }
    if let Some(value) = patch.get("removeGroupIds").and_then(Value::as_array) {
        let remove: Vec<&str> = value.iter().filter_map(Value::as_str).collect();
        item.group_ids.retain(|group_id| !remove.contains(&group_id.as_str()));
    }
    if let Some(value) = patch.get("tags").and_then(Value::as_array) {
        item.tags = unique_strings(
            &value
                .iter()
                .filter_map(Value::as_str)
                .map(|tag| tag.to_string())
                .collect::<Vec<_>>(),
            24,
            24,
        );
    }
    if let Some(value) = patch.get("addTags").and_then(Value::as_array) {
        let mut tags = item.tags.clone();
        tags.extend(value.iter().filter_map(Value::as_str).map(|tag| tag.to_string()));
        item.tags = unique_strings(&tags, 24, 24);
    }
    if let Some(value) = patch.get("removeTags").and_then(Value::as_array) {
        let remove: Vec<String> = value
            .iter()
            .filter_map(Value::as_str)
            .map(|tag| tag.to_lowercase())
            .collect();
        item.tags.retain(|tag| !remove.contains(&tag.to_lowercase()));
    }
    if let Some(value) = patch.get("favorite").and_then(Value::as_bool) {
        item.favorite = value;
    }
    if let Some(value) = patch.get("aiNote").and_then(Value::as_str) {
        item.ai_note = clean_text(value, 200);
    }
    let explicit_status = patch.get("status").and_then(Value::as_str).filter(|value| {
        *value == "inbox" || *value == "sorted"
    });
    match explicit_status {
        Some("inbox") => item.status = "inbox".to_string(),
        Some(_) => item.status = "sorted".to_string(),
        None => {
            item.status = if item.category_id.is_some() || !item.group_ids.is_empty() {
                "sorted".to_string()
            } else {
                "inbox".to_string()
            }
        }
    }
    Ok(())
}

fn apply_settings_patch(settings: &mut Settings, patch: &Value) {
    if let Some(ai) = patch.get("ai") {
        if let Some(value) = ai.get("enabled").and_then(Value::as_bool) {
            settings.ai.enabled = value;
        }
        if let Some(value) = ai.get("baseUrl").and_then(Value::as_str) {
            settings.ai.base_url = clean_text(value, 300);
        }
        if let Some(value) = ai.get("model").and_then(Value::as_str) {
            settings.ai.model = clean_text(value, 120);
        }
        if let Some(value) = ai.get("vision").and_then(Value::as_bool) {
            settings.ai.vision = value;
        }
        if let Some(value) = ai.get("batchSize").and_then(Value::as_u64) {
            settings.ai.batch_size = value.clamp(1, 24) as u32;
        }
        if let Some(value) = ai.get("timeoutMs").and_then(Value::as_u64) {
            settings.ai.timeout_ms = value.clamp(10_000, 300_000);
        }
        if let Some(value) = ai.get("apiKey").and_then(Value::as_str) {
            if value == "__CLEAR__" {
                settings.ai.api_key.clear();
            } else if !value.trim().is_empty() {
                settings.ai.api_key = value.trim().to_string();
            }
        }
    }
    if let Some(value) = patch.get("copyMode").and_then(Value::as_str) {
        if value == "image" || value == "file" {
            settings.copy_mode = value.to_string();
        }
    }
    if let Some(value) = patch.get("cardSize").and_then(Value::as_u64) {
        settings.card_size = value.clamp(96, 260) as u32;
    }
    if let Some(value) = patch.get("autoBackup").and_then(Value::as_bool) {
        settings.auto_backup = value;
    }
    if let Some(value) = patch.get("quickAlwaysOnTop").and_then(Value::as_bool) {
        settings.quick_always_on_top = value;
    }
}