//! 文件写入工具：先写临时文件再原子替换，避免半截文件覆盖已有产物。

use std::io::Write;
use std::path::{Path, PathBuf};

/// 生成同目录临时路径（带 pid 与纳秒时间戳，避免并发冲突）。
pub fn temporary_path(path: &Path) -> PathBuf {
    let mut file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    file_name.push_str(&format!(
        ".tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    path.with_file_name(file_name)
}

/// 把临时文件替换到目标位置（Windows 下先删除已有目标）。
pub fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        let _ = std::fs::remove_file(to);
    }
    std::fs::rename(from, to)
}

/// 原子写入字节。
pub fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let temporary = temporary_path(path);
    {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
    }
    replace_file(&temporary, path)
}

/// 原子复制文件（最终产物从工作目录拷到输出路径时使用）。
pub fn copy_atomically(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let temporary = temporary_path(to);
    std::fs::copy(from, &temporary)?;
    replace_file(&temporary, to)
}
