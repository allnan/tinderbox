use chrono::{Duration, Local};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::State;

use crate::{
    model::{AppSettings, PolicyConfig, Source},
    service,
    state::SharedState,
    traffic,
};

#[tauri::command]
pub fn app_snapshot(state: State<'_, SharedState>) -> Result<Value, String> {
    let sources = state.sources.read().map_err(|_| "读取订阅失败")?.clone();
    let nodes = state.nodes.read().map_err(|_| "读取节点失败")?.clone();
    let policy = state.policy.read().map_err(|_| "读取策略失败")?.clone();
    let policy_library = state
        .policy_library
        .read()
        .map_err(|_| "读取本机方案失败")?
        .clone();
    let rule_set_library = state
        .rule_set_library
        .read()
        .map_err(|_| "读取规则集库失败")?
        .clone();
    let settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    let status = state
        .sync_status
        .lock()
        .map_err(|_| "读取同步状态失败")?
        .clone();
    let last_sync = state
        .last_sync
        .lock()
        .map_err(|_| "读取同步时间失败")?
        .clone();
    let traffic_status = state
        .last_traffic_status
        .lock()
        .map_err(|_| "读取流量状态失败")?
        .clone();
    let profile_last_requested_at = state.profile_last_requested_at.load(Ordering::Relaxed);
    let profile_last_generated_at = state.profile_last_generated_at.load(Ordering::Relaxed);
    let profile_needs_update = state.profile_legacy_needs_update.load(Ordering::Relaxed)
        || (profile_last_requested_at > 0 && profile_last_generated_at > profile_last_requested_at);
    Ok(json!({
        "sources": sources,
        "nodes": nodes,
        "policy": policy,
        "policyLibrary": policy_library,
        "ruleSetLibrary": rule_set_library,
        "settings": settings,
        "profileUrl": state.profile_url,
        "profileLastRequestedAt": (profile_last_requested_at > 0).then_some(profile_last_requested_at),
        "profileNeedsUpdate": profile_needs_update,
        "dataDir": state.data_dir,
        "syncStatus": status,
        "lastSync": last_sync,
        "trafficStatus": traffic_status
    }))
}

#[tauri::command]
pub fn source_save(state: State<'_, SharedState>, source: Source) -> Result<Vec<Source>, String> {
    service::save_source(&state, source)
}

#[tauri::command]
pub fn source_reorder(
    state: State<'_, SharedState>,
    source_ids: Vec<String>,
) -> Result<Vec<Source>, String> {
    service::reorder_sources(&state, &source_ids)
}

#[tauri::command]
pub fn source_delete(
    state: State<'_, SharedState>,
    source_id: String,
) -> Result<Vec<Source>, String> {
    service::delete_source(&state, &source_id)
}

#[tauri::command]
pub async fn source_sync(
    state: State<'_, SharedState>,
) -> Result<crate::model::SourceSyncResult, String> {
    service::sync_sources(&state).await
}

#[tauri::command]
pub async fn source_sync_mode(
    state: State<'_, SharedState>,
    mode: String,
) -> Result<crate::model::SourceSyncResult, String> {
    let use_proxy = match mode.as_str() {
        "direct" => false,
        "proxy" => true,
        _ => return Err("未知的订阅刷新方式".into()),
    };
    if use_proxy && !service::subscription_proxy_available(&state).await? {
        return Err("订阅代理当前不可连接，请检查代理设置和代理程序。".into());
    }
    service::sync_sources_with_proxy(&state, use_proxy).await
}

#[tauri::command]
pub async fn subscription_proxy_check(state: State<'_, SharedState>) -> Result<bool, String> {
    service::subscription_proxy_available(&state).await
}

#[tauri::command]
pub async fn source_sync_one(
    state: State<'_, SharedState>,
    source_id: String,
) -> Result<crate::model::SourceSyncResult, String> {
    service::sync_source(&state, &source_id).await
}

#[tauri::command]
pub fn policy_save(
    state: State<'_, SharedState>,
    policy: PolicyConfig,
    policy_id: Option<String>,
    activate: bool,
) -> Result<crate::model::PolicySaveResult, String> {
    service::save_policy_entry(&state, policy, policy_id, activate)
}

#[tauri::command]
pub async fn rule_set_preview(
    state: State<'_, SharedState>,
    url: String,
    behavior: String,
    format: String,
) -> Result<crate::model::RuleSetPreview, String> {
    service::preview_rule_set(&state, &url, &behavior, &format).await
}

#[tauri::command]
pub async fn rule_set_refresh(
    state: State<'_, SharedState>,
    id: String,
    sync: bool,
) -> Result<Option<bool>, String> {
    service::refresh_rule_set(&state, &id, sync).await
}

#[tauri::command]
pub async fn rule_set_save(
    state: State<'_, SharedState>,
    item: crate::model::RuleSetItem,
    downloaded_at: Option<String>,
) -> Result<crate::model::RuleSetItem, String> {
    service::save_rule_set(&state, item, downloaded_at)
}

