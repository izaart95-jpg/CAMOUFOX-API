/**
 * background.js — Arena reCAPTCHA Harvester
 * Service worker. All logic lives here.
 *
 * TUNING timing model (fixed):
 *   Injected page scripts harvest exactly ONE token, fire __arena_token_stored__,
 *   then go completely idle.  Background owns the interval:
 *     - waits the correct delay
 *     - reloads the tab
 *     - re-injects the harvester
 *
 *   v3           → 12–18 s random interval (background-owned)
 *   v2 invisible → 80–100 s random interval (background-owned)
 *   v2 checkbox  → no interval; reload fires immediately after solve
 *   error/timeout→ 15 s fixed backoff
 */

// ─── Config defaults ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  SERVER_PORT:      5000,
  FIVE_GAIN:        false,
  EVAL_ID:          "",
  TUNING:           true,
  HARD_TUNING:      false,
  HARD_TUNING_KEEP: [
    "arena-auth-prod-v1.0",
    "arena-auth-prod-v1.1",
    "__cf_bm",
    "cf_clearance",
  ],
};

// ─── Per-tab state ────────────────────────────────────────────────────────────
// {
//   status:          "idle" | "harvesting_v2" | "harvesting_v3" | "waiting" | "reloading"
//   activeHarvester: null | "v2" | "v3"
//   tokenCount:      number
//   waitTimer:       timeoutId | null   ← background-owned interval timer
// }
const tabState = {};

// ─── Config helpers ───────────────────────────────────────────────────────────

function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get("harvester_config", data => {
      resolve(Object.assign({}, DEFAULT_CONFIG, data.harvester_config || {}));
    });
  });
}

function saveConfig(cfg) {
  return new Promise(resolve => chrome.storage.local.set({ harvester_config: cfg }, resolve));
}

// ─── Core injection helper ────────────────────────────────────────────────────

function runInTab(tabId, jsString) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world:  "MAIN",
    func:   (code) => { (0, eval)(code); },
    args:   [jsString],
  });
}

// ─── Interval helpers ─────────────────────────────────────────────────────────

function cryptoRandFloat() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] / (0xFFFFFFFF + 1);
}

/** Returns background-side wait (ms) before reloading + re-injecting. */
function getIntervalMs(harvesterType) {
  if (harvesterType === "v3") {
    return (12 + cryptoRandFloat() * 6) * 1000;   // 12–18 s
  }
  if (harvesterType === "v2") {
    return (80 + cryptoRandFloat() * 20) * 1000;  // 80–100 s
  }
  return 0;
}

// ─── Script builders ─────────────────────────────────────────────────────────
//
// KEY CHANGE: scripts no longer contain any self-rescheduling (scheduleNext /
// setTimeout for next harvest).  Each injection harvests exactly ONE token,
// fires __arena_token_stored__, then goes idle.  Background owns the loop.

function getBlockerScript() {
  return `(function() {
  if (window.__POSTHOG_CAPTURE_READY__) return;
  window.__POSTHOG_CAPTURE_READY__ = true;
  var _orig = window.fetch;
  window.fetch = function() {
    var args = Array.prototype.slice.call(arguments);
    var options = args[1] || {};
    if (options.body && typeof options.body === 'string') {
      try {
        var body = JSON.parse(options.body);
        var deepClean = function(obj) {
          if (!obj || typeof obj !== 'object') return obj;
          if (Array.isArray(obj)) return obj.map(deepClean);
          var out = {};
          for (var k in obj) {
            if (k === 'forceLowRecaptchaScore') { console.log('[blocker] REMOVED forceLowRecaptchaScore'); continue; }
            out[k] = deepClean(obj[k]);
          }
          return out;
        };
        args[1] = Object.assign({}, options, { body: JSON.stringify(deepClean(body)) });
      } catch(e) {}
    }
    return _orig.apply(this, args);
  };
  console.log('[harvester] Blocker installed');
})();`;
}

/**
 * V2 invisible — one-shot. Renders hidden widget, executes, stores token,
 * fires event, stops. Background owns the 80–100 s interval.
 */
