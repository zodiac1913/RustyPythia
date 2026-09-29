//! Natural-language to SQL through a local Ollama model.
//!
//! Ported from the PythiaJS server: the schema is ranked down to the tables
//! most relevant to the conversation, enriched with the bundled database
//! documentation and learned hints, and handed to the model with the Oracle's
//! instructions. Generated SQL is validated against the real schema and sent
//! back for one repair round before it is trusted.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::probe::ProbeRelation;
use crate::{normalize_connection_id, resolve_query_target, run_sql_query, QueryTarget};

const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const OLLAMA_STATUS_TIMEOUT: Duration = Duration::from_millis(2500);
// Local models on a laptop can take well over a minute on a large prompt.
const OLLAMA_CHAT_TIMEOUT: Duration = Duration::from_secs(300);
const FORBIDDEN_AI_SCHEMAS: &[&str] = &["BUS"];
const PREFERRED_AI_SCHEMAS: &[&str] = &["HR", "CORE"];
const ECHELON_SNAPSHOT_LIMIT: usize = 40;
// Budgets that keep the prompt small enough for a laptop model to answer in
// reasonable time: only the playbook sections and table docs that match.
const PLAYBOOK_SECTION_LIMIT: usize = 3;
const PLAYBOOK_CHAR_BUDGET: usize = 2400;
const TABLE_DOC_LIMIT: usize = 3;
const TABLE_DOC_CHARS: usize = 1200;
const RELATIONSHIP_LIMIT: usize = 16;
const REQUESTED_COLUMN_LIMIT: usize = 40;
const PROMPT_HINT_LIMIT: usize = 6;
const REQUESTED_COLUMN_STOPWORDS: &[&str] = &[
    "how", "many", "much", "are", "was", "were", "the", "and", "for", "each", "per", "every",
    "who", "what", "which", "show", "list", "give", "get", "all", "any", "with", "from", "that",
    "this", "have", "has", "count", "number", "total",
];

const HR_EMPLOYEE_REQUIRED_FIELDS: &[&str] = &[
    "ComponentAcronym",
    "DivisionAcronym",
    "GroupAcronym",
    "OfficeAcronym",
    "DivisionIdentifier",
    "GroupIdentifier",
    "OfficeIdentifier",
    "SeparationDate",
    "DeactivateTimestamp",
];

const HR_COMPONENT_METADATA_FIELDS: &[&str] =
    &["ComponentAcronym", "ComponentName", "Level", "ParentComponentIdentifier"];

const SEARCH_STOP_WORDS: &[&str] = &[
    "what", "which", "tell", "show", "give", "from", "with", "that", "this", "there", "have",
    "into", "about", "would", "could", "should", "where", "when", "then", "they", "them",
    "database", "table", "tables", "field", "fields", "query", "only", "still", "work", "works",
    "using", "use", "need", "please", "find", "list", "all", "any",
];

fn query_term_aliases(token: &str) -> &'static [&'static str] {
    match token {
        "xo" => &["executive", "officer", "executiveofficer", "deputy"],
        "xos" => &["executive", "officers", "executiveofficer", "deputy"],
        "executive" => &["xo", "officer", "leadership"],
        "officers" => &["officer", "executive", "leadership"],
        "leadership" => &["executive", "officer", "xo"],
        "active" => &[
            "current", "currently", "enabled", "status", "notseparated", "notdeactivated",
            "stillemployed",
        ],
        "current" => &["active", "currently", "notseparated", "notdeactivated", "stillemployed"],
        "currently" => &["current", "active", "notseparated", "notdeactivated"],
        "manager" => &["ismanager", "managerrole", "hasmanagerrole"],
        _ => &[],
    }
}

fn regex(pattern: &'static str) -> Regex {
    Regex::new(pattern).expect("static regex is valid")
}

macro_rules! static_regex {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            CELL.get_or_init(|| regex($pattern))
        }
    };
}

