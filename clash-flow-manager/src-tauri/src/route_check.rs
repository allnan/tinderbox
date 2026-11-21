use reqwest::{header, redirect::Policy, Client, Response};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use url::Url;

use crate::model::{
    dynamic_node_range_id, AppSettings, PolicyConfig, PolicyGroup, ProxyNode, RuleSetLibrary,
    SavedPolicy, DYNAMIC_NODE_RANGE_PREFIX,
};
use crate::rule_sets;

const ROUTE_WAIT: Duration = Duration::from_secs(8);
const CONNECTION_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCheckResult {
    pub host: String,
    pub captured: bool,
    pub rule: String,
    pub rule_payload: String,
    pub route_group: String,
    pub node: String,
    pub proxy_chain: Vec<String>,
    pub status_code: Option<u16>,
    pub elapsed_ms: u64,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRouteCheckResult {
    pub host: String,
    pub policy_id: String,
    pub policy_name: String,
    pub status: String,
    pub rule: String,
    pub rule_payload: String,
    pub target: String,
    pub target_kind: String,
    pub group_kind: String,
    pub members: Vec<String>,
    pub member_count: usize,
    pub members_complete: bool,
    pub message: String,
}

enum LocalRuleMatch {
    Match,
    NoMatch,
    Unknown(String),
}

struct MatchedRoute {
    rule: String,
    rule_payload: String,
    route_group: String,
    node: String,
    proxy_chain: Vec<String>,
}

fn connection_ids(connections: &[Value]) -> std::collections::HashSet<String> {
    connections
        .iter()
        .filter_map(|connection| connection.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn connection_host(candidate: &str) -> &str {
    let trimmed = candidate.trim();
    if let Some(close_bracket) = trimmed.strip_prefix('[').and_then(|value| value.find(']')) {
        return &trimmed[1..close_bracket + 1];
    }
    if trimmed.parse::<std::net::IpAddr>().is_ok() {
        return trimmed;
    }
    trimmed
        .rsplit_once(':')
        .filter(|(host, port)| !host.is_empty() && port.parse::<u16>().is_ok())
        .map(|(host, _)| host)
        .unwrap_or(trimmed)
}

fn current_executable_name() -> Option<String> {
    std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    })
}

fn matches_current_process(connection: &Value, executable_name: Option<&str>) -> bool {
    let Some(executable_name) = executable_name else {
        return true;
    };
    let metadata = connection.get("metadata").unwrap_or(&Value::Null);
    let process = metadata
        .get("processPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| metadata.get("process").and_then(Value::as_str))
        .unwrap_or("");
    if process.is_empty() {
        return true;
    }
    let observed_name = Path::new(process)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| process.to_string());
    let observed_stem = Path::new(&observed_name)
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| observed_name.clone());
    let expected_stem = Path::new(executable_name)
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| executable_name.to_string());
    observed_name.eq_ignore_ascii_case(executable_name)
        || observed_stem.eq_ignore_ascii_case(&expected_stem)
}

fn matches_target(
    connection: &Value,
    target_host: &str,
    target_port: u16,
    executable_name: Option<&str>,
) -> bool {
    if !matches_current_process(connection, executable_name) {
        return false;
    }
    let metadata = connection.get("metadata").unwrap_or(&Value::Null);
    let connection_port = metadata.get("destinationPort").and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_u64().map(|number| number.to_string()))
    });
    let port_matches = connection_port.as_deref().map_or(true, |port| {
        port.parse::<u16>().map_or(true, |port| port == target_port)
    });
    if !port_matches {
        return false;
    }

    let target_host = normalize_host(target_host);
    let candidates = ["host", "destinationIP", "remoteDestination"]
        .into_iter()
        .filter_map(|key| metadata.get(key).and_then(Value::as_str));

    candidates
        .into_iter()
        .any(|candidate| normalize_host(connection_host(candidate)) == target_host)
}

