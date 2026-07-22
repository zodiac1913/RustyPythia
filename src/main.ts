import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

let launcherUrlEl: HTMLInputElement | null;
let launcherMsgEl: HTMLElement | null;
let openTauriButtonEl: HTMLButtonElement | null;
let openBrowserButtonEl: HTMLButtonElement | null;
let launchMenuButtonEl: HTMLButtonElement | null;
let launchMenuEl: HTMLElement | null;
let footerBrowserLinkEl: HTMLButtonElement | null;
let activePresetNameEl: HTMLElement | null;
let activePresetSummaryEl: HTMLElement | null;
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
let presetListEl: HTMLElement | null;
let presetListStatusEl: HTMLElement | null;

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

const PRESET_STORAGE_KEY = "rusty-pythia.connection-presets";
const ACTIVE_PRESET_STORAGE_KEY = "rusty-pythia.active-preset";

let connectionPresets: ConnectionPreset[] = [];
let activePresetId: string | null = null;

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

function updateActivePresetSummary() {
  const preset = getPresetById(activePresetId);

  if (!activePresetNameEl || !activePresetSummaryEl) {
    return;
  }

  if (!preset) {
    activePresetNameEl.textContent = "No external connection";
    activePresetSummaryEl.textContent =
      "Rusty Pythia still uses its internal workspace database even when no external connection is selected.";
    return;
  }

  activePresetNameEl.textContent = preset.name;
  activePresetSummaryEl.textContent = `${preset.engine.toUpperCase()} · ${preset.database || "No default database"} · ${preset.host || "No host"}`;
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
  if (!presetListEl || !presetListStatusEl) {
    return;
  }

  presetListEl.innerHTML = "";

  if (!connectionPresets.length) {
    presetListStatusEl.textContent = "No external connections saved yet.";
    presetListEl.innerHTML = '<p class="preset-list__empty">Create an external connection only if you want reusable launch or test defaults.</p>';
    updateActivePresetSummary();
    return;
  }

  presetListStatusEl.textContent = `${connectionPresets.length} external connection${connectionPresets.length === 1 ? "" : "s"} stored locally.`;

  presetListEl.innerHTML = connectionPresets
    .map((preset) => {
      const isActive = preset.id === activePresetId;
      const databaseLabel = preset.database || "No default DB";

      return `
        <article class="preset-list__item${isActive ? " is-active" : ""}">
          <div class="preset-list__meta">
            <p class="preset-list__name">${preset.name}</p>
            <p class="preset-list__details">${preset.engine.toUpperCase()} · ${databaseLabel}</p>
            <p class="preset-list__details">${preset.host || "No host"}</p>
            <p class="preset-list__details">${preset.authMode.toUpperCase()}${preset.domain ? ` · ${preset.domain}` : ""}</p>
          </div>
          <div class="preset-list__actions">
            <button type="button" class="preset-action" data-preset-action="activate" data-preset-id="${preset.id}">${isActive ? "Active" : "Use"}</button>
            <button type="button" class="preset-action" data-preset-action="edit" data-preset-id="${preset.id}">Edit</button>
            <button type="button" class="preset-action preset-action--danger" data-preset-action="delete" data-preset-id="${preset.id}">Delete</button>
          </div>
        </article>
      `;
    })
    .join("");

  updateActivePresetSummary();
}

function syncLauncherUrlToActivePreset() {
  const preset = getPresetById(activePresetId);
  if (launcherUrlEl && preset?.launchUrl) {
    launcherUrlEl.value = preset.launchUrl;
  }
}

function activatePreset(id: string) {
  const preset = getPresetById(id);
  if (!preset) {
    return;
  }

  activePresetId = preset.id;
  populatePresetForm(preset);
  syncLauncherUrlToActivePreset();
  renderPresetList();
  setLauncherMessage(`Activated external connection ${preset.name}.`);
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
    setLauncherMessage(`Saved external connection ${preset.name}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLauncherMessage(message, true);
  }
}

function handlePresetListClick(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const actionButton = target.closest<HTMLElement>("[data-preset-action]");
  if (!actionButton) {
    return;
  }

  const presetId = actionButton.dataset.presetId;
  const action = actionButton.dataset.presetAction;
  if (!presetId || !action) {
    return;
  }

  if (action === "activate") {
    activatePreset(presetId);
    return;
  }

  if (action === "edit") {
    populatePresetForm(getPresetById(presetId));
    setLauncherMessage("Connection loaded into the editor.");
    return;
  }

  if (action === "delete") {
    connectionPresets = connectionPresets.filter((preset) => preset.id !== presetId);
    if (activePresetId === presetId) {
      activePresetId = connectionPresets[0]?.id ?? null;
      syncLauncherUrlToActivePreset();
    }
    void persistPresetStore()
      .then(() => {
        renderPresetList();
        resetPresetForm();
        setLauncherMessage("External connection deleted.");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setLauncherMessage(message, true);
      });
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

  const activeIndex = items.findIndex((item) => item === document.activeElement);
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
  activePresetNameEl = document.querySelector("#active-preset-name");
  activePresetSummaryEl = document.querySelector("#active-preset-summary");
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
  presetListEl = document.querySelector("#preset-list");
  presetListStatusEl = document.querySelector("#preset-list-status");
  installTopHorizontalScrollbar();

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
          setLauncherMessage("Migrated existing presets into Rusty Pythia storage.");
          return;
        }
      }

      connectionPresets = store.presets;
      activePresetId = store.activePresetId;
      renderPresetList();
      syncLauncherUrlToActivePreset();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setLauncherMessage(message, true);
    });

  document.querySelector("#launcher-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void openSqlApp("tauri");
  });

  presetFormEl?.addEventListener("submit", (event) => {
    void savePreset(event);
  });

  resetPresetButtonEl?.addEventListener("click", () => {
    resetPresetForm();
    setLauncherMessage("Ready to add a new external connection.");
  });

  testPresetButtonEl?.addEventListener("click", () => {
    void testPresetConnection();
  });

  presetListEl?.addEventListener("click", (event) => {
    handlePresetListClick(event);
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
