//! ffmpeg 文本探测与产物验证。
//!
//! 两个用途：
//! 1. `probe_video`：MP4 结构解析失败时的兜底探测（解析 `ffmpeg -i` 的 stderr 文本）；
//! 2. `verify_with_ffmpeg`：真实解码产物，统计帧数 / 尺寸 / 时长，用于 POC 验收与集成自检。
//!
//! 不使用 ffprobe：x-gif-studio/tools/bin 只提供 ffmpeg.exe，与 Electron 版保持一致。

use std::path::Path;
use std::time::Duration;

use crate::process::{run_process, RunResult, RunSpec};

const VERIFY_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// 从 ffmpeg 文本输出解析出的源视频信息。
#[derive(Debug, Clone)]
pub struct FfmpegMediaProbe {
    pub width: u32,
    pub height: u32,
    pub duration_sec: f64,
    pub fps: f64,
    pub frame_count: usize,
    pub has_audio: bool,
}

/// `ffmpeg -i` 文本里解析出的基础信息。
#[derive(Debug, Clone)]
pub struct FfmpegMediaInfo {
    pub width: u32,
    pub height: u32,
    pub duration_sec: f64,
    pub fps: f64,
    pub has_audio: bool,
}

/// ffmpeg 真解码验证结果。
#[derive(Debug, Clone)]
pub struct FfmpegVerify {
    pub width: u32,
    pub height: u32,
    pub frame_count: u64,
    pub duration_sec: f64,
    pub exit_code: Option<i32>,
}

/// 兜底探测：先读 `ffmpeg -i` 文本，缺失帧数/时长时再做一次 null 解码统计。
pub fn probe_video(ffmpeg: &Path, input: &Path) -> Option<FfmpegMediaProbe> {
    let info_args = vec![
        "-hide_banner".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
    ];
    let info_result = run_capture(ffmpeg, &info_args).ok()?;
    let text = format!("{}\n{}", info_result.stderr, info_result.stdout);
    let mut parsed = parse_media_info(&text)?;

    let mut frame_count = if parsed.duration_sec > 0.0 && parsed.fps > 0.0 {
        (parsed.duration_sec * parsed.fps).round() as usize
    } else {
        0
    };
    if frame_count == 0 || !(parsed.duration_sec > 0.0) {
        if let Some((frames, out_time_sec)) = decode_stats(ffmpeg, input) {
            if frame_count == 0 {
                frame_count = frames as usize;
            }
            if !(parsed.duration_sec > 0.0) {
                parsed.duration_sec = if out_time_sec > 0.0 {
                    out_time_sec
                } else if parsed.fps > 0.0 {
                    frame_count as f64 / parsed.fps
                } else {
                    0.0
                };
            }
        }
    }
    if frame_count == 0 || !(parsed.duration_sec > 0.0) {
        return None;
    }
    Some(FfmpegMediaProbe {
        width: parsed.width,
        height: parsed.height,
        duration_sec: parsed.duration_sec,
        fps: parsed.fps,
        frame_count,
        has_audio: parsed.has_audio,
    })
}

/// 用 ffmpeg 真实解码产物：统计解码帧数与容器时长/尺寸。
pub fn verify_with_ffmpeg(ffmpeg: &Path, file: &Path) -> Result<FfmpegVerify, String> {
    let args = vec![
        "-hide_banner".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        "-i".to_string(),
        file.to_string_lossy().into_owned(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];
    let result = run_capture(ffmpeg, &args)
        .map_err(|error| format!("ffmpeg 验证命令启动失败：{}", error))?;
    if !result.success() {
        return Err(format!(
            "ffmpeg 验证命令失败（退出码 {:?}）：{}",
            result.code,
            result.tail(4)
        ));
    }
    let text = format!("{}\n{}", result.stderr, result.stdout);
    let info = parse_media_info(&text).ok_or_else(|| "无法从 ffmpeg 输出解析尺寸".to_string())?;
    let frames = parse_progress_frames(&result.stdout);
    let duration_sec = if info.duration_sec > 0.0 {
        info.duration_sec
    } else {
        parse_progress_out_time_sec(&result.stdout).unwrap_or(0.0)
    };
    if frames == 0 {
        return Err("ffmpeg 没有解码出任何帧".to_string());
    }
    Ok(FfmpegVerify {
        width: info.width,
        height: info.height,
        frame_count: frames,
        duration_sec: round3(duration_sec),
        exit_code: result.code,
    })
}

fn run_capture(bin: &Path, args: &[String]) -> std::io::Result<RunResult> {
    run_process(
        &RunSpec {
            bin,
            args,
            cwd: None,
            timeout: Some(VERIFY_TIMEOUT),
            cancel: None,
        },
        &mut (),
    )
}

fn decode_stats(ffmpeg: &Path, input: &Path) -> Option<(u64, f64)> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];
    let result = run_capture(ffmpeg, &args).ok()?;
    Some((
        parse_progress_frames(&result.stdout),
        parse_progress_out_time_sec(&result.stdout).unwrap_or(0.0),
    ))
}

