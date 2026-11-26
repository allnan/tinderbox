use std::time::Duration;

use serde_json::{json, Value};

use crate::models::*;
use crate::rules::DraftEntry;
use crate::util::{clean_text, unique_strings};

const SYSTEM_PROMPT: &str = "你是一名表情包整理助手。用户会把待整理的表情包缩略图和文件名交给你。\n请为每个素材建议：一个主分类、0-3 个分组、2-5 个中文标签，并可选地把文件名改写得更易读。\n优先使用用户已有的分类和分组；只有确实没有合适选项时，才提出新的分类（最多 1 个）或新分组（最多 2 个），名称不超过 8 个字。\n标签要短（不超过 6 个字），描述情绪、用途或画面（例如：大笑、无语、猫、加班、动图）。\n文件名改写只做轻微清理，不要臆造无关内容；拿不准就留空。\n只输出 JSON，不要输出 Markdown 代码块或解释。JSON 结构：\n{\"items\":[{\"id\":\"素材 id\",\"category\":\"已有分类名或空字符串\",\"newCategory\":\"新分类名或空字符串\",\"groups\":[\"已有分组名\"],\"newGroups\":[\"新分组名\"],\"tags\":[\"标签\"],\"name\":\"建议文件名或空字符串\",\"confidence\":0.0,\"reason\":\"不超过 30 字的中文理由\"}]}";

pub fn presets() -> Vec<AiPreset> {
    [
        ("openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o-mini", true),
        (
            "qwen",
            "通义千问（兼容模式）",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "qwen-vl-max",
            true,
        ),
        ("zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4v-flash", true),
        (
            "deepseek",
            "DeepSeek（文本模型）",
            "https://api.deepseek.com/v1",
            "deepseek-chat",
            false,
        ),
        ("custom", "自定义 OpenAI 兼容服务", "", "", true),
    ]
    .iter()
    .map(|(id, label, base_url, model, vision)| AiPreset {
        id: id.to_string(),
        label: label.to_string(),
        base_url: base_url.to_string(),
        model: model.to_string(),
        vision: *vision,
    })
    .collect()
}

pub struct AiOutcome {
    pub content: String,
    pub model: String,
    pub usage: Value,
}

pub fn build_messages(
    categories: &[Category],
    groups: &[Group],
    items: &[(Sticker, String)],
    vision: bool,
) -> Value {
    let category_list = if categories.is_empty() {
        "（暂无）".to_string()
    } else {
        categories
            .iter()
            .map(|category| category.name.clone())
            .collect::<Vec<_>>()
            .join("、")
    };
    let group_list = if groups.is_empty() {
        "（暂无）".to_string()
    } else {
        groups.iter().map(|group| group.name.clone()).collect::<Vec<_>>().join("、")
    };
    let mut lines = vec![
        format!("请整理以下 {} 个表情包素材。", items.len()),
        format!("现有分类：{}", category_list),
        format!("现有分组：{}", group_list),
        "素材清单：".to_string(),
    ];
    for (index, (item, _)) in items.iter().enumerate() {
        let mut bits = vec![
            format!("{}. id={}", index + 1, item.id),
            format!("文件名={}", item.name),
            format!("尺寸={}x{}", item.width, item.height),
            format!("格式={}", item.ext),
        ];
        if item.category_id.is_some() {
            bits.push("已有分类".to_string());
        }
        if !item.tags.is_empty() {
            bits.push(format!("已有标签={}", item.tags.join("/")));
        }
        lines.push(bits.join("｜"));
    }
    lines.push("要求：只返回 items 数组，id 必须原样使用；没有把握的字段用空字符串或空数组。".to_string());
    let intro = lines.join("\n");

    let has_images = vision && items.iter().any(|(_, image)| !image.is_empty());
    if !has_images {
        return json!([
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": intro }
        ]);
    }
    let mut content: Vec<Value> = vec![json!({ "type": "text", "text": intro })];
    for (item, image) in items {
        if image.is_empty() {
            continue;
        }
        content.push(json!({ "type": "text", "text": format!("素材 id={} 的缩略图：", item.id) }));
        content.push(json!({ "type": "image_url", "image_url": { "url": image } }));
    }
    json!([
        { "role": "system", "content": SYSTEM_PROMPT },
        { "role": "user", "content": content }
    ])
}

