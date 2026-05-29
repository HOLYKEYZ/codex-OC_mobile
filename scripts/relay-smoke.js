#!/usr/bin/env node
const path = require('path');

let WebSocket;
try {
  WebSocket = require(path.join(__dirname, '..', 'backend', 'node_modules', 'ws'));
} catch {
  WebSocket = require('ws');
}

const serverUrl = process.env.SERVER_URL || process.argv[2] || 'wss://agent-hub-backend-wk48.onrender.com';
const relayCode = process.env.RELAY_CODE || process.argv[3] || '';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 45000);
const executeOpenCode = process.env.SMOKE_EXECUTE_OPENCODE === '1' || process.argv.includes('--execute-opencode');
const openCodeExpected = process.env.SMOKE_OPENCODE_EXPECT || 'AGENTHUB_SMOKE_OK';
const openCodePrompt = process.env.SMOKE_OPENCODE_PROMPT || `Agent Hub relay smoke test: reply with exactly ${openCodeExpected}.`;
const attachSmokeFile = process.env.SMOKE_ATTACH_FILE === '1' || process.argv.includes('--attach-file');
const attachmentText = process.env.SMOKE_ATTACHMENT_TEXT || `Agent Hub smoke attachment ${openCodeExpected}`;

if (!relayCode) {
  console.error('Usage: node scripts/relay-smoke.js <server-url> <relay-code>');
  console.error('Or set SERVER_URL and RELAY_CODE.');
  process.exit(2);
}

function withTimeout(label, work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function connectPhone(label) {
  return withTimeout(label, () => new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    const state = {
      joined: null,
      sessions: null,
      selectedCodex: null,
      codexDetail: null,
      opencodeSessions: null,
      opencodeExecution: executeOpenCode ? { selected: null, statuses: [], output: '', done: false, attachmentSaved: false } : null,
    };

    function send(payload) {
      ws.send(JSON.stringify(payload));
    }

    ws.on('open', () => send({ type: 'join_session', code: relayCode }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'error') {
        reject(new Error(msg.content || 'Relay returned error'));
        try { ws.close(); } catch {}
        return;
      }

      if (msg.type === 'session_joined') {
        if (state.joined) return;
        state.joined = msg;
        if (!msg.relay_online) {
          reject(new Error('Relay is offline for this code'));
          try { ws.close(); } catch {}
          return;
        }
        send({ type: 'session_list' });
        return;
      }

      if (msg.type === 'sessions' && !state.sessions) {
        const sessions = msg.sessions || [];
        const codex = sessions.find((session) => session.agent === 'codex' && session.id);
        if (!codex) return;
        state.sessions = sessions;
        state.selectedCodex = { id: codex.id, title: codex.title };
        send({ type: 'session_detail', agent: 'codex', sessionId: codex.id });
        return;
      }

      if (msg.type === 'session_detail' && msg.detail?.agent === 'codex' && !state.codexDetail) {
        const detail = msg.detail;
        if (detail.sessionId !== state.selectedCodex?.id) return;
        const hasUsableDetail = Array.isArray(detail.messages) && detail.messages.length > 0 && detail.metadataScope === 'latest_turn';
        if (!hasUsableDetail) return;
        state.codexDetail = detail;
        send({ type: 'session_list', agent: 'opencode' });
        return;
      }

      if (msg.type === 'sessions' && state.sessions && state.codexDetail && !state.opencodeSessions) {
        const opencodeSessions = (msg.sessions || []).filter((session) => session.agent === 'opencode' && session.id);
        if (opencodeSessions.length === 0) return;
        state.opencodeSessions = opencodeSessions;
        if (!executeOpenCode) {
          try { ws.close(1000, 'smoke done'); } catch {}
          resolve(state);
          return;
        }
        const selected = state.opencodeSessions.find((session) => session.agent === 'opencode' && session.id);
        if (!selected) {
          reject(new Error('No OpenCode session available for execute smoke'));
          try { ws.close(); } catch {}
          return;
        }
        state.opencodeExecution.selected = { id: selected.id, title: selected.title };
        const payload = { agent: 'opencode', sessionId: selected.id, prompt: openCodePrompt };
        if (attachSmokeFile) {
          const data = Buffer.from(attachmentText, 'utf8');
          payload.attachments = [{
            name: 'agenthub-smoke.txt',
            mime: 'text/plain',
            base64: data.toString('base64'),
            size: data.length,
          }];
        }
        send(payload);
        return;
      }

      if (executeOpenCode && msg.type === 'status') {
        state.opencodeExecution?.statuses.push(msg.content || '');
        if (msg.content?.startsWith('file: saved upload ')) state.opencodeExecution.attachmentSaved = true;
        return;
      }

      if (executeOpenCode && (msg.type === 'stream' || msg.type === 'replace_stream')) {
        if (msg.content) state.opencodeExecution.output = msg.content;
        return;
      }

      if (executeOpenCode && msg.type === 'done') {
        state.opencodeExecution.done = true;
        try { ws.close(1000, 'smoke done'); } catch {}
        resolve(state);
      }
    });
  }));
}

