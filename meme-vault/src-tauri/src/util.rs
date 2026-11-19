use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::AppError;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id(prefix: &str) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("{}_{}", prefix, &raw[..16])
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

pub fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let text = serde_json::to_vec_pretty(value)
        .map_err(|error| AppError::new("serialize", format!("写入数据失败：{}", error)))?;
    write_bytes_atomic(path, &text)
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|value| value.to_str()).unwrap_or("dat")
    ));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn format_timestamp(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year, month, day, hour, minute, second
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn clean_text(value: &str, max_chars: usize) -> String {
    let filtered: String = value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    filtered.chars().take(max_chars).collect::<String>()
}

pub fn unique_strings(values: &[String], max_len: usize, max_count: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in values {
        let value = clean_text(raw, max_len);
        if value.is_empty() {
            continue;
        }
        let key = value.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(value);
        if out.len() >= max_count {
            break;
        }
    }
    out
}

pub fn normalize_ext(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let ext = lower
        .rsplit('.')
        .next()
        .filter(|_| lower.contains('.'))
        .unwrap_or("");
    let normalized = match ext {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        "avif" => "avif",
        _ => return None,
    };
    Some(normalized.to_string())
}

pub fn safe_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "bmp" => Some("bmp"),
        "avif" => Some("avif"),
        _ => None,
    }
}

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub fn display_name(raw: &str, fallback: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw)
        .to_string();
    let stem = match base.rfind('.') {
        Some(index) if base.len() - index <= 6 => base[..index].to_string(),
        _ => base,
    };
    let cleaned = clean_text(
        &stem.replace(['_', '%', '+'], " ").split_whitespace().collect::<Vec<_>>().join(" "),
        60,
    );
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

pub fn human_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    let kb = bytes as f64 / 1024.0;
    if kb < 1024.0 {
        return format!("{:.1} KB", kb);
    }
    let mb = kb / 1024.0;
    if mb < 1024.0 {
        return format!("{:.1} MB", mb);
    }
    format!("{:.2} GB", mb / 1024.0)
}

pub fn normalize_color(color: &str) -> String {
    let value = color.trim();
    if value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|ch| ch.is_ascii_hexdigit()) {
        value.to_string()
    } else {
        "#96a0a8".to_string()
    }
}

pub fn color_for_name(name: &str) -> String {
    const PALETTE: [&str; 10] = [
        "#f5b942", "#8f9fd9", "#b79df0", "#ef7a63", "#f292b8", "#6fc2a4", "#6f9fd8", "#96a0a8",
        "#e2a455", "#7bb0a6",
    ];
    let mut hash: u32 = 0;
    for ch in name.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as u32);
    }
    PALETTE[(hash as usize) % PALETTE.len()].to_string()
}

