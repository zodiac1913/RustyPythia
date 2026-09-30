//! Shared, versioned knowledge about a database, stored outside that database.
//!
//! The AI window is read-only. The SQL window stays full SQL. Approved meanings ship inside the app and refresh the
//! local workspace catalog on startup. Proposals from a session stay local and
//! are not reused until a later release promotes them.

use rusqlite::{params, Connection as SqliteConnection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

use crate::{open_workspace_database, SqlQueryResult};

const SEED_JSON: &str = include_str!("../resources/ai/knowledge-seed.json");
const SEED_VERSION: i64 = 4;
pub const MIN_GROUP_SIZE: i64 = 10;

#[derive(Debug, Deserialize)]
struct SeedConcept {
    id: String,
    term: String,
    meaning: String,
    tables: Vec<String>,
    #[serde(default)]
    privacy: PrivacyRules,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct PrivacyRules {
    never_prompt: Vec<String>,
    filter_only: Vec<String>,
    aggregate_only: Vec<String>,
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let connection = open_workspace_database(app)?;
    ensure_tables(&connection)?;
    seed_approved(&connection)
}

fn ensure_tables(connection: &SqliteConnection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS ai_knowledge_concept (
                id TEXT PRIMARY KEY,
                term TEXT NOT NULL,
                meaning TEXT NOT NULL,
                tables_json TEXT NOT NULL,
                privacy_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL,
                seed_version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ai_knowledge_proposal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_id TEXT NOT NULL,
                question TEXT NOT NULL,
                sql TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'proposed',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .map_err(|err| format!("Failed to create the AI knowledge catalog: {}", err))?;
    // Existing developer databases may predate explicit privacy metadata.
    let _ = connection.execute("ALTER TABLE ai_knowledge_concept ADD COLUMN privacy_json TEXT NOT NULL DEFAULT '{}'", []);
    Ok(())
}

fn seed_approved(connection: &SqliteConnection) -> Result<(), String> {
    let concepts: Vec<SeedConcept> = serde_json::from_str(SEED_JSON).map_err(|err| format!("AI knowledge seed is invalid: {}", err))?;
    for concept in concepts {
        connection
            .execute(
                "
                INSERT INTO ai_knowledge_concept
                    (id, term, meaning, tables_json, privacy_json, status, seed_version)
                VALUES (?1, ?2, ?3, ?4, ?5, 'approved', ?6)
                ON CONFLICT(id) DO UPDATE SET
                    term = excluded.term,
                    meaning = excluded.meaning,
                    tables_json = excluded.tables_json,
                    privacy_json = excluded.privacy_json,
                    status = 'approved',
                    seed_version = excluded.seed_version
                ",
                params![
                    concept.id,
                    concept.term,
                    concept.meaning,
                    serde_json::to_string(&concept.tables).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&concept.privacy).unwrap_or_else(|_| "{}".into()),
                    SEED_VERSION,
                ],
            )
            .map_err(|err| format!("Failed to seed AI knowledge {}: {}", concept.id, err))?;
    }
    Ok(())
}

/// Approved meanings that overlap this question. Proposals are never included.
pub fn prompt_excerpt(app: &AppHandle, question: &str) -> String {
    let Ok(connection) = open_workspace_database(app) else {
        return String::new();
    };
    let _ = ensure_tables(&connection);
    let Ok(mut statement) = connection.prepare(
        "SELECT term, meaning, privacy_json
         FROM ai_knowledge_concept WHERE status = 'approved' ORDER BY term",
    ) else {
        return String::new();
    };
    let needle = question.to_lowercase();
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)));
    let Ok(rows) = rows else {
        return String::new();
    };

    let mut lines = Vec::new();
    for row in rows.flatten() {
        let (term, meaning, privacy_json) = row;
        if knowledge_term_matches(&needle, &term) {
            lines.push(format!("- {}: {}", term, meaning));
            if let Ok(privacy) = serde_json::from_str::<PrivacyRules>(&privacy_json) {
                if !privacy.never_prompt.is_empty() {
                    lines.push(format!("  Never reveal or use these columns: {}.", privacy.never_prompt.join(", ")));
                }
                if !privacy.filter_only.is_empty() {
                    lines.push(format!(
                        "  These columns may filter an aggregate but must never be returned: {}.",
                        privacy.filter_only.join(", ")
                    ));
                }
                if !privacy.aggregate_only.is_empty() {
                    lines.push(format!(
                        "  These sensitive columns may be used only in aggregates whose groups contain at least {} people: {}.",
                        MIN_GROUP_SIZE,
                        privacy.aggregate_only.join(", ")
                    ));
                }
            }
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "APPROVED BUSINESS MEANINGS\nUse only these meanings. If a term is not listed, ask instead of guessing a rule.\n{}",
        lines.join("\n")
    )
}

