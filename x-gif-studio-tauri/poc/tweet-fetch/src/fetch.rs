//! 推文抓取主流程（移植 tweet.cjs#fetchTweet 的四级回退与错误归类）。

use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::Value;

use crate::cache::remember_tweet;
use crate::error::{TweetError, TweetErrorCode};
use crate::model::TweetInfo;
use crate::normalize::{normalize_fx_tweet, normalize_syndication, normalize_vx_tweet};
use crate::parse::{parse_tweet_url, ParsedTweetUrl};
use crate::proxy::{build_client, ProxySettings};
use crate::token::syndication_token;

/// 默认 UA（与 Electron 版一致）。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/// 单个接口默认超时（毫秒，与 Electron 版一致）。
pub const DEFAULT_TIMEOUT_MS: u64 = 15000;

/// 回退链中的接口。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    FxTwitterV2,
    FxTwitterV1,
    Syndication,
    VxTwitter,
}

impl Endpoint {
    /// 回退顺序（与 Electron 版一致）。
    pub fn all() -> Vec<Endpoint> {
        vec![
            Endpoint::FxTwitterV2,
            Endpoint::FxTwitterV1,
            Endpoint::Syndication,
            Endpoint::VxTwitter,
        ]
    }

    /// 日志/CLI 使用的接口名。
    pub fn label(self) -> &'static str {
        match self {
            Self::FxTwitterV2 => "fxtwitter",
            Self::FxTwitterV1 => "fxtwitter-v1",
            Self::Syndication => "syndication",
            Self::VxTwitter => "vxtwitter",
        }
    }

    /// 从 CLI 标签解析；兼容 fxv1 / vx 简写。
    pub fn from_label(label: &str) -> Option<Endpoint> {
        match label.trim().to_ascii_lowercase().as_str() {
            "fxtwitter" | "fx" | "fxv2" => Some(Endpoint::FxTwitterV2),
            "fxtwitter-v1" | "fxv1" => Some(Endpoint::FxTwitterV1),
            "syndication" | "syn" => Some(Endpoint::Syndication),
            "vxtwitter" | "vx" => Some(Endpoint::VxTwitter),
            _ => None,
        }
    }
}

/// 抓取一个接口的尝试结果（用于 CLI --verbose 与排障日志）。
#[derive(Debug, Clone)]
pub struct EndpointAttempt {
    pub endpoint: Endpoint,
    pub ok: bool,
    pub message: Option<String>,
}

/// 抓取参数。
#[derive(Debug, Clone)]
pub struct FetchOptions {
    pub proxy: ProxySettings,
    /// 单个接口请求超时。
    pub timeout: Duration,
    pub user_agent: String,
    /// None 表示按默认回退顺序尝试全部接口；Some 用于测试/排障时限定接口。
    pub endpoints: Option<Vec<Endpoint>>,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            proxy: ProxySettings::default(),
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            endpoints: None,
        }
    }
}

