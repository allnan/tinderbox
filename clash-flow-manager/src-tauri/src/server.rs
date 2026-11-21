use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
    thread,
};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProfileMetadata {
    name: String,
    subscription_info: Option<crate::model::SubscriptionInfo>,
}

fn content_disposition(name: &str) -> String {
    let mut fallback = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "-_. ".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    if fallback.is_empty() {
        fallback = "Clash Flow Manager".into();
    }
    let utf8_name = name.to_string();
    format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        fallback,
        utf8_percent_encode(&utf8_name, NON_ALPHANUMERIC)
    )
}

fn subscription_userinfo(info: Option<crate::model::SubscriptionInfo>) -> Option<String> {
    let info = info?;
    let total = info.total_bytes?;
    let remaining = info.remaining_bytes;
    let upload = info.upload_bytes;
    let download = info.download_bytes;
    let (upload, download) = match (upload, download, remaining) {
        (Some(upload), Some(download), _) => (upload, download),
        (Some(upload), None, Some(remaining)) => (
            upload,
            total.saturating_sub(remaining).saturating_sub(upload),
        ),
        (None, Some(download), Some(remaining)) => (
            total.saturating_sub(remaining).saturating_sub(download),
            download,
        ),
        (None, None, Some(remaining)) => (0, total.saturating_sub(remaining)),
        _ => return None,
    };
    let expires = chrono::NaiveDate::parse_from_str(&info.expires_at, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc().timestamp())
        .unwrap_or(0);
    Some(format!(
        "upload={upload}; download={download}; total={total}; expire={expires}"
    ))
}

fn serve(
    mut stream: TcpStream,
    profile_path: &PathBuf,
    profile_route: &str,
    last_requested_at: &AtomicI64,
    legacy_needs_update: &AtomicBool,
) {
    let mut request = [0u8; 4096];
    let Ok(length) = stream.read(&mut request) else {
        return;
    };
    let line = String::from_utf8_lossy(&request[..length])
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let allowed = line.starts_with("GET ") && line.split_whitespace().nth(1) == Some(profile_route);
    if allowed {
        let requested_at = chrono::Utc::now().timestamp_millis();
        last_requested_at.store(requested_at, Ordering::Relaxed);
        legacy_needs_update.store(false, Ordering::Relaxed);
        let request_time_path = profile_path.with_file_name("profile-last-requested-at.txt");
        let _ = fs::write(request_time_path, requested_at.to_string());
        let body = fs::read(profile_path).unwrap_or_else(|_| {
            b"proxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n".to_vec()
        });
        let metadata_path = profile_path.with_file_name("profile-metadata.json");
        let metadata = fs::read(metadata_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ProfileMetadata>(&bytes).ok())
            .unwrap_or_default();
        let name = if metadata.name.trim().is_empty() {
            "Clash 管家"
        } else {
            metadata.name.trim()
        };
        let mut header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/yaml; charset=utf-8\r\nContent-Disposition: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n",
            content_disposition(name), body.len()
        );
        if let Some(userinfo) = subscription_userinfo(metadata.subscription_info) {
            header.push_str(&format!("Subscription-Userinfo: {userinfo}\r\n"));
        }
        header.push_str("\r\n");
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(&body);
    } else {
        let body = b"Not found";
        let header = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
    }
}

pub fn start(
    profile_path: PathBuf,
    preferred_port: u16,
    token: String,
    last_requested_at: Arc<AtomicI64>,
    legacy_needs_update: Arc<AtomicBool>,
) -> Result<u16, String> {
    let route = format!("/profile/{token}.yaml");
    let listener = (preferred_port..preferred_port.saturating_add(24))
        .filter_map(|port| {
            TcpListener::bind(("127.0.0.1", port))
                .ok()
                .map(|listener| (port, listener))
        })
        .next()
        .ok_or_else(|| "无法启动本机配置服务：39127 附近端口均已被占用".to_string())?;
    let (port, listener) = listener;
    thread::Builder::new()
        .name("clash-profile-http".into())
        .spawn(move || {
            for incoming in listener.incoming() {
                if let Ok(stream) = incoming {
                    let path = profile_path.clone();
                    let route = route.clone();
                    let last_requested_at = Arc::clone(&last_requested_at);
                    let legacy_needs_update = Arc::clone(&legacy_needs_update);
                    let _ = thread::Builder::new()
                        .name("clash-profile-request".into())
                        .spawn(move || {
                            serve(
                                stream,
                                &path,
                                &route,
                                &last_requested_at,
                                &legacy_needs_update,
                            );
                        });
                }
            }
        })
        .map_err(|error| format!("启动本机配置服务失败：{error}"))?;
    Ok(port)
}