fn route_from_connection(connection: &Value) -> MatchedRoute {
    let proxy_chain = connection
        .get("chains")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    MatchedRoute {
        rule: connection
            .get("rule")
            .and_then(Value::as_str)
            .filter(|rule| !rule.is_empty())
            .unwrap_or("未提供")
            .to_string(),
        rule_payload: connection
            .get("rulePayload")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        route_group: proxy_chain
            .first()
            .cloned()
            .unwrap_or_else(|| "未识别策略组".into()),
        node: proxy_chain
            .last()
            .cloned()
            .unwrap_or_else(|| "未识别节点".into()),
        proxy_chain,
    }
}

async fn active_connections(client: &Client, settings: &AppSettings) -> Result<Vec<Value>, String> {
    let endpoint = format!(
        "{}/connections",
        settings.controller_url.trim_end_matches('/')
    );
    let mut request = client.get(endpoint);
    if !settings.controller_secret.is_empty() {
        request = request.bearer_auth(&settings.controller_secret);
    }
    let response = request.send().await.map_err(|_| {
        "无法连接 Mihomo 控制器。请检查 Clash Verge 是否运行，以及 external-controller 地址和端口是否匹配。".to_string()
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Mihomo 连接接口返回 HTTP {}。请核对控制器密钥和地址。",
            response.status().as_u16()
        ));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| "Mihomo 连接接口返回了无法解析的数据。".to_string())?;
    data.get("connections")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Mihomo 响应中没有活动连接列表。".to_string())
}

pub async fn check(settings: &AppSettings, raw_url: &str) -> Result<RouteCheckResult, String> {
    if settings.mixed_port == 0 {
        return Err("Mihomo 混合端口必须在 1 到 65535 之间。".into());
    }
    let target = Url::parse(raw_url.trim()).map_err(|_| "请输入完整的 HTTP 或 HTTPS 链接。")?;
    if !matches!(target.scheme(), "http" | "https") || target.host_str().is_none() {
        return Err("请输入包含主机名的 HTTP 或 HTTPS 链接。".into());
    }
    let target_host = target
        .host_str()
        .ok_or_else(|| "链接中没有有效的主机名。".to_string())?
        .to_string();
    let target_port = target
        .port_or_known_default()
        .ok_or_else(|| "链接没有有效的目标端口。".to_string())?;

    let controller_client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "创建 Mihomo 控制器连接失败。".to_string())?;
    let baseline = active_connections(&controller_client, settings).await?;
    let baseline_ids = connection_ids(&baseline);
    let executable_name = current_executable_name();

    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{}", settings.mixed_port))
        .map_err(|_| "创建本地混合代理失败。".to_string())?;
    let probe_client = Client::builder()
        .proxy(proxy)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "创建线路验证请求失败。".to_string())?;

    let started = Instant::now();
    let request_future = probe_client
        .get(target)
        .header(header::RANGE, "bytes=0-0")
        .header(header::ACCEPT, "*/*")
        .send();
    tokio::pin!(request_future);

    let deadline = started + ROUTE_WAIT;
    let mut request_finished = false;
    let mut request_failed = false;
    let mut response: Option<Response> = None;
    let mut status_code = None;
    let mut matched_route: Option<MatchedRoute> = None;
    let mut matched_at = None;
    let mut controller_error = None;

    loop {
        if Instant::now() >= deadline {
            break;
        }
        tokio::select! {
            result = &mut request_future, if !request_finished => {
                request_finished = true;
                match result {
                    Ok(received) => {
                        status_code = Some(received.status().as_u16());
                        response = Some(received);
                    }
                    Err(_) => request_failed = true,
                }
            }
            _ = tokio::time::sleep(CONNECTION_POLL_INTERVAL) => {}
        }

        match active_connections(&controller_client, settings).await {
            Ok(connections) => {
                if matched_route.is_none() {
                    if let Some(connection) = connections.iter().find(|connection| {
                        let id = connection.get("id").and_then(Value::as_str).unwrap_or("");
                        !id.is_empty()
                            && !baseline_ids.contains(id)
                            && matches_target(
                                connection,
                                &target_host,
                                target_port,
                                executable_name.as_deref(),
                            )
                    }) {
                        matched_route = Some(route_from_connection(connection));
                        matched_at = Some(Instant::now());
                    }
                }
                controller_error = None;
            }
            Err(error) => controller_error = Some(error),
        }

        if matched_route.is_some()
            && (request_finished
                || matched_at.is_some_and(|time| time.elapsed() >= Duration::from_millis(300)))
        {
            break;
        }
        if request_failed {
            break;
        }
    }

    // Keep the response body unread while observing /connections so even a large response
    // remains an active Mihomo connection. Dropping it here avoids downloading the body.
    drop(response);

    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if let Some(route) = matched_route {
        return Ok(RouteCheckResult {
            host: target_host,
            captured: true,
            rule: route.rule,
            rule_payload: route.rule_payload,
            route_group: route.route_group,
            node: route.node,
            proxy_chain: route.proxy_chain,
            status_code,
            elapsed_ms,
            message: "已捕获本次请求的实际规则和线路。".into(),
        });
    }

    if let Some(error) = controller_error {
        return Err(error);
    }
    let message = if request_failed {
        format!(
            "无法通过 Mihomo 混合端口 {} 完成请求。请检查 Mihomo 是否运行、混合端口是否正确，以及目标链接是否可访问。",
            settings.mixed_port
        )
    } else {
        match status_code {
            Some(status) => format!(
                "请求返回 HTTP {status}，但 Mihomo 活动连接列表没有捕获到该请求的线路信息。短连接可能在采样前结束，可再试一次。"
            ),
            None => format!(
                "等待目标响应超时，Mihomo 活动连接列表也没有捕获到线路信息。请检查目标链接及混合端口 {}。",
                settings.mixed_port
            ),
        }
    };
    Ok(RouteCheckResult {
        host: target_host,
        captured: false,
        rule: String::new(),
        rule_payload: String::new(),
        route_group: String::new(),
        node: String::new(),
        proxy_chain: Vec::new(),
        status_code,
        elapsed_ms,
        message,
    })
}