function getV2Script(tabId, serverPort) {
  return `(function() {
  if (window.__V2_HARVESTER_RUNNING__) { console.log('[v2] already running, skip'); return; }
  window.__V2_HARVESTER_RUNNING__ = true;

  var SERVER_URL = 'http://localhost:${serverPort}/api';
  var V2_SITEKEY = '6Ld7ePYrAAAAAB34ovoFoDau1fqCJ6IyOjFEQaMn';
  var TAB_ID     = ${tabId};

  function signal(isError) {
    window.__V2_HARVESTER_RUNNING__ = false;
    window.dispatchEvent(new CustomEvent('__arena_token_stored__', {
      detail: { tabId: TAB_ID, version: 'v2', mode: 'invisible', error: !!isError }
    }));
  }

  function tryInvisible() {
    var g = window.grecaptcha && window.grecaptcha.enterprise;
    if (!g || typeof g.render !== 'function') { setTimeout(tryInvisible, 2000); return; }

    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;';
    document.body.appendChild(el);
    var settled = false;

    var guard = setTimeout(function() {
      if (settled) return; settled = true; el.remove();
      console.warn('[v2] Timeout — signalling for retry');
      signal(true);
    }, 60000);

    try {
      var wid = g.render(el, {
        sitekey: V2_SITEKEY, size: 'invisible',
        callback: function(token) {
          if (settled) return; settled = true; clearTimeout(guard); el.remove();
          fetch(SERVER_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, version: 'v2', action: 'invisible_auto',
              harvest_number: 1, source_url: window.location.href, tab_id: TAB_ID })
          }).then(function(r) { return r.json(); }).then(function(data) {
            console.log('[v2] Stored. Total: ' + data.total_count + ' — signalling background');
            signal(false);
          }).catch(function(err) {
            console.error('[v2] Store failed:', err); signal(true);
          });
        },
        'error-callback': function() {
          if (settled) return; settled = true; clearTimeout(guard); el.remove();
          console.warn('[v2] reCAPTCHA error'); signal(true);
        }
      });
      if (typeof g.execute === 'function') g.execute(wid);
    } catch(e) {
      el.remove();
      console.error('[v2] render threw:', e); signal(true);
    }
  }

  console.log('[v2] One-shot invisible harvester starting');
  if (window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.ready) {
    window.grecaptcha.enterprise.ready(tryInvisible);
  } else { tryInvisible(); }
})();`;
}

/**
 * V2 checkbox — shows a panel. User solves once.
 * After each solve: stores token, fires event with mode:'checkbox'.
 * Background reloads immediately (0 ms interval) then re-injects this script.
 */
