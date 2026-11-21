use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    let path = exe_dir().join("userdata");
    let _ = fs::create_dir_all(&path);
    path
}

pub fn path(name: &str) -> PathBuf {
    data_dir().join(name)
}

pub fn ensure_json<T: DeserializeOwned + Serialize>(name: &str, default: T) -> T {
    let target = path(name);
    if let Ok(bytes) = fs::read(&target) {
        if let Ok(value) = serde_json::from_slice(&bytes) {
            return value;
        }
    }
    let _ = write_json(name, &default);
    default
}

pub fn write_json<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(&path(name), &bytes)
}

pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = target.with_extension(format!("tmp-{nonce}-{count}"));
    fs::write(&temp, bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&temp, target).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("保存文件失败：{error}")
    })?;
    Ok(())
}
