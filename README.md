# reCAPTCHA Harvester Extension Framework <span class="badge">Flexible</span>

A modular browser extension architecture for harvesting reCAPTCHA v2/v3 tokens — currently configured for `arena.ai`, but designed for easy adaptation to any target website.

> **Important:** This project is a *framework*. While the current implementation is tuned for `arena.ai`, the core logic, injection pipeline, and token routing are intentionally decoupled from domain-specific details. With minimal configuration changes (target URL, cookie names, endpoint paths), this architecture can be repurposed for any website implementing reCAPTCHA v2 or v3.

---

## 🔧 Architecture Overview

```
Your Browser (Target Tab)
        │
        │  chrome.scripting.executeScript
        ▼
   content.js  ←──── manifest.json (matches target domain)
        │
        │  Installs fetch/XHR interceptor in page context
        │
   background.js  (Service Worker)
        │
        │  • Injects reCAPTCHA v2/v3 harvesters dynamically
        │  • Manages TUNING / HARD_TUNING reload cycles
        │  • Handles cookie preservation & selective wipe
        │  • Routes harvested tokens to local API
        │
        │  POST /api/tokens
        ▼
   server.py  (Local FastAPI Backend)
        │
        ▼
   tokens.json  ──→  Consumed by modula.py / main.py
```

---

## ⚙️ Setup Instructions

### 1. Start the Local API Server

```bash
pip install fastapi uvicorn
python server.py
```

Dashboard available at: `http://localhost:5000`

### 2. Install the Browser Extension

1. Navigate to `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory
5. Confirm the 🎯 icon appears in your toolbar

### 3. Begin Harvesting

1. Open your target site (e.g., [https://arena.ai](https://arena.ai)) and authenticate if required
2. Click the 🎯 extension icon in your toolbar
3. Select the active target tab from the popup
4. Click **V2 Start** or **V3 Start** to begin token collection

---

## ✨ Core Features

### 🔄 TUNING Mode

When enabled, the extension automatically reloads the target tab after each successful token harvest and re-injects the harvesting script. This creates a continuous, self-sustaining collection loop until manually stopped.

### 🧼 HARD_TUNING Mode *(requires `TUNING=true`)*

Enhances token freshness by simulating a "clean" browser session per harvest cycle:

1. Preserves 4 essential authentication cookies in memory:
   - `arena-auth-prod-v1.0`
   - `arena-auth-prod-v1.1`
   - `__cf_bm`
   - `cf_clearance`
2. Deletes all other domain-scoped cookies to clear session fingerprint artifacts
3. Reloads the tab with a sanitized cookie jar
4. Restores the preserved authentication cookies to maintain login state
5. Re-injects the harvester script for the next cycle

**Result:** Each reCAPTCHA request originates from a minimally fingerprinted session, reducing historical signal contamination and improving token quality scores.

### 🎯 FIVE_GAIN Mode

When enabled, post-reload navigation targets a specific evaluation path: `arena.ai/c/<eval_id>` instead of the root domain. Configure your desired `eval_id` in the extension Settings panel.

---

## 📦 Project Structure

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest: permissions, content script matches, service worker declaration |
| `background.js` | Service worker: orchestrates injection, tuning logic, cookie management, and API communication |
| `content.js` | Page-level script: intercepts reCAPTCHA network requests within the target page context |
| `popup.html` / `popup.js` | Extension popup UI: tab selection, mode toggles, and harvest controls |
| `server.py` | Local FastAPI server: receives and persists harvested tokens to `tokens.json` |

---

## 🔍 Capability Comparison: Framework vs. Playwright Implementation

| Feature | Playwright Version | Extension Framework |
|---------|-------------------|---------------------|
| Multi-window support | ✅ Native | Use multiple browser tabs |
| Session isolation (HARD_TUNING) | Full profile directory wipe | ✅ Cookie-level isolation (equivalent fingerprint reset) |
| Authentication handling | ✅ Auto-login scripting | Manual login (persistent session via preserved cookies) |
| Anti-detection (mouse movement) | ✅ Programmatic simulation | Not required (executes in real user browser context) |
| Stealth profile | Injected stealth scripts | ✅ Native browser environment (inherently low-detection) |
| Third-party extension compatibility | ✅ Via Playwright context | ✅ Install directly in browser (e.g., RektCaptcha for v2) |

---

## ♻️ Adapting This Framework

To repurpose this extension for a different target website:

1. **Update `manifest.json`**: Modify `content_scripts.matches` to target your domain
2. **Configure domain-specific values** in `background.js`:
   - Cookie names for authentication preservation
   - Target URL patterns for FIVE_GAIN-style navigation
   - reCAPTCHA site keys or endpoint identifiers (if required)
3. **Adjust the local server** (`server.py`) if token schema or storage logic differs
4. **Test injection reliability**: Verify that `content.js` correctly intercepts reCAPTCHA requests on your target site

The separation of concerns—content script for interception, background script for orchestration, and external server for persistence—ensures minimal friction when retargeting.

---

⚠️ **Ethical Use Notice:** This framework is provided for educational, research, and authorized security testing purposes only. Always comply with target websites' Terms of Service, applicable laws (e.g., CFAA, GDPR), and obtain explicit permission before harvesting tokens or automating interactions.

© 2026 reCAPTCHA Harvester Framework — Modular Architecture for Ethical Automation Research
