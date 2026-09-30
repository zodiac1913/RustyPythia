import "bootstrap/dist/css/bootstrap.min.css";
import { invoke } from "@tauri-apps/api/core";
import { bridgeInvoke, hasTauriBackend, readSqlBridge, startBridgeHeartbeat, type SqlBridge } from "./backend";
import { blockUnavailableControls, isUnavailable, setUnavailable, showUnavailable, watchControlLabels } from "./unavailable";

type OllamaStatus = {
  online: boolean;
  models: { name: string; size: number | null }[];
  defaultModel: string | null;
  baseUrl: string;
  detail: string | null;
};

type AiDecision = {
  status: "ready" | "clarify";
  question: string;
  sql: string;
  assumptions: string[];
  explanation: string;
  model: string;
};

type SqlQueryResult = {
  connectionId: string;
  connectionLabel: string;
  columns: string[];
  rows: string[][];
  rowsAffected: number;
  message: string;
};

type PresetStore = {
  activePresetId: string | null;
  presets: { id: string; name: string; engine: string }[];
};

type ChatMessage = { role: "user" | "assistant"; content: string };

type ProbeSummary = {
  connectionId: string;
  tableCount: number;
  changedTables: number;
  relationCount: number;
  durationMs: number;
};

const INTERNAL_CONNECTION_ID = "__internal_workspace__";
const MODEL_STORAGE_KEY = "rustyPythia.ollamaModel";
const CONNECTION_STORAGE_KEY = "rustyPythia.aiConnection";
const RESULT_ROW_CHUNK = 250;

let sqlBridge: SqlBridge | null = null;
let conversation: ChatMessage[] = [];
let lastSql = "";
let ollamaOnline = false;
let isWorking = false;
let renderToken = 0;

