package com.example.agenthub

import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.net.Uri
import android.provider.OpenableColumns
import android.speech.RecognizerIntent
import android.util.Base64
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import com.example.agenthub.theme.AgentHubTheme
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.TimeUnit

data class AgentInfo(val id: String, val name: String)
data class LogLine(val id: Long, val text: String, val type: String = "append")
data class RemoteSession(val agent: String, val id: String, val title: String, val subtitle: String, val updatedAt: Long = 0)
data class PendingAttachment(val name: String, val mime: String, val base64: String, val size: Int)

val AGENT_NAMES = mapOf("codex" to "Codex", "opencode" to "OpenCode", "system" to "system")
const val MAX_DETAIL_MESSAGES_ON_PHONE = 40
const val MAX_DETAIL_MESSAGE_CHARS = 3000
const val MAX_DETAIL_TOTAL_CHARS = 60000

fun parseRemoteSessions(raw: String): List<RemoteSession> {
    if (raw.isBlank()) return emptyList()
    return try {
        val arr = JSONArray(raw)
        (0 until arr.length()).mapNotNull { i ->
            val obj = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = obj.optString("id")
            if (id.isBlank()) return@mapNotNull null
            RemoteSession(
                agent = obj.optString("agent"),
                id = id,
                title = obj.optString("title", id),
                subtitle = obj.optString("subtitle", obj.optString("directory", "")),
                updatedAt = obj.optLong("updatedAt", 0)
            )
        }
    } catch (_: Exception) {
        emptyList()
    }
}

fun remoteSessionsToJson(sessions: List<RemoteSession>): String {
    val arr = JSONArray()
    sessions.forEach { session ->
        arr.put(JSONObject().apply {
            put("agent", session.agent)
            put("id", session.id)
            put("title", session.title)
            put("subtitle", session.subtitle)
            put("updatedAt", session.updatedAt)
        })
    }
    return arr.toString()
}

class MainActivity : ComponentActivity() {
    private val deepLinkState = mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        deepLinkState.value = intent?.data?.toString() ?: ""
        setContent {
            AgentHubTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF0A0A0C)) {
                    AgentHubScreen(initialDeepLink = deepLinkState.value)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLinkState.value = intent.data?.toString() ?: ""
    }
}

@Composable
fun CrashFallback(message: String) {
    Box(modifier = Modifier.fillMaxSize().background(Color(0xFF0A0A0C)).padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Agent Hub hit an error", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(message, color = Color(0xFFEF4444), fontSize = 13.sp)
            Spacer(Modifier.height(16.dp))
            Text("Close and reopen the app, then use Settings to reconnect.", color = Color(0xFF888888), fontSize = 13.sp)
        }
    }
}

