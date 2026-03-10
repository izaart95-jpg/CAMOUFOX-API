/**
 * popup.js — all event wiring via addEventListener (no inline handlers)
 */

let _config = {};
let _toastTimer = null;
let _configPanelOpen = false;
let _configDirty = false; // true while user is editing — suppress refresh overwrites

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("config-toggle").addEventListener("click", toggleConfig);
  document.getElementById("btn-save-config").addEventListener("click", saveConfig);
  document.getElementById("btn-refresh").addEventListener("click", refresh);
  document.getElementById("btn-clear-tokens").addEventListener("click", clearTokens);
  document.getElementById("cfg-tuning").addEventListener("change", onTuningChange);
  document.getElementById("cfg-five-gain").addEventListener("change", onFiveGainChange);
  document.getElementById("arena-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://arena.ai" });
  });

  document.getElementById("btn-add-cookie").addEventListener("click", () => { addCookieRow(""); _configDirty = true; });
  document.getElementById("config-panel").addEventListener("input",  () => { _configDirty = true; });
  document.getElementById("config-panel").addEventListener("change", () => { _configDirty = true; });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "STATE_UPDATE") refresh();
  });

  refresh();
  setInterval(refresh, 3000);
});

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const state = await sendMsg({ type: "GET_STATE" });
    if (!state.ok) return;

    // Only update config UI when panel is closed and user hasn't touched anything
    if (!_configPanelOpen && !_configDirty) {
      applyConfigToUI(state.config || {});
    }
    _config = state.config || {};

    await fetchServerStats();
    renderTabs(state.tabs || []);
    document.getElementById("refresh-info").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (e) {
    console.error("[popup] refresh error:", e);
  }
}

function applyConfigToUI(cfg) {
  _config = cfg;
  document.getElementById("cfg-port").value           = cfg.SERVER_PORT || 5000;
  document.getElementById("cfg-tuning").checked       = !!cfg.TUNING;
  document.getElementById("cfg-hard-tuning").checked  = !!cfg.HARD_TUNING;
  document.getElementById("cfg-hard-tuning").disabled = !cfg.TUNING;
  document.getElementById("cfg-five-gain").checked    = !!cfg.FIVE_GAIN;
  document.getElementById("cfg-eval-id").value        = cfg.EVAL_ID || "";
  document.getElementById("eval-id-row").style.display = cfg.FIVE_GAIN ? "block" : "none";

  // Render cookie names list
  renderCookieNames(cfg.HARD_TUNING_KEEP || [
    "arena-auth-prod-v1.0",
    "arena-auth-prod-v1.1",
    "__cf_bm",
    "cf_clearance",
  ]);
}

async function fetchServerStats() {
  try {
    const port = _config.SERVER_PORT || 5000;
    const resp = await fetch(`http://localhost:${port}/api/tokens`);
    if (!resp.ok) return;
    const data   = await resp.json();
    const tokens = data.tokens || [];
    const now    = Date.now();

    document.getElementById("stat-total").textContent = tokens.length;
    document.getElementById("stat-v2").textContent    = tokens.filter(t => (t.version||"").includes("v2")).length;
    document.getElementById("stat-v3").textContent    = tokens.filter(t => t.version === "v3").length;
    document.getElementById("stat-fresh").textContent = tokens.filter(t => {
      try { return (now - new Date(t.timestamp_utc).getTime()) / 1000 < 120; } catch { return false; }
    }).length;
  } catch (_) {
    ["stat-total","stat-v2","stat-v3","stat-fresh"].forEach(id => {
      document.getElementById(id).textContent = "–";
    });
  }
}

// ─── Cookie name editor ───────────────────────────────────────────────────────

function getCookieNames() {
  const items = document.querySelectorAll(".cookie-name-input");
  return Array.from(items)
    .map(i => i.value.trim())
    .filter(Boolean);
}

function renderCookieNames(names) {
  const list = document.getElementById("cookie-names-list");
  list.innerHTML = "";
  names.forEach(name => addCookieRow(name));
}

