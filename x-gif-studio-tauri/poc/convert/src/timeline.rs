//! 时间轴计算（逐帧时长 → GIF 厘秒延时 / 编码器名义帧率）。
//!
//! 逐行移植自 Electron 版 `electron/lib/gif.cjs` 的 computeDelaysCs /
//! averageFrameDuration / computeNominalFps / uniformDurations / groupDurations /
//! alignFrameDurations / resolveDelaysForFrames。这些函数是纯函数，已覆盖单测。

use crate::params::{FpsMode, MIN_DELAY_CS};

/// gifski 允许的名义帧率上限。
pub const GIFSKI_MAX_FPS: f64 = 100.0;

/// 把每帧毫秒时长换算成 GIF 厘秒延时。
///
/// 采用「累计时间 + 四舍五入 + 最小 2cs」的分配方式：即使帧时长不是 10ms 的整数倍
/// （例如 15fps 的 66.67ms），总时长也不会漂移；速度倍率直接作用于时长。
pub fn compute_delays_cs(frame_durations_ms: &[f64], speed: f64, min_cs: u32) -> Vec<u32> {
    if frame_durations_ms.is_empty() {
        return Vec::new();
    }
    let speed = if speed.is_finite() && speed > 0.0 {
        speed
    } else {
        1.0
    };
    let min_cs = if min_cs > 0 { min_cs } else { MIN_DELAY_CS };
    let mut delays = Vec::with_capacity(frame_durations_ms.len());
    let mut cumulative_ms = 0.0_f64;
    let mut assigned_cs = 0_u64;
    for duration in frame_durations_ms {
        let duration = if duration.is_finite() {
            duration.max(0.0)
        } else {
            0.0
        };
        cumulative_ms += duration / speed;
        let rounded = (cumulative_ms / 10.0).round() as i64;
        let mut cs = rounded - assigned_cs as i64;
        if cs < min_cs as i64 {
            cs = min_cs as i64;
        }
        delays.push(cs as u32);
        assigned_cs += cs as u64;
    }
    delays
}

/// 平均帧时长（毫秒）。
pub fn average_frame_duration(
    frame_durations_ms: &[f64],
    fallback_duration_sec: f64,
    frame_count: usize,
) -> f64 {
    if !frame_durations_ms.is_empty() {
        let total: f64 = frame_durations_ms.iter().map(|value| safe(*value)).sum();
        if total > 0.0 {
            return total / frame_durations_ms.len() as f64;
        }
    }
    if fallback_duration_sec > 0.0 && frame_count > 0 {
        return (fallback_duration_sec * 1000.0) / frame_count as f64;
    }
    0.0
}

/// gifski 名义帧率：只影响初始时长（最终延时会被 patch_delays 覆盖），
/// 但 gifski 限制 1-100，必须夹紧并保留 3 位小数。
pub fn compute_nominal_fps(average_ms: f64) -> f64 {
    if !(average_ms > 0.0) {
        return 25.0;
    }
    let fps = 1000.0 / average_ms;
    let clamped = fps.clamp(1.0, GIFSKI_MAX_FPS);
    round3(clamped)
}

/// 数字 fps 模式：把源总时长按输出帧数均匀分配（保持总时长）。
pub fn uniform_durations(duration_sec: f64, frame_count: usize) -> Vec<f64> {
    let count = frame_count.max(1);
    let duration = if duration_sec.is_finite() {
        duration_sec
    } else {
        0.0
    };
    let total_ms = (duration * 1000.0).max(1.0);
    vec![total_ms / count as f64; count]
}