function getV2CheckboxScript(tabId, serverPort) {
  return `(function() {
  if (window.__V2_CHECKBOX_RUNNING__) { console.log('[v2-cb] already running, skip'); return; }
  window.__V2_CHECKBOX_RUNNING__ = true;

  var SERVER_URL = 'http://localhost:${serverPort}/api';
  var V2_SITEKEY = '6Ld7ePYrAAAAAB34ovoFoDau1fqCJ6IyOjFEQaMn';
  var TAB_ID     = ${tabId};
  var count      = 0;

  function createPanel() {
    if (document.getElementById('__ph_widget_container__')) return;
    var panel = document.createElement('div');
    panel.id = '__ph_widget_container__';
    panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;background:#1a1a2e;border:2px solid #16213e;border-radius:12px;padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;min-width:320px;';
    panel.innerHTML = '<div style="color:#e0e0e0;font-size:13px;margin-bottom:8px;font-weight:600;">v2 Checkbox <span id="__ph_widget_count__" style="color:#4ade80;float:right;">0 tokens</span></div>'
      + '<div id="__ph_widget_status__" style="color:#9ca3af;font-size:11px;margin-bottom:10px;">Click the checkbox to harvest</div>'
      + '<div id="__ph_widget_body__" style="display:flex;justify-content:center;"></div>'
      + '<div id="__ph_widget_dismiss__" style="color:#6b7280;font-size:11px;margin-top:8px;cursor:pointer;text-align:center;">✕ stop</div>';
    panel.querySelector('#__ph_widget_dismiss__').addEventListener('click', function() {
      panel.remove(); window.__V2_CHECKBOX_RUNNING__ = false;
    });
    document.body.appendChild(panel);
  }

  function updateStatus(msg) { var el = document.getElementById('__ph_widget_status__'); if (el) el.textContent = msg; }
  function updateCount()     { var el = document.getElementById('__ph_widget_count__');  if (el) el.textContent = count + ' token' + (count !== 1 ? 's' : ''); }

  function renderCheckbox() {
    var g = window.grecaptcha && window.grecaptcha.enterprise;
    if (!g || typeof g.render !== 'function') { setTimeout(renderCheckbox, 1000); return; }
    var panel = document.getElementById('__ph_widget_container__'); if (!panel) return;
    var old = document.getElementById('__ph_widget_body__'); if (old) old.remove();
    var container = document.createElement('div');
    container.id = '__ph_widget_body__'; container.style.cssText = 'display:flex;justify-content:center;';
    panel.insertBefore(container, panel.lastElementChild);
    updateStatus('Click the checkbox to harvest a v2 token');
    var expTimer = setTimeout(function() { updateStatus('Expired — re-rendering...'); renderCheckbox(); }, 60000);
    try {
      g.render(container, {
        sitekey: V2_SITEKEY,
        callback: function(token) {
          clearTimeout(expTimer); count++; updateCount();
          updateStatus('Token #' + count + ' captured — storing...');
          fetch(SERVER_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, version: 'v2', action: 'checkbox_challenge',
              harvest_number: count, source_url: window.location.href, tab_id: TAB_ID })
          }).then(function(r) { return r.json(); }).then(function(data) {
            console.log('[v2-checkbox #' + count + '] Stored. Total: ' + data.total_count);
            updateStatus('Stored! Reloading...');
            window.__V2_CHECKBOX_RUNNING__ = false;
            // mode:'checkbox' → background uses 0 ms delay
            window.dispatchEvent(new CustomEvent('__arena_token_stored__', {
              detail: { tabId: TAB_ID, version: 'v2', mode: 'checkbox', error: false }
            }));
          }).catch(function(err) {
            console.error('[v2-checkbox] Store failed:', err);
            updateStatus('Store failed — retry in 3s...');
            setTimeout(renderCheckbox, 3000);
          });
        },
        'error-callback':   function() { clearTimeout(expTimer); updateStatus('Failed — retry in 5s...');  setTimeout(renderCheckbox, 5000); },
        'expired-callback': function() { clearTimeout(expTimer); updateStatus('Expired — retry in 3s...'); setTimeout(renderCheckbox, 3000); },
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      });
    } catch(e) {
      clearTimeout(expTimer);
      updateStatus('Error: ' + e.message + ' — retry in 10s...');
      setTimeout(renderCheckbox, 10000);
    }
  }

  console.log('[v2-checkbox] Panel starting');
  createPanel();
  if (window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.ready) {
    window.grecaptcha.enterprise.ready(renderCheckbox);
  } else { renderCheckbox(); }
})();`;
}

/**
 * V3 — one-shot. Executes enterprise token, stores it, fires event, stops.
 * Background owns the 12–18 s wait before the next reload+re-inject.
 */
function getV3Script(tabId, serverPort) {
  return `(function() {
  if (window.__V3_HARVESTER_RUNNING__) { console.log('[v3] already running, skip'); return; }
  window.__V3_HARVESTER_RUNNING__ = true;

  var SERVER_URL = 'http://localhost:${serverPort}/api';
  var SITE_KEY   = '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I';
  var ACTION     = 'chat_submit';
  var TAB_ID     = ${tabId};

  function signal(isError) {
    window.__V3_HARVESTER_RUNNING__ = false;
    window.dispatchEvent(new CustomEvent('__arena_token_stored__', {
      detail: { tabId: TAB_ID, version: 'v3', error: !!isError }
    }));
  }

  function harvest() {
    if (!window.grecaptcha || !window.grecaptcha.enterprise) {
      setTimeout(harvest, 2000); return;
    }
    grecaptcha.enterprise.ready(function() {
      grecaptcha.enterprise.execute(SITE_KEY, { action: ACTION })
        .then(function(token) {
          console.log('[v3] Token generated (' + token.length + ' chars) — storing');
          return fetch(SERVER_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, version: 'v3', action: ACTION,
              harvest_number: 1, source_url: window.location.href, tab_id: TAB_ID })
          }).then(function(r) { return r.json(); });
        })
        .then(function(data) {
          console.log('[v3] Stored. Total: ' + data.total_count + ' — signalling background');
          signal(false);
        })
        .catch(function(err) {
          console.error('[v3] Error:', err);
          signal(true);
        });
    });
  }

  console.log('[v3] One-shot harvester starting');
  harvest();
})();`;
}

