const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = 3000;
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Ensure files exist
fs.ensureFileSync(TOKENS_FILE);
fs.ensureFileSync(CONFIG_FILE);

// Initialize files if empty
if (fs.readFileSync(TOKENS_FILE, 'utf-8').trim() === '') {
  fs.writeJsonSync(TOKENS_FILE, { tokens: [], total_count: 0, last_updated: '' });
}

if (fs.readFileSync(CONFIG_FILE, 'utf-8').trim() === '') {
  fs.writeJsonSync(CONFIG_FILE, {});
}

// Token storage functions
function loadTokens() {
  try {
    return fs.readJsonSync(TOKENS_FILE);
  } catch (e) {
    return { tokens: [], total_count: 0, last_updated: '' };
  }
}

function saveTokens(data) {
  fs.writeJsonSync(TOKENS_FILE, data, { spaces: 2 });
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Get all tokens
app.get('/api/tokens', (req, res) => {
  const data = loadTokens();
  res.json(data);
});

// Store a token
app.post('/api/tokens', (req, res) => {
  const tokenData = req.body;
  const tokensData = loadTokens();
  
  // Create token entry
  const entry = {
    token: tokenData.token,
    version: tokenData.version || 'v3',
    action: tokenData.action || '',
    source_url: tokenData.source_url || '',
    tabId: tokenData.tabId || -1,
    harvest_number: tokenData.harvest_number || 0,
    timestamp_utc: new Date().toISOString(),
    timestamp_local: new Date().toLocaleString(),
    token_preview: tokenData.token.length > 40 
      ? tokenData.token.substring(0, 40) + '...' 
      : tokenData.token
  };
  
  tokensData.tokens.push(entry);
  tokensData.total_count = tokensData.tokens.length;
  tokensData.last_updated = entry.timestamp_utc;
  
  saveTokens(tokensData);
  
  console.log(`[token] ${entry.version} - ${entry.token_preview} (total: ${tokensData.total_count})`);
  
  res.json({ 
    success: true, 
    total_count: tokensData.total_count,
    token_id: tokensData.tokens.length - 1
  });
});

// Clear tokens
app.delete('/api/tokens', (req, res) => {
  const tokensData = loadTokens();
  const removed = tokensData.tokens.length;
  
  saveTokens({ tokens: [], total_count: 0, last_updated: new Date().toISOString() });
  
  res.json({ success: true, removed });
});

// Get latest tokens
app.get('/api/tokens/latest', (req, res) => {
  const tokensData = loadTokens();
  const tokens = tokensData.tokens || [];
  const latest = {};
  
  // Get the most recent token of each version
  for (const token of tokens) {
    const version = token.version;
    if (!latest[version] || new Date(token.timestamp_utc) > new Date(latest[version].timestamp_utc)) {
      latest[version] = token;
    }
  }
  
  res.json({ latest });
});

// Tab ready notification
app.post('/api/tabs/:tabId/ready', (req, res) => {
  console.log(`[tab ${req.params.tabId}] marked ready`);
  res.json({ success: true });
});

// Update config
app.post('/api/config', (req, res) => {
  const updates = req.body;
  const config = fs.readJsonSync(CONFIG_FILE);
  
  Object.assign(config, updates);
  fs.writeJsonSync(CONFIG_FILE, config, { spaces: 2 });
  
  res.json({ success: true });
});

// Get config
app.get('/api/config', (req, res) => {
  const config = fs.readJsonSync(CONFIG_FILE);
  res.json(config);
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const tokensData = loadTokens();
  const tokens = tokensData.tokens || [];
  
  const stats = {
    total: tokens.length,
    v2: tokens.filter(t => t.version?.includes('v2')).length,
    v3: tokens.filter(t => t.version === 'v3').length,
    fresh: tokens.filter(t => {
      const age = (Date.now() - new Date(t.timestamp_utc).getTime()) / 1000;
      return age < 120;
    }).length
  };
  
  res.json(stats);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║  reCAPTCHA Harvester Server            ║
║  Dashboard: http://localhost:${PORT}   ║
║  API: http://localhost:${PORT}/api     ║
║  Tokens: ${TOKENS_FILE}                 ║
╚════════════════════════════════════════╝
  `);
});