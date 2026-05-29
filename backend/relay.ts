// @ts-nocheck
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
let pty = null;
try { pty = require('node-pty'); } catch {}

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3001';
const RELAY_DIR = fs.existsSync(path.join(__dirname, 'package.json')) ? __dirname : path.join(__dirname, '..');
const WORKSPACE_CWD = path.resolve(process.env.AGENTHUB_CWD || process.env.WORKSPACE_CWD || path.join(RELAY_DIR, '..'));
const isWin = os.platform() === 'win32';
const RELAY_STATE_FILE = path.join(RELAY_DIR, 'relay-state.json');

const AGENTS = [
  { id: 'codex',    name: 'Codex',    modelKey: 'CODEX_MODEL',    cmd: process.env.CODEX_PATH || 'codex', args: p => ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', p], localPromptCli: true, jsonExec: true },
  { id: 'opencode', name: 'OpenCode', modelKey: 'OPENCODE_MODEL', cmd: null, args: p => ['run', '--dangerously-skip-permissions', '--format', 'json', p], localPromptCli: true, serverBacked: true },
];

const PTY_AGENT_ARGS = {
  codex: (prompt, sessionId) => sessionId
    ? ['resume', sessionId, prompt, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']
    : ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', prompt],
};

function quoteCmdArg(value) {
  const raw = String(value);
  const escaped = raw.replace(/([&|^<>()!])/g, '^$1').replace(/"/g, '""');
  return /[\s"]/u.test(raw) ? `"${escaped}"` : escaped;
}

function spawnAgentCommand(cmd, args) {
  if (!isWin) {
    return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  }

  // Windows CLI tools installed through npm/cargo are often .cmd/.ps1 shims.
  // Running through cmd.exe avoids EPERM from child_process.spawn on those shims.
  const commandLine = [quoteCmdArg(cmd), ...args.map(quoteCmdArg)].join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    windowsHide: true,
  });
}

function spawnCodexCommand(args) {
  const nodeLaunch = resolveCodexNodeLaunch(args);
  if (nodeLaunch) {
    return spawn(nodeLaunch.command, nodeLaunch.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
  }
  return spawnAgentCommand(process.env.CODEX_PATH || 'codex', args);
}

function openExternalUrl(url) {
  try {
    if (isWin) {
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '""', url], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      }).unref();
      return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

function openCodexDesktopThread(sessionId, clientId) {
  if (!sessionId || process.env.AGENTHUB_OPEN_CODEX_DESKTOP === '0') return;
  openExternalUrl(`codex://local/${encodeURIComponent(sessionId)}`);
  if (clientId) send({ type: 'status', clientId, content: 'Opening Codex Desktop chat' });
}

function scheduleCodexDesktopRefresh(sessionId, clientId, delayMs = 0) {
  if (!sessionId || process.env.AGENTHUB_OPEN_CODEX_DESKTOP === '0') return;
  setTimeout(() => openCodexDesktopThread(sessionId, clientId), delayMs).unref?.();
}

function buildWindowsCommandLine(cmd, args) {
  return [quoteCmdArg(cmd), ...args.map(quoteCmdArg)].join(' ');
}

function buildPtyCommand(cmd, args) {
  if (!isWin) return { command: cmd, args };
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', buildWindowsCommandLine(cmd, args)],
  };
}

function resolveCodexNodeLaunch(args) {
  if (!isWin) return null;
  const codexJs = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!fs.existsSync(codexJs)) return null;
  return { command: process.execPath, args: [codexJs, ...args] };
}

function buildPtyAgentLaunch(agent, cmd, args) {
  if (agent === 'codex') {
    const nodeLaunch = resolveCodexNodeLaunch(args);
    if (nodeLaunch) return nodeLaunch;
  }
  return buildPtyCommand(cmd, args);
}

function getCmd(a) {
  if (a.cmd) return a.cmd;
  if (a.id === 'opencode') {
    if (isWin) {
      const fp = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'OpenCode', 'opencode-cli.exe');
      try { fs.accessSync(fp); return fp; } catch {}
    }
    return 'opencode';
  }
  return a.id;
}

function commandExists(command) {
  if (!command) return false;
  if (path.isAbsolute(command)) {
    try { fs.accessSync(command); return true; } catch { return false; }
  }
  const pathExt = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const names = isWin && !path.extname(command) ? pathExt.map(ext => command + ext.toLowerCase()).concat(pathExt.map(ext => command + ext)) : [command];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      try { fs.accessSync(path.join(dir, name)); return true; } catch {}
    }
  }
  return false;
}

function readCodexConfig() {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    const cfg = {};
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const model = raw.match(/model\s*=\s*"([^"]+)"/)?.[1];
      if (model) cfg.CODEX_MODEL = model;
    }
    return cfg;
  } catch { return {}; }
}

function readOpenCodeConfig() {
  try {
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    return {};
  } catch { return {}; }
}

function readLocalConfig() {
  const cfg = { ...readCodexConfig(), ...readOpenCodeConfig() };
  cfg.LOCAL_AGENTS = getAvailableAgents().map(a => a.id);
  return cfg;
}

function readPersistedRelayCode() {
  try {
    if (!fs.existsSync(RELAY_STATE_FILE)) return '';
    const state = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, 'utf-8'));
    return typeof state.code === 'string' ? state.code : '';
  } catch {
    return '';
  }
}

