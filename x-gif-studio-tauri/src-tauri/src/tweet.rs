// 推文解析：fxtwitter v2 → fxtwitter v1 → syndication → vxtwitter，统一归一化为 TweetInfo。
#![allow(dead_code)]

use serde_json::{json, Value};
use std::sync::Mutex;

use crate::http::{build_client, fetch_json, FetchError};
use crate::model::{AppSettings, MediaVariant, TweetAuthor, TweetInfo, TweetMedia};
use crate::paths::iso_now;

static TWEET_CACHE: Mutex<Vec<(String, TweetInfo)>> = Mutex::new(Vec::new());
const MAX_CACHE: usize = 20;

pub struct ParsedTweet {
    pub tweet_id: String,
    pub canonical_url: String,
    pub screen_name: Option<String>,
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

fn str_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn text_of(value: &Value, key: &str) -> String {
    str_of(get(value, key))
}

fn opt_string(value: Option<&Value>) -> Option<String> {
    let text = str_of(value);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn opt_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|item| match item {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    })
}

fn opt_u32(value: Option<&Value>) -> Option<u32> {
    opt_f64(value)
        .filter(|number| *number > 0.0)
        .map(|number| number.round() as u32)
}

fn bool_of(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) != 0,
        Some(Value::String(text)) => text == "true" || text == "1",
        _ => false,
    }
}

