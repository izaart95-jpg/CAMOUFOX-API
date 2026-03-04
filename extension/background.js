// Background service worker for the extension
let serverUrl = 'http://localhost:3000';
let activeTabs = new Map(); // tabId -> { status, harvestType }
let settings = {
  autoLogin: false,
  email: '',
  password: '',
  fiveGain: false,
  evalId: '',
  tuning: true
};

// Load settings from storage
chrome.storage.local.get(['settings'], (result) => {
  if (result.settings) {
    settings = { ...settings, ...result.settings };
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TOKEN_HARVESTED') {
    // Forward token to server
    fetch(`${serverUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...message.data,
        tabId: sender.tab?.id,
        timestamp: new Date().toISOString()
      })
    })
    .then(res => res.json())
    .then(data => {
      console.log('Token stored:', data);
      
      // Handle reload if tuning is enabled
      if (settings.tuning && message.data.version !== 'v2_initial' && message.data.version !== 'v2_ondemand') {
        if (sender.tab?.id) {
          setTimeout(() => {
            chrome.tabs.reload(sender.tab.id);
          }, 1000);
        }
      }
    })
    .catch(err => console.error('Failed to store token:', err));
  }
  
  if (message.type === 'TAB_READY') {
    if (sender.tab?.id) {
      activeTabs.set(sender.tab.id, {
        status: 'ready',
        ...activeTabs.get(sender.tab.id)
      });
      
      // Notify server
      fetch(`${serverUrl}/api/tabs/${sender.tab.id}/ready`, {
        method: 'POST'
      }).catch(() => {});
    }
  }
  
  if (message.type === 'AUTO_LOGIN_SUCCESS') {
    // Save auth cookies to server
    fetch(`${serverUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.data)
    }).catch(() => {});
  }
});

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('arena.ai')) {
    // Inject blocker script on page load
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectBlockerScript
    }).catch(() => {});
  }
});

// Blocker script to inject
function injectBlockerScript() {
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    let [url, options = {}] = args;
    
    if (options.body && typeof options.body === 'string') {
      try {
        const body = JSON.parse(options.body);
        
        const deepClean = (obj) => {
          if (!obj || typeof obj !== 'object') return obj;
          if (Array.isArray(obj)) return obj.map(deepClean);
          const cleaned = {};
          for (const [key, value] of Object.entries(obj)) {
            if (key === 'forceLowRecaptchaScore') continue;
            cleaned[key] = deepClean(value);
          }
          return cleaned;
        };
        
        options = { ...options, body: JSON.stringify(deepClean(body)) };
        args[1] = options;
      } catch (e) {}
    }
    
    return originalFetch.apply(this, args);
  };
  
  console.log('🔧 Blocker installed');
}

// Start harvesting on a tab
async function startHarvesting(tabId, type) {
  activeTabs.set(tabId, {
    status: `harvesting_${type}`,
    harvestType: type
  });
  
  if (type === 'v2') {
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectV2Script,
      args: [tabId]
    });
  } else if (type === 'v3') {
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectV3Script,
      args: [tabId]
    });
  }
}

// Stop harvesting on a tab
function stopHarvesting(tabId) {
  const tab = activeTabs.get(tabId);
  if (tab) {
    activeTabs.set(tabId, { ...tab, status: 'idle' });
    
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__STOP_V2_HARVEST__) window.__STOP_V2_HARVEST__();
        if (window.__STOP_HARVEST__) window.__STOP_HARVEST__();
      }
    });
  }
}

// Export functions for popup
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'getStatus') {
      const tabs = await chrome.tabs.query({ url: 'https://arena.ai/*' });
      const status = [];
      
      for (const tab of tabs) {
        status.push({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          status: activeTabs.get(tab.id)?.status || 'idle',
          harvestType: activeTabs.get(tab.id)?.harvestType
        });
      }
      
      port.postMessage({ type: 'status', data: status });
    }
    
    if (msg.action === 'startV2') {
      startHarvesting(msg.tabId, 'v2');
    }
    
    if (msg.action === 'stopV2') {
      stopHarvesting(msg.tabId);
    }
    
    if (msg.action === 'startV3') {
      startHarvesting(msg.tabId, 'v3');
    }
    
    if (msg.action === 'stopV3') {
      stopHarvesting(msg.tabId);
    }
    
    if (msg.action === 'runInvisible') {
      chrome.scripting.executeScript({
        target: { tabId: msg.tabId },
        func: injectOnDemandV2Script
      });
    }
    
    if (msg.action === 'updateSettings') {
      settings = { ...settings, ...msg.settings };
      chrome.storage.local.set({ settings });
    }
  });
});