function writePersistedRelayCode(code) {
  try {
    fs.writeFileSync(RELAY_STATE_FILE, JSON.stringify({ code, serverUrl: SERVER_URL, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

// â”€â”€â”€ Detect available agents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getAvailableAgents() {
  return AGENTS.filter((a) => {
    if (!a.localPromptCli) return false;
    const cmd = getCmd(a);
    if (!commandExists(cmd)) return false;
    if (a.id === 'codex') return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
    if (a.id === 'opencode') {
      const dataDir = path.join(os.homedir(), '.local', 'share', 'opencode');
      return fs.existsSync(path.join(dataDir, 'auth.json')) || fs.existsSync(path.join(dataDir, 'opencode.db'));
    }
    return false;
  });
}

// â”€â”€â”€ WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let ws, reconnectTimer, heartbeatTimer, sessionCode;

function connect() {
  if (ws) { ws.close(); ws = null; }
  const socket = new WebSocket(SERVER_URL);
  ws = socket;
  let scheduledReconnect = false;

  function scheduleReconnect() {
    if (scheduledReconnect) return;
    scheduledReconnect = true;
    clearInterval(heartbeatTimer);
    if (ws === socket) ws = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  }

  socket.on('open', () => {
    if (ws !== socket) return;
    const config = readLocalConfig();
    const preferredCode = process.env.AGENTHUB_RELAY_CODE || readPersistedRelayCode();
    socket.send(JSON.stringify({ type: 'register_relay', config, preferredCode }));
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: 'ping' }), 25000);
  });

  socket.on('message', async (raw) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'relay_registered') {
      sessionCode = msg.code;
      writePersistedRelayCode(sessionCode);
      console.log(`\nðŸ”— Relay session: ${sessionCode}${msg.reused ? ' (reused)' : ''}\n`);
      printAgentQRCodes(sessionCode);
      return;
    }

    if (msg.type === 'execute') {
      const { agent, prompt, clientId, sessionId, attachments } = msg;
      console.log(`\nðŸ“© ${agent}: "${prompt.slice(0, 80)}..."`);
      executeAgent(agent, prompt, clientId, sessionId, attachments || []).catch((err) => {
        send({ type: 'error', clientId, content: `${agent} failed: ${err.message}` });
      });
    } else if (msg.type === 'session_list') {
      const sessions = await listLocalSessions(msg.agent);
      console.log(`  [sessions] ${sessions.length} ${msg.agent || 'all'} -> ${msg.clientId || 'unknown'}`);
      send({ type: 'sessions', clientId: msg.clientId, sessions });
    } else if (msg.type === 'session_detail') {
      try {
        const active = msg.sessionId ? activeCodexByThread.get(msg.sessionId) : null;
        if (active && msg.clientId) active.clients.add(msg.clientId);
        if (msg.agent !== 'opencode' && msg.sessionId) openCodexDesktopThread(msg.sessionId, msg.clientId);
        const detail = msg.agent === 'opencode'
          ? await getOpenCodeSessionDetail(msg.sessionId)
          : await getCodexSessionDetail(msg.sessionId);
        send({ type: 'session_detail', clientId: msg.clientId, detail });
      } catch (err) {
        send({ type: 'error', clientId: msg.clientId, content: err.message });
      }
    } else if (msg.type === 'pong') {
      return;
    } else if (msg.type === 'system' || msg.type === 'phone_connected') {
      console.log(`â„¹ï¸  ${msg.content || msg.type}`);
    }
  });

  socket.on('close', () => {
    console.log('âŒ Disconnected. Reconnecting in 5s...');
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    console.error(`âš ï¸  ${err.message}`);
    scheduleReconnect();
  });
}

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || `http://127.0.0.1:${OPENCODE_PORT}`;
let opencodeServerProcess = null;

const CODEX_APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:4545';
let codexAppProcess = null;
let codexAppWs = null;
let codexAppReady = null;
let codexAppNextId = 1;
const codexAppPending = new Map();
const activeCodexByThread = new Map();

function isWsOpen(socket) {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === 1;
}

function rejectCodexPending(reason) {
  for (const pending of codexAppPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(reason);
  }
  codexAppPending.clear();
}

function attachCodexAppSocket(socket) {
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.id !== undefined && codexAppPending.has(msg.id)) {
      const pending = codexAppPending.get(msg.id);
      codexAppPending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method) handleCodexAppNotification(msg.method, msg.params || {});
  });

  socket.on('close', () => {
    codexAppWs = null;
    codexAppReady = null;
    rejectCodexPending(new Error('Codex app-server disconnected.'));
  });

  socket.on('error', (err) => {
    rejectCodexPending(err);
  });
}

function openCodexAppSocket(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(CODEX_APP_SERVER_URL);
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error(`Codex app-server did not answer on ${CODEX_APP_SERVER_URL}`));
    }, timeoutMs);
    socket.once('open', () => {
      clearTimeout(timer);
      attachCodexAppSocket(socket);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function spawnCodexAppServer() {
  if (codexAppProcess && !codexAppProcess.killed) return;
  const args = ['app-server', '--listen', CODEX_APP_SERVER_URL];
  const launch = resolveCodexNodeLaunch(args);
  if (launch) {
    codexAppProcess = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: WORKSPACE_CWD,
      env: { ...process.env },
      windowsHide: true,
    });
  } else {
    codexAppProcess = spawnAgentCommand(process.env.CODEX_PATH || 'codex', args);
  }
}

async function ensureCodexAppServer() {
  if (isWsOpen(codexAppWs)) return;
  if (codexAppReady) return codexAppReady;

  codexAppReady = (async () => {
    try {
      codexAppWs = await openCodexAppSocket(2500);
    } catch {
      spawnCodexAppServer();
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        try {
          codexAppWs = await openCodexAppSocket(1500);
          break;
        } catch {}
      }
      if (!isWsOpen(codexAppWs)) {
        throw new Error(`Could not start Codex app-server on ${CODEX_APP_SERVER_URL}.`);
      }
    }

    await callCodexApp('initialize', {
      clientInfo: { name: 'agent-hub-relay', title: 'Agent Hub Relay', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
    }, 15000);
  })();

  try {
    await codexAppReady;
  } catch (err) {
    codexAppReady = null;
    codexAppWs = null;
    throw err;
  }
}

async function callCodexApp(method, params = {}, timeoutMs = 30000) {
  if (!isWsOpen(codexAppWs)) {
    if (method === 'initialize') throw new Error('Codex app-server socket is not open.');
    await ensureCodexAppServer();
  }
  const id = codexAppNextId++;
  const message = { id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      codexAppPending.delete(id);
      reject(new Error(`Codex app-server ${method} timed out.`));
    }, timeoutMs);
    codexAppPending.set(id, { resolve, reject, timer });
    codexAppWs.send(JSON.stringify(message), (err) => {
      if (!err) return;
      codexAppPending.delete(id);
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function requestJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function isOpenCodeServerRunning() {
  try {
    const health = await requestJson(`${OPENCODE_BASE_URL}/global/health`);
    return !!health;
  } catch {
    return false;
  }
}

async function ensureOpenCodeServer() {
  if (await isOpenCodeServerRunning()) return;
  const opencode = AGENTS.find((a) => a.id === 'opencode');
  const cmd = opencode ? getCmd(opencode) : null;
  if (!cmd || !commandExists(cmd)) throw new Error('OpenCode CLI not found.');

  opencodeServerProcess = spawn(cmd, ['serve', '--hostname', '127.0.0.1', '--port', String(OPENCODE_PORT), '--log-level', 'ERROR'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: WORKSPACE_CWD,
    env: { ...process.env },
    windowsHide: true,
  });

  for (let i = 0; i < 30; i++) {
    if (await isOpenCodeServerRunning()) return;
    await sleep(500);
  }
  throw new Error(`OpenCode server did not start on ${OPENCODE_BASE_URL}.`);
}

function responseItems(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.value)) return json.value;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.items)) return json.items;
  return [];
}

