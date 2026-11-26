mod backup;
mod clipboard;
mod commands;
mod history;
mod models;
mod organize;
mod rules;
mod store;
mod util;

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::json;
use tauri::http::Response;
use tauri::{Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use models::{AppError, Sticker};
use store::{AppState, Store};

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        let path = std::env::temp_dir().join("meme-vault-crash.log");
        let _ = std::fs::write(&path, format!("{}\n", info));
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_quick_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            let mut store = Store::open(data_dir.clone())?;
            let quick_always_on_top = store.settings.quick_always_on_top;
            if std::env::var("MEME_VAULT_SELFTEST").ok().as_deref() == Some("1") {
                let report = run_selftest(&mut store, &data_dir);
                let passed = report.get("ok").and_then(|value| value.as_bool()).unwrap_or(false);
                let target = data_dir.join("selftest.json");
                let _ = std::fs::write(
                    &target,
                    serde_json::to_vec_pretty(&report).unwrap_or_default(),
                );
                app.handle().exit(if passed { 0 } else { 1 });
                return Ok(());
            }
            let _ = backup::maybe_auto_backup(&mut store);
            app.manage(AppState {
                store: Mutex::new(store),
            });
            let webview_dir = data_dir.join("webview");
            std::fs::create_dir_all(&webview_dir)?;
            let main_window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("表情包仓库")
                    .inner_size(1360.0, 880.0)
                    .min_inner_size(1080.0, 700.0)
                    .center()
                    .theme(Some(tauri::Theme::Dark))
                    .data_directory(webview_dir.clone())
                    .build()?;
            let app_handle = app.handle().clone();
            main_window.on_window_event(move |event| {
                // 快捷窗口是隐藏窗口，关闭主窗口时必须显式退出，避免进程留在后台。
                if let WindowEvent::CloseRequested { .. } = event {
                    app_handle.exit(0);
                }
            });
            if let Err(error) = create_quick_window(app, &webview_dir, quick_always_on_top) {
                log_quick(&format!("创建快速窗口失败：{}", error));
            }
            if let Err(error) = app.global_shortcut().register("Ctrl+Shift+Space") {
                log_quick(&format!("注册全局热键失败：{}", error));
            }
            Ok(())
        })
        .register_uri_scheme_protocol("meme", |context, request| {
            build_media_response(context.app_handle(), request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::get_system,
            commands::import_paths,
            commands::import_folder,
            commands::import_bytes,
            commands::update_item,
            commands::batch_update,
            commands::delete_items,
            commands::restore_items,
            commands::copy_item,
            commands::create_category,
            commands::update_category,
            commands::delete_category,
            commands::create_group,
            commands::update_group,
            commands::delete_group,
            commands::propose_rules,
            commands::update_proposal,
            commands::apply_proposal,
            commands::dismiss_proposal,
            commands::revert_proposal,
            commands::get_history,
            commands::undo_history,
            commands::export_backup,
            commands::list_backups,
            commands::import_backup,
            commands::restore_backup,
            commands::delete_backup,
            commands::open_data_dir,
            commands::save_settings,
            commands::show_quick,
            commands::quick_visible,
            commands::quick_hotkey_registered,
            commands::set_quick_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running meme vault");
}

/// 不创建窗口的自检模式：用于在无法启动 WebView2 的环境里验证 release 二进制的数据链路。
fn run_selftest(store: &mut Store, data_dir: &std::path::Path) -> serde_json::Value {
    match selftest_inner(store, data_dir) {
        Ok(steps) => json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "dataDir": data_dir.display().to_string(),
            "steps": steps,
        }),
        Err(error) => json!({
            "ok": false,
            "code": error.code,
            "error": error.message,
        }),
    }
}

