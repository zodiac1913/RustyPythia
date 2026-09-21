use keyring::Entry as KeyringEntry;
use postgres::{Client as PostgresClient, Config as PostgresConfig, NoTls};
use rusqlite::types::ValueRef;
use rusqlite::Connection as SqliteConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, WebviewWindow};
use tauri::window::Color;
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tiberius::{
    AuthMethod, Client as TiberiusClient, ColumnData, Config as TiberiusConfig, EncryptionLevel,
    Row as TiberiusRow,
};
use tokio::net::TcpStream;
use tokio_util::compat::Compat;
use tokio_util::compat::TokioAsyncWriteCompatExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionPreset {
    id: String,
    name: String,
    engine: String,
    launch_url: String,
    host: String,
    port: String,
    database: String,
    username: String,
    // Never persisted to disk; it is held in the OS keychain and only travels
    // in-memory between the UI and a live connection attempt.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    password: String,
    // Tells the UI a keychain secret exists without revealing it, so saving an
    // untouched form does not wipe the stored password.
    #[serde(default)]
    has_stored_password: bool,
    auth_mode: String,
    domain: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetStore {
    active_preset_id: Option<String>,
    presets: Vec<ConnectionPreset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTestResult {
    engine: String,
    summary: String,
    password_days_remaining: Option<i32>,
    password_renewal_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDatabaseInfo {
    path: String,
    summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlMemoryEntry {
    connection_id: String,
    statement: String,
    squerrl_statement: Option<String>,
    first_seen_at: String,
    last_seen_at: String,
    execution_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppLogEntry {
    id: i64,
    kind: String,
    message: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlQueryResult {
    connection_id: String,
    connection_label: String,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    rows_affected: usize,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlSchemaTable {
    name: String,
    fields: Vec<String>,
}

const INTERNAL_CONNECTION_ID: &str = "__internal_workspace__";

fn rusty_window_color() -> Color {
    Color(177, 88, 61, 255)
}

fn next_window_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn build_sql_popup_window(
    app: &AppHandle,
    target_url: &str,
    features: NewWindowFeatures,
) -> Result<WebviewWindow, String> {
    let parsed_url = target_url
        .parse()
        .map_err(|err| format!("Invalid popup URL: {}", err))?;
    let popup_app = app.clone();

    WebviewWindowBuilder::new(
        app,
        format!("sql-popup-{}", next_window_suffix()),
        WebviewUrl::External(parsed_url),
    )
    .window_features(features)
    .title("Rusty Pythia SQL Popup")
    .background_color(rusty_window_color())
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    })
    .on_new_window(move |url, features| {
        eprintln!("Handling nested embedded SQL popup in-app: {}", url);

        match build_sql_popup_window(&popup_app, url.as_str(), features) {
            Ok(window) => NewWindowResponse::Create { window },
            Err(err) => {
                eprintln!(
                    "Failed to create nested SQL popup window for {}: {}. Falling back to native handling.",
                    url, err
                );
                NewWindowResponse::Allow
            }
        }
    })
    .build()
    .map_err(|err| format!("Failed to create SQL popup window: {}", err))
}

impl ConnectionPreset {
    fn normalized_port(&self) -> Result<u16, String> {
        if self.port.trim().is_empty() {
            return Ok(match self.engine.as_str() {
                "postgres" => 5432,
                _ => 1433,
            });
        }

        self.port
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("Invalid port '{}'", self.port.trim()))
    }
}

const KEYRING_SERVICE: &str = "com.rustypythia.connections";

fn keyring_entry(connection_id: &str) -> Result<KeyringEntry, String> {
    KeyringEntry::new(KEYRING_SERVICE, connection_id).map_err(|err| {
        format!(
            "Failed to open the OS keychain for {}: {}",
            connection_id, err
        )
    })
}

/// Secrets already unlocked during this run. Connecting per query would
/// otherwise hit the OS keychain every time, which prompts the user on each
/// query because dev builds are ad-hoc signed and never keep an allow grant.
static PASSWORD_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn password_cache() -> &'static Mutex<HashMap<String, String>> {
    PASSWORD_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_password(connection_id: &str) -> Option<String> {
    password_cache().lock().ok()?.get(connection_id).cloned()
}

fn cache_password(connection_id: &str, password: &str) {
    if let Ok(mut cache) = password_cache().lock() {
        cache.insert(connection_id.to_string(), password.to_string());
    }
}

fn forget_cached_password(connection_id: &str) {
    if let Ok(mut cache) = password_cache().lock() {
        cache.remove(connection_id);
    }
}

fn read_connection_password(connection_id: &str) -> Result<Option<String>, String> {
    match keyring_entry(connection_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!(
            "Failed to read the stored password for {}: {}",
            connection_id, err
        )),
    }
}

fn write_connection_password(connection_id: &str, password: &str) -> Result<(), String> {
    keyring_entry(connection_id)?
        .set_password(password)
        .map_err(|err| {
            format!(
                "Failed to store the password for {} in the OS keychain: {}",
                connection_id, err
            )
        })?;

    cache_password(connection_id, password);
    Ok(())
}

fn delete_connection_password(connection_id: &str) -> Result<(), String> {
    forget_cached_password(connection_id);
    match keyring_entry(connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!(
            "Failed to remove the stored password for {}: {}",
            connection_id, err
        )),
    }
}

/// Writes the preset file. Callers must clear passwords first; `password` is
/// skipped when empty so secrets never reach the disk.
fn persist_preset_store_file(store_path: &PathBuf, store: &PresetStore) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(store)
        .map_err(|err| format!("Failed to serialize preset store: {}", err))?;

    fs::write(store_path, payload)
        .map_err(|err| format!("Failed to write preset store: {}", err))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(store_path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Failed to restrict preset store permissions: {}", err))?;
    }

    Ok(())
}

/// Resolves the password to use for a live connection: an explicitly supplied
/// one wins, then the in-memory cache, and only then the OS keychain.
fn resolve_preset_password(preset: &ConnectionPreset) -> Result<String, String> {
    if !preset.password.is_empty() {
        return Ok(preset.password.clone());
    }

    if let Some(cached) = cached_password(&preset.id) {
        return Ok(cached);
    }

    let password = read_connection_password(&preset.id)?.unwrap_or_default();

    // The preset file tracks whether a secret should exist. If it claims one
    // but the keychain has nothing, connecting would silently send an empty
    // password and surface as a confusing "login failed" from the server.
    if password.is_empty() && preset.has_stored_password {
        return Err(format!(
            "No saved password found for {}. Open the connection and enter the password again.",
            preset.name
        ));
    }

    if !password.is_empty() {
        cache_password(&preset.id, &password);
    }

    Ok(password)
}

fn preset_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Failed to resolve app config directory: {}", err))?;

    fs::create_dir_all(&config_dir)
        .map_err(|err| format!("Failed to create app config directory: {}", err))?;

    Ok(config_dir.join("connection-presets.json"))
}

