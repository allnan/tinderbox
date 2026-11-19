use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::models::*;
use crate::store::Store;
use crate::util::now_ms;

pub fn snapshot(item: &Sticker) -> Snapshot {
    let mut group_ids = item.group_ids.clone();
    group_ids.sort();
    group_ids.dedup();
    let mut tags = item.tags.clone();
    tags.sort();
    tags.dedup();
    Snapshot {
        name: item.name.clone(),
        note: item.note.clone(),
        category_id: item.category_id.clone(),
        group_ids,
        tags,
        favorite: item.favorite,
        status: if item.status == "sorted" {
            "sorted".to_string()
        } else {
            "inbox".to_string()
        },
        deleted: item.deleted,
        ai_note: item.ai_note.clone(),
    }
}

pub fn apply_snapshot(item: &mut Sticker, snapshot: &Snapshot) {
    item.name = snapshot.name.clone();
    item.note = snapshot.note.clone();
    item.category_id = snapshot.category_id.clone();
    item.group_ids = snapshot.group_ids.clone();
    item.tags = snapshot.tags.clone();
    item.favorite = snapshot.favorite;
    item.status = if snapshot.status == "sorted" {
        "sorted".to_string()
    } else {
        "inbox".to_string()
    };
    item.deleted = snapshot.deleted;
    item.deleted_at = if snapshot.deleted { Some(now_ms()) } else { None };
    item.ai_note = snapshot.ai_note.clone();
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub undone: bool,
    pub entry_id: String,
    pub conflicts: Vec<String>,
    pub restored_catalogs: Vec<String>,
    pub changes: usize,
}

const SUPPORTED_ITEM_TYPES: [&str; 7] = [
    "items.import",
    "items.update",
    "items.batch",
    "items.delete",
    "items.restore",
    "organize.apply",
    "backup.import",
];

const SUPPORTED_CATALOG_TYPES: [&str; 6] = [
    "catalog.createCategory",
    "catalog.updateCategory",
    "catalog.deleteCategory",
    "catalog.createGroup",
    "catalog.updateGroup",
    "catalog.deleteGroup",
];

pub fn is_supported(entry: &HistoryEntry) -> bool {
    SUPPORTED_ITEM_TYPES.contains(&entry.kind.as_str())
        || SUPPORTED_CATALOG_TYPES.contains(&entry.kind.as_str())
}

