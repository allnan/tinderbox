use base64::{engine::general_purpose, Engine as _};
use percent_encoding::percent_decode_str;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use url::Url;

use crate::model::{ProxyNode, Source, SubscriptionInfo};

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let compact = value
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    [
        &general_purpose::STANDARD,
        &general_purpose::STANDARD_NO_PAD,
        &general_purpose::URL_SAFE,
        &general_purpose::URL_SAFE_NO_PAD,
    ]
    .into_iter()
    .find_map(|engine| engine.decode(compact.as_bytes()).ok())
}

fn decode_component(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().to_string()
}

fn decode_base64_text(value: &str) -> Option<String> {
    let decoded = decode_base64(value)?;
    String::from_utf8(decoded).ok()
}

fn summarize_parse_errors(errors: &[String]) -> String {
    let mut seen = HashSet::new();
    let unique = errors
        .iter()
        .filter(|error| seen.insert((*error).clone()))
        .cloned()
        .collect::<Vec<_>>();
    let shown = unique.iter().take(3).cloned().collect::<Vec<_>>();
    let remaining = unique.len().saturating_sub(shown.len());
    if remaining > 0 {
        format!("{}；另有 {remaining} 类错误", shown.join("；"))
    } else {
        shown.join("；")
    }
}

fn country_from_name(name: &str, hint: &str) -> (String, String) {
    let candidates = [
        ("香港", "hong kong|hongkong|hk|香港|🇭🇰", "🇭🇰"),
        ("台湾", "taiwan|tw|台湾|台灣|🇹🇼", "🇹🇼"),
        ("日本", "japan|jp|日本|东京|大阪|🇯🇵", "🇯🇵"),
        ("新加坡", "singapore|sg|新加坡|🇸🇬", "🇸🇬"),
        ("美国", "united states|usa|us|美国|洛杉矶|🇺🇸", "🇺🇸"),
        ("英国", "united kingdom|uk|英国|伦敦|🇬🇧", "🇬🇧"),
        ("韩国", "south korea|kr|韩国|首尔|🇰🇷", "🇰🇷"),
        ("德国", "germany|de|德国|🇩🇪", "🇩🇪"),
        ("法国", "france|fr|法国|🇫🇷", "🇫🇷"),
        ("加拿大", "canada|ca|加拿大|🇨🇦", "🇨🇦"),
        ("澳大利亚", "australia|au|澳大利亚|🇦🇺", "🇦🇺"),
        ("荷兰", "netherlands|nl|荷兰|🇳🇱", "🇳🇱"),
        ("俄罗斯", "russia|ru|俄罗斯|🇷🇺", "🇷🇺"),
        ("中国", "china|cn|中国|🇨🇳", "🇨🇳"),
        ("泰国", "thailand|th|泰国|曼谷|🇹🇭", "🇹🇭"),
        ("越南", "vietnam|vn|越南|🇻🇳", "🇻🇳"),
        ("马来西亚", "malaysia|my|马来西亚|🇲🇾", "🇲🇾"),
        ("菲律宾", "philippines|ph|菲律宾|🇵🇭", "🇵🇭"),
        ("印度", "india|in|印度|🇮🇳", "🇮🇳"),
        ("瑞士", "switzerland|ch|瑞士|🇨🇭", "🇨🇭"),
        ("土耳其", "turkey|tr|土耳其|🇹🇷", "🇹🇷"),
        ("巴西", "brazil|br|巴西|🇧🇷", "🇧🇷"),
    ];
    for text in [name, hint] {
        let text = text.to_lowercase();
        for (country, patterns, flag) in candidates {
            if patterns.split('|').any(|part| {
                if part.chars().all(|ch| ch.is_ascii_alphabetic()) && part.len() <= 3 {
                    text.split(|ch: char| !ch.is_ascii_alphanumeric())
                        .any(|token| token == part)
                } else {
                    text.contains(part)
                }
            }) {
                return (country.into(), flag.into());
            }
        }
    }
    ("未识别".into(), "🌐".into())
}

fn value_after_marker<'a>(text: &'a str, markers: &[&str]) -> Option<&'a str> {
    let lower = text.to_ascii_lowercase();
    markers.iter().find_map(|marker| {
        lower
            .find(&marker.to_ascii_lowercase())
            .map(|index| &text[index + marker.len()..])
    })
}

