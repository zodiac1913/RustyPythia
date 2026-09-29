//! A cached catalog of every table, column, key and relationship in a
//! database, so the AI can reason about a large schema without re-reading it
//! on every question.
//!
//! The catalog lives in the workspace SQLite database. Each probe compares a
//! per-table change marker (MSSQL `modify_date`, the SQLite `CREATE` text) and
//! only re-reads the columns of tables that changed; keys, relationships and
//! row counts are cheap whole-database queries and are refreshed every time.

use rusqlite::{params, Connection as SqliteConnection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::AppHandle;

use crate::{
    execute_mssql_query, execute_postgres_query, load_preset_store, normalize_connection_id,
    open_workspace_database, resolve_query_target, write_app_log, QueryTarget, INTERNAL_CONNECTION_ID,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTable {
    pub name: String,
    pub kind: String,
    pub row_count: Option<i64>,
    pub primary_key: Vec<String>,
    pub columns: Vec<ProbeColumn>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRelation {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
    /// Not enforced by the database; derived from a column that matches
    /// another table's single-column primary key.
    pub inferred: bool,
}

#[derive(Debug, Clone)]
pub struct Probe {
    pub tables: Vec<ProbeTable>,
    pub relations: Vec<ProbeRelation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSummary {
    connection_id: String,
    table_count: usize,
    changed_tables: usize,
    relation_count: usize,
    duration_ms: u128,
}

/// A table as listed by the catalog, before its columns are read.
struct CatalogObject {
    /// The engine's own handle for the table: an object id or the plain name.
    key: String,
    name: String,
    kind: String,
    marker: String,
}

struct CatalogSnapshot {
    objects: Vec<CatalogObject>,
    columns: HashMap<String, Vec<ProbeColumn>>,
    primary_keys: HashMap<String, Vec<String>>,
    row_counts: HashMap<String, i64>,
    foreign_keys: Vec<(String, String, String, String)>,
}

fn probe_cache() -> &'static Mutex<HashMap<String, Arc<Probe>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Probe>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Probes are serialized so the startup sweep and an AI request never read
/// and rewrite the same connection's catalog at once.
fn probe_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn ensure_probe_tables(connection: &SqliteConnection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS schema_probe_table (
                connection_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                kind TEXT NOT NULL,
                modified_marker TEXT NOT NULL,
                row_count INTEGER,
                primary_key TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (connection_id, table_name)
            );
            CREATE TABLE IF NOT EXISTS schema_probe_column (
                connection_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                column_name TEXT NOT NULL,
                data_type TEXT NOT NULL,
                is_nullable INTEGER NOT NULL,
                PRIMARY KEY (connection_id, table_name, ordinal)
            );
            CREATE TABLE IF NOT EXISTS schema_probe_relation (
                connection_id TEXT NOT NULL,
                from_table TEXT NOT NULL,
                from_column TEXT NOT NULL,
                to_table TEXT NOT NULL,
                to_column TEXT NOT NULL,
                inferred INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS schema_probe_relation_connection
                ON schema_probe_relation (connection_id);
            CREATE TABLE IF NOT EXISTS schema_probe_run (
                connection_id TEXT PRIMARY KEY,
                probed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                table_count INTEGER NOT NULL,
                changed_count INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL
            );
            ",
        )
        .map_err(|err| format!("Failed to prepare schema probe tables: {}", err))
}

fn is_null_cell(value: &str) -> bool {
    value.is_empty() || value.eq_ignore_ascii_case("null")
}

// ---------------------------------------------------------------------------
// Catalog readers
// ---------------------------------------------------------------------------

fn mssql_type_label(type_name: &str, max_length: &str, precision: &str, scale: &str) -> String {
    let length = max_length.parse::<i64>().unwrap_or(0);
    match type_name {
        "varchar" | "char" | "varbinary" | "binary" => {
            if length < 0 {
                format!("{}(max)", type_name)
            } else {
                format!("{}({})", type_name, length)
            }
        }
        // max_length is in bytes; Unicode types store two bytes per character.
        "nvarchar" | "nchar" => {
            if length < 0 {
                format!("{}(max)", type_name)
            } else {
                format!("{}({})", type_name, length / 2)
            }
        }
        "decimal" | "numeric" => format!("{}({},{})", type_name, precision, scale),
        _ => type_name.to_string(),
    }
}

async fn mssql_rows(preset: &crate::ConnectionPreset, sql: &str) -> Result<Vec<Vec<String>>, String> {
    Ok(execute_mssql_query(preset, "probe", "probe", sql, true).await?.rows)
}

async fn read_mssql_catalog(
    preset: &crate::ConnectionPreset,
    stored_markers: &HashMap<String, String>,
) -> Result<CatalogSnapshot, String> {
    let objects = mssql_rows(
        preset,
        "
        SELECT CAST(o.object_id AS varchar(20)), s.name, o.name, o.type,
               CONVERT(varchar(33), o.modify_date, 126)
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        ",
    )
    .await?
    .into_iter()
    .filter(|row| row.len() >= 5)
    .map(|row| CatalogObject {
        key: row[0].clone(),
        name: format!("{}.{}", row[1], row[2]),
        kind: if row[3].trim() == "V" { "view" } else { "table" }.into(),
        marker: row[4].clone(),
    })
    .collect::<Vec<_>>();

    let changed_ids = objects
        .iter()
        .filter(|object| stored_markers.get(&object.name) != Some(&object.marker))
        .map(|object| object.key.clone())
        .collect::<Vec<_>>();

    let mut columns: HashMap<String, Vec<ProbeColumn>> = HashMap::new();
    // IN lists are chunked; a single statement with thousands of ids is slow
    // to parse and can hit the parameter-size ceiling.
    for chunk in changed_ids.chunks(250) {
        let sql = format!(
            "
            SELECT CAST(c.object_id AS varchar(20)), c.name, t.name,
                   CAST(c.max_length AS varchar(10)), CAST(c.precision AS varchar(10)),
                   CAST(c.scale AS varchar(10)), CAST(c.is_nullable AS varchar(1))
            FROM sys.columns c
            JOIN sys.types t ON t.user_type_id = c.user_type_id
            WHERE c.object_id IN ({})
            ORDER BY c.object_id, c.column_id
            ",
            chunk.join(",")
        );
        for row in mssql_rows(preset, &sql).await? {
            if row.len() < 7 {
                continue;
            }
            columns.entry(row[0].clone()).or_default().push(ProbeColumn {
                name: row[1].clone(),
                data_type: mssql_type_label(&row[2], &row[3], &row[4], &row[5]),
                nullable: row[6].trim() == "1" || row[6].eq_ignore_ascii_case("true"),
            });
        }
    }

    let mut primary_keys: HashMap<String, Vec<String>> = HashMap::new();
    for row in mssql_rows(
        preset,
        "
        SELECT CAST(i.object_id AS varchar(20)), c.name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1
        ORDER BY i.object_id, ic.key_ordinal
        ",
    )
    .await?
    {
        if row.len() >= 2 {
            primary_keys.entry(row[0].clone()).or_default().push(row[1].clone());
        }
    }

    let foreign_keys = mssql_rows(
        preset,
        "
        SELECT CAST(fk.parent_object_id AS varchar(20)), pc.name,
               CAST(fk.referenced_object_id AS varchar(20)), rc.name
        FROM sys.foreign_key_columns fk
        JOIN sys.columns pc ON pc.object_id = fk.parent_object_id AND pc.column_id = fk.parent_column_id
        JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fk.referenced_column_id
        ",
    )
    .await?
    .into_iter()
    .filter(|row| row.len() >= 4)
    .map(|row| (row[0].clone(), row[1].clone(), row[2].clone(), row[3].clone()))
    .collect();

    let row_counts = mssql_rows(
        preset,
        "
        SELECT CAST(p.object_id AS varchar(20)), CAST(SUM(p.rows) AS varchar(20))
        FROM sys.partitions p
        WHERE p.index_id IN (0, 1)
        GROUP BY p.object_id
        ",
    )
    .await?
    .into_iter()
    .filter_map(|row| Some((row.first()?.clone(), row.get(1)?.parse::<i64>().ok()?)))
    .collect();

    Ok(CatalogSnapshot {
        objects,
        columns,
        primary_keys,
        row_counts,
        foreign_keys,
    })
}

fn read_postgres_catalog(preset: &crate::ConnectionPreset) -> Result<CatalogSnapshot, String> {
    let rows = |sql: &str| -> Result<Vec<Vec<String>>, String> {
        Ok(execute_postgres_query(preset, "probe", "probe", sql, true)?.rows)
    };
    const RELATIONS: &str = "
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'v', 'm', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
    ";

    // Postgres keeps no per-table modification time, and its catalogs are
    // cheap to read, so every table is treated as changed.
    let objects = rows(&format!(
        "SELECT c.oid::text, n.nspname, c.relname, c.relkind::text {}",
        RELATIONS
    ))?
    .into_iter()
    .filter(|row| row.len() >= 4)
    .map(|row| CatalogObject {
        key: row[0].clone(),
        // public is on the default search path, so its tables are written bare.
        name: if row[1] == "public" {
            row[2].clone()
        } else {
            format!("{}.{}", row[1], row[2])
        },
        kind: if matches!(row[3].as_str(), "v" | "m") { "view" } else { "table" }.into(),
        marker: String::new(),
    })
    .collect::<Vec<_>>();

    let mut columns: HashMap<String, Vec<ProbeColumn>> = HashMap::new();
    for row in rows(&format!(
        "SELECT c.oid::text, a.attname, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE a.attnum > 0 AND NOT a.attisdropped
           AND c.relkind IN ('r', 'v', 'm', 'p')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'
         ORDER BY c.oid, a.attnum"
    ))? {
        if row.len() >= 4 {
            columns.entry(row[0].clone()).or_default().push(ProbeColumn {
                name: row[1].clone(),
                data_type: row[2].clone(),
                nullable: row[3] == "true",
            });
        }
    }

    let mut primary_keys: HashMap<String, Vec<String>> = HashMap::new();
    let mut foreign_keys = Vec::new();
    for row in rows(
        "SELECT con.conrelid::text, con.contype::text, a.attname, con.confrelid::text, af.attname
         FROM pg_constraint con
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         LEFT JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = k.fattnum
         WHERE con.contype IN ('p', 'f')
         ORDER BY con.oid, k.ord",
    )? {
        if row.len() < 5 {
            continue;
        }
        if row[1] == "p" {
            primary_keys.entry(row[0].clone()).or_default().push(row[2].clone());
        } else if !is_null_cell(&row[4]) {
            foreign_keys.push((row[0].clone(), row[2].clone(), row[3].clone(), row[4].clone()));
        }
    }

    let row_counts = rows(&format!("SELECT c.oid::text, c.reltuples::bigint::text {}", RELATIONS))?
        .into_iter()
        // reltuples is -1 until the table has been analyzed.
        .filter_map(|row| Some((row.first()?.clone(), row.get(1)?.parse::<i64>().ok().filter(|count| *count >= 0)?)))
        .collect();

    Ok(CatalogSnapshot {
        objects,
        columns,
        primary_keys,
        row_counts,
        foreign_keys,
    })
}

fn read_sqlite_catalog(
    path: &std::path::Path,
    stored_markers: &HashMap<String, String>,
) -> Result<CatalogSnapshot, String> {
    let connection = SqliteConnection::open(path)
        .map_err(|err| format!("Failed to open SQLite target {}: {}", path.display(), err))?;

    let objects = {
        let mut statement = connection
            .prepare(
                "SELECT name, type, COALESCE(sql, '') FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                   AND name NOT LIKE 'schema_probe_%'
                 ORDER BY name",
            )
            .map_err(|err| format!("Failed to read SQLite catalog: {}", err))?;
        let rows = statement
            .query_map([], |row| {
                Ok(CatalogObject {
                    key: row.get::<_, String>(0)?,
                    name: row.get::<_, String>(0)?,
                    kind: row.get::<_, String>(1)?,
                    marker: row.get::<_, String>(2)?,
                })
            })
            .map_err(|err| format!("Failed to read SQLite catalog: {}", err))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Failed to read SQLite catalog: {}", err))?;
        rows
    };

    let quoted = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    let mut columns = HashMap::new();
    let mut primary_keys = HashMap::new();
    let mut foreign_keys = Vec::new();
    let mut row_counts = HashMap::new();

    for object in &objects {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({})", quoted(&object.name)))
            .map_err(|err| format!("Failed to read columns of {}: {}", object.name, err))?;
        let mut key_columns: Vec<(i64, String)> = Vec::new();
        let table_columns = statement
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let pk_position: i64 = row.get(5)?;
                Ok((
                    ProbeColumn {
                        name: name.clone(),
                        data_type: row.get::<_, String>(2).unwrap_or_default(),
                        nullable: row.get::<_, i64>(3)? == 0,
                    },
                    pk_position,
                ))
            })
            .map_err(|err| format!("Failed to read columns of {}: {}", object.name, err))?
            .filter_map(Result::ok)
            .map(|(column, pk_position)| {
                if pk_position > 0 {
                    key_columns.push((pk_position, column.name.clone()));
                }
                column
            })
            .collect::<Vec<_>>();
        key_columns.sort();
        primary_keys.insert(object.key.clone(), key_columns.into_iter().map(|(_, name)| name).collect());
        if stored_markers.get(&object.name) != Some(&object.marker) {
            columns.insert(object.key.clone(), table_columns);
        }

        if let Ok(mut statement) = connection.prepare(&format!("PRAGMA foreign_key_list({})", quoted(&object.name))) {
            let found = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, rusqlite::types::Value>(4)?,
                    ))
                })
                .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
                .unwrap_or_default();
            for (to_table, from_column, to_column) in found {
                let to_column = match to_column {
                    rusqlite::types::Value::Text(text) => text,
                    _ => String::new(),
                };
                foreign_keys.push((object.key.clone(), from_column, to_table, to_column));
            }
        }

        if object.kind == "table" {
            if let Ok(count) = connection.query_row(
                &format!("SELECT COUNT(*) FROM {}", quoted(&object.name)),
                [],
                |row| row.get::<_, i64>(0),
            ) {
                row_counts.insert(object.key.clone(), count);
            }
        }
    }

    // An FK with no explicit target column points at the target's primary key.
    for fk in foreign_keys.iter_mut() {
        if fk.3.is_empty() {
            fk.3 = primary_keys.get(&fk.2).and_then(|key: &Vec<String>| key.first().cloned()).unwrap_or_default();
        }
    }

    Ok(CatalogSnapshot {
        objects,
        columns,
        primary_keys,
        row_counts,
        foreign_keys,
    })
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn stored_markers(connection: &SqliteConnection, connection_id: &str) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT table_name, modified_marker FROM schema_probe_table WHERE connection_id = ?1")
        .map_err(|err| format!("Failed to read probe markers: {}", err))?;
    let markers = statement
        .query_map([connection_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|err| format!("Failed to read probe markers: {}", err))?
        .filter_map(Result::ok)
        .collect();
    Ok(markers)
}

fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn base_name(table: &str) -> &str {
    table.rsplit('.').next().unwrap_or(table)
}

/// Joins the database does not declare but its naming implies: a column such
/// as `UserIdentifier` pointing at the one table whose primary key has that
/// exact name.
fn infer_relations(tables: &[ProbeTable], declared: &[ProbeRelation]) -> Vec<ProbeRelation> {
    let mut by_key: HashMap<String, Vec<&ProbeTable>> = HashMap::new();
    for table in tables {
        if let [key] = table.primary_key.as_slice() {
            by_key.entry(normalize(key)).or_default().push(table);
        }
    }

    let declared_pairs = declared
        .iter()
        .map(|relation| (relation.from_table.clone(), normalize(&relation.from_column)))
        .collect::<HashSet<_>>();

    let mut inferred = Vec::new();
    for table in tables {
        for column in &table.columns {
            let key = normalize(&column.name);
            let looks_like_reference = key.len() > 2 && (key.ends_with("identifier") || key.ends_with("id"));
            if !looks_like_reference || declared_pairs.contains(&(table.name.clone(), key.clone())) {
                continue;
            }

            let Some(candidates) = by_key.get(&key) else {
                continue;
            };
            let candidates = candidates
                .iter()
                .filter(|candidate| candidate.name != table.name)
                .collect::<Vec<_>>();

            // With several tables sharing the key name, prefer the one named
            // after it (UserIdentifier -> User); otherwise the link is a guess.
            let stem = key.trim_end_matches("identifier").trim_end_matches("id").to_string();
            let target = match candidates.as_slice() {
                [only] => Some(**only),
                many => many
                    .iter()
                    .find(|candidate| {
                        let base = normalize(base_name(&candidate.name));
                        !stem.is_empty() && (base == stem || base.ends_with(&stem))
                    })
                    .map(|candidate| **candidate),
            };

            if let Some(target) = target {
                inferred.push(ProbeRelation {
                    from_table: table.name.clone(),
                    from_column: column.name.clone(),
                    to_table: target.name.clone(),
                    to_column: target.primary_key[0].clone(),
                    inferred: true,
                });
            }
        }
    }
    inferred
}