/// 抽帧数量与源帧数不一致时：按时间比例把源帧时长合并成目标帧数。
pub fn group_durations(frame_durations_ms: &[f64], target_count: usize) -> Vec<f64> {
    let count = target_count.max(1);
    let durations: Vec<f64> = frame_durations_ms
        .iter()
        .map(|value| if value.is_finite() { value.max(0.0) } else { 0.0 })
        .collect();
    if durations.is_empty() {
        return vec![0.0; count];
    }
    if durations.len() == count {
        return durations;
    }
    let total: f64 = durations.iter().sum();
    if !(total > 0.0) {
        return vec![0.0; count];
    }
    let mut result = Vec::with_capacity(count);
    let mut cursor = 0_usize;
    let mut accumulated = 0.0_f64;
    for index in 0..count {
        let target_end = total * (index + 1) as f64 / count as f64;
        let mut group_total = 0.0_f64;
        while cursor < durations.len() && (accumulated < target_end || group_total == 0.0) {
            accumulated += durations[cursor];
            group_total += durations[cursor];
            cursor += 1;
            if cursor >= durations.len() {
                break;
            }
            if accumulated >= target_end {
                break;
            }
        }
        result.push(group_total);
    }
    // 理论上前面的循环会消耗完所有帧；若仍有剩余（浮点误差），并入最后一帧。
    let mut rest = 0.0_f64;
    while cursor < durations.len() {
        rest += durations[cursor];
        cursor += 1;
    }
    if rest > 0.0 {
        if let Some(last) = result.last_mut() {
            *last += rest;
        }
    }
    result
}

/// 把源逐帧时长对齐到目标帧数（抽帧数 / 编码后帧数与源不一致时的兜底）。
///
/// - 数量一致：原样返回；
/// - 目标更少：按时间比例合并相邻帧，保留 VFR 节奏与总时长；
/// - 目标更多：按源总时长均匀分配，保证总时长不漂移。
pub fn align_frame_durations(
    frame_durations_ms: &[f64],
    target_frames: usize,
    duration_sec: f64,
) -> Vec<f64> {
    let frames = target_frames;
    if frames == 0 {
        return Vec::new();
    }
    let durations: Vec<f64> = frame_durations_ms
        .iter()
        .map(|value| if value.is_finite() { value.max(0.0) } else { 0.0 })
        .collect();
    if durations.len() == frames && !durations.is_empty() {
        return durations;
    }
    if durations.is_empty() {
        return uniform_durations(duration_sec, frames);
    }
    if durations.len() > frames {
        return group_durations(&durations, frames);
    }
    uniform_durations(duration_sec, frames)
}

/// 编码前计算出的逐帧延时方案。
#[derive(Debug, Clone)]
pub struct DelayPlan {
    /// GIF 厘秒延时（WebP 编码时乘以 10 得到毫秒）。
    pub delays_cs: Vec<u32>,
    /// 对齐后的逐帧毫秒时长（与 Electron resolveDelaysForFrames 返回值一致，供调用方诊断）。
    #[allow(dead_code)]
    pub durations_ms: Vec<f64>,
    /// 目标帧数是否与源逐帧时长数量不同。
    pub aligned: bool,
}

/// 按目标帧数生成 GIF 厘秒延时（编码器输出帧数与抽帧数不一致时使用）。
///
/// `preserve_timing` 只在 `fps == source` 时生效（与 Electron 版一致）。
pub fn resolve_delays_for_frames(
    source_durations_ms: &[f64],
    source_duration_sec: f64,
    target_frames: usize,
    fps: FpsMode,
    preserve_timing: bool,
    speed: f64,
) -> DelayPlan {
    let frames = target_frames;
    let source_mode = matches!(fps, FpsMode::Source);
    let keep_timing = preserve_timing && source_mode;
    let durations_ms = if keep_timing && !source_durations_ms.is_empty() {
        align_frame_durations(source_durations_ms, frames, source_duration_sec)
    } else {
        uniform_durations(source_duration_sec, frames)
    };
    let delays_cs = compute_delays_cs(&durations_ms, speed, MIN_DELAY_CS);
    DelayPlan {
        delays_cs,
        durations_ms,
        aligned: frames != source_durations_ms.len(),
    }
}

/// gifski `--repeat` 取值：负数表示不循环（-1），否则取非负整数。
pub fn loop_to_repeat(loop_count: i32) -> i32 {
    if loop_count < 0 {
        -1
    } else {
        loop_count
    }
}

