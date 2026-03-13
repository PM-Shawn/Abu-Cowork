//! Feishu WebSocket long connection client.
//!
//! Establishes an outbound WSS connection to Feishu's servers so that Abu
//! can receive IM events without requiring a public IP or ngrok tunnel.
//!
//! Protocol:
//! 1. POST /callback/ws/endpoint to get WSS URL (needs tenant_access_token)
//! 2. Connect to WSS URL
//! 3. Receive binary protobuf frames (pbbp2) containing JSON event payloads
//! 4. Send ping frames at PingInterval to keep alive
//! 5. Auto-reconnect on disconnect

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::sync::{watch, Mutex};
use tokio_tungstenite::tungstenite;

use tauri::{AppHandle, Emitter};

// ── Protobuf types (Feishu pbbp2 frame protocol) ──

#[derive(Clone, PartialEq, prost::Message)]
pub struct PbHeader {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(string, tag = "2")]
    pub value: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Frame {
    #[prost(uint64, tag = "1")]
    pub seq_id: u64,
    #[prost(uint64, tag = "2")]
    pub log_id: u64,
    #[prost(int32, tag = "3")]
    pub service: i32,
    #[prost(int32, tag = "4")]
    pub method: i32,
    #[prost(message, repeated, tag = "5")]
    pub headers: Vec<PbHeader>,
    #[prost(string, optional, tag = "6")]
    pub payload_encoding: Option<String>,
    #[prost(string, optional, tag = "7")]
    pub payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = "8")]
    pub payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = "9")]
    pub log_id_new: Option<String>,
}

impl Frame {
    fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }
}

// ── API response types ──

#[derive(serde::Deserialize, Debug)]
struct TokenResponse {
    code: Option<i32>,
    msg: Option<String>,
    tenant_access_token: Option<String>,
    expire: Option<u64>,
}

#[derive(serde::Deserialize, Debug)]
struct EndpointResponse {
    code: Option<i32>,
    msg: Option<String>,
    data: Option<EndpointData>,
}

#[derive(serde::Deserialize, Debug)]
struct EndpointData {
    #[serde(rename = "URL")]
    url: Option<String>,
    #[serde(rename = "ClientConfig")]
    client_config: Option<ClientConfig>,
}

#[derive(serde::Deserialize, Debug, Clone)]
struct ClientConfig {
    #[serde(rename = "ReconnectCount", default = "default_reconnect_count")]
    reconnect_count: i32,
    #[serde(rename = "ReconnectInterval", default = "default_interval")]
    reconnect_interval: u64,
    #[serde(rename = "ReconnectNonce", default = "default_nonce")]
    reconnect_nonce: u64,
    #[serde(rename = "PingInterval", default = "default_ping")]
    ping_interval: u64,
}

fn default_reconnect_count() -> i32 { -1 }
fn default_interval() -> u64 { 120 }
fn default_nonce() -> u64 { 30 }
fn default_ping() -> u64 { 120 }

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            reconnect_count: -1,
            reconnect_interval: 120,
            reconnect_nonce: 30,
            ping_interval: 120,
        }
    }
}

// ── Connection state ──

#[derive(serde::Serialize, Clone, Debug)]
pub struct WsStatus {
    pub connected: bool,
    pub connecting: bool,
    pub error: Option<String>,
    pub reconnect_attempts: u32,
}

struct WsState {
    /// Signal to stop the connection loop
    stop_tx: watch::Sender<bool>,
    /// Current status
    status: Mutex<WsStatus>,
    /// Dedup map: message_id → seen_at_millis (TTL-based sliding window)
    seen_messages: Mutex<HashMap<String, u64>>,
}

static WS_STATE: std::sync::OnceLock<Arc<WsState>> = std::sync::OnceLock::new();