fn array_of<'a>(value: Option<&'a Value>) -> Vec<&'a Value> {
    value
        .and_then(|item| item.as_array())
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn safe_text(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let mut result = String::new();
    let mut chars = value.char_indices().peekable();
    while let Some((index, _)) = chars.next() {
        if value[index..].starts_with("https://t.co/") {
            for _ in 0..18 {
                if chars.next().is_none() {
                    break;
                }
            }
            result.push(' ');
        } else {
            result.push(value[index..].chars().next().unwrap_or(' '));
        }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 推文链接解析：支持 x.com / twitter.com 的 {user|i|i/web|web}/status/{id}。
pub fn parse_tweet_url(input: &str) -> Option<ParsedTweet> {
    let mut text = input.trim().to_string();
    if text.is_empty() {
        return None;
    }
    text = text
        .trim_start_matches(|ch: char| ch == '<' || ch == '（' || ch == '(' || ch == '【' || ch == '「' || ch.is_whitespace())
        .trim_end_matches(|ch: char| ch == '>' || ch == '）' || ch == ')' || ch == '】' || ch == '」' || ch.is_whitespace())
        .to_string();
    let lower = text.to_lowercase();
    let stripped = if let Some(rest) = lower.strip_prefix("https://") {
        rest.to_string()
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest.to_string()
    } else {
        lower.clone()
    };
    let stripped = stripped.trim_start_matches("www.").trim_start_matches("mobile.").trim_start_matches("m.").to_string();
    let parts: Vec<&str> = stripped.split('/').collect();
    if parts.len() < 4 {
        return None;
    }
    let host = parts[0];
    if host != "x.com" && host != "twitter.com" {
        return None;
    }
    let user_part = parts[1];
    let valid_user = user_part == "i" || user_part == "web" || user_part == "i/web" || is_screen_name(user_part);
    if !valid_user {
        return None;
    }
    let mut status_index = 2;
    if user_part == "i" && parts.get(2) == Some(&"web") {
        status_index = 3;
    }
    if parts.get(status_index) != Some(&"status") && parts.get(status_index) != Some(&"statuses") {
        return None;
    }
    let id_part = parts.get(status_index + 1)?.split(|ch: char| ch == '?' || ch == '#' || ch == '/').next()?;
    if id_part.len() < 5 || id_part.len() > 25 || !id_part.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let screen_name = if user_part == "i" || user_part == "web" || user_part == "i/web" {
        None
    } else {
        Some(user_part.to_string())
    };
    let canonical_url = match &screen_name {
        Some(name) => format!("https://x.com/{name}/status/{id_part}"),
        None => format!("https://x.com/i/status/{id_part}"),
    };
    Some(ParsedTweet {
        tweet_id: id_part.to_string(),
        canonical_url,
        screen_name,
    })
}

fn is_screen_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 30
        && value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

pub fn syndication_token(tweet_id: &str) -> String {
    let number: f64 = tweet_id.parse().unwrap_or(0.0);
    let value = (number / 1e15) * std::f64::consts::PI;
    base36(value)
}

fn base36(value: f64) -> String {
    let mut integer = value.floor() as u64;
    let mut fraction = value - value.floor();
    if integer == 0 {
        return trim_token(fraction_to_base36(fraction));
    }
    let mut digits = Vec::new();
    while integer > 0 {
        let digit = (integer % 36) as u32;
        digits.push(std::char::from_digit(digit, 36).unwrap_or('0'));
        integer /= 36;
    }
    let mut text: String = digits.into_iter().rev().collect();
    if fraction > 0.0 {
        text.push_str(&fraction_to_base36(fraction));
    }
    trim_token(text)
}

fn fraction_to_base36(mut fraction: f64) -> String {
    let mut text = String::new();
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    for _ in 0..16 {
        fraction *= 36.0;
        let digit = fraction.floor() as usize;
        text.push(digits[digit.min(35)] as char);
        fraction -= digit as f64;
        if fraction <= 0.0 {
            break;
        }
    }
    text
}

fn trim_token(value: String) -> String {
    value.replace(['0', '.'], "")
}

fn iso_from_unix(seconds: f64) -> Option<String> {
    if !seconds.is_finite() {
        return None;
    }
    let mut seconds = seconds;
    if seconds > 1e12 {
        seconds /= 1000.0;
    }
    let secs = seconds as i64;
    let millis = ((seconds - secs as f64) * 1000.0).round() as i64;
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        millis.clamp(0, 999)
    ))
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m as u32, d as u32)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let month = month as i64;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_iso_date(value: Option<&Value>) -> Option<String> {
    let item = value?;
    match item {
        Value::Number(number) => iso_from_unix(number.as_f64()?),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            if text.len() >= 19 && text.as_bytes().get(4) == Some(&b'-') && text.contains('T') {
                return Some(text.replace(' ', "T").trim_end_matches('Z').to_string() + "Z");
            }
            // Twitter 格式：Wed Oct 05 20:52:11 +0000 2023
            let parts: Vec<&str> = text.split_whitespace().collect();
            if parts.len() >= 6 {
                let month = match parts[1] {
                    "Jan" => 1,
                    "Feb" => 2,
                    "Mar" => 3,
                    "Apr" => 4,
                    "May" => 5,
                    "Jun" => 6,
                    "Jul" => 7,
                    "Aug" => 8,
                    "Sep" => 9,
                    "Oct" => 10,
                    "Nov" => 11,
                    "Dec" => 12,
                    _ => 0,
                };
                let day: u32 = parts[2].parse().ok()?;
                let clock: Vec<&str> = parts[3].split(':').collect();
                let hour: i64 = clock.first()?.parse().ok()?;
                let minute: i64 = clock.get(1).and_then(|item| item.parse().ok()).unwrap_or(0);
                let second: i64 = clock.get(2).and_then(|item| item.parse().ok()).unwrap_or(0);
                let year: i64 = parts[5].parse().ok()?;
                if month > 0 {
                    let offset = if parts[4].starts_with('+') || parts[4].starts_with('-') {
                        let sign = if parts[4].starts_with('-') { -1 } else { 1 };
                        let digits: i64 = parts[4][1..].parse().ok()?;
                        sign * ((digits / 100) * 3600 + (digits % 100) * 60)
                    } else {
                        0
                    };
                    let seconds = days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
                    return iso_from_unix(seconds as f64);
                }
            }
            None
        }
        _ => None,
    }
}

fn normalize_kind(value: &str) -> Option<String> {
    match value.to_lowercase().as_str() {
        "gif" | "animated_gif" | "animatedgif" => Some("gif".into()),
        "video" => Some("video".into()),
        "photo" | "image" => Some("photo".into()),
        _ => None,
    }
}

fn size_from_variant_url(url: &str) -> (Option<u32>, Option<u32>) {
    for segment in url.split('/') {
        if let Some((left, right)) = segment.split_once('x') {
            let left_ok = !left.is_empty() && left.chars().all(|ch| ch.is_ascii_digit());
            let right: String = right.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if left_ok && !right.is_empty() && right.len() <= 5 {
                let width = left.parse::<u32>().ok();
                let height = right.parse::<u32>().ok();
                return (width, height);
            }
        }
    }
    (None, None)
}

fn normalize_variant(item: &Value) -> Option<MediaVariant> {
    let url = text_of(item, "url");
    let url = if url.is_empty() { text_of(item, "src") } else { url };
    if url.is_empty() {
        return None;
    }
    let (size_width, size_height) = size_from_variant_url(&url);
    Some(MediaVariant {
        url,
        bitrate: opt_f64(get(item, "bitrate")).unwrap_or(0.0) as u64,
        width: opt_u32(get(item, "width")).or(size_width),
        height: opt_u32(get(item, "height")).or(size_height),
    })
}

