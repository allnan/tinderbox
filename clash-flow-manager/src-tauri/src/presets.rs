use serde_json::{json, Map, Value};

use crate::model::{default_policy, PolicyConfig, PolicyGroup, PolicyRule};

const DEFAULT_INTERVAL: u64 = 86400;

fn safe_id(value: &str) -> String {
    let mut id = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while id.contains("--") {
        id = id.replace("--", "-");
    }
    id.trim_matches('-').to_string()
}

fn from_yaml(name: &str, url: &str, text: &str) -> Result<PolicyConfig, String> {
    let root: Value =
        serde_yaml::from_str(text).map_err(|error| format!("预设不是有效的 YAML：{error}"))?;
    let mut policy = PolicyConfig {
        template_name: name.to_string(),
        template_url: url.to_string(),
        template_content: text.to_string(),
        rule_providers: root
            .get("rule-providers")
            .cloned()
            .unwrap_or_else(|| json!({})),
        groups: Vec::new(),
        rules: Vec::new(),
        rule_group_order: Vec::new(),
        auto_group_settings: Default::default(),
    };
    if let Some(groups) = root.get("proxy-groups").and_then(Value::as_array) {
        for (index, item) in groups.iter().enumerate() {
            let Some(group_name) = item.get("name").and_then(Value::as_str) else {
                continue;
            };
            let mut members = Vec::new();
            if let Some(values) = item.get("proxies").and_then(Value::as_array) {
                for value in values.iter().filter_map(Value::as_str) {
                    if value != "DIRECT" && value != "REJECT" {
                        members.push(value.to_string());
                    }
                }
            }
            policy.groups.push(PolicyGroup {
                id: format!("preset-{}-{}", index, safe_id(group_name)),
                name: group_name.to_string(),
                kind: item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("select")
                    .to_string(),
                all_nodes: item
                    .get("include-all")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || item
                        .get("include-all-proxies")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    || item.get("filter").is_some(),
                source_ids: Vec::new(),
                countries: Vec::new(),
                node_ids: Vec::new(),
                include_node_ids: Vec::new(),
                exclude_node_ids: Vec::new(),
                group_names: members,
                filter: item
                    .get("filter")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                url: item
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                interval: item.get("interval").and_then(Value::as_u64).unwrap_or(0),
                options: item
                    .as_object()
                    .map(|item| {
                        let mut options = item.clone();
                        for key in ["name", "type", "proxies", "url", "interval", "filter"] {
                            options.remove(key);
                        }
                        Value::Object(options)
                    })
                    .unwrap_or_else(|| json!({})),
            });
        }
    }
    if let Some(rules) = root.get("rules").and_then(Value::as_array) {
        for value in rules.iter().filter_map(Value::as_str) {
            let parts = value.splitn(3, ',').collect::<Vec<_>>();
            if parts.len() == 3 {
                policy.rules.push(PolicyRule {
                    kind: parts[0].to_string(),
                    value: parts[1].to_string(),
                    target: parts[2].to_string(),
                });
            } else if parts.len() == 2 && parts[0] == "MATCH" {
                policy.rules.push(PolicyRule {
                    kind: parts[0].to_string(),
                    value: String::new(),
                    target: parts[1].to_string(),
                });
            }
        }
    }
    if policy.groups.is_empty() || policy.rules.is_empty() {
        let defaults = default_policy();
        if policy.groups.is_empty() {
            policy.groups = defaults.groups;
        }
        if policy.rules.is_empty() {
            policy.rules = defaults.rules;
        }
    }
    Ok(policy)
}

fn parse_acl_group(line: &str, index: usize) -> Option<PolicyGroup> {
    let (_, definition) = line.split_once('=')?;
    let fields = definition
        .split(char::from(96))
        .map(str::trim)
        .collect::<Vec<_>>();
    if fields.len() < 2 {
        return None;
    }
    let name = fields[0];
    let kind = match fields[1].to_lowercase().as_str() {
        "url-test" | "urltest" => "url-test",
        "fallback" => "fallback",
        "load-balance" | "loadbalance" => "load-balance",
        _ => "select",
    };
    let options = fields.iter().skip(2).copied().collect::<Vec<_>>();
    let mut members = Vec::new();
    let mut filters = Vec::new();
    let mut extras = Map::new();
    let mut include_all = false;
    let mut url = "https://www.gstatic.com/generate_204";
    let mut interval = 600;
    for option in &options {
        if let Some(value) = option.strip_prefix("[]") {
            if !value.is_empty() && value != "DIRECT" && value != "REJECT" {
                members.push(value.to_string());
            }
        } else if option.starts_with("http://") || option.starts_with("https://") {
            url = *option;
        } else if let Ok(value) = option.parse::<u64>() {
            interval = value;
        } else if let Some((key, value)) = option.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            if key == "include-all" || key == "include-all-proxies" {
                include_all |= value.eq_ignore_ascii_case("true");
                if key == "include-all-proxies" {
                    extras.insert(key, json!(value.eq_ignore_ascii_case("true")));
                }
            } else if matches!(
                key.as_str(),
                "exclude-filter"
                    | "exclude-type"
                    | "expected-status"
                    | "icon"
                    | "default-selected"
                    | "strategy"
            ) {
                extras.insert(key, json!(value));
            } else if matches!(key.as_str(), "lazy" | "hidden" | "disable-udp") {
                extras.insert(key, json!(value.eq_ignore_ascii_case("true")));
            } else if let Ok(number) = value.parse::<u64>() {
                if matches!(key.as_str(), "tolerance" | "timeout" | "max-failed-times") {
                    extras.insert(key, json!(number));
                }
            }
        } else if !option.is_empty() {
            filters.push(option.trim_matches('(').trim_matches(')').to_string());
        }
    }
    Some(PolicyGroup {
        id: format!("acl-{index}-{}", safe_id(name)),
        name: name.to_string(),
        kind: kind.to_string(),
        all_nodes: include_all || !filters.is_empty(),
        source_ids: Vec::new(),
        countries: Vec::new(),
        node_ids: Vec::new(),
        include_node_ids: Vec::new(),
        exclude_node_ids: Vec::new(),
        group_names: members,
        filter: filters.join("|"),
        url: if kind == "select" {
            String::new()
        } else {
            url.to_string()
        },
        interval: if kind == "select" { 0 } else { interval },
        options: Value::Object(extras),
    })
}

