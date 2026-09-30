/// Connection details for the desktop app's loopback SQL bridge.
///
/// A browser session that was launched from the app carries these in its URL.
/// With them the page runs SQL through the real drivers in Rust; without them
/// it degrades to the local SQLite workspace.
export type SqlBridge = { port: number; token: string };

const BRIDGE_STORAGE_KEY = "rustyPythia.bridge";

/// Commands a browser session can run through the bridge, and the route each
/// one is served on. Anything not listed stays local to the browser preview.
const BRIDGE_ROUTES: Record<string, string> = {
  execute_sql_query: "query",
  load_sql_schema: "schema",
  load_preset_store: "presets",
  ai_status: "ai/status",
  ai_slap_ollama: "ai/slap",
  ai_assist: "ai/assist",
  ai_execute_sql: "ai/query",
  probe_schema: "ai/probe",
};

export function hasTauriBackend() {
  return typeof (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === "function";
}

export function readSqlBridge(): SqlBridge | null {
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get("bridge"));
  const token = params.get("token");

  if (port > 0 && token) {
    const bridge = { port, token } satisfies SqlBridge;
    window.sessionStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify(bridge));
    // The token should not linger in the address bar where it can be copied
    // into a bug report or shared screenshot.
    params.delete("bridge");
    params.delete("token");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    return bridge;
  }

  try {
    const stored = window.sessionStorage.getItem(BRIDGE_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as SqlBridge) : null;
  } catch {
    return null;
  }
}

/// Tells the desktop app this browser session is alive.
///
/// The app shuts down once nothing is using it, and a browser tab is not a
/// window it can see. Without this pulse a tab left open would be ignored and
/// the backend would exit out from under it.
export function startBridgeHeartbeat(bridge: SqlBridge) {
  const sessionId = crypto.randomUUID();
  const endpoint = `http://127.0.0.1:${bridge.port}/api/session`;

  const ping = (closing: boolean) => {
    const body = JSON.stringify({ sessionId, closing });

    // An unload handler cannot await fetch, so the farewell goes out as a
    // keepalive request that survives the page going away.
    void fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body,
      keepalive: true,
    }).catch(() => undefined);
  };

  ping(false);
  const timer = window.setInterval(() => ping(false), 5000);

  window.addEventListener("pagehide", () => {
    window.clearInterval(timer);
    ping(true);
  });
}

export function isBridgedCommand(command: string) {
  return command in BRIDGE_ROUTES;
}

export async function bridgeInvoke<T>(bridge: SqlBridge, command: string, args?: Record<string, unknown>) {
  const route = BRIDGE_ROUTES[command];
  if (!route) {
    throw new Error(`Command '${command}' is not available over the SQL bridge.`);
  }

  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(args ?? {}),
  });

  if (!response.ok) {
    throw new Error((await response.text()) || `SQL bridge returned ${response.status}.`);
  }

  return (await response.json()) as T;
}