fn trim_notice_value(value: &str) -> &str {
    value.trim_start_matches(|character: char| {
        character.is_whitespace() || ":：=|->＞".contains(character)
    })
}

fn parse_notice_bytes_label(value: &str) -> Option<String> {
    let value = trim_notice_value(value);
    let end = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let amount = value[..end].parse::<f64>().ok()?;
    let unit = value[end..]
        .trim_start()
        .split(|character: char| character.is_whitespace() || ",，;；/|()（）".contains(character))
        .next()
        .unwrap_or_default();
    let unit_lower = unit.to_ascii_lowercase();
    if ![
        "b", "byte", "bytes", "kb", "kib", "mb", "mib", "gb", "gib", "tb", "tib",
    ]
    .iter()
    .any(|known| unit_lower == *known)
    {
        return None;
    }
    Some(format!("{} {}", amount, unit.to_ascii_uppercase()))
}

fn parse_notice_expiry(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if ["长期有效", "永久有效", "永久", "unlimited", "never"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return Some("长期有效".into());
    }
    let parts = value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .take(3)
        .collect::<Vec<_>>();
    let (year, month, day) = if parts.len() == 1 && parts[0].len() == 8 {
        (
            parts[0][0..4].parse::<i32>().ok()?,
            parts[0][4..6].parse::<u32>().ok()?,
            parts[0][6..8].parse::<u32>().ok()?,
        )
    } else if parts.len() >= 3 && parts[0].len() == 4 {
        (
            parts[0].parse::<i32>().ok()?,
            parts[1].parse::<u32>().ok()?,
            parts[2].parse::<u32>().ok()?,
        )
    } else {
        return None;
    };
    chrono::NaiveDate::from_ymd_opt(year, month, day)
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn parse_notice_days(value: &str) -> Option<u64> {
    let value = trim_notice_value(value);
    let start = value.find(|character: char| character.is_ascii_digit())?;
    let digits = value[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

fn host_from_url(value: &str) -> String {
    let candidate = value
        .trim()
        .trim_matches(|character: char| "\"'<>[]()（）,，;；。".contains(character));
    let parsed =
        url::Url::parse(candidate).or_else(|_| url::Url::parse(&format!("https://{candidate}")));
    parsed
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn parse_userinfo(info: &mut SubscriptionInfo, value: &str) {
    let mut expire = None;
    for item in value.split(';') {
        let Some((key, raw_value)) = item.split_once('=') else {
            continue;
        };
        let Ok(number) = raw_value.trim().parse::<u64>() else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "upload" => info.upload_bytes = Some(number),
            "download" => info.download_bytes = Some(number),
            "total" => info.total_bytes = (number > 0).then_some(number),
            "expire" => expire = (number > 0).then_some(number),
            _ => {}
        }
    }
    if let Some(timestamp) = expire.and_then(|value| i64::try_from(value).ok()) {
        info.expires_at = chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)
            .map(|date| date.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
    }
}

/// Reads subscription quota metadata from common HTTP headers and provider notice text.
pub fn parse_subscription_info(
    userinfo: Option<&str>,
    profile_title: Option<&str>,
    profile_web_page_url: Option<&str>,
    body: &str,
) -> Option<SubscriptionInfo> {
    let mut info = SubscriptionInfo::default();
    if let Some(value) = userinfo {
        parse_userinfo(&mut info, value);
    }
    info.package_name = profile_title.unwrap_or_default().trim().to_string();
    info.official_url = profile_web_page_url
        .map(host_from_url)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();

    let decoded = decode_base64_text(body.trim());
    for text in std::iter::once(body).chain(decoded.as_deref()) {
        for line in text.lines() {
            if info.remaining_bytes.is_none() && info.remaining_label.is_empty() {
                if let Some(value) = value_after_marker(
                    line,
                    &[
                        "剩余流量",
                        "可用流量",
                        "remaining traffic",
                        "remaining data",
                    ],
                ) {
                    if let Some(label) = parse_notice_bytes_label(value) {
                        info.remaining_label = label;
                    }
                }
            }
            if info.reset_after_days.is_none() {
                if let Some(value) = value_after_marker(
                    line,
                    &["距离下次重置剩余", "距下次重置剩余", "下次重置", "reset in"],
                ) {
                    info.reset_after_days = parse_notice_days(value);
                }
            }
            if info.expires_at.is_empty() {
                if let Some(value) = value_after_marker(
                    line,
                    &["套餐到期", "到期时间", "到期日期", "expiry", "expire"],
                ) {
                    info.expires_at = parse_notice_expiry(value).unwrap_or_default();
                }
            }
            if info.official_url.is_empty() {
                if let Some(value) =
                    value_after_marker(line, &["官方发布页", "官方页面", "官网", "official page"])
                {
                    info.official_url = host_from_url(trim_notice_value(value));
                }
            }
        }
    }
    if let (Some(total), Some(upload), Some(download)) =
        (info.total_bytes, info.upload_bytes, info.download_bytes)
    {
        let used = upload.saturating_add(download);
        info.remaining_bytes = Some(total.saturating_sub(used));
    }
    let has_metadata = !info.package_name.is_empty()
        || info.upload_bytes.is_some()
        || info.download_bytes.is_some()
        || info.total_bytes.is_some()
        || !info.remaining_label.is_empty()
        || !info.expires_at.is_empty()
        || info.reset_after_days.is_some()
        || !info.official_url.is_empty();
    has_metadata.then_some(info)
}

pub fn is_provider_notice_name(name: &str) -> bool {
    let name = name.trim().to_lowercase();
    [
        "不支持本机场协议",
        "客户端不支持",
        "请更换以下支持协议",
        "支持协议的代理软件",
        "win客户端:",
        "mac客户端:",
        "安卓客户端:",
        "ios客户端:",
        "iphone客户端:",
        "unsupported client",
        "client is not supported",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

pub fn is_provider_metadata_notice_name(name: &str) -> bool {
    let name = name.trim().to_lowercase();
    [
        "剩余流量",
        "可用流量",
        "已用流量",
        "距离下次重置",
        "距下次重置",
        "下次重置",
        "套餐到期",
        "到期时间",
        "到期日期",
        "官方发布页",
        "官方页面",
        "官网",
        "remaining traffic",
        "remaining data",
        "reset in",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

fn is_provider_compatibility_notice(text: &str) -> bool {
    text.lines().any(is_provider_notice_name)
        || ["请更换以下", "当前客户端不支持", "客户端: v2rayn"]
            .iter()
            .any(|marker| text.to_lowercase().contains(marker))
}

fn provider_compatibility_error() -> String {
    "服务商返回了客户端/协议说明，没有提供可用节点。请在服务商后台选择 Clash Verge、Clash Meta 或 Mihomo 兼容的订阅类型，再复制对应的原始订阅链接。".into()
}

fn is_supported_proxy_type(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "anytls"
            | "direct"
            | "dns"
            | "easytier"
            | "http"
            | "hysteria"
            | "hysteria2"
            | "masque"
            | "mieru"
            | "openvpn"
            | "pass"
            | "reject"
            | "reject-drop"
            | "rematch"
            | "shadowquic"
            | "shadowtls"
            | "snell"
            | "socks"
            | "socks5"
            | "ss"
            | "ssr"
            | "sudoku"
            | "tailscale"
            | "trojan"
            | "tuic"
            | "trusttunnel"
            | "vless"
            | "vmess"
            | "wireguard"
            | "ssh"
            | "zerotier"
    )
}

fn is_valid_proxy_entry(node: &Value) -> bool {
    let Some(object) = node.as_object() else {
        return false;
    };
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let proxy_type = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| is_supported_proxy_type(value));
    let server = object
        .get("server")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let port = object
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .or_else(|| {
            object
                .get("port")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u16>().ok())
        })
        .filter(|port| *port > 0);

    name.is_some_and(|value| !is_provider_notice_name(value))
        && proxy_type.is_some()
        && server.is_some()
        && port.is_some()
}

fn node_config_from_yaml(raw: &str) -> Result<Vec<Value>, String> {
    let parsed: Value = serde_yaml::from_str(raw).map_err(|error| error.to_string())?;
    let nodes = parsed
        .get("proxies")
        .and_then(Value::as_array)
        .ok_or_else(|| "内容不是带 proxies 列表的 Clash 配置".to_string())?;
    let contains_provider_notice = nodes.iter().any(|node| {
        node.get("name")
            .and_then(Value::as_str)
            .is_some_and(is_provider_notice_name)
    });
    let usable = nodes
        .iter()
        .filter(|node| is_valid_proxy_entry(node))
        .cloned()
        .collect::<Vec<_>>();
    if usable.is_empty() {
        if contains_provider_notice || is_provider_compatibility_notice(raw) {
            return Err(provider_compatibility_error());
        }
        return Err(format!(
            "Clash YAML 的 proxies 列表有 {} 条记录，但没有有效节点；节点必须包含有效名称、已知协议类型、服务器地址和 1–65535 范围内的端口。",
            nodes.len()
        ));
    }
    Ok(usable)
}

fn parse_clash_yaml(raw: &str) -> Option<Result<Vec<Value>, String>> {
    let parsed: Value = serde_yaml::from_str(raw).ok()?;
    parsed
        .get("proxies")
        .and_then(Value::as_array)
        .map(|_| node_config_from_yaml(raw))
}

fn parse_vmess(uri: &str) -> Result<Value, String> {
    let encoded = uri.trim_start_matches("vmess://");
    let bytes = decode_base64(encoded).ok_or_else(|| "vmess 节点编码无法识别".to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "vmess 节点内容不是 UTF-8".to_string())?;
    let data: Value =
        serde_json::from_str(&text).map_err(|error| format!("vmess 节点内容错误：{error}"))?;
    let old_name = data.get("ps").and_then(Value::as_str).unwrap_or("VMess");
    let server = data.get("add").and_then(Value::as_str).unwrap_or("");
    let port = data
        .get("port")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            data.get("port")
                .and_then(Value::as_str)
                .and_then(|v| v.parse().ok())
        })
        .unwrap_or(443);
    if server.is_empty() {
        return Err("vmess 节点缺少服务器地址".into());
    }
    let network = data.get("net").and_then(Value::as_str).unwrap_or("tcp");
    let tls = data.get("tls").and_then(Value::as_str).unwrap_or("");
    let mut node = json!({
        "name": old_name,
        "type": "vmess",
        "server": server,
        "port": port,
        "uuid": data.get("id").and_then(Value::as_str).unwrap_or(""),
        "alterId": data.get("aid").and_then(|v| v.as_u64()).or_else(|| data.get("aid").and_then(Value::as_str).and_then(|v| v.parse().ok())).unwrap_or(0),
        "cipher": data.get("scy").and_then(Value::as_str).filter(|v| !v.is_empty()).unwrap_or("auto"),
        "udp": true
    });
    if tls.eq_ignore_ascii_case("tls") {
        node["tls"] = json!(true);
        if let Some(sni) = data
            .get("sni")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            node["servername"] = json!(sni);
        }
    }
    if network == "ws" {
        let mut headers = Map::new();
        if let Some(host) = data
            .get("host")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            headers.insert("Host".into(), json!(host));
        }
        node["network"] = json!("ws");
        node["ws-opts"] = json!({
            "path": data.get("path").and_then(Value::as_str).unwrap_or("/"),
            "headers": headers
        });
    } else if network == "grpc" {
        node["network"] = json!("grpc");
        node["grpc-opts"] =
            json!({"grpc-service-name": data.get("path").and_then(Value::as_str).unwrap_or("")});
    }
    Ok(node)
}

