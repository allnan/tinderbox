//! 代理配置解析与 HTTP 客户端构建（移植 proxy.cjs 的代理地址规则，并映射到 reqwest）。

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE};
use reqwest::{NoProxy, Proxy};
use serde::{Deserialize, Serialize};

use crate::error::TweetError;

/// 默认不走代理的主机（与 Electron 版一致）。
pub const DEFAULT_BYPASS: &str = "localhost;127.0.0.1;<local>";

/// 代理模式：系统 / 自定义 / 直连。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    System,
    Custom,
    Direct,
}

impl ProxyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Custom => "custom",
            Self::Direct => "direct",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "system" => Some(Self::System),
            "custom" => Some(Self::Custom),
            "direct" => Some(Self::Direct),
            _ => None,
        }
    }
}

/// 代理设置，字段与 x-gif-studio/src/shared/types.ts 的 ProxySettings 一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub mode: ProxyMode,
    pub url: String,
    pub bypass: String,
    pub username: String,
    pub password: String,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: ProxyMode::System,
            url: String::new(),
            bypass: DEFAULT_BYPASS.to_string(),
            username: String::new(),
            password: String::new(),
        }
    }
}

impl ProxySettings {
    /// 收敛外部传入的代理配置（缺省补全、去空白），等价 proxy.cjs#normalizeProxySettings。
    pub fn normalized(mut self) -> Self {
        self.url = self.url.trim().to_string();
        self.bypass = {
            let trimmed = self.bypass.trim();
            if trimmed.is_empty() {
                DEFAULT_BYPASS.to_string()
            } else {
                trimmed.to_string()
            }
        };
        self.username = self.username.trim().to_string();
        self
    }
}

/// 解析后的自定义代理地址。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedProxy {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    /// 规范化后的代理地址（scheme://host:port，含认证信息时不带凭据）。
    pub url: String,
    pub username: String,
    pub password: String,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn has_scheme(value: &str) -> bool {
    let Some(separator) = value.find("://") else {
        return false;
    };
    let scheme = &value[..separator];
    !scheme.is_empty()
        && scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// 解析自定义代理地址（移植 proxy.cjs#parseProxyUrl）。
///
/// 支持 http://host:port、https://host:port、socks5://host:port、裸 host:port（按 http）。
pub fn parse_proxy_url(raw_url: &str) -> Result<ParsedProxy, String> {
    let raw = raw_url.trim();
    if raw.is_empty() {
        return Err(
            "请填写代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080".to_string(),
        );
    }
    let invalid = || format!("代理地址格式不正确：{}", raw);
    let value = if has_scheme(raw) {
        raw.to_string()
    } else {
        format!("http://{}", raw)
    };
    let Some(separator) = value.find("://") else {
        return Err(invalid());
    };
    let scheme = value[..separator].to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "socks5") {
        return Err(format!(
            "不支持的代理协议：{}（支持 http / https / socks5）",
            scheme
        ));
    }
    let rest = &value[separator + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let (userinfo, host_port) = match authority.rfind('@') {
        Some(index) => (Some(&authority[..index]), &authority[index + 1..]),
        None => (None, authority),
    };
    let (host, port_text) = if let Some(stripped) = host_port.strip_prefix('[') {
        let Some(end) = stripped.find(']') else {
            return Err(invalid());
        };
        let host = format!("[{}]", &stripped[..end]);
        let remainder = &stripped[end + 1..];
        let port = remainder.strip_prefix(':').unwrap_or_default().to_string();
        (host, port)
    } else {
        match host_port.rfind(':') {
            Some(index) => (
                host_port[..index].to_string(),
                host_port[index + 1..].to_string(),
            ),
            None => (host_port.to_string(), String::new()),
        }
    };
    if host.is_empty() {
        return Err(format!("代理地址缺少主机名：{}", raw));
    }
    let default_port = match scheme.as_str() {
        "https" => 443,
        "socks5" => 1080,
        _ => 80,
    };
    let port = if port_text.is_empty() {
        default_port
    } else {
        port_text
            .parse::<u16>()
            .map_err(|_| format!("代理端口不正确：{}", port_text))?
    };
    if port == 0 {
        return Err(format!("代理端口不正确：{}", port_text));
    }
    let (username, password) = match userinfo {
        Some(info) => match info.split_once(':') {
            Some((user, pass)) => (percent_decode(user), percent_decode(pass)),
            None => (percent_decode(info), String::new()),
        },
        None => (String::new(), String::new()),
    };
    let canonical_url = format!("{}://{}:{}", scheme, host, port);
    Ok(ParsedProxy {
        scheme,
        host,
        port,
        url: canonical_url,
        username,
        password,
    })
}

/// 生成不去代理的主机列表（始终追加本机回环，移植 buildBypassRules）。
pub fn build_bypass_rules(bypass: &str) -> String {
    let mut items: Vec<String> = Vec::new();
    for token in bypass.split(|c: char| c == ';' || c == ',' || c.is_whitespace()) {
        let token = token.trim();
        if !token.is_empty() && !items.iter().any(|item| item == token) {
            items.push(token.to_string());
        }
    }
    for required in ["localhost", "127.0.0.1", "<local>"] {
        if !items.iter().any(|item| item == required) {
            items.push(required.to_string());
        }
    }
    items.join(";")
}

fn reqwest_no_proxy(bypass: &str) -> Option<NoProxy> {
    let rules = build_bypass_rules(bypass);
    let entries: Vec<&str> = rules
        .split(';')
        .filter(|item| !item.is_empty() && *item != "<local>")
        .collect();
    if entries.is_empty() {
        None
    } else {
        NoProxy::from_string(&entries.join(","))
    }
}

fn base_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.9,zh-CN;q=0.8"),
    );
    headers
}

