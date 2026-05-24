# Agent Hub — Full Product Build

## Mission
Build a mobile app that lets you chat with AI coding agents from your phone. Users scan a QR code on their desktop terminal, the app connects to the running agent (Codex, OpenCode, Claude Code, Windsurf, Cursor, etc.), and they can prompt it, see responses, approve tool calls, and control the coding session — all from their phone.

This must work RELAY mode (agent runs on desktop, output streams to phone) AND CLOUD mode (desktop off, phone calls APIs directly using stored credentials). Must be production quality — clean UI, no crashes, push notifications, full terminal fidelity when needed.

## Current State

### Repo
- `https://github.com/HOLYKEYZ/vibe-app-slop` (master branch, auto-deploys to Render)
- Render server: `wss://agent-hub-backend-wk48.onrender.com` (free tier, spins down after 15min)
- Android app in `AgentHub/` (Kotlin/Compose), backend in `backend/` (Node.js)

### What's Built (Broken/Partial)
1. **backend/relay.js** — Connects to Render server, discovers CLI configs (Codex JWT, OpenCode API keys), registers session, prints QR codes per agent
2. **backend/server.js** — Node.js WebSocket server on Render, relays messages between phone and desktop, has cloud mode handlers (calls ChatGPT backend API for Codex, OpenAI API for OpenCode, Bedrock for Kiro)
3. **AgentHub/.../MainActivity.kt** — Android app in Jetpack Compose. Currently has agent selection from QR, chat UI, model picker
4. **AgentHub/.../QrScanner.kt** — Camera-based QR scanner using ML Kit