function summarize(result) {
  const sessions = result.sessions || [];
  const counts = sessions.reduce((acc, session) => {
    acc[session.agent] = (acc[session.agent] || 0) + 1;
    return acc;
  }, {});
  const detail = result.codexDetail || {};
  return {
    relayOnline: !!result.joined?.relay_online,
    agents: result.joined?.available_agents || [],
    totalSessions: sessions.length,
    counts,
    selectedCodex: result.selectedCodex,
    opencodeSessions: result.opencodeSessions?.length || 0,
    codexDetail: {
      status: detail.status || '',
      messages: Array.isArray(detail.messages) ? detail.messages.length : 0,
      metadataScope: detail.metadataScope || '',
      commands: Array.isArray(detail.commands) ? detail.commands.length : 0,
      tools: Array.isArray(detail.tools) ? detail.tools.length : 0,
      files: Array.isArray(detail.files) ? detail.files.length : 0,
    },
    opencodeExecution: result.opencodeExecution ? {
      selected: result.opencodeExecution.selected,
      statusCount: result.opencodeExecution.statuses.length,
      done: result.opencodeExecution.done,
      output: result.opencodeExecution.output,
      attachmentSaved: result.opencodeExecution.attachmentSaved,
    } : null,
  };
}

(async () => {
  const first = await connectPhone('first phone connection');
  const second = await connectPhone('reconnected phone connection');
  const firstSummary = summarize(first);
  const secondSummary = summarize(second);

  const failures = [];
  for (const [label, summary] of [['first', firstSummary], ['reconnect', secondSummary]]) {
    if (!summary.relayOnline) failures.push(`${label}: relay not online`);
    if (!summary.agents.includes('codex')) failures.push(`${label}: codex missing`);
    if (!summary.agents.includes('opencode')) failures.push(`${label}: opencode missing`);
    if (summary.totalSessions < 1) failures.push(`${label}: no sessions returned`);
    if ((summary.counts.codex || 0) < 1) failures.push(`${label}: no Codex sessions`);
    if (summary.opencodeSessions < 1) failures.push(`${label}: no OpenCode sessions`);
    if (summary.codexDetail.messages < 1) failures.push(`${label}: Codex detail has no messages`);
    if (summary.codexDetail.metadataScope !== 'latest_turn') failures.push(`${label}: Codex metadata is not latest_turn`);
    if (executeOpenCode) {
      if (!summary.opencodeExecution?.selected?.id) failures.push(`${label}: no OpenCode execution target`);
      if (!summary.opencodeExecution?.done) failures.push(`${label}: OpenCode execution did not finish`);
      if (!summary.opencodeExecution?.output?.includes(openCodeExpected)) {
        failures.push(`${label}: OpenCode output did not include ${openCodeExpected}`);
      }
      if (attachSmokeFile && !summary.opencodeExecution?.attachmentSaved) {
        failures.push(`${label}: relay did not report saved attachment`);
      }
    }
  }

  console.log(JSON.stringify({ serverUrl, relayCode, executeOpenCode, attachSmokeFile, first: firstSummary, reconnect: secondSummary }, null, 2));
  if (failures.length) {
    console.error(`Relay smoke failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
