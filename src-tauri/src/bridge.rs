//! A loopback HTTP bridge so a browser session can drive the real database
//! backends.
//!
//! The webview reaches MSSQL, Postgres and SQLite through Tauri commands, but a
//! plain browser tab has no such channel and used to fall back to a local
//! SQLite imitation. This exposes the same query and schema code over
//! `127.0.0.1` and serves the packaged UI, so "open in browser" is a real
//! session rather than a downgraded one.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::{run_load_sql_schema, run_sql_query, SqlSchemaTable};

/// Where the bridge is listening and the secret that unlocks it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
}

static BRIDGE: OnceLock<BridgeInfo> = OnceLock::new();

pub fn bridge_info() -> Option<BridgeInfo> {
    BRIDGE.get().cloned()
}

/// A browser tab can be closed, crash, or lose power without telling anyone,
/// so sessions are kept alive by a heartbeat and expire on silence rather than
/// being trusted to announce their own exit.
const SESSION_TIMEOUT: Duration = Duration::from_secs(20);

static SESSIONS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Instant>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn touch_session(id: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.insert(id.to_string(), Instant::now());
    }
}

fn end_session(id: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.remove(id);
    }
}

/// Live browser sessions, dropping any that have stopped checking in.
pub fn active_session_count() -> usize {
    match sessions().lock() {
        Ok(mut map) => {
            map.retain(|_, seen| seen.elapsed() < SESSION_TIMEOUT);
            map.len()
        }
        Err(_) => 0,
    }
}

struct BridgeState {
    app: AppHandle,
    token: String,
    /// In development the UI is served by Vite, not from the bundle, so asset
    /// requests are sent there instead of 404ing.
    dev_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryRequest {
    connection_id: Option<String>,
    sql: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaRequest {
    connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    session_id: String,
    #[serde(default)]
    closing: bool,
}

/// A random token, generated per run, that the page must present.
///
/// Binding to loopback is not access control on its own: any page in the
/// browser can post to `127.0.0.1`. The token is handed to the session through
/// the launch URL, so only a tab this app opened can reach the databases.
fn generate_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut token = String::with_capacity(64);
    while token.len() < 64 {
        let value = RandomState::new().build_hasher().finish();
        token.push_str(&format!("{:016x}", value));
    }
    token
}

fn cors_headers(origin: Option<&HeaderValue>) -> HeaderMap {
    let mut headers = HeaderMap::new();

    // Only a page this app launched should be able to call the bridge, so the
    // allowed origins are the bundle's own host and the dev server.
    let allowed = origin.and_then(|value| value.to_str().ok()).filter(|value| {
        value.starts_with("http://localhost:")
            || value.starts_with("http://127.0.0.1:")
            || value.starts_with("tauri://")
    });

    if let Some(value) = allowed.and_then(|value| HeaderValue::from_str(value).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("authorization, content-type"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("origin"));
    }

    headers
}

fn authorized(state: &BridgeState, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == state.token)
}

async fn preflight(headers: HeaderMap) -> Response {
    (StatusCode::NO_CONTENT, cors_headers(headers.get(header::ORIGIN))).into_response()
}

async fn query_endpoint(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(request): Json<QueryRequest>,
) -> Response {
    let cors = cors_headers(headers.get(header::ORIGIN));
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, cors, "Invalid bridge token.").into_response();
    }

    match run_sql_query(state.app.clone(), request.connection_id, request.sql).await {
        Ok(result) => (StatusCode::OK, cors, Json(result)).into_response(),
        Err(message) => (StatusCode::BAD_REQUEST, cors, message).into_response(),
    }
}

async fn schema_endpoint(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(request): Json<SchemaRequest>,
) -> Response {
    let cors = cors_headers(headers.get(header::ORIGIN));
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, cors, "Invalid bridge token.").into_response();
    }

    match run_load_sql_schema(state.app.clone(), request.connection_id).await {
        Ok(tables) => (StatusCode::OK, cors, Json::<Vec<SqlSchemaTable>>(tables)).into_response(),
        Err(message) => (StatusCode::BAD_REQUEST, cors, message).into_response(),
    }
}

