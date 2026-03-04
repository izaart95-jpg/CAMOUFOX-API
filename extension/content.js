// Content script for arena.ai
console.log('🔷 reCAPTCHA Harvester content script loaded');

// Send ready signal
setTimeout(() => {
  chrome.runtime.sendMessage({ type: 'TAB_READY' });
}, 3000);

// Initial v2 token harvest
function harvestInitialV2() {
  const script = `
    (() => {
      const SITE_KEY = '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I';
      
      async function getV2Token() {
        const w = window.wrappedJSObject || window;
        await waitForGrecaptcha(w);
        const g = w.grecaptcha?.enterprise;
        if (!g || typeof g.render !== 'function') throw new Error('NO_GRECAPTCHA_V2');
        
        let settled = false;
        const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
        
        return new Promise((resolve, reject) => {
          try {
            const el = w.document.createElement('div');
            el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
            w.document.body.appendChild(el);
            
            const timer = w.setTimeout(() => done(reject, 'V2_TIMEOUT'), 60000);
            
            const wid = g.render(el, {
              sitekey: SITE_KEY,
              size: 'invisible',
              callback: (tok) => {
                w.clearTimeout(timer);
                done(resolve, tok);
              },
              'error-callback': () => {
                w.clearTimeout(timer);
                done(reject, 'V2_ERROR');
              }
            });
            
            if (typeof g.execute === 'function') g.execute(wid);
          } catch (e) {
            done(reject, String(e));
          }
        });
      }
      
      async function waitForGrecaptcha(w) {
        const start = Date.now();
        while (Date.now() - start < 60000) {
          if (w.grecaptcha?.enterprise?.render) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('Timeout waiting for grecaptcha');
      }
      
      (async function() {
        try {
          const token = await getV2Token();
          console.log('✅ INITIAL token received');
          
          fetch('http://localhost:3000/api/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token,
              version: 'v2_initial',
              action: 'initial_page_load',
              source_url: window.location.href
            })
          }).catch(err => console.log('Store failed:', err));
        } catch (error) {
          console.error('❌ Initial token failed:', error);
        }
      })();
    })();
  `;
  
  const scriptElement = document.createElement('script');
  scriptElement.textContent = script;
  document.documentElement.appendChild(scriptElement);
  scriptElement.remove();
}

// Run initial harvest after page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(harvestInitialV2, 2000);
  });
} else {
  setTimeout(harvestInitialV2, 2000);
}

// Auto-login if configured
chrome.storage.local.get(['settings'], (result) => {
  const settings = result.settings || {};
  if (settings.autoLogin && settings.email && settings.password) {
    setTimeout(async () => {
      try {
        const resp = await fetch("https://arena.ai/nextjs-api/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: settings.email,
            password: settings.password,
            shouldLinkHistory: false
          }),
          credentials: "include"
        });
        
        if (resp.ok) {
          chrome.runtime.sendMessage({ 
            type: 'AUTO_LOGIN_SUCCESS',
            data: { autoLoginSuccess: true }
          });
        }
      } catch (e) {
        console.error('Auto-login failed:', e);
      }
    }, 3000);
  }
});