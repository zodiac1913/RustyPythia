import "bootstrap/dist/css/bootstrap.min.css";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: unknown;
  };
};

type BrowserSqlQueryResult = {
  columns: string[];
  values: unknown[][];
};

type BrowserSqlStatement = {
  bind(params?: unknown): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
};

type BrowserSqlDatabase = {
  run(sql: string, params?: unknown): void;
  exec(sql: string, params?: unknown): BrowserSqlQueryResult[];
  export(): Uint8Array;
  getRowsModified(): number;
  prepare(sql: string): BrowserSqlStatement;
};

type BrowserSqlModule = {
  Database: new (data?: Uint8Array) => BrowserSqlDatabase;
};

let launcherUrlEl: HTMLInputElement | null;
let launcherMsgEl: HTMLElement | null;
let openTauriButtonEl: HTMLButtonElement | null;
let openBrowserButtonEl: HTMLButtonElement | null;
let launchMenuButtonEl: HTMLButtonElement | null;
let launchMenuEl: HTMLElement | null;
let footerBrowserLinkEl: HTMLButtonElement | null;
let databaseSelectorEl: HTMLSelectElement | null;
let toggleFavoriteDatabaseEl: HTMLButtonElement | null;
let addDatabaseButtonEl: HTMLButtonElement | null;
let workspaceDbPathEl: HTMLElement | null;
let workspaceDbSummaryEl: HTMLElement | null;
let useInternalDbButtonEl: HTMLButtonElement | null;
let sqlEditorFormEl: HTMLFormElement | null;
let sqlEditorEl: HTMLTextAreaElement | null;
let queryLanguageEl: HTMLSelectElement | null;
let savedQueryDropdownEl: HTMLSelectElement | null;
let querySearchButtonEl: HTMLButtonElement | null;
let appLogButtonEl: HTMLButtonElement | null;
let runSqlButtonEl: HTMLButtonElement | null;
let clearSqlButtonEl: HTMLButtonElement | null;
let squerrlPickerEl: HTMLElement | null;
let squerrlPickerTitleEl: HTMLElement | null;
let squerrlPickerStatusEl: HTMLElement | null;
let squerrlPickerOptionsEl: HTMLElement | null;
let squerrlTableSearchEl: HTMLInputElement | null;
let squerrlSortOverlayEl: HTMLSelectElement | null;
let squerrlSelectedIndex = 0;
let squerrlSchemaCacheKey = "";
let squerrlSchemaCache: SqlSchemaTable[] | null = null;
let squerrlRequestId = 0;
let activeQueryLanguage: QueryLanguage | null = null;
let activeSQuerrlTableName: string | null = null;
let activeSQuerrlStage: "fields" | "options" | "conditions" | null = null;
let selectedSQuerrlFields = new Set<string>();
let squerrlConditionKeyboardController: AbortController | null = null;
let sqlResultsStatusEl: HTMLElement | null;
let sqlResultsOutputEl: HTMLElement | null;
let querySearchModalEl: HTMLDialogElement | null;
let querySearchInputEl: HTMLInputElement | null;
let queryDateFromEl: HTMLInputElement | null;
let queryDateToEl: HTMLInputElement | null;
let querySearchResultsEl: HTMLElement | null;
let loadQueryFromSearchButtonEl: HTMLButtonElement | null;
let clearQuerySearchButtonEl: HTMLButtonElement | null;
let closeQuerySearchModalButtonEl: HTMLButtonElement | null;
let appLogModalEl: HTMLDialogElement | null;
let appLogSearchInputEl: HTMLInputElement | null;
let appLogKindFilterEl: HTMLSelectElement | null;
let appLogDateFromEl: HTMLInputElement | null;
let appLogDateToEl: HTMLInputElement | null;
let appLogResultsEl: HTMLElement | null;
let refreshAppLogButtonEl: HTMLButtonElement | null;
let clearAppLogFiltersButtonEl: HTMLButtonElement | null;
let closeAppLogModalButtonEl: HTMLButtonElement | null;
let presetFormEl: HTMLFormElement | null;
let presetIdEl: HTMLInputElement | null;
let presetNameEl: HTMLInputElement | null;
let presetEngineEl: HTMLSelectElement | null;
let presetLaunchUrlEl: HTMLInputElement | null;
let presetHostEl: HTMLInputElement | null;
let presetPortEl: HTMLInputElement | null;
let presetDatabaseEl: HTMLInputElement | null;
let presetUsernameEl: HTMLInputElement | null;
let presetPasswordEl: HTMLInputElement | null;
let presetAuthModeEl: HTMLSelectElement | null;
let presetDomainEl: HTMLInputElement | null;
let testPresetButtonEl: HTMLButtonElement | null;
let resetPresetButtonEl: HTMLButtonElement | null;
let connectionModalEl: HTMLDialogElement | null;
let closeConnectionModalButtonEl: HTMLButtonElement | null;

type PresetEngine = "mssql" | "postgres" | "sqlite";

type ConnectionPreset = {
  id: string;
  name: string;
  engine: PresetEngine;
  launchUrl: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  authMode: "sql" | "ntlm" | "none";
  domain: string;
};

type PresetStore = {
  activePresetId: string | null;
  presets: ConnectionPreset[];
};

type ConnectionTestResult = {
  engine: string;
  summary: string;
};

type WorkspaceDatabaseInfo = {
  path: string;
  summary: string;
};

type SqlMemoryEntry = {
  connectionId: string;
  statement: string;
  squerrlStatement: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  executionCount: number;
};

type SqlQueryResult = {
  connectionId: string;
  connectionLabel: string;
  columns: string[];
  rows: string[][];
  rowsAffected: number;
  message: string;
};

type AppLogEntry = {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
};

type SqlSchemaTable = {
  name: string;
  fields: string[];
};

type SQuerrlSuggestion = {
  label: string;
  value: string;
  detail?: string;
};

type SQuerrlPickerOptions = {
  fieldScopeTables?: SqlSchemaTable[];
  includeStarOption?: boolean;
};

type QueryLanguage = "squerrl" | "sql" | "freeform";

type PreparedSqlExecution = {
  statement: string;
  squerrlStatement: string | null;
};

const QUERY_KEYWORDS: Record<QueryLanguage, SQuerrlSuggestion[]> = {
  freeform: [],
  sql: [
    { label: "SELECT", value: "SELECT ", detail: "choose fields" },
    { label: "INSERT", value: "INSERT ", detail: "add rows" },
    { label: "UPDATE", value: "UPDATE ", detail: "change rows" },
    { label: "DELETE", value: "DELETE ", detail: "remove rows" },
    { label: "DROP", value: "DROP ", detail: "remove an object" },
    { label: "CREATE", value: "CREATE ", detail: "create an object" },
    { label: "ALTER", value: "ALTER ", detail: "change an object" },
    { label: "TRUNCATE", value: "TRUNCATE ", detail: "empty a table" },
    { label: "RENAME", value: "RENAME ", detail: "rename an object" },
    { label: "REVOKE", value: "REVOKE ", detail: "remove permissions" },
    { label: "GRANT", value: "GRANT ", detail: "assign permissions" },
  ],
  squerrl: [
    { label: "SELECT", value: "SELECT ", detail: "choose fields" },
    { label: "FROM", value: "FROM ", detail: "choose a table" },
    { label: "WHERE", value: "WHERE ", detail: "filter rows" },
    { label: "ORDER BY", value: "ORDER BY ", detail: "sort rows" },
  ],
};

const SQL_PREFIX_PATTERN = /^\s*(select|with|insert|update|delete|drop|create|alter|pragma|explain)\b/i;
const SQUERRL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9$]*$/;

const INTERNAL_CONNECTION_ID = "__internal_workspace__";
const PRESET_STORAGE_KEY = "rusty-pythia.connection-presets";
const ACTIVE_PRESET_STORAGE_KEY = "rusty-pythia.active-preset";
const BROWSER_WORKSPACE_DB_KEY = "rusty-pythia.browser-workspace.sqlite";
const BROWSER_WORKSPACE_DB_PATH = "browser://rusty-pythia-workspace.sqlite";

let connectionPresets: ConnectionPreset[] = [];
let activePresetId: string | null = null;
let workspaceDatabaseInfo: WorkspaceDatabaseInfo | null = null;
let appLogEntriesCache: AppLogEntry[] = [];
let browserSqlModulePromise: Promise<BrowserSqlModule> | null = null;
let browserWorkspaceDbPromise: Promise<BrowserSqlDatabase> | null = null;

function hasTauriBackend() {
  return typeof (window as TauriWindow).__TAURI_INTERNALS__?.invoke === "function";
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function sqliteValueToString(value: unknown) {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Uint8Array) {
    return `<${value.byteLength} bytes>`;
  }

  if (value instanceof ArrayBuffer) {
    return `<${value.byteLength} bytes>`;
  }

  return String(value);
}

function isSqlRowQuery(statement: string) {
  const queryPrefix = statement.split(/\s+/);
  const firstToken = queryPrefix[0]?.toLowerCase() ?? "";

  return ["select", "with", "pragma", "explain"].includes(firstToken);
}

function browserTimestamp() {
  return new Date().toISOString();
}

function persistBrowserWorkspaceDb(database: BrowserSqlDatabase) {
  window.localStorage.setItem(BROWSER_WORKSPACE_DB_KEY, bytesToBase64(database.export()));
}

function getBrowserSqlRows(database: BrowserSqlDatabase, sql: string, params: unknown[] = []) {
  const statement = database.prepare(sql);
  statement.bind(params);
  const rows: Record<string, unknown>[] = [];

  while (statement.step()) {
    rows.push(statement.getAsObject());
  }

  statement.free();
  return rows;
}

function normalizeBrowserConnectionId(connectionId: string | null | undefined) {
  return connectionId?.trim() ? connectionId : INTERNAL_CONNECTION_ID;
}

function browserConnectionLabel(connectionId: string) {
  if (connectionId === INTERNAL_CONNECTION_ID) {
    return "Internal workspace database";
  }

  return getPresetById(connectionId)?.name ?? connectionId;
}

function initializeBrowserWorkspaceDb(database: BrowserSqlDatabase) {
  database.run(`
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sql_statement_memory (
      connection_id TEXT NOT NULL,
      statement TEXT NOT NULL,
      squerrl_statement TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(connection_id, statement)
    );
  `);
}