/// 构建阻塞式 HTTP 客户端，并把代理设置映射为 reqwest 的 Proxy。
///
/// - system：不调用 proxy/no_proxy，交给 reqwest 0.13 的 system-proxy 特性；
/// - custom：Proxy::all + 可选 Basic 认证 + 不走代理列表；
/// - direct：no_proxy()，强制直连。
pub fn build_client(
    settings: &ProxySettings,
    timeout: Duration,
    user_agent: &str,
) -> Result<Client, TweetError> {
    let settings = settings.clone().normalized();
    let mut builder = Client::builder()
        .timeout(timeout)
        .user_agent(user_agent.to_string())
        .default_headers(base_headers());
    match settings.mode {
        ProxyMode::System => {}
        ProxyMode::Direct => {
            builder = builder.no_proxy();
        }
        ProxyMode::Custom => {
            let parsed = parse_proxy_url(&settings.url).map_err(TweetError::proxy_invalid)?;
            let mut proxy = Proxy::all(&parsed.url).map_err(|error| {
                TweetError::proxy_invalid(format!("代理地址格式不正确：{}", error))
            })?;
            let username = if !settings.username.is_empty() {
                settings.username.clone()
            } else {
                parsed.username.clone()
            };
            let password = if !settings.password.is_empty() {
                settings.password.clone()
            } else {
                parsed.password.clone()
            };
            if !username.is_empty() {
                proxy = proxy.basic_auth(&username, &password);
            }
            if let Some(no_proxy) = reqwest_no_proxy(&settings.bypass) {
                proxy = proxy.no_proxy(Some(no_proxy));
            }
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|error| TweetError::api_failed(format!("创建网络客户端失败：{}", error)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_proxy_variants() {
        let parsed = parse_proxy_url("http://127.0.0.1:7890").unwrap();
        assert_eq!(parsed.url, "http://127.0.0.1:7890");
        assert_eq!(parsed.port, 7890);
        assert_eq!(parsed.username, "");
        assert_eq!(parsed.password, "");

        let parsed = parse_proxy_url("127.0.0.1:7890").unwrap();
        assert_eq!(parsed.scheme, "http");
        assert_eq!(parsed.url, "http://127.0.0.1:7890");

        let parsed = parse_proxy_url("https://proxy.local").unwrap();
        assert_eq!(parsed.url, "https://proxy.local:443");

        let parsed = parse_proxy_url("socks5://127.0.0.1:1080").unwrap();
        assert_eq!(parsed.scheme, "socks5");
        assert_eq!(parsed.url, "socks5://127.0.0.1:1080");

        let parsed = parse_proxy_url("socks5://127.0.0.1").unwrap();
        assert_eq!(parsed.url, "socks5://127.0.0.1:1080");
    }

    #[test]
    fn parses_proxy_credentials() {
        let parsed = parse_proxy_url("http://user:pass@127.0.0.1:7890").unwrap();
        assert_eq!(parsed.username, "user");
        assert_eq!(parsed.password, "pass");
        assert_eq!(parsed.url, "http://127.0.0.1:7890");

        let parsed = parse_proxy_url("http://u%40ser:p%3Ass@host:8080").unwrap();
        assert_eq!(parsed.username, "u@ser");
        assert_eq!(parsed.password, "p:ss");
    }

    #[test]
    fn rejects_invalid_proxy_urls() {
        assert!(parse_proxy_url("").is_err());
        assert!(parse_proxy_url("ftp://127.0.0.1:21")
            .unwrap_err()
            .contains("不支持的代理协议"));
        assert!(parse_proxy_url("http://:7890").is_err());
        assert!(parse_proxy_url("http://127.0.0.1:99999").is_err());
        assert!(parse_proxy_url("http://127.0.0.1:abc").is_err());
    }

    #[test]
    fn bypass_rules_always_include_loopback() {
        assert_eq!(build_bypass_rules(""), "localhost;127.0.0.1;<local>");
        assert_eq!(
            build_bypass_rules("example.com; *.local, 10.0.0.0/8"),
            "example.com;*.local;10.0.0.0/8;localhost;127.0.0.1;<local>"
        );
    }

    #[test]
    fn direct_client_builds_without_network() {
        let settings = ProxySettings {
            mode: ProxyMode::Direct,
            ..Default::default()
        };
        let client = build_client(&settings, Duration::from_millis(1000), "test-agent");
        assert!(client.is_ok());
    }
}
