use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
};
use uuid::Uuid;

use crate::{
    model::{
        default_policy, AppSettings, PolicyConfig, PolicyLibrary, ProxyNode, RuleSetLibrary,
        SavedPolicy, Source, SourceSyncProgress,
    },
    paths,
};

pub struct AppState {
    pub source_sync_lock: tokio::sync::Mutex<()>,
    pub source_sync_cancel_requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub source_sync_progress: Mutex<HashMap<String, SourceSyncProgress>>,
    pub traffic_history_lock: Mutex<()>,
    pub traffic_history_generation: AtomicU64,
    pub sources: RwLock<Vec<Source>>,
    pub nodes: RwLock<Vec<ProxyNode>>,
    pub policy: RwLock<PolicyConfig>,
    pub policy_library: RwLock<PolicyLibrary>,
    pub rule_set_library: RwLock<RuleSetLibrary>,
    pub settings: RwLock<AppSettings>,
    pub sync_status: Mutex<String>,
    pub last_sync: Mutex<String>,
    pub last_traffic_status: Mutex<String>,
    pub profile_url: String,
    pub profile_last_requested_at: Arc<AtomicI64>,
    pub profile_last_generated_at: Arc<AtomicI64>,
    pub profile_legacy_needs_update: Arc<AtomicBool>,
    pub profile_sync_subscriptions: Arc<AtomicBool>,
    pub profile_refresh: Arc<crate::server::ProfileRefreshSignal>,
    pub data_dir: String,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new() -> Result<SharedState, String> {
        let data_dir = paths::data_dir();
        let sources: Vec<Source> = paths::ensure_json("sources.json", Vec::new());
        let mut nodes: Vec<ProxyNode> = paths::ensure_json("nodes.json", Vec::new());
        let mut policy: PolicyConfig = paths::ensure_json("policy.json", default_policy());
        let mut policy_library: PolicyLibrary =
            paths::ensure_json("policy-library.json", PolicyLibrary::default());
        if policy_library.items.is_empty() {
            let id = Uuid::new_v4().to_string();
            policy_library.active_id = id.clone();
            policy_library.items.push(SavedPolicy {
                id,
                name: policy.template_name.clone(),
                config: policy.clone(),
                updated_at: chrono::Local::now().to_rfc3339(),
                pinned: false,
            });
            paths::write_json("policy-library.json", &policy_library)?;
        } else {
            if !policy_library
                .items
                .iter()
                .any(|item| item.id == policy_library.active_id)
            {
                policy_library.active_id = policy_library.items[0].id.clone();
            }
            if let Some(active) = policy_library
                .items
                .iter()
                .find(|item| item.id == policy_library.active_id)
            {
                policy = active.config.clone();
            }
        }
        let mut rule_set_library: RuleSetLibrary =
            paths::ensure_json("rule-set-library.json", RuleSetLibrary::default());
        let rule_sets_changed =
            crate::rule_sets::normalize_policy_library(&mut policy_library, &mut rule_set_library);
        if rule_sets_changed {
            paths::write_json("rule-set-library.json", &rule_set_library)?;
            paths::write_json("policy-library.json", &policy_library)?;
        }
        if let Some(active) = policy_library
            .items
            .iter()
            .find(|item| item.id == policy_library.active_id)
        {
            policy = active.config.clone();
        }
        if rule_sets_changed || !paths::path("policy.json").exists() {
            paths::write_json("policy.json", &policy)?;
        }
        let settings: AppSettings = paths::ensure_json("settings.json", AppSettings::default());
        let previous_node_names = nodes
            .iter()
            .map(|node| {
                (
                    node.id.clone(),
                    node.display_name.clone(),
                    node.country.clone(),
                    node.source_name.clone(),
                    node.source_prefix.clone(),
                    node.config
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect::<Vec<_>>();
        for source in &sources {
            crate::conversion::retag_nodes(source, &mut nodes);
        }
        let node_names_changed = nodes
            .iter()
            .map(|node| {
                (
                    node.id.clone(),
                    node.display_name.clone(),
                    node.country.clone(),
                    node.source_name.clone(),
                    node.source_prefix.clone(),
                    node.config
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect::<Vec<_>>()
            != previous_node_names;
        if node_names_changed {
            paths::write_json("nodes.json", &nodes)?;
        }
        let profile_path = data_dir.join("generated-profile.yaml");
        let yaml = crate::policy::generate_profile(&nodes, &sources, &policy, &settings)?;
        let selected_info = sources
            .iter()
            .find(|source| source.id == settings.profile_traffic_source_id)
            .and_then(|source| source.subscription_info.as_ref());
        let metadata = serde_json::json!({
            "name": settings.profile_name,
            "subscriptionInfo": selected_info,
        });
        let metadata_bytes = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        let metadata_path = data_dir.join("profile-metadata.json");
        let profile_unchanged = std::fs::read(&profile_path)
            .ok()
            .is_some_and(|previous| previous == yaml.as_bytes())
            && std::fs::read(&metadata_path)
                .ok()
                .is_some_and(|previous| previous.as_slice() == metadata_bytes.as_slice());
        let request_time_path = data_dir.join("profile-last-requested-at.txt");
        let request_time_marker_exists = request_time_path.exists();
        let stored_request_time = std::fs::read_to_string(&request_time_path)
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or_default();
        let previous_request_time = normalize_profile_timestamp(stored_request_time);
        let generated_time_path = data_dir.join("profile-last-generated-at.txt");
        let stored_generated_time = std::fs::read_to_string(&generated_time_path)
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or_default();
        let previous_generated_time = normalize_profile_timestamp(stored_generated_time);
        let generated_at = if profile_unchanged && previous_generated_time > 0 {
            previous_generated_time
        } else if profile_unchanged && previous_request_time > 0 {
            previous_request_time
        } else {
            chrono::Utc::now()
                .timestamp_millis()
                .max(previous_request_time.saturating_add(1))
        };
        paths::write_atomic(&profile_path, yaml.as_bytes())?;
        paths::write_atomic(&metadata_path, &metadata_bytes)?;
        paths::write_atomic(&generated_time_path, generated_at.to_string().as_bytes())?;
        if stored_request_time > 0 && stored_request_time != previous_request_time {
            paths::write_atomic(
                &request_time_path,
                previous_request_time.to_string().as_bytes(),
            )?;
        }
        if stored_generated_time > 0 && stored_generated_time != previous_generated_time {
            paths::write_atomic(
                &generated_time_path,
                previous_generated_time.to_string().as_bytes(),
            )?;
        }
        let token_path = data_dir.join("profile-token.txt");
        let token = std::fs::read_to_string(&token_path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                let value = Uuid::new_v4().to_string();
                let _ = std::fs::write(&token_path, &value);
                value
            });
        let profile_last_requested_at = Arc::new(AtomicI64::new(previous_request_time));
        let profile_last_generated_at = Arc::new(AtomicI64::new(generated_at));
        let profile_legacy_needs_update = Arc::new(AtomicBool::new(
            request_time_marker_exists && previous_request_time <= 0,
        ));
        let profile_sync_subscriptions = Arc::new(AtomicBool::new(
            settings.sync_subscriptions_on_profile_refresh,
        ));
        let profile_refresh = crate::server::ProfileRefreshSignal::new();
        let port = crate::server::start(
            profile_path,
            settings.profile_port,
            token.clone(),
            Arc::clone(&profile_last_requested_at),
            Arc::clone(&profile_legacy_needs_update),
            Arc::clone(&profile_sync_subscriptions),
            Arc::clone(&profile_refresh),
        )?;
        let mut settings = settings;
        settings.profile_port = port;
        let _ = paths::write_json("settings.json", &settings);
        Ok(Arc::new(Self {
            source_sync_lock: tokio::sync::Mutex::new(()),
            source_sync_cancel_requests: Mutex::new(HashMap::new()),
            source_sync_progress: Mutex::new(HashMap::new()),
            traffic_history_lock: Mutex::new(()),
            traffic_history_generation: AtomicU64::new(0),
            sources: RwLock::new(sources),
            nodes: RwLock::new(nodes),
            policy: RwLock::new(policy),
            policy_library: RwLock::new(policy_library),
            rule_set_library: RwLock::new(rule_set_library),
            settings: RwLock::new(settings),
            sync_status: Mutex::new("尚未同步订阅".into()),
            last_sync: Mutex::new(String::new()),
            last_traffic_status: Mutex::new("等待连接 Mihomo".into()),
            profile_url: format!("http://127.0.0.1:{port}/profile/{token}.yaml"),
            profile_last_requested_at,
            profile_last_generated_at,
            profile_legacy_needs_update,
            profile_sync_subscriptions,
            profile_refresh,
            data_dir: data_dir.to_string_lossy().to_string(),
        }))
    }

    pub fn save_sources(&self) -> Result<(), String> {
        let sources = self.sources.read().map_err(|_| "订阅数据锁定失败")?;
        paths::write_json("sources.json", &*sources)
    }

    pub fn save_nodes(&self) -> Result<(), String> {
        let nodes = self.nodes.read().map_err(|_| "节点数据锁定失败")?;
        paths::write_json("nodes.json", &*nodes)
    }

    pub fn save_policy(&self) -> Result<(), String> {
        let policy = self.policy.read().map_err(|_| "策略配置锁定失败")?;
        paths::write_json("policy.json", &*policy)
    }

    pub fn save_settings(&self) -> Result<(), String> {
        let settings = self.settings.read().map_err(|_| "应用设置锁定失败")?;
        paths::write_json("settings.json", &*settings)
    }

    pub fn regenerate_profile(&self) -> Result<(), String> {
        let sources = self.sources.read().map_err(|_| "订阅数据锁定失败")?.clone();
        let nodes = self.nodes.read().map_err(|_| "节点数据锁定失败")?;
        let policy = self.policy.read().map_err(|_| "策略配置锁定失败")?;
        let settings = self.settings.read().map_err(|_| "应用设置锁定失败")?;
        let yaml = crate::policy::generate_profile(&nodes, &sources, &policy, &settings)?;
        let profile_path = paths::data_dir().join("generated-profile.yaml");
        let metadata_path = paths::data_dir().join("profile-metadata.json");
        let previous_profile = std::fs::read(&profile_path).ok();
        let previous_metadata = std::fs::read(&metadata_path).ok();
        let selected_info = sources
            .iter()
            .find(|source| source.id == settings.profile_traffic_source_id)
            .and_then(|source| source.subscription_info.as_ref());
        let metadata = serde_json::json!({
            "name": settings.profile_name,
            "subscriptionInfo": selected_info,
        });
        let metadata_bytes = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        let profile_changed = previous_profile.as_deref() != Some(yaml.as_bytes())
            || previous_metadata.as_deref() != Some(metadata_bytes.as_slice());
        paths::write_atomic(&profile_path, yaml.as_bytes())?;
        paths::write_atomic(&metadata_path, &metadata_bytes)?;
        if profile_changed {
            let generated_at = chrono::Utc::now().timestamp_millis().max(
                self.profile_last_requested_at
                    .load(Ordering::Relaxed)
                    .saturating_add(1),
            );
            self.profile_last_generated_at
                .store(generated_at, Ordering::Relaxed);
            paths::write_atomic(
                &paths::data_dir().join("profile-last-generated-at.txt"),
                generated_at.to_string().as_bytes(),
            )?;
        }
        Ok(())
    }
}

fn normalize_profile_timestamp(timestamp: i64) -> i64 {
    if timestamp > 0 && timestamp < 100_000_000_000 {
        timestamp.saturating_mul(1000)
    } else {
        timestamp
    }
}
