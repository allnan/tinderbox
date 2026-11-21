use chrono::Local;
use std::{
    collections::{HashMap, HashSet},
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

use crate::{
    conversion,
    model::{PolicyConfig, PolicyLibrary, RuleSetItem, RuleSetLibrary, Source, SourceSyncResult},
    paths, presets, rule_sets,
    state::AppState,
};

const SUBSCRIPTION_USER_AGENT: &str = "clash-verge/v2.4.0";

pub fn http_client(proxy: &str, timeout_seconds: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_seconds))
        .user_agent("ClashFlowManager/0.1");
    let proxy = proxy.trim();
    if proxy.is_empty() || proxy.eq_ignore_ascii_case("direct") {
        builder = builder.no_proxy();
    } else {
        let parsed =
            reqwest::Proxy::all(proxy).map_err(|error| format!("代理地址无效：{error}"))?;
        builder = builder.proxy(parsed);
    }
    builder
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))
}

async fn fetch_subscription_response(
    client: &reqwest::Client,
    url: &str,
    using_proxy: bool,
) -> Result<reqwest::Response, String> {
    for attempt in 0..3 {
        let response = client
            .get(url)
            .header(reqwest::header::USER_AGENT, SUBSCRIPTION_USER_AGENT)
            .send()
            .await;
        match response {
            Ok(response) => return Ok(response),
            Err(error) if error.is_connect() && attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(2 * (attempt + 1))).await;
            }
            Err(error) if error.is_timeout() => {
                return Err(if using_proxy {
                    "下载超时：请检查订阅服务器或本地代理连接".to_string()
                } else {
                    "下载超时：请检查订阅服务器网络连接".to_string()
                });
            }
            Err(error) if error.is_connect() => {
                return Err(if using_proxy {
                    "无法连接订阅服务器或本地代理（连接错误）".to_string()
                } else {
                    "无法连接订阅服务器（连接错误）".to_string()
                });
            }
            Err(_) => {
                return Err(if using_proxy {
                    "订阅下载网络请求失败，请检查订阅地址和本地代理连接".to_string()
                } else {
                    "订阅下载网络请求失败，请检查订阅地址和网络连接".to_string()
                });
            }
        }
    }
    unreachable!("subscription connection retry loop must return")
}

pub async fn sync_sources(state: &Arc<AppState>) -> Result<SourceSyncResult, String> {
    sync_sources_for(state, None, None).await
}

pub async fn sync_sources_with_proxy(
    state: &Arc<AppState>,
    use_proxy: bool,
) -> Result<SourceSyncResult, String> {
    sync_sources_for(state, None, Some(use_proxy)).await
}

pub async fn sync_source(
    state: &Arc<AppState>,
    source_id: &str,
) -> Result<SourceSyncResult, String> {
    sync_sources_for(state, Some(source_id), None).await
}