fn workspace_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Failed to resolve app config directory: {}", err))?;

    fs::create_dir_all(&config_dir)
        .map_err(|err| format!("Failed to create app config directory: {}", err))?;

    Ok(config_dir.join("rusty-pythia-workspace.sqlite"))
}

fn sync_workspace_connection_catalog(
    connection: &SqliteConnection,
    store: &PresetStore,
) -> Result<(), String> {
    connection
        .execute(
            "
            INSERT INTO connection_catalog (
                connection_id,
                display_name,
                engine,
                is_internal,
                is_default,
                updated_at
            )
            VALUES (?1, ?2, ?3, 1, ?4, CURRENT_TIMESTAMP)
            ON CONFLICT(connection_id) DO UPDATE SET
                display_name = excluded.display_name,
                engine = excluded.engine,
                is_internal = 1,
                is_default = excluded.is_default,
                updated_at = CURRENT_TIMESTAMP
            ",
            (
                INTERNAL_CONNECTION_ID,
                "Internal workspace database",
                "sqlite",
                i64::from(store.active_preset_id.is_none()),
            ),
        )
        .map_err(|err| format!("Failed to sync internal workspace connection: {}", err))?;

    for preset in &store.presets {
        connection
            .execute(
                "
                INSERT INTO connection_catalog (
                    connection_id,
                    display_name,
                    engine,
                    is_internal,
                    launch_url,
                    host,
                    port,
                    database_name,
                    username,
                    auth_mode,
                    domain,
                    is_default,
                    updated_at
                )
                VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP)
                ON CONFLICT(connection_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    engine = excluded.engine,
                    is_internal = 0,
                    launch_url = excluded.launch_url,
                    host = excluded.host,
                    port = excluded.port,
                    database_name = excluded.database_name,
                    username = excluded.username,
                    auth_mode = excluded.auth_mode,
                    domain = excluded.domain,
                    is_default = excluded.is_default,
                    updated_at = CURRENT_TIMESTAMP
                ",
                (
                    preset.id.as_str(),
                    preset.name.as_str(),
                    preset.engine.as_str(),
                    preset.launch_url.as_str(),
                    preset.host.as_str(),
                    preset.port.as_str(),
                    preset.database.as_str(),
                    preset.username.as_str(),
                    preset.auth_mode.as_str(),
                    preset.domain.as_str(),
                    i64::from(store.active_preset_id.as_deref() == Some(preset.id.as_str())),
                ),
            )
            .map_err(|err| format!("Failed to sync connection {}: {}", preset.name, err))?;
    }

    connection
        .execute(
            "
            UPDATE connection_catalog
            SET is_default = CASE
                WHEN connection_id = ?1 THEN ?2
                ELSE 0
            END,
                updated_at = CURRENT_TIMESTAMP
            WHERE is_internal = 1
            ",
            (
                INTERNAL_CONNECTION_ID,
                i64::from(store.active_preset_id.is_none()),
            ),
        )
        .map_err(|err| format!("Failed to finalize default connection state: {}", err))?;

    Ok(())
}

