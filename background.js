/**
 * background.js — Arena reCAPTCHA Harvester
 * ============================================
 * Runs as a Manifest V3 service worker.
 *
 * Responsibilities:
 *   - Maintains extension config (SERVER_PORT, TUNING, HARD_TUNING, FIVE_GAIN, etc.)
 *   - Receives harvested tokens from content.js via chrome.runtime.sendMessage
 *   - POSTs tokens to the local Python server (tokens.json)
 *   - Implements TUNING: reload the tab after each token
 *   - Implements HARD_TUNING: save 4 cookies → clear all cookies → reload fresh →
 *     restore the 4 saved cookies (profile "wipe" equivalent for extensions)
 *   - Manages per-tab harvester state (active script type, token count)
 *   - Exposes a message API that popup.js uses to start/stop harvesters and read state
 */

// ─── Default config (user edits via popup) ────────────────────────────────────

const DEFAULT_CONFIG = {
  SERVER_PORT:  5000,      // local Python server port
  FIVE_GAIN:    false,     // navigate to arena.ai/c/<eval_id> after each cycle
  EVAL_ID:      "",        // used when FIVE_GAIN=true
  TUNING:       true,      // reload tab after each v2/v3 token
  HARD_TUNING:  false,     // wipe non-auth cookies + reload (requires TUNING=true)
};

// ─── In-memory tab state ──────────────────────────────────────────────────────
// tabState[tabId] = { status, activeHarvester, tokenCount }
// status: "idle" | "harvesting_v2" | "harvesting_v3" | "reloading"
// activeHarvester: null | "v2" | "v3"

const tabState = {};

// Cookies we always preserve during HARD_TUNING
const HARD_TUNING_KEEP_COOKIES = new Set([
  "arena-auth-prod-v1.0",
  "arena-auth-prod-v1.1",
  "__cf_bm",
  "cf_clearance",
]);

// ─── Config helpers ───────────────────────────────────────────────────────────

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get("harvester_config", data => {
      resolve({ ...DEFAULT_CONFIG, ...(data.harvester_config || {}) });
    });
  });
}

async function saveConfig(cfg) {
  return new Promise(resolve => {
    chrome.storage.local.set({ harvester_config: cfg }, resolve);
  });
}

// ─── Token POST to local server ───────────────────────────────────────────────

async function postTokenToServer(tokenData, cfg) {
  const url = `http://localhost:${cfg.SERVER_PORT}/api`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tokenData),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    console.log(`[bg] Token stored. Total on server: ${data.total_count}`);
    return data;
  } catch (err) {
    console.error("[bg] Failed to POST token to server:", err.message);
    return null;
  }
}

// ─── HARD_TUNING: cookie wipe + restore ──────────────────────────────────────

async function hardTuningCycleCookies(tabId) {
  try {
    // 1. Read ALL cookies for arena.ai
    const all = await chrome.cookies.getAll({ domain: "arena.ai" });

    // 2. Save the 4 essential cookies to memory
    const saved = all.filter(c => HARD_TUNING_KEEP_COOKIES.has(c.name));
    console.log(`[bg][HARD_TUNING] Saved ${saved.length} essential cookies:`,
      saved.map(c => c.name).join(", "));

    // 3. Delete ALL arena.ai cookies
    for (const c of all) {
      const cookieUrl = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
      await chrome.cookies.remove({ url: cookieUrl, name: c.name });
    }
    console.log(`[bg][HARD_TUNING] Wiped ${all.length} cookies`);

    // 4. Return the saved cookies so we can restore them after the reload
    return saved;
  } catch (err) {
    console.error("[bg][HARD_TUNING] Cookie wipe error:", err);
    return [];
  }
}

async function restoreCookies(savedCookies) {
  for (const c of savedCookies) {
    try {
      const cookieUrl = `https://${c.domain.replace(/^\./, "")}${c.path}`;
      const details = {
        url:      cookieUrl,
        name:     c.name,
        value:    c.value,
        domain:   c.domain,
        path:     c.path,
        secure:   c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite ? c.sameSite.toLowerCase() : "lax",
      };
      if (c.expirationDate) details.expirationDate = c.expirationDate;
      await chrome.cookies.set(details);
      console.log(`[bg][HARD_TUNING] Restored: ${c.name}`);
    } catch (err) {
      console.warn(`[bg][HARD_TUNING] Failed to restore cookie ${c.name}:`, err.message);
    }
  }
}

