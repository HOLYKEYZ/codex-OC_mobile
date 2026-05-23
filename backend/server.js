const http = require('http');
const { WebSocketServer } = require('ws');
const { BedrockRuntimeClient, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');

const PORT = process.env.PORT || 3001;

// ─── Default models (env overridable) ──────────────────────────

const DEFAULTS = {
  codex:    process.env.CODEX_MODEL      || 'gpt-5.5',
  opencode: process.env.OPENCODE_MODEL   || 'gpt-5.5',
  windsurf: process.env.WINDSURF_MODEL   || 'gpt-4o',
  kiro:     process.env.KIRO_MODEL       || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  kiroRegion: process.env.KIRO_REGION    || 'us-east-1',
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: relayWs ? 'relay' : 'cloud' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Agent Hub Backend');
});

const wss = new WebSocketServer({ server });
const clientConfigs = new Map();
let relayWs = null;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function getCfg(clientId) {
  return clientConfigs.get(clientId) || {};
}

wss.on('connection', (ws) => {
  const clientId = Date.now().toString(36) + Math.random().toString(36).slice(2);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send(ws, { type: 'error', content: 'Invalid JSON' }); return; }

    if (msg.type === 'config') {
      const cfg = msg.config || {};
      if (cfg.role === 'relay') {
        relayWs = ws;
        console.log(`[${clientId}] Relay REGISTERED`);
        send(ws, { type: 'system', content: '✅ Registered as desktop relay' });
        return;
      }
      clientConfigs.set(clientId, cfg);
      console.log(`[${clientId}] Config saved`);
      send(ws, { type: 'system', content: '✅ Config saved' });
      return;
    }

    // Relay → phone forwarding
    if (msg.clientId && (msg.type === 'stream' || msg.type === 'replace_stream' || msg.type === 'done' || msg.type === 'error' || msg.type === 'status')) {
      const phone = clientConfigs.get(msg.clientId);
      if (phone && phone.ws) send(phone.ws, { type: msg.type, content: msg.content });
      return;
    }

    const { agent, prompt } = msg;
    if (!agent || !prompt) { send(ws, { type: 'error', content: 'Missing agent or prompt' }); return; }

    console.log(`[${clientId}] ${agent} ← "${prompt.slice(0, 80)}"`);

    // Relay mode
    if (relayWs && relayWs.readyState === 1) {
      console.log(`[${clientId}] → relay`);
      const cfg = getCfg(clientId);
      cfg.ws = ws;
      clientConfigs.set(clientId, cfg);
      send(relayWs, { type: 'execute', agent, prompt, clientId });
      return;
    }

    // Cloud mode
    console.log(`[${clientId}] → cloud`);
    try {
      const cfg = getCfg(clientId);
      switch (agent.toLowerCase()) {
        case 'codex':    await runCodexCloud(ws, cfg, prompt); break;
        case 'opencode': await runOpenCodeCloud(ws, cfg, prompt); break;
        case 'windsurf': await runWindsurfCloud(ws, cfg, prompt); break;
        case 'kiro':     await runKiroCloud(ws, cfg, prompt); break;
        default: send(ws, { type: 'error', content: `Unknown agent: ${agent}` });
      }
    } catch (e) {
      send(ws, { type: 'error', content: `Error: ${e.message}` });
    }
  });

  ws.on('close', () => {
    if (relayWs === ws) {
      console.log(`[${clientId}] Relay DISCONNECTED`);
      relayWs = null;
    } else console.log(`[${clientId}] Client disconnected`);
    clientConfigs.delete(clientId);
  });
});

// ─── Helpers ───────────────────────────────────────────────────

function model(cfg, key) {
  return cfg[key] || DEFAULTS[key.toLowerCase().replace(/_model$/, '')] || DEFAULTS[key.replace(/_MODEL$/, '').toLowerCase()];
}

async function streamSSE(response, ws) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const d = JSON.parse(line.slice(6));
          let content = d.choices?.[0]?.delta?.content || d.choices?.[0]?.text || d.message?.content?.parts?.[0] || '';
          if (content) send(ws, { type: 'replace_stream', content });
        } catch (e) {}
      }
    }
  }
}

// ─── Codex ─────────────────────────────────────────────────────

async function runCodexCloud(ws, cfg, prompt) {
  const session = cfg.CODEX_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'CODEX_SESSION not set' });
  const m = cfg.CODEX_MODEL || DEFAULTS.codex;

  send(ws, { type: 'status', content: `🤖 Codex (${m}) processing...` });

  const body = { model: m, messages: [{ role: 'user', content: prompt }], stream: true };
  let resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    // Fallback: Responses API
    resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, input: prompt, stream: true }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      send(ws, { type: 'error', content: `Codex error: ${resp.status} ${errText}` });
      return;
    }
  }

  await streamSSE(resp, ws);
  send(ws, { type: 'done', content: `\n✅ Codex (${m}) complete.` });
}