fn get_or_init_state() -> Arc<WsState> {
    WS_STATE
        .get_or_init(|| {
            let (stop_tx, _) = watch::channel(false);
            Arc::new(WsState {
                stop_tx,
                status: Mutex::new(WsStatus {
                    connected: false,
                    connecting: false,
                    error: None,
                    reconnect_attempts: 0,
                }),
                seen_messages: Mutex::new(HashMap::new()),
            })
        })
        .clone()
}

// ── HTTP helpers ──

async fn fetch_token(
    client: &reqwest::Client,
    app_id: &str,
    app_secret: &str,
) -> Result<(String, u64), String> {
    let resp = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&serde_json::json!({
            "app_id": app_id,
            "app_secret": app_secret,
        }))
        .send()
        .await
        .map_err(|e| format!("Token request failed: {}", e))?;

    let data: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Token parse failed: {}", e))?;

    if data.code != Some(0) {
        return Err(format!(
            "Token error: {}",
            data.msg.unwrap_or_else(|| "unknown".into())
        ));
    }

    let token = data
        .tenant_access_token
        .ok_or("No token in response")?;
    let expire = data.expire.unwrap_or(7200);

    Ok((token, expire))
}

async fn fetch_endpoint(
    client: &reqwest::Client,
    app_id: &str,
    app_secret: &str,
) -> Result<(String, ClientConfig), String> {
    let resp = client
        .post("https://open.feishu.cn/callback/ws/endpoint")
        .json(&serde_json::json!({
            "AppID": app_id,
            "AppSecret": app_secret,
        }))
        .send()
        .await
        .map_err(|e| format!("Endpoint request failed: {}", e))?;

    let data: EndpointResponse = resp
        .json()
        .await
        .map_err(|e| format!("Endpoint parse failed: {}", e))?;

    if data.code != Some(0) {
        return Err(format!(
            "Endpoint error: {}",
            data.msg.unwrap_or_else(|| "unknown".into())
        ));
    }

    let ep = data.data.ok_or("No data in endpoint response")?;
    let url = ep.url.ok_or("No URL in endpoint response")?;
    let config = ep.client_config.unwrap_or_default();

    Ok((url, config))
}

// ── Frame helpers ──

fn build_ping_frame(seq_id: u64, service_id: &str) -> Vec<u8> {
    let frame = Frame {
        seq_id,
        log_id: 0,
        service: 0, // CONTROL
        method: 0,  // CONTROL
        headers: vec![
            PbHeader {
                key: "type".into(),
                value: "ping".into(),
            },
            PbHeader {
                key: "service_id".into(),
                value: service_id.into(),
            },
        ],
        payload_encoding: None,
        payload_type: None,
        payload: None,
        log_id_new: None,
    };
    frame.encode_to_vec()
}

fn build_ack_frame(seq_id: u64, log_id: u64) -> Vec<u8> {
    let ack = serde_json::json!({ "code": 0 });
    let frame = Frame {
        seq_id,
        log_id,
        service: 0,
        method: 0, // CONTROL for ack
        headers: vec![PbHeader {
            key: "type".into(),
            value: "pong".into(), // ack uses pong type
        }],
        payload_encoding: None,
        payload_type: Some("application/json".into()),
        payload: Some(ack.to_string().into_bytes()),
        log_id_new: None,
    };
    frame.encode_to_vec()
}

/// Extract service_id from a WSS URL query string
fn extract_service_id(url: &str) -> String {
    url.split('?')
        .nth(1)
        .and_then(|qs| {
            qs.split('&')
                .find(|p| p.starts_with("service_id="))
                .map(|p| p.trim_start_matches("service_id=").to_string())
        })
        .unwrap_or_default()
}

// ── Main connection loop ──

