use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::history::snapshot;
use crate::models::*;
use crate::store::Store;
use crate::util::{
    clean_text, format_timestamp, human_bytes, mime_for_ext, new_id, normalize_color, now_ms,
    safe_ext, sha256_hex, write_bytes_atomic,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub bytes: u64,
    pub created_at: i64,
    pub items: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub duplicates: usize,
    pub missing_files: usize,
    pub categories_added: usize,
    pub groups_added: usize,
    pub history_archived: Option<String>,
    pub history_entry_id: Option<String>,
}

fn add_entry(
    zip: &mut ZipWriter<File>,
    name: &str,
    data: &[u8],
    method: CompressionMethod,
) -> Result<(), AppError> {
    let options = SimpleFileOptions::default()
        .compression_method(method)
        .unix_permissions(0o644);
    zip.start_file(name, options)
        .map_err(|error| AppError::new("zip", format!("写入备份失败：{}", error)))?;
    zip.write_all(data)?;
    Ok(())
}

pub fn export_backup(store: &mut Store) -> Result<BackupInfo, AppError> {
    fs::create_dir_all(&store.backups_dir)?;
    let file_name = format!("meme-vault-{}.zip", format_timestamp(now_ms()));
    let final_path = store.backups_dir.join(&file_name);
    let tmp_path = store.backups_dir.join(format!("{}.part", file_name));

    let mut export_library = store.library.clone();
    export_library.items.retain(|item| !item.deleted);
    export_library.proposals.clear();
    let items: Vec<Sticker> = export_library.items.clone();

    let mut library_value = serde_json::to_value(&export_library)?;
    if let Value::Object(map) = &mut library_value {
        map.insert("app".to_string(), json!("meme-vault"));
        map.insert("exportedAt".to_string(), json!(now_ms()));
    }
    let manifest = json!({
        "app": "meme-vault",
        "format": 1,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "createdAt": now_ms(),
        "items": items.len(),
        "note": "表情包仓库备份：library.json 为元数据，images/ 为原图，thumbs/ 为缩略图。"
    });
    let settings_value = json!({
        "copyMode": store.settings.copy_mode,
        "cardSize": store.settings.card_size,
        "autoBackup": store.settings.auto_backup,
        "ai": {
            "baseUrl": store.settings.ai.base_url,
            "model": store.settings.ai.model,
            "vision": store.settings.ai.vision,
            "batchSize": store.settings.ai.batch_size,
            "apiKey": if store.settings.ai.api_key.is_empty() { "" } else { "[REDACTED_SECRET]" }
        }
    });

    let file = File::create(&tmp_path)?;
    let mut zip = ZipWriter::new(file);
    add_entry(&mut zip, "manifest.json", serde_json::to_vec_pretty(&manifest)?.as_slice(), CompressionMethod::Deflated)?;
    add_entry(&mut zip, "library.json", serde_json::to_vec_pretty(&library_value)?.as_slice(), CompressionMethod::Deflated)?;
    add_entry(&mut zip, "settings.json", serde_json::to_vec_pretty(&settings_value)?.as_slice(), CompressionMethod::Deflated)?;
    let history_bytes = serde_json::to_vec_pretty(&store.history)?;
    add_entry(&mut zip, "history.json", &history_bytes, CompressionMethod::Deflated)?;

    for item in items.iter() {
        let image_path = store.image_path(item);
        if let Ok(bytes) = fs::read(&image_path) {
            add_entry(
                &mut zip,
                &format!("images/{}.{}", item.sha256, item.ext),
                &bytes,
                CompressionMethod::Stored,
            )?;
        }
        let thumb_path = store.thumb_path(&item.sha256);
        if let Ok(bytes) = fs::read(&thumb_path) {
            add_entry(
                &mut zip,
                &format!("thumbs/{}", item.sha256),
                &bytes,
                CompressionMethod::Stored,
            )?;
        }
    }
    zip.finish()
        .map_err(|error| AppError::new("zip", format!("完成备份失败：{}", error)))?;
    fs::rename(&tmp_path, &final_path)?;

    let bytes = fs::metadata(&final_path)?.len();
    store.library.meta.last_backup_at = now_ms();
    store.log(
        "backup.export",
        "user",
        format!(
            "导出备份 {}（{} 张，约 {}）",
            file_name,
            items.len(),
            human_bytes(bytes)
        ),
        false,
        Vec::new(),
        json!({ "fileName": file_name, "bytes": bytes, "items": items.len() }),
    );
    store.persist_library()?;
    Ok(BackupInfo {
        file_name,
        bytes,
        created_at: now_ms(),
        items: items.len(),
    })
}