fn variant_is_mp4(item: &Value) -> bool {
    let content_type = format!("{}{}", text_of(item, "content_type"), text_of(item, "container")).to_lowercase();
    if content_type.contains("mpegurl") {
        return false;
    }
    if content_type.contains("mp4") {
        return true;
    }
    text_of(item, "url").to_lowercase().contains(".mp4")
}

fn pick_best_mp4(variants: &[&Value], fallback: Option<String>) -> Option<String> {
    let mut mp4: Vec<(String, u64)> = variants
        .iter()
        .filter(|item| variant_is_mp4(item))
        .map(|item| {
            (
                text_of(item, "url"),
                opt_f64(get(item, "bitrate")).unwrap_or(0.0) as u64,
            )
        })
        .filter(|(url, _)| !url.is_empty())
        .collect();
    if mp4.is_empty() {
        return fallback.or_else(|| variants.first().map(|item| text_of(item, "url")));
    }
    mp4.sort_by(|a, b| b.1.cmp(&a.1));
    Some(mp4.remove(0).0)
}

fn original_photo_url(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    match reqwest::Url::parse(url) {
        Ok(mut parsed) => {
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if host == "pbs.twimg.com" || host.ends_with(".pbs.twimg.com") {
                parsed.set_query(Some("name=orig"));
                Some(parsed.to_string())
            } else {
                Some(url.to_string())
            }
        }
        Err(_) => Some(url.to_string()),
    }
}

fn media_from_fx(item: &Value, index: usize) -> Option<TweetMedia> {
    let kind = normalize_kind(&text_of(item, "type"))?;
    let variants_json = if get(item, "variants").map(|value| value.is_array()).unwrap_or(false) {
        array_of(get(item, "variants"))
    } else {
        array_of(get(item, "formats"))
    };
    let variants: Vec<MediaVariant> = variants_json.iter().filter_map(|value| normalize_variant(value)).collect();
    let raw_variants: Vec<&Value> = variants_json.clone();
    let source_url = if kind == "photo" {
        let base = if !text_of(item, "url").is_empty() {
            text_of(item, "url")
        } else {
            variants.first().map(|variant| variant.url.clone()).unwrap_or_default()
        };
        original_photo_url(&base)?
    } else {
        let fallback = {
            let url = text_of(item, "url");
            if url.is_empty() {
                None
            } else {
                Some(url)
            }
        };
        pick_best_mp4(&raw_variants, fallback)?
    };
    let width = opt_u32(get(item, "width")).or_else(|| {
        get(item, "original_info").and_then(|info| opt_u32(get(info, "width")))
    });
    let height = opt_u32(get(item, "height")).or_else(|| {
        get(item, "original_info").and_then(|info| opt_u32(get(info, "height")))
    });
    let duration_sec = opt_f64(get(item, "duration"))
        .or_else(|| opt_f64(get(item, "duration_millis")).map(|value| value / 1000.0))
        .filter(|value| *value > 0.0);
    let media_id = {
        let id = text_of(item, "id");
        if id.is_empty() {
            text_of(item, "id_str")
        } else {
            id
        }
    };
    let thumbnail = {
        let value = text_of(item, "thumbnail_url");
        if !value.is_empty() {
            Some(value)
        } else if kind == "photo" {
            Some(source_url.clone())
        } else {
            opt_string(get(item, "thumbnail_url"))
        }
    };
    Some(TweetMedia {
        id: if media_id.is_empty() { format!("media-{}", index + 1) } else { media_id },
        kind,
        source_url,
        thumbnail_url: thumbnail,
        width,
        height,
        duration_sec,
        variants,
    })
}