// ─── OpenCode ──────────────────────────────────────────────────

async function runOpenCodeCloud(ws, cfg, prompt) {
  const session = cfg.OPENCODE_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'OPENCODE_SESSION not set' });
  const userModel = cfg.OPENCODE_MODEL;

  let apiUrl, model;
  if (session.startsWith('sk-or-')) {
    apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    model = userModel || 'openai/gpt-4o';
  } else if (session.startsWith('gsk_')) {
    apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
    model = userModel || 'llama-3.3-70b-versatile';
  } else if (session.startsWith('nvapi-')) {
    apiUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    model = userModel || 'meta/llama-3.1-70b-instruct';
  } else if (session.startsWith('AIza')) {
    send(ws, { type: 'status', content: `🤖 OpenCode (Google AI) processing...` });
    const modelId = userModel || 'gemini-pro';
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/${modelId}:streamGenerateContent?key=${session}&alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) { send(ws, { type: 'error', content: `Google AI error: ${resp.status}` }); return; }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split('\n').slice(0, -1)) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6));
            const t = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (t) send(ws, { type: 'replace_stream', content: t });
          } catch (e) {}
        }
      }
      buf = buf.split('\n').pop() || '';
    }
    send(ws, { type: 'done', content: '\n✅ OpenCode complete.' });
    return;
  } else {
    apiUrl = 'https://api.openai.com/v1/chat/completions';
    model = userModel || DEFAULTS.opencode;
  }

  send(ws, { type: 'status', content: `🤖 OpenCode (${model}) processing...` });
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    send(ws, { type: 'error', content: `OpenCode error ${resp.status}: ${t}` });
    return;
  }
  await streamSSE(resp, ws);
  send(ws, { type: 'done', content: `\n✅ OpenCode (${model}) complete.` });
}

// ─── Windsurf ──────────────────────────────────────────────────

async function runWindsurfCloud(ws, cfg, prompt) {
  const session = cfg.WINDSURF_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'WINDSURF_SESSION not set' });

  send(ws, { type: 'status', content: '🏄 Windsurf (cloud) processing...' });

  const body = { messages: [{ role: 'user', content: prompt }] };
  const userModel = cfg.WINDSURF_MODEL;
  if (userModel) body.model = userModel;

  try {
    const resp = await fetch('https://server.codeium.com/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      send(ws, { type: 'stream', content: `[Windsurf] API returned ${resp.status}. Use relay mode for desktop agents.\n\nPrompt: ${prompt}` });
      send(ws, { type: 'done', content: '\n⚠️ Windsurf cloud: connect desktop relay for full access.' });
      return;
    }
    await streamSSE(resp, ws);
    send(ws, { type: 'done', content: '\n✅ Windsurf complete.' });
  } catch (err) {
    send(ws, { type: 'error', content: `Windsurf error: ${err.message}` });
  }
}

// ─── Kiro (Amazon Bedrock) ─────────────────────────────────────

function parseAwsCreds(session) {
  let accessKeyId, secretAccessKey, region;
  try {
    const parsed = JSON.parse(session);
    accessKeyId = parsed.accessKeyId || parsed.access_key_id;
    secretAccessKey = parsed.secretAccessKey || parsed.secret_access_key;
    region = parsed.region;
  } catch {
    const parts = session.split(':');
    accessKeyId = parts[0];
    secretAccessKey = parts[1];
    region = parts[2];
  }
  return { accessKeyId, secretAccessKey, region: region || DEFAULTS.kiroRegion };
}

async function runKiroCloud(ws, cfg, prompt) {
  const session = cfg.KIRO_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'KIRO_SESSION not set' });

  const { accessKeyId, secretAccessKey, region } = parseAwsCreds(session);
  if (!accessKeyId || !secretAccessKey) {
    return send(ws, { type: 'error', content: 'KIRO_SESSION must be JSON: {"accessKeyId":"...","secretAccessKey":"...","region":"..."} or colon-separated: key:secret:region' });
  }

  const modelId = cfg.KIRO_MODEL || DEFAULTS.kiro;

  send(ws, { type: 'status', content: `🔮 Kiro (${modelId}) processing...` });

  try {
    const client = new BedrockRuntimeClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });

    const cmd = new ConverseStreamCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      anthropicVersion: 'bedrock-2023-05-31',
    });

    const resp = await client.send(cmd);

    for await (const event of resp.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        send(ws, { type: 'replace_stream', content: event.contentBlockDelta.delta.text });
      } else if (event.messageStop) {
        send(ws, { type: 'done', content: '\n✅ Kiro complete.' });
        return;
      }
    }
    send(ws, { type: 'done', content: '\n✅ Kiro complete.' });
  } catch (err) {
    send(ws, { type: 'error', content: `Kiro error: ${err.message}` });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Hub Backend on port ${PORT}`);
});