fn read_zip_entries(path: &Path, wanted: &HashSet<String>) -> Result<HashMap<String, Vec<u8>>, AppError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::new("zip", format!("无法读取备份包：{}", error)))?;
    let mut out = HashMap::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::new("zip", format!("读取备份条目失败：{}", error)))?;
        let name = entry.name().to_string();
        if !wanted.contains(&name) {
            continue;
        }
        if entry.size() > 512 * 1024 * 1024 {
            return Err(AppError::new("zip", "备份包中的单个文件过大"));
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        out.insert(name, bytes);
    }
    Ok(out)
}

pub fn import_backup(store: &mut Store, path: &Path) -> Result<ImportReport, AppError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::new("zip", format!("无法解压备份包：{}", error)))?;
    let mut manifest: Option<Value> = None;
    let mut library: Option<Library> = None;
    let mut history_bytes: Option<Vec<u8>> = None;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::new("zip", format!("读取备份条目失败：{}", error)))?;
        let name = entry.name().to_string();
        match name.as_str() {
            "manifest.json" | "library.json" | "history.json" => {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes)?;
                match name.as_str() {
                    "manifest.json" => {
                        manifest = serde_json::from_slice(&bytes).ok();
                    }
                    "library.json" => {
                        library = serde_json::from_slice(&bytes).ok();
                    }
                    _ => history_bytes = Some(bytes),
                }
            }
            _ => {}
        }
    }
    let manifest = manifest.ok_or_else(|| AppError::new("backup_invalid", "备份包缺少 manifest.json"))?;
    if manifest.get("app").and_then(Value::as_str) != Some("meme-vault") {
        return Err(AppError::new("backup_invalid", "这不是表情包仓库导出的备份包"));
    }
    let library = library.ok_or_else(|| AppError::new("backup_invalid", "备份包缺少 library.json"))?;
    if library.items.is_empty() {
        return Err(AppError::new("backup_empty", "这个备份包里没有素材"));
    }

    let local_shas: HashSet<String> = store
        .library
        .items
        .iter()
        .map(|item| item.sha256.clone())
        .collect();
    let mut wanted: HashSet<String> = HashSet::new();
    for item in library.items.iter() {
        if item.deleted || local_shas.contains(&item.sha256) {
            continue;
        }
        let ext = safe_ext(&item.ext).unwrap_or("png");
        wanted.insert(format!("images/{}.{}", item.sha256, ext));
        wanted.insert(format!("thumbs/{}", item.sha256));
    }
    let files = read_zip_entries(path, &wanted)?;

    let mut report = ImportReport::default();
    let mut changes: Vec<Change> = Vec::new();
    let category_before = store.library.categories.len();
    let group_before = store.library.groups.len();

    for source in library.items.iter() {
        if source.deleted {
            continue;
        }
        if source.sha256.len() != 64 || !source.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            report.missing_files += 1;
            continue;
        }
        if store.library.items.iter().any(|item| item.sha256 == source.sha256) {
            report.duplicates += 1;
            continue;
        }
        let ext = safe_ext(&source.ext).unwrap_or("png");
        let image_key = format!("images/{}.{}", source.sha256, ext);
        let Some(image_bytes) = files.get(&image_key) else {
            report.missing_files += 1;
            continue;
        };
        if sha256_hex(image_bytes) != source.sha256 {
            report.missing_files += 1;
            continue;
        }
        write_bytes_atomic(&store.images_dir.join(format!("{}.{}", source.sha256, ext)), image_bytes)?;
        let thumb_key = format!("thumbs/{}", source.sha256);
        let thumb_mime = if let Some(thumb) = files.get(&thumb_key) {
            write_bytes_atomic(&store.thumb_path(&source.sha256), thumb)?;
            if source.thumb_mime.is_empty() {
                "image/webp".to_string()
            } else {
                source.thumb_mime.clone()
            }
        } else {
            String::new()
        };

        let category_id = source
            .category_id
            .as_ref()
            .and_then(|id| library.categories.iter().find(|category| &category.id == id))
            .and_then(|category| ensure_category_named(store, &category.name, &category.color));
        let mut group_ids: Vec<String> = Vec::new();
        for group_id in source.group_ids.iter() {
            if let Some(group) = library.groups.iter().find(|group| &group.id == group_id) {
                if let Some(created) = ensure_group_named(store, &group.name, &group.color) {
                    if !group_ids.contains(&created) {
                        group_ids.push(created);
                    }
                }
            }
        }

        let mut item = Sticker {
            id: new_id("item"),
            sha256: source.sha256.clone(),
            ext: ext.to_string(),
            mime: mime_for_ext(ext).to_string(),
            thumb_mime,
            width: source.width,
            height: source.height,
            bytes: image_bytes.len() as u64,
            phash: source.phash.clone(),
            name: clean_text(&source.name, 60),
            note: source.note.clone(),
            category_id,
            group_ids,
            tags: source.tags.clone(),
            favorite: source.favorite,
            status: if source.status == "sorted" { "sorted".to_string() } else { "inbox".to_string() },
            deleted: false,
            deleted_at: None,
            imported_at: if source.imported_at > 0 { source.imported_at } else { now_ms() },
            created_at: if source.created_at > 0 { source.created_at } else { now_ms() },
            usage_count: source.usage_count,
            last_used_at: source.last_used_at,
            origin: "backup".to_string(),
            ai_note: source.ai_note.clone(),
        };
        if item.name.is_empty() {
            item.name = "恢复的表情".to_string();
        }
        if !item.group_ids.is_empty() || item.category_id.is_some() {
            item.status = "sorted".to_string();
        }
        store.library.items.push(item.clone());
        changes.push(Change {
            item_id: item.id.clone(),
            before: None,
            after: Some(snapshot(&item)),
        });
        report.added += 1;
    }
    report.categories_added = store.library.categories.len() - category_before;
    report.groups_added = store.library.groups.len() - group_before;
    store.library.meta.last_import_at = now_ms();

    if let Some(bytes) = history_bytes {
        let archive_path = store
            .backups_dir
            .join(format!("imported-history-{}.json", format_timestamp(now_ms())));
        fs::write(&archive_path, bytes)?;
        report.history_archived = archive_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_string());
    }

    if !changes.is_empty() {
        let entry = store.log(
            "backup.import",
            "user",
            format!(
                "从备份恢复 {} 张表情包（跳过重复 {} 张）",
                changes.len(),
                report.duplicates
            ),
            true,
            changes,
            json!({ "added": report.added, "duplicates": report.duplicates }),
        );
        report.history_entry_id = Some(entry.id);
    }
    store.persist_library()?;
    Ok(report)
}