fn selftest_inner(store: &mut Store, data_dir: &std::path::Path) -> Result<Vec<String>, AppError> {
    let mut steps: Vec<String> = Vec::new();

    let png = make_test_png()?;
    let sha = util::sha256_hex(&png);
    store.save_image(&sha, "png", &png)?;
    store.save_thumb(&sha, &png)?;
    let now = util::now_ms();
    let item = Sticker {
        id: util::new_id("item"),
        sha256: sha.clone(),
        ext: "png".to_string(),
        mime: "image/png".to_string(),
        thumb_mime: "image/png".to_string(),
        width: 96,
        height: 96,
        bytes: png.len() as u64,
        name: "自检-大笑猫".to_string(),
        status: "inbox".to_string(),
        imported_at: now,
        created_at: now,
        ..Sticker::default()
    };
    store.library.items.push(item.clone());
    store.persist_library()?;
    steps.push(format!("保存素材 {}", item.id));

    let entries = rules::build_rule_entries(
        &store.library.items,
        &store.library.categories,
        &store.library.groups,
    );
    if entries.is_empty() {
        return Err(AppError::new("selftest", "规则整理没有生成任何建议"));
    }
    steps.push(format!("规则整理生成 {} 条建议", entries.len()));

    let proposal = organize::create_proposal(
        store,
        "rules",
        "自检提案",
        entries,
        json!({ "selftest": true }),
    )?;
    let applied = organize::apply_proposal(store, &proposal.id, None)?;
    let applied_item = store
        .library
        .items
        .iter()
        .find(|row| row.id == item.id)
        .ok_or_else(|| AppError::new("selftest", "应用后找不到素材"))?
        .clone();
    if applied_item.category_id.is_none() {
        return Err(AppError::new("selftest", "应用提案后素材没有分类"));
    }
    steps.push(format!(
        "应用提案 {}（{} 张，分类 {:?}）",
        proposal.id, applied.applied, applied_item.category_id
    ));

    history::revert(store, &applied.history_id, false)?;
    let reverted = store
        .library
        .items
        .iter()
        .find(|row| row.id == item.id)
        .ok_or_else(|| AppError::new("selftest", "撤回后找不到素材"))?
        .clone();
    if reverted.category_id.is_some() || reverted.status != "inbox" {
        return Err(AppError::new("selftest", "撤回后素材没有回到待整理"));
    }
    steps.push("撤回提案并恢复待整理状态".to_string());

    let backup_info = backup::export_backup(store)?;
    let backup_path = store.backups_dir.join(&backup_info.file_name);
    if !backup_path.is_file() {
        return Err(AppError::new("selftest", "备份文件没有生成"));
    }
    steps.push(format!(
        "导出备份 {}（{} 字节）",
        backup_info.file_name, backup_info.bytes
    ));

    let target_dir = data_dir.join("selftest-target");
    let _ = std::fs::remove_dir_all(&target_dir);
    let mut target = Store::open(target_dir)?;
    let report = backup::import_backup(&mut target, &backup_path)?;
    if report.added == 0 {
        return Err(AppError::new("selftest", "从备份恢复没有新增素材"));
    }
    steps.push(format!("从备份恢复 {} 张", report.added));

    let state = store.state_view();
    if state.categories.is_empty() || state.history_count == 0 {
        return Err(AppError::new("selftest", "状态视图缺少分类或留痕"));
    }
    steps.push(format!(
        "状态视图：{} 个分类、{} 条留痕、{} 张素材",
        state.categories.len(),
        state.history_count,
        state.items.len()
    ));

    Ok(steps)
}

fn make_test_png() -> Result<Vec<u8>, AppError> {
    use image::{ImageFormat, Rgba, RgbaImage};

    let seed = (util::now_ms() % 120) as u8;
    let mut image = RgbaImage::from_pixel(96, 96, Rgba([245, 178, 59, 255]));
    let ink = Rgba([40 + seed, 30, 20, 255]);
    for (left, right) in [(24u32, 36u32), (60, 72)] {
        for y in 30..42 {
            for x in left..right {
                image.put_pixel(x, y, ink);
            }
        }
    }
    for x in 26..70 {
        let offset = ((x as i32 - 48).abs() as u32) / 2;
        for y in (58 + offset)..(64 + offset) {
            image.put_pixel(x, y, ink);
        }
    }
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|error| AppError::new("selftest", format!("生成自检图片失败：{}", error)))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_paths_are_strict() {
        let sha = "a".repeat(64);
        assert_eq!(
            parse_media_path(&format!("/image/{}", sha)),
            Some(("image", sha.as_str()))
        );
        assert_eq!(
            parse_media_path(&format!("/thumb/{}", sha)),
            Some(("thumb", sha.as_str()))
        );
        assert!(parse_media_path("/image/short").is_none());
        assert!(parse_media_path("/other/".to_string().as_str()).is_none());
        assert!(parse_media_path(&format!("/image/{}", "z".repeat(64))).is_none());
    }

    #[test]
    fn portable_data_uses_userdata_next_to_exe() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("portable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let resolved = portable_data_dir_from(&dir).expect("应能在可写目录创建 userdata");
        assert_eq!(resolved, dir.join("userdata"));
        assert!(resolved.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tauri_config_keeps_release_csp_and_window_setup() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json 应为合法 JSON");
        let csp = config
            .pointer("/app/security/csp")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        assert!(csp.contains("http://meme.localhost"), "CSP 必须允许自定义表情协议");
        assert!(csp.contains("http://ipc.localhost"), "CSP 必须允许 Tauri IPC");
        assert!(csp.contains("data:"), "CSP 必须允许 data: 图片");
        let create = config
            .pointer("/app/windows/0/create")
            .and_then(serde_json::Value::as_bool);
        assert_eq!(create, Some(false), "窗口应在 setup 中手动创建以指定 WebView 数据目录");
        assert!(
            config.pointer("/build/devUrl").is_none(),
            "发布配置不应包含任何开发地址；devUrl 由 scripts/dev.mjs 在开发构建时注入"
        );
        assert!(
            config.pointer("/bundle/icon").and_then(|value| value.as_array()).map(|icons| !icons.is_empty()).unwrap_or(false),
            "打包图标不能为空"
        );
    }
}

