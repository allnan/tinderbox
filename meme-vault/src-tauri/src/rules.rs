use crate::models::{Action, Category, Group, Sticker};
use crate::util::clean_text;

pub struct DraftEntry {
    pub item_id: String,
    pub action: Action,
    pub reason: String,
    pub confidence: f64,
    pub source: String,
}

struct KeywordRule {
    keywords: &'static [&'static str],
    category: &'static str,
    tags: &'static [&'static str],
}

const KEYWORD_RULES: &[KeywordRule] = &[
    KeywordRule {
        keywords: &["笑", "哈哈", "嘿嘿", "233", "lol", "xd", "happy", "joy", "乐"],
        category: "开心",
        tags: &["笑"],
    },
    KeywordRule {
        keywords: &["无语", "汗", "沉默", "尴尬", "麻木", "speechless", "sweat", "省略号"],
        category: "无语",
        tags: &["无语"],
    },
    KeywordRule {
        keywords: &["疑问", "疑惑", "问号", "what", "confus", "嗯?", "啊?"],
        category: "疑惑",
        tags: &["问号"],
    },
    KeywordRule {
        keywords: &["嘲讽", "鄙视", "白眼", "嫌弃", "阴阳", "狗头", "doge", "sneer"],
        category: "嘲讽",
        tags: &["阴阳"],
    },
    KeywordRule {
        keywords: &["可爱", "猫", "狗", "萌", "cute", "heart", "亲亲", "kiss", "抱抱", "love", "比心"],
        category: "可爱",
        tags: &["可爱"],
    },
    KeywordRule {
        keywords: &["工作", "加班", "开会", "老板", "ppt", "deadline", "摸鱼", "打工", "上班"],
        category: "工作",
        tags: &["打工"],
    },
    KeywordRule {
        keywords: &["晚安", "早安", "吃饭", "睡觉", "学校", "日常", "天气", "周末"],
        category: "日常",
        tags: &["日常"],
    },
];

const MAX_PHASH_ITEMS: usize = 600;
const SERIES_DISTANCE: u32 = 8;

pub fn hamming_hex(left: &str, right: &str) -> u32 {
    if left.len() != 16 || right.len() != 16 {
        return 64;
    }
    let mut distance = 0;
    for (a, b) in left.bytes().zip(right.bytes()) {
        let value = match (a.is_ascii_hexdigit(), b.is_ascii_hexdigit()) {
            (true, true) => (a as char).to_digit(16).unwrap_or(0) ^ (b as char).to_digit(16).unwrap_or(0),
            _ => 15,
        };
        distance += (value as u32).count_ones();
    }
    distance
}

pub fn prettify_name(raw: &str) -> String {
    let mut name = raw.trim().to_string();
    if name.is_empty() {
        return name;
    }
    if let Some(index) = name.rfind('.') {
        if name.len() - index <= 6 {
            name.truncate(index);
        }
    }
    name = name.replace(['_', '%', '+'], " ");
    name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    for suffix in ["副本", "copy", "Copy", "COPY"] {
        let trimmed = name.trim_end();
        if trimmed.ends_with(suffix) {
            name = trimmed.trim_end_matches(suffix).trim_end_matches(['-', ' ']).to_string();
        }
    }
    // 去掉结尾的 (1) / （2） 这类副本编号
    loop {
        let trimmed = name.trim_end();
        let chars: Vec<char> = trimmed.chars().collect();
        if chars.len() < 3 {
            break;
        }
        let last = chars.last().copied().unwrap_or(' ');
        if last != ')' && last != '）' {
            break;
        }
        let open = if last == ')' { '(' } else { '（' };
        let Some(position) = chars.iter().rposition(|ch| *ch == open) else {
            break;
        };
        let inside: String = chars[position + 1..chars.len() - 1].iter().collect();
        if inside.len() <= 4 && inside.chars().all(|ch| ch.is_ascii_digit()) {
            name = chars[..position].iter().collect::<String>();
            name = name.trim_end().to_string();
        } else {
            break;
        }
    }
    for prefix in ["wechat", "mmexport", "image", "img", "wx"] {
        let lower = name.to_lowercase();
        if lower.starts_with(prefix) {
            let rest = &name[prefix.len()..];
            if rest.starts_with([' ', '-', '_']) {
                name = rest.trim_start_matches([' ', '-', '_']).to_string();
                break;
            }
        }
    }
    // 去掉结尾的时间戳 / 纯数字编号
    let tokens: Vec<&str> = name.split_whitespace().collect();
    if tokens.len() > 1 {
        let last = tokens[tokens.len() - 1];
        let digits = last.chars().filter(|ch| ch.is_ascii_digit()).count();
        if digits >= 8 && digits == last.chars().count() {
            name = tokens[..tokens.len() - 1].join(" ");
        } else if digits >= 12 && last.contains(['-', '_']) {
            name = tokens[..tokens.len() - 1].join(" ");
        }
    }
    let cleaned = clean_text(&name, 40);
    if cleaned.is_empty() {
        raw.trim().chars().take(40).collect()
    } else {
        cleaned
    }
}

