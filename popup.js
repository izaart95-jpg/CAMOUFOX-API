/**
 * popup.js — Arena reCAPTCHA Harvester
 * ======================================
 * Handles all popup UI logic. Communicates with background.js via
 * chrome.runtime.sendMessage.
 */

let _currentTabs = [];
let _config      = {};
let _serverTokens = { v2: 0, v3: 0, fresh: 0, total: 0 };

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  refresh();
  setInterval(refresh, 3000);

  // Listen for real-time state pushes from background
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "STATE_UPDATE") refresh();
  });
});

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    // Get tab state + config from background
    const state = await sendMsg({ type: "GET_STATE" });
    if (!state.ok) return;

    _currentTabs = state.tabs || [];
    _config      = state.config || {};

    // Populate config panel
    document.getElementById("cfg-port").value          = _config.SERVER_PORT || 5000;
    document.getElementById("cfg-tuning").checked      = !!_config.TUNING;
    document.getElementById("cfg-hard-tuning").checked = !!_config.HARD_TUNING;
    document.getElementById("cfg-hard-tuning").disabled = !_config.TUNING;
    document.getElementById("cfg-five-gain").checked   = !!_config.FIVE_GAIN;
    document.getElementById("cfg-eval-id").value       = _config.EVAL_ID || "";
    document.getElementById("eval-id-row").style.display = _config.FIVE_GAIN ? "block" : "none";

    // Fetch token stats from server
    await fetchServerStats();

    // Render tabs
    renderTabs(_currentTabs);

    document.getElementById("refresh-info").textContent = "Updated " + new Date().toLocaleTimeString();
    document.getElementById("refresh-info-bottom").textContent = "";
  } catch (e) {
    console.error("[popup] refresh error:", e);
  }
}

async function fetchServerStats() {
  try {
    const port = _config.SERVER_PORT || 5000;
    const resp = await fetch(`http://localhost:${port}/api/tokens`);
    if (!resp.ok) return;
    const data = await resp.json();
    const tokens = data.tokens || [];
    const now = Date.now();

    _serverTokens.total = tokens.length;
    _serverTokens.v2    = tokens.filter(t => (t.version || "").includes("v2")).length;
    _serverTokens.v3    = tokens.filter(t => t.version === "v3").length;
    _serverTokens.fresh = tokens.filter(t => {
      try { return (now - new Date(t.timestamp_utc).getTime()) / 1000 < 120; } catch { return false; }
    }).length;

    document.getElementById("stat-total").textContent = _serverTokens.total;
    document.getElementById("stat-v2").textContent    = _serverTokens.v2;
    document.getElementById("stat-v3").textContent    = _serverTokens.v3;
    document.getElementById("stat-fresh").textContent = _serverTokens.fresh;
  } catch (_) {
    document.getElementById("stat-total").textContent = "–";
    document.getElementById("stat-v2").textContent    = "–";
    document.getElementById("stat-v3").textContent    = "–";
    document.getElementById("stat-fresh").textContent = "–";
  }
}

// ─── Render tab cards ─────────────────────────────────────────────────────────

