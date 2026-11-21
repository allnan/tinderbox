use chrono::{Duration as ChronoDuration, Local, NaiveDate};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use crate::{
    model::{AppSettings, UnmatchedConnection, UsageDay, UsageRecord, UsageRow, UsageSummary},
    paths,
    state::AppState,
};

fn read_settings(state: &AppState) -> AppSettings {
    state
        .settings
        .read()
        .map(|value| value.clone())
        .unwrap_or_default()
}

fn numeric(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

fn connection_meta(connection: &Value) -> (String, String, String, String) {
    let metadata = connection.get("metadata").unwrap_or(&Value::Null);
    let chains = connection.get("chains").and_then(Value::as_array);
    let chain_values = chains
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let node = chain_values
        .first()
        .cloned()
        .unwrap_or_else(|| "未识别节点".into());
    let group = chain_values
        .last()
        .cloned()
        .unwrap_or_else(|| "未识别策略组".into());
    let site = metadata
        .get("host")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| metadata.get("destinationIP").and_then(Value::as_str))
        .or_else(|| metadata.get("remoteDestination").and_then(Value::as_str))
        .unwrap_or("未知站点")
        .to_string();
    let rule = match (
        connection.get("rule").and_then(Value::as_str),
        connection.get("rulePayload").and_then(Value::as_str),
    ) {
        (Some(rule), Some(payload)) if !payload.is_empty() => format!("{rule} · {payload}"),
        (Some(rule), _) if !rule.is_empty() => rule.to_string(),
        _ => group.clone(),
    };
    (node, group, site, rule)
}

fn unmatched_connection(connection: &Value, detected_at: &str) -> Option<UnmatchedConnection> {
    let rule = connection.get("rule").and_then(Value::as_str)?;
    if !rule.eq_ignore_ascii_case("MATCH") {
        return None;
    }
    let connection_id = string(connection.get("id"));
    if connection_id.is_empty() {
        return None;
    }
    let metadata = connection.get("metadata").unwrap_or(&Value::Null);
    let destination_ip = string(metadata.get("destinationIP"));
    let site = metadata
        .get("host")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| metadata.get("destinationIP").and_then(Value::as_str))
        .or_else(|| metadata.get("remoteDestination").and_then(Value::as_str))
        .unwrap_or("未知站点")
        .to_string();
    let proxy_chain = connection
        .get("chains")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let started_at = connection
        .get("start")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(detected_at)
        .to_string();
    Some(UnmatchedConnection {
        connection_id,
        detected_at: detected_at.to_string(),
        started_at,
        site,
        destination_ip,
        destination_port: string(metadata.get("destinationPort")),
        source_ip: string(metadata.get("sourceIP")),
        source_port: string(metadata.get("sourcePort")),
        network: string(metadata.get("network")),
        process: string(metadata.get("process")),
        process_path: string(metadata.get("processPath")),
        inbound: string(metadata.get("inboundName")),
        fallback_target: string(connection.get("rulePayload")),
        proxy_chain,
    })
}

fn provider_from_node(node: &str) -> String {
    node.strip_prefix('[')
        .and_then(|value| value.split_once(']'))
        .map(|(provider, _)| provider.to_string())
        .unwrap_or_else(|| "未知来源".into())
}

fn append_records(records: &[UsageRecord]) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let day = Local::now().format("%Y-%m-%d").to_string();
    let path = paths::data_dir().join(format!("traffic-{day}.jsonl"));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("打开流量记录文件失败：{error}"))?;
    let mut writer = std::io::BufWriter::new(file);
    for record in records {
        serde_json::to_writer(&mut writer, record).map_err(|error| error.to_string())?;
        writer.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())
}

fn append_unmatched_connections(records: &[UnmatchedConnection]) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let day = Local::now().format("%Y-%m-%d").to_string();
    let path = paths::data_dir().join(format!("unmatched-{day}.jsonl"));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("打开未命中连接记录失败：{error}"))?;
    let mut writer = std::io::BufWriter::new(file);
    for record in records {
        serde_json::to_writer(&mut writer, record).map_err(|error| error.to_string())?;
        writer.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())
}

