//! Local HTTP preview server for safe HTML rendering inside an iframe.
//!
//! ## Why this exists
//! WKWebView refuses to serve `asset://` (or any custom-scheme) sub-resources from
//! a sandboxed iframe. That made `<script src="./chart.js">` style relative refs
//! in previewed HTML unloadable, regardless of how `<base href>` is set. The
//! industry-standard escape hatch (used by VS Code's Live Preview, etc.) is a
//! loopback HTTP server: `http://` IS a standard scheme so sandbox composes
//! correctly. We mirror that here.
//!
//! ## Security model
//! - Bound to `127.0.0.1` (loopback only).
//! - Random kernel-assigned port (`bind(127.0.0.1:0)`).
//! - Per-launch token in URL; verified with `subtle::ConstantTimeEq`.
//! - `Host` header pinned to `127.0.0.1:PORT` or `localhost:PORT` (DNS rebinding).
//! - `Origin` header, if present, must be `null` or `http://127.0.0.1:PORT`.
//! - GET / HEAD only (else 405).
//! - Path canonicalization + allowed-root whitelist + blocklist.
//! - `Cache-Control: no-store` (agent may rewrite files at any time).
//! - `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`.
//!
//! ## Limitation
//! Token in URL path means absolute paths inside HTML (`<script src="/foo.js">`)
//! won't resolve (no token in resolved URL). AI-generated HTML should use
//! relative `./foo.js` style. This is acceptable for "preview" scope; future
//! "code dev" mode may switch to cookie-based auth.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio_util::io::ReaderStream;

/// Max number of simultaneously-registered roots before LRU eviction kicks in.
const MAX_ROOTS: usize = 16;

/// Hard-coded blocklist: even if a root allows it, these paths/extensions
/// are refused. Keep this list narrow — broad-scope guarding belongs in
/// `src/core/tools/pathSafety.ts` (frontend) which is the canonical source
/// for tool-write sensitivity. Server enforces a *minimum* floor so a buggy
/// frontend can't leak credentials via preview.
const BLOCKED_PATH_SEGMENTS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
];

const BLOCKED_FILE_PREFIXES: &[&str] = &[
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ed25519",
    "id_ecdsa",
];

const BLOCKED_FILE_EXTS: &[&str] = &["pem", "key", "p12", "pfx"];

/// The preview-tab element picker runtime, injected inline into every
/// `.html`/`.htm` response — see `inject_picker_script`. Sibling of
/// `abu-inspect.js` (the browser-tab picker); forked because the transport
/// differs (postMessage vs. Tauri `initialization_script` + invoke). See
/// `docs/2026-07-19-preview-element-select-design.md`.
const ABU_PREVIEW_INSPECT_JS: &str = include_str!("../inspect/abu-preview-inspect.js");

// ─── State ───────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct PreviewServerHandle {
    pub port: u16,
    pub token: Arc<String>,
    inner: Arc<PreviewServerInner>,
}

struct PreviewServerInner {
    /// `root_id` -> canonical filesystem path. Read-mostly; writes happen
    /// on register/unregister/evict.
    roots: RwLock<HashMap<String, PathBuf>>,
    /// LRU eviction order. Front = most recently accessed.
    access_order: RwLock<Vec<String>>,
}

/// Global handle — set once at startup so axum handlers (which can't easily
/// receive Tauri `State`) can reach the registry.
static SERVER: OnceLock<PreviewServerHandle> = OnceLock::new();

// ─── Lifecycle ───────────────────────────────────────────────────────────