// ─── TUNING: tab reload after token ──────────────────────────────────────────

async function reloadTabAfterToken(tabId, version) {
  const cfg  = await getConfig();
  const state = tabState[tabId];
  if (!state || !state.activeHarvester) {
    console.log(`[bg] Tab ${tabId}: harvester stopped — skipping reload`);
    return;
  }

  state.status = "reloading";
  broadcastStateUpdate();

  let savedCookies = [];

  // ── HARD_TUNING: wipe cookies before reload ───────────────────────────────
  if (cfg.HARD_TUNING) {
    console.log(`[bg][HARD_TUNING] Tab ${tabId}: running cookie cycle...`);
    savedCookies = await hardTuningCycleCookies(tabId);
  }

  // ── Determine target URL ──────────────────────────────────────────────────
  const targetUrl = (cfg.FIVE_GAIN && cfg.EVAL_ID)
    ? `https://arena.ai/c/${cfg.EVAL_ID}`
    : "https://arena.ai";

  // ── Reload the tab ────────────────────────────────────────────────────────
  console.log(`[bg] Tab ${tabId}: reloading → ${targetUrl}`);

  // Wait for tab to finish loading, then restore cookies + re-inject
  const onCompleted = (details) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    chrome.webNavigation.onCompleted.removeListener(onCompleted);

    (async () => {
      // ── HARD_TUNING: restore cookies into fresh page ──────────────────────
      if (cfg.HARD_TUNING && savedCookies.length > 0) {
        await restoreCookies(savedCookies);
        // Give the page a moment to pick up restored cookies before injecting
        await sleep(300);
      }

      // ── Re-inject blocker ─────────────────────────────────────────────────
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: installBlocker,
        });
      } catch (e) {
        console.warn("[bg] Blocker re-inject error:", e.message);
      }

      // ── Check if harvester was stopped during reload ──────────────────────
      const s = tabState[tabId];
      if (!s || !s.activeHarvester) {
        console.log(`[bg] Tab ${tabId}: harvester stopped during reload — not re-injecting`);
        if (s) s.status = "idle";
        broadcastStateUpdate();
        return;
      }

      // ── Re-inject the harvester ───────────────────────────────────────────
      const harvType = s.activeHarvester;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func:   harvType === "v2" ? injectV2Harvester : injectV3Harvester,
          args:   [tabId, cfg.SERVER_PORT],
        });
        s.status = harvType === "v2" ? "harvesting_v2" : "harvesting_v3";
        console.log(`[bg] Tab ${tabId}: ✅ ${harvType} harvester re-injected (${cfg.HARD_TUNING ? "HARD_TUNING" : "TUNING"} cycle)`);
      } catch (e) {
        console.error("[bg] Re-inject error:", e.message);
        s.status = "idle";
      }

      broadcastStateUpdate();
    })();
  };

  // Register navigation listener BEFORE navigating
  if (typeof chrome.webNavigation !== "undefined") {
    chrome.webNavigation.onCompleted.addListener(onCompleted);
  }

  // Navigate / reload
  try {
    if (targetUrl === "https://arena.ai" || !cfg.FIVE_GAIN) {
      await chrome.tabs.reload(tabId, { bypassCache: cfg.HARD_TUNING });
    } else {
      await chrome.tabs.update(tabId, { url: targetUrl });
    }
  } catch (err) {
    console.error(`[bg] Tab ${tabId}: reload/navigate error:`, err.message);
    if (tabState[tabId]) tabState[tabId].status = "idle";
    chrome.webNavigation?.onCompleted.removeListener(onCompleted);
    broadcastStateUpdate();
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function broadcastStateUpdate() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", tabState }).catch(() => {});
}

