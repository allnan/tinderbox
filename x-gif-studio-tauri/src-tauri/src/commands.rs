// Tauri 命令：前端 window.desktop 的真实实现（除剪贴板外的全部桌面能力）。
#![allow(dead_code)]

use std::path::PathBuf;
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::convert;
use crate::history;
use crate::http;
use crate::jobs;
use crate::media;
use crate::model::{fail, fail_code, ok, AppInfo, AppSettings, MediaProbe, ProxySettings, TweetMedia};
use crate::paths;
use crate::settings;
use crate::tools;
use crate::tweet;

fn op_result<T: serde::Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(data) => ok(json!(data)),
        Err(error) => {
            if error.starts_with("CANCELLED") {
                fail_code("任务已取消", "CANCELLED")
            } else {
                fail(error)
            }
        }
    }
}

fn command_error(error: impl Into<String>) -> String {
    error.into()
}

fn open_path(path: &str) -> Result<String, String> {
    open::that(path).map_err(|error| format!("打开失败：{error}"))?;
    Ok(path.to_string())
}

fn reveal_path(path: &str) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("定位文件失败：{error}"))
}

fn remove_file(path: &str) -> Result<bool, String> {
    if PathBuf::from(path).exists() {
        std::fs::remove_file(path).map_err(|error| format!("删除文件失败：{error}"))?;
    }
    Ok(true)
}

async fn save_dialog(default_name: Option<String>) -> Result<Option<PathBuf>, String> {
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(name) = default_name {
            dialog = dialog.set_file_name(name);
        }
        dialog.save_file()
    });
    handle.await.map_err(|error| format!("打开保存对话框失败：{error}"))
}

async fn choose_directory_dialog() -> Result<Option<String>, String> {
    let handle = tauri::async_runtime::spawn_blocking(move || rfd::FileDialog::new().pick_folder());
    let selected = handle.await.map_err(|error| format!("打开目录选择对话框失败：{error}"))?;
    Ok(selected.map(|path| path.to_string_lossy().to_string()))
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn app_info() -> Value {
    let tool_status = tools::status().await;
    let info = AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        name: "X 媒体工坊".into(),
        is_packaged: true,
        data_dir: paths::data_dir().to_string_lossy().to_string(),
        cache_dir: paths::cache_dir().to_string_lossy().to_string(),
        output_dir: paths::output_dir_default().to_string_lossy().to_string(),
        logs_dir: paths::logs_dir().to_string_lossy().to_string(),
        tools: tool_status,
    };
    ok(json!(info))
}

#[tauri::command]
pub async fn app_toggle_devtools() -> Value {
    ok(json!(true))
}

#[tauri::command]
pub async fn app_open_output_dir() -> Value {
    let settings = settings::load();
    op_result(open_path(&settings::effective_output_dir(&settings).to_string_lossy()))
}

#[tauri::command]
pub async fn app_open_cache_dir() -> Value {
    let settings = settings::load();
    op_result(open_path(&settings::effective_cache_dir(&settings).to_string_lossy()))
}