/// Spawn the preview HTTP server. Idempotent — second call is a no-op
/// (returns the existing handle).
pub async fn start() -> Result<PreviewServerHandle, String> {
    if let Some(existing) = SERVER.get() {
        return Ok(existing.clone());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("preview server bind failed: {}", e))?;

    let addr = listener
        .local_addr()
        .map_err(|e| format!("preview server local_addr failed: {}", e))?;
    let port = addr.port();

    let token = generate_token();
    let inner = Arc::new(PreviewServerInner {
        roots: RwLock::new(HashMap::new()),
        access_order: RwLock::new(Vec::new()),
    });
    let handle = PreviewServerHandle {
        port,
        token: Arc::new(token),
        inner,
    };

    SERVER.set(handle.clone()).map_err(|_| "preview server SERVER already set")?;

    let router = build_router(handle.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[preview_server] serve loop ended: {}", e);
        }
    });

    eprintln!("[preview_server] listening on 127.0.0.1:{}", port);
    Ok(handle)
}

fn generate_token() -> String {
    // 32 url-safe characters from a v4 UUID's 128 random bits.
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    uuid
}

// ─── Router + middleware ─────────────────────────────────────────────────

fn build_router(handle: PreviewServerHandle) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        // axum 0.7 path-param syntax: `:name` for single segment, `*name` for
        // wildcard (catches the rest, can include '/'). The wildcard is what
        // makes relative URL resolution work: <script src="./sub/x.js"> in an
        // HTML at .../files/T/id/index.html resolves to .../files/T/id/sub/x.js
        // and routes here with rel_path = "sub/x.js".
        .route("/files/:token/:root_id/*rel_path", get(serve_file))
        .with_state(handle)
        .layer(middleware::from_fn(method_guard))
        .layer(middleware::from_fn(host_guard))
}

async fn healthz() -> &'static str {
    "ok"
}

/// 405 for anything other than GET / HEAD.
async fn method_guard(req: Request, next: Next) -> Response {
    let m = req.method().clone();
    if m == Method::GET || m == Method::HEAD {
        return next.run(req).await;
    }
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

/// `Host` must be `127.0.0.1:PORT` or `localhost:PORT` (DNS rebinding).
/// `Origin`, if present, must be `null` or `http://127.0.0.1:PORT`.
async fn host_guard(req: Request, next: Next) -> Response {
    let port = match SERVER.get() {
        Some(s) => s.port,
        None => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let expected_127 = format!("127.0.0.1:{}", port);
    let expected_localhost = format!("localhost:{}", port);

    if let Some(host) = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()) {
        if host != expected_127 && host != expected_localhost {
            return (StatusCode::MISDIRECTED_REQUEST, "bad host").into_response();
        }
    }

    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let expected_origin = format!("http://127.0.0.1:{}", port);
        let expected_origin_localhost = format!("http://localhost:{}", port);
        if origin != "null"
            && origin != expected_origin
            && origin != expected_origin_localhost
        {
            return (StatusCode::FORBIDDEN, "bad origin").into_response();
        }
    }

    next.run(req).await
}

// ─── HTML picker script injection ───────────────────────────────────────

/// Case-insensitive byte-window scan for an ASCII `needle` in `haystack`,
/// returning the byte index of the LAST occurrence (or `None`).
///
/// UTF-8 safe without decoding: ASCII bytes are always `< 0x80`, while every
/// byte of a multibyte UTF-8 sequence (lead or continuation) is `>= 0x80`.
/// An ASCII needle can therefore never partially match inside a multibyte
/// codepoint, so a plain byte-window comparison is correct — no risk of
/// slicing a CJK character in half or producing a spurious match.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let hay = haystack.as_bytes();
    let pat = needle.as_bytes();
    let nlen = pat.len();
    if nlen == 0 || hay.len() < nlen {
        return None;
    }
    let mut found = None;
    let mut i = 0;
    while i + nlen <= hay.len() {
        if hay[i..i + nlen].eq_ignore_ascii_case(pat) {
            found = Some(i);
        }
        i += 1;
    }
    found
}

