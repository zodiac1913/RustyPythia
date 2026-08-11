use postgres::{Client as PostgresClient, Config as PostgresConfig, NoTls};
use rusqlite::types::ValueRef;
use rusqlite::Connection as SqliteConnection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, WebviewWindow};
use tauri::window::Color;
use tiberius::{AuthMethod, Client as TiberiusClient, Config as TiberiusConfig, EncryptionLevel};
use tokio::net::TcpStream;
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
    password: String,
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
    first_seen_at: String,
    last_seen_at: String,
    execution_count: i64,
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

            CREATE TABLE IF NOT EXISTS sql_statement_history (
                statement TEXT PRIMARY KEY,
                first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                execution_count INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS sql_statement_memory (
                connection_id TEXT NOT NULL,
                statement TEXT NOT NULL,
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

    let bootstrap_store = PresetStore::default();
    sync_workspace_connection_catalog(&connection, &bootstrap_store)?;

    connection
        .execute_batch(
            "
            INSERT OR IGNORE INTO sql_statement_memory (
                connection_id,
                statement,
                first_seen_at,
                last_seen_at,
                execution_count
            )
            SELECT
                '__internal_workspace__',
                statement,
                first_seen_at,
                last_seen_at,
                execution_count
            FROM sql_statement_history;
            ",
        )
        .map_err(|err| {
            format!(
                "Failed to migrate legacy SQL memory into scoped storage {}: {}",
                workspace_path.display(),
                err
            )
        })?;

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

fn normalize_connection_id(connection_id: Option<&str>) -> &str {
    connection_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(INTERNAL_CONNECTION_ID)
}

fn ensure_connection_exists(connection: &SqliteConnection, connection_id: &str) -> Result<(), String> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM connection_catalog WHERE connection_id = ?1)",
            [connection_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("Failed to validate connection scope {}: {}", connection_id, err))?;

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

fn resolve_sqlite_query_target(
    app: &AppHandle,
    connection_id: &str,
) -> Result<(PathBuf, String), String> {
    if connection_id == INTERNAL_CONNECTION_ID {
        return Ok((workspace_database_path(app)?, "Internal workspace database".into()));
    }

    let workspace_connection = open_workspace_database(app)?;
    ensure_connection_exists(&workspace_connection, connection_id)?;

    let (display_name, engine, host, database_name): (String, String, String, String) = workspace_connection
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

    if engine != "sqlite" {
        return Err(format!(
            "Direct query execution is currently available for the internal workspace database and SQLite targets. '{}' uses {}.",
            display_name, engine
        ));
    }

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

    Ok((PathBuf::from(path), display_name))
}

#[tauri::command]
fn record_sql_memory(
    app: AppHandle,
    connection_id: Option<String>,
    statement: String,
) -> Result<(), String> {
    let normalized_statement = statement.trim();
    if normalized_statement.is_empty() {
        return Err("SQL statement cannot be empty.".into());
    }

    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    let connection = open_workspace_database(&app)?;
    ensure_connection_exists(&connection, &connection_id)?;

    connection
        .execute(
            "
            INSERT INTO sql_statement_history (
                statement,
                first_seen_at,
                last_seen_at,
                execution_count
            )
            VALUES (?1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
            ON CONFLICT(statement) DO UPDATE SET
                last_seen_at = CURRENT_TIMESTAMP,
                execution_count = sql_statement_history.execution_count + 1
            ",
            [normalized_statement],
        )
        .map_err(|err| format!("Failed to record global SQL memory: {}", err))?;

    connection
        .execute(
            "
            INSERT INTO sql_statement_memory (
                connection_id,
                statement,
                first_seen_at,
                last_seen_at,
                execution_count
            )
            VALUES (?1, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
            ON CONFLICT(connection_id, statement) DO UPDATE SET
                last_seen_at = CURRENT_TIMESTAMP,
                execution_count = sql_statement_memory.execution_count + 1
            ",
            (connection_id.as_str(), normalized_statement),
        )
        .map_err(|err| format!("Failed to record scoped SQL memory: {}", err))?;

    Ok(())
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
                first_seen_at: row.get(2)?,
                last_seen_at: row.get(3)?,
                execution_count: row.get(4)?,
            })
        })
        .map_err(|err| format!("Failed to load SQL memory: {}", err))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Failed to read SQL memory rows: {}", err))
}

