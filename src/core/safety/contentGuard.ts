/**
 * Content Safety Scanner
 *
 * Regex-based static analysis for content that gets injected into prompts or
 * persisted as skills. Patterns ported from NousResearch/hermes-agent
 * `tools/skills_guard.py` (120 rules across 12 categories), plus an invisible-
 * unicode check that catches zero-width payload injection.
 *
 * ## Scope
 *
 * Used at two write boundaries:
 * - `memdir/write.ts` — when an agent persists a memory entry (→ system prompt)
 * - `skill_manage` (future) — when an agent creates/edits a skill (→ agent context)
 *
 * ## MVP policy (conservative)
 *
 * First version enforces only `critical` findings (→ verdict `dangerous` → block).
 * `high` maps to `caution`, which our default policy currently allows but surfaces
 * in the scan log. `medium` and `low` are tracked for future tuning but never
 * affect verdict. This matches the agreed "只打 critical + high, m/l 标记但不 block"
 * stance with a further step down: the initial cut only blocks `critical` so we
 * don't over-block during cold-start tuning. See `INSTALL_POLICY`.
 *
 * @see docs: project_self_evolving_skills_prd.md sections 2.4 / 2.5
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ThreatCategory =
  | 'exfiltration'
  | 'injection'
  | 'destructive'
  | 'persistence'
  | 'network'
  | 'obfuscation'
  | 'execution'
  | 'traversal'
  | 'mining'
  | 'supply_chain'
  | 'privilege_escalation'
  | 'credential_exposure';

export interface ThreatPattern {
  /** Stable identifier for bypass lists, telemetry, and tests. */
  id: string;
  severity: ThreatSeverity;
  category: ThreatCategory;
  regex: RegExp;
  /** Human-readable description shown in scan reports. */
  description: string;
}

export interface Finding {
  patternId: string;
  severity: ThreatSeverity;
  category: ThreatCategory;
  description: string;
  /** First 60 chars of the matched substring. */
  match: string;
  /** 1-based line number where the match starts. */
  line: number;
}

export type ScanVerdict = 'safe' | 'caution' | 'dangerous';

export interface ScanResult {
  verdict: ScanVerdict;
  findings: Finding[];
}

/** The context in which content is being written — drives install policy. */
export type ScanContext =
  | 'memory'
  | 'skill-create'
  | 'skill-patch'
  | 'draft';

export type InstallVerdict = 'allow' | 'warn' | 'block';

// ── Invisible unicode (zero-width payload injection) ────────────────────────

/**
 * Characters that render as empty but can carry prompt-injection payloads
 * across copy/paste boundaries. Any presence in scanned content is flagged
 * as a critical injection finding.
 */
export const INVISIBLE_UNICODE: ReadonlySet<string> = new Set([
  '\u200b', // zero-width space
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\u2060', // word joiner
  '\ufeff', // zero-width no-break space / BOM
  '\u202a', // LRE
  '\u202b', // RLE
  '\u202c', // pop directional formatting
  '\u202d', // LRO
  '\u202e', // RLO
]);

// ── Threat patterns (ported from Hermes skills_guard.py) ────────────────────

