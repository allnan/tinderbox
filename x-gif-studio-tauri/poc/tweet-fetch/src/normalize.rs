//! 接口响应归一化（移植 tweet.cjs 的 normalizeFxTweet / normalizeSyndication / normalizeVxTweet）。

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::model::{MediaKind, MediaVariant, TweetAuthor, TweetInfo, TweetMedia, TweetSource};
use crate::timeutil::{iso_date_opt, now_iso};

// ---------------------------------------------------------------------------
// 通用辅助：尽量贴近 JS 的 Number / String / 真值语义
// ---------------------------------------------------------------------------

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|v| v != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_truthy_opt(value: Option<&Value>) -> bool {
    value.map(js_truthy).unwrap_or(false)
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        _ => None,
    }
}

fn js_number_to_string(value: f64) -> String {
    if !value.is_finite() {
        return "NaN".to_string();
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return format!("{}", value as i64);
    }
    format!("{}", value)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                int.to_string()
            } else if let Some(uint) = number.as_u64() {
                uint.to_string()
            } else {
                js_number_to_string(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// JS 的 value1 || value2 || ...（返回第一个真值）。
fn js_or<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values
        .iter()
        .find_map(|value| value.filter(|item| js_truthy(item)))
}

fn finite_positive_u32(value: Option<f64>) -> Option<u32> {
    match value {
        Some(number) if number.is_finite() && number > 0.0 => Some(number as u32),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 文本、图片、变体辅助
// ---------------------------------------------------------------------------

fn tco_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"https://t\.co/\w+").expect("t.co 正则必须可编译"))
}

/// 去掉 t.co 短链并压缩空白（移植 safeText）。
fn safe_text(value: Option<&Value>) -> String {
    let Some(Value::String(text)) = value else {
        return String::new();
    };
    let stripped = tco_regex().replace_all(text, " ");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 把 pbs.twimg.com 图片地址规范到原图（移植 originalPhotoUrl）。
pub fn original_photo_url(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    let Some(scheme_end) = url.find("://") else {
        return Some(url.to_string());
    };
    let host_start = scheme_end + 3;
    let rest = &url[host_start..];
    let host_len = rest
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let host = &rest[..host_len];
    let host_lower = host.to_ascii_lowercase();
    let is_pbs_host = host_lower == "pbs.twimg.com" || host_lower.ends_with(".pbs.twimg.com");
    if !is_pbs_host {
        return Some(url.to_string());
    }

    let (without_fragment, fragment) = match url.find('#') {
        Some(index) => (&url[..index], Some(&url[index..])),
        None => (url, None),
    };
    let (base, query) = match without_fragment.find('?') {
        Some(index) => (
            &without_fragment[..index],
            Some(&without_fragment[index + 1..]),
        ),
        None => (without_fragment, None),
    };
    let mut params: Vec<String> = query
        .map(|query| {
            query
                .split('&')
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut replaced = false;
    for param in params.iter_mut() {
        let key = param.split('=').next().unwrap_or_default();
        if key == "name" {
            *param = "name=orig".to_string();
            replaced = true;
        }
    }
    if !replaced {
        params.push("name=orig".to_string());
    }
    let mut output = base.to_string();
    if !params.is_empty() {
        output.push('?');
        output.push_str(&params.join("&"));
    }
    if let Some(fragment) = fragment {
        output.push_str(fragment);
    }
    Some(output)
}

/// 从 video.twimg.com 的变体地址推断尺寸（移植 sizeFromVariantUrl）。
fn size_from_variant_url(url: &str) -> (Option<u32>, Option<u32>) {
    fn capture_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?i)/vid/[^/]+/([0-9]+)x([0-9]+)/").expect("vid 尺寸正则必须可编译")
        })
    }
    fn fallback_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new(r"/([0-9]{2,5})x([0-9]{2,5})/").expect("尺寸正则必须可编译"))
    }
    for regex in [capture_regex(), fallback_regex()] {
        if let Some(captures) = regex.captures(url) {
            let width = captures.get(1).and_then(|m| m.as_str().parse::<u32>().ok());
            let height = captures.get(2).and_then(|m| m.as_str().parse::<u32>().ok());
            return (width, height);
        }
    }
    (None, None)
}

