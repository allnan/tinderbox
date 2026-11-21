use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::{
    model::{AppSettings, PolicyConfig, PolicyLibrary, ProxyNode, RuleSetLibrary, Source},
    paths,
    state::AppState,
};

const FORMAT: &str = "clash-flow-manager-backup";
const VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficBackupFile {
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupBundle {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub settings: AppSettings,
    pub sources: Vec<Source>,
    pub nodes: Vec<ProxyNode>,
    pub policy: PolicyConfig,
    pub policy_library: PolicyLibrary,
    pub rule_set_library: RuleSetLibrary,
    pub traffic_files: Vec<TrafficBackupFile>,
}

fn is_traffic_log_name(name: &str) -> bool {
    ["traffic-", "unmatched-"].iter().any(|prefix| {
        name.strip_prefix(prefix)
            .and_then(|tail| tail.strip_suffix(".jsonl"))
            .is_some_and(|date| {
                NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok() && date.len() == 10
            })
    })
}

pub fn export(state: &AppState) -> Result<BackupBundle, String> {
    let _history_guard = state
        .traffic_history_lock
        .lock()
        .map_err(|_| "流量历史操作锁定失败")?;
    let dir = paths::data_dir();
    let entries = fs::read_dir(&dir).map_err(|error| format!("读取备份数据目录失败：{error}"))?;
    let mut traffic_files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if path.is_file() && is_traffic_log_name(name) {
            let content = fs::read_to_string(&path)
                .map_err(|error| format!("读取流量记录 {name} 失败：{error}"))?;
            traffic_files.push(TrafficBackupFile {
                name: name.to_string(),
                content,
            });
        }
    }
    traffic_files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(BackupBundle {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: chrono::Local::now().to_rfc3339(),
        settings: state
            .settings
            .read()
            .map_err(|_| "应用设置锁定失败")?
            .clone(),
        sources: state
            .sources
            .read()
            .map_err(|_| "订阅来源锁定失败")?
            .clone(),
        nodes: state.nodes.read().map_err(|_| "节点数据锁定失败")?.clone(),
        policy: state.policy.read().map_err(|_| "策略配置锁定失败")?.clone(),
        policy_library: state
            .policy_library
            .read()
            .map_err(|_| "策略库锁定失败")?
            .clone(),
        rule_set_library: state
            .rule_set_library
            .read()
            .map_err(|_| "规则集库锁定失败")?
            .clone(),
        traffic_files,
    })
}

fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|error| format!("生成备份数据失败：{error}"))
}

fn rollback(originals: &BTreeMap<String, Option<Vec<u8>>>) {
    for (name, bytes) in originals {
        let path = paths::path(name);
        match bytes {
            Some(bytes) => {
                let _ = paths::write_atomic(&path, bytes);
            }
            None => {
                let _ = fs::remove_file(path);
            }
        }
    }
}