async fn sync_sources_for(
    state: &Arc<AppState>,
    only_source_id: Option<&str>,
    use_proxy_override: Option<bool>,
) -> Result<SourceSyncResult, String> {
    let _sync_guard = state.source_sync_lock.lock().await;
    let sources = state
        .sources
        .read()
        .map_err(|_| "读取订阅来源失败")?
        .clone();
    let old_nodes = state.nodes.read().map_err(|_| "读取节点失败")?.clone();
    let settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    let use_subscription_proxy = use_proxy_override.unwrap_or(settings.use_subscription_proxy);
    let subscription_proxy = if use_subscription_proxy {
        settings.subscription_proxy.trim()
    } else {
        "direct"
    };
    let using_proxy =
        !subscription_proxy.is_empty() && !subscription_proxy.eq_ignore_ascii_case("direct");
    let client = http_client(subscription_proxy, 45)?;
    let mut updated_sources = sources.clone();
    if let Some(source_id) = only_source_id {
        if !sources.iter().any(|source| source.id == source_id) {
            return Err("找不到要刷新的订阅来源".into());
        }
    }
    let mut updated_nodes = if let Some(source_id) = only_source_id {
        old_nodes
            .iter()
            .filter(|node| node.source_id != source_id)
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let mut errors = Vec::new();
    let now = Local::now().to_rfc3339();

    for source in &sources {
        let should_sync = only_source_id
            .map(|source_id| source.id == source_id)
            .unwrap_or(source.enabled);
        if !should_sync {
            continue;
        }
        let source_index = updated_sources
            .iter()
            .position(|item| item.id == source.id)
            .unwrap_or(0);
        let result = async {
            let response = fetch_subscription_response(&client, &source.url, using_proxy).await?;
            if !response.status().is_success() {
                return Err(format!("订阅返回 HTTP {}", response.status().as_u16()));
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let subscription_userinfo = response
                .headers()
                .get("subscription-userinfo")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let profile_title = response
                .headers()
                .get("profile-title")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let profile_web_page_url = response
                .headers()
                .get("profile-web-page-url")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = response
                .text()
                .await
                .map_err(|_| "无法读取订阅响应内容".to_string())?;
            let configs = conversion::parse_subscription(&body, &content_type)?;
            if configs.is_empty() {
                return Err("订阅中没有代理节点".to_string());
            }
            let subscription_info = conversion::parse_subscription_info(
                subscription_userinfo.as_deref(),
                profile_title.as_deref(),
                profile_web_page_url.as_deref(),
                &body,
            );
            Ok((conversion::tag_nodes(source, configs), subscription_info))
        }
        .await;
        match result {
            Ok((mut nodes, subscription_info)) => {
                updated_sources[source_index].node_count = nodes.len();
                updated_sources[source_index].last_updated = now.clone();
                updated_sources[source_index].last_error.clear();
                updated_sources[source_index].subscription_info = subscription_info;
                updated_nodes.append(&mut nodes);
            }
            Err(error) => {
                updated_sources[source_index].last_error = error.clone();
                errors.push(format!("{}：{}", source.name, error));
                let retained_nodes = old_nodes
                    .iter()
                    .filter(|node| {
                        node.source_id == source.id
                            && !conversion::is_provider_notice_name(&node.original_name)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                updated_sources[source_index].node_count = retained_nodes.len();
                updated_nodes.extend(retained_nodes);
            }
        }
    }
    {
        let mut current = state.sources.write().map_err(|_| "保存订阅来源失败")?;
        *current = updated_sources.clone();
    }
    {
        let mut current = state.nodes.write().map_err(|_| "保存节点失败")?;
        *current = updated_nodes.clone();
    }
    state.save_sources()?;
    state.save_nodes()?;
    state.regenerate_profile()?;
    let status = if let Some(source_id) = only_source_id {
        let source_name = updated_sources
            .iter()
            .find(|source| source.id == source_id)
            .map(|source| source.name.as_str())
            .unwrap_or("订阅来源");
        let source_node_count = updated_nodes
            .iter()
            .filter(|node| node.source_id == source_id)
            .count();
        if errors.is_empty() {
            format!("{source_name} 刷新完成：{source_node_count} 个节点")
        } else {
            format!("{source_name} 刷新失败，已保留 {source_node_count} 个旧节点")
        }
    } else if errors.is_empty() {
        format!("同步完成：{} 个节点", updated_nodes.len())
    } else {
        format!(
            "部分同步失败：{} 个节点可用，{} 项来源报错",
            updated_nodes.len(),
            errors.len()
        )
    };
    if let Ok(mut current) = state.sync_status.lock() {
        *current = status;
    }
    if let Ok(mut current) = state.last_sync.lock() {
        *current = now.clone();
    }
    Ok(SourceSyncResult {
        sources: updated_sources,
        node_count: updated_nodes.len(),
        errors,
        updated_at: now,
    })
}

pub async fn subscription_proxy_available(state: &Arc<AppState>) -> Result<bool, String> {
    let settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    let Ok(parsed) = url::Url::parse(settings.subscription_proxy.trim()) else {
        return Ok(false);
    };
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Ok(false);
    }
    let Some(host) = parsed.host_str() else {
        return Ok(false);
    };
    let Some(port) = parsed.port_or_known_default() else {
        return Ok(false);
    };
    Ok(tokio::time::timeout(
        Duration::from_secs(1),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .is_ok_and(|result| result.is_ok()))
}

pub async fn import_preset(
    state: &Arc<AppState>,
    name: &str,
    url: &str,
) -> Result<PolicyConfig, String> {
    let settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    let client = http_client(&settings.subscription_proxy, 30)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("下载策略预设失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("策略预设返回 HTTP {}", response.status().as_u16()));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取策略预设失败：{error}"))?;
    let mut policy = presets::parse_remote_preset(name, url, &text)?;
    policy.template_content = text;
    Ok(policy)
}

pub async fn auto_sync_loop(state: Arc<AppState>) {
    // Give the desktop and its local subscription proxy time to finish starting.
    tokio::time::sleep(Duration::from_secs(12)).await;
    let mut last_sync: Option<tokio::time::Instant> = None;
    let mut retry_at: Option<tokio::time::Instant> = None;
    let mut retry_used = false;
    loop {
        let settings = state.settings.read().map(|settings| settings.clone()).ok();
        let Some(settings) = settings else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        if !settings.auto_update_enabled {
            last_sync = None;
            retry_at = None;
            retry_used = false;
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        let interval = Duration::from_secs(settings.update_minutes.max(15).saturating_mul(60));
        let now = tokio::time::Instant::now();
        let due = retry_at.map(|retry| now >= retry).unwrap_or_else(|| {
            last_sync
                .map(|last| last.elapsed() >= interval)
                .unwrap_or(true)
        });
        if due {
            let has_enabled = state
                .sources
                .read()
                .map(|sources| sources.iter().any(|source| source.enabled))
                .unwrap_or(false);
            if has_enabled {
                let failed = sync_sources(&state)
                    .await
                    .map(|result| !result.errors.is_empty())
                    .unwrap_or(true);
                if failed && !retry_used {
                    retry_at = Some(tokio::time::Instant::now() + Duration::from_secs(15));
                    retry_used = true;
                } else {
                    last_sync = Some(tokio::time::Instant::now());
                    retry_at = None;
                    retry_used = false;
                }
            } else {
                last_sync = Some(tokio::time::Instant::now());
                retry_at = None;
                retry_used = false;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub fn save_source(state: &Arc<AppState>, mut source: Source) -> Result<Vec<Source>, String> {
    source.name = source.name.trim().to_string();
    source.prefix = source
        .prefix
        .trim()
        .trim_matches(|ch| ch == '[' || ch == ']')
        .to_string();
    source.url = source.url.trim().to_string();
    source.region_hint = source.region_hint.trim().to_string();
    if source.name.is_empty() {
        return Err("请填写服务商显示名称".into());
    }
    if source.prefix.is_empty() {
        source.prefix = source.name.clone();
    }
    if source
        .prefix
        .chars()
        .any(|ch| matches!(ch, '[' | ']' | '\n' | '\r'))
    {
        return Err("节点前缀不能包含方括号或换行符".into());
    }
    {
        let sources = state.sources.read().map_err(|_| "读取订阅来源失败")?;
        if sources.iter().any(|existing| {
            existing.id != source.id && existing.name.eq_ignore_ascii_case(&source.name)
        }) {
            return Err("服务商显示名称需要唯一，便于区分来源分组".into());
        }
        if sources.iter().any(|existing| {
            existing.id != source.id && existing.prefix.eq_ignore_ascii_case(&source.prefix)
        }) {
            return Err("节点前缀需要与其他服务商不同，避免节点和来源分组重名".into());
        }
    }
    let url =
        url::Url::parse(&source.url).map_err(|_| "订阅链接必须是有效的 HTTP 或 HTTPS 地址")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("订阅链接仅支持 HTTP 或 HTTPS".into());
    }
    if source.id.is_empty() {
        source.id = uuid::Uuid::new_v4().to_string();
    }
    let (output, node_format_changed) = {
        let mut sources = state.sources.write().map_err(|_| "订阅来源锁定失败")?;
        if let Some(index) = sources.iter().position(|existing| existing.id == source.id) {
            let previous = &sources[index];
            let node_format_changed = previous.name != source.name
                || previous.prefix != source.prefix
                || previous.region_hint != source.region_hint
                || previous.include_prefix != source.include_prefix
                || previous.include_flag != source.include_flag
                || previous.include_country != source.include_country
                || previous.include_original_name != source.include_original_name;
            source.node_count = sources[index].node_count;
            source.last_updated = sources[index].last_updated.clone();
            source.last_error = sources[index].last_error.clone();
            if source.url != sources[index].url {
                source.subscription_info = None;
            }
            sources[index] = source.clone();
            (sources.clone(), node_format_changed)
        } else {
            sources.push(source.clone());
            (sources.clone(), false)
        }
    };
    state.save_sources()?;
    if node_format_changed {
        {
            let mut nodes = state.nodes.write().map_err(|_| "节点数据锁定失败")?;
            conversion::retag_nodes(&source, &mut nodes);
        }
        state.save_nodes()?;
        state.regenerate_profile()?;
    }
    Ok(output)
}

pub fn reorder_sources(
    state: &Arc<AppState>,
    source_ids: &[String],
) -> Result<Vec<Source>, String> {
    let ordered_sources = {
        let mut sources = state.sources.write().map_err(|_| "订阅来源锁定失败")?;
        let current_ids = sources
            .iter()
            .map(|source| source.id.as_str())
            .collect::<HashSet<_>>();
        let requested_ids = source_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if source_ids.len() != sources.len()
            || requested_ids.len() != source_ids.len()
            || current_ids != requested_ids
        {
            return Err("订阅顺序已变化，请刷新页面后重试".into());
        }
        let mut by_id = sources
            .drain(..)
            .map(|source| (source.id.clone(), source))
            .collect::<HashMap<_, _>>();
        *sources = source_ids
            .iter()
            .filter_map(|source_id| by_id.remove(source_id))
            .collect();
        sources.clone()
    };
    state.save_sources()?;
    state.regenerate_profile()?;
    Ok(ordered_sources)
}

pub fn delete_source(state: &Arc<AppState>, source_id: &str) -> Result<Vec<Source>, String> {
    {
        let mut sources = state.sources.write().map_err(|_| "订阅来源锁定失败")?;
        sources.retain(|source| source.id != source_id);
    }
    {
        let mut nodes = state.nodes.write().map_err(|_| "节点数据锁定失败")?;
        nodes.retain(|node| node.source_id != source_id);
    }
    state.save_sources()?;
    state.save_nodes()?;
    let mut settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    if settings.profile_traffic_source_id == source_id {
        settings.profile_traffic_source_id.clear();
        *state.settings.write().map_err(|_| "设置锁定失败")? = settings;
        state.save_settings()?;
    }
    state.regenerate_profile()?;
    Ok(state
        .sources
        .read()
        .map_err(|_| "读取订阅来源失败")?
        .clone())
}

pub fn save_settings(
    state: &Arc<AppState>,
    settings: crate::model::AppSettings,
) -> Result<(), String> {
    if !settings.controller_url.starts_with("http://")
        && !settings.controller_url.starts_with("https://")
    {
        return Err("Mihomo 控制器地址应以 http:// 或 https:// 开头".into());
    }
    let controller =
        url::Url::parse(&settings.controller_url).map_err(|_| "Mihomo 控制器地址无效")?;
    if controller.host_str().is_none()
        || controller.path() != "/"
        || controller.query().is_some()
        || controller.fragment().is_some()
    {
        return Err("控制器地址只填写协议、主机和端口，例如 http://127.0.0.1:9090".into());
    }
    if settings.auto_update_enabled && !(15..=1440).contains(&settings.update_minutes) {
        return Err("订阅自动更新间隔必须为 15 到 1440 分钟".into());
    }
    if !(1..=65535).contains(&settings.mixed_port) {
        return Err("混合端口必须在 1 到 65535 之间".into());
    }
    validate_auto_group_name_parts(&settings.auto_group_name_parts)?;
    let profile_name = settings.profile_name.trim();
    if profile_name.is_empty()
        || profile_name.chars().count() > 64
        || profile_name.contains(['\r', '\n', '\0'])
    {
        return Err("配置名称须为 1 到 64 个字符，且不能包含换行".into());
    }
    if !settings.profile_traffic_source_id.is_empty()
        && !state
            .sources
            .read()
            .map_err(|_| "订阅数据锁定失败")?
            .iter()
            .any(|source| source.id == settings.profile_traffic_source_id)
    {
        return Err("所选流量订阅已不存在，请重新选择".into());
    }

    let previous_settings = state.settings.read().map_err(|_| "读取设置失败")?.clone();
    let sources = state
        .sources
        .read()
        .map_err(|_| "订阅数据锁定失败")?
        .clone();
    let nodes = state.nodes.read().map_err(|_| "节点数据锁定失败")?.clone();
    let previous_group_names = crate::policy::generated_group_name_map(
        &nodes,
        &sources,
        &previous_settings.auto_group_name_parts,
    );
    let next_group_names =
        crate::policy::generated_group_name_map(&nodes, &sources, &settings.auto_group_name_parts);
    let mut generated_name_renames = HashMap::new();
    for (group_id, previous_name) in &previous_group_names {
        if let Some(next_name) = next_group_names.get(group_id) {
            if previous_name != next_name {
                generated_name_renames.insert(previous_name.clone(), next_name.clone());
            }
        }
    }

    let mut unique_generated_names = HashSet::new();
    for name in next_group_names.values() {
        if !unique_generated_names.insert(name.clone()) {
            return Err(format!(
                "自动地区线路命名重复：{name}。请保留厂商和线路标识。"
            ));
        }
    }
    {
        let library = state.policy_library.read().map_err(|_| "策略库锁定失败")?;
        for item in &library.items {
            if let Some(group) = item
                .config
                .groups
                .iter()
                .find(|group| unique_generated_names.contains(&group.name))
            {
                return Err(format!(
                    "自动地区线路名称「{}」与方案「{}」中的策略组重名，请调整名称后再保存。",
                    group.name, item.name
                ));
            }
        }
    }

    if !generated_name_renames.is_empty() {
        let mut library = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
        let mut changed = false;
        for item in &mut library.items {
            if rename_generated_group_references(&mut item.config, &generated_name_renames) {
                item.updated_at = Local::now().to_rfc3339();
                changed = true;
            }
        }
        if changed {
            paths::write_json("policy-library.json", &*library)?;
        }
        drop(library);

        let mut active_policy = state.policy.write().map_err(|_| "策略配置锁定失败")?;
        if rename_generated_group_references(&mut active_policy, &generated_name_renames) {
            paths::write_json("policy.json", &*active_policy)?;
        }
    }
    {
        let mut current = state.settings.write().map_err(|_| "设置锁定失败")?;
        *current = settings;
    }
    state.save_settings()?;
    state.regenerate_profile()
}

fn validate_auto_group_name_parts(parts: &[String]) -> Result<(), String> {
    let is_separator = |part: &str| {
        matches!(
            part,
            "separator:dot"
                | "separator:dash"
                | "separator:slash"
                | "separator:underscore"
                | "separator:space"
        )
    };
    let provider_positions = parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| (part == "provider").then_some(index))
        .collect::<Vec<_>>();
    let route_positions = parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| (part == "route").then_some(index))
        .collect::<Vec<_>>();
    let separator_positions = parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| is_separator(part).then_some(index))
        .collect::<Vec<_>>();
    let known_parts = parts
        .iter()
        .all(|part| part == "provider" || part == "route" || is_separator(part));
    if !known_parts
        || provider_positions.len() != 1
        || route_positions.len() != 1
        || separator_positions.len() != 1
        || separator_positions[0] <= provider_positions[0].min(route_positions[0])
        || separator_positions[0] >= provider_positions[0].max(route_positions[0])
        || parts.len() != 3
    {
        return Err("自动地区线路名称需要由厂商、一个分隔符和地区/全部节点标识组成；分隔符必须位于名称元素之间。".into());
    }
    Ok(())
}

fn rename_generated_group_references(
    policy: &mut PolicyConfig,
    names: &HashMap<String, String>,
) -> bool {
    let mut changed = false;
    for group in &mut policy.groups {
        for name in &mut group.group_names {
            if let Some(next_name) = names.get(name) {
                *name = next_name.clone();
                changed = true;
            }
        }
        if let Some(default_selected) = group.options.get_mut("default-selected") {
            if let Some(previous_name) = default_selected.as_str() {
                if let Some(next_name) = names.get(previous_name) {
                    *default_selected = serde_json::Value::String(next_name.clone());
                    changed = true;
                }
            }
        }
    }
    for rule in &mut policy.rules {
        if let Some(next_name) = names.get(&rule.target) {
            rule.target = next_name.clone();
            changed = true;
        }
    }
    changed
}

fn validate_policy_rule(rule: &crate::model::PolicyRule, index: usize) -> Result<(), String> {
    let kind = rule.kind.trim().to_ascii_uppercase();
    let value = rule.value.trim();
    let invalid = |reason: &str| Err(format!("第 {} 条 {} 规则无效：{reason}", index + 1, kind));

    if rule.target.trim().is_empty() {
        return invalid("请选择目标去向");
    }
    if rule
        .target
        .chars()
        .any(|character| matches!(character, ',' | '\r' | '\n'))
    {
        return invalid("目标去向不能包含逗号或换行");
    }
    if kind == "MATCH" {
        return Ok(());
    }
    if value
        .chars()
        .any(|character| matches!(character, ',' | '\r' | '\n'))
    {
        return invalid("匹配内容不能包含逗号或换行");
    }

    let valid = match kind.as_str() {
        "DOMAIN" | "DOMAIN-SUFFIX" => {
            matches!(url::Host::parse(value), Ok(url::Host::Domain(_)))
        }
        "DOMAIN-KEYWORD" => !value.is_empty() && !value.chars().any(char::is_whitespace),
        "IP-CIDR" => value.split_once('/').is_some_and(|(address, prefix)| {
            address.parse::<Ipv4Addr>().is_ok()
                && prefix.parse::<u8>().is_ok_and(|prefix| prefix <= 32)
        }),
        "IP-CIDR6" => value.split_once('/').is_some_and(|(address, prefix)| {
            address.parse::<Ipv6Addr>().is_ok()
                && prefix.parse::<u8>().is_ok_and(|prefix| prefix <= 128)
        }),
        "PROCESS-NAME" | "PROCESS-PATH" => !value.is_empty(),
        _ => true,
    };
    if !valid {
        return invalid(match kind.as_str() {
            "DOMAIN" | "DOMAIN-SUFFIX" => "请输入有效域名",
            "DOMAIN-KEYWORD" => "关键词不能为空或包含空白字符",
            "IP-CIDR" => "请输入有效的 IPv4 网段，例如 192.168.1.0/24",
            "IP-CIDR6" => "请输入有效的 IPv6 网段，例如 2001:db8::/32",
            "PROCESS-NAME" | "PROCESS-PATH" => "匹配内容不能为空",
            _ => "匹配内容无效",
        });
    }
    Ok(())
}

fn validate_policy(policy: &PolicyConfig) -> Result<(), String> {
    if policy.template_name.trim().is_empty() {
        return Err("请填写方案名称".into());
    }
    if policy
        .groups
        .iter()
        .any(|group| group.name.trim().is_empty())
    {
        return Err("策略组名称不能为空".into());
    }
    let mut names = std::collections::HashSet::new();
    if policy
        .groups
        .iter()
        .any(|group| !names.insert(group.name.trim()))
    {
        return Err("策略组名称不能重复；请先重命名重复的组".into());
    }
    for (index, rule) in policy.rules.iter().enumerate() {
        validate_policy_rule(rule, index)?;
    }
    for (group_id, settings) in &policy.auto_group_settings {
        if !matches!(
            settings.kind.trim().to_ascii_lowercase().as_str(),
            "select" | "url-test" | "fallback" | "load-balance"
        ) {
            return Err(format!("自动地区线路「{group_id}」的切换方式无效"));
        }
    }
    Ok(())
}

pub fn save_policy_entry(
    state: &Arc<AppState>,
    policy: PolicyConfig,
    id: Option<String>,
    activate: bool,
) -> Result<crate::model::PolicySaveResult, String> {
    let mut policy = policy;
    let mut library = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
    {
        let mut rule_set_library = state
            .rule_set_library
            .write()
            .map_err(|_| "规则集库锁定失败")?;
        rule_sets::normalize_policy_config(&mut policy, &mut rule_set_library);
        paths::write_json("rule-set-library.json", &*rule_set_library)?;
    }
    validate_policy(&policy)?;
    policy.template_name = policy.template_name.trim().to_string();
    let requested_id = id.filter(|id| library.items.iter().any(|item| item.id == *id));
    let updating_active = requested_id
        .as_deref()
        .is_some_and(|id| id == library.active_id);
    let saved_id = if requested_id.is_none() {
        uuid::Uuid::new_v4().to_string()
    } else {
        requested_id.unwrap_or_default()
    };
    if !library.items.iter().any(|item| item.id == saved_id) {
        let base_name = policy.template_name.clone();
        let mut name = base_name;
        let mut suffix = 2;
        while library.items.iter().any(|item| item.name == name) {
            name = format!("{} ({suffix})", policy.template_name);
            suffix += 1;
        }
        policy.template_name = name;
    } else if library
        .items
        .iter()
        .any(|item| item.id != saved_id && item.name == policy.template_name)
    {
        let base_name = policy.template_name.clone();
        let mut suffix = 2;
        let mut name = format!("{base_name} ({suffix})");
        while library
            .items
            .iter()
            .any(|item| item.id != saved_id && item.name == name)
        {
            suffix += 1;
            name = format!("{base_name} ({suffix})");
        }
        policy.template_name = name;
    }
    let now = Local::now().to_rfc3339();
    if let Some(item) = library.items.iter_mut().find(|item| item.id == saved_id) {
        item.name = policy.template_name.clone();
        item.config = policy.clone();
        item.updated_at = now;
    } else {
        library.items.push(crate::model::SavedPolicy {
            id: saved_id.clone(),
            name: policy.template_name.clone(),
            config: policy.clone(),
            updated_at: now,
            pinned: false,
        });
    }
    if activate {
        library.active_id = saved_id.clone();
    }
    paths::write_json("policy-library.json", &*library)?;
    let result = crate::model::PolicySaveResult {
        library: library.clone(),
        saved_id,
    };
    drop(library);

    if activate || updating_active {
        {
            let mut active = state.policy.write().map_err(|_| "当前策略锁定失败")?;
            *active = policy;
        }
        state.save_policy()?;
        state.regenerate_profile()?;
    }
    Ok(result)
}

pub async fn preview_rule_set(
    state: &Arc<AppState>,
    url: &str,
    behavior: &str,
    format: &str,
) -> Result<crate::model::RuleSetPreview, String> {
    let settings = state
        .settings
        .read()
        .map_err(|_| "读取网络设置失败")?
        .clone();
    let client = http_client(&settings.subscription_proxy, 25)?;
    rule_sets::preview_remote(&client, url, behavior, format).await
}

pub async fn refresh_rule_set(
    state: &Arc<AppState>,
    id: &str,
    sync: bool,
) -> Result<Option<bool>, String> {
    let mut item = state
        .rule_set_library
        .read()
        .map_err(|_| "规则集库锁定失败")?
        .items
        .iter()
        .find(|item| item.id == id)
        .cloned()
        .ok_or("找不到此规则集。")?;
    if item.provider["type"].as_str() != Some("http") {
        return Err("只有在线规则集可以检查或同步。".into());
    }
    let url = item.provider["url"]
        .as_str()
        .ok_or("在线规则集缺少地址。")?;
    let behavior = item.provider["behavior"].as_str().unwrap_or("classical");
    let format = item.provider["format"].as_str().unwrap_or("yaml");
    let preview = preview_rule_set(state, url, behavior, format).await?;
    let changed = rule_sets::remote_changed(&item, &preview);

    if sync {
        item.provider["behavior"] = preview.behavior.into();
        item.provider["format"] = preview.format.into();
        item.remote_entries = preview.entries;
        item.entry_count = preview.entry_count;
        item.sample = preview.sample;
        item.mrs_hash = preview.mrs_hash;
        save_rule_set(state, item, Some(preview.downloaded_at))?;
    } else {
        let mut library = state
            .rule_set_library
            .write()
            .map_err(|_| "规则集库锁定失败")?;
        let index = current_rule_set_index(&library, &item)?;
        let mut next = library.clone();
        next.items[index].checked_at = preview.downloaded_at;
        next.items[index].update_available = changed;
        paths::write_json("rule-set-library.json", &next)?;
        *library = next;
    }
    Ok(changed)
}

fn current_rule_set_index(library: &RuleSetLibrary, item: &RuleSetItem) -> Result<usize, String> {
    let index = library
        .items
        .iter()
        .position(|candidate| candidate.id == item.id)
        .ok_or("此规则集已删除。")?;
    if library.items[index].updated_at != item.updated_at {
        return Err("规则集刚刚已同步或修改，请重新打开编辑窗口或重新操作。".into());
    }
    Ok(index)
}

pub fn save_rule_set(
    state: &Arc<AppState>,
    mut item: RuleSetItem,
    downloaded_at: Option<String>,
) -> Result<RuleSetItem, String> {
    item.name = item.name.trim().to_string();
    if item.name.is_empty() {
        return Err("请填写规则集名称。".into());
    }
    let provider_type = item
        .provider
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !matches!(provider_type.as_str(), "http" | "inline") {
        return Err("规则集来源类型无效。".into());
    }
    if provider_type == "http" {
        let url = item
            .provider
            .get("url")
            .and_then(serde_json::Value::as_str)
            .ok_or("在线规则集缺少地址。")?;
        let parsed = url::Url::parse(url).map_err(|_| "请输入有效的 HTTP 或 HTTPS 规则集地址。")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("规则集地址必须使用 HTTP 或 HTTPS。".into());
        }
        if item
            .provider
            .get("format")
            .and_then(serde_json::Value::as_str)
            == Some("mrs")
            && (!item.local_additions.is_empty() || !item.excluded_entries.is_empty())
        {
            return Err("MRS 是二进制规则集，当前无法逐条追加或屏蔽规则。".into());
        }
        if (!item.local_additions.is_empty() || !item.excluded_entries.is_empty())
            && item.remote_entries.is_empty()
        {
            return Err("请先拉取在线规则，再保存本地追加或屏蔽项。".into());
        }
    } else {
        let has_entries = item
            .provider
            .get("payload")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|entries| !entries.is_empty());
        if !has_entries {
            return Err("手动规则集至少需要一条规则。".into());
        }
    }

    let mut policies = state
        .policy_library
        .write()
        .map_err(|_| "本机方案库锁定失败")?;
    let mut library = state
        .rule_set_library
        .write()
        .map_err(|_| "规则集库锁定失败")?;
    let existing_index = if item.id.is_empty() {
        item.id = format!("ruleset-{}", uuid::Uuid::new_v4().simple());
        None
    } else {
        Some(current_rule_set_index(&library, &item)?)
    };
    if library
        .items
        .iter()
        .any(|candidate| candidate.id != item.id && candidate.name.eq_ignore_ascii_case(&item.name))
    {
        return Err("已有同名规则集，请使用不同名称以便区分。".into());
    }
    let existing = existing_index.map(|index| &library.items[index]);
    let now = Local::now().to_rfc3339();
    if provider_type == "http" {
        if let Some(downloaded_at) = downloaded_at {
            item.checked_at = downloaded_at;
            item.synced_at = now.clone();
            item.update_available = Some(false);
        } else if let Some(existing) = existing {
            item.checked_at.clone_from(&existing.checked_at);
            item.synced_at.clone_from(&existing.synced_at);
            item.update_available = existing.update_available;
            item.mrs_hash.clone_from(&existing.mrs_hash);
        }
        let format = item
            .provider
            .get("format")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("yaml")
            .to_ascii_lowercase();
        let extension = match format.as_str() {
            "mrs" => "mrs",
            "text" => "list",
            _ => "yaml",
        };
        let safe_id = item
            .id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                    character
                } else {
                    '-'
                }
            })
            .take(80)
            .collect::<String>();
        let provider = item
            .provider
            .as_object_mut()
            .ok_or("在线规则集配置格式无效。")?;
        if existing.and_then(|existing| existing.provider["format"].as_str())
            != Some(format.as_str())
        {
            provider.remove("path");
        }
        provider.entry("path").or_insert_with(|| {
            serde_json::Value::String(format!("./ruleset/{safe_id}.{extension}"))
        });
        provider
            .entry("interval")
            .or_insert_with(|| serde_json::Value::Number(86400.into()));
    }
    let effective_entries = rule_sets::effective_entries(&item);
    if provider_type == "inline" || !item.remote_entries.is_empty() {
        item.entry_count = Some(effective_entries.len());
        item.sample = effective_entries.into_iter().take(5).collect();
    }
    item.updated_at = now;
    let mut next = library.clone();
    if let Some(index) = existing_index {
        next.items[index] = item.clone();
    } else {
        next.items.push(item.clone());
    }
    paths::write_json("rule-set-library.json", &next)?;
    if let Err(error) = update_rule_set_references(state, &mut policies, &item) {
        let _ = paths::write_json("rule-set-library.json", &*library);
        return Err(error);
    }
    *library = next;
    Ok(item)
}