// ─── Injected functions (run in page context via scripting.executeScript) ─────
// These are serialised and sent to the content world — they must be self-contained.

function installBlocker() {
  if (window.__ARENA_BLOCKER_INSTALLED__) return;
  window.__ARENA_BLOCKER_INSTALLED__ = true;
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    let [url, options = {}] = args;
    if (options.body && typeof options.body === "string") {
      try {
        const body = JSON.parse(options.body);
        const deepClean = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          if (Array.isArray(obj)) return obj.map(deepClean);
          const out = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === "forceLowRecaptchaScore") { console.log("🚫 REMOVED forceLowRecaptchaScore"); continue; }
            out[k] = deepClean(v);
          }
          return out;
        };
        options = { ...options, body: JSON.stringify(deepClean(body)) };
        args[1] = options;
      } catch (_) {}
    }
    return originalFetch.apply(this, args);
  };
  console.log("✅ Arena Blocker installed");
}

function injectV2Harvester(tabId, serverPort) {
  // Stop any existing instance
  if (typeof window.__STOP_V2_HARVEST__ === "function") window.__STOP_V2_HARVEST__();

  const SERVER_URL  = `http://localhost:${serverPort}/api`;
  const V2_SITEKEY  = "6Ld7ePYrAAAAAB34ovoFoDau1fqCJ6IyOjFEQaMn";
  const FORCE_MODE  = "checkbox";

  let v2Count = 0;
  let currentTimeoutId = null;
  let panelCreated = false;
  let widgetCounter = 0;
  let invisibleErrors = 0;

  function getRandomInterval(min, max) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return min + (arr[0] / (0xFFFFFFFF + 1)) * (max - min);
  }

  function sendToken(token, mode) {
    v2Count++;
    invisibleErrors = 0;
    console.log(`[v2-${mode} #${v2Count}] Token generated (${token.length} chars)`);
    updateCount();
    if (panelCreated) updateStatus(`Token #${v2Count} captured! Sending...`);
    return fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        version: "v2",
        action:  mode === "invisible" ? "invisible_auto" : "checkbox_challenge",
        harvest_number: v2Count,
        source_url: window.location.href,
        tab_id:  tabId,
        _reload_after: true,
      }),
    }).then(r => r.json()).then(data => {
      console.log(`[v2-${mode} #${v2Count}] Stored. Total: ${data.total_count}`);
      if (panelCreated) updateStatus(`Token #${v2Count} stored! Reloading...`);
    }).catch(err => console.error(`[v2-${mode}] Store failed:`, err));
  }

  function harvestInvisible() {
    const g = window.grecaptcha?.enterprise;
    if (!g || typeof g.render !== "function") {
      currentTimeoutId = setTimeout(harvestInvisible, 2000);
      return;
    }
    widgetCounter++;
    const el = document.createElement("div");
    el.id = `__v2_inv_${widgetCounter}`;
    el.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;";
    document.body.appendChild(el);
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; el.remove(); handleInvisibleFailure(); } }, 60000);
    try {
      const wid = g.render(el, {
        sitekey: V2_SITEKEY,
        size: "invisible",
        callback: (token) => {
          if (settled) return;
          settled = true; clearTimeout(timer); el.remove();
          sendToken(token, "invisible").then(() => {
            const next = getRandomInterval(80, 100);
            currentTimeoutId = setTimeout(harvestInvisible, next * 1000);
          });
        },
        "error-callback": () => {
          if (settled) return;
          settled = true; clearTimeout(timer); el.remove(); handleInvisibleFailure();
        },
      });
      if (typeof g.execute === "function") g.execute(wid);
    } catch (e) { el.remove(); handleInvisibleFailure(); }
  }

  function handleInvisibleFailure() {
    invisibleErrors++;
    const backoff = Math.min(15 * Math.pow(1.5, invisibleErrors - 1), 300);
    currentTimeoutId = setTimeout(harvestInvisible, backoff * 1000);
  }

  // ── UI Panel ──────────────────────────────────────────────────
  function createPanel() {
    if (panelCreated) return;
    panelCreated = true;
    let panel = document.getElementById("__v2_harvest_panel");
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "__v2_harvest_panel";
    panel.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:999999;background:#1a1a2e;border:2px solid #16213e;border-radius:12px;padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;min-width:320px;";
    panel.innerHTML = `
      <div style="color:#e0e0e0;font-size:13px;margin-bottom:8px;font-weight:600;">
        v2 Harvester <span id="__v2_count" style="color:#4ade80;float:right;">0 tokens</span>
      </div>
      <div id="__v2_status" style="color:#9ca3af;font-size:11px;margin-bottom:10px;">Click the checkbox below to harvest a v2 token</div>
      <div id="__v2_checkbox_container" style="display:flex;justify-content:center;"></div>
      <div style="color:#6b7280;font-size:11px;margin-top:8px;cursor:pointer;text-align:center;" onclick="window.__STOP_V2_HARVEST__()">
        ✕ stop harvester
      </div>`;
    document.body.appendChild(panel);
  }

  function updateStatus(msg) { const el = document.getElementById("__v2_status"); if (el) el.textContent = msg; }
  function updateCount()     { const el = document.getElementById("__v2_count");  if (el) el.textContent = `${v2Count} token${v2Count !== 1 ? "s" : ""}`; }

  function renderCheckbox() {
    const g = window.grecaptcha?.enterprise;
    if (!g || typeof g.render !== "function") { setTimeout(renderCheckbox, 1000); return; }
    const panel = document.getElementById("__v2_harvest_panel");
    if (!panel) return;
    const old = document.getElementById("__v2_checkbox_container");
    if (old) old.remove();
    const container = document.createElement("div");
    container.id = "__v2_checkbox_container";
    container.style.cssText = "display:flex;justify-content:center;";
    panel.insertBefore(container, panel.lastElementChild);
    updateStatus("Click the checkbox to harvest a v2 token");
    const timeout = setTimeout(() => { updateStatus("Widget expired. Re-rendering..."); renderCheckbox(); }, 60000);
    try {
      g.render(container, {
        sitekey: V2_SITEKEY,
        callback: (token) => { clearTimeout(timeout); sendToken(token, "checkbox"); },
        "error-callback":   () => { clearTimeout(timeout); updateStatus("Challenge failed. Retry in 5s..."); setTimeout(renderCheckbox, 5000); },
        "expired-callback": () => { clearTimeout(timeout); updateStatus("Token expired. Retry in 3s...");    setTimeout(renderCheckbox, 3000); },
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      });
    } catch (e) {
      clearTimeout(timeout);
      updateStatus(`Error: ${e.message}. Retry in 10s...`);
      setTimeout(renderCheckbox, 10000);
    }
  }

  window.__STOP_V2_HARVEST__ = () => {
    if (currentTimeoutId) { clearTimeout(currentTimeoutId); currentTimeoutId = null; }
    const panel = document.getElementById("__v2_harvest_panel");
    if (panel) panel.remove();
    panelCreated = false;
    console.log(`[v2] Stopped. Tokens: ${v2Count}`);
  };

  console.log("[v2] Harvester started");
  if (FORCE_MODE === "checkbox") {
    createPanel();
    if (window.grecaptcha?.enterprise?.ready) window.grecaptcha.enterprise.ready(renderCheckbox);
    else renderCheckbox();
  } else {
    if (window.grecaptcha?.enterprise?.ready) window.grecaptcha.enterprise.ready(harvestInvisible);
    else harvestInvisible();
  }
}