function getInvisibleScript(serverPort) {
  return `(function() {
  var SERVER_URL = 'http://localhost:${serverPort}/api';
  var SITE_KEY   = '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I';
  function loadScript() {
    return new Promise(function(res, rej) {
      if (document.querySelector('script[src*="recaptcha/enterprise.js"]')) { res(); return; }
      var s = document.createElement('script'); s.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + SITE_KEY;
      s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  function waitFor() {
    return new Promise(function(res, rej) {
      var t = Date.now();
      (function check() {
        if (window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.render) { res(); return; }
        if (Date.now() - t > 30000) { rej(new Error('Timeout')); return; }
        setTimeout(check, 100);
      })();
    });
  }
  (async function() {
    try {
      if (!window.grecaptcha || !window.grecaptcha.enterprise) await loadScript();
      await waitFor();
      var g = window.grecaptcha.enterprise;
      var el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
      document.body.appendChild(el);
      var settled = false, done = function(fn, v) { if (settled) return; settled = true; fn(v); };
      var token = await new Promise(function(res, rej) {
        var t = setTimeout(function() { done(rej, 'TIMEOUT'); }, 60000);
        var wid = g.render(el, {
          sitekey: SITE_KEY, size: 'invisible',
          callback: function(tok) { clearTimeout(t); done(res, tok); },
          'error-callback': function() { clearTimeout(t); done(rej, 'ERROR'); }
        });
        if (typeof g.execute === 'function') g.execute(wid);
      });
      el.remove();
      await fetch(SERVER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, version: 'v2_ondemand', action: 'manual_trigger', source_url: window.location.href }) });
      console.log('[invisible] Token stored');
    } catch(e) { console.error('[invisible] Failed:', e); }
  })();
})();`;
}

// ─── HARD_TUNING helpers ──────────────────────────────────────────────────────

async function hardTuningCycleCookies(keepSet) {
  try {
    const all   = await chrome.cookies.getAll({ domain: "arena.ai" });
    const saved = all.filter(c => keepSet.has(c.name));
    console.log("[bg][HARD_TUNING] Saving:", saved.map(c => c.name).join(", ") || "none");
    for (const c of all) {
      const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
      await chrome.cookies.remove({ url, name: c.name }).catch(() => {});
    }
    console.log("[bg][HARD_TUNING] Wiped", all.length, "cookies");
    return saved;
  } catch (e) {
    console.error("[bg][HARD_TUNING] wipe error:", e);
    return [];
  }
}

async function restoreCookies(saved) {
  for (const c of saved) {
    try {
      const url = `https://${c.domain.replace(/^\./, "")}${c.path}`;
      await chrome.cookies.set({
        url, name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly,
        sameSite: (c.sameSite || "lax").toLowerCase(),
        ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
      });
    } catch (e) { console.warn("[bg][HARD_TUNING] restore failed:", c.name, e.message); }
  }
  console.log("[bg][HARD_TUNING] Restored", saved.length, "cookies");
}

// ─── Reload + re-inject (called after interval wait has elapsed) ──────────────