pub fn check_local(
    policy: &SavedPolicy,
    rule_set_library: &RuleSetLibrary,
    nodes: &[ProxyNode],
    raw_url: &str,
) -> Result<LocalRouteCheckResult, String> {
    let parsed = Url::parse(raw_url.trim()).map_err(|_| "请输入完整的 HTTP 或 HTTPS 链接。")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("请输入包含主机名的 HTTP 或 HTTPS 链接。".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "链接中没有有效的主机名。".to_string())?;
    let host = normalize_host(host);
    let host_ip = host.parse::<std::net::IpAddr>().ok();
    let target_port = parsed
        .port_or_known_default()
        .ok_or_else(|| "链接没有有效的目标端口。".to_string())?;
    let executable_path = std::env::current_exe().ok();
    let executable_name = executable_path
        .as_deref()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned());
    let rules = &policy.config.rules;

    let (status, rule, rule_payload, target, message) = if rules.is_empty() {
        (
            "matched",
            "MATCH".to_string(),
            String::new(),
            "DIRECT".to_string(),
            "所选方案没有自定义规则；生成配置使用 MATCH,DIRECT。".to_string(),
        )
    } else {
        let mut resolution = None;
        for rule in rules {
            match evaluate_policy_rule(
                rule,
                &policy.config,
                rule_set_library,
                &host,
                host_ip,
                target_port,
                executable_path.as_deref(),
                executable_name.as_deref(),
            ) {
                LocalRuleMatch::Match => {
                    resolution = Some((
                        "matched",
                        rule.kind.clone(),
                        rule.value.clone(),
                        rule.target.clone(),
                        format!("已按「{}」的规则顺序本地匹配。", policy.name),
                    ));
                    break;
                }
                LocalRuleMatch::NoMatch => {}
                LocalRuleMatch::Unknown(reason) => {
                    resolution = Some((
                        "uncertain",
                        rule.kind.clone(),
                        rule.value.clone(),
                        rule.target.clone(),
                        format!(
                            "规则「{} {}」依赖{reason}；本地结果无法确认后续命中。",
                            rule.kind, rule.value
                        ),
                    ));
                    break;
                }
            }
        }
        resolution.unwrap_or_else(|| {
            (
                "unmatched",
                String::new(),
                String::new(),
                String::new(),
                "所选方案没有可确定的规则命中，也没有显式 MATCH 兜底规则。".into(),
            )
        })
    };

    let (target_kind, group_kind, members, member_count, members_complete) =
        describe_local_target(&target, &policy.config, nodes);
    Ok(LocalRouteCheckResult {
        host,
        policy_id: policy.id.clone(),
        policy_name: policy.name.clone(),
        status: status.into(),
        rule,
        rule_payload,
        target,
        target_kind,
        group_kind,
        members,
        member_count,
        members_complete,
        message,
    })
}

