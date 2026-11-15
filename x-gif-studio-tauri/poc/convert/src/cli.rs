//! CLI 参数解析与 JSON 输出（进度行 / 最终结果 / 错误）。
//!
//! 主 Tauri 后端集成时不需要这一层：直接构造 `pipeline::ConvertRequest` 并传入
//! 实现 `ProgressSink` 的适配器即可，见 docs/PORT-convert.md 第 6 节。

use std::path::PathBuf;

use crate::params::{AnimFormat, Dither, Encoder, FpsMode, GifParams};
use crate::pipeline::{ConvertError, ConvertResult};
use crate::progress::{Phase, ProgressEvent, ProgressSink};

/// 解析后的 CLI 选项。
pub struct CliOptions {
    pub input: PathBuf,
    pub output: PathBuf,
    pub format: AnimFormat,
    pub params: GifParams,
    pub tools_dir: Option<PathBuf>,
    pub ffmpeg: Option<PathBuf>,
    pub gifski: Option<PathBuf>,
    pub gifsicle: Option<PathBuf>,
    pub work_dir: Option<PathBuf>,
    pub keep_frames: bool,
    pub verify: bool,
    pub progress_json: bool,
    pub dump_delays: bool,
}

pub enum ParseOutcome {
    Run(CliOptions),
    Help,
}

pub fn parse_args(args: &[String]) -> Result<ParseOutcome, String> {
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut format: Option<AnimFormat> = None;
    let mut params = GifParams::default();
    let mut tools_dir = None;
    let mut ffmpeg = None;
    let mut gifski = None;
    let mut gifsicle = None;
    let mut work_dir = None;
    let mut keep_frames = false;
    let mut verify = true;
    let mut progress_json = false;
    let mut dump_delays = false;

    let mut index = 0_usize;
    while index < args.len() {
        let argument = args[index].as_str();
        let mut value = |name: &str| -> Result<String, String> {
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| format!("参数 {} 缺少取值", name))
        };
        match argument {
            "-h" | "--help" => return Ok(ParseOutcome::Help),
            "-i" | "--input" => input = Some(PathBuf::from(value("--input")?)),
            "-o" | "--output" => output = Some(PathBuf::from(value("--output")?)),
            "--format" => {
                let raw = value("--format")?;
                format = Some(match raw.as_str() {
                    "gif" => AnimFormat::Gif,
                    "webp" => AnimFormat::Webp,
                    _ => return Err(format!("--format 只接受 gif / webp，收到：{}", raw)),
                });
            }
            "--encoder" => {
                let raw = value("--encoder")?;
                params.encoder = match raw.as_str() {
                    "gifski" => Encoder::Gifski,
                    "ffmpeg" => Encoder::Ffmpeg,
                    _ => return Err(format!("--encoder 只接受 gifski / ffmpeg，收到：{}", raw)),
                };
            }
            "--fps" => {
                let raw = value("--fps")?;
                params.fps = if raw == "source" {
                    FpsMode::Source
                } else {
                    FpsMode::Numeric(
                        raw.parse::<u32>()
                            .map_err(|_| format!("--fps 只接受 source 或整数，收到：{}", raw))?,
                    )
                };
            }
            "--width" => {
                let raw = value("--width")?;
                params.width = if raw == "source" {
                    None
                } else {
                    Some(
                        raw.parse::<u32>()
                            .map_err(|_| format!("--width 只接受 source 或整数，收到：{}", raw))?,
                    )
                };
            }
            "--colors" => {
                params.colors = value("--colors")?
                    .parse::<u32>()
                    .map_err(|_| "--colors 需要整数".to_string())?;
            }
            "--quality" => {
                params.quality = value("--quality")?
                    .parse::<u32>()
                    .map_err(|_| "--quality 需要整数".to_string())?;
            }
            "--dither" => {
                let raw = value("--dither")?;
                params.dither = match raw.as_str() {
                    "sierra2_4a" => Dither::Sierra2_4a,
                    "bayer" => Dither::Bayer,
                    "none" => Dither::None,
                    _ => {
                        return Err(format!(
                            "--dither 只接受 sierra2_4a / bayer / none，收到：{}",
                            raw
                        ))
                    }
                };
            }
            "--loop" => {
                params.loop_count = value("--loop")?
                    .parse::<i32>()
                    .map_err(|_| "--loop 需要整数（-1 表示不循环）".to_string())?;
            }
            "--speed" => {
                params.speed = value("--speed")?
                    .parse::<f64>()
                    .map_err(|_| "--speed 需要数字".to_string())?;
            }
            "--lossy" => {
                params.lossy = value("--lossy")?
                    .parse::<u32>()
                    .map_err(|_| "--lossy 需要整数".to_string())?;
            }
            "--no-preserve-timing" => params.preserve_timing = false,
            "--optimize" => params.optimize = true,
            "--tools-dir" => tools_dir = Some(PathBuf::from(value("--tools-dir")?)),
            "--ffmpeg" => ffmpeg = Some(PathBuf::from(value("--ffmpeg")?)),
            "--gifski" => gifski = Some(PathBuf::from(value("--gifski")?)),
            "--gifsicle" => gifsicle = Some(PathBuf::from(value("--gifsicle")?)),
            "--work-dir" => work_dir = Some(PathBuf::from(value("--work-dir")?)),
            "--keep-frames" => keep_frames = true,
            "--verify" => verify = true,
            "--no-verify" => verify = false,
            "--progress-json" => progress_json = true,
            "--dump-delays" => dump_delays = true,
            other => return Err(format!("未知参数：{}", other)),
        }
        index += 1;
    }

    let input = input.ok_or_else(|| "缺少必填参数 --input".to_string())?;
    let output = output.ok_or_else(|| "缺少必填参数 --output".to_string())?;
    let format = match format {
        Some(format) => format,
        None => infer_format(&output)
            .ok_or_else(|| "无法从输出扩展名判断格式，请显式传 --format gif|webp".to_string())?,
    };
    Ok(ParseOutcome::Run(CliOptions {
        input,
        output,
        format,
        params,
        tools_dir,
        ffmpeg,
        gifski,
        gifsicle,
        work_dir,
        keep_frames,
        verify,
        progress_json,
        dump_delays,
    }))
}

