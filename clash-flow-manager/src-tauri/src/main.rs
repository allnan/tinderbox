#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod commands;
mod conversion;
mod model;
mod paths;
mod policy;
mod presets;
mod route_check;
mod rule_sets;
mod server;
mod service;
mod state;
mod traffic;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

fn tray_image() -> tauri::image::Image<'static> {
    tauri::image::Image::from_app_icon_resource(32)
        .expect("Windows executable must contain the Clash Flow Manager application icon")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = state::AppState::new().map_err(std::io::Error::other)?;
            app.manage(state.clone());
            traffic::start_collector(state.clone());
            tauri::async_runtime::spawn(service::auto_sync_loop(state));

            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(tray_image())
                .tooltip("Clash 订阅与流量管理")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_snapshot,
            commands::app_open_data_dir,
            commands::source_save,
            commands::source_reorder,
            commands::source_delete,
            commands::source_sync,
            commands::source_sync_mode,
            commands::source_sync_one,
            commands::subscription_proxy_check,
            commands::policy_save,
            commands::rule_set_preview,
            commands::rule_set_refresh,
            commands::rule_set_save,
            commands::rule_set_delete,
            commands::policy_activate,
            commands::policy_rename,
            commands::policy_set_pinned,
            commands::policy_delete,
            commands::preset_fetch,
            commands::settings_save,
            commands::profile_regenerate,
            commands::usage_summary,
            commands::usage_unmatched_connections,
            commands::usage_clear_history,
            commands::backup_export_to,
            commands::backup_restore,
            commands::controller_check,
            commands::route_check,
            commands::route_check_local,
            commands::usage_default_range,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_start_dragging,
            commands::window_close
        ])
        .run(tauri::generate_context!())
        .expect("Clash 订阅与流量管理启动失败");
}
