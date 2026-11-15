//! 与 x-gif-studio/src/shared/types.ts 对齐的数据契约。
//!
//! 序列化时统一使用 camelCase 字段名（与 Electron 版传给渲染进程的 JSON 完全一致）。

use serde::{Deserialize, Serialize};

/// 推文媒体类型：X 的「GIF」在数据里是 animated_gif，但文件实际是 mp4。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Gif,
    Video,
    Photo,
}

/// 媒体数据来源，仅用于排障与日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TweetSource {
    FxTwitter,
    Syndication,
    VxTwitter,
}

/// 作者信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetAuthor {
    pub name: String,
    pub screen_name: String,
    pub avatar_url: Option<String>,
    pub verified: bool,
}

/// 视频/GIF 的清晰度变体。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVariant {
    pub url: String,
    pub bitrate: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 一条推文媒体。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetMedia {
    /// X 媒体 id（media id_str）；缺失时使用 media-序号。
    pub id: String,
    pub kind: MediaKind,
    /// 下载用地址：gif/video 为 mp4，photo 为原图。
    pub source_url: String,
    pub thumbnail_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 视频/GIF 时长（秒）；图片为 None。
    pub duration_sec: Option<f64>,
    pub variants: Vec<MediaVariant>,
}

/// 归一化后的推文信息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetInfo {
    pub id: String,
    /// 规范化后的推文链接（https://x.com/<user>/status/<id>）。
    pub url: String,
    pub author: TweetAuthor,
    pub text: String,
    /// 推文发布时间（ISO 字符串），缺失时为 None。
    pub created_at: Option<String>,
    pub media: Vec<TweetMedia>,
    pub source: TweetSource,
    pub fetched_at: String,
}