fn normalize_kind(raw_type: Option<&Value>) -> Option<MediaKind> {
    let raw = match raw_type {
        Some(Value::String(text)) => text.to_lowercase(),
        Some(value) => js_string(value).to_lowercase(),
        None => return None,
    };
    match raw.as_str() {
        "gif" | "animated_gif" | "animatedgif" => Some(MediaKind::Gif),
        "video" => Some(MediaKind::Video),
        "photo" | "image" => Some(MediaKind::Photo),
        _ => None,
    }
}

fn normalize_variant(value: &Value) -> MediaVariant {
    let raw_url = js_or(&[value.get("url"), value.get("src")])
        .map(js_string)
        .unwrap_or_default();
    let (size_width, size_height) = size_from_variant_url(&raw_url);
    let width = if value.get("width").is_some_and(|item| !item.is_null()) {
        finite_positive_u32(number_of(value.get("width")))
    } else {
        size_width
    };
    let height = if value.get("height").is_some_and(|item| !item.is_null()) {
        finite_positive_u32(number_of(value.get("height")))
    } else {
        size_height
    };
    MediaVariant {
        url: raw_url,
        bitrate: number_of(value.get("bitrate")).unwrap_or(0.0) as u64,
        width,
        height,
    }
}

fn mp4_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.mp4(?:[?#]|$)").expect("mp4 正则必须可编译"))
}

/// 选码率最高的 mp4 变体（移植 pickBestMp4）。
fn pick_best_mp4(raw_variants: &[&Value], fallback: Option<&Value>) -> Option<String> {
    let mut mp4: Vec<&Value> = Vec::new();
    for item in raw_variants {
        let content_type = js_or(&[item.get("content_type"), item.get("container")])
            .map(js_string)
            .unwrap_or_default()
            .to_lowercase();
        if content_type.contains("mpegurl") {
            continue;
        }
        let url = js_or(&[item.get("url")]).map(js_string).unwrap_or_default();
        if content_type.contains("mp4") || mp4_regex().is_match(&url) {
            mp4.push(item);
        }
    }
    if mp4.is_empty() {
        if let Some(fallback) = fallback {
            if js_truthy(fallback) {
                return Some(js_string(fallback));
            }
        }
        return raw_variants
            .first()
            .and_then(|item| js_or(&[item.get("url")]).map(js_string))
            .filter(|url| !url.is_empty());
    }
    mp4.sort_by(|left, right| {
        let left_bitrate = number_of(left.get("bitrate")).unwrap_or(0.0);
        let right_bitrate = number_of(right.get("bitrate")).unwrap_or(0.0);
        right_bitrate
            .partial_cmp(&left_bitrate)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    js_or(&[mp4[0].get("url")])
        .map(js_string)
        .filter(|url| !url.is_empty())
}

fn media_id(item: &Value, index: usize) -> String {
    js_or(&[item.get("id"), item.get("id_str")])
        .map(js_string)
        .unwrap_or_else(|| format!("media-{}", index + 1))
}

fn derive_syndication_media_id(item: &Value, index: usize) -> String {
    fn video_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"/(?:tweet_video|amplify_video|ext_tw_video)/([0-9]+)")
                .expect("视频 id 正则必须可编译")
        })
    }
    fn file_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?i)/([A-Za-z0-9_-]{6,})\.(?:jpg|jpeg|png|webp|mp4)")
                .expect("媒体文件名正则必须可编译")
        })
    }
    for key in ["media_url_https", "expanded_url", "url"] {
        if let Some(candidate) = js_or(&[item.get(key)]).map(js_string) {
            if let Some(captures) = video_regex().captures(&candidate) {
                return captures[1].to_string();
            }
            if let Some(captures) = file_regex().captures(&candidate) {
                return captures[1].to_string();
            }
        }
    }
    format!("media-{}", index + 1)
}

fn avatar_with_400x400(url: &str) -> Option<String> {
    fn avatar_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?i)_normal(\.(?:jpg|jpeg|png|gif|webp))").expect("头像尺寸正则必须可编译")
        })
    }
    if url.is_empty() {
        return None;
    }
    Some(avatar_regex().replace(url, "_400x400$1").to_string())
}

// ---------------------------------------------------------------------------
// fxtwitter（v2 / v1 共用字段结构）
// ---------------------------------------------------------------------------