fn infer_format(output: &std::path::Path) -> Option<AnimFormat> {
    let extension = output.extension()?.to_string_lossy().to_ascii_lowercase();
    match extension.as_str() {
        "gif" => Some(AnimFormat::Gif),
        "webp" => Some(AnimFormat::Webp),
        _ => None,
    }
}

pub fn usage() -> String {
    [
        "xgif-convert-poc - X 媒体工坊 GIF/WebP 转换流水线 Rust 原型",
        "",
        "用法：",
        "  xgif-convert-poc --input <视频> --output <产物> [参数]",
        "",
        "必填：",
        "  -i, --input <path>        源视频（X 媒体 MP4；其它容器走 ffmpeg 文本探测兜底）",
        "  -o, --output <path>       输出文件；扩展名决定格式（也可用 --format 显式指定）",
        "",
        "常用参数：",
        "  --format <gif|webp>       输出格式（默认按扩展名）",
        "  --encoder <gifski|ffmpeg> GIF 编码器（默认 gifski；ffmpeg = 两遍调色板法）",
        "  --fps <source|4-60>       默认 source（passthrough，不重采样、不抽帧）",
        "  --width <source|64-1920>  目标宽度，只缩不放（默认 source）",
        "  --colors <16-256>         ffmpeg GIF 调色板颜色数（默认 256）",
        "  --quality <1-100>         gifski / WebP 质量（默认 92）",
        "  --dither <sierra2_4a|bayer|none>  ffmpeg GIF 抖动（默认 sierra2_4a）",
        "  --loop <-1-100>           循环次数：-1 不循环，0 无限（默认 0）",
        "  --speed <0.25-4>          速度快慢（默认 1）",
        "  --optimize                可选 gifsicle 极限压缩（默认关闭）",
        "  --lossy <0-200>           gifsicle --lossy（需 --optimize）",
        "  --no-preserve-timing      不按源逐帧时长还原延时",
        "",
        "工具与运行：",
        "  --tools-dir <dir>         工具目录（指向 x-gif-studio/tools/bin）",
        "  --ffmpeg/--gifski/--gifsicle <path>  单独指定工具路径",
        "  --work-dir <dir>          帧 / 中间产物目录（默认 <输出目录>/.convert-work-<pid>）",
        "  --keep-frames             保留抽出的 PNG 帧与中间产物",
        "  --verify / --no-verify    转换后用 ffmpeg 真实解码校验（默认开启）",
        "  --progress-json           额外向 stdout 输出 JSON 进度行",
        "  --dump-delays             结果 JSON 中附带完整逐帧厘秒延时",
        "  -h, --help                显示本帮助",
        "",
        "示例：",
        "  xgif-convert-poc --input testdata/source-3s-30fps.mp4 --output out/gifski.gif --tools-dir <工具目录>",
        "  xgif-convert-poc --input testdata/source-3s-30fps.mp4 --output out/animated.webp --format webp --tools-dir <工具目录>",
        "",
        "退出码：0 成功；1 转换 / 验证失败；2 参数错误。",
    ]
    .join("\n")
}