pub fn restore(state: &AppState, mut bundle: BackupBundle) -> Result<(), String> {
    if bundle.format != FORMAT || bundle.version != VERSION {
        return Err("备份文件格式或版本不受支持".into());
    }
    let mut names = HashSet::new();
    for file in &bundle.traffic_files {
        if !is_traffic_log_name(&file.name) || !names.insert(file.name.clone()) {
            return Err("备份中的流量文件名无效或重复".into());
        }
    }
    let source_ids = bundle
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect::<HashSet<_>>();
    if source_ids.len() != bundle.sources.len() {
        return Err("备份中存在重复的订阅来源 ID".into());
    }
    let node_ids = bundle
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<HashSet<_>>();
    if node_ids.len() != bundle.nodes.len() {
        return Err("备份中存在重复的节点 ID".into());
    }
    if bundle.settings.profile_name.trim().is_empty()
        || bundle.settings.profile_name.chars().count() > 64
        || bundle
            .settings
            .profile_name
            .chars()
            .any(|ch| matches!(ch, '\r' | '\n' | '\0'))
    {
        return Err("备份中的配置名称无效".into());
    }
    if !source_ids.contains(bundle.settings.profile_traffic_source_id.as_str()) {
        bundle.settings.profile_traffic_source_id.clear();
    }

    let _history_guard = state
        .traffic_history_lock
        .lock()
        .map_err(|_| "流量历史操作锁定失败")?;
    let mut settings_guard = state.settings.write().map_err(|_| "应用设置锁定失败")?;
    let mut sources_guard = state.sources.write().map_err(|_| "订阅来源锁定失败")?;
    let mut nodes_guard = state.nodes.write().map_err(|_| "节点数据锁定失败")?;
    let mut policy_guard = state.policy.write().map_err(|_| "策略配置锁定失败")?;
    let mut policies_guard = state.policy_library.write().map_err(|_| "策略库锁定失败")?;
    let mut rule_sets_guard = state
        .rule_set_library
        .write()
        .map_err(|_| "规则集库锁定失败")?;

    bundle.settings.profile_port = settings_guard.profile_port;
    if bundle.policy_library.items.is_empty() {
        bundle.policy_library.items.push(crate::model::SavedPolicy {
            id: uuid::Uuid::new_v4().to_string(),
            name: bundle.policy.template_name.clone(),
            config: bundle.policy.clone(),
            updated_at: chrono::Local::now().to_rfc3339(),
            pinned: false,
        });
    }
    if !bundle
        .policy_library
        .items
        .iter()
        .any(|item| item.id == bundle.policy_library.active_id)
    {
        bundle.policy_library.active_id = bundle.policy_library.items[0].id.clone();
    }
    crate::rule_sets::normalize_policy_library(
        &mut bundle.policy_library,
        &mut bundle.rule_set_library,
    );
    bundle.policy = bundle
        .policy_library
        .items
        .iter()
        .find(|item| item.id == bundle.policy_library.active_id)
        .map(|item| item.config.clone())
        .unwrap_or(bundle.policy);

    let yaml = crate::policy::generate_profile(
        &bundle.nodes,
        &bundle.sources,
        &bundle.policy,
        &bundle.settings,
    )?;
    let selected_info = bundle
        .sources
        .iter()
        .find(|source| source.id == bundle.settings.profile_traffic_source_id)
        .and_then(|source| source.subscription_info.as_ref());
    let metadata = serde_json::json!({ "name": bundle.settings.profile_name, "subscriptionInfo": selected_info });
    let metadata_bytes = json_bytes(&metadata)?;
    let mut writes = BTreeMap::new();
    writes.insert("settings.json".to_string(), json_bytes(&bundle.settings)?);
    writes.insert("sources.json".to_string(), json_bytes(&bundle.sources)?);
    writes.insert("nodes.json".to_string(), json_bytes(&bundle.nodes)?);
    writes.insert("policy.json".to_string(), json_bytes(&bundle.policy)?);
    writes.insert(
        "policy-library.json".to_string(),
        json_bytes(&bundle.policy_library)?,
    );
    writes.insert(
        "rule-set-library.json".to_string(),
        json_bytes(&bundle.rule_set_library)?,
    );
    writes.insert("generated-profile.yaml".to_string(), yaml.into_bytes());
    writes.insert("profile-metadata.json".to_string(), metadata_bytes);
    for file in &bundle.traffic_files {
        writes.insert(file.name.clone(), file.content.as_bytes().to_vec());
    }

    let mut originals = BTreeMap::<String, Option<Vec<u8>>>::new();
    let managed = [
        "settings.json",
        "sources.json",
        "nodes.json",
        "policy.json",
        "policy-library.json",
        "rule-set-library.json",
        "generated-profile.yaml",
        "profile-metadata.json",
    ];
    for name in managed {
        let path = paths::path(name);
        let previous = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("读取当前文件 {name} 失败，未执行恢复：{error}")),
        };
        originals.insert(name.into(), previous);
    }
    let entries = fs::read_dir(paths::data_dir())
        .map_err(|error| format!("读取当前流量记录失败：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if path.is_file() && is_traffic_log_name(name) {
            let bytes = fs::read(&path)
                .map_err(|error| format!("读取当前流量记录 {name} 失败，未执行恢复：{error}"))?;
            originals.insert(name.into(), Some(bytes));
        }
    }
    for name in writes.keys() {
        originals.entry(name.clone()).or_insert(None);
    }

    for (name, bytes) in &writes {
        if let Err(error) = paths::write_atomic(&paths::path(name), bytes) {
            rollback(&originals);
            return Err(format!("恢复备份失败，已尝试回滚本机文件：{error}"));
        }
    }
    for name in originals
        .keys()
        .filter(|name| is_traffic_log_name(name) && !writes.contains_key(*name))
    {
        if let Err(error) = fs::remove_file(paths::path(name)) {
            rollback(&originals);
            return Err(format!("替换旧流量历史失败，已尝试回滚本机文件：{error}"));
        }
    }

    *settings_guard = bundle.settings;
    *sources_guard = bundle.sources;
    *nodes_guard = bundle.nodes;
    *policy_guard = bundle.policy;
    *policies_guard = bundle.policy_library;
    *rule_sets_guard = bundle.rule_set_library;
    state
        .traffic_history_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    Ok(())
}
