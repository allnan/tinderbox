use reqwest::{header, redirect::Policy, Client, Response};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use url::Url;

use crate::model::AppSettings;

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
    // Mihomo returns `chains` from the selected outbound back through its parent
    // groups. Keep the leaf as the actual node, and reverse the chain for the UI.
    let mut proxy_chain = connection
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
    let node = proxy_chain
        .first()
        .cloned()
        .unwrap_or_else(|| "未识别节点".into());
    let route_group = proxy_chain
        .last()
        .cloned()
        .unwrap_or_else(|| "未识别策略组".into());
    proxy_chain.reverse();
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
        route_group,
        node,
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