async fn run_connection(
    app: AppHandle,
    app_id: String,
    app_secret: String,
    state: Arc<WsState>,
) {
    let http_client = reqwest::Client::new();
    let mut stop_rx = state.stop_tx.subscribe();
    let mut reconnect_attempts: u32 = 0;
    let mut seq_counter: u64 = 1;

    loop {
        // Check if stopped
        if *stop_rx.borrow() {
            break;
        }

        // Update status: connecting
        {
            let mut s = state.status.lock().await;
            s.connecting = true;
            s.connected = false;
            s.reconnect_attempts = reconnect_attempts;
        }
        emit_status(&app, &state).await;

        // Step 1: Verify credentials by fetching token (also cached for reply APIs)
        let _token = match fetch_token(&http_client, &app_id, &app_secret).await {
            Ok((t, _)) => t,
            Err(e) => {
                eprintln!("[FeishuWS] Token error: {}", e);
                set_error(&state, &e).await;
                emit_status(&app, &state).await;
                if wait_or_stop(&mut stop_rx, 30).await {
                    break;
                }
                reconnect_attempts += 1;
                continue;
            }
        };

        // Step 2: Get WebSocket endpoint (uses AppID/AppSecret directly, not token)
        let (wss_url, config) =
            match fetch_endpoint(&http_client, &app_id, &app_secret).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[FeishuWS] Endpoint error: {}", e);
                    set_error(&state, &e).await;
                    emit_status(&app, &state).await;
                    if wait_or_stop(&mut stop_rx, 30).await {
                        break;
                    }
                    reconnect_attempts += 1;
                    continue;
                }
            };

        let service_id = extract_service_id(&wss_url);
        eprintln!(
            "[FeishuWS] Connecting to {} (ping={}s, reconnect_interval={}s)",
            &wss_url, config.ping_interval, config.reconnect_interval
        );

        // Step 3: Connect WebSocket
        let ws_result = tokio_tungstenite::connect_async(&wss_url).await;
        let ws_stream = match ws_result {
            Ok((stream, _)) => stream,
            Err(e) => {
                let msg = format!("WebSocket connect failed: {}", e);
                eprintln!("[FeishuWS] {}", msg);
                set_error(&state, &msg).await;
                emit_status(&app, &state).await;
                if wait_or_stop(&mut stop_rx, config.reconnect_interval).await {
                    break;
                }
                reconnect_attempts += 1;
                continue;
            }
        };

        // Connected!
        eprintln!("[FeishuWS] Connected");
        reconnect_attempts = 0;
        {
            let mut s = state.status.lock().await;
            s.connected = true;
            s.connecting = false;
            s.error = None;
            s.reconnect_attempts = 0;
        }
        emit_status(&app, &state).await;

        let (write, read) = ws_stream.split();
        let write = Arc::new(tokio::sync::Mutex::new(write));

        // Ping task
        let write_ping = write.clone();
        let ping_interval = config.ping_interval;
        let sid = service_id.clone();
        let mut stop_rx_ping = state.stop_tx.subscribe();
        let ping_handle = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_secs(ping_interval));
            interval.tick().await; // skip first tick
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let data = build_ping_frame(seq_counter, &sid);
                        let msg = tungstenite::Message::Binary(data.into());
                        if let Err(e) = write_ping.lock().await.send(msg).await {
                            eprintln!("[FeishuWS] Ping send error: {}", e);
                            break;
                        }
                    }
                    _ = stop_rx_ping.changed() => {
                        break;
                    }
                }
            }
        });

        // Read loop
        let mut read = read;
        let disconnect_reason;

        'read_loop: loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            seq_counter += 1;
                            if let Err(e) = handle_binary_frame(
                                &data,
                                &app,
                                &state,
                                &write,
                            ).await {
                                eprintln!("[FeishuWS] Frame error: {}", e);
                            }
                        }
                        Some(Ok(tungstenite::Message::Close(frame))) => {
                            disconnect_reason = format!("Server closed: {:?}", frame);
                            break 'read_loop;
                        }
                        Some(Ok(_)) => {
                            // Text or other frames — ignore
                        }
                        Some(Err(e)) => {
                            disconnect_reason = format!("Read error: {}", e);
                            break 'read_loop;
                        }
                        None => {
                            disconnect_reason = "Stream ended".into();
                            break 'read_loop;
                        }
                    }
                }
                _ = stop_rx.changed() => {
                    disconnect_reason = "Stopped by user".into();
                    break 'read_loop;
                }
            }
        }

        // Cleanup
        ping_handle.abort();
        eprintln!("[FeishuWS] Disconnected: {}", disconnect_reason);

        {
            let mut s = state.status.lock().await;
            s.connected = false;
            s.connecting = false;
        }
        emit_status(&app, &state).await;

        if *stop_rx.borrow() {
            break;
        }

        // Reconnect delay with jitter
        let jitter = (config.reconnect_nonce as f64 * rand_f64()) as u64;
        let delay = config.reconnect_interval + jitter;
        eprintln!("[FeishuWS] Reconnecting in {}s...", delay);

        if wait_or_stop(&mut stop_rx, delay).await {
            break;
        }
        reconnect_attempts += 1;

        // Check reconnect limit
        if config.reconnect_count >= 0
            && reconnect_attempts >= config.reconnect_count as u32
        {
            let msg = format!(
                "Reconnect limit reached ({})",
                config.reconnect_count
            );
            set_error(&state, &msg).await;
            emit_status(&app, &state).await;
            break;
        }
    }

    // Final cleanup
    {
        let mut s = state.status.lock().await;
        s.connected = false;
        s.connecting = false;
    }
    emit_status(&app, &state).await;
    eprintln!("[FeishuWS] Connection loop ended");
}