fn knowledge_term_matches(question: &str, term: &str) -> bool {
    let term = term.to_lowercase();
    question.contains(&term)
        || (term == "personnel action"
            && regex_is_match(r"(?i)\b(employee|staff)\s+actions?\b", question))
}

pub fn record_proposal(app: &AppHandle, connection_id: &str, question: &str, sql: &str) {
    let Ok(connection) = open_workspace_database(app) else {
        return;
    };
    if ensure_tables(&connection).is_err() {
        return;
    }
    let _ = connection.execute(
        "
        INSERT INTO ai_knowledge_proposal (connection_id, question, sql, status)
        VALUES (?1, ?2, ?3, 'proposed')
        ",
        params![connection_id, question.trim(), sql.trim()],
    );
}

pub fn statistic_issues(app: &AppHandle, sql: &str) -> Vec<String> {
    let rules = approved_privacy_rules(app);
    let mut issues = Vec::new();
    let select = crate::ai::select_clause_for_privacy(sql);
    if select.is_empty() {
        return issues;
    }
    if !regex_is_match(r"(?i)\b(count|sum|avg|min|max)\s*\(", sql) {
        issues.push("AI answers must be aggregates (COUNT, SUM, AVG, MIN, or MAX), not lists of people or rows.".into());
    }
    if !regex_is_match(r"(?i)\bcount\s*\(", &select) {
        issues.push("AI statistics must include COUNT(*) so groups smaller than 10 can be withheld.".into());
    }
    if identity_projection(&select)
        || rules
            .iter()
            .flat_map(|rule| rule.never_prompt.iter().chain(rule.filter_only.iter()))
            .any(|column| regex_is_match(&format!(r"(?i)\b{}\b", regex::escape(column)), &select))
    {
        issues.push("Names, emails, identifiers, addresses, phones, and birth dates cannot be returned.".into());
    }
    issues
}

fn approved_privacy_rules(app: &AppHandle) -> Vec<PrivacyRules> {
    let Ok(connection) = open_workspace_database(app) else {
        return Vec::new();
    };
    let _ = ensure_tables(&connection);
    let Ok(mut statement) = connection.prepare("SELECT privacy_json FROM ai_knowledge_concept WHERE status = 'approved'") else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten().filter_map(|json| serde_json::from_str::<PrivacyRules>(&json).ok()).collect()
}

/// Columns too dangerous to reveal to the model at all, keyed by table.
pub fn never_prompt_columns(app: &AppHandle) -> HashMap<String, Vec<String>> {
    let Ok(connection) = open_workspace_database(app) else {
        return HashMap::new();
    };
    let _ = ensure_tables(&connection);
    let Ok(mut statement) = connection.prepare(
        "SELECT tables_json, privacy_json
         FROM ai_knowledge_concept WHERE status = 'approved'",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else {
        return HashMap::new();
    };

    let mut result = HashMap::new();
    for (tables_json, privacy_json) in rows.flatten() {
        let tables = serde_json::from_str::<Vec<String>>(&tables_json).unwrap_or_default();
        let privacy = serde_json::from_str::<PrivacyRules>(&privacy_json).unwrap_or_default();
        for table in tables {
            result.entry(table).or_insert_with(Vec::new).extend(privacy.never_prompt.iter().cloned());
        }
    }
    result
}

fn identity_projection(select_clause: &str) -> bool {
    [
        "firstname",
        "lastname",
        "middlename",
        "fullname",
        "email",
        "moniker",
        "phone",
        "address",
        "birthdate",
        "dateofbirth",
        "dob",
        "ssn",
        "personnelnumber",
        "userid",
        "username",
    ]
    .iter()
    .any(|token| regex_is_match(&format!(r"(?i)\b{}\b", token), select_clause))
}

