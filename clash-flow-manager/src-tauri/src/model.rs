use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const DYNAMIC_NODE_RANGE_PREFIX: &str = "__clash_flow_manager_dynamic_node_range_v1__:";

pub fn dynamic_node_range_id(value: &str) -> Option<String> {
    let payload = value.strip_prefix(DYNAMIC_NODE_RANGE_PREFIX)?;
    let parsed: Value = serde_json::from_str(payload).ok()?;
    parsed
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub url: String,
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub include_prefix: bool,
    #[serde(default = "default_true")]
    pub include_flag: bool,
    #[serde(default = "default_true")]
    pub include_country: bool,
    #[serde(default = "default_true")]
    pub include_original_name: bool,
    #[serde(default)]
    pub region_hint: String,
    #[serde(default)]
    pub node_count: usize,
    #[serde(default)]
    pub last_updated: String,
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub subscription_info: Option<SubscriptionInfo>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    #[serde(default)]
    pub package_name: String,
    #[serde(default)]
    pub upload_bytes: Option<u64>,
    #[serde(default)]
    pub download_bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub remaining_bytes: Option<u64>,
    #[serde(default)]
    pub remaining_label: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub reset_after_days: Option<u64>,
    #[serde(default)]
    pub official_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNode {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    #[serde(default)]
    pub source_prefix: String,
    pub original_name: String,
    pub display_name: String,
    pub country: String,
    pub config: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyGroup {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub all_nodes: bool,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub countries: Vec<String>,
    #[serde(default)]
    pub node_ids: Vec<String>,
    #[serde(default)]
    pub include_node_ids: Vec<String>,
    #[serde(default)]
    pub exclude_node_ids: Vec<String>,
    #[serde(default)]
    pub group_names: Vec<String>,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub interval: u64,
    #[serde(default)]
    pub options: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub kind: String,
    pub value: String,
    pub target: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyConfig {
    pub template_name: String,
    #[serde(default)]
    pub template_url: String,
    #[serde(default)]
    pub template_content: String,
    #[serde(default)]
    pub rule_providers: Value,
    #[serde(default)]
    pub groups: Vec<PolicyGroup>,
    #[serde(default)]
    pub rules: Vec<PolicyRule>,
    #[serde(default)]
    pub rule_group_order: Vec<String>,
    #[serde(default)]
    pub auto_group_settings: BTreeMap<String, AutoGroupSettings>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoGroupSettings {
    #[serde(default = "default_auto_group_kind")]
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub interval: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_selected: Option<String>,
}

fn default_auto_group_kind() -> String {
    "select".into()
}

impl Default for AutoGroupSettings {
    fn default() -> Self {
        Self {
            kind: default_auto_group_kind(),
            url: String::new(),
            interval: 0,
            default_selected: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPolicy {
    pub id: String,
    pub name: String,
    pub config: PolicyConfig,
    pub updated_at: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PolicyLibrary {
    pub active_id: String,
    pub items: Vec<SavedPolicy>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
    pub provider: Value,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub remote_entries: Vec<String>,
    #[serde(default)]
    pub local_additions: Vec<String>,
    #[serde(default)]
    pub excluded_entries: Vec<String>,
    #[serde(default)]
    pub entry_count: Option<usize>,
    #[serde(default)]
    pub sample: Vec<String>,
    #[serde(default)]
    pub checked_at: String,
    #[serde(default)]
    pub synced_at: String,
    #[serde(default)]
    pub update_available: Option<bool>,
    #[serde(default)]
    pub mrs_hash: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetLibrary {
    pub items: Vec<RuleSetItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetPreview {
    pub entry_count: Option<usize>,
    pub sample: Vec<String>,
    pub summary: String,
    pub behavior: String,
    pub format: String,
    #[serde(default)]
    pub entries: Vec<String>,
    pub downloaded_at: String,
    pub mrs_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySaveResult {
    pub library: PolicyLibrary,
    pub saved_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub controller_url: String,
    #[serde(default)]
    pub controller_secret: String,
    #[serde(default)]
    pub subscription_proxy: String,
    pub use_subscription_proxy: bool,
    pub collect_enabled: bool,
    pub auto_update_enabled: bool,
    #[serde(default = "default_true")]
    pub sync_subscriptions_on_profile_refresh: bool,
    pub update_minutes: u64,
    pub profile_port: u16,
    pub mixed_port: u16,
    #[serde(default = "default_profile_name")]
    pub profile_name: String,
    #[serde(default)]
    pub profile_traffic_source_id: String,
    #[serde(default = "default_auto_group_name_parts")]
    pub auto_group_name_parts: Vec<String>,
}

fn default_profile_name() -> String {
    "Clash 管家".into()
}

fn default_auto_group_name_parts() -> Vec<String> {
    vec!["provider".into(), "separator:dot".into(), "route".into()]
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            controller_url: "http://127.0.0.1:9090".into(),
            controller_secret: String::new(),
            subscription_proxy: "http://127.0.0.1:7897".into(),
            use_subscription_proxy: true,
            collect_enabled: true,
            auto_update_enabled: true,
            sync_subscriptions_on_profile_refresh: true,
            update_minutes: 60,
            profile_port: 39127,
            mixed_port: 7890,
            profile_name: default_profile_name(),
            profile_traffic_source_id: String::new(),
            auto_group_name_parts: default_auto_group_name_parts(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub time: String,
    pub upload: u64,
    pub download: u64,
    pub provider: String,
    pub node: String,
    #[serde(default)]
    pub group: String,
    pub site: String,
    pub rule: String,
    #[serde(default)]
    pub chain_order_version: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedConnection {
    pub connection_id: String,
    pub detected_at: String,
    pub started_at: String,
    pub site: String,
    pub destination_ip: String,
    pub destination_port: String,
    pub source_ip: String,
    pub source_port: String,
    pub network: String,
    pub process: String,
    pub process_path: String,
    pub inbound: String,
    pub fallback_target: String,
    pub proxy_chain: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub key: String,
    pub provider: String,
    pub node: String,
    #[serde(default)]
    pub group: String,
    pub site: String,
    pub rule: String,
    pub upload: u64,
    pub download: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub upload: u64,
    pub download: u64,
    pub by_node: Vec<UsageRow>,
    pub by_site: Vec<UsageRow>,
    pub by_provider: Vec<UsageRow>,
    pub by_group: Vec<UsageRow>,
    pub by_rule: Vec<UsageRow>,
    #[serde(default)]
    pub by_detail: Vec<UsageRow>,
    pub by_day: Vec<UsageDay>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub date: String,
    pub upload: u64,
    pub download: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSyncResult {
    pub sources: Vec<Source>,
    pub node_count: usize,
    pub errors: Vec<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceSyncProgress {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub origin: String,
    pub source_id: Option<String>,
    pub active: bool,
    pub cancel_requested: bool,
    pub completed: usize,
    pub total: usize,
    pub source_name: String,
    pub phase: String,
}

pub fn default_policy() -> PolicyConfig {
    PolicyConfig {
        template_name: "本地基础分流".into(),
        template_url: String::new(),
        template_content: String::new(),
        rule_providers: Value::Object(Default::default()),
        groups: vec![
            PolicyGroup {
                id: "all-nodes".into(),
                name: "🌐 全部节点".into(),
                kind: "select".into(),
                all_nodes: true,
                source_ids: vec![],
                countries: vec![],
                node_ids: vec![],
                include_node_ids: vec![],
                exclude_node_ids: vec![],
                group_names: vec![],
                filter: String::new(),
                url: String::new(),
                interval: 0,
                options: Value::Object(Default::default()),
            },
            PolicyGroup {
                id: "ai".into(),
                name: "🤖 AI 服务".into(),
                kind: "select".into(),
                all_nodes: false,
                source_ids: vec![],
                countries: vec![],
                node_ids: vec![],
                include_node_ids: vec![],
                exclude_node_ids: vec![],
                group_names: vec!["🌐 全部节点".into()],
                filter: String::new(),
                url: String::new(),
                interval: 0,
                options: Value::Object(Default::default()),
            },
            PolicyGroup {
                id: "auto".into(),
                name: "⚡ 自动选择".into(),
                kind: "url-test".into(),
                all_nodes: true,
                source_ids: vec![],
                countries: vec![],
                node_ids: vec![],
                include_node_ids: vec![],
                exclude_node_ids: vec![],
                group_names: vec![],
                filter: String::new(),
                url: "https://www.gstatic.com/generate_204".into(),
                interval: 600,
                options: Value::Object(Default::default()),
            },
        ],
        rule_group_order: Vec::new(),
        auto_group_settings: BTreeMap::new(),
        rules: vec![
            PolicyRule {
                kind: "DOMAIN-SUFFIX".into(),
                value: "openai.com".into(),
                target: "🤖 AI 服务".into(),
            },
            PolicyRule {
                kind: "DOMAIN-SUFFIX".into(),
                value: "chatgpt.com".into(),
                target: "🤖 AI 服务".into(),
            },
            PolicyRule {
                kind: "MATCH".into(),
                value: String::new(),
                target: "🌐 全部节点".into(),
            },
        ],
    }
}
