// 媒体准备 / 保存 / 缩略图 / 图片识别。
#![allow(dead_code)]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::http::{build_client, download_to_file, fetch_bytes, MAX_DOWNLOAD_BYTES, MAX_IMAGE_BYTES};
use crate::jobs::JobCtx;
use crate::model::{AppSettings, MediaProbe, PreparedMedia, SaveMediaResult, SavedMedia, TweetMedia};
use crate::{history, paths, probe_mp4, settings, tools, tweet};

pub fn require_tweet(tweet_id: &str) -> Result<crate::model::TweetInfo, String> {
    tweet::get_cached(tweet_id).ok_or_else(|| "请先解析推文后再操作（推文信息已过期，请重新解析）".to_string())
}

fn cache_media_dir(settings: &AppSettings) -> PathBuf {
    paths::ensure_dir(settings::effective_cache_dir(settings).join("media"))
}

fn cache_thumbs_dir(settings: &AppSettings) -> PathBuf {
    paths::ensure_dir(settings::effective_cache_dir(settings).join("thumbs"))
}

pub fn media_index(tweet: &crate::model::TweetInfo, media_id: &str) -> usize {
    tweet
        .media
        .iter()
        .position(|item| item.id == media_id)
        .map(|index| index + 1)
        .unwrap_or(1)
}

pub fn build_save_file_name(
    screen_name: &str,
    tweet_id: &str,
    media_index: usize,
    width: Option<u32>,
    height: Option<u32>,
    ext: &str,
) -> String {
    let screen = paths::safe_name(screen_name, "x");
    let size = match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => format!("{width}x{height}"),
        _ => "media".into(),
    };
    format!("{screen}_{tweet_id}_{media_index}_{size}.{ext}")
}

async fn make_thumbnail(input: &Path, target: &Path) -> Option<PathBuf> {
    tools::resolve("ffmpeg")?;
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = target.with_extension("tmp.jpg");
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        "scale=w='min(640,iw)':h=-2:flags=lanczos".to_string(),
        "-q:v".to_string(),
        "3".to_string(),
        temporary.to_string_lossy().to_string(),
    ];
    let result = tools::run_tool(None, "ffmpeg", &args, None, |_| {}).await.ok()?;
    if result.code != 0 {
        let _ = std::fs::remove_file(&temporary);
        return None;
    }
    if paths::file_size(&temporary) == 0 {
        let _ = std::fs::remove_file(&temporary);
        return None;
    }
    let _ = std::fs::rename(&temporary, target);
    Some(target.to_path_buf())
}