fn load_recorded_unmatched_ids() -> HashSet<String> {
    let day = Local::now().format("%Y-%m-%d").to_string();
    let path = paths::data_dir().join(format!("unmatched-{day}.jsonl"));
    let Ok(file) = fs::File::open(path) else {
        return HashSet::new();
    };
    BufReader::new(file)
        .lines()
        .flatten()
        .filter_map(|line| serde_json::from_str::<UnmatchedConnection>(&line).ok())
        .map(|record| record.connection_id)
        .collect()
}

fn bump(
    map: &mut HashMap<(String, String, String, String, String), (u64, u64)>,
    provider: String,
    node: String,
    group: String,
    site: String,
    rule: String,
    up: u64,
    down: u64,
) {
    let entry = map
        .entry((provider, node, group, site, rule))
        .or_insert((0, 0));
    entry.0 = entry.0.saturating_add(up);
    entry.1 = entry.1.saturating_add(down);
}

async fn poll_once(
    client: &reqwest::Client,
    settings: &AppSettings,
    previous_total: &mut Option<(u64, u64)>,
    previous_flows: &mut HashMap<String, (u64, u64)>,
    recorded_unmatched_ids: &mut HashSet<String>,
    warmup: &mut bool,
    history_lock: &Mutex<()>,
    history_generation: &AtomicU64,
) -> Result<(u64, u64), String> {
    let generation = history_generation.load(Ordering::Acquire);
    let endpoint = format!(
        "{}/connections",
        settings.controller_url.trim_end_matches('/')
    );
    let mut request = client.get(endpoint);
    if !settings.controller_secret.is_empty() {
        request = request.bearer_auth(&settings.controller_secret);
    }
    let response = request
        .send()
        .await
        .map_err(|_| {
            "无法连接 Mihomo 控制器。请检查 Clash Verge 是否运行，以及 external-controller 地址和端口是否匹配。".to_string()
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Mihomo API 返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|error| format!("Mihomo API 响应无法解析：{error}"))?;
    let timestamp = Local::now().to_rfc3339();
    let mut records = Vec::new();
    let mut unmatched_records = Vec::new();
    let current_total = (
        numeric(data.get("uploadTotal").or_else(|| data.get("upTotal"))),
        numeric(data.get("downloadTotal").or_else(|| data.get("downTotal"))),
    );
    if let Some(previous) = previous_total {
        let up = current_total.0.saturating_sub(previous.0);
        let down = current_total.1.saturating_sub(previous.1);
        if up > 0 || down > 0 {
            records.push(UsageRecord {
                time: timestamp.clone(),
                upload: up,
                download: down,
                provider: "__total__".into(),
                node: "总流量".into(),
                group: "全部".into(),
                site: "全部连接".into(),
                rule: "全部策略".into(),
                chain_order_version: 1,
            });
        }
    }
    *previous_total = Some(current_total);

    let mut by_connection = HashMap::new();
    if let Some(connections) = data.get("connections").and_then(Value::as_array) {
        for connection in connections {
            let id = string(connection.get("id"));
            if id.is_empty() {
                continue;
            }
            if let Some(record) = unmatched_connection(connection, &timestamp) {
                if !recorded_unmatched_ids.contains(&record.connection_id) {
                    unmatched_records.push(record);
                }
            }
            let current = (
                numeric(connection.get("upload")),
                numeric(connection.get("download")),
            );
            let old = previous_flows.get(&id).copied();
            previous_flows.insert(id.clone(), current);
            if *warmup {
                continue;
            }
            let delta = old
                .map(|value| {
                    (
                        current.0.saturating_sub(value.0),
                        current.1.saturating_sub(value.1),
                    )
                })
                .unwrap_or(current);
            if delta.0 == 0 && delta.1 == 0 {
                continue;
            }
            let (node, group, site, rule) = connection_meta(connection);
            let provider = provider_from_node(&node);
            bump(
                &mut by_connection,
                provider,
                node,
                group,
                site,
                rule,
                delta.0,
                delta.1,
            );
        }
    }
    *warmup = false;
    previous_flows.retain(|id, _| {
        data.get("connections")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
            })
    });
    for ((provider, node, group, site, rule), (upload, download)) in by_connection {
        records.push(UsageRecord {
            time: timestamp.clone(),
            upload,
            download,
            provider,
            node,
            group,
            site,
            rule,
            chain_order_version: 1,
        });
    }
    let _history_guard = history_lock.lock().map_err(|_| "流量历史操作锁定失败")?;
    if history_generation.load(Ordering::Acquire) != generation {
        return Ok(current_total);
    }
    append_records(&records)?;
    append_unmatched_connections(&unmatched_records)?;
    recorded_unmatched_ids.extend(
        unmatched_records
            .into_iter()
            .map(|record| record.connection_id),
    );
    Ok(current_total)
}