function toOpenCodeSession(item) {
  return {
    agent: 'opencode',
    id: item.id,
    title: item.title || item.slug || item.id,
    subtitle: item.directory || item.path || 'OpenCode',
    directory: item.directory || '',
    updatedAt: item.time?.updated || item.time_updated || 0,
    createdAt: item.time?.created || item.time_created || 0,
    status: '',
    summary: item.summary || null,
  };
}

function stripTerminalNoise(value) {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu, '')
    .replace(/\r/g, '')
    .trim();
}

function truncateText(value, max = 140) {
  const text = stripTerminalNoise(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

const DETAIL_MESSAGE_LIMIT = 80;
const DETAIL_MESSAGE_CHARS = 6000;

function capMessageText(value, max = DETAIL_MESSAGE_CHARS) {
  const text = stripTerminalNoise(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[message truncated for phone]`;
}

function capDetailMessages(messages, limit = DETAIL_MESSAGE_LIMIT) {
  return (messages || []).slice(-limit).map((message) => ({
    ...message,
    text: capMessageText(message.text || ''),
  }));
}

function readJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function codexSessionsRoot() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function collectJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function readCodexIndexTitles() {
  const titles = new Map();
  const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return titles;
  for (const line of fs.readFileSync(indexPath, 'utf-8').split(/\r?\n/).filter(Boolean)) {
    const item = readJsonLine(line);
    if (item?.id) titles.set(item.id, item.thread_name || item.title || item.id);
  }
  return titles;
}

function extractTextParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    return part.text || part.message || part.output || '';
  }).filter(Boolean).join('\n');
}

function parseCodexRollout(file, includeEvents = false) {
  const stat = fs.statSync(file);
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
  const messages = [];
  const commands = [];
  const tools = [];
  const files = new Set();
  let meta = {};
  let firstUserText = '';

  for (const line of lines) {
    const ev = readJsonLine(line);
    if (!ev) continue;
    const payload = ev.payload || {};
    const time = ev.timestamp || payload.timestamp || null;

    if (ev.type === 'session_meta') {
      meta = { ...meta, ...payload };
      continue;
    }

    if (ev.type === 'response_item') {
      if (payload.type === 'message') {
        const role = payload.role || 'message';
        if (!['user', 'assistant'].includes(role)) continue;
        const text = stripTerminalNoise(extractTextParts(payload.content));
        if (text && !isHiddenCodexText(text)) {
          if (role === 'user' && !firstUserText) firstUserText = text;
          messages.push({ role, text, time, type: 'message' });
        }
      } else if (includeEvents && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
        const name = payload.name || payload.tool || payload.type || 'tool';
        const args = stripTerminalNoise(payload.arguments || payload.input || '');
        if (name === 'shell_command' && args) {
          const command = extractCommandFromArgs(args);
          commands.push({ name, command: command || truncateText(args, 500), time });
        } else {
          tools.push({ name, arguments: truncateText(args, 700), time });
        }
        for (const candidate of extractPathsFromText(args)) files.add(candidate);
      } else if (includeEvents && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
        const text = stripTerminalNoise(payload.output || payload.stdout || '');
        if (text) tools.push({ name: payload.type || 'tool_output', arguments: truncateText(text, 900), time });
        for (const candidate of extractPathsFromText(text)) files.add(candidate);
      } else if (includeEvents && /web_search|tool_search|browser|mcp/i.test(payload.type || '')) {
        tools.push({ name: payload.type || 'tool', arguments: summarizeToolPayload(payload, 900), time });
      } else if (includeEvents && payload.type === 'reasoning') {
        const summary = Array.isArray(payload.summary) ? payload.summary.map((s) => s?.text || s).filter(Boolean).join('\n') : '';
        tools.push({ name: 'thinking', arguments: summary ? truncateText(summary, 700) : 'Reasoning step recorded', time });
      }
      continue;
    }

    if (ev.type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = stripTerminalNoise(payload.message || '');
        if (text && !firstUserText) firstUserText = text;
      } else if (payload.type === 'agent_message') {
        const text = stripTerminalNoise(payload.message || '');
        if (text && !isHiddenCodexText(text)) messages.push({ role: 'assistant', text, time, type: 'message' });
      } else if (includeEvents && /tool|exec|browser|file|patch|command|web_search|mcp/i.test(payload.type || '')) {
        tools.push({ name: payload.type || 'event', arguments: summarizeToolPayload(payload, 1000), time });
        if (payload.changes) {
          for (const changed of Object.keys(payload.changes)) files.add(changed);
        }
      }
    }
  }

  return {
    id: meta.id || path.basename(file, '.jsonl'),
    file,
    meta,
    firstUserText,
    messages: dedupeAdjacentMessages(messages),
    commands,
    tools,
    files: [...files],
    updatedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.ctimeMs,
  };
}

function isHiddenCodexText(text) {
  return /^Workspace:\s+/i.test(text)
    || /^<environment_context>/i.test(text)
    || text.includes('You are Codex, a coding agent')
    || text.includes('# Instructions');
}

function dedupeAdjacentMessages(messages) {
  const out = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && prev.text === msg.text) continue;
    out.push(msg);
  }
  return out;
}

function extractCommandFromArgs(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj.command || '';
  } catch {
    return '';
  }
}

function summarizeToolPayload(payload, max = 900) {
  const compact = {};
  for (const key of ['name', 'tool', 'status', 'call_id', 'query', 'action', 'arguments', 'input', 'output', 'stdout', 'stderr', 'success', 'duration']) {
    if (payload?.[key] !== undefined) compact[key] = payload[key];
  }
  return truncateText(Object.keys(compact).length ? JSON.stringify(compact) : JSON.stringify(payload || {}), max);
}

function extractPathsFromText(raw) {
  const text = String(raw || '');
  const matches = text.match(/[A-Z]:\\[^\s"',)]+|(?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g) || [];
  return matches.map((m) => m.replace(/\\+/g, '\\')).filter((m) => /\.[A-Za-z0-9]{1,8}$/.test(m)).slice(0, 50);
}

function codexThreadTitle(thread) {
  return thread?.name || truncateText(thread?.preview || '', 72) || thread?.id || 'Codex chat';
}

function codexThreadProject(thread) {
  const cwd = String(thread?.cwd || '');
  return cwd ? path.basename(cwd) : 'Codex';
}

function toCodexAppSession(thread, loadedIds = new Set()) {
  const cwd = String(thread?.cwd || '');
  const project = codexThreadProject(thread);
  const status = thread?.status?.type || '';
  const loaded = loadedIds.has(thread.id);
  const latestTurnTime = Math.max(
    0,
    ...(thread.turns || []).flatMap((turn) => [Number(turn.startedAt || 0), Number(turn.completedAt || 0)]),
  ) * 1000;
  const updatedAt = Math.max(Number(thread.updatedAt || 0) * 1000, latestTurnTime);
  return {
    agent: 'codex',
    id: thread.id,
    title: codexThreadTitle(thread),
    subtitle: cwd ? `${project} - ${cwd}${loaded || status === 'active' ? ' - loaded' : ''}` : 'Codex',
    directory: cwd,
    project,
    path: thread.path || '',
    updatedAt,
    createdAt: Number(thread.createdAt || 0) * 1000,
    originator: thread.source || '',
    status,
    loaded,
  };
}

function userInputText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part) return '';
    if (part.type === 'text') return part.text || '';
    if (part.type === 'localImage') return `[image: ${part.path || 'local image'}]`;
    if (part.type === 'image') return `[image: ${part.url || 'image'}]`;
    if (part.type === 'mention') return `@${part.name || part.path || 'mention'}`;
    if (part.type === 'skill') return `$${part.name || part.path || 'skill'}`;
    return `[${part.type || 'input'}]`;
  }).filter(Boolean).join('\n');
}

function pathsFromFileChanges(changes = []) {
  return (Array.isArray(changes) ? changes : [])
    .map((change) => change?.path)
    .filter(Boolean);
}

function describeThreadItem(item) {
  if (!item) return null;
  if (item.type === 'commandExecution') {
    const suffix = item.status ? ` (${typeof item.status === 'string' ? item.status : item.status.type || 'running'})` : '';
    return { kind: 'command', text: `command: ${item.command}${suffix}` };
  }
  if (item.type === 'fileChange') {
    const files = pathsFromFileChanges(item.changes);
    return { kind: 'file', text: files.length ? `file: ${files.join('\nfile: ')}` : 'file: patch updated' };
  }
  if (item.type === 'mcpToolCall') {
    return { kind: 'tool', text: `tool: ${item.server}.${item.tool}` };
  }
  if (item.type === 'dynamicToolCall') {
    return { kind: 'tool', text: `tool: ${[item.namespace, item.tool].filter(Boolean).join('.') || 'tool'}` };
  }
  if (item.type === 'collabAgentToolCall') {
    const receivers = Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length
      ? ` -> ${item.receiverThreadIds.join(', ')}`
      : '';
    return { kind: 'tool', text: `agent: ${item.tool}${receivers}` };
  }
  if (item.type === 'webSearch') {
    return { kind: 'tool', text: `browser/search: ${item.query || 'web search'}` };
  }
  if (item.type === 'imageView') {
    return { kind: 'tool', text: `image: ${item.path}` };
  }
  if (item.type === 'imageGeneration') {
    return { kind: 'tool', text: `image generation: ${item.status || ''}${item.savedPath ? ` ${item.savedPath}` : ''}`.trim() };
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.join('\n') : '';
    return { kind: 'tool', text: summary ? `thinking: ${truncateText(summary, 1000)}` : 'thinking...' };
  }
  return null;
}

function turnSortValue(turn) {
  return Math.max(
    Number(turn?.startedAt || 0),
    Number(turn?.completedAt || 0),
    Number(turn?.updatedAt || 0),
  );
}

function parseCodexAppThreadDetail(thread) {
  const messages = [];
  const commands = [];
  const tools = [];
  const files = new Set();
  const turns = [...(thread?.turns || [])].sort((a, b) => turnSortValue(a) - turnSortValue(b));
  const latestTurn = turns[turns.length - 1] || null;

  for (const turn of turns) {
    const includeTurnEvents = latestTurn && turn?.id === latestTurn.id;
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = stripTerminalNoise(userInputText(item.content));
        if (text) messages.push({ id: item.id, role: 'user', text, type: 'message' });
      } else if (item.type === 'agentMessage') {
        const text = stripTerminalNoise(item.text || '');
        if (text && !isHiddenCodexText(text)) messages.push({ id: item.id, role: 'assistant', text, type: 'message', phase: item.phase || '' });
      } else if (includeTurnEvents && item.type === 'commandExecution') {
        commands.push({
          id: item.id,
          name: 'shell',
          command: item.command || '',
          cwd: item.cwd || '',
          output: truncateText(item.aggregatedOutput || '', 1200),
          exitCode: item.exitCode,
          durationMs: item.durationMs,
        });
      } else if (includeTurnEvents && item.type === 'fileChange') {
        for (const file of pathsFromFileChanges(item.changes)) files.add(file);
      } else if (includeTurnEvents) {
        const described = describeThreadItem(item);
        if (described) tools.push({ id: item.id, name: item.type, arguments: described.text });
      }
    }
  }

  return {
    agent: 'codex',
    sessionId: thread.id,
    title: codexThreadTitle(thread),
    directory: thread.cwd || '',
    project: codexThreadProject(thread),
    path: thread.path || '',
    updatedAt: Number(thread.updatedAt || 0) * 1000,
    messages: capDetailMessages(messages),
    files: [...files],
    commands: commands.slice(-80),
    tools: tools.slice(-80),
    metadataScope: latestTurn?.id ? 'latest_turn' : 'none',
    metadataTurnId: latestTurn?.id || '',
    status: thread.status?.type || '',
  };
}

async function listCodexAppTurns(threadId, limit = 60) {
  const result = await callCodexApp('thread/turns/list', {
    threadId,
    limit,
    cursor: null,
  }, 60000);
  return Array.isArray(result?.data) ? result.data : [];
}

async function readCodexAppThreadWithTurns(threadId, turnLimit = 60) {
  const result = await callCodexApp('thread/read', { threadId }, 60000);
  const thread = result?.thread || {};
  try {
    thread.turns = await listCodexAppTurns(threadId, turnLimit);
  } catch (err) {
    thread.turns = Array.isArray(thread.turns) ? thread.turns : [];
  }
  return thread;
}

function sendToCodexTracker(tracker, payload) {
  if (!tracker) return;
  for (const clientId of tracker.clients) {
    send({ ...payload, clientId });
  }
}

function trackerForNotification(params) {
  const tracker = activeCodexByThread.get(params.threadId);
  if (!tracker) return null;
  if (tracker.turnId && params.turnId && tracker.turnId !== params.turnId) return null;
  return tracker;
}

function handleCodexAppNotification(method, params) {
  const tracker = trackerForNotification(params);
  if (!tracker) return;

  if (method === 'turn/started') {
    tracker.turnId = params.turn?.id || tracker.turnId || params.turnId;
    sendToCodexTracker(tracker, { type: 'status', content: 'Codex turn started' });
    scheduleCodexDesktopRefresh(tracker.threadId, null, 250);
    return;
  }

  if (method === 'item/agentMessage/delta') {
    if (tracker.agentItemId !== params.itemId) {
      tracker.agentItemId = params.itemId;
      tracker.agentText = '';
    }
    tracker.agentText = (tracker.agentText || '') + (params.delta || '');
    sendToCodexTracker(tracker, { type: 'replace_stream', content: tracker.agentText });
    return;
  }

  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    tracker.reasoningText = (tracker.reasoningText || '') + (params.delta || '');
    sendToCodexTracker(tracker, { type: 'status', content: `thinking: ${truncateText(tracker.reasoningText, 1000)}` });
    return;
  }

  if (method === 'item/commandExecution/outputDelta') {
    const text = stripTerminalNoise(params.delta || '');
    if (text) sendToCodexTracker(tracker, { type: 'status', content: `command output: ${truncateText(text, 1200)}` });
    return;
  }

  if (method === 'item/mcpToolCall/progress') {
    sendToCodexTracker(tracker, { type: 'status', content: `tool: ${params.message || 'MCP tool running'}` });
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    const described = describeThreadItem(params.item);
    if (described) sendToCodexTracker(tracker, { type: 'status', content: described.text });
    return;
  }

  if (method === 'item/fileChange/patchUpdated') {
    const files = pathsFromFileChanges(params.changes);
    sendToCodexTracker(tracker, { type: 'status', content: files.length ? `file: ${files.join('\nfile: ')}` : 'file: patch updated' });
    return;
  }

  if (method === 'turn/diff/updated') {
    const files = extractPathsFromText(params.diff || '');
    sendToCodexTracker(tracker, { type: 'status', content: files.length ? `file diff: ${files.slice(0, 20).join('\nfile diff: ')}` : 'file diff updated' });
    return;
  }

  if (method === 'rawResponseItem/completed') {
    const item = params.item || {};
    if (/web_search|tool_search|browser|mcp|function_call|custom_tool_call|local_shell/i.test(item.type || '')) {
      sendToCodexTracker(tracker, { type: 'status', content: `${item.type}: ${summarizeToolPayload(item, 1000)}` });
    }
    return;
  }

  if (method === 'turn/completed') {
    const status = params.turn?.status;
    const failed = status && typeof status === 'object' && status.type === 'failed';
    if (failed) {
      const message = params.turn?.error?.message || 'Codex turn failed.';
      sendToCodexTracker(tracker, { type: 'error', content: message });
      tracker.reject?.(new Error(message));
    } else {
      sendToCodexTracker(tracker, { type: 'done', content: '' });
      tracker.resolve?.();
    }
    scheduleCodexDesktopRefresh(tracker.threadId, null, 500);
    activeCodexByThread.delete(params.threadId);
  }
}

async function listCodexAppSessions() {
  await ensureCodexAppServer();
  const loadedResult = await callCodexApp('thread/loaded/list', { limit: 200 }, 15000).catch(() => ({ data: [] }));
  const loadedIds = new Set(Array.isArray(loadedResult?.data) ? loadedResult.data : []);
  const result = await callCodexApp('thread/list', {
    limit: 200,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
    sourceKinds: [],
  }, 30000);
  const threadsById = new Map((result?.data || []).filter((thread) => thread?.id).map((thread) => [thread.id, thread]));
  for (const id of loadedIds) {
    if (threadsById.has(id)) continue;
    try {
      threadsById.set(id, await readCodexAppThreadWithTurns(id, 10));
    } catch (err) {
      console.log(`  [codex-app] loaded thread read failed ${id}: ${err.message}`);
    }
  }
  return [...threadsById.values()]
    .map((thread) => toCodexAppSession(thread, loadedIds))
    .filter((s) => s.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getCodexAppSessionDetail(sessionId) {
  await ensureCodexAppServer();
  return parseCodexAppThreadDetail(await readCodexAppThreadWithTurns(sessionId, 80));
}

function getCodexRollouts(limit = 200) {
  return collectJsonlFiles(codexSessionsRoot())
    .map((file) => {
      try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => item.file);
}

async function listOpenCodeSessions() {
  try {
    await ensureOpenCodeServer();
    const json = await requestJson(`${OPENCODE_BASE_URL}/session?limit=100`);
    return responseItems(json).map(toOpenCodeSession).filter((s) => s.id);
  } catch (err) {
    return [{ agent: 'opencode', id: '', title: `OpenCode unavailable: ${err.message}`, subtitle: '', updatedAt: 0, error: true }];
  }
}

function listCodexRolloutSessions() {
  const titles = readCodexIndexTitles();
  return getCodexRollouts(1000).map((file) => {
    try {
      const parsed = parseCodexRollout(file, false);
      const cwd = parsed.meta.cwd || '';
      const project = cwd ? path.basename(cwd) : 'Codex';
      const title = titles.get(parsed.id) || truncateText(parsed.firstUserText, 72) || parsed.id;
      return {
        agent: 'codex',
        id: parsed.id,
        title,
        subtitle: cwd ? `${project} - ${cwd}` : 'Codex',
        directory: cwd,
        project,
        path: file,
        updatedAt: parsed.updatedAt,
        createdAt: parsed.createdAt,
        originator: parsed.meta.originator || '',
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function listCodexSessions() {
  try {
    return await listCodexAppSessions();
  } catch (err) {
    console.log(`  [codex-app] session list fallback: ${err.message}`);
    return listCodexRolloutSessions();
  }
}

async function listLocalSessions(agent) {
  const codexSessions = agent && agent !== 'codex' ? [] : await listCodexSessions();
  const opencodeSessions = agent && agent !== 'opencode' ? [] : await listOpenCodeSessions();
  return [...codexSessions, ...opencodeSessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function formatOpenCodePart(part) {
  if (!part) return '';
  if (part.type === 'text') return part.text || '';
  if (part.type === 'reasoning' || part.type === 'step-start' || part.type === 'step-finish') return '';
  if (part.type === 'tool') {
    const status = part.state?.status || '';
    const title = part.state?.title || part.tool || 'tool';
    return `[tool:${title}${status ? ` ${status}` : ''}]`;
  }
  if (part.type === 'file') return `[file:${part.filename || part.url || 'attachment'}]`;
  return `[${part.type || 'part'}]`;
}

function formatOpenCodeMessage(message) {
  const info = message.info || message;
  const role = info.role || message.role || 'message';
  const parts = message.parts || message.content || [];
  const text = Array.isArray(parts) ? parts.map(formatOpenCodePart).filter(Boolean).join('\n') : '';
  return {
    id: info.id || message.id || '',
    role,
    text,
    time: info.time || message.time || null,
  };
}

async function getOpenCodeSessionDetail(sessionId) {
  await ensureOpenCodeServer();
  const [messagesJson, diffJson, todoJson] = await Promise.all([
    requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/message?limit=60`).catch((err) => ({ error: err.message })),
    requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/diff`).catch(() => []),
    requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/todo`).catch(() => []),
  ]);
  return {
    agent: 'opencode',
    sessionId,
    messages: capDetailMessages(responseItems(messagesJson).map(formatOpenCodeMessage), 60),
    diff: responseItems(diffJson),
    todo: responseItems(todoJson),
  };
}

