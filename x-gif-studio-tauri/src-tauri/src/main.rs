// X 媒体工坊 · Tauri 完整功能版主进程
//
// 真实实现：推文解析、媒体下载/保存、GIF/WebP 转换、外部工具下载、设置/历史 JSON、文件操作与代理。
// 前端复用 Electron 版 React 构建产物，通过 scripts/tauri-shim.js 调用这里注册的 Tauri 命令。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod convert;
mod history;
mod http;
mod jobs;
mod media;
mod model;
mod paths;
mod probe_gif;
mod probe_mp4;
mod probe_webp;
mod settings;
mod tools;
mod tweet;

/// 创建主窗口：参数来自 tauri.conf.json；设置 XGIF_TAURI_DEBUG_PORT 时额外开放 WebView2 远程调试端口（仅本地截图验证用）。
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .cloned()
        .expect("tauri.conf.json 缺少 label 为 main 的窗口配置");

    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;

    if let Ok(port) = std::env::var("XGIF_TAURI_DEBUG_PORT") {
        let port = port.trim();
        if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            builder = builder.additional_browser_args(&format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
            ));
        }
    }

    builder.build()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            crate::tools::scrub_network_markers();
            create_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_toggle_devtools,
            commands::app_open_output_dir,
            commands::app_open_cache_dir,
            commands::app_open_data_dir,
            commands::tools_status,
            commands::tools_download,
            commands::tools_poll,
            commands::tweet_fetch,
            commands::media_prepare,
            commands::media_save,
            commands::media_export_as,
            commands::media_open,
            commands::media_reveal,
            commands::media_remove,
            commands::media_copy_path,
            commands::media_probe_file,
            commands::media_video_thumbnail,
            commands::gif_convert,
            commands::gif_info,
            commands::gif_export_as,
            commands::gif_open,
            commands::gif_reveal,
            commands::gif_remove,
            commands::gif_copy_path,
            commands::history_list,
            commands::history_get,
            commands::history_remove,
            commands::history_remove_result,
            commands::history_remove_saved,
            commands::history_clear,
            commands::settings_get,
            commands::settings_save,
            commands::settings_choose_directory,
            commands::proxy_test,
            commands::jobs_cancel,
            commands::jobs_poll,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_close,
            commands::window_start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("启动 X 媒体工坊失败");
}
