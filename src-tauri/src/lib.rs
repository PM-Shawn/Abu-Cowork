use std::collections::HashMap;
use std::process::{Child, Command as StdCommand, Stdio};
use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};
use std::thread;
use std::sync::{Arc, Mutex};
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};

mod sandbox;
mod proxy;
mod trigger_server;
mod feishu_ws;
mod window_info;
mod computer_use;

/// Maximum number of output lines to collect from a shell command.
/// Prevents OOM when commands produce unbounded output.
const MAX_OUTPUT_LINES: usize = 10_000;

/// Detect sandbox violations in command output and prepend a friendly message.
/// Returns the annotated stderr if a violation is detected, otherwise returns it unchanged.
fn annotate_sandbox_violations(stderr: &str, command: &str, sandbox_enabled: bool) -> String {
    if !sandbox_enabled || stderr.is_empty() {
        return stderr.to_string();
    }

    let stderr_lower = stderr.to_lowercase();
    let mut reasons = Vec::new();

    // File system violations
    if stderr_lower.contains("operation not permitted") {
        if stderr_lower.contains("read") || command.contains("cat ") || command.contains("less ")
            || command.contains("head ") || command.contains("tail ")
        {
            reasons.push("file read blocked by sandbox policy");
        } else {
            reasons.push("file write or network access blocked by sandbox policy");
        }
    }

    // Network violations
    if stderr_lower.contains("could not resolve host") {
        reasons.push("DNS resolution blocked — network isolation is active");
    }
    if stderr_lower.contains("sandbox-network-blocked") {
        reasons.push("domain not in network whitelist");
    }

    // Permission denied (may come from sandbox)
    if stderr_lower.contains("permission denied") && !stderr_lower.contains("sudo") {
        reasons.push("access denied — possibly blocked by sandbox policy");
    }

    if reasons.is_empty() {
        return stderr.to_string();
    }

    let reason_text = reasons.join("; ");
    format!(
        "[sandbox-blocked] {}\n\n{}",
        reason_text, stderr
    )
}

#[derive(serde::Serialize)]
pub struct CommandOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to ABU.", name)
}

