// Tab Ripper UI. The backend owns all state; this file renders it and calls
// the deno desktop `bindings` global for every action.

const bindings = globalThis.bindings;
const POLL_MS = 250;
const PROBE_MS = 2000;
const SETTING_KEYS = ["cdpAddress", "outputDir", "ffmpegPath", "ffprobePath"];

const ui = {
  screen: null,
  connected: false,
  shuttingDown: false,
  settings: null,
  tools: null,
  urlPattern: "",
  pollTimer: null,
  polling: false,
  refreshQueued: false,
  startPending: false,
  probeGeneration: 0,
  probeTimer: null,
  resultPath: null,
};

const $ = (id) => document.getElementById(id);

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function setText(id, text) {
  $(id).textContent = text;
}

function setHidden(id, hidden) {
  $(id).hidden = hidden;
}

function showError(id, error) {
  const element = $(id);
  if (error === null || error === undefined) {
    element.hidden = true;
    element.textContent = "";
  } else {
    element.hidden = false;
    element.textContent = errorText(error);
  }
}

function showScreen(name) {
  for (const section of document.querySelectorAll(".screen")) {
    section.hidden = section.id !== `screen-${name}`;
  }
  ui.screen = name;
}

// ---- status polling (only while extracting/processing) ----

function startPolling() {
  if (ui.pollTimer === null) {
    ui.pollTimer = setInterval(() => void refresh(), POLL_MS);
  }
}

function stopPolling() {
  if (ui.pollTimer !== null) {
    clearInterval(ui.pollTimer);
    ui.pollTimer = null;
  }
}

async function refresh() {
  if (ui.shuttingDown) return;
  if (ui.polling) {
    // A refresh requested mid-flight must not be dropped: the in-flight one
    // may hold a stale snapshot taken before the caller's action.
    ui.refreshQueued = true;
    return;
  }
  ui.polling = true;
  try {
    const [status, connection] = await Promise.all([
      bindings.getStatus(),
      bindings.getConnection(),
    ]);
    // Shutdown may have started while the request was in flight.
    if (ui.shuttingDown) return;
    ui.connected = connection.connected;
    render(status);
  } catch (error) {
    console.error(error);
  } finally {
    ui.polling = false;
  }
  if (ui.refreshQueued && !ui.shuttingDown) {
    ui.refreshQueued = false;
    await refresh();
  }
}

// Screen = f(job state, connected); the job state wins.
function render(status) {
  switch (status.state) {
    case "extracting":
      stopProbing();
      showScreen("extracting");
      renderExtracting(status);
      startPolling();
      break;
    case "ready":
      stopProbing();
      // While a start request is pending, a stale "ready" snapshot must not
      // stop polling: the backend may already be preparing.
      if (!ui.startPending) stopPolling();
      renderPreview(status);
      break;
    case "processing":
      stopProbing();
      if (ui.screen !== "processing") showError("process-error", null);
      showScreen("processing");
      renderProcessing(status);
      startPolling();
      break;
    case "done":
    case "failed":
    case "cancelled":
      stopProbing();
      stopPolling();
      renderResult(status);
      break;
    default:
      stopPolling();
      if (ui.connected) {
        stopProbing();
        if (ui.screen !== "tabs") {
          showScreen("tabs");
          void loadTabs();
        }
      } else if (ui.screen !== "connect") {
        showScreen("connect");
        startProbing();
      }
  }
}

// ---- 1. connect ----

function startProbing() {
  stopProbing();
  void probeOnce();
}

function stopProbing() {
  // Invalidate any in-flight probe so an obsolete result cannot overwrite a newer one.
  ui.probeGeneration++;
  if (ui.probeTimer !== null) {
    clearTimeout(ui.probeTimer);
    ui.probeTimer = null;
  }
}

async function probeOnce() {
  ui.probeTimer = null;
  if (ui.screen !== "connect" || ui.shuttingDown) return;
  const generation = ui.probeGeneration;
  try {
    const result = await bindings.probe();
    if (generation !== ui.probeGeneration) return;
    if (ui.settings && result.address !== ui.settings.cdpAddress) {
      // Settings changed while probing: probe the current address instead.
      startProbing();
      return;
    }
    setText("probe-address", result.address);
    setText("probe-address-open", result.address);
    setHidden("connect-closed", result.open);
    setHidden("connect-open", !result.open);
    if (!result.open && ui.screen === "connect") {
      ui.probeTimer = setTimeout(() => void probeOnce(), PROBE_MS);
    }
  } catch (error) {
    if (generation !== ui.probeGeneration) return;
    showError("connect-error", error);
    ui.probeTimer = setTimeout(() => void probeOnce(), PROBE_MS);
  }
}

async function connect() {
  showError("connect-error", null);
  setHidden("connect-hint", false);
  $("connect-button").disabled = true;
  try {
    await bindings.connect();
  } catch (error) {
    showError("connect-error", error);
  } finally {
    setHidden("connect-hint", true);
    $("connect-button").disabled = false;
  }
  await refresh();
  if (ui.screen === "connect") startProbing();
}

// ---- 2. tabs ----