fn ensure_workspace_database(app: &AppHandle) -> Result<WorkspaceDatabaseInfo, String> {
    let workspace_path = workspace_database_path(app)?;
    let connection = SqliteConnection::open(&workspace_path).map_err(|err| {
        format!(
            "Failed to open internal workspace database {}: {}",
            workspace_path.display(),
            err
        )
    })?;

    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS app_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS connection_catalog (
                connection_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                engine TEXT NOT NULL,
                is_internal INTEGER NOT NULL DEFAULT 0,
                launch_url TEXT NOT NULL DEFAULT '',
                host TEXT NOT NULL DEFAULT '',
                port TEXT NOT NULL DEFAULT '',
                database_name TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT '',
                auth_mode TEXT NOT NULL DEFAULT '',
                domain TEXT NOT NULL DEFAULT '',
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS connection_secret (
                connection_id TEXT PRIMARY KEY,
                secret_blob BLOB,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(connection_id) REFERENCES connection_catalog(connection_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sql_statement_memory (
                connection_id TEXT NOT NULL,
                statement TEXT NOT NULL,
                squerrl_statement TEXT,
                first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                execution_count INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY(connection_id, statement),
                FOREIGN KEY(connection_id) REFERENCES connection_catalog(connection_id) ON DELETE CASCADE
            );
            ",
        )
        .map_err(|err| {
            format!(
                "Failed to initialize internal workspace database {}: {}",
                workspace_path.display(),
                err
            )
        })?;

    let has_squerrl_statement_column = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sql_statement_memory') WHERE name = 'squerrl_statement')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("Failed to inspect SQL memory schema: {}", err))?;

    if has_squerrl_statement_column == 0 {
        connection
            .execute(
                "ALTER TABLE sql_statement_memory ADD COLUMN squerrl_statement TEXT",
                [],
            )
            .map_err(|err| format!("Failed to add SQuerL audit column: {}", err))?;
    }

    let bootstrap_store = PresetStore::default();
    sync_workspace_connection_catalog(&connection, &bootstrap_store)?;

    let has_legacy_history = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sql_statement_history')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("Failed to inspect legacy SQL history: {}", err))?;

    if has_legacy_history != 0 {
        connection
            .execute(
                "
                INSERT OR IGNORE INTO sql_statement_memory (
                    connection_id,
                    statement,
                    first_seen_at,
                    last_seen_at,
                    execution_count
                )
                SELECT ?1, statement, first_seen_at, last_seen_at, execution_count
                FROM sql_statement_history
                ",
                [INTERNAL_CONNECTION_ID],
            )
            .map_err(|err| format!("Failed to migrate legacy SQL memory: {}", err))?;
        connection
            .execute("DROP TABLE sql_statement_history", [])
            .map_err(|err| format!("Failed to remove legacy SQL history: {}", err))?;
    }

    Ok(WorkspaceDatabaseInfo {
        path: workspace_path.display().to_string(),
        summary: "Internal SQLite workspace is ready for logs, protected connection records, and connection-scoped SQL memory.".into(),
    })
}

fn open_workspace_database(app: &AppHandle) -> Result<SqliteConnection, String> {
    ensure_workspace_database(app)?;
    let workspace_path = workspace_database_path(app)?;
    SqliteConnection::open(&workspace_path).map_err(|err| {
        format!(
            "Failed to open internal workspace database {}: {}",
            workspace_path.display(),
            err
        )
    })
}

fn insert_app_log(connection: &SqliteConnection, kind: &str, message: &str) -> Result<(), String> {
    connection
        .execute(
            "
            INSERT INTO app_log (kind, message)
            VALUES (?1, ?2)
            ",
            (kind.trim(), message.trim()),
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to write app log: {}", err))
}

fn write_app_log(app: &AppHandle, kind: &str, message: &str) {
    if kind.trim().is_empty() || message.trim().is_empty() {
        return;
    }

    match open_workspace_database(app) {
        Ok(connection) => {
            if let Err(err) = insert_app_log(&connection, kind, message) {
                eprintln!("{}", err);
            }
        }
        Err(err) => eprintln!("Failed to open workspace database for app log: {}", err),
    }
}

fn summarize_for_log(message: &str) -> String {
    const MAX_LOG_CHARS: usize = 240;

    let condensed = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if condensed.chars().count() <= MAX_LOG_CHARS {
        return condensed;
    }

    let prefix = condensed
        .chars()
        .take(MAX_LOG_CHARS.saturating_sub(1))
        .collect::<String>();
    format!("{}…", prefix)
}

fn normalize_connection_id(connection_id: Option<&str>) -> &str {
    connection_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(INTERNAL_CONNECTION_ID)
}

fn ensure_connection_exists(
    connection: &SqliteConnection,
    connection_id: &str,
) -> Result<(), String> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM connection_catalog WHERE connection_id = ?1)",
            [connection_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| {
            format!(
                "Failed to validate connection scope {}: {}",
                connection_id, err
            )
        })?;

    if exists == 0 {
        return Err(format!("Unknown database target '{}'.", connection_id));
    }

    Ok(())
}

fn sqlite_value_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "NULL".into(),
        ValueRef::Integer(number) => number.to_string(),
        ValueRef::Real(number) => number.to_string(),
        ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Blob(bytes) => format!("<{} bytes>", bytes.len()),
    }
}

/// A connection resolved to something the query and schema commands can drive.
enum QueryTarget {
    Sqlite {
        path: PathBuf,
        label: String,
    },
    Mssql {
        preset: Box<ConnectionPreset>,
        label: String,
    },
}

fn read_preset_by_id(app: &AppHandle, connection_id: &str) -> Result<ConnectionPreset, String> {
    let store_path = preset_store_path(app)?;
    let raw = fs::read_to_string(&store_path)
        .map_err(|err| format!("Failed to read preset store: {}", err))?;
    let store = serde_json::from_str::<PresetStore>(&raw)
        .map_err(|err| format!("Failed to parse preset store: {}", err))?;

    store
        .presets
        .into_iter()
        .find(|preset| preset.id == connection_id)
        .ok_or_else(|| format!("No saved connection preset matches {}.", connection_id))
}