fn normalize_base_url(base_url: &str) -> Result<String, AppError> {
    let value = base_url.trim().trim_end_matches('/').to_string();
    if !value.starts_with("http://") && !value.starts_with("https://") {
        return Err(AppError::new("invalid_config", "AI 服务地址必须以 http:// 或 https:// 开头"));
    }
    Ok(value)
}

fn http_error(status: u16, body: &str) -> AppError {
    let snippet: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet = snippet.chars().take(240).collect::<String>();
    match status {
        401 | 403 => AppError::new("ai_auth", format!("AI 服务鉴权失败，请检查 API Key（{}）", status)),
        429 => AppError::new("ai_rate_limit", "AI 服务限流或额度不足，请稍后再试"),
        _ => AppError::new(
            "ai_http",
            format!(
                "AI 服务返回错误 {}{}",
                status,
                if snippet.is_empty() {
                    String::new()
                } else {
                    format!("：{}", snippet)
                }
            ),
        ),
    }
}

async fn send_chat(
    settings: &Settings,
    messages: &Value,
    json_mode: bool,
) -> Result<(Value, u16, String), AppError> {
    let mut body = json!({
        "model": settings.ai.model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 2400,
    });
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(settings.ai.timeout_ms))
        .build()
        .map_err(|error| AppError::new("ai_client", format!("无法初始化网络客户端：{}", error)))?;
    let response = client
        .post(format!("{}/chat/completions", normalize_base_url(&settings.ai.base_url)?))
        .bearer_auth(&settings.ai.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                AppError::new(
                    "ai_timeout",
                    format!("AI 请求超时（{} 秒），请检查服务或调小批量", settings.ai.timeout_ms / 1000),
                )
            } else {
                AppError::new("ai_network", format!("AI 请求失败：{}", error))
            }
        })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Ok((Value::Null, status, text));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| AppError::new("ai_parse", "AI 服务返回的内容不是合法 JSON"))?;
    Ok((value, status, text))
}

pub async fn request_ai(
    settings: &Settings,
    categories: &[Category],
    groups: &[Group],
    items: &[(Sticker, String)],
) -> Result<AiOutcome, AppError> {
    if settings.ai.api_key.trim().is_empty() {
        return Err(AppError::new("ai_config", "还没有配置 AI API Key，请先在设置中填写"));
    }
    if settings.ai.model.trim().is_empty() {
        return Err(AppError::new("ai_config", "还没有配置 AI 模型名称"));
    }
    let messages = build_messages(categories, groups, items, settings.ai.vision);
    let mut outcome = send_chat(settings, &messages, true).await?;
    if outcome.1 == 400 {
        outcome = send_chat(settings, &messages, false).await?;
    }
    if !(200..300).contains(&outcome.1) {
        return Err(http_error(outcome.1, &outcome.2));
    }
    let payload = outcome.0;
    let message = payload
        .pointer("/choices/0/message")
        .ok_or_else(|| AppError::new("ai_parse", "AI 响应缺少 choices[0].message"))?;
    let content = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    if content.trim().is_empty() {
        return Err(AppError::new("ai_parse", "AI 返回了空内容"));
    }
    Ok(AiOutcome {
        content,
        model: payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(&settings.ai.model)
            .to_string(),
        usage: payload.get("usage").cloned().unwrap_or(Value::Null),
    })
}

pub async fn test_connection(settings: &Settings) -> Result<String, AppError> {
    if settings.ai.api_key.trim().is_empty() {
        return Err(AppError::new("ai_config", "请先填写 API Key"));
    }
    let messages = json!([
        { "role": "user", "content": "请只回复 OK" }
    ]);
    let mut fast = settings.clone();
    fast.ai.timeout_ms = settings.ai.timeout_ms.min(30_000);
    let outcome = send_chat(&fast, &messages, false).await?;
    if !(200..300).contains(&outcome.1) {
        return Err(http_error(outcome.1, &outcome.2));
    }
    let model = outcome
        .0
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&settings.ai.model)
        .to_string();
    Ok(format!("连接成功，模型 {} 已响应", model))
}