fn update_rule_set_references(
    state: &AppState,
    policies: &mut PolicyLibrary,
    item: &RuleSetItem,
) -> Result<(), String> {
    let provider = rule_sets::applied_provider(item);
    let mut updated = policies.clone();
    let mut changed = false;
    let mut active_policy = None;
    for saved in &mut updated.items {
        let Some(previous) = saved
            .config
            .rule_providers
            .as_object_mut()
            .and_then(|providers| providers.get_mut(&item.id))
        else {
            continue;
        };
        if *previous == provider {
            continue;
        }
        *previous = provider.clone();
        changed = true;
        if saved.id == updated.active_id {
            active_policy = Some(saved.config.clone());
        }
    }
    if !changed {
        return Ok(());
    }
    paths::write_json("policy-library.json", &updated)?;
    if let Some(active_policy) = active_policy {
        let previous = match state.policy.write() {
            Ok(mut policy) => std::mem::replace(&mut *policy, active_policy),
            Err(_) => {
                let _ = paths::write_json("policy-library.json", policies);
                return Err("当前策略锁定失败".into());
            }
        };
        if let Err(error) = state
            .save_policy()
            .and_then(|()| state.regenerate_profile())
        {
            if let Ok(mut policy) = state.policy.write() {
                *policy = previous;
            }
            let _ = state.save_policy();
            let _ = paths::write_json("policy-library.json", policies);
            return Err(error);
        }
    }
    *policies = updated;
    Ok(())
}

