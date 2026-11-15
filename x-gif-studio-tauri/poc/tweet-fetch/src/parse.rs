//! 推文链接解析（移植 tweet.cjs#parseTweetUrl）。

use std::sync::OnceLock;

use regex::Regex;

/// 解析结果：推文 id、规范化链接、可选的用户名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTweetUrl {
    pub tweet_id: String,
    pub canonical_url: String,
    pub screen_name: Option<String>,
}

fn url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(x\.com|twitter\.com)/(?:([A-Za-z0-9_]{1,30})|i/web|i|web)/status(?:es)?/([0-9]{5,25})(?:[/?#].*)?$",
        )
        .expect("推文链接正则必须可编译")
    })
}

/// 去掉链接两端常见的粘贴包裹字符（尖括号、中文括号、引号、空白）。
fn strip_wrapping(text: &str) -> &str {
    let leading = |c: char| matches!(c, '<' | '（' | '(' | '【' | '「') || c.is_whitespace();
    let trailing = |c: char| matches!(c, '>' | '）' | ')' | '】' | '」') || c.is_whitespace();
    text.trim_start_matches(leading).trim_end_matches(trailing)
}

/// 大小写不敏感地去掉前缀（等价 JS 的 replace(/^.../i)）。
fn strip_prefix_ci<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    if input.len() >= prefix.len()
        && input.is_char_boundary(prefix.len())
        && input[..prefix.len()].eq_ignore_ascii_case(prefix)
    {
        Some(&input[prefix.len()..])
    } else {
        None
    }
}

/// 解析推文链接。
///
/// 支持 x.com / twitter.com / mobile.twitter.com / m.twitter.com 的
/// {user|i|i/web|web}/status/{id} 链接（带查询参数、/photo/1 等后缀与包裹字符）。
pub fn parse_tweet_url(input: &str) -> Option<ParsedTweetUrl> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut rest = strip_wrapping(trimmed);

    if let Some(stripped) = strip_prefix_ci(rest, "https://") {
        rest = stripped;
    } else if let Some(stripped) = strip_prefix_ci(rest, "http://") {
        rest = stripped;
    }
    if let Some(stripped) = strip_prefix_ci(rest, "www.") {
        rest = stripped;
    }
    if let Some(stripped) = strip_prefix_ci(rest, "mobile.") {
        rest = stripped;
    } else if let Some(stripped) = strip_prefix_ci(rest, "m.") {
        rest = stripped;
    }

    let captures = url_regex().captures(rest)?;
    let tweet_id = captures.get(3)?.as_str().to_string();
    let raw_user = captures.get(2).map(|m| m.as_str());
    let screen_name = raw_user
        .filter(|user| !user.eq_ignore_ascii_case("i") && !user.eq_ignore_ascii_case("web"))
        .map(|user| user.to_string());

    let canonical_url = match &screen_name {
        Some(user) => format!("https://x.com/{}/status/{}", user, tweet_id),
        None => format!("https://x.com/i/status/{}", tweet_id),
    };

    Some(ParsedTweetUrl {
        tweet_id,
        canonical_url,
        screen_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Option<(String, String, Option<String>)> {
        parse_tweet_url(url)
            .map(|parsed| (parsed.tweet_id, parsed.canonical_url, parsed.screen_name))
    }

    #[test]
    fn parses_standard_links() {
        assert_eq!(
            parse("https://x.com/lapislazulidm/status/2119254989323588005"),
            Some((
                "2119254989323588005".to_string(),
                "https://x.com/lapislazulidm/status/2119254989323588005".to_string(),
                Some("lapislazulidm".to_string()),
            ))
        );
        assert_eq!(
            parse("https://twitter.com/foo/status/1234567890?s=20"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
        assert_eq!(
            parse("x.com/foo/statuses/12345/photo/1"),
            Some((
                "12345".to_string(),
                "https://x.com/foo/status/12345".to_string(),
                Some("foo".to_string()),
            ))
        );
    }

    #[test]
    fn parses_category_and_mobile_links() {
        assert_eq!(
            parse("https://x.com/i/status/123456789012345678"),
            Some((
                "123456789012345678".to_string(),
                "https://x.com/i/status/123456789012345678".to_string(),
                None,
            ))
        );
        assert_eq!(
            parse("https://x.com/i/web/status/1234567890"),
            Some((
                "1234567890".to_string(),
                "https://x.com/i/status/1234567890".to_string(),
                None,
            ))
        );
        assert_eq!(
            parse("https://x.com/web/status/1234567890"),
            Some((
                "1234567890".to_string(),
                "https://x.com/i/status/1234567890".to_string(),
                None,
            ))
        );
        assert_eq!(
            parse("http://www.mobile.twitter.com/foo/status/1234567890"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
        assert_eq!(
            parse("https://m.twitter.com/foo/status/1234567890"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
    }

    #[test]
    fn strips_wrapping_characters() {
        assert_eq!(
            parse("<https://x.com/foo/status/1234567890>"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
        assert_eq!(
            parse("「https://x.com/foo/status/1234567890」"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
        assert_eq!(
            parse("（https://x.com/foo/status/1234567890）"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
    }

    #[test]
    fn rejects_invalid_links() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("https://example.com/foo/status/1234567890"), None);
        assert_eq!(parse("https://x.com/foo/1234567890"), None);
        assert_eq!(parse("https://x.com/foo/status/abc"), None);
        assert_eq!(parse("https://x.com/foo/status/1234"), None);
        assert_eq!(parse("https://x.com/foo/status/1234567890 extra"), None);
        // 与 Electron 版一致：/photo/1、查询参数等后缀可以被接受
        assert_eq!(
            parse("https://x.com/foo/status/1234567890/photo/1"),
            Some((
                "1234567890".to_string(),
                "https://x.com/foo/status/1234567890".to_string(),
                Some("foo".to_string()),
            ))
        );
    }
}