fn write_snapshot(
    connection: &mut SqliteConnection,
    connection_id: &str,
    snapshot: &CatalogSnapshot,
) -> Result<(usize, usize), String> {
    let names_by_key = snapshot
        .objects
        .iter()
        .map(|object| (object.key.clone(), object.name.clone()))
        .collect::<HashMap<_, _>>();

    let transaction = connection
        .transaction()
        .map_err(|err| format!("Failed to start probe transaction: {}", err))?;
    let fail = |err: rusqlite::Error| format!("Failed to store schema probe: {}", err);

    let live_names = snapshot.objects.iter().map(|object| object.name.clone()).collect::<HashSet<_>>();
    let existing = {
        let mut statement = transaction
            .prepare("SELECT table_name FROM schema_probe_table WHERE connection_id = ?1")
            .map_err(fail)?;
        let names = statement
            .query_map([connection_id], |row| row.get::<_, String>(0))
            .map_err(fail)?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        names
    };
    for dropped in existing.iter().filter(|name| !live_names.contains(*name)) {
        transaction
            .execute(
                "DELETE FROM schema_probe_table WHERE connection_id = ?1 AND table_name = ?2",
                params![connection_id, dropped],
            )
            .map_err(fail)?;
        transaction
            .execute(
                "DELETE FROM schema_probe_column WHERE connection_id = ?1 AND table_name = ?2",
                params![connection_id, dropped],
            )
            .map_err(fail)?;
    }

    let mut changed = 0;
    for object in &snapshot.objects {
        if let Some(columns) = snapshot.columns.get(&object.key) {
            changed += 1;
            transaction
                .execute(
                    "DELETE FROM schema_probe_column WHERE connection_id = ?1 AND table_name = ?2",
                    params![connection_id, object.name],
                )
                .map_err(fail)?;
            for (ordinal, column) in columns.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO schema_probe_column
                         (connection_id, table_name, ordinal, column_name, data_type, is_nullable)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            connection_id,
                            object.name,
                            ordinal as i64,
                            column.name,
                            column.data_type,
                            column.nullable as i64
                        ],
                    )
                    .map_err(fail)?;
            }
        }

        let primary_key = snapshot.primary_keys.get(&object.key).cloned().unwrap_or_default();
        transaction
            .execute(
                "INSERT INTO schema_probe_table
                 (connection_id, table_name, kind, modified_marker, row_count, primary_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (connection_id, table_name) DO UPDATE SET
                    kind = excluded.kind,
                    modified_marker = excluded.modified_marker,
                    row_count = excluded.row_count,
                    primary_key = excluded.primary_key",
                params![
                    connection_id,
                    object.name,
                    object.kind,
                    object.marker,
                    snapshot.row_counts.get(&object.key),
                    serde_json::to_string(&primary_key).unwrap_or_else(|_| "[]".into())
                ],
            )
            .map_err(fail)?;
    }

    transaction
        .execute("DELETE FROM schema_probe_relation WHERE connection_id = ?1", [connection_id])
        .map_err(fail)?;
    let declared = snapshot
        .foreign_keys
        .iter()
        .filter_map(|(from_key, from_column, to_key, to_column)| {
            Some(ProbeRelation {
                from_table: names_by_key.get(from_key)?.clone(),
                from_column: from_column.clone(),
                to_table: names_by_key.get(to_key)?.clone(),
                to_column: to_column.clone(),
                inferred: false,
            })
        })
        .collect::<Vec<_>>();
    for relation in &declared {
        insert_relation(&transaction, connection_id, relation).map_err(fail)?;
    }

    transaction.commit().map_err(|err| format!("Failed to save schema probe: {}", err))?;

    // Inference needs every table's columns, including the unchanged ones
    // already on disk, so it runs against the stored catalog.
    let tables = read_stored_tables(connection, connection_id)?;
    let inferred = infer_relations(&tables, &declared);
    for relation in &inferred {
        insert_relation(connection, connection_id, relation).map_err(fail)?;
    }

    Ok((changed, declared.len() + inferred.len()))
}

