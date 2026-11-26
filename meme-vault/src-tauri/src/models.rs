use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            conflicts: Vec::new(),
        }
    }

    pub fn with_conflicts(code: &str, message: impl Into<String>, conflicts: Vec<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            conflicts,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::new("io_error", format!("文件读写失败：{}", error))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError::new("json_error", format!("数据格式错误：{}", error))
    }
}

pub type ApiResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    pub order: i64,
    pub created_at: i64,
}

impl Default for Category {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: "#96a0a8".to_string(),
            order: 0,
            created_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub note: String,
    pub order: i64,
    pub created_at: i64,
}

impl Default for Group {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: "#8f9fd9".to_string(),
            note: String::new(),
            order: 0,
            created_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sticker {
    pub id: String,
    pub sha256: String,
    pub ext: String,
    pub mime: String,
    pub thumb_mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub phash: String,
    pub name: String,
    pub note: String,
    pub category_id: Option<String>,
    pub group_ids: Vec<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub status: String,
    pub deleted: bool,
    pub deleted_at: Option<i64>,
    pub imported_at: i64,
    pub created_at: i64,
    pub usage_count: u32,
    pub last_used_at: Option<i64>,
    pub origin: String,
    /// 整理说明（旧字段名为 aiNote，保留别名以兼容既有数据）。
    #[serde(alias = "aiNote")]
    pub organize_note: String,
}

impl Default for Sticker {
    fn default() -> Self {
        Self {
            id: String::new(),
            sha256: String::new(),
            ext: "png".to_string(),
            mime: "image/png".to_string(),
            thumb_mime: String::new(),
            width: 0,
            height: 0,
            bytes: 0,
            phash: String::new(),
            name: String::new(),
            note: String::new(),
            category_id: None,
            group_ids: Vec::new(),
            tags: Vec::new(),
            favorite: false,
            status: "inbox".to_string(),
            deleted: false,
            deleted_at: None,
            imported_at: 0,
            created_at: 0,
            usage_count: 0,
            last_used_at: None,
            origin: "import".to_string(),
            organize_note: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Action {
    pub category_id: Option<String>,
    pub new_category_name: String,
    pub add_group_ids: Vec<String>,
    pub new_group_names: Vec<String>,
    pub add_tags: Vec<String>,
    pub name: String,
    pub favorite: Option<bool>,
}

impl Default for Action {
    fn default() -> Self {
        Self {
            category_id: None,
            new_category_name: String::new(),
            add_group_ids: Vec::new(),
            new_group_names: Vec::new(),
            add_tags: Vec::new(),
            name: String::new(),
            favorite: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposalEntry {
    pub id: String,
    pub item_id: String,
    pub action: Action,
    pub reason: String,
    pub confidence: f64,
    pub skipped: bool,
    pub source: String,
    pub applied: bool,
    pub skip_reason: Option<String>,
}

impl Default for ProposalEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            item_id: String::new(),
            action: Action::default(),
            reason: String::new(),
            confidence: 0.5,
            skipped: false,
            source: String::new(),
            applied: false,
            skip_reason: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Proposal {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub summary: String,
    pub created_at: i64,
    pub applied_at: Option<i64>,
    pub applied_by: String,
    pub dismissed_at: Option<i64>,
    pub reverted_at: Option<i64>,
    pub superseded_at: Option<i64>,
    pub history_id: Option<String>,
    pub entries: Vec<ProposalEntry>,
    pub meta: Value,
}

impl Default for Proposal {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "rules".to_string(),
            status: "pending".to_string(),
            summary: String::new(),
            created_at: 0,
            applied_at: None,
            applied_by: String::new(),
            dismissed_at: None,
            reverted_at: None,
            superseded_at: None,
            history_id: None,
            entries: Vec::new(),
            meta: Value::Null,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub name: String,
    pub note: String,
    pub category_id: Option<String>,
    pub group_ids: Vec<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub status: String,
    pub deleted: bool,
    #[serde(alias = "aiNote")]
    pub organize_note: String,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            name: String::new(),
            note: String::new(),
            category_id: None,
            group_ids: Vec::new(),
            tags: Vec::new(),
            favorite: false,
            status: "inbox".to_string(),
            deleted: false,
            organize_note: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Change {
    pub item_id: String,
    pub before: Option<Snapshot>,
    pub after: Option<Snapshot>,
}

impl Default for Change {
    fn default() -> Self {
        Self {
            item_id: String::new(),
            before: None,
            after: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryEntry {
    pub id: String,
    pub at: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub actor: String,
    pub summary: String,
    pub undoable: bool,
    pub undone_at: Option<i64>,
    pub changes: Vec<Change>,
    pub meta: Value,
}

impl Default for HistoryEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            at: 0,
            kind: String::new(),
            actor: "user".to_string(),
            summary: String::new(),
            undoable: false,
            undone_at: None,
            changes: Vec::new(),
            meta: Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryMeta {
    pub last_backup_at: i64,
    pub last_import_at: i64,
}

impl Default for LibraryMeta {
    fn default() -> Self {
        Self {
            last_backup_at: 0,
            last_import_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    pub version: u32,
    pub updated_at: i64,
    pub categories: Vec<Category>,
    pub groups: Vec<Group>,
    pub items: Vec<Sticker>,
    pub proposals: Vec<Proposal>,
    pub meta: LibraryMeta,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: 0,
            categories: default_categories(),
            groups: Vec::new(),
            items: Vec::new(),
            proposals: Vec::new(),
            meta: LibraryMeta::default(),
        }
    }
}

pub fn default_categories() -> Vec<Category> {
    let at = crate::util::now_ms();
    [
        ("cat_happy", "开心", "#f5b942"),
        ("cat_speechless", "无语", "#8f9fd9"),
        ("cat_puzzled", "疑惑", "#b79df0"),
        ("cat_snark", "嘲讽", "#ef7a63"),
        ("cat_cute", "可爱", "#f292b8"),
        ("cat_daily", "日常", "#6fc2a4"),
        ("cat_work", "工作", "#6f9fd8"),
        ("cat_other", "其他", "#96a0a8"),
    ]
    .iter()
    .enumerate()
    .map(|(index, (id, name, color))| Category {
        id: id.to_string(),
        name: name.to_string(),
        color: color.to_string(),
        order: index as i64,
        created_at: at,
    })
    .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub copy_mode: String,
    pub card_size: u32,
    pub auto_backup: bool,
    /// 快速窗口是否置顶；由快捷窗口里的图钉按钮控制，默认不强制置顶。
    pub quick_always_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            copy_mode: "image".to_string(),
            card_size: 150,
            auto_backup: true,
            quick_always_on_top: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub copy_mode: String,
    pub card_size: u32,
    pub auto_backup: bool,
    pub quick_always_on_top: bool,
}

impl From<&Settings> for SettingsView {
    fn from(value: &Settings) -> Self {
        Self {
            copy_mode: value.copy_mode.clone(),
            card_size: value.card_size,
            auto_backup: value.auto_backup,
            quick_always_on_top: value.quick_always_on_top,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    pub categories: Vec<Category>,
    pub groups: Vec<Group>,
    pub items: Vec<Sticker>,
    pub proposals: Vec<Proposal>,
    pub settings: SettingsView,
    pub meta: LibraryMeta,
    pub history_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub version: String,
    pub platform: String,
    pub data_dir: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_ai_note_is_read_and_saved_as_organize_note() {
        let sticker: Sticker =
            serde_json::from_value(serde_json::json!({ "name": "旧素材", "aiNote": "规则：测试" }))
                .expect("旧 aiNote 应能反序列化");
        assert_eq!(sticker.organize_note, "规则：测试");
        let value = serde_json::to_value(&sticker).expect("serialize");
        assert_eq!(value["organizeNote"], "规则：测试");
        assert!(value.get("aiNote").is_none());

        let snapshot: Snapshot =
            serde_json::from_value(serde_json::json!({ "aiNote": "旧说明" })).expect("旧快照应能反序列化");
        assert_eq!(snapshot.organize_note, "旧说明");
    }
}