#[tauri::command]
async fn run_shell_command(
    command: String,
    cwd: Option<String>,
    background: Option<bool>,
    timeout: Option<u64>,
    sandbox_enabled: Option<bool>,
    extra_writable_paths: Option<Vec<String>>,
    network_isolation: Option<bool>,
) -> Result<CommandOutput, String> {
    let is_background = background.unwrap_or(false);
    let timeout_secs = timeout.unwrap_or(30).min(300); // default 30s, max 300s
    let is_sandboxed = sandbox_enabled.unwrap_or(true);
    let cmd_for_annotation = command.clone();

    async_runtime::spawn_blocking(move || {
        let extra_paths = extra_writable_paths.unwrap_or_default();
        let proxy_port = if network_isolation.unwrap_or(false) {
            proxy::get_proxy_port()
        } else {
            None
        };
        let mut cmd = sandbox::build_sandboxed_command(
            &command,
            cwd.as_deref(),
            &extra_paths,
            sandbox_enabled.unwrap_or(true),
            proxy_port,
        );

        // Inject enhanced PATH
        #[cfg(target_os = "windows")]
        if let Some(path) = get_enhanced_path_windows() {
            cmd.env("PATH", &path);
        }
        #[cfg(not(target_os = "windows"))]
        if let Some(path) = get_login_shell_path() {
            cmd.env("PATH", &path);
        }

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(ref dir) = cwd {
            cmd.current_dir(dir);
        }

        if is_background {
            // 后台模式：启动进程，等待几秒收集初始输出后返回
            let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {}", e))?;

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let stdout_lines = Arc::new(Mutex::new(Vec::new()));
            let stderr_lines = Arc::new(Mutex::new(Vec::new()));

            // 启动线程读取 stdout
            let stdout_lines_clone = Arc::clone(&stdout_lines);
            if let Some(out) = stdout {
                thread::spawn(move || {
                    let reader = BufReader::new(out);
                    for line in reader.lines().map_while(Result::ok) {
                        if let Ok(mut lines) = stdout_lines_clone.lock() {
                            if lines.len() >= MAX_OUTPUT_LINES {
                                lines.push(format!("[truncated: exceeded {} lines]", MAX_OUTPUT_LINES));
                                break;
                            }
                            lines.push(line);
                        }
                    }
                });
            }

            // 启动线程读取 stderr
            let stderr_lines_clone = Arc::clone(&stderr_lines);
            if let Some(err) = stderr {
                thread::spawn(move || {
                    let reader = BufReader::new(err);
                    for line in reader.lines().map_while(Result::ok) {
                        if let Ok(mut lines) = stderr_lines_clone.lock() {
                            if lines.len() >= MAX_OUTPUT_LINES {
                                lines.push(format!("[truncated: exceeded {} lines]", MAX_OUTPUT_LINES));
                                break;
                            }
                            lines.push(line);
                        }
                    }
                });
            }

            // 等待最多 3 秒收集输出，或者进程提前结束
            let start = Instant::now();
            let wait_duration = Duration::from_secs(3);

            loop {
                // 检查进程是否已结束
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // 进程已结束，稍等一下让输出线程收集完
                        thread::sleep(Duration::from_millis(100));
                        let stdout_result = stdout_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        let stderr_result = stderr_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        return Ok(CommandOutput {
                            stdout: stdout_result,
                            stderr: stderr_result,
                            code: status.code().unwrap_or(-1),
                        });
                    }
                    Ok(None) => {
                        // 进程仍在运行
                        if start.elapsed() >= wait_duration {
                            // 时间到，返回已收集的输出，进程继续后台运行
                            let stdout_result = stdout_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                            let stderr_result = stderr_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                            return Ok(CommandOutput {
                                stdout: if stdout_result.is_empty() && stderr_result.is_empty() {
                                    "服务已在后台启动".to_string()
                                } else {
                                    stdout_result
                                },
                                stderr: stderr_result,
                                code: 0, // 进程仍在运行，返回 0 表示成功启动
                            });
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => return Err(format!("Error checking process status: {}", e)),
                }
            }
        } else {
            // 前台模式：spawn + try_wait 循环，支持超时
            let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {}", e))?;

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let stdout_lines = Arc::new(Mutex::new(Vec::new()));
            let stderr_lines = Arc::new(Mutex::new(Vec::new()));

            // 启动线程读取 stdout
            let stdout_lines_clone = Arc::clone(&stdout_lines);
            if let Some(out) = stdout {
                thread::spawn(move || {
                    let reader = BufReader::new(out);
                    for line in reader.lines().map_while(Result::ok) {
                        if let Ok(mut lines) = stdout_lines_clone.lock() {
                            if lines.len() >= MAX_OUTPUT_LINES {
                                lines.push(format!("[truncated: exceeded {} lines]", MAX_OUTPUT_LINES));
                                break;
                            }
                            lines.push(line);
                        }
                    }
                });
            }

            // 启动线程读取 stderr
            let stderr_lines_clone = Arc::clone(&stderr_lines);
            if let Some(err) = stderr {
                thread::spawn(move || {
                    let reader = BufReader::new(err);
                    for line in reader.lines().map_while(Result::ok) {
                        if let Ok(mut lines) = stderr_lines_clone.lock() {
                            if lines.len() >= MAX_OUTPUT_LINES {
                                lines.push(format!("[truncated: exceeded {} lines]", MAX_OUTPUT_LINES));
                                break;
                            }
                            lines.push(line);
                        }
                    }
                });
            }

            let start = Instant::now();
            let timeout_duration = Duration::from_secs(timeout_secs);

            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        thread::sleep(Duration::from_millis(100));
                        let stdout_result = stdout_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        let stderr_result = stderr_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        return Ok(CommandOutput {
                            stdout: stdout_result,
                            stderr: stderr_result,
                            code: status.code().unwrap_or(-1),
                        });
                    }
                    Ok(None) => {
                        if start.elapsed() >= timeout_duration {
                            // 超时，kill 进程并返回部分输出
                            let _ = child.kill();
                            let _ = child.wait();
                            thread::sleep(Duration::from_millis(100));
                            let stdout_result = stdout_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                            let stderr_result = stderr_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                            return Ok(CommandOutput {
                                stdout: stdout_result,
                                stderr: format!("{}\n[Command timed out after {}s and was killed]", stderr_result, timeout_secs),
                                code: -1,
                            });
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => return Err(format!("Error checking process status: {}", e)),
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map(|mut output| {
        output.stderr = annotate_sandbox_violations(
            &output.stderr,
            &cmd_for_annotation,
            is_sandboxed,
        );
        output
    })
}

#[derive(serde::Serialize, Clone)]
struct CommandOutputLine {
    stream: String,  // "stdout" or "stderr"
    line: String,
}

#[tauri::command]
async fn run_shell_command_streaming(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
    timeout: Option<u64>,
    event_id: String,
    sandbox_enabled: Option<bool>,
    extra_writable_paths: Option<Vec<String>>,
    network_isolation: Option<bool>,
) -> Result<CommandOutput, String> {
    let timeout_secs = timeout.unwrap_or(30).min(300);
    let is_sandboxed_s = sandbox_enabled.unwrap_or(true);
    let cmd_for_annotation_s = command.clone();

    async_runtime::spawn_blocking(move || {
        let extra_paths = extra_writable_paths.unwrap_or_default();
        let proxy_port = if network_isolation.unwrap_or(false) {
            proxy::get_proxy_port()
        } else {
            None
        };
        let mut cmd = sandbox::build_sandboxed_command(
            &command,
            cwd.as_deref(),
            &extra_paths,
            sandbox_enabled.unwrap_or(true),
            proxy_port,
        );

        // Inject enhanced PATH
        #[cfg(target_os = "windows")]
        if let Some(path) = get_enhanced_path_windows() {
            cmd.env("PATH", &path);
        }
        #[cfg(not(target_os = "windows"))]
        if let Some(path) = get_login_shell_path() {
            cmd.env("PATH", &path);
        }

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(ref dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {}", e))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stdout_lines = Arc::new(Mutex::new(Vec::new()));
        let stderr_lines = Arc::new(Mutex::new(Vec::new()));

        // Stream stdout lines via Tauri events
        let stdout_lines_clone = Arc::clone(&stdout_lines);
        let app_clone = app.clone();
        let event_id_clone = event_id.clone();
        if let Some(out) = stdout {
            thread::spawn(move || {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = app_clone.emit(&format!("abu://command-output-{}", event_id_clone), CommandOutputLine {
                        stream: "stdout".to_string(),
                        line: line.clone(),
                    });
                    if let Ok(mut lines) = stdout_lines_clone.lock() {
                        if lines.len() >= MAX_OUTPUT_LINES {
                            lines.push(format!("[truncated: exceeded {} lines]", MAX_OUTPUT_LINES));
                            break;
                        }
                        lines.push(line);
                    }
                }
            });
        }

        // Stream stderr lines via Tauri events
        let stderr_lines_clone = Arc::clone(&stderr_lines);
        let app_clone2 = app.clone();
        let event_id_clone2 = event_id.clone();
        if let Some(err) = stderr {
            thread::spawn(move || {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = app_clone2.emit(&format!("abu://command-output-{}", event_id_clone2), CommandOutputLine {
                        stream: "stderr".to_string(),
                        line: line.clone(),
                    });
                    if let Ok(mut lines) = stderr_lines_clone.lock() {
                        if lines.len() >= MAX_OUTPUT_LINES {
                            lines.push(format!("[truncated: exceeded {} lines]", MAX_OUTPUT_LINES));
                            break;
                        }
                        lines.push(line);
                    }
                }
            });
        }

        let start = Instant::now();
        let timeout_duration = Duration::from_secs(timeout_secs);

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    thread::sleep(Duration::from_millis(100));
                    let stdout_result = stdout_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                    let stderr_result = stderr_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                    return Ok(CommandOutput {
                        stdout: stdout_result,
                        stderr: stderr_result,
                        code: status.code().unwrap_or(-1),
                    });
                }
                Ok(None) => {
                    if start.elapsed() >= timeout_duration {
                        let _ = child.kill();
                        let _ = child.wait();
                        thread::sleep(Duration::from_millis(100));
                        let stdout_result = stdout_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        let stderr_result = stderr_lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        return Ok(CommandOutput {
                            stdout: stdout_result,
                            stderr: format!("{}\n[Command timed out after {}s and was killed]", stderr_result, timeout_secs),
                            code: -1,
                        });
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("Error checking process status: {}", e)),
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map(|mut output| {
        output.stderr = annotate_sandbox_violations(
            &output.stderr,
            &cmd_for_annotation_s,
            is_sandboxed_s,
        );
        output
    })
}

// =============================================================
// Shell PATH resolution — macOS desktop apps launched from
// Dock/Finder don't inherit the terminal's full PATH, so
// commands like npx, node, python etc. can't be found.
// We resolve the full PATH from the user's login shell once.
// =============================================================

#[cfg(not(target_os = "windows"))]
fn get_login_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    use std::io::Read;
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        // Use -ilc (interactive + login) so that .zshrc/.bashrc are sourced.
        // Many tools (nvm, fnm, volta, Homebrew) add PATH entries in .zshrc,
        // which -lc (login-only, non-interactive) would skip.
        // Use unique markers to reliably extract PATH from potentially noisy output.
        const MARKER: &str = "__ABU_PATH__";
        let echo_cmd = format!("echo {0}$PATH{0}", MARKER);

        let mut child = StdCommand::new(&shell)
            .args(["-ilc", &echo_cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        let stdout = child.stdout.take()?;

        // Read stdout in a background thread so we can apply a timeout
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = BufReader::new(stdout).read_to_string(&mut buf);
            let _ = tx.send(buf);
        });

        // Wait up to 8s — nvm/conda init in .zshrc can be slow
        let raw = match rx.recv_timeout(std::time::Duration::from_secs(8)) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("[Abu PATH] Login shell timed out after 8s, using fallback PATH");
                let _ = child.kill();
                String::new()
            }
        };
        let _ = child.wait(); // reap zombie

        // Extract PATH between markers to ignore shell noise (motd, hooks, etc.)
        if let Some(start) = raw.find(MARKER) {
            let after = &raw[start + MARKER.len()..];
            if let Some(end) = after.find(MARKER) {
                let path = after[..end].trim().to_string();
                if !path.is_empty() {
                    eprintln!("[Abu PATH] Resolved from login shell: {}", &path);
                    return Some(path);
                }
            }
        }

        // Fallback: inherited PATH + common tool directories
        let base = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

        let mut extra_dirs: Vec<String> = vec![
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
            "/opt/homebrew/sbin".to_string(),
            format!("{}/.volta/bin", home),
            format!("{}/.cargo/bin", home),
            format!("{}/.local/bin", home),
        ];

        // nvm: glob for the latest installed node version
        let nvm_base = format!("{}/.nvm/versions/node", home);
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            // Collect version dirs sorted descending, pick the latest
            let mut versions: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                extra_dirs.push(format!("{}/{}/bin", nvm_base, latest));
            }
        }

        // Deduplicate: only add dirs not already in base PATH
        let base_set: std::collections::HashSet<&str> = base.split(':').collect();
        let mut merged = base.clone();
        for dir in &extra_dirs {
            if !base_set.contains(dir.as_str()) && std::path::Path::new(dir).exists() {
                merged.push(':');
                merged.push_str(dir);
            }
        }

        eprintln!("[Abu PATH] Using fallback PATH: {}", &merged);
        Some(merged)
    }).clone()
}