function renderTabs(tabs) {
  const container = document.getElementById("tabs-container");
  const active = tabs.filter(t => t.status !== "idle").length;
  document.getElementById("stat-active").textContent = active;

  if (tabs.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="icon">🌐</div>
        <p>No arena.ai tabs open.<br>
           Open <a href="https://arena.ai" target="_blank" style="color:#7c3aed;">arena.ai</a> to start harvesting.</p>
      </div>`;
    return;
  }

  container.innerHTML = tabs.map(tab => {
    const status   = tab.status || "idle";
    const badgeText = status.replace(/_/g, " ").toUpperCase();
    const isReady   = status !== "reloading";
    const dis       = isReady ? "" : "disabled";
    const shortUrl  = (tab.url || "").replace("https://", "").slice(0, 38);

    return `
    <div class="tab-card">
      <div class="tab-header">
        <div>
          <div class="tab-title">Tab ${tab.tabId}</div>
          <div class="tab-url">${shortUrl}</div>
        </div>
        <span class="badge ${status}">${badgeText}</span>
      </div>
      <div class="btn-row">
        <button class="btn v2-start" onclick="v2Start(${tab.tabId})" ${dis}>V2 Start</button>
        <button class="btn v2-stop"  onclick="v2Stop(${tab.tabId})"  ${dis}>V2 Stop</button>
        <button class="btn v3-start" onclick="v3Start(${tab.tabId})" ${dis}>V3 Start</button>
        <button class="btn v3-stop"  onclick="v3Stop(${tab.tabId})"  ${dis}>V3 Stop</button>
      </div>
      <div class="btn-row">
        <button class="btn inv-run" onclick="runInvisible(${tab.tabId})" ${dis}>🎯 Invisible Token</button>
      </div>
      <div class="tab-info">
        Session tokens: ${tab.tokenCount || 0}
      </div>
    </div>`;
  }).join("");
}

// ─── Button handlers ──────────────────────────────────────────────────────────

async function v2Start(tabId) {
  const r = await sendMsg({ type: "V2_START", tabId });
  if (r.ok) toast(`Tab ${tabId}: V2 started`, "#4ade80");
  else      toast(`Error: ${r.error}`, "#f87171");
  await refresh();
}

async function v2Stop(tabId) {
  const r = await sendMsg({ type: "V2_STOP", tabId });
  if (r.ok) toast(`Tab ${tabId}: V2 stopped`, "#f87171");
  await refresh();
}

async function v3Start(tabId) {
  const r = await sendMsg({ type: "V3_START", tabId });
  if (r.ok) toast(`Tab ${tabId}: V3 started`, "#60a5fa");
  else      toast(`Error: ${r.error}`, "#f87171");
  await refresh();
}

async function v3Stop(tabId) {
  const r = await sendMsg({ type: "V3_STOP", tabId });
  if (r.ok) toast(`Tab ${tabId}: V3 stopped`, "#a78bfa");
  await refresh();
}

async function runInvisible(tabId) {
  const r = await sendMsg({ type: "INVISIBLE_RUN", tabId });
  if (r.ok) toast(`Tab ${tabId}: Invisible triggered`, "#c084fc");
  else      toast(`Error: ${r.error}`, "#f87171");
}

async function clearTokens() {
  if (!confirm("Clear all tokens from tokens.json?\nThis cannot be undone.")) return;
  try {
    const port = _config.SERVER_PORT || 5000;
    const resp = await fetch(`http://localhost:${port}/tokens/clear`, { method: "DELETE" });
    const data = await resp.json();
    if (data.ok) toast(`Cleared ${data.removed} token(s)`, "#fb923c");
    else         toast("Error clearing tokens", "#f87171");
    await refresh();
  } catch (e) {
    toast("Server unreachable", "#f87171");
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

function toggleConfig() {
  const toggle = document.getElementById("config-toggle");
  const panel  = document.getElementById("config-panel");
  toggle.classList.toggle("open");
  panel.classList.toggle("open");
}

function onTuningChange() {
  const tuning = document.getElementById("cfg-tuning").checked;
  const hardEl = document.getElementById("cfg-hard-tuning");
  hardEl.disabled = !tuning;
  if (!tuning) hardEl.checked = false;
}

function onFiveGainChange() {
  const on = document.getElementById("cfg-five-gain").checked;
  document.getElementById("eval-id-row").style.display = on ? "block" : "none";
}

async function saveConfig() {
  const errEl  = document.getElementById("cfg-error");
  errEl.style.display = "none";

  const tuning     = document.getElementById("cfg-tuning").checked;
  const hardTuning = document.getElementById("cfg-hard-tuning").checked;
  const fiveGain   = document.getElementById("cfg-five-gain").checked;
  const evalId     = document.getElementById("cfg-eval-id").value.trim();
  const port       = parseInt(document.getElementById("cfg-port").value, 10) || 5000;

  const cfg = {
    SERVER_PORT: port,
    TUNING:      tuning,
    HARD_TUNING: hardTuning,
    FIVE_GAIN:   fiveGain,
    EVAL_ID:     evalId,
  };

  const r = await sendMsg({ type: "SAVE_CONFIG", config: cfg });
  if (r.ok) {
    toast("Settings saved ✓", "#4ade80");
    _config = cfg;
  } else {
    errEl.textContent = r.error || "Save failed";
    errEl.style.display = "block";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || { ok: false });
      }
    });
  });
}

let _toastTimer = null;
function toast(msg, color = "#e0e0e0") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.borderColor = color;
  el.style.color = color;
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