fn create_quick_window(app: &tauri::App, webview_dir: &Path, always_on_top: bool) -> tauri::Result<()> {
    let quick = WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("quick.html".into()))
        .title("快速使用")
        .inner_size(860.0, 620.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(always_on_top)
        .skip_taskbar(true)
        .visible(false)
        .shadow(true)
        // 独立数据目录，避免两个 WebView2 环境互相影响导致主窗口被关闭。
        .data_directory(webview_dir.join("quick"))
        .build()?;
    let handle = quick.clone();
    quick.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
    Ok(())
}

fn log_quick(message: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("meme-vault-quick.log");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {}", util::now_ms(), message);
    }
}

pub(crate) fn show_quick_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("quick") else {
        return;
    };
    position_quick(&window);
    if let Err(error) = window.show() {
        log_quick(&format!("show: error {}", error));
    }
    if let Err(error) = window.set_focus() {
        log_quick(&format!("focus: error {}", error));
    }
    // Tauri 对“初始隐藏”的窗口调用 show 时，个别环境只更新状态、不设置 WS_VISIBLE；
    // 这里用 Win32 兜底，确保热键真的能把窗口显示出来。
    force_show(&window);
}

#[cfg(windows)]
fn force_show(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, ShowWindow, SW_SHOWNORMAL,
    };
    if let Ok(hwnd) = window.hwnd() {
        let handle = hwnd.0 as *mut core::ffi::c_void;
        unsafe {
            ShowWindow(handle, SW_SHOWNORMAL);
            SetForegroundWindow(handle);
        }
    }
}

#[cfg(not(windows))]
fn force_show(_window: &tauri::WebviewWindow) {}

pub(crate) fn toggle_quick_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("quick") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        position_quick(&window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn position_quick(window: &tauri::WebviewWindow) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Some((cursor_x, cursor_y)) = cursor_position() else {
        let _ = window.center();
        return;
    };
    let mut x = cursor_x - size.width as i32 / 2;
    let mut y = cursor_y - size.height as i32 / 2;
    if let Ok(Some(monitor)) = window.monitor_from_point(cursor_x as f64, cursor_y as f64) {
        let origin = monitor.position();
        let area = monitor.size();
        let min_x = origin.x + 12;
        let min_y = origin.y + 12;
        let max_x = (origin.x + area.width as i32 - size.width as i32 - 12).max(min_x);
        let max_y = (origin.y + area.height as i32 - size.height as i32 - 12).max(min_y);
        x = x.clamp(min_x, max_x);
        y = y.clamp(min_y, max_y);
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    let ok = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) };
    if ok != 0 {
        Some((point.x, point.y))
    } else {
        None
    }
}

#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("MEME_VAULT_DATA") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let app_data = app.path().app_data_dir().ok();
    // 兼容早期把数据直接放在应用数据根目录的情况。
    if let Some(root) = &app_data {
        if root.join("library.json").is_file() {
            return root.clone();
        }
        let nested = root.join("data");
        if nested.join("library.json").is_file() {
            return nested;
        }
    }
    if let Some(portable) = portable_data_dir() {
        return portable;
    }
    app_data
        .map(|root| root.join("data"))
        .unwrap_or_else(|| PathBuf::from("data"))
}

/// 便携模式：数据放在 exe 同级的 userdata/，可以让整个文件夹复制到其他电脑继续使用。
fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    portable_data_dir_from(exe.parent()?)
}

fn portable_data_dir_from(exe_dir: &Path) -> Option<PathBuf> {
    let candidate = exe_dir.join("userdata");
    std::fs::create_dir_all(&candidate).ok()?;
    let probe = candidate.join(".write-probe");
    std::fs::write(&probe, b"ok").ok()?;
    let _ = std::fs::remove_file(&probe);
    Some(candidate)
}

fn parse_media_path(path: &str) -> Option<(&str, &str)> {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let kind = parts.next().unwrap_or_default();
    let sha = parts.next().unwrap_or_default();
    if !matches!(kind, "image" | "thumb") {
        return None;
    }
    if sha.len() != 64 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((kind, sha))
}

fn build_media_response(app: &tauri::AppHandle, path: &str) -> Response<Vec<u8>> {
    let empty = |status: u16| {
        Response::builder()
            .status(status)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap()
    };
    let Some((kind, sha)) = parse_media_path(path) else {
        return empty(404);
    };
    let state = app.state::<AppState>();
    let store = match state.store.lock() {
        Ok(store) => store,
        Err(_) => return empty(500),
    };
    let Some(item) = store.library.items.iter().find(|item| item.sha256 == sha) else {
        return empty(404);
    };
    let (file, mime) = match kind {
        "image" => (store.image_path(item), item.mime.clone()),
        "thumb" if !item.thumb_mime.is_empty() => {
            (store.thumb_path(sha), item.thumb_mime.clone())
        }
        _ => return empty(404),
    };
    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap(),
        Err(_) => empty(404),
    }
}