function syncBrowserConnectionCatalog(database: BrowserSqlDatabase, store: PresetStore) {
  database.run(
    `
      INSERT INTO connection_catalog (
        connection_id,
        display_name,
        engine,
        is_internal,
        is_default,
        updated_at
      )
      VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(connection_id) DO UPDATE SET
        display_name = excluded.display_name,
        engine = excluded.engine,
        is_internal = 1,
        is_default = excluded.is_default,
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      INTERNAL_CONNECTION_ID,
      "Internal workspace database",
      "sqlite",
      store.activePresetId ? 0 : 1,
    ]
  );

  store.presets.forEach((preset) => {
    database.run(
      `
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
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
      `,
      [
        preset.id,
        preset.name,
        preset.engine,
        preset.launchUrl,
        preset.host,
        preset.port,
        preset.database,
        preset.username,
        preset.authMode,
        preset.domain,
        store.activePresetId === preset.id ? 1 : 0,
      ]
    );
  });
}

async function getBrowserSqlModule() {
  if (!browserSqlModulePromise) {
    browserSqlModulePromise = initSqlJs({
      locateFile: () => sqlWasmUrl,
    }) as unknown as Promise<BrowserSqlModule>;
  }

  return browserSqlModulePromise;
}

async function getBrowserWorkspaceDb() {
  if (!browserWorkspaceDbPromise) {
    browserWorkspaceDbPromise = (async () => {
      const sqlModule = await getBrowserSqlModule();
      const encodedDb = window.localStorage.getItem(BROWSER_WORKSPACE_DB_KEY);
      const database = new sqlModule.Database(encodedDb ? base64ToBytes(encodedDb) : undefined);

      initializeBrowserWorkspaceDb(database);
      syncBrowserConnectionCatalog(database, readLegacyPresetStore());
      persistBrowserWorkspaceDb(database);

      return database;
    })();
  }

  return browserWorkspaceDbPromise;
}

async function browserWriteAppLog(kind: string, message: string) {
  const database = await getBrowserWorkspaceDb();
  database.run(
    `
      INSERT INTO app_log (kind, message, created_at)
      VALUES (?, ?, ?)
    `,
    [kind.trim(), message.trim(), browserTimestamp()]
  );
  persistBrowserWorkspaceDb(database);
}

async function browserInvoke<T>(command: string, args?: Record<string, unknown>) {
  switch (command) {
    case "load_workspace_database_info": {
      const info = {
        path: BROWSER_WORKSPACE_DB_PATH,
        summary: "Internal SQLite workspace is ready for logs, protected connection records, and connection-scoped SQL memory.",
      } satisfies WorkspaceDatabaseInfo;
      await browserWriteAppLog("workspace.info", `Loaded workspace database info for ${info.path}`);
      return info as T;
    }

    case "load_preset_store": {
      const store = readLegacyPresetStore();
      const browserStore = {
        activePresetId: null,
        presets: store.presets,
      } satisfies PresetStore;
      const database = await getBrowserWorkspaceDb();
      syncBrowserConnectionCatalog(database, browserStore);
      persistBrowserWorkspaceDb(database);
      return browserStore as T;
    }

    case "save_preset_store": {
      const store = (args?.store ?? { activePresetId: null, presets: [] }) as PresetStore;
      window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(store.presets));
      if (store.activePresetId) {
        window.localStorage.setItem(ACTIVE_PRESET_STORAGE_KEY, store.activePresetId);
      } else {
        window.localStorage.removeItem(ACTIVE_PRESET_STORAGE_KEY);
      }
      const database = await getBrowserWorkspaceDb();
      syncBrowserConnectionCatalog(database, { ...store, activePresetId: null });
      persistBrowserWorkspaceDb(database);
      return undefined as T;
    }

    case "record_app_event": {
      await browserWriteAppLog(String(args?.kind ?? ""), String(args?.message ?? ""));
      return undefined as T;
    }

    case "load_app_log": {
      const database = await getBrowserWorkspaceDb();
      const rowLimit = Math.max(1, Math.min(Number(args?.limit ?? 100), 500));
      const entries = getBrowserSqlRows(
        database,
        `
          SELECT id, kind, message, created_at
          FROM app_log
          ORDER BY id DESC
          LIMIT ?
        `,
        [rowLimit]
      ).map((row) => ({
        id: Number(row.id ?? 0),
        kind: String(row.kind ?? ""),
        message: String(row.message ?? ""),
        createdAt: String(row.created_at ?? ""),
      } satisfies AppLogEntry));
      return entries as T;
    }

    case "load_sql_memory": {
      const database = await getBrowserWorkspaceDb();
      const connectionId = normalizeBrowserConnectionId(args?.connectionId as string | null | undefined);
      const rowLimit = Math.max(1, Math.min(Number(args?.limit ?? 25), 250));
      const entries = getBrowserSqlRows(
        database,
        `
          SELECT connection_id, statement, squerrl_statement, first_seen_at, last_seen_at, execution_count
          FROM sql_statement_memory
          WHERE connection_id = ?
          ORDER BY last_seen_at DESC, statement COLLATE NOCASE ASC
          LIMIT ?
        `,
        [connectionId, rowLimit]
      ).map((row) => ({
        connectionId: String(row.connection_id ?? ""),
        statement: String(row.statement ?? ""),
        squerrlStatement: row.squerrl_statement == null ? null : String(row.squerrl_statement),
        firstSeenAt: String(row.first_seen_at ?? ""),
        lastSeenAt: String(row.last_seen_at ?? ""),
        executionCount: Number(row.execution_count ?? 0),
      } satisfies SqlMemoryEntry));
      return entries as T;
    }

    case "has_sql_memory_statement": {
      const database = await getBrowserWorkspaceDb();
      const connectionId = normalizeBrowserConnectionId(args?.connectionId as string | null | undefined);
      const statement = String(args?.statement ?? "").trim();

      if (!statement) {
        return false as T;
      }

      const existingRow = getBrowserSqlRows(
        database,
        `
          SELECT 1
          FROM sql_statement_memory
          WHERE connection_id = ?
            AND statement = ?
          LIMIT 1
        `,
        [connectionId, statement]
      )[0];

      return Boolean(existingRow) as T;
    }

    case "record_sql_memory": {
      const database = await getBrowserWorkspaceDb();
      const connectionId = normalizeBrowserConnectionId(args?.connectionId as string | null | undefined);
      const statement = String(args?.statement ?? "").trim();
      const squerrlStatement = String(args?.squerrlStatement ?? "").trim();

      if (!statement) {
        throw new Error("SQL statement cannot be empty.");
      }

      database.run(
        `
          INSERT INTO sql_statement_memory (
            connection_id,
            statement,
            squerrl_statement,
            first_seen_at,
            last_seen_at,
            execution_count
          )
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(connection_id, statement) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            execution_count = sql_statement_memory.execution_count + 1,
            squerrl_statement = CASE
              WHEN excluded.squerrl_statement IS NOT NULL AND TRIM(excluded.squerrl_statement) <> '' THEN excluded.squerrl_statement
              ELSE sql_statement_memory.squerrl_statement
            END
        `,
        [
          connectionId,
          statement,
          squerrlStatement || null,
          browserTimestamp(),
          browserTimestamp(),
        ]
      );
      persistBrowserWorkspaceDb(database);
      await browserWriteAppLog(
        "sql.memory",
        `Recorded SQL memory for ${connectionId}: ${statement}${squerrlStatement ? ` (SQuerL: ${squerrlStatement})` : ""}`
      );
      return undefined as T;
    }

    case "execute_sql_query": {
      const database = await getBrowserWorkspaceDb();
      const connectionId = normalizeBrowserConnectionId(args?.connectionId as string | null | undefined);
      const sql = String(args?.sql ?? "").trim();

      if (!sql) {
        throw new Error("SQL query cannot be empty.");
      }

      if (connectionId !== INTERNAL_CONNECTION_ID) {
        throw new Error("Browser fallback currently runs SQL against the internal workspace database only.");
      }

      try {
        if (isSqlRowQuery(sql)) {
          const result = database.exec(sql)[0] ?? { columns: [], values: [] };
          const queryResult = {
            connectionId,
            connectionLabel: browserConnectionLabel(connectionId),
            columns: result.columns,
            rows: result.values.map((row) => row.map((value) => sqliteValueToString(value))),
            rowsAffected: result.values.length,
            message: `Loaded ${result.values.length} row${result.values.length === 1 ? "" : "s"} from ${browserConnectionLabel(connectionId)}.`,
          } satisfies SqlQueryResult;
          await browserWriteAppLog("sql.execute", `Executed SQL against ${queryResult.connectionLabel}: ${sql}`);
          return queryResult as T;
        }

        database.run(sql);
        const rowsAffected = database.getRowsModified();
        persistBrowserWorkspaceDb(database);
        const queryResult = {
          connectionId,
          connectionLabel: browserConnectionLabel(connectionId),
          columns: [],
          rows: [],
          rowsAffected,
          message: `Executed statement against ${browserConnectionLabel(connectionId)}. ${rowsAffected} row${rowsAffected === 1 ? "" : "s"} affected.`,
        } satisfies SqlQueryResult;
        await browserWriteAppLog("sql.execute", `Executed SQL against ${queryResult.connectionLabel}: ${sql}`);
        return queryResult as T;
      } catch (error) {
        await browserWriteAppLog(
          "sql.error",
          `Failed SQL execution for ${connectionId}: ${error instanceof Error ? error.message : String(error)} :: ${sql}`
        );
        throw error;
      }
    }

    case "load_sql_schema": {
      const database = await getBrowserWorkspaceDb();
      const connectionId = normalizeBrowserConnectionId(args?.connectionId as string | null | undefined);

      if (connectionId !== INTERNAL_CONNECTION_ID) {
        throw new Error("Browser fallback currently loads schema from the internal workspace database only.");
      }

      const tables = getBrowserSqlRows(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE"
      ).map((row) => String(row.name ?? ""));

      const schema = tables.map((tableName) => ({
        name: tableName,
        fields: getBrowserSqlRows(database, `PRAGMA table_info(${quoteSqlIdentifier(tableName)})`).map((row) => String(row.name ?? "")),
      } satisfies SqlSchemaTable));

      await browserWriteAppLog("schema.load", `Loaded schema for ${connectionId} with ${schema.length} table(s)`);
      return schema as T;
    }

    case "test_connection": {
      throw new Error("Browser fallback currently supports the internal workspace database only. External connection testing requires the Tauri desktop runtime.");
    }

    case "open_sql_window": {
      const targetUrl = String(args?.url ?? "");
      const openedWindow = window.open(targetUrl, "_blank", "noopener,noreferrer");

      if (!openedWindow) {
        throw new Error("The browser blocked the popup window. Allow popups for this preview to open the SQL app.");
      }

      return undefined as T;
    }

    default:
      throw new Error(`Command '${command}' is not available in browser fallback mode.`);
  }
}

async function invokeBackend<T>(command: string, args?: Record<string, unknown>) {
  if (!hasTauriBackend()) {
    return browserInvoke<T>(command, args);
  }

  return invoke<T>(command, args);
}

function applyRuntimeAvailabilityState() {
  if (hasTauriBackend()) {
    return;
  }

  databaseSelectorEl?.toggleAttribute("disabled", true);
  toggleFavoriteDatabaseEl?.toggleAttribute("disabled", true);
  testPresetButtonEl?.toggleAttribute("disabled", true);
  setLauncherMessage("Browser fallback is active. SQL runs against the internal workspace database in this preview.");
}

function getActiveConnectionId() {
  return activePresetId;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function recordAppEvent(kind: string, message: string) {
  try {
    await invokeBackend("record_app_event", { kind, message });
  } catch (error) {
    console.error("Failed to record app event", error);
  }
}

function quoteSqlIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeSQuerrlValue(rawValue: string) {
  const value = rawValue.trim();
  if (!value) {
    throw new Error("Each SQuerL condition needs a value.");
  }

  if (/^'.*'$/.test(value)) {
    return value;
  }

  if (/^".*"$/.test(value)) {
    return `'${value.slice(1, -1).replace(/'/g, "''")}'`;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value) || /^(null|true|false|current_timestamp|current_date|current_time)$/i.test(value)) {
    return value;
  }

  if (/^(\?[0-9]*|[:@$][A-Za-z_][A-Za-z0-9_]*)$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "''")}'`;
}

