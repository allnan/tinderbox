use std::io::Read;

use chrono::Local;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::model::{PolicyConfig, PolicyLibrary, RuleSetItem, RuleSetLibrary, RuleSetPreview};

const MAX_RULE_SET_BYTES: usize = 8 * 1024 * 1024;

pub fn normalize_policy_library(
    policies: &mut PolicyLibrary,
    library: &mut RuleSetLibrary,
) -> bool {
    let before_policies = serde_json::to_value(&*policies).unwrap_or(Value::Null);
    let before_library = serde_json::to_value(&*library).unwrap_or(Value::Null);
    for item in &mut policies.items {
        normalize_policy_config(&mut item.config, library);
    }
    before_policies != serde_json::to_value(&*policies).unwrap_or(Value::Null)
        || before_library != serde_json::to_value(&*library).unwrap_or(Value::Null)
}

pub fn normalize_policy_config(policy: &mut PolicyConfig, library: &mut RuleSetLibrary) {
    let Some(providers) = policy.rule_providers.as_object().cloned() else {
        return;
    };
    if providers.is_empty() {
        return;
    }

    let mut id_map = std::collections::HashMap::new();
    let mut normalized = Map::new();
    for (old_id, provider) in providers {
        let identity = provider_identity(&provider);
        let existing = library
            .items
            .iter()
            .find(|item| item.id == old_id)
            .or_else(|| {
                library
                    .items
                    .iter()
                    .find(|item| provider_identity(&item.provider) == identity)
            })
            .map(|item| item.id.clone());
        let id = if let Some(id) = existing {
            id
        } else {
            let id = if library.items.iter().all(|item| item.id != old_id) {
                old_id.clone()
            } else {
                format!("ruleset-{}", uuid::Uuid::new_v4().simple())
            };
            let entry_count = provider
                .get("payload")
                .and_then(Value::as_array)
                .map(Vec::len);
            library.items.push(RuleSetItem {
                id: id.clone(),
                name: provider_name(&provider, &old_id),
                category: String::new(),
                provider: provider.clone(),
                description: String::new(),
                remote_entries: provider_sample_all(&provider),
                local_additions: Vec::new(),
                excluded_entries: Vec::new(),
                entry_count,
                sample: provider_sample(&provider),
                checked_at: String::new(),
                synced_at: String::new(),
                update_available: None,
                mrs_hash: String::new(),
                updated_at: Local::now().to_rfc3339(),
            });
            id
        };
        id_map.insert(old_id, id.clone());
        let canonical_provider = library
            .items
            .iter()
            .find(|item| item.id == id)
            .map(applied_provider)
            .unwrap_or(provider);
        normalized.insert(id, canonical_provider);
    }

    for rule in &mut policy.rules {
        if rule.kind.trim().eq_ignore_ascii_case("RULE-SET") {
            if let Some(id) = id_map.get(&rule.value) {
                rule.value = id.clone();
            }
        }
    }
    policy.rule_providers = Value::Object(normalized);
}

fn provider_identity(provider: &Value) -> String {
    let provider_type = provider
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("http")
        .to_ascii_lowercase();
    let identity = if provider_type == "inline" {
        json!({
            "type": provider_type,
            "behavior": provider.get("behavior").cloned().unwrap_or(json!("classical")),
            "payload": provider.get("payload").cloned().unwrap_or(Value::Null),
        })
    } else {
        json!({
            "type": provider_type,
            "url": provider.get("url").and_then(Value::as_str).unwrap_or("").trim(),
            "behavior": provider.get("behavior").cloned().unwrap_or(json!("classical")),
            "format": provider.get("format").cloned().unwrap_or(json!("yaml")),
            "header": provider.get("header").cloned().unwrap_or(Value::Null),
        })
    };
    serde_json::to_string(&identity).unwrap_or_default()
}

fn provider_sample(provider: &Value) -> Vec<String> {
    provider
        .get("payload")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(5)
        .map(str::to_string)
        .collect()
}

fn provider_sample_all(provider: &Value) -> Vec<String> {
    provider
        .get("payload")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub fn effective_entries(item: &RuleSetItem) -> Vec<String> {
    let Some(source_entries) = item
        .provider
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| *kind == "http")
        .map(|_| item.remote_entries.as_slice())
    else {
        return item
            .provider
            .get("payload")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    };
    let excluded = item
        .excluded_entries
        .iter()
        .map(|entry| normalized_entry(entry))
        .collect::<std::collections::HashSet<_>>();
    let mut seen = std::collections::HashSet::new();
    source_entries
        .iter()
        .filter(|entry| !excluded.contains(&normalized_entry(entry)))
        .chain(item.local_additions.iter())
        .filter(|entry| seen.insert(normalized_entry(entry)))
        .cloned()
        .collect()
}

