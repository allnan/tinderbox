//! 最近解析结果缓存（移植 tweet.cjs 的 tweetCache：容量 20、按访问顺序淘汰）。

use std::sync::{Mutex, OnceLock};

use crate::model::TweetInfo;

/// 缓存容量上限。
pub const MAX_CACHE: usize = 20;

/// 推文信息缓存（最近使用的在前）。
#[derive(Debug, Default)]
pub struct TweetCache {
    entries: Vec<(String, TweetInfo)>,
}

impl TweetCache {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// 记录一条推文信息；重复 id 会先移除旧记录再放到最前。
    pub fn remember(&mut self, info: &TweetInfo) {
        if info.id.is_empty() {
            return;
        }
        self.entries.retain(|(id, _)| id != &info.id);
        self.entries.insert(0, (info.id.clone(), info.clone()));
        self.entries.truncate(MAX_CACHE);
    }

    /// 取最近一次解析的推文信息。
    pub fn get(&self, tweet_id: &str) -> Option<TweetInfo> {
        if tweet_id.is_empty() {
            return None;
        }
        self.entries
            .iter()
            .find(|(id, _)| id == tweet_id)
            .map(|(_, info)| info.clone())
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn global_cache() -> &'static Mutex<TweetCache> {
    static CACHE: OnceLock<Mutex<TweetCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(TweetCache::new()))
}

/// 记录到进程级缓存（供转换流水线只拿到 tweetId 时取回推文信息）。
pub fn remember_tweet(info: &TweetInfo) {
    if let Ok(mut cache) = global_cache().lock() {
        cache.remember(info);
    }
}

/// 从进程级缓存取回推文信息（不存在时返回 None）。
pub fn get_cached(tweet_id: &str) -> Option<TweetInfo> {
    global_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(tweet_id))
}

/// 清空进程级缓存。
pub fn clear_cache() {
    if let Ok(mut cache) = global_cache().lock() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MediaKind, TweetAuthor, TweetMedia, TweetSource};

    fn sample_info(id: &str) -> TweetInfo {
        TweetInfo {
            id: id.to_string(),
            url: format!("https://x.com/demo/status/{}", id),
            author: TweetAuthor {
                name: "Demo".to_string(),
                screen_name: "demo".to_string(),
                avatar_url: None,
                verified: false,
            },
            text: "hello".to_string(),
            created_at: None,
            media: vec![TweetMedia {
                id: "m1".to_string(),
                kind: MediaKind::Gif,
                source_url: "https://video.twimg.com/a.mp4".to_string(),
                thumbnail_url: None,
                width: Some(1),
                height: Some(1),
                duration_sec: None,
                variants: Vec::new(),
            }],
            source: TweetSource::FxTwitter,
            fetched_at: "2026-11-15T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn remembers_and_evicts() {
        let mut cache = TweetCache::new();
        for index in 0..(MAX_CACHE + 5) {
            cache.remember(&sample_info(&index.to_string()));
        }
        assert_eq!(cache.len(), MAX_CACHE);
        assert!(cache.get("0").is_none());
        assert!(cache.get(&(MAX_CACHE + 4).to_string()).is_some());
        // 最近记录在最前
        assert!(cache.get("4").is_none());
    }

    #[test]
    fn duplicate_ids_move_to_front() {
        let mut cache = TweetCache::new();
        cache.remember(&sample_info("1"));
        cache.remember(&sample_info("2"));
        cache.remember(&sample_info("1"));
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.entries[0].0, "1");
    }
}