/// On Windows, enhance the process PATH by merging user-level PATH from the registry.
/// Desktop apps launched from Start Menu usually inherit system PATH, but tools
/// installed via nvm-windows, scoop, or volta may only modify user-level PATH
/// (HKCU\Environment\Path) which might not be inherited.
#[cfg(target_os = "windows")]
fn get_enhanced_path_windows() -> Option<String> {
    use std::sync::OnceLock;
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED.get_or_init(|| {
        let current_path = std::env::var("PATH").unwrap_or_default();

        // Try to read user-level PATH from registry
        let user_path = read_user_path_from_registry().unwrap_or_default();

        if user_path.is_empty() {
            if current_path.is_empty() {
                return None;
            }
            return Some(current_path);
        }

        // Merge: add user PATH entries that aren't already in the current PATH
        let current_entries: std::collections::HashSet<String> = current_path
            .split(';')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        let mut merged = current_path.clone();
        for entry in user_path.split(';') {
            let trimmed = entry.trim();
            if !trimmed.is_empty() && !current_entries.contains(&trimmed.to_lowercase()) {
                merged.push(';');
                merged.push_str(trimmed);
            }
        }

        Some(merged)
    }).clone()
}

/// Read the user-level PATH from Windows registry (HKCU\Environment\Path)
#[cfg(target_os = "windows")]
fn read_user_path_from_registry() -> Option<String> {
    let output = StdCommand::new("reg")
        .args(["query", "HKCU\\Environment", "/v", "Path"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    // Registry output format: "    Path    REG_SZ    value" or "    Path    REG_EXPAND_SZ    value"
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Path") || trimmed.starts_with("PATH") || trimmed.starts_with("path") {
            // Split on REG_SZ or REG_EXPAND_SZ
            if let Some(idx) = trimmed.find("REG_") {
                let after_type = &trimmed[idx..];
                // Skip past the type identifier (REG_SZ or REG_EXPAND_SZ)
                if let Some(val_start) = after_type.find("    ") {
                    let value = after_type[val_start..].trim();
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }
    None
}

// =============================================================
// MCP Process Management — long-running child processes for
// MCP Stdio transport (newline-delimited JSON-RPC over stdin/stdout)
// Protocol: each message is a JSON object followed by \n
// =============================================================

struct McpProcess {
    stdin: std::process::ChildStdin,
    child: Child,
}

#[derive(Default)]
struct McpState {
    processes: Mutex<HashMap<String, McpProcess>>,
}

/// Spawn an MCP server process and stream its stdout messages via Tauri events.
/// MCP uses newline-delimited JSON: each line is one JSON-RPC message.
#[tauri::command]
async fn mcp_spawn(
    app: AppHandle,
    state: tauri::State<'_, McpState>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    let mut cmd = StdCommand::new(&command);
    cmd.args(&args)
       .stdin(Stdio::piped())
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    // Inject enhanced PATH so commands like npx/node can be found
    if !env.contains_key("PATH") {
        #[cfg(not(target_os = "windows"))]
        if let Some(path) = get_login_shell_path() {
            cmd.env("PATH", &path);
        }
        #[cfg(target_os = "windows")]
        if let Some(path) = get_enhanced_path_windows() {
            cmd.env("PATH", &path);
        }
    }

    // Merge environment variables
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let path_info = std::env::var("PATH").unwrap_or_else(|_| "(unavailable)".to_string());
        eprintln!("[MCP] Failed to spawn '{}': {}. PATH={}", command, e, path_info);
        format!("Failed to spawn '{}': {}. Check that the command is installed and in your PATH.", command, e)
    })?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;

    // Store process atomically — check + insert under one lock
    {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        if processes.contains_key(&id) {
            let _ = child.kill();
            return Err(format!("MCP process '{}' already running", id));
        }
        processes.insert(id.clone(), McpProcess { stdin, child });
    }

    // Thread: read stdout line by line, each line is a JSON-RPC message
    let app_stdout = app.clone();
    let id_stdout = id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let _ = app_stdout.emit(&format!("mcp-msg-{}", id_stdout), trimmed);
                }
                Err(_) => break,
            }
        }
        let _ = app_stdout.emit(&format!("mcp-close-{}", id_stdout), "");
    });

    // Thread: read stderr line by line, emit as error events
    let app_stderr = app.clone();
    let id_stderr = id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_stderr.emit(&format!("mcp-err-{}", id_stderr), &line);
        }
    });

    Ok(())
}