// Script injection functions
function injectV2Script(tabId) {
  const script = `
    (() => {
      const SERVER_URL = "http://localhost:3000/api/tokens";
      const V2_SITEKEY = "6Ld7ePYrAAAAAB34ovoFoDau1fqCJ6IyOjFEQaMn";
      
      let v2Count = 0;
      let currentTimeoutId = null;
      let widgetCounter = 0;
      let panelCreated = false;
      
      function sendToken(token, mode) {
        v2Count++;
        console.log(\`[v2-\${mode} #\${v2Count}] Token generated\`);
        
        return fetch(SERVER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            version: "v2",
            action: mode === "invisible" ? "invisible_auto" : "checkbox_challenge",
            harvest_number: v2Count,
            source_url: window.location.href,
            tabId: ${tabId},
            _reload_after: true
          })
        }).catch(err => console.error(\`[v2] Store failed:\`, err));
      }
      
      function harvestInvisible() {
        const g = window.grecaptcha?.enterprise;
        if (!g || typeof g.render !== 'function') {
          currentTimeoutId = setTimeout(harvestInvisible, 2000);
          return;
        }
        
        widgetCounter++;
        const el = document.createElement('div');
        el.id = \`__v2_inv_widget_\${widgetCounter}\`;
        el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
        document.body.appendChild(el);
        
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; el.remove(); }
        }, 60000);
        
        try {
          const wid = g.render(el, {
            sitekey: V2_SITEKEY,
            size: 'invisible',
            callback: (token) => {
              if (settled) return;
              settled = true; clearTimeout(timer); el.remove();
              sendToken(token, "invisible");
            },
            'error-callback': () => {
              if (settled) return;
              settled = true; clearTimeout(timer); el.remove();
            }
          });
          
          if (typeof g.execute === 'function') g.execute(wid);
        } catch (e) {
          if (!settled) { settled = true; clearTimeout(timer); el.remove(); }
        }
      }
      
      console.log('v2 Harvester started');
      harvestInvisible();
      
      window.__STOP_V2_HARVEST__ = () => {
        if (currentTimeoutId) { clearTimeout(currentTimeoutId); currentTimeoutId = null; }
        const panel = document.getElementById('__v2_harvest_panel');
        if (panel) panel.remove();
        console.log(\`[v2] Stopped. Tokens: \${v2Count}\`);
      };
    })();
  `;
  
  const scriptElement = document.createElement('script');
  scriptElement.textContent = script;
  document.documentElement.appendChild(scriptElement);
  scriptElement.remove();
}

function injectV3Script(tabId) {
  const script = `
    (() => {
      const SERVER_URL = "http://localhost:3000/api/tokens";
      const SITE_KEY = "6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I";
      const ACTION = "chat_submit";
      
      let tokenCount = 0;
      let currentTimeoutId = null;
      
      function harvest() {
        grecaptcha.enterprise.ready(() => {
          grecaptcha.enterprise.execute(SITE_KEY, { action: ACTION })
            .then(token => {
              tokenCount++;
              console.log(\`[v3 #\${tokenCount}] Token generated\`);
              
              return fetch(SERVER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  token,
                  version: "v3",
                  action: ACTION,
                  harvest_number: tokenCount,
                  source_url: window.location.href,
                  tabId: ${tabId},
                  _reload_after: true
                })
              }).catch(err => console.error("[v3] Store failed:", err));
            })
            .catch(err => console.error("[v3] Error:", err));
        });
      }
      
      console.log('v3 Auto-harvester started');
      harvest();
      
      window.__STOP_HARVEST__ = () => {
        if (currentTimeoutId) { clearTimeout(currentTimeoutId); currentTimeoutId = null; }
        console.log("[v3] Stopped. Total captured:", tokenCount);
      };
    })();
  `;
  
  const scriptElement = document.createElement('script');
  scriptElement.textContent = script;
  document.documentElement.appendChild(scriptElement);
  scriptElement.remove();
}

function injectOnDemandV2Script() {
  const script = `
    (() => {
      const SITE_KEY = '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I';
      
      async function getV2Token() {
        const w = window.wrappedJSObject || window;
        
        if (!w.grecaptcha?.enterprise) {
          await loadRecaptchaScript(w);
        }
        await waitForGrecaptcha(w);
        
        const g = w.grecaptcha.enterprise;
        let settled = false;
        
        return new Promise((resolve, reject) => {
          try {
            const el = w.document.createElement('div');
            el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
            w.document.body.appendChild(el);
            
            const timer = w.setTimeout(() => {
              if (!settled) { settled = true; reject('V2_TIMEOUT'); }
            }, 60000);
            
            const wid = g.render(el, {
              sitekey: SITE_KEY,
              size: 'invisible',
              callback: (tok) => { 
                w.clearTimeout(timer); 
                if (!settled) { settled = true; resolve(tok); }
              },
              'error-callback': () => { 
                w.clearTimeout(timer); 
                if (!settled) { settled = true; reject('V2_ERROR'); }
              }
            });
            
            if (typeof g.execute === 'function') g.execute(wid);
          } catch (e) {
            if (!settled) { settled = true; reject(String(e)); }
          }
        });
      }
      
      async function loadRecaptchaScript(w) {
        return new Promise((resolve, reject) => {
          if (w.document.querySelector('script[src*="recaptcha/enterprise.js"]')) {
            resolve();
            return;
          }
          const script = w.document.createElement('script');
          script.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + SITE_KEY;
          script.async = true;
          script.defer = true;
          script.onload = resolve;
          script.onerror = reject;
          w.document.head.appendChild(script);
        });
      }
      
      async function waitForGrecaptcha(w) {
        const start = Date.now();
        while (Date.now() - start < 30000) {
          if (w.grecaptcha?.enterprise?.render) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('Timeout');
      }
      
      (async function() {
        try {
          const token = await getV2Token();
          console.log('✅ On-demand token received');
          
          fetch('http://localhost:3000/api/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token,
              version: 'v2_ondemand',
              action: 'manual_trigger',
              source_url: window.location.href
            })
          }).catch(err => console.log('Store failed:', err));
          
          return token;
        } catch (error) {
          console.error('❌ On-demand token failed:', error);
        }
      })();
    })();
  `;
  
  const scriptElement = document.createElement('script');
  scriptElement.textContent = script;
  document.documentElement.appendChild(scriptElement);
  scriptElement.remove();
}