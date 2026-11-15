//! 外部工具（ffmpeg / gifski / gifsicle）定位与版本查询。
//!
//! 查找顺序（与 Electron 版 tools.cjs 对齐的可裁剪版本）：
//! 1. CLI 显式路径（--ffmpeg / --gifski / --gifsicle）；
//! 2. `--tools-dir` 指定的目录（POC 指向 x-gif-studio/tools/bin）；
//! 3. 环境变量 PATH。
//!
//! 主 Tauri 后端集成时建议替换为「应用工具目录 / 打包 resources / PATH」三级查找，
//! 见 docs/PORT-convert.md 第 6 节。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::process::{run_process, RunSpec};

#[derive(Debug, Clone)]
pub struct ToolPaths {
    pub ffmpeg: PathBuf,
    pub gifski: Option<PathBuf>,
    pub gifsicle: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct ToolError {
    pub message: String,
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ToolError {}

/// 工具定位的覆盖项。
#[derive(Default)]
pub struct ToolOverrides<'a> {
    pub tools_dir: Option<&'a Path>,
    pub ffmpeg: Option<&'a Path>,
    pub gifski: Option<&'a Path>,
    pub gifsicle: Option<&'a Path>,
}

/// 定位工具；ffmpeg 必需，gifski / gifsicle 缺失时返回 None 由调用方决定是否报错。
pub fn resolve_tools(overrides: &ToolOverrides<'_>) -> Result<ToolPaths, ToolError> {
    let ffmpeg = resolve_one("ffmpeg", overrides.ffmpeg, overrides.tools_dir)
        .ok_or_else(|| ToolError { message: missing_message("ffmpeg") })?;
    Ok(ToolPaths {
        ffmpeg,
        gifski: resolve_one("gifski", overrides.gifski, overrides.tools_dir),
        gifsicle: resolve_one("gifsicle", overrides.gifsicle, overrides.tools_dir),
    })
}

fn resolve_one(name: &str, explicit: Option<&Path>, tools_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(explicit) = explicit {
        return explicit.is_file().then(|| explicit.to_path_buf());
    }
    if let Some(directory) = tools_dir {
        let candidate = directory.join(exe_name(name));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path_value = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path_value) {
        for candidate_name in candidate_names(name) {
            let candidate = directory.join(candidate_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn candidate_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if name.to_ascii_lowercase().ends_with(".exe") {
            vec![name.to_string()]
        } else {
            vec![format!("{}.exe", name)]
        }
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn exe_name(name: &str) -> String {
    candidate_names(name).into_iter().next().unwrap_or_else(|| name.to_string())
}

fn missing_message(name: &str) -> String {
    format!(
        "缺少外部工具 {}。请用 --tools-dir 指向 x-gif-studio/tools/bin，或把 {} 放到 PATH 中",
        name, name
    )
}

/// 读取工具版本（第一条非空输出行），用于结果元数据与文档记录。
pub fn version_of(bin: &Path, args: &[&str]) -> Option<String> {
    let owned: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let result = run_process(
        &RunSpec {
            bin,
            args: &owned,
            cwd: None,
            timeout: Some(Duration::from_secs(20)),
            cancel: None,
        },
        &mut (),
    )
    .ok()?;
    let text = format!("{}\n{}", result.stdout, result.stderr);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

/// 一次性采集三个工具的版本信息。
pub fn collect_versions(tools: &ToolPaths) -> Vec<(String, String)> {
    let mut versions = Vec::new();
    if let Some(version) = version_of(&tools.ffmpeg, &["-version"]) {
        versions.push(("ffmpeg".to_string(), version));
    }
    if let Some(gifski) = tools.gifski.as_ref() {
        if let Some(version) = version_of(gifski, &["--version"]) {
            versions.push(("gifski".to_string(), version));
        }
    }
    if let Some(gifsicle) = tools.gifsicle.as_ref() {
        if let Some(version) = version_of(gifsicle, &["--version"]) {
            versions.push(("gifsicle".to_string(), version));
        }
    }
    versions
}