fn ensure_category_named(store: &mut Store, name: &str, color: &str) -> Option<String> {
    let clean = clean_text(name, 24);
    if clean.is_empty() {
        return None;
    }
    if let Some(existing) = store.category_by_name(&clean) {
        return Some(existing.id.clone());
    }
    let category = Category {
        id: new_id("cat"),
        name: clean,
        color: normalize_color(color),
        order: store.library.categories.len() as i64,
        created_at: now_ms(),
    };
    let id = category.id.clone();
    store.library.categories.push(category);
    Some(id)
}

fn ensure_group_named(store: &mut Store, name: &str, color: &str) -> Option<String> {
    let clean = clean_text(name, 24);
    if clean.is_empty() {
        return None;
    }
    if let Some(existing) = store.group_by_name(&clean) {
        return Some(existing.id.clone());
    }
    let group = Group {
        id: new_id("grp"),
        name: clean,
        color: normalize_color(color),
        note: String::new(),
        order: store.library.groups.len() as i64,
        created_at: now_ms(),
    };
    let id = group.id.clone();
    store.library.groups.push(group);
    Some(id)
}

pub fn list_backups(store: &Store) -> Result<Vec<BackupInfo>, AppError> {
    let mut rows: Vec<BackupInfo> = Vec::new();
    for entry in fs::read_dir(&store.backups_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_backup_name(&name) {
            continue;
        }
        let metadata = entry.metadata()?;
        rows.push(BackupInfo {
            file_name: name,
            bytes: metadata.len(),
            created_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
            items: 0,
        });
    }
    rows.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(rows)
}