async function reloadAndReinject(tabId) {
  const cfg   = await getConfig();
  const state = tabState[tabId];
  if (!state || !state.activeHarvester) {
    console.log("[bg] Tab", tabId, "— harvester off, skip reload");
    if (state) state.status = "idle";
    broadcastStateUpdate();
    return;
  }

  state.status = "reloading";
  broadcastStateUpdate();

  const keepList = (cfg.HARD_TUNING_KEEP && cfg.HARD_TUNING_KEEP.length > 0)
    ? cfg.HARD_TUNING_KEEP
    : DEFAULT_CONFIG.HARD_TUNING_KEEP;
  const keepSet = new Set(keepList);

  let savedCookies = [];
  if (cfg.HARD_TUNING) savedCookies = await hardTuningCycleCookies(keepSet);

  const targetUrl = (cfg.FIVE_GAIN && cfg.EVAL_ID)
    ? `https://arena.ai/c/${cfg.EVAL_ID}`
    : "https://arena.ai";

  // Navigate and wait for the page to finish loading
  try {
    await new Promise((resolve, reject) => {
      const onCompleted = (details) => {
        if (details.tabId !== tabId || details.frameId !== 0) return;
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
        resolve();
      };
      chrome.webNavigation.onCompleted.addListener(onCompleted);

      const nav = (cfg.FIVE_GAIN && cfg.EVAL_ID)
        ? chrome.tabs.update(tabId, { url: targetUrl })
        : chrome.tabs.reload(tabId, { bypassCache: cfg.HARD_TUNING });

      nav.catch(err => {
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
        reject(err);
      });
    });
  } catch (err) {
    console.error("[bg] Reload error:", err.message);
    if (tabState[tabId]) tabState[tabId].status = "idle";
    broadcastStateUpdate();
    return;
  }

  // Restore cookies if needed, then give the page a moment to settle
  if (cfg.HARD_TUNING && savedCookies.length > 0) {
    await restoreCookies(savedCookies);
    await new Promise(r => setTimeout(r, 400));
  }

  // Re-check harvester hasn't been stopped during all the async work
  const s = tabState[tabId];
  if (!s || !s.activeHarvester) {
    if (s) s.status = "idle";
    broadcastStateUpdate();
    return;
  }

  try {
    await runInTab(tabId, getBlockerScript());
    const harvType = s.activeHarvester;
    // Use checkbox script only if that's what was started, otherwise invisible
    const script = harvType === "v3"
      ? getV3Script(tabId, cfg.SERVER_PORT)
      : (s.checkboxMode ? getV2CheckboxScript(tabId, cfg.SERVER_PORT) : getV2Script(tabId, cfg.SERVER_PORT));
    await runInTab(tabId, script);
    s.status = harvType === "v2" ? "harvesting_v2" : "harvesting_v3";
    console.log("[bg] Tab", tabId, "✅", harvType, "re-injected after reload");
  } catch (e) {
    console.error("[bg] Re-inject error:", e.message);
    if (tabState[tabId]) tabState[tabId].status = "idle";
  }
  broadcastStateUpdate();
}

// ─── Token stored handler — owns the full timing loop ────────────────────────

