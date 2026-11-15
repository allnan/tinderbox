// 数据模型：字段名与前端 src/shared/types.ts 保持一致（camelCase）。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Json = Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub ffmpeg: Option<String>,
    pub gifski: Option<String>,
    pub gifsicle: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub gifski_version: Option<String>,
    pub gifsicle_version: Option<String>,
    pub ready: bool,
    pub missing: Vec<String>,
}

impl ToolStatus {
    pub fn missing() -> Self {
        Self {
            ffmpeg: None,
            gifski: None,
            gifsicle: None,
            ffmpeg_version: None,
            gifski_version: None,
            gifsicle_version: None,
            ready: false,
            missing: vec!["ffmpeg".into(), "gifski".into(), "gifsicle".into()],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub is_packaged: bool,
    pub data_dir: String,
    pub cache_dir: String,
    pub output_dir: String,
    pub logs_dir: String,
    pub tools: ToolStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetAuthor {
    pub name: String,
    pub screen_name: String,
    pub avatar_url: Option<String>,
    pub verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVariant {
    pub url: String,
    pub bitrate: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetMedia {
    pub id: String,
    pub kind: String, // gif | video | photo
    pub source_url: String,
    pub thumbnail_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_sec: Option<f64>,
    pub variants: Vec<MediaVariant>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetInfo {
    pub id: String,
    pub url: String,
    pub author: TweetAuthor,
    pub text: String,
    pub created_at: Option<String>,
    pub media: Vec<TweetMedia>,
    pub source: String,
    pub fetched_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub duration_sec: f64,
    pub frame_count: u32,
    pub fps: f64,
    pub frame_durations_ms: Vec<f64>,
    pub has_audio: bool,
    pub size_bytes: u64,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMedia {
    pub media_id: String,
    pub local_path: String,
    pub thumbnail_path: Option<String>,
    pub probe: MediaProbe,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMedia {
    pub id: String,
    pub tweet_id: String,
    pub media_id: String,
    pub media_kind: String,
    pub format: String,
    pub file_path: String,
    pub file_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_sec: Option<f64>,
    pub size_bytes: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMediaResult {
    pub saved: SavedMedia,
    pub new_file: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMedia {
    pub id: String,
    pub kind: String,
    pub source_url: String,
    pub thumbnail_url: Option<String>,
    pub local_path: Option<String>,
    pub probe: Option<MediaProbe>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifInfo {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub frame_count: u32,
    pub duration_sec: f64,
    pub fps: f64,
    pub frame_delays_ms: Vec<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifResult {
    pub id: String,
    pub tweet_id: String,
    pub media_id: String,
    pub gif_path: String,
    #[serde(default)]
    pub format: Option<String>,
    pub info: GifInfo,
    pub params: Json,
    pub preset_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub copies: Vec<String>,
    pub source_probe: Option<MediaProbe>,
    pub source_saved: Option<SavedMedia>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub tweet_url: String,
    pub author: TweetAuthor,
    pub text: String,
    pub tweet_created_at: Option<String>,
    pub fetched_at: String,
    pub last_opened_at: String,
    pub media: Vec<HistoryMedia>,
    pub saved_media: Vec<SavedMedia>,
    pub results: Vec<GifResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub mode: String, // system | custom | direct
    pub url: String,
    pub bypass: String,
    pub username: String,
    pub password: String,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: "system".into(),
            url: String::new(),
            bypass: "localhost;127.0.0.1;<local>".into(),
            username: String::new(),
            password: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub output_dir: Option<String>,
    pub cache_dir: Option<String>,
    pub default_params: Json,
    pub default_preset_id: String,
    pub keep_original_mp4: bool,
    pub max_cache_size_mb: f64,
    pub proxy: ProxySettings,
    pub theme: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub scope: String,
    pub phase: String,
    pub percent: f64,
    pub message: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDownloadProgress {
    pub tool: String,
    pub phase: String,
    pub percent: f64,
    pub message: String,
    #[serde(default)]
    pub done: bool,
}

pub fn ok(data: Json) -> Json {
    serde_json::json!({ "ok": true, "data": data })
}

pub fn fail(message: impl Into<String>) -> Json {
    let message: String = message.into();
    serde_json::json!({ "ok": false, "error": message })
}

pub fn fail_code(message: impl Into<String>, code: &str) -> Json {
    let message: String = message.into();
    serde_json::json!({ "ok": false, "error": message, "code": code })
}