### Key Problems
1. App crashes on startup after any error (no crash recovery, no error boundaries)
2. QR scanning is flaky (camera init can fail, no retry, no fallback)
3. No push notifications — user must watch the screen
4. Output is raw terminal text with ANSI codes (even with stripping, it's ugly)
5. No IDE integration (VS Code, JetBrains)
6. Only Android — no iOS
7. Relay dies after 10min timeout (no keepalive/heartbeat)
8. Render free tier has ephemeral disk — session persistence doesn't work
9. Cloud mode has hardcoded model lists, no proper error handling per API key
10. No proper PTY wrapping — currently runs one-shot CLI commands, not persistent agent sessions

### Architecture Issues (Must Fix)
- Current relay runs `codex exec <prompt>` and `opencode run <prompt>` as one-shot commands. This means no persistent session state, no way for the agent to ask follow-up questions, no tool call approval from phone.
- Need to wrap agents in a **PTY** (node-pty or similar) so the phone sees a live terminal session, can send keystrokes, approve tool calls, etc.
- No workspace context — phone doesn't know what files/project the agent is working on.

## Reference Projects (Research These)

### Must Study
1. **anycoding** (`gurudin/any-coding`) — Node.js + Android (Termux). PTY hub, cloudflared tunnel, multi-tab sessions. Uses `node-pty` for PTY wrapping, JSON control frames + raw PTY bytes over WebSocket. Has idle detection (2500ms silence = agent waiting). 256KB ring buffer for session replay. 6-digit numeric pair code + QR.
2. **MobileCLI** (`MobileCLI/mobilecli`) — Rust + iOS. Most polished. Has auth-v2 challenge-response, 256KB replay buffer, push notifications via Expo, file browser + editor, phone-initiated spawns. Agent detection via PTY output pattern matching (detection.rs ~390 lines).
3. **Paseo** (`getpaseo/paseo`) — TypeScript monorepo. Most sophisticated protocol. ECDH key exchange in QR → XSalsa20-Poly1305 E2EE. Binary multiplexed WebSocket (channel 0 = control, channel 1 = terminal). Agent lifecycle management with ACP (Agent Client Protocol). Timeline persistence to disk. Voice input.
4. **cyhhao/vibe-remote** — Python. IM-bot bridge (Slack/Discord/Telegram/WeChat). Agent routing by message prefix (`Codex: do X`). Very different approach but good for understanding chat-based UX.
5. **vibe-remote (Btelo/BteloLabs)** — Go/Rust? Closed source CLI + iOS. Connector name/password, QR pairing, E2EE relay. Has VS Code extension and JetBrains plugin.

### Key Files to Read
- `anycoding`: `hub.js`, `session.js`, `terminal.js` — how PTY wrapping works
- `MobileCLI`: `detection.rs`, `session.rs`, `protocol.md` — agent detection, protocol spec
- `Paseo`: `transport.ts`, `session.ts`, `agent-manager.ts` — binary mux protocol, agent lifecycle

## Full Product Spec

### 1. Desktop Daemon (Node.js, replace current relay.js)

**What it does:**
- Runs as a background process on the desktop
- Detects available AI coding agents (Codex, OpenCode, Claude Code, Windsurf, Cursor, Gemini CLI)
- Reads credentials from CLI configs (auth.json, config.toml, etc.)
- Wraps agent processes in PTY sessions (node-pty)
- Exposes a WebSocket server on localhost + connects to Render relay for remote access
- Generates QR codes per agent session
- Handles tool call approvals from phone
- Persists session state to disk

**Key features:**
- Auto-detect agents by scanning common config paths and checking CLI availability
- PTY wrapping: spawn agent process in a PTY, capture all output, relay to phone, accept keystrokes from phone
- Idle detection: after 2.5s of no PTY output, fire `agent_event{idle}` so phone can send notification
- Tool call detection: parse structured output (OpenCode JSON events, Codex permission prompts, Claude Code approval requests) and send structured `agent_permission_request` to phone instead of raw terminal text
- Session persistence: save session state to `~/.agenthub/sessions/` with 1MB ring buffer for replay
- Multiple agents: support running Codex + OpenCode + Claude Code simultaneously, each in its own session
- Workspace context: detect cwd, git branch, open files (via LSP or editor extensions)
- Heartbeat/ping every 30s to keep Render connection alive
- Reconnect with exponential backoff

**Agent detection (copy MobileCLI's detection.rs approach):**
```
Agent        | Detection Method
Codex        | Check ~/.codex/auth.json exists, try `codex --version`
OpenCode     | Check ~/.local/share/opencode/auth.json, try `opencode --version`
Claude Code  | Check `claude` CLI available, check ~/.claude/credentials
Windsurf     | Check ~/.codeium/windsurf.json
Cursor       | Check ~/.cursor/ config
Gemini CLI   | Check `gemini` CLI available
```

**PTY Protocol (WebSocket JSON messages):**
```json
// Phone → Daemon
{ "type": "auth", "token": "one-time-pairing-token" }
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 80, "rows": 24 }
{ "type": "approve", "tool_call_id": "abc123" }
{ "type": "spawn", "agent": "codex", "cwd": "/home/user/project" }
{ "type": "get_sessions" }
{ "type": "ping" }

// Daemon → Phone
{ "type": "welcome", "version": "1.0.0" }
{ "type": "pty_output", "session_id": "s1", "data": "..." }
{ "type": "agent_event", "session_id": "s1", "state": "idle"|"busy"|"waiting_for_input"|"error" }
{ "type": "agent_permission_request", "tool_call_id": "abc123", "tool": "read_file", "args": {"path": "/etc/passwd"} }
{ "type": "session_created", "session_id": "s1", "agent": "codex", "cwd": "/home/user/project" }
{ "type": "session_list", "sessions": [...] }
{ "type": "pong" }
```

### 2. Relay Server (Node.js, update current server.js)

**What it does:**
- Bridges phone ↔ daemon when they're not on the same LAN
- Zero-knowledge relay: all payloads encrypted (or at least opaque to server)
- Session persistence to PostgreSQL (Render free tier includes Postgres)
- Health endpoint, APK serving
- No message processing — just route bytes between phone WS and daemon WS

**Changes needed:**
- Replace ephemeral Map + sessions.json with PostgreSQL (use `pg` npm package)
- Add proper session auth (one-time pairing tokens, not just codes)
- Heartbeat management (ping/pong every 30s)
- Multi-daemon support (multiple desktop relays can connect)
- Rate limiting and connection limits

### 3. Mobile App (Full Rewrite)

**Platform:** React Native (Expo) for iOS + Android from one codebase. Or keep native Android + add iOS.

**Screens:**

**a) Welcome / Pairing Screen**
- "Scan QR Code" button → opens camera
- Manual code entry field (6-character alphanumeric)
- "Connect" button
- Clean, minimal design — dark theme

**b) Agent Chat Screen** (main screen)
- Header: agent name + connection status dot (green=yellow=cloud, green=relay, red=disconnected)
- Model name tappable → model picker
- Chat messages: user prompts in right-aligned bubbles, agent responses in left-aligned
- Terminal output: monospace, ANSI rendered (use a terminal emulator library like xterm.js in WebView, or parse ANSI)
- Tool call approvals: show structured cards with Accept/Reject buttons (not raw terminal text)
- Input bar at bottom with send button
- Voice input button (uses device speech-to-text)