fn is_backup_name(name: &str) -> bool {
    name.starts_with("meme-vault-")
        && name.ends_with(".zip")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn backup_path(store: &Store, file_name: &str) -> Result<PathBuf, AppError> {
    if !is_backup_name(file_name) {
        return Err(AppError::new("invalid_name", "备份文件名不合法"));
    }
    Ok(store.backups_dir.join(file_name))
}

pub fn delete_backup(store: &mut Store, file_name: &str) -> Result<(), AppError> {
    let path = backup_path(store, file_name)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    store.log(
        "backup.delete",
        "user",
        format!("删除备份 {}", file_name),
        false,
        Vec::new(),
        Value::Null,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Sticker;
    use base64::Engine as _;

    #[test]
    fn backup_roundtrip_restores_items() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("backup-src-{}", std::process::id()));
        let target_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("backup-dst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&target_root);
        let mut store = Store::open(root).expect("source store");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            .unwrap();
        let sha = crate::util::sha256_hex(&bytes);
        store.save_image(&sha, "png", &bytes).unwrap();
        store.save_thumb(&sha, &bytes).unwrap();
        store.library.items.push(Sticker {
            id: crate::util::new_id("item"),
            sha256: sha.clone(),
            ext: "png".to_string(),
            mime: "image/png".to_string(),
            thumb_mime: "image/png".to_string(),
            name: "测试表情".to_string(),
            bytes: bytes.len() as u64,
            status: "sorted".to_string(),
            category_id: Some("cat_happy".to_string()),
            tags: vec!["笑".to_string()],
            imported_at: crate::util::now_ms(),
            created_at: crate::util::now_ms(),
            ..Sticker::default()
        });
        store.persist_library().unwrap();

        let info = export_backup(&mut store).expect("export");
        let path = store.backups_dir.join(&info.file_name);
        assert!(path.is_file());
        assert!(info.bytes > 0);

        let mut target = Store::open(target_root).expect("target store");
        let report = import_backup(&mut target, &path).expect("import");
        assert_eq!(report.added, 1);
        assert_eq!(report.missing_files, 0);
        assert!(target.library.items.iter().any(|item| item.sha256 == sha));
        let imported = target.library.items.iter().find(|item| item.sha256 == sha).unwrap();
        assert_eq!(imported.name, "测试表情");
        assert_eq!(imported.tags, vec!["笑".to_string()]);
        assert!(target.library.categories.iter().any(|category| category.id == "cat_happy"));
    }
}

pub fn maybe_auto_backup(store: &mut Store) -> Result<Option<BackupInfo>, AppError> {
    if !store.settings.auto_backup {
        return Ok(None);
    }
    if !store.library.items.iter().any(|item| !item.deleted) {
        return Ok(None);
    }
    let last = store.library.meta.last_backup_at;
    if now_ms() - last < 24 * 60 * 60 * 1000 {
        return Ok(None);
    }
    let backups = list_backups(store)?;
    if backups.len() >= 10 {
        if let Some(oldest) = backups.last() {
            let path = store.backups_dir.join(&oldest.file_name);
            let _ = fs::remove_file(path);
        }
    }
    export_backup(store).map(Some)
}