/// Serves the saved connections so a browser session lists the same databases
/// as the desktop window. Passwords live in the OS keychain and are never part
/// of this payload.
async fn presets_endpoint(State(state): State<Arc<BridgeState>>, headers: HeaderMap) -> Response {
    let cors = cors_headers(headers.get(header::ORIGIN));
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, cors, "Invalid bridge token.").into_response();
    }

    match crate::load_preset_store(state.app.clone()) {
        Ok(store) => (StatusCode::OK, cors, Json(store)).into_response(),
        Err(message) => (StatusCode::BAD_REQUEST, cors, message).into_response(),
    }
}

async fn session_endpoint(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(request): Json<SessionRequest>,
) -> Response {
    let cors = cors_headers(headers.get(header::ORIGIN));
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, cors, "Invalid bridge token.").into_response();
    }

    if request.closing {
        end_session(&request.session_id);
        // The tab that just went away may have been the last thing keeping the
        // app alive, so settle up immediately instead of waiting to time out.
        crate::evaluate_shutdown(&state.app);
    } else {
        touch_session(&request.session_id);
    }

    (StatusCode::NO_CONTENT, cors).into_response()
}

fn serve_asset(state: &BridgeState, path: &str) -> Response {
    let lookup = if path.is_empty() { "index.html" } else { path };

    if let Some(asset) = state.app.asset_resolver().get(format!("/{}", lookup)) {
        let mut headers = HeaderMap::new();
        if let Ok(value) = HeaderValue::from_str(&asset.mime_type) {
            headers.insert(header::CONTENT_TYPE, value);
        }
        return (StatusCode::OK, headers, asset.bytes).into_response();
    }

    // A dev build has no embedded assets, so hand the session to Vite while
    // keeping the bridge details in the URL.
    if let Some(dev_url) = &state.dev_url {
        let separator = if lookup == "index.html" { "" } else { lookup };
        return Redirect::temporary(&format!(
            "{}/{}?bridge={}&token={}",
            dev_url.trim_end_matches('/'),
            separator,
            BRIDGE.get().map(|info| info.port).unwrap_or_default(),
            state.token
        ))
        .into_response();
    }

    (StatusCode::NOT_FOUND, "Not found").into_response()
}

async fn index_route(
    State(state): State<Arc<BridgeState>>,
    Query(_params): Query<HashMap<String, String>>,
) -> Response {
    serve_asset(&state, "index.html")
}

async fn asset_route(State(state): State<Arc<BridgeState>>, Path(path): Path<String>) -> Response {
    serve_asset(&state, &path)
}

/// Starts the bridge on an ephemeral loopback port and records how to reach it.
pub fn start(app: &AppHandle) -> Result<BridgeInfo, String> {
    if let Some(existing) = bridge_info() {
        return Ok(existing);
    }

    let token = generate_token();
    let dev_url = app
        .config()
        .build
        .dev_url
        .as_ref()
        .map(|url| url.to_string());

    let state = Arc::new(BridgeState {
        app: app.clone(),
        token: token.clone(),
        dev_url,
    });

    let router = Router::new()
        .route("/", get(index_route))
        .route(
            "/api/query",
            post(query_endpoint).options(preflight),
        )
        .route(
            "/api/schema",
            post(schema_endpoint).options(preflight),
        )
        .route(
            "/api/session",
            post(session_endpoint).options(preflight),
        )
        .route(
            "/api/presets",
            post(presets_endpoint).options(preflight),
        )
        .route("/{*path}", get(asset_route))
        .with_state(state);

    // Port 0 lets the OS pick a free port, which avoids clashing with whatever
    // else the developer happens to be running.
    let listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|err| format!("Failed to bind the SQL bridge: {}", err))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("Failed to configure the SQL bridge socket: {}", err))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Failed to read the SQL bridge port: {}", err))?
        .port();

    let info = BridgeInfo { port, token };
    let _ = BRIDGE.set(info.clone());

    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => {
                if let Err(err) = axum::serve(listener, router).await {
                    eprintln!("SQL bridge stopped: {}", err);
                }
            }
            Err(err) => eprintln!("Failed to start the SQL bridge listener: {}", err),
        }
    });

    // Catches sessions that vanished without a goodbye: a crashed tab or a
    // closed laptop simply stops checking in, and the app can then retire.
    let reaper_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            crate::evaluate_shutdown(&reaper_app);
        }
    });

    Ok(info)
}

/// Hands the UI the port and token so it can call the bridge or open a session.
#[tauri::command]
pub fn get_bridge_info() -> Result<BridgeInfo, String> {
    bridge_info().ok_or_else(|| "The SQL bridge is not running.".to_string())
}