fn normalize_fx_tweet(tweet: &Value, source: &str, canonical_url: &str) -> Option<TweetInfo> {
    let author_source = get(tweet, "author").cloned().unwrap_or(json!({}));
    let verification = get(&author_source, "verification").cloned().unwrap_or(json!({}));
    let name = {
        let value = text_of(&author_source, "name");
        if value.is_empty() {
            text_of(&author_source, "screen_name")
        } else {
            value
        }
    };
    let screen_name = {
        let value = text_of(&author_source, "screen_name");
        if value.is_empty() {
            canonical_url
                .split("x.com/")
                .nth(1)
                .and_then(|rest| rest.split('/').next())
                .unwrap_or("")
                .to_string()
        } else {
            value
        }
    };
    let author = TweetAuthor {
        name: if name.is_empty() { "未知用户".into() } else { name },
        screen_name,
        avatar_url: opt_string(get(&author_source, "avatar_url"))
            .or_else(|| opt_string(get(&author_source, "profile_image_url_https"))),
        verified: bool_of(get(&author_source, "verified"))
            || bool_of(get(&verification, "verified"))
            || bool_of(get(&author_source, "is_blue_verified")),
    };
    let media_container = get(tweet, "media");
    let mut media_items: Vec<&Value> = Vec::new();
    if let Some(container) = media_container {
        if get(container, "all").map(|value| value.is_array()).unwrap_or(false) {
            media_items = array_of(get(container, "all"));
        } else if get(container, "videos").map(|value| value.is_array()).unwrap_or(false) {
            media_items.extend(array_of(get(container, "videos")));
            media_items.extend(array_of(get(container, "photos")));
        }
    }
    let media: Vec<TweetMedia> = media_items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| media_from_fx(item, index))
        .collect();
    let text = {
        let value = safe_text(&text_of(tweet, "text"));
        if value.is_empty() {
            safe_text(&text_of(tweet, "raw_text"))
        } else {
            value
        }
    };
    let id = {
        let value = text_of(tweet, "id");
        if value.is_empty() {
            text_of(tweet, "id_str")
        } else {
            value
        }
    };
    if id.is_empty() {
        return None;
    }
    Some(TweetInfo {
        id,
        url: canonical_url.to_string(),
        author,
        text,
        created_at: parse_iso_date(get(tweet, "created_at")).or_else(|| parse_iso_date(get(tweet, "created_timestamp"))),
        media,
        source: source.to_string(),
        fetched_at: iso_now(),
    })
}

fn derive_media_id(item: &Value, index: usize) -> String {
    for candidate in ["media_url_https", "expanded_url", "url"] {
        let text = text_of(item, candidate);
        if text.is_empty() {
            continue;
        }
        for marker in ["/tweet_video/", "/amplify_video/", "/ext_tw_video/"] {
            if let Some(rest) = text.split(marker).nth(1) {
                let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
                if !digits.is_empty() {
                    return digits;
                }
            }
        }
        if let Some(last) = text.split('/').last() {
            if let Some(stem) = last.split('.').next() {
                if stem.len() >= 6 && stem.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
                    return stem.to_string();
                }
            }
        }
    }
    format!("media-{}", index + 1)
}

fn media_from_syndication(item: &Value, index: usize, fallback_poster: Option<&str>) -> Option<TweetMedia> {
    let kind = normalize_kind(&text_of(item, "type"))?;
    let video_info = get(item, "video_info");
    let raw_variants: Vec<&Value> = array_of(video_info.and_then(|info| get(info, "variants")));
    let variants: Vec<MediaVariant> = raw_variants.iter().filter_map(|value| normalize_variant(value)).collect();
    let source_url = if kind == "photo" {
        let url = {
            let media_url = text_of(item, "media_url_https");
            if media_url.is_empty() {
                text_of(item, "url")
            } else {
                media_url
            }
        };
        original_photo_url(&url)?
    } else {
        pick_best_mp4(&raw_variants, None)?
    };
    let width = get(item, "original_info").and_then(|info| opt_u32(get(info, "width")));
    let height = get(item, "original_info").and_then(|info| opt_u32(get(info, "height")));
    let duration_sec = video_info
        .and_then(|info| opt_f64(get(info, "duration_millis")))
        .map(|value| (value / 1000.0 * 1000.0).round() / 1000.0)
        .filter(|value| *value > 0.0);
    let thumbnail = {
        let media_url = text_of(item, "media_url_https");
        if !media_url.is_empty() {
            Some(media_url)
        } else if kind == "photo" {
            Some(source_url.clone())
        } else {
            fallback_poster.map(|value| value.to_string())
        }
    };
    Some(TweetMedia {
        id: derive_media_id(item, index),
        kind,
        source_url,
        thumbnail_url: thumbnail,
        width,
        height,
        duration_sec,
        variants,
    })
}