fn parse_ssr(uri: &str) -> Result<Value, String> {
    let encoded = uri.trim_start_matches("ssr://");
    let decoded = decode_base64_text(encoded).ok_or_else(|| "SSR 节点编码无法识别".to_string())?;
    let (main, query) = decoded.split_once("/?").unwrap_or((&decoded, ""));
    let fields = main.split(':').collect::<Vec<_>>();
    if fields.len() < 6 {
        return Err("SSR 节点字段不完整".into());
    }
    let server = fields[0];
    let port = fields[1].parse::<u16>().map_err(|_| "SSR 节点端口无效")?;
    let password = decode_base64_text(fields[5]).ok_or_else(|| "SSR 密码无法解码".to_string())?;
    let params =
        Url::parse(&format!("http://localhost/?{query}")).map_err(|_| "SSR 节点参数无法解析")?;
    let mut values = HashMap::new();
    for (key, value) in params.query_pairs() {
        values.insert(key.to_lowercase(), value.into_owned());
    }
    let name = values
        .get("remarks")
        .and_then(|value| decode_base64_text(value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| server.to_string());
    let mut node = json!({
        "name": name,
        "type": "ssr",
        "server": server,
        "port": port,
        "cipher": fields[3],
        "password": password,
        "protocol": fields[2],
        "obfs": fields[4],
        "udp": true
    });
    if let Some(value) = values
        .get("protoparam")
        .and_then(|value| decode_base64_text(value))
    {
        node["protocol-param"] = json!(value);
    }
    if let Some(value) = values
        .get("obfsparam")
        .and_then(|value| decode_base64_text(value))
    {
        node["obfs-param"] = json!(value);
    }
    Ok(node)
}

fn parse_share_uri(uri: &str) -> Result<Value, String> {
    if uri.starts_with("vmess://") {
        return parse_vmess(uri);
    }
    if uri.starts_with("ssr://") {
        return parse_ssr(uri);
    }
    let parsed = Url::parse(uri).map_err(|error| format!("节点链接无法解析：{error}"))?;
    let scheme = parsed.scheme().to_lowercase();
    let host = parsed
        .host_str()
        .ok_or_else(|| "节点链接缺少服务器地址".to_string())?;
    let port = parsed
        .port()
        .ok_or_else(|| "节点链接缺少端口".to_string())?;
    let fragment = parsed
        .fragment()
        .map(decode_component)
        .filter(|v| !v.is_empty());
    let mut query = HashMap::new();
    for (key, value) in parsed.query_pairs() {
        query.insert(key.to_lowercase(), value.to_string());
    }
    let mut node = Map::new();
    node.insert(
        "name".into(),
        json!(fragment.unwrap_or_else(|| host.to_string())),
    );
    node.insert("server".into(), json!(host));
    node.insert("port".into(), json!(port));
    node.insert("udp".into(), json!(true));
    match scheme.as_str() {
        "trojan" => {
            node.insert("type".into(), json!("trojan"));
            node.insert(
                "password".into(),
                json!(decode_component(parsed.password().unwrap_or(""))),
            );
            node.insert(
                "sni".into(),
                json!(query
                    .get("sni")
                    .or(query.get("peer"))
                    .cloned()
                    .unwrap_or_default()),
            );
            node.insert(
                "skip-cert-verify".into(),
                json!(query
                    .get("allowinsecure")
                    .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))),
            );
            apply_transport_options(&mut node, &query);
        }
        "vless" => {
            node.insert("type".into(), json!("vless"));
            node.insert("uuid".into(), json!(decode_component(parsed.username())));
            node.insert(
                "tls".into(),
                json!(query
                    .get("security")
                    .is_some_and(|v| v == "tls" || v == "reality")),
            );
            node.insert(
                "servername".into(),
                json!(query
                    .get("sni")
                    .or(query.get("servername"))
                    .cloned()
                    .unwrap_or_default()),
            );
            if let Some(flow) = query.get("flow").filter(|v| !v.is_empty()) {
                node.insert("flow".into(), json!(flow));
            }
            if query.get("security").is_some_and(|v| v == "reality") {
                let mut reality = Map::new();
                if let Some(key) = query.get("pbk").filter(|v| !v.is_empty()) {
                    reality.insert("public-key".into(), json!(key));
                }
                if let Some(id) = query.get("sid").filter(|v| !v.is_empty()) {
                    reality.insert("short-id".into(), json!(id));
                }
                if let Some(path) = query.get("spx").filter(|v| !v.is_empty()) {
                    reality.insert("spider-x".into(), json!(path));
                }
                node.insert("reality-opts".into(), Value::Object(reality));
                if let Some(fingerprint) = query.get("fp").filter(|v| !v.is_empty()) {
                    node.insert("client-fingerprint".into(), json!(fingerprint));
                }
            }
            apply_transport_options(&mut node, &query);
        }
        "hysteria2" | "hy2" => {
            node.insert("type".into(), json!("hysteria2"));
            node.insert(
                "password".into(),
                json!(decode_component(
                    parsed.password().unwrap_or(parsed.username())
                )),
            );
            node.insert(
                "sni".into(),
                json!(query
                    .get("sni")
                    .or(query.get("peer"))
                    .cloned()
                    .unwrap_or_default()),
            );
            node.insert(
                "skip-cert-verify".into(),
                json!(query
                    .get("insecure")
                    .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))),
            );
            if let Some(obfs) = query.get("obfs").filter(|v| !v.is_empty()) {
                node.insert("obfs".into(), json!(obfs));
                node.insert(
                    "obfs-password".into(),
                    json!(query.get("obfs-password").cloned().unwrap_or_default()),
                );
            }
        }
        "tuic" => {
            node.insert("type".into(), json!("tuic"));
            node.insert("uuid".into(), json!(decode_component(parsed.username())));
            node.insert(
                "password".into(),
                json!(decode_component(parsed.password().unwrap_or(""))),
            );
            node.insert(
                "congestion-controller".into(),
                json!(query
                    .get("congestion_control")
                    .cloned()
                    .unwrap_or_else(|| "bbr".into())),
            );
            node.insert(
                "sni".into(),
                json!(query.get("sni").cloned().unwrap_or_default()),
            );
            node.insert(
                "udp-relay-mode".into(),
                json!(query
                    .get("udp_relay_mode")
                    .cloned()
                    .unwrap_or_else(|| "native".into())),
            );
        }
        "ss" => {
            node.insert("type".into(), json!("ss"));
            let userinfo = if let Some(password) = parsed.password() {
                format!("{}:{}", parsed.username(), password)
            } else {
                let encoded = parsed.username();
                let bytes = decode_base64(encoded)
                    .ok_or_else(|| "Shadowsocks 节点认证信息无法解析".to_string())?;
                String::from_utf8(bytes)
                    .map_err(|_| "Shadowsocks 节点认证信息不是 UTF-8".to_string())?
            };
            let (method, password) = userinfo
                .split_once(':')
                .ok_or_else(|| "Shadowsocks 节点缺少加密方式或密码".to_string())?;
            node.insert("cipher".into(), json!(decode_component(method)));
            node.insert("password".into(), json!(decode_component(password)));
        }
        "socks" | "socks5" => {
            node.insert("type".into(), json!("socks5"));
            if !parsed.username().is_empty() {
                node.insert(
                    "username".into(),
                    json!(decode_component(parsed.username())),
                );
            }
            if let Some(password) = parsed.password() {
                node.insert("password".into(), json!(decode_component(password)));
            }
        }
        _ => return Err(format!("暂不支持此节点协议：{scheme}")),
    }
    Ok(Value::Object(node))
}