**c) Multi-Session Tabs**
- Horizontal scrollable tab bar at top showing all active sessions
- Each tab = one agent session
- Swipe between sessions
- "+" button to spawn new agent session from phone

**d) Settings Screen**
- Server URL
- Connected devices
- About / version

**Key Features:**
- **Push notifications**: When daemon detects `agent_event{idle}` or `agent_permission_request`, send push notification via Expo Push Service (or Firebase for Android). Notification opens correct session.
- **Session persistence**: App remembers last 10 sessions, quick reconnect
- **Full terminal view**: Option to see raw terminal output (toggle between "clean chat" and "terminal" view)
- **File browser**: Browse project files from phone (MobileCLI-style)
- **Offline mode**: Show last session output when disconnected
- **Error recovery**: Never crash on startup. Wrap everything in error boundaries. Show "Something went wrong" with retry button.

### 4. IDE Integration (VS Code Extension + JetBrains Plugin)

**VS Code Extension (`agenthub-vscode`):**
- When user activates, connects to local daemon
- Shows current agent session status in status bar
- "Open in Phone" button to generate QR for current workspace
- Mirrors chat output in VS Code panel
- Detects open files, sends workspace context to daemon
- Commands: `Agent Hub: Connect Phone`, `Agent Hub: Send to Agent`, `Agent Hub: View Session`

**JetBrains Plugin:**
- Same functionality for IntelliJ/WebStorm/PyCharm

**Communication with daemon:**
- Local IPC via Unix socket or localhost WebSocket
- Sends: `{ type: "workspace_context", cwd, openFiles, gitBranch, projectType }`
- Receives: `{ type: "agent_output", session_id, data }`

### 5. Agent Support Matrix

| Agent | Relay Mode | Cloud Mode | Tool Call Approval | Notes |
|---|---|---|---|---|
| Codex | PTY wrap `codex` | call `chatgpt.com/backend-api/codex/responses` with JWT | Parse "Approve?" prompts | JWT from ~/.codex/auth.json |
| OpenCode | PTY wrap `opencode` | call OpenAI API with sk- key | Parse structured JSON events | JSON output with `--format json` |
| Claude Code | PTY wrap `claude` | call Anthropic API with sk-ant key | Native structured approval | ACP support coming |
| Windsurf | PTY wrap `windsurf` | call Codeium API | Parse prompts | Token from ~/.codeium/windsurf.json |
| Cursor | PTY wrap `cursor` | TBD | TBD | Check ~/.cursor config |
| Gemini CLI | PTY wrap `gemini` | call Google AI API | Parse prompts | Key from `gemini auth` |

### 6. Cloud Mode Architecture

When desktop daemon is disconnected:
1. Phone sends prompt to Render server
2. Server checks session config for stored API credentials
3. Server calls the appropriate API:
   - Codex: `chatgpt.com/backend-api/codex/responses` (JWT OAuth token)
   - OpenCode: `api.openai.com/v1/chat/completions` (sk- key)
   - Claude Code: `api.anthropic.com/v1/messages` (sk-ant- key)
   - Windsurf: Codeium's API
   - Gemini: Google AI API
4. Stream response back to phone via WebSocket
5. No terminal output — clean JSON/SSE responses only

### 7. Deployment

- **Daemon**: `npm install -g agenthub` → `agenthub daemon` → prints QR. Auto-updates via npm.
- **Relay Server**: Docker container on Render (upgrade to paid tier for persistent disk + Postgres). Or use Railway/Fly.io for better free tier.
- **Mobile App**: Expo build → App Store + Google Play. Or distribute APK via Render for beta.
- **CI/CD**: GitHub Actions builds APK + Docker image. Auto-deploys to Render.

## Priority Order

1. **Phase 1 — Make current thing not crash** (1 day)
   - Fix crash loop: wrap composable in error boundary, catch all exceptions
   - Add keepalive to relay (ping/pong every 30s)
   - Handle WebSocket reconnection properly
   - Session persistence to PostgreSQL on Render
   - Proper error messages in app (no blank screens)

2. **Phase 2 — PTY wrapping** (2 days)
   - Replace one-shot CLI execution with node-pty persistent sessions
   - Implement idle detection (2.5s timeout)
   - Tool call detection and structured approval UI
   - Multi-session support
   - Workspace context (cwd, git branch)