static_regex!(camel_boundary_re, r"([a-z0-9])([A-Z])");
static_regex!(identifier_separator_re, r"[_\-.]+");
static_regex!(continuation_re, r"(?i)^(yes|no|ok|okay|use\s+\*|all fields|division|group|office|center|component|acronym|level|same|continue|go ahead|run it|do it)\b");
static_regex!(acronym_re, r"\b[A-Z]{2,12}\b");
static_regex!(block_comment_re, r"(?s)/\*.*?\*/");
static_regex!(line_comment_re, r"(?m)--.*$");
static_regex!(read_only_start_re, r"(?i)^\s*(SELECT|WITH|SHOW|DESCRIBE|PRAGMA)\b");
static_regex!(write_keyword_re, r"(?i)\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|EXEC(?:UTE)?|CALL)\b");
static_regex!(referenced_table_re, r"(?i)\b(?:FROM|JOIN|UPDATE|INTO)\s+([^\s;]+)");
static_regex!(limit_re, r"(?i)\bLIMIT\b");
static_regex!(select_star_re, r"(?i)\bSELECT\s+(?:DISTINCT\s+)?\*");
static_regex!(whitespace_re, r"\s+");
static_regex!(select_start_re, r"(?i)^select\b");
static_regex!(from_word_re, r"(?i)\bfrom\b");
static_regex!(select_prefix_re, r"(?i)^select\s+");
static_regex!(top_prefix_re, r"(?i)^top\s*\(?\d+\)?\s+");
static_regex!(distinct_prefix_re, r"(?i)^distinct\s+");
static_regex!(alias_split_re, r"(?i)\s+as\s+");
static_regex!(think_re, r"(?is)<think>.*?</think>");
static_regex!(fence_open_re, r"(?i)^```(?:json)?\s*");
static_regex!(fence_close_re, r"\s*```$");
static_regex!(bare_sql_re, r"(?is)(?:^|\n)\s*((?:SELECT|WITH).*?)\s*;?\s*$");
static_regex!(echelon_intent_re, r"\b(component|acronym|echelon|division|group|office|center|manager|employee|staff|people)\b");
static_regex!(what_is_acronym_re, r"(?i)^\s*what\s+is\s+[a-z0-9_-]{2,12}\s*\??\s*$");
static_regex!(what_level_re, r"(?i)^\s*what\s+level\s+is\s+[a-z0-9_-]{2,20}\s*\??\s*$");
static_regex!(hierarchy_for_re, r"(?i)^\s*(show|list|give)\s+me\s+the\s+hierarchy\s+for\s+[a-z0-9_-]{2,20}\s*\??\s*$");
static_regex!(belongs_to_re, r"(?i)^\s*what\s+component\s+does\s+.+\s+belong\s+to\s*\??\s*$");
static_regex!(parent_child_re, r"(?i)\b(parent|child)\b");
static_regex!(component_relationship_re, r"(?i)\b(component|relationship|relationships)\b");

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    name: String,
    size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    online: bool,
    models: Vec<OllamaModel>,
    default_model: Option<String>,
    base_url: String,
    detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAssistRequest {
    connection_id: Option<String>,
    #[serde(default)]
    conversation: Vec<ChatMessage>,
    model: Option<String>,
    current_query: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDecision {
    status: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    sql: String,
    #[serde(default)]
    assumptions: Vec<String>,
    #[serde(default)]
    explanation: String,
    #[serde(default)]
    model: String,
}

impl AiDecision {
    fn clarify(question: impl Into<String>) -> Self {
        Self {
            status: "clarify".into(),
            question: question.into(),
            ..Self::default()
        }
    }

    fn is_ready_with_sql(&self) -> bool {
        self.status == "ready" && !self.sql.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

fn ollama_base_url() -> String {
    std::env::var("OLLAMA_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

pub async fn ollama_status() -> OllamaStatus {
    let base_url = ollama_base_url();
    let response = http_client()
        .get(format!("{}/api/tags", base_url.trim_end_matches('/')))
        .timeout(OLLAMA_STATUS_TIMEOUT)
        .send()
        .await
        .and_then(|response| response.error_for_status());

    let payload = match response {
        Ok(response) => response.json::<Value>().await.map_err(|err| err.to_string()),
        Err(err) => Err(err.to_string()),
    };

    match payload {
        Ok(payload) => {
            let models = payload["models"]
                .as_array()
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            let name = entry["name"].as_str()?.trim().to_string();
                            (!name.is_empty()).then(|| OllamaModel {
                                name,
                                size: entry["size"].as_u64(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            OllamaStatus {
                online: true,
                default_model: models.first().map(|model| model.name.clone()),
                models,
                base_url,
                detail: None,
            }
        }
        Err(detail) => OllamaStatus {
            online: false,
            models: Vec::new(),
            default_model: None,
            base_url,
            detail: Some(detail),
        },
    }
}

async fn request_ai_decision(model: &str, messages: &[ChatMessage]) -> Result<AiDecision, String> {
    let body = json!({
        "model": model,
        "stream": false,
        "format": {
            "type": "object",
            "properties": {
                "status": { "type": "string" },
                "question": { "type": "string" },
                "sql": { "type": "string" },
                "assumptions": { "type": "array", "items": { "type": "string" } },
                "explanation": { "type": "string" }
            },
            "required": ["status", "question", "sql", "assumptions", "explanation"]
        },
        "messages": messages,
        "options": { "temperature": 0.1 }
    });

    let response = http_client()
        .post(format!("{}/api/chat", ollama_base_url().trim_end_matches('/')))
        .timeout(OLLAMA_CHAT_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                format!(
                    "{} took longer than {} seconds to answer. Try a more specific question or a faster model.",
                    model,
                    OLLAMA_CHAT_TIMEOUT.as_secs()
                )
            } else {
                format!("Ollama request failed: {}", err)
            }
        })?;

    if !response.status().is_success() {
        return Err(format!("Ollama request failed with status {}", response.status()));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|err| format!("Failed to read Ollama response: {}", err))?;

    Ok(parse_ai_decision(payload["message"]["content"].as_str().unwrap_or_default()))
}

fn extract_json_object(text: &str) -> String {
    let trimmed = think_re().replace_all(text, "").trim().to_string();
    let without_fence = fence_open_re().replace(&trimmed, "").to_string();
    let without_fence = fence_close_re().replace(&without_fence, "").to_string();

    match (without_fence.find('{'), without_fence.rfind('}')) {
        (Some(start), Some(end)) if end > start => without_fence[start..=end].to_string(),
        _ => without_fence,
    }
}

fn parse_ai_decision(raw_content: &str) -> AiDecision {
    let candidate = extract_json_object(raw_content);

    if let Ok(parsed) = serde_json::from_str::<Value>(&candidate) {
        if parsed.is_object() {
            let status = if parsed["status"].as_str() == Some("clarify") {
                "clarify"
            } else {
                "ready"
            };
            let text = |key: &str| parsed[key].as_str().unwrap_or_default().trim().to_string();

            return AiDecision {
                status: status.into(),
                question: text("question"),
                sql: if status == "clarify" { String::new() } else { text("sql") },
                assumptions: parsed["assumptions"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| match item {
                                Value::String(value) => value.trim().to_string(),
                                other => other.to_string(),
                            })
                            .filter(|item| !item.is_empty())
                            .collect()
                    })
                    .unwrap_or_default(),
                explanation: text("explanation"),
                model: String::new(),
            };
        }
    }

    let normalized = think_re().replace_all(raw_content, "").trim().to_string();
    if let Some(captures) = bare_sql_re().captures(&normalized) {
        return AiDecision {
            status: "ready".into(),
            sql: captures[1].trim().to_string(),
            explanation: "Using the most likely employee-related table based on the current schema.".into(),
            ..AiDecision::default()
        };
    }

    if !normalized.is_empty() {
        return AiDecision::clarify(normalized);
    }

    AiDecision::clarify(
        "I need a bit more detail before I can build a reliable query. Which table or result columns should I use?",
    )
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

fn normalize_conversation(conversation: &[ChatMessage]) -> Vec<ChatMessage> {
    conversation
        .iter()
        .map(|entry| ChatMessage {
            role: if entry.role == "assistant" { "assistant" } else { "user" }.into(),
            content: entry.content.trim().to_string(),
        })
        .filter(|entry| !entry.content.is_empty())
        .collect()
}

fn latest_user_message(conversation: &[ChatMessage]) -> String {
    normalize_conversation(conversation)
        .into_iter()
        .rev()
        .find(|entry| entry.role == "user")
        .map(|entry| entry.content)
        .unwrap_or_default()
}

fn conversation_text(conversation: &[ChatMessage]) -> String {
    normalize_conversation(conversation)
        .into_iter()
        .map(|entry| entry.content)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Keeps short follow-ups ("yes", "division") grounded in the request they
/// answer, without leaking older context into an unrelated new prompt.
fn user_intent_text(conversation: &[ChatMessage]) -> String {
    let user_messages = normalize_conversation(conversation)
        .into_iter()
        .filter(|entry| entry.role == "user")
        .map(|entry| entry.content)
        .collect::<Vec<_>>();

    let Some(latest) = user_messages.last() else {
        return String::new();
    };
    if user_messages.len() == 1 {
        return latest.clone();
    }

    let previous = &user_messages[user_messages.len() - 2];
    let is_short_follow_up = latest.chars().count() <= 40 || continuation_re().is_match(latest);
    if is_short_follow_up {
        return format!("{} {}", previous, latest).trim().to_string();
    }

    latest.clone()
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

fn push_unique(target: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !target.contains(&value) {
        target.push(value);
    }
}

fn normalize_search_token(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .collect()
}

fn split_identifier_parts(value: &str) -> Vec<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Vec::new();
    }

    let spaced = camel_boundary_re().replace_all(raw, "$1 $2");
    let spaced = identifier_separator_re().replace_all(&spaced, " ").to_lowercase();

    spaced
        .split_whitespace()
        .map(str::trim)
        .filter(|part| part.chars().count() >= 2)
        .map(str::to_string)
        .collect()
}

fn build_search_token_set(text: &str) -> Vec<String> {
    let base_parts = split_identifier_parts(text);
    let mut tokens = Vec::new();

    for part in &base_parts {
        push_unique(&mut tokens, part.clone());
        let normalized = normalize_search_token(part);
        if !normalized.is_empty() {
            push_unique(&mut tokens, normalized);
        }
    }

    for pair in base_parts.windows(2) {
        let combined = normalize_search_token(&format!("{}{}", pair[0], pair[1]));
        if combined.len() >= 4 {
            push_unique(&mut tokens, combined);
        }
    }

    tokens
}

fn user_asked_for_manager_role(text: &str) -> bool {
    let tokens = build_search_token_set(text);
    tokens.iter().any(|token| token == "manager" || token == "managers")
}

/// ManagerIdentifier-style columns point at a supervisor; they do not say the
/// employee is a manager, so they are kept out of manager-role answers.
fn is_manager_relationship_column(column: &str) -> bool {
    let normalized = normalize_search_token(column);
    if !normalized.contains("manager") {
        return false;
    }

    let role_signals = ["ismanager", "hasmanagerrole", "managerrole", "managerflag"];
    if role_signals.iter().any(|signal| normalized.contains(signal)) {
        return false;
    }

    let relationship_signals = ["manageridentifier", "managerid", "manageremployeeid", "managernumber"];
    relationship_signals.iter().any(|signal| normalized.contains(signal))
}

fn extract_search_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in build_search_token_set(text) {
        if token.chars().count() >= 2 && !SEARCH_STOP_WORDS.contains(&token.as_str()) {
            push_unique(&mut tokens, token);
        }
    }
    tokens
}

fn is_learnable_token(token: &str) -> bool {
    let normalized = normalize_search_token(token);
    if normalized.len() < 3 {
        return false;
    }
    !SEARCH_STOP_WORDS.contains(&normalized.as_str()) && !["the", "and", "are"].contains(&normalized.as_str())
}

fn expand_search_tokens(tokens: &[String]) -> Vec<String> {
    let mut expanded = tokens.to_vec();
    for token in tokens {
        for alias in query_term_aliases(token) {
            push_unique(&mut expanded, *alias);
            let normalized = normalize_search_token(alias);
            if !normalized.is_empty() {
                push_unique(&mut expanded, normalized);
            }
        }
    }
    expanded
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct SchemaEntry {
    name: String,
    columns: Vec<String>,
    /// Display type per column, parallel to `columns`.
    column_types: Vec<String>,
    kind: String,
    row_count: Option<i64>,
    primary_key: Vec<String>,
}

type Schema = Vec<SchemaEntry>;

/// The probed catalog: every table with types and keys, and the declared and
/// inferred joins between them. Read from the workspace cache, not the live
/// database, so a question does not wait on a full catalog scan.
async fn load_schema(app: &AppHandle, connection_id: &str) -> Result<(Schema, Vec<ProbeRelation>), String> {
    let probe = crate::probe::load_probe(app, connection_id).await?;
    let schema = probe
        .tables
        .iter()
        .map(|table| SchemaEntry {
            name: table.name.clone(),
            columns: table.columns.iter().map(|column| column.name.clone()).collect(),
            column_types: table
                .columns
                .iter()
                .map(|column| {
                    if column.nullable {
                        column.data_type.clone()
                    } else {
                        format!("{} NOT NULL", column.data_type)
                    }
                })
                .collect(),
            kind: table.kind.clone(),
            row_count: table.row_count,
            primary_key: table.primary_key.clone(),
        })
        .collect();
    Ok((schema, probe.relations.clone()))
}

fn strip_identifier_quotes(value: &str) -> String {
    value.replace(['[', ']', '"', '`'], "")
}

fn is_forbidden_ai_table(table_name: &str) -> bool {
    let schema_name = table_name.split('.').next().unwrap_or_default().to_uppercase();
    FORBIDDEN_AI_SCHEMAS.contains(&schema_name.as_str())
}

fn ai_schema_priority(table_name: &str) -> i64 {
    let schema_name = table_name.split('.').next().unwrap_or_default().to_uppercase();
    PREFERRED_AI_SCHEMAS
        .iter()
        .position(|preferred| *preferred == schema_name)
        .map(|index| ((PREFERRED_AI_SCHEMAS.len() - index) * 40) as i64)
        .unwrap_or(0)
        - scratch_table_penalty(table_name)
}

static_regex!(
    scratch_table_regex,
    r"(TMP|TEMP|BK|BAK|BACKUP|OLD|COPY|TEST)(W?\d+)?$|INDEXBK|_\d{6,}$"
);

fn scratch_table_penalty(table_name: &str) -> i64 {
    let tail = table_name.split('.').next_back().unwrap_or_default().to_uppercase();
    if scratch_table_regex().is_match(&tail) {
        120
    } else {
        0
    }
}

fn normalize_table_base_name(table_name: &str) -> String {
    let cleaned = strip_identifier_quotes(table_name);
    let tail = cleaned.split('.').next_back().unwrap_or(&cleaned).to_string();
    normalize_search_token(&tail)
}

fn find_schema_table_by_base_name<'a>(schema: &'a Schema, base_name: &str) -> Option<&'a SchemaEntry> {
    let wanted = normalize_search_token(base_name);
    schema.iter().find(|entry| normalize_table_base_name(&entry.name) == wanted)
}

fn find_column_name(columns: &[String], preferred: &str) -> Option<String> {
    let wanted = normalize_search_token(preferred);
    columns.iter().find(|column| normalize_search_token(column) == wanted).cloned()
}

fn resolve_canonical_column_name(columns: &[String], preferred: &str) -> String {
    find_column_name(columns, preferred).unwrap_or_else(|| preferred.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct SchemaHint {
    token: String,
    tables: Vec<String>,
    columns: Vec<String>,
}

fn build_schema_discovery_hints(schema: &Schema, tokens: &[String]) -> Vec<SchemaHint> {
    let mut wanted = Vec::new();
    for token in tokens {
        let normalized = normalize_search_token(token);
        if !normalized.is_empty() {
            push_unique(&mut wanted, normalized);
        }
    }

    let mut hints = wanted
        .iter()
        .map(|token| SchemaHint {
            token: token.clone(),
            tables: Vec::new(),
            columns: Vec::new(),
        })
        .collect::<Vec<_>>();

    for entry in schema.iter().filter(|entry| !is_forbidden_ai_table(&entry.name)) {
        let table_parts = split_identifier_parts(&entry.name)
            .iter()
            .map(|part| normalize_search_token(part))
            .collect::<Vec<_>>();
        let normalized_table = normalize_search_token(&entry.name);

        for hint in hints.iter_mut() {
            if table_parts.contains(&hint.token)
                || normalized_table.contains(&hint.token)
                || hint.token.contains(&normalized_table)
            {
                push_unique(&mut hint.tables, entry.name.clone());
            }
        }

        for column in &entry.columns {
            let normalized_column = normalize_search_token(column);
            let column_parts = split_identifier_parts(column)
                .iter()
                .map(|part| normalize_search_token(part))
                .collect::<Vec<_>>();

            for hint in hints.iter_mut() {
                if normalized_column.contains(&hint.token)
                    || hint.token.contains(&normalized_column)
                    || column_parts.contains(&hint.token)
                {
                    push_unique(&mut hint.columns, format!("{}.{}", entry.name, column));
                    push_unique(&mut hint.tables, entry.name.clone());
                }
            }
        }
    }

    hints
        .into_iter()
        .map(|mut hint| {
            hint.tables.truncate(6);
            hint.columns.truncate(10);
            hint
        })
        .filter(|hint| !hint.tables.is_empty() || !hint.columns.is_empty())
        .take(10)
        .collect()
}

fn unknown_search_tokens(tokens: &[String], hints: &[SchemaHint]) -> Vec<String> {
    tokens
        .iter()
        .filter(|token| {
            let normalized = normalize_search_token(token);
            !hints.iter().any(|hint| hint.token == normalized)
        })
        .cloned()
        .collect()
}

fn extract_mentioned_tables(schema: &Schema, conversation: &[ChatMessage]) -> Vec<String> {
    let text = conversation_text(conversation).to_lowercase();
    if text.is_empty() {
        return Vec::new();
    }

    schema
        .iter()
        .filter(|entry| !is_forbidden_ai_table(&entry.name) && text.contains(&entry.name.to_lowercase()))
        .map(|entry| entry.name.clone())
        .collect()
}

fn score_schema_entry(table_name: &str, columns: &[String], tokens: &[String]) -> i64 {
    let table_lower = table_name.to_lowercase();
    let haystack = format!("{} {}", table_name, columns.join(" ")).to_lowercase();
    let normalized_columns = columns.iter().map(|column| column.to_lowercase()).collect::<Vec<_>>();
    let has_employee_signal =
        normalized_columns.iter().any(|column| column.contains("employee")) || table_lower.contains("employee");
    let has_component_signal =
        normalized_columns.iter().any(|column| column.contains("component")) || table_lower.contains("component");
    let table_parts = split_identifier_parts(table_name);
    let mut score = 0i64;

    for token in tokens {
        if table_lower.contains(token.as_str()) || table_parts.contains(token) {
            score += 8;
        }

        for column in columns {
            let column_lower = column.to_lowercase();
            if column_lower.contains(token.as_str()) || split_identifier_parts(column).contains(token) {
                score += 3;
            }
        }
    }

    if haystack.contains("employee") {
        score += 4;
    }
    if haystack.contains("component") {
        score += 4;
    }
    if haystack.contains("department") {
        score += 2;
    }
    if haystack.contains("name") {
        score += 1;
    }

    let has = |wanted: &str| tokens.iter().any(|token| token == wanted);
    let asks_employees = has("employee") || has("employees");
    if asks_employees {
        if has_employee_signal {
            score += 18;
        }
        if normalized_columns
            .iter()
            .any(|column| column.contains("name") || column.contains("email") || column.contains("title"))
        {
            score += 6;
        }
    }
    if has("component") {
        if has_component_signal {
            score += 18;
        }
        if normalized_columns
            .iter()
            .any(|column| column.contains("acronym") || column.contains("fullcomponent"))
        {
            score += 6;
        }
    }
    if asks_employees && has("component") && has_employee_signal && has_component_signal {
        score += 24;
    }

    score
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

fn extract_acronym_candidates(text: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    for found in acronym_re().find_iter(text) {
        push_unique(&mut candidates, found.as_str().to_uppercase());
    }
    candidates
}

fn conversation_acronym_candidates(conversation: &[ChatMessage]) -> Vec<String> {
    const BLOCKED: &[&str] = &["SELECT", "FROM", "WHERE", "WITH", "AND", "OR", "NULL", "SQL", "HR", "MSSQL"];
    let keep = |token: &String| !BLOCKED.contains(&token.as_str());

    let latest = extract_acronym_candidates(&latest_user_message(conversation))
        .into_iter()
        .filter(keep)
        .collect::<Vec<_>>();
    if !latest.is_empty() {
        return latest;
    }

    extract_acronym_candidates(&user_intent_text(conversation))
        .into_iter()
        .filter(keep)
        .collect()
}

fn is_whole_organization_alias(token: &str) -> bool {
    matches!(token.trim().to_uppercase().as_str(), "CMS" | "MEDICARE")
}

fn user_requested_commissioned_corps_employees(conversation: &[ChatMessage]) -> bool {
    let text = user_intent_text(conversation).to_lowercase();
    if text.is_empty() {
        return false;
    }

    let employee_signals = ["employee", "employees", "officer", "officers", "staff", "people"];
    let commissioned_signals = [
        "commissioned corps",
        "commissionedcorps",
        "corps employee",
        "corps employees",
        "corps officer",
        "corps officers",
    ];

    commissioned_signals.iter().any(|signal| text.contains(signal))
        && employee_signals.iter().any(|signal| text.contains(signal))
}

fn user_requested_employees_by_component(conversation: &[ChatMessage]) -> bool {
    let text = user_intent_text(conversation).to_lowercase();
    if text.is_empty() || user_requested_commissioned_corps_employees(conversation) {
        return false;
    }

    let employee_signals = ["employee", "employees", "staff", "worker", "workers", "people"];
    let component_signals = [
        "component",
        "componentacronym",
        "division",
        "group",
        "office",
        "center",
        "divisionacronym",
        "groupacronym",
        "officeacronym",
        "centeracronym",
        "divisionidentifier",
        "groupidentifier",
        "officeidentifier",
    ];

    let asks_for_employees = employee_signals.iter().any(|signal| text.contains(signal));
    if asks_for_employees && component_signals.iter().any(|signal| text.contains(signal)) {
        return true;
    }

    // "employees of DASM" is still component membership even without a level word.
    asks_for_employees
        && conversation_acronym_candidates(conversation)
            .iter()
            .any(|token| !is_whole_organization_alias(token))
}

fn user_requested_component_metadata(conversation: &[ChatMessage]) -> bool {
    let latest = latest_user_message(conversation).trim().to_string();
    let text = latest.to_lowercase();
    if text.is_empty() || user_requested_employees_by_component(conversation) {
        return false;
    }

    let strict_signals = [
        "component metadata",
        "component name",
        "component level",
        "hierarchy",
        "parent/child",
        "parent child",
        "parent component",
        "parentcomponentidentifier",
        "child component",
        "component hierarchy",
        "what level is",
        "what component does this belong to",
    ];
    if strict_signals.iter().any(|signal| text.contains(signal)) {
        return true;
    }

    what_is_acronym_re().is_match(&latest)
        || what_level_re().is_match(&latest)
        || hierarchy_for_re().is_match(&latest)
        || belongs_to_re().is_match(&latest)
        || (parent_child_re().is_match(&latest) && component_relationship_re().is_match(&latest))
}

fn user_needs_component_level_resolution(conversation: &[ChatMessage]) -> bool {
    user_requested_employees_by_component(conversation)
        && acronym_re().is_match(&user_intent_text(conversation))
}

// ---------------------------------------------------------------------------
// Learned hints
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaMemory {
    #[serde(default)]
    token_to_tables: HashMap<String, Vec<String>>,
    #[serde(default)]
    token_to_columns: HashMap<String, Vec<String>>,
}

fn memory_state() -> &'static Mutex<Option<SchemaMemory>> {
    static MEMORY: OnceLock<Mutex<Option<SchemaMemory>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(None))
}

fn memory_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("ai-schema-memory.json"))
}

/// Learned hints live in the app data folder so they survive updates; the
/// first run starts from the hints PythiaJS already accumulated.
fn load_memory(app: &AppHandle) -> SchemaMemory {
    let read = |path: PathBuf| -> Option<SchemaMemory> {
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    };

    memory_path(app)
        .filter(|path| path.exists())
        .and_then(read)
        .or_else(|| ai_resource_dir(app).map(|dir| dir.join("ai-schema-memory.seed.json")).and_then(read))
        .unwrap_or_default()
}

fn with_memory<T>(app: &AppHandle, action: impl FnOnce(&mut SchemaMemory) -> T) -> T {
    let mut guard = memory_state().lock().unwrap_or_else(|poison| poison.into_inner());
    let memory = guard.get_or_insert_with(|| load_memory(app));
    action(memory)
}

fn collect_learned_hints(app: &AppHandle, tokens: &[String]) -> Vec<SchemaHint> {
    with_memory(app, |memory| {
        tokens
            .iter()
            .filter_map(|token| {
                let tables = memory.token_to_tables.get(token).cloned().unwrap_or_default();
                let columns = memory.token_to_columns.get(token).cloned().unwrap_or_default();
                if tables.is_empty() && columns.is_empty() {
                    return None;
                }
                Some(SchemaHint {
                    token: token.clone(),
                    tables: tables.into_iter().take(3).collect(),
                    columns: columns.into_iter().take(4).collect(),
                })
            })
            .take(8)
            .collect()
    })
}

fn upsert_hint_value(bucket: &mut HashMap<String, Vec<String>>, token: &str, value: &str) {
    if token.is_empty() || value.is_empty() {
        return;
    }
    let existing = bucket.entry(token.to_string()).or_default();
    existing.retain(|item| item != value);
    existing.insert(0, value.to_string());
    existing.truncate(8);
}

fn extract_select_clause(sql: &str) -> String {
    let normalized = whitespace_re().replace_all(sql, " ").trim().to_string();
    if !select_start_re().is_match(&normalized) {
        return String::new();
    }
    match from_word_re().find(&normalized) {
        Some(found) if found.start() > 0 => select_prefix_re()
            .replace(&normalized[..found.start()], "")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn extract_sql_selected_columns(sql: &str) -> Vec<String> {
    let clause = extract_select_clause(sql);
    let clause = top_prefix_re().replace(&clause, "").to_string();
    let clause = distinct_prefix_re().replace(&clause, "").trim().to_string();
    if clause.is_empty() || clause == "*" {
        return Vec::new();
    }

    clause
        .split(',')
        .filter_map(|column| {
            let without_alias = alias_split_re().split(column).next().unwrap_or_default().trim();
            let tail = without_alias.split('.').next_back().unwrap_or_default();
            let cleaned = strip_identifier_quotes(tail).trim().to_string();
            (!cleaned.is_empty()).then_some(cleaned)
        })
        .collect()
}

fn extract_referenced_tables(sql: &str) -> Vec<String> {
    referenced_table_re()
        .captures_iter(sql)
        .map(|captures| captures[1].to_string())
        .collect()
}

fn learn_schema_hints(app: &AppHandle, latest_user_message: &str, sql: &str) {
    let tokens = extract_search_tokens(latest_user_message)
        .into_iter()
        .map(|token| normalize_search_token(&token))
        .filter(|token| is_learnable_token(token))
        .collect::<Vec<_>>();
    if tokens.is_empty() || sql.is_empty() {
        return;
    }

    let tables = extract_referenced_tables(sql)
        .into_iter()
        .map(|table| strip_identifier_quotes(&table).trim().to_string())
        .filter(|table| !table.is_empty())
        .collect::<Vec<_>>();
    let columns = extract_sql_selected_columns(sql);

    let snapshot = with_memory(app, |memory| {
        for token in &tokens {
            for table in &tables {
                upsert_hint_value(&mut memory.token_to_tables, token, table);
            }
            let manager_token = token == "manager" || token == "managers";
            for column in &columns {
                if manager_token && is_manager_relationship_column(column) {
                    continue;
                }
                upsert_hint_value(&mut memory.token_to_columns, token, column);
            }
        }
        memory.clone()
    });

    if let Some(path) = memory_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string_pretty(&snapshot) {
            let _ = fs::write(path, serialized);
        }
    }
}

// ---------------------------------------------------------------------------
// Relevant schema subset
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RelevantTable {
    table_name: String,
    columns: Vec<String>,
    column_types: Vec<String>,
    total_columns: usize,
    kind: String,
    row_count: Option<i64>,
    primary_key: Vec<String>,
}

fn format_count(count: i64) -> String {
    let digits = count.abs().to_string();
    let mut grouped = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    if count < 0 {
        format!("-{}", grouped)
    } else {
        grouped
    }
}

/// The schema as compact DDL-style text. It carries types, keys and sizes in
/// far fewer tokens than JSON, and models read it the way they read DDL.
fn render_schema_excerpt(tables: &[RelevantTable], relations: &[ProbeRelation]) -> String {
    let mut lines = Vec::new();
    for table in tables {
        let size = match table.row_count {
            Some(count) => format!("~{} rows", format_count(count)),
            None => "row count unknown".into(),
        };
        let key = if table.primary_key.is_empty() {
            String::new()
        } else {
            format!(" · PK ({})", table.primary_key.join(", "))
        };
        lines.push(format!("{} [{}, {}{}]", table.table_name, table.kind, size, key));

        let columns = table
            .columns
            .iter()
            .zip(table.column_types.iter())
            .map(|(name, data_type)| {
                if data_type.is_empty() {
                    name.clone()
                } else {
                    format!("{} {}", name, data_type)
                }
            })
            .collect::<Vec<_>>();
        lines.push(format!("  {}", columns.join(", ")));
        if table.total_columns > table.columns.len() {
            lines.push(format!(
                "  (showing {} of {} columns; only the columns listed above may be used)",
                table.columns.len(),
                table.total_columns
            ));
        }
    }

    // Joins inside the excerpt come first; links out to other tables follow so
    // the model knows a lookup table exists even when it was not ranked in.
    let names = tables.iter().map(|table| table.table_name.as_str()).collect::<Vec<_>>();
    let touches = |relation: &&ProbeRelation| {
        names.contains(&relation.from_table.as_str()) || names.contains(&relation.to_table.as_str())
    };
    let mut related = relations.iter().filter(touches).collect::<Vec<_>>();
    related.sort_by_key(|relation| {
        let inside = names.contains(&relation.from_table.as_str()) && names.contains(&relation.to_table.as_str());
        (!inside, relation.inferred)
    });
    let joins = related
        .into_iter()
        .take(RELATIONSHIP_LIMIT)
        .map(|relation| {
            format!(
                "- {}.{} -> {}.{}{}",
                relation.from_table,
                relation.from_column,
                relation.to_table,
                relation.to_column,
                if relation.inferred { " (by naming convention, not enforced)" } else { "" }
            )
        })
        .collect::<Vec<_>>();
    if !joins.is_empty() {
        lines.push(String::new());
        lines.push("Relationships between these tables (use these for joins):".into());
        lines.extend(joins);
    }

    lines.join("\n")
}

struct RelevantSchema {
    latest_user_message: String,
    tokens: Vec<String>,
    unknown_tokens: Vec<String>,
    total_tables: usize,
    requested_columns: Vec<String>,
    learned_hints: Vec<SchemaHint>,
    discovery_hints: Vec<SchemaHint>,
    relevant_tables: Vec<RelevantTable>,
}

struct RankedEntry<'a> {
    entry: &'a SchemaEntry,
    score: i64,
}

fn select_relevant_columns(
    columns: &[String],
    tokens: &[String],
    requested_columns: &[String],
    is_explicit_table: bool,
    force_include: &[String],
    only_force_include: bool,
) -> Vec<String> {
    let resolved_force = force_include
        .iter()
        .map(|column| resolve_canonical_column_name(columns, column))
        .collect::<Vec<_>>();

    if only_force_include {
        let mut selected = Vec::new();
        for column in resolved_force {
            push_unique(&mut selected, column);
        }
        return selected;
    }

    let normalized_requested = requested_columns
        .iter()
        .map(|column| normalize_search_token(column))
        .collect::<Vec<_>>();
    let manager_intent = tokens.iter().any(|token| token == "manager" || token == "managers");
    let identity_re = identity_column_re();
    let mut selected = Vec::new();

    for column in columns {
        let normalized_column = normalize_search_token(column);
        let matches_requested = normalized_requested.contains(&normalized_column);
        let matches_search = tokens
            .iter()
            .any(|token| normalized_column.contains(&normalize_search_token(token)));
        let is_useful_identity = identity_re.is_match(column);

        if manager_intent && is_manager_relationship_column(column) && !matches_requested {
            continue;
        }

        if matches_requested || matches_search || (is_explicit_table && is_useful_identity) {
            push_unique(&mut selected, column.clone());
        }
    }

    for column in &resolved_force {
        push_unique(&mut selected, column.clone());
    }

    if !selected.is_empty() {
        selected.truncate(18);
        return selected;
    }

    let mut fallback = columns.iter().take(12).cloned().collect::<Vec<_>>();
    for column in resolved_force {
        push_unique(&mut fallback, column);
    }
    fallback
}

static_regex!(identity_column_re, r"(?i)identifier|name|moniker|title|email|component|office|group|division");

fn infer_requested_columns(entries: &[(&str, &[String])], conversation: &[ChatMessage]) -> Vec<String> {
    let latest = latest_user_message(conversation);
    let manager_intent = user_asked_for_manager_role(&latest);
    let mut message_tokens = Vec::new();
    for token in build_search_token_set(&latest) {
        let normalized = normalize_search_token(&token);
        if normalized.len() < 3 || REQUESTED_COLUMN_STOPWORDS.contains(&normalized.as_str()) {
            continue;
        }
        let singular = normalized.strip_suffix('s').unwrap_or(&normalized).to_string();
        push_unique(&mut message_tokens, normalized);
        if singular.len() >= 3 {
            push_unique(&mut message_tokens, singular);
        }
    }

    let mut requested: Vec<(String, String)> = Vec::new();
    for (_, columns) in entries {
        for column in columns.iter() {
            let normalized_column = normalize_search_token(column);
            if normalized_column.is_empty() || (manager_intent && is_manager_relationship_column(column)) {
                continue;
            }

            let column_parts = split_identifier_parts(column)
                .iter()
                .map(|part| normalize_search_token(part))
                .collect::<Vec<_>>();
            let matched = message_tokens.contains(&normalized_column)
                || column_parts.iter().any(|part| message_tokens.contains(part))
                || message_tokens.iter().any(|token| {
                    (token.len() >= 5 && normalized_column.contains(token.as_str()))
                        || (normalized_column.len() >= 5 && token.contains(&normalized_column))
                });

            if matched {
                match requested.iter_mut().find(|(key, _)| *key == normalized_column) {
                    Some(existing) => existing.1 = column.clone(),
                    None => requested.push((normalized_column, column.clone())),
                }
            }
        }
    }

    requested
        .into_iter()
        .map(|(_, column)| column)
        .take(REQUESTED_COLUMN_LIMIT)
        .collect()
}

fn build_relevant_schema_subset(app: &AppHandle, schema: &Schema, conversation: &[ChatMessage]) -> RelevantSchema {
    let entries = schema
        .iter()
        .filter(|entry| !is_forbidden_ai_table(&entry.name))
        .collect::<Vec<_>>();
    let latest = latest_user_message(conversation);
    let base_tokens = extract_search_tokens(&format!("{} {}", conversation_text(conversation), latest));
    let tokens = expand_search_tokens(&base_tokens);
    let learned_hints = collect_learned_hints(app, &tokens);
    let discovery_hints = build_schema_discovery_hints(schema, &tokens);
    let unknown_tokens = unknown_search_tokens(&tokens, &discovery_hints);
    let mentioned_tables = extract_mentioned_tables(schema, conversation);
    let include_component_metadata = user_requested_component_metadata(conversation);
    let include_component_for_acronym =
        user_requested_employees_by_component(conversation) && user_needs_component_level_resolution(conversation);
    let include_component = include_component_metadata || include_component_for_acronym;

    let mut ranked = entries
        .iter()
        .map(|entry| {
            let learned_score = learned_hints
                .iter()
                .map(|hint| {
                    if hint.tables.contains(&entry.name) {
                        35
                    } else if hint.columns.iter().any(|column| entry.columns.contains(column)) {
                        18
                    } else {
                        0
                    }
                })
                .sum::<i64>();

            RankedEntry {
                entry,
                score: score_schema_entry(&entry.name, &entry.columns, &tokens)
                    + learned_score
                    + ai_schema_priority(&entry.name)
                    + if mentioned_tables.contains(&entry.name) { 1000 } else { 0 }
                    // An empty table cannot answer anything; keep it out of the way.
                    + if entry.row_count == Some(0) { -40 } else { 0 },
            }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.entry.name.cmp(&right.entry.name))
    });

    let employee_base = normalize_search_token("HR_Employee");
    let component_base = normalize_search_token("HR_Component");
    let is_employee = |entry: &SchemaEntry| normalize_table_base_name(&entry.name) == employee_base;
    let is_component = |entry: &SchemaEntry| normalize_table_base_name(&entry.name) == component_base;

    let employee_index = ranked.iter().position(|ranked| is_employee(ranked.entry));
    let component_index = ranked.iter().position(|ranked| is_component(ranked.entry));

    let candidates = ranked
        .iter()
        .enumerate()
        .filter(|(index, _)| include_component || Some(*index) != component_index)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();

    let requested_columns = infer_requested_columns(
        &candidates
            .iter()
            .map(|index| (ranked[*index].entry.name.as_str(), ranked[*index].entry.columns.as_slice()))
            .collect::<Vec<_>>(),
        conversation,
    );

    let result_limit = if mentioned_tables.is_empty() { 8 } else { 4 };
    let mut selected = candidates
        .iter()
        .copied()
        .filter(|index| ranked[*index].score > 0)
        .take(result_limit)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        selected = candidates.iter().copied().take(result_limit).collect();
    }

    let mut final_indexes = Vec::new();
    if let Some(index) = employee_index {
        final_indexes.push(index);
    }
    for index in selected {
        if !final_indexes.contains(&index) {
            final_indexes.push(index);
        }
    }
    if include_component {
        if let Some(index) = component_index {
            if !final_indexes.contains(&index) {
                final_indexes.push(index);
            }
        }
    }

    let employee_force = HR_EMPLOYEE_REQUIRED_FIELDS.iter().map(|field| field.to_string()).collect::<Vec<_>>();

    let relevant_tables = final_indexes
        .into_iter()
        .filter_map(|index| {
            let ranked_entry = &ranked[index];
            let entry = ranked_entry.entry;
            let explicit = mentioned_tables.contains(&entry.name);

            let columns = if is_employee(entry) {
                select_relevant_columns(&entry.columns, &tokens, &requested_columns, explicit, &employee_force, false)
            } else if is_component(entry) {
                if !include_component {
                    return None;
                }
                let force = if include_component_for_acronym {
                    vec![
                        resolve_canonical_column_name(&entry.columns, "ComponentAcronym"),
                        resolve_canonical_column_name(&entry.columns, "Level"),
                    ]
                } else {
                    HR_COMPONENT_METADATA_FIELDS.iter().map(|field| field.to_string()).collect()
                };
                select_relevant_columns(&entry.columns, &tokens, &requested_columns, explicit, &force, true)
            } else {
                select_relevant_columns(&entry.columns, &tokens, &requested_columns, explicit, &[], false)
            };

            let column_types = columns
                .iter()
                .map(|column| {
                    entry
                        .columns
                        .iter()
                        .position(|candidate| candidate == column)
                        .and_then(|index| entry.column_types.get(index).cloned())
                        .unwrap_or_default()
                })
                .collect();

            Some(RelevantTable {
                table_name: entry.name.clone(),
                columns,
                column_types,
                total_columns: entry.columns.len(),
                kind: entry.kind.clone(),
                row_count: entry.row_count,
                primary_key: entry.primary_key.clone(),
            })
        })
        .collect();

    RelevantSchema {
        latest_user_message: latest,
        tokens,
        unknown_tokens,
        total_tables: entries.len(),
        requested_columns,
        learned_hints,
        discovery_hints,
        relevant_tables,
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn sql_dialect_rules(connection_type: &str) -> Vec<&'static str> {
    match connection_type {
        "mssql" => vec![
            "Dialect rules: this is Microsoft SQL Server.",
            "Use SELECT TOP (n) for row limits. Never use LIMIT.",
            "Use schema-qualified table names when available.",
            "Do not use PostgreSQL or SQLite-only syntax.",
        ],
        "postgres" => vec![
            "Dialect rules: this is PostgreSQL.",
            "LIMIT is allowed.",
            "Use double quotes only when needed for identifiers.",
        ],
        _ => vec!["Dialect rules: use syntax valid for the current database type only."],
    }
}

pub(crate) fn is_read_only_sql(sql: &str) -> bool {
    let text = sql.trim();
    if text.is_empty() {
        return false;
    }

    let without_comments = block_comment_re().replace_all(text, " ");
    let without_comments = line_comment_re().replace_all(&without_comments, " ");
    let without_comments = without_comments.trim();

    read_only_start_re().is_match(without_comments) && !write_keyword_re().is_match(without_comments)
}

fn normalize_schema_identifier(value: &str) -> String {
    strip_identifier_quotes(value).trim().to_lowercase()
}

struct SqlValidation {
    valid: bool,
    unknown_tables: Vec<String>,
    issues: Vec<String>,
}

fn validate_generated_sql(sql: &str, schema: &Schema, connection_type: &str, requested_columns: &[String]) -> SqlValidation {
    let referenced = extract_referenced_tables(sql);
    let mut issues = Vec::new();
    if !is_read_only_sql(sql) {
        issues.push("Only read-only SQL is allowed. Use SELECT/WITH/SHOW/DESCRIBE/PRAGMA and avoid write operations.".to_string());
    }
    if referenced.is_empty() {
        return SqlValidation {
            valid: true,
            unknown_tables: Vec::new(),
            issues,
        };
    }

    let forbidden = referenced
        .iter()
        .filter(|table| is_forbidden_ai_table(&normalize_schema_identifier(table)))
        .cloned()
        .collect::<Vec<_>>();
    let available = schema
        .iter()
        .filter(|entry| !is_forbidden_ai_table(&entry.name))
        .map(|entry| normalize_schema_identifier(&entry.name))
        .collect::<Vec<_>>();
    let unknown = referenced
        .iter()
        .filter(|table| !available.contains(&normalize_schema_identifier(table)))
        .cloned()
        .collect::<Vec<_>>();

    if connection_type == "mssql" && limit_re().is_match(sql) {
        issues.push("SQL Server does not support LIMIT; use TOP instead.".into());
    }

    if !requested_columns.is_empty() && select_star_re().is_match(sql) {
        issues.push(format!(
            "The user asked for specific columns ({}), so SELECT * is too broad.",
            requested_columns.join(", ")
        ));
    }

    if !requested_columns.is_empty() {
        let normalized_sql = normalize_search_token(sql);
        let all_missing = requested_columns
            .iter()
            .all(|column| !normalized_sql.contains(&normalize_search_token(column)));
        if all_missing {
            issues.push(format!(
                "The SQL does not include the requested column(s): {}.",
                requested_columns.join(", ")
            ));
        }
    }

    let valid = unknown.is_empty() && forbidden.is_empty() && issues.is_empty();
    let mut unknown_tables = unknown;
    unknown_tables.extend(forbidden);

    SqlValidation {
        valid,
        unknown_tables,
        issues,
    }
}

fn validate_restricted_pii_projection(sql: &str) -> Vec<String> {
    let clause = extract_select_clause(sql).to_lowercase();
    if clause.is_empty() {
        return Vec::new();
    }

    if clause == "*" {
        return vec!["SELECT * is not allowed for AI-generated SQL because restricted PII fields might be exposed.".into()];
    }

    static BLOCKED: OnceLock<Vec<Regex>> = OnceLock::new();
    let blocked = BLOCKED.get_or_init(|| {
        ["dateofbirth", "birthdate", "dob", "ssn", "socialsecurity", "driverslicense", "taxpayerid", "medical"]
            .iter()
            .map(|token| Regex::new(&format!(r"(?i)\b{}\b", token)).expect("static regex is valid"))
            .collect()
    });

    if blocked.iter().any(|pattern| pattern.is_match(&clause)) {
        return vec!["Restricted PII fields (including DOB/BirthDate) cannot be returned in SELECT output. They may be used only for filtering or age calculations.".into()];
    }

    Vec::new()
}

// ---------------------------------------------------------------------------
// Database documentation
// ---------------------------------------------------------------------------

/// The bundled docs folder. A dev build runs from `target/`, where Tauri may
/// not have copied resources yet, so the source tree is the fallback.
fn ai_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("ai");
        if bundled.join("schema_docs").is_dir() {
            return Some(bundled);
        }
    }

    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ai");
    source.join("schema_docs").is_dir().then_some(source)
}

