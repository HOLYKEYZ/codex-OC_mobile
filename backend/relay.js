const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3001';

// ─── Detect CLI paths ──────────────────────────────────────────

const isWin = os.platform() === 'win32';
const CODEX_CMD = process.env.CODEX_PATH || (isWin ? 'codex' : 'codex');
const OPENCODE_CMD = process.env.OPENCODE_PATH || (isWin
  ? path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE + '\\AppData\\Local', 'OpenCode', 'opencode-cli.exe')
  : 'opencode');

function getOpenCodeCmd() {
  // Try the full path first, fall back to bare command
  if (isWin) {
    const fullPath = path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'),
      'OpenCode', 'opencode-cli.exe'
    );
    try { require('fs').accessSync(fullPath); return fullPath; } catch (e) {}
  }
  return 'opencode';
}

// ─── WebSocket connection ──────────────────────────────────────

let ws;
let reconnectTimer;

function connect() {
  if (ws) { ws.close(); ws = null; }

  console.log(`\n🔌 Connecting to ${SERVER_URL}...\n`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('✅ Connected to Agent Hub server');
    ws.send(JSON.stringify({ type: 'config', config: { role: 'relay' } }));
    printQR();
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'execute') {
      const { agent, prompt, clientId } = msg;
      console.log(`\n📩 Execute: ${agent} ← "${prompt.slice(0, 60)}..."`);
      await executeAgent(agent, prompt, clientId);
    } else if (msg.type === 'system') {
      console.log(`ℹ️  Server: ${msg.content}`);
    }
  });

  ws.on('close', () => {
    console.log('❌ Disconnected. Reconnecting in 5s...');
    ws = null;
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`⚠️  WebSocket error: ${err.message}`);
    ws = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ─── QR Code ───────────────────────────────────────────────────

function printQR() {
  const url = SERVER_URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  QRCode.toString(url, { type: 'terminal', small: true }, (err, qr) => {
    if (err) return;
    console.log('\n📱 Scan to connect your phone:');
    console.log(qr);
    console.log(`   ${url}\n`);
  });
}

// ─── Agent execution ───────────────────────────────────────────

function executeAgent(agent, prompt, clientId) {
  return new Promise((resolve) => {
    let cmd, args;

    switch (agent.toLowerCase()) {
      case 'codex':
        cmd = CODEX_CMD;
        args = ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt];
        break;
      case 'opencode':
        cmd = getOpenCodeCmd();
        args = ['run', '--dangerously-skip-permissions', '--format', 'json', prompt];
        break;
      default:
        send({ type: 'error', clientId, content: `Unknown agent: ${agent}` });
        resolve();
        return;
    }

    console.log(`  $ ${cmd} ${args.join(' ')}`);
    send({ type: 'status', clientId, content: `🔄 Running ${agent} locally...` });

    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let doneSent = false;
    let fullOutput = '';
    let jsonBuffer = '';

    function handleData(data) {
      const text = data.toString();
      fullOutput += text;

      if (agent.toLowerCase() === 'opencode') {
        // OpenCode JSON mode: each line is a JSON event
        jsonBuffer += text;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'content' && event.content) {
              send({ type: 'replace_stream', clientId, content: event.content });
            }
          } catch (e) {
            // Not JSON — stream as raw text
            send({ type: 'stream', clientId, content: line + '\n' });
          }
        }
      } else {
        // Codex: output is plain text
        send({ type: 'stream', clientId, content: text });
      }
    }

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('error', (err) => {
      if (!doneSent) {
        doneSent = true;
        send({ type: 'error', clientId, content: `Failed to start ${agent}: ${err.message}` });
        resolve();
      }
    });

    child.on('close', (code) => {
      if (!doneSent) {
        doneSent = true;
        if (code === 0) {
          send({ type: 'done', clientId, content: `\n✅ ${agent} completed (exit ${code}).` });
        } else {
          send({ type: 'done', clientId, content: `\n⚠️ ${agent} exited with code ${code}.` });
        }
      }
      resolve();
    });

    // Timeout safety
    setTimeout(() => {
      if (!doneSent) {
        doneSent = true;
        child.kill();
        send({ type: 'done', clientId, content: `\n⏱️ ${agent} timed out.` });
        resolve();
      }
    }, 10 * 60 * 1000); // 10 min timeout
  });
}

// ─── Start ─────────────────────────────────────────────────────

console.log('═══════════════════════════════════════');
console.log('  Agent Hub — Desktop Relay');
console.log('═══════════════════════════════════════');
console.log(`  Codex:    ${CODEX_CMD}`);
console.log(`  OpenCode: ${getOpenCodeCmd()}`);
console.log(`  Server:   ${SERVER_URL}`);
console.log('═══════════════════════════════════════\n');

connect();

process.on('SIGINT', () => {
  clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
});