#[tauri::command]
pub async fn app_open_data_dir() -> Value {
    op_result(open_path(&paths::data_dir().to_string_lossy()))
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tools_status() -> Value {
    op_result(Ok(tools::status().await))
}

#[tauri::command]
pub async fn tools_download(names: Option<Vec<String>>) -> Value {
    let settings = settings::load();
    let names = names.unwrap_or_default();
    op_result(tools::download(names, &settings.proxy).await)
}

#[tauri::command]
pub async fn tools_poll() -> Value {
    op_result(Ok(jobs::tool_poll()))
}

// ---------------------------------------------------------------------------
// tweet
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tweet_fetch(url: String) -> Value {
    let settings = settings::load();
    match tweet::fetch_tweet(&settings, &url).await {
        Ok(info) => ok(json!(info)),
        Err(error) => fail(error),
    }
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub job_id: String,
    pub tweet_id: String,
    pub media: TweetMedia,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub job_id: String,
    pub tweet_id: String,
    pub media: TweetMedia,
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn media_prepare(request: PrepareRequest) -> Value {
    let settings = settings::load();
    let job = jobs::JobCtx::start(&request.job_id, "media");
    let result = media::prepare(&settings, &job, &request.tweet_id, &request.media, false).await;
    job.finish();
    op_result(result)
}

#[tauri::command]
pub async fn media_save(request: SaveRequest) -> Value {
    let settings = settings::load();
    let job = jobs::JobCtx::start(&request.job_id, "save");
    let result = media::save(&settings, &job, &request.tweet_id, &request.media, request.force).await;
    job.finish();
    op_result(result)
}

#[tauri::command]
pub async fn media_export_as(file_path: String, default_name: Option<String>) -> Value {
    let selected = match save_dialog(default_name).await {
        Ok(selected) => selected,
        Err(error) => return fail(error),
    };
    match selected {
        None => ok(json!({ "canceled": true })),
        Some(target) => match std::fs::copy(&file_path, &target) {
            Ok(_) => {
                let target_text = target.to_string_lossy().to_string();
                history::add_copy(&file_path, &target_text);
                ok(json!({ "canceled": false, "filePath": target_text }))
            }
            Err(error) => fail(format!("另存为失败：{error}")),
        },
    }
}

#[tauri::command]
pub async fn media_open(file_path: String) -> Value {
    op_result(open_path(&file_path).map(|_| true))
}

#[tauri::command]
pub async fn media_reveal(file_path: String) -> Value {
    op_result(reveal_path(&file_path).map(|_| true))
}

#[tauri::command]
pub async fn media_remove(file_path: String) -> Value {
    op_result(remove_file(&file_path))
}

#[tauri::command]
pub async fn media_copy_path(file_path: String) -> Value {
    ok(json!(file_path))
}

#[tauri::command]
pub async fn media_probe_file(file_path: String) -> Option<MediaProbe> {
    media::probe_file(&file_path)
}

#[tauri::command]
pub async fn media_video_thumbnail(file_path: String) -> Value {
    match media::video_thumbnail(&file_path).await {
        Some(path) => ok(json!(path)),
        None => ok(json!("")),
    }
}

// ---------------------------------------------------------------------------
// gif
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequestDto {
    pub job_id: String,
    pub tweet_id: String,
    pub media: TweetMedia,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub auto_save: bool,
}

#[tauri::command]
pub async fn gif_convert(request: ConvertRequestDto) -> Value {
    let settings = settings::load();
    let result = convert::convert(
        &settings,
        convert::ConvertRequest {
            job_id: request.job_id,
            tweet_id: request.tweet_id,
            media: request.media,
            params: request.params,
            preset_id: request.preset_id,
            format: request.format,
            auto_save: request.auto_save,
        },
    )
    .await;
    op_result(result)
}

#[tauri::command]
pub async fn gif_info(file_path: String) -> Value {
    op_result(convert::gif_info(&file_path))
}

#[tauri::command]
pub async fn gif_export_as(file_path: String, default_name: Option<String>) -> Value {
    media_export_as(file_path, default_name).await
}

#[tauri::command]
pub async fn gif_open(file_path: String) -> Value {
    media_open(file_path).await
}

#[tauri::command]
pub async fn gif_reveal(file_path: String) -> Value {
    media_reveal(file_path).await
}

#[tauri::command]
pub async fn gif_remove(file_path: String) -> Value {
    media_remove(file_path).await
}

#[tauri::command]
pub async fn gif_copy_path(file_path: String) -> Value {
    ok(json!(file_path))
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn history_list() -> Value {
    ok(json!(history::list()))
}

#[tauri::command]
pub async fn history_get(tweet_id: String) -> Value {
    ok(json!(history::get(&tweet_id)))
}

#[tauri::command]
pub async fn history_remove(tweet_id: String, delete_files: Option<bool>) -> Value {
    match history::remove(&tweet_id, delete_files.unwrap_or(false)) {
        Ok((deleted, failed)) => ok(json!({ "deletedFiles": deleted, "failedFiles": failed })),
        Err(error) => fail(error),
    }
}

#[tauri::command]
pub async fn history_remove_result(tweet_id: String, result_id: String) -> Value {
    op_result(history::remove_result(&tweet_id, &result_id).map(|_| true))
}

#[tauri::command]
pub async fn history_remove_saved(tweet_id: String, saved_id: String) -> Value {
    op_result(history::remove_saved(&tweet_id, &saved_id).map(|_| true))
}

#[tauri::command]
pub async fn history_clear() -> Value {
    op_result(history::clear().map(|_| true))
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_get() -> Value {
    op_result(Ok(settings::load()))
}

#[tauri::command]
pub async fn settings_save(settings: AppSettings) -> Value {
    op_result(settings::save(settings))
}

#[tauri::command]
pub async fn settings_choose_directory(_kind: Option<String>) -> Value {
    match choose_directory_dialog().await {
        Ok(Some(path)) => ok(json!(path)),
        Ok(None) => ok(json!(Value::Null)),
        Err(error) => fail(error),
    }
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn proxy_test(proxy: ProxySettings) -> Value {
    let checks = [("X 接口", "https://api.fxtwitter.com/2/status/1"), ("媒体 CDN", "https://pbs.twimg.com/")];
    let client = match http::build_client(&proxy) {
        Ok(client) => client,
        Err(error) => return fail(error),
    };
    let mut results = Vec::new();
    let mut all_ok = true;
    let mut error_text: Option<String> = None;
    for (name, url) in checks {
        let started = Instant::now();
        match client.get(url).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let ok_flag = status < 500;
                if !ok_flag {
                    all_ok = false;
                }
                results.push(json!({
                    "name": name,
                    "url": url,
                    "ok": ok_flag,
                    "status": status,
                    "latencyMs": started.elapsed().as_millis() as u64,
                    "error": if ok_flag { Value::Null } else { json!(format!("HTTP {status}")) }
                }));
            }
            Err(error) => {
                all_ok = false;
                if error_text.is_none() {
                    error_text = Some(error.to_string());
                }
                results.push(json!({
                    "name": name,
                    "url": url,
                    "ok": false,
                    "status": Value::Null,
                    "latencyMs": started.elapsed().as_millis() as u64,
                    "error": error.to_string()
                }));
            }
        }
    }
    ok(json!({
        "ok": all_ok,
        "mode": proxy.mode,
        "effectiveUrl": if proxy.mode == "custom" { json!(proxy.url) } else { Value::Null },
        "checks": results,
        "error": error_text
    }))
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jobs_cancel(job_id: String) -> Value {
    jobs::cancel(&job_id);
    ok(json!(true))
}

#[tauri::command]
pub async fn jobs_poll() -> Value {
    ok(json!(jobs::poll()))
}

// ---------------------------------------------------------------------------
// window（无边框窗口控制）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(!maximized)
}

#[tauri::command]
pub fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}