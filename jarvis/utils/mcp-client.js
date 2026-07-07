'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const state = require('./state');

const MCP_CONFIG_FILE = path.join('/data', 'mcp_servers.json');
const PROTOCOL_VERSION = '2024-11-05';

let nextRequestId = 1;
const pendingRequests = new Map();

function log(msg) { console.log(`[mcp] ${msg}`); }

function loadMcpConfig() {
  try {
    if (!fs.existsSync(MCP_CONFIG_FILE)) return {};
    const raw = fs.readFileSync(MCP_CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    log(`config load error: ${e.message}`);
    return {};
  }
}

function saveMcpConfig(config) {
  try {
    fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    log(`config save error: ${e.message}`);
  }
}

class McpServer {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.proc = null;
    this.buffer = '';
    this.tools = [];
    this.initialized = false;
    this.requestQueue = [];
    this.shuttingDown = false;
  }

  async start() {
    const cmd = this.config.command;
    if (!cmd) { log(`server ${this.name}: no command`); return; }
    const args = this.config.args || [];
    const env = { ...process.env, ...(this.config.env || {}) };
    log(`starting ${this.name}: ${cmd} ${(Array.isArray(args) ? args : [args]).join(' ')}`);

    this.proc = spawn(cmd, Array.isArray(args) ? args : [args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(`${this.name} stderr: ${text.slice(0, 200)}`);
    });
    this.proc.on('exit', (code) => {
      log(`${this.name} exited (code=${code})`);
      this.initialized = false;
      if (!this.shuttingDown) {
        log(`${this.name} will retry on next tool call`);
      }
    });

    await this._initialize();
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch {}
    }
  }

  _handleMessage(msg) {
    if (msg.id && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  _sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error(`MCP server ${this.name} not running`));
        return;
      }
      const id = nextRequestId++;
      const req = { jsonrpc: '2.0', id, method, params };
      pendingRequests.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(JSON.stringify(req) + '\n');
      } catch (e) {
        pendingRequests.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`MCP ${this.name} request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  async _initialize() {
    try {
      const result = await this._sendRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'jarvis', version: state.JARVIS_VERSION }
      });
      this._sendRequest('notifications/initialized', {}).catch(() => {});
      this.initialized = true;
      log(`${this.name} initialized (proto=${result.protocolVersion})`);
      await this._listTools();
    } catch (e) {
      log(`${this.name} init failed: ${e.message}`);
    }
  }

  async _listTools() {
    try {
      const result = await this._sendRequest('tools/list', {});
      this.tools = (result.tools || []).map(t => ({
        name: `${this.name}__${t.name}`,
        originalName: t.name,
        server: this.name,
        description: t.description || '',
        input_schema: t.inputSchema || { type: 'object', properties: {} }
      }));
      log(`${this.name} has ${this.tools.length} tools`);
    } catch (e) {
      log(`${this.name} tools/list failed: ${e.message}`);
    }
  }

  async callTool(toolName, args) {
    if (!this.initialized || !this.proc || this.proc.killed) {
      log(`${this.name} not ready, restarting...`);
      await this.start();
    }
    return this._sendRequest('tools/call', { name: toolName, arguments: args || {} });
  }

  stop() {
    this.shuttingDown = true;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }
}

const servers = {};
let allMcpTools = [];

async function initMcpServers() {
  const config = loadMcpConfig();
  const names = Object.keys(config);
  if (names.length === 0) {
    log('no MCP servers configured');
    return;
  }
  log(`initializing ${names.length} MCP server(s): ${names.join(', ')}`);
  for (const name of names) {
    const srv = new McpServer(name, config[name]);
    servers[name] = srv;
    try { await srv.start(); } catch (e) { log(`${name} start error: ${e.message}`); }
  }
  rebuildToolList();
}

function rebuildToolList() {
  allMcpTools = [];
  for (const srv of Object.values(servers)) {
    allMcpTools.push(...srv.tools);
  }
  if (allMcpTools.length > 0) {
    log(`total MCP tools available: ${allMcpTools.length}`);
  }
}

function getMcpToolDefinitions() {
  return allMcpTools.map(t => ({
    name: t.name,
    description: `[MCP:${t.server}] ${t.description}`,
    input_schema: t.input_schema
  }));
}

function getMcpOpenAiTools() {
  return allMcpTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: `[MCP:${t.server}] ${t.description}`,
      parameters: t.input_schema || { type: 'object', properties: {} }
    }
  }));
}

function isMcpTool(toolName) {
  return toolName && toolName.includes('__') && allMcpTools.some(t => t.name === toolName);
}

async function executeMcpTool(toolName, input) {
  const tool = allMcpTools.find(t => t.name === toolName);
  if (!tool) return { error: `MCP tool not found: ${toolName}` };
  const srv = servers[tool.server];
  if (!srv) return { error: `MCP server not running: ${tool.server}` };
  try {
    const result = await srv.callTool(tool.originalName, input);
    if (result.isError) {
      const text = (result.content || []).map(c => c.text || '').join('');
      return { error: text || 'MCP tool returned error' };
    }
    const text = (result.content || []).map(c => c.text || '').join('\n');
    return { result: text, raw: result };
  } catch (e) {
    return { error: `MCP ${tool.server}.${tool.originalName}: ${e.message}` };
  }
}

function listMcpServers() {
  return Object.entries(servers).map(([name, srv]) => ({
    name,
    initialized: srv.initialized,
    tools: srv.tools.length,
    command: srv.config.command
  }));
}

async function stopAllMcpServers() {
  for (const srv of Object.values(servers)) srv.stop();
}

module.exports = {
  initMcpServers,
  stopAllMcpServers,
  getMcpToolDefinitions,
  getMcpOpenAiTools,
  isMcpTool,
  executeMcpTool,
  listMcpServers,
  loadMcpConfig,
  saveMcpConfig
};