fn canonical_screen_name(canonical_url: &str, fallback: &str) -> String {
    fn screen_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new(r"(?i)x\.com/([^/]+)/").expect("用户名正则必须可编译"))
    }
    if !fallback.is_empty() {
        return fallback.to_string();
    }
    screen_regex()
        .captures(canonical_url)
        .map(|captures| captures[1].to_string())
        .unwrap_or_default()
}

/// 归一化 fxtwitter v2/v1 的 status/tweet 对象（移植 normalizeFxTweet）。
pub fn normalize_fx_tweet(tweet: &Value, canonical_url: &str) -> Option<TweetInfo> {
    if !tweet.is_object() {
        return None;
    }
    let author_source = tweet.get("author");
    let verification = author_source.and_then(|author| author.get("verification"));
    let name = js_or(&[
        author_source.and_then(|author| author.get("name")),
        author_source.and_then(|author| author.get("screen_name")),
    ])
    .map(js_string)
    .unwrap_or_else(|| "未知用户".to_string());
    let screen_name = author_source
        .and_then(|author| author.get("screen_name"))
        .map(js_string)
        .unwrap_or_default();
    let avatar_url = js_or(&[
        author_source.and_then(|author| author.get("avatar_url")),
        author_source.and_then(|author| author.get("profile_image_url_https")),
    ])
    .map(js_string);
    let verified = js_truthy_opt(author_source.and_then(|author| author.get("verified")))
        || js_truthy_opt(verification.and_then(|item| item.get("verified")))
        || js_truthy_opt(author_source.and_then(|author| author.get("is_blue_verified")));
    let author = TweetAuthor {
        name,
        screen_name: canonical_screen_name(canonical_url, &screen_name),
        avatar_url,
        verified,
    };

    let media_source: Vec<&Value> = tweet
        .get("media")
        .and_then(|media| {
            ["all", "videos", "photos"]
                .iter()
                .find_map(|key| media.get(*key))
                .and_then(Value::as_array)
        })
        .map(|items| items.iter().collect())
        .unwrap_or_default();

    let mut media: Vec<TweetMedia> = Vec::with_capacity(media_source.len());
    for (index, item) in media_source.iter().enumerate() {
        let Some(kind) = normalize_kind(item.get("type")) else {
            continue;
        };
        let raw_variants: Vec<&Value> = item
            .get("variants")
            .or_else(|| item.get("formats"))
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default();
        let variants: Vec<MediaVariant> = raw_variants
            .iter()
            .map(|variant| normalize_variant(variant))
            .filter(|variant| !variant.url.is_empty())
            .collect();

        let source_url = if kind == MediaKind::Photo {
            let raw = js_or(&[item.get("url")])
                .map(js_string)
                .filter(|url| !url.is_empty())
                .or_else(|| variants.first().map(|variant| variant.url.clone()));
            raw.as_deref().and_then(original_photo_url)
        } else {
            pick_best_mp4(&raw_variants, item.get("url"))
        };
        let Some(source_url) = source_url else {
            continue;
        };

        let width = if item.get("width").is_some_and(|value| !value.is_null()) {
            number_of(item.get("width"))
        } else {
            item.get("original_info")
                .and_then(|info| info.get("width"))
                .and_then(|value| number_of(Some(value)))
        };
        let height = if item.get("height").is_some_and(|value| !value.is_null()) {
            number_of(item.get("height"))
        } else {
            item.get("original_info")
                .and_then(|info| info.get("height"))
                .and_then(|value| number_of(Some(value)))
        };
        let duration_sec = match number_of(item.get("duration")) {
            Some(seconds) if seconds.is_finite() && seconds > 0.0 => {
                Some((seconds * 1000.0).round() / 1000.0)
            }
            _ => match number_of(item.get("duration_millis")) {
                Some(millis) if millis.is_finite() && millis > 0.0 => Some(millis.round() / 1000.0),
                _ => None,
            },
        };

        media.push(TweetMedia {
            id: media_id(item, index),
            kind,
            source_url: source_url.clone(),
            thumbnail_url: js_or(&[item.get("thumbnail_url")])
                .map(js_string)
                .or_else(|| (kind == MediaKind::Photo).then(|| source_url.clone())),
            width: finite_positive_u32(width),
            height: finite_positive_u32(height),
            duration_sec,
            variants,
        });
    }

    let mut text = safe_text(tweet.get("text"));
    if text.is_empty() {
        text = safe_text(tweet.get("raw_text").and_then(|raw| raw.get("text")));
    }
    let id = js_or(&[tweet.get("id"), tweet.get("id_str")])
        .map(js_string)
        .unwrap_or_default();
    if id.is_empty() {
        return None;
    }
    let url = match js_or(&[tweet.get("url")]) {
        Some(Value::String(url))
            if Regex::new(r"(?i)(?:x|twitter)\.com/.*/status/")
                .expect("推文链接正则必须可编译")
                .is_match(url) =>
        {
            url.clone()
        }
        _ => canonical_url.to_string(),
    };
    Some(TweetInfo {
        id,
        url,
        author,
        text,
        created_at: iso_date_opt(js_or(&[
            tweet.get("created_at"),
            tweet.get("created_timestamp"),
        ])),
        media,
        source: TweetSource::FxTwitter,
        fetched_at: now_iso(),
    })
}