function parseSQuerrlConditions(segment: string) {
  const clauses: string[] = [];
  let remaining = segment.trim();

  while (remaining) {
    const match = /^(has|not)\s+([A-Za-z_][A-Za-z0-9$]*)\s+(contains|!=|>=|<=|=|>|<)\s+([\s\S]+?)(?=(?:\s+(?:has|not)\s+[A-Za-z_][A-Za-z0-9$]*\s+(?:contains|!=|>=|<=|=|>|<)\s+)|$)/i.exec(remaining);
    if (!match) {
      throw new Error(`Unsupported SQuerL condition segment: ${remaining}`);
    }

    const [, mode, fieldName, operator, rawValue] = match;
    const fieldSql = quoteSqlIdentifier(fieldName);
    const valueSql = normalizeSQuerrlValue(rawValue);
    const comparison = operator.toLowerCase() === "contains"
      ? `${fieldSql} LIKE '%' || ${valueSql} || '%'`
      : `${fieldSql} ${operator} ${valueSql}`;

    clauses.push(mode.toLowerCase() === "not" ? `NOT (${comparison})` : comparison);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return clauses;
}

function normalizeSQuerrlStatement(statement: string) {
  return statement.trim().replace(/;+\s*$/, "");
}

function parseSQuerrlFields(fieldSegment: string) {
  if (!fieldSegment) {
    return ["*"];
  }

  const hasCommaSeparatedFields = fieldSegment.includes(",");
  const selectedFields = fieldSegment
    .split(hasCommaSeparatedFields ? /\s*,\s*/ : /\s+/)
    .map((field) => field.trim())
    .filter(Boolean);

  if (selectedFields.includes("*") && selectedFields.length > 1) {
    throw new Error("SQuerL fields cannot combine '*' with named fields.");
  }

  return selectedFields;
}

function translateSQuerrlToSql(statement: string) {
  const trimmedStatement = normalizeSQuerrlStatement(statement);
  const [tableName] = trimmedStatement.split(/\s+/);
  if (!SQUERRL_IDENTIFIER_PATTERN.test(tableName ?? "")) {
    throw new Error("SQuerL statements must start with a table name.");
  }

  const remainder = trimmedStatement.slice(tableName.length).trim();
  const sortMatch = /(^|\s)(~up|~down)(?=\s|$)/i.exec(remainder);
  const conditionMatch = /(^|\s)(has|not)\s+[A-Za-z_][A-Za-z0-9$]*\s+(contains|!=|>=|<=|=|>|<)\s+/i.exec(remainder);
  const sortIndex = sortMatch ? sortMatch.index + sortMatch[1].length : -1;
  const conditionIndex = conditionMatch ? conditionMatch.index + conditionMatch[1].length : -1;
  const fieldSegmentEnd = [sortIndex, conditionIndex]
    .filter((index) => index >= 0)
    .reduce((smallest, index) => Math.min(smallest, index), remainder.length);
  const fieldSegment = remainder.slice(0, fieldSegmentEnd).trim();
  let trailingSegment = remainder.slice(fieldSegmentEnd).trim();

  const selectedFields = parseSQuerrlFields(fieldSegment);

  if (!selectedFields.length || selectedFields.some((field) => field !== "*" && !SQUERRL_IDENTIFIER_PATTERN.test(field))) {
    throw new Error("SQuerL fields must be '*' or named fields separated by commas or spaces.");
  }

  let sortDirection: "ASC" | "DESC" | null = null;
  if (/^~up\b/i.test(trailingSegment)) {
    sortDirection = "ASC";
    trailingSegment = trailingSegment.replace(/^~up\b/i, "").trim();
  } else if (/^~down\b/i.test(trailingSegment)) {
    sortDirection = "DESC";
    trailingSegment = trailingSegment.replace(/^~down\b/i, "").trim();
  }

  const conditions = trailingSegment ? parseSQuerrlConditions(trailingSegment) : [];
  const projection = selectedFields.length === 1 && selectedFields[0] === "*"
    ? "*"
    : selectedFields.map((field) => quoteSqlIdentifier(field)).join(", ");
  const schemaTable = squerrlSchemaCache?.find((table) => table.name.toLowerCase() === tableName.toLowerCase());
  const orderField = selectedFields.find((field) => field !== "*") ?? schemaTable?.fields[0];

  if (sortDirection && !orderField) {
    throw new Error(`SQuerL sort needs at least one sortable field for ${tableName}.`);
  }

  const sqlParts = [`SELECT ${projection}`, `FROM ${quoteSqlIdentifier(tableName)}`];
  if (conditions.length) {
    sqlParts.push(`WHERE ${conditions.join(" AND ")}`);
  }
  if (sortDirection && orderField) {
    sqlParts.push(`ORDER BY ${quoteSqlIdentifier(orderField)} ${sortDirection}`);
  }

  return sqlParts.join(" ");
}

function prepareSqlExecution(statement: string): PreparedSqlExecution {
  const trimmedStatement = statement.trim();
  if (getEffectiveQueryLanguage() !== "squerrl" || SQL_PREFIX_PATTERN.test(trimmedStatement)) {
    return {
      statement: trimmedStatement,
      squerrlStatement: null,
    };
  }

  const normalizedSQuerrlStatement = normalizeSQuerrlStatement(trimmedStatement);

  return {
    statement: translateSQuerrlToSql(normalizedSQuerrlStatement),
    squerrlStatement: normalizedSQuerrlStatement,
  };
}

function normalizePreset(preset: Partial<ConnectionPreset>): ConnectionPreset {
  const engine: PresetEngine =
    preset.engine === "postgres" || preset.engine === "sqlite" || preset.engine === "mssql"
      ? preset.engine
      : "mssql";
  const authMode: ConnectionPreset["authMode"] =
    preset.authMode === "ntlm" || preset.authMode === "none" || preset.authMode === "sql"
      ? preset.authMode
      : "sql";

  return {
    id: typeof preset.id === "string" && preset.id ? preset.id : crypto.randomUUID(),
    name: typeof preset.name === "string" ? preset.name : "",
    engine,
    launchUrl: typeof preset.launchUrl === "string" ? preset.launchUrl : "",
    host: typeof preset.host === "string" ? preset.host : "",
    port: typeof preset.port === "string" ? preset.port : "",
    database: typeof preset.database === "string" ? preset.database : "",
    username: typeof preset.username === "string" ? preset.username : "",
    password: typeof preset.password === "string" ? preset.password : "",
    authMode,
    domain: typeof preset.domain === "string" ? preset.domain : "",
  };
}

function installTopHorizontalScrollbar() {
  const topScrollbar = document.createElement("div");
  topScrollbar.className = "top-horizontal-scrollbar";
  topScrollbar.setAttribute("aria-hidden", "true");

  const scrollbarContent = document.createElement("div");
  scrollbarContent.className = "top-horizontal-scrollbar__content";
  topScrollbar.appendChild(scrollbarContent);
  document.body.appendChild(topScrollbar);

  let syncingFromWindow = false;
  let syncingFromBar = false;

  const syncScrollbarWidth = () => {
    const { scrollWidth, clientWidth } = document.documentElement;
    scrollbarContent.style.width = `${scrollWidth}px`;
    topScrollbar.classList.toggle("is-visible", scrollWidth > clientWidth);
    topScrollbar.scrollLeft = window.scrollX;
  };

  topScrollbar.addEventListener("scroll", () => {
    if (syncingFromWindow) {
      return;
    }

    syncingFromBar = true;
    window.scrollTo({ left: topScrollbar.scrollLeft, top: window.scrollY });
    syncingFromBar = false;
  });

  window.addEventListener("scroll", () => {
    if (syncingFromBar || topScrollbar.scrollLeft === window.scrollX) {
      return;
    }

    syncingFromWindow = true;
    topScrollbar.scrollLeft = window.scrollX;
    syncingFromWindow = false;
  });

  window.addEventListener("resize", syncScrollbarWidth);
  new ResizeObserver(syncScrollbarWidth).observe(document.documentElement);
  syncScrollbarWidth();
}

function setLauncherMessage(message: string, isError = false) {
  if (!launcherMsgEl) {
    return;
  }

  launcherMsgEl.textContent = message;
  launcherMsgEl.dataset.state = isError ? "error" : "success";
}

function readStoredPresets() {
  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readLegacyPresetStore(): PresetStore {
  const presets = readStoredPresets() as ConnectionPreset[];
  const activeId = window.localStorage.getItem(ACTIVE_PRESET_STORAGE_KEY);

  return {
    presets: presets.map((preset) => normalizePreset(preset)),
    activePresetId: activeId,
  };
}

async function loadPresetStore() {
  const store = await invokeBackend<PresetStore>("load_preset_store");
  return {
    activePresetId: store.activePresetId ?? null,
    presets: Array.isArray(store.presets)
      ? store.presets.map((preset) => normalizePreset(preset))
      : [],
  } satisfies PresetStore;
}

async function persistPresetStore() {
  await invokeBackend("save_preset_store", {
    store: {
      activePresetId,
      presets: connectionPresets,
    } satisfies PresetStore,
  });
}

function getPresetById(id: string | null) {
  return connectionPresets.find((preset) => preset.id === id) ?? null;
}

function updateDatabaseSelector() {
  if (!databaseSelectorEl) {
    return;
  }

  // Set the selector value to the active preset ID or "internal"
  databaseSelectorEl.value = activePresetId || "internal";

  // Update favorite button state
  if (toggleFavoriteDatabaseEl) {
    const isDefaultInternal = activePresetId === null;
    toggleFavoriteDatabaseEl.classList.toggle("is-favorite", isDefaultInternal);
  }
}

function renderWorkspaceDatabaseInfo() {
  if (!workspaceDbPathEl || !workspaceDbSummaryEl) {
    return;
  }

  workspaceDbPathEl.textContent = workspaceDatabaseInfo?.path ?? "Workspace database unavailable.";
  workspaceDbSummaryEl.textContent = workspaceDatabaseInfo?.summary
    ?? "Rusty Pythia could not load the internal workspace database details.";
  updateDatabaseSelector();
}

function renderSqlResults(result: SqlQueryResult | null) {
  if (!sqlResultsStatusEl || !sqlResultsOutputEl) {
    return;
  }

  if (!result) {
    sqlResultsStatusEl.textContent = "Ready.";
    sqlResultsOutputEl.innerHTML = '<p class="sql-results-output__empty">Run a query to see rows or statement results here.</p>';
    return;
  }

  sqlResultsStatusEl.textContent = result.message;

  if (!result.columns.length) {
    sqlResultsOutputEl.innerHTML = `
      <p class="sql-results-output__message">${escapeHtml(result.message)}</p>
    `;
    return;
  }

  const header = result.columns
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("");
  const rows = result.rows
    .map((row) => {
      const cells = row.map((value) => `<td>${escapeHtml(value)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  sqlResultsOutputEl.innerHTML = `
    <div class="sql-results-table-wrap">
      <table class="sql-results-table">
        <thead>
          <tr>${header}</tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function openConnectionModal() {
  connectionModalEl?.showModal();
}

function closeConnectionModal() {
  connectionModalEl?.close();
}

function openQuerySearchModal() {
  querySearchModalEl?.showModal();
}

function closeQuerySearchModal() {
  querySearchModalEl?.close();
}

function openAppLogModal() {
  appLogModalEl?.showModal();
}

function closeAppLogModal() {
  appLogModalEl?.close();
}

async function performQuerySearch() {
  try {
    const searchText = querySearchInputEl?.value ?? "";
    const dateFrom = queryDateFromEl?.value ?? "";
    const dateTo = queryDateToEl?.value ?? "";

    const entries = await invokeBackend<SqlMemoryEntry[]>("load_sql_memory", {
      connectionId: getActiveConnectionId(),
      limit: 100,
    });

    let filtered = entries;

    // Filter by search text
    if (searchText) {
      const lowerSearch = searchText.toLowerCase();
      filtered = filtered.filter((entry) =>
        entry.statement.toLowerCase().includes(lowerSearch)
        || entry.squerrlStatement?.toLowerCase().includes(lowerSearch)
      );
    }

    // Filter by date range
    if (dateFrom) {
      const fromDate = new Date(dateFrom).getTime();
      filtered = filtered.filter(
        (entry) => new Date(entry.firstSeenAt).getTime() >= fromDate
      );
    }

    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(
        (entry) => new Date(entry.firstSeenAt).getTime() <= toDate.getTime()
      );
    }

    await populateQuerySearchResults(filtered);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  }
}

async function populateQuerySearchResults(entries: SqlMemoryEntry[]) {
  if (!querySearchResultsEl) {
    return;
  }

  if (!entries.length) {
    querySearchResultsEl.innerHTML =
      '<p class="query-search-results__empty">No queries found matching your search criteria.</p>';
    return;
  }

  querySearchResultsEl.innerHTML = entries
    .map(
      (entry) => `
      <div class="query-search-result-item" data-query-text="${escapeHtml(entry.squerrlStatement || entry.statement)}" data-query-language="${entry.squerrlStatement ? "squerrl" : "sql"}">
        ${entry.squerrlStatement ? `<p class="query-search-result-item__text"><strong>SQuerL:</strong> ${escapeHtml(entry.squerrlStatement)}</p>` : ""}
        <p class="query-search-result-item__text"><strong>SQL:</strong> ${escapeHtml(entry.statement)}</p>
        <p class="query-search-result-item__meta">Used ${entry.executionCount} time${entry.executionCount === 1 ? "" : "s"} · Last: ${entry.lastSeenAt}</p>
      </div>
    `
    )
    .join("");

  // Add click handlers to result items
  querySearchResultsEl.querySelectorAll(".query-search-result-item").forEach((item) => {
    item.addEventListener("click", () => {
      querySearchResultsEl!.querySelectorAll(".query-search-result-item").forEach((i) => {
        i.classList.remove("is-selected");
      });
      item.classList.add("is-selected");
    });
  });
}

async function loadQueryFromSearch() {
  const selectedItem = querySearchResultsEl?.querySelector(
    ".query-search-result-item.is-selected"
  ) as HTMLDivElement | null;

  if (!selectedItem) {
    setLauncherMessage("Please select a query first.");
    return false;
  }

  const queryText = selectedItem.dataset.queryText;
  const queryLanguage = (selectedItem.dataset.queryLanguage as QueryLanguage | undefined) ?? "sql";
  if (!queryText || !sqlEditorEl) {
    return false;
  }

  sqlEditorEl.value = queryText;
  setEditorLanguage(queryLanguage, queryText);
  closeQuerySearchModal();
  setLauncherMessage("Query loaded from search.");
  return true;
}

async function refreshSavedQueries() {
  try {
    const entries = await invokeBackend<SqlMemoryEntry[]>("load_sql_memory", {
      connectionId: getActiveConnectionId(),
      limit: 100,
    });
    populateSavedQueriesDropdown(entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  }
}

function populateSavedQueriesDropdown(entries: SqlMemoryEntry[]) {
  if (!savedQueryDropdownEl) {
    return;
  }

  // Reset dropdown to default option only
  savedQueryDropdownEl.innerHTML = '<option value="">Load a saved query...</option>';

  // Add entries as options
  entries.forEach((entry) => {
    const option = document.createElement("option");
    const displayQuery = entry.squerrlStatement || entry.statement;
    option.value = displayQuery;
    option.dataset.queryLanguage = entry.squerrlStatement ? "squerrl" : "sql";
    option.title = entry.squerrlStatement
      ? `SQuerL: ${entry.squerrlStatement}\nSQL: ${entry.statement}`
      : entry.statement;
    option.textContent = displayQuery.substring(0, 60) + (displayQuery.length > 60 ? "..." : "");
    savedQueryDropdownEl!.appendChild(option);
  });
}

function populateAppLogKindFilter(entries: AppLogEntry[]) {
  if (!appLogKindFilterEl) {
    return;
  }

  const selectedValue = appLogKindFilterEl.value;
  const kinds = Array.from(new Set(entries.map((entry) => entry.kind))).sort((left, right) => left.localeCompare(right));
  appLogKindFilterEl.innerHTML = '<option value="">All kinds</option>';

  kinds.forEach((kind) => {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = kind;
    appLogKindFilterEl!.appendChild(option);
  });

  appLogKindFilterEl.value = kinds.includes(selectedValue) ? selectedValue : "";
}

function filterAppLogEntries(entries: AppLogEntry[]) {
  const searchText = appLogSearchInputEl?.value.trim().toLowerCase() ?? "";
  const kind = appLogKindFilterEl?.value ?? "";
  const dateFrom = appLogDateFromEl?.value ?? "";
  const dateTo = appLogDateToEl?.value ?? "";

  return entries.filter((entry) => {
    if (searchText) {
      const haystack = `${entry.kind} ${entry.message} ${entry.createdAt}`.toLowerCase();
      if (!haystack.includes(searchText)) {
        return false;
      }
    }

    if (kind && entry.kind !== kind) {
      return false;
    }

    const createdAt = new Date(entry.createdAt).getTime();
    if (dateFrom && createdAt < new Date(dateFrom).getTime()) {
      return false;
    }

    if (dateTo) {
      const inclusiveEnd = new Date(dateTo);
      inclusiveEnd.setHours(23, 59, 59, 999);
      if (createdAt > inclusiveEnd.getTime()) {
        return false;
      }
    }

    return true;
  });
}

function renderAppLogEntries(entries: AppLogEntry[]) {
  if (!appLogResultsEl) {
    return;
  }

  if (!entries.length) {
    appLogResultsEl.innerHTML = '<p class="query-search-results__empty">No app log entries match the active filters.</p>';
    return;
  }

  appLogResultsEl.innerHTML = entries
    .map(
      (entry) => `
        <article class="app-log-entry">
          <div class="app-log-entry__header">
            <span class="app-log-entry__kind">${escapeHtml(entry.kind)}</span>
            <span class="app-log-entry__timestamp">${escapeHtml(entry.createdAt)}</span>
          </div>
          <p class="app-log-entry__message">${escapeHtml(entry.message)}</p>
        </article>
      `
    )
    .join("");
}

function applyAppLogFilters() {
  renderAppLogEntries(filterAppLogEntries(appLogEntriesCache));
}

async function refreshAppLog() {
  try {
    const entries = await invokeBackend<AppLogEntry[]>("load_app_log", { limit: 250 });
    appLogEntriesCache = entries;
    populateAppLogKindFilter(entries);
    applyAppLogFilters();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  }
}

function hideSQuerrlPicker() {
  squerrlConditionKeyboardController?.abort();
  squerrlConditionKeyboardController = null;
  if (squerrlPickerEl) {
    squerrlPickerEl.hidden = true;
  }
  squerrlTableSearchEl = null;
  squerrlSelectedIndex = 0;
}

function openSQuerrlSortOverlay() {
  if (!squerrlSortOverlayEl || !sqlEditorEl) {
    return;
  }

  activeSQuerrlStage = "conditions";
  squerrlSortOverlayEl.hidden = false;
  squerrlSortOverlayEl.focus();
}

function constrainSQuerrlPickerFocus(onEscape?: () => void) {
  if (!squerrlPickerEl) {
    return;
  }

  const pickerEl = squerrlPickerEl;
  pickerEl.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape?.();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const controls = Array.from(
      pickerEl.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')
    );
    const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (activeIndex - 1 + controls.length) % controls.length
      : (activeIndex + 1) % controls.length;
    event.preventDefault();
    controls[nextIndex]?.focus();
  };
}

function renderSQuerrlConditionBuilder(table: SqlSchemaTable) {
  if (!squerrlPickerEl) {
    return;
  }

  const modeChoices = ["has ", "not "];
  const fieldChoices = table.fields;
  const operatorChoices = ["=", "!=", ">", "<", ">=", "<=", "contains"];
  squerrlPickerEl.setAttribute("aria-label", `SQuerL condition builder for ${table.name}`);
  squerrlPickerEl.innerHTML = `<div class="squerrl-picker__header"><div><span class="squerrl-picker__eyebrow">SQuerL</span><h3>Build criteria</h3></div><span id="squerrl-condition-status" class="squerrl-picker__status">Step 1 of 6 · choose has or not</span></div><div class="squerrl-condition-builder" aria-label="SQuerL condition builder"><button type="button" id="squerrl-condition-mode" class="squerrl-condition-choice" data-value="has " aria-label="Condition mode">has</button><button type="button" id="squerrl-condition-field" class="squerrl-condition-choice" data-value="${escapeHtml(fieldChoices[0] ?? "")}" aria-label="Condition field">${escapeHtml(fieldChoices[0] ?? "")}</button><button type="button" id="squerrl-condition-operator" class="squerrl-condition-choice" data-value="=" aria-label="Condition operator">=</button><input id="squerrl-condition-value" type="text" placeholder="Value or variable" aria-label="Condition value or variable" /><button type="button" id="squerrl-add-condition">Add condition</button><button type="button" id="squerrl-finish-conditions">Finish</button></div>`;
  squerrlPickerEl.onkeydown = null;
  squerrlPickerOptionsEl = null;
  squerrlTableSearchEl = null;
  squerrlPickerEl.hidden = false;

  const modeEl = squerrlPickerEl.querySelector<HTMLButtonElement>("#squerrl-condition-mode");
  const fieldEl = squerrlPickerEl.querySelector<HTMLButtonElement>("#squerrl-condition-field");
  const operatorEl = squerrlPickerEl.querySelector<HTMLButtonElement>("#squerrl-condition-operator");
  const valueEl = squerrlPickerEl.querySelector<HTMLInputElement>("#squerrl-condition-value");
  const addButton = squerrlPickerEl.querySelector<HTMLButtonElement>("#squerrl-add-condition");
  const finishButton = squerrlPickerEl.querySelector<HTMLButtonElement>("#squerrl-finish-conditions");
  const statusEl = squerrlPickerEl.querySelector<HTMLElement>("#squerrl-condition-status");
  const controls = [modeEl, fieldEl, operatorEl, valueEl, addButton, finishButton].filter(
    (control): control is HTMLInputElement | HTMLButtonElement => Boolean(control)
  );
  const stepLabels = ["choose has or not", "choose a field", "choose an operator", "enter a value or variable", "add the condition", "finish conditions"];
  const updateStepStatus = (control: HTMLInputElement | HTMLButtonElement) => {
    const stepIndex = controls.indexOf(control);
    if (statusEl && stepIndex >= 0) {
      statusEl.textContent = `Step ${stepIndex + 1} of ${controls.length} · ${stepLabels[stepIndex]}`;
    }
  };

  squerrlConditionKeyboardController?.abort();
  squerrlConditionKeyboardController = new AbortController();
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const movesForward = event.key === "ArrowRight" || event.key === "ArrowDown" || key === "d" || key === "s";
    const movesBackward = event.key === "ArrowLeft" || event.key === "ArrowUp" || key === "a" || key === "w";
    const movesByTab = event.key === "Tab";
    if (!movesForward && !movesBackward && !movesByTab) {
      return;
    }
    const activeIndex = controls.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
    if (activeIndex < 0) {
      return;
    }
    const nextIndex = movesBackward || (movesByTab && event.shiftKey)
      ? (activeIndex - 1 + controls.length) % controls.length
      : (activeIndex + 1) % controls.length;
    event.preventDefault();
    event.stopImmediatePropagation();
    controls[nextIndex].focus();
  }, { capture: true, signal: squerrlConditionKeyboardController.signal });

  const cycleChoice = (button: HTMLButtonElement | null, choices: string[]) => {
    if (!button || !choices.length) {
      return;
    }
    const currentIndex = choices.indexOf(button.dataset.value ?? "");
    const value = choices[(currentIndex + 1) % choices.length];
    button.dataset.value = value;
    button.textContent = value.trim();
  };
  modeEl?.addEventListener("click", () => cycleChoice(modeEl, modeChoices));
  fieldEl?.addEventListener("click", () => cycleChoice(fieldEl, fieldChoices));
  operatorEl?.addEventListener("click", () => cycleChoice(operatorEl, operatorChoices));

  controls.forEach((control, controlIndex) => {
    control.addEventListener("focus", () => updateStepStatus(control));
    control.onkeydown = (event) => {
      const key = event.key.toLowerCase();
      if (event.key === "Escape") {
        event.preventDefault();
        hideSQuerrlPicker();
        sqlEditorEl?.focus();
        return;
      }
      const movesForward = event.key === "ArrowRight" || event.key === "ArrowDown" || key === "d" || key === "s";
      const movesBackward = event.key === "ArrowLeft" || event.key === "ArrowUp" || key === "a" || key === "w";
      const movesByTab = event.key === "Tab";
      if (!movesForward && !movesBackward && !movesByTab) {
        return;
      }
      const nextIndex = movesBackward || (movesByTab && event.shiftKey)
        ? (controlIndex - 1 + controls.length) % controls.length
        : (controlIndex + 1) % controls.length;
      event.preventDefault();
      event.stopPropagation();
      controls[nextIndex].focus();
    };
  });

  addButton?.addEventListener("click", () => {
    if (!sqlEditorEl || !modeEl || !fieldEl || !operatorEl || !valueEl?.value.trim()) {
      return;
    }
    const cursor = sqlEditorEl.selectionStart;
    sqlEditorEl.setRangeText(`${modeEl.dataset.value}${fieldEl.dataset.value} ${operatorEl.dataset.value} ${valueEl.value.trim()} `, cursor, cursor, "end");
    valueEl.value = "";
    valueEl.focus();
  });
  finishButton?.addEventListener("click", () => {
    hideSQuerrlPicker();
    sqlEditorEl?.focus();
  });
  modeEl?.focus();
}

function getSQuerrlContext() {
  if (!sqlEditorEl) {
    return null;
  }

  const cursor = sqlEditorEl.selectionStart;
  const beforeCursor = sqlEditorEl.value.slice(0, cursor);
  const tokenMatch = /[A-Za-z_][A-Za-z0-9$]*$/.exec(beforeCursor);
  const prefix = tokenMatch?.[0] ?? "";
  const beforeToken = beforeCursor.slice(0, beforeCursor.length - prefix.length);
  const normalized = beforeToken.toLowerCase();
  const fromMatch = /\bfrom\s+([a-z_][a-z0-9$]*)?$/.exec(normalized);
  const hasFrom = /\bfrom\b/i.test(beforeCursor);
  const hasClause = /\b(where|order\s+by)\b/i.test(beforeCursor);
  const trigger = Boolean(prefix) || /\s$/.test(beforeCursor);
  const language = getEffectiveQueryLanguage();

  return { cursor, beforeCursor, beforeToken, prefix, fromMatch, hasFrom, hasClause, trigger, language };
}

function getEffectiveQueryLanguage(): QueryLanguage {
  return (queryLanguageEl?.value ?? activeQueryLanguage ?? "squerrl") as QueryLanguage;
}

function setEditorLanguage(language: QueryLanguage, queryText = "") {
  const firstToken = queryText.trim().split(/\s+/)[0];
  activeQueryLanguage = language;
  activeSQuerrlTableName = language === "squerrl"
    ? firstToken || null
    : null;
  activeSQuerrlStage = null;
  selectedSQuerrlFields.clear();

  if (queryLanguageEl) {
    queryLanguageEl.value = language;
  }

  const modeBadge = document.querySelector<HTMLElement>("#editor-mode-badge");
  if (modeBadge) {
    const modeLabel = language === "freeform"
      ? "Non Assist"
      : language === "sql"
        ? "SQL Assist"
        : "SQuerL";
    modeBadge.textContent = modeLabel;
    modeBadge.dataset.mode = language;
  }
}

function isAssistLanguage(language: QueryLanguage) {
  return language === "squerrl" || language === "sql";
}

function selectSQuerrlSuggestion(suggestion: SQuerrlSuggestion) {
  const context = getSQuerrlContext();
  if (!sqlEditorEl || !context) {
    return;
  }

  if (!context.beforeCursor.trim()) {
    const selectedTable = squerrlSchemaCache?.find(
      (table) => table.name.toLowerCase() === suggestion.value.trim().toLowerCase()
    );
    setEditorLanguage(selectedTable ? "squerrl" : "sql", suggestion.value.trim());
    activeSQuerrlTableName = selectedTable?.name ?? null;
    activeSQuerrlStage = selectedTable ? "fields" : null;
  }

  const insertStart = context.cursor - context.prefix.length;
  sqlEditorEl.setRangeText(suggestion.value, insertStart, context.cursor, "end");
  sqlEditorEl.focus();
  hideSQuerrlPicker();
}

function setSQuerrlSelection(index: number) {
  if (!squerrlPickerOptionsEl) {
    return;
  }

  const options = Array.from(squerrlPickerOptionsEl.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]"));
  if (!options.length) {
    return;
  }

  squerrlSelectedIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    option.setAttribute("aria-selected", String(optionIndex === squerrlSelectedIndex));
    option.classList.toggle("is-selected", optionIndex === squerrlSelectedIndex);
  });
  options[squerrlSelectedIndex].scrollIntoView({ block: "nearest" });
}

function focusSQuerrlSelection(index: number) {
  if (!squerrlPickerOptionsEl) {
    return;
  }

  setSQuerrlSelection(index);
  const options = squerrlPickerOptionsEl.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]");
  options[squerrlSelectedIndex]?.focus();
}

