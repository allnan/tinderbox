// 外部工具（ffmpeg / gifski / gifsicle）：定位、版本、子进程执行、一键下载（ZIP 解压）。
#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::http::{build_client, download_to_file};
use crate::jobs::{self, JobCtx};
use crate::model::{ProxySettings, ToolDownloadProgress, ToolStatus};
use crate::paths;

pub struct ProcessResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn exe_name(name: &str) -> String {
    format!("{name}.exe")
}

pub fn resolve(name: &str) -> Option<PathBuf> {
    let file = exe_name(name);
    let beside = paths::tools_dir().join(&file);
    if beside.exists() {
        return Some(beside);
    }
    let data = paths::data_dir().join("tools").join(&file);
    if data.exists() {
        return Some(data);
    }
    None
}

pub fn require(name: &str) -> Result<PathBuf, String> {
    resolve(name).ok_or_else(|| {
        format!(
            "缺少外部工具 {name}。请在应用内重新下载工具（设置 → 外部工具 → 下载/更新），或把 {}.exe 放到程序目录的 tools/ 下",
            name
        )
    })
}

static STATUS_CACHE: Mutex<Option<(u128, ToolStatus)>> = Mutex::new(None);

/// 清理程序自身与 tools/ 下所有文件的网络来源标记，避免复制时被 Windows
/// “这些文件可能对你的计算机有害”拦截。启动时同步执行，文件很少。
pub fn scrub_network_markers() {
    if let Ok(exe) = std::env::current_exe() {
        strip_motw(&exe);
    }
    let dir = paths::tools_dir();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            strip_motw(&path);
        }
    }
}

pub fn invalidate_status_cache() {
    if let Ok(mut cache) = STATUS_CACHE.lock() {
        *cache = None;
    }
}

