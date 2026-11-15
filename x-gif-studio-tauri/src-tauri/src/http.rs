// 网络请求：按设置构造 reqwest Client（自定义代理 / 系统代理 / 直连），JSON 抓取与流式下载。
#![allow(dead_code)]

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use reqwest::{Client, Proxy};
use serde_json::Value;

use crate::model::ProxySettings;
use crate::paths::now_ms;

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
pub const MAX_DOWNLOAD_BYTES: u64 = 600 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct FetchError {
    pub message: String,
    pub code: String,
    pub not_found: bool,
    pub protected: bool,
    pub network: bool,
}

impl FetchError {
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self {
            message: message.into(),
            code: code.to_string(),
            not_found: false,
            protected: false,
            network: false,
        }
    }

    fn network(message: impl Into<String>, code: &str) -> Self {
        let mut error = Self::new(message, code);
        error.network = true;
        error
    }
}

/// 读取 Windows 系统代理（Internet 选项），失败返回 None。
fn system_proxy() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
            .ok()?;
        let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        if enabled == 0 {
            return None;
        }
        let server: String = key.get_value("ProxyServer").ok()?;
        return parse_proxy_server(&server);
    }
    #[cfg(not(windows))]
    {
        std::env::var("HTTPS_PROXY")
            .ok()
            .or_else(|| std::env::var("https_proxy").ok())
            .or_else(|| std::env::var("HTTP_PROXY").ok())
    }
}

fn parse_proxy_server(server: &str) -> Option<String> {
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    if server.contains('=') {
        for part in server.split(';') {
            if let Some(value) = part.trim().strip_prefix("http=") {
                if !value.is_empty() {
                    return Some(format!("http://{value}"));
                }
            }
        }
        for part in server.split(';') {
            if let Some(value) = part.trim().strip_prefix("https=") {
                if !value.is_empty() {
                    return Some(format!("http://{value}"));
                }
            }
        }
        return None;
    }
    Some(format!("http://{server}"))
}

pub fn normalize_proxy_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("请填写代理地址".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let parsed = reqwest::Url::parse(&with_scheme).map_err(|_| format!("代理地址格式不正确：{raw}"))?;
    let scheme = parsed.scheme();
    if !["http", "https", "socks5", "socks4"].contains(&scheme) {
        return Err(format!("不支持的代理协议：{scheme}（支持 http / https / socks5）"));
    }
    Ok(parsed.to_string())
}

fn configured_proxy(url: &str, proxy: &ProxySettings) -> Result<Proxy, String> {
    let mut configured = Proxy::all(url).map_err(|error| format!("代理配置无效：{error}"))?;
    if !proxy.username.is_empty() || !proxy.password.is_empty() {
        configured = configured.basic_auth(&proxy.username, &proxy.password);
    }
    if !proxy.bypass.trim().is_empty() {
        if let Some(no_proxy) = reqwest::NoProxy::from_string(&proxy.bypass) {
            configured = configured.no_proxy(Some(no_proxy));
        }
    }
    Ok(configured)
}

pub fn build_client(proxy: &ProxySettings) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15));
    match proxy.mode.as_str() {
        "custom" => {
            let url = normalize_proxy_url(&proxy.url)?;
            builder = builder.proxy(configured_proxy(&url, proxy)?);
        }
        "system" => {
            if let Some(url) = system_proxy() {
                builder = builder.proxy(configured_proxy(&url, proxy)?);
            }
        }
        _ => {}
    }
    builder
        .build()
        .map_err(|error| format!("初始化网络客户端失败：{error}"))
}

/// 构造一个不走代理的客户端（用于代理连通性测试的最后一项对照）。
pub fn build_direct_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("初始化网络客户端失败：{error}"))
}