fn resolve_query_target(app: &AppHandle, connection_id: &str) -> Result<QueryTarget, String> {
    if connection_id == INTERNAL_CONNECTION_ID {
        return Ok(QueryTarget::Sqlite {
            path: workspace_database_path(app)?,
            label: "Internal workspace database".into(),
        });
    }

    let workspace_connection = open_workspace_database(app)?;
    ensure_connection_exists(&workspace_connection, connection_id)?;

    let (display_name, engine, host, database_name): (String, String, String, String) =
        workspace_connection
            .query_row(
                "
            SELECT display_name, engine, host, database_name
            FROM connection_catalog
            WHERE connection_id = ?1
            ",
                [connection_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|err| format!("Failed to load database target {}: {}", connection_id, err))?;

    match engine.as_str() {
        "sqlite" => {
            let path = if !host.trim().is_empty() {
                host.trim().to_string()
            } else {
                database_name.trim().to_string()
            };

            if path.is_empty() {
                return Err(format!(
                    "SQLite target '{}' needs a file path in Host or Default database before it can open a SQL interface.",
                    display_name
                ));
            }

            Ok(QueryTarget::Sqlite {
                path: PathBuf::from(path),
                label: display_name,
            })
        }
        "mssql" => Ok(QueryTarget::Mssql {
            preset: Box::new(read_preset_by_id(app, connection_id)?),
            label: display_name,
        }),
        other => Err(format!(
            "Direct query execution is currently available for the internal workspace database, SQLite, and MSSQL targets. '{}' uses {}.",
            display_name, other
        )),
    }
}

#[tauri::command]
fn record_sql_memory(
    app: AppHandle,
    connection_id: Option<String>,
    statement: String,
    squerrl_statement: Option<String>,
) -> Result<(), String> {
    let normalized_statement = statement.trim();
    if normalized_statement.is_empty() {
        return Err("SQL statement cannot be empty.".into());
    }

    let normalized_squerrl_statement = squerrl_statement
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    let connection = open_workspace_database(&app)?;
    ensure_connection_exists(&connection, &connection_id)?;

    connection
        .execute(
            "
            INSERT INTO sql_statement_memory (
                connection_id,
                statement,
                squerrl_statement,
                first_seen_at,
                last_seen_at,
                execution_count
            )
            VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
            ON CONFLICT(connection_id, statement) DO UPDATE SET
                last_seen_at = CURRENT_TIMESTAMP,
                execution_count = sql_statement_memory.execution_count + 1,
                squerrl_statement = CASE
                    WHEN excluded.squerrl_statement IS NOT NULL AND TRIM(excluded.squerrl_statement) <> '' THEN excluded.squerrl_statement
                    ELSE sql_statement_memory.squerrl_statement
                END
            ",
            (
                connection_id.as_str(),
                normalized_statement,
                normalized_squerrl_statement.as_deref(),
            ),
        )
        .map_err(|err| format!("Failed to record scoped SQL memory: {}", err))?;

    write_app_log(
        &app,
        "sql.memory",
        &format!(
            "Recorded SQL memory for {}: {}{}",
            connection_id,
            summarize_for_log(normalized_statement),
            normalized_squerrl_statement
                .as_deref()
                .map(|squerrl| format!(" (SQuerL: {})", summarize_for_log(squerrl)))
                .unwrap_or_default()
        ),
    );

    Ok(())
}

#[tauri::command]
fn has_sql_memory_statement(
    app: AppHandle,
    connection_id: Option<String>,
    statement: String,
) -> Result<bool, String> {
    let normalized_statement = statement.trim();
    if normalized_statement.is_empty() {
        return Ok(false);
    }

    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    let connection = open_workspace_database(&app)?;
    ensure_connection_exists(&connection, &connection_id)?;

    let mut exists_statement = connection
        .prepare(
            "
            SELECT 1
            FROM sql_statement_memory
            WHERE connection_id = ?1
              AND statement = ?2
            LIMIT 1
            ",
        )
        .map_err(|err| format!("Failed to prepare SQL memory lookup: {}", err))?;

    let mut rows = exists_statement
        .query((connection_id.as_str(), normalized_statement))
        .map_err(|err| format!("Failed to check SQL memory: {}", err))?;

    rows.next()
        .map(|row| row.is_some())
        .map_err(|err| format!("Failed to read SQL memory lookup result: {}", err))
}

#[tauri::command]
fn load_sql_memory(
    app: AppHandle,
    connection_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SqlMemoryEntry>, String> {
    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    let connection = open_workspace_database(&app)?;
    ensure_connection_exists(&connection, &connection_id)?;

    let row_limit = i64::from(limit.unwrap_or(25).clamp(1, 250));
    let mut statement = connection
        .prepare(
            "
            SELECT
                connection_id,
                statement,
                squerrl_statement,
                first_seen_at,
                last_seen_at,
                execution_count
            FROM sql_statement_memory
            WHERE connection_id = ?1
            ORDER BY last_seen_at DESC, statement COLLATE NOCASE ASC
            LIMIT ?2
            ",
        )
        .map_err(|err| format!("Failed to prepare SQL memory query: {}", err))?;

    let rows = statement
        .query_map((connection_id.as_str(), row_limit), |row| {
            Ok(SqlMemoryEntry {
                connection_id: row.get(0)?,
                statement: row.get(1)?,
                squerrl_statement: row.get(2)?,
                first_seen_at: row.get(3)?,
                last_seen_at: row.get(4)?,
                execution_count: row.get(5)?,
            })
        })
        .map_err(|err| format!("Failed to load SQL memory: {}", err))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read SQL memory rows: {}", err))
}

#[tauri::command]
async fn execute_sql_query(
    app: AppHandle,
    connection_id: Option<String>,
    sql: String,
) -> Result<SqlQueryResult, String> {
    let sql = sql.trim().to_string();
    let normalized_sql = sql.as_str();
    if normalized_sql.is_empty() {
        return Err("SQL query cannot be empty.".into());
    }

    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();

    let query_prefix = normalized_sql
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_row_query = matches!(
        query_prefix.as_str(),
        "select" | "with" | "pragma" | "explain" | "show"
    );

    let target = resolve_query_target(&app, &connection_id);

    let execution_result = match target {
        Err(err) => Err(err),
        Ok(QueryTarget::Mssql { preset, label }) => {
            execute_mssql_query(
                &preset,
                &connection_id,
                &label,
                normalized_sql,
                is_row_query,
            )
            .await
        }
        Ok(QueryTarget::Sqlite {
            path: target_path,
            label: connection_label,
        }) => (|| -> Result<SqlQueryResult, String> {
            let connection = SqliteConnection::open(&target_path).map_err(|err| {
                format!(
                    "Failed to open SQLite target {} at {}: {}",
                    connection_label,
                    target_path.display(),
                    err
                )
            })?;

            if is_row_query {
                let mut statement = connection
                    .prepare(normalized_sql)
                    .map_err(|err| format!("Failed to prepare query: {}", err))?;
                let column_count = statement.column_count();
                let columns = statement
                    .column_names()
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect::<Vec<_>>();
                let rows = statement
                    .query_map([], |row| {
                        let mut values = Vec::with_capacity(column_count);
                        for index in 0..column_count {
                            values.push(sqlite_value_to_string(row.get_ref(index)?));
                        }
                        Ok(values)
                    })
                    .map_err(|err| format!("Failed to execute query: {}", err))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|err| format!("Failed to read query results: {}", err))?;

                return Ok(SqlQueryResult {
                    connection_id: connection_id.clone(),
                    connection_label: connection_label.clone(),
                    rows_affected: rows.len(),
                    message: format!(
                        "Loaded {} row{} from {}.",
                        rows.len(),
                        if rows.len() == 1 { "" } else { "s" },
                        connection_label
                    ),
                    columns,
                    rows,
                });
            }

            let rows_affected = connection
                .execute(normalized_sql, [])
                .map_err(|err| format!("Failed to execute statement: {}", err))?;

            Ok(SqlQueryResult {
                connection_id: connection_id.clone(),
                connection_label: connection_label.clone(),
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected,
                message: format!(
                    "Executed statement against {}. {} row{} affected.",
                    connection_label,
                    rows_affected,
                    if rows_affected == 1 { "" } else { "s" }
                ),
            })
        })(),
    };

    match &execution_result {
        Ok(result) => write_app_log(
            &app,
            "sql.execute",
            &format!(
                "Executed SQL against {}: {}",
                result.connection_label,
                summarize_for_log(normalized_sql)
            ),
        ),
        Err(err) => write_app_log(
            &app,
            "sql.error",
            &format!(
                "Failed SQL execution for {}: {} :: {}",
                connection_id,
                err,
                summarize_for_log(normalized_sql)
            ),
        ),
    }

    execution_result
}

#[tauri::command]
async fn load_sql_schema(
    app: AppHandle,
    connection_id: Option<String>,
) -> Result<Vec<SqlSchemaTable>, String> {
    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    let target_path = match resolve_query_target(&app, &connection_id)? {
        QueryTarget::Sqlite { path, .. } => path,
        QueryTarget::Mssql { preset, .. } => {
            let tables = load_mssql_schema(&preset).await?;
            write_app_log(
                &app,
                "schema.load",
                &format!(
                    "Loaded schema for {} with {} table(s)",
                    connection_id,
                    tables.len()
                ),
            );
            return Ok(tables);
        }
    };
    let connection = SqliteConnection::open(&target_path).map_err(|err| {
        format!(
            "Failed to open schema target at {}: {}",
            target_path.display(),
            err
        )
    })?;

    let mut table_statement = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE",
        )
        .map_err(|err| format!("Failed to prepare schema query: {}", err))?;
    let mut table_names = table_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("Failed to read schema tables: {}", err))?;

    let mut tables = Vec::new();
    while let Some(table_name) = table_names
        .next()
        .transpose()
        .map_err(|err| format!("Failed to read schema table name: {}", err))?
    {
        let quoted_name = table_name.replace('"', "\"\"");
        let pragma = format!("PRAGMA table_info(\"{}\")", quoted_name);
        let mut field_statement = connection
            .prepare(&pragma)
            .map_err(|err| format!("Failed to inspect table {}: {}", table_name, err))?;
        let mut fields = field_statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|err| format!("Failed to read fields for table {}: {}", table_name, err))?;
        let mut field_names = Vec::new();
        while let Some(field_name) = fields
            .next()
            .transpose()
            .map_err(|err| format!("Failed to read field for table {}: {}", table_name, err))?
        {
            field_names.push(field_name);
        }
        tables.push(SqlSchemaTable {
            name: table_name,
            fields: field_names,
        });
    }

    write_app_log(
        &app,
        "schema.load",
        &format!(
            "Loaded schema for {} with {} table(s)",
            connection_id,
            tables.len()
        ),
    );

    Ok(tables)
}