function moveSQuerrlSelection(direction: "up" | "down" | "left" | "right") {
  if (!squerrlPickerOptionsEl) {
    return;
  }

  const options = Array.from(squerrlPickerOptionsEl.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]"));
  const columnCount = 4;
  let targetIndex = squerrlSelectedIndex;

  if (direction === "up") {
    targetIndex -= columnCount;
    if (targetIndex < 0) {
      squerrlTableSearchEl?.focus();
      return;
    }
  } else if (direction === "down") {
    targetIndex = Math.min(squerrlSelectedIndex + columnCount, options.length - 1);
  } else if (direction === "left") {
    targetIndex = (squerrlSelectedIndex - 1 + options.length) % options.length;
  } else if (direction === "right") {
    targetIndex = (squerrlSelectedIndex + 1) % options.length;
  }

  focusSQuerrlSelection(targetIndex);
}

function selectActiveSQuerrlSuggestion() {
  const option = squerrlPickerOptionsEl?.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]")[squerrlSelectedIndex];
  if (!option) {
    return;
  }

  selectSQuerrlSuggestion({
    label: option.textContent?.trim() ?? "",
    value: option.dataset.squerrlValue ?? "",
  });
}

function commitSQuerrlFields() {
  const context = getSQuerrlContext();
  if (!sqlEditorEl || !context || !selectedSQuerrlFields.size) {
    return;
  }

  sqlEditorEl.setRangeText(`${[...selectedSQuerrlFields].join(", ")} `, context.cursor, context.cursor, "end");
  selectedSQuerrlFields.clear();
  activeSQuerrlStage = "options";
  hideSQuerrlPicker();
  sqlEditorEl.focus();
}

