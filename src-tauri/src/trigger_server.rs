//! Local HTTP trigger server for event-driven automation.
//!
//! Listens on `127.0.0.1` (localhost only) and accepts POST requests
//! to fire triggers. Events are forwarded to the frontend via Tauri events.
//!
//! Endpoints:
//! - `GET  /health`        — health check
//! - `POST /trigger/{id}`  — fire a trigger

use std::io::{BufRead, BufReader, Read as IoRead, Write};
use std::net::TcpListener;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// Trigger server listen port, set once at startup.
static TRIGGER_PORT: OnceLock<u16> = OnceLock::new();

/// Get the trigger server port (None if not started).
pub fn get_trigger_port() -> Option<u16> {
    TRIGGER_PORT.get().copied()
}

/// Start the trigger HTTP server on the given port.
/// If port is 0, an available port is chosen automatically.
/// Returns the actual port.
pub fn start_server(app: AppHandle, port: u16) -> Result<u16, String> {
    if TRIGGER_PORT.get().is_some() {
        return Err("Trigger server already running".into());
    }

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr)
        .map_err(|e| format!("Failed to bind {}: {}", addr, e))?;

    let actual_port = listener.local_addr().unwrap().port();
    TRIGGER_PORT.set(actual_port).ok();

    thread::spawn(move || {
        eprintln!("[TriggerServer] Listening on 127.0.0.1:{}", actual_port);
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || {
                if let Err(e) = handle_connection(stream, &app) {
                    eprintln!("[TriggerServer] Connection error: {}", e);
                }
            });
        }
    });

    Ok(actual_port)
}

// ── Connection handling ──

fn handle_connection(
    mut client: std::net::TcpStream,
    app: &AppHandle,
) -> std::io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(10)))?;

    let client_clone = client.try_clone()?;
    let mut reader = BufReader::new(client_clone);

    // Read request line: "POST /trigger/abc123 HTTP/1.1"
    let mut request_line = String::with_capacity(256);
    reader.read_line(&mut request_line)?;

    let parts: Vec<&str> = request_line.trim().splitn(3, ' ').collect();
    if parts.len() < 2 {
        return send_json(&mut client, 400, r#"{"success":false,"message":"Bad request"}"#);
    }

    let method = parts[0];
    let path = parts[1];

    // Read headers to get Content-Length
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            break;
        }
        let lower = line.to_lowercase();
        if lower.starts_with("content-length:") {
            if let Ok(len) = lower[15..].trim().parse::<usize>() {
                content_length = len;
            }
        }
    }

    // Route
    match (method, path) {
        ("GET", "/health") => {
            send_json(&mut client, 200, r#"{"status":"ok"}"#)
        }
        ("POST", p) if p.starts_with("/trigger/") => {
            let trigger_id = &p[9..]; // strip "/trigger/"
            if trigger_id.is_empty() {
                return send_json(&mut client, 400, r#"{"success":false,"message":"Missing trigger ID"}"#);
            }
            if trigger_id.len() > 64 || !trigger_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                return send_json(&mut client, 400, r#"{"success":false,"message":"Invalid trigger ID"}"#);
            }

            // Read body
            let body = if content_length > 0 {
                // Cap at 1MB to prevent abuse
                let len = content_length.min(1_048_576);
                let mut buf = vec![0u8; len];
                reader.read_exact(&mut buf)?;
                String::from_utf8_lossy(&buf).to_string()
            } else {
                "{}".to_string()
            };

            // Validate JSON
            let payload: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => {
                    return send_json(&mut client, 400, r#"{"success":false,"message":"Invalid JSON body"}"#);
                }
            };

            // Emit Tauri event to frontend
            let event_data = serde_json::json!({
                "triggerId": trigger_id,
                "payload": payload
            });

            match app.emit("trigger-http-event", event_data) {
                Ok(_) => {
                    let msg = format!(
                        r#"{{"success":true,"message":"Trigger {} fired"}}"#,
                        trigger_id
                    );
                    send_json(&mut client, 200, &msg)
                }
                Err(e) => {
                    let msg = format!(
                        r#"{{"success":false,"message":"Event emit failed: {}"}}"#,
                        e
                    );
                    send_json(&mut client, 500, &msg)
                }
            }
        }
        _ => {
            send_json(&mut client, 404, r#"{"success":false,"message":"Not found"}"#)
        }
    }
}

fn send_json(client: &mut std::net::TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
        code, reason, body.len(), body
    );
    client.write_all(response.as_bytes())?;
    client.flush()
}

// ── Tauri commands ──

#[tauri::command]
pub fn start_trigger_server(app: AppHandle, port: u16) -> Result<u16, String> {
    start_server(app, port)
}

#[tauri::command]
pub fn get_trigger_server_port() -> Option<u16> {
    get_trigger_port()
}
