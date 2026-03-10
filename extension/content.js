/**
 * content.js — Arena reCAPTCHA Harvester
 * =======================================
 * Injected into every arena.ai page at document_idle.
 *
 * Responsibilities:
 *   - Install the fetch blocker (removes forceLowRecaptchaScore) immediately
 *   - Bridge page → background for TOKEN_STORED so TUNING reloads actually fire
 */

// ─── Install fetch blocker in MAIN world ──────────────────────────────────────

function installBlockerViaScript() {
  if (document.getElementById("__arena_blocker_script__")) return;
  const s = document.createElement("script");
  s.id = "__arena_blocker_script__";
  s.textContent = `
    (function() {
      if (window.__ARENA_BLOCKER_INSTALLED__) return;
      window.__ARENA_BLOCKER_INSTALLED__ = true;
      const _origFetch = window.fetch;
      window.fetch = function(...args) {
        let [url, options = {}] = args;
        if (options.body && typeof options.body === 'string') {
          try {
            const body = JSON.parse(options.body);
            const deepClean = (obj) => {
              if (!obj || typeof obj !== 'object') return obj;
              if (Array.isArray(obj)) return obj.map(deepClean);
              const out = {};
              for (const [k, v] of Object.entries(obj)) {
                if (k === 'forceLowRecaptchaScore') { console.log('🚫 REMOVED forceLowRecaptchaScore'); continue; }
                out[k] = deepClean(v);
              }
              return out;
            };
            options = { ...options, body: JSON.stringify(deepClean(body)) };
            args[1] = options;
          } catch(_) {}
        }
        return _origFetch.apply(this, args);
      };
      console.log('[content] ✅ Arena Blocker installed');
    })();
  `;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
}

installBlockerViaScript();

// ─── Bridge: page window messages → background service worker ─────────────────
// Harvester scripts (running in MAIN world) dispatch a CustomEvent after a token
// is successfully stored. We relay that here so background.js can trigger reloads.
//
// Event fired from injected scripts:
//   window.dispatchEvent(new CustomEvent('__arena_token_stored__', {
//     detail: { tabId, version }
//   }));

window.addEventListener("__arena_token_stored__", (e) => {
  const { tabId, version, mode, error } = e.detail || {};
  chrome.runtime.sendMessage({ type: "TOKEN_STORED", tabId, version, mode: mode || null, error: !!error })
    .catch(() => {});
});

// ─── Listen for messages from background ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") {
    // Reserved for future page-level notifications
  }
});

console.log("[content] Arena Harvester content script loaded on", window.location.href);