function renderSQuerrlPicker(
  title: string,
  status: string,
  suggestions: SQuerrlSuggestion[],
  context: ReturnType<typeof getSQuerrlContext>,
  searchableTables?: SqlSchemaTable[],
  multiSelect = false,
  showSortControl = false,
  pickerOptions: SQuerrlPickerOptions = {}
) {
  if (!squerrlPickerEl || !squerrlPickerTitleEl || !squerrlPickerStatusEl || !squerrlPickerOptionsEl || !context) {
    return;
  }

  const fieldScopeTables = pickerOptions.fieldScopeTables ?? [];
  const usesFieldScope = fieldScopeTables.length > 0;
  const tableFilterMarkup = usesFieldScope
    ? `<label class="squerrl-picker__table-filter" for="squerrl-table-filter"><span>Table</span><select id="squerrl-table-filter" aria-label="Filter fields by table"><option value="">All tables</option>${fieldScopeTables
        .map((table) => `<option value="${escapeHtml(table.name)}">${escapeHtml(table.name)}</option>`)
        .join("")}</select></label>`
    : "";

  squerrlSelectedIndex = 0;
  squerrlPickerEl.setAttribute("aria-label", `${title}. ${status}`);
  squerrlPickerEl.innerHTML = `${showSortControl ? '<label class="squerrl-picker__sort" for="squerrl-sort-order"><span>Sort</span><select id="squerrl-sort-order" aria-label="Optional SQuerL sort order"><option value="">NO SORT</option><option value="~up ">~up</option><option value="~down ">~down</option></select></label>' : ""}${tableFilterMarkup}<input id="squerrl-table-search" class="squerrl-picker__search" type="search" placeholder="Filter suggestions" autocomplete="off" aria-label="Filter suggestions" /><div class="squerrl-picker__header"><div><span class="squerrl-picker__eyebrow">SQuerrl</span><h3 id="squerrl-picker-title"></h3></div><span id="squerrl-picker-status" class="squerrl-picker__status"></span></div><div id="squerrl-picker-options" class="squerrl-picker__options"></div>`;
  const pickerTitleEl = squerrlPickerEl.querySelector<HTMLElement>("#squerrl-picker-title");
  const pickerStatusEl = squerrlPickerEl.querySelector<HTMLElement>("#squerrl-picker-status");
  const pickerOptionsEl = squerrlPickerEl.querySelector<HTMLElement>("#squerrl-picker-options");
  if (!pickerTitleEl || !pickerStatusEl || !pickerOptionsEl) {
    return;
  }
  squerrlPickerTitleEl = pickerTitleEl;
  squerrlPickerStatusEl = pickerStatusEl;
  squerrlPickerOptionsEl = pickerOptionsEl;
  squerrlTableSearchEl = squerrlPickerEl.querySelector("#squerrl-table-search");
  const tableFilterEl = squerrlPickerEl.querySelector<HTMLSelectElement>("#squerrl-table-filter");
  if (squerrlTableSearchEl && usesFieldScope) {
    squerrlTableSearchEl.value = context.prefix;
  }
  pickerTitleEl.textContent = title;
  pickerStatusEl.textContent = status;
  constrainSQuerrlPickerFocus(() => {
    selectedSQuerrlFields.clear();
    hideSQuerrlPicker();
    sqlEditorEl?.focus();
  });
  pickerOptionsEl.setAttribute("aria-label", multiSelect ? "Field choices. Use Space to mark fields, Enter to use marked fields, or Escape to cancel." : "Suggestions. Use arrow keys to navigate, Enter to select, or Escape to cancel.");

  const sortOrderEl = squerrlPickerEl.querySelector<HTMLSelectElement>("#squerrl-sort-order");
  sortOrderEl?.addEventListener("change", () => {
    if (!sortOrderEl.value || !sqlEditorEl) {
      return;
    }
    const cursor = sqlEditorEl.selectionStart;
    sqlEditorEl.setRangeText(sortOrderEl.value, cursor, cursor, "end");
    sortOrderEl.value = "";
    sqlEditorEl.focus();
  });

  const renderOptions = (items: SQuerrlSuggestion[]) => {
    squerrlPickerOptionsEl!.innerHTML = items.length
      ? items
          .map(
            (suggestion) => `<button type="button" class="squerrl-picker__option${multiSelect && selectedSQuerrlFields.has(suggestion.value.trim()) ? " is-marked" : ""}" data-squerrl-value="${escapeHtml(suggestion.value)}"${multiSelect ? ` aria-pressed="${selectedSQuerrlFields.has(suggestion.value.trim())}"` : ""}>
              <span>${escapeHtml(suggestion.label)}</span>
              ${suggestion.detail ? `<small>${escapeHtml(suggestion.detail)}</small>` : ""}
            </button>`
          )
          .join("")
      : '<p class="squerrl-picker__empty">No matching schema items found.</p>';

    squerrlPickerOptionsEl!.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]").forEach((button) => {
      button.addEventListener("click", () => {
        if (multiSelect) {
          const value = button.dataset.squerrlValue?.trim() ?? "";
          if (value === "*") {
            selectedSQuerrlFields.clear();
          }
          if (selectedSQuerrlFields.has(value)) {
            selectedSQuerrlFields.delete(value);
          } else {
            if (value !== "*") {
              selectedSQuerrlFields.delete("*");
            }
            selectedSQuerrlFields.add(value);
          }
          const selectedIndex = squerrlSelectedIndex;
          renderOptions(items);
          focusSQuerrlSelection(selectedIndex);
          return;
        }
        selectSQuerrlSuggestion({
          label: button.textContent?.trim() ?? "",
          value: button.dataset.squerrlValue ?? "",
        });
      });
      button.addEventListener("keydown", (event) => {
        const key = event.key.toLowerCase();
        if (event.key === "ArrowDown" || key === "s") {
          event.preventDefault();
          moveSQuerrlSelection("down");
        } else if (event.key === "ArrowUp" || key === "w") {
          event.preventDefault();
          moveSQuerrlSelection("up");
        } else if (event.key === "ArrowLeft" || key === "a") {
          event.preventDefault();
          moveSQuerrlSelection("left");
        } else if (event.key === "ArrowRight" || key === "d") {
          event.preventDefault();
          moveSQuerrlSelection("right");
        } else if (event.key === " " && multiSelect) {
          event.preventDefault();
          button.click();
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (multiSelect) {
            commitSQuerrlFields();
          } else {
            selectActiveSQuerrlSuggestion();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          selectedSQuerrlFields.clear();
          hideSQuerrlPicker();
          sqlEditorEl?.focus();
        }
      });
    });
    setSQuerrlSelection(0);
  };

  const tableSuggestions = searchableTables?.map((table) => ({
    label: table.name,
    value: table.name,
    detail: `${table.fields.length} field${table.fields.length === 1 ? "" : "s"}`,
  })) ?? [];

  const buildScopedFieldSuggestions = (tableFilterName: string) => {
    const scopedTables = tableFilterName
      ? fieldScopeTables.filter((table) => table.name === tableFilterName)
      : fieldScopeTables;
    const scopedFields = Array.from(new Set(scopedTables.flatMap((table) => table.fields)))
      .sort((left, right) => left.localeCompare(right))
      .map((field) => ({ label: field, value: field, detail: "field" }));

    if (!pickerOptions.includeStarOption) {
      return scopedFields;
    }

    return [{ label: "*", value: "* ", detail: "all fields" }, ...scopedFields];
  };

  const getFilteredItems = () => {
    const searchTerm = squerrlTableSearchEl?.value.toLowerCase() ?? "";
    if (usesFieldScope) {
      const tableFilterName = tableFilterEl?.value ?? "";
      return buildScopedFieldSuggestions(tableFilterName)
        .filter((item) => item.label.toLowerCase().includes(searchTerm));
    }

    return [...suggestions, ...tableSuggestions]
      .filter((item) => item.label.toLowerCase().includes(searchTerm));
  };

  if (squerrlTableSearchEl) {
    squerrlTableSearchEl.addEventListener("input", () => {
      renderOptions(getFilteredItems());
    });
    squerrlTableSearchEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusSQuerrlSelection(0);
      } else if (event.key === "Enter" && multiSelect) {
        event.preventDefault();
        commitSQuerrlFields();
      } else if (event.key === "Enter" && squerrlSelectedIndex >= 0) {
        event.preventDefault();
        selectActiveSQuerrlSuggestion();
      } else if (event.key === "Escape") {
        event.preventDefault();
        selectedSQuerrlFields.clear();
        hideSQuerrlPicker();
        sqlEditorEl?.focus();
      }
    });
  }

  tableFilterEl?.addEventListener("change", () => {
    renderOptions(getFilteredItems());
  });

  renderOptions(usesFieldScope ? getFilteredItems() : suggestions);
  squerrlPickerEl.hidden = false;
}