fn normalize_syndication(json: &Value, canonical_url: &str) -> Option<TweetInfo> {
    if text_of(json, "__typename").contains("Tombstone") {
        return None;
    }
    let raw_id = {
        let id_str = text_of(json, "id_str");
        if id_str.is_empty() {
            text_of(json, "id")
        } else {
            id_str
        }
    };
    if raw_id.is_empty() {
        return None;
    }
    let user = get(json, "user").cloned().unwrap_or(json!({}));
    let avatar = text_of(&user, "profile_image_url_https")
        .replace("_normal.", "_400x400.");
    let author = TweetAuthor {
        name: {
            let name = text_of(&user, "name");
            if name.is_empty() { text_of(&user, "screen_name") } else { name }
        },
        screen_name: text_of(&user, "screen_name"),
        avatar_url: if avatar.is_empty() { None } else { Some(avatar) },
        verified: bool_of(get(&user, "verified")) || bool_of(get(&user, "is_blue_verified")),
    };
    let details = array_of(get(json, "mediaDetails"));
    let fallback_poster = get(json, "video").and_then(|video| opt_string(get(video, "poster")));
    let media: Vec<TweetMedia> = details
        .iter()
        .enumerate()
        .filter_map(|(index, item)| media_from_syndication(item, index, fallback_poster.as_deref()))
        .collect();
    let screen_name = author.screen_name.clone();
    let url = if canonical_url.is_empty() {
        if screen_name.is_empty() {
            format!("https://x.com/i/status/{raw_id}")
        } else {
            format!("https://x.com/{screen_name}/status/{raw_id}")
        }
    } else {
        canonical_url.to_string()
    };
    Some(TweetInfo {
        id: raw_id,
        url,
        author,
        text: safe_text(&text_of(json, "text")),
        created_at: parse_iso_date(get(json, "created_at")),
        media,
        source: "syndication".into(),
        fetched_at: iso_now(),
    })
}

fn normalize_vx(json: &Value, canonical_url: &str) -> Option<TweetInfo> {
    let tweet_url = text_of(json, "tweetURL");
    let tweet_id = {
        let id = text_of(json, "tweet_id");
        if id.is_empty() {
            tweet_url
                .split("status/")
                .nth(1)
                .and_then(|rest| rest.split(|ch: char| !ch.is_ascii_digit()).next())
                .unwrap_or("")
                .to_string()
        } else {
            id
        }
    };
    if tweet_id.is_empty() {
        return None;
    }
    let author = TweetAuthor {
        name: {
            let name = text_of(json, "user_name");
            if name.is_empty() { "未知用户".into() } else { name }
        },
        screen_name: text_of(json, "user_screen_name"),
        avatar_url: opt_string(get(json, "user_profile_image_url")),
        verified: bool_of(get(json, "user_verified")),
    };
    let items = array_of(get(json, "media_extended"));
    let media: Vec<TweetMedia> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let kind = normalize_kind(&text_of(item, "type"))?;
            let raw_url = text_of(item, "url");
            let source_url = if kind == "photo" { original_photo_url(&raw_url)? } else { raw_url };
            if source_url.is_empty() {
                return None;
            }
            let size = get(item, "size");
            Some(TweetMedia {
                id: derive_media_id(item, index),
                kind,
                source_url,
                thumbnail_url: opt_string(get(item, "thumbnail_url")),
                width: size.and_then(|value| opt_u32(get(value, "width"))),
                height: size.and_then(|value| opt_u32(get(value, "height"))),
                duration_sec: opt_f64(get(item, "duration_millis"))
                    .map(|value| (value / 1000.0 * 1000.0).round() / 1000.0)
                    .filter(|value| *value > 0.0),
                variants: Vec::new(),
            })
        })
        .collect();
    Some(TweetInfo {
        id: tweet_id,
        url: if canonical_url.is_empty() { tweet_url } else { canonical_url.to_string() },
        author,
        text: safe_text(&text_of(json, "text")),
        created_at: parse_iso_date(get(json, "date")).or_else(|| parse_iso_date(get(json, "date_epoch"))),
        media,
        source: "vxtwitter".into(),
        fetched_at: iso_now(),
    })
}

pub fn remember(tweet: TweetInfo) {
    if tweet.id.is_empty() {
        return;
    }
    if let Ok(mut cache) = TWEET_CACHE.lock() {
        cache.retain(|(id, _)| id != &tweet.id);
        cache.push((tweet.id.clone(), tweet));
        while cache.len() > MAX_CACHE {
            cache.remove(0);
        }
    }
}

