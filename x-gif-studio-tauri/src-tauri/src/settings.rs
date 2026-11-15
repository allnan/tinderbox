// 设置读写：<exe>/userdata/settings.json（原子写入），字段与前端 AppSettings 一致。
#![allow(dead_code)]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::model::{AppSettings, ProxySettings};
use crate::paths::{self, ensure_dir};

pub fn default_params() -> Value {
    json!({
        "encoder": "gifski",
        "width": null,
        "maxLongSide": null,
        "fps": "source",
        "colors": 256,
        "quality": 92,
        "dither": "sierra2_4a",
        "preserveTiming": true,
        "optimize": false,
        "lossy": 0,
        "speed": 1,
        "loopCount": 0
    })
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        output_dir: None,
        cache_dir: None,
        default_params: default_params(),
        default_preset_id: "source".into(),
        keep_original_mp4: true,
        max_cache_size_mb: 4096.0,
        proxy: ProxySettings::default(),
        theme: "dark".into(),
    }
}

fn normalize(input: AppSettings) -> AppSettings {
    let fallback = default_settings();
    let proxy = input.proxy;
    AppSettings {
        output_dir: clean_dir(input.output_dir),
        cache_dir: clean_dir(input.cache_dir),
        default_params: if input.default_params.is_object() { input.default_params } else { fallback.default_params },
        default_preset_id: if ["source", "balanced", "small", "mini"].contains(&input.default_preset_id.as_str()) {
            input.default_preset_id
        } else {
            "source".into()
        },
        keep_original_mp4: input.keep_original_mp4,
        max_cache_size_mb: input.max_cache_size_mb.clamp(64.0, 1_048_576.0),
        proxy: ProxySettings {
            mode: if ["system", "custom", "direct"].contains(&proxy.mode.as_str()) { proxy.mode } else { "system".into() },
            url: proxy.url.trim().to_string(),
            bypass: if proxy.bypass.trim().is_empty() {
                "localhost;127.0.0.1;<local>".into()
            } else {
                proxy.bypass.trim().to_string()
            },
            username: proxy.username.trim().to_string(),
            password: proxy.password,
        },
        theme: if ["dark", "light", "system"].contains(&input.theme.as_str()) { input.theme } else { "dark".into() },
    }
}

fn clean_dir(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

pub fn settings_path() -> PathBuf {
    paths::data_dir().join("settings.json")
}

pub fn load() -> AppSettings {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<AppSettings>(&text) {
            Ok(settings) => normalize(settings),
            Err(_) => default_settings(),
        },
        Err(_) => default_settings(),
    }
}

/// 校验代理地址：合法返回规范化的 url，非法返回中文错误。
pub fn validate_proxy(proxy: &ProxySettings) -> Result<(), String> {
    if proxy.mode != "custom" {
        return Ok(());
    }
    let raw = proxy.url.trim();
    if raw.is_empty() {
        return Err("请填写代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let parsed = reqwest::Url::parse(&with_scheme)
        .map_err(|_| format!("代理地址格式不正确：{raw}"))?;
    let scheme = parsed.scheme();
    if !["http", "https", "socks5", "socks4"].contains(&scheme) {
        return Err(format!("不支持的代理协议：{scheme}（支持 http / https / socks5）"));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(format!("代理地址缺少主机名：{raw}"));
    }
    Ok(())
}

pub fn save(input: AppSettings) -> Result<AppSettings, String> {
    let normalized = normalize(input);
    validate_proxy(&normalized.proxy)?;
    let text = serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?;
    let path = settings_path();
    if let Ok(old) = std::fs::read_to_string(&path) {
        let _ = std::fs::write(path.with_extension("json.bak"), old);
    }
    paths::atomic_write(&path, text.as_bytes())?;
    Ok(normalized)
}

pub fn effective_output_dir(settings: &AppSettings) -> PathBuf {
    match settings.output_dir.as_deref() {
        Some(dir) if !dir.trim().is_empty() => ensure_dir(Path::new(dir).to_path_buf()),
        _ => paths::output_dir_default(),
    }
}

pub fn effective_cache_dir(settings: &AppSettings) -> PathBuf {
    match settings.cache_dir.as_deref() {
        Some(dir) if !dir.trim().is_empty() => ensure_dir(Path::new(dir).to_path_buf()),
        _ => paths::cache_dir(),
    }
}
