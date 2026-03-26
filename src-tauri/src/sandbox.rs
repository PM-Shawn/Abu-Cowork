//! macOS Seatbelt (sandbox-exec) integration for OS-level isolation.
//!
//! Uses a **whitelist (deny-default) model**: everything is denied unless
//! explicitly allowed. This is defense-in-depth independent of TS-side checks.
//!
//! Allowed categories:
//! - Process: exec, fork, signals, mach IPC, sysctl
//! - File read: broadly allowed, except sensitive paths (~/.ssh, ~/.aws, etc.)
//! - File write: only CWD + /tmp + explicitly granted paths
//! - Network: allowed (Phase 2 will add proxy-based network isolation)

use std::process::Command as StdCommand;

/// Sensitive paths under $HOME that should never be readable.
/// Maintained independently from TS pathSafety.ts (defense in depth).
const SENSITIVE_READ_PATHS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".gpg",
    ".aws/credentials",
    ".azure",
    ".config/gcloud",
    ".env",
    ".env.local",
    ".env.production",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".docker/config.json",
    ".kube/config",
    ".git-credentials",
    ".password-store",
    "Library/Keychains",
];

/// Generate a Seatbelt Profile Language (SBPL) configuration string.
///
/// Whitelist model — `(deny default)` base with explicit allows:
/// - Process/IPC/sysctl: broadly allowed (commands need to run)
/// - File read: broadly allowed, sensitive home paths denied
/// - File write: only CWD, /tmp, /dev, and extra_writable_paths
/// - Network: if `network_proxy_port` is Some, deny all outbound except localhost
pub fn generate_seatbelt_profile(
    cwd: Option<&str>,
    extra_writable_paths: &[String],
    home_dir: &str,
    network_proxy_port: Option<u16>,
) -> String {
    let mut profile = String::with_capacity(4096);

    // ── Base: deny everything by default ──
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n\n");

    // ── Process operations ──
    // Commands need to execute binaries, fork, send signals
    profile.push_str(";; Process operations\n");
    profile.push_str("(allow process*)\n");
    profile.push_str("(allow signal)\n\n");

    // ── Mach IPC ──
    // Critical for macOS — almost every program needs mach lookups
    // (DNS resolution, dyld, system services, etc.)
    profile.push_str(";; Mach IPC (required by most macOS programs)\n");
    profile.push_str("(allow mach*)\n\n");

    // ── System info ──
    profile.push_str(";; System info queries\n");
    profile.push_str("(allow sysctl*)\n\n");

    // ── POSIX IPC ──
    profile.push_str(";; POSIX IPC (pipes, shared memory, semaphores)\n");
    profile.push_str("(allow ipc-posix*)\n");
    profile.push_str("(allow ipc-sysv*)\n\n");

    // ── Pseudo-TTY ──
    profile.push_str(";; Terminal operations\n");
    profile.push_str("(allow pseudo-tty)\n\n");

    // ── Network ──
    if let Some(_port) = network_proxy_port {
        // Network isolation: deny all outbound, only allow localhost (proxy lives there)
        profile.push_str(";; Network: isolated — only localhost allowed (proxy)\n");
        profile.push_str("(deny network-outbound)\n");
        profile.push_str("(allow network-outbound (remote ip \"localhost:*\"))\n");
        profile.push_str("(allow network-inbound)\n");
        profile.push_str("(allow system-socket)\n\n");
    } else {
        // No network isolation
        profile.push_str(";; Network: unrestricted\n");
        profile.push_str("(allow network*)\n\n");
    }

    // ── File reads: broadly allow, then deny sensitive paths ──
    profile.push_str(";; File reads: allow most, deny sensitive paths\n");
    profile.push_str("(allow file-read*)\n");

    for sensitive in SENSITIVE_READ_PATHS {
        let full_path = format!("{}/{}", home_dir, sensitive);
        let escaped = escape_sbpl_path(&full_path);
        profile.push_str(&format!("(deny file-read* (subpath \"{}\"))\n", escaped));
    }
    profile.push('\n');

    // ── File writes: deny by default (from deny default), allow specific ──
    profile.push_str(";; File writes: only specific directories\n");
    profile.push_str("(allow file-write* (subpath \"/tmp\"))\n");
    profile.push_str("(allow file-write* (subpath \"/private/tmp\"))\n");
    profile.push_str("(allow file-write* (subpath \"/dev\"))\n");
    profile.push_str("(allow file-write* (subpath \"/private/var\"))\n");

    // CWD — the working directory is writable
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            let escaped = escape_sbpl_path(dir);
            profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escaped));
        }
    }

    // Extra writable paths (e.g. process_image output directory)
    for path in extra_writable_paths {
        if !path.is_empty() {
            let escaped = escape_sbpl_path(path);
            profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escaped));
        }
    }

    // ── File ioctl (some programs need this) ──
    profile.push_str("\n;; File ioctl\n");
    profile.push_str("(allow file-ioctl)\n");

    profile
}