/// Wrap `ABU_PREVIEW_INSPECT_JS` in a `<script>` tag and splice it into
/// `html`: immediately before the last `</body>` (case-insensitive); if
/// absent, before the last `</html>`; if neither is present, appended at
/// the end. Byte-slicing on `find_ci`'s index is safe per its doc comment.
fn inject_picker_script(html: &str) -> String {
    let script_tag = format!("<script>{}</script>", ABU_PREVIEW_INSPECT_JS);

    let insert_at = find_ci(html, "</body>").or_else(|| find_ci(html, "</html>"));

    match insert_at {
        Some(idx) => {
            let mut out = String::with_capacity(html.len() + script_tag.len());
            out.push_str(&html[..idx]);
            out.push_str(&script_tag);
            out.push_str(&html[idx..]);
            out
        }
        None => {
            let mut out = String::with_capacity(html.len() + script_tag.len());
            out.push_str(html);
            out.push_str(&script_tag);
            out
        }
    }
}

// ─── File handler ────────────────────────────────────────────────────────

async fn serve_file(
    State(handle): State<PreviewServerHandle>,
    axum::extract::Path((token, root_id, rel_path)): axum::extract::Path<(String, String, String)>,
) -> Response {
    // 1. Token check — constant-time to avoid timing oracle.
    if !verify_token(&handle.token, &token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // 2. Look up root path and bump LRU.
    let root_path = match handle.lookup_root(&root_id) {
        Some(p) => p,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    // 3. Decode + canonicalize rel_path under root.
    let target = match resolve_path(&root_path, &rel_path) {
        Ok(p) => p,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    // 4. Blocklist check on the *canonical* path (defeats symlink tricks).
    if is_blocked(&target, &root_path) {
        return StatusCode::FORBIDDEN.into_response();
    }

    // 5. Stat. We refuse directories — preview is file-only.
    let metadata = match tokio::fs::metadata(&target).await {
        Ok(m) => m,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if !metadata.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }

    // 6. Content-Type via mime_guess; nosniff guards against type confusion.
    let mut mime = mime_guess::from_path(&target)
        .first_or_octet_stream()
        .to_string();
    // Text responses must declare UTF-8, otherwise a webview/browser on a
    // locale like zh-CN falls back to GBK and mojibakes CJK content.
    if mime.starts_with("text/") && !mime.contains("charset") {
        mime.push_str("; charset=utf-8");
    }

    let is_html = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
        .unwrap_or(false);

    // 7. Body. HTML gets buffered + the picker script spliced in — this
    // can't stream, since injection changes the byte length. Every other
    // file type keeps the original zero-copy streaming path (file handle
    // only opened here, not in the HTML branch).
    let (body, len) = if is_html {
        let bytes = match tokio::fs::read(&target).await {
            Ok(b) => b,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };
        let html_str = String::from_utf8_lossy(&bytes);
        let injected = inject_picker_script(&html_str);
        // Content-Length MUST be recomputed from the injected bytes, not
        // the on-disk metadata length — otherwise the response is
        // truncated at the original file size and the tail (our injected
        // script, or the closing tags) never reaches the client. This is
        // exactly the class of bug the charset=utf-8 fix above guards
        // against in spirit: silent, locale/content-dependent corruption.
        let len = injected.len() as u64;
        (Body::from(injected), len)
    } else {
        let file = match tokio::fs::File::open(&target).await {
            Ok(f) => f,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };
        (Body::from_stream(ReaderStream::new(file)), metadata.len())
    };

    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header_value(&mime));
    headers.insert(header::CONTENT_LENGTH, header_value(&len.to_string()));
    headers.insert(header::CACHE_CONTROL, header_value("no-store"));
    headers.insert("x-content-type-options", header_value("nosniff"));
    // Response-level `sandbox` CSP enforces sandboxing even if someone opens
    // the URL directly (e.g. in a browser). Deliberately omits `frame-ancestors`
    // and X-Frame-Options: the legitimate parent (Tauri webview) is cross-origin
    // with the loopback server, and the other defenses (loopback, token,
    // Origin/Host check) are sufficient against cross-site framing.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header_value("sandbox allow-scripts allow-same-origin allow-forms allow-popups"),
    );

    response
}

fn header_value(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

// ─── Token / path / blocklist helpers ────────────────────────────────────

fn verify_token(expected: &str, actual: &str) -> bool {
    // Length-mismatch is OK to leak (URL is in plaintext anyway).
    if expected.len() != actual.len() {
        return false;
    }
    expected.as_bytes().ct_eq(actual.as_bytes()).into()
}

/// Decode each segment, join under root, canonicalize, and verify it stays
/// within the root (defeats `../` and symlink-out-of-root attacks).
fn resolve_path(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    // Reject empty / absolute / parent-component path attempts pre-decode.
    // axum already decodes %xx, but we double-check segments.
    let mut joined = root.to_path_buf();
    for raw_seg in rel.split('/') {
        if raw_seg.is_empty() {
            return Err(PathError::BadSegment);
        }
        let decoded = urlencoding::decode(raw_seg).map_err(|_| PathError::BadSegment)?;
        let seg = decoded.as_ref();
        if seg == "." || seg == ".." {
            return Err(PathError::BadSegment);
        }
        // No backslash in any segment — blocks Windows-style traversal even on Unix.
        if seg.contains('\\') || seg.contains('\0') {
            return Err(PathError::BadSegment);
        }
        joined.push(seg);
    }

    // Canonicalize both (resolves symlinks). If target doesn't exist, this
    // returns Err; that's fine — we map it to NotFound.
    let canon_target = std::fs::canonicalize(&joined).map_err(|_| PathError::NotFound)?;
    let canon_root = std::fs::canonicalize(root).map_err(|_| PathError::NotFound)?;
    if !canon_target.starts_with(&canon_root) {
        return Err(PathError::Escape);
    }
    Ok(canon_target)
}

#[derive(Debug, PartialEq, Eq)]
enum PathError {
    BadSegment,
    NotFound,
    Escape,
}

fn is_blocked(target: &Path, root: &Path) -> bool {
    // We check the part of `target` that lies UNDER `root` only. Files in
    // `root/.env` are blocked, but if root happens to be inside a path
    // that contains `.ssh` (e.g. `/Users/x/proj-.ssh-archive/`), that ancestor
    // segment is irrelevant.
    let rel = match target.strip_prefix(root) {
        Ok(p) => p,
        Err(_) => return true, // shouldn't happen post-canon, fail closed
    };

    for component in rel.components() {
        if let Component::Normal(name) = component {
            let s = match name.to_str() {
                Some(s) => s,
                None => return true, // non-UTF8 — be safe, reject
            };
            // Directory segment matches blocked list?
            if BLOCKED_PATH_SEGMENTS.iter().any(|b| s.eq_ignore_ascii_case(b)) {
                return true;
            }
            // File-prefix list (only matters on the leaf — but checking each
            // segment is fine: directories starting with `.env` are rare and
            // arguably also worth blocking).
            if BLOCKED_FILE_PREFIXES
                .iter()
                .any(|b| s.to_ascii_lowercase().starts_with(&b.to_ascii_lowercase()))
            {
                return true;
            }
        }
    }

    // Extension on the leaf.
    if let Some(ext) = target.extension().and_then(|e| e.to_str()) {
        let lower = ext.to_ascii_lowercase();
        if BLOCKED_FILE_EXTS.iter().any(|b| *b == lower) {
            return true;
        }
    }

    false
}

// ─── Root registry ───────────────────────────────────────────────────────

impl PreviewServerHandle {
    /// Insert a root and return a stable id derived from its canonical path.
    /// LRU evicts the oldest if we exceed MAX_ROOTS.
    pub fn register_root(&self, path: PathBuf) -> Result<String, String> {
        let canon = std::fs::canonicalize(&path)
            .map_err(|e| format!("canonicalize {:?} failed: {}", path, e))?;
        let id = root_id_from_path(&canon);

        {
            let mut roots = self.inner.roots.write().unwrap();
            let mut order = self.inner.access_order.write().unwrap();

            if roots.contains_key(&id) {
                // Bump LRU.
                order.retain(|x| x != &id);
                order.insert(0, id.clone());
                return Ok(id);
            }

            roots.insert(id.clone(), canon);
            order.insert(0, id.clone());

            // Evict if over cap.
            while roots.len() > MAX_ROOTS {
                if let Some(victim) = order.pop() {
                    roots.remove(&victim);
                } else {
                    break;
                }
            }
        }

        Ok(id)
    }

    pub fn unregister_root(&self, id: &str) -> bool {
        let mut roots = self.inner.roots.write().unwrap();
        let mut order = self.inner.access_order.write().unwrap();
        order.retain(|x| x != id);
        roots.remove(id).is_some()
    }

    fn lookup_root(&self, id: &str) -> Option<PathBuf> {
        let path = {
            let roots = self.inner.roots.read().unwrap();
            roots.get(id).cloned()?
        };
        // Bump LRU on access.
        let mut order = self.inner.access_order.write().unwrap();
        order.retain(|x| x != id);
        order.insert(0, id.to_string());
        Some(path)
    }

}

fn root_id_from_path(canon: &Path) -> String {
    // Stable, URL-safe, short-ish id. We use SHA-like hashing via std DefaultHasher
    // — collision-resistance isn't critical here; we just need uniqueness within
    // an app lifetime and the path is the actual authority.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    canon.hash(&mut hasher);
    let h = hasher.finish();
    format!("{:x}", h)
}

// ─── Tauri commands ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PreviewServerInfo {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn get_preview_server_info() -> Result<PreviewServerInfo, String> {
    let handle = SERVER.get().ok_or_else(|| "preview server not started".to_string())?;
    Ok(PreviewServerInfo {
        port: handle.port,
        token: handle.token.as_ref().clone(),
    })
}

#[tauri::command]
pub fn register_preview_root(path: String) -> Result<String, String> {
    let handle = SERVER.get().ok_or_else(|| "preview server not started".to_string())?;
    handle.register_root(PathBuf::from(path))
}

#[tauri::command]
pub fn unregister_preview_root(root_id: String) -> Result<bool, String> {
    let handle = SERVER.get().ok_or_else(|| "preview server not started".to_string())?;
    Ok(handle.unregister_root(&root_id))
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_handle() -> PreviewServerHandle {
        PreviewServerHandle {
            port: 12345,
            token: Arc::new("testtoken".to_string()),
            inner: Arc::new(PreviewServerInner {
                roots: RwLock::new(HashMap::new()),
                access_order: RwLock::new(Vec::new()),
            }),
        }
    }

    #[test]
    fn token_constant_time() {
        assert!(verify_token("abcd", "abcd"));
        assert!(!verify_token("abcd", "abce"));
        assert!(!verify_token("abcd", "abc")); // length mismatch
        assert!(!verify_token("abcd", "abcde"));
    }

    #[test]
    fn resolve_simple() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("foo.html");
        fs::write(&file, "ok").unwrap();
        let resolved = resolve_path(dir.path(), "foo.html").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn resolve_nested() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        let file = dir.path().join("sub/bar.css");
        fs::write(&file, "x{}").unwrap();
        let resolved = resolve_path(dir.path(), "sub/bar.css").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn resolve_rejects_dotdot() {
        let dir = TempDir::new().unwrap();
        let err = resolve_path(dir.path(), "../etc/passwd").unwrap_err();
        assert_eq!(err, PathError::BadSegment);
    }

    #[test]
    fn resolve_rejects_dot() {
        let dir = TempDir::new().unwrap();
        let err = resolve_path(dir.path(), "./foo").unwrap_err();
        assert_eq!(err, PathError::BadSegment);
    }

    #[test]
    fn resolve_rejects_empty_segment() {
        let dir = TempDir::new().unwrap();
        let err = resolve_path(dir.path(), "foo//bar").unwrap_err();
        assert_eq!(err, PathError::BadSegment);
    }

    #[test]
    fn resolve_rejects_backslash() {
        let dir = TempDir::new().unwrap();
        let err = resolve_path(dir.path(), "foo\\bar").unwrap_err();
        assert_eq!(err, PathError::BadSegment);
    }

    #[test]
    fn resolve_handles_unicode() {
        let dir = TempDir::new().unwrap();
        let cn = dir.path().join("中文.html");
        fs::write(&cn, "你好").unwrap();
        let resolved = resolve_path(dir.path(), "%E4%B8%AD%E6%96%87.html").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&cn).unwrap());
    }

    #[test]
    fn resolve_handles_spaces() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("with space.html");
        fs::write(&f, "x").unwrap();
        let resolved = resolve_path(dir.path(), "with%20space.html").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn resolve_symlink_out_of_root() {
        // Skip on Windows in tests — symlink creation requires elevated privs.
        #[cfg(not(target_os = "windows"))]
        {
            let outer = TempDir::new().unwrap();
            let inner = TempDir::new().unwrap();
            fs::write(inner.path().join("secret.txt"), "shh").unwrap();
            // outer/link -> inner
            std::os::unix::fs::symlink(inner.path(), outer.path().join("link")).unwrap();
            // Try to escape through the symlink.
            let err = resolve_path(outer.path(), "link/secret.txt").unwrap_err();
            assert_eq!(err, PathError::Escape);
        }
    }

    #[test]
    fn block_dot_env() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join(".env");
        fs::write(&f, "SECRET=x").unwrap();
        let canon_file = std::fs::canonicalize(&f).unwrap();
        let canon_root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(is_blocked(&canon_file, &canon_root));
    }

    #[test]
    fn block_ssh_dir() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".ssh")).unwrap();
        let f = dir.path().join(".ssh/id_rsa");
        fs::write(&f, "key").unwrap();
        let canon_file = std::fs::canonicalize(&f).unwrap();
        let canon_root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(is_blocked(&canon_file, &canon_root));
    }

    #[test]
    fn block_pem_extension() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("cert.pem");
        fs::write(&f, "----").unwrap();
        let canon_file = std::fs::canonicalize(&f).unwrap();
        let canon_root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(is_blocked(&canon_file, &canon_root));
    }

    #[test]
    fn allow_normal_html() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("report.html");
        fs::write(&f, "<html></html>").unwrap();
        let canon_file = std::fs::canonicalize(&f).unwrap();
        let canon_root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(!is_blocked(&canon_file, &canon_root));
    }

    #[test]
    fn register_root_idempotent() {
        let dir = TempDir::new().unwrap();
        let h = make_handle();
        let id1 = h.register_root(dir.path().to_path_buf()).unwrap();
        let id2 = h.register_root(dir.path().to_path_buf()).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn register_root_lru_evict() {
        let h = make_handle();
        let mut ids = Vec::new();
        let mut dirs = Vec::new();
        for _ in 0..(MAX_ROOTS + 3) {
            let d = TempDir::new().unwrap();
            ids.push(h.register_root(d.path().to_path_buf()).unwrap());
            dirs.push(d);
        }
        // First 3 should have been evicted (we inserted MAX_ROOTS+3).
        for id in &ids[..3] {
            assert!(h.lookup_root(id).is_none(), "id {} should be evicted", id);
        }
        for id in &ids[3..] {
            assert!(h.lookup_root(id).is_some(), "id {} should still be present", id);
        }
    }

    #[test]
    fn unregister_returns_true_when_present() {
        let dir = TempDir::new().unwrap();
        let h = make_handle();
        let id = h.register_root(dir.path().to_path_buf()).unwrap();
        assert!(h.unregister_root(&id));
        assert!(!h.unregister_root(&id));
    }

    // ─── HTML picker script injection ────────────────────────────────────

    #[test]
    fn find_ci_basic_and_case_insensitive() {
        assert_eq!(find_ci("<html><BODY>x</BODY></html>", "</body>"), Some(13));
        assert_eq!(find_ci("no closing tag here", "</body>"), None);
        assert_eq!(find_ci("", "</body>"), None);
    }

    #[test]
    fn find_ci_returns_last_occurrence() {
        // Two literal "</body>" substrings — the real closing tag is the
        // second one; find_ci must not stop at the first (which could be
        // inside quoted text/JS, not an actual tag).
        let html = "<html><body>text with literal \"</body>\" inside</body></html>";
        let first = html.find("</body>").unwrap();
        let last = html.rfind("</body>").unwrap();
        assert_ne!(first, last);
        assert_eq!(find_ci(html, "</body>"), Some(last));
    }

    #[test]
    fn inject_before_body_close() {
        let html = "<html><body><p>hi</p></body></html>";
        let out = inject_picker_script(html);
        let script_tag = format!("<script>{}</script>", ABU_PREVIEW_INSPECT_JS);
        let expected = format!("<html><body><p>hi</p>{}</body></html>", script_tag);
        assert_eq!(out, expected);
    }

    #[test]
    fn inject_case_insensitive_body_close() {
        let html = "<HTML><BODY><p>hi</p></BODY></HTML>";
        let out = inject_picker_script(html);
        let script_tag = format!("<script>{}</script>", ABU_PREVIEW_INSPECT_JS);
        let expected = format!("<HTML><BODY><p>hi</p>{}</BODY></HTML>", script_tag);
        assert_eq!(out, expected);
    }

    #[test]
    fn inject_before_html_close_when_no_body() {
        let html = "<html><p>hi, no body tag</p></html>";
        let out = inject_picker_script(html);
        let script_tag = format!("<script>{}</script>", ABU_PREVIEW_INSPECT_JS);
        let expected = format!("<html><p>hi, no body tag</p>{}</html>", script_tag);
        assert_eq!(out, expected);
    }

    #[test]
    fn inject_appends_when_neither_tag_present() {
        let html = "<p>fragment, no html/body wrapper</p>";
        let out = inject_picker_script(html);
        let script_tag = format!("<script>{}</script>", ABU_PREVIEW_INSPECT_JS);
        let expected = format!("<p>fragment, no html/body wrapper</p>{}", script_tag);
        assert_eq!(out, expected);
    }

    #[test]
    fn inject_lands_before_body_close_not_after() {
        let html = "<html><body><p>hi</p></body></html>";
        let out = inject_picker_script(html);
        let script_idx = out.find("<script>").unwrap();
        let body_close_idx = out.rfind("</body>").unwrap();
        assert!(script_idx < body_close_idx);
    }

    #[test]
    fn inject_cjk_content_byte_exact_around_injection() {
        // Regression guard for the charset=utf-8 fix (module doc comment,
        // lines ~246-250): injection must not corrupt or reflow CJK bytes,
        // and must still land immediately before the real </body>.
        let html = "<html><head><meta charset=\"utf-8\"></head><body><h1>你好世界</h1><p>中文内容测试，包含标点符号。</p></body></html>";
        let out = inject_picker_script(html);

        let idx = find_ci(html, "</body>").unwrap();
        // Everything before the injection point is byte-for-byte untouched.
        assert_eq!(&out[..idx], &html[..idx]);
        // Everything from the injection point onward, in the original, is
        // preserved verbatim at the tail of the output.
        assert!(out.ends_with(&html[idx..]));
        // And the injected script sits between those two halves.
        let script_tag = format!("<script>{}</script>", ABU_PREVIEW_INSPECT_JS);
        let expected = format!("{}{}{}", &html[..idx], script_tag, &html[idx..]);
        assert_eq!(out, expected);
    }
}