pub fn cluster_series(items: &[Sticker]) -> Vec<Vec<usize>> {
    let pool: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            item.phash.len() == 16 && item.phash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .map(|(index, _)| index)
        .take(MAX_PHASH_ITEMS)
        .collect();
    let mut parent: Vec<usize> = (0..pool.len()).collect();
    fn find(parent: &mut [usize], index: usize) -> usize {
        if parent[index] != index {
            let root = find(parent, parent[index]);
            parent[index] = root;
        }
        parent[index]
    }
    for left in 0..pool.len() {
        for right in (left + 1)..pool.len() {
            if hamming_hex(&items[pool[left]].phash, &items[pool[right]].phash) <= SERIES_DISTANCE {
                let root_left = find(&mut parent, left);
                let root_right = find(&mut parent, right);
                if root_left != root_right {
                    parent[root_left] = root_right;
                }
            }
        }
    }
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    for index in 0..pool.len() {
        let root = find(&mut parent, index);
        if let Some(slot) = groups.iter_mut().find(|(value, _)| *value == root) {
            slot.1.push(pool[index]);
        } else {
            groups.push((root, vec![pool[index]]));
        }
    }
    groups
        .into_iter()
        .map(|(_, members)| members)
        .filter(|members| members.len() >= 3)
        .collect()
}

fn common_prefix(names: &[String]) -> String {
    let cleaned: Vec<String> = names
        .iter()
        .map(|name| {
            prettify_name(name)
                .trim_end_matches(|ch: char| ch.is_ascii_digit() || ch.is_whitespace() || ch == '-' || ch == '_' || ch == '.')
                .trim()
                .to_string()
        })
        .filter(|name| name.chars().count() >= 2)
        .collect();
    if cleaned.len() < 2 {
        return String::new();
    }
    let first: Vec<char> = cleaned[0].chars().collect();
    let mut length = first.len();
    for other in cleaned.iter().skip(1) {
        let chars: Vec<char> = other.chars().collect();
        length = length.min(chars.len());
        let mut index = 0;
        while index < length && first[index] == chars[index] {
            index += 1;
        }
        length = index;
        if length == 0 {
            return String::new();
        }
    }
    first[..length].iter().collect::<String>().trim().to_string()
}

fn orientation_tag(item: &Sticker) -> &'static str {
    if item.width == 0 || item.height == 0 {
        return "方图";
    }
    let ratio = item.width as f64 / item.height as f64;
    if ratio >= 2.6 {
        "横长图"
    } else if ratio >= 1.45 {
        "横图"
    } else if ratio <= 0.38 {
        "竖长图"
    } else if ratio <= 0.7 {
        "竖图"
    } else {
        "方图"
    }
}

fn push_tag(tags: &mut Vec<String>, tag: &str) {
    let lower = tag.to_lowercase();
    if !tags.iter().any(|existing| existing.to_lowercase() == lower) {
        tags.push(tag.to_string());
    }
}