async function loadTabs() {
  showError("tabs-error", null);
  try {
    const tabs = await bindings.listTabs();
    const list = $("tab-list");
    list.replaceChildren();
    for (const tab of tabs) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab";
      const title = document.createElement("strong");
      title.textContent = tab.title || "（無標題）";
      const url = document.createElement("span");
      url.className = "muted";
      url.textContent = tab.url;
      button.append(title, url);
      button.addEventListener("click", () => void startExtract(tab.targetId));
      item.append(button);
      list.append(item);
    }
    setText("tabs-pattern", ui.urlPattern);
    setHidden("tabs-empty", tabs.length > 0);
  } catch (error) {
    showError("tabs-error", error);
    await refresh(); // Falls back to the connect screen if the connection dropped.
  }
}

async function startExtract(targetId) {
  try {
    await bindings.extract(targetId);
  } catch (error) {
    showError("tabs-error", error);
  }
  // Also after a failure: a dropped connection must lead back to the connect screen.
  await refresh();
}

// ---- 3. extracting ----

function renderExtracting(status) {
  const bar = $("extract-progress");
  if (status.total > 0) {
    bar.max = status.total;
    bar.value = status.received;
  } else {
    bar.removeAttribute("value");
  }
  setText(
    "extract-bytes",
    `${formatBytes(status.received)} / ${formatBytes(status.total)}`,
  );
}

// ---- 4. preview ----

function renderPreview(status) {
  const entering = ui.screen !== "preview";
  // Back from the processing screen (overwrite confirmation or destination
  // failure): keep the filename the user typed.
  const fromProcessing = ui.screen === "processing";
  showScreen("preview");
  // Do not wipe an error shown by an action while staying on this screen.
  if (entering || status.lastError) {
    showError("preview-error", status.lastError ?? null);
  }
  const body = $("info-table").querySelector("tbody");
  body.replaceChildren();
  const addRow = (label, value) => {
    const row = document.createElement("tr");
    const head = document.createElement("th");
    head.textContent = label;
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(head, cell);
    body.append(row);
  };
  for (const column of status.columns) {
    const value = status.info[column.key];
    addRow(column.label, value === undefined ? "" : String(value));
  }
  addRow("主檔大小", formatBytes(status.mainSize));
  addRow("輔助檔大小", formatBytes(status.auxSize));
  // Keep what the user typed when re-rendering or returning from processing.
  if (entering && !fromProcessing) $("filename").value = status.defaultFilename;
  const ffmpegOk = ui.tools ? ui.tools.ffmpeg.ok : true;
  $("start-button").disabled = !ffmpegOk;
  setHidden("tool-warning", ffmpegOk);
}

async function startProcessing() {
  const filename = $("filename").value;
  showError("preview-error", null);
  try {
    let confirmed = null;
    for (;;) {
      // Poll while the binding is pending: destination checks can be slow,
      // and the processing screen (with its cancel button) must show at once.
      ui.startPending = true;
      startPolling();
      let result;
      try {
        result = await bindings.startProcess(filename, confirmed);
      } finally {
        ui.startPending = false;
      }
      if (!result.needsConfirm) break;
      await refresh(); // Back to the preview behind the confirmation dialog.
      if (!confirm(`檔案已存在，要覆蓋嗎？\n${result.finalPath}`)) return;
      confirmed = result.finalPath;
    }
  } catch (error) {
    await refresh();
    showError("preview-error", error);
    return;
  }
  await refresh();
}

async function discard() {
  try {
    await bindings.discard();
  } catch (error) {
    showError("preview-error", error);
    return;
  }
  await refresh();
}

// ---- 5. processing ----

function renderProcessing(status) {
  const bar = $("process-progress");
  if (status.phase === "preparing") {
    setText("processing-title", "準備中");
    bar.removeAttribute("value");
    setText("process-detail", "");
  } else if (status.phase === "publishing") {
    setText("processing-title", "輸出檔案中");
    bar.removeAttribute("value");
    setText("process-detail", "");
  } else {
    setText("processing-title", "處理中");
    const speed = status.speed === null ? "" : `，速度 ${status.speed}x`;
    if (status.percent !== null && status.durationSec !== null) {
      bar.value = status.percent;
      setText(
        "process-detail",
        `${status.percent.toFixed(1)}%（${formatTime(status.outTimeSec)} / ${
          formatTime(status.durationSec)
        }）${speed}`,
      );
    } else {
      bar.removeAttribute("value");
      setText(
        "process-detail",
        `已處理 ${formatTime(status.outTimeSec)}${speed}`,
      );
    }
  }
  const message = status.phase === "running" ? (status.message ?? "") : "";
  setText("process-message", message);
  $("process-message").title = message;
  $("cancel-button").disabled = status.phase === "publishing";
}

async function cancelProcessing() {
  showError("process-error", null);
  try {
    await bindings.cancel();
  } catch (error) {
    showError("process-error", error);
  }
  await refresh();
}

// ---- 6. result ----