async function maybeShowSQuerrlPicker(forceOpen = false) {
  const context = getSQuerrlContext();
  if (!context || (!context.trigger && !forceOpen)) {
    hideSQuerrlPicker();
    return;
  }

  const requestId = ++squerrlRequestId;
  try {
    const schemaKey = getActiveConnectionId() ?? "__internal_workspace__";
    if (squerrlSchemaCacheKey !== schemaKey || !squerrlSchemaCache) {
      squerrlSchemaCache = await invokeBackend<SqlSchemaTable[]>("load_sql_schema", {
        connectionId: getActiveConnectionId(),
      });
      squerrlSchemaCacheKey = schemaKey;
    }
    if (requestId !== squerrlRequestId) {
      return;
    }

    const schema = squerrlSchemaCache;
    const prefix = context.prefix.toLowerCase();
    const tables = schema.filter((table) => table.name.toLowerCase().includes(prefix));
    const selectedTableNames = new Set(
      [...context.beforeCursor.matchAll(/\bfrom\s+([A-Za-z_][A-Za-z0-9$]*)/gi)].map((match) => match[1].toLowerCase())
    );
    const selectedTables = schema.filter((table) => selectedTableNames.has(table.name.toLowerCase()));

    const languageLabel = context.language === "sql" ? "SQL Assist" : context.language === "freeform" ? "Non Assist" : "SQuerL";

    if (context.language === "squerrl" && activeSQuerrlTableName && activeSQuerrlStage === "conditions") {
      const selectedTable = schema.find((table) => table.name === activeSQuerrlTableName);
      if (selectedTable) {
        renderSQuerrlConditionBuilder(selectedTable);
        return;
      }
    }

    if (context.language === "squerrl" && activeSQuerrlTableName && activeSQuerrlStage === "fields") {
      const selectedTable = schema.find((table) => table.name === activeSQuerrlTableName);
      const hasOnlySelectedTable = context.beforeCursor.trim().toLowerCase() === activeSQuerrlTableName.toLowerCase();
      if (selectedTable && hasOnlySelectedTable) {
        renderSQuerrlPicker(
          "Choose fields",
          `SQuerL · ${selectedTable.name} · Space marks fields, Enter uses them, Escape cancels`,
          [
            { label: "*", value: "* ", detail: "all fields" },
            ...selectedTable.fields.map((field) => ({ label: field, value: field, detail: "field" })),
          ],
          context,
          undefined,
          true
        );
        return;
      }
    }

    if (context.language === "freeform") {
      hideSQuerrlPicker();
      return;
    }

    if (context.fromMatch) {
      renderSQuerrlPicker(
        "Choose a table",
        `${languageLabel} · search ${schema.length} tables in the active database`,
        tables.map((table) => ({ label: table.name, value: table.name, detail: `${table.fields.length} field${table.fields.length === 1 ? "" : "s"}` })),
        context,
        schema
      );
      return;
    }

    const isSqlSelectProjection =
      context.language === "sql" &&
      /^\s*select\b/i.test(context.beforeCursor) &&
      !context.hasFrom;

    if (isSqlSelectProjection) {
      renderSQuerrlPicker(
        "Choose fields",
        `SQL Assist · select fields first, then add FROM`,
        [],
        context,
        undefined,
        false,
        false,
        {
          fieldScopeTables: schema,
          includeStarOption: true,
        }
      );
      return;
    }

    if (!context.hasFrom) {
      const keywords = QUERY_KEYWORDS[context.language].filter((suggestion) => suggestion.label.toLowerCase().startsWith(prefix));
      const matchingTables = tables.map((table) => ({
        label: table.name,
        value: table.name,
        detail: `${table.fields.length} field${table.fields.length === 1 ? "" : "s"}`,
      }));
      renderSQuerrlPicker(
        `Start a ${languageLabel} query`,
        `${languageLabel} · SQL prefixes and ${schema.length} database tables`,
        [...keywords, ...matchingTables],
        context,
        schema
      );
      return;
    }

    if (context.hasClause) {
      const fields = selectedTables.flatMap((table) => table.fields).filter((field) => field.toLowerCase().startsWith(prefix));
      const clauses: SQuerrlSuggestion[] = context.beforeCursor.trimEnd().toLowerCase().endsWith("where") || /\bwhere\s+$/i.test(context.beforeCursor)
        ? fields.map((field) => ({ label: field, value: field, detail: "filter field" }))
        : [
            { label: "WHERE", value: "WHERE ", detail: "filter rows" },
            { label: "ORDER BY", value: "ORDER BY ", detail: "sort rows" },
            ...fields.map((field) => ({ label: field, value: field, detail: "sort/filter field" })),
          ].filter((suggestion) => suggestion.label.toLowerCase().startsWith(prefix));
      renderSQuerrlPicker("Shape the query", `${languageLabel} · sort or filter with active fields`, clauses, context);
      return;
    }

    const fields = selectedTables.flatMap((table) => table.fields).filter((field) => field.toLowerCase().startsWith(prefix));
    renderSQuerrlPicker("Choose a field", `${languageLabel} · fields from the selected table`, fields.map((field) => ({ label: field, value: field, detail: "field" })), context);
  } catch (error) {
    if (requestId !== squerrlRequestId) {
      return;
    }
    hideSQuerrlPicker();
    setLauncherMessage(error instanceof Error ? error.message : String(error), true);
  }
}

function populatePresetForm(preset: ConnectionPreset | null) {
  if (
    !presetIdEl ||
    !presetNameEl ||
    !presetEngineEl ||
    !presetLaunchUrlEl ||
    !presetHostEl ||
    !presetPortEl ||
    !presetDatabaseEl ||
    !presetUsernameEl ||
    !presetPasswordEl ||
    !presetAuthModeEl ||
    !presetDomainEl
  ) {
    return;
  }

  presetIdEl.value = preset?.id ?? "";
  presetNameEl.value = preset?.name ?? "";
  presetEngineEl.value = preset?.engine ?? "mssql";
  presetLaunchUrlEl.value = preset?.launchUrl ?? "";
  presetHostEl.value = preset?.host ?? "";
  presetPortEl.value = preset?.port ?? "";
  presetDatabaseEl.value = preset?.database ?? "";
  presetUsernameEl.value = preset?.username ?? "";
  presetPasswordEl.value = preset?.password ?? "";
  presetAuthModeEl.value = preset?.authMode ?? "sql";
  presetDomainEl.value = preset?.domain ?? "";
}

function renderPresetList() {
  if (!databaseSelectorEl) {
    return;
  }

  // Clear existing options except the internal one
  databaseSelectorEl.innerHTML = '<option value="internal">Internal workspace database</option>';

  // Add external connections as options
  connectionPresets.forEach((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    databaseSelectorEl!.appendChild(option);
  });

  updateDatabaseSelector();
}

function syncLauncherUrlToActivePreset() {
  const preset = getPresetById(activePresetId);
  if (launcherUrlEl && preset?.launchUrl) {
    launcherUrlEl.value = preset.launchUrl;
  }
}

function useInternalWorkspaceAsDefault() {
  activePresetId = null;
  renderPresetList();
  void refreshSavedQueries();
  setLauncherMessage("Internal workspace database is now the default.");
  void persistPresetStore().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  });
}

function resetPresetForm() {
  populatePresetForm(null);
}

function readPresetForm(): ConnectionPreset {
  if (
    !presetNameEl ||
    !presetEngineEl ||
    !presetLaunchUrlEl ||
    !presetHostEl ||
    !presetPortEl ||
    !presetDatabaseEl ||
    !presetUsernameEl ||
    !presetPasswordEl ||
    !presetAuthModeEl ||
    !presetDomainEl ||
    !presetIdEl
  ) {
    throw new Error("Connection form is unavailable.");
  }

  const name = presetNameEl.value.trim();
  if (!name) {
    throw new Error("Connection name is required.");
  }

  const launchUrl = presetLaunchUrlEl.value.trim();
  if (launchUrl) {
    try {
      const parsedUrl = new URL(launchUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Preferred SQL app URL must start with http:// or https://.");
      }
    } catch {
      throw new Error("Preferred SQL app URL must start with http:// or https://.");
    }
  }

  return {
    id: presetIdEl.value || crypto.randomUUID(),
    name,
    engine: presetEngineEl.value as PresetEngine,
    launchUrl,
    host: presetHostEl.value.trim(),
    port: presetPortEl.value.trim(),
    database: presetDatabaseEl.value.trim(),
    username: presetUsernameEl.value.trim(),
    password: presetPasswordEl.value,
    authMode: presetAuthModeEl.value as ConnectionPreset["authMode"],
    domain: presetDomainEl.value.trim(),
  };
}