/* eslint-disable no-useless-escape */
export const THREAT_PATTERNS: ReadonlyArray<ThreatPattern> = [
  { id: 'env_exfil_curl', severity: 'critical', category: 'exfiltration', regex: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, description: 'curl command interpolating secret environment variable' },
  { id: 'env_exfil_wget', severity: 'critical', category: 'exfiltration', regex: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, description: 'wget command interpolating secret environment variable' },
  { id: 'env_exfil_fetch', severity: 'critical', category: 'exfiltration', regex: /fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i, description: 'fetch() call interpolating secret environment variable' },
  { id: 'env_exfil_httpx', severity: 'critical', category: 'exfiltration', regex: /httpx?\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i, description: 'HTTP library call with secret variable' },
  { id: 'env_exfil_requests', severity: 'critical', category: 'exfiltration', regex: /requests\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i, description: 'requests library call with secret variable' },
  { id: 'encoded_exfil', severity: 'high', category: 'exfiltration', regex: /base64[^\n]*env/i, description: 'base64 encoding combined with environment access' },
  { id: 'ssh_dir_access', severity: 'high', category: 'exfiltration', regex: /\$HOME\/\.ssh|\~\/\.ssh/i, description: 'references user SSH directory' },
  { id: 'aws_dir_access', severity: 'high', category: 'exfiltration', regex: /\$HOME\/\.aws|\~\/\.aws/i, description: 'references user AWS credentials directory' },
  { id: 'gpg_dir_access', severity: 'high', category: 'exfiltration', regex: /\$HOME\/\.gnupg|\~\/\.gnupg/i, description: 'references user GPG keyring' },
  { id: 'kube_dir_access', severity: 'high', category: 'exfiltration', regex: /\$HOME\/\.kube|\~\/\.kube/i, description: 'references Kubernetes config directory' },
  { id: 'docker_dir_access', severity: 'high', category: 'exfiltration', regex: /\$HOME\/\.docker|\~\/\.docker/i, description: 'references Docker config (may contain registry creds)' },
  { id: 'hermes_env_access', severity: 'critical', category: 'exfiltration', regex: /\$HOME\/\.hermes\/\.env|\~\/\.hermes\/\.env/i, description: 'directly references Hermes secrets file' },
  { id: 'read_secrets_file', severity: 'critical', category: 'exfiltration', regex: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, description: 'reads known secrets file' },
  { id: 'dump_all_env', severity: 'high', category: 'exfiltration', regex: /printenv|env\s*\|/i, description: 'dumps all environment variables' },
  { id: 'python_os_environ', severity: 'high', category: 'exfiltration', regex: /os\.environ\b(?!\s*\.get\s*\(\s*["\']PATH)/i, description: 'accesses os.environ (potential env dump)' },
  { id: 'python_getenv_secret', severity: 'critical', category: 'exfiltration', regex: /os\.getenv\s*\(\s*[^\)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, description: 'reads secret via os.getenv()' },
  { id: 'node_process_env', severity: 'high', category: 'exfiltration', regex: /process\.env\[/i, description: 'accesses process.env (Node.js environment)' },
  { id: 'ruby_env_secret', severity: 'critical', category: 'exfiltration', regex: /ENV\[.*(?:KEY|TOKEN|SECRET|PASSWORD)/i, description: 'reads secret via Ruby ENV[]' },
  { id: 'dns_exfil', severity: 'critical', category: 'exfiltration', regex: /\b(dig|nslookup|host)\s+[^\n]*\$/i, description: 'DNS lookup with variable interpolation (possible DNS exfiltration)' },
  { id: 'tmp_staging', severity: 'critical', category: 'exfiltration', regex: />\s*\/tmp\/[^\s]*\s*&&\s*(curl|wget|nc|python)/i, description: 'writes to /tmp then exfiltrates' },
  { id: 'md_image_exfil', severity: 'high', category: 'exfiltration', regex: /!\[.*\]\(https?:\/\/[^\)]*\$\{?/i, description: 'markdown image URL with variable interpolation (image-based exfil)' },
  { id: 'md_link_exfil', severity: 'high', category: 'exfiltration', regex: /\[.*\]\(https?:\/\/[^\)]*\$\{?/i, description: 'markdown link with variable interpolation' },
  { id: 'prompt_injection_ignore', severity: 'critical', category: 'injection', regex: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i, description: 'prompt injection: ignore previous instructions' },
  { id: 'role_hijack', severity: 'high', category: 'injection', regex: /you\s+are\s+(?:\w+\s+)*now\s+/i, description: "attempts to override the agent's role" },
  { id: 'deception_hide', severity: 'critical', category: 'injection', regex: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, description: 'instructs agent to hide information from user' },
  { id: 'sys_prompt_override', severity: 'critical', category: 'injection', regex: /system\s+prompt\s+override/i, description: 'attempts to override the system prompt' },
  { id: 'role_pretend', severity: 'high', category: 'injection', regex: /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i, description: 'attempts to make the agent assume a different identity' },
  { id: 'disregard_rules', severity: 'critical', category: 'injection', regex: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i, description: 'instructs agent to disregard its rules' },
  { id: 'leak_system_prompt', severity: 'high', category: 'injection', regex: /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i, description: 'attempts to extract the system prompt' },
  { id: 'conditional_deception', severity: 'high', category: 'injection', regex: /(when|if)\s+no\s*one\s+is\s+(watching|looking)/i, description: 'conditional instruction to behave differently when unobserved' },
  { id: 'bypass_restrictions', severity: 'critical', category: 'injection', regex: /act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don\'t\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)/i, description: 'instructs agent to act without restrictions' },
  { id: 'translate_execute', severity: 'critical', category: 'injection', regex: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, description: 'translate-then-execute evasion technique' },
  { id: 'html_comment_injection', severity: 'high', category: 'injection', regex: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, description: 'hidden instructions in HTML comments' },
  { id: 'hidden_div', severity: 'high', category: 'injection', regex: /<\s*div\s+style\s*=\s*["\'][\s\S]*?display\s*:\s*none/i, description: 'hidden HTML div (invisible instructions)' },
  { id: 'destructive_root_rm', severity: 'critical', category: 'destructive', regex: /rm\s+-rf\s+\//i, description: 'recursive delete from root' },
  { id: 'destructive_home_rm', severity: 'critical', category: 'destructive', regex: /rm\s+(-[^\s]*)?r.*\$HOME|\brmdir\s+.*\$HOME/i, description: 'recursive delete targeting home directory' },
  { id: 'insecure_perms', severity: 'medium', category: 'destructive', regex: /chmod\s+777/i, description: 'sets world-writable permissions' },
  { id: 'system_overwrite', severity: 'critical', category: 'destructive', regex: />\s*\/etc\//i, description: 'overwrites system configuration file' },
  { id: 'format_filesystem', severity: 'critical', category: 'destructive', regex: /\bmkfs\b/i, description: 'formats a filesystem' },
  { id: 'disk_overwrite', severity: 'critical', category: 'destructive', regex: /\bdd\s+.*if=.*of=\/dev\//i, description: 'raw disk write operation' },
  { id: 'python_rmtree', severity: 'high', category: 'destructive', regex: /shutil\.rmtree\s*\(\s*[\"\'\/]/i, description: 'Python rmtree on absolute or root-relative path' },
  { id: 'truncate_system', severity: 'critical', category: 'destructive', regex: /truncate\s+-s\s*0\s+\//i, description: 'truncates system file to zero bytes' },
  { id: 'persistence_cron', severity: 'medium', category: 'persistence', regex: /\bcrontab\b/i, description: 'modifies cron jobs' },
  { id: 'shell_rc_mod', severity: 'medium', category: 'persistence', regex: /\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)\b/i, description: 'references shell startup file' },
  { id: 'ssh_backdoor', severity: 'critical', category: 'persistence', regex: /authorized_keys/i, description: 'modifies SSH authorized keys' },
  { id: 'ssh_keygen', severity: 'medium', category: 'persistence', regex: /ssh-keygen/i, description: 'generates SSH keys' },
  { id: 'systemd_service', severity: 'medium', category: 'persistence', regex: /systemd.*\.service|systemctl\s+(enable|start)/i, description: 'references or enables systemd service' },
  { id: 'init_script', severity: 'medium', category: 'persistence', regex: /\/etc\/init\.d\//i, description: 'references init.d startup script' },
  { id: 'macos_launchd', severity: 'medium', category: 'persistence', regex: /launchctl\s+load|LaunchAgents|LaunchDaemons/i, description: 'macOS launch agent/daemon persistence' },
  { id: 'sudoers_mod', severity: 'critical', category: 'persistence', regex: /\/etc\/sudoers|visudo/i, description: 'modifies sudoers (privilege escalation)' },
  { id: 'git_config_global', severity: 'medium', category: 'persistence', regex: /git\s+config\s+--global\s+/i, description: 'modifies global git configuration' },
  { id: 'reverse_shell', severity: 'critical', category: 'network', regex: /\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b/i, description: 'potential reverse shell listener' },
  { id: 'tunnel_service', severity: 'high', category: 'network', regex: /\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i, description: 'uses tunneling service for external access' },
  { id: 'hardcoded_ip_port', severity: 'medium', category: 'network', regex: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/i, description: 'hardcoded IP address with port' },
  { id: 'bind_all_interfaces', severity: 'high', category: 'network', regex: /0\.0\.0\.0:\d+|INADDR_ANY/i, description: 'binds to all network interfaces' },
  { id: 'bash_reverse_shell', severity: 'critical', category: 'network', regex: /\/bin\/(ba)?sh\s+-i\s+.*>\/dev\/tcp\//i, description: 'bash interactive reverse shell via /dev/tcp' },
  { id: 'python_socket_oneliner', severity: 'critical', category: 'network', regex: /python[23]?\s+-c\s+["\']import\s+socket/i, description: 'Python one-liner socket connection (likely reverse shell)' },
  { id: 'python_socket_connect', severity: 'high', category: 'network', regex: /socket\.connect\s*\(\s*\(/i, description: 'Python socket connect to arbitrary host' },
  { id: 'exfil_service', severity: 'high', category: 'network', regex: /webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/i, description: 'references known data exfiltration/webhook testing service' },
  { id: 'paste_service', severity: 'medium', category: 'network', regex: /pastebin\.com|hastebin\.com|ghostbin\./i, description: 'references paste service (possible data staging)' },
  { id: 'base64_decode_pipe', severity: 'high', category: 'obfuscation', regex: /base64\s+(-d|--decode)\s*\|/i, description: 'base64 decodes and pipes to execution' },
  { id: 'hex_encoded_string', severity: 'medium', category: 'obfuscation', regex: /\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}/i, description: 'hex-encoded string (possible obfuscation)' },
  { id: 'eval_string', severity: 'high', category: 'obfuscation', regex: /\beval\s*\(\s*["\']/i, description: 'eval() with string argument' },
  { id: 'exec_string', severity: 'high', category: 'obfuscation', regex: /\bexec\s*\(\s*["\']/i, description: 'exec() with string argument' },
  { id: 'echo_pipe_exec', severity: 'critical', category: 'obfuscation', regex: /echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)/i, description: 'echo piped to interpreter for execution' },
  { id: 'python_compile_exec', severity: 'high', category: 'obfuscation', regex: /compile\s*\(\s*[^\)]+,\s*["\'].*["\']\s*,\s*["\']exec["\']\s*\)/i, description: 'Python compile() with exec mode' },
  { id: 'python_getattr_builtins', severity: 'high', category: 'obfuscation', regex: /getattr\s*\(\s*__builtins__/i, description: 'dynamic access to Python builtins (evasion technique)' },
  { id: 'python_import_os', severity: 'high', category: 'obfuscation', regex: /__import__\s*\(\s*["\']os["\']\s*\)/i, description: 'dynamic import of os module' },
  { id: 'python_codecs_decode', severity: 'medium', category: 'obfuscation', regex: /codecs\.decode\s*\(\s*["\']/i, description: 'codecs.decode (possible ROT13 or encoding obfuscation)' },
  { id: 'js_char_code', severity: 'medium', category: 'obfuscation', regex: /String\.fromCharCode|charCodeAt/i, description: 'JavaScript character code construction (possible obfuscation)' },
  { id: 'js_base64', severity: 'medium', category: 'obfuscation', regex: /atob\s*\(|btoa\s*\(/i, description: 'JavaScript base64 encode/decode' },
  { id: 'string_reversal', severity: 'low', category: 'obfuscation', regex: /\[::-1\]/i, description: 'string reversal (possible obfuscated payload)' },
  { id: 'chr_building', severity: 'high', category: 'obfuscation', regex: /chr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(\s*\d+/i, description: 'building string from chr() calls (obfuscation)' },
  { id: 'unicode_escape_chain', severity: 'medium', category: 'obfuscation', regex: /\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}/i, description: 'chain of unicode escapes (possible obfuscation)' },
  { id: 'python_subprocess', severity: 'medium', category: 'execution', regex: /subprocess\.(run|call|Popen|check_output)\s*\(/i, description: 'Python subprocess execution' },
  { id: 'python_os_system', severity: 'high', category: 'execution', regex: /os\.system\s*\(/i, description: 'os.system() — unguarded shell execution' },
  { id: 'python_os_popen', severity: 'high', category: 'execution', regex: /os\.popen\s*\(/i, description: 'os.popen() — shell pipe execution' },
  { id: 'node_child_process', severity: 'high', category: 'execution', regex: /child_process\.(exec|spawn|fork)\s*\(/i, description: 'Node.js child_process execution' },
  { id: 'java_runtime_exec', severity: 'high', category: 'execution', regex: /Runtime\.getRuntime\(\)\.exec\(/i, description: 'Java Runtime.exec() — shell execution' },
  { id: 'backtick_subshell', severity: 'medium', category: 'execution', regex: /`[^`]*\$\([^)]+\)[^`]*`/i, description: 'backtick string with command substitution' },
  { id: 'path_traversal_deep', severity: 'high', category: 'traversal', regex: /\.\.\/\.\.\/\.\./i, description: 'deep relative path traversal (3+ levels up)' },
  { id: 'path_traversal', severity: 'medium', category: 'traversal', regex: /\.\.\/\.\./i, description: 'relative path traversal (2+ levels up)' },
  { id: 'system_passwd_access', severity: 'critical', category: 'traversal', regex: /\/etc\/passwd|\/etc\/shadow/i, description: 'references system password files' },
  { id: 'proc_access', severity: 'high', category: 'traversal', regex: /\/proc\/self|\/proc\/\d+\//i, description: 'references /proc filesystem (process introspection)' },
  { id: 'dev_shm', severity: 'medium', category: 'traversal', regex: /\/dev\/shm\//i, description: 'references shared memory (common staging area)' },
  { id: 'crypto_mining', severity: 'critical', category: 'mining', regex: /xmrig|stratum\+tcp|monero|coinhive|cryptonight/i, description: 'cryptocurrency mining reference' },
  { id: 'mining_indicators', severity: 'medium', category: 'mining', regex: /hashrate|nonce.*difficulty/i, description: 'possible cryptocurrency mining indicators' },
  { id: 'curl_pipe_shell', severity: 'critical', category: 'supply_chain', regex: /curl\s+[^\n]*\|\s*(ba)?sh/i, description: 'curl piped to shell (download-and-execute)' },
  { id: 'wget_pipe_shell', severity: 'critical', category: 'supply_chain', regex: /wget\s+[^\n]*-O\s*-\s*\|\s*(ba)?sh/i, description: 'wget piped to shell (download-and-execute)' },
  { id: 'curl_pipe_python', severity: 'critical', category: 'supply_chain', regex: /curl\s+[^\n]*\|\s*python/i, description: 'curl piped to Python interpreter' },
  { id: 'pep723_inline_deps', severity: 'medium', category: 'supply_chain', regex: /#\s*\/\/\/\s*script.*dependencies/i, description: 'PEP 723 inline script metadata with dependencies (verify pinning)' },
  { id: 'unpinned_pip_install', severity: 'medium', category: 'supply_chain', regex: /pip\s+install\s+(?!-r\s)(?!.*==)/i, description: 'pip install without version pinning' },
  { id: 'unpinned_npm_install', severity: 'medium', category: 'supply_chain', regex: /npm\s+install\s+(?!.*@\d)/i, description: 'npm install without version pinning' },
  { id: 'uv_run', severity: 'medium', category: 'supply_chain', regex: /uv\s+run\s+/i, description: 'uv run (may auto-install unpinned dependencies)' },
  { id: 'remote_fetch', severity: 'medium', category: 'supply_chain', regex: /(curl|wget|httpx?\.get|requests\.get|fetch)\s*[\(]?\s*["\']https?:\/\//i, description: 'fetches remote resource at runtime' },
  { id: 'git_clone', severity: 'medium', category: 'supply_chain', regex: /git\s+clone\s+/i, description: 'clones a git repository at runtime' },
  { id: 'docker_pull', severity: 'medium', category: 'supply_chain', regex: /docker\s+pull\s+/i, description: 'pulls a Docker image at runtime' },
  { id: 'allowed_tools_field', severity: 'high', category: 'privilege_escalation', regex: /^allowed-tools\s*:/im, description: 'skill declares allowed-tools (pre-approves tool access)' },
  { id: 'sudo_usage', severity: 'high', category: 'privilege_escalation', regex: /\bsudo\b/i, description: 'uses sudo (privilege escalation)' },
  { id: 'setuid_setgid', severity: 'critical', category: 'privilege_escalation', regex: /setuid|setgid|cap_setuid/i, description: 'setuid/setgid (privilege escalation mechanism)' },
  { id: 'nopasswd_sudo', severity: 'critical', category: 'privilege_escalation', regex: /NOPASSWD/i, description: 'NOPASSWD sudoers entry (passwordless privilege escalation)' },
  { id: 'suid_bit', severity: 'critical', category: 'privilege_escalation', regex: /chmod\s+[u+]?s/i, description: 'sets SUID/SGID bit on a file' },
  { id: 'agent_config_mod', severity: 'critical', category: 'persistence', regex: /AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules/i, description: 'references agent config files (could persist malicious instructions across sessions)' },
  { id: 'hermes_config_mod', severity: 'critical', category: 'persistence', regex: /\.hermes\/config\.yaml|\.hermes\/SOUL\.md/i, description: 'references Hermes configuration files directly' },
  { id: 'other_agent_config', severity: 'high', category: 'persistence', regex: /\.claude\/settings|\.codex\/config/i, description: 'references other agent configuration files' },
  // NOTE (credential_exposure × memory writes): memdir/write.ts REDACTS
  // credential-shaped text via memdir/sanitize.ts BEFORE this scan runs, so
  // for the memory surface these patterns fire only on shapes the redactor
  // doesn't cover. That is deliberate — memory policy is redact-and-keep, not
  // block-and-lose (the model is told via the tool result). Other surfaces
  // (skills etc.) still see raw text here. Keep the two lists in mind when
  // adding patterns to either file.
  { id: 'hardcoded_secret', severity: 'critical', category: 'credential_exposure', regex: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["\'][A-Za-z0-9+\/=_-]{20,}/i, description: 'possible hardcoded API key, token, or secret' },
  { id: 'embedded_private_key', severity: 'critical', category: 'credential_exposure', regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, description: 'embedded private key' },
  { id: 'github_token_leaked', severity: 'critical', category: 'credential_exposure', regex: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}/i, description: 'GitHub personal access token in skill content' },
  { id: 'openai_key_leaked', severity: 'critical', category: 'credential_exposure', regex: /sk-[A-Za-z0-9]{20,}/i, description: 'possible OpenAI API key in skill content' },
  { id: 'anthropic_key_leaked', severity: 'critical', category: 'credential_exposure', regex: /sk-ant-[A-Za-z0-9_-]{90,}/i, description: 'possible Anthropic API key in skill content' },
  { id: 'aws_access_key_leaked', severity: 'critical', category: 'credential_exposure', regex: /AKIA[0-9A-Z]{16}/i, description: 'AWS access key ID in skill content' },
  { id: 'jailbreak_dan', severity: 'critical', category: 'injection', regex: /\bDAN\s+mode\b|Do\s+Anything\s+Now/i, description: 'DAN (Do Anything Now) jailbreak attempt' },
  { id: 'jailbreak_dev_mode', severity: 'critical', category: 'injection', regex: /\bdeveloper\s+mode\b.*\benabled?\b/i, description: 'developer mode jailbreak attempt' },
  { id: 'hypothetical_bypass', severity: 'high', category: 'injection', regex: /hypothetical\s+scenario.*(?:ignore|bypass|override)/i, description: 'hypothetical scenario used to bypass restrictions' },
  { id: 'educational_pretext', severity: 'medium', category: 'injection', regex: /for\s+educational\s+purposes?\s+only/i, description: 'educational pretext often used to justify harmful content' },
  { id: 'remove_filters', severity: 'critical', category: 'injection', regex: /(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)/i, description: 'instructs agent to respond without safety filters' },
  { id: 'fake_update', severity: 'high', category: 'injection', regex: /you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to/i, description: 'fake update/patch announcement (social engineering)' },
  { id: 'fake_policy', severity: 'medium', category: 'injection', regex: /new\s+policy|updated\s+guidelines|revised\s+instructions/i, description: 'claims new policy/guidelines (may be social engineering)' },
  { id: 'context_exfil', severity: 'high', category: 'exfiltration', regex: /(include|output|print|send|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|context)/i, description: 'instructs agent to output/share conversation history' },
  { id: 'send_to_url', severity: 'high', category: 'exfiltration', regex: /(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?:\/\//i, description: 'instructs agent to send data to a URL' },
];
/* eslint-enable no-useless-escape */

// ── Scanner ─────────────────────────────────────────────────────────────────

/** Count newlines before `index` — 1-based line number of the match. */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

/**
 * Scan `content` for all threat patterns + invisible unicode.
 *
 * Optional `bypass` is an allow-list of `patternId` strings; matched patterns
 * in the list are skipped entirely (useful for users with legitimate
 * false-positive cases, e.g. skills that intentionally discuss `rm -rf /tmp/X`).
 *
 * Verdict is derived conservatively (see INSTALL_POLICY comment at top):
 *   - any `critical` finding ⇒ `dangerous`
 *   - any `high` finding ⇒ `caution`
 *   - only `medium`/`low` findings ⇒ `safe` (findings still recorded)
 */
export function scanContent(
  content: string,
  options: { bypass?: ReadonlySet<string> } = {},
): ScanResult {
  const bypass = options.bypass ?? new Set<string>();
  const findings: Finding[] = [];

  // Invisible unicode check runs first — it's the cheapest and most reliable.
  for (const ch of INVISIBLE_UNICODE) {
    const idx = content.indexOf(ch);
    if (idx !== -1) {
      findings.push({
        patternId: 'invisible_unicode',
        severity: 'critical',
        category: 'injection',
        description: `invisible unicode character U+${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()} detected`,
        match: ch,
        line: lineOf(content, idx),
      });
      break; // one is sufficient to flag
    }
  }

  for (const pattern of THREAT_PATTERNS) {
    if (bypass.has(pattern.id)) continue;
    const m = pattern.regex.exec(content);
    if (!m) continue;
    findings.push({
      patternId: pattern.id,
      severity: pattern.severity,
      category: pattern.category,
      description: pattern.description,
      match: m[0].slice(0, 60),
      line: lineOf(content, m.index),
    });
  }

  let verdict: ScanVerdict = 'safe';
  if (findings.some((f) => f.severity === 'critical')) verdict = 'dangerous';
  else if (findings.some((f) => f.severity === 'high')) verdict = 'caution';

  return { verdict, findings };
}

// ── Install policy ──────────────────────────────────────────────────────────

/**
 * Per-context policy: for each verdict (safe / caution / dangerous), decide
 * whether the write is allowed, warns, or is blocked.
 *
 * MVP stance: `dangerous` always blocks. `caution` warns but allows — we
 * track the caution data for a cycle before deciding whether to block
 * certain contexts.
 */
const INSTALL_POLICY: Record<ScanContext, Record<ScanVerdict, InstallVerdict>> = {
  memory:         { safe: 'allow', caution: 'warn', dangerous: 'block' },
  'skill-create': { safe: 'allow', caution: 'warn', dangerous: 'block' },
  'skill-patch':  { safe: 'allow', caution: 'warn', dangerous: 'block' },
  draft:          { safe: 'allow', caution: 'warn', dangerous: 'block' },
};

/** Policy verdict for a given scan + write context. */
export function evaluate(scan: ScanResult, context: ScanContext): InstallVerdict {
  return INSTALL_POLICY[context][scan.verdict];
}

// ── Human-readable scan report (for agent error messages) ───────────────────

/**
 * Format a scan result as a structured error message for agent consumption.
 * Mirrors Hermes's `format_scan_report` layout: one line per finding with
 * severity / category / line / 60-char match excerpt.
 *
 * Kept intentionally machine-parseable (fixed columns, no markdown) so the
 * agent can reason about specific patterns to avoid in its re-write.
 */
export function formatScanReport(scan: ScanResult): string {
  if (scan.findings.length === 0) {
    return `Verdict: ${scan.verdict.toUpperCase()} (no findings)`;
  }

  const severityOrder: Record<ThreatSeverity, number> = {
    critical: 0, high: 1, medium: 2, low: 3,
  };
  const sorted = [...scan.findings].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
  );

  const lines = [`Verdict: ${scan.verdict.toUpperCase()} (${scan.findings.length} findings)`];
  for (const f of sorted) {
    const sev = f.severity.toUpperCase().padEnd(8);
    const cat = f.category.padEnd(22);
    const loc = `line ${f.line}`.padEnd(10);
    lines.push(`  ${sev} ${cat} ${loc} [${f.patternId}] "${f.match}"`);
  }
  return lines.join('\n');
}

// ── ContentSafetyError (throwable from callers) ─────────────────────────────

/**
 * Thrown by write-path callers (`writeMemory`, `skill_manage`) when scan
 * produces a blocking verdict. Carries the structured scan result so agents
 * and UI can inspect findings (pattern_id, line, match excerpt).
 */
export class ContentSafetyError extends Error {
  readonly scan: ScanResult;
  readonly context: ScanContext;

  constructor(scan: ScanResult, context: ScanContext, message?: string) {
    super(message ?? `Content blocked by safety scanner (${context}): ${formatScanReport(scan)}`);
    this.name = 'ContentSafetyError';
    this.scan = scan;
    this.context = context;
  }
}