function renderResult(status) {
  if (ui.screen !== "result") showError("result-error", null);
  showScreen("result");
  const detail = $("result-detail");
  detail.hidden = true;
  detail.textContent = "";
  setHidden("reveal-button", true);
  ui.resultPath = null;
  if (status.state === "done") {
    setText("result-title", "完成");
    setText("result-message", `已輸出：${status.outputPath}`);
    ui.resultPath = status.outputPath;
    setHidden("reveal-button", false);
  } else if (status.state === "failed") {
    setText(
      "result-title",
      status.stage === "extract" ? "擷取失敗" : "處理失敗",
    );
    setText("result-message", status.message);
    if (status.detail && status.detail.length > 0) {
      detail.textContent = status.detail.join("\n");
      detail.hidden = false;
    }
  } else {
    setText("result-title", "已取消");
    setText("result-message", "工作已取消。");
  }
  setHidden("result-cleanup", !status.cleanupWarning);
  setText("result-cleanup", status.cleanupWarning ?? "");
}

async function again() {
  showError("result-error", null);
  try {
    await bindings.reset();
  } catch (error) {
    showError("result-error", error);
  }
  await refresh();
}

async function reveal() {
  if (ui.resultPath === null) return;
  showError("result-error", null);
  try {
    await bindings.revealInFinder(ui.resultPath);
  } catch (error) {
    showError("result-error", error);
  }
}

// ---- settings ----

async function loadSettings() {
  const data = await bindings.getSettings();
  ui.settings = data.settings;
  ui.tools = data.tools;
  ui.urlPattern = data.urlPattern;
  setHidden("settings-warning", !data.warning);
  setText("settings-warning", data.warning ?? "");
  setHidden("probe-warning", !data.probeWarning);
  setText("probe-warning", data.probeWarning ?? "");
  renderTools();
}

function renderTools() {
  if (!ui.tools) return;
  const describe = (check) =>
    check.ok
      ? `可用：${check.version ?? ""}`
      : `無法執行：${check.error ?? ""}`;
  setText("tool-ffmpeg", describe(ui.tools.ffmpeg));
  setText("tool-ffprobe", describe(ui.tools.ffprobe));
  $("tool-ffmpeg").className = ui.tools.ffmpeg.ok ? "muted" : "error";
  $("tool-ffprobe").className = ui.tools.ffprobe.ok ? "muted" : "warning";
}

async function openSettings() {
  // Reload so tool checks and the latest ffprobe warning are current.
  try {
    await loadSettings();
  } catch (error) {
    console.error(error);
  }
  if (ui.shuttingDown) return;
  const form = $("settings-form");
  for (const key of SETTING_KEYS) {
    form.elements.namedItem(key).value = ui.settings ? ui.settings[key] : "";
  }
  showError("settings-error", null);
  renderTools();
  $("settings-dialog").showModal();
}

async function saveSettingsFromForm() {
  const form = $("settings-form");
  const next = {};
  for (const key of SETTING_KEYS) {
    next[key] = form.elements.namedItem(key).value.trim();
  }
  try {
    const result = await bindings.saveSettings(next);
    // The settings are in effect even if writing the file failed.
    ui.settings = next;
    ui.tools = result.tools;
    renderTools();
    if (result.persistError) {
      // Keep the dialog open so the write failure stays visible.
      showError("settings-error", result.persistError);
    } else {
      showError("settings-error", null);
      $("settings-dialog").close();
    }
  } catch (error) {
    // Rejected before anything was applied (validation, or a CDP address
    // change while extracting): settings are unchanged.
    showError("settings-error", error);
    return;
  }
  if (ui.screen === "connect") startProbing();
  // Reconcile with the backend after any settings change (e.g. a dropped
  // connection while the dialog was open, or ffmpeg becoming usable).
  await refresh();
}

// ---- shutdown overlay (called by the backend via executeJs) ----

globalThis.__showShuttingDown = () => {
  ui.shuttingDown = true;
  stopPolling();
  stopProbing();
  // A modal dialog sits in the top layer above the overlay, so close it first.
  const dialog = $("settings-dialog");
  if (dialog.open) dialog.close();
  setHidden("shutdown-overlay", false);
};

// ---- wiring ----

function wire() {
  $("open-settings").addEventListener("click", () => void openSettings());
  $("settings-close").addEventListener(
    "click",
    () => $("settings-dialog").close(),
  );
  // Closing settings by any means (button, Escape, save) reconciles the
  // current screen, e.g. the start button after a tool re-check.
  $("settings-dialog").addEventListener("close", () => void refresh());
  $("settings-save").addEventListener(
    "click",
    () => void saveSettingsFromForm(),
  );
  $("probe-retry").addEventListener("click", () => startProbing());
  $("connect-button").addEventListener("click", () => void connect());
  $("tabs-refresh").addEventListener("click", () => void loadTabs());
  $("start-button").addEventListener("click", () => void startProcessing());
  $("discard-button").addEventListener("click", () => void discard());
  $("cancel-button").addEventListener("click", () => void cancelProcessing());
  $("again-button").addEventListener("click", () => void again());
  $("reveal-button").addEventListener("click", () => void reveal());
}

async function init() {
  wire();
  try {
    await loadSettings();
  } catch (error) {
    console.error(error);
  }
  await refresh();
}

void init();