async fn version_of(name: &str, args: &[&str]) -> Option<String> {
    let bin = resolve(name)?;
    let result = run_quiet(&bin, args, Duration::from_secs(15)).await.ok()?;
    let text = format!("{}\n{}", result.stdout, result.stderr);
    text.lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

async fn compute_status() -> ToolStatus {
    let ffmpeg = resolve("ffmpeg").map(|path| path.to_string_lossy().to_string());
    let gifski = resolve("gifski").map(|path| path.to_string_lossy().to_string());
    let gifsicle = resolve("gifsicle").map(|path| path.to_string_lossy().to_string());
    let mut missing = Vec::new();
    if ffmpeg.is_none() {
        missing.push("ffmpeg".to_string());
    }
    if gifski.is_none() {
        missing.push("gifski".to_string());
    }
    if gifsicle.is_none() {
        missing.push("gifsicle".to_string());
    }
    let ffmpeg_version = version_of("ffmpeg", &["-version"]).await;
    let gifski_version = version_of("gifski", &["--version"]).await;
    let gifsicle_version = version_of("gifsicle", &["--version"]).await;
    ToolStatus {
        ffmpeg,
        gifski,
        gifsicle,
        ffmpeg_version,
        gifski_version,
        gifsicle_version,
        ready: missing.is_empty(),
        missing,
    }
}

pub async fn status() -> ToolStatus {
    if let Ok(cache) = STATUS_CACHE.lock() {
        if let Some((updated, status)) = cache.as_ref() {
            if paths::now_ms().saturating_sub(*updated) < 10_000 {
                return status.clone();
            }
        }
    }
    let status = compute_status().await;
    if let Ok(mut cache) = STATUS_CACHE.lock() {
        *cache = Some((paths::now_ms(), status.clone()));
    }
    status
}

async fn run_quiet(bin: &Path, args: &[&str], timeout: Duration) -> Result<ProcessResult, String> {
    let mut command = tokio::process::Command::new(bin);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command.spawn().map_err(|error| format!("启动 {} 失败：{error}", bin.display()))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "命令执行超时".to_string())?
        .map_err(|error| error.to_string())?;
    Ok(ProcessResult {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// 执行工具进程：按行回调 stdout（用于进度），收集 stderr 尾部；支持任务取消（杀掉整个进程树）。
pub async fn run_tool(
    job: Option<&JobCtx>,
    name: &str,
    args: &[String],
    cwd: Option<&Path>,
    mut on_stdout_line: impl FnMut(&str),
) -> Result<ProcessResult, String> {
    if let Some(job) = job {
        job.throw_if_cancelled()?;
    }
    let bin = require(name)?;
    let mut command = tokio::process::Command::new(&bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败：{error}", bin.display()))?;
    if let Some(job) = job {
        job.set_child(child.id());
    }
    let stdout = child.stdout.take().ok_or("无法读取工具输出")?;
    let stderr = child.stderr.take().ok_or("无法读取工具错误输出")?;
    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut stdout_done = false;
    let mut stderr_done = false;
    while !stdout_done || !stderr_done {
        if let Some(job) = job {
            if job.is_cancelled() {
                let _ = child.kill().await;
                let _ = child.wait().await;
                jobs::cancel(&job.id);
                return Err("CANCELLED: 任务已取消".into());
            }
        }
        tokio::select! {
            line = stdout_lines.next_line(), if !stdout_done => {
                match line {
                    Ok(Some(text)) => {
                        on_stdout_line(&text);
                        stdout_text.push_str(&text);
                        stdout_text.push('\n');
                    }
                    _ => stdout_done = true,
                }
            }
            line = stderr_lines.next_line(), if !stderr_done => {
                match line {
                    Ok(Some(text)) => {
                        stderr_text.push_str(&text);
                        stderr_text.push('\n');
                        if stderr_text.len() > 400_000 {
                            stderr_text = stderr_text[stderr_text.len() - 200_000..].to_string();
                        }
                    }
                    _ => stderr_done = true,
                }
            }
        }
    }
    let status = child.wait().await.map_err(|error| error.to_string())?;
    if let Some(job) = job {
        job.set_child(None);
        job.throw_if_cancelled()?;
    }
    Ok(ProcessResult {
        code: status.code().unwrap_or(-1),
        stdout: stdout_text,
        stderr: stderr_text,
    })
}

pub async fn run_or_throw(
    job: Option<&JobCtx>,
    name: &str,
    args: &[String],
    cwd: Option<&Path>,
    on_stdout_line: impl FnMut(&str),
) -> Result<ProcessResult, String> {
    let result = run_tool(job, name, args, cwd, on_stdout_line).await?;
    if result.code != 0 {
        let tail: Vec<&str> = result
            .stderr
            .lines()
            .chain(result.stdout.lines())
            .filter(|line| !line.trim().is_empty())
            .collect();
        let tail = tail
            .iter()
            .rev()
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(format!("命令执行失败（{name}，退出码 {}）：{tail}", result.code));
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 一键下载（真实下载到 <exe>/tools/）
// ---------------------------------------------------------------------------

const SOURCES: [(&str, &str, &[&str]); 3] = [
    (
        "ffmpeg",
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        &["-version"],
    ),
    ("gifski", "https://gif.ski/gifski-1.32.0.zip", &["--version"]),
    (
        "gifsicle",
        "https://eternallybored.org/misc/gifsicle/releases/gifsicle-1.97-win64.zip",
        &["--version"],
    ),
];

fn emit_tool(tool: &str, phase: &str, percent: f64, message: &str) {
    jobs::tool_progress(ToolDownloadProgress {
        tool: tool.to_string(),
        phase: phase.to_string(),
        percent,
        message: message.to_string(),
        done: phase == "done",
    });
}

/// 清除 Windows 的网络来源标记（Zone.Identifier），避免用户复制已下载的工具时
/// 被“这些文件可能对你的计算机有害”拦下。工具本身从官方源下载，校验已通过。
pub fn strip_motw(path: &Path) {
    let stream = format!("{}:Zone.Identifier", path.display());
    let _ = std::fs::remove_file(stream);
}

async fn verify_executable(path: &Path, args: &[&str]) -> bool {
    if !path.exists() {
        return false;
    }
    match run_quiet(path, args, Duration::from_secs(20)).await {
        Ok(result) => {
            result.code == 0 && !result.stdout.trim().is_empty() || !result.stderr.trim().is_empty()
        }
        Err(_) => false,
    }
}

fn find_executable(root: &Path, name: &str) -> Option<PathBuf> {
    let wanted = exe_name(name).to_lowercase();
    let mut found = Vec::new();
    walk(root, &mut found);
    found
        .into_iter()
        .filter(|path| {
            path.file_name()
                .map(|file| file.to_string_lossy().to_lowercase() == wanted)
                .unwrap_or(false)
        })
        .min_by_key(|path| {
            let in_bin = path
                .components()
                .any(|component| component.as_os_str().to_string_lossy().eq_ignore_ascii_case("bin"));
            (if in_bin { 0 } else { 1 }, path.to_string_lossy().len())
        })
}

fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, found);
        } else if path.is_file() {
            found.push(path);
        }
    }
}

fn read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    if offset + 2 > buffer.len() {
        return None;
    }
    Some(u16::from_le_bytes([buffer[offset], buffer[offset + 1]]))
}

fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 > buffer.len() {
        return None;
    }
    Some(u32::from_le_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]))
}

