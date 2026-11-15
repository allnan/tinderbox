//! syndication 接口的 token 算法（移植 Node/V8 的 Number.prototype.toString(36)）。
//!
//! Electron 版实现：
//!   ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
//!
//! 为逐位复现 V8 的 36 进制输出，这里按 V8 源码 src/numbers/conversions.cc 中
//! DoubleToRadixStringView 的算法实现（整数部分 + 小数部分逐位生成、delta = 半个 ULP、
//! 最后一位按就近偶数舍入并处理进位），再用与 JS 相同的正则语义删掉所有 0 和小数点。

const RADIX: f64 = 36.0;
const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// 计算 syndication 接口需要的 token。
pub fn syndication_token(tweet_id: &str) -> String {
    let id = tweet_id.parse::<f64>().unwrap_or(0.0);
    let value = (id / 1e15) * std::f64::consts::PI;
    let raw = js_to_string_radix36(value);
    raw.chars().filter(|c| *c != '0' && *c != '.').collect()
}

/// 正向浮点数的下一个可表示值（用于计算半个 ULP）。
fn next_up(value: f64) -> f64 {
    if value.is_nan() || value == f64::INFINITY {
        return value;
    }
    if value == 0.0 {
        return f64::from_bits(1);
    }
    f64::from_bits(value.to_bits() + 1)
}

fn digit_value(byte: u8) -> u32 {
    match byte {
        b'0'..=b'9' => (byte - b'0') as u32,
        b'a'..=b'z' => (byte - b'a') as u32 + 10,
        _ => 0,
    }
}

fn format_integer_base36(integer: f64) -> String {
    if (0.0..=9_007_199_254_740_992.0).contains(&integer) {
        let mut value = integer as u64;
        if value == 0 {
            return "0".to_string();
        }
        let mut digits = Vec::with_capacity(12);
        while value > 0 {
            digits.push(DIGITS[(value % 36) as usize]);
            value /= 36;
        }
        digits.reverse();
        return String::from_utf8(digits).expect("base36 数字为合法 ASCII");
    }
    // 推文 id 换算出的整数部分远小于 2^53，这里仅为通用性兜底。
    let mut digits = Vec::new();
    let mut value = integer;
    while value >= 1.0 {
        let remainder = value % RADIX;
        digits.push(DIGITS[remainder as usize]);
        value = (value - remainder) / RADIX;
    }
    if digits.is_empty() {
        digits.push(b'0');
    }
    digits.reverse();
    String::from_utf8(digits).expect("base36 数字为合法 ASCII")
}

/// 等价于 JS 的 Number.prototype.toString(36)（正数、有限值）。
pub fn js_to_string_radix36(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let negative = value < 0.0;
    let value = value.abs();

    let mut integer = value.floor();
    let mut fraction = value - integer;
    let mut delta = 0.5 * (next_up(value) - value);
    delta = delta.max(f64::from_bits(1));

    let mut frac_digits: Vec<u8> = Vec::new();
    if fraction >= delta {
        loop {
            fraction *= RADIX;
            delta *= RADIX;
            let digit = fraction as i32;
            frac_digits.push(DIGITS[digit as usize]);
            fraction -= digit as f64;
            let round_to_even = fraction > 0.5 || (fraction == 0.5 && (digit & 1) != 0);
            if round_to_even && fraction + delta > 1.0 {
                // 进位：丢弃末尾连续的 z，再把它前面一位加一；全部进位则整数 +1。
                let mut carried = false;
                while let Some(last) = frac_digits.pop() {
                    if last == b'z' {
                        continue;
                    }
                    let next = digit_value(last) + 1;
                    frac_digits.push(DIGITS[next as usize]);
                    carried = true;
                    break;
                }
                if !carried {
                    integer += 1.0;
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }

    let mut output = String::new();
    if negative {
        output.push('-');
    }
    output.push_str(&format_integer_base36(integer));
    if !frac_digits.is_empty() {
        output.push('.');
        for digit in frac_digits {
            output.push(digit as char);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tweet_value(tweet_id: &str) -> f64 {
        (tweet_id.parse::<f64>().unwrap() / 1e15) * std::f64::consts::PI
    }

    /// 期望值由 Node.js（V8）实际输出得到，覆盖大整数、个位数 id、极小值等分支。
    #[test]
    fn matches_v8_base36_output() {
        let cases = [
            ("2119254989323588005", "54x.u3c0bnh8"),
            ("2116630142135275663", "54p.l899s7du"),
            ("20", "0.000000006dq1a2xwd93"),
            ("1234567890123456789", "2zq.ic77uqyk"),
            ("1", "0.000000000bhi2ay3f28n"),
            ("5", "0.000000001lfibiqh3ba"),
            ("9999999999999999999999999", "efk8c1z.wbpu"),
            ("100000", "0.000000oma01s8k7kf"),
            ("12345", "0.00000031esng3xq8a"),
            ("1754200314986013117", "492.zdqkdcon"),
            ("6974967288283419467", "gwo.i7rk3ar7"),
        ];
        for (tweet_id, expected) in cases {
            assert_eq!(
                js_to_string_radix36(tweet_value(tweet_id)),
                expected,
                "tweet_id = {}",
                tweet_id
            );
        }
    }

    #[test]
    fn matches_electron_token() {
        let cases = [
            ("2119254989323588005", "54xu3cbnh8"),
            ("2116630142135275663", "54pl899s7du"),
            ("20", "6dq1a2xwd93"),
            ("1234567890123456789", "2zqic77uqyk"),
            ("1", "bhi2ay3f28n"),
            ("5", "1lfibiqh3ba"),
            ("9999999999999999999999999", "efk8c1zwbpu"),
            ("100000", "oma1s8k7kf"),
            ("12345", "31esng3xq8a"),
            ("1754200314986013117", "492zdqkdcon"),
            ("6974967288283419467", "gwoi7rk3ar7"),
        ];
        for (tweet_id, expected) in cases {
            assert_eq!(
                syndication_token(tweet_id),
                expected,
                "tweet_id = {}",
                tweet_id
            );
        }
    }

    #[test]
    fn integer_part_formats_as_base36() {
        assert_eq!(format_integer_base36(0.0), "0");
        assert_eq!(format_integer_base36(35.0), "z");
        assert_eq!(format_integer_base36(36.0), "10");
        assert_eq!(format_integer_base36(1296.0), "100");
        assert_eq!(format_integer_base36(6657.0), "54x");
    }
}