function addCookieRow(value = "") {
  const list = document.getElementById("cookie-names-list");
  const row  = document.createElement("div");
  row.className = "cookie-row";
  row.innerHTML = `
    <input class="cfg-input cookie-name-input" type="text" value="${escHtml(value)}" placeholder="cookie_name">
    <button class="cookie-del-btn" title="Remove">✕</button>
  `;
  row.querySelector(".cookie-del-btn").addEventListener("click", () => {
    row.remove();
    _configDirty = true;
  });
  list.appendChild(row);
  _configDirty = true;
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─── Render tab cards ─────────────────────────────────────────────────────────

function renderTabs(tabs) {
  const container = document.getElementById("tabs-container");
  document.getElementById("stat-active").textContent =
    tabs.filter(t => t.status !== "idle").length;

  if (!tabs.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="icon">🌐</div>
        <p>No arena.ai tabs open.<br>
           Open <a id="arena-link2" href="#">arena.ai</a> to start harvesting.</p>
      </div>`;
    const link = document.getElementById("arena-link2");
    if (link) link.addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: "https://arena.ai" }); });
    return;
  }

  container.innerHTML = tabs.map(tab => {
    const status    = tab.status || "idle";
    const badgeText = status.replace(/_/g, " ").toUpperCase();
    const isReady   = status !== "reloading";
    const dis       = isReady ? "" : "disabled";
    const shortUrl  = (tab.url || "").replace("https://", "").slice(0, 38);
    const tid       = tab.tabId;

    return `
    <div class="tab-card">
      <div class="tab-header">
        <div>
          <div class="tab-title">Tab ${tid}</div>
          <div class="tab-url">${shortUrl}</div>
        </div>
        <span class="badge ${status}">${badgeText}</span>
      </div>
      <div class="btn-row">
        <button class="btn v2-start"  data-tab="${tid}" data-action="V2_START"          ${dis}>V2 Invisible</button>
        <button class="btn v2-cb"     data-tab="${tid}" data-action="V2_CHECKBOX_START"  ${dis}>V2 Checkbox</button>
        <button class="btn v2-stop"   data-tab="${tid}" data-action="V2_STOP"            ${dis}>V2 Stop</button>
      </div>
      <div class="btn-row">
        <button class="btn v3-start" data-tab="${tid}" data-action="V3_START" ${dis}>V3 Start</button>
        <button class="btn v3-stop"  data-tab="${tid}" data-action="V3_STOP"  ${dis}>V3 Stop</button>
        <button class="btn inv-run"  data-tab="${tid}" data-action="INVISIBLE_RUN" ${dis}>🎯 On-demand</button>
      </div>
      <div class="tab-info">Session tokens: ${tab.tokenCount || 0}</div>
    </div>`;
  }).join("");

  container.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", onTabButton);
  });
}

async function onTabButton(e) {
  const btn    = e.currentTarget;
  const tabId  = parseInt(btn.dataset.tab, 10);
  const action = btn.dataset.action;

  const toastMap = {
    V2_START:          ["V2 invisible started",  "#4ade80"],
    V2_CHECKBOX_START: ["V2 checkbox started",   "#4ade80"],
    V2_STOP:           ["V2 stopped",            "#f87171"],
    V3_START:          ["V3 started",            "#60a5fa"],
    V3_STOP:           ["V3 stopped",            "#a78bfa"],
    INVISIBLE_RUN:     ["On-demand triggered",   "#c084fc"],
  };

  const r = await sendMsg({ type: action, tabId });
  if (r.ok) {
    const [msg, color] = toastMap[action] || ["Done", "#e0e0e0"];
    toast(`Tab ${tabId}: ${msg}`, color);
  } else {
    toast(`Error: ${r.error || "unknown"}`, "#f87171");
  }
  await refresh();
}

// ─── Config ───────────────────────────────────────────────────────────────────

function toggleConfig() {
  _configPanelOpen = !_configPanelOpen;
  document.getElementById("config-toggle").classList.toggle("open", _configPanelOpen);
  document.getElementById("config-panel").classList.toggle("open", _configPanelOpen);

  // When opening, load fresh values from last known config
  if (_configPanelOpen) {
    applyConfigToUI(_config);
    _configDirty = false; // reset — user hasn't changed anything yet
  }
}

function onTuningChange() {
  const tuning = document.getElementById("cfg-tuning").checked;
  const hardEl = document.getElementById("cfg-hard-tuning");
  hardEl.disabled = !tuning;
  if (!tuning) hardEl.checked = false;
}

function onFiveGainChange() {
  document.getElementById("eval-id-row").style.display =
    document.getElementById("cfg-five-gain").checked ? "block" : "none";
}

async function saveConfig() {
  const errEl = document.getElementById("cfg-error");
  errEl.style.display = "none";

  const cfg = {
    SERVER_PORT:      parseInt(document.getElementById("cfg-port").value, 10) || 5000,
    TUNING:           document.getElementById("cfg-tuning").checked,
    HARD_TUNING:      document.getElementById("cfg-hard-tuning").checked,
    FIVE_GAIN:        document.getElementById("cfg-five-gain").checked,
    EVAL_ID:          document.getElementById("cfg-eval-id").value.trim(),
    HARD_TUNING_KEEP: getCookieNames(),
  };

  const r = await sendMsg({ type: "SAVE_CONFIG", config: cfg });
  if (r.ok) {
    toast("Settings saved ✓", "#4ade80");
    _config = cfg;
    _configDirty = false;
  } else {
    errEl.textContent   = r.error || "Save failed";
    errEl.style.display = "block";
  }
}

// ─── Clear tokens ─────────────────────────────────────────────────────────────

async function clearTokens() {
  if (!confirm("Clear all tokens from tokens.json?\nThis cannot be undone.")) return;
  try {
    const port = _config.SERVER_PORT || 5000;
    const resp = await fetch(`http://localhost:${port}/tokens/clear`, { method: "DELETE" });
    const data = await resp.json();
    if (data.ok) toast(`Cleared ${data.removed} token(s)`, "#fb923c");
    else         toast("Error clearing tokens", "#f87171");
    await refresh();
  } catch (_) {
    toast("Server unreachable", "#f87171");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response || { ok: false });
    });
  });
}

function toast(msg, color = "#e0e0e0") {
  const el = document.getElementById("toast");
  el.textContent      = msg;
  el.style.borderColor = color;
  el.style.color       = color;
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