/// 从 ffmpeg 文本输出解析宽高、时长、帧率、是否含音轨。
pub fn parse_media_info(text: &str) -> Option<FfmpegMediaInfo> {
    let mut width = 0_u32;
    let mut height = 0_u32;
    let mut duration_sec = 0.0_f64;
    let mut fps = 0.0_f64;
    let mut has_audio = false;
    for line in text.lines() {
        if line.contains("Duration:") {
            if let Some(duration) = parse_duration(line) {
                duration_sec = duration;
            }
        }
        if line.contains("Video:") && width == 0 {
            if let Some((parsed_width, parsed_height)) = find_dimensions(line) {
                width = parsed_width;
                height = parsed_height;
            }
            if let Some(parsed_fps) = find_fps(line) {
                fps = parsed_fps;
            }
        }
        if line.contains("Audio:") {
            has_audio = true;
        }
    }
    if width == 0 || height == 0 {
        return None;
    }
    Some(FfmpegMediaInfo {
        width,
        height,
        duration_sec,
        fps,
        has_audio,
    })
}

/// 解析 `-progress pipe:1` 输出里的最大 frame 值。
pub fn parse_progress_frames(stdout: &str) -> u64 {
    let mut last = 0_u64;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("frame=") {
            if let Ok(value) = rest.trim().parse::<u64>() {
                last = last.max(value);
            }
        }
    }
    last
}

/// 解析 `out_time_us=` 得到秒（媒体时间轴；最后一帧的显示时长不计入）。
pub fn parse_progress_out_time_sec(stdout: &str) -> Option<f64> {
    let mut last = None;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("out_time_us=") {
            if let Ok(value) = rest.trim().parse::<i64>() {
                if value >= 0 {
                    last = Some(value as f64 / 1_000_000.0);
                }
            }
        }
    }
    last
}

fn parse_duration(line: &str) -> Option<f64> {
    let index = line.find("Duration:")?;
    let rest = line[index + "Duration:".len()..].trim_start();
    let mut parts = rest.split(':');
    let hours = parts.next()?.trim().parse::<f64>().ok()?;
    let minutes = parts.next()?.trim().parse::<f64>().ok()?;
    let seconds_text = parts.next()?;
    let seconds = seconds_text.split(',').next()?.trim().parse::<f64>().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn find_dimensions(line: &str) -> Option<(u32, u32)> {
    let bytes = line.as_bytes();
    let mut index = 0_usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let width_start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            let width_len = index - width_start;
            if (2..=5).contains(&width_len)
                && index < bytes.len()
                && bytes[index] == b'x'
                && index + 1 < bytes.len()
                && bytes[index + 1].is_ascii_digit()
            {
                let height_start = index + 1;
                let mut height_end = height_start;
                while height_end < bytes.len() && bytes[height_end].is_ascii_digit() {
                    height_end += 1;
                }
                let height_len = height_end - height_start;
                if (2..=5).contains(&height_len) {
                    let width = line[width_start..index].parse::<u32>().ok()?;
                    let height = line[height_start..height_end].parse::<u32>().ok()?;
                    if width > 0 && height > 0 && width <= 16384 && height <= 16384 {
                        return Some((width, height));
                    }
                }
            }
            continue;
        }
        index += 1;
    }
    None
}

fn find_fps(line: &str) -> Option<f64> {
    for part in line.split(',') {
        let token = part.trim();
        if let Some(value) = token.strip_suffix(" fps") {
            if let Ok(fps) = value.trim().parse::<f64>() {
                if fps > 0.0 {
                    return Some(fps);
                }
            }
        }
    }
    None
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':\n  Duration: 00:00:03.00, start: 0.000000, bitrate: 458 kb/s\n  Stream #0:0: Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 480x270, 453 kb/s, 30 fps, 30 tbr\n";

    #[test]
    fn parses_ffmpeg_info_text() {
        let info = parse_media_info(SAMPLE).expect("info");
        assert_eq!(info.width, 480);
        assert_eq!(info.height, 270);
        assert_eq!(info.duration_sec, 3.0);
        assert_eq!(info.fps, 30.0);
    }

    #[test]
    fn parses_progress_frame_and_time() {
        let text = "frame=1\nframe=90\nout_time_us=2966667\nprogress=end\n";
        assert_eq!(parse_progress_frames(text), 90);
        assert!((parse_progress_out_time_sec(text).unwrap() - 2.966_667).abs() < 1e-6);
    }

    #[test]
    fn ignores_codec_fourcc_as_dimensions() {
        let (width, height) = find_dimensions(
            "Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 640x360 [SAR 1:1 DAR 16:9]",
        )
        .expect("dimensions");
        assert_eq!((width, height), (640, 360));
    }
}