fn parse_acl_rule(
    line: &str,
    index: usize,
    providers: &mut Map<String, Value>,
) -> Option<PolicyRule> {
    let (_, definition) = line.split_once('=')?;
    let (target, expression) = definition.split_once(',')?;
    let expression = expression.trim();
    let remote_rule_url = if expression.starts_with("http://") || expression.starts_with("https://")
    {
        Some(expression.to_string())
    } else {
        expression
            .strip_prefix("rules/ACL4SSR/Clash/")
            .filter(|path| !path.split('/').any(|part| part == ".."))
            .map(|path| {
                format!("https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/{path}")
            })
    };
    if let Some(remote_rule_url) = remote_rule_url {
        let id = format!("acl-rule-{index}");
        providers.insert(
            id.clone(),
            json!({
                "type": "http",
                "behavior": "classical",
                "format": "text",
                "url": remote_rule_url,
                "path": format!("./ruleset/{id}.yaml"),
                "interval": DEFAULT_INTERVAL
            }),
        );
        return Some(PolicyRule {
            kind: "RULE-SET".into(),
            value: id,
            target: target.trim().to_string(),
        });
    }
    let value = expression.trim_start_matches("[]");
    let (kind, payload) = value.split_once(',').unwrap_or((value, ""));
    let kind = kind.to_uppercase();
    if matches!(
        kind.as_str(),
        "DOMAIN"
            | "DOMAIN-SUFFIX"
            | "DOMAIN-KEYWORD"
            | "DOMAIN-REGEX"
            | "IP-CIDR"
            | "IP-CIDR6"
            | "SRC-IP-CIDR"
            | "GEOIP"
            | "GEOSITE"
            | "PROCESS-NAME"
            | "PROCESS-PATH"
            | "DST-PORT"
            | "SRC-PORT"
            | "NETWORK"
            | "RULE-SET"
            | "MATCH"
            | "FINAL"
    ) {
        return Some(PolicyRule {
            kind: if kind == "FINAL" {
                "MATCH".into()
            } else {
                kind
            },
            value: payload.to_string(),
            target: target.trim().to_string(),
        });
    }
    None
}

fn from_acl4ssr(name: &str, url: &str, text: &str) -> Result<PolicyConfig, String> {
    let mut policy = PolicyConfig {
        template_name: name.to_string(),
        template_url: url.to_string(),
        template_content: text.to_string(),
        rule_providers: json!({}),
        groups: Vec::new(),
        rules: Vec::new(),
        rule_group_order: Vec::new(),
        auto_group_settings: Default::default(),
    };
    let mut provider_map = Map::new();
    let mut group_index = 0usize;
    let mut rule_index = 0usize;
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with(';') && !line.starts_with('#'))
    {
        if line.starts_with("custom_proxy_group=") {
            if let Some(group) = parse_acl_group(line, group_index) {
                policy.groups.push(group);
                group_index += 1;
            }
        } else if line.starts_with("ruleset=") {
            if let Some(rule) = parse_acl_rule(line, rule_index, &mut provider_map) {
                policy.rules.push(rule);
                rule_index += 1;
            }
        } else if let Some(content) = line.strip_prefix("rule=") {
            let parts = content.splitn(3, ',').collect::<Vec<_>>();
            if parts.len() == 3 {
                policy.rules.push(PolicyRule {
                    kind: parts[0].to_string(),
                    value: parts[1].to_string(),
                    target: parts[2].to_string(),
                });
            }
        }
    }
    policy.rule_providers = Value::Object(provider_map);
    if policy.groups.is_empty() || policy.rules.is_empty() {
        let defaults = default_policy();
        if policy.groups.is_empty() {
            policy.groups = defaults.groups;
        }
        if policy.rules.is_empty() {
            policy.rules = defaults.rules;
        }
    }
    Ok(policy)
}

pub fn parse_remote_preset(name: &str, url: &str, text: &str) -> Result<PolicyConfig, String> {
    if text.trim().starts_with("[custom]") || text.contains("custom_proxy_group=") {
        return from_acl4ssr(name, url, text);
    }
    from_yaml(name, url, text)
}
