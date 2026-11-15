//! 真实网络回归测试（默认忽略；需要可访问 X 解析接口的网络环境）。
//!
//! 运行：
//!   cargo test --test real_network -- --ignored --nocapture
//!
//! 可用 TWEET_FETCH_TEST_URL 指定其它公开推文链接。

use std::time::Duration;

use xgif_tweet_fetch::{fetch_tweet, proxy::ProxyMode, FetchOptions};

const DEFAULT_TEST_URL: &str = "https://x.com/lapislazulidm/status/2119254989323588005";

#[test]
#[ignore = "需要真实网络：访问 api.fxtwitter.com / cdn.syndication.twimg.com"]
fn fetch_real_public_tweet() {
    let url =
        std::env::var("TWEET_FETCH_TEST_URL").unwrap_or_else(|_| DEFAULT_TEST_URL.to_string());
    let options = FetchOptions {
        timeout: Duration::from_secs(20),
        ..Default::default()
    };
    let info = fetch_tweet(&url, &options).expect("真实推文应能抓取成功");
    assert!(!info.id.is_empty());
    assert!(!info.author.name.is_empty());
    assert!(!info.media.is_empty(), "测试推文应包含媒体");
    assert!(
        info.media
            .iter()
            .all(|media| media.source_url.starts_with("http")),
        "媒体 sourceUrl 必须是 http(s) 地址"
    );
    println!("{}", serde_json::to_string_pretty(&info).unwrap());
}

#[test]
#[ignore = "需要真实网络：验证 direct 代理模式仍可直连"]
fn fetch_real_public_tweet_direct_mode() {
    let url =
        std::env::var("TWEET_FETCH_TEST_URL").unwrap_or_else(|_| DEFAULT_TEST_URL.to_string());
    let options = FetchOptions {
        proxy: xgif_tweet_fetch::ProxySettings {
            mode: ProxyMode::Direct,
            ..Default::default()
        },
        ..Default::default()
    };
    let info = fetch_tweet(&url, &options).expect("direct 模式应能抓取成功");
    assert!(!info.media.is_empty());
}
