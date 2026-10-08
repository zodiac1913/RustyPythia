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
const OLLAMA_CHECK_INTERVAL_MS = 30_000;

let sqlBridge: SqlBridge | null = null;
let conversation: ChatMessage[] = [];
let lastSql = "";
let lastAnswer: { question: string; decision: AiDecision } | null = null;
let ollamaOnline = false;
let isWorking = false;
let isCheckingStatus = false;
let isRefreshingOllama = false;

const el = {
  connection: document.querySelector<HTMLSelectElement>("#ai-connection")!,
  model: document.querySelector<HTMLSelectElement>("#ai-model")!,
  showSql: document.querySelector<HTMLInputElement>("#ai-show-sql")!,
  sqlPanel: document.querySelector<HTMLElement>("#ai-sql-panel")!,
  refresh: document.querySelector<HTMLElement>("#ai-refresh-status")!,
  reprobe: document.querySelector<HTMLElement>("#ai-reprobe")!,
  status: document.querySelector<HTMLOutputElement>("#ai-status")!,
  conversation: document.querySelector<HTMLDivElement>("#ai-conversation")!,
  progress: document.querySelector<HTMLDivElement>("#ai-progress")!,
  progressLabel: document.querySelector<HTMLSpanElement>("#ai-progress-label")!,
  compose: document.querySelector<HTMLFormElement>("#ai-compose")!,
  prompt: document.querySelector<HTMLTextAreaElement>("#ai-prompt")!,
  send: document.querySelector<HTMLElement>("#ai-send")!,
  clear: document.querySelector<HTMLElement>("#ai-clear")!,
  sql: document.querySelector<HTMLPreElement>("#ai-sql")!,
  copySql: document.querySelector<HTMLElement>("#ai-copy-sql")!,
  rerunSql: document.querySelector<HTMLElement>("#ai-rerun-sql")!,
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
  throw new Error("The Oracle needs the Rusty Pythia desktop app. Open this window from Popout.");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Changes only the visible label so sml-reactive-button keeps its icon markup. */
function setButtonText(button: HTMLElement, text: string) {
  button.dataset.text = text;
  const label = button.querySelector(".smlRBText");
  if (label) label.textContent = text;
}

function setStatus(message: string, state: "checking" | "online" | "offline" | "error") {
  const online = state === "checking" ? ollamaOnline : state === "online";
  const availability = document.createElement("span");
  availability.className = "ai-status__availability";
  availability.textContent = online ? "Online" : "Offline";
  el.status.replaceChildren("Ollama ", availability);
  el.status.dataset.online = String(online);
  el.status.title = message;
  el.status.dataset.state = state;
}

function syncControls() {
  const canAsk = ollamaOnline && !isWorking;
  const busy = "The Oracle is working";
  setUnavailable(el.send, !canAsk, isWorking ? busy : !ollamaOnline ? "Ollama is offline" : undefined);
  setUnavailable(el.clear, isWorking, isWorking ? busy : undefined);
  setUnavailable(el.connection, isWorking);
  setUnavailable(el.model, isWorking || !ollamaOnline || el.model.options.length === 0);
  setUnavailable(el.refresh, isWorking || isCheckingStatus, isWorking ? busy : isCheckingStatus ? "Checking Ollama" : undefined);
  setUnavailable(el.reprobe, isWorking, isWorking ? busy : undefined);
  setUnavailable(el.copySql, !lastSql, lastSql ? undefined : "No SQL to copy yet");
  setUnavailable(el.rerunSql, !lastSql || isWorking, isWorking ? busy : !lastSql ? "No SQL to run yet" : undefined);
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
  return bubble;
}

function resetConversation(note: string) {
  conversation = [];
  el.conversation.innerHTML = "";
  appendMessage("system", note);
}

function showSql(decision: AiDecision | null, question = "") {
  lastSql = decision?.sql ?? "";
  lastAnswer = decision ? { question, decision } : null;
  if (!decision || !lastSql) {
    el.sql.innerHTML = '<span class="ai-sql__empty">The SQL the Oracle writes will appear here.</span>';
    syncControls();
    return;
  }

  el.sql.textContent = lastSql;
  syncControls();
}

/** Results belong to their chronological AI reply, never to the hidden SQL panel. */
function createResultEntry(reply?: HTMLElement) {
  const entry = reply ?? appendMessage("assistant", "Running the latest query again.");
  const status = document.createElement("p");
  status.textContent = "Running the generated SQL...";
  const output = document.createElement("div");
  output.className = "sql-results-output";
  entry.append(status, output);
  el.conversation.scrollTop = el.conversation.scrollHeight;
  return { status, output };
}

function renderResults(
  result: SqlQueryResult | null,
  entry: ReturnType<typeof createResultEntry>,
  message?: string
) {
  const status = message ?? result?.message ?? "No results returned.";
  entry.status.textContent = status;
  if (!result) {
    entry.output.innerHTML = `<p class="sql-results-output__message">${escapeHtml(status)}</p>`;
    return;
  }

  if (!result.columns.length) {
    entry.output.innerHTML = `<p class="sql-results-output__message">${escapeHtml(result.message)}</p>`;
    return;
  }

  const header = result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  entry.output.innerHTML = `
    <div class="sql-results-table-wrap" tabindex="0" role="region" aria-label="Scrollable query results">
      <table class="sql-results-table">
        <thead><tr>${header}</tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  const body = entry.output.querySelector("tbody");
  if (body) void fillRows(result, body);
}

// Rows go in a slice at a time with a paint between slices, so a large result
// does not lock the window while its markup is parsed.
async function fillRows(result: SqlQueryResult, body: HTMLTableSectionElement) {
  for (let start = 0; start < result.rows.length; start += RESULT_ROW_CHUNK) {
    // Clear detaches the table; newer answers do not cancel this run's rendering.
    if (!body.isConnected) {
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

async function runSql(sql: string, reply?: HTMLElement) {
  setWorking(true, "Running the generated SQL...");
  const entry = createResultEntry(reply);
  try {
    const result = await call<SqlQueryResult>("ai_execute_sql", {
      connectionId: el.connection.value,
      sql,
      question: lastAnswer?.question ?? null,
      answer: lastAnswer ? decisionReply(lastAnswer.decision) : null,
    });
    renderResults(result, entry);
  } catch (error) {
    const message = errorMessage(error);
    renderResults(null, entry, `Query failed: ${message}`);
  } finally {
    setWorking(false);
    el.conversation.scrollTop = el.conversation.scrollHeight;
  }
}

function decisionReply(decision: AiDecision) {
  return [
    decision.explanation,
    decision.assumptions.length ? `Assumptions: ${decision.assumptions.join("; ")}` : "",
    "Checking CATS System data...",
  ].filter(Boolean).join("\n\n");
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
  el.send.classList.add("progress-bar", "progress-bar-striped", "progress-bar-animated");
  el.send.setAttribute("aria-busy", "true");

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
    await refreshStatus(false);
    el.prompt.focus();
    return;
  } finally {
    el.send.classList.remove("progress-bar", "progress-bar-striped", "progress-bar-animated");
    el.send.removeAttribute("aria-busy");
  }

  if (decision.status === "clarify" || !decision.sql) {
    const question = decision.question || "Which table or fields should I use?";
    conversation.push({ role: "assistant", content: question });
    appendMessage("assistant", question);
    setWorking(false);
    el.prompt.focus();
    return;
  }

  const reply = decisionReply(decision);
  conversation.push({ role: "assistant", content: `${reply}\n\nSQL:\n${decision.sql}` });
  const replyBubble = appendMessage("assistant", reply);
  showSql(decision, message);

  await runSql(decision.sql, replyBubble);
  el.prompt.focus();
}

async function reprobe() {
  setWorking(true, `Probing ${selectedConnectionLabel()}...`);
  try {
    const summary = await call<ProbeSummary>("probe_schema", { connectionId: el.connection.value });
    appendMessage(
      "system",
      `Probed ${selectedConnectionLabel()}: ${summary.tableCount} tables (${summary.changedTables} changed), ` +
        `${summary.relationCount} relationships, in ${(summary.durationMs / 1000).toFixed(1)}s. ` +
        "The live schema cache was refreshed; Markdown instructions were not changed."
    );
  } catch (error) {
    appendMessage("system", `Probe failed: ${errorMessage(error)}`);
  } finally {
    setWorking(false);
  }
}

function applyOllamaStatus(status: OllamaStatus, updateModels = true) {
  ollamaOnline = status.online && status.models.length > 0;

  if (updateModels) {
    const saved = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
    const current = el.model.value || saved;
    el.model.innerHTML = status.models
      .map((model) => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}</option>`)
      .join("");
    const preferred = status.models.some((model) => model.name === current) ? current : status.defaultModel ?? "";
    if (preferred) {
      el.model.value = preferred;
    }
  }

  if (!status.online) {
    setStatus(`Ollama is unavailable. Use Refresh Ollama or start the Ollama app.${status.detail ? ` ${status.detail}` : ""}`, "offline");
  } else if (!status.models.length) {
    setStatus("Ollama is running but has no models. Pull one (for example `ollama pull hermes3`).", "offline");
  } else {
    setStatus(`Ollama online at ${status.baseUrl}.`, "online");
  }
  syncControls();
}

