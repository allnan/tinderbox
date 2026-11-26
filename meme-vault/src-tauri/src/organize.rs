use std::collections::HashSet;

use serde::Serialize;
use serde_json::{json, Value};

use crate::history::snapshot;
use crate::models::*;
use crate::rules::DraftEntry;
use crate::store::{ensure_category, ensure_group, Store};
use crate::util::{clean_text, new_id, now_ms, unique_strings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: usize,
    pub changes: usize,
    pub history_id: String,
    pub proposal: Proposal,
}

pub fn create_proposal(
    store: &mut Store,
    kind: &str,
    summary: &str,
    drafts: Vec<DraftEntry>,
    meta: Value,
) -> Result<Proposal, AppError> {
    let mut entries: Vec<ProposalEntry> = Vec::new();
    for draft in drafts {
        let Some(item) = store.visible_item(&draft.item_id).cloned() else {
            continue;
        };
        let mut action = normalize_action(store, &item, draft.action);
        if action.category_id.as_ref() == item.category_id.as_ref() {
            action.category_id = None;
        }
        if action.name == item.name {
            action.name.clear();
        }
        let category_changes = action.category_id.is_some() || !action.new_category_name.is_empty();
        let group_changes = !action.add_group_ids.is_empty() || !action.new_group_names.is_empty();
        let tag_changes = !action.add_tags.is_empty();
        let name_changes = !action.name.is_empty();
        if !category_changes && !group_changes && !tag_changes && !name_changes {
            continue;
        }
        entries.push(ProposalEntry {
            id: new_id("ent"),
            item_id: item.id,
            action,
            reason: clean_text(&draft.reason, 80),
            confidence: draft.confidence.clamp(0.0, 1.0),
            skipped: false,
            source: if draft.source.is_empty() {
                kind.to_string()
            } else {
                draft.source
            },
            applied: false,
            skip_reason: None,
        });
    }
    if entries.is_empty() {
        return Err(AppError::new("empty", "没有产生可应用的整理建议"));
    }
    supersede_pending(store, kind, &entries);
    let proposal = Proposal {
        id: new_id("prop"),
        kind: kind.to_string(),
        status: "pending".to_string(),
        summary: clean_text(summary, 120),
        created_at: now_ms(),
        applied_at: None,
        applied_by: String::new(),
        dismissed_at: None,
        reverted_at: None,
        superseded_at: None,
        history_id: None,
        entries,
        meta,
    };
    store.library.proposals.insert(0, proposal.clone());
    if store.library.proposals.len() > 120 {
        store.library.proposals.truncate(120);
    }
    store.log(
        "proposal.create",
        "rules",
        format!("生成整理建议：{}", proposal.summary),
        false,
        Vec::new(),
        json!({
            "proposalId": proposal.id,
            "kind": proposal.kind,
            "model": proposal.meta.get("model").and_then(Value::as_str).unwrap_or(""),
            "entries": proposal.entries.len(),
        }),
    );
    store.persist_library()?;
    Ok(proposal)
}

fn normalize_action(store: &Store, item: &Sticker, mut action: Action) -> Action {
    if let Some(category_id) = action.category_id.clone() {
        if !store
            .library
            .categories
            .iter()
            .any(|category| category.id == category_id)
        {
            action.category_id = None;
        }
    }
    if !action.new_category_name.is_empty() {
        if let Some(existing) = store.category_by_name(&action.new_category_name) {
            if Some(existing.id.clone()) != item.category_id {
                action.category_id = Some(existing.id.clone());
            }
            action.new_category_name.clear();
        } else if let Some(current) = item
            .category_id
            .as_ref()
            .and_then(|id| store.library.categories.iter().find(|category| &category.id == id))
        {
            if current.name.to_lowercase() == action.new_category_name.to_lowercase() {
                action.new_category_name.clear();
            }
        }
    }
    action.add_group_ids.retain(|group_id| {
        store
            .library
            .groups
            .iter()
            .any(|group| &group.id == group_id)
            && !item.group_ids.contains(group_id)
    });
    action.add_group_ids.sort();
    action.add_group_ids.dedup();
    let mut new_groups: Vec<String> = Vec::new();
    for name in action.new_group_names.into_iter() {
        let clean = clean_text(&name, 24);
        if clean.is_empty() {
            continue;
        }
        if let Some(existing) = store.group_by_name(&clean) {
            if !item.group_ids.contains(&existing.id) && !action.add_group_ids.contains(&existing.id) {
                action.add_group_ids.push(existing.id.clone());
            }
        } else if !new_groups.iter().any(|value| value.to_lowercase() == clean.to_lowercase()) && new_groups.len() < 3 {
            new_groups.push(clean);
        }
    }
    action.new_group_names = new_groups;
    action.add_tags = unique_strings(&action.add_tags, 16, 6)
        .into_iter()
        .filter(|tag| {
            !item
                .tags
                .iter()
                .any(|existing| existing.to_lowercase() == tag.to_lowercase())
        })
        .collect();
    action.name = clean_text(&action.name, 40);
    action
}