/// CLI 进度输出：人类可读行写 stderr，机器可读 JSON 行进 stdout（--progress-json）。
pub struct CliProgressSink {
    pub json: bool,
}

impl ProgressSink for CliProgressSink {
    fn progress(&mut self, event: &ProgressEvent) {
        eprintln!(
            "[{:>5.1}%] {:<8} {}",
            event.percent,
            phase_label(event.phase),
            event.message
        );
        if self.json {
            println!("{}", progress_json(event));
        }
    }
}

fn phase_label(phase: Phase) -> &'static str {
    match phase {
        Phase::Queued => "准备",
        Phase::Probe => "探测",
        Phase::Extract => "抽帧",
        Phase::Encode => "编码",
        Phase::Optimize => "优化",
        Phase::Finalize => "收尾",
        Phase::Done => "完成",
        Phase::Cancelled => "取消",
        Phase::Error => "失败",
    }
}

fn progress_json(event: &ProgressEvent) -> String {
    let mut json = String::from("{\"type\":\"progress\",");
    json.push_str(&format!("\"phase\":\"{}\",", event.phase.as_str()));
    json.push_str(&format!("\"percent\":{:.1},", event.percent));
    json.push_str(&format!("\"message\":\"{}\"", json_escape(&event.message)));
    if let Some(frame) = event.frame {
        json.push_str(&format!(",\"frame\":{}", frame));
    }
    if let Some(total) = event.total_frames {
        json.push_str(&format!(",\"totalFrames\":{}", total));
    }
    json.push('}');
    json
}

/// 最终结果 JSON（单行）。
pub fn result_json(result: &ConvertResult, dump_delays: bool) -> String {
    let delay_total: u64 = result.frame_delays_ms.iter().map(|ms| u64::from(*ms)).sum();
    let min_cs = result.frame_delays_ms.iter().map(|ms| ms / 10).min().unwrap_or(0);
    let max_cs = result.frame_delays_ms.iter().map(|ms| ms / 10).max().unwrap_or(0);
    let mut json = String::from("{\"type\":\"result\",\"ok\":true,");
    json.push_str(&format!("\"outputPath\":\"{}\",", json_escape(&result.output_path.to_string_lossy())));
    json.push_str(&format!("\"format\":\"{}\",", result.format.extension()));
    json.push_str(&format!("\"encoder\":\"{}\",", json_escape(&result.encoder)));
    json.push_str(&format!("\"width\":{},", result.width));
    json.push_str(&format!("\"height\":{},", result.height));
    json.push_str(&format!("\"frameCount\":{},", result.frame_count));
    json.push_str(&format!("\"durationSec\":{:.3},", result.duration_sec));
    json.push_str(&format!("\"fps\":{:.3},", result.fps));
    json.push_str(&format!("\"sizeBytes\":{},", result.size_bytes));
    match result.loop_count {
        Some(loop_count) => json.push_str(&format!("\"loopCount\":{},", loop_count)),
        None => json.push_str("\"loopCount\":null,"),
    }
    json.push_str(&format!(
        "\"delaySummary\":{{\"count\":{},\"totalMs\":{},\"minCs\":{},\"maxCs\":{}{}}},",
        result.frame_delays_ms.len(),
        delay_total,
        min_cs,
        max_cs,
        if dump_delays {
            format!(
                ",\"delaysCs\":[{}]",
                result
                    .frame_delays_ms
                    .iter()
                    .map(|ms| (ms / 10).to_string())
                    .collect::<Vec<String>>()
                    .join(",")
            )
        } else {
            String::new()
        }
    ));
    json.push_str(&format!("\"source\":{},", source_json(result)));
    match &result.ffmpeg_verify {
        Some(verify) => {
            let exit_code = match verify.exit_code {
                Some(code) => code.to_string(),
                None => "null".to_string(),
            };
            json.push_str(&format!(
                "\"ffmpegVerify\":{{\"width\":{},\"height\":{},\"frameCount\":{},\"durationSec\":{:.3},\"exitCode\":{}}},",
                verify.width, verify.height, verify.frame_count, verify.duration_sec, exit_code
            ));
        }
        None => json.push_str("\"ffmpegVerify\":null,"),
    }
    json.push_str(&format!(
        "\"toolVersions\":{{{}}},",
        result
            .tool_versions
            .iter()
            .map(|(name, version)| format!("\"{}\":\"{}\"", json_escape(name), json_escape(version)))
            .collect::<Vec<String>>()
            .join(",")
    ));
    json.push_str(&format!("\"elapsedMs\":{},", result.elapsed_ms));
    json.push_str(&format!(
        "\"warnings\":[{}]}}",
        result
            .warnings
            .iter()
            .map(|warning| format!("\"{}\"", json_escape(warning)))
            .collect::<Vec<String>>()
            .join(",")
    ));
    json
}

