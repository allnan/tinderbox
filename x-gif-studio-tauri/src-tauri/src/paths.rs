// 路径与通用工具：便携数据目录（exe 同级 userdata）、文件名清洗、ISO 时间、原子写入。
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    ensure_dir(exe_dir().join("userdata"))
}

pub fn cache_dir() -> PathBuf {
    ensure_dir(data_dir().join("cache"))
}

pub fn media_cache_dir() -> PathBuf {
    ensure_dir(cache_dir().join("media"))
}

pub fn thumbs_dir() -> PathBuf {
    ensure_dir(cache_dir().join("thumbs"))
}

pub fn output_dir_default() -> PathBuf {
    ensure_dir(data_dir().join("media"))
}

pub fn logs_dir() -> PathBuf {
    ensure_dir(data_dir().join("logs"))
}

pub fn frames_root() -> PathBuf {
    ensure_dir(cache_dir().join("frames"))
}

/// 外部工具目录：优先 exe 同级 tools/，其次 userdata/tools。
pub fn tools_dir() -> PathBuf {
    let beside_exe = exe_dir().join("tools");
    if beside_exe.exists() {
        return beside_exe;
    }
    let fallback = data_dir().join("tools");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

pub fn ensure_dir(path: PathBuf) -> PathBuf {
    let _ = fs::create_dir_all(&path);
    path
}

pub fn safe_name(value: &str, fallback: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        if result.len() >= 60 {
            break;
        }
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            result.push('-');
        } else {
            result.push(ch);
        }
    }
    let collapsed = result.split_whitespace().collect::<Vec<_>>().join("-");
    let collapsed = collapse_dashes(&collapsed);
    let trimmed = collapsed.trim_start_matches('.').trim_matches('-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn collapse_dashes(value: &str) -> String {
    let mut result = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch == '-' {
            if !last_dash {
                result.push('-');
            }
            last_dash = true;
        } else {
            result.push(ch);
            last_dash = false;
        }
    }
    result
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// 生成 UTC ISO8601（毫秒）字符串，供前端 Date 解析。
pub fn iso_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    let hour = sod / 3600;
    let minute = (sod % 3600) / 60;
    let second = sod % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
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
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

pub fn format_timestamp(date: SystemTime) -> String {
    let duration = date.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year,
        month,
        day,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

pub fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension().and_then(|ext| ext.to_str()).unwrap_or("tmp"),
        now_ms()
    ));
    fs::write(&tmp, bytes).map_err(|error| format!("写入临时文件失败：{error}"))?;
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).map_err(|error| format!("重命名输出文件失败：{error}"))?;
    Ok(())
}

pub fn copy_atomic(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = target.with_extension(format!(
        "{}.tmp-{}",
        target.extension().and_then(|ext| ext.to_str()).unwrap_or("tmp"),
        now_ms()
    ));
    fs::copy(source, &tmp).map_err(|error| format!("复制文件失败：{error}"))?;
    let _ = fs::remove_file(target);
    fs::rename(&tmp, target).map_err(|error| format!("写入输出文件失败：{error}"))?;
    Ok(())
}

pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("");
    for index in 2..100 {
        let name = if ext.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{ext}")
        };
        candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}.{}", now_ms(), ext))
}