async fn handle_binary_frame(
    data: &[u8],
    app: &AppHandle,
    state: &Arc<WsState>,
    write: &Arc<tokio::sync::Mutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tungstenite::Message,
        >,
    >>,
) -> Result<(), String> {
    let frame =
        Frame::decode(data).map_err(|e| format!("Protobuf decode error: {}", e))?;

    let msg_type = frame.get_header("type").unwrap_or("");

    match msg_type {
        "pong" => {
            // Server pong — check for config update in payload
            // (we don't dynamically update config in this impl)
        }
        "event" | "card" => {
            // Extract payload JSON
            if let Some(payload_bytes) = &frame.payload {
                let payload_str = String::from_utf8_lossy(payload_bytes);
                eprintln!(
                    "[FeishuWS] Event received (type={}): {}",
                    msg_type,
                    &payload_str[..payload_str.len().min(200)]
                );

                // Parse as JSON
                match serde_json::from_str::<serde_json::Value>(&payload_str) {
                    Ok(payload) => {
                        // Only forward message events, skip message_read/recalled/etc.
                        let event_type = payload
                            .get("header")
                            .and_then(|h| h.get("event_type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        if event_type != "im.message.receive_v1" {
                            eprintln!("[FeishuWS] Skipping non-message event: {}", event_type);
                        } else {
                            // ── create_time filter: skip events older than 5 minutes ──
                            let now_ms = now_millis();
                            let is_stale = is_stale_event(&payload, now_ms);

                            if is_stale {
                                // Stale event — ACK will still be sent below, but don't emit
                            } else {
                                // ── Dedup by message_id with 30-min TTL sliding window ──
                                dedup_and_emit(&payload, state, app, now_ms).await;
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[FeishuWS] Payload parse error: {}", e);
                    }
                }
            }

            // Send acknowledgment
            let ack = build_ack_frame(frame.seq_id, frame.log_id);
            let msg = tungstenite::Message::Binary(ack.into());
            if let Err(e) = write.lock().await.send(msg).await {
                eprintln!("[FeishuWS] Ack send error: {}", e);
            }
        }
        _ => {
            // Unknown type — log and ignore
            eprintln!("[FeishuWS] Unknown frame type: {}", msg_type);
        }
    }

    Ok(())
}

// ── Dedup & staleness helpers ──

/// 30-minute TTL for dedup entries (aligned with OpenClaw / industry practice)
const DEDUP_TTL_MS: u64 = 30 * 60 * 1000;
/// Events older than 5 minutes are considered stale (reconnect replay)
const STALE_EVENT_MS: u64 = 5 * 60 * 1000;

fn now_millis() -> u64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Check if a Feishu event's create_time is older than STALE_EVENT_MS.
fn is_stale_event(payload: &serde_json::Value, now_ms: u64) -> bool {
    let create_time_str = payload
        .get("header")
        .and_then(|h| h.get("create_time"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if create_time_str.is_empty() {
        return false;
    }

    if let Ok(create_ms) = create_time_str.parse::<u64>() {
        if now_ms > create_ms && now_ms - create_ms > STALE_EVENT_MS {
            eprintln!(
                "[FeishuWS] Stale event skipped (age={}s, create_time={})",
                (now_ms - create_ms) / 1000,
                create_time_str,
            );
            return true;
        }
    }

    false
}

/// Dedup by business message_id with TTL sliding window, then emit if fresh.
async fn dedup_and_emit(
    payload: &serde_json::Value,
    state: &Arc<WsState>,
    app: &AppHandle,
    now_ms: u64,
) {
    let biz_msg_id = payload
        .get("event")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.get("message_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !biz_msg_id.is_empty() {
        let mut seen = state.seen_messages.lock().await;

        // Check if already processed within TTL window
        if let Some(&seen_at) = seen.get(biz_msg_id) {
            if now_ms - seen_at < DEDUP_TTL_MS {
                eprintln!("[FeishuWS] Duplicate biz message skipped: {}", biz_msg_id);
                return;
            }
        }

        // Record this message
        seen.insert(biz_msg_id.to_string(), now_ms);

        // Lazy GC: remove entries older than TTL
        if seen.len() > 100 {
            seen.retain(|_, &mut t| now_ms - t < DEDUP_TTL_MS);
        }
    }

    let event_data = serde_json::json!({
        "platform": "feishu",
        "payload": payload
    });
    let _ = app.emit("im-inbound-event", event_data);
}

// ── Utility functions ──

async fn set_error(state: &Arc<WsState>, err: &str) {
    let mut s = state.status.lock().await;
    s.error = Some(err.to_string());
    s.connecting = false;
}

async fn emit_status(app: &AppHandle, state: &Arc<WsState>) {
    let s = state.status.lock().await;
    let _ = app.emit("feishu-ws-status", s.clone());
}

/// Wait for `secs` seconds or until stop signal. Returns true if stopped.
async fn wait_or_stop(stop_rx: &mut watch::Receiver<bool>, secs: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => false,
        _ = stop_rx.changed() => true,
    }
}

/// Simple pseudo-random f64 in [0, 1)
fn rand_f64() -> f64 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    (nanos % 1000) as f64 / 1000.0
}

// ── Tauri commands ──

#[tauri::command]
pub async fn start_feishu_ws(
    app: AppHandle,
    app_id: String,
    app_secret: String,
) -> Result<(), String> {
    let state = get_or_init_state();

    // Idempotent: if already running, return Ok
    {
        let s = state.status.lock().await;
        if s.connected || s.connecting {
            eprintln!("[FeishuWS] Already running, skipping duplicate start");
            return Ok(());
        }
    }

    // Reset stop signal
    let _ = state.stop_tx.send(false);

    // NOTE: Do NOT clear seen_messages here — preserving them across
    // reconnects prevents old-message replay (industry best practice).

    let state_clone = state.clone();
    tokio::spawn(async move {
        run_connection(app, app_id, app_secret, state_clone).await;
    });

    // Wait briefly for initial status
    tokio::time::sleep(Duration::from_millis(100)).await;

    Ok(())
}

#[tauri::command]
pub async fn stop_feishu_ws() -> Result<(), String> {
    let state = get_or_init_state();
    let _ = state.stop_tx.send(true);
    eprintln!("[FeishuWS] Stop signal sent");
    Ok(())
}

#[tauri::command]
pub async fn get_feishu_ws_status() -> Result<WsStatus, String> {
    let state = get_or_init_state();
    let s = state.status.lock().await;
    Ok(s.clone())
}