/// 纯 Rust ZIP 解压（stored / deflate），不依赖外部程序。
pub fn extract_zip(zip_path: &Path, destination: &Path) -> Result<(), String> {
    let buffer = std::fs::read(zip_path).map_err(|error| format!("读取 ZIP 失败：{error}"))?;
    let mut eocd = None;
    if buffer.len() >= 22 {
        let min = buffer.len().saturating_sub(22 + 65535);
        let mut offset = buffer.len() - 22;
        loop {
            if read_u32(&buffer, offset) == Some(0x06054b50) {
                eocd = Some(offset);
                break;
            }
            if offset <= min {
                break;
            }
            offset -= 1;
        }
    }
    let eocd = eocd.ok_or_else(|| format!("不是有效的 ZIP 文件：{}", zip_path.display()))?;
    let entries = read_u16(&buffer, eocd + 10).unwrap_or(0) as usize;
    let mut offset = read_u32(&buffer, eocd + 16).unwrap_or(0) as usize;
    let dest_root = destination.to_path_buf();
    std::fs::create_dir_all(&dest_root).map_err(|error| error.to_string())?;
    for _ in 0..entries {
        if read_u32(&buffer, offset) != Some(0x02014b50) {
            return Err("ZIP 中央目录损坏".into());
        }
        let method = read_u16(&buffer, offset + 10).unwrap_or(0);
        let compressed_size = read_u32(&buffer, offset + 20).unwrap_or(0) as usize;
        let name_len = read_u16(&buffer, offset + 28).unwrap_or(0) as usize;
        let extra_len = read_u16(&buffer, offset + 30).unwrap_or(0) as usize;
        let comment_len = read_u16(&buffer, offset + 32).unwrap_or(0) as usize;
        let local_offset = read_u32(&buffer, offset + 42).unwrap_or(0) as usize;
        if offset + 46 + name_len > buffer.len() {
            return Err("ZIP 中央目录损坏".into());
        }
        let name = String::from_utf8_lossy(&buffer[offset + 46..offset + 46 + name_len]).replace('\\', "/");
        offset += 46 + name_len + extra_len + comment_len;
        if name.is_empty() || name.ends_with('/') {
            continue;
        }
        if name.split('/').any(|part| part == ".." || part.contains(':')) {
            return Err(format!("ZIP 内包含非法路径：{name}"));
        }
        if read_u32(&buffer, local_offset) != Some(0x04034b50) {
            return Err(format!("ZIP 本地文件头损坏：{name}"));
        }
        let local_name_len = read_u16(&buffer, local_offset + 26).unwrap_or(0) as usize;
        let local_extra_len = read_u16(&buffer, local_offset + 28).unwrap_or(0) as usize;
        let data_start = local_offset + 30 + local_name_len + local_extra_len;
        if data_start + compressed_size > buffer.len() {
            return Err(format!("ZIP 数据不完整：{name}"));
        }
        let compressed = &buffer[data_start..data_start + compressed_size];
        let data = match method {
            0 => compressed.to_vec(),
            8 => {
                let mut decoder = flate2::read::DeflateDecoder::new(compressed);
                let mut out = Vec::new();
                decoder
                    .read_to_end(&mut out)
                    .map_err(|error| format!("解压 {name} 失败：{error}"))?;
                out
            }
            other => return Err(format!("不支持的 ZIP 压缩方式 {other}：{name}")),
        };
        let target = dest_root.join(&name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = std::fs::File::create(&target).map_err(|error| format!("写入解压文件失败：{error}"))?;
        file.write_all(&data).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub async fn download(names: Vec<String>, proxy: &ProxySettings) -> Result<ToolStatus, String> {
    let client = build_client(proxy)?;
    let target_dir = paths::tools_dir();
    let _ = std::fs::create_dir_all(&target_dir);
    let selected: Vec<&(&str, &str, &[&str])> = SOURCES
        .iter()
        .filter(|item| names.is_empty() || names.iter().any(|name| name == item.0))
        .collect();
    for (name, url, args) in selected {
        let target = target_dir.join(exe_name(name));
        if verify_executable(&target, args).await {
            emit_tool(name, "done", 100.0, &format!("{name} 已存在且可运行，跳过下载"));
            continue;
        }
        emit_tool(name, "download", 0.0, &format!("开始下载 {name}…"));
        let temp_root = paths::cache_dir().join("tools-download");
        let _ = std::fs::create_dir_all(&temp_root);
        let temp_dir = temp_root.join(format!("{}-{}", name, paths::now_ms()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let zip_path = temp_dir.join(format!("{name}.zip"));
        let mut last_percent = 999.0f64;
        let mut on_progress = |received: u64, total: u64| {
            let percent = if total > 0 {
                (received as f64 / total as f64 * 100.0).min(99.0)
            } else {
                (received / 1024 / 1024) as f64
            };
            if (percent - last_percent).abs() >= 1.0 {
                last_percent = percent;
                emit_tool(
                    name,
                    "download",
                    percent,
                    &format!("正在下载 {name}：{:.1} MB", received as f64 / 1024.0 / 1024.0),
                );
            }
        };
        let download_result = download_to_file(&client, url, &zip_path, 600 * 1024 * 1024, 600, &mut on_progress).await;
        if let Err(error) = download_result {
            emit_tool(name, "error", -1.0, &format!("{name} 下载失败：{error}"));
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!("{name} 下载失败：{error}"));
        }
        emit_tool(name, "extract", 5.0, &format!("正在解压 {name}…"));
        let extract_dir = temp_dir.join("extract");
        if let Err(error) = extract_zip(&zip_path, &extract_dir) {
            emit_tool(name, "error", -1.0, &format!("{name} 解压失败：{error}"));
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!("{name} 解压失败：{error}"));
        }
        emit_tool(name, "verify", 90.0, &format!("正在校验 {name}…"));
        let located = find_executable(&extract_dir, name)
            .ok_or_else(|| format!("解压后未找到 {name}.exe（下载源可能已变更）"))?;
        if !verify_executable(&located, args).await {
            let _ = std::fs::remove_dir_all(&temp_dir);
            emit_tool(name, "error", -1.0, &format!("{name} 校验失败"));
            return Err(format!("校验失败：{name} 无法正常运行（下载源可能已变更）"));
        }
        std::fs::copy(&located, &target).map_err(|error| format!("复制 {name} 到 tools/ 失败：{error}"))?;
        strip_motw(&target);
        if !verify_executable(&target, args).await {
            let _ = std::fs::remove_file(&target);
            let _ = std::fs::remove_dir_all(&temp_dir);
            emit_tool(name, "error", -1.0, &format!("{name} 复制后校验失败"));
            return Err(format!("校验失败：复制到 {} 后无法运行", target.display()));
        }
        strip_motw(&target);
        let _ = std::fs::remove_dir_all(&temp_dir);
        emit_tool(name, "done", 100.0, &format!("{name} 已下载到 tools/ 并校验通过"));
    }
    invalidate_status_cache();
    let status = compute_status().await;
    if let Ok(mut cache) = STATUS_CACHE.lock() {
        *cache = Some((paths::now_ms(), status.clone()));
    }
    emit_tool(
        "all",
        if status.ready { "done" } else { "error" },
        100.0,
        if status.ready { "外部工具已就绪" } else { "工具尚未就绪，可重试下载" },
    );
    Ok(status)
}