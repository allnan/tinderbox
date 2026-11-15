// 历史记录：<exe>/userdata/history.json，以推文 id 为主键分组；字段与前端 HistoryEntry 一致。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::model::{
    GifResult, HistoryEntry, HistoryMedia, MediaProbe, SavedMedia, TweetInfo, TweetMedia,
};
use crate::paths::{self, iso_now};

#[derive(Serialize, Deserialize, Default)]
struct Store {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, HistoryEntry>,
}

static MEMORY: OnceLock<Mutex<Option<Store>>> = OnceLock::new();

fn memory() -> &'static Mutex<Option<Store>> {
    MEMORY.get_or_init(|| Mutex::new(None))
}

fn history_path() -> std::path::PathBuf {
    paths::data_dir().join("history.json")
}

fn load_store() -> Store {
    let mut guard = memory().lock().unwrap();
    if let Some(store) = guard.as_ref() {
        return clone_store(store);
    }
    let store = std::fs::read_to_string(history_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Store>(&text).ok())
        .map(sanitize)
        .unwrap_or_default();
    *guard = Some(clone_store(&store));
    store
}

fn clone_store(store: &Store) -> Store {
    Store {
        version: store.version,
        entries: store.entries.clone(),
    }
}

fn sanitize(mut store: Store) -> Store {
    store.version = 1;
    store.entries.retain(|id, entry| {
        entry.id = id.clone();
        !entry.id.is_empty()
    });
    store
}

fn persist(store: &Store) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    let path = history_path();
    if let Ok(old) = std::fs::read_to_string(&path) {
        let _ = std::fs::write(path.with_extension("json.bak"), old);
    }
    paths::atomic_write(&path, text.as_bytes())
}

fn with_store<T>(mutate: impl FnOnce(&mut Store) -> T, write: bool) -> Result<T, String> {
    let mut guard = memory().lock().unwrap();
    if guard.is_none() {
        drop(guard);
        let store = load_store();
        guard = memory().lock().unwrap();
        if guard.is_none() {
            *guard = Some(store);
        }
    }
    let store = guard.as_mut().expect("history store initialized");
    let result = mutate(store);
    if write {
        persist(store)?;
    }
    Ok(result)
}

pub fn list() -> Vec<HistoryEntry> {
    with_store(
        |store| {
            let mut entries: Vec<HistoryEntry> = store.entries.values().cloned().collect();
            entries.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
            entries
        },
        false,
    )
    .unwrap_or_default()
}

pub fn get(tweet_id: &str) -> Option<HistoryEntry> {
    if tweet_id.is_empty() {
        return None;
    }
    with_store(
        |store| {
            let entry = store.entries.get_mut(tweet_id)?;
            entry.last_opened_at = iso_now();
            Some(entry.clone())
        },
        true,
    )
    .ok()
    .flatten()
}

pub fn find_saved(tweet_id: &str, media_id: &str, format: Option<&str>) -> Option<SavedMedia> {
    let store = load_store();
    let entry = store.entries.get(tweet_id)?;
    entry
        .saved_media
        .iter()
        .find(|item| {
            item.media_id == media_id && format.map(|value| item.format == value).unwrap_or(true)
        })
        .cloned()
}

fn ensure_entry(store: &mut Store, tweet: &TweetInfo) -> HistoryEntry {
    let now = iso_now();
    store
        .entries
        .entry(tweet.id.clone())
        .or_insert_with(|| HistoryEntry {
            id: tweet.id.clone(),
            tweet_url: tweet.url.clone(),
            author: tweet.author.clone(),
            text: tweet.text.clone(),
            tweet_created_at: tweet.created_at.clone(),
            fetched_at: now.clone(),
            last_opened_at: now,
            media: Vec::new(),
            saved_media: Vec::new(),
            results: Vec::new(),
        })
        .clone()
}

fn update_tweet_fields(entry: &mut HistoryEntry, tweet: &TweetInfo) {
    entry.tweet_url = tweet.url.clone();
    entry.author = tweet.author.clone();
    entry.text = tweet.text.clone();
    entry.tweet_created_at = tweet.created_at.clone();
    entry.last_opened_at = iso_now();
}