async function savePreset(event: SubmitEvent) {
  event.preventDefault();

  try {
    const preset = readPresetForm();
    const existingIndex = connectionPresets.map((entry) => entry.id).indexOf(preset.id);

    if (existingIndex >= 0) {
      connectionPresets[existingIndex] = preset;
    } else {
      connectionPresets.unshift(preset);
    }

    activePresetId = preset.id;
    await persistPresetStore();
    renderPresetList();
    syncLauncherUrlToActivePreset();
    void refreshSavedQueries();
    setLauncherMessage(`Saved external connection ${preset.name}.`);
    closeConnectionModal();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  }
}

function getTargetUrl() {
  if (!launcherUrlEl) {
    throw new Error("Launcher URL input is unavailable.");
  }

  const value = launcherUrlEl.value.trim();
  if (!value) {
    throw new Error("Enter a SQL app URL first.");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("Use a full URL starting with http:// or https://.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  return parsedUrl.toString();
}

function setLauncherBusy(isBusy: boolean) {
  openTauriButtonEl?.toggleAttribute("disabled", isBusy);
  openBrowserButtonEl?.toggleAttribute("disabled", isBusy);
  launchMenuButtonEl?.toggleAttribute("disabled", isBusy);
  footerBrowserLinkEl?.toggleAttribute("disabled", isBusy);
  launcherUrlEl?.toggleAttribute("aria-busy", isBusy);
}

function setPresetBusy(isBusy: boolean) {
  presetFormEl?.querySelectorAll("input, select, button").forEach((element) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement
    ) {
      element.toggleAttribute("disabled", isBusy);
    }
  });
}