pub fn start_collector(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(4))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                if let Ok(mut status) = state.last_traffic_status.lock() {
                    *status = format!("创建网络客户端失败：{error}");
                }
                return;
            }
        };
        let mut previous_total = None;
        let mut previous_flows = HashMap::new();
        let mut recorded_unmatched_ids = load_recorded_unmatched_ids();
        let mut warmup = true;
        let mut last_history_generation = state.traffic_history_generation.load(Ordering::Acquire);
        loop {
            let observed_generation = state.traffic_history_generation.load(Ordering::Acquire);
            if observed_generation != last_history_generation {
                if let Ok(_history_guard) = state.traffic_history_lock.lock() {
                    let locked_generation =
                        state.traffic_history_generation.load(Ordering::Acquire);
                    if locked_generation != last_history_generation {
                        previous_total = None;
                        previous_flows.clear();
                        recorded_unmatched_ids = load_recorded_unmatched_ids();
                        warmup = true;
                        last_history_generation = locked_generation;
                    }
                }
            }
            let settings = read_settings(&state);
            if settings.collect_enabled && !settings.controller_url.trim().is_empty() {
                match poll_once(
                    &client,
                    &settings,
                    &mut previous_total,
                    &mut previous_flows,
                    &mut recorded_unmatched_ids,
                    &mut warmup,
                    &state.traffic_history_lock,
                    &state.traffic_history_generation,
                )
                .await
                {
                    Ok(_) => {
                        if let Ok(mut status) = state.last_traffic_status.lock() {
                            *status = format!("已连接 · {}", Local::now().format("%H:%M:%S"));
                        }
                    }
                    Err(error) => {
                        if let Ok(mut status) = state.last_traffic_status.lock() {
                            *status = error;
                        }
                    }
                }
            } else if let Ok(mut status) = state.last_traffic_status.lock() {
                *status = "统计采集已暂停".into();
                previous_total = None;
                previous_flows.clear();
                warmup = true;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

fn date_in_range(time: &str, from: &str, to: &str) -> bool {
    let Some(day) = time.get(0..10) else {
        return false;
    };
    day >= from && day <= to
}

fn add_row(map: &mut HashMap<String, UsageRow>, key: String, record: &UsageRecord) {
    let row = map.entry(key.clone()).or_insert_with(|| UsageRow {
        key,
        provider: record.provider.clone(),
        node: record.node.clone(),
        group: record.group.clone(),
        site: record.site.clone(),
        rule: record.rule.clone(),
        upload: 0,
        download: 0,
    });
    row.upload = row.upload.saturating_add(record.upload);
    row.download = row.download.saturating_add(record.download);
}

fn sorted_rows(map: HashMap<String, UsageRow>) -> Vec<UsageRow> {
    let mut rows = map.into_values().collect::<Vec<_>>();
    rows.sort_by_key(|row| std::cmp::Reverse(row.upload.saturating_add(row.download)));
    rows
}

pub fn summarize(from: &str, to: &str) -> Result<UsageSummary, String> {
    let from_date =
        NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|_| "起始日期格式应为 YYYY-MM-DD")?;
    let to_date =
        NaiveDate::parse_from_str(to, "%Y-%m-%d").map_err(|_| "结束日期格式应为 YYYY-MM-DD")?;
    if to_date < from_date {
        return Err("结束日期不能早于起始日期".into());
    }
    let mut result = UsageSummary::default();
    let mut by_node = HashMap::new();
    let mut by_site = HashMap::new();
    let mut by_provider = HashMap::new();
    let mut by_group = HashMap::new();
    let mut by_rule = HashMap::new();
    let mut by_detail = HashMap::new();
    let mut by_day: HashMap<String, UsageDay> = HashMap::new();
    let dir = paths::data_dir();
    let entries = fs::read_dir(&dir).map_err(|error| format!("读取流量记录失败：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !filename.starts_with("traffic-") || !filename.ends_with(".jsonl") {
            continue;
        }
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        for line in BufReader::new(file).lines().flatten() {
            let Ok(mut record) = serde_json::from_str::<UsageRecord>(&line) else {
                continue;
            };
            if record.provider != "__total__" && record.chain_order_version == 0 {
                if !record.node.is_empty() && !record.group.is_empty() {
                    std::mem::swap(&mut record.node, &mut record.group);
                    record.provider = provider_from_node(&record.node);
                }
                record.chain_order_version = 1;
            }
            if !date_in_range(&record.time, from, to) {
                continue;
            }
            if record.provider == "__total__" {
                result.upload = result.upload.saturating_add(record.upload);
                result.download = result.download.saturating_add(record.download);
                let date = record.time.get(0..10).unwrap_or("").to_string();
                let day = by_day.entry(date.clone()).or_insert_with(|| UsageDay {
                    date,
                    upload: 0,
                    download: 0,
                });
                day.upload = day.upload.saturating_add(record.upload);
                day.download = day.download.saturating_add(record.download);
                continue;
            }
            add_row(&mut by_node, record.node.clone(), &record);
            add_row(&mut by_site, record.site.clone(), &record);
            add_row(&mut by_provider, record.provider.clone(), &record);
            add_row(&mut by_group, record.group.clone(), &record);
            add_row(&mut by_rule, record.rule.clone(), &record);
            let detail_key = [
                record.site.as_str(),
                record.provider.as_str(),
                record.node.as_str(),
                record.group.as_str(),
                record.rule.as_str(),
            ]
            .join("\0");
            add_row(&mut by_detail, detail_key, &record);
        }
    }
    result.by_node = sorted_rows(by_node);
    result.by_site = sorted_rows(by_site);
    result.by_provider = sorted_rows(by_provider);
    result.by_group = sorted_rows(by_group);
    result.by_rule = sorted_rows(by_rule);
    result.by_detail = sorted_rows(by_detail);
    let days = (to_date - from_date).num_days();
    result.by_day = (0..=days)
        .map(|offset| {
            let date = (from_date + ChronoDuration::days(offset))
                .format("%Y-%m-%d")
                .to_string();
            by_day.remove(&date).unwrap_or(UsageDay {
                date,
                upload: 0,
                download: 0,
            })
        })
        .collect();
    Ok(result)
}

pub fn unmatched_connections(from: &str, to: &str) -> Result<Vec<UnmatchedConnection>, String> {
    let from_date =
        NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|_| "起始日期格式应为 YYYY-MM-DD")?;
    let to_date =
        NaiveDate::parse_from_str(to, "%Y-%m-%d").map_err(|_| "结束日期格式应为 YYYY-MM-DD")?;
    if to_date < from_date {
        return Err("结束日期不能早于起始日期".into());
    }
    let mut records = Vec::new();
    let dir = paths::data_dir();
    let entries = fs::read_dir(&dir).map_err(|error| format!("读取未命中连接记录失败：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !filename.starts_with("unmatched-") || !filename.ends_with(".jsonl") {
            continue;
        }
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        for line in BufReader::new(file).lines().flatten() {
            let Ok(record) = serde_json::from_str::<UnmatchedConnection>(&line) else {
                continue;
            };
            if date_in_range(&record.detected_at, from, to) {
                records.push(record);
            }
        }
    }
    records.sort_by(|a, b| b.detected_at.cmp(&a.detected_at));
    Ok(records)
}

pub fn clear_history(state: &AppState) -> Result<usize, String> {
    let _history_guard = state
        .traffic_history_lock
        .lock()
        .map_err(|_| "流量历史操作锁定失败")?;
    state
        .traffic_history_generation
        .fetch_add(1, Ordering::AcqRel);
    let dir = paths::data_dir();
    let entries = fs::read_dir(&dir).map_err(|error| format!("读取流量记录目录失败：{error}"))?;
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let is_traffic = ["traffic-", "unmatched-"]
            .iter()
            .any(|prefix| filename.starts_with(prefix) && filename.ends_with(".jsonl"));
        if is_traffic {
            fs::remove_file(&path)
                .map_err(|error| format!("删除流量记录 {} 失败：{error}", filename))?;
            removed += 1;
        }
    }
    Ok(removed)
}