pub fn parse_ai_response(
    text: &str,
    items: &[Sticker],
    categories: &[Category],
    groups: &[Group],
) -> Result<Vec<DraftEntry>, AppError> {
    let value = extract_json(text)?;
    let list = if let Some(array) = value.as_array() {
        array.clone()
    } else if let Some(array) = value.get("items").and_then(Value::as_array) {
        array.clone()
    } else {
        return Err(AppError::new("ai_parse", "AI 返回的 JSON 缺少 items 数组"));
    };
    let mut seen: Vec<String> = Vec::new();
    let mut entries: Vec<DraftEntry> = Vec::new();
    for row in list {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(item) = items.iter().find(|item| item.id == id) else {
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let mut action = Action::default();
        let raw_category = clean_text(
            row.get("category").and_then(Value::as_str).unwrap_or(""),
            24,
        );
        let raw_new = clean_text(
            row.get("newCategory").and_then(Value::as_str).unwrap_or(""),
            24,
        );
        if !raw_category.is_empty() {
            if let Some(existing) = category_match(categories, &raw_category) {
                if Some(existing.id.clone()) != item.category_id {
                    action.category_id = Some(existing.id.clone());
                }
            } else {
                action.new_category_name = if raw_new.is_empty() { raw_category } else { raw_new };
            }
        } else if !raw_new.is_empty() {
            action.new_category_name = raw_new;
        }
        if !action.new_category_name.is_empty() {
            if let Some(existing) = category_match(categories, &action.new_category_name) {
                if Some(existing.id.clone()) != item.category_id {
                    action.category_id = Some(existing.id.clone());
                }
                action.new_category_name.clear();
            }
        }
        let mut group_names: Vec<String> = Vec::new();
        for key in ["groups", "newGroups"] {
            if let Some(array) = row.get(key).and_then(Value::as_array) {
                for value in array {
                    if let Some(name) = value.as_str() {
                        group_names.push(name.to_string());
                    }
                }
            }
        }
        let group_names = unique_strings(&group_names, 24, 4);
        for name in group_names {
            if let Some(existing) = group_match(groups, &name) {
                if !item.group_ids.contains(&existing.id) && !action.add_group_ids.contains(&existing.id)
                {
                    action.add_group_ids.push(existing.id.clone());
                }
            } else if action.new_group_names.len() < 2 {
                action.new_group_names.push(name);
            }
        }
        if let Some(array) = row.get("tags").and_then(Value::as_array) {
            let tags: Vec<String> = array
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.to_string())
                .collect();
            action.add_tags = unique_strings(&tags, 16, 4)
                .into_iter()
                .filter(|tag| {
                    !item
                        .tags
                        .iter()
                        .any(|existing| existing.to_lowercase() == tag.to_lowercase())
                })
                .collect();
        }
        let suggested_name = clean_text(
            row.get("name").and_then(Value::as_str).unwrap_or(""),
            30,
        );
        if !suggested_name.is_empty() && suggested_name != item.name {
            action.name = suggested_name;
        }
        let confidence = row
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        entries.push(DraftEntry {
            item_id: id,
            action,
            reason: clean_text(row.get("reason").and_then(Value::as_str).unwrap_or(""), 60),
            confidence,
            source: "ai".to_string(),
        });
    }
    Ok(entries)
}

fn category_match<'a>(categories: &'a [Category], name: &str) -> Option<&'a Category> {
    let needle = name.trim().to_lowercase();
    categories
        .iter()
        .find(|category| category.name.to_lowercase() == needle)
}

fn group_match<'a>(groups: &'a [Group], name: &str) -> Option<&'a Group> {
    let needle = name.trim().to_lowercase();
    groups.iter().find(|group| group.name.to_lowercase() == needle)
}