pub fn build_rule_entries(items: &[Sticker], categories: &[Category], groups: &[Group]) -> Vec<DraftEntry> {
    let visible: Vec<&Sticker> = items.iter().filter(|item| !item.deleted).collect();
    let series = cluster_series(items);
    let mut series_map: Vec<(usize, String, usize)> = Vec::new();
    for cluster in series {
        let names: Vec<String> = cluster.iter().map(|index| items[*index].name.clone()).collect();
        let prefix = common_prefix(&names);
        let label = if prefix.chars().count() >= 2 {
            format!("系列·{}", prefix.chars().take(16).collect::<String>())
        } else {
            "相似系列".to_string()
        };
        for index in cluster {
            series_map.push((index, label.clone(), names.len()));
        }
    }
    let mut new_group_names: Vec<String> = Vec::new();
    let mut entries: Vec<DraftEntry> = Vec::new();

    for item in visible {
        if entries.len() >= 200 {
            break;
        }
        let name_lower = item.name.to_lowercase();
        let mut tags: Vec<String> = Vec::new();
        let mut category_id: Option<String> = item.category_id.clone();
        let mut confidence = 0.3_f64;
        let mut reasons: Vec<String> = Vec::new();

        if category_id.is_none() {
            let by_name = categories
                .iter()
                .find(|category| !category.name.is_empty() && name_lower.contains(&category.name.to_lowercase()));
            let by_keyword = if by_name.is_none() {
                KEYWORD_RULES.iter().find(|rule| {
                    rule.keywords.iter().any(|keyword| name_lower.contains(keyword))
                        && categories
                            .iter()
                            .any(|category| category.name == rule.category)
                })
            } else {
                None
            };
            if let Some(category) = by_name {
                category_id = Some(category.id.clone());
                confidence = 0.72;
                reasons.push(format!("文件名含“{}”", category.name));
            } else if let Some(rule) = by_keyword {
                if let Some(category) = categories.iter().find(|category| category.name == rule.category) {
                    category_id = Some(category.id.clone());
                    confidence = 0.62;
                    if let Some(keyword) = rule.keywords.iter().find(|keyword| name_lower.contains(*keyword)) {
                        reasons.push(format!("识别到关键词“{}”", keyword));
                    }
                }
            }
            for rule in KEYWORD_RULES {
                if rule.keywords.iter().any(|keyword| name_lower.contains(keyword)) {
                    for tag in rule.tags {
                        push_tag(&mut tags, tag);
                    }
                }
            }
        }

        push_tag(&mut tags, orientation_tag(item));
        if item.ext == "gif" || item.ext == "webp" {
            push_tag(&mut tags, "动图");
        }
        if item.bytes > 1_572_864 {
            push_tag(&mut tags, "大图");
        }

        let item_index = items.iter().position(|row| row.id == item.id);
        let mut group_ids: Vec<String> = Vec::new();
        let mut pending_groups: Vec<String> = Vec::new();
        if let Some(index) = item_index {
            if let Some((_, label, size)) = series_map.iter().find(|(value, _, _)| *value == index) {
                if let Some(existing) = groups.iter().find(|group| group.name == *label) {
                    group_ids.push(existing.id.clone());
                } else if new_group_names.len() < 5 || new_group_names.contains(label) {
                    if !new_group_names.contains(label) {
                        new_group_names.push(label.clone());
                    }
                    pending_groups.push(label.clone());
                } else {
                    push_tag(&mut tags, "相似系列");
                }
                if !group_ids.is_empty() || pending_groups.iter().any(|name| name == label) {
                    confidence = confidence.max(0.56);
                    reasons.push(format!("与另外 {} 张画面相似", size.saturating_sub(1)));
                }
            }
        }

        let pretty = prettify_name(&item.name);
        let proposed_name = if !pretty.is_empty() && pretty != item.name {
            pretty
        } else {
            String::new()
        };
        let add_tags: Vec<String> = tags
            .into_iter()
            .filter(|tag| {
                !item
                    .tags
                    .iter()
                    .any(|existing| existing.to_lowercase() == tag.to_lowercase())
            })
            .take(6)
            .collect();
        let category_changed = category_id
            .as_ref()
            .map(|id| Some(id) != item.category_id.as_ref())
            .unwrap_or(false);
        let group_changed = group_ids.iter().any(|id| !item.group_ids.contains(id));
        let changes_something =
            category_changed || group_changed || !pending_groups.is_empty() || !add_tags.is_empty() || !proposed_name.is_empty();
        if !changes_something {
            continue;
        }
        if add_tags.len() >= 3 {
            confidence = (confidence + 0.1).min(0.9);
        }
        let reason = if reasons.is_empty() {
            "按文件名和画面特征整理".to_string()
        } else {
            reasons.join("；")
        };
        entries.push(DraftEntry {
            item_id: item.id.clone(),
            action: Action {
                category_id: if category_changed { category_id } else { None },
                new_category_name: String::new(),
                add_group_ids: group_ids,
                new_group_names: pending_groups,
                add_tags,
                name: proposed_name,
                favorite: None,
            },
            reason,
            confidence: (confidence * 100.0).round() / 100.0,
            source: "rules".to_string(),
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::default_categories;

    fn sticker(id: &str, name: &str, width: u32, height: u32, phash: &str) -> Sticker {
        let mut item = Sticker::default();
        item.id = id.to_string();
        item.sha256 = "a".repeat(64);
        item.name = name.to_string();
        item.width = width;
        item.height = height;
        item.phash = phash.to_string();
        item.ext = "png".to_string();
        item
    }

    #[test]
    fn hamming_distance_works() {
        assert_eq!(hamming_hex("0000000000000000", "0000000000000000"), 0);
        assert_eq!(hamming_hex("0000000000000000", "000000000000000f"), 4);
        assert_eq!(hamming_hex("ffffffffffffffff", "0000000000000000"), 64);
    }

    #[test]
    fn prettify_strips_noise() {
        assert_eq!(prettify_name("IMG_20230101_大笑猫"), "20230101 大笑猫");
        assert_eq!(prettify_name("doge_laugh(1)"), "doge laugh");
        assert_eq!(prettify_name("猫猫头-副本"), "猫猫头");
        assert_eq!(prettify_name("wechat_无语.png"), "无语");
    }

    #[test]
    fn rule_entry_matches_keyword_category() {
        let categories = default_categories();
        let groups: Vec<Group> = Vec::new();
        let items = vec![sticker("i1", "大笑猫", 512, 512, "0000000000000000")];
        let entries = build_rule_entries(&items, &categories, &groups);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action.category_id.as_deref(), Some("cat_happy"));
        assert!(entries[0].action.add_tags.contains(&"笑".to_string()));
        assert!(entries[0].action.add_tags.contains(&"方图".to_string()));
    }

    #[test]
    fn series_clusters_similar_images() {
        let groups: Vec<Group> = Vec::new();
        let categories = default_categories();
        let items = vec![
            sticker("i1", "猫猫头1", 300, 300, "0000000000000000"),
            sticker("i2", "猫猫头2", 300, 300, "0000000000000003"),
            sticker("i3", "猫猫头3", 300, 300, "000000000000000f"),
        ];
        let entries = build_rule_entries(&items, &categories, &groups);
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|entry| {
            entry.action.new_group_names.iter().any(|name| name.starts_with("系列·"))
        }));
    }
}