pub fn revert(store: &mut Store, history_id: &str, force: bool) -> Result<RevertResult, AppError> {
    let entry = store
        .history_by_id(history_id)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", "找不到这条整理记录"))?;
    if entry.undone_at.is_some() {
        return Err(AppError::new("already_undone", "这条记录已经撤回过了"));
    }
    if !entry.undoable {
        return Err(AppError::new("not_undoable", "这条记录不支持撤回"));
    }
    if !is_supported(&entry) {
        return Err(AppError::new("not_undoable", "这类记录暂不支持自动撤回"));
    }

    let mut conflicts: Vec<String> = Vec::new();
    let mut restored_catalogs: Vec<String> = Vec::new();

    match entry.kind.as_str() {
        "catalog.deleteCategory" | "catalog.deleteGroup" => {
            let record = entry
                .meta
                .get("record")
                .cloned()
                .ok_or_else(|| AppError::new("invalid", "记录缺少目录快照，无法撤回"))?;
            if entry.kind == "catalog.deleteCategory" {
                let category: Category = serde_json::from_value(record)?;
                if !store.library.categories.iter().any(|row| row.id == category.id) {
                    restored_catalogs.push("分类 ".to_string() + &category.name);
                    store.library.categories.push(category);
                }
            } else {
                let group: Group = serde_json::from_value(record)?;
                if !store.library.groups.iter().any(|row| row.id == group.id) {
                    restored_catalogs.push("分组 ".to_string() + &group.name);
                    store.library.groups.push(group);
                }
            }
        }
        "catalog.createCategory" | "catalog.createGroup" => {
            let id = entry
                .meta
                .get("record")
                .and_then(|record| record.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if id.is_empty() {
                return Err(AppError::new("invalid", "记录缺少目录信息，无法撤回"));
            }
            if entry.kind == "catalog.createCategory" {
                for item in store.library.items.iter() {
                    if item.category_id.as_deref() == Some(id.as_str()) {
                        conflicts.push(item.id.clone());
                    }
                }
            } else {
                for item in store.library.items.iter() {
                    if item.group_ids.contains(&id) {
                        conflicts.push(item.id.clone());
                    }
                }
            }
            if !conflicts.is_empty() && !force {
                return Err(AppError::with_conflicts(
                    "conflict",
                    format!("有 {} 张素材正在使用这个目录，撤回前请先移出", conflicts.len()),
                    conflicts,
                ));
            }
            if entry.kind == "catalog.createCategory" {
                store.library.categories.retain(|row| row.id != id);
                for item in store.library.items.iter_mut() {
                    if item.category_id.as_deref() == Some(id.as_str()) {
                        item.category_id = None;
                        if item.group_ids.is_empty() {
                            item.status = "inbox".to_string();
                        }
                    }
                }
            } else {
                store.library.groups.retain(|row| row.id != id);
                for item in store.library.items.iter_mut() {
                    item.group_ids.retain(|group_id| group_id != &id);
                    if item.category_id.is_none() && item.group_ids.is_empty() {
                        item.status = "inbox".to_string();
                    }
                }
            }
            return finish(store, &entry, conflicts, restored_catalogs);
        }
        "catalog.updateCategory" | "catalog.updateGroup" => {
            let entity_id = entry
                .meta
                .get("entityId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let before = entry.meta.get("before").cloned().unwrap_or(Value::Null);
            let after = entry.meta.get("after").cloned().unwrap_or(Value::Null);
            if entry.kind == "catalog.updateCategory" {
                let Some(category) = store
                    .library
                    .categories
                    .iter_mut()
                    .find(|row| row.id == entity_id)
                else {
                    return Err(AppError::new("conflict", "分类已被删除，无法撤回改名"));
                };
                let current = json!({ "name": category.name, "color": category.color });
                if !force && !values_equal(&current, &after) {
                    return Err(AppError::with_conflicts(
                        "conflict",
                        "分类在改名后又被修改过，撤回会产生冲突",
                        vec![entity_id],
                    ));
                }
                if let Some(name) = before.get("name").and_then(Value::as_str) {
                    category.name = name.to_string();
                }
                if let Some(color) = before.get("color").and_then(Value::as_str) {
                    category.color = color.to_string();
                }
            } else {
                let Some(group) = store.library.groups.iter_mut().find(|row| row.id == entity_id) else {
                    return Err(AppError::new("conflict", "分组已被删除，无法撤回改名"));
                };
                let current = json!({ "name": group.name, "color": group.color, "note": group.note });
                if !force && !values_equal(&current, &after) {
                    return Err(AppError::with_conflicts(
                        "conflict",
                        "分组在改名后又被修改过，撤回会产生冲突",
                        vec![entity_id],
                    ));
                }
                if let Some(name) = before.get("name").and_then(Value::as_str) {
                    group.name = name.to_string();
                }
                if let Some(color) = before.get("color").and_then(Value::as_str) {
                    group.color = color.to_string();
                }
                if let Some(note) = before.get("note").and_then(Value::as_str) {
                    group.note = note.to_string();
                }
            }
            return finish(store, &entry, conflicts, restored_catalogs);
        }
        _ => {}
    }

    for change in entry.changes.iter() {
        let current = store
            .library
            .items
            .iter()
            .find(|item| item.id == change.item_id)
            .map(snapshot);
        if current != change.after {
            conflicts.push(change.item_id.clone());
        }
    }
    if !conflicts.is_empty() && !force {
        return Err(AppError::with_conflicts(
            "conflict",
            format!(
                "有 {} 张素材在整理后又被修改过，撤回会产生冲突",
                conflicts.len()
            ),
            conflicts,
        ));
    }
    for change in entry.changes.iter() {
        if let Some(item) = store
            .library
            .items
            .iter_mut()
            .find(|item| item.id == change.item_id)
        {
            match &change.before {
                None => {
                    item.deleted = true;
                    item.deleted_at = Some(now_ms());
                }
                Some(snapshot) => apply_snapshot(item, snapshot),
            }
        }
    }
    if let Some(proposal_id) = entry.meta.get("proposalId").and_then(Value::as_str) {
        if let Some(proposal) = store
            .library
            .proposals
            .iter_mut()
            .find(|proposal| proposal.id == proposal_id)
        {
            proposal.status = "reverted".to_string();
            proposal.reverted_at = Some(now_ms());
        }
    }
    finish(store, &entry, conflicts, restored_catalogs)
}

fn finish(
    store: &mut Store,
    entry: &HistoryEntry,
    conflicts: Vec<String>,
    restored_catalogs: Vec<String>,
) -> Result<RevertResult, AppError> {
    if let Some(row) = store.history.iter_mut().find(|row| row.id == entry.id) {
        row.undone_at = Some(now_ms());
    }
    store.persist_library()?;
    store.persist_history()?;
    Ok(RevertResult {
        undone: true,
        entry_id: entry.id.clone(),
        conflicts,
        restored_catalogs,
        changes: entry.changes.len(),
    })
}

fn values_equal(left: &Value, right: &Value) -> bool {
    if let (Some(left), Some(right)) = (left.as_object(), right.as_object()) {
        left.len() == right.len()
            && left
                .iter()
                .all(|(key, value)| right.get(key).map(|other| other == value).unwrap_or(false))
    } else {
        left == right
    }
}
