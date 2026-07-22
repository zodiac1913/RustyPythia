use postgres::{Client as PostgresClient, Config as PostgresConfig, NoTls};
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

#[tauri::command]
fn load_preset_store(app: AppHandle) -> Result<PresetStore, String> {
    let store_path = preset_store_path(&app)?;
    if !store_path.exists() {
        return Ok(PresetStore::default());
    }

    let raw = fs::read_to_string(&store_path)
        .map_err(|err| format!("Failed to read preset store: {}", err))?;

    serde_json::from_str(&raw).map_err(|err| format!("Failed to parse preset store: {}", err))
}

#[tauri::command]
fn save_preset_store(app: AppHandle, store: PresetStore) -> Result<(), String> {
    let store_path = preset_store_path(&app)?;
    let payload = serde_json::to_string_pretty(&store)
        .map_err(|err| format!("Failed to serialize preset store: {}", err))?;

    fs::write(&store_path, payload).map_err(|err| format!("Failed to write preset store: {}", err))
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
            load_preset_store,
            save_preset_store,
            test_connection
        ])
        .setup(|app| {
            build_internal_window(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Rusty Pythia")
        .run(|_, _| {});
}