function injectV3Harvester(tabId, serverPort) {
  if (typeof window.__STOP_HARVEST__ === "function") window.__STOP_HARVEST__();

  const SERVER_URL = `http://localhost:${serverPort}/api`;
  const SITE_KEY   = "6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I";
  const ACTION     = "chat_submit";
  const MIN_INT    = 12;
  const MAX_INT    = 18;

  let tokenCount = 0;
  let currentTimeoutId = null;

  function getRandomInterval() {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return MIN_INT + (arr[0] / (0xFFFFFFFF + 1)) * (MAX_INT - MIN_INT);
  }

  function harvest() {
    grecaptcha.enterprise.ready(() => {
      grecaptcha.enterprise.execute(SITE_KEY, { action: ACTION })
        .then(token => {
          tokenCount++;
          console.log(`[v3 #${tokenCount}] Token generated (${token.length} chars)`);
          return fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token,
              version: "v3",
              action:  ACTION,
              harvest_number: tokenCount,
              source_url: window.location.href,
              tab_id:  tabId,
              _reload_after: true,
            }),
          }).then(r => r.json()).then(data => {
            console.log(`[v3 #${tokenCount}] Stored. Total: ${data.total_count}`);
            window.__RECAPTCHA_TOKEN__ = token;
            scheduleNext();
          });
        }).catch(err => { console.error("[v3] Error:", err); scheduleNext(); });
    });
  }

  function scheduleNext() {
    const next = getRandomInterval();
    console.log(`[v3] Next harvest in ${next.toFixed(2)}s`);
    currentTimeoutId = setTimeout(harvest, next * 1000);
  }

  window.__STOP_HARVEST__ = () => {
    if (currentTimeoutId) { clearTimeout(currentTimeoutId); currentTimeoutId = null; }
    console.log("[v3] Stopped. Total captured:", tokenCount);
  };

  console.log("[v3] Harvester started");
  harvest();
}

