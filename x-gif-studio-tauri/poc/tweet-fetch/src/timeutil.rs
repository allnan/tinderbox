//! 推文时间的解析与统一输出（等价 JS 的 new Date(...).toISOString()）。

use serde_json::Value;
use time::format_description::well_known::{Rfc2822, Rfc3339};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

fn format_iso(datetime: OffsetDateTime) -> String {
    let dt = datetime.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        dt.year(),
        u8::from(dt.month()),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second(),
        dt.millisecond()
    )
}

/// 当前时间的 ISO 字符串（毫秒精度、UTC，形如 2026-11-15T12:34:56.789Z）。
pub fn now_iso() -> String {
    format_iso(OffsetDateTime::now_utc())
}

fn month_from_name(name: &str) -> Option<Month> {
    let month = match name.to_ascii_lowercase().as_str() {
        "jan" => Month::January,
        "feb" => Month::February,
        "mar" => Month::March,
        "apr" => Month::April,
        "may" => Month::May,
        "jun" => Month::June,
        "jul" => Month::July,
        "aug" => Month::August,
        "sep" => Month::September,
        "oct" => Month::October,
        "nov" => Month::November,
        "dec" => Month::December,
        _ => return None,
    };
    Some(month)
}

/// 解析 vxtwitter 等接口使用的 ctime 风格日期：
/// "Sun Nov 08 02:25:37 +0000 2026"（JS new Date() 可解析，但不是标准 RFC 2822）。
fn parse_ctime_like(text: &str) -> Option<OffsetDateTime> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() != 6 {
        return None;
    }
    let month = month_from_name(parts[1])?;
    let day: u8 = parts[2].parse().ok()?;
    let time_parts: Vec<&str> = parts[3].split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }
    let hour: u8 = time_parts[0].parse().ok()?;
    let minute: u8 = time_parts[1].parse().ok()?;
    let second: u8 = time_parts[2].parse().ok()?;
    let offset_text = parts[4];
    if offset_text.len() != 5 {
        return None;
    }
    let sign = match &offset_text[..1] {
        "+" => 1,
        "-" => -1,
        _ => return None,
    };
    let offset_hours: i8 = offset_text[1..3].parse().ok()?;
    let offset_minutes: i8 = offset_text[3..5].parse().ok()?;
    let year: i32 = parts[5].parse().ok()?;
    let date = Date::from_calendar_date(year, month, day).ok()?;
    let time = Time::from_hms(hour, minute, second).ok()?;
    let offset = UtcOffset::from_hms(sign * offset_hours, sign * offset_minutes, 0).ok()?;
    Some(
        PrimitiveDateTime::new(date, time)
            .assume_offset(offset)
            .to_offset(UtcOffset::UTC),
    )
}

fn epoch_millis_to_iso(millis: f64) -> Option<String> {
    if !millis.is_finite() {
        return None;
    }
    let nanos = (millis.trunc() as i128).checked_mul(1_000_000)?;
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .map(format_iso)
}

/// 等价 Electron 版 isoDate(value)：数值按秒/毫秒推断，字符串支持 ISO 8601 与 RFC 2822。
pub fn iso_date_from_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Number(number) => {
            let numeric = number.as_f64()?;
            if numeric == 0.0 {
                return None;
            }
            // 小于 1e12 视为秒级时间戳（与 Electron 版一致）。
            let millis = if numeric < 1e12 {
                numeric * 1000.0
            } else {
                numeric
            };
            epoch_millis_to_iso(millis)
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(datetime) = OffsetDateTime::parse(trimmed, &Rfc3339) {
                return Some(format_iso(datetime));
            }
            if let Ok(datetime) = OffsetDateTime::parse(trimmed, &Rfc2822) {
                return Some(format_iso(datetime));
            }
            parse_ctime_like(trimmed).map(format_iso)
        }
        _ => None,
    }
}

/// 数值（秒/毫秒）或字符串形式的日期转换，便于归一化代码复用。
pub fn iso_date_opt(value: Option<&Value>) -> Option<String> {
    value.and_then(iso_date_from_value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_iso_strings() {
        assert_eq!(
            iso_date_from_value(&json!("2026-11-08T02:25:37.000Z")).as_deref(),
            Some("2026-11-08T02:25:37.000Z")
        );
        assert_eq!(
            iso_date_from_value(&json!("2026-11-08T02:25:37Z")).as_deref(),
            Some("2026-11-08T02:25:37.000Z")
        );
        assert_eq!(
            iso_date_from_value(&json!("2026-11-08T10:25:37+08:00")).as_deref(),
            Some("2026-11-08T02:25:37.000Z")
        );
    }

    #[test]
    fn parses_rfc2822_strings() {
        assert_eq!(
            iso_date_from_value(&json!("Sun Nov 08 02:25:37 +0000 2026")).as_deref(),
            Some("2026-11-08T02:25:37.000Z")
        );
    }

    #[test]
    fn parses_epoch_seconds_and_millis() {
        assert_eq!(
            iso_date_from_value(&json!(1794104737)).as_deref(),
            Some("2026-11-08T02:25:37.000Z")
        );
        assert_eq!(
            iso_date_from_value(&json!(1794104737000i64)).as_deref(),
            Some("2026-11-08T02:25:37.000Z")
        );
    }

    #[test]
    fn returns_none_for_invalid_values() {
        assert_eq!(iso_date_from_value(&json!(null)), None);
        assert_eq!(iso_date_from_value(&json!(0)), None);
        assert_eq!(iso_date_from_value(&json!("not a date")), None);
        assert_eq!(iso_date_from_value(&json!("")), None);
    }
}