/// WebP 的 `-loop` 取值：muxer 只接受 0-65535（0 = 无限循环），-1（不循环）映射为 1。
pub fn loop_to_webp(loop_count: i32) -> u16 {
    if loop_count < 0 {
        1
    } else {
        loop_count.min(65535) as u16
    }
}

fn safe(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_30fps_keep_exact_total() {
        let durations = vec![1000.0 / 30.0; 90];
        let delays = compute_delays_cs(&durations, 1.0, MIN_DELAY_CS);
        assert_eq!(delays.len(), 90);
        assert_eq!(delays.iter().sum::<u32>(), 300);
        assert_eq!(&delays[..3], &[3, 4, 3]);
        assert!(delays.iter().all(|value| *value >= MIN_DELAY_CS));
    }

    #[test]
    fn delays_clamp_to_min_two_cs() {
        let delays = compute_delays_cs(&[1.0, 1.0, 1.0], 1.0, MIN_DELAY_CS);
        assert_eq!(delays, vec![2, 2, 2]);
    }

    #[test]
    fn speed_scales_duration() {
        let delays = compute_delays_cs(&[100.0, 100.0, 100.0], 2.0, MIN_DELAY_CS);
        assert_eq!(delays.iter().sum::<u32>(), 15);
        assert_eq!(delays, vec![5, 5, 5]);
        let slowed = compute_delays_cs(&[100.0, 100.0], 0.5, MIN_DELAY_CS);
        assert_eq!(slowed.iter().sum::<u32>(), 40);
    }

    #[test]
    fn nominal_fps_clamps_and_rounds() {
        assert_eq!(compute_nominal_fps(1000.0 / 30.0), 30.0);
        assert_eq!(compute_nominal_fps(0.0), 25.0);
        assert_eq!(compute_nominal_fps(0.1), 100.0);
        assert_eq!(compute_nominal_fps(100000.0), 1.0);
    }

    #[test]
    fn group_durations_preserves_total() {
        let durations = vec![10.0, 20.0, 30.0, 40.0];
        let grouped = group_durations(&durations, 2);
        assert_eq!(grouped.len(), 2);
        let total: f64 = grouped.iter().sum();
        assert_eq!(total, 100.0);
    }

    #[test]
    fn align_handles_all_cases() {
        let durations = vec![10.0, 20.0, 30.0, 40.0];
        assert_eq!(
            align_frame_durations(&durations, 4, 0.1).len(),
            4
        );
        assert_eq!(align_frame_durations(&durations, 2, 0.1).len(), 2);
        let expanded = align_frame_durations(&durations, 8, 0.1);
        assert_eq!(expanded.len(), 8);
        let expanded_total: f64 = expanded.iter().sum();
        assert!((expanded_total - 100.0).abs() < 1e-9);
        assert_eq!(align_frame_durations(&durations, 0, 0.1).len(), 0);
    }

    #[test]
    fn resolve_delays_source_mode_aligned() {
        let durations = vec![33.333_f64; 90];
        let plan = resolve_delays_for_frames(&durations, 3.0, 90, FpsMode::Source, true, 1.0);
        assert!(!plan.aligned);
        assert_eq!(plan.delays_cs.iter().sum::<u32>(), 300);
        let fewer = resolve_delays_for_frames(&durations, 3.0, 45, FpsMode::Source, true, 1.0);
        assert!(fewer.aligned);
        assert_eq!(fewer.delays_cs.len(), 45);
        assert_eq!(fewer.delays_cs.iter().sum::<u32>(), 300);
        let numeric = resolve_delays_for_frames(&durations, 3.0, 45, FpsMode::Numeric(15), true, 1.0);
        assert_eq!(numeric.delays_cs.iter().sum::<u32>(), 300);
    }

    #[test]
    fn loop_mappings_match_electron() {
        assert_eq!(loop_to_repeat(-1), -1);
        assert_eq!(loop_to_repeat(0), 0);
        assert_eq!(loop_to_repeat(3), 3);
        assert_eq!(loop_to_webp(-1), 1);
        assert_eq!(loop_to_webp(0), 0);
        assert_eq!(loop_to_webp(70000), 65535);
    }
}