pub fn get_cached(tweet_id: &str) -> Option<TweetInfo> {
    TWEET_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.iter().find(|(id, _)| id == tweet_id).map(|(_, tweet)| tweet.clone()))
}

pub fn clear_cache() {
    if let Ok(mut cache) = TWEET_CACHE.lock() {
        cache.clear();
    }
}

async fn endpoint_fx(
    client: &reqwest::Client,
    parsed: &ParsedTweet,
    use_v2: bool,
) -> Result<TweetInfo, FetchError> {
    let url = if use_v2 {
        format!("https://api.fxtwitter.com/2/status/{}", parsed.tweet_id)
    } else {
        match &parsed.screen_name {
            Some(name) => format!("https://api.fxtwitter.com/{name}/status/{}", parsed.tweet_id),
            None => format!("https://api.fxtwitter.com/i/status/{}", parsed.tweet_id),
        }
    };
    let json = fetch_json(client, &url).await?;
    let tweet = if use_v2 {
        get(&json, "status").or_else(|| get(&json, "tweet"))
    } else {
        get(&json, "tweet")
    }
    .ok_or_else(|| FetchError::new("fxtwitter 接口没有返回推文数据", "TWEET_FETCH_FAILED"))?;
    normalize_fx_tweet(tweet, "fxtwitter", &parsed.canonical_url)
        .ok_or_else(|| FetchError::new("fxtwitter 接口没有返回推文数据", "TWEET_FETCH_FAILED"))
}

async fn endpoint_syndication(
    client: &reqwest::Client,
    parsed: &ParsedTweet,
) -> Result<TweetInfo, FetchError> {
    let token = syndication_token(&parsed.tweet_id);
    let url = format!(
        "https://cdn.syndication.twimg.com/tweet-result?id={}&lang=en&token={}",
        parsed.tweet_id, token
    );
    let json = fetch_json(client, &url).await?;
    normalize_syndication(&json, &parsed.canonical_url)
        .ok_or_else(|| FetchError::new("syndication 接口没有返回推文数据", "TWEET_FETCH_FAILED"))
}

async fn endpoint_vx(client: &reqwest::Client, parsed: &ParsedTweet) -> Result<TweetInfo, FetchError> {
    let url = format!("https://api.vxtwitter.com/i/status/{}", parsed.tweet_id);
    let json = fetch_json(client, &url).await?;
    normalize_vx(&json, &parsed.canonical_url)
        .ok_or_else(|| FetchError::new("vxtwitter 接口没有返回推文数据", "TWEET_FETCH_FAILED"))
}

fn no_media_error() -> String {
    "该推文没有可转换的媒体（没有 GIF、视频或图片）".into()
}

pub async fn fetch_tweet(settings: &AppSettings, raw_url: &str) -> Result<TweetInfo, String> {
    let parsed = parse_tweet_url(raw_url)
        .ok_or_else(|| "链接格式不正确，请输入 X 或 Twitter 的推文链接（例如 https://x.com/user/status/1234567890）".to_string())?;
    let client = build_client(&settings.proxy)?;
    let mut errors: Vec<FetchError> = Vec::new();
    let mut empty_media: Option<TweetInfo> = None;

    let attempts: [&str; 4] = ["fxtwitter", "fxtwitter-v1", "syndication", "vxtwitter"];
    for attempt in attempts {
        let result = match attempt {
            "fxtwitter" => endpoint_fx(&client, &parsed, true).await,
            "fxtwitter-v1" => endpoint_fx(&client, &parsed, false).await,
            "syndication" => endpoint_syndication(&client, &parsed).await,
            _ => endpoint_vx(&client, &parsed).await,
        };
        match result {
            Ok(info) => {
                if !info.media.is_empty() {
                    remember(info.clone());
                    return Ok(info);
                }
                empty_media = Some(info);
            }
            Err(error) => errors.push(error),
        }
    }

    if let Some(info) = empty_media {
        remember(info);
        return Err(no_media_error());
    }
    let not_found_count = errors.iter().filter(|error| error.not_found).count();
    let protected_count = errors.iter().filter(|error| error.protected).count();
    if not_found_count >= 2 || (not_found_count >= 1 && errors.len() == not_found_count) {
        return Err("推文不存在或已被删除".into());
    }
    if protected_count >= 1 {
        return Err("该推文受保护或账号不可用，无法读取".into());
    }
    let detail = errors.last().map(|error| error.message.clone()).unwrap_or_else(|| "未知错误".into());
    Err(format!("网络请求失败，请检查网络后重试：{detail}"))
}