pub async fn prepare(
    app_settings: &AppSettings,
    job: &JobCtx,
    _tweet_id: &str,
    media: &TweetMedia,
    force: bool,
) -> Result<PreparedMedia, String> {
    if media.kind == "photo" {
        return Err("图片不支持转换为 GIF，请选择 GIF 或视频".into());
    }
    if media.source_url.is_empty() {
        return Err("缺少要准备的媒体信息，请重新解析推文".into());
    }
    let media_dir = cache_media_dir(app_settings);
    let thumbs_dir = cache_thumbs_dir(app_settings);
    let media_id = paths::safe_name(&media.id, "media");
    let local_path = media_dir.join(format!("{media_id}.mp4"));
    let thumbnail_path = thumbs_dir.join(format!("{media_id}.jpg"));

    job.throw_if_cancelled()?;
    job.progress("download", 0.0, "正在检查本地缓存…");
    let mut cached = !force && paths::file_size(&local_path) > 16;
    let client = build_client(&app_settings.proxy)?;
    if !cached {
        job.progress("download", 2.0, "正在下载媒体…");
        let mut on_progress = |received: u64, total: u64| {
            let percent = if total > 0 {
                2.0 + (received as f64 / total as f64) * 38.0
            } else {
                20.0
            };
            job.progress("download", percent, &format!("正在下载媒体：{:.1} MB", received as f64 / 1024.0 / 1024.0));
        };
        download_to_file(
            &client,
            &media.source_url,
            &local_path,
            MAX_DOWNLOAD_BYTES,
            120,
            &mut on_progress,
        )
        .await
        .map_err(|error| {
            if error.contains("超时") {
                error
            } else {
                format!("网络连接失败，无法下载媒体：{error}")
            }
        })?;
        cached = false;
    } else {
        job.progress("download", 40.0, "使用已缓存的媒体文件");
    }

    job.progress("probe", 45.0, "正在解析媒体信息…");
    let mut probe = match probe_mp4::probe(&local_path.to_string_lossy()) {
        Ok(probe) => probe,
        Err(error) => {
            if cached {
                job.progress("download", 2.0, "缓存文件已损坏，正在重新下载…");
                let _ = std::fs::remove_file(&local_path);
                let mut on_progress = |received: u64, total: u64| {
                    let percent = if total > 0 {
                        2.0 + (received as f64 / total as f64) * 38.0
                    } else {
                        20.0
                    };
                    job.progress("download", percent, "正在重新下载媒体…");
                };
                download_to_file(
                    &client,
                    &media.source_url,
                    &local_path,
                    MAX_DOWNLOAD_BYTES,
                    120,
                    &mut on_progress,
                )
                .await?;
                job.progress("probe", 50.0, "正在解析媒体信息…");
                probe_mp4::probe(&local_path.to_string_lossy())?
            } else {
                return Err(error);
            }
        }
    };
    if probe.frame_count == 0 || probe.width == 0 || probe.height == 0 {
        return Err("媒体文件无法解析出有效视频帧，可能已损坏".into());
    }
    probe.path = local_path.to_string_lossy().to_string();
    job.progress(
        "probe",
        70.0,
        &format!("媒体信息解析完成：{}×{}，{} 帧", probe.width, probe.height, probe.frame_count),
    );
    job.throw_if_cancelled()?;
    job.progress("thumbnail", 72.0, "正在生成缩略图…");
    let generated = if !thumbnail_path.exists() || force {
        make_thumbnail(&local_path, &thumbnail_path).await
    } else {
        Some(thumbnail_path.clone())
    };
    job.progress("thumbnail", 100.0, "媒体准备完成");
    Ok(PreparedMedia {
        media_id,
        local_path: local_path.to_string_lossy().to_string(),
        thumbnail_path: generated.map(|path| path.to_string_lossy().to_string()),
        probe,
    })
}

// ---------------------------------------------------------------------------
// 图片格式与尺寸
// ---------------------------------------------------------------------------