function findCodexRollout(sessionId) {
  for (const file of getCodexRollouts(500)) {
    try {
      const parsed = parseCodexRollout(file, false);
      if (parsed.id === sessionId || path.basename(file, '.jsonl').includes(sessionId)) return file;
    } catch {}
  }
  return null;
}

async function getCodexSessionDetail(sessionId) {
  try {
    return await getCodexAppSessionDetail(sessionId);
  } catch (err) {
    console.log(`  [codex-app] detail fallback: ${err.message}`);
  }
  const file = findCodexRollout(sessionId);
  if (!file) throw new Error(`Codex session not found: ${sessionId}`);
  const parsed = parseCodexRollout(file, true);
  return {
    agent: 'codex',
    sessionId: parsed.id,
    title: truncateText(parsed.firstUserText, 90) || parsed.id,
    directory: parsed.meta.cwd || '',
    project: parsed.meta.cwd ? path.basename(parsed.meta.cwd) : '',
    path: file,
    updatedAt: parsed.updatedAt,
    messages: capDetailMessages(parsed.messages),
    files: parsed.files,
    commands: parsed.commands.slice(-50),
    tools: parsed.tools.slice(-50),
  };
}

async function createOpenCodeSession() {
  await ensureOpenCodeServer();
  const json = await requestJson(`${OPENCODE_BASE_URL}/session`, {
    method: 'POST',
    body: '{}',
  });
  return json?.value || json?.data || json;
}