fn insert_relation(connection: &SqliteConnection, connection_id: &str, relation: &ProbeRelation) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT INTO schema_probe_relation
         (connection_id, from_table, from_column, to_table, to_column, inferred)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            connection_id,
            relation.from_table,
            relation.from_column,
            relation.to_table,
            relation.to_column,
            relation.inferred as i64
        ],
    )
}

fn read_stored_tables(connection: &SqliteConnection, connection_id: &str) -> Result<Vec<ProbeTable>, String> {
    let fail = |err: rusqlite::Error| format!("Failed to read schema probe: {}", err);

    let mut columns: HashMap<String, Vec<ProbeColumn>> = HashMap::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT table_name, column_name, data_type, is_nullable FROM schema_probe_column
                 WHERE connection_id = ?1 ORDER BY table_name, ordinal",
            )
            .map_err(fail)?;
        let rows = statement
            .query_map([connection_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ProbeColumn {
                        name: row.get(1)?,
                        data_type: row.get(2)?,
                        nullable: row.get::<_, i64>(3)? != 0,
                    },
                ))
            })
            .map_err(fail)?;
        for (table, column) in rows.filter_map(Result::ok) {
            columns.entry(table).or_default().push(column);
        }
    }

    let mut statement = connection
        .prepare(
            "SELECT table_name, kind, row_count, primary_key FROM schema_probe_table
             WHERE connection_id = ?1 ORDER BY table_name",
        )
        .map_err(fail)?;
    let tables = statement
        .query_map([connection_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(fail)?
        .filter_map(Result::ok)
        .map(|(name, kind, row_count, primary_key)| ProbeTable {
            columns: columns.remove(&name).unwrap_or_default(),
            name,
            kind,
            row_count,
            primary_key: serde_json::from_str(&primary_key).unwrap_or_default(),
        })
        .collect();
    Ok(tables)
}

fn read_stored_probe(connection: &SqliteConnection, connection_id: &str) -> Result<Option<Probe>, String> {
    let tables = read_stored_tables(connection, connection_id)?;
    if tables.is_empty() {
        return Ok(None);
    }

    let mut statement = connection
        .prepare(
            "SELECT from_table, from_column, to_table, to_column, inferred FROM schema_probe_relation
             WHERE connection_id = ?1",
        )
        .map_err(|err| format!("Failed to read schema probe relations: {}", err))?;
    let relations = statement
        .query_map([connection_id], |row| {
            Ok(ProbeRelation {
                from_table: row.get(0)?,
                from_column: row.get(1)?,
                to_table: row.get(2)?,
                to_column: row.get(3)?,
                inferred: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|err| format!("Failed to read schema probe relations: {}", err))?
        .filter_map(Result::ok)
        .collect();

    Ok(Some(Probe { tables, relations }))
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/// Brings the stored catalog up to date with the live database.
pub async fn probe_connection(app: &AppHandle, connection_id: &str) -> Result<ProbeSummary, String> {
    let _guard = probe_lock().lock().await;
    let started = Instant::now();
    let connection_id = normalize_connection_id(Some(connection_id)).to_string();

    let markers = {
        let connection = open_workspace_database(app)?;
        ensure_probe_tables(&connection)?;
        stored_markers(&connection, &connection_id)?
    };

    let snapshot = match resolve_query_target(app, &connection_id)? {
        QueryTarget::Mssql { preset, .. } => read_mssql_catalog(&preset, &markers).await?,
        QueryTarget::Postgres { preset, .. } => read_postgres_catalog(&preset)?,
        QueryTarget::Sqlite { path, .. } => read_sqlite_catalog(&path, &markers)?,
    };

    let mut connection = open_workspace_database(app)?;
    let (changed, relation_count) = write_snapshot(&mut connection, &connection_id, &snapshot)?;
    let duration_ms = started.elapsed().as_millis();
    connection
        .execute(
            "INSERT INTO schema_probe_run (connection_id, table_count, changed_count, duration_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (connection_id) DO UPDATE SET
                probed_at = CURRENT_TIMESTAMP,
                table_count = excluded.table_count,
                changed_count = excluded.changed_count,
                duration_ms = excluded.duration_ms",
            params![connection_id, snapshot.objects.len() as i64, changed as i64, duration_ms as i64],
        )
        .map_err(|err| format!("Failed to record schema probe: {}", err))?;

    if let Ok(mut cache) = probe_cache().lock() {
        cache.remove(&connection_id);
    }

    let summary = ProbeSummary {
        connection_id: connection_id.clone(),
        table_count: snapshot.objects.len(),
        changed_tables: changed,
        relation_count,
        duration_ms,
    };
    write_app_log(
        app,
        "schema.probe",
        &format!(
            "Probed {}: {} table(s), {} changed, {} relationship(s) in {} ms",
            connection_id, summary.table_count, summary.changed_tables, summary.relation_count, duration_ms
        ),
    );
    Ok(summary)
}

/// The catalog for a connection, probing it first if it has never been read.
pub async fn load_probe(app: &AppHandle, connection_id: &str) -> Result<Arc<Probe>, String> {
    let connection_id = normalize_connection_id(Some(connection_id)).to_string();
    if let Some(cached) = probe_cache().lock().ok().and_then(|cache| cache.get(&connection_id).cloned()) {
        return Ok(cached);
    }

    let stored = {
        let connection = open_workspace_database(app)?;
        ensure_probe_tables(&connection)?;
        read_stored_probe(&connection, &connection_id)?
    };

    let probe = match stored {
        Some(probe) => probe,
        None => {
            probe_connection(app, &connection_id).await?;
            let connection = open_workspace_database(app)?;
            read_stored_probe(&connection, &connection_id)?
                .ok_or_else(|| format!("The schema probe found no tables for {}.", connection_id))?
        }
    };

    let probe = Arc::new(probe);
    if let Ok(mut cache) = probe_cache().lock() {
        cache.insert(connection_id, probe.clone());
    }
    Ok(probe)
}

/// Refreshes every saved database in the background, so a schema change made
/// since the last run is picked up before anyone asks a question about it.
pub fn start_background_sweep(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut connection_ids = vec![INTERNAL_CONNECTION_ID.to_string()];
        if let Ok(store) = load_preset_store(app.clone()) {
            connection_ids.extend(store.presets.into_iter().map(|preset| preset.id));
        }

        for connection_id in connection_ids {
            if let Err(err) = probe_connection(&app, &connection_id).await {
                write_app_log(&app, "schema.probe.error", &format!("Probe of {} failed: {}", connection_id, err));
            }
        }
    });
}

#[tauri::command]
pub async fn probe_schema(app: AppHandle, connection_id: Option<String>) -> Result<ProbeSummary, String> {
    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    probe_connection(&app, &connection_id).await
}