fn evaluate_policy_rule(
    rule: &crate::model::PolicyRule,
    policy: &PolicyConfig,
    rule_set_library: &RuleSetLibrary,
    host: &str,
    host_ip: Option<std::net::IpAddr>,
    target_port: u16,
    executable_path: Option<&Path>,
    executable_name: Option<&str>,
) -> LocalRuleMatch {
    let kind = rule.kind.trim().to_ascii_uppercase();
    if kind == "RULE-SET" {
        return evaluate_rule_set(
            &rule.value,
            policy,
            rule_set_library,
            host,
            host_ip,
            target_port,
            executable_path,
            executable_name,
        );
    }
    evaluate_rule_condition(
        &kind,
        &rule.value,
        host,
        host_ip,
        target_port,
        executable_path,
        executable_name,
    )
}

fn evaluate_rule_set(
    id: &str,
    policy: &PolicyConfig,
    rule_set_library: &RuleSetLibrary,
    host: &str,
    host_ip: Option<std::net::IpAddr>,
    target_port: u16,
    executable_path: Option<&Path>,
    executable_name: Option<&str>,
) -> LocalRuleMatch {
    let configured_provider = policy
        .rule_providers
        .as_object()
        .and_then(|providers| providers.get(id));
    if let Some(provider) = configured_provider {
        if provider.get("type").and_then(Value::as_str) == Some("inline") {
            if let Some(entries) = provider.get("payload").and_then(Value::as_array) {
                let entries = entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                let behavior = provider
                    .get("behavior")
                    .and_then(Value::as_str)
                    .unwrap_or("classical");
                return evaluate_rule_set_entries(
                    behavior,
                    &entries,
                    host,
                    host_ip,
                    target_port,
                    executable_path,
                    executable_name,
                );
            }
        }
    }

    let item = rule_set_library.items.iter().find(|item| item.id == id);
    let Some(item) = item else {
        return LocalRuleMatch::Unknown("未保存或未读取到的规则集内容".into());
    };
    let provider_kind = item
        .provider
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("http");
    let entries = rule_sets::effective_entries(item);
    let behavior = configured_provider
        .and_then(|provider| provider.get("behavior"))
        .and_then(Value::as_str)
        .or_else(|| item.provider.get("behavior").and_then(Value::as_str))
        .unwrap_or("classical");
    let local_match = evaluate_rule_set_entries(
        behavior,
        &entries,
        host,
        host_ip,
        target_port,
        executable_path,
        executable_name,
    );
    if matches!(local_match, LocalRuleMatch::Match) {
        return local_match;
    }

    if provider_kind == "http"
        && (item.remote_entries.is_empty()
            || item.provider.get("format").and_then(Value::as_str) == Some("mrs"))
    {
        let reason = if item.provider.get("format").and_then(Value::as_str) == Some("mrs") {
            "MRS 二进制规则集无法在本地逐条匹配"
        } else {
            "尚未下载的在线规则集内容"
        };
        return LocalRuleMatch::Unknown(reason.into());
    }
    if entries.is_empty() && provider_kind != "inline" {
        return LocalRuleMatch::Unknown("本地没有可逐条匹配的规则集内容".into());
    }
    local_match
}

