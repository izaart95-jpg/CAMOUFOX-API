let port = chrome.runtime.connect({ name: 'popup' });
let settings = {};

// Load settings
chrome.storage.local.get(['settings'], (result) => {
  settings = result.settings || {
    autoLogin: false,
    email: '',
    password: '',
    fiveGain: false,
    evalId: '',
    tuning: true
  };
  
  document.getElementById('autoLogin').checked = settings.autoLogin;
  document.getElementById('email').value = settings.email || '';
  document.getElementById('password').value = settings.password || '';
  document.getElementById('fiveGain').checked = settings.fiveGain;
  document.getElementById('evalId').value = settings.evalId || '';
  document.getElementById('tuning').checked = settings.tuning !== false;
  
  toggleFields();
});

// Toggle fields based on checkboxes
document.getElementById('autoLogin').addEventListener('change', toggleFields);
document.getElementById('fiveGain').addEventListener('change', toggleFields);

function toggleFields() {
  const autoLogin = document.getElementById('autoLogin').checked;
  const fiveGain = document.getElementById('fiveGain').checked;
  
  document.getElementById('emailField').style.display = autoLogin ? 'block' : 'none';
  document.getElementById('passwordField').style.display = autoLogin ? 'block' : 'none';
  document.getElementById('evalField').style.display = fiveGain ? 'block' : 'none';
}

// Save settings
document.getElementById('saveSettings').addEventListener('click', () => {
  settings = {
    autoLogin: document.getElementById('autoLogin').checked,
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
    fiveGain: document.getElementById('fiveGain').checked,
    evalId: document.getElementById('evalId').value,
    tuning: document.getElementById('tuning').checked
  };
  
  chrome.storage.local.set({ settings });
  port.postMessage({ action: 'updateSettings', settings });
  
  // Show saved message
  const btn = document.getElementById('saveSettings');
  const originalText = btn.textContent;
  btn.textContent = '✓ Saved';
  setTimeout(() => { btn.textContent = originalText; }, 1500);
});

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', loadTabs);

// Request status update
port.postMessage({ action: 'getStatus' });

// Handle incoming messages
port.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    renderTabs(msg.data);
  }
});

// Load token stats
async function loadStats() {
  try {
    const res = await fetch('http://localhost:3000/api/tokens');
    const data = await res.json();
    
    const tokens = data.tokens || [];
    const v2 = tokens.filter(t => t.version?.includes('v2')).length;
    const v3 = tokens.filter(t => t.version === 'v3').length;
    
    document.getElementById('total-tokens').textContent = tokens.length;
    document.getElementById('v2-tokens').textContent = v2;
    document.getElementById('v3-tokens').textContent = v3;
  } catch (e) {
    document.getElementById('total-tokens').textContent = '?';
  }
}

// Load tabs
async function loadTabs() {
  port.postMessage({ action: 'getStatus' });
  loadStats();
}

function renderTabs(tabs) {
  const container = document.getElementById('tabsList');
  document.getElementById('active-tabs').textContent = tabs.length;
  
  if (tabs.length === 0) {
    container.innerHTML = '<p style="color:#6b7280; font-size:12px; text-align:center;">No arena.ai tabs open</p>';
    return;
  }
  
  container.innerHTML = tabs.map(tab => `
    <div class="tab-item">
      <div class="tab-title">${tab.title || 'Arena.ai'}</div>
      <div class="tab-status status-${tab.status}">${tab.status.replace('_', ' ').toUpperCase()}</div>
      <div class="btn-row">
        <button class="btn v2-start" onclick="window.controlTab(${tab.tabId}, 'v2-start')" ${tab.status.includes('harvesting') ? 'disabled' : ''}>V2 Start</button>
        <button class="btn v2-stop" onclick="window.controlTab(${tab.tabId}, 'v2-stop')" ${!tab.status.includes('harvesting_v2') ? 'disabled' : ''}>V2 Stop</button>
        <button class="btn v3-start" onclick="window.controlTab(${tab.tabId}, 'v3-start')" ${tab.status.includes('harvesting') ? 'disabled' : ''}>V3 Start</button>
        <button class="btn v3-stop" onclick="window.controlTab(${tab.tabId}, 'v3-stop')" ${!tab.status.includes('harvesting_v3') ? 'disabled' : ''}>V3 Stop</button>
      </div>
      <button class="btn inv-run" onclick="window.controlTab(${tab.tabId}, 'invisible')">🎯 Run Invisible Script</button>
    </div>
  `).join('');
  
  // Make control functions available globally
  window.controlTab = (tabId, action) => {
    if (action === 'v2-start') port.postMessage({ action: 'startV2', tabId });
    if (action === 'v2-stop') port.postMessage({ action: 'stopV2', tabId });
    if (action === 'v3-start') port.postMessage({ action: 'startV3', tabId });
    if (action === 'v3-stop') port.postMessage({ action: 'stopV3', tabId });
    if (action === 'invisible') port.postMessage({ action: 'runInvisible', tabId });
    
    // Update UI after a delay
    setTimeout(loadTabs, 500);
  };
}

// Initial load
loadTabs();
setInterval(loadTabs, 3000);