// ---------------------------------------------------------------------------
// syndication
// ---------------------------------------------------------------------------

/// 归一化 cdn.syndication.twimg.com/tweet-result 响应（移植 normalizeSyndication）。
pub fn normalize_syndication(json: &Value, canonical_url: Option<&str>) -> Option<TweetInfo> {
    if !json.is_object() {
        return None;
    }
    if json
        .get("__typename")
        .and_then(Value::as_str)
        .is_some_and(|typename| typename.contains("Tombstone"))
    {
        return None;
    }
    let tweet_id = js_or(&[json.get("id_str"), json.get("id")]).map(js_string)?;

    let user = json.get("user");
    let avatar_url = user
        .and_then(|user| user.get("profile_image_url_https"))
        .map(js_string)
        .and_then(|url| avatar_with_400x400(&url));
    let author = TweetAuthor {
        name: js_or(&[
            user.and_then(|user| user.get("name")),
            user.and_then(|user| user.get("screen_name")),
        ])
        .map(js_string)
        .unwrap_or_else(|| "未知用户".to_string()),
        screen_name: user
            .and_then(|user| user.get("screen_name"))
            .map(js_string)
            .unwrap_or_default(),
        avatar_url,
        verified: js_truthy_opt(user.and_then(|user| user.get("verified")))
            || js_truthy_opt(user.and_then(|user| user.get("is_blue_verified"))),
    };

    let details: Vec<&Value> = json
        .get("mediaDetails")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();

    let mut media: Vec<TweetMedia> = Vec::with_capacity(details.len());
    for (index, item) in details.iter().enumerate() {
        let Some(kind) = normalize_kind(item.get("type")) else {
            continue;
        };
        let raw_variants: Vec<&Value> = item
            .get("video_info")
            .and_then(|info| info.get("variants"))
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default();
        let variants: Vec<MediaVariant> = raw_variants
            .iter()
            .map(|variant| normalize_variant(variant))
            .filter(|variant| !variant.url.is_empty())
            .collect();

        let source_url = if kind == MediaKind::Photo {
            let raw = js_or(&[item.get("media_url_https"), item.get("url")])
                .map(js_string)
                .unwrap_or_default();
            original_photo_url(&raw)
        } else {
            pick_best_mp4(&raw_variants, None)
        };
        let Some(source_url) = source_url else {
            continue;
        };

        let width = item
            .get("original_info")
            .and_then(|info| info.get("width"))
            .and_then(|value| number_of(Some(value)));
        let height = item
            .get("original_info")
            .and_then(|info| info.get("height"))
            .and_then(|value| number_of(Some(value)));
        let duration_sec = item
            .get("video_info")
            .and_then(|info| info.get("duration_millis"))
            .and_then(|value| number_of(Some(value)))
            .filter(|millis| *millis > 0.0)
            .map(|millis| millis.round() / 1000.0)
            .or_else(|| {
                json.get("video")
                    .and_then(|video| video.get("durationMs"))
                    .and_then(|value| number_of(Some(value)))
                    .filter(|millis| *millis > 0.0)
                    .map(|millis| millis.round() / 1000.0)
            });

        media.push(TweetMedia {
            id: derive_syndication_media_id(item, index),
            kind,
            source_url: source_url.clone(),
            thumbnail_url: js_or(&[item.get("media_url_https")])
                .map(js_string)
                .or_else(|| {
                    json.get("video")
                        .and_then(|video| video.get("poster"))
                        .filter(|poster| js_truthy(poster))
                        .map(js_string)
                }),
            width: finite_positive_u32(width),
            height: finite_positive_u32(height),
            duration_sec,
            variants,
        });
    }

    let screen_name = author.screen_name.clone();
    let url = match canonical_url {
        Some(url) if !url.is_empty() => url.to_string(),
        _ => {
            if tweet_id.is_empty() {
                String::new()
            } else if screen_name.is_empty() {
                format!("https://x.com/i/status/{}", tweet_id)
            } else {
                format!("https://x.com/{}/status/{}", screen_name, tweet_id)
            }
        }
    };

    Some(TweetInfo {
        id: tweet_id,
        url,
        author,
        text: safe_text(json.get("text")),
        created_at: iso_date_opt(json.get("created_at")),
        media,
        source: TweetSource::Syndication,
        fetched_at: now_iso(),
    })
}

