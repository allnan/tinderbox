//! 真实推文解析 Rust 原型库。
//!
//! 移植自 Electron 版 x-gif-studio/electron/lib/tweet.cjs，对外提供与
//! x-gif-studio/src/shared/types.ts 中 TweetInfo / TweetMedia 一致的 JSON 契约。
//!
//! 主要入口：
//! - parse_tweet_url：解析 x.com / twitter.com 推文链接；
//! - fetch_tweet：按 fxtwitter v2 -> fxtwitter v1 -> syndication -> vxtwitter 回退抓取并归一化；
//! - ProxySettings / FetchOptions：代理与请求参数；
//! - get_cached / remember_tweet / clear_cache：最近解析结果缓存（最多 20 条）。
//!
//! 集成说明与接口契约见 x-gif-studio-tauri/docs/PORT-tweet.md。

pub mod cache;
pub mod error;
pub mod fetch;
pub mod model;
pub mod normalize;
pub mod parse;
pub mod proxy;
pub mod timeutil;
pub mod token;

pub use cache::{clear_cache, get_cached, remember_tweet, TweetCache, MAX_CACHE};
pub use error::{TweetError, TweetErrorCode};
pub use fetch::{
    fetch_tweet, fetch_tweet_with_report, Endpoint, FetchOptions, FetchReport, DEFAULT_TIMEOUT_MS,
    DEFAULT_USER_AGENT,
};
pub use model::{MediaKind, MediaVariant, TweetAuthor, TweetInfo, TweetMedia, TweetSource};
pub use normalize::{normalize_fx_tweet, normalize_syndication, normalize_vx_tweet};
pub use parse::{parse_tweet_url, ParsedTweetUrl};
pub use proxy::{
    build_bypass_rules, build_client, parse_proxy_url, ParsedProxy, ProxyMode, ProxySettings,
    DEFAULT_BYPASS,
};
pub use token::syndication_token;