fn apply_transport_options(node: &mut Map<String, Value>, query: &HashMap<String, String>) {
    let network = query.get("type").map(String::as_str).unwrap_or("tcp");
    match network {
        "ws" => {
            let mut headers = Map::new();
            if let Some(host) = query.get("host").filter(|v| !v.is_empty()) {
                headers.insert("Host".into(), json!(host));
            }
            node.insert("network".into(), json!("ws"));
            node.insert(
                "ws-opts".into(),
                json!({
                    "path": query.get("path").cloned().unwrap_or_else(|| "/".into()),
                    "headers": headers
                }),
            );
        }
        "grpc" => {
            node.insert("network".into(), json!("grpc"));
            node.insert(
                "grpc-opts".into(),
                json!({"grpc-service-name": query.get("servicename").cloned().unwrap_or_default()}),
            );
        }
        _ => {}
    }
}

fn is_share_uri_line(line: &str) -> bool {
    [
        "vmess://",
        "ss://",
        "ssr://",
        "trojan://",
        "vless://",
        "hysteria2://",
        "hy2://",
        "tuic://",
        "socks://",
        "socks5://",
    ]
    .iter()
    .any(|scheme| line.to_ascii_lowercase().starts_with(scheme))
}

fn parse_share_uri_lines(text: &str) -> Option<Result<Vec<Value>, String>> {
    let lines = text
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}'))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    if lines.is_empty() || !lines.iter().all(|line| is_share_uri_line(line)) {
        return None;
    }
    let mut nodes = Vec::with_capacity(lines.len());
    let mut errors = Vec::new();
    for line in lines {
        match parse_share_uri(line) {
            Ok(node) => nodes.push(node),
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() && !nodes.is_empty() {
        Some(Ok(nodes))
    } else {
        Some(Err(summarize_parse_errors(&errors)))
    }
}

fn looks_like_web_page(body: &str) -> bool {
    let preview = body
        .trim_start()
        .chars()
        .take(2048)
        .collect::<String>()
        .to_ascii_lowercase();
    preview.starts_with("<!doctype html")
        || preview.starts_with("<html")
        || preview.starts_with("<head")
        || preview.starts_with("<body")
        || preview.contains("<html")
        || preview.contains("<body")
}

fn response_format_hint(body: &str, content_type: &str) -> String {
    let content_type = content_type.to_ascii_lowercase();
    let media_type = if content_type.contains("text/html") {
        "text/html"
    } else if content_type.contains("application/json") || content_type.contains("text/json") {
        "application/json"
    } else if content_type.contains("text/plain") {
        "text/plain"
    } else if content_type.is_empty() {
        "未提供 Content-Type"
    } else {
        "其他类型"
    };
    let trimmed = body.trim();
    let shape = if looks_like_web_page(trimmed) {
        "网页内容"
    } else if serde_json::from_str::<Value>(trimmed).is_ok() {
        "JSON 数据"
    } else if trimmed.starts_with("proxies:") || trimmed.starts_with("proxy-groups:") {
        "Clash YAML（结构或节点字段不符合要求）"
    } else if decode_base64_text(trimmed).is_some() {
        "可解码的 Base64 文本，但解码内容不是受支持的节点格式"
    } else if is_provider_compatibility_notice(trimmed) {
        "服务商客户端/协议说明"
    } else {
        "未知文本或订阅专用格式"
    };
    format!(
        "服务商返回了无法识别的订阅内容（Content-Type：{media_type}；响应大小：{} 字节；正文类型：{shape}）。请在服务商后台选择 Clash Verge、Clash Meta 或 Mihomo 兼容格式。",
        body.len()
    )
}

pub fn parse_subscription(body: &str, content_type: &str) -> Result<Vec<Value>, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("订阅响应为空".into());
    }
    if let Some(result) = parse_clash_yaml(trimmed) {
        return result;
    }
    if let Some(decoded) = decode_base64_text(trimmed) {
        if let Some(result) = parse_clash_yaml(&decoded) {
            return result;
        }
        if let Some(result) = parse_share_uri_lines(&decoded) {
            return result;
        }
        if is_provider_compatibility_notice(&decoded) {
            return Err(provider_compatibility_error());
        }
        if looks_like_web_page(&decoded) {
            return Err("订阅地址返回了网页内容，不是节点订阅。请确认服务商提供的是原始订阅链接，且登录状态未过期。".into());
        }
    }

    if looks_like_web_page(trimmed) || content_type.to_ascii_lowercase().contains("text/html") {
        let response_type = if content_type.trim().is_empty() {
            String::new()
        } else {
            format!("（响应类型：{}）", content_type)
        };
        return Err(format!(
            "订阅地址返回了网页内容，不是节点订阅{}。请确认服务商提供的是原始订阅链接，且登录或订阅状态有效。",
            response_type
        ));
    }
    if let Some(result) = parse_share_uri_lines(trimmed) {
        return result;
    }
    if is_provider_compatibility_notice(trimmed) {
        return Err(provider_compatibility_error());
    }

    Err(response_format_hint(trimmed, content_type))
}