/// Escape special characters in path strings for SBPL.
fn escape_sbpl_path(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build a command that may be wrapped with macOS sandbox-exec.
///
/// On macOS with sandbox_enabled=true:
///   `sandbox-exec -p <profile> /bin/bash -lc <command>`
///
/// When `network_proxy_port` is Some, the Seatbelt profile blocks all outbound
/// network except localhost, and HTTP_PROXY/HTTPS_PROXY env vars are injected
/// to route traffic through the local proxy.
pub fn build_sandboxed_command(
    command: &str,
    cwd: Option<&str>,
    extra_writable_paths: &[String],
    sandbox_enabled: bool,
    network_proxy_port: Option<u16>,
) -> StdCommand {
    #[cfg(target_os = "macos")]
    {
        if sandbox_enabled {
            let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            let profile =
                generate_seatbelt_profile(cwd, extra_writable_paths, &home_dir, network_proxy_port);

            let mut cmd = StdCommand::new("sandbox-exec");
            cmd.args(["-p", &profile]);

            // Use the user's shell inside the sandbox
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            cmd.args([&shell, "-lc", command]);

            // Inject proxy env vars for network isolation
            if let Some(port) = network_proxy_port {
                let proxy_url = format!("http://127.0.0.1:{}", port);
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("ALL_PROXY", &proxy_url);
                // Don't proxy localhost traffic
                cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");
                cmd.env("no_proxy", "localhost,127.0.0.1,::1");
            }

            return cmd;
        }
    }

    // Windows: PowerShell with optional ConstrainedLanguage sandbox
    #[cfg(target_os = "windows")]
    {
        if sandbox_enabled {
            let mut cmd = StdCommand::new("powershell");

            let mut wrapped = String::with_capacity(command.len() + 256);

            // ConstrainedLanguage mode: blocks .NET reflection, COM objects, Add-Type
            wrapped
                .push_str("$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ");

            // Execute user command
            wrapped.push_str(command);

            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Restricted",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &wrapped,
            ]);

            // 隐藏 PowerShell 窗口 (CREATE_NO_WINDOW)
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }

            // Network isolation via proxy
            if let Some(port) = network_proxy_port {
                let proxy_url = format!("http://127.0.0.1:{}", port);
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("ALL_PROXY", &proxy_url);
                cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");
                cmd.env("no_proxy", "localhost,127.0.0.1,::1");
            }

            return cmd;
        }

        let _ = (cwd, extra_writable_paths);
        let mut cmd = StdCommand::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            command,
        ]);

        // 隐藏 PowerShell 窗口 (CREATE_NO_WINDOW)
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        return cmd;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (extra_writable_paths, sandbox_enabled, network_proxy_port);
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = StdCommand::new(&shell);
        cmd.args(["-lc", command]);
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_uses_deny_default_base() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(profile.contains("(version 1)"));
        assert!(profile.contains("(deny default)"));
        // Must NOT contain (allow default)
        assert!(!profile.contains("(allow default)"));
    }

    #[test]
    fn profile_allows_required_operations() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(profile.contains("(allow process*)"));
        assert!(profile.contains("(allow signal)"));
        assert!(profile.contains("(allow mach*)"));
        assert!(profile.contains("(allow sysctl*)"));
        assert!(profile.contains("(allow ipc-posix*)"));
        assert!(profile.contains("(allow pseudo-tty)"));
        assert!(profile.contains("(allow network*)"));
        assert!(profile.contains("(allow file-read*)"));
        assert!(profile.contains("(allow file-ioctl)"));
    }

    #[test]
    fn profile_denies_sensitive_read_paths() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(profile.contains("(deny file-read* (subpath \"/Users/test/.ssh\"))"));
        assert!(profile.contains("(deny file-read* (subpath \"/Users/test/.env\"))"));
        assert!(profile.contains("(deny file-read* (subpath \"/Users/test/.aws/credentials\"))"));
        assert!(profile.contains("(deny file-read* (subpath \"/Users/test/.gnupg\"))"));
        assert!(profile.contains("(deny file-read* (subpath \"/Users/test/.password-store\"))"));
    }

    #[test]
    fn profile_does_not_deny_shell_configs() {
        // Shell configs (.bashrc, .zshrc, etc.) are NOT in SENSITIVE_READ_PATHS
        // because shells need to read them on startup with -l (login shell)
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(!profile.contains(".bashrc"));
        assert!(!profile.contains(".zshrc"));
        assert!(!profile.contains(".bash_profile"));
    }

    #[test]
    fn profile_allows_cwd_write() {
        let profile =
            generate_seatbelt_profile(Some("/Users/test/project"), &[], "/Users/test", None);
        assert!(profile.contains("(allow file-write* (subpath \"/Users/test/project\"))"));
    }

    #[test]
    fn profile_allows_extra_writable_paths() {
        let extra = vec!["/Users/test/output".to_string()];
        let profile =
            generate_seatbelt_profile(Some("/Users/test/project"), &extra, "/Users/test", None);
        assert!(profile.contains("(allow file-write* (subpath \"/Users/test/output\"))"));
    }

    #[test]
    fn profile_allows_tmp_write() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(profile.contains("(allow file-write* (subpath \"/tmp\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/private/tmp\"))"));
    }

    #[test]
    fn profile_no_cwd_does_not_panic() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(profile.contains("(version 1)"));
        assert!(profile.contains("(deny default)"));
        // No CWD write rule should appear
        assert!(!profile.contains("subpath \"\""));
    }

    #[test]
    fn profile_escapes_special_chars() {
        let profile =
            generate_seatbelt_profile(Some("/Users/test/my \"project\""), &[], "/Users/test", None);
        assert!(profile.contains("my \\\"project\\\""));
    }

    #[test]
    fn build_command_without_sandbox() {
        let cmd = build_sandboxed_command("echo hello", None, &[], false, None);
        let program = cmd.get_program().to_string_lossy().to_string();
        #[cfg(target_os = "windows")]
        assert!(program.contains("powershell"));
        #[cfg(not(target_os = "windows"))]
        {
            assert!(
                program.contains("sh") || program.contains("zsh"),
                "Expected shell program, got: {}",
                program
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_command_with_sandbox_uses_sandbox_exec() {
        let cmd = build_sandboxed_command("echo hello", Some("/tmp/test"), &[], true, None);
        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(program, "sandbox-exec");
    }

    #[test]
    fn profile_network_isolated() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", Some(18080));
        assert!(profile.contains("(deny network-outbound)"));
        assert!(profile.contains("(allow network-outbound (remote ip \"localhost:*\"))"));
        assert!(profile.contains("(allow system-socket)"));
        // Should NOT contain unrestricted network
        assert!(!profile.contains("(allow network*)\n"));
    }

    #[test]
    fn profile_network_unrestricted() {
        let profile = generate_seatbelt_profile(None, &[], "/Users/test", None);
        assert!(profile.contains("(allow network*)"));
        assert!(!profile.contains("(deny network-outbound)"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_command_with_network_isolation_sets_proxy_env() {
        let cmd = build_sandboxed_command("echo hello", Some("/tmp/test"), &[], true, Some(18080));
        let envs: Vec<_> = cmd.get_envs().collect();
        let has_proxy = envs.iter().any(|(k, v)| {
            *k == "HTTP_PROXY"
                && v.map(|v| v.to_str().unwrap_or(""))
                    .unwrap_or("")
                    .contains("18080")
        });
        assert!(has_proxy, "HTTP_PROXY env var should contain proxy port");
    }
}