fn regex_is_match(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).map(|pattern| pattern.is_match(value)).unwrap_or(false)
}

/// Drops groups smaller than the minimum. A count of 3 is itself identifying.
pub fn suppress_small_groups(result: SqlQueryResult, sql: &str) -> SqlQueryResult {
    let indexes = count_projection_indexes(sql);
    if indexes.is_empty() {
        return result;
    }

    let mut kept = Vec::new();
    let mut withheld = 0usize;
    for row in result.rows {
        let small = indexes.iter().any(|index| {
            row.get(*index)
                .and_then(|value| value.replace(',', "").parse::<i64>().ok())
                .is_some_and(|value| (0..MIN_GROUP_SIZE).contains(&value))
        });
        if small {
            withheld += 1;
        } else {
            kept.push(row);
        }
    }

    if withheld == 0 {
        return SqlQueryResult { rows: kept, ..result };
    }

    if kept.is_empty() {
        return SqlQueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            message: format!("Result withheld. A group smaller than {} could identify someone.", MIN_GROUP_SIZE),
            ..result
        };
    }

    SqlQueryResult {
        rows: kept,
        message: format!("{} group(s) withheld because they were smaller than {}.", withheld, MIN_GROUP_SIZE),
        ..result
    }
}

fn count_projection_indexes(sql: &str) -> Vec<usize> {
    let clause = crate::ai::select_clause_for_privacy(sql);
    let mut expressions = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    for character in clause.chars() {
        match character {
            '(' => {
                depth += 1;
                current.push(character);
            }
            ')' => {
                depth -= 1;
                current.push(character);
            }
            ',' if depth == 0 => expressions.push(std::mem::take(&mut current)),
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        expressions.push(current);
    }
    expressions
        .iter()
        .enumerate()
        .filter(|(_, expression)| regex_is_match(r"(?i)\bcount\s*\(", expression))
        .map(|(index, _)| index)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_seed_has_explicit_pii_rules() {
        let concepts: Vec<SeedConcept> = serde_json::from_str(SEED_JSON).unwrap();
        assert_eq!(concepts.len(), 5);
        let action = concepts.iter().find(|concept| concept.id == "hr-personnel-action").unwrap();
        assert!(action.meaning.contains("NOA"));
        assert!(action.tables.iter().any(|table| table == "CORE.KeyValue"));
        assert!(action.tables.iter().any(|table| table == "CORE.KeyValueDefinition"));
        assert!(concepts.iter().all(|concept| !concept.privacy.never_prompt.is_empty()));
        assert!(concepts
            .iter()
            .flat_map(|concept| &concept.privacy.never_prompt)
            .any(|column| column == "SocialSecurityNumber"));
    }

    #[test]
    fn employee_action_wording_matches_personnel_action_knowledge() {
        assert!(knowledge_term_matches(
            "how many employee actions of pay adjustments were made in 2025",
            "personnel action"
        ));
    }

    #[test]
    fn static_identity_projection_is_rejected() {
        assert!(!identity_projection("COUNT(*) AS EmployeeCount"));
        assert!(identity_projection("FirstName"));
        assert!(identity_projection("LastName, COUNT(*) AS EmployeeCount"));
        assert_eq!(
            count_projection_indexes("SELECT Component, COUNT(*) AS Whatever FROM HR.HR_Employee GROUP BY Component"),
            vec![1]
        );
    }

    #[test]
    fn small_groups_are_withheld() {
        let result = SqlQueryResult {
            connection_id: "x".into(),
            connection_label: "x".into(),
            columns: vec!["Component".into(), "EmployeeCount".into()],
            rows: vec![vec!["A".into(), "4".into()], vec!["B".into(), "25".into()]],
            rows_affected: 2,
            message: String::new(),
        };
        let suppressed = suppress_small_groups(
            result,
            "SELECT Component, COUNT(*) AS Whatever FROM HR.HR_Employee GROUP BY Component",
        );
        assert_eq!(suppressed.rows.len(), 1);
        assert!(suppressed.message.contains("withheld"));
    }
}