#[tauri::command]
fn record_app_event(app: AppHandle, kind: String, message: String) -> Result<(), String> {
    let normalized_kind = kind.trim();
    let normalized_message = message.trim();

    if normalized_kind.is_empty() {
        return Err("App log kind cannot be empty.".into());
    }

    if normalized_message.is_empty() {
        return Err("App log message cannot be empty.".into());
    }

    let connection = open_workspace_database(&app)?;
    insert_app_log(&connection, normalized_kind, normalized_message)
}

#[tauri::command]
fn load_app_log(app: AppHandle, limit: Option<u32>) -> Result<Vec<AppLogEntry>, String> {
    let row_limit = i64::from(limit.unwrap_or(100).clamp(1, 500));
    let connection = open_workspace_database(&app)?;
    let mut statement = connection
        .prepare(
            "
            SELECT id, kind, message, created_at
            FROM app_log
            ORDER BY id DESC
            LIMIT ?1
            ",
        )
        .map_err(|err| format!("Failed to prepare app log query: {}", err))?;

    let rows = statement
        .query_map([row_limit], |row| {
            Ok(AppLogEntry {
                id: row.get(0)?,
                kind: row.get(1)?,
                message: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|err| format!("Failed to load app log rows: {}", err))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read app log entries: {}", err))
}

#[tauri::command]
fn load_workspace_database_info(app: AppHandle) -> Result<WorkspaceDatabaseInfo, String> {
    let result = ensure_workspace_database(&app);
    if let Ok(info) = &result {
        write_app_log(
            &app,
            "workspace.info",
            &format!("Loaded workspace database info for {}", info.path),
        );
    }
    result
}

#[tauri::command]
fn load_preset_store(app: AppHandle) -> Result<PresetStore, String> {
    let store_path = preset_store_path(&app)?;
    if !store_path.exists() {
        let store = PresetStore::default();
        let workspace_path = workspace_database_path(&app)?;
        let connection = SqliteConnection::open(&workspace_path).map_err(|err| {
            format!(
                "Failed to open internal workspace database {} while loading presets: {}",
                workspace_path.display(),
                err
            )
        })?;
        sync_workspace_connection_catalog(&connection, &store)?;
        write_app_log(
            &app,
            "preset.load",
            "Loaded empty preset store and synced internal connection catalog",
        );
        return Ok(store);
    }

    let raw = fs::read_to_string(&store_path)
        .map_err(|err| format!("Failed to read preset store: {}", err))?;

    let mut store = serde_json::from_str::<PresetStore>(&raw)
        .map_err(|err| format!("Failed to parse preset store: {}", err))?;

    // Older builds wrote passwords straight into this file. Move any that are
    // still there into the keychain and rewrite the file without them.
    let mut migrated = 0_usize;
    for preset in &mut store.presets {
        if !preset.password.is_empty() {
            write_connection_password(&preset.id, &preset.password)?;
            preset.password.clear();
            preset.has_stored_password = true;
            migrated += 1;
        }
    }

    if migrated > 0 {
        persist_preset_store_file(&store_path, &store)?;
        write_app_log(
            &app,
            "preset.migrate",
            &format!(
                "Moved {} plaintext password(s) out of the preset file into the OS keychain",
                migrated
            ),
        );
    }

    let workspace_path = workspace_database_path(&app)?;
    let connection = SqliteConnection::open(&workspace_path).map_err(|err| {
        format!(
            "Failed to open internal workspace database {} while syncing presets: {}",
            workspace_path.display(),
            err
        )
    })?;
    sync_workspace_connection_catalog(&connection, &store)?;

    write_app_log(
        &app,
        "preset.load",
        &format!("Loaded preset store with {} preset(s)", store.presets.len()),
    );

    Ok(store)
}

#[tauri::command]
fn save_preset_store(app: AppHandle, mut store: PresetStore) -> Result<(), String> {
    let store_path = preset_store_path(&app)?;

    // Route every secret into the keychain before anything touches the disk.
    for preset in &mut store.presets {
        if !preset.password.is_empty() {
            write_connection_password(&preset.id, &preset.password)?;
            preset.password.clear();
            preset.has_stored_password = true;
        } else if !preset.has_stored_password {
            delete_connection_password(&preset.id)?;
        }
    }

    // Drop keychain entries for presets the user deleted.
    let previous = fs::read_to_string(&store_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PresetStore>(&raw).ok());
    if let Some(previous) = previous {
        for stale in previous
            .presets
            .iter()
            .filter(|candidate| !store.presets.iter().any(|preset| preset.id == candidate.id))
        {
            delete_connection_password(&stale.id)?;
        }
    }

    persist_preset_store_file(&store_path, &store)?;

    let workspace_path = workspace_database_path(&app)?;
    let connection = SqliteConnection::open(&workspace_path).map_err(|err| {
        format!(
            "Failed to open internal workspace database {} while saving presets: {}",
            workspace_path.display(),
            err
        )
    })?;
    sync_workspace_connection_catalog(&connection, &store)?;

    write_app_log(
        &app,
        "preset.save",
        &format!(
            "Saved preset store with {} preset(s); active preset is {}",
            store.presets.len(),
            store.active_preset_id.as_deref().unwrap_or("internal")
        ),
    );

    Ok(())
}

async fn connect_mssql(
    preset: &ConnectionPreset,
) -> Result<TiberiusClient<Compat<TcpStream>>, String> {
    if preset.auth_mode == "ntlm" {
        return Err(
            "NTLM connections are not implemented in Rusty Pythia yet. Use SQL auth for now."
                .into(),
        );
    }

    let host = preset.host.trim();
    if host.is_empty() {
        return Err("Host is required for MSSQL presets.".into());
    }

    let password = if preset.auth_mode == "none" {
        String::new()
    } else {
        resolve_preset_password(preset)?
    };
    connect_mssql_with_password(preset, &password, None).await
}

async fn connect_mssql_with_password(
    preset: &ConnectionPreset,
    password: &str,
    new_password: Option<&str>,
) -> Result<TiberiusClient<Compat<TcpStream>>, String> {
    let host = preset.host.trim();
    if host.is_empty() {
        return Err("Host is required for MSSQL presets.".into());
    }
    let mut config = TiberiusConfig::new();
    config.host(host);
    config.port(preset.normalized_port()?);
    if !preset.database.trim().is_empty() {
        config.database(preset.database.trim());
    }

    if preset.auth_mode == "none" {
        config.authentication(AuthMethod::sql_server("", ""));
    } else if let Some(new_password) = new_password {
        config.authentication(AuthMethod::sql_server_with_password_change(
            preset.username.trim(),
            password,
            new_password,
        ));
    } else {
        config.authentication(AuthMethod::sql_server(preset.username.trim(), password));
    }

    config.encryption(EncryptionLevel::Required);
    config.trust_cert();

    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(|err| format!("Failed to reach MSSQL server {}: {}", host, err))?;
    tcp.set_nodelay(true)
        .map_err(|err| format!("Failed to configure MSSQL socket: {}", err))?;

    TiberiusClient::connect(config, tcp.compat_write())
        .await
        .map_err(|err| match err.code() {
            Some(18487 | 18488) => format!(
                "PASSWORD_RENEWAL_REQUIRED:Your SQL Server password must be changed before connecting to {}.",
                host
            ),
            _ => format!("MSSQL login failed for {}: {}", host, err),
        })
}

async fn mssql_password_status(
    client: &mut TiberiusClient<Compat<TcpStream>>,
) -> Result<(Option<i32>, bool), String> {
    let row = client
        .simple_query(
            "SELECT \
             CAST(LOGINPROPERTY(SUSER_SNAME(), 'DaysUntilExpiration') AS int), \
             CAST(LOGINPROPERTY(SUSER_SNAME(), 'IsExpired') AS int), \
             CAST(LOGINPROPERTY(SUSER_SNAME(), 'IsMustChange') AS int)",
        )
        .await
        .map_err(|err| format!("Failed to check MSSQL password status: {}", err))?
        .into_row()
        .await
        .map_err(|err| format!("Failed to read MSSQL password status: {}", err))?;

    let Some(row) = row else {
        return Ok((None, false));
    };
    let days = row.get::<i32, _>(0);
    let renewal_required =
        row.get::<i32, _>(1).unwrap_or(0) == 1 || row.get::<i32, _>(2).unwrap_or(0) == 1;
    Ok((days, renewal_required))
}

/// Renders one MSSQL cell as display text. Temporal columns are read back
/// through chrono so they format as timestamps instead of raw TDS structs.
fn mssql_cell_to_string(row: &TiberiusRow, index: usize, value: &ColumnData<'static>) -> String {
    fn scalar<T: ToString>(value: &Option<T>) -> String {
        value.as_ref().map(ToString::to_string).unwrap_or_default()
    }

    fn temporal<T: ToString>(row: &TiberiusRow, index: usize) -> String
    where
        T: for<'a> tiberius::FromSql<'a>,
    {
        row.try_get::<T, _>(index)
            .ok()
            .flatten()
            .map(|parsed| parsed.to_string())
            .unwrap_or_default()
    }

    match value {
        ColumnData::U8(inner) => scalar(inner),
        ColumnData::I16(inner) => scalar(inner),
        ColumnData::I32(inner) => scalar(inner),
        ColumnData::I64(inner) => scalar(inner),
        ColumnData::F32(inner) => scalar(inner),
        ColumnData::F64(inner) => scalar(inner),
        ColumnData::Bit(inner) => scalar(inner),
        ColumnData::Guid(inner) => scalar(inner),
        ColumnData::Numeric(inner) => scalar(inner),
        ColumnData::String(inner) => inner
            .as_ref()
            .map(|text| text.to_string())
            .unwrap_or_default(),
        ColumnData::Xml(inner) => inner
            .as_ref()
            .map(|xml| xml.to_string())
            .unwrap_or_default(),
        ColumnData::Binary(inner) => inner
            .as_ref()
            .map(|bytes| format!("<{} bytes>", bytes.len()))
            .unwrap_or_default(),
        ColumnData::Date(_) => temporal::<chrono::NaiveDate>(row, index),
        ColumnData::Time(_) => temporal::<chrono::NaiveTime>(row, index),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            temporal::<chrono::NaiveDateTime>(row, index)
        }
        ColumnData::DateTimeOffset(_) => temporal::<chrono::DateTime<chrono::Utc>>(row, index),
    }
}

fn mssql_rows_to_grid(rows: &[TiberiusRow]) -> (Vec<String>, Vec<Vec<String>>) {
    let columns = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let values = rows
        .iter()
        .map(|row| {
            row.cells()
                .enumerate()
                .map(|(index, (_, value))| mssql_cell_to_string(row, index, value))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    (columns, values)
}

async fn execute_mssql_query(
    preset: &ConnectionPreset,
    connection_id: &str,
    connection_label: &str,
    sql: &str,
    is_row_query: bool,
) -> Result<SqlQueryResult, String> {
    let mut client = connect_mssql(preset).await?;

    if is_row_query {
        let mut stream = client
            .simple_query(sql)
            .await
            .map_err(|err| format!("Failed to execute query: {}", err))?;

        // Peek the result metadata before consuming rows. Without this an
        // empty result set carries no column names and renders as a blank
        // panel, which is indistinguishable from a failed query.
        let metadata_columns = stream
            .columns()
            .await
            .map_err(|err| format!("Failed to read result metadata: {}", err))?
            .map(|columns| {
                columns
                    .iter()
                    .map(|column| column.name().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let rows = stream
            .into_first_result()
            .await
            .map_err(|err| format!("Failed to read query results: {}", err))?;

        let (mut columns, values) = mssql_rows_to_grid(&rows);
        if columns.is_empty() {
            columns = metadata_columns;
        }

        return Ok(SqlQueryResult {
            connection_id: connection_id.to_string(),
            connection_label: connection_label.to_string(),
            rows_affected: values.len(),
            message: format!(
                "Loaded {} row{} from {}.",
                values.len(),
                if values.len() == 1 { "" } else { "s" },
                connection_label
            ),
            columns,
            rows: values,
        });
    }

    let outcome = client
        .execute(sql, &[])
        .await
        .map_err(|err| format!("Failed to execute statement: {}", err))?;
    let rows_affected = outcome.rows_affected().iter().sum::<u64>() as usize;

    Ok(SqlQueryResult {
        connection_id: connection_id.to_string(),
        connection_label: connection_label.to_string(),
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected,
        message: format!(
            "Executed statement against {}. {} row{} affected.",
            connection_label,
            rows_affected,
            if rows_affected == 1 { "" } else { "s" }
        ),
    })
}

async fn load_mssql_schema(preset: &ConnectionPreset) -> Result<Vec<SqlSchemaTable>, String> {
    let mut client = connect_mssql(preset).await?;

    let rows = client
        .simple_query(
            "
            SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
            ",
        )
        .await
        .map_err(|err| format!("Failed to query MSSQL schema: {}", err))?
        .into_first_result()
        .await
        .map_err(|err| format!("Failed to read MSSQL schema rows: {}", err))?;

    let mut tables: Vec<SqlSchemaTable> = Vec::new();
    for row in &rows {
        let schema_name = row.get::<&str, _>(0).unwrap_or_default();
        let table_name = row.get::<&str, _>(1).unwrap_or_default();
        let column_name = row.get::<&str, _>(2).unwrap_or_default().to_string();
        let qualified_name = format!("{}.{}", schema_name, table_name);

        match tables.last_mut() {
            Some(table) if table.name == qualified_name => table.fields.push(column_name),
            _ => tables.push(SqlSchemaTable {
                name: qualified_name,
                fields: vec![column_name],
            }),
        }
    }

    Ok(tables)
}

async fn test_mssql_connection(preset: &ConnectionPreset) -> Result<ConnectionTestResult, String> {
    let host = preset.host.trim();
    let mut client = connect_mssql(preset).await?;
    let (password_days_remaining, password_renewal_required) =
        mssql_password_status(&mut client).await?;

    let database_suffix = if preset.database.trim().is_empty() {
        String::new()
    } else {
        format!(" / {}", preset.database.trim())
    };

    let expiry_suffix = match password_days_remaining {
        Some(days) if days <= 14 => format!(
            ". Password expires in {} day{}",
            days,
            if days == 1 { "" } else { "s" }
        ),
        _ => String::new(),
    };

    Ok(ConnectionTestResult {
        engine: "mssql".into(),
        summary: format!(
            "Connected to MSSQL {}{}{}",
            host, database_suffix, expiry_suffix
        ),
        password_days_remaining,
        password_renewal_required,
    })
}

fn test_postgres_connection(preset: &ConnectionPreset) -> Result<ConnectionTestResult, String> {
    let host = preset.host.trim();
    if host.is_empty() {
        return Err("Host is required for Postgres presets.".into());
    }

    let mut config = PostgresConfig::new();
    config.host(host);
    config.port(preset.normalized_port()?);

    if !preset.username.trim().is_empty() {
        config.user(preset.username.trim());
    }
    let password = resolve_preset_password(preset)?;
    if !password.is_empty() {
        config.password(password.as_str());
    }
    if !preset.database.trim().is_empty() {
        config.dbname(preset.database.trim());
    }

    let _client: PostgresClient = config
        .connect(NoTls)
        .map_err(|err| format!("Postgres login failed for {}: {}", host, err))?;

    let database_suffix = if preset.database.trim().is_empty() {
        String::new()
    } else {
        format!(" / {}", preset.database.trim())
    };

    Ok(ConnectionTestResult {
        engine: "postgres".into(),
        summary: format!("Connected to Postgres {}{}", host, database_suffix),
        password_days_remaining: None,
        password_renewal_required: false,
    })
}

fn test_sqlite_connection(preset: &ConnectionPreset) -> Result<ConnectionTestResult, String> {
    let path = if !preset.host.trim().is_empty() {
        preset.host.trim()
    } else {
        preset.database.trim()
    };

    if path.is_empty() {
        return Err("SQLite presets need a file path in Host or Default database.".into());
    }

    let _connection = SqliteConnection::open(path)
        .map_err(|err| format!("Failed to open SQLite database {}: {}", path, err))?;

    Ok(ConnectionTestResult {
        engine: "sqlite".into(),
        summary: format!("Opened SQLite database {}", path),
        password_days_remaining: None,
        password_renewal_required: false,
    })
}

#[tauri::command]
async fn renew_mssql_password(
    app: AppHandle,
    connection_id: String,
    old_password: String,
    new_password: String,
) -> Result<ConnectionTestResult, String> {
    if old_password.is_empty() {
        return Err("Old password is required.".into());
    }
    if new_password.is_empty() {
        return Err("New password is required.".into());
    }
    if old_password == new_password {
        return Err("New password must differ from the old password.".into());
    }

    let preset = read_preset_by_id(&app, &connection_id)?;
    if preset.engine != "mssql" || preset.auth_mode != "sql" {
        return Err("Password renewal is available only for MSSQL SQL-auth connections.".into());
    }

    let mut client =
        connect_mssql_with_password(&preset, &old_password, Some(&new_password)).await?;
    write_connection_password(&preset.id, &new_password)?;
    let (password_days_remaining, password_renewal_required) = mssql_password_status(&mut client)
        .await
        .unwrap_or((None, false));

    write_app_log(
        &app,
        "connection.password-renewed",
        &format!("Renewed MSSQL password for {}", preset.name),
    );

    Ok(ConnectionTestResult {
        engine: "mssql".into(),
        summary: format!("Password renewed. Connected to {}.", preset.name),
        password_days_remaining,
        password_renewal_required,
    })
}

#[tauri::command]
async fn test_connection(
    app: AppHandle,
    preset: ConnectionPreset,
) -> Result<ConnectionTestResult, String> {
    let result = match preset.engine.as_str() {
        "mssql" => test_mssql_connection(&preset).await,
        "postgres" => test_postgres_connection(&preset),
        "sqlite" => test_sqlite_connection(&preset),
        other => Err(format!("Unsupported engine '{}'", other)),
    };

    match &result {
        Ok(summary) => write_app_log(
            &app,
            "connection.test",
            &format!(
                "Connection test succeeded for {}: {}",
                preset.name, summary.summary
            ),
        ),
        Err(err) => write_app_log(
            &app,
            "connection.error",
            &format!("Connection test failed for {}: {}", preset.name, err),
        ),
    }

    result
}

fn build_sql_window(app: &AppHandle, target_url: &str) -> Result<(), String> {
    let parsed_url = target_url
        .parse()
        .map_err(|err| format!("Invalid target URL: {}", err))?;
    let popup_app = app.clone();
    let window_suffix = next_window_suffix();
    let label = format!("sql-window-{}", window_suffix);
    let mut window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "Missing main window configuration.".to_string())?;

    window_config.label = label;
    window_config.title = "Rusty Pythia SQL".into();
    window_config.url = WebviewUrl::External(parsed_url);
    window_config.width = 1360.0;
    window_config.height = 900.0;
    window_config.min_width = Some(1024.0);
    window_config.min_height = Some(700.0);

    WebviewWindowBuilder::from_config(app, &window_config)
        .map_err(|err| format!("Failed to load SQL window config: {}", err))?
        .background_color(rusty_window_color())
        .on_new_window(move |url, features| {
            eprintln!("Handling embedded SQL popup request in-app: {}", url);

            match build_sql_popup_window(&popup_app, url.as_str(), features) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(err) => {
                    eprintln!(
                        "Failed to create SQL popup window for {}: {}. Falling back to native handling.",
                        url, err
                    );
                    NewWindowResponse::Allow
                }
            }
        })
        .build()
        .map(|_| ())
        .map_err(|err| format!("Failed to create SQL window: {}", err))
}

#[tauri::command]
fn open_sql_window(app: AppHandle, url: String) -> Result<(), String> {
    let result = build_sql_window(&app, &url);
    match &result {
        Ok(_) => write_app_log(
            &app,
            "window.open",
            &format!("Opened SQL window for {}", url),
        ),
        Err(err) => write_app_log(
            &app,
            "window.error",
            &format!("Failed to open SQL window for {}: {}", url, err),
        ),
    }
    result
}

fn build_internal_window(app: &tauri::App) -> Result<(), String> {
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .ok_or_else(|| "Missing main window configuration.".to_string())?;

    if let Some(window) = app.get_webview_window(&window_config.label) {
        eprintln!(
            "Reusing existing main webview window during setup: {}",
            window_config.label
        );
        return window
            .set_size(LogicalSize::new(1360.0, 900.0))
            .map_err(|err| format!("Failed to set startup window size: {}", err));
    }

    WebviewWindowBuilder::from_config(app, window_config)
        .map_err(|err| format!("Failed to load Tauri window config: {}", err))?
        .inner_size(1360.0, 900.0)
        .min_inner_size(1024.0, 700.0)
        .background_color(rusty_window_color())
        .build()
        .map(|_| ())
        .map_err(|err| format!("Failed to create Tauri window: {}", err))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_sql_window,
            execute_sql_query,
            load_sql_schema,
            load_app_log,
            record_app_event,
            has_sql_memory_statement,
            record_sql_memory,
            load_sql_memory,
            load_workspace_database_info,
            load_preset_store,
            save_preset_store,
            test_connection,
            renew_mssql_password
        ])
        .setup(|app| {
            ensure_workspace_database(&app.handle())?;
            build_internal_window(app)?;
            write_app_log(
                &app.handle(),
                "app.startup",
                "Rusty Pythia initialized its internal workspace and main window",
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Rusty Pythia")
        .run(|_, _| {});
}