pub async fn fetch_json(client: &Client, url: &str) -> Result<Value, FetchError> {
    let response = client
        .get(url)
        .header("accept", "application/json, text/plain, */*")
        .header("accept-language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                FetchError::network("请求超时", "NETWORK_ERROR")
            } else {
                FetchError::network(format!("网络连接失败：{error}"), "NETWORK_ERROR")
            }
        })?;
    let status = response.status().as_u16();
    if status == 404 {
        let mut error = FetchError::new("推文不存在或已被删除", "TWEET_NOT_FOUND");
        error.not_found = true;
        return Err(error);
    }
    if status == 401 || status == 403 {
        let mut error = FetchError::new("该推文受保护或账号不可用，无法读取", "TWEET_PROTECTED");
        error.protected = true;
        return Err(error);
    }
    if status == 429 {
        return Err(FetchError::network("请求过于频繁，请稍后再试", "TWEET_RATE_LIMIT"));
    }
    if !(200..300).contains(&status) {
        return Err(FetchError::network(
            format!("接口请求失败（HTTP {status}）"),
            "TWEET_FETCH_FAILED",
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|error| FetchError::network(format!("读取接口数据失败：{error}"), "NETWORK_ERROR"))?;
    serde_json::from_str::<Value>(&text)
        .map_err(|_| FetchError::network("接口返回了无法解析的数据", "TWEET_FETCH_FAILED"))
}

/// 流式下载文件（媒体/工具），返回字节数。
pub async fn download_to_file(
    client: &Client,
    url: &str,
    dest: &Path,
    max_bytes: u64,
    timeout_secs: u64,
    on_progress: &mut (impl FnMut(u64, u64) + Send),
) -> Result<u64, String> {
    let response = client
        .get(url)
        .header("accept", "video/mp4,video/*;q=0.9,image/*;q=0.8,*/*;q=0.5")
        .timeout(Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "下载超时，请检查网络或代理后重试".to_string()
            } else {
                format!("网络连接失败，无法下载：{error}")
            }
        })?;
    let status = response.status().as_u16();
    if status == 404 || status == 403 || status == 410 {
        return Err(format!("文件不存在或已过期（HTTP {status}），请重新解析推文"));
    }
    if !(200..300).contains(&status) {
        return Err(format!("下载失败（HTTP {status}）"));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if content_type.contains("text/html") {
        return Err("下载被拒绝（返回了网页而不是媒体文件）".into());
    }
    let total = response.content_length().unwrap_or(0);
    if total > max_bytes {
        return Err("文件过大，暂不支持".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = dest.with_extension(format!(
        "{}.part-{}",
        dest.extension().and_then(|ext| ext.to_str()).unwrap_or("tmp"),
        now_ms()
    ));
    let mut file = std::fs::File::create(&temporary).map_err(|error| format!("创建下载文件失败：{error}"))?;
    let mut received: u64 = 0;
    let mut last_report = 0u128;
    let mut response = response;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                received += chunk.len() as u64;
                if received > max_bytes {
                    drop(file);
                    let _ = std::fs::remove_file(&temporary);
                    return Err("文件过大，暂不支持".into());
                }
                file.write_all(&chunk).map_err(|error| format!("写入下载文件失败：{error}"))?;
                let now = now_ms();
                if now.saturating_sub(last_report) > 250 {
                    last_report = now;
                    on_progress(received, total);
                }
            }
            Ok(None) => break,
            Err(error) => {
                drop(file);
                let _ = std::fs::remove_file(&temporary);
                return Err(format!("下载中断：{error}"));
            }
        }
    }
    drop(file);
    if received == 0 {
        let _ = std::fs::remove_file(&temporary);
        return Err("下载到的文件为空，请稍后重试".into());
    }
    if total > 0 && received < total {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("下载不完整：{received} / {total} 字节"));
    }
    std::fs::rename(&temporary, dest).map_err(|error| format!("保存下载文件失败：{error}"))?;
    on_progress(received, total.max(received));
    Ok(received)
}

/// 下载到内存（图片）。
pub async fn fetch_bytes(
    client: &Client,
    url: &str,
    max_bytes: u64,
    timeout_secs: u64,
    on_progress: &mut (impl FnMut(u64, u64) + Send),
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header("accept", "image/*,*/*;q=0.8")
        .timeout(Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "图片下载超时，请检查网络或代理后重试".to_string()
            } else {
                format!("网络连接失败，无法下载图片：{error}")
            }
        })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("图片下载失败（HTTP {status}）"));
    }
    let total = response.content_length().unwrap_or(0);
    if total > max_bytes {
        return Err("图片过大，暂不支持保存".into());
    }
    let mut buffer: Vec<u8> = Vec::new();
    let mut response = response;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                buffer.extend_from_slice(&chunk);
                if buffer.len() as u64 > max_bytes {
                    return Err("图片过大，暂不支持保存".into());
                }
                on_progress(buffer.len() as u64, total);
            }
            Ok(None) => break,
            Err(error) => return Err(format!("图片下载中断：{error}")),
        }
    }
    if buffer.is_empty() {
        return Err("下载到的图片为空".into());
    }
    Ok(buffer)
}