fn evaluate_rule_set_entries(
    behavior: &str,
    entries: &[String],
    host: &str,
    host_ip: Option<std::net::IpAddr>,
    target_port: u16,
    executable_path: Option<&Path>,
    executable_name: Option<&str>,
) -> LocalRuleMatch {
    let behavior = behavior.to_ascii_lowercase();
    let mut unresolved = None;
    for entry in entries
        .iter()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
    {
        let result = match behavior.as_str() {
            "domain" => evaluate_domain_pattern(entry, host),
            "ipcidr" => evaluate_ip_cidr(entry, host_ip),
            "classical" => {
                if let Some((kind, payload)) = entry.split_once(',') {
                    evaluate_rule_condition(
                        kind.trim(),
                        payload.trim(),
                        host,
                        host_ip,
                        target_port,
                        executable_path,
                        executable_name,
                    )
                } else if entry.contains('/') {
                    evaluate_ip_cidr(entry, host_ip)
                } else {
                    LocalRuleMatch::Unknown("classical 规则条目缺少匹配类型".into())
                }
            }
            _ => LocalRuleMatch::Unknown(format!("未知规则集类型 {behavior}")),
        };
        match result {
            LocalRuleMatch::Match => return LocalRuleMatch::Match,
            LocalRuleMatch::NoMatch => {}
            LocalRuleMatch::Unknown(reason) => unresolved = Some(reason),
        }
    }
    unresolved.map_or(LocalRuleMatch::NoMatch, LocalRuleMatch::Unknown)
}

fn evaluate_rule_condition(
    kind: &str,
    raw_value: &str,
    host: &str,
    host_ip: Option<std::net::IpAddr>,
    target_port: u16,
    executable_path: Option<&Path>,
    executable_name: Option<&str>,
) -> LocalRuleMatch {
    let kind = kind.trim().to_ascii_uppercase();
    let value = raw_value.trim();
    match kind.as_str() {
        "MATCH" | "FINAL" => LocalRuleMatch::Match,
        "DOMAIN" => compare_domain(host == normalize_host(value)),
        "DOMAIN-SUFFIX" => compare_domain(domain_suffix_matches(host, value)),
        "DOMAIN-KEYWORD" if value.is_empty() => {
            LocalRuleMatch::Unknown("空的域名关键词条件".into())
        }
        "DOMAIN-KEYWORD" => compare_domain(host.contains(&normalize_host(value))),
        "DOMAIN-WILDCARD" => compare_domain(domain_wildcard_matches(value, host)),
        "DOMAIN-REGEX" => LocalRuleMatch::Unknown("域名正则表达式规则".into()),
        "IP-CIDR" | "IP-CIDR6" => evaluate_ip_cidr(value, host_ip),
        "SRC-IP-CIDR" => evaluate_ip_cidr(
            value,
            Some(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
        ),
        "GEOIP" | "GEOSITE" | "IP-ASN" | "IP-SUFFIX" => {
            LocalRuleMatch::Unknown(format!("{kind} 地理或地址数据库"))
        }
        "DST-PORT" => evaluate_ports(value, target_port),
        "SRC-PORT" => LocalRuleMatch::Unknown("来源端口条件".into()),
        "NETWORK" => {
            let values = value.split([',', '/']).map(str::trim).collect::<Vec<_>>();
            if values.iter().any(|value| value.eq_ignore_ascii_case("tcp")) {
                LocalRuleMatch::Match
            } else if values.iter().all(|value| value.eq_ignore_ascii_case("udp")) {
                LocalRuleMatch::NoMatch
            } else {
                LocalRuleMatch::Unknown("网络类型条件".into())
            }
        }
        "PROCESS-NAME" => match executable_name {
            Some(executable_name) => {
                let observed_stem = Path::new(executable_name)
                    .file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| executable_name.to_string());
                let expected_stem = Path::new(value)
                    .file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| value.to_string());
                compare_domain(
                    executable_name.eq_ignore_ascii_case(value)
                        || observed_stem.eq_ignore_ascii_case(&expected_stem),
                )
            }
            None => LocalRuleMatch::Unknown("进程名称条件".into()),
        },
        "PROCESS-PATH" => match executable_path {
            Some(executable_path) => {
                let actual = executable_path.to_string_lossy().replace('/', "\\");
                let expected = value.replace('/', "\\");
                compare_domain(actual.eq_ignore_ascii_case(&expected))
            }
            None => LocalRuleMatch::Unknown("进程路径条件".into()),
        },
        _ => LocalRuleMatch::Unknown(format!("暂未支持的 {kind} 匹配类型")),
    }
}