fn extract_json(text: &str) -> Result<Value, AppError> {
    let raw = text
        .trim()
        .trim_start_matches(['\u{feff}', '\u{60}'])
        .trim_start_matches("json")
        .trim_end_matches('\u{60}')
        .trim();
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return Ok(value);
    }
    if let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}')) {
        if end > start {
            if let Ok(value) = serde_json::from_str::<Value>(&raw[start..=end]) {
                return Ok(value);
            }
        }
    }
    if let (Some(start), Some(end)) = (raw.find('['), raw.rfind(']')) {
        if end > start {
            if let Ok(value) = serde_json::from_str::<Value>(&raw[start..=end]) {
                return Ok(value);
            }
        }
    }
    Err(AppError::new(
        "ai_parse",
        "AI 返回的内容无法解析为 JSON，请检查模型是否支持 JSON 输出",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::default_categories;

    fn sticker(id: &str, name: &str) -> Sticker {
        let mut item = Sticker::default();
        item.id = id.to_string();
        item.name = name.to_string();
        item.sha256 = "a".repeat(64);
        item
    }

    #[test]
    fn parses_known_category_and_new_group() {
        let categories = default_categories();
        let groups = vec![Group {
            id: "grp_1".to_string(),
            name: "斗图".to_string(),
            ..Group::default()
        }];
        let items = vec![sticker("item_1", "猫猫头")];
        let text = r#"{"items":[{"id":"item_1","category":"可爱","groups":["斗图"],"newGroups":["猫猫"],"tags":["猫","可爱"],"name":"猫猫头 1","confidence":0.8,"reason":"画面是猫"}]}"#;
        let entries = parse_ai_response(text, &items, &categories, &groups).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action.category_id.as_deref(), Some("cat_cute"));
        assert!(entries[0].action.add_group_ids.contains(&"grp_1".to_string()));
        assert!(entries[0].action.new_group_names.contains(&"猫猫".to_string()));
        assert!(entries[0].action.add_tags.contains(&"猫".to_string()));
    }

    #[tokio::test]
    async fn talks_to_openai_compatible_service() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .ok();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(size) => {
                        buffer.extend_from_slice(&chunk[..size]);
                        if buffer.windows(2).any(|window| window == b"}}") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let request = String::from_utf8_lossy(&buffer).to_string();
            assert!(request.contains("/chat/completions"), "请求路径不正确");
            assert!(request.contains("Bearer test-key"), "请求未携带鉴权头");
            let content = r#"{"items":[{"id":"item_1","category":"可爱","tags":["猫"],"confidence":0.9,"reason":"mock 服务"}]}"#;
            let body = serde_json::json!({
                "model": "mock-vision",
                "choices": [{ "message": { "content": content } }],
                "usage": { "total_tokens": 10 }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write response");
        });

        let settings = Settings {
            ai: AiConfig {
                enabled: true,
                base_url: format!("http://127.0.0.1:{}/v1", port),
                model: "mock-vision".to_string(),
                api_key: "test-key".to_string(),
                vision: false,
                ..AiConfig::default()
            },
            ..Settings::default()
        };
        let categories = default_categories();
        let items = vec![(sticker("item_1", "大叫猫"), String::new())];
        let outcome = request_ai(&settings, &categories, &[], &items)
            .await
            .expect("AI 请求应当成功");
        assert!(outcome.content.contains("items"));
        assert_eq!(outcome.model, "mock-vision");
        let parsed = parse_ai_response(&outcome.content, &items.iter().map(|(item, _)| item.clone()).collect::<Vec<_>>(), &categories, &[])
            .expect("解析响应");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].action.category_id.as_deref(), Some("cat_cute"));
        handle.join().expect("mock server thread");
    }

    #[test]
    fn tolerates_code_fences() {
        let categories = default_categories();
        let items = vec![sticker("item_1", "x")];
        let fence = "\u{60}\u{60}\u{60}";
        let text = format!("{}json\n{{\"items\":[{{\"id\":\"item_1\",\"newCategory\":\"测试\",\"tags\":[]}}]}}\n{}", fence, fence);
        let entries = parse_ai_response(&text, &items, &categories, &[]).unwrap();
        assert_eq!(entries[0].action.new_category_name, "测试");
    }
}
