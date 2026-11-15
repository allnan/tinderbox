//! xgif-convert-poc：X 媒体工坊 GIF/WebP 转换流水线 Rust 原型。
//!
//! 在 `x-gif-studio-tauri/poc/convert` 下独立构建，不修改 x-gif-studio：
//! 只读取并使用 `x-gif-studio/tools/bin` 下的 ffmpeg / gifski / gifsicle。
//! 集成说明见 `x-gif-studio-tauri/docs/PORT-convert.md`。
//!
//! 用法示例：
//!   xgif-convert-poc --input testdata/source-3s-30fps.mp4 --output out/gifski.gif \
//!     --tools-dir E:\\github-repositories\\tinderbox\\x-gif-studio\\tools\\bin

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use xgif_convert_poc::cli::{self, CliOptions, CliProgressSink, ParseOutcome};
use xgif_convert_poc::pipeline::{self, ConvertError, ConvertRequest};
use xgif_convert_poc::tools::{self, ToolOverrides};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("{}", cli::usage());
        std::process::exit(2);
    }
    let options = match cli::parse_args(&args) {
        Ok(ParseOutcome::Help) => {
            println!("{}", cli::usage());
            return;
        }
        Ok(ParseOutcome::Run(options)) => options,
        Err(message) => {
            eprintln!("参数错误：{}", message);
            eprintln!();
            eprintln!("{}", cli::usage());
            std::process::exit(2);
        }
    };
    if let Err(exit_code) = run(options) {
        std::process::exit(exit_code);
    }
}

fn run(options: CliOptions) -> Result<(), i32> {
    let tool_overrides = ToolOverrides {
        tools_dir: options.tools_dir.as_deref(),
        ffmpeg: options.ffmpeg.as_deref(),
        gifski: options.gifski.as_deref(),
        gifsicle: options.gifsicle.as_deref(),
    };
    let tools = match tools::resolve_tools(&tool_overrides) {
        Ok(tools) => tools,
        Err(error) => {
            eprintln!("{}", error.message);
            let failure = ConvertError {
                code: "TOOLS_MISSING".to_string(),
                stage: "准备".to_string(),
                message: error.message,
                stderr_tail: None,
            };
            println!("{}", cli::error_json(&failure));
            return Err(1);
        }
    };
    eprintln!(
        "工具：ffmpeg={} gifski={} gifsicle={}",
        tools.ffmpeg.display(),
        tools
            .gifski
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "（未找到）".to_string()),
        tools
            .gifsicle
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "（未找到）".to_string()),
    );

    let explicit_work_dir = options.work_dir.is_some();
    let work_dir = options
        .work_dir
        .clone()
        .unwrap_or_else(|| default_work_dir(&options.output));
    let created_work_dir = !work_dir.exists();
    if let Err(error) = std::fs::create_dir_all(&work_dir) {
        let failure = ConvertError {
            code: "IO_ERROR".to_string(),
            stage: "准备".to_string(),
            message: format!("创建临时目录失败（{}）：{}", work_dir.display(), error),
            stderr_tail: None,
        };
        eprintln!("{}", failure.message);
        println!("{}", cli::error_json(&failure));
        return Err(1);
    }

    let request = ConvertRequest {
        input: options.input.clone(),
        output: options.output.clone(),
        format: options.format,
        params: options.params.clone(),
        tools,
        work_dir: work_dir.clone(),
        keep_frames: options.keep_frames,
        verify_with_ffmpeg: options.verify,
        cancel: Arc::new(AtomicBool::new(false)),
    };
    let mut sink = CliProgressSink {
        json: options.progress_json,
    };
    let outcome = pipeline::convert(&request, &mut sink);

    if created_work_dir && !options.keep_frames && !explicit_work_dir {
        let _ = std::fs::remove_dir_all(&work_dir);
    }
    match outcome {
        Ok(result) => {
            println!("{}", cli::result_json(&result, options.dump_delays));
            eprintln!(
                "完成：{}（{:.2} MB，{} 帧，{:.3} 秒，耗时 {}ms）",
                result.output_path.display(),
                result.size_bytes as f64 / 1024.0 / 1024.0,
                result.frame_count,
                result.duration_sec,
                result.elapsed_ms
            );
            Ok(())
        }
        Err(error) => {
            eprintln!("失败：{}", error);
            println!("{}", cli::error_json(&error));
            Err(1)
        }
    }
}

fn default_work_dir(output: &Path) -> PathBuf {
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    parent.join(format!(".convert-work-{}", std::process::id()))
}