// ─── Message handler (from popup or content) ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const cfg = await getConfig();

    switch (msg.type) {

      // ── Popup queries state ──────────────────────────────────
      case "GET_STATE": {
        const tabs = await chrome.tabs.query({ url: "https://arena.ai/*" });
        const states = tabs.map(t => ({
          tabId:   t.id,
          title:   t.title || `Tab ${t.id}`,
          url:     t.url,
          ...( tabState[t.id] || { status: "idle", activeHarvester: null, tokenCount: 0 } ),
        }));
        sendResponse({ ok: true, tabs: states, config: cfg });
        break;
      }

      // ── Config save ──────────────────────────────────────────
      case "SAVE_CONFIG": {
        // Validate: HARD_TUNING requires TUNING
        if (msg.config.HARD_TUNING && !msg.config.TUNING) {
          sendResponse({ ok: false, error: "HARD_TUNING requires TUNING=true" });
          break;
        }
        await saveConfig({ ...cfg, ...msg.config });
        sendResponse({ ok: true });
        break;
      }

      // ── Start v2 on a tab ────────────────────────────────────
      case "V2_START": {
        const { tabId } = msg;
        if (!tabState[tabId]) tabState[tabId] = { status: "idle", activeHarvester: null, tokenCount: 0 };
        tabState[tabId].activeHarvester = "v2";
        tabState[tabId].status = "harvesting_v2";
        try {
          await chrome.scripting.executeScript({ target: { tabId }, func: installBlocker });
          await chrome.scripting.executeScript({ target: { tabId }, func: injectV2Harvester, args: [tabId, cfg.SERVER_PORT] });
          sendResponse({ ok: true });
        } catch (e) {
          tabState[tabId].status = "idle";
          tabState[tabId].activeHarvester = null;
          sendResponse({ ok: false, error: e.message });
        }
        broadcastStateUpdate();
        break;
      }

      // ── Stop v2 ──────────────────────────────────────────────
      case "V2_STOP": {
        const { tabId } = msg;
        if (tabState[tabId]) { tabState[tabId].activeHarvester = null; tabState[tabId].status = "idle"; }
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { if (typeof window.__STOP_V2_HARVEST__ === "function") window.__STOP_V2_HARVEST__(); },
          });
        } catch (_) {}
        sendResponse({ ok: true });
        broadcastStateUpdate();
        break;
      }

      // ── Start v3 ─────────────────────────────────────────────
      case "V3_START": {
        const { tabId } = msg;
        if (!tabState[tabId]) tabState[tabId] = { status: "idle", activeHarvester: null, tokenCount: 0 };
        tabState[tabId].activeHarvester = "v3";
        tabState[tabId].status = "harvesting_v3";
        try {
          await chrome.scripting.executeScript({ target: { tabId }, func: installBlocker });
          await chrome.scripting.executeScript({ target: { tabId }, func: injectV3Harvester, args: [tabId, cfg.SERVER_PORT] });
          sendResponse({ ok: true });
        } catch (e) {
          tabState[tabId].status = "idle";
          tabState[tabId].activeHarvester = null;
          sendResponse({ ok: false, error: e.message });
        }
        broadcastStateUpdate();
        break;
      }

      // ── Stop v3 ──────────────────────────────────────────────
      case "V3_STOP": {
        const { tabId } = msg;
        if (tabState[tabId]) { tabState[tabId].activeHarvester = null; tabState[tabId].status = "idle"; }
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { if (typeof window.__STOP_HARVEST__ === "function") window.__STOP_HARVEST__(); },
          });
        } catch (_) {}
        sendResponse({ ok: true });
        broadcastStateUpdate();
        break;
      }

      // ── Run invisible on-demand token ────────────────────────
      case "INVISIBLE_RUN": {
        const { tabId } = msg;
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (serverPort) => {
              const SERVER_URL = `http://localhost:${serverPort}/api`;
              const SITE_KEY   = "6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I";
              async function loadRecaptcha() {
                if (document.querySelector('script[src*="recaptcha/enterprise.js"]')) return;
                await new Promise((res, rej) => {
                  const s = document.createElement("script");
                  s.src = `https://www.google.com/recaptcha/enterprise.js?render=${SITE_KEY}`;
                  s.async = true; s.onload = res; s.onerror = rej;
                  document.head.appendChild(s);
                });
              }
              async function waitFor(w) {
                const t = Date.now();
                while (Date.now() - t < 30000) {
                  if (w.grecaptcha?.enterprise?.render) return;
                  await new Promise(r => setTimeout(r, 100));
                }
              }
              (async () => {
                try {
                  const w = window.wrappedJSObject || window;
                  if (!w.grecaptcha?.enterprise) await loadRecaptcha();
                  await waitFor(w);
                  const g = w.grecaptcha.enterprise;
                  const el = document.createElement("div");
                  el.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;";
                  document.body.appendChild(el);
                  let settled = false;
                  const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
                  const token = await new Promise((res, rej) => {
                    const t = setTimeout(() => done(rej, "V2_TIMEOUT"), 60000);
                    const wid = g.render(el, {
                      sitekey: SITE_KEY,
                      size: "invisible",
                      callback: (tok) => { clearTimeout(t); done(res, tok); },
                      "error-callback": () => { clearTimeout(t); done(rej, "V2_ERROR"); },
                    });
                    if (typeof g.execute === "function") g.execute(wid);
                  });
                  await fetch(SERVER_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token, version: "v2_ondemand", action: "manual_trigger", source_url: window.location.href }),
                  });
                  console.log("[invisible] Token stored");
                } catch (e) { console.error("[invisible] Failed:", e); }
              })();
            },
            args: [cfg.SERVER_PORT],
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      // ── Token received from page (content.js relay) ──────────
      case "TOKEN_HARVESTED": {
        const { token, version, action, sourceUrl, tabId, reloadAfter } = msg;
        if (!tabState[tabId]) tabState[tabId] = { status: "idle", activeHarvester: null, tokenCount: 0 };
        tabState[tabId].tokenCount = (tabState[tabId].tokenCount || 0) + 1;

        await postTokenToServer({
          token,
          version,
          action,
          source_url:     sourceUrl,
          tab_id:         tabId,
          harvest_number: tabState[tabId].tokenCount,
          _reload_after:  reloadAfter,
        }, cfg);

        // Trigger TUNING reload if applicable
        if (cfg.TUNING && reloadAfter && (version === "v2" || version === "v3")) {
          reloadTabAfterToken(tabId, version);
        }

        sendResponse({ ok: true });
        broadcastStateUpdate();
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
    }
  })();
  return true; // keep message channel open for async response
});

// ─── Clean up state when a tab is closed ─────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  delete tabState[tabId];
  broadcastStateUpdate();
});

console.log("[bg] Arena Harvester background service worker started.");