/// Write a JSON-RPC message to an MCP process's stdin (newline-delimited JSON)
#[tauri::command]
async fn mcp_write(
    state: tauri::State<'_, McpState>,
    id: String,
    message: String,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let proc = processes.get_mut(&id).ok_or(format!("MCP process '{}' not found", id))?;

    proc.stdin.write_all(message.as_bytes()).map_err(|e| format!("stdin write error: {}", e))?;
    proc.stdin.write_all(b"\n").map_err(|e| format!("stdin write error: {}", e))?;
    proc.stdin.flush().map_err(|e| format!("stdin flush error: {}", e))?;

    Ok(())
}

/// Allowed environment variable name patterns for security.
/// Only variables matching these prefixes/names can be read from the frontend.
const ENV_VAR_ALLOWED_PREFIXES: &[&str] = &[
    "HOME", "USER", "LANG", "LC_", "PATH", "SHELL", "TERM",
    "TMPDIR", "XDG_",
    // Common tool/runtime vars that MCP configs legitimately reference
    "NODE_", "NPM_", "NVM_", "CARGO_", "RUSTUP_", "GOPATH", "GOROOT",
    "JAVA_HOME", "PYTHON", "VIRTUAL_ENV", "CONDA_",
    // API keys that users intentionally set for MCP server configs
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "GITHUB_TOKEN", "GITHUB_PERSONAL_TOKEN", "GH_TOKEN",
    "TAVILY_API_KEY", "BRAVE_API_KEY", "SERP_API_KEY",
    "FIRECRAWL_API_KEY", "EXA_API_KEY", "JINA_API_KEY",
    // MCP / Abu specific
    "ABU_", "MCP_", "CLAUDE_",
];