fn supersede_pending(store: &mut Store, kind: &str, entries: &[ProposalEntry]) {
    let ids: HashSet<String> = entries.iter().map(|entry| entry.item_id.clone()).collect();
    if ids.is_empty() {
        return;
    }
    for proposal in store.library.proposals.iter_mut() {
        if proposal.status != "pending" || proposal.kind != kind {
            continue;
        }
        proposal.entries.retain(|entry| !ids.contains(&entry.item_id));
        if proposal.entries.is_empty() {
            proposal.status = "superseded".to_string();
            proposal.superseded_at = Some(now_ms());
        }
    }
}

pub fn update_proposal_entries(
    store: &mut Store,
    proposal_id: &str,
    patches: Vec<EntryPatch>,
) -> Result<Proposal, AppError> {
    let category_ids: HashSet<String> = store
        .library
        .categories
        .iter()
        .map(|category| category.id.clone())
        .collect();
    let group_ids: HashSet<String> = store
        .library
        .groups
        .iter()
        .map(|group| group.id.clone())
        .collect();
    let proposal = store
        .library
        .proposals
        .iter_mut()
        .find(|proposal| proposal.id == proposal_id)
        .ok_or_else(|| AppError::new("not_found", "找不到这条整理提案"))?;
    if proposal.status != "pending" {
        return Err(AppError::new("invalid_status", "只能修改待确认的提案"));
    }
    for patch in patches {
        let Some(entry) = proposal.entries.iter_mut().find(|entry| entry.id == patch.id) else {
            continue;
        };
        if let Some(skipped) = patch.skipped {
            entry.skipped = skipped;
        }
        if let Some(action) = patch.action {
            if let Some(category_id) = action.category_id {
                if category_id.is_empty() {
                    entry.action.category_id = None;
                    entry.action.new_category_name.clear();
                } else if category_ids.contains(&category_id) {
                    entry.action.category_id = Some(category_id);
                    entry.action.new_category_name.clear();
                }
            }
            if let Some(ids) = action.add_group_ids {
                entry.action.add_group_ids = ids
                    .into_iter()
                    .filter(|id| group_ids.contains(id))
                    .collect();
            }
            if let Some(tags) = action.add_tags {
                entry.action.add_tags = unique_strings(&tags, 16, 6);
            }
            if let Some(name) = action.name {
                entry.action.name = clean_text(&name, 40);
            }
        }
    }
    let result = proposal.clone();
    store.persist_library()?;
    Ok(result)
}

fn store_has_category(store: &Store, id: &str) -> bool {
    store.library.categories.iter().any(|category| category.id == id)
}