const el = {
  connection: document.querySelector<HTMLSelectElement>("#ai-connection")!,
  model: document.querySelector<HTMLSelectElement>("#ai-model")!,
  refresh: document.querySelector<HTMLButtonElement>("#ai-refresh-status")!,
  slap: document.querySelector<HTMLButtonElement>("#ai-slap-ollama")!,
  reprobe: document.querySelector<HTMLButtonElement>("#ai-reprobe")!,
  status: document.querySelector<HTMLOutputElement>("#ai-status")!,
  conversation: document.querySelector<HTMLDivElement>("#ai-conversation")!,
  progress: document.querySelector<HTMLDivElement>("#ai-progress")!,
  progressLabel: document.querySelector<HTMLSpanElement>("#ai-progress-label")!,
  compose: document.querySelector<HTMLFormElement>("#ai-compose")!,
  prompt: document.querySelector<HTMLTextAreaElement>("#ai-prompt")!,
  send: document.querySelector<HTMLButtonElement>("#ai-send")!,
  clear: document.querySelector<HTMLButtonElement>("#ai-clear")!,
  sql: document.querySelector<HTMLPreElement>("#ai-sql")!,
  sqlNotes: document.querySelector<HTMLDivElement>("#ai-sql-notes")!,
  copySql: document.querySelector<HTMLButtonElement>("#ai-copy-sql")!,
  rerunSql: document.querySelector<HTMLButtonElement>("#ai-rerun-sql")!,
  resultsStatus: document.querySelector<HTMLParagraphElement>("#ai-results-status")!,
  resultsOutput: document.querySelector<HTMLDivElement>("#ai-results-output")!,
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function call<T>(command: string, args?: Record<string, unknown>) {
  if (hasTauriBackend()) {
    return invoke<T>(command, args);
  }
  if (sqlBridge) {
    return bridgeInvoke<T>(sqlBridge, command, args);
  }
  throw new Error("The Oracle needs the Rusty Pythia desktop app. Open this window from Launch SQL App.");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(message: string, state: "checking" | "online" | "offline" | "error") {
  el.status.textContent = message;
  el.status.dataset.state = state;
}

function syncControls() {
  const canAsk = ollamaOnline && !isWorking;
  setUnavailable(el.send, !canAsk);
  setUnavailable(el.clear, isWorking);
  setUnavailable(el.connection, isWorking);
  setUnavailable(el.model, isWorking || !ollamaOnline || el.model.options.length === 0);
  setUnavailable(el.refresh, isWorking);
  setUnavailable(el.slap, isWorking);
  setUnavailable(el.reprobe, isWorking);
  setUnavailable(el.copySql, !lastSql);
  setUnavailable(el.rerunSql, !lastSql || isWorking);
}

function setWorking(working: boolean, label = "The Oracle is working...") {
  isWorking = working;
  el.progress.hidden = !working;
  el.progressLabel.textContent = label;
  syncControls();
}

function appendMessage(role: "user" | "assistant" | "system", message: string) {
  const bubble = document.createElement("div");
  bubble.className = `ai-message ai-message--${role}`;
  bubble.textContent = message;
  el.conversation.appendChild(bubble);
  el.conversation.scrollTop = el.conversation.scrollHeight;
}

function resetConversation(note: string) {
  conversation = [];
  el.conversation.innerHTML = "";
  appendMessage("system", note);
}

function showSql(decision: AiDecision | null) {
  lastSql = decision?.sql ?? "";
  if (!decision || !lastSql) {
    el.sql.innerHTML = '<span class="ai-sql__empty">The SQL the Oracle writes will appear here.</span>';
    el.sqlNotes.hidden = true;
    el.sqlNotes.innerHTML = "";
    syncControls();
    return;
  }

  el.sql.textContent = lastSql;
  const notes = [
    decision.explanation ? `<p>${escapeHtml(decision.explanation)}</p>` : "",
    decision.assumptions.length
      ? `<p><strong>Assumptions:</strong> ${decision.assumptions.map(escapeHtml).join("; ")}</p>`
      : "",
  ].join("");
  el.sqlNotes.innerHTML = notes;
  el.sqlNotes.hidden = !notes;
  syncControls();
}

function renderResults(result: SqlQueryResult | null, message?: string) {
  renderToken += 1;

  if (!result) {
    el.resultsStatus.textContent = message ?? "Ask a question to see results here.";
    el.resultsOutput.innerHTML = `<p class="sql-results-output__empty">${escapeHtml(
      message ?? "Results from the generated SQL will appear here."
    )}</p>`;
    return;
  }

  el.resultsStatus.textContent = result.message;
  if (!result.columns.length) {
    el.resultsOutput.innerHTML = `<p class="sql-results-output__message">${escapeHtml(result.message)}</p>`;
    return;
  }

  const header = result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  el.resultsOutput.innerHTML = `
    <div class="sql-results-table-wrap">
      <table class="sql-results-table">
        <thead><tr>${header}</tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  void fillRows(result, renderToken);
}

// Rows go in a slice at a time with a paint between slices, so a large result
// does not lock the window while its markup is parsed.
async function fillRows(result: SqlQueryResult, token: number) {
  const body = el.resultsOutput.querySelector("tbody");
  if (!body) {
    return;
  }

  for (let start = 0; start < result.rows.length; start += RESULT_ROW_CHUNK) {
    if (token !== renderToken) {
      return;
    }
    const slice = result.rows.slice(start, start + RESULT_ROW_CHUNK);
    body.insertAdjacentHTML(
      "beforeend",
      slice.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

async function runSql(sql: string) {
  setWorking(true, "Running the generated SQL...");
  renderResults(null, "Running the generated SQL...");
  try {
    const result = await call<SqlQueryResult>("ai_execute_sql", {
      connectionId: el.connection.value,
      sql,
    });
    renderResults(result);
  } catch (error) {
    const message = errorMessage(error);
    renderResults(null, `Query failed: ${message}`);
    appendMessage("assistant", `The SQL did not run: ${message}`);
  } finally {
    setWorking(false);
  }
}

async function submitPrompt() {
  const message = el.prompt.value.trim();
  if (!message || isUnavailable(el.send)) {
    if (isUnavailable(el.send)) {
      showUnavailable(el.send);
    }
    return;
  }

  conversation.push({ role: "user", content: message });
  appendMessage("user", message);
  el.prompt.value = "";
  setWorking(true, "The Oracle is reviewing the schema and preparing a response...");

  let decision: AiDecision;
  try {
    decision = await call<AiDecision>("ai_assist", {
      request: {
        connectionId: el.connection.value,
        conversation,
        model: el.model.value || null,
        currentQuery: lastSql,
      },
    });
  } catch (error) {
    appendMessage("assistant", `The Oracle could not answer: ${errorMessage(error)}`);
    setWorking(false);
    el.prompt.focus();
    return;
  }

  if (decision.status === "clarify" || !decision.sql) {
    const question = decision.question || "Which table or fields should I use?";
    conversation.push({ role: "assistant", content: question });
    appendMessage("assistant", question);
    setWorking(false);
    el.prompt.focus();
    return;
  }

  const reply = [
    decision.explanation,
    decision.assumptions.length ? `Assumptions: ${decision.assumptions.join("; ")}` : "",
    "Running the SQL shown on the right.",
  ]
    .filter(Boolean)
    .join("\n\n");
  conversation.push({ role: "assistant", content: `${reply}\n\nSQL:\n${decision.sql}` });
  appendMessage("assistant", reply);
  showSql(decision);

  await runSql(decision.sql);
  el.prompt.focus();
}

async function reprobe() {
  setWorking(true, `Probing ${selectedConnectionLabel()}...`);
  try {
    const summary = await call<ProbeSummary>("probe_schema", { connectionId: el.connection.value });
    appendMessage(
      "system",
      `Probed ${selectedConnectionLabel()}: ${summary.tableCount} tables (${summary.changedTables} changed), ` +
        `${summary.relationCount} relationships, in ${(summary.durationMs / 1000).toFixed(1)}s.`
    );
  } catch (error) {
    appendMessage("system", `Probe failed: ${errorMessage(error)}`);
  } finally {
    setWorking(false);
  }
}

function applyOllamaStatus(status: OllamaStatus) {
  ollamaOnline = status.online && status.models.length > 0;

  const saved = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  const current = el.model.value || saved;
  el.model.innerHTML = status.models
    .map((model) => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}</option>`)
    .join("");
  const preferred = status.models.some((model) => model.name === current) ? current : status.defaultModel ?? "";
  if (preferred) {
    el.model.value = preferred;
  }

  if (!status.online) {
    setStatus(status.detail ?? "Ollama is offline. Slap it, or start the Ollama app.", "offline");
  } else if (!status.models.length) {
    setStatus("Ollama is running but has no models. Pull one (for example `ollama pull hermes3`).", "offline");
  } else {
    setStatus(`Ollama online at ${status.baseUrl}.`, "online");
  }
  syncControls();
}

async function slapOllama() {
  setWorking(true, "Slapping Ollama...");
  try {
    applyOllamaStatus(await call<OllamaStatus>("ai_slap_ollama"));
    appendMessage("system", ollamaOnline ? "Ollama is awake." : "Ollama did not wake up.");
  } catch (error) {
    appendMessage("system", `Slap failed: ${errorMessage(error)}`);
  } finally {
    setWorking(false);
  }
}

async function refreshStatus() {
  setStatus("Checking Ollama status...", "checking");
  try {
    applyOllamaStatus(await call<OllamaStatus>("ai_status"));
  } catch (error) {
    ollamaOnline = false;
    setStatus(errorMessage(error), "error");
    syncControls();
  }
}

async function loadConnections() {
  const saved = window.localStorage.getItem(CONNECTION_STORAGE_KEY);
  let store: PresetStore = { activePresetId: null, presets: [] };
  try {
    store = await call<PresetStore>("load_preset_store");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }

  const options = [
    { id: INTERNAL_CONNECTION_ID, label: "Internal workspace (SQLite)" },
    ...store.presets.map((preset) => ({ id: preset.id, label: `${preset.name} (${preset.engine})` })),
  ];
  el.connection.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
    .join("");

  const preferred = [saved, store.activePresetId].find((id) => id && options.some((option) => option.id === id));
  el.connection.value = preferred ?? INTERNAL_CONNECTION_ID;
}

function selectedConnectionLabel() {
  return el.connection.selectedOptions[0]?.textContent ?? "the selected database";
}

function wireEvents() {
  el.compose.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPrompt();
  });

  el.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
    }
  });

  el.clear.addEventListener("click", () => {
    resetConversation("Conversation cleared. Ask for a result in plain English.");
    showSql(null);
    renderResults(null);
    el.prompt.focus();
  });

  el.refresh.addEventListener("click", () => {
    void refreshStatus();
  });

  el.slap.addEventListener("click", () => {
    void slapOllama();
  });

  el.reprobe.addEventListener("click", () => {
    void reprobe();
  });

  el.model.addEventListener("change", () => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, el.model.value);
  });

  el.connection.addEventListener("change", () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, el.connection.value);
    resetConversation(`Now using ${selectedConnectionLabel()}. Ask what you want from this database.`);
    showSql(null);
    renderResults(null);
  });

  el.copySql.addEventListener("click", async () => {
    if (!lastSql) {
      return;
    }
    try {
      await navigator.clipboard.writeText(lastSql);
      el.copySql.textContent = "Copied";
      window.setTimeout(() => (el.copySql.textContent = "Copy"), 1500);
    } catch (error) {
      appendMessage("system", `Could not copy the SQL: ${errorMessage(error)}`);
    }
  });

  el.rerunSql.addEventListener("click", () => {
    if (lastSql) {
      void runSql(lastSql);
    }
  });
}

async function initialize() {
  watchControlLabels();
  blockUnavailableControls();
  sqlBridge = readSqlBridge();
  if (sqlBridge && !hasTauriBackend()) {
    startBridgeHeartbeat(sqlBridge);
  }

  wireEvents();
  syncControls();
  await loadConnections();
  resetConversation(
    `Ask for a result in plain English. The Oracle uses the ${selectedConnectionLabel()} schema and will ask when something is unclear.`
  );
  await refreshStatus();
  el.prompt.focus();
}

void initialize();