function getLaunchMenuItems() {
  if (!launchMenuEl) {
    return [] as HTMLButtonElement[];
  }

  return Array.from(launchMenuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function focusLaunchMenuItem(index: number) {
  const items = getLaunchMenuItems();
  if (!items.length) {
    return;
  }

  const boundedIndex = Math.max(0, Math.min(index, items.length - 1));
  items[boundedIndex]?.focus();
}

function setLaunchMenuOpen(isOpen: boolean, focusTarget?: "first" | "last" | "button") {
  if (!launchMenuButtonEl || !launchMenuEl) {
    return;
  }

  launchMenuButtonEl.setAttribute("aria-expanded", String(isOpen));
  launchMenuEl.hidden = !isOpen;

  if (!isOpen) {
    if (focusTarget === "button") {
      launchMenuButtonEl.focus();
    }
    return;
  }

  if (focusTarget === "last") {
    const items = getLaunchMenuItems();
    focusLaunchMenuItem(items.length - 1);
    return;
  }

  if (focusTarget === "first") {
    focusLaunchMenuItem(0);
  }
}

function toggleLaunchMenu(focusTarget?: "first" | "last") {
  if (!launchMenuButtonEl) {
    return;
  }

  const isOpen = launchMenuButtonEl.getAttribute("aria-expanded") === "true";
  setLaunchMenuOpen(!isOpen, !isOpen ? focusTarget : undefined);
}

function moveLaunchMenuFocus(step: 1 | -1) {
  const items = getLaunchMenuItems();
  if (!items.length) {
    return;
  }

  const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = activeIndex < 0 ? 0 : (activeIndex + step + items.length) % items.length;
  items[nextIndex]?.focus();
}

async function testPresetConnection() {
  try {
    const preset = readPresetForm();
    setPresetBusy(true);
    const result = await invokeBackend<ConnectionTestResult>("test_connection", { preset });
    setLauncherMessage(result.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  } finally {
    setPresetBusy(false);
  }
}

async function runSql() {
  if (!sqlEditorEl) {
    return;
  }

  const editorStatement = sqlEditorEl.value.trim();
  if (!editorStatement) {
    setLauncherMessage("Enter a SQL query first.", true);
    return;
  }

  try {
    const connectionId = getActiveConnectionId();
    const queryLanguage = getEffectiveQueryLanguage();
    const bufferedSQuerrlStatement = queryLanguage === "squerrl"
      ? normalizeSQuerrlStatement(editorStatement)
      : null;
    const execution = prepareSqlExecution(editorStatement);
    runSqlButtonEl?.toggleAttribute("disabled", true);
    clearSqlButtonEl?.toggleAttribute("disabled", true);

    if (bufferedSQuerrlStatement) {
      sqlEditorEl.value = execution.statement;
      setEditorLanguage("sql", execution.statement);
    }

    sqlResultsStatusEl!.textContent = execution.squerrlStatement
      ? `Buffered SQuerL. Translated to SQL. Running against ${connectionId ?? "internal workspace database"}...`
      : `Running SQL against ${connectionId ?? "internal workspace database"}...`;
    setLauncherMessage(execution.squerrlStatement
      ? "SQuerL buffered, translated to SQL, and running query..."
      : "Running SQL query...");
    const result = await invokeBackend<SqlQueryResult>("execute_sql_query", {
      connectionId,
      sql: execution.statement,
    });
    renderSqlResults(result);

    const hasSqlMemoryStatement = await invokeBackend<boolean>("has_sql_memory_statement", {
      connectionId,
      statement: execution.statement,
    });

    if (!hasSqlMemoryStatement) {
      await invokeBackend("record_sql_memory", {
        connectionId,
        statement: execution.statement,
        squerrlStatement: bufferedSQuerrlStatement,
      });
    }

    await refreshSavedQueries();
    setLauncherMessage(result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderSqlResults(null);
    setLauncherMessage(message, true);
  } finally {
    runSqlButtonEl?.toggleAttribute("disabled", false);
    clearSqlButtonEl?.toggleAttribute("disabled", false);
  }
}

async function openSqlApp(mode: "tauri" | "browser") {
  try {
    const targetUrl = getTargetUrl();
    setLauncherBusy(true);

    if (mode === "tauri") {
      setLaunchMenuOpen(false);
      await invokeBackend("open_sql_window", { url: targetUrl });
      setLauncherMessage(`Opened ${targetUrl} in a new Tauri window.`);
      void recordAppEvent("ui.launch.tauri", `Opened SQL app in a Tauri window for ${targetUrl}`);
      return;
    }

    setLaunchMenuOpen(false);
    await openUrl(targetUrl);
    setLauncherMessage(`Opened ${targetUrl} in your default browser.`);
    void recordAppEvent("ui.launch.browser", `Opened SQL app in the default browser for ${targetUrl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
    void recordAppEvent("ui.launch.error", `Failed to open SQL app in ${mode} mode: ${message}`);
  } finally {
    setLauncherBusy(false);
  }
}

let hasInitializedApp = false;

function initializeApp() {
  if (hasInitializedApp) {
    return;
  }

  hasInitializedApp = true;

  launcherUrlEl = document.querySelector("#launcher-url");
  launcherMsgEl = document.querySelector("#launcher-msg");
  openTauriButtonEl = document.querySelector("#open-tauri-button");
  openBrowserButtonEl = document.querySelector("#open-browser-button");
  launchMenuButtonEl = document.querySelector("#launch-menu-button");
  launchMenuEl = document.querySelector("#launch-menu");
  footerBrowserLinkEl = document.querySelector("#footer-browser-link");
  databaseSelectorEl = document.querySelector("#database-selector");
  toggleFavoriteDatabaseEl = document.querySelector("#toggle-favorite-database");
  addDatabaseButtonEl = document.querySelector("#add-database-button");
  workspaceDbPathEl = document.querySelector("#workspace-db-path");
  workspaceDbSummaryEl = document.querySelector("#workspace-db-summary");
  useInternalDbButtonEl = document.querySelector("#use-internal-db-button");
  sqlEditorFormEl = document.querySelector("#sql-editor-form");
  sqlEditorEl = document.querySelector("#sql-editor");
  queryLanguageEl = document.querySelector("#query-language");
  savedQueryDropdownEl = document.querySelector("#saved-query-dropdown");
  querySearchButtonEl = document.querySelector("#query-search-button");
  appLogButtonEl = document.querySelector("#app-log-button");
  runSqlButtonEl = document.querySelector("#run-sql-button");
  clearSqlButtonEl = document.querySelector("#clear-sql-button");
  squerrlPickerEl = document.querySelector("#squerrl-picker");
  squerrlPickerTitleEl = document.querySelector("#squerrl-picker-title");
  squerrlPickerStatusEl = document.querySelector("#squerrl-picker-status");
  squerrlPickerOptionsEl = document.querySelector("#squerrl-picker-options");
  squerrlTableSearchEl = document.querySelector("#squerrl-table-search");
  squerrlSortOverlayEl = document.querySelector("#squerrl-sort-overlay");
  sqlResultsStatusEl = document.querySelector("#sql-results-status");
  sqlResultsOutputEl = document.querySelector("#sql-results-output");
  querySearchModalEl = document.querySelector("#query-search-modal");
  querySearchInputEl = document.querySelector("#query-search-input");
  queryDateFromEl = document.querySelector("#query-date-from");
  queryDateToEl = document.querySelector("#query-date-to");
  querySearchResultsEl = document.querySelector("#query-search-results");
  loadQueryFromSearchButtonEl = document.querySelector("#load-query-from-search-button");
  clearQuerySearchButtonEl = document.querySelector("#clear-query-search-button");
  closeQuerySearchModalButtonEl = document.querySelector("#close-query-search-modal-button");
  appLogModalEl = document.querySelector("#app-log-modal");
  appLogSearchInputEl = document.querySelector("#app-log-search-input");
  appLogKindFilterEl = document.querySelector("#app-log-kind-filter");
  appLogDateFromEl = document.querySelector("#app-log-date-from");
  appLogDateToEl = document.querySelector("#app-log-date-to");
  appLogResultsEl = document.querySelector("#app-log-results");
  refreshAppLogButtonEl = document.querySelector("#refresh-app-log-button");
  clearAppLogFiltersButtonEl = document.querySelector("#clear-app-log-filters-button");
  closeAppLogModalButtonEl = document.querySelector("#close-app-log-modal-button");
  presetFormEl = document.querySelector("#preset-form");
  presetIdEl = document.querySelector("#preset-id");
  presetNameEl = document.querySelector("#preset-name");
  presetEngineEl = document.querySelector("#preset-engine");
  presetLaunchUrlEl = document.querySelector("#preset-launch-url");
  presetHostEl = document.querySelector("#preset-host");
  presetPortEl = document.querySelector("#preset-port");
  presetDatabaseEl = document.querySelector("#preset-database");
  presetUsernameEl = document.querySelector("#preset-username");
  presetPasswordEl = document.querySelector("#preset-password");
  presetAuthModeEl = document.querySelector("#preset-auth-mode");
  presetDomainEl = document.querySelector("#preset-domain");
  testPresetButtonEl = document.querySelector("#test-preset-button");
  resetPresetButtonEl = document.querySelector("#reset-preset-button");
  connectionModalEl = document.querySelector("#connection-modal");
  closeConnectionModalButtonEl = document.querySelector("#close-connection-modal-button");
  applyRuntimeAvailabilityState();
  installTopHorizontalScrollbar();
  renderSqlResults(null);

  void invokeBackend<WorkspaceDatabaseInfo>("load_workspace_database_info")
    .then((info) => {
      workspaceDatabaseInfo = info;
      renderWorkspaceDatabaseInfo();
      void refreshSavedQueries();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setLauncherMessage(message, true);
      renderWorkspaceDatabaseInfo();
    });

  void loadPresetStore()
    .then(async (store) => {
      if (!store.presets.length) {
        const legacyStore = readLegacyPresetStore();
        if (legacyStore.presets.length) {
          connectionPresets = legacyStore.presets;
          activePresetId = legacyStore.activePresetId;
          await persistPresetStore();
          renderPresetList();
          syncLauncherUrlToActivePreset();
          void refreshSavedQueries();
          setLauncherMessage("Migrated existing presets into Rusty Pythia storage.");
          return;
        }
      }

      connectionPresets = store.presets;
      activePresetId = store.activePresetId;
      renderPresetList();
      syncLauncherUrlToActivePreset();
      void refreshSavedQueries();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setLauncherMessage(message, true);
    });

  document.querySelector("#launcher-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void openSqlApp("tauri");
  });

  sqlEditorFormEl?.addEventListener("submit", (event) => {
    event.preventDefault();
    void runSql();
  });

  runSqlButtonEl?.addEventListener("click", () => {
    void runSql();
  });

  sqlEditorEl?.addEventListener("input", () => {
    if (!sqlEditorEl!.value.trim()) {
      activeQueryLanguage = null;
      activeSQuerrlTableName = null;
      activeSQuerrlStage = null;
      selectedSQuerrlFields.clear();
    }
    hideSQuerrlPicker();
  });

  queryLanguageEl?.addEventListener("change", () => {
    const nextLanguage = queryLanguageEl!.value as QueryLanguage;
    setEditorLanguage(nextLanguage, sqlEditorEl?.value ?? "");
    hideSQuerrlPicker();
    void maybeShowSQuerrlPicker();
    const modeLabel = queryLanguageEl!.options[queryLanguageEl!.selectedIndex].text;
    setLauncherMessage(`${modeLabel} selected.`);
    void recordAppEvent("ui.query.mode", `Switched query authoring mode to ${modeLabel}`);
  });

  sqlEditorEl?.addEventListener("click", () => {
    void maybeShowSQuerrlPicker();
  });

  sqlEditorEl?.addEventListener("keydown", (event) => {
    const activeLanguage = getEffectiveQueryLanguage();

    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !isAssistLanguage(activeLanguage)) {
      return;
    }

    if (event.key === "ArrowDown" && activeQueryLanguage === "squerrl" && activeSQuerrlStage === "options") {
      event.preventDefault();
      openSQuerrlSortOverlay();
      return;
    }

    if (squerrlPickerEl?.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        void maybeShowSQuerrlPicker(true).then(() => {
          const options = squerrlPickerOptionsEl?.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]");
          if (!options?.length) {
            return;
          }
          if (event.key === "ArrowUp") {
            focusSQuerrlSelection(options.length - 1);
            return;
          }
          focusSQuerrlSelection(0);
        });
      }
      return;
    }

    const options = squerrlPickerOptionsEl?.querySelectorAll<HTMLButtonElement>("[data-squerrl-value]");
    const selectedOption = options?.[squerrlSelectedIndex];
    if (event.key === "ArrowDown" && options?.length) {
      event.preventDefault();
      setSQuerrlSelection(squerrlSelectedIndex + 1);
    } else if (event.key === "ArrowUp" && options?.length) {
      event.preventDefault();
      setSQuerrlSelection(squerrlSelectedIndex - 1);
    } else if ((event.key === "Enter" || event.key === "Tab" || event.key === "ArrowRight") && selectedOption) {
      event.preventDefault();
      selectActiveSQuerrlSuggestion();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideSQuerrlPicker();
      sqlEditorEl?.focus();
    }
  });

  squerrlSortOverlayEl?.addEventListener("change", () => {
    if (squerrlSortOverlayEl!.value && sqlEditorEl) {
      const cursor = sqlEditorEl.selectionStart;
      sqlEditorEl.setRangeText(squerrlSortOverlayEl!.value, cursor, cursor, "end");
    }
    squerrlSortOverlayEl!.value = "";
    squerrlSortOverlayEl!.hidden = true;
    sqlEditorEl?.focus();
  });

  squerrlSortOverlayEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      squerrlSortOverlayEl!.value = "";
      squerrlSortOverlayEl!.hidden = true;
      sqlEditorEl?.focus();
    }
  });

  presetFormEl?.addEventListener("submit", (event) => {
    void savePreset(event);
  });

  savedQueryDropdownEl?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    const query = target.value;
    const selectedOption = target.selectedOptions[0];
    const queryLanguage = (selectedOption?.dataset.queryLanguage as QueryLanguage | undefined) ?? "sql";

    if (query && sqlEditorEl) {
      sqlEditorEl.value = query;
      setEditorLanguage(queryLanguage, query);
      setLauncherMessage("Query loaded into workspace.");
      void recordAppEvent("ui.query.load.saved", `Loaded a saved ${queryLanguage === "squerrl" ? "SQuerL" : "SQL"} statement from the dropdown`);
      target.value = ""; // Reset dropdown
    }
  });

  querySearchButtonEl?.addEventListener("click", () => {
    openQuerySearchModal();
    void performQuerySearch();
    void recordAppEvent("ui.query.search.open", "Opened the saved-query search modal");
  });

  appLogButtonEl?.addEventListener("click", () => {
    openAppLogModal();
    void refreshAppLog();
    void recordAppEvent("ui.app-log.open", "Opened the application log viewer");
  });

  resetPresetButtonEl?.addEventListener("click", () => {
    resetPresetForm();
    setLauncherMessage("Ready to add a new external connection.");
    void recordAppEvent("ui.connection.reset", "Reset the connection form for a new external connection");
  });

  clearSqlButtonEl?.addEventListener("click", () => {
    if (sqlEditorEl) {
      sqlEditorEl.value = "";
      sqlEditorEl.focus();
    }
    activeQueryLanguage = null;
    activeSQuerrlTableName = null;
    activeSQuerrlStage = null;
    selectedSQuerrlFields.clear();
    hideSQuerrlPicker();
    renderSqlResults(null);
    void recordAppEvent("ui.query.clear", "Cleared the SQL workspace editor and results surface");
  });

  useInternalDbButtonEl?.addEventListener("click", () => {
    useInternalWorkspaceAsDefault();
  });

  databaseSelectorEl?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    const selectedValue = target.value;

    // Switch to selected database
    if (selectedValue === "internal") {
      activePresetId = null;
    } else {
      activePresetId = selectedValue;
    }

    void persistPresetStore();
    syncLauncherUrlToActivePreset();
    void refreshSavedQueries();
    updateDatabaseSelector();
    setLauncherMessage(`Switched to database: ${databaseSelectorEl!.options[databaseSelectorEl!.selectedIndex].text}`);
    void recordAppEvent("ui.database.switch", `Switched active database target to ${databaseSelectorEl!.options[databaseSelectorEl!.selectedIndex].text}`);
  });

  toggleFavoriteDatabaseEl?.addEventListener("click", () => {
    // When internal is active, it's already the default (is-favorite state)
    // This button doesn't need to do anything more since internal is always the implicit default
    // But we can optionally show a message
    if (activePresetId === null) {
      setLauncherMessage("Internal workspace database is your default.");
      void recordAppEvent("ui.database.default", "Viewed the current default database setting for the internal workspace database");
    } else {
      // Switch to internal as default
      activePresetId = null;
      void persistPresetStore();
      syncLauncherUrlToActivePreset();
      void refreshSavedQueries();
      updateDatabaseSelector();
      setLauncherMessage("Internal workspace database is now your default.");
      void recordAppEvent("ui.database.default", "Set the internal workspace database as the default target");
    }
  });

  addDatabaseButtonEl?.addEventListener("click", () => {
    resetPresetForm();
    openConnectionModal();
    void recordAppEvent("ui.connection.open", "Opened the external connection modal");
  });

  closeConnectionModalButtonEl?.addEventListener("click", () => {
    closeConnectionModal();
    void recordAppEvent("ui.connection.close", "Closed the external connection modal");
  });

  closeQuerySearchModalButtonEl?.addEventListener("click", () => {
    closeQuerySearchModal();
    void recordAppEvent("ui.query.search.close", "Closed the saved-query search modal");
  });

  querySearchInputEl?.addEventListener("input", () => {
    void performQuerySearch();
  });

  queryDateFromEl?.addEventListener("change", () => {
    void performQuerySearch();
  });

  queryDateToEl?.addEventListener("change", () => {
    void performQuerySearch();
  });

  clearQuerySearchButtonEl?.addEventListener("click", () => {
    if (querySearchInputEl) querySearchInputEl.value = "";
    if (queryDateFromEl) queryDateFromEl.value = "";
    if (queryDateToEl) queryDateToEl.value = "";
    void populateQuerySearchResults([]);
    void recordAppEvent("ui.query.search.clear", "Cleared saved-query search filters");
  });

  loadQueryFromSearchButtonEl?.addEventListener("click", () => {
    void loadQueryFromSearch().then((wasLoaded) => {
      if (wasLoaded) {
        void recordAppEvent("ui.query.load.search", "Loaded a saved query from the query search modal");
      }
    });
  });

  closeAppLogModalButtonEl?.addEventListener("click", () => {
    closeAppLogModal();
    void recordAppEvent("ui.app-log.close", "Closed the application log viewer");
  });

  refreshAppLogButtonEl?.addEventListener("click", () => {
    void refreshAppLog();
    void recordAppEvent("ui.app-log.refresh", "Refreshed the application log viewer");
  });

  clearAppLogFiltersButtonEl?.addEventListener("click", () => {
    if (appLogSearchInputEl) appLogSearchInputEl.value = "";
    if (appLogKindFilterEl) appLogKindFilterEl.value = "";
    if (appLogDateFromEl) appLogDateFromEl.value = "";
    if (appLogDateToEl) appLogDateToEl.value = "";
    applyAppLogFilters();
    void recordAppEvent("ui.app-log.clear", "Cleared application log filters");
  });

  appLogSearchInputEl?.addEventListener("input", () => {
    applyAppLogFilters();
  });

  appLogKindFilterEl?.addEventListener("change", () => {
    applyAppLogFilters();
  });

  appLogDateFromEl?.addEventListener("change", () => {
    applyAppLogFilters();
  });

  appLogDateToEl?.addEventListener("change", () => {
    applyAppLogFilters();
  });

  testPresetButtonEl?.addEventListener("click", () => {
    void testPresetConnection();
  });

  launchMenuButtonEl?.addEventListener("click", () => {
    toggleLaunchMenu();
  });

  launchMenuButtonEl?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setLaunchMenuOpen(true, "first");
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setLaunchMenuOpen(true, "last");
    }
  });

  openBrowserButtonEl?.addEventListener("click", () => {
    void openSqlApp("browser");
  });

  footerBrowserLinkEl?.addEventListener("click", () => {
    void openSqlApp("browser");
  });

  document.addEventListener("click", (event) => {
    if (!launchMenuEl || !launchMenuButtonEl) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (launchMenuEl.contains(target) || launchMenuButtonEl.contains(target)) {
      return;
    }

    setLaunchMenuOpen(false);
  });

  launchMenuEl?.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveLaunchMenuFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveLaunchMenuFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        focusLaunchMenuItem(0);
        break;
      case "End": {
        event.preventDefault();
        const items = getLaunchMenuItems();
        focusLaunchMenuItem(items.length - 1);
        break;
      }
      case "Tab":
        setLaunchMenuOpen(false);
        break;
      case "Escape":
        event.preventDefault();
        setLaunchMenuOpen(false, "button");
        break;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setLaunchMenuOpen(false, "button");
    }
  });

  setLauncherMessage("Rusty Pythia workspace ready.");
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initializeApp, { once: true });
} else {
  initializeApp();
}