fn is_env_var_allowed(name: &str) -> bool {
    ENV_VAR_ALLOWED_PREFIXES.iter().any(|prefix| {
        if prefix.ends_with('_') {
            // Prefix match (e.g., "LC_" matches "LC_ALL")
            name.starts_with(prefix)
        } else {
            // Exact match
            name == *prefix
        }
    })
}

/// Get environment variables by name (filtered by allowlist)
#[tauri::command]
fn get_env_vars(names: Vec<String>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for name in names {
        if !is_env_var_allowed(&name) {
            continue;
        }
        if let Ok(val) = std::env::var(&name) {
            result.insert(name, val);
        }
    }
    result
}

/// Kill an MCP process
#[tauri::command]
async fn mcp_kill(
    state: tauri::State<'_, McpState>,
    id: String,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    if let Some(mut proc) = processes.remove(&id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

// ── Network proxy commands ──

/// Start the network isolation proxy. Returns the port.
#[tauri::command]
fn start_network_proxy(
    whitelist: Vec<String>,
    allow_private_networks: bool,
) -> Result<u16, String> {
    if proxy::get_proxy_port().is_some() {
        return Err("Proxy already running".to_string());
    }
    Ok(proxy::start_proxy(&whitelist, allow_private_networks))
}

/// Update the proxy whitelist at runtime.
#[tauri::command]
fn update_network_whitelist(
    whitelist: Vec<String>,
    allow_private_networks: bool,
) {
    proxy::update_whitelist(&whitelist, allow_private_networks);
}

/// Get the current proxy port (None if not started).
#[tauri::command]
fn get_network_proxy_port() -> Option<u16> {
    proxy::get_proxy_port()
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn app_exit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn window_hide(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn window_show(app: AppHandle) {
    show_main_window(&app);
}

/// IM channel status entry for tray menu display
#[derive(serde::Deserialize)]
struct IMTrayStatus {
    platform: String,
    label: String,
    sessions: u32,
}

/// Update the system tray menu with IM channel status.
/// Called from the frontend whenever IM channel state changes.
#[tauri::command]
fn update_tray_menu(app: AppHandle, im_channels: Vec<IMTrayStatus>, trigger_count: u32) {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return,
    };

    // Build menu items
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();

    // IM channel section (if any channels exist)
    if !im_channels.is_empty() {
        if let Ok(header) = MenuItem::with_id(&app, "im_header", "── IM ──", false, None::<&str>) {
            items.push(header);
        }
        for ch in &im_channels {
            let label = format!("  {} · {} sessions", ch.label, ch.sessions);
            if let Ok(item) = MenuItem::with_id(&app, format!("im_{}", ch.platform), label, false, None::<&str>) {
                items.push(item);
            }
        }
    }

    // Trigger count
    if trigger_count > 0 {
        let label = format!("⚡ {} triggers active", trigger_count);
        if let Ok(item) = MenuItem::with_id(&app, "triggers", label, false, None::<&str>) {
            items.push(item);
        }
    }

    // Separator + actions
    if let Ok(sep) = MenuItem::with_id(&app, "sep", "────────────", false, None::<&str>) {
        items.push(sep);
    }
    if let Ok(show) = MenuItem::with_id(&app, "show", "Show Abu / 显示窗口", true, None::<&str>) {
        items.push(show);
    }
    if let Ok(quit) = MenuItem::with_id(&app, "quit", "Quit / 退出", true, None::<&str>) {
        items.push(quit);
    }

    // Build menu from items
    let item_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    if let Ok(menu) = Menu::with_items(&app, &item_refs) {
        let _ = tray.set_menu(Some(menu));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(McpState::default())
        .setup(|app| {
            // Build tray menu — bilingual labels for cross-locale compatibility
            let show_item = MenuItem::with_id(app, "show", "Show Abu / 显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit / 退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Create tray icon with known ID for update_tray_menu
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("default window icon must be set in tauri.conf.json").clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            show_main_window(app);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            run_shell_command,
            run_shell_command_streaming,
            mcp_spawn,
            mcp_write,
            mcp_kill,
            get_env_vars,
            app_exit,
            window_hide,
            window_show,
            start_network_proxy,
            update_network_whitelist,
            get_network_proxy_port,
            window_info::get_active_window,
            computer_use::capture_screen,
            computer_use::mouse_click,
            computer_use::mouse_move,
            computer_use::mouse_scroll,
            computer_use::mouse_drag,
            computer_use::keyboard_type,
            computer_use::keyboard_press,
            computer_use::check_macos_permissions,
            computer_use::request_screen_recording,
            trigger_server::start_trigger_server,
            trigger_server::get_trigger_server_port,
            feishu_ws::start_feishu_ws,
            feishu_ws::stop_feishu_ws,
            feishu_ws::get_feishu_ws_status,
            update_tray_menu
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    show_main_window(app);
                }
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    // Kill all MCP child processes on app exit to prevent zombies
                    if let Some(state) = app.try_state::<McpState>() {
                        if let Ok(mut processes) = state.processes.lock() {
                            for (id, mut proc) in processes.drain() {
                                let _ = proc.child.kill();
                                let _ = proc.child.wait();
                                eprintln!("[MCP] Killed process on exit: {}", id);
                            }
                        }
                    }
                }
                _ => {}
            }
            let _ = (app, event);
        });
}