pub fn delete_rule_set(state: &Arc<AppState>, id: &str) -> Result<RuleSetLibrary, String> {
    let mut policies = state
        .policy_library
        .write()
        .map_err(|_| "本机方案库锁定失败")?;
    let references = policies
        .items
        .iter()
        .map(|saved| {
            saved
                .config
                .rules
                .iter()
                .filter(|rule| rule.kind.eq_ignore_ascii_case("RULE-SET") && rule.value == id)
                .count()
        })
        .sum::<usize>();
    if references > 0 {
        return Err(format!(
            "此规则集仍被 {references} 条分流规则引用，请先从策略组移除。"
        ));
    }

    let mut library = state
        .rule_set_library
        .write()
        .map_err(|_| "规则集库锁定失败")?;
    let Some(index) = library.items.iter().position(|item| item.id == id) else {
        return Err("找不到此规则集。".into());
    };
    library.items.remove(index);
    for saved in &mut policies.items {
        if let Some(providers) = saved.config.rule_providers.as_object_mut() {
            providers.remove(id);
        }
    }
    let active_id = policies.active_id.clone();
    let active_policy = policies
        .items
        .iter()
        .find(|item| item.id == active_id)
        .map(|item| item.config.clone());
    paths::write_json("rule-set-library.json", &*library)?;
    paths::write_json("policy-library.json", &*policies)?;
    let result = library.clone();
    drop(library);
    drop(policies);
    if let Some(active_policy) = active_policy {
        *state.policy.write().map_err(|_| "当前策略锁定失败")? = active_policy;
        state.save_policy()?;
        state.regenerate_profile()?;
    }
    Ok(result)
}

