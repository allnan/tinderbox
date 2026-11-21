use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use url::Url;

use crate::model::{
    dynamic_node_range_id, AppSettings, AutoGroupSettings, PolicyConfig, PolicyGroup, ProxyNode,
    Source, DYNAMIC_NODE_RANGE_PREFIX,
};

fn unique_push(items: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !items.iter().any(|item| item == &value) {
        items.push(value);
    }
}

fn has_known_country(node: &ProxyNode) -> bool {
    let country = node.country.trim();
    !country.is_empty() && country != "未识别"
}

fn is_route_label(value: &str) -> bool {
    let value = value.trim();
    if value == "全部节点" {
        return true;
    }
    if let Some(country) = value.strip_prefix("🌏 ") {
        return !country.trim().is_empty();
    }
    let mut chars = value.chars();
    let first = chars.next().map(|ch| ch as u32).unwrap_or_default();
    let second = chars.next().map(|ch| ch as u32).unwrap_or_default();
    let remainder = chars.as_str();
    (0x1f1e6..=0x1f1ff).contains(&first)
        && (0x1f1e6..=0x1f1ff).contains(&second)
        && remainder.starts_with(' ')
        && !remainder.trim().is_empty()
}

fn is_stale_generated_group_name(
    name: &str,
    sources: &[Source],
    auto_group_name_parts: &[String],
) -> bool {
    if name.starts_with("🌏 ") || (name.starts_with("📦 ") && name.ends_with(" · 全部节点"))
    {
        return true;
    }
    let separators = [
        ("separator:dot", " · "),
        ("separator:dash", " — "),
        ("separator:slash", " / "),
        ("separator:underscore", "_"),
        ("separator:space", " "),
    ];
    let provider_first = auto_group_name_parts
        .first()
        .is_some_and(|part| part == "provider");
    let route_first = auto_group_name_parts
        .first()
        .is_some_and(|part| part == "route");
    for source in sources {
        let provider = source.name.trim();
        if provider.is_empty() {
            continue;
        }
        for (token, separator) in separators {
            if !auto_group_name_parts.iter().any(|part| part == token) {
                continue;
            }
            if provider_first {
                if let Some(route) = name
                    .strip_prefix(provider)
                    .and_then(|value| value.strip_prefix(separator))
                {
                    if is_route_label(route) {
                        return true;
                    }
                }
            }
            if route_first {
                if let Some(route) = name.strip_suffix(&format!("{separator}{provider}")) {
                    if is_route_label(route) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

struct GeneratedSourceGroup {
    id: String,
    name: String,
    provider: String,
    country: Option<String>,
    nodes: Vec<String>,
}

fn legacy_generated_group_matches(name: &str, group: &GeneratedSourceGroup) -> bool {
    let separators = [" · ", " — ", " / ", "_", " "];
    let route_labels = match &group.country {
        Some(country) => vec![
            country_label(country),
            format!("🌎 {country}"),
            format!("🌍 {country}"),
            format!("🌏 {country}"),
        ],
        None => vec!["📦 全部节点".to_string()],
    };
    let normalize = |value: &str| value.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = normalize(name);
    route_labels.iter().any(|route| {
        if name == normalize(route) {
            return true;
        }
        separators.iter().any(|separator| {
            name == normalize(&format!("{}{separator}{route}", group.provider))
                || name == normalize(&format!("{route}{separator}{}", group.provider))
        })
    })
}

fn legacy_generated_group_for_name<'a>(
    name: &str,
    generated_groups: &'a [GeneratedSourceGroup],
) -> Option<&'a GeneratedSourceGroup> {
    let mut matched = None;
    for group in generated_groups
        .iter()
        .filter(|group| legacy_generated_group_matches(name, group))
    {
        if matched.is_some_and(|previous: &GeneratedSourceGroup| previous.id != group.id) {
            return None;
        }
        matched = Some(group);
    }
    matched
}

fn country_label(country: &str) -> String {
    let value = country.trim().to_lowercase();
    let flag = match value.as_str() {
        "香港"
        | "香港特别行政区"
        | "hong kong"
        | "hongkong"
        | "hk"
        | "台湾"
        | "台灣"
        | "臺灣"
        | "taiwan"
        | "tw"
        | "中国"
        | "中国大陆"
        | "china"
        | "cn" => "🇨🇳",
        "日本" | "japan" | "jp" => "🇯🇵",
        "新加坡" | "singapore" | "sg" => "🇸🇬",
        "美国" | "united states" | "usa" | "us" => "🇺🇸",
        "英国" | "united kingdom" | "uk" => "🇬🇧",
        "韩国" | "south korea" | "kr" => "🇰🇷",
        "德国" | "germany" | "de" => "🇩🇪",
        "法国" | "france" | "fr" => "🇫🇷",
        "加拿大" | "canada" | "ca" => "🇨🇦",
        "澳大利亚" | "australia" | "au" => "🇦🇺",
        "荷兰" | "netherlands" | "nl" => "🇳🇱",
        "俄罗斯" | "russia" | "ru" => "🇷🇺",
        "泰国" | "thailand" | "th" => "🇹🇭",
        "越南" | "vietnam" | "vn" => "🇻🇳",
        "马来西亚" | "malaysia" | "my" => "🇲🇾",
        "菲律宾" | "philippines" | "ph" => "🇵🇭",
        "印度" | "india" | "in" => "🇮🇳",
        "瑞士" | "switzerland" | "ch" => "🇨🇭",
        "土耳其" | "turkey" | "tr" => "🇹🇷",
        "巴西" | "brazil" | "br" => "🇧🇷",
        _ => "🌏",
    };
    format!("{flag} {country}")
}

fn format_auto_group_name(parts: &[String], provider: &str, route: &str) -> String {
    let mut name = String::new();
    for part in parts {
        match part.as_str() {
            "provider" => name.push_str(provider),
            "route" => name.push_str(route),
            "separator:dot" if !name.is_empty() => name.push_str(" · "),
            "separator:dash" if !name.is_empty() => name.push_str(" — "),
            "separator:slash" if !name.is_empty() => name.push_str(" / "),
            "separator:underscore" if !name.is_empty() => name.push('_'),
            "separator:space" if !name.is_empty() => name.push(' '),
            _ => {}
        }
    }
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn generated_source_groups(
    nodes: &[ProxyNode],
    sources: &[Source],
    auto_group_name_parts: &[String],
) -> Vec<GeneratedSourceGroup> {
    let mut by_source: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut source_indexes = HashMap::new();
    let mut by_country: Vec<(String, String, String, Vec<String>)> = Vec::new();
    let mut country_indexes = HashMap::new();
    for node in nodes {
        let source_index = *source_indexes
            .entry(node.source_id.clone())
            .or_insert_with(|| {
                by_source.push((node.source_id.clone(), node.source_name.clone(), Vec::new()));
                by_source.len() - 1
            });
        by_source[source_index].2.push(node.display_name.clone());
        if has_known_country(node) {
            let key = (node.source_id.clone(), node.country.clone());
            let country_index = *country_indexes.entry(key).or_insert_with(|| {
                by_country.push((
                    node.source_id.clone(),
                    node.source_name.clone(),
                    node.country.clone(),
                    Vec::new(),
                ));
                by_country.len() - 1
            });
            by_country[country_index].3.push(node.display_name.clone());
        }
    }
    let mut ordered_source_ids = sources
        .iter()
        .map(|source| source.id.clone())
        .filter(|source_id| source_indexes.contains_key(source_id))
        .collect::<Vec<_>>();
    for (source_id, _, _) in &by_source {
        if !ordered_source_ids.iter().any(|item| item == source_id) {
            ordered_source_ids.push(source_id.clone());
        }
    }
    let mut groups = Vec::new();
    for source_id in ordered_source_ids {
        let Some((_, source, names)) = by_source.iter().find(|(id, _, _)| id == &source_id) else {
            continue;
        };
        groups.push(GeneratedSourceGroup {
            id: format!("auto:provider:{source_id}"),
            name: format_auto_group_name(auto_group_name_parts, source, "全部节点"),
            provider: source.clone(),
            country: None,
            nodes: names.clone(),
        });
        for (country_source_id, country_source, country, names) in &by_country {
            if country_source_id == &source_id {
                groups.push(GeneratedSourceGroup {
                    id: format!("auto:country:{source_id}\0{country}"),
                    name: format_auto_group_name(
                        auto_group_name_parts,
                        country_source,
                        &country_label(country),
                    ),
                    provider: country_source.clone(),
                    country: Some(country.clone()),
                    nodes: names.clone(),
                });
            }
        }
    }
    groups
}

pub fn generated_group_name_map(
    nodes: &[ProxyNode],
    sources: &[Source],
    auto_group_name_parts: &[String],
) -> HashMap<String, String> {
    generated_source_groups(nodes, sources, auto_group_name_parts)
        .into_iter()
        .map(|group| (group.id, group.name))
        .collect()
}

fn generated_group_value(
    group: &GeneratedSourceGroup,
    settings: Option<&AutoGroupSettings>,
) -> Value {
    let settings = settings.cloned().unwrap_or_default();
    let kind = match settings.kind.trim().to_ascii_lowercase().as_str() {
        "url-test" => "url-test",
        "fallback" => "fallback",
        "load-balance" => "load-balance",
        _ => "select",
    };
    let mut value = json!({
        "name": group.name,
        "type": kind,
        "proxies": group.nodes,
    });
    if kind == "select" {
        if let Some(default_selected) = settings
            .default_selected
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            value["default-selected"] = json!(default_selected);
        }
    }
    if matches!(kind, "url-test" | "fallback" | "load-balance") {
        if !settings.url.trim().is_empty() {
            value["url"] = json!(settings.url);
        }
        if settings.interval > 0 {
            value["interval"] = json!(settings.interval);
        }
    }
    value
}

fn matches_group(group: &PolicyGroup, node: &ProxyNode) -> bool {
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

fn imported_node_name(name: &str, nodes: &[ProxyNode]) -> Vec<String> {
    let matching_nodes = nodes
        .iter()
        .filter(|node| node.original_name == name || node.display_name == name)
        .collect::<Vec<_>>();
    if matching_nodes.is_empty() {
        vec![name.to_string()]
    } else {
        matching_nodes
            .into_iter()
            .map(|node| node.display_name.clone())
            .collect()
    }
}

fn group_value(
    group: &PolicyGroup,
    nodes: &[ProxyNode],
    group_names: &HashSet<String>,
    generated_groups: &[GeneratedSourceGroup],
    sources: &[Source],
    auto_group_name_parts: &[String],
) -> Value {
    let mut proxies = Vec::new();
    if !group.all_nodes {
        for node in nodes.iter().filter(|node| matches_group(group, node)) {
            unique_push(&mut proxies, node.display_name.clone());
        }
    }
    for node_id in &group.include_node_ids {
        if let Some(node) = nodes.iter().find(|node| {
            node.id == *node_id && !group.exclude_node_ids.iter().any(|id| id == &node.id)
        }) {
            unique_push(&mut proxies, node.display_name.clone());
        }
    }
    for name in &group.group_names {
        if name.starts_with(DYNAMIC_NODE_RANGE_PREFIX) {
            if let Some(range_id) = dynamic_node_range_id(name) {
                if let Some(generated_group) =
                    generated_groups.iter().find(|item| item.id == range_id)
                {
                    for node_name in &generated_group.nodes {
                        unique_push(&mut proxies, node_name.clone());
                    }
                }
            }
            continue;
        }
        if group_names.contains(name)
            || matches!(
                name.as_str(),
                "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "PASS-RULE"
            )
        {
            unique_push(&mut proxies, name.clone());
        } else if let Some(generated_group) =
            legacy_generated_group_for_name(name, generated_groups)
        {
            unique_push(&mut proxies, generated_group.name.clone());
        } else if !is_stale_generated_group_name(name, sources, auto_group_name_parts) {
            for resolved in imported_node_name(name, nodes) {
                unique_push(&mut proxies, resolved);
            }
        }
    }
    if proxies.is_empty() && !group.all_nodes {
        proxies.push("DIRECT".into());
    }

    let mut item = group.options.as_object().cloned().unwrap_or_default();
    let default_selected = item
        .remove("default-selected")
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| {
            legacy_generated_group_for_name(&value, generated_groups)
                .map(|generated_group| generated_group.name.clone())
                .unwrap_or(value)
        });
    if group.all_nodes {
        let existing = item
            .get("exclude-filter")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let mut patterns = if existing.is_empty() {
            Vec::new()
        } else {
            existing
                .split("```")
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        let excluded_names = nodes
            .iter()
            .filter(|node| group.exclude_node_ids.iter().any(|id| id == &node.id))
            .map(|node| escape_regex(&node.display_name))
            .collect::<Vec<_>>();
        if !excluded_names.is_empty() {
            patterns.push(format!("^({})$", excluded_names.join("|")));
        }
        let exclude_filter = patterns.join("```");
        item.insert("exclude-filter".into(), json!(exclude_filter));
    }
    item.insert("name".into(), json!(group.name));
    item.insert("type".into(), json!(group.kind));
    item.insert("proxies".into(), json!(proxies));
    item.insert("include-all".into(), json!(group.all_nodes));
    if group.kind.trim().eq_ignore_ascii_case("select") {
        if let Some(default_selected) = default_selected {
            item.insert("default-selected".into(), json!(default_selected));
        }
    }
    let supports_health_check = matches!(
        group.kind.to_ascii_lowercase().as_str(),
        "url-test" | "fallback" | "load-balance"
    );
    if !supports_health_check || group.url.is_empty() {
        item.remove("url");
    } else {
        item.insert("url".into(), json!(group.url));
    }
    if group.filter.is_empty() || !group.all_nodes {
        item.remove("filter");
    } else {
        item.insert("filter".into(), json!(group.filter));
    }
    if !supports_health_check || group.interval == 0 {
        item.remove("interval");
    } else {
        item.insert("interval".into(), json!(group.interval));
    }
    Value::Object(item)
}

fn escape_regex(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if ".+*?^$()[]{}|\\".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn controller_address(value: &str) -> Result<String, String> {
    let parsed =
        Url::parse(value.trim()).map_err(|_| "Mihomo 控制器地址必须是有效的 HTTP 或 HTTPS 地址")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Mihomo 控制器地址只填写协议、主机和端口，例如 http://127.0.0.1:9090".into());
    }
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "控制器地址缺少有效端口".to_string())?;
    Ok(format!("{host}:{port}"))
}

pub fn generate_profile(
    nodes: &[ProxyNode],
    sources: &[Source],
    policy: &PolicyConfig,
    settings: &AppSettings,
) -> Result<String, String> {
    let mut proxy_values = Vec::new();
    let mut seen_names = HashSet::new();
    for node in nodes {
        if seen_names.insert(node.display_name.clone()) {
            proxy_values.push(node.config.clone());
        }
    }
    let groups = generated_source_groups(nodes, sources, &settings.auto_group_name_parts);
    let mut known_groups = policy
        .groups
        .iter()
        .map(|group| group.name.clone())
        .collect::<HashSet<_>>();
    known_groups.extend(groups.iter().map(|group| group.name.clone()));
    let mut output_groups = policy
        .groups
        .iter()
        .map(|group| {
            group_value(
                group,
                nodes,
                &known_groups,
                &groups,
                sources,
                &settings.auto_group_name_parts,
            )
        })
        .collect::<Vec<_>>();
    for group in &groups {
        output_groups.push(generated_group_value(
            group,
            policy.auto_group_settings.get(&group.id),
        ));
    }
    if output_groups.is_empty() {
        output_groups.push(json!({
            "name": "🌐 全部节点",
            "type": "select",
            "proxies": nodes.iter().map(|node| node.display_name.clone()).collect::<Vec<_>>()
        }));
    }

    let mut rules = Vec::new();
    for rule in &policy.rules {
        let line = if rule.kind.eq_ignore_ascii_case("MATCH") {
            format!("MATCH,{}", rule.target)
        } else if rule.value.trim().is_empty() {
            format!("{},{}", rule.kind, rule.target)
        } else {
            format!("{},{},{}", rule.kind, rule.value, rule.target)
        };
        rules.push(Value::String(line));
    }
    if rules.is_empty() {
        rules.push(json!("MATCH,DIRECT"));
    }

    let mut root = Map::new();
    root.insert("mixed-port".into(), json!(settings.mixed_port));
    root.insert("allow-lan".into(), json!(false));
    root.insert("mode".into(), json!("rule"));
    root.insert("log-level".into(), json!("info"));
    root.insert(
        "external-controller".into(),
        json!(controller_address(&settings.controller_url)?),
    );
    if !settings.controller_secret.is_empty() {
        root.insert("secret".into(), json!(settings.controller_secret));
    }
    root.insert("proxies".into(), Value::Array(proxy_values));
    root.insert("proxy-groups".into(), Value::Array(output_groups));
    root.insert("rules".into(), Value::Array(rules));
    if policy.rule_providers.is_object()
        && policy
            .rule_providers
            .as_object()
            .is_some_and(|map| !map.is_empty())
    {
        root.insert("rule-providers".into(), policy.rule_providers.clone());
    }
    serde_yaml::to_string(&Value::Object(root))
        .map_err(|error| format!("生成 Clash 配置失败：{error}"))
}