impl FetchOptions {
    pub fn with_proxy(mut self, proxy: ProxySettings) -> Self {
        self.proxy = proxy;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_endpoints(mut self, endpoints: Vec<Endpoint>) -> Self {
        self.endpoints = Some(endpoints);
        self
    }
}

/// 抓取成功后的完整结果。
#[derive(Debug, Clone)]
pub struct FetchReport {
    pub info: TweetInfo,
    /// 实际提供媒体数据的接口。
    pub endpoint: Endpoint,
    pub attempts: Vec<EndpointAttempt>,
}

fn fetch_json_endpoint(client: &Client, url: &str, label: &str) -> Result<Value, TweetError> {
    let response = client.get(url).send().map_err(|error| {
        let reason = if error.is_timeout() {
            "请求超时"
        } else {
            "网络连接失败"
        };
        TweetError::network_error(format!("{} 接口{}：{}", label, reason, error))
    })?;
    let status = response.status().as_u16();
    let text = response.text().unwrap_or_default();
    if status == 404 {
        return Err(TweetError::not_found());
    }
    if status == 401 || status == 403 {
        return Err(TweetError::protected());
    }
    if status == 429 {
        return Err(TweetError::rate_limit("请求过于频繁，请稍后再试"));
    }
    if !(200..300).contains(&status) {
        return Err(TweetError::api_failed(format!(
            "{} 接口请求失败（HTTP {}）",
            label, status
        )));
    }
    serde_json::from_str(&text)
        .map_err(|_| TweetError::api_failed(format!("{} 接口返回了无法解析的数据", label)))
}

fn code_is_not_found(code: Option<&Value>) -> bool {
    match code {
        Some(Value::Number(number)) => number.as_i64() == Some(404),
        Some(Value::String(text)) => text == "NOT_FOUND",
        _ => false,
    }
}

fn run_endpoint(
    endpoint: Endpoint,
    client: &Client,
    parsed: &ParsedTweetUrl,
) -> Result<TweetInfo, TweetError> {
    match endpoint {
        Endpoint::FxTwitterV2 => {
            let url = format!("https://api.fxtwitter.com/2/status/{}", parsed.tweet_id);
            let json = fetch_json_endpoint(client, &url, "fxtwitter")?;
            let tweet = json
                .get("status")
                .or_else(|| json.get("tweet"))
                .filter(|value| value.is_object());
            let Some(tweet) = tweet else {
                if code_is_not_found(json.get("code")) {
                    return Err(TweetError::not_found());
                }
                return Err(TweetError::fetch_failed("fxtwitter 接口没有返回推文数据"));
            };
            normalize_fx_tweet(tweet, &parsed.canonical_url)
                .ok_or_else(|| TweetError::fetch_failed("fxtwitter 接口没有返回推文数据"))
        }
        Endpoint::FxTwitterV1 => {
            let path = match &parsed.screen_name {
                Some(screen_name) => format!("{}/status/{}", screen_name, parsed.tweet_id),
                None => format!("i/status/{}", parsed.tweet_id),
            };
            let url = format!("https://api.fxtwitter.com/{}", path);
            let json = fetch_json_endpoint(client, &url, "fxtwitter")?;
            let Some(tweet) = json.get("tweet").filter(|value| value.is_object()) else {
                return Err(TweetError::fetch_failed("fxtwitter 接口没有返回推文数据"));
            };
            normalize_fx_tweet(tweet, &parsed.canonical_url)
                .ok_or_else(|| TweetError::fetch_failed("fxtwitter 接口没有返回推文数据"))
        }
        Endpoint::Syndication => {
            let token = syndication_token(&parsed.tweet_id);
            let url = format!(
                "https://cdn.syndication.twimg.com/tweet-result?id={}&lang=en&token={}",
                parsed.tweet_id, token
            );
            let json = fetch_json_endpoint(client, &url, "syndication")?;
            normalize_syndication(&json, Some(&parsed.canonical_url))
                .ok_or_else(|| TweetError::fetch_failed("syndication 接口没有返回推文数据"))
        }
        Endpoint::VxTwitter => {
            let url = format!("https://api.vxtwitter.com/i/status/{}", parsed.tweet_id);
            let json = fetch_json_endpoint(client, &url, "vxtwitter")?;
            normalize_vx_tweet(&json, Some(&parsed.canonical_url))
                .ok_or_else(|| TweetError::fetch_failed("vxtwitter 接口没有返回推文数据"))
        }
    }
}

/// 抓取并归一化推文，返回完整报告（含实际命中的接口与各接口尝试结果）。
pub fn fetch_tweet_with_report(
    input_url: &str,
    options: &FetchOptions,
) -> Result<FetchReport, TweetError> {
    let parsed = parse_tweet_url(input_url).ok_or_else(|| {
        TweetError::invalid_url(
            "链接格式不正确，请输入 X 或 Twitter 的推文链接（例如 https://x.com/user/status/1234567890）",
        )
    })?;
    let client = build_client(&options.proxy, options.timeout, &options.user_agent)?;
    let endpoints = options.endpoints.clone().unwrap_or_else(Endpoint::all);

    let mut attempts: Vec<EndpointAttempt> = Vec::new();
    let mut endpoint_errors: Vec<(Endpoint, TweetError)> = Vec::new();
    let mut empty_media_info: Option<(TweetInfo, Endpoint)> = None;

    for endpoint in endpoints {
        match run_endpoint(endpoint, &client, &parsed) {
            Ok(info) => {
                let has_media = !info.media.is_empty();
                attempts.push(EndpointAttempt {
                    endpoint,
                    ok: true,
                    message: if has_media {
                        None
                    } else {
                        Some("接口成功但没有解析出媒体".to_string())
                    },
                });
                if has_media {
                    remember_tweet(&info);
                    return Ok(FetchReport {
                        info,
                        endpoint,
                        attempts,
                    });
                }
                // 某个接口成功但没有媒体：继续尝试其它接口，全部失败后再给「无媒体」结论
                empty_media_info = Some((info, endpoint));
            }
            Err(error) => {
                attempts.push(EndpointAttempt {
                    endpoint,
                    ok: false,
                    message: Some(error.message.clone()),
                });
                // 明确不存在/受保护时记录，但继续尝试其它接口（各接口可用性不同）
                endpoint_errors.push((endpoint, error));
            }
        }
    }

    if let Some((info, _)) = empty_media_info {
        remember_tweet(&info);
        return Err(TweetError::no_media());
    }

    let not_found_count = endpoint_errors
        .iter()
        .filter(|(_, error)| error.not_found || error.code == TweetErrorCode::TweetNotFound)
        .count();
    let protected_count = endpoint_errors
        .iter()
        .filter(|(_, error)| error.protected || error.code == TweetErrorCode::TweetProtected)
        .count();
    if not_found_count >= 2 || (not_found_count > 0 && endpoint_errors.len() == not_found_count) {
        return Err(TweetError::not_found());
    }
    if protected_count >= 1 {
        return Err(TweetError::protected());
    }
    let detail = endpoint_errors
        .last()
        .map(|(_, error)| error.message.clone())
        .unwrap_or_else(|| "未知错误".to_string());
    Err(TweetError::network_error(format!(
        "网络请求失败，请检查网络后重试：{}",
        detail
    )))
}

/// 抓取并归一化推文（只要 TweetInfo）。
pub fn fetch_tweet(input_url: &str, options: &FetchOptions) -> Result<TweetInfo, TweetError> {
    fetch_tweet_with_report(input_url, options).map(|report| report.info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_labels_round_trip() {
        for endpoint in Endpoint::all() {
            assert_eq!(Endpoint::from_label(endpoint.label()), Some(endpoint));
        }
        assert_eq!(Endpoint::from_label("fxv1"), Some(Endpoint::FxTwitterV1));
        assert_eq!(Endpoint::from_label("vx"), Some(Endpoint::VxTwitter));
        assert_eq!(Endpoint::from_label("unknown"), None);
    }

    #[test]
    fn invalid_url_is_reported_without_network() {
        let options = FetchOptions {
            endpoints: Some(vec![Endpoint::FxTwitterV2]),
            ..Default::default()
        };
        let error = fetch_tweet("https://example.com/foo/status/1234567890", &options)
            .expect_err("非推文链接应失败");
        assert_eq!(error.code, TweetErrorCode::InvalidUrl);
    }

    #[test]
    fn invalid_proxy_is_reported_before_network() {
        let proxy = ProxySettings {
            mode: crate::proxy::ProxyMode::Custom,
            url: "ftp://127.0.0.1:21".to_string(),
            ..Default::default()
        };
        let options = FetchOptions {
            proxy,
            ..Default::default()
        };
        let error = fetch_tweet("https://x.com/foo/status/1234567890", &options)
            .expect_err("非法代理应失败");
        assert_eq!(error.code, TweetErrorCode::ProxyInvalid);
    }
}
