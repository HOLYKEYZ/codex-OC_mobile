package com.example.agenthub

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.agenthub.theme.AgentHubTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class Agent(val id: String, val name: String, val initial: String)
data class LogLine(val id: Long, val agent: String, val text: String, val type: String = "append")

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AgentHubTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = Color(0xFF0A0A0C)
                ) {
                    AgentHubScreen()
                }
            }
        }
    }
}

object OkHttpAgent {
    val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentHubScreen() {
    val context = LocalContext.current
    val sharedPrefs = remember { context.getSharedPreferences("AgentHubPrefs", Context.MODE_PRIVATE) }
    
    val agents = listOf(
        Agent("codex", "Codex", "C"),
        Agent("opencode", "OpenCode", "O"),
        Agent("windsurf", "Windsurf", "W"),
        Agent("kiro", "Kiro", "K")
    )

    var activeAgent by remember { mutableStateOf(agents[0]) }
    var input by remember { mutableStateOf("") }
    var logs by remember { mutableStateOf(listOf<LogLine>()) }
    var wsStatus by remember { mutableStateOf("connecting") }
    var webSocket by remember { mutableStateOf<WebSocket?>(null) }
    
    var showSettings by remember { mutableStateOf(false) }
    
    // Config states
    var serverUrl by remember { mutableStateOf(sharedPrefs.getString("SERVER_URL", "ws://192.168.100.13:3001") ?: "") }
    var codexSession by remember { mutableStateOf(sharedPrefs.getString("CODEX_SESSION", "") ?: "") }
    var codexModel by remember { mutableStateOf(sharedPrefs.getString("CODEX_MODEL", "") ?: "") }
    var opencodeSession by remember { mutableStateOf(sharedPrefs.getString("OPENCODE_SESSION", "") ?: "") }
    var opencodeModel by remember { mutableStateOf(sharedPrefs.getString("OPENCODE_MODEL", "") ?: "") }
    var windsurfSession by remember { mutableStateOf(sharedPrefs.getString("WINDSURF_SESSION", "") ?: "") }
    var windsurfModel by remember { mutableStateOf(sharedPrefs.getString("WINDSURF_MODEL", "") ?: "") }
    var kiroSession by remember { mutableStateOf(sharedPrefs.getString("KIRO_SESSION", "") ?: "") }
    var kiroModel by remember { mutableStateOf(sharedPrefs.getString("KIRO_MODEL", "") ?: "") }

    val listState = rememberLazyListState()

    // Connect to WebSocket
    val connectWs = {
        webSocket?.close(1000, "Reconnecting")
        val request = Request.Builder().url(serverUrl).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                wsStatus = "connected"
                logs = logs + LogLine(System.currentTimeMillis(), "system", "Connected to Agent Hub Backend")
                
                // Send config
                val configMsg = JSONObject()
                configMsg.put("type", "config")
                val configObj = JSONObject()
                configObj.put("CODEX_SESSION", codexSession)
                if (codexModel.isNotBlank()) configObj.put("CODEX_MODEL", codexModel)
                configObj.put("OPENCODE_SESSION", opencodeSession)
                if (opencodeModel.isNotBlank()) configObj.put("OPENCODE_MODEL", opencodeModel)
                configObj.put("WINDSURF_SESSION", windsurfSession)
                if (windsurfModel.isNotBlank()) configObj.put("WINDSURF_MODEL", windsurfModel)
                configObj.put("KIRO_SESSION", kiroSession)
                if (kiroModel.isNotBlank()) configObj.put("KIRO_MODEL", kiroModel)
                configMsg.put("config", configObj)
                webSocket.send(configMsg.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    val type = json.optString("type")
                    val content = json.optString("content")
                    
                    if (type == "stream") {
                        logs = logs + LogLine(System.currentTimeMillis(), activeAgent.id, content)
                    } else if (type == "replace_stream") {
                        logs = logs + LogLine(System.currentTimeMillis(), activeAgent.id, content, "replace")
                    } else if (type == "status") {
                         logs = logs + LogLine(System.currentTimeMillis(), "system", content)
                    } else if (type == "done") {
                        logs = logs + LogLine(System.currentTimeMillis(), activeAgent.id, content)
                    } else if (type == "error") {
                        logs = logs + LogLine(System.currentTimeMillis(), "system", "Error: $content")
                    } else if (type == "system") {
                        logs = logs + LogLine(System.currentTimeMillis(), "system", content)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                wsStatus = "disconnected"
                logs = logs + LogLine(System.currentTimeMillis(), "system", "Disconnected from backend")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                wsStatus = "disconnected"
                logs = logs + LogLine(System.currentTimeMillis(), "system", "Connection failed: ${t.message}")
            }
        }
        webSocket = OkHttpAgent.client.newWebSocket(request, listener)
    }

    DisposableEffect(serverUrl) {
        connectWs()
        onDispose {
            webSocket?.close(1000, "App closing")
        }
    }

    // Auto-scroll terminal
    LaunchedEffect(logs.size) {
        if (logs.isNotEmpty()) {
            listState.animateScrollToItem(logs.size - 1)
        }
    }

    val handleSend = {
        if (input.isNotBlank() && wsStatus == "connected") {
            logs = logs + LogLine(System.currentTimeMillis(), "user", "> $input")
            val msg = JSONObject()
            msg.put("agent", activeAgent.id)
            msg.put("prompt", input)
            webSocket?.send(msg.toString())
            input = ""
        }
    }

    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("Settings") },
            text = {
                LazyColumn {
                    item {
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = { serverUrl = it },
                            label = { Text("Server WS URL") },
                            placeholder = { Text("Run relay.js for QR code") }
                        )
                        OutlinedTextField(
                            value = codexSession,
                            onValueChange = { codexSession = it },
                            label = { Text("Codex Session") },
                            placeholder = { Text("OpenAI key or access_token") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = codexModel,
                            onValueChange = { codexModel = it },
                            label = { Text("Codex Model (optional)") },
                            placeholder = { Text("gpt-5.5, o3, o4-mini...") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = opencodeSession,
                            onValueChange = { opencodeSession = it },
                            label = { Text("OpenCode Session") },
                            placeholder = { Text("Provider key from auth.json") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = opencodeModel,
                            onValueChange = { opencodeModel = it },
                            label = { Text("OpenCode Model (optional)") },
                            placeholder = { Text("gpt-5.5, claude-sonnet-4...") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = windsurfSession,
                            onValueChange = { windsurfSession = it },
                            label = { Text("Windsurf Session") },
                            placeholder = { Text("Codeium / devin token") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = windsurfModel,
                            onValueChange = { windsurfModel = it },
                            label = { Text("Windsurf Model (optional)") },
                            placeholder = { Text("gpt-4o, claude-3.5...") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = kiroSession,
                            onValueChange = { kiroSession = it },
                            label = { Text("Kiro Session") },
                            placeholder = { Text("JSON: {\"accessKeyId\":...") },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = kiroModel,
                            onValueChange = { kiroModel = it },
                            label = { Text("Kiro Model (optional)") },
                            placeholder = { Text("anthropic.claude-3-5-sonnet...") },
                            singleLine = true
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    sharedPrefs.edit()
                        .putString("SERVER_URL", serverUrl)
                        .putString("CODEX_SESSION", codexSession)
                        .putString("CODEX_MODEL", codexModel)
                        .putString("OPENCODE_SESSION", opencodeSession)
                        .putString("OPENCODE_MODEL", opencodeModel)
                        .putString("WINDSURF_SESSION", windsurfSession)
                        .putString("WINDSURF_MODEL", windsurfModel)
                        .putString("KIRO_SESSION", kiroSession)
                        .putString("KIRO_MODEL", kiroModel)
                        .apply()
                    showSettings = false
                    connectWs()
                }) {
                    Text("Save & Reconnect")
                }
            }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .padding(top = 32.dp, bottom = 16.dp)
    ) {
        // Header
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(if (wsStatus == "disconnected") Color.Red else Color.Green)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Agent Hub",
                    color = Color.White,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold
                )
            }
            IconButton(onClick = { showSettings = true }) {
                Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color.White)
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Agent Selector
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(agents) { agent ->
                val isSelected = agent.id == activeAgent.id
                Box(
                    modifier = Modifier
                        .width(100.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (isSelected) Color(0xFF333340) else Color(0xFF1E1E24))
                        .clickable { activeAgent = agent }
                        .padding(16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            modifier = Modifier
                                .size(48.dp)
                                .clip(CircleShape)
                                .background(Color(0xFF8B5CF6)),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(text = agent.initial, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(text = agent.name, color = Color.White, fontSize = 12.sp)
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Terminal View
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(Color(0xFF1E1E24))
                .padding(16.dp)
        ) {
            LazyColumn(state = listState) {
                if (logs.isEmpty()) {
                    item {
                        Text(
                            text = "Select an agent and start prompting...",
                            color = Color.Gray,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp
                        )
                    }
                }
                
                // Simple representation of replace_stream logic
                // In a real app we'd group logs by ID and update the latest one.
                val consolidatedLogs = mutableListOf<LogLine>()
                for (log in logs) {
                    if (log.type == "replace" && consolidatedLogs.isNotEmpty() && consolidatedLogs.last().agent == log.agent && consolidatedLogs.last().type == "replace") {
                        consolidatedLogs[consolidatedLogs.size - 1] = log
                    } else {
                        consolidatedLogs.add(log)
                    }
                }

                items(consolidatedLogs) { log ->
                    val color = when (log.agent) {
                        "user" -> Color.White
                        "system" -> Color.Gray
                        else -> Color(0xFFA7F3D0) // Light green
                    }
                    Text(
                        text = log.text,
                        color = color,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 2.dp)
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Input Area
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(24.dp)),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color(0xFF1E1E24),
                    unfocusedContainerColor = Color(0xFF1E1E24),
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                ),
                placeholder = { Text("Prompt ${activeAgent.name}...", color = Color.Gray) }
            )
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(
                onClick = handleSend,
                modifier = Modifier
                    .size(50.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF8B5CF6))
            ) {
                Text("➤", color = Color.White, fontSize = 20.sp)
            }
        }
    }
}
