import "bootstrap/dist/css/bootstrap.min.css";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

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
let savedQueryDropdownEl: HTMLSelectElement | null;
let querySearchButtonEl: HTMLButtonElement | null;
let runSqlButtonEl: HTMLButtonElement | null;
let clearSqlButtonEl: HTMLButtonElement | null;
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

const PRESET_STORAGE_KEY = "rusty-pythia.connection-presets";
const ACTIVE_PRESET_STORAGE_KEY = "rusty-pythia.active-preset";

let connectionPresets: ConnectionPreset[] = [];
let activePresetId: string | null = null;
let workspaceDatabaseInfo: WorkspaceDatabaseInfo | null = null;

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
  const store = await invoke<PresetStore>("load_preset_store");
  return {
    activePresetId: store.activePresetId ?? null,
    presets: Array.isArray(store.presets)
      ? store.presets.map((preset) => normalizePreset(preset))
      : [],
  } satisfies PresetStore;
}

async function persistPresetStore() {
  await invoke("save_preset_store", {
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

async function performQuerySearch() {
  try {
    const searchText = querySearchInputEl?.value ?? "";
    const dateFrom = queryDateFromEl?.value ?? "";
    const dateTo = queryDateToEl?.value ?? "";

    const entries = await invoke<SqlMemoryEntry[]>("load_sql_memory", {
      connectionId: getActiveConnectionId(),
      limit: 100,
    });

    let filtered = entries;

    // Filter by search text
    if (searchText) {
      const lowerSearch = searchText.toLowerCase();
      filtered = filtered.filter((entry) =>
        entry.statement.toLowerCase().includes(lowerSearch)
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
      <div class="query-search-result-item" data-query-text="${escapeHtml(entry.statement)}">
        <p class="query-search-result-item__text">${escapeHtml(entry.statement)}</p>
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
    return;
  }

  const queryText = selectedItem.dataset.queryText;
  if (!queryText || !sqlEditorEl) {
    return;
  }

  sqlEditorEl.value = queryText;
  closeQuerySearchModal();
  setLauncherMessage("Query loaded from search.");
}

async function refreshSavedQueries() {
  try {
    const entries = await invoke<SqlMemoryEntry[]>("load_sql_memory", {
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
    option.value = entry.statement;
    option.title = entry.statement; // Full query shown on hover
    option.textContent = entry.statement.substring(0, 60) + (entry.statement.length > 60 ? "..." : "");
    savedQueryDropdownEl!.appendChild(option);
  });
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
    const result = await invoke<ConnectionTestResult>("test_connection", { preset });
    setLauncherMessage(result.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  } finally {
    setPresetBusy(false);
  }
}

async function runSql(event: SubmitEvent) {
  event.preventDefault();

  if (!sqlEditorEl) {
    return;
  }

  const sql = sqlEditorEl.value.trim();
  if (!sql) {
    setLauncherMessage("Enter a SQL query first.", true);
    return;
  }

  try {
    runSqlButtonEl?.toggleAttribute("disabled", true);
    clearSqlButtonEl?.toggleAttribute("disabled", true);
    const result = await invoke<SqlQueryResult>("execute_sql_query", {
      connectionId: getActiveConnectionId(),
      sql,
    });
    renderSqlResults(result);
    await invoke("record_sql_memory", {
      connectionId: getActiveConnectionId(),
      statement: sql,
    });
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
      await invoke("open_sql_window", { url: targetUrl });
      setLauncherMessage(`Opened ${targetUrl} in a new Tauri window.`);
      return;
    }

    setLaunchMenuOpen(false);
    await openUrl(targetUrl);
    setLauncherMessage(`Opened ${targetUrl} in your default browser.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  } finally {
    setLauncherBusy(false);
  }
}

window.addEventListener("DOMContentLoaded", () => {
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
  savedQueryDropdownEl = document.querySelector("#saved-query-dropdown");
  querySearchButtonEl = document.querySelector("#query-search-button");
  runSqlButtonEl = document.querySelector("#run-sql-button");
  clearSqlButtonEl = document.querySelector("#clear-sql-button");
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
  installTopHorizontalScrollbar();
  renderSqlResults(null);

  void invoke<WorkspaceDatabaseInfo>("load_workspace_database_info")
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
    void runSql(event);
  });

  presetFormEl?.addEventListener("submit", (event) => {
    void savePreset(event);
  });

  savedQueryDropdownEl?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    const query = target.value;

    if (query && sqlEditorEl) {
      sqlEditorEl.value = query;
      setLauncherMessage("Query loaded into workspace.");
      target.value = ""; // Reset dropdown
    }
  });

  querySearchButtonEl?.addEventListener("click", () => {
    openQuerySearchModal();
  });

  resetPresetButtonEl?.addEventListener("click", () => {
    resetPresetForm();
    setLauncherMessage("Ready to add a new external connection.");
  });

  clearSqlButtonEl?.addEventListener("click", () => {
    if (sqlEditorEl) {
      sqlEditorEl.value = "";
      sqlEditorEl.focus();
    }
    renderSqlResults(null);
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
  });

  toggleFavoriteDatabaseEl?.addEventListener("click", () => {
    // When internal is active, it's already the default (is-favorite state)
    // This button doesn't need to do anything more since internal is always the implicit default
    // But we can optionally show a message
    if (activePresetId === null) {
      setLauncherMessage("Internal workspace database is your default.");
    } else {
      // Switch to internal as default
      activePresetId = null;
      void persistPresetStore();
      syncLauncherUrlToActivePreset();
      void refreshSavedQueries();
      updateDatabaseSelector();
      setLauncherMessage("Internal workspace database is now your default.");
    }
  });

  addDatabaseButtonEl?.addEventListener("click", () => {
    resetPresetForm();
    openConnectionModal();
  });

  closeConnectionModalButtonEl?.addEventListener("click", () => {
    closeConnectionModal();
  });

  closeQuerySearchModalButtonEl?.addEventListener("click", () => {
    closeQuerySearchModal();
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
  });

  loadQueryFromSearchButtonEl?.addEventListener("click", () => {
    void loadQueryFromSearch();
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
});
