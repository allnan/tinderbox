use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use crate::models::*;
use crate::util::*;

pub struct Store {
    pub data_dir: PathBuf,
    pub images_dir: PathBuf,
    pub thumbs_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub library: Library,
    pub settings: Settings,
    pub history: Vec<HistoryEntry>,
}

pub struct AppState {
    pub store: Mutex<Store>,
}

pub fn lock_store(state: &AppState) -> Result<MutexGuard<'_, Store>, AppError> {
    state
        .store
        .lock()
        .map_err(|_| AppError::new("lock", "数据状态异常，请重启应用"))
}

impl Store {
    pub fn open(data_dir: PathBuf) -> Result<Self, AppError> {
        let images_dir = data_dir.join("images");
        let thumbs_dir = data_dir.join("thumbs");
        let backups_dir = data_dir.join("backups");
        for dir in [&data_dir, &images_dir, &thumbs_dir, &backups_dir] {
            fs::create_dir_all(dir)?;
        }
        let mut library = load_library(&data_dir)?;
        library.normalize();
        let mut settings: Settings = read_json_or_default(&data_dir.join("settings.json"));
        settings.normalize();
        let mut history: Vec<HistoryEntry> = read_json_or_default(&data_dir.join("history.json"));
        if history.len() > 5000 {
            let skip = history.len() - 5000;
            history.drain(..skip);
        }
        let store = Self {
            data_dir,
            images_dir,
            thumbs_dir,
            backups_dir,
            library,
            settings,
            history,
        };
        store.persist_library()?;
        store.persist_settings()?;
        Ok(store)
    }

    pub fn persist_library(&self) -> Result<(), AppError> {
        let file = self.data_dir.join("library.json");
        if file.exists() {
            let _ = fs::copy(&file, self.data_dir.join("library.json.bak"));
        }
        write_json_atomic(&file, &self.library)
    }

    pub fn persist_settings(&self) -> Result<(), AppError> {
        write_json_atomic(&self.data_dir.join("settings.json"), &self.settings)
    }

    pub fn persist_history(&self) -> Result<(), AppError> {
        write_json_atomic(&self.data_dir.join("history.json"), &self.history)
    }

    pub fn image_path(&self, item: &Sticker) -> PathBuf {
        self.images_dir
            .join(format!("{}.{}", item.sha256, item.ext))
    }

    pub fn thumb_path(&self, sha256: &str) -> PathBuf {
        self.thumbs_dir.join(sha256)
    }

    pub fn state_view(&self) -> StateView {
        StateView {
            categories: self.library.categories.clone(),
            groups: self.library.groups.clone(),
            items: self.library.items.clone(),
            proposals: self.library.proposals.clone(),
            settings: SettingsView::from(&self.settings),
            meta: self.library.meta.clone(),
            history_count: self.history.len(),
        }
    }

    pub fn visible_item(&self, id: &str) -> Option<&Sticker> {
        self.library
            .items
            .iter()
            .find(|item| item.id == id && !item.deleted)
    }

    pub fn category_by_name(&self, name: &str) -> Option<&Category> {
        let needle = name.trim().to_lowercase();
        self.library
            .categories
            .iter()
            .find(|category| category.name.to_lowercase() == needle)
    }

    pub fn group_by_name(&self, name: &str) -> Option<&Group> {
        let needle = name.trim().to_lowercase();
        self.library
            .groups
            .iter()
            .find(|group| group.name.to_lowercase() == needle)
    }

    pub fn log(
        &mut self,
        kind: &str,
        actor: &str,
        summary: String,
        undoable: bool,
        changes: Vec<Change>,
        meta: Value,
    ) -> HistoryEntry {
        let entry = HistoryEntry {
            id: new_id("hist"),
            at: now_ms(),
            kind: kind.to_string(),
            actor: actor.to_string(),
            summary,
            undoable,
            undone_at: None,
            changes,
            meta,
        };
        self.history.push(entry.clone());
        if self.history.len() > 5000 {
            let skip = self.history.len() - 5000;
            self.history.drain(..skip);
        }
        let _ = self.persist_history();
        entry
    }

    pub fn save_image(&self, sha: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
        let file = self.images_dir.join(format!("{}.{}", sha, ext));
        if !file.exists() {
            write_bytes_atomic(&file, bytes)?;
        }
        Ok(file)
    }

    pub fn save_thumb(&self, sha: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
        let file = self.thumb_path(sha);
        write_bytes_atomic(&file, bytes)?;
        Ok(file)
    }

    pub fn history_by_id(&self, id: &str) -> Option<&HistoryEntry> {
        self.history.iter().find(|entry| entry.id == id)
    }

}

/// 读取素材库；损坏时尝试用上一次写入的 .bak 自动恢复，并保留损坏文件供排查。
fn load_library(data_dir: &Path) -> Result<Library, AppError> {
    let file = data_dir.join("library.json");
    if !file.exists() {
        return Ok(Library::default());
    }
    let bytes = fs::read(&file)?;
    match serde_json::from_slice::<Library>(&bytes) {
        Ok(library) => Ok(library),
        Err(primary) => {
            let backup = data_dir.join("library.json.bak");
            if backup.exists() {
                if let Ok(mut library) = serde_json::from_slice::<Library>(&fs::read(&backup)?) {
                    let corrupt = data_dir.join(format!("library.corrupt-{}.json", now_ms()));
                    let _ = fs::copy(&file, &corrupt);
                    library.normalize();
                    write_json_atomic(&file, &library)?;
                    return Ok(library);
                }
            }
            Err(AppError::new(
                "library_corrupt",
                format!(
                    "素材库文件 library.json 已损坏，无法启动：{}。原文件已保留，可尝试用 library.json.bak 恢复。",
                    primary
                ),
            ))
        }
    }
}