function sanitizeAttachmentName(name, index) {
  const cleaned = String(name || `upload-${index}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  return cleaned || `upload-${index}`;
}

function saveAttachments(attachments = [], clientId = '') {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const dir = path.join(WORKSPACE_CWD, '.agenthub_uploads');
  fs.mkdirSync(dir, { recursive: true });
  return attachments.slice(0, 10).map((file, index) => {
    const name = sanitizeAttachmentName(file.name, index);
    const out = path.join(dir, `${Date.now()}-${index}-${name}`);
    const data = Buffer.from(String(file.base64 || ''), 'base64');
    fs.writeFileSync(out, data);
    send({ type: 'status', clientId, content: `file: saved upload ${out}` });
    return { path: out, name, mime: file.mime || '', size: data.length };
  });
}

function promptWithAttachments(prompt, attachments, clientId) {
  const saved = saveAttachments(attachments, clientId);
  if (!saved.length) return prompt;
  const note = saved.map((file) => `- ${file.path}${file.mime ? ` (${file.mime})` : ''}`).join('\n');
  return `${prompt}\n\nAttached files from phone saved on this laptop:\n${note}`;
}

async function sendOpenCodePrompt(prompt, clientId, sessionId, attachments = []) {
  await ensureOpenCodeServer();
  prompt = promptWithAttachments(prompt, attachments, clientId);
  let target = sessionId;
  if (!target) {
    const created = await createOpenCodeSession();
    target = created?.id;
  }
  if (!target) throw new Error('OpenCode session not found.');

  const before = await getOpenCodeSessionDetail(target).catch(() => null);
  const beforeCount = before?.messages?.length || 0;
  send({ type: 'status', clientId, content: `Sending to OpenCode session ${target}` });
  await requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(target)}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
  });
  send({ type: 'status', clientId, content: `OpenCode accepted prompt for ${target}` });

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const detail = await getOpenCodeSessionDetail(target).catch(() => null);
    if (detail?.messages?.length) {
      const fresh = detail.messages.slice(beforeCount);
      const latestAssistant = fresh.filter((m) => m.role === 'assistant' && m.text).slice(-1)[0];
      if (latestAssistant) send({ type: 'replace_stream', clientId, content: latestAssistant.text });
    }
    const statusJson = await requestJson(`${OPENCODE_BASE_URL}/session/status`).catch(() => null);
    const statuses = statusJson?.value || statusJson?.data || statusJson || {};
    const current = statuses[target];
    if (!current || current.status === 'idle' || current === 'idle') break;
  }
  const detail = await getOpenCodeSessionDetail(target).catch(() => null);
  if (detail) send({ type: 'session_detail', clientId, detail });
  send({ type: 'done', clientId, content: '' });
}

function codexExecArgs(prompt, sessionId) {
  if (sessionId) {
    return ['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox', sessionId, prompt];
  }
  return ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', prompt];
}

function formatCodexJsonEvent(ev) {
  const payload = ev?.payload || {};
  if (ev?.type === 'response_item') {
    if (payload.type === 'message') {
      const role = payload.role || 'assistant';
      const text = stripTerminalNoise(extractTextParts(payload.content));
      if (!text || isHiddenCodexText(text)) return null;
      return role === 'assistant' ? { kind: 'stream', text } : null;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const name = payload.name || payload.tool || payload.type || 'tool';
      const command = name === 'shell_command' ? extractCommandFromArgs(payload.arguments || payload.input || '') : '';
      return { kind: 'status', text: command ? `command: ${command}` : `tool: ${name}` };
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const text = stripTerminalNoise(payload.output || payload.stdout || '');
      return text ? { kind: 'status', text: truncateText(text, 900) } : null;
    }
    if (/web_search|tool_search|browser|mcp/i.test(payload.type || '')) {
      return { kind: 'status', text: `${payload.type}: ${summarizeToolPayload(payload, 700)}` };
    }
    if (payload.type === 'reasoning') return { kind: 'status', text: 'thinking...' };
  }
  if (ev?.type === 'event_msg') {
    if (payload.type === 'agent_message') {
      const text = stripTerminalNoise(payload.message || '');
      return text && !isHiddenCodexText(text) ? { kind: 'stream', text } : null;
    }
    if (payload.type === 'task_started') return { kind: 'status', text: 'Codex started' };
    if (payload.type === 'task_complete') return { kind: 'status', text: 'Codex finished' };
    if (/tool|exec|browser|file|patch|command|web_search|mcp/i.test(payload.type || '')) {
      return { kind: 'status', text: `${payload.type}: ${summarizeToolPayload(payload, 700)}` };
    }
  }
  return null;
}

async function sendCodexAppPrompt(prompt, clientId, sessionId) {
  await ensureCodexAppServer();
  const tracker = {
    clients: new Set([clientId]),
    threadId: sessionId,
    turnId: null,
    agentText: '',
    reasoningText: '',
  };
  const completion = new Promise((resolve, reject) => {
    tracker.resolve = resolve;
    tracker.reject = reject;
  });

  send({ type: 'status', clientId, content: `Opening Codex chat ${sessionId}` });
  console.log(`  [codex-app] resume ${sessionId}`);
  const resumed = await callCodexApp('thread/resume', { threadId: sessionId }, 60000);
  scheduleCodexDesktopRefresh(sessionId, clientId, 250);
  const thread = resumed?.thread || {};
  const turns = await listCodexAppTurns(sessionId, 12).catch(() => thread.turns || []);
  const activeTurn = [...(turns || [])].reverse().find((turn) => turn?.status === 'inProgress' || turn?.status?.type === 'inProgress');
  if (thread.status?.type === 'active' && activeTurn?.id) {
    tracker.turnId = activeTurn.id;
    activeCodexByThread.set(sessionId, tracker);
    send({ type: 'status', clientId, content: `Steering active Codex turn ${activeTurn.id}` });
    console.log(`  [codex-app] steer ${sessionId} turn=${activeTurn.id}`);
    await callCodexApp('turn/steer', {
      threadId: sessionId,
      expectedTurnId: activeTurn.id,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    }, 60000);
    await completion;
    const detail = await getCodexSessionDetail(sessionId).catch(() => null);
    if (detail) send({ type: 'session_detail', clientId, detail });
    openCodexDesktopThread(sessionId, clientId);
    send({ type: 'done', clientId, content: '' });
    return;
  }

  send({ type: 'status', clientId, content: 'Starting Codex turn through app-server' });
  console.log(`  [codex-app] turn/start ${sessionId}`);
  activeCodexByThread.set(sessionId, tracker);

  const started = await callCodexApp('turn/start', {
    threadId: sessionId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
  }, 60000);
  tracker.turnId = started?.turn?.id || tracker.turnId;

  await completion;

  const detail = await getCodexSessionDetail(sessionId).catch(() => null);
  if (detail) send({ type: 'session_detail', clientId, detail });
  openCodexDesktopThread(sessionId, clientId);
  send({ type: 'done', clientId, content: '' });
}

async function sendCodexPrompt(prompt, clientId, sessionId, attachments = []) {
  if (!sessionId) {
    throw new Error('Pick a Codex chat first. This build blocks accidental new Codex sessions from the phone.');
  }
  prompt = promptWithAttachments(prompt, attachments, clientId);
  openCodexDesktopThread(sessionId, clientId);

  try {
    await sendCodexAppPrompt(prompt, clientId, sessionId);
    return;
  } catch (err) {
    activeCodexByThread.delete(sessionId);
    if (process.env.AGENTHUB_CODEX_CLI_FALLBACK !== '1') {
      throw err;
    }
    send({ type: 'status', clientId, content: `Codex app-server failed, falling back to CLI resume: ${err.message}` });
  }

  const a = AGENTS.find((x) => x.id === 'codex');
  const cmd = getCmd(a);
  if (!commandExists(cmd)) throw new Error('Codex CLI not found on PATH.');
  const args = codexExecArgs(prompt, sessionId);
  console.log(`  [codex-json] resume ${sessionId}`);
  const before = await getCodexSessionDetail(sessionId).catch(() => null);
  const beforeCount = before?.messages?.length || 0;
  send({ type: 'status', clientId, content: `Sending to Codex chat ${sessionId}` });
  send({ type: 'status', clientId, content: 'Codex is running via resume; it will not type into the visible desktop composer.' });

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCodexCommand(args);
    } catch (err) {
      reject(err);
      return;
    }

    let buffer = '';
    let fullText = '';
    let done = false;
    let sawEvent = false;
    let firstEventTimer = null;

    function consume(data) {
      const text = data.toString();
      fullText += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = readJsonLine(line);
        if (!ev) continue;
        sawEvent = true;
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }
        const formatted = formatCodexJsonEvent(ev);
        if (!formatted) continue;
        if (formatted.kind === 'stream') send({ type: 'replace_stream', clientId, content: formatted.text });
        else send({ type: 'status', clientId, content: formatted.text });
      }
    }

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (code === 0) resolve();
      else reject(new Error(stripTerminalNoise(fullText).slice(-1200) || `Codex exited ${code}`));
    });

    firstEventTimer = setTimeout(() => {
      if (done || sawEvent) return;
      done = true;
      try { child.kill(); } catch {}
      reject(new Error('Codex did not emit any resume events in 45 seconds. This usually means that chat is currently active/locked in Codex Desktop; pick an inactive chat or start a dedicated phone chat.'));
    }, 45 * 1000);

    setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      reject(new Error('Codex timed out after 3 minutes.'));
    }, 3 * 60 * 1000);
  });

  const detail = await getCodexSessionDetail(sessionId).catch(() => null);
  if (detail) send({ type: 'session_detail', clientId, detail });
  if (detail && (detail.messages?.length || 0) <= beforeCount) {
    send({ type: 'status', clientId, content: 'Codex finished but no new assistant message appeared in the session log.' });
  }
  send({ type: 'done', clientId, content: '' });
}

function printAgentQRCodes(code) {
  const agents = getAvailableAgents();
  const qrFile = path.join(WORKSPACE_CWD, 'session_qr.txt');
  let fileContent = '';

  agents.forEach((a, i) => {
    const qrPayload = `${SERVER_URL}?code=${code}&agent=${a.id}`;
    if (i > 0) console.log('');
    QRCode.toString(qrPayload, { type: 'terminal', small: true }, (err, qr) => {
      if (err) return;
      console.log(`â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
      console.log(`  ${a.name}`);
      console.log(`â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
      console.log(qr);
      console.log(`   Code: ${code}`);
      console.log(`   Agent: ${a.name}`);
      console.log(`â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n`);
    });
    fileContent += `Agent: ${a.name} (${a.id})\nCode: ${code}\nURL: ${qrPayload}\n\n`;

    // Also print a compact one-liner
    console.log(`  [${a.id}] Code: ${code}  |  URL: ${qrPayload}\n`);
  });

  if (agents.length === 0) {
    console.log('âš ï¸  No agents detected.');
    console.log('   Install and sign in to Codex or OpenCode.\n');
  }

  try {
    if (fileContent) fs.writeFileSync(qrFile, fileContent);
  } catch {}
}

// â”€â”€â”€ Agent execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ptySessions = new Map();

function sessionKey(agent, sessionId = '') {
  return `${agent}:${WORKSPACE_CWD}:${sessionId || 'default'}`;
}

function startPtyAgent(agent, prompt, clientId, sessionId = '') {
  if (!pty) throw new Error('node-pty is not installed. Run npm install in backend/.');
  const a = AGENTS.find(x => x.id === agent);
  if (!a) throw new Error(`Unknown agent: ${agent}`);
  if (!a.localPromptCli) throw new Error(`${a.name} is installed as an editor launcher, not a promptable local agent CLI.`);
  if (a.serverBacked) throw new Error(`${a.name} uses its local HTTP server, not PTY.`);

  const cmd = getCmd(a);
  if (!commandExists(cmd)) throw new Error(`${a.name} CLI not found on PATH.`);
  const args = (PTY_AGENT_ARGS[agent] || ((p) => a.args(p)))(prompt, sessionId);
  const launch = buildPtyAgentLaunch(agent, cmd, args);
  const id = sessionKey(agent, sessionId);
  console.log(`  [pty] ${a.name} cwd=${WORKSPACE_CWD}`);
  console.log(`  [pty] $ ${launch.command} ${launch.args.join(' ')}`);

  const terminal = pty.spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: WORKSPACE_CWD,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      NO_COLOR: '0',
    },
  });

  const session = {
    id,
    agent,
    name: a.name,
    terminal,
    clients: new Set([clientId]),
    output: '',
    closed: false,
  };
  ptySessions.set(id, session);

  terminal.onData((data) => {
    session.output = (session.output + data).slice(-256 * 1024);
    process.stdout.write(data);
    for (const target of session.clients) {
      send({ type: 'stream', clientId: target, content: data });
    }
  });

  terminal.onExit(({ exitCode }) => {
    session.closed = true;
    ptySessions.delete(id);
    for (const target of session.clients) {
      send({ type: 'done', clientId: target, content: `\n[${a.name} exited ${exitCode}]\n` });
    }
  });

  return session;
}

function executePtyAgent(agent, prompt, clientId, sessionId = '') {
  const id = sessionKey(agent, sessionId);
  let session = ptySessions.get(id);
  if (!session || session.closed) {
    const target = sessionId ? ` session ${sessionId}` : '';
    send({ type: 'status', clientId, content: `Starting ${agent}${target} in ${WORKSPACE_CWD}` });
    startPtyAgent(agent, prompt, clientId, sessionId);
    return;
  }

  session.clients.add(clientId);
  send({ type: 'status', clientId, content: `Sending to existing ${agent} session in ${WORKSPACE_CWD}` });
  if (session.output) {
    send({ type: 'stream', clientId, content: session.output.slice(-12000) });
  }
  session.terminal.write(prompt);
  setTimeout(() => {
    try { session.terminal.write('\r'); } catch {}
  }, 250);
}

function executeAgent(agent, prompt, clientId, sessionId = '', attachments = []) {
  return new Promise(async (resolve) => {
    const a = AGENTS.find(x => x.id === agent);
    if (!a) { send({ type: 'error', clientId, content: `Unknown agent: ${agent}` }); resolve(); return; }
    if (!a.localPromptCli) { send({ type: 'error', clientId, content: `${a.name} is installed as an editor launcher, not a promptable local agent CLI.` }); resolve(); return; }
    if (a.serverBacked) {
      try {
        await sendOpenCodePrompt(prompt, clientId, sessionId, attachments);
      } catch (err) {
        send({ type: 'error', clientId, content: `OpenCode failed: ${err.message}` });
      }
      resolve();
      return;
    }

    if (agent === 'codex') {
      try {
        await sendCodexPrompt(prompt, clientId, sessionId, attachments);
      } catch (err) {
        send({ type: 'error', clientId, content: `Codex failed: ${err.message}` });
      }
      resolve();
      return;
    }

    if (process.env.AGENTHUB_ONE_SHOT !== '1') {
      try {
        executePtyAgent(agent, prompt, clientId, sessionId);
      } catch (err) {
        send({ type: 'error', clientId, content: `PTY failed: ${err.message}` });
      }
      resolve();
      return;
    }

    const cmd = getCmd(a);
    const args = a.args(prompt);
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    send({ type: 'status', clientId, content: `ðŸ”„ ${a.name}...` });

    let child;
    try {
      child = spawnAgentCommand(cmd, args);
    } catch (err) {
      send({ type: 'error', clientId, content: `Failed to start ${a.name}: ${err.message}` });
      resolve();
      return;
    }
    let doneSent = false, fullOutput = '', jsonBuffer = '';

    function handleData(data) {
      const text = data.toString();
      fullOutput += text;

      if (agent === 'opencode') {
        jsonBuffer += text;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'content' && ev.content) {
              send({ type: 'replace_stream', clientId, content: ev.content });
            }
          } catch {
            // Skip non-JSON lines (progress spinners, status, etc.)
          }
        }
      } else if (agent === 'codex') {
        // Codex output is mostly AI text. Forward cleanly, strip ANSI.
        send({ type: 'stream', clientId, content: text });
      } else {
        send({ type: 'stream', clientId, content: text });
      }
    }

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('error', (err) => { if (!doneSent) { doneSent = true; send({ type: 'error', clientId, content: `Failed: ${err.message}` }); resolve(); } });
    child.on('close', (code) => {
      if (!doneSent) { doneSent = true; send({ type: 'done', clientId, content: code === 0 ? '' : `\nâš ï¸ Exit ${code}` }); }
      resolve();
    });
    setTimeout(() => { if (!doneSent) { doneSent = true; child.kill(); send({ type: 'done', clientId, content: '\nâ±ï¸ Timeout' }); resolve(); } }, 10 * 60 * 1000);
  });
}

// â”€â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
console.log('  Agent Hub â€” Desktop Relay');
console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');

const agents = getAvailableAgents();
console.log(`  Agents:   ${agents.length ? agents.map(a => a.name).join(', ') : 'none'}`);
console.log(`  Server:   ${SERVER_URL}`);
console.log(`  Cwd:      ${WORKSPACE_CWD}`);
console.log(`  Mode:     Codex app-server + OpenCode session server${pty ? ' + PTY fallback' : ''}`);
console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');

connect();

process.on('SIGINT', () => {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  for (const session of ptySessions.values()) {
    try { session.terminal.kill(); } catch {}
  }
  try { opencodeServerProcess?.kill(); } catch {}
  if (ws) ws.close();
  process.exit(0);
});