pub fn applied_provider(item: &RuleSetItem) -> Value {
    if item.provider.get("type").and_then(Value::as_str) != Some("http")
        || (item.local_additions.is_empty() && item.excluded_entries.is_empty())
        || item.remote_entries.is_empty()
    {
        return item.provider.clone();
    }
    json!({
        "type": "inline",
        "behavior": item.provider.get("behavior").and_then(Value::as_str).unwrap_or("classical"),
        "payload": effective_entries(item),
    })
}

fn normalized_entry(entry: &str) -> String {
    entry
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn provider_name(provider: &Value, id: &str) -> String {
    let filename = provider
        .get("url")
        .and_then(Value::as_str)
        .and_then(|url| Url::parse(url).ok())
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty());
    let value = filename.unwrap_or_else(|| id.to_string());
    let stem = value
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(&value);
    let mut name = String::new();
    let mut previous_lower = false;
    for character in stem.chars() {
        if character.is_ascii_uppercase() && previous_lower {
            name.push(' ');
        }
        if character == '-' || character == '_' {
            name.push(' ');
            previous_lower = false;
        } else {
            name.push(character);
            previous_lower = character.is_ascii_lowercase() || character.is_ascii_digit();
        }
    }
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        "规则集".into()
    } else if name.starts_with("acl rule ") {
        let number = name.trim_start_matches("acl rule ").parse::<usize>().ok();
        number
            .map(|number| format!("模板规则集 {}", number + 1))
            .unwrap_or(name)
    } else {
        name
    }
}

pub fn remote_changed(item: &RuleSetItem, preview: &RuleSetPreview) -> Option<bool> {
    if preview.format == "mrs" {
        return (!item.mrs_hash.is_empty()).then(|| item.mrs_hash != preview.mrs_hash);
    }
    (!item.remote_entries.is_empty()).then(|| {
        !item
            .remote_entries
            .iter()
            .map(|entry| entry.trim())
            .eq(preview.entries.iter().map(|entry| entry.trim()))
    })
}