object OkHttpAgent {
    val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentHubScreen(initialDeepLink: String = "") {
    val context = LocalContext.current
    val rootView = LocalView.current
    val prefs = remember { context.getSharedPreferences("AgentHubPrefs", Context.MODE_PRIVATE) }
    val mainHandler = remember { Handler(Looper.getMainLooper()) }

    DisposableEffect(rootView, context) {
        rootView.keepScreenOn = true
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose {
            rootView.keepScreenOn = false
            window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    fun onUi(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post { block() }
    }

    var input by remember { mutableStateOf("") }
    var logs by remember {
        mutableStateOf(
            prefs.getString("LAST_TRANSCRIPT", "")?.takeIf { it.isNotBlank() }
                ?.let { listOf(LogLine(System.currentTimeMillis(), it, "replace")) }
                ?: emptyList()
        )
    }
    var wsStatus by remember { mutableStateOf("connecting") }
    var webSocket by remember { mutableStateOf<WebSocket?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    var showChats by remember { mutableStateOf(prefs.getBoolean("SHOW_CHATS", true)) }
    var showQrScanner by remember { mutableStateOf(false) }
    var showModelPicker by remember { mutableStateOf(false) }
    var relayOnline by remember { mutableStateOf(false) }
    var currentAgent by remember { mutableStateOf(prefs.getString("CURRENT_AGENT", "") ?: "") }
    var availableAgents by remember { mutableStateOf(listOf<String>()) }
    var sessions by remember { mutableStateOf(parseRemoteSessions(prefs.getString("LAST_SESSIONS", "") ?: "")) }
    var sessionsLoading by remember { mutableStateOf(false) }
    var sessionsNotice by remember { mutableStateOf("") }
    var selectedSessionId by remember { mutableStateOf(prefs.getString("SELECTED_SESSION_ID", "") ?: "") }
    var selectedSessionTitle by remember { mutableStateOf(prefs.getString("SELECTED_SESSION_TITLE", "") ?: "") }
    var agentModels by remember { mutableStateOf(listOf<String>()) }
    var currentModel by remember { mutableStateOf("") }
    var connectionSeq by remember { mutableStateOf(0L) }
    var hasPausedOnce by remember { mutableStateOf(false) }
    var attachments by remember { mutableStateOf(listOf<PendingAttachment>()) }
    var promptRunning by remember { mutableStateOf(false) }
    var promptInFlight by remember { mutableStateOf(false) }
    var lastConnectAttemptAt by remember { mutableStateOf(0L) }
    var showTechnicalEvents by remember { mutableStateOf(prefs.getBoolean("SHOW_TECHNICAL_EVENTS", false)) }
    var stickToBottom by remember { mutableStateOf(true) }

    var sessionCode by remember { mutableStateOf(prefs.getString("SESSION_CODE", "") ?: "") }
    var serverUrl by remember { mutableStateOf(prefs.getString("SERVER_URL", "wss://agent-hub-backend-wk48.onrender.com") ?: "") }

    val agentName = AGENT_NAMES[currentAgent] ?: "Agent"
    val scrollScope = rememberCoroutineScope()

    val speechLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val spoken = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            if (spoken.isNotBlank()) input = listOf(input, spoken).filter { it.isNotBlank() }.joinToString(" ")
        }
    }

    fun displayNameForUri(uri: android.net.Uri): String {
        return try {
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            } ?: uri.lastPathSegment ?: "upload"
        } catch (_: Exception) {
            uri.lastPathSegment ?: "upload"
        }
    }

    fun readUriBytesBounded(uri: android.net.Uri, maxBytes: Int): ByteArray {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > maxBytes) throw IllegalArgumentException("${displayNameForUri(uri)} is over ${maxBytes / 1024 / 1024} MB")
                out.write(buffer, 0, read)
            }
            return out.toByteArray()
        }
        throw IllegalArgumentException("Could not open ${displayNameForUri(uri)}")
    }

    val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        val added = mutableListOf<PendingAttachment>()
        for (uri in uris.take(10)) {
            try {
                val bytes = readUriBytesBounded(uri, 8 * 1024 * 1024)
                added += PendingAttachment(
                    name = displayNameForUri(uri),
                    mime = context.contentResolver.getType(uri) ?: "application/octet-stream",
                    base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
                    size = bytes.size
                )
            } catch (e: Exception) {
                logs = logs + LogLine(System.currentTimeMillis(), "Error: Could not attach ${uri.lastPathSegment ?: "file"} (${e.message})")
            }
        }
        if (added.isNotEmpty()) {
            attachments = (attachments + added).takeLast(10)
            logs = logs + LogLine(System.currentTimeMillis(), "Attached ${added.size} file(s) from phone", "file")
        }
    }

    fun startVoiceInput() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Prompt ${AGENT_NAMES[currentAgent] ?: "agent"}")
        }
        try {
            speechLauncher.launch(intent)
        } catch (e: Exception) {
            logs = logs + LogLine(System.currentTimeMillis(), "Error: Voice input unavailable (${e.message})")
        }
    }

    fun stripAnsi(str: String): String {
        return str
            .replace(Regex("\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001B\\\\))"), "")
            .replace(Regex("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]"), "")
            .replace("\r", "")
    }

    fun requestSessions(agent: String = "", socket: WebSocket? = webSocket) {
        val j = JSONObject()
        j.put("type", "session_list")
        if (agent.isNotBlank()) j.put("agent", agent)
        sessionsLoading = true
        sessionsNotice = "Loading chats..."
        if (socket?.send(j.toString()) != true) {
            sessionsLoading = false
            sessionsNotice = "Could not request chats. Reconnect the relay."
        }
    }

    fun requestSessionDetail(session: RemoteSession, socket: WebSocket? = webSocket) {
        if (session.id.isBlank()) return
        val j = JSONObject()
        j.put("type", "session_detail")
        j.put("agent", session.agent)
        j.put("sessionId", session.id)
        socket?.send(j.toString())
    }

    fun parseSessions(arr: JSONArray): List<RemoteSession> {
        return (0 until arr.length()).mapNotNull { i ->
            val obj = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = obj.optString("id")
            if (id.isBlank()) return@mapNotNull null
            RemoteSession(
                agent = obj.optString("agent"),
                id = id,
                title = obj.optString("title", id),
                subtitle = obj.optString("subtitle", obj.optString("directory", "")),
                updatedAt = obj.optLong("updatedAt", 0)
            )
        }
    }

    fun consolidatedLogs(): List<LogLine> {
        val consolidated = mutableListOf<LogLine>()
        for (log in logs) {
            if (log.type == "replace" && consolidated.isNotEmpty() && consolidated.last().type == "replace") {
                consolidated[consolidated.size - 1] = log
            } else {
                consolidated.add(log)
            }
        }
        return consolidated
    }

    fun visibleTranscript(): String {
        return consolidatedLogs().map { it.text }.filter { it.isNotBlank() }.joinToString("\n\n").takeLast(200000)
    }

    fun appendLog(line: LogLine) {
        if (logs.lastOrNull()?.text == line.text && logs.lastOrNull()?.type == line.type) return
        logs = logs + line
    }

    fun statusLogType(text: String): String {
        val value = text.trim()
        return when {
            value.startsWith("command:") || value.startsWith("tool:") || value.startsWith("web_search") ||
                value.startsWith("tool_search") || value.startsWith("mcp_") || value.startsWith("patch_") ||
                value.startsWith("thinking") || value.startsWith("browser/search") ||
                value.startsWith("command output:") -> "tool"
            value.startsWith("file:") || value.startsWith("files:") || value.startsWith("file diff:") -> "file"
            else -> "status"
        }
    }

    fun detailExtraLogs(detail: JSONObject?, startId: Long): List<LogLine> {
        if (detail == null) return emptyList()
        val out = mutableListOf<LogLine>()
        var next = startId
        val commands = detail.optJSONArray("commands")
        if (commands != null && commands.length() > 0) {
            out += LogLine(next++, "latest turn commands: ${commands.length()}", "tool")
        }
        val tools = detail.optJSONArray("tools")
        if (tools != null && tools.length() > 0) {
            val names = (0 until tools.length()).mapNotNull { i ->
                tools.optJSONObject(i)?.optString("name")?.takeIf { it.isNotBlank() }
            }.distinct().take(6)
            out += LogLine(next++, if (names.isEmpty()) "latest turn tools: ${tools.length()}" else "latest turn tools: ${names.joinToString(", ")}", "tool")
        }
        val files = detail.optJSONArray("files")
        if (files != null && files.length() > 0) {
            out += LogLine(next++, "latest turn files: ${files.length()}", "file")
        }
        val diff = detail.optJSONArray("diff")
        if (diff != null && diff.length() > 0) {
            out += LogLine(next++, "files changed: ${diff.length()} diff item(s)", "file")
        }
        val todo = detail.optJSONArray("todo")
        if (todo != null && todo.length() > 0) {
            out += LogLine(next++, "todo: ${todo.length()} item(s)", "tool")
        }
        return out
    }

    fun statusForPhone(content: String): LogLine? {
        val raw = content.trim()
        if (raw.isBlank()) return null
        val type = statusLogType(raw)
        if (showTechnicalEvents) return LogLine(System.currentTimeMillis(), raw, type)
        val lower = raw.lowercase()
        val summary = when {
            lower.startsWith("command output:") -> null
            lower.startsWith("command:") -> "Running command"
            lower.startsWith("tool:") || lower.startsWith("mcp_") || lower.startsWith("patch_") -> "Using tool"
            lower.startsWith("web_search") || lower.startsWith("tool_search") || lower.contains("browser") -> "Using browser/search"
            lower.startsWith("file diff:") || lower.startsWith("file:") || lower.startsWith("files:") -> "Editing files"
            lower.startsWith("thinking") -> "Thinking"
            lower.startsWith("opening codex chat") -> "Opening selected Codex chat"
            lower.startsWith("starting codex turn") -> "Starting Codex turn"
            lower.startsWith("steering active codex turn") -> "Steering active Codex turn"
            lower.startsWith("sending to codex chat") -> "Sending to selected Codex chat"
            lower.startsWith("sending to opencode session") -> "Sending to selected OpenCode session"
            lower.startsWith("opencode accepted prompt") -> "OpenCode accepted prompt"
            else -> raw
        } ?: return null
        return LogLine(System.currentTimeMillis(), summary, type)
    }

    fun openUpdatePage() {
        val base = serverUrl.trim()
            .replaceFirst("wss://", "https://")
            .replaceFirst("ws://", "http://")
            .trimEnd('/')
        if (base.isBlank()) {
            appendLog(LogLine(System.currentTimeMillis(), "Error: Server URL is empty"))
            return
        }
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$base/download")))
        } catch (e: Exception) {
            appendLog(LogLine(System.currentTimeMillis(), "Error: Could not open update page (${e.message})"))
        }
    }

    fun copyVisibleTranscript() {
        val text = visibleTranscript()
        if (text.isBlank()) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Agent Hub transcript", text))
        logs = logs + LogLine(System.currentTimeMillis(), "Copied visible transcript")
    }

    fun compactChatText(text: String): String {
        val cleaned = stripAnsi(text).trim()
        val looksLikeTerminalPaste = cleaned.contains("Windows PowerShell") ||
            cleaned.contains("node relay.js") ||
            cleaned.contains("════════") ||
            cleaned.contains("Relay session:")
        if (looksLikeTerminalPaste && cleaned.length > 1200) {
            return "[long terminal paste hidden in chat view; use the Codex desktop chat for the original paste]"
        }
        if (cleaned.length <= MAX_DETAIL_MESSAGE_CHARS) return cleaned
        return cleaned.take(MAX_DETAIL_MESSAGE_CHARS) + "\n\n[message truncated on phone]"
    }

    fun detailMessageLogs(messages: JSONArray?): List<LogLine> {
        if (messages == null || messages.length() == 0) return emptyList()
        val start = maxOf(0, messages.length() - MAX_DETAIL_MESSAGES_ON_PHONE)
        val out = mutableListOf<LogLine>()
        var totalChars = 0
        if (start > 0) {
            out += LogLine(System.currentTimeMillis(), "Showing latest ${messages.length() - start} messages. Older history is hidden on phone to keep the app responsive.", "status")
        }
        for (i in start until messages.length()) {
            val m = messages.optJSONObject(i) ?: continue
            val role = m.optString("role", "message")
            if (role != "user" && role != "assistant") continue
            val text = compactChatText(m.optString("text", ""))
            if (text.isBlank()) continue
            totalChars += text.length
            if (totalChars > MAX_DETAIL_TOTAL_CHARS) {
                out += LogLine(System.currentTimeMillis() + i, "More history hidden on phone to keep the app responsive.", "status")
                break
            }
            out += LogLine(System.currentTimeMillis() + i, text, role)
        }
        return out
    }

    val listState = rememberLazyListState()
    val lifecycleOwner = LocalLifecycleOwner.current

    val connectWs = connectWs@{ urlOverride: String?, codeOverride: String? ->
        val targetServerUrl = (urlOverride ?: serverUrl).trim()
        val targetSessionCode = codeOverride ?: sessionCode
        val now = System.currentTimeMillis()
        if (targetServerUrl.isBlank()) {
            wsStatus = "disconnected"
            logs = logs + LogLine(System.currentTimeMillis(), "Error: Server URL is empty")
            return@connectWs
        }
        if (wsStatus == "connecting" && now - lastConnectAttemptAt < 2500) return@connectWs
        lastConnectAttemptAt = now
        connectionSeq += 1
        val seq = connectionSeq
        wsStatus = "connecting"
        webSocket?.close(1000, "Reconnecting")
        val request = try {
            Request.Builder().url(targetServerUrl).build()
        } catch (e: Exception) {
            wsStatus = "disconnected"
            logs = logs + LogLine(System.currentTimeMillis(), "Error: Invalid server URL (${e.message})")
            null
        }
        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                onUi {
                    if (seq != connectionSeq) return@onUi
                    webSocket = ws
                    wsStatus = "connected"
                    logs = logs + LogLine(System.currentTimeMillis(), "Connected to server")
                    if (targetSessionCode.isNotBlank()) {
                        val j = JSONObject(); j.put("type", "join_session"); j.put("code", targetSessionCode)
                        ws.send(j.toString())
                    } else {
                        logs = logs + LogLine(System.currentTimeMillis(), "Enter a session code in Settings")
                    }
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    onUi {
                        if (seq != connectionSeq) return@onUi
                        when (json.optString("type")) {
                            "session_joined" -> {
                                relayOnline = json.optBoolean("relay_online", false)
                                val agents = json.optJSONArray("available_agents")
                                availableAgents = if (agents != null) (0 until agents.length()).map { agents.getString(it) } else emptyList()
                                if (currentAgent.isBlank() && availableAgents.isNotEmpty()) {
                                    currentAgent = availableAgents.first()
                                    prefs.edit().putString("CURRENT_AGENT", currentAgent).apply()
                                }
                                if (currentAgent.isNotBlank()) {
                                    appendLog(LogLine(System.currentTimeMillis(),
                                        if (relayOnline) "$agentName ready (relay code $targetSessionCode)" else "$agentName waiting for desktop relay on code $targetSessionCode"))
                                    val m = json.optJSONObject("agent_model")
                                    if (m != null && m.has(currentAgent)) currentModel = m.getString(currentAgent)
                                    val models = json.optJSONObject("available_models")
                                    if (models != null && models.has(currentAgent)) {
                                        val arr = models.optJSONArray(currentAgent)
                                        if (arr != null) agentModels = (0 until arr.length()).map { arr.getString(it) }
                                    }
                                } else {
                                    appendLog(LogLine(System.currentTimeMillis(), "Connected (scan QR or set agent in settings)"))
                                }
                                if (relayOnline) {
                                    mainHandler.postDelayed({
                                        onUi {
                                            if (seq == connectionSeq && relayOnline) {
                                                requestSessions("", webSocket)
                                            }
                                        }
                                    }, 600)
                                    mainHandler.postDelayed({
                                        onUi {
                                            if (seq == connectionSeq && relayOnline && sessions.isEmpty()) {
                                                requestSessions("", webSocket)
                                            }
                                        }
                                    }, 2400)
                                    mainHandler.postDelayed({
                                        onUi {
                                            if (seq == connectionSeq && relayOnline && sessions.isEmpty()) {
                                                sessionsLoading = false
                                                sessionsNotice = "No chats received yet. Tap refresh or restart the relay."
                                            }
                                        }
                                    }, 7000)
                                    if (selectedSessionId.isNotBlank() && currentAgent.isNotBlank()) {
                                        requestSessionDetail(RemoteSession(currentAgent, selectedSessionId, selectedSessionTitle, ""), ws)
                                    }
                                }
                            }
                            "sessions" -> {
                                sessions = parseSessions(json.optJSONArray("sessions") ?: JSONArray())
                                sessionsLoading = false
                                sessionsNotice = if (sessions.isEmpty()) "No saved Codex/OpenCode chats found." else ""
                                prefs.edit().putString("LAST_SESSIONS", remoteSessionsToJson(sessions.take(200))).apply()
                                sessions.firstOrNull { it.id == selectedSessionId }?.let {
                                    selectedSessionTitle = it.title
                                    prefs.edit().putString("SELECTED_SESSION_TITLE", it.title).apply()
                                }
                            }
                            "session_detail" -> {
                                val detail = json.optJSONObject("detail")
                                val messages = detail?.optJSONArray("messages")
                                val chatLogs = detailMessageLogs(messages)
                                val extras = if (showTechnicalEvents) detailExtraLogs(detail, System.currentTimeMillis() + 10000) else emptyList()
                                if (chatLogs.isNotEmpty() || extras.isNotEmpty()) logs = chatLogs + extras
                                val detailActive = detail?.optString("status") == "active"
                                promptRunning = detailActive || promptInFlight
                            }
                            "config_updated" -> {
                                val cfg = json.optJSONObject("config")
                                if (cfg != null && currentAgent.isNotBlank()) {
                                    val modelKey = currentAgent.uppercase() + "_MODEL"
                                    if (cfg.has(modelKey)) currentModel = cfg.getString(modelKey)
                                }
                            }
                            "stream" -> {
                                promptRunning = true
                                logs = logs + LogLine(System.currentTimeMillis(), compactChatText(json.optString("content")), "assistant")
                            }
                            "replace_stream" -> {
                                promptRunning = true
                                logs = logs + LogLine(System.currentTimeMillis(), compactChatText(json.optString("content")), "replace")
                            }
                            "status", "system" -> {
                                val content = json.optString("content")
                                val lower = content.lowercase(Locale.ROOT)
                                if (lower.contains("starting") || lower.contains("steering") || lower.contains("working") || lower.contains("codex started")) {
                                    promptRunning = true
                                } else if (lower.contains("finished") || lower.contains("completed") || lower.contains("exited")) {
                                    if (!promptInFlight) promptRunning = false
                                }
                                statusForPhone(content)?.let { appendLog(it) }
                            }
                            "done" -> {
                                promptInFlight = false
                                promptRunning = false
                                val c = json.optString("content"); if (c.isNotBlank()) logs = logs + LogLine(System.currentTimeMillis(), c)
                            }
                            "error" -> {
                                promptInFlight = false
                                promptRunning = false
                                logs = logs + LogLine(System.currentTimeMillis(), "Error: ${json.optString("content")}")
                            }
                        }
                    }
                } catch (_: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) { onUi { if (seq == connectionSeq) wsStatus = "disconnected" } }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                onUi {
                    if (seq != connectionSeq) return@onUi
                    wsStatus = "disconnected"
                    logs = logs + LogLine(System.currentTimeMillis(), "Error: ${t.message ?: "Connection failed"}")
                }
            }
        }
        if (request != null) webSocket = OkHttpAgent.client.newWebSocket(request, listener)
    }

    DisposableEffect(Unit) {
        if (initialDeepLink.isBlank()) connectWs(null, null)
        onDispose { webSocket?.close(1000, "Closing") }
    }

    DisposableEffect(lifecycleOwner, serverUrl, sessionCode) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) {
                hasPausedOnce = true
            } else if (event == Lifecycle.Event.ON_RESUME && hasPausedOnce && sessionCode.isNotBlank()) {
                if (wsStatus == "connected") {
                    if (relayOnline && showChats) requestSessions("", webSocket)
                    sessions.firstOrNull { it.id == selectedSessionId }?.let { requestSessionDetail(it, webSocket) }
                } else {
                    connectWs(null, null)
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val isNearBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val total = info.totalItemsCount
            total == 0 || (info.visibleItemsInfo.lastOrNull()?.index ?: 0) >= total - 3
        }
    }

    LaunchedEffect(isNearBottom) {
        stickToBottom = isNearBottom
    }

    LaunchedEffect(logs) {
        val text = visibleTranscript()
        prefs.edit().putString("LAST_TRANSCRIPT", text.takeLast(200000)).apply()
        val renderedCount = consolidatedLogs().size
        if (renderedCount > 0 && stickToBottom) {
            try {
                listState.scrollToItem(renderedCount - 1)
            } catch (_: Exception) {}
        }
    }

    LaunchedEffect(relayOnline, showChats, webSocket) {
        val socket = webSocket
        if (relayOnline && showChats && socket != null) {
            delay(600)
            if (sessions.isEmpty()) requestSessions("", socket)
            delay(2400)
            if (sessions.isEmpty()) requestSessions("", socket)
        }
    }

    LaunchedEffect(wsStatus, sessionCode, serverUrl) {
        if (wsStatus == "disconnected" && sessionCode.isNotBlank()) {
            val seqAtSchedule = connectionSeq
            delay(3000)
            if (connectionSeq != seqAtSchedule) return@LaunchedEffect
            if (wsStatus == "disconnected") connectWs(null, null)
        }
    }

    val sendMsg = {
        if ((input.isNotBlank() || attachments.isNotEmpty()) && wsStatus == "connected" && currentAgent.isNotBlank()) {
            if (currentAgent == "codex" && selectedSessionId.isBlank()) {
                logs = logs + LogLine(System.currentTimeMillis(), "Pick a Codex chat first. This prevents starting a new terminal session by accident.")
            } else {
            val promptText = input.ifBlank { "Please inspect the attached file(s)." }
            logs = logs + LogLine(System.currentTimeMillis(), promptText, "user")
            val j = JSONObject(); j.put("agent", currentAgent); j.put("prompt", promptText)
            if (selectedSessionId.isNotBlank()) j.put("sessionId", selectedSessionId)
            if (attachments.isNotEmpty()) {
                val arr = JSONArray()
                attachments.forEach { file ->
                    arr.put(JSONObject().apply {
                        put("name", file.name)
                        put("mime", file.mime)
                        put("base64", file.base64)
                        put("size", file.size)
                    })
                }
                j.put("attachments", arr)
            }
            if (webSocket?.send(j.toString()) == true) {
                promptInFlight = true
                promptRunning = true
                input = ""
                attachments = emptyList()
            } else {
                logs = logs + LogLine(System.currentTimeMillis(), "Error: Could not send prompt. Reconnect the relay.")
            }
            }
        }
    }

    val onQrScanned = { raw: String ->
        showQrScanner = false
        try {
            val uri = java.net.URI(if (raw.startsWith("ws") || raw.startsWith("wss")) raw else "ws://x/$raw")
            val query = uri.query ?: ""
            val params = query.split("&").filter { it.isNotBlank() }.associate { kv ->
                kv.split("=", limit=2).let {
                    java.net.URLDecoder.decode(it[0], "UTF-8") to java.net.URLDecoder.decode(it.getOrElse(1) { "" }, "UTF-8")
                }
            }
            val nextSessionCode = params["code"] ?: sessionCode
            val nextAgent = params["agent"] ?: currentAgent
            var nextServerUrl = serverUrl
            if (params.containsKey("code")) sessionCode = nextSessionCode
            if (params.containsKey("agent")) currentAgent = nextAgent
            selectedSessionId = ""
            selectedSessionTitle = ""
            if (raw.startsWith("ws") || raw.startsWith("wss")) {
                val port = if (uri.port > 0) ":${uri.port}" else ""
                nextServerUrl = "${uri.scheme}://${uri.host}$port"
                serverUrl = nextServerUrl
            }
            prefs.edit().putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl)
                .putString("CURRENT_AGENT", currentAgent).putString("SELECTED_SESSION_ID", "").putString("SELECTED_SESSION_TITLE", "").apply()
            connectWs(nextServerUrl, nextSessionCode)
        } catch (_: Exception) {
            sessionCode = raw
            prefs.edit().putString("SESSION_CODE", raw).apply(); connectWs(null, raw)
        }
    }

    LaunchedEffect(initialDeepLink) {
        if (initialDeepLink.isNotBlank()) onQrScanned(initialDeepLink)
    }

    val isConnected = wsStatus == "connected"
    val canPrompt = isConnected && currentAgent.isNotBlank() && (currentAgent != "codex" || selectedSessionId.isNotBlank())
    val hasDraft = input.isNotBlank() || attachments.isNotEmpty()
    val canSubmit = canPrompt && (!promptRunning || hasDraft)

    // ─── QR Scanner ──────────────────────────────────────────────
    if (showQrScanner) { QrScanner(onScan = onQrScanned, onCancel = { showQrScanner = false }); return }

    // ─── Settings ─────────────────────────────────────────────────
    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("Settings", color = Color.White, fontWeight = FontWeight.Bold) },
            containerColor = Color(0xFF1A1A2E),
            text = {
                LazyColumn(modifier = Modifier.heightIn(max = 480.dp)) {
                    item {
                        Text("Connect", fontWeight = FontWeight.Bold, color = Color(0xFF8B5CF6), fontSize = 14.sp)
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = { showSettings = false; showQrScanner = true },
                            modifier = Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(16.dp)),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) {
                            Icon(Icons.Default.QrCodeScanner, contentDescription = null, tint = Color.White)
                            Spacer(Modifier.width(8.dp))
                            Text("Scan QR Code", color = Color.White, fontSize = 16.sp)
                        }
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(value = sessionCode, onValueChange = { sessionCode = it },
                            label = { Text("Session Code") }, placeholder = { Text("e.g. Xk3mR9aB2q") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White))
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = currentAgent, onValueChange = { currentAgent = it },
                            label = { Text("Agent") }, placeholder = { Text("codex / opencode") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White))
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = serverUrl, onValueChange = { serverUrl = it },
                            label = { Text("Server URL") }, placeholder = { Text("wss://host:port") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White))
                        Spacer(Modifier.height(12.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Show command details", color = Color.White, fontSize = 13.sp)
                                Text("Off hides terminal output and paths", color = Color(0xFF8F96A3), fontSize = 11.sp)
                            }
                            Switch(
                                checked = showTechnicalEvents,
                                onCheckedChange = {
                                    showTechnicalEvents = it
                                    prefs.edit().putBoolean("SHOW_TECHNICAL_EVENTS", it).apply()
                                },
                                colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = Color(0xFF8B5CF6))
                            )
                        }
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = { openUpdatePage() },
                            modifier = Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(14.dp)),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2F255F))
                        ) {
                            Icon(Icons.Default.Refresh, contentDescription = null, tint = Color.White)
                            Spacer(Modifier.width(8.dp))
                            Text("Open App Update Page", color = Color.White, fontSize = 14.sp)
                        }
                    }
                }
            },
            confirmButton = {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { showSettings = false }) { Text("Cancel", color = Color.Gray) }
                    TextButton(onClick = {
                        prefs.edit().putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl)
                            .putString("CURRENT_AGENT", currentAgent).putBoolean("SHOW_TECHNICAL_EVENTS", showTechnicalEvents).apply()
                        showSettings = false; connectWs(null, null)
                    }) { Text("Save", color = Color(0xFF8B5CF6)) }
                }
            }
        )
    }

    // ─── Model Picker ────────────────────────────────────────────
    if (showModelPicker && agentModels.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = { showModelPicker = false },
            title = { Text("Model", color = Color.White, fontWeight = FontWeight.Bold) },
            containerColor = Color(0xFF1A1A2E),
            text = {
                Column {
                    agentModels.forEach { model ->
                        val isCurrent = model == currentModel
                        Row(
                            modifier = Modifier.fillMaxWidth().clickable {
                                val j = JSONObject(); j.put("type", "select_model")
                                j.put("agent", currentAgent); j.put("model", model)
                                webSocket?.send(j.toString()); showModelPicker = false
                            }.padding(vertical = 10.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            RadioButton(selected = isCurrent, onClick = {},
                                colors = RadioButtonDefaults.colors(selectedColor = Color(0xFF8B5CF6)))
                            Spacer(Modifier.width(8.dp))
                            Text(model, color = if (isCurrent) Color.White else Color(0xFFBBBBBB), fontSize = 13.sp)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showModelPicker = false }) { Text("Cancel", color = Color.Gray) } }
        )
    }

    // ─── Main UI ─────────────────────────────────────────────────
    Column(modifier = Modifier.fillMaxSize().padding(top = 44.dp, bottom = 8.dp, start = 12.dp, end = 12.dp)) {
        // Header
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.size(12.dp).clip(CircleShape).background(
                    if (isConnected && relayOnline) Color(0xFF4ADE80) else if (isConnected) Color(0xFFFBBF24) else Color(0xFFEF4444)))
                Spacer(Modifier.width(8.dp))
                if (currentAgent.isNotBlank()) {
                    Text(agentName, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    if (isConnected) {
                        Text(if (relayOnline) "  ● Relay" else "  ● Offline", color = Color(0xFF8B5CF6), fontSize = 11.sp, fontWeight = FontWeight.Medium)
                    }
                } else {
                    Text("Agent Hub", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                }
            }
            Row {
                if (currentModel.isNotBlank() && isConnected && agentModels.isNotEmpty()) {
                    Text(currentModel, color = Color(0xFF8B5CF6), fontSize = 10.sp,
                        modifier = Modifier.clickable { showModelPicker = true }.padding(end = 8.dp, top = 4.dp))
                }
                if (isConnected && relayOnline) {
                    IconButton(onClick = {
                        showChats = !showChats
                        prefs.edit().putBoolean("SHOW_CHATS", showChats).apply()
                        if (showChats) requestSessions("")
                    }) {
                        Icon(Icons.Default.Chat, contentDescription = "Chats", tint = Color(0xFF888888))
                    }
                }
                if (!isConnected) {
                    Button(onClick = { showSettings = true },
                        modifier = Modifier.height(36.dp).clip(RoundedCornerShape(18.dp)),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6)),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 0.dp)
                    ) { Text("Connect", color = Color.White, fontSize = 13.sp) }
                    Spacer(Modifier.width(8.dp))
                }
                if (isConnected && relayOnline) {
                    IconButton(onClick = { requestSessions("") }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh sessions", tint = Color(0xFF888888))
                    }
                }
                IconButton(onClick = { showSettings = true }) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color(0xFF888888))
                }
            }
        }

        Spacer(Modifier.height(8.dp))

        if (showChats && relayOnline) {
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp).clip(RoundedCornerShape(12.dp))
                    .background(Color(0xFF15161A)).padding(8.dp)
            ) {
                item {
                    Text("Chats", color = Color(0xFF8B5CF6), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                }
                if (sessions.isEmpty()) {
                    item {
                        Text(
                            if (sessionsLoading) "Loading chats..." else sessionsNotice.ifBlank { "No chats loaded yet. Tap refresh." },
                            color = Color(0xFF9CA3AF),
                            fontSize = 12.sp,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp)
                        )
                    }
                }
                items(sessions.take(200)) { session ->
                    val selected = session.id == selectedSessionId
                    Row(
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                            .background(if (selected) Color(0xFF2F255F) else Color.Transparent)
                            .clickable {
                                currentAgent = session.agent
                                selectedSessionId = session.id
                                selectedSessionTitle = session.title
                                logs = emptyList()
                                prefs.edit().putString("CURRENT_AGENT", session.agent).putString("SELECTED_SESSION_ID", session.id)
                                    .putString("SELECTED_SESSION_TITLE", session.title).putString("LAST_TRANSCRIPT", "").apply()
                                requestSessionDetail(session)
                            }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(if (session.agent == "codex") Color(0xFF4ADE80) else Color(0xFF60A5FA)))
                        Spacer(Modifier.width(8.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(session.title, color = Color.White, fontSize = 12.sp, maxLines = 1)
                            if (session.subtitle.isNotBlank()) Text(session.subtitle, color = Color(0xFF7B7F8A), fontSize = 10.sp, maxLines = 1)
                        }
                        Text(AGENT_NAMES[session.agent] ?: session.agent, color = Color(0xFFB8A7FF), fontSize = 10.sp)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }

        // Chat area
        Box(modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(Color(0xFF1E1E24)).padding(12.dp)) {
            if (logs.isNotEmpty()) {
                IconButton(
                    onClick = { copyVisibleTranscript() },
                    modifier = Modifier.align(Alignment.TopEnd).size(36.dp)
                ) {
                    Icon(Icons.Default.ContentCopy, contentDescription = "Copy transcript", tint = Color(0xFF888888))
                }
                if (!isNearBottom) {
                    IconButton(
                        onClick = {
                            scrollScope.launch {
                                val count = consolidatedLogs().size
                                if (count > 0) listState.scrollToItem(count - 1)
                                stickToBottom = true
                            }
                        },
                        modifier = Modifier.align(Alignment.BottomEnd).size(44.dp)
                            .clip(CircleShape).background(Color(0xFF3B2F79))
                    ) {
                        Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Scroll to latest", tint = Color.White)
                    }
                }
            }
            if (!isConnected) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Not connected", color = Color(0xFF666666), fontSize = 16.sp)
                        Spacer(Modifier.height(4.dp))
                        Text("Settings → Scan QR or enter session code", color = Color(0xFF444444), fontSize = 12.sp)
                        Spacer(Modifier.height(24.dp))
                        Button(onClick = { showSettings = true },
                            modifier = Modifier.clip(RoundedCornerShape(24.dp)).height(48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) { Text("Connect", color = Color.White) }
                    }
                }
            } else if (logs.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Connected", color = Color(0xFF4ADE80), fontSize = 14.sp)
                        Spacer(Modifier.height(4.dp))
                        Text("Send a prompt to ${if (currentAgent.isNotBlank()) agentName else "your agent"}", color = Color(0xFF444444), fontSize = 12.sp)
                    }
                }
            } else {
                LazyColumn(state = listState) {
                    items(consolidatedLogs()) { log ->
                        if (log.text.isNotBlank()) {
                            val isUser = log.type == "user"
                            val isStatus = log.type == "status" || log.text.startsWith("Error")
                            val isTool = log.type == "tool"
                            val isFile = log.type == "file"
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(
                                    start = if (isUser) 32.dp else 0.dp,
                                    top = 3.dp,
                                    end = if (isUser) 0.dp else 32.dp,
                                    bottom = 3.dp
                                ),
                                horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
                            ) {
                                Surface(
                                    color = when {
                                        isStatus -> Color.Transparent
                                        isTool -> Color(0xFF111827)
                                        isFile -> Color(0xFF10231B)
                                        isUser -> Color(0xFF3B2F79)
                                        else -> Color(0xFF15161A)
                                    },
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Text(
                                        log.text,
                                        color = when {
                                            log.text.startsWith("Error") -> Color(0xFFEF4444)
                                            isStatus -> Color(0xFF8F96A3)
                                            isTool -> Color(0xFFA7F3D0)
                                            isFile -> Color(0xFF86EFAC)
                                            else -> Color.White
                                        },
                                        fontFamily = if (isStatus || isTool || isFile) FontFamily.Monospace else FontFamily.Default,
                                        fontSize = if (isStatus || isTool || isFile) 11.sp else 13.sp,
                                        modifier = Modifier.padding(horizontal = if (isStatus) 0.dp else 10.dp, vertical = if (isStatus) 2.dp else 8.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))

        // Input bar
        if (attachments.isNotEmpty()) {
            Text(
                attachments.joinToString("  ") { "${it.name} (${it.size / 1024} KB)" },
                color = Color(0xFF86EFAC),
                fontSize = 10.sp,
                maxLines = 1,
                modifier = Modifier.padding(start = 58.dp, bottom = 4.dp)
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = { startVoiceInput() },
                enabled = canPrompt,
                modifier = Modifier.size(44.dp).clip(CircleShape).background(Color(0xFF1E1E24))
            ) {
                Icon(Icons.Default.Mic, contentDescription = "Voice prompt", tint = if (canPrompt) Color(0xFFA7F3D0) else Color(0xFF333333))
            }
            Spacer(Modifier.width(6.dp))
            IconButton(
                onClick = {
                    try {
                        fileLauncher.launch("*/*")
                    } catch (e: Exception) {
                        logs = logs + LogLine(System.currentTimeMillis(), "Error: File picker unavailable (${e.message})")
                    }
                },
                enabled = canPrompt,
                modifier = Modifier.size(44.dp).clip(CircleShape).background(Color(0xFF1E1E24))
            ) {
                Icon(Icons.Default.AttachFile, contentDescription = "Attach file", tint = if (canPrompt) Color(0xFFB8A7FF) else Color(0xFF333333))
            }
            Spacer(Modifier.width(6.dp))
            TextField(
                value = input, onValueChange = { input = it },
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(24.dp)).height(48.dp),
                enabled = canPrompt,
                colors = TextFieldDefaults.colors(focusedContainerColor = Color(0xFF1E1E24), unfocusedContainerColor = Color(0xFF1E1E24),
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                    disabledContainerColor = Color(0xFF151518), disabledTextColor = Color(0xFF333333)),
                placeholder = { Text(
                    if (!isConnected) "Connect to send prompts"
                    else if (currentAgent.isBlank()) "Set agent in Settings"
                    else if (currentAgent == "codex" && selectedSessionId.isBlank()) "Pick a Codex chat first"
                    else if (promptRunning) "Steer running turn..."
                    else if (selectedSessionTitle.isNotBlank()) "Prompt ${selectedSessionTitle.take(24)}..."
                    else "Prompt $agentName...",
                    color = if (isConnected && currentAgent.isNotBlank()) Color.Gray else Color(0xFF333333)) }
            )
            Spacer(Modifier.width(6.dp))
            Box(modifier = Modifier.size(48.dp).clip(CircleShape).background(
                if (canSubmit) Color(0xFF8B5CF6) else if (promptRunning && canPrompt) Color(0xFF2F255F) else Color(0xFF1E1E24))
                .clickable(enabled = canSubmit) { sendMsg() },
                contentAlignment = Alignment.Center) {
                if (promptRunning && !hasDraft) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
                } else {
                    Icon(
                        Icons.Default.Send,
                        contentDescription = if (promptRunning) "Steer turn" else "Send",
                        tint = if (canSubmit) Color.White else Color(0xFF333333)
                    )
                }
            }
        }
    }
}