#[tauri::command]
fn execute_sql_query(
    app: AppHandle,
    connection_id: Option<String>,
    sql: String,
) -> Result<SqlQueryResult, String> {
    let normalized_sql = sql.trim();
    if normalized_sql.is_empty() {
        return Err("SQL query cannot be empty.".into());
    }

    let connection_id = normalize_connection_id(connection_id.as_deref()).to_string();
    let (target_path, connection_label) = resolve_sqlite_query_target(&app, &connection_id)?;
    let connection = SqliteConnection::open(&target_path).map_err(|err| {
        format!(
            "Failed to open SQLite target {} at {}: {}",
            connection_label,
            target_path.display(),
            err
        )
    })?;

    let query_prefix = normalized_sql
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_row_query = matches!(
        query_prefix.as_str(),
        "select" | "with" | "pragma" | "explain"
    );

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
            connection_id,
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
        connection_id,
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
}

#[tauri::command]
fn load_workspace_database_info(app: AppHandle) -> Result<WorkspaceDatabaseInfo, String> {
    ensure_workspace_database(&app)
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
        return Ok(store);
    }

    let raw = fs::read_to_string(&store_path)
        .map_err(|err| format!("Failed to read preset store: {}", err))?;

    let store = serde_json::from_str::<PresetStore>(&raw)
        .map_err(|err| format!("Failed to parse preset store: {}", err))?;
    let workspace_path = workspace_database_path(&app)?;
    let connection = SqliteConnection::open(&workspace_path).map_err(|err| {
        format!(
            "Failed to open internal workspace database {} while syncing presets: {}",
            workspace_path.display(),
            err
        )
    })?;
    sync_workspace_connection_catalog(&connection, &store)?;

    Ok(store)
}

#[tauri::command]
fn save_preset_store(app: AppHandle, store: PresetStore) -> Result<(), String> {
    let store_path = preset_store_path(&app)?;
    let payload = serde_json::to_string_pretty(&store)
        .map_err(|err| format!("Failed to serialize preset store: {}", err))?;

    fs::write(&store_path, payload).map_err(|err| format!("Failed to write preset store: {}", err))?;

    let workspace_path = workspace_database_path(&app)?;
    let connection = SqliteConnection::open(&workspace_path).map_err(|err| {
        format!(
            "Failed to open internal workspace database {} while saving presets: {}",
            workspace_path.display(),
            err
        )
    })?;
    sync_workspace_connection_catalog(&connection, &store)
}

async fn test_mssql_connection(preset: &ConnectionPreset) -> Result<ConnectionTestResult, String> {
    if preset.auth_mode == "ntlm" {
        return Err("NTLM connection testing is not implemented in Rusty Pythia yet. Use SQL auth for now.".into());
    }

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
    } else {
        config.authentication(AuthMethod::sql_server(
            preset.username.trim(),
            preset.password.as_str(),
        ));
    }

    config.encryption(EncryptionLevel::Required);
    config.trust_cert();

    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(|err| format!("Failed to reach MSSQL server {}: {}", host, err))?;
    tcp.set_nodelay(true)
        .map_err(|err| format!("Failed to configure MSSQL socket: {}", err))?;

    let _client = TiberiusClient::connect(config, tcp.compat_write())
        .await
        .map_err(|err| format!("MSSQL login failed for {}: {}", host, err))?;

    let database_suffix = if preset.database.trim().is_empty() {
        String::new()
    } else {
        format!(" / {}", preset.database.trim())
    };

    Ok(ConnectionTestResult {
        engine: "mssql".into(),
        summary: format!("Connected to MSSQL {}{}", host, database_suffix),
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
    if !preset.password.is_empty() {
        config.password(preset.password.as_str());
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
    })
}

#[tauri::command]
async fn test_connection(preset: ConnectionPreset) -> Result<ConnectionTestResult, String> {
    match preset.engine.as_str() {
        "mssql" => test_mssql_connection(&preset).await,
        "postgres" => test_postgres_connection(&preset),
        "sqlite" => test_sqlite_connection(&preset),
        other => Err(format!("Unsupported engine '{}'", other)),
    }
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
    build_sql_window(&app, &url)
}

fn build_internal_window(app: &tauri::App) -> Result<(), String> {
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .ok_or_else(|| "Missing main window configuration.".to_string())?;

    if app.get_webview_window(&window_config.label).is_some() {
        eprintln!(
            "Reusing existing main webview window during setup: {}",
            window_config.label
        );
        return Ok(());
    }

    WebviewWindowBuilder::from_config(app, window_config)
        .map_err(|err| format!("Failed to load Tauri window config: {}", err))?
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
            record_sql_memory,
            load_sql_memory,
            load_workspace_database_info,
            load_preset_store,
            save_preset_store,
            test_connection
        ])
        .setup(|app| {
            ensure_workspace_database(&app.handle())?;
            build_internal_window(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Rusty Pythia")
        .run(|_, _| {});
}