pub async fn preview_remote(
    client: &reqwest::Client,
    url: &str,
    behavior: &str,
    format: &str,
) -> Result<RuleSetPreview, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "请输入有效的 HTTP 或 HTTPS 规则集地址。")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("规则集地址必须使用 HTTP 或 HTTPS。".into());
    }
    if !matches!(behavior, "auto" | "classical" | "domain" | "ipcidr") {
        return Err("请选择有效的规则内容类型。".into());
    }
    if !matches!(format, "auto" | "text" | "yaml" | "yml" | "mrs") {
        return Err("请选择有效的规则集格式。".into());
    }

    let mut response = client.get(parsed.as_str()).send().await.map_err(|error| {
        if error.is_timeout() {
            "下载超时，请检查网络或订阅刷新代理。".to_string()
        } else {
            format!("下载规则集失败：{}", error.without_url())
        }
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "规则集地址返回 HTTP {}。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RULE_SET_BYTES as u64)
    {
        return Err("规则集超过 8 MiB，暂不支持预览。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "无法读取规则集下载内容。".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_RULE_SET_BYTES {
            return Err("规则集超过 8 MiB，无法读取。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&bytes).ok();
    let mrs_behavior = zstd::stream::read::Decoder::new(&bytes[..])
        .ok()
        .and_then(|mut decoder| {
            let mut header = [0_u8; 5];
            decoder.read_exact(&mut header).ok()?;
            if &header[..4] != b"MRS\x01" {
                return None;
            }
            match header[4] {
                0 => Some("domain"),
                1 => Some("ipcidr"),
                2 => Some("classical"),
                _ => None,
            }
        });
    let is_mrs = mrs_behavior.is_some();
    let extension = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .and_then(|filename| {
            filename
                .rsplit_once('.')
                .map(|(_, extension)| extension.to_ascii_lowercase())
        });
    let detected_format = if format == "auto" {
        if is_mrs {
            "mrs"
        } else if extension.as_deref() == Some("mrs") {
            return Err("文件扩展名是 MRS，但内容头无法识别为有效的 Mihomo MRS 规则集。".into());
        } else if text.is_none() {
            return Err("下载内容不是有效的文本规则文件，也不是可识别的 MRS 规则集。".into());
        } else if matches!(extension.as_deref(), Some("yaml" | "yml"))
            || text.as_deref().is_some_and(looks_like_yaml_rules)
        {
            "yaml"
        } else {
            "text"
        }
    } else if format == "yml" {
        "yaml"
    } else {
        format
    };
    if detected_format == "mrs" {
        let detected_behavior = mrs_behavior.ok_or_else(|| {
            "此地址未返回有效的 Mihomo MRS 规则文件；请检查链接或手动选择正确格式。".to_string()
        })?;
        let selected_behavior = if behavior == "auto" {
            detected_behavior
        } else {
            behavior
        };
        if selected_behavior != detected_behavior {
            return Err(format!("MRS 文件头标记的内容类型是 {detected_behavior}，与当前选择的 {selected_behavior} 不一致。"));
        }
        return Ok(RuleSetPreview {
            entry_count: None,
            sample: Vec::new(),
            summary: format!(
                "已识别为 MRS（二进制 {} 规则集），下载 {} KiB；规则条目无法逐条预览。",
                detected_behavior,
                bytes.len().div_ceil(1024)
            ),
            behavior: detected_behavior.into(),
            format: detected_format.into(),
            entries: Vec::new(),
            downloaded_at: Local::now().to_rfc3339(),
            mrs_hash: format!("{:x}", Sha256::digest(&bytes)),
        });
    }

    let text = text.ok_or_else(|| {
        "内容不是可识别的 UTF-8 规则文件。请检查来源地址或手动选择正确格式。".to_string()
    })?;
    let text = text.trim_start_matches('\u{feff}');
    if text.trim_start().starts_with('<') {
        return Err("此地址返回了网页内容，请检查规则文件地址。".into());
    }
    let entries = if detected_format == "yaml" {
        let yaml: Value = serde_yaml::from_str(text)
            .map_err(|_| "无法解析 YAML 规则集；请核对来源和文件格式。".to_string())?;
        let payload = yaml
            .get("payload")
            .or_else(|| yaml.get("rules"))
            .or_else(|| yaml.get("rules-list"))
            .unwrap_or(&yaml);
        payload
            .as_array()
            .ok_or_else(|| "YAML 中没有可识别的规则列表。".to_string())?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        text.lines()
            .map(|line| line.split('#').next().unwrap_or_default().trim())
            .filter(|line| !line.is_empty() && !line.starts_with(';'))
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    if entries.is_empty() {
        return Err("下载成功，但没有找到规则条目。".into());
    }
    let detected_behavior = if behavior == "auto" {
        infer_rule_behavior(&entries)
    } else {
        behavior
    };
    let sample = entries.iter().take(5).cloned().collect::<Vec<_>>();
    Ok(RuleSetPreview {
        entry_count: Some(entries.len()),
        sample,
        summary: format!("已读取 {} 条规则。", entries.len()),
        behavior: detected_behavior.into(),
        format: detected_format.into(),
        entries,
        downloaded_at: Local::now().to_rfc3339(),
        mrs_hash: String::new(),
    })
}

fn looks_like_yaml_rules(text: &str) -> bool {
    serde_yaml::from_str::<Value>(text)
        .ok()
        .is_some_and(|yaml| {
            yaml.get("payload")
                .or_else(|| yaml.get("rules"))
                .or_else(|| yaml.get("rules-list"))
                .and_then(Value::as_array)
                .is_some()
                || yaml
                    .as_array()
                    .is_some_and(|items| !items.is_empty() && items.iter().all(Value::is_string))
        })
}

fn infer_rule_behavior(entries: &[String]) -> &'static str {
    let mut saw_domain = false;
    let mut saw_ipcidr = false;
    for entry in entries {
        let value = entry.trim();
        if let Some((kind, _)) = value.split_once(',') {
            match kind.trim().to_ascii_uppercase().as_str() {
                "DOMAIN" | "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD" => saw_domain = true,
                "IP-CIDR" | "IP-CIDR6" => saw_ipcidr = true,
                _ => return "classical",
            }
        } else if looks_like_ip_cidr(value) {
            saw_ipcidr = true;
        } else if value.contains('.')
            && !value.contains('/')
            && !value.contains(char::is_whitespace)
        {
            saw_domain = true;
        } else {
            return "classical";
        }
        if saw_domain && saw_ipcidr {
            return "classical";
        }
    }
    if saw_domain {
        "domain"
    } else if saw_ipcidr {
        "ipcidr"
    } else {
        "classical"
    }
}

fn looks_like_ip_cidr(value: &str) -> bool {
    let Some((address, prefix)) = value.split_once('/') else {
        return false;
    };
    if !prefix.chars().all(|character| character.is_ascii_digit()) {
        return false;
    }
    if address.contains(':') {
        prefix.parse::<u8>().is_ok_and(|bits| bits <= 128)
            && address
                .chars()
                .all(|character| character.is_ascii_hexdigit() || character == ':')
    } else {
        let valid_address = address.split('.').count() == 4
            && address.split('.').all(|octet| {
                octet
                    .parse::<u8>()
                    .is_ok_and(|value| !octet.is_empty() && value.to_string() == octet)
            });
        valid_address && prefix.parse::<u8>().is_ok_and(|bits| bits <= 32)
    }
}