pub fn activate_policy_entry(state: &Arc<AppState>, id: &str) -> Result<(), String> {
    let mut library = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
    let policy = library
        .items
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.config.clone())
        .ok_or_else(|| "找不到此本机方案".to_string())?;
    library.active_id = id.to_string();
    paths::write_json("policy-library.json", &*library)?;
    drop(library);
    {
        let mut active = state.policy.write().map_err(|_| "当前策略锁定失败")?;
        *active = policy;
    }
    state.save_policy()?;
    state.regenerate_profile()
}

pub fn rename_policy_entry(state: &Arc<AppState>, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("方案名称不能为空".into());
    }

    let mut library = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
    let index = library
        .items
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| "找不到此本机方案".to_string())?;
    if library
        .items
        .iter()
        .any(|item| item.id != id && item.name.eq_ignore_ascii_case(name))
    {
        return Err("方案名称已存在，请换一个名称".into());
    }

    let previous_item = library.items[index].clone();
    let is_active = library.active_id == id;
    let now = Local::now().to_rfc3339();
    if is_active {
        let mut active_policy = state.policy.write().map_err(|_| "当前策略锁定失败")?;
        let previous_policy = active_policy.clone();
        active_policy.template_name = name.to_string();
        if let Err(error) = paths::write_json("policy.json", &*active_policy) {
            *active_policy = previous_policy;
            return Err(error);
        }

        library.items[index].name = name.to_string();
        library.items[index].config.template_name = name.to_string();
        library.items[index].updated_at = now;
        if let Err(error) = paths::write_json("policy-library.json", &*library) {
            library.items[index] = previous_item;
            let _ = paths::write_json("policy-library.json", &*library);
            *active_policy = previous_policy.clone();
            let _ = paths::write_json("policy.json", &previous_policy);
            return Err(error);
        }
    } else {
        library.items[index].name = name.to_string();
        library.items[index].config.template_name = name.to_string();
        library.items[index].updated_at = now;
        if let Err(error) = paths::write_json("policy-library.json", &*library) {
            library.items[index] = previous_item;
            let _ = paths::write_json("policy-library.json", &*library);
            return Err(error);
        }
    }
    Ok(())
}

pub fn set_policy_pinned(state: &Arc<AppState>, id: &str, pinned: bool) -> Result<(), String> {
    let mut library = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
    let index = library
        .items
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| "找不到此本机方案".to_string())?;
    if library.items[index].pinned == pinned {
        return Ok(());
    }
    let previous = library.items[index].pinned;
    library.items[index].pinned = pinned;
    if let Err(error) = paths::write_json("policy-library.json", &*library) {
        library.items[index].pinned = previous;
        return Err(error);
    }
    Ok(())
}

pub fn delete_policy_entry(state: &Arc<AppState>, id: &str) -> Result<(), String> {
    let mut library = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
    if library.active_id == id {
        return Err("当前正在使用的方案不能删除；请先启用其他方案".into());
    }
    let old_len = library.items.len();
    library.items.retain(|item| item.id != id);
    if library.items.len() == old_len {
        return Err("找不到此本机方案".into());
    }
    paths::write_json("policy-library.json", &*library)
}

pub fn refresh_profile(state: &Arc<AppState>) -> Result<(), String> {
    state.regenerate_profile()
}

pub fn store_profile_copy() -> Result<String, String> {
    let path = paths::data_dir().join("generated-profile.yaml");
    Ok(path.to_string_lossy().to_string())
}