#[derive(Clone)]
struct SchemaDocs {
    database: String,
    root: PathBuf,
    manifest: Option<Value>,
    playbook: String,
}

fn normalize_database_name(value: &str) -> String {
    value.trim().to_uppercase()
}

fn trim_doc_text(value: &str, max_chars: usize) -> String {
    let text = value.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head = text.chars().take(max_chars - 3).collect::<String>();
    format!("{}...", head.trim_end())
}

fn docs_database_root(app: &AppHandle, database: &str) -> Option<PathBuf> {
    let docs_root = ai_resource_dir(app)?.join("schema_docs");
    let direct = docs_root.join(database);
    if direct.is_dir() {
        return Some(direct);
    }

    let manifest = fs::read_to_string(docs_root.join("portable_manifest.json")).ok()?;
    let manifest = serde_json::from_str::<Value>(&manifest).ok()?;
    (normalize_database_name(manifest["database"].as_str().unwrap_or_default()) == database).then_some(docs_root)
}

fn load_schema_docs(app: &AppHandle, database_name: &str) -> Option<SchemaDocs> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<SchemaDocs>>>> = OnceLock::new();
    let database = normalize_database_name(database_name);
    if database.is_empty() {
        return None;
    }

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().ok().and_then(|cache| cache.get(&database).cloned()) {
        return cached;
    }

    let docs = docs_database_root(app, &database).map(|root| SchemaDocs {
        manifest: fs::read_to_string(root.join("portable_manifest.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok()),
        playbook: fs::read_to_string(root.join("query_playbook.md")).unwrap_or_default(),
        database: database.clone(),
        root,
    });

    if let Ok(mut cache) = cache.lock() {
        cache.insert(database, docs.clone());
    }
    docs
}

fn table_doc_snippet(root: &std::path::Path, doc_path: &str) -> String {
    if doc_path.is_empty() {
        return String::new();
    }
    let relative = doc_path.strip_prefix("schema_docs/").unwrap_or(doc_path);
    fs::read_to_string(root.join(relative))
        .map(|raw| trim_doc_text(&raw, TABLE_DOC_CHARS))
        .unwrap_or_default()
}

/// Only the playbook recipes that share words with the question. Sending the
/// whole playbook every time was most of the prompt and most of the wait.
fn select_playbook_sections(playbook: &str, tokens: &[String]) -> String {
    let mut sections: Vec<String> = Vec::new();
    for line in playbook.lines() {
        if line.starts_with("## ") || sections.is_empty() {
            sections.push(String::new());
        }
        if let Some(section) = sections.last_mut() {
            section.push_str(line);
            section.push('\n');
        }
    }

    let meaningful = tokens
        .iter()
        .filter(|token| token.len() >= 3)
        .map(|token| token.to_lowercase())
        .collect::<Vec<_>>();

    let mut scored = sections
        .iter()
        .enumerate()
        .filter(|(_, section)| section.starts_with("## "))
        .map(|(index, section)| {
            let lower = section.to_lowercase();
            let score = meaningful.iter().filter(|token| lower.contains(token.as_str())).count();
            (index, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));

    let mut picked = scored
        .into_iter()
        .take(PLAYBOOK_SECTION_LIMIT)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    picked.sort_unstable();

    let joined = picked
        .into_iter()
        .map(|index| sections[index].trim().to_string())
        .collect::<Vec<_>>()
        .join("\n\n");
    trim_doc_text(&joined, PLAYBOOK_CHAR_BUDGET)
}

fn build_schema_docs_context(app: &AppHandle, database_name: &str, relevant: &RelevantSchema) -> String {
    let Some(docs) = load_schema_docs(app, database_name) else {
        return String::new();
    };
    if docs.manifest.is_none() && docs.playbook.is_empty() {
        return String::new();
    }

    let manifest = docs.manifest.clone().unwrap_or(Value::Null);
    let string_list = |value: &Value, limit: usize| -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .take(limit)
                    .map(|item| item.as_str().map(str::to_string).unwrap_or_else(|| item.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };

    let playbook = select_playbook_sections(&docs.playbook, &relevant.tokens);
    let retrieval_strategy = string_list(&manifest["retrievalStrategy"], 6)
        .into_iter()
        .map(|entry| format!("- {}", entry))
        .collect::<Vec<_>>()
        .join("\n");

    let table_index = manifest["tables"].as_array().cloned().unwrap_or_default();
    let relevant_docs = relevant
        .relevant_tables
        .iter()
        .filter_map(|table| {
            let wanted = table.table_name.to_uppercase();
            table_index
                .iter()
                .find(|entry| entry["qualifiedName"].as_str().unwrap_or_default().to_uppercase() == wanted)
        })
        .take(TABLE_DOC_LIMIT)
        .map(|entry| {
            let usage_notes = string_list(&entry["usageNotes"], 3);
            let joins = string_list(&entry["conventionalJoins"], 2);
            let snippet = table_doc_snippet(&docs.root, entry["docPath"].as_str().unwrap_or_default());
            let summary = entry["summary"].as_str().unwrap_or_default();

            [
                format!("Table: {}", entry["qualifiedName"].as_str().unwrap_or_default()),
                if summary.is_empty() { String::new() } else { format!("Summary: {}", summary) },
                if usage_notes.is_empty() {
                    String::new()
                } else {
                    format!("Usage Notes: {}", usage_notes.join(" | "))
                },
                if joins.is_empty() {
                    String::new()
                } else {
                    format!("Conventional Joins: {}", joins.join(" | "))
                },
                if snippet.is_empty() { String::new() } else { format!("Reference:\n{}", snippet) },
            ]
            .into_iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
        })
        .collect::<Vec<_>>();

    [
        "========================".to_string(),
        format!("DATABASE DOCUMENTATION ({})", docs.database),
        "========================".to_string(),
        if retrieval_strategy.is_empty() {
            String::new()
        } else {
            format!("Retrieval Strategy:\n{}", retrieval_strategy)
        },
        if playbook.is_empty() {
            String::new()
        } else {
            format!("Query Playbook (sections matching this request):\n{}", playbook)
        },
        if relevant_docs.is_empty() {
            String::new()
        } else {
            format!("Relevant Table Docs:\n\n{}", relevant_docs.join("\n\n"))
        },
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

fn build_organization_alias_context(database_name: &str) -> String {
    if normalize_database_name(database_name) != "CATSDEV" {
        return String::new();
    }

    [
        "ORGANIZATION ALIASES",
        "In CATSDEV, CMS and Medicare can refer to the organization as a whole.",
        "CMS is an agency under HHS.",
        "Do not assume a bare mention of CMS or Medicare means a narrower Division, Group, Office, or ComponentAcronym filter.",
        "If the user is asking for an organization-wide employee category, do not invent a CMS component filter unless the user explicitly asks for CMS-scoped component membership.",
    ]
    .join("\n")
}

/// Real Echelon paths (e.g. /OIT/IUSG/DASM) show the model how component
/// acronyms nest, which it cannot infer from column names alone.
async fn build_employee_echelon_context(
    app: &AppHandle,
    connection_id: &str,
    connection_type: &str,
    database_name: &str,
    schema: &Schema,
    conversation: &[ChatMessage],
) -> String {
    if normalize_database_name(database_name) != "CATSDEV" {
        return String::new();
    }

    let user_text = user_intent_text(conversation).to_lowercase();
    if !user_requested_employees_by_component(conversation) && !echelon_intent_re().is_match(&user_text) {
        return String::new();
    }

    let Some(employee) = find_schema_table_by_base_name(schema, "HR_Employee") else {
        return String::new();
    };
    let Some(echelon_column) = find_column_name(&employee.columns, "Echelon") else {
        return String::new();
    };

    let sql = if connection_type == "mssql" {
        format!(
            "SELECT DISTINCT TOP ({limit}) {col} AS Echelon FROM {table} WHERE {col} IS NOT NULL AND LEN(LTRIM(RTRIM({col}))) > 0 ORDER BY {col}",
            limit = ECHELON_SNAPSHOT_LIMIT,
            col = echelon_column,
            table = employee.name
        )
    } else {
        format!(
            "SELECT DISTINCT {col} AS Echelon FROM {table} WHERE {col} IS NOT NULL AND LENGTH(TRIM({col})) > 0 ORDER BY {col} LIMIT {limit}",
            limit = ECHELON_SNAPSHOT_LIMIT,
            col = echelon_column,
            table = employee.name
        )
    };

    let Ok(result) = run_sql_query(app.clone(), Some(connection_id.to_string()), sql).await else {
        return String::new();
    };
    let Some(column_index) = result
        .columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case("echelon"))
    else {
        return String::new();
    };

    let echelons = result
        .rows
        .iter()
        .filter_map(|row| row.get(column_index))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("null"))
        .take(ECHELON_SNAPSHOT_LIMIT)
        .collect::<Vec<_>>();
    if echelons.is_empty() {
        return String::new();
    }

    let mut lines = vec![
        "ECHELON HIERARCHY SNAPSHOT".to_string(),
        format!("Distinct values from {}.{}:", employee.name, echelon_column),
    ];
    lines.extend(echelons.into_iter().map(|value| format!("- {}", value)));
    lines.push("Treat each Echelon value as a hierarchy path example that shows related component acronyms in one chain.".into());
    lines.push("Example: if an Echelon looks like /OIT/IUSG/DASM, use that as evidence that OIT, IUSG, and DASM belong to the same hierarchy path.".into());
    lines.push("Use this snapshot to understand higher-level and lower-level component relationships before asking the user to clarify level names.".into());
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const STRICT_GLOBAL_PROMPT: &str = include_str!("../resources/ai/prompts/strict_global_prompt.txt");
const SQL_PLANNING_PROMPT: &str = include_str!("../resources/ai/prompts/sql_planning_prompt.txt");

struct PromptContext<'a> {
    connection_id: &'a str,
    connection_type: &'a str,
    database_name: &'a str,
    relevant: &'a RelevantSchema,
    relations: &'a [ProbeRelation],
    current_query: &'a str,
    echelon_context: &'a str,
    docs_context: String,
}

fn build_ai_system_prompt(context: &PromptContext) -> String {
    let relevant = context.relevant;
    let current_query_text = if context.current_query.is_empty() {
        "Current query box contents: empty".to_string()
    } else {
        format!("Current query box contents:\n{}", context.current_query)
    };
    let requested_column_text = if relevant.requested_columns.is_empty() {
        "User-requested columns or fields: none explicitly named".to_string()
    } else {
        format!("User-requested columns or fields: {}", relevant.requested_columns.join(", "))
    };
    let revealed_tables = relevant
        .relevant_tables
        .iter()
        .map(|table| table.table_name.as_str())
        .collect::<Vec<_>>();
    let hints_json = |hints: &[SchemaHint]| {
        let focused = hints
            .iter()
            .filter_map(|hint| {
                let tables = hint
                    .tables
                    .iter()
                    .filter(|table| revealed_tables.contains(&table.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                if tables.is_empty() {
                    return None;
                }
                let columns = hint
                    .columns
                    .iter()
                    .filter(|column| {
                        !column.contains('.')
                            || tables.iter().any(|table| column.starts_with(&format!("{}.", table)))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                Some(SchemaHint {
                    token: hint.token.clone(),
                    tables,
                    columns,
                })
            })
            .take(PROMPT_HINT_LIMIT)
            .collect::<Vec<_>>();
        if focused.is_empty() {
            "none".to_string()
        } else {
            serde_json::to_string(&focused).unwrap_or_else(|_| "none".into())
        }
    };
    let optional_block = |text: &str| {
        if text.is_empty() {
            String::new()
        } else {
            format!("{}\n\n", text)
        }
    };
    let or_none = |values: &[String]| {
        if values.is_empty() {
            "none".to_string()
        } else {
            values.join(", ")
        }
    };

    SQL_PLANNING_PROMPT
        .replace("{{CONNECTION_ID}}", context.connection_id)
        .replace("{{CONNECTION_TYPE}}", context.connection_type)
        .replace(
            "{{DATABASE_LINE}}",
            &if context.database_name.is_empty() {
                String::new()
            } else {
                format!("Database: {}", context.database_name)
            },
        )
        .replace("{{CURRENT_QUERY}}", &current_query_text)
        .replace("{{TOTAL_TABLES}}", &relevant.total_tables.to_string())
        .replace(
            "{{LATEST_USER_MESSAGE}}",
            if relevant.latest_user_message.is_empty() { "n/a" } else { &relevant.latest_user_message },
        )
        .replace("{{SEARCH_TOKENS}}", &or_none(&relevant.tokens))
        .replace("{{UNKNOWN_TOKENS}}", &or_none(&relevant.unknown_tokens))
        .replace("{{REQUESTED_COLUMNS}}", &requested_column_text)
        .replace("{{LEARNED_HINTS}}", &hints_json(&relevant.learned_hints))
        .replace("{{DISCOVERY_HINTS}}", &hints_json(&relevant.discovery_hints))
        .replace(
            "{{ORGANIZATION_ALIASES}}",
            &optional_block(&build_organization_alias_context(context.database_name)),
        )
        .replace("{{ECHELON_CONTEXT}}", &optional_block(context.echelon_context))
        .replace("{{SCHEMA_DOCS}}", &optional_block(&context.docs_context))
        .replace(
            "{{SCHEMA_EXCERPT}}",
            &render_schema_excerpt(&relevant.relevant_tables, context.relations),
        )
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

fn describe_connection(app: &AppHandle, connection_id: &str) -> Result<(String, String), String> {
    Ok(match resolve_query_target(app, connection_id)? {
        QueryTarget::Sqlite { .. } => ("sqlite".into(), String::new()),
        QueryTarget::Mssql { preset, .. } => ("mssql".into(), normalize_database_name(&preset.database)),
        QueryTarget::Postgres { preset, .. } => ("postgres".into(), normalize_database_name(&preset.database)),
    })
}

fn normalize_run_query_text(text: &str) -> String {
    text.replace(['\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'], "'")
        .replace(['\u{201C}', '\u{201D}', '\u{201E}', '\u{201F}'], "\"")
}

pub(crate) async fn run_ai_assist(app: AppHandle, request: AiAssistRequest) -> Result<AiDecision, String> {
    let status = ollama_status().await;
    if !status.online {
        return Err("Ollama is offline. Start Ollama and try again.".into());
    }

    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
        .or(status.default_model.clone())
        .ok_or_else(|| "No Ollama models are available.".to_string())?;
    if !status.models.iter().any(|entry| entry.name == model) {
        return Err(format!("Selected Ollama model is unavailable: {}", model));
    }

    let connection_id = normalize_connection_id(request.connection_id.as_deref()).to_string();
    let (connection_type, database_name) = describe_connection(&app, &connection_id)?;
    let (schema, relations) = load_schema(&app, &connection_id).await?;
    let current_query = normalize_run_query_text(request.current_query.as_deref().unwrap_or_default());
    let conversation = normalize_conversation(&request.conversation);

    let mut decision = ask_ollama_for_sql(
        &app,
        &model,
        &connection_id,
        &connection_type,
        &database_name,
        &schema,
        &relations,
        &conversation,
        current_query.trim(),
    )
    .await?;
    decision.model = model.clone();

    crate::write_app_log(
        &app,
        "ai.assist",
        &format!(
            "{} for {} using {}",
            if decision.status == "ready" { "AI generated SQL" } else { "AI asked for clarification" },
            connection_id,
            model
        ),
    );

    Ok(decision)
}

#[allow(clippy::too_many_arguments)]
async fn ask_ollama_for_sql(
    app: &AppHandle,
    model: &str,
    connection_id: &str,
    connection_type: &str,
    database_name: &str,
    schema: &Schema,
    relations: &[ProbeRelation],
    conversation: &[ChatMessage],
    current_query: &str,
) -> Result<AiDecision, String> {
    let relevant = build_relevant_schema_subset(app, schema, conversation);
    let echelon_context =
        build_employee_echelon_context(app, connection_id, connection_type, database_name, schema, conversation).await;

    let system_prompt = format!(
        "{}\n\n========================\nSQL PLANNING CONTEXT\n========================\n{}",
        STRICT_GLOBAL_PROMPT,
        build_ai_system_prompt(&PromptContext {
            connection_id,
            connection_type,
            database_name,
            relevant: &relevant,
            relations,
            current_query,
            echelon_context: &echelon_context,
            docs_context: build_schema_docs_context(app, database_name, &relevant),
        })
    );

    crate::write_app_log(
        app,
        "ai.prompt",
        &format!(
            "Prompt for {}: {} chars, {} table(s): {}",
            connection_id,
            system_prompt.chars().count(),
            relevant.relevant_tables.len(),
            relevant
                .relevant_tables
                .iter()
                .map(|table| table.table_name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );

    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: system_prompt,
    }];
    messages.extend(conversation.iter().cloned());

    let mut decision = request_ai_decision(model, &messages).await?;

    if decision.is_ready_with_sql() {
        let validation = validate_generated_sql(&decision.sql, schema, connection_type, &relevant.requested_columns);
        let pii_issues = validate_restricted_pii_projection(&decision.sql);

        if !validation.valid || !pii_issues.is_empty() {
            let issue_line = |label: &str, issues: &[String]| {
                if issues.is_empty() {
                    format!("{}: none", label)
                } else {
                    format!("{}: {}", label, issues.join(" "))
                }
            };

            let mut repair = vec![
                "Your previous SQL does not satisfy the real schema or dialect requirements.".to_string(),
                if validation.unknown_tables.is_empty() {
                    "Unknown or forbidden table references: none".to_string()
                } else {
                    format!("Unknown or forbidden table references: {}", validation.unknown_tables.join(", "))
                },
                issue_line("Additional SQL issues", &validation.issues),
                issue_line("PII projection issues", &pii_issues),
                "Rewrite the SQL using only these exact available tables and their exact columns:".to_string(),
                render_schema_excerpt(&relevant.relevant_tables, relations),
                "For age questions (for example over 55 years old), do not use CareerStartDate/HireDate/StartDate as age proxies. Use DateOfBirth/BirthDate (or an explicit Age column) when available.".to_string(),
                "DOB/BirthDate may be used in filters and age calculations, but must not be returned in SELECT output.".to_string(),
                if relevant.requested_columns.is_empty() {
                    "The user did not explicitly ask for a named field.".to_string()
                } else {
                    format!(
                        "The user explicitly asked for these fields, so include them if they exist: {}",
                        relevant.requested_columns.join(", ")
                    )
                },
                "If you still cannot produce reliable SQL from this real schema subset, return status \"clarify\" and ask one precise question.".to_string(),
                "Do not invent schemas, table names, columns, or joins.".to_string(),
            ];
            repair.extend(sql_dialect_rules(connection_type).into_iter().map(str::to_string));

            let mut repair_messages = messages.clone();
            repair_messages.push(ChatMessage {
                role: "assistant".into(),
                content: serde_json::to_string(&decision).unwrap_or_default(),
            });
            repair_messages.push(ChatMessage {
                role: "user".into(),
                content: repair.join("\n\n"),
            });

            decision = request_ai_decision(model, &repair_messages).await?;

            if decision.is_ready_with_sql() {
                let revalidated =
                    validate_generated_sql(&decision.sql, schema, connection_type, &relevant.requested_columns);
                let repaired_pii = validate_restricted_pii_projection(&decision.sql);
                if !revalidated.valid || !repaired_pii.is_empty() {
                    let candidates = relevant
                        .relevant_tables
                        .iter()
                        .take(5)
                        .map(|table| table.table_name.clone())
                        .collect::<Vec<_>>();
                    return Ok(AiDecision::clarify(format!(
                        "I found likely tables in this area: {}. Which one should I use for the employee lookup?",
                        candidates.join(", ")
                    )));
                }
            }
        }
    }

    if decision.status == "ready" && decision.sql.is_empty() {
        return Ok(AiDecision::clarify(
            "I could not produce SQL from that request. Please restate the result you want (for example: current employees for component acronym DASM).",
        ));
    }

    if decision.is_ready_with_sql() && !is_read_only_sql(&decision.sql) {
        return Ok(AiDecision::clarify(
            "I can only run read-only SQL in this workspace. Please restate the request as a read/report query.",
        ));
    }

    if decision.is_ready_with_sql() {
        learn_schema_hints(app, &relevant.latest_user_message, &decision.sql);
    }

    Ok(decision)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_status() -> Result<OllamaStatus, String> {
    Ok(ollama_status().await)
}

#[tauri::command]
pub async fn ai_assist(app: AppHandle, request: AiAssistRequest) -> Result<AiDecision, String> {
    run_ai_assist(app, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_guard_blocks_writes() {
        assert!(is_read_only_sql("SELECT * FROM HR.HR_Employee"));
        assert!(is_read_only_sql("-- note\nWITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_read_only_sql("DELETE FROM HR.HR_Employee"));
        assert!(!is_read_only_sql("SELECT 1; DROP TABLE x"));
    }

    #[test]
    fn identifier_parts_split_camel_and_separators() {
        assert_eq!(split_identifier_parts("HR_EmployeeName"), vec!["hr", "employee", "name"]);
    }

    #[test]
    fn decision_parses_fenced_json() {
        let decision = parse_ai_decision("```json\n{\"status\":\"ready\",\"sql\":\"SELECT 1\",\"question\":\"\",\"assumptions\":[],\"explanation\":\"x\"}\n```");
        assert_eq!(decision.status, "ready");
        assert_eq!(decision.sql, "SELECT 1");
    }

    #[test]
    fn pii_projection_is_rejected() {
        assert!(!validate_restricted_pii_projection("SELECT Moniker, DateOfBirth FROM HR.HR_Employee").is_empty());
        assert!(validate_restricted_pii_projection("SELECT Moniker FROM HR.HR_Employee WHERE DateOfBirth < '1970-01-01'").is_empty());
    }
}
