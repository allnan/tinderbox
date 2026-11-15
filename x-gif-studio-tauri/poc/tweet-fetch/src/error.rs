//! 可直接展示给用户的错误类型（中文消息 + 与 Electron 版一致的错误码）。

use std::fmt;

use serde::Serialize;

/// 错误码，与 Electron 版 tweet.cjs 抛出的 code 一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TweetErrorCode {
    #[serde(rename = "INVALID_URL")]
    InvalidUrl,
    #[serde(rename = "TWEET_NOT_FOUND")]
    TweetNotFound,
    #[serde(rename = "TWEET_PROTECTED")]
    TweetProtected,
    #[serde(rename = "TWEET_RATE_LIMIT")]
    TweetRateLimit,
    #[serde(rename = "NO_MEDIA")]
    NoMedia,
    #[serde(rename = "NETWORK_ERROR")]
    NetworkError,
    #[serde(rename = "TWEET_FETCH_FAILED")]
    TweetFetchFailed,
    #[serde(rename = "PROXY_INVALID")]
    ProxyInvalid,
}

impl TweetErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidUrl => "INVALID_URL",
            Self::TweetNotFound => "TWEET_NOT_FOUND",
            Self::TweetProtected => "TWEET_PROTECTED",
            Self::TweetRateLimit => "TWEET_RATE_LIMIT",
            Self::NoMedia => "NO_MEDIA",
            Self::NetworkError => "NETWORK_ERROR",
            Self::TweetFetchFailed => "TWEET_FETCH_FAILED",
            Self::ProxyInvalid => "PROXY_INVALID",
        }
    }
}

/// 推文抓取错误：message 可直接展示（中文），分类字段用于调用方决定重试/提示方式。
#[derive(Debug, Clone)]
pub struct TweetError {
    pub code: TweetErrorCode,
    pub message: String,
    /// 是否属于网络/接口临时失败（可提示用户检查网络或稍后重试）。
    pub network: bool,
    /// 推文不存在/已删除。
    pub not_found: bool,
    /// 推文受保护或账号不可用。
    pub protected: bool,
}

impl TweetError {
    pub fn new(code: TweetErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            network: false,
            not_found: false,
            protected: false,
        }
    }

    pub fn invalid_url(message: impl Into<String>) -> Self {
        Self::new(TweetErrorCode::InvalidUrl, message)
    }

    pub fn not_found() -> Self {
        let mut error = Self::new(TweetErrorCode::TweetNotFound, "推文不存在或已被删除");
        error.not_found = true;
        error
    }

    pub fn protected() -> Self {
        let mut error = Self::new(
            TweetErrorCode::TweetProtected,
            "该推文受保护或账号不可用，无法读取",
        );
        error.protected = true;
        error
    }

    pub fn rate_limit(message: impl Into<String>) -> Self {
        let mut error = Self::new(TweetErrorCode::TweetRateLimit, message);
        error.network = true;
        error
    }

    pub fn no_media() -> Self {
        Self::new(
            TweetErrorCode::NoMedia,
            "该推文没有可转换的媒体（没有 GIF、视频或图片）",
        )
    }

    pub fn network_error(message: impl Into<String>) -> Self {
        let mut error = Self::new(TweetErrorCode::NetworkError, message);
        error.network = true;
        error
    }

    pub fn fetch_failed(message: impl Into<String>) -> Self {
        Self::new(TweetErrorCode::TweetFetchFailed, message)
    }

    pub fn api_failed(message: impl Into<String>) -> Self {
        let mut error = Self::new(TweetErrorCode::TweetFetchFailed, message);
        error.network = true;
        error
    }

    pub fn proxy_invalid(message: impl Into<String>) -> Self {
        Self::new(TweetErrorCode::ProxyInvalid, message)
    }
}

impl fmt::Display for TweetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TweetError {}