pub fn detect_image_format(buffer: &[u8]) -> Option<&'static str> {
    if buffer.len() < 12 {
        return None;
    }
    if buffer[0] == 0xff && buffer[1] == 0xd8 && buffer[2] == 0xff {
        return Some("jpg");
    }
    if buffer.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if &buffer[0..4] == b"GIF8" {
        return Some("gif");
    }
    if &buffer[0..4] == b"RIFF" && &buffer[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

fn parse_jpeg_dimensions(buffer: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2usize;
    while offset + 4 <= buffer.len() {
        if buffer[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = buffer[offset + 1];
        if marker == 0xff {
            offset += 1;
            continue;
        }
        if marker == 0xd8 || marker == 0xd9 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            offset += 2;
            continue;
        }
        let length = ((buffer[offset + 2] as usize) << 8) | buffer[offset + 3] as usize;
        if length < 2 {
            return None;
        }
        let is_sof = (0xc0..=0xc3).contains(&marker)
            || (0xc5..=0xc7).contains(&marker)
            || (0xc9..=0xcb).contains(&marker)
            || (0xcd..=0xcf).contains(&marker);
        if is_sof {
            if offset + 9 > buffer.len() {
                return None;
            }
            let height = ((buffer[offset + 5] as u32) << 8) | buffer[offset + 6] as u32;
            let width = ((buffer[offset + 7] as u32) << 8) | buffer[offset + 8] as u32;
            return if width > 0 && height > 0 { Some((width, height)) } else { None };
        }
        offset += 2 + length;
    }
    None
}

pub fn parse_image_dimensions(buffer: &[u8], format: &str) -> (Option<u32>, Option<u32>) {
    match format {
        "jpg" => parse_jpeg_dimensions(buffer)
            .map(|(width, height)| (Some(width), Some(height)))
            .unwrap_or((None, None)),
        "png" => {
            if buffer.len() < 24 {
                return (None, None);
            }
            let width = u32::from_be_bytes([buffer[16], buffer[17], buffer[18], buffer[19]]);
            let height = u32::from_be_bytes([buffer[20], buffer[21], buffer[22], buffer[23]]);
            (Some(width), Some(height))
        }
        "gif" => {
            if buffer.len() < 10 {
                return (None, None);
            }
            (
                Some(u16::from_le_bytes([buffer[6], buffer[7]]) as u32),
                Some(u16::from_le_bytes([buffer[8], buffer[9]]) as u32),
            )
        }
        "webp" => {
            if buffer.len() < 30 {
                return (None, None);
            }
            let chunk = &buffer[12..16];
            if chunk == b"VP8X" {
                let width = 1 + (buffer[24] as u32 | ((buffer[25] as u32) << 8) | ((buffer[26] as u32) << 16));
                let height = 1 + (buffer[27] as u32 | ((buffer[28] as u32) << 8) | ((buffer[29] as u32) << 16));
                return (Some(width), Some(height));
            }
            if chunk == b"VP8 " {
                let width = u16::from_le_bytes([buffer[26], buffer[27]]) as u32 & 0x3fff;
                let height = u16::from_le_bytes([buffer[28], buffer[29]]) as u32 & 0x3fff;
                return (Some(width), Some(height));
            }
            if chunk == b"VP8L" && buffer.len() >= 25 {
                let bits = u32::from_le_bytes([buffer[21], buffer[22], buffer[23], buffer[24]]);
                return (Some((bits & 0x3fff) + 1), Some(((bits >> 14) & 0x3fff) + 1));
            }
            (None, None)
        }
        _ => (None, None),
    }
}

// ---------------------------------------------------------------------------
// 保存原始媒体
// ---------------------------------------------------------------------------

pub async fn save(
    app_settings: &AppSettings,
    job: &JobCtx,
    tweet_id: &str,
    media: &TweetMedia,
    force: bool,
) -> Result<SaveMediaResult, String> {
    if tweet_id.is_empty() {
        return Err("缺少推文 id，无法保存媒体".into());
    }
    if media.source_url.is_empty() {
        return Err("缺少要保存的媒体信息，请重新解析推文".into());
    }
    let info = require_tweet(tweet_id)?;
    if !force {
        if let Some(reused) = history::find_saved(tweet_id, &media.id, None) {
            if std::path::Path::new(&reused.file_path).exists() {
                job.progress("finalize", 100.0, "媒体已保存过，直接复用");
                return Ok(SaveMediaResult { saved: reused, new_file: false });
            }
        }
    }
    let output_dir = settings::effective_output_dir(app_settings);
    let screen_name = if !info.author.screen_name.is_empty() {
        info.author.screen_name.clone()
    } else {
        history::get(tweet_id)
            .map(|entry| entry.author.screen_name)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "x".into())
    };
    let index = media_index(&info, &media.id);
    let author_dir = output_dir.join(paths::safe_name(&screen_name, "x"));
    let tweet_dir = author_dir.join(paths::safe_name(tweet_id, "tweet"));
    paths::ensure_dir(tweet_dir.clone());

    if media.kind == "photo" {
        job.progress("download", 0.0, "正在下载图片…");
        let client = build_client(&app_settings.proxy)?;
        let mut on_progress = |received: u64, total: u64| {
            let percent = if total > 0 {
                (received as f64 / total as f64 * 88.0).min(88.0)
            } else {
                30.0
            };
            job.progress("download", percent, "正在下载图片…");
        };
        let buffer = fetch_bytes(&client, &media.source_url, MAX_IMAGE_BYTES, 60, &mut on_progress).await?;
        job.throw_if_cancelled()?;
        job.progress("probe", 90.0, "正在识别图片格式与尺寸…");
        let format = detect_image_format(&buffer).ok_or("无法识别的图片格式（支持 JPG / PNG / GIF / WebP）")?;
        let (width, height) = parse_image_dimensions(&buffer, format);
        let existing = history::find_saved(tweet_id, &media.id, None);
        let file_name = build_save_file_name(&screen_name, tweet_id, index, width, height, format);
        let target = match existing.as_ref().filter(|item| !item.file_path.is_empty()) {
            Some(item) => PathBuf::from(&item.file_path),
            None => paths::unique_path(&tweet_dir, &file_name),
        };
        job.progress("finalize", 94.0, "正在写入输出目录…");
        paths::atomic_write(&target, &buffer)?;
        let saved = SavedMedia {
            id: format!("{tweet_id}:{}:{format}", media.id),
            tweet_id: tweet_id.to_string(),
            media_id: media.id.clone(),
            media_kind: media.kind.clone(),
            format: format.to_string(),
            file_path: target.to_string_lossy().to_string(),
            file_name: target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or(file_name),
            width,
            height,
            duration_sec: None,
            size_bytes: paths::file_size(&target),
            created_at: paths::iso_now(),
        };
        if let Some(existing) = existing {
            if existing.id != saved.id {
                let _ = history::remove_saved(tweet_id, &existing.id);
            }
        }
        history::record_saved(&info, media, &saved, None)?;
        job.progress("done", 100.0, "图片已保存");
        return Ok(SaveMediaResult { saved, new_file: true });
    }

    job.progress("download", 0.0, "正在准备视频/GIF 媒体…");
    let prepared = prepare(app_settings, job, tweet_id, media, force).await?;
    job.throw_if_cancelled()?;
    let probe = prepared.probe.clone();
    let existing = history::find_saved(tweet_id, &media.id, Some("mp4"));
    let file_name = build_save_file_name(
        &screen_name,
        tweet_id,
        index,
        Some(probe.width),
        Some(probe.height),
        "mp4",
    );
    let target = match existing.as_ref().filter(|item| !item.file_path.is_empty()) {
        Some(item) => PathBuf::from(&item.file_path),
        None => paths::unique_path(&tweet_dir, &file_name),
    };
    job.progress("finalize", 88.0, "正在写入输出目录…");
    paths::copy_atomic(Path::new(&prepared.local_path), &target)?;
    let saved = SavedMedia {
        id: format!("{tweet_id}:{}:mp4", media.id),
        tweet_id: tweet_id.to_string(),
        media_id: media.id.clone(),
        media_kind: media.kind.clone(),
        format: "mp4".into(),
        file_path: target.to_string_lossy().to_string(),
        file_name: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or(file_name),
        width: Some(probe.width),
        height: Some(probe.height),
        duration_sec: Some(probe.duration_sec),
        size_bytes: paths::file_size(&target),
        created_at: paths::iso_now(),
    };
    history::record_saved(&info, media, &saved, Some(&probe))?;
    job.progress("done", 100.0, "媒体已保存");
    Ok(SaveMediaResult { saved, new_file: true })
}

// ---------------------------------------------------------------------------
// 已保存视频缩略图 / 探测
// ---------------------------------------------------------------------------

pub async fn video_thumbnail(file_path: &str) -> Option<String> {
    let path = Path::new(file_path);
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "mp4" && ext != "m4v" {
        return None;
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let target = paths::ensure_dir(paths::cache_dir().join("thumbs").join("saved")).join(format!("{hash}.jpg"));
    if target.exists() && paths::file_size(&target) > 0 {
        return Some(target.to_string_lossy().to_string());
    }
    let generated = make_thumbnail(path, &target).await?;
    Some(generated.to_string_lossy().to_string())
}

pub fn probe_file(file_path: &str) -> Option<MediaProbe> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "mp4" || ext == "m4v" {
        probe_mp4::probe(file_path).ok()
    } else {
        None
    }
}