#[tauri::command]
pub fn rule_set_delete(
    state: State<'_, SharedState>,
    id: String,
) -> Result<crate::model::RuleSetLibrary, String> {
    service::delete_rule_set(&state, &id)
}

#[tauri::command]
pub fn policy_activate(state: State<'_, SharedState>, id: String) -> Result<(), String> {
    service::activate_policy_entry(&state, &id)
}

#[tauri::command]
pub fn policy_rename(
    state: State<'_, SharedState>,
    id: String,
    name: String,
) -> Result<(), String> {
    service::rename_policy_entry(&state, &id, &name)
}

#[tauri::command]
pub fn policy_set_pinned(
    state: State<'_, SharedState>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    service::set_policy_pinned(&state, &id, pinned)
}

#[tauri::command]
pub fn policy_delete(state: State<'_, SharedState>, id: String) -> Result<(), String> {
    service::delete_policy_entry(&state, &id)
}

#[tauri::command]
pub async fn preset_fetch(
    state: State<'_, SharedState>,
    name: String,
    url: String,
) -> Result<PolicyConfig, String> {
    service::import_preset(&state, &name, &url).await
}

#[tauri::command]
pub fn settings_save(state: State<'_, SharedState>, settings: AppSettings) -> Result<(), String> {
    service::save_settings(&state, settings)
}

#[tauri::command]
pub fn profile_regenerate(state: State<'_, SharedState>) -> Result<String, String> {
    service::refresh_profile(&state)?;
    service::store_profile_copy()
}

#[tauri::command]
pub fn usage_summary(from: String, to: String) -> Result<crate::model::UsageSummary, String> {
    traffic::summarize(&from, &to)
}

#[tauri::command]
pub fn usage_unmatched_connections(
    from: String,
    to: String,
) -> Result<Vec<crate::model::UnmatchedConnection>, String> {
    traffic::unmatched_connections(&from, &to)
}

#[tauri::command]
pub fn usage_clear_history(state: State<'_, SharedState>) -> Result<usize, String> {
    traffic::clear_history(&state)
}

#[tauri::command]
pub fn backup_export_to(state: State<'_, SharedState>, path: String) -> Result<(), String> {
    crate::backup::export_to(&state, &path)
}

#[tauri::command]
pub fn backup_restore(
    state: State<'_, SharedState>,
    backup: crate::backup::BackupBundle,
) -> Result<(), String> {
    crate::backup::restore(&state, backup)
}

#[tauri::command]
pub async fn controller_check(
    state: State<'_, SharedState>,
    url: Option<String>,
    secret: Option<String>,
) -> Result<String, String> {
    let settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    let controller_url = url.unwrap_or(settings.controller_url);
    let controller_secret = secret.unwrap_or(settings.controller_secret);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("创建 Mihomo API 客户端失败：{error}"))?;
    let mut request = client.get(format!("{}/version", controller_url.trim_end_matches('/')));
    if !controller_secret.is_empty() {
        request = request.bearer_auth(controller_secret);
    }
    let response = request
        .send()
        .await
        .map_err(|_| {
            "无法连接 Mihomo 控制器。请检查 Clash Verge 是否运行，以及 external-controller 地址和端口是否匹配。".to_string()
        })?;
    if !response.status().is_success() {
        return Err(format!("控制器返回 HTTP {}", response.status().as_u16()));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|error| format!("读取版本信息失败：{error}"))?;
    Ok(data
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("已连接")
        .to_string())
}

#[tauri::command]
pub async fn route_check(
    state: State<'_, SharedState>,
    url: String,
) -> Result<crate::route_check::RouteCheckResult, String> {
    let settings = state
        .settings
        .read()
        .map_err(|_| "读取 Mihomo 设置失败")?
        .clone();
    crate::route_check::check(&settings, &url).await
}

#[tauri::command]
pub fn route_check_local(
    state: State<'_, SharedState>,
    policy_id: String,
    url: String,
) -> Result<crate::route_check::LocalRouteCheckResult, String> {
    let policy = state
        .policy_library
        .read()
        .map_err(|_| "读取本机策略方案失败")?
        .items
        .iter()
        .find(|item| item.id == policy_id)
        .cloned()
        .ok_or_else(|| "请选择仍保存在本机的策略方案。".to_string())?;
    let rule_sets = state
        .rule_set_library
        .read()
        .map_err(|_| "读取规则集库失败")?
        .clone();
    let nodes = state.nodes.read().map_err(|_| "读取节点失败")?.clone();
    crate::route_check::check_local(&policy, &rule_sets, &nodes, &url)
}

#[tauri::command]
pub fn app_open_data_dir(state: State<'_, SharedState>) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(state.data_dir.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开数据目录失败：{error}"))
}

#[tauri::command]
pub fn usage_default_range() -> (String, String) {
    let today = Local::now().date_naive();
    let from = today - Duration::days(6);
    (
        from.format("%Y-%m-%d").to_string(),
        today.format("%Y-%m-%d").to_string(),
    )
}

#[tauri::command]
pub fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<bool, String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}