async function refreshOllama() {
  if (isWorking || isCheckingStatus) return;
  isRefreshingOllama = true;
  setWorking(true, "Refreshing Ollama...");
  try {
    applyOllamaStatus(await call<OllamaStatus>("ai_slap_ollama"));
    appendMessage("system", ollamaOnline ? "Ollama is ready." : "Ollama is not ready. See the status above.");
  } catch (error) {
    ollamaOnline = false;
    setStatus(`Ollama refresh failed: ${errorMessage(error)}`, "error");
    appendMessage("system", `Ollama refresh failed: ${errorMessage(error)}`);
  } finally {
    isRefreshingOllama = false;
    setWorking(false);
  }
}

/** Passive checks never start Ollama or replace the selected model during a query. */
async function refreshStatus(showChecking = true) {
  if (isCheckingStatus || isRefreshingOllama) return;
  isCheckingStatus = true;
  if (showChecking) setStatus("Checking Ollama status...", "checking");
  syncControls();
  try {
    applyOllamaStatus(await call<OllamaStatus>("ai_status"), !isWorking);
  } catch (error) {
    ollamaOnline = false;
    setStatus(errorMessage(error), "error");
  } finally {
    isCheckingStatus = false;
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
  el.showSql.addEventListener("change", () => {
    el.sqlPanel.hidden = !el.showSql.checked;
  });

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

  // sml-reactive-button is not a form control, so it cannot submit the compose form itself.
  el.send.addEventListener("click", () => {
    void submitPrompt();
  });

  el.clear.addEventListener("click", () => {
    resetConversation("Conversation cleared. Ask for a result in plain English.");
    showSql(null);
    el.prompt.focus();
  });

  el.refresh.addEventListener("click", () => {
    void refreshOllama();
  });

  el.reprobe.addEventListener("click", () => {
    void reprobe();
  });

  el.model.addEventListener("change", () => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, el.model.value);
  });

  el.connection.addEventListener("change", () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, el.connection.value);
    conversation = [];
    appendMessage("system", "Data connection changed. Ask the Oracle a new question.");
    showSql(null);
  });

  el.copySql.addEventListener("click", async () => {
    if (!lastSql) {
      return;
    }
    try {
      await navigator.clipboard.writeText(lastSql);
      setButtonText(el.copySql, "Copied");
      window.setTimeout(() => setButtonText(el.copySql, "Copy"), 1500);
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
  await refreshStatus();
  const statusTimer = window.setInterval(() => {
    void refreshStatus(false);
  }, OLLAMA_CHECK_INTERVAL_MS);
  window.addEventListener("pagehide", () => window.clearInterval(statusTimer), { once: true });
  el.prompt.focus();
}

void initialize();