fn source_json(result: &ConvertResult) -> String {
    let timescale = match result.source.timescale {
        Some(value) => value.to_string(),
        None => "null".to_string(),
    };
    format!(
        "{{\"path\":\"{}\",\"width\":{},\"height\":{},\"frameCount\":{},\"durationSec\":{:.3},\"fps\":{:.3},\"sizeBytes\":{},\"timescale\":{},\"hasAudio\":{},\"warnings\":[{}]}}",
        json_escape(&result.source.path),
        result.source.width,
        result.source.height,
        result.source.frame_count,
        result.source.duration_sec,
        result.source.fps,
        result.source.size_bytes,
        timescale,
        result.source.has_audio,
        result
            .source
            .warnings
            .iter()
            .map(|warning| format!("\"{}\"", json_escape(warning)))
            .collect::<Vec<String>>()
            .join(",")
    )
}

/// 错误 JSON（单行）。
pub fn error_json(error: &ConvertError) -> String {
    let mut json = String::from("{\"type\":\"error\",\"ok\":false,");
    json.push_str(&format!("\"code\":\"{}\",", json_escape(&error.code)));
    json.push_str(&format!("\"stage\":\"{}\",", json_escape(&error.stage)));
    json.push_str(&format!("\"message\":\"{}\"", json_escape(&error.message)));
    if let Some(tail) = &error.stderr_tail {
        json.push_str(&format!(",\"stderrTail\":\"{}\"", json_escape(tail)));
    }
    json.push('}');
    json
}

pub fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 8);
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                escaped.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_format_from_extension() {
        assert_eq!(
            infer_format(std::path::Path::new("a.gif")),
            Some(AnimFormat::Gif)
        );
        assert_eq!(
            infer_format(std::path::Path::new("a.WEBP")),
            Some(AnimFormat::Webp)
        );
        assert_eq!(infer_format(std::path::Path::new("a.png")), None);
    }

    #[test]
    fn parses_progress_and_delay_flags() {
        let args: Vec<String> = [
            "--input",
            "in.mp4",
            "--output",
            "out.webp",
            "--fps",
            "15",
            "--width",
            "320",
            "--loop",
            "-1",
            "--optimize",
            "--progress-json",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        match parse_args(&args).expect("parse") {
            ParseOutcome::Run(options) => {
                assert_eq!(options.format, AnimFormat::Webp);
                assert_eq!(options.params.fps, FpsMode::Numeric(15));
                assert_eq!(options.params.width, Some(320));
                assert_eq!(options.params.loop_count, -1);
                assert!(options.params.optimize);
                assert!(options.progress_json);
            }
            ParseOutcome::Help => panic!("expected run"),
        }
    }

    #[test]
    fn rejects_unknown_argument() {
        assert!(parse_args(&["--nope".to_string()]).is_err());
    }

    #[test]
    fn json_escape_handles_quotes_and_newlines() {
        assert_eq!(json_escape("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }
}