fn stable_node_id(source_id: &str, config: &Value, stable_name: &str, index: usize) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    source_id.hash(&mut hasher);
    stable_name.hash(&mut hasher);
    config
        .get("server")
        .and_then(Value::as_str)
        .unwrap_or("")
        .hash(&mut hasher);
    config
        .get("port")
        .map(Value::to_string)
        .unwrap_or_default()
        .hash(&mut hasher);
    index.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub fn tag_nodes(source: &Source, configs: Vec<Value>) -> Vec<ProxyNode> {
    let mut counts = HashMap::<String, usize>::new();
    let mut id_counts = HashMap::<String, usize>::new();
    configs
        .into_iter()
        .enumerate()
        .map(|(index, mut config)| {
            let original = config
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("未命名节点")
                .to_string();
            let is_metadata_node = is_provider_metadata_notice_name(&original);
            let (detected_country, flag) = if is_metadata_node {
                ("未识别".to_string(), "🌐".to_string())
            } else {
                country_from_name(&original, &source.region_hint)
            };
            let country = if !is_metadata_node
                && detected_country == "未识别"
                && !source.region_hint.is_empty()
            {
                source.region_hint.clone()
            } else {
                detected_country.clone()
            };
            let country_already_in_name =
                country_already_in_node_name(&original, &country, is_metadata_node);
            let mut stable_name =
                format!("[{}] {} {} · {}", source.prefix, flag, country, original);
            let stable_count = id_counts.entry(stable_name.clone()).or_insert(0);
            *stable_count += 1;
            if *stable_count > 1 {
                stable_name.push_str(&format!(" ({})", stable_count));
            }
            let mut display_name =
                format_node_name(source, &original, &country, country_already_in_name, &flag);
            let count = counts.entry(display_name.clone()).or_insert(0);
            *count += 1;
            if *count > 1 {
                display_name.push_str(&format!(" ({})", count));
            }
            if let Some(object) = config.as_object_mut() {
                object.insert("name".into(), json!(display_name));
            }
            ProxyNode {
                id: stable_node_id(&source.id, &config, &stable_name, index),
                source_id: source.id.clone(),
                source_name: source.name.clone(),
                source_prefix: source.prefix.clone(),
                original_name: original,
                display_name,
                country,
                config,
            }
        })
        .collect()
}