// ---------------------------------------------------------------------------
// vxtwitter
// ---------------------------------------------------------------------------

/// 归一化 api.vxtwitter.com 响应（移植 normalizeVxTweet）。
pub fn normalize_vx_tweet(json: &Value, canonical_url: Option<&str>) -> Option<TweetInfo> {
    if !json.is_object() {
        return None;
    }
    let has_identity = js_truthy_opt(json.get("tweetURL"))
        || js_truthy_opt(json.get("tweet_id"))
        || js_truthy_opt(json.get("user_screen_name"));
    if !has_identity {
        return None;
    }
    let author = TweetAuthor {
        name: js_or(&[json.get("user_name")])
            .map(js_string)
            .unwrap_or_else(|| "未知用户".to_string()),
        screen_name: json
            .get("user_screen_name")
            .map(js_string)
            .unwrap_or_default(),
        avatar_url: js_or(&[json.get("user_profile_image_url")]).map(js_string),
        verified: js_truthy_opt(json.get("user_verified")),
    };

    let items: Vec<&Value> = json
        .get("media_extended")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    let mut media: Vec<TweetMedia> = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Some(kind) = normalize_kind(item.get("type")) else {
            continue;
        };
        let source_url = if kind == MediaKind::Photo {
            original_photo_url(&js_or(&[item.get("url")]).map(js_string).unwrap_or_default())
        } else {
            js_or(&[item.get("url")])
                .map(js_string)
                .filter(|url| !url.is_empty())
        };
        let Some(source_url) = source_url else {
            continue;
        };
        let width = item
            .get("size")
            .and_then(|size| size.get("width"))
            .and_then(|value| number_of(Some(value)));
        let height = item
            .get("size")
            .and_then(|size| size.get("height"))
            .and_then(|value| number_of(Some(value)));
        let duration_sec = number_of(item.get("duration_millis"))
            .filter(|millis| millis.is_finite() && *millis > 0.0)
            .map(|millis| millis.round() / 1000.0);
        media.push(TweetMedia {
            id: derive_syndication_media_id(item, index),
            kind,
            source_url: source_url.clone(),
            thumbnail_url: js_or(&[item.get("thumbnail_url")])
                .map(js_string)
                .or_else(|| (kind == MediaKind::Photo).then(|| source_url.clone())),
            width: finite_positive_u32(width),
            height: finite_positive_u32(height),
            duration_sec,
            variants: Vec::new(),
        });
    }

    let tweet_id = match js_or(&[json.get("tweet_id")]).map(js_string) {
        Some(id) if !id.is_empty() => id,
        _ => {
            let tweet_url = json.get("tweetURL").map(js_string).unwrap_or_default();
            static ID_RE: OnceLock<Regex> = OnceLock::new();
            ID_RE
                .get_or_init(|| Regex::new(r"status/([0-9]+)").expect("推文 id 正则必须可编译"))
                .captures(&tweet_url)
                .map(|captures| captures[1].to_string())
                .unwrap_or_default()
        }
    };
    let url = match canonical_url {
        Some(url) if !url.is_empty() => url.to_string(),
        _ => json.get("tweetURL").map(js_string).unwrap_or_default(),
    };

    Some(TweetInfo {
        id: tweet_id,
        url,
        author,
        text: safe_text(json.get("text")),
        created_at: iso_date_opt(js_or(&[json.get("date"), json.get("date_epoch")])),
        media,
        source: TweetSource::VxTwitter,
        fetched_at: now_iso(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fx_v2_fixture() -> Value {
        json!({
            "id": "2119254989323588005",
            "url": "https://x.com/lapislazulidm/status/2119254989323588005",
            "text": "#初星学園ぬいぬい部\nGIF2 https://t.co/APGRV0Qb2Z",
            "created_at": "2026-11-08T02:25:37.000Z",
            "author": {
                "screen_name": "lapislazulidm",
                "name": "ラピスラズリ(DM)",
                "avatar_url": "https://pbs.twimg.com/profile_images/1/avatar_normal.jpg",
                "verification": { "verified": true }
            },
            "media": {
                "all": [
                    {
                        "id": "2119254785778151424",
                        "url": "https://video.twimg.com/tweet_video/HWka_9bacAAnUxi.mp4",
                        "thumbnail_url": "https://pbs.twimg.com/tweet_video_thumb/HWka_9bacAAnUxi.jpg",
                        "duration": 0,
                        "width": 478,
                        "height": 450,
                        "type": "gif",
                        "formats": [
                            {
                                "url": "https://video.twimg.com/tweet_video/HWka_9bacAAnUxi.mp4",
                                "bitrate": 0,
                                "container": "mp4",
                                "codec": "h264"
                            }
                        ]
                    },
                    {
                        "id": "2119254785778151425",
                        "url": "https://pbs.twimg.com/media/PIC00001?format=jpg&name=small",
                        "type": "photo",
                        "width": 1200,
                        "height": 800
                    },
                    {
                        "id": "2119254785778151426",
                        "url": "https://video.twimg.com/ext_tw_video/2119254785778151426/pu/vid/720x1280/video.mp4",
                        "thumbnail_url": "https://pbs.twimg.com/ext_tw_video_thumb/2119254785778151426/pu/img/poster.jpg",
                        "duration": 12.345,
                        "width": 720,
                        "height": 1280,
                        "type": "video",
                        "variants": [
                            {
                                "url": "https://video.twimg.com/ext_tw_video/2119254785778151426/pu/vid/480x854/low.mp4",
                                "bitrate": 256000,
                                "content_type": "video/mp4"
                            },
                            {
                                "url": "https://video.twimg.com/ext_tw_video/2119254785778151426/pu/vid/720x1280/high.mp4",
                                "bitrate": 2176000,
                                "content_type": "video/mp4"
                            },
                            {
                                "url": "https://video.twimg.com/ext_tw_video/2119254785778151426/pu/pl/playlist.m3u8",
                                "content_type": "application/x-mpegURL"
                            }
                        ]
                    }
                ]
            }
        })
    }

    #[test]
    fn normalizes_fx_v2_status() {
        let info = normalize_fx_tweet(
            &fx_v2_fixture(),
            "https://x.com/lapislazulidm/status/2119254989323588005",
        )
        .expect("应能归一化");
        assert_eq!(info.id, "2119254989323588005");
        assert_eq!(info.source, TweetSource::FxTwitter);
        assert_eq!(info.author.name, "ラピスラズリ(DM)");
        assert_eq!(info.author.screen_name, "lapislazulidm");
        assert_eq!(info.author.verified, true);
        assert_eq!(
            info.author.avatar_url.as_deref(),
            Some("https://pbs.twimg.com/profile_images/1/avatar_normal.jpg")
        );
        // t.co 链接被删除，换行/多空格被压缩
        assert_eq!(info.text, "#初星学園ぬいぬい部 GIF2");
        assert_eq!(info.created_at.as_deref(), Some("2026-11-08T02:25:37.000Z"));
        assert_eq!(info.media.len(), 3);

        let gif = &info.media[0];
        assert_eq!(gif.kind, MediaKind::Gif);
        assert_eq!(
            gif.source_url,
            "https://video.twimg.com/tweet_video/HWka_9bacAAnUxi.mp4"
        );
        assert_eq!(gif.width, Some(478));
        assert_eq!(gif.height, Some(450));
        assert_eq!(gif.duration_sec, None);
        assert_eq!(gif.variants.len(), 1);

        let photo = &info.media[1];
        assert_eq!(photo.kind, MediaKind::Photo);
        assert_eq!(
            photo.source_url,
            "https://pbs.twimg.com/media/PIC00001?format=jpg&name=orig"
        );
        assert_eq!(
            photo.thumbnail_url.as_deref(),
            Some(photo.source_url.as_str())
        );

        let video = &info.media[2];
        assert_eq!(video.kind, MediaKind::Video);
        // 选码率最高的 mp4，且忽略 m3u8
        assert_eq!(
            video.source_url,
            "https://video.twimg.com/ext_tw_video/2119254785778151426/pu/vid/720x1280/high.mp4"
        );
        // variants 保留全部变体（含 m3u8），只影响 variants 列表，不参与 sourceUrl 选择
        assert_eq!(video.variants.len(), 3);
        assert_eq!(video.duration_sec, Some(12.345));
        assert_eq!(video.width, Some(720));
        assert_eq!(video.height, Some(1280));
    }

    #[test]
    fn fx_author_screen_name_falls_back_to_canonical_url() {
        let mut fixture = fx_v2_fixture();
        fixture["author"]
            .as_object_mut()
            .unwrap()
            .remove("screen_name");
        let info = normalize_fx_tweet(
            &fixture,
            "https://x.com/fallback_user/status/2119254989323588005",
        )
        .expect("应能归一化");
        assert_eq!(info.author.screen_name, "fallback_user");
    }

    #[test]
    fn fx_returns_none_without_id() {
        let mut fixture = fx_v2_fixture();
        fixture.as_object_mut().unwrap().remove("id");
        assert!(normalize_fx_tweet(&fixture, "https://x.com/a/status/1").is_none());
    }

    #[test]
    fn normalizes_syndication_animated_gif_and_photo() {
        let fixture = json!({
            "__typename": "Tweet",
            "id_str": "2119254989323588005",
            "text": "syndication 测试 https://t.co/abc",
            "created_at": "2026-11-08T02:25:37.000Z",
            "user": {
                "name": "测试作者",
                "screen_name": "demo_user",
                "verified": false,
                "is_blue_verified": true,
                "profile_image_url_https": "https://pbs.twimg.com/profile_images/9/avatar_normal.png"
            },
            "mediaDetails": [
                {
                    "type": "animated_gif",
                    "media_url_https": "https://pbs.twimg.com/tweet_video_thumb/THUMB01.jpg",
                    "url": "https://t.co/APGRV0Qb2Z",
                    "expanded_url": "https://x.com/demo_user/status/2119254989323588005/photo/1",
                    "original_info": { "width": 478, "height": 450 },
                    "video_info": {
                        "variants": [
                            {
                                "bitrate": 0,
                                "content_type": "video/mp4",
                                "url": "https://video.twimg.com/tweet_video/CLIP01.mp4"
                            }
                        ]
                    }
                },
                {
                    "type": "photo",
                    "media_url_https": "https://pbs.twimg.com/media/PHOTO01.jpg",
                    "url": "https://t.co/xyz",
                    "original_info": { "width": 100, "height": 200 }
                }
            ],
            "video": { "poster": "https://pbs.twimg.com/poster/POSTER01.jpg", "durationMs": 4200 }
        });
        let info = normalize_syndication(
            &fixture,
            Some("https://x.com/demo_user/status/2119254989323588005"),
        )
        .expect("应能归一化");
        assert_eq!(info.source, TweetSource::Syndication);
        assert_eq!(info.author.name, "测试作者");
        assert_eq!(info.author.screen_name, "demo_user");
        assert_eq!(info.author.verified, true);
        assert_eq!(
            info.author.avatar_url.as_deref(),
            Some("https://pbs.twimg.com/profile_images/9/avatar_400x400.png")
        );
        assert_eq!(info.text, "syndication 测试");
        assert_eq!(info.media.len(), 2);

        let gif = &info.media[0];
        assert_eq!(gif.kind, MediaKind::Gif);
        assert_eq!(gif.id, "THUMB01");
        assert_eq!(
            gif.source_url,
            "https://video.twimg.com/tweet_video/CLIP01.mp4"
        );
        assert_eq!(
            gif.thumbnail_url.as_deref(),
            Some("https://pbs.twimg.com/tweet_video_thumb/THUMB01.jpg")
        );
        assert_eq!(gif.width, Some(478));
        assert_eq!(gif.duration_sec, Some(4.2));

        let photo = &info.media[1];
        assert_eq!(photo.kind, MediaKind::Photo);
        assert_eq!(
            photo.source_url,
            "https://pbs.twimg.com/media/PHOTO01.jpg?name=orig"
        );
    }

    #[test]
    fn syndication_rejects_tombstone() {
        let fixture = json!({ "__typename": "TweetTombstone", "id_str": "1" });
        assert!(normalize_syndication(&fixture, None).is_none());
    }

    #[test]
    fn normalizes_vxtwitter_media() {
        let fixture = json!({
            "tweetURL": "https://twitter.com/demo/status/123456789012345678",
            "user_name": "Demo",
            "user_screen_name": "demo",
            "user_profile_image_url": "https://pbs.twimg.com/profile/avatar.jpg",
            "user_verified": true,
            "text": "vx 测试 https://t.co/xyz",
            "date": "Sun Nov 08 02:25:37 +0000 2026",
            "date_epoch": 1794104737,
            "media_extended": [
                {
                    "type": "image",
                    "url": "https://pbs.twimg.com/media/VXPHOTO?format=png&name=900x900",
                    "size": { "width": 900, "height": 900 },
                    "thumbnail_url": "https://pbs.twimg.com/media/VXPHOTO?name=thumb"
                },
                {
                    "type": "video",
                    "url": "https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/vx.mp4",
                    "thumbnail_url": "https://pbs.twimg.com/poster.jpg",
                    "duration_millis": 9876
                }
            ]
        });
        let info = normalize_vx_tweet(
            &fixture,
            Some("https://x.com/demo/status/123456789012345678"),
        )
        .expect("应能归一化");
        assert_eq!(info.id, "123456789012345678");
        assert_eq!(info.source, TweetSource::VxTwitter);
        assert_eq!(info.author.screen_name, "demo");
        assert_eq!(info.text, "vx 测试");
        assert_eq!(info.created_at.as_deref(), Some("2026-11-08T02:25:37.000Z"));
        assert_eq!(info.media.len(), 2);
        assert_eq!(info.media[0].kind, MediaKind::Photo);
        assert_eq!(
            info.media[0].source_url,
            "https://pbs.twimg.com/media/VXPHOTO?format=png&name=orig"
        );
        assert_eq!(info.media[0].width, Some(900));
        assert_eq!(info.media[1].kind, MediaKind::Video);
        assert_eq!(info.media[1].duration_sec, Some(9.876));
        assert_eq!(info.media[1].variants.len(), 0);
    }

    #[test]
    fn vxtwitter_requires_identity_fields() {
        assert!(normalize_vx_tweet(&json!({ "text": "x" }), None).is_none());
    }

    #[test]
    fn original_photo_url_moves_to_orig() {
        assert_eq!(
            original_photo_url("https://pbs.twimg.com/media/ABC?format=jpg&name=small").as_deref(),
            Some("https://pbs.twimg.com/media/ABC?format=jpg&name=orig")
        );
        assert_eq!(
            original_photo_url("https://pbs.twimg.com/media/ABC.jpg").as_deref(),
            Some("https://pbs.twimg.com/media/ABC.jpg?name=orig")
        );
        assert_eq!(
            original_photo_url("https://example.com/media/ABC.jpg").as_deref(),
            Some("https://example.com/media/ABC.jpg")
        );
        assert_eq!(original_photo_url(""), None);
    }

    #[test]
    fn size_from_variant_url_parses_resolution() {
        assert_eq!(
            size_from_variant_url("https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/v.mp4"),
            (Some(720), Some(1280))
        );
        assert_eq!(
            size_from_variant_url("https://video.twimg.com/ext_tw_video/1/pu/vid/480x486/v.mp4"),
            (Some(480), Some(486))
        );
        assert_eq!(
            size_from_variant_url("https://example.com/v.mp4"),
            (None, None)
        );
    }

    #[test]
    fn pick_best_mp4_prefers_highest_bitrate_and_skips_hls() {
        let variants = [
            json!({ "url": "https://a/low.mp4", "bitrate": 100, "content_type": "video/mp4" }),
            json!({ "url": "https://a/hls.m3u8", "content_type": "application/x-mpegURL" }),
            json!({ "url": "https://a/high.mp4", "bitrate": 900, "container": "mp4" }),
        ];
        let refs: Vec<&Value> = variants.iter().collect();
        assert_eq!(
            pick_best_mp4(&refs, None).as_deref(),
            Some("https://a/high.mp4")
        );
        assert_eq!(
            pick_best_mp4(&[], Some(&json!("https://a/fallback.mp4"))).as_deref(),
            Some("https://a/fallback.mp4")
        );
    }
}