impl Library {
    pub fn normalize(&mut self) {
        if self.categories.is_empty() {
            self.categories = default_categories();
        }
        self.categories.retain(|category| !category.id.is_empty() && !category.name.is_empty());
        for (index, category) in self.categories.iter_mut().enumerate() {
            category.name = clean_text(&category.name, 24);
            if category.created_at == 0 {
                category.created_at = now_ms();
            }
            category.order = index as i64;
        }
        self.groups.retain(|group| !group.id.is_empty() && !group.name.is_empty());
        for (index, group) in self.groups.iter_mut().enumerate() {
            group.name = clean_text(&group.name, 24);
            group.note = clean_text(&group.note, 120);
            if group.created_at == 0 {
                group.created_at = now_ms();
            }
            group.order = index as i64;
        }
        let category_ids: Vec<String> = self.categories.iter().map(|c| c.id.clone()).collect();
        let group_ids: Vec<String> = self.groups.iter().map(|g| g.id.clone()).collect();
        self.items.retain(|item| !item.id.is_empty() && item.sha256.len() == 64);
        for item in self.items.iter_mut() {
            if item.status != "sorted" {
                item.status = "inbox".to_string();
            }
            if item.deleted {
                item.status = "inbox".to_string();
            }
            if let Some(category_id) = &item.category_id {
                if !category_ids.contains(category_id) {
                    item.category_id = None;
                }
            }
            item.group_ids.retain(|id| group_ids.contains(id));
            item.group_ids.sort();
            item.group_ids.dedup();
            item.tags = unique_strings(&item.tags, 24, 24);
            item.tags.sort();
            item.name = clean_text(&item.name, 60);
            if item.name.is_empty() {
                item.name = "未命名表情".to_string();
            }
            if item.mime.is_empty() {
                item.mime = mime_for_ext(&item.ext).to_string();
            }
        }
        if self.proposals.len() > 120 {
            self.proposals.truncate(120);
        }
        for proposal in self.proposals.iter_mut() {
            for entry in proposal.entries.iter_mut() {
                entry.confidence = entry.confidence.clamp(0.0, 1.0);
            }
        }
    }
}

impl Settings {
    pub fn normalize(&mut self) {
        if self.ai.base_url.trim().is_empty() {
            self.ai.base_url = "https://api.openai.com/v1".to_string();
        }
        self.ai.base_url = self.ai.base_url.trim_end_matches('/').to_string();
        if self.ai.model.trim().is_empty() {
            self.ai.model = "gpt-4o-mini".to_string();
        }
        self.ai.batch_size = self.ai.batch_size.clamp(1, 24);
        self.ai.timeout_ms = self.ai.timeout_ms.clamp(10_000, 300_000);
        if !["image", "file"].contains(&self.copy_mode.as_str()) {
            self.copy_mode = "image".to_string();
        }
        self.card_size = self.card_size.clamp(96, 260);
    }
}

pub fn ensure_category(store: &mut Store, name: &str) -> Option<String> {
    let clean = clean_text(name, 24);
    if clean.is_empty() {
        return None;
    }
    if let Some(existing) = store.category_by_name(&clean) {
        return Some(existing.id.clone());
    }
    let category = Category {
        id: new_id("cat"),
        name: clean.clone(),
        color: color_for_name(&clean),
        order: store.library.categories.len() as i64,
        created_at: now_ms(),
    };
    let id = category.id.clone();
    store.library.categories.push(category);
    Some(id)
}

pub fn ensure_group(store: &mut Store, name: &str) -> Option<String> {
    let clean = clean_text(name, 24);
    if clean.is_empty() {
        return None;
    }
    if let Some(existing) = store.group_by_name(&clean) {
        return Some(existing.id.clone());
    }
    let group = Group {
        id: new_id("grp"),
        name: clean.clone(),
        color: color_for_name(&clean),
        note: String::new(),
        order: store.library.groups.len() as i64,
        created_at: now_ms(),
    };
    let id = group.id.clone();
    store.library.groups.push(group);
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_corrupt_library_from_backup() {
        let source_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("store-source-{}", std::process::id()));
        let target_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("store-target-{}", std::process::id()));
        let _ = fs::remove_dir_all(&source_dir);
        let _ = fs::remove_dir_all(&target_dir);
        let source = Store::open(source_dir.clone()).expect("source store");
        let valid = fs::read(source_dir.join("library.json")).unwrap();
        drop(source);

        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("library.json"), b"{ this is broken").unwrap();
        fs::write(target_dir.join("library.json.bak"), valid).unwrap();
        let recovered = Store::open(target_dir.clone()).expect("should recover from bak");
        assert_eq!(recovered.library.categories.len(), 8);
        assert!(fs::read_dir(&target_dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("library.corrupt-")));

        let broken_dir = target_dir.join("broken");
        fs::create_dir_all(&broken_dir).unwrap();
        fs::write(broken_dir.join("library.json"), b"not json").unwrap();
        assert!(Store::open(broken_dir).is_err());
    }

    #[test]
    fn opens_and_persists_in_workspace() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.tmp/store-test");
        let _ = fs::remove_dir_all(&dir);
        let store = Store::open(dir.clone()).expect("store should open");
        assert!(dir.join("library.json").is_file());
        assert!(dir.join("settings.json").is_file());
        assert_eq!(store.library.categories.len(), 8);
        let _ = fs::remove_dir_all(&dir);
    }
}