pub fn retag_nodes(source: &Source, nodes: &mut [ProxyNode]) {
    let mut counts = HashMap::<String, usize>::new();
    for node in nodes.iter_mut().filter(|node| node.source_id == source.id) {
        let is_metadata_node = is_provider_metadata_notice_name(&node.original_name);
        let (detected_country, flag) = if is_metadata_node {
            ("未识别".to_string(), "🌐".to_string())
        } else {
            country_from_name(&node.original_name, &source.region_hint)
        };
        let country =
            if !is_metadata_node && detected_country == "未识别" && !source.region_hint.is_empty()
            {
                source.region_hint.clone()
            } else {
                detected_country.clone()
            };
        let country_already_in_name =
            country_already_in_node_name(&node.original_name, &country, is_metadata_node);
        let mut display_name = format_node_name(
            source,
            &node.original_name,
            &country,
            country_already_in_name,
            &flag,
        );
        let count = counts.entry(display_name.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            display_name.push_str(&format!(" ({})", count));
        }
        if let Some(object) = node.config.as_object_mut() {
            object.insert("name".into(), json!(display_name));
        }
        node.source_name = source.name.clone();
        node.source_prefix = source.prefix.clone();
        node.country = country;
        node.display_name = display_name;
    }
}

fn country_already_in_node_name(name: &str, country: &str, is_metadata_node: bool) -> bool {
    if is_metadata_node || country.is_empty() || country == "未识别" {
        return false;
    }
    name.to_lowercase().contains(&country.to_lowercase())
        || country_from_name(name, "").0 == country
}

fn format_node_name(
    source: &Source,
    original_name: &str,
    country: &str,
    country_already_in_name: bool,
    flag: &str,
) -> String {
    let mut fields = Vec::new();
    if source.include_flag && !flag.is_empty() {
        fields.push(flag.to_string());
    }
    if source.include_country
        && country != "未识别"
        && (!source.include_original_name || !country_already_in_name)
    {
        fields.push(country.to_string());
    }
    let mut parts = Vec::new();
    if source.include_prefix && !source.prefix.is_empty() {
        parts.push(format!("[{}]", source.prefix));
    }
    if !fields.is_empty() {
        parts.push(fields.join(" "));
    }
    if source.include_original_name {
        if parts.is_empty() {
            original_name.to_string()
        } else {
            format!("{} · {}", parts.join(" "), original_name)
        }
    } else if parts.is_empty() {
        original_name.to_string()
    } else {
        parts.join(" ")
    }
}