async function onTokenStored(tabId, version, mode, isError) {
  const cfg   = await getConfig();
  const state = tabState[tabId];

  if (!state || !state.activeHarvester) {
    console.log("[bg] TOKEN_STORED tab", tabId, "— harvester off, ignoring");
    return;
  }

  // Count successful tokens
  if (!isError) state.tokenCount = (state.tokenCount || 0) + 1;

  // Clear any stale wait timer
  if (state.waitTimer) { clearTimeout(state.waitTimer); state.waitTimer = null; }

  if (!cfg.TUNING) {
    // TUNING off: just record the token, no reload
    broadcastStateUpdate();
    return;
  }

  // Determine wait duration
  let delayMs;
  if (isError) {
    delayMs = 15000; // 15 s backoff on error
    console.log(`[bg] Tab ${tabId} — error/timeout, retry in 15s`);
  } else if (mode === "checkbox") {
    delayMs = 0;     // checkbox: reload immediately, user is sitting there
    console.log(`[bg] Tab ${tabId} — checkbox token stored, reloading immediately`);
  } else {
    delayMs = getIntervalMs(state.activeHarvester);
    console.log(`[bg] Tab ${tabId} — token #${state.tokenCount} stored, waiting ${(delayMs/1000).toFixed(1)}s`);
  }

  state.status = delayMs > 0 ? "waiting" : "reloading";
  broadcastStateUpdate();

  if (delayMs === 0) {
    // Fire immediately without setTimeout overhead
    reloadAndReinject(tabId).catch(e => console.error("[bg] reload error:", e));
  } else {
    state.waitTimer = setTimeout(() => {
      state.waitTimer = null;
      reloadAndReinject(tabId).catch(e => console.error("[bg] reload error:", e));
    }, delayMs);
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcastStateUpdate() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE" }).catch(() => {});
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    let cfg;
    try { cfg = await getConfig(); } catch(e) { cfg = Object.assign({}, DEFAULT_CONFIG); }

    try {
      switch (msg.type) {

        case "GET_STATE": {
          const tabs = await chrome.tabs.query({ url: "https://arena.ai/*" });
          sendResponse({
            ok: true,
            tabs: tabs.map(t => ({
              tabId: t.id,
              title: t.title || ("Tab " + t.id),
              url:   t.url || "",
              ...(tabState[t.id] || { status: "idle", activeHarvester: null, tokenCount: 0 }),
            })),
            config: cfg,
          });
          break;
        }

        case "SAVE_CONFIG": {
          if (msg.config.HARD_TUNING && !msg.config.TUNING) {
            sendResponse({ ok: false, error: "HARD_TUNING requires TUNING=true" });
            break;
          }
          await saveConfig(Object.assign({}, cfg, msg.config));
          sendResponse({ ok: true });
          break;
        }

        // Forwarded from content.js after page fires __arena_token_stored__
        case "TOKEN_STORED": {
          const { tabId, version, mode, error: isError } = msg;
          sendResponse({ ok: true });
          onTokenStored(tabId, version, mode || null, !!isError)
            .catch(e => console.error("[bg] onTokenStored error:", e));
          break;
        }

        case "V2_START": {
          // Invisible auto-harvest mode
          const { tabId } = msg;
          if (!tabState[tabId]) tabState[tabId] = { status: "idle", activeHarvester: null, tokenCount: 0, waitTimer: null };
          const s = tabState[tabId];
          if (s.waitTimer) { clearTimeout(s.waitTimer); s.waitTimer = null; }
          s.checkboxMode = false;
          try {
            await runInTab(tabId, getBlockerScript());
            await runInTab(tabId, getV2Script(tabId, cfg.SERVER_PORT));
            s.activeHarvester = "v2"; s.status = "harvesting_v2";
            sendResponse({ ok: true });
          } catch (e) {
            console.error("[bg] V2_START error:", e);
            sendResponse({ ok: false, error: e.message });
          }
          broadcastStateUpdate();
          break;
        }

        case "V2_CHECKBOX_START": {
          const { tabId } = msg;
          if (!tabState[tabId]) tabState[tabId] = { status: "idle", activeHarvester: null, tokenCount: 0, waitTimer: null };
          const s = tabState[tabId];
          if (s.waitTimer) { clearTimeout(s.waitTimer); s.waitTimer = null; }
          s.checkboxMode = true;
          try {
            await runInTab(tabId, getBlockerScript());
            await runInTab(tabId, getV2CheckboxScript(tabId, cfg.SERVER_PORT));
            s.activeHarvester = "v2"; s.status = "harvesting_v2";
            sendResponse({ ok: true });
          } catch (e) {
            console.error("[bg] V2_CHECKBOX_START error:", e);
            sendResponse({ ok: false, error: e.message });
          }
          broadcastStateUpdate();
          break;
        }

        case "V2_STOP": {
          const { tabId } = msg;
          const s = tabState[tabId];
          if (s) {
            if (s.waitTimer) { clearTimeout(s.waitTimer); s.waitTimer = null; }
            s.activeHarvester = null; s.status = "idle"; s.checkboxMode = false;
          }
          try {
            await runInTab(tabId,
              "window.__V2_HARVESTER_RUNNING__=false;" +
              "window.__V2_CHECKBOX_RUNNING__=false;" +
              "var p=document.getElementById('__ph_widget_container__');if(p)p.remove();"
            );
          } catch(_) {}
          sendResponse({ ok: true });
          broadcastStateUpdate();
          break;
        }

        case "V3_START": {
          const { tabId } = msg;
          if (!tabState[tabId]) tabState[tabId] = { status: "idle", activeHarvester: null, tokenCount: 0, waitTimer: null };
          const s = tabState[tabId];
          if (s.waitTimer) { clearTimeout(s.waitTimer); s.waitTimer = null; }
          try {
            await runInTab(tabId, getBlockerScript());
            await runInTab(tabId, getV3Script(tabId, cfg.SERVER_PORT));
            s.activeHarvester = "v3"; s.status = "harvesting_v3";
            sendResponse({ ok: true });
          } catch (e) {
            console.error("[bg] V3_START error:", e);
            sendResponse({ ok: false, error: e.message });
          }
          broadcastStateUpdate();
          break;
        }

        case "V3_STOP": {
          const { tabId } = msg;
          const s = tabState[tabId];
          if (s) {
            if (s.waitTimer) { clearTimeout(s.waitTimer); s.waitTimer = null; }
            s.activeHarvester = null; s.status = "idle";
          }
          try { await runInTab(tabId, "window.__V3_HARVESTER_RUNNING__=false;"); } catch(_) {}
          sendResponse({ ok: true });
          broadcastStateUpdate();
          break;
        }

        case "INVISIBLE_RUN": {
          const { tabId } = msg;
          try {
            await runInTab(tabId, getInvisibleScript(cfg.SERVER_PORT));
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (e) {
      console.error("[bg] Unhandled error:", e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ─── Tab close cleanup ────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  const s = tabState[tabId];
  if (s && s.waitTimer) clearTimeout(s.waitTimer);
  delete tabState[tabId];
});

console.log("[bg] Arena Harvester service worker ready.");