3. **Phase 3 — Production mobile app** (3 days)
   - React Native (Expo) rewrite for iOS + Android
   - Push notifications
   - Clean chat UI with ANSI rendering
   - Multi-session tabs
   - Voice input

4. **Phase 4 — IDE integration** (2 days)
   - VS Code extension
   - JetBrains plugin
   - Workspace context sharing

5. **Phase 5 — Polish** (2 days)
   - File browser from phone
   - Session replay/reconnect
   - Performance optimization
   - Error recovery everywhere
   - Offline support

## Non-Negotiable Rules

1. **Never crash**. Every error must be caught. Every screen must have a fallback. Startup crash = product is dead.
2. **Clean output**. The phone must show clean AI responses, not terminal garbage. Parse everything.
3. **Push notifications**. User should not need to watch the screen. Notify when agent needs them.
4. **Persistent sessions**. Closing the app must not kill the agent. Reconnect gets full state.
5. **Zero-config for phone**. Phone never sees API keys. Everything auto-discovered from desktop CLI configs.
6. **One QR, one agent**. Each QR code is for a specific agent. No generic codes.
7. **Work offline**. App shows useful state when disconnected (last session output, quick reconnect).

## What the Current Codebase Has (Don't Discard)

- Working WebSocket relay pattern (phone ↔ server ↔ daemon)
- QR code generation and scanning
- API credential discovery (Codex JWT, OpenCode keys)
- Codex cloud mode that calls ChatGPT backend API
- OpenCode cloud mode with multi-provider support (OpenAI, Groq, OpenRouter, Google)
- Kiro cloud mode with AWS Bedrock SigV4
- Dark theme Compose UI
- Launcher icon
- Render deployment with APK serving

## What Must Be Replaced

- relay.js → Full daemon with PTY wrapping
- server.js → Add PostgreSQL, proper auth, keepalive
- MainActivity.kt → React Native (Expo) for cross-platform, or complete rewrite
- QrScanner.kt → Keep but harden (or replace if React Native)
- session persistence → PostgreSQL on Render
- One-shot CLI execution → Persistent PTY sessions

## Files to Reference in This Repo

```
backend/relay.js        — Current relay, shows agent discovery pattern
backend/server.js       — Current server, shows cloud mode + WS routing
AgentHub/.../MainActivity.kt  — Current app UI
AgentHub/.../QrScanner.kt     — QR scanner with ML Kit
AgentHub/.../res/drawable/    — Launcher icons
```

## Research References (Read Before Building)

1. **anycoding** architecture:
   - `hub.js` — PTY session management, idle detection
   - `session.js` — Session lifecycle, 256KB ring buffer
   - Protocol: JSON control + raw PTY bytes over WS

2. **MobileCLI** detection:
   - `detection.rs` — Agent fingerprint database, PTY pattern matching
   - Protocol: auth-v2 challenge-response, structured messages

3. **Paseo** protocol:
   - Binary multiplexing (channel 0 = control, channel 1 = terminal)
   - ECDH key exchange for E2EE
   - Agent lifecycle + ACP support

4. **node-pty** — The standard Node.js PTY library. Used by anycoding, VS Code terminal.
   - `spawn('/bin/bash', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd() })`
   - Events: `data`, `exit`
   - Methods: `write(data)`, `resize(cols, rows)`

## Financial
- Render paid tier ~$7/month (necessary for persistent disk + Postgres)
- Expo push notifications ~free for dev
- Google Play Store $25 one-time fee
- Apple Developer $99/year

## Don't Stop Until

- [ ] App opens without crashing on a fresh install
- [ ] QR scanning works (camera permission, scan, connect)
- [ ] PTY wrapping works (agent runs persistently, output streams to phone)
- [ ] Clean chat output (no ANSI codes, no terminal noise)
- [ ] Tool call approval from phone (structured buttons)
- [ ] Push notifications when agent needs input
- [ ] Multi-session tabs
- [ ] Cloud mode works (desktop off)
- [ ] Model switching works
- [ ] Session persistence (reconnect, see history)
- [ ] VS Code extension
- [ ] Works on both Android and iOS
- [ ] All 6 agents supported (Codex, OpenCode, Claude Code, Windsurf, Cursor, Gemini)
- [ ] File browser from phone
- [ ] Voice input