fn store_has_group(store: &Store, id: &str) -> bool {
    store.library.groups.iter().any(|group| group.id == id)
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryPatch {
    pub id: String,
    pub skipped: Option<bool>,
    pub action: Option<EntryActionPatch>,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryActionPatch {
    pub category_id: Option<String>,
    pub add_group_ids: Option<Vec<String>>,
    pub add_tags: Option<Vec<String>>,
    pub name: Option<String>,
}

pub fn apply_proposal(
    store: &mut Store,
    proposal_id: &str,
    entry_ids: Option<Vec<String>>,
) -> Result<ApplyResult, AppError> {
    let proposal_index = store
        .library
        .proposals
        .iter()
        .position(|proposal| proposal.id == proposal_id)
        .ok_or_else(|| AppError::new("not_found", "找不到这条整理提案"))?;
    let status = store.library.proposals[proposal_index].status.clone();
    match status.as_str() {
        "pending" => {}
        "applied" => return Err(AppError::new("invalid_status", "这条提案已经应用过了")),
        "dismissed" => return Err(AppError::new("invalid_status", "这条提案已被忽略")),
        "reverted" => return Err(AppError::new("invalid_status", "这条提案已撤回，请重新整理")),
        "superseded" => {
            return Err(AppError::new(
                "invalid_status",
                "这条提案中有素材已被更新的提案覆盖，请使用最新提案",
            ))
        }
        _ => {}
    }
    let proposal = store.library.proposals[proposal_index].clone();
    let selected: HashSet<String> = match entry_ids {
        Some(ids) if !ids.is_empty() => ids.into_iter().collect(),
        _ => proposal
            .entries
            .iter()
            .filter(|entry| !entry.skipped)
            .map(|entry| entry.id.clone())
            .collect(),
    };
    let mut changes: Vec<Change> = Vec::new();
    let mut applied = 0;

    for (entry_index, entry) in proposal.entries.iter().enumerate() {
        if entry.applied || entry.skipped || !selected.contains(&entry.id) {
            continue;
        }
        let Some(item_index) = store
            .library
            .items
            .iter()
            .position(|item| item.id == entry.item_id && !item.deleted)
        else {
            store.library.proposals[proposal_index].entries[entry_index].skipped = true;
            store.library.proposals[proposal_index].entries[entry_index].skip_reason =
                Some("素材已不存在".to_string());
            continue;
        };
        let before = snapshot(&store.library.items[item_index]);

        let mut next_category = store.library.items[item_index].category_id.clone();
        if let Some(category_id) = entry.action.category_id.clone() {
            if store_has_category(store, &category_id) {
                next_category = Some(category_id);
            }
        } else if !entry.action.new_category_name.is_empty() {
            if let Some(created) = ensure_category(store, &entry.action.new_category_name) {
                next_category = Some(created);
            }
        }

        let mut next_groups = store.library.items[item_index].group_ids.clone();
        for group_id in entry.action.add_group_ids.iter() {
            if store_has_group(store, group_id) && !next_groups.contains(group_id) {
                next_groups.push(group_id.clone());
            }
        }
        for group_name in entry.action.new_group_names.iter() {
            if let Some(created) = ensure_group(store, group_name) {
                if !next_groups.contains(&created) {
                    next_groups.push(created);
                }
            }
        }

        let mut next_tags = store.library.items[item_index].tags.clone();
        next_tags.extend(entry.action.add_tags.iter().cloned());
        let next_tags = unique_strings(&next_tags, 24, 24);
        let next_name = if entry.action.name.is_empty() {
            None
        } else {
            Some(clean_text(&entry.action.name, 40))
        };
        let favorite = entry.action.favorite;
        let note = if entry.source == "ai" {
            format!("AI：{}", if entry.reason.is_empty() { "已整理" } else { entry.reason.as_str() })
        } else {
            format!("规则：{}", if entry.reason.is_empty() { "已整理" } else { entry.reason.as_str() })
        };

        {
            let item = &mut store.library.items[item_index];
            if next_category.is_some() {
                item.category_id = next_category.clone();
            }
            item.group_ids = next_groups;
            item.tags = next_tags;
            if let Some(name) = next_name {
                if !name.is_empty() {
                    item.name = name;
                }
            }
            if let Some(favorite) = favorite {
                item.favorite = favorite;
            }
            if item.category_id.is_some() || !item.group_ids.is_empty() {
                item.status = "sorted".to_string();
            }
            item.organize_note = clean_text(&note, 200);
        }

        let after = snapshot(&store.library.items[item_index]);
        if before != after {
            changes.push(Change {
                item_id: entry.item_id.clone(),
                before: Some(before),
                after: Some(after),
            });
            applied += 1;
            store.library.proposals[proposal_index].entries[entry_index].applied = true;
        }
    }

    if changes.is_empty() {
        return Err(AppError::new("empty", "选中的建议没有产生任何变化"));
    }
    {
        let proposal = &mut store.library.proposals[proposal_index];
        proposal.status = "applied".to_string();
        proposal.applied_at = Some(now_ms());
        proposal.applied_by = "user".to_string();
    }
    let summary = format!(
        "应用整理提案：{}（{} 张）",
        store.library.proposals[proposal_index].summary, changes.len()
    );
    let history = store.log(
        "organize.apply",
        if store.library.proposals[proposal_index].kind == "ai" {
            "ai"
        } else {
            "rules"
        },
        summary,
        true,
        changes.clone(),
        json!({
            "proposalId": proposal_id,
            "kind": store.library.proposals[proposal_index].kind,
            "model": store.library.proposals[proposal_index].meta.get("model").cloned().unwrap_or(Value::Null),
        }),
    );
    store.library.proposals[proposal_index].history_id = Some(history.id.clone());
    store.persist_library()?;
    Ok(ApplyResult {
        applied,
        changes: changes.len(),
        history_id: history.id,
        proposal: store.library.proposals[proposal_index].clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{revert, snapshot};
    use crate::models::Category;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn seed_item(store: &mut Store, name: &str) -> String {
        let item = Sticker {
            id: new_id("item"),
            sha256: "a".repeat(64),
            ext: "png".to_string(),
            mime: "image/png".to_string(),
            name: name.to_string(),
            status: "inbox".to_string(),
            imported_at: now_ms(),
            created_at: now_ms(),
            ..Sticker::default()
        };
        let id = item.id.clone();
        store.library.items.push(item);
        id
    }

    #[test]
    fn apply_then_revert_restores_item() {
        let dir = temp_dir("organize-apply");
        let mut store = Store::open(dir).expect("store");
        let item_id = seed_item(&mut store, "大笑猫");
        let proposal = create_proposal(
            &mut store,
            "rules",
            "测试提案",
            vec![DraftEntry {
                item_id: item_id.clone(),
                action: Action {
                    category_id: Some("cat_happy".to_string()),
                    add_tags: vec!["笑".to_string()],
                    ..Action::default()
                },
                reason: "文件名含笑".to_string(),
                confidence: 0.8,
                source: "rules".to_string(),
            }],
            serde_json::json!({}),
        )
        .expect("proposal");
        assert_eq!(store.library.proposals.len(), 1);
        let result = apply_proposal(&mut store, &proposal.id, None).expect("apply");
        assert_eq!(result.applied, 1);
        let item = store.library.items.iter().find(|row| row.id == item_id).unwrap();
        assert_eq!(item.category_id.as_deref(), Some("cat_happy"));
        assert_eq!(item.status, "sorted");

        revert(&mut store, &result.history_id, false).expect("revert");
        let item = store.library.items.iter().find(|row| row.id == item_id).unwrap();
        assert_eq!(item.category_id, None);
        assert_eq!(item.status, "inbox");
    }

    #[test]
    fn revert_detects_conflicting_edits() {
        let dir = temp_dir("organize-conflict");
        let mut store = Store::open(dir).expect("store");
        let item_id = seed_item(&mut store, "无语熊猫");
        let proposal = create_proposal(
            &mut store,
            "rules",
            "测试冲突",
            vec![DraftEntry {
                item_id: item_id.clone(),
                action: Action {
                    category_id: Some("cat_speechless".to_string()),
                    ..Action::default()
                },
                reason: "测试".to_string(),
                confidence: 0.6,
                source: "rules".to_string(),
            }],
            serde_json::json!({}),
        )
        .expect("proposal");
        let result = apply_proposal(&mut store, &proposal.id, None).expect("apply");
        {
            let item = store.library.items.iter_mut().find(|row| row.id == item_id).unwrap();
            item.name = "整理后又改了名字".to_string();
        }
        let before = snapshot(store.library.items.iter().find(|row| row.id == item_id).unwrap());
        let error = revert(&mut store, &result.history_id, false).unwrap_err();
        assert_eq!(error.code, "conflict");
        assert_eq!(error.conflicts, vec![item_id.clone()]);
        // 强制撤回仍然成功
        revert(&mut store, &result.history_id, true).expect("force revert");
        let item = store.library.items.iter().find(|row| row.id == item_id).unwrap();
        assert_eq!(item.category_id, None);
        assert_ne!(snapshot(item), before);
    }

    #[test]
    fn proposal_entry_category_can_be_overridden_or_cleared() {
        let dir = temp_dir("organize-override");
        let mut store = Store::open(dir).expect("store");
        let item_id = seed_item(&mut store, "测试表情");
        let proposal = create_proposal(
            &mut store,
            "rules",
            "测试覆盖",
            vec![DraftEntry {
                item_id,
                action: Action {
                    new_category_name: "规则 分类".to_string(),
                    ..Action::default()
                },
                reason: "测试".to_string(),
                confidence: 0.9,
                source: "rules".to_string(),
            }],
            serde_json::json!({}),
        )
        .expect("proposal");
        let entry_id = proposal.entries[0].id.clone();
        let updated = update_proposal_entries(
            &mut store,
            &proposal.id,
            vec![EntryPatch {
                id: entry_id.clone(),
                skipped: None,
                action: Some(EntryActionPatch {
                    category_id: Some("cat_work".to_string()),
                    ..EntryActionPatch::default()
                }),
            }],
        )
        .expect("override");
        assert_eq!(updated.entries[0].action.category_id.as_deref(), Some("cat_work"));
        assert!(updated.entries[0].action.new_category_name.is_empty());

        let cleared = update_proposal_entries(
            &mut store,
            &proposal.id,
            vec![EntryPatch {
                id: entry_id,
                skipped: None,
                action: Some(EntryActionPatch {
                    category_id: Some(String::new()),
                    ..EntryActionPatch::default()
                }),
            }],
        )
        .expect("clear");
        assert!(cleared.entries[0].action.category_id.is_none());
        assert!(cleared.entries[0].action.new_category_name.is_empty());
    }

    #[test]
    fn category_delete_restores_on_revert() {
        let dir = temp_dir("organize-category");
        let mut store = Store::open(dir).expect("store");
        let item_id = seed_item(&mut store, "工作狗");
        store.library.categories.push(Category {
            id: "cat_test".to_string(),
            name: "测试分类".to_string(),
            color: "#abcdef".to_string(),
            order: 99,
            created_at: now_ms(),
        });
        let before = {
            let item = store.library.items.iter_mut().find(|row| row.id == item_id).unwrap();
            item.category_id = Some("cat_test".to_string());
            item.status = "sorted".to_string();
            snapshot(item)
        };
        store.library.categories.retain(|category| category.id != "cat_test");
        let after = {
            let item = store.library.items.iter_mut().find(|row| row.id == item_id).unwrap();
            item.category_id = None;
            item.status = "inbox".to_string();
            snapshot(item)
        };
        let entry = store.log(
            "catalog.deleteCategory",
            "user",
            "删除分类".to_string(),
            true,
            vec![crate::models::Change {
                item_id: item_id.clone(),
                before: Some(before),
                after: Some(after),
            }],
            serde_json::json!({ "record": { "id": "cat_test", "name": "测试分类", "color": "#abcdef", "order": 99, "createdAt": now_ms() } }),
        );
        store.persist_library().unwrap();
        revert(&mut store, &entry.id, false).expect("revert category");
        assert!(store.library.categories.iter().any(|category| category.id == "cat_test"));
        let item = store.library.items.iter().find(|row| row.id == item_id).unwrap();
        assert_eq!(item.category_id.as_deref(), Some("cat_test"));
    }
}

pub fn dismiss_proposal(store: &mut Store, proposal_id: &str) -> Result<Proposal, AppError> {
    let proposal = store
        .library
        .proposals
        .iter_mut()
        .find(|proposal| proposal.id == proposal_id)
        .ok_or_else(|| AppError::new("not_found", "找不到这条整理提案"))?;
    match proposal.status.as_str() {
        "applied" => return Err(AppError::new("invalid_status", "已经应用的提案不能忽略，请使用撤回")),
        "reverted" => return Err(AppError::new("invalid_status", "这条提案已被撤回")),
        "dismissed" => {}
        _ => {
            proposal.status = "dismissed".to_string();
            proposal.dismissed_at = Some(now_ms());
        }
    }
    let result = proposal.clone();
    store.persist_library()?;
    Ok(result)
}