fn compare_domain(matches: bool) -> LocalRuleMatch {
    if matches {
        LocalRuleMatch::Match
    } else {
        LocalRuleMatch::NoMatch
    }
}

fn domain_suffix_matches(host: &str, suffix: &str) -> bool {
    let suffix = normalize_host(suffix.trim_start_matches('.'));
    host == suffix
        || host
            .strip_suffix(&suffix)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn domain_wildcard_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let host = normalize_host(host);
    if let Some(suffix) = pattern.strip_prefix('.') {
        return domain_suffix_matches(&host, suffix);
    }
    let pattern_labels = pattern.split('.').collect::<Vec<_>>();
    let host_labels = host.split('.').collect::<Vec<_>>();
    pattern_labels.len() == host_labels.len()
        && pattern_labels
            .iter()
            .zip(host_labels.iter())
            .all(|(pattern, label)| wildcard_label_matches(pattern, label))
}

fn wildcard_label_matches(pattern: &str, label: &str) -> bool {
    let pattern = pattern.as_bytes();
    let label = label.as_bytes();
    let (mut pattern_index, mut label_index) = (0usize, 0usize);
    let mut star_index = None;
    let mut retry_label_index = 0usize;
    while label_index < label.len() {
        if pattern_index < pattern.len() && pattern[pattern_index] == label[label_index] {
            pattern_index += 1;
            label_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            pattern_index += 1;
            retry_label_index = label_index;
        } else if let Some(star) = star_index {
            retry_label_index += 1;
            label_index = retry_label_index;
            pattern_index = star + 1;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn evaluate_ip_cidr(value: &str, host_ip: Option<std::net::IpAddr>) -> LocalRuleMatch {
    let Some(host_ip) = host_ip else {
        if value
            .split(',')
            .skip(1)
            .any(|flag| flag.trim().eq_ignore_ascii_case("no-resolve"))
        {
            return LocalRuleMatch::NoMatch;
        }
        return LocalRuleMatch::Unknown("目标 IP 规则需要 DNS 解析结果".into());
    };
    let cidr = value.split(',').next().unwrap_or_default().trim();
    let Some((network, prefix)) = cidr.split_once('/') else {
        return LocalRuleMatch::Unknown("IP 网段格式".into());
    };
    let Ok(network_ip) = network.trim().parse::<std::net::IpAddr>() else {
        return LocalRuleMatch::Unknown("IP 网段格式".into());
    };
    let Ok(prefix) = prefix.trim().parse::<u8>() else {
        return LocalRuleMatch::Unknown("IP 网段掩码".into());
    };
    match (host_ip, network_ip) {
        (std::net::IpAddr::V4(address), std::net::IpAddr::V4(network)) if prefix <= 32 => {
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            compare_domain(u32::from(address) & mask == u32::from(network) & mask)
        }
        (std::net::IpAddr::V6(address), std::net::IpAddr::V6(network)) if prefix <= 128 => {
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            compare_domain(u128::from(address) & mask == u128::from(network) & mask)
        }
        (std::net::IpAddr::V4(_), std::net::IpAddr::V6(_))
        | (std::net::IpAddr::V6(_), std::net::IpAddr::V4(_)) => LocalRuleMatch::NoMatch,
        _ => LocalRuleMatch::Unknown("IP 网段掩码".into()),
    }
}

fn evaluate_ports(value: &str, target_port: u16) -> LocalRuleMatch {
    if value.trim().is_empty() {
        return LocalRuleMatch::Unknown("空的目标端口条件".into());
    }
    let mut invalid = false;
    for item in value
        .split([',', '/'])
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let matches = if let Some((start, end)) = item.split_once('-') {
            match (start.trim().parse::<u16>(), end.trim().parse::<u16>()) {
                (Ok(start), Ok(end)) if start <= end => Some((start..=end).contains(&target_port)),
                _ => None,
            }
        } else {
            item.parse::<u16>().ok().map(|port| port == target_port)
        };
        match matches {
            Some(true) => return LocalRuleMatch::Match,
            Some(false) => {}
            None => invalid = true,
        }
    }
    if invalid {
        LocalRuleMatch::Unknown("目标端口条件格式".into())
    } else {
        LocalRuleMatch::NoMatch
    }
}

fn evaluate_domain_pattern(pattern: &str, host: &str) -> LocalRuleMatch {
    let pattern = pattern.trim();
    if pattern.starts_with('.') {
        compare_domain(domain_suffix_matches(host, pattern))
    } else if pattern.contains('*') {
        compare_domain(domain_wildcard_matches(pattern, host))
    } else {
        compare_domain(host == normalize_host(pattern))
    }
}

fn describe_local_target(
    target: &str,
    policy: &PolicyConfig,
    nodes: &[ProxyNode],
) -> (String, String, Vec<String>, usize, bool) {
    if target.trim().is_empty() {
        return (String::new(), String::new(), Vec::new(), 0, true);
    }
    match target {
        "DIRECT" => return ("内置去向".into(), "直连".into(), Vec::new(), 0, true),
        "REJECT" => return ("内置去向".into(), "拦截".into(), Vec::new(), 0, true),
        _ => {}
    }
    if let Some(group) = policy.groups.iter().find(|group| group.name == target) {
        let (members, complete) = local_group_members(group, policy, nodes);
        let member_count = members.len();
        let preview = members.iter().take(20).cloned().collect();
        return (
            "策略组".into(),
            group_kind_label(group),
            preview,
            member_count,
            complete,
        );
    }
    if let Some(members) = generated_group_members(target, nodes) {
        let member_count = members.len();
        let preview = members.into_iter().take(20).collect();
        return (
            "自动线路".into(),
            "订阅来源或地区线路".into(),
            preview,
            member_count,
            true,
        );
    }
    if nodes.iter().any(|node| node.display_name == target) {
        return (
            "节点".into(),
            "固定节点".into(),
            vec![target.to_string()],
            1,
            true,
        );
    }
    ("其他去向".into(), String::new(), Vec::new(), 0, true)
}

fn group_kind_label(group: &PolicyGroup) -> String {
    let mut label = match group.kind.to_ascii_lowercase().as_str() {
        "select" => "手动选择".to_string(),
        "url-test" => "自动测速".to_string(),
        "fallback" => "故障切换".to_string(),
        "load-balance" => "负载均衡".to_string(),
        kind => kind.to_string(),
    };
    if group.all_nodes {
        label.push_str(" · 全部节点动态范围");
    }
    if !group.filter.trim().is_empty() {
        label.push_str(" · 含动态筛选");
    }
    label
}

fn local_group_members(
    group: &PolicyGroup,
    policy: &PolicyConfig,
    nodes: &[ProxyNode],
) -> (Vec<String>, bool) {
    let mut members = Vec::new();
    let can_expand_nodes = group.filter.trim().is_empty();
    if can_expand_nodes {
        for node in nodes
            .iter()
            .filter(|node| matches_policy_group_node(group, node))
        {
            push_unique(&mut members, node.display_name.clone());
        }
    }
    for id in &group.include_node_ids {
        if group.exclude_node_ids.iter().any(|excluded| excluded == id) {
            continue;
        }
        if let Some(node) = nodes.iter().find(|node| &node.id == id) {
            push_unique(&mut members, node.display_name.clone());
        }
    }
    let policy_group_names = policy
        .groups
        .iter()
        .map(|group| group.name.as_str())
        .collect::<Vec<_>>();
    for configured_name in &group.group_names {
        if let Some(range_members) = dynamic_node_range_members(configured_name, nodes) {
            for member in range_members {
                push_unique(&mut members, member);
            }
            continue;
        }
        if configured_name.starts_with(DYNAMIC_NODE_RANGE_PREFIX) {
            continue;
        }
        if policy_group_names.contains(&configured_name.as_str())
            || generated_group_members(configured_name, nodes).is_some()
        {
            push_unique(&mut members, configured_name.clone());
            continue;
        }
        let matching_nodes = nodes
            .iter()
            .filter(|node| {
                node.original_name == *configured_name || node.display_name == *configured_name
            })
            .collect::<Vec<_>>();
        if matching_nodes.is_empty() {
            push_unique(&mut members, configured_name.clone());
        } else {
            for node in matching_nodes {
                push_unique(&mut members, node.display_name.clone());
            }
        }
    }
    if members.is_empty() && !group.all_nodes && can_expand_nodes {
        members.push("DIRECT".into());
    }
    (members, can_expand_nodes)
}

fn matches_policy_group_node(group: &PolicyGroup, node: &ProxyNode) -> bool {
    if group.exclude_node_ids.iter().any(|id| id == &node.id) {
        return false;
    }
    if group.all_nodes {
        return true;
    }
    let has_source = !group.source_ids.is_empty();
    let has_country = !group.countries.is_empty();
    let has_node = !group.node_ids.is_empty();
    (has_source || has_country || has_node)
        && (!has_source || group.source_ids.iter().any(|id| id == &node.source_id))
        && (!has_country
            || group
                .countries
                .iter()
                .any(|country| country == &node.country))
        && (!has_node || group.node_ids.iter().any(|id| id == &node.id))
}

fn generated_group_members(target: &str, nodes: &[ProxyNode]) -> Option<Vec<String>> {
    if let Some(source) = target
        .strip_prefix("📦 ")
        .and_then(|name| name.strip_suffix(" · 全部节点"))
    {
        return Some(
            nodes
                .iter()
                .filter(|node| node.source_name == source)
                .map(|node| node.display_name.clone())
                .collect(),
        );
    }
    let region = target.strip_prefix("🌏 ")?;
    let (country, source) = region.split_once(" · ")?;
    Some(
        nodes
            .iter()
            .filter(|node| node.country == country && node.source_name == source)
            .map(|node| node.display_name.clone())
            .collect(),
    )
}

fn dynamic_node_range_members(target: &str, nodes: &[ProxyNode]) -> Option<Vec<String>> {
    let range_id = dynamic_node_range_id(target)?;
    if let Some(source_id) = range_id.strip_prefix("auto:provider:") {
        return Some(
            nodes
                .iter()
                .filter(|node| node.source_id == source_id)
                .map(|node| node.display_name.clone())
                .collect(),
        );
    }
    let country_key = range_id.strip_prefix("auto:country:")?;
    let (source_id, country) = country_key.split_once('\0')?;
    Some(
        nodes
            .iter()
            .filter(|node| node.source_id == source_id && node.country == country)
            .map(|node| node.display_name.clone())
            .collect(),
    )
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}