pub fn record_saved(
    tweet: &TweetInfo,
    media: &TweetMedia,
    saved: &SavedMedia,
    probe: Option<&MediaProbe>,
) -> Result<(), String> {
    with_store(
        |store| {
            let mut entry = ensure_entry(store, tweet);
            update_tweet_fields(&mut entry, tweet);
            let record = HistoryMedia {
                id: media.id.clone(),
                kind: media.kind.clone(),
                source_url: media.source_url.clone(),
                thumbnail_url: media.thumbnail_url.clone(),
                local_path: Some(saved.file_path.clone()),
                probe: probe.cloned(),
            };
            if let Some(existing) = entry.media.iter_mut().find(|item| item.id == media.id) {
                *existing = record;
            } else {
                entry.media.push(record);
            }
            if let Some(existing) = entry.saved_media.iter_mut().find(|item| item.id == saved.id) {
                *existing = saved.clone();
            } else {
                entry.saved_media.insert(0, saved.clone());
            }
            store.entries.insert(tweet.id.clone(), entry);
        },
        true,
    )
}

pub fn record_result(
    tweet: &TweetInfo,
    media: &TweetMedia,
    probe: &MediaProbe,
    result: &GifResult,
) -> Result<(), String> {
    with_store(
        |store| {
            let mut entry = ensure_entry(store, tweet);
            update_tweet_fields(&mut entry, tweet);
            let record = HistoryMedia {
                id: media.id.clone(),
                kind: media.kind.clone(),
                source_url: media.source_url.clone(),
                thumbnail_url: media.thumbnail_url.clone(),
                local_path: None,
                probe: Some(probe.clone()),
            };
            if let Some(existing) = entry.media.iter_mut().find(|item| item.id == media.id) {
                existing.probe = Some(probe.clone());
                existing.thumbnail_url = media.thumbnail_url.clone();
                existing.source_url = media.source_url.clone();
            } else {
                entry.media.push(record);
            }
            if let Some(existing) = entry.results.iter_mut().find(|item| item.id == result.id) {
                *existing = result.clone();
            } else {
                entry.results.insert(0, result.clone());
            }
            entry.results.truncate(200);
            store.entries.insert(tweet.id.clone(), entry);
        },
        true,
    )
}

fn deletable(file: &str) -> bool {
    let lower = file.to_lowercase();
    [".mp4", ".m4a", ".jpg", ".jpeg", ".png", ".webp", ".gif"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

pub fn remove(tweet_id: &str, delete_files: bool) -> Result<(u64, u64), String> {
    let mut deleted = 0u64;
    let mut failed = 0u64;
    if delete_files {
        if let Some(entry) = get(tweet_id) {
            let mut files: Vec<String> = entry.saved_media.iter().map(|item| item.file_path.clone()).collect();
            files.extend(entry.results.iter().map(|item| item.gif_path.clone()));
            for file in files {
                if !std::path::Path::new(&file).is_absolute() || !deletable(&file) {
                    failed += 1;
                    continue;
                }
                match std::fs::remove_file(&file) {
                    Ok(_) => deleted += 1,
                    Err(_) => {
                        if std::path::Path::new(&file).exists() {
                            failed += 1;
                        }
                    }
                }
            }
        }
    }
    with_store(
        |store| {
            store.entries.remove(tweet_id);
        },
        true,
    )?;
    Ok((deleted, failed))
}

pub fn remove_result(tweet_id: &str, result_id: &str) -> Result<(), String> {
    with_store(
        |store| {
            if let Some(entry) = store.entries.get_mut(tweet_id) {
                if let Some(index) = entry.results.iter().position(|item| item.id == result_id) {
                    let removed = entry.results.remove(index);
                    let _ = std::fs::remove_file(removed.gif_path);
                }
            }
        },
        true,
    )
}

pub fn remove_saved(tweet_id: &str, saved_id: &str) -> Result<(), String> {
    with_store(
        |store| {
            if let Some(entry) = store.entries.get_mut(tweet_id) {
                if let Some(index) = entry.saved_media.iter().position(|item| item.id == saved_id) {
                    let removed = entry.saved_media.remove(index);
                    let _ = std::fs::remove_file(&removed.file_path);
                    for media in entry.media.iter_mut() {
                        if media.local_path.as_deref() == Some(removed.file_path.as_str()) {
                            media.local_path = None;
                        }
                    }
                }
            }
        },
        true,
    )
}

pub fn clear() -> Result<(), String> {
    with_store(
        |store| {
            store.entries.clear();
        },
        true,
    )
}

pub fn add_copy(gif_path: &str, copy_path: &str) {
    let _ = with_store(
        |store| {
            for entry in store.entries.values_mut() {
                for result in entry.results.iter_mut() {
                    if result.gif_path == gif_path {
                        if !result.copies.iter().any(|item| item == copy_path) {
                            result.copies.push(copy_path.to_string());
                        }
                    }
                }
            }
        },
        true,
    );
}
