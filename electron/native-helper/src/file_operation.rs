use crate::error::HelperError;
use crate::file_operation_platform::{self as platform, Access};
use serde_json::{json, Value};
use image::{ImageDecoder, ImageEncoder};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};
use std::time::UNIX_EPOCH;

const MAX_TARGETS: usize = 10_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_MEDIA_CHUNK_BYTES: u64 = 1024 * 1024;
const MAX_STREAM_WRITE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_SESSIONS: usize = 128;
const MAX_IMAGE_WORK_BYTES: u64 = 256 * 1024 * 1024;

struct ImageOutput<'a> { bytes: Vec<u8>, position: usize, cancelled: &'a AtomicBool }
impl Write for ImageOutput<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Acquire) { return Err(io::Error::other("File session cancelled")); }
        let end = self.position.checked_add(bytes.len()).filter(|end| *end <= MAX_BYTES)
            .ok_or_else(|| io::Error::other("Image output limit reached"))?;
        if end > self.bytes.len() {
            if end > self.bytes.capacity() {
                let capacity = end.next_power_of_two().min(MAX_BYTES);
                self.bytes.try_reserve_exact(capacity - self.bytes.len()).map_err(|_| io::Error::other("Image allocation refused"))?;
            }
            self.bytes.resize(end, 0);
        }
        self.bytes[self.position..end].copy_from_slice(bytes);
        self.position = end;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Acquire) { Err(io::Error::other("File session cancelled")) } else { Ok(()) }
    }
}
impl Seek for ImageOutput<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.flush()?;
        let next = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(value) => self.position as i128 + i128::from(value),
            SeekFrom::End(value) => self.bytes.len() as i128 + i128::from(value),
        };
        if !(0..=MAX_BYTES as i128).contains(&next) { return Err(io::Error::other("Image output limit reached")); }
        self.position = next as usize;
        Ok(next as u64)
    }
}

fn image_pixels(width: u32, height: u32) -> Result<u64, HelperError> {
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 { return Err(refused()); }
    u64::from(width).checked_mul(u64::from(height)).ok_or_else(refused)
}

fn refused() -> HelperError { HelperError::not_executed("file-operation-refused", "File operation is no longer authorized or its target changed") }
fn io_error(error: io::Error) -> HelperError {
    HelperError::not_executed("file-operation-io", format!("File operation failed: {error}"))
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, HelperError> {
    value.get(field).and_then(Value::as_str).filter(|text| !text.is_empty() && text.len() <= 32_768)
        .ok_or_else(refused)
}
fn session_id(value: &Value) -> Result<u64, HelperError> {
    let value = text(value, "session")?;
    if value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(refused()); }
    value.parse::<u64>().map_err(|_| refused())
}
fn check(cancelled: &AtomicBool) -> Result<(), HelperError> {
    if cancelled.load(Ordering::Acquire) { Err(refused()) } else { Ok(()) }
}
fn slash(path: &Path) -> Result<String, HelperError> {
    path.to_str().map(|text| text.replace('\\', "/")).ok_or_else(refused)
}

#[derive(Clone, PartialEq, Eq)]
struct Target { path: PathBuf, purpose: String, follow: bool }
impl Target {
    fn parse(value: &Value) -> Result<Self, HelperError> {
        let path = PathBuf::from(text(value, "path")?);
        if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0')
            || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
            return Err(refused());
        }
        let purpose = text(value, "purpose")?;
        if !["read", "write", "list", "traverse", "delete"].contains(&purpose) { return Err(refused()); }
        let follow = value.get("followFinalSymlink").and_then(Value::as_bool).ok_or_else(refused)?;
        if purpose == "delete" && follow { return Err(refused()); }
        Ok(Self { path, purpose: purpose.to_owned(), follow })
    }
}

#[derive(Default)]
struct Controls { watermark: u64, active: HashMap<u64, Arc<AtomicBool>> }
static CONTROLS: OnceLock<Mutex<Controls>> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<u64, Session>>> = OnceLock::new();

/// Runs on the stdin reader before a request joins the execution queue.
pub(crate) fn ingress(params: &Value) -> Result<(), HelperError> {
    let id = session_id(params)?;
    let action = text(params, "action")?;
    let mut controls = CONTROLS.get_or_init(|| Mutex::new(Controls::default())).lock().map_err(|_| refused())?;
    if action == "open" {
        let targets = params.get("targets").and_then(Value::as_array).ok_or_else(refused)?;
        if targets.is_empty() || targets.len() > MAX_TARGETS { return Err(refused()); }
        for target in targets { Target::parse(target)?; }
        if id <= controls.watermark || controls.active.len() >= MAX_SESSIONS { return Err(refused()); }
        controls.watermark = id;
        controls.active.insert(id, Arc::new(AtomicBool::new(false)));
    } else if action == "release" || action == "cancel" {
        // Unknown cancellation never advances the open watermark or allocates memory.
        if let Some(cancelled) = controls.active.get(&id) { cancelled.store(true, Ordering::Release); }
        else if id > controls.watermark { return Err(refused()); }
    } else {
        let cancelled = controls.active.get(&id).ok_or_else(refused)?;
        check(cancelled)?;
    }
    Ok(())
}

pub(crate) fn discard_open(params: &Value) {
    if params.get("action").and_then(Value::as_str) != Some("open") { return; }
    if let (Ok(id), Some(controls)) = (session_id(params), CONTROLS.get()) {
        if let Ok(mut controls) = controls.lock() {
            if let Some(cancelled) = controls.active.remove(&id) { cancelled.store(true, Ordering::Release); }
        }
    }
}

pub(crate) fn cancel_all() {
    if let Some(controls) = CONTROLS.get() {
        if let Ok(controls) = controls.lock() {
            for cancelled in controls.active.values() { cancelled.store(true, Ordering::Release); }
        }
    }
}

pub(crate) fn close_all() {
    cancel_all();
    if let Some(sessions) = SESSIONS.get() { if let Ok(mut sessions) = sessions.lock() { sessions.clear(); } }
    if let Some(controls) = CONTROLS.get() { if let Ok(mut controls) = controls.lock() { controls.active.clear(); } }
}

pub(crate) fn discard_cancelled() {
    if let Some(sessions) = SESSIONS.get() {
        if let Ok(mut sessions) = sessions.lock() {
            sessions.retain(|_, session| !session.cancelled.load(Ordering::Acquire));
        }
    }
}

#[derive(Clone)]
struct Anchor {
    file: Arc<File>, parent: Option<Arc<File>>, name: String, path: PathBuf,
    identity: String, canonical: PathBuf, follow: bool, comparison: Option<Value>,
}
impl Anchor {
    fn new(file: File, parent: Option<Arc<File>>, name: String, path: PathBuf, follow: bool) -> Result<Self, HelperError> {
        let identity = platform::identity(&file).map_err(io_error)?;
        let canonical = platform::canonical(&file).map_err(io_error)?;
        let comparison = if file.metadata().map_err(io_error)?.is_dir() { Some(platform::facts(&file).map_err(io_error)?) } else { None };
        Ok(Self { file: Arc::new(file), parent, name, path, identity, canonical, follow, comparison })
    }
    fn validate(&self, cancelled: &AtomicBool) -> Result<(), HelperError> {
        check(cancelled)?;
        let current = if let Some(parent) = &self.parent {
            platform::relative(parent, &self.name, Access::Attributes, self.follow, None)
        } else { platform::root(&self.path) }.map_err(io_error)?;
        if platform::identity(&current).map_err(io_error)? != self.identity
            || platform::canonical(&current).map_err(io_error)? != self.canonical
            || platform::canonical(&self.file).map_err(io_error)? != self.canonical {
            return Err(refused());
        }
        if let Some(comparison) = &self.comparison {
            if platform::facts(&self.file).map_err(io_error)? != *comparison { return Err(refused()); }
        }
        Ok(())
    }
}

struct Resolved {
    anchors: Vec<Anchor>, canonical: PathBuf, missing: Vec<String>, parent: Arc<File>,
    file: Option<Arc<File>>, identity: Option<String>, is_file: bool, is_dir: bool,
    is_symlink: bool, facts: Value,
}

fn inspect_path(target: &Target, cancelled: &AtomicBool) -> Result<Resolved, HelperError> {
    let mut root = PathBuf::new();
    let mut names = Vec::new();
    for part in target.path.components() {
        match part {
            Component::Prefix(_) | Component::RootDir => root.push(part.as_os_str()),
            Component::Normal(name) => names.push(name.to_str().ok_or_else(refused)?.to_owned()),
            _ => return Err(refused()),
        }
    }
    if names.len() > 128 { return Err(refused()); }
    check(cancelled)?;
    let root_file = platform::root(&root).map_err(io_error)?;
    let root_anchor = Anchor::new(root_file, None, String::new(), root.clone(), true)?;
    inspect_components(target, cancelled, root.clone(), root, Arc::clone(&root_anchor.file),
        vec![root_anchor], Vec::new(), names)
}

fn inspect_components(target: &Target, cancelled: &AtomicBool, root: PathBuf, mut lexical_parent: PathBuf,
    mut current: Arc<File>, mut anchors: Vec<Anchor>, mut components: Vec<Value>, names: Vec<String>) -> Result<Resolved, HelperError> {
    let mut missing = Vec::new();
    let mut file = Some(Arc::clone(&current));
    let mut final_symlink = false;
    let mut final_parent = Arc::clone(&current);
    for (index, name) in names.iter().enumerate() {
        check(cancelled)?;
        let mut facts = if missing.is_empty() { platform::facts(&current).map_err(io_error)? }
            else { json!({ "caseMode": "unknown", "directoryIdentity": null,
                "platform": std::env::consts::OS, "filesystem": null, "reason": "missing-parent" }) };
        facts["name"] = json!(name);
        facts["parentPath"] = json!(slash(&lexical_parent)?);
        components.push(facts);
        lexical_parent.push(name);
        if !missing.is_empty() { missing.push(name.clone()); continue; }
        final_parent = Arc::clone(&current);
        let entry = match platform::relative(&current, name, Access::Attributes, false, None) {
            Ok(entry) => entry,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(name.clone()); file = None; continue;
            }
            Err(error) => return Err(io_error(error)),
        };
        let metadata = entry.metadata().map_err(io_error)?;
        let symlink = metadata.file_type().is_symlink();
        let last = index + 1 == names.len();
        let follow = !last || target.follow;
        let entry_anchor = Anchor::new(entry, Some(Arc::clone(&current)), name.clone(), lexical_parent.clone(), false)?;
        let mut selected = Arc::clone(&entry_anchor.file);
        anchors.push(entry_anchor);
        if symlink && follow {
            check(cancelled)?;
            let resolved = platform::relative(&current, name, Access::Attributes, true, None).map_err(io_error)?;
            let resolved_anchor = Anchor::new(resolved, Some(Arc::clone(&current)), name.clone(), lexical_parent.clone(), true)?;
            selected = Arc::clone(&resolved_anchor.file);
            anchors.push(resolved_anchor);
        }
        let metadata = selected.metadata().map_err(io_error)?;
        if !last && !metadata.is_dir() { return Err(refused()); }
        if last {
            final_symlink = symlink;
            if !metadata.is_file() && !metadata.is_dir() && !metadata.file_type().is_symlink() { return Err(refused()); }
            if metadata.is_file() && ["read", "write"].contains(&target.purpose.as_str()) {
                check(cancelled)?;
                let data = platform::relative(&current, name,
                    if target.purpose == "write" { Access::Write } else { Access::Read }, follow, None).map_err(io_error)?;
                if platform::identity(&data).map_err(io_error)? != platform::identity(&selected).map_err(io_error)? {
                    return Err(refused());
                }
                selected = Arc::new(data);
            }
        }
        current = Arc::clone(&selected);
        file = Some(selected);
    }
    let mut canonical = platform::canonical(&current).map_err(io_error)?;
    for name in &missing { canonical.push(name); }
    let metadata = file.as_ref().map(|file| file.metadata()).transpose().map_err(io_error)?;
    let identity = file.as_ref().map(|file| platform::identity(file)).transpose().map_err(io_error)?;
    for anchor in &anchors { anchor.validate(cancelled)?; }
    Ok(Resolved { anchors, canonical, missing, parent: final_parent, file, identity,
        is_file: metadata.as_ref().is_some_and(|info| info.is_file()),
        is_dir: metadata.as_ref().is_some_and(|info| info.is_dir()), is_symlink: final_symlink,
        facts: json!({ "path": slash(&target.path)?, "root": slash(&root)?, "components": components }) })
}

struct Observation { target: Target, resolved: Resolved, canonical_anchors: Vec<Anchor>, comparison: Value, parent_ref: Option<String> }
impl Observation {
    fn media_info(&self, cancelled: &AtomicBool) -> Result<Value, HelperError> {
        if self.target.purpose != "read" || !self.resolved.is_file
            || (self.resolved.is_symlink && !self.target.follow) { return Err(refused()); }
        self.validate(cancelled)?;
        let file = self.resolved.file.as_ref().ok_or_else(refused)?;
        let metadata = file.metadata().map_err(io_error)?;
        let modified = metadata.modified().map_err(io_error)?.duration_since(UNIX_EPOCH).map_err(|_| refused())?;
        Ok(json!({ "size": metadata.len(), "modifiedNs": modified.as_nanos().to_string() }))
    }
    fn read_media_range(&self, params: &Value, cancelled: &AtomicBool) -> Result<Value, HelperError> {
        let expected_size = params.get("expectedSize").and_then(Value::as_u64).ok_or_else(refused)?;
        let expected_modified = text(params, "expectedModifiedNs")?;
        let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(refused)?;
        let length = params.get("length").and_then(Value::as_u64).filter(|length| *length > 0 && *length <= MAX_MEDIA_CHUNK_BYTES).ok_or_else(refused)?;
        let end = offset.checked_add(length).filter(|end| *end <= expected_size).ok_or_else(refused)?;
        let expected = json!({ "size": expected_size, "modifiedNs": expected_modified });
        if self.media_info(cancelled)? != expected { return Err(refused()); }
        let mut reader = self.resolved.file.as_ref().ok_or_else(refused)?.try_clone().map_err(io_error)?;
        reader.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut bytes = vec![0u8; (end - offset) as usize];
        check(cancelled)?;
        reader.read_exact(&mut bytes).map_err(io_error)?;
        check(cancelled)?;
        if self.media_info(cancelled)? != expected { return Err(refused()); }
        Ok(json!({ "base64": STANDARD.encode(bytes) }))
    }
    fn read_bytes(&self, cancelled: &AtomicBool) -> Result<Vec<u8>, HelperError> {
        if self.target.purpose != "read" || !self.resolved.is_file
            || (self.resolved.is_symlink && !self.target.follow) { return Err(refused()); }
        let file = self.resolved.file.as_ref().ok_or_else(refused)?;
        check(cancelled)?;
        if file.metadata().map_err(io_error)?.len() > MAX_BYTES as u64 { return Err(refused()); }
        let mut reader = file.try_clone().map_err(io_error)?;
        reader.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            check(cancelled)?;
            let count = reader.read(&mut chunk).map_err(io_error)?;
            if count == 0 { break; }
            if bytes.len() + count > MAX_BYTES { return Err(refused()); }
            bytes.extend_from_slice(&chunk[..count]);
        }
        self.validate(cancelled)?;
        Ok(bytes)
    }
    fn new(target: Target, cancelled: &AtomicBool, parent_ref: Option<String>) -> Result<Self, HelperError> {
        let resolved = inspect_path(&target, cancelled)?;
        let canonical_target = Target { path: resolved.canonical.clone(), purpose: target.purpose.clone(), follow: target.follow };
        let canonical = inspect_path(&canonical_target, cancelled)?;
        if canonical.identity != resolved.identity || canonical.canonical != resolved.canonical { return Err(refused()); }
        let comparison = json!({ "lexical": resolved.facts, "canonical": canonical.facts });
        Ok(Self { target, resolved, canonical_anchors: canonical.anchors, comparison, parent_ref })
    }
    fn child(parent: &Observation, parent_ref: String, target: Target, name: String, cancelled: &AtomicBool) -> Result<Self, HelperError> {
        parent.validate(cancelled)?;
        let file = parent.resolved.file.as_ref().ok_or_else(refused)?;
        let root = PathBuf::from(text(&parent.resolved.facts, "root")?);
        let components = parent.resolved.facts.get("components").and_then(Value::as_array).cloned().ok_or_else(refused)?;
        if components.len() >= 128 { return Err(refused()); }
        let resolved = inspect_components(&target, cancelled, root, parent.target.path.clone(), Arc::clone(file),
            parent.resolved.anchors.clone(), components, vec![name])?;
        let canonical_target = Target { path: resolved.canonical.clone(), purpose: target.purpose.clone(), follow: target.follow };
        let canonical = inspect_path(&canonical_target, cancelled)?;
        if canonical.identity != resolved.identity || canonical.canonical != resolved.canonical { return Err(refused()); }
        let comparison = json!({ "lexical": resolved.facts, "canonical": canonical.facts });
        Ok(Self { target, resolved, canonical_anchors: canonical.anchors, comparison, parent_ref: Some(parent_ref) })
    }
    fn describe(&self, reference: &str) -> Result<Value, HelperError> {
        Ok(json!({ "reference": reference, "path": slash(&self.target.path)?,
            "canonicalPath": slash(&self.resolved.canonical)?, "exists": self.resolved.file.is_some(),
            "isFile": self.resolved.is_file, "isDirectory": self.resolved.is_dir,
            "isSymlink": self.resolved.is_symlink, "identity": self.resolved.identity,
            "comparison": self.comparison }))
    }
    fn validate(&self, cancelled: &AtomicBool) -> Result<(), HelperError> {
        for anchor in self.resolved.anchors.iter().chain(self.canonical_anchors.iter()) { anchor.validate(cancelled)?; }
        if let Some(first) = self.resolved.missing.first() {
            check(cancelled)?;
            match platform::relative(&self.resolved.parent, first, Access::Attributes, false, None) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                _ => return Err(refused()),
            }
        }
        Ok(())
    }
    fn compare_component(&self, params: &Value, cancelled: &AtomicBool) -> Result<Value, HelperError> {
        let path_kind = text(params, "pathKind")?;
        if !["lexical", "canonical"].contains(&path_kind) { return Err(refused()); }
        let index = params.get("component").and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok()).ok_or_else(refused)?;
        let facts = self.comparison.get(path_kind).ok_or_else(refused)?;
        let components = facts.get("components").and_then(Value::as_array).ok_or_else(refused)?;
        if index >= components.len() { return Err(refused()); }
        let pattern = text(params, "pattern")?;
        if pattern.contains(['/', '\\', '\0']) || pattern == "." || pattern == ".." { return Err(refused()); }
        let mut path = PathBuf::from(text(facts, "root")?);
        for component in components.iter().take(index + 1) { path.push(text(component, "name")?); }
        let anchors = if path_kind == "lexical" { &self.resolved.anchors } else { &self.canonical_anchors };
        let result = if let Some(anchor) = anchors.iter().find(|anchor| !anchor.follow && anchor.path == path) {
            let parent = anchor.parent.as_ref().ok_or_else(refused)?;
            platform::compare_component(parent, &anchor.identity, &anchor.canonical, pattern,
                &|| check(cancelled).map_err(|_| io::Error::other("File session cancelled")))
                .unwrap_or("unknown")
        } else { "unknown" };
        self.validate(cancelled)?;
        Ok(json!(result))
    }
    fn reported_path(&self, reported: &str, cancelled: &AtomicBool) -> Result<&'static str, HelperError> {
        let candidate = Path::new(reported);
        if !candidate.is_absolute() || reported.contains(['\0', '*', '?']) { return Ok("unknown"); }
        let mut root = PathBuf::new();
        let mut names = Vec::new();
        for component in candidate.components() {
            match component {
                Component::Prefix(_) | Component::RootDir => root.push(component.as_os_str()),
                Component::Normal(name) => names.push(name.to_str().ok_or_else(refused)?),
                _ => return Ok("unknown"),
            }
        }
        if names.len() > 128 { return Ok("unknown"); }
        let mut uncertain = false;
        for kind in ["lexical", "canonical"] {
            let facts = self.comparison.get(kind).ok_or_else(refused)?;
            if root != PathBuf::from(text(facts, "root")?) { uncertain = true; continue; }
            let components = facts.get("components").and_then(Value::as_array).ok_or_else(refused)?;
            if components.len() != names.len() { continue; }
            let mut result = "match";
            for (index, name) in names.iter().enumerate() {
                check(cancelled)?;
                if *name == text(&components[index], "name")? { continue; }
                let compared = self.compare_component(&json!({ "pathKind": kind, "component": index, "pattern": name }), cancelled)?;
                match compared.as_str() {
                    Some("no-match") => { result = "no-match"; break; }
                    Some("match") => (),
                    _ => result = "unknown",
                }
            }
            if result == "match" { return Ok("match"); }
            uncertain |= result == "unknown";
        }
        Ok(if uncertain { "unknown" } else { "no-match" })
    }
    fn filter_open_documents<'a>(&self, documents: impl IntoIterator<Item = (&'a str, &'a str, bool)>,
        mut complete: bool, cancelled: &AtomicBool) -> Result<Value, HelperError> {
        self.validate(cancelled)?;
        if self.target.purpose != "read" { return Err(refused()); }
        let name = self.target.path.file_name().and_then(|name| name.to_str()).ok_or_else(refused)?;
        let path = slash(&self.target.path)?;
        let mut visible = Vec::new();
        for (index, (app, reported, unsaved)) in documents.into_iter().enumerate() {
            check(cancelled)?;
            if index >= MAX_TARGETS { return Err(refused()); }
            match self.reported_path(reported, cancelled)? {
                "match" if self.resolved.is_file => visible.push(json!({ "app": app, "name": name,
                    "path": path, "unsaved": unsaved, "samePath": true })),
                "no-match" => (),
                _ => complete = false,
            }
        }
        self.validate(cancelled)?;
        Ok(json!({ "supported": true, "complete": complete, "documents": visible }))
    }
    fn open_document(&self, cancelled: &AtomicBool) -> Result<Value, HelperError> {
        self.validate(cancelled)?;
        if self.target.purpose != "read" { return Err(refused()); }
        #[cfg(target_os = "windows")]
        {
            let report = crate::windows_backend::office_documents_impl()?;
            self.filter_open_documents(report.documents.iter().map(|document|
                (document.app.as_str(), document.path.as_str(), document.unsaved)), report.complete, cancelled)
        }
        #[cfg(not(target_os = "windows"))]
        {
            self.validate(cancelled)?;
            Ok(json!({ "supported": false, "complete": false, "documents": [] }))
        }
    }
}

struct Entry { parent: String, name: String }
struct Session {
    id: u64, cancelled: Arc<AtomicBool>, targets: Vec<Target>, observations: HashMap<String, Observation>,
    entries: HashMap<String, Entry>, created: HashMap<PathBuf, String>, serial: u64,
    searches: HashMap<String, regex::Regex>, search_bytes: usize,
    stream_writes: HashMap<String, u64>,
}

impl Session {
    fn branch_entry(&mut self, params: &Value) -> Result<Value, HelperError> {
        let name = text(params, "name")?;
        if name.is_empty() || name.len() > 255 || name.contains("..")
            || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
            return Err(refused());
        }
        let parent = self.observation(text(params, "reference")?)?;
        if parent.target.purpose != "write" || parent.target.follow || !parent.resolved.is_dir
            || parent.resolved.is_symlink { return Err(refused()); }
        let directory = parent.resolved.file.as_ref().ok_or_else(refused)?;
        if text(params, "action")? == "branch-move" {
            let destination = self.observation(text(params, "destination")?)?;
            if destination.target.purpose != "write" || destination.target.follow || !destination.resolved.is_dir
                || destination.resolved.is_symlink { return Err(refused()); }
            platform::move_directory(directory, name, destination.resolved.file.as_ref().ok_or_else(refused)?,
                text(params, "identity")?).map_err(|error| io_error(error).after_dispatch())?;
            destination.validate(&self.cancelled).map_err(HelperError::after_dispatch)?;
        } else {
            remove_branch_entry(directory, name, &self.cancelled, 0)?;
        }
        parent.validate(&self.cancelled).map_err(HelperError::after_dispatch)?;
        Ok(Value::Null)
    }

    /// Main-process branch copies use retained directory handles for every creation.
    fn write_chunk(&mut self, reference: &str, params: &Value) -> Result<Value, HelperError> {
        let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(refused)?;
        let bytes = params.get("bytes").and_then(Value::as_array).filter(|bytes| bytes.len() <= 1024 * 1024)
            .ok_or_else(refused)?.iter().map(|byte| byte.as_u64().filter(|byte| *byte <= 255)
                .map(|byte| byte as u8).ok_or_else(refused)).collect::<Result<Vec<_>, _>>()?;
        let end = offset.checked_add(bytes.len() as u64).filter(|end| *end <= MAX_STREAM_WRITE_BYTES).ok_or_else(refused)?;
        if let Some(written) = self.stream_writes.get(reference) {
            if *written != offset { return Err(refused()); }
        } else {
            let observation = self.observation(reference)?;
            if offset != 0 || observation.resolved.file.is_some() || observation.target.purpose != "write"
                || observation.target.follow { return Err(refused()); }
            self.create_missing(reference, true)?;
        }
        let observation = self.observation(reference)?;
        if !observation.resolved.is_file || observation.resolved.is_symlink { return Err(refused()); }
        let file = observation.resolved.file.as_ref().ok_or_else(refused)?;
        let mut writer = file.try_clone().map_err(io_error)?;
        if writer.metadata().map_err(io_error)?.len() != offset { return Err(refused()); }
        writer.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        check(&self.cancelled)?;
        writer.write_all(&bytes).map_err(|error| io_error(error).after_dispatch())?;
        observation.validate(&self.cancelled).map_err(HelperError::after_dispatch)?;
        self.stream_writes.insert(reference.to_owned(), end);
        Ok(json!({ "written": end }))
    }

    fn finish_write(&mut self, reference: &str, params: &Value) -> Result<Value, HelperError> {
        let size = params.get("size").and_then(Value::as_u64).ok_or_else(refused)?;
        if self.stream_writes.get(reference) != Some(&size) { return Err(refused()); }
        let observation = self.observation(reference)?;
        let file = observation.resolved.file.as_ref().ok_or_else(refused)?;
        if file.metadata().map_err(io_error)?.len() != size { return Err(refused()); }
        check(&self.cancelled)?;
        file.sync_all().map_err(|error| io_error(error).after_dispatch())?;
        observation.validate(&self.cancelled).map_err(HelperError::after_dispatch)?;
        self.stream_writes.remove(reference);
        Ok(Value::Null)
    }

    /// Copies between retained handles without sending file contents over RPC.
    fn copy_file(&mut self, reference: &str, params: &Value) -> Result<Value, HelperError> {
        let source_reference = text(params, "sourceReference")?;
        let size = params.get("size").and_then(Value::as_u64)
            .filter(|size| *size <= MAX_STREAM_WRITE_BYTES).ok_or_else(refused)?;
        let source = self.observation(source_reference)?;
        if source.target.purpose != "read" || source.target.follow || !source.resolved.is_file
            || source.resolved.is_symlink { return Err(refused()); }
        let mut reader = source.resolved.file.as_ref().ok_or_else(refused)?.try_clone().map_err(io_error)?;
        let before = reader.metadata().map_err(io_error)?;
        let modified = before.modified().map_err(io_error)?;
        if before.len() != size { return Err(refused()); }
        let destination = self.observation(reference)?;
        if destination.target.purpose != "write" || destination.target.follow
            || destination.resolved.file.is_some() { return Err(refused()); }
        reader.seek(SeekFrom::Start(0)).map_err(io_error)?;
        self.create_missing(reference, true)?;
        let destination = self.observation(reference)?;
        let mut writer = destination.resolved.file.as_ref().ok_or_else(refused)?.try_clone().map_err(io_error)?;
        let mut copy = || -> Result<Value, HelperError> {
            let mut copied = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            while copied < size {
                check(&self.cancelled)?;
                let limit = (size - copied).min(buffer.len() as u64) as usize;
                let count = reader.read(&mut buffer[..limit]).map_err(io_error)?;
                if count == 0 { return Err(refused()); }
                writer.write_all(&buffer[..count]).map_err(io_error)?;
                copied += count as u64;
            }
            let after = reader.metadata().map_err(io_error)?;
            if after.len() != size || after.modified().map_err(io_error)? != modified { return Err(refused()); }
            self.observation(source_reference)?;
            destination.validate(&self.cancelled)?;
            check(&self.cancelled)?;
            writer.sync_all().map_err(io_error)?;
            if writer.metadata().map_err(io_error)?.len() != size { return Err(refused()); }
            destination.validate(&self.cancelled)?;
            Ok(json!({ "written": copied }))
        };
        copy().map_err(HelperError::after_dispatch)
    }

    fn process_image(&mut self, params: &Value) -> Result<Value, HelperError> {
        let reference = text(params, "reference")?;
        let operation = text(params, "operation")?;
        if !["resize", "fit-width", "crop", "convert", "compress"].contains(&operation) { return Err(refused()); }
        let options = params.get("params").and_then(Value::as_object).ok_or_else(refused)?;
        let dimension = |name: &str| -> Result<u32, HelperError> {
            options.get(name).and_then(Value::as_u64).filter(|value| (1..=16_384).contains(value))
                .map(|value| value as u32).ok_or_else(refused)
        };
        let requested = match operation {
            "resize" | "crop" => Some((dimension("width")?, dimension("height")?)),
            "fit-width" => Some((dimension("width")?, 1)),
            _ => None,
        };
        let quality = match options.get("quality") {
            None => 80,
            Some(value) => value.as_u64().filter(|value| (1..=100).contains(value)).ok_or_else(refused)? as u8,
        };
        let output_reference = params.get("outputReference").map(|value| value.as_str().ok_or_else(refused)).transpose()?;
        if let Some(output_reference) = output_reference {
            let output = self.observation(output_reference)?;
            if output.target.purpose != "write" || output.resolved.is_dir
                || (output.resolved.is_symlink && !output.target.follow) { return Err(refused()); }
        }
        if self.observation(reference)?.target.purpose != "read" { return Err(refused()); }
        let input = self.observation(reference)?.read_bytes(&self.cancelled)?;
        let mut reader = image::ImageReader::new(io::Cursor::new(input)).with_guessed_format().map_err(io_error)?;
        let input_format = reader.format().ok_or_else(refused)?;
        let output_format = match operation {
            "compress" => image::ImageFormat::Jpeg,
            "fit-width" => image::ImageFormat::Png,
            "convert" => match options.get("format").map(|value| value.as_str().ok_or_else(refused)).transpose()?
                .unwrap_or("png").to_ascii_lowercase().as_str() {
                "png" => image::ImageFormat::Png, "jpeg" | "jpg" => image::ImageFormat::Jpeg,
                "gif" => image::ImageFormat::Gif, "bmp" => image::ImageFormat::Bmp,
                "tiff" => image::ImageFormat::Tiff, _ => return Err(refused()),
            },
            _ if cfg!(target_os = "windows") => image::ImageFormat::Png,
            _ => input_format,
        };
        if ![image::ImageFormat::Png, image::ImageFormat::Jpeg, image::ImageFormat::Gif,
            image::ImageFormat::Bmp, image::ImageFormat::Tiff].contains(&output_format) { return Err(refused()); }
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16_384);
        limits.max_image_height = Some(16_384);
        limits.max_alloc = Some(MAX_BYTES as u64);
        reader.limits(limits);
        let decoder = reader.into_decoder().map_err(|_| refused())?;
        let (source_width, source_height) = decoder.dimensions();
        image_pixels(source_width, source_height)?;
        if decoder.total_bytes() > MAX_BYTES as u64 { return Err(refused()); }
        let dimensions = if operation == "fit-width" {
            let width = requested.ok_or_else(refused)?.0;
            let height = u64::from(source_height).checked_mul(u64::from(width)).ok_or_else(refused)?
                / u64::from(source_width);
            (width, u32::try_from(height.max(1)).map_err(|_| refused())?)
        } else { requested.unwrap_or((source_width, source_height)) };
        let output_pixels = image_pixels(dimensions.0, dimensions.1)?;
        // Bound source pixels, transformed pixels, encoder conversion and the
        // float intermediate used by image's separable resampling operation.
        let intermediate = if operation == "resize" || operation == "fit-width" {
            u64::from(source_width).checked_mul(u64::from(dimensions.1)).ok_or_else(refused)?
        } else { 0 };
        let transformed_bytes = output_pixels.checked_mul(u64::from(decoder.color_type().bytes_per_pixel())).ok_or_else(refused)?;
        let conversion_bytes = output_pixels.checked_mul(4).ok_or_else(refused)?;
        let work_bytes = decoder.total_bytes().checked_add(transformed_bytes)
            .and_then(|value| value.checked_add(conversion_bytes))
            .and_then(|value| intermediate.checked_mul(16).and_then(|extra| value.checked_add(extra)))
            .ok_or_else(refused)?;
        if work_bytes > MAX_IMAGE_WORK_BYTES { return Err(refused()); }
        check(&self.cancelled)?;
        let source = image::DynamicImage::from_decoder(decoder).map_err(|_| refused())?;
        check(&self.cancelled)?;
        let output = match operation {
            "resize" | "fit-width" => source.resize_exact(dimensions.0, dimensions.1, image::imageops::FilterType::Lanczos3),
            "crop" => {
                let (width, height) = dimensions;
                if width > source_width || height > source_height { return Err(refused()); }
                let coordinate = |name: &str| -> Result<u32, HelperError> {
                    options.get(name).map(|value| value.as_u64().and_then(|value| u32::try_from(value).ok())
                        .ok_or_else(refused)).transpose().map(|value| value.unwrap_or(0))
                };
                let (x, y) = (coordinate("x")?, coordinate("y")?);
                if x.checked_add(width).filter(|value| *value <= source_width).is_none()
                    || y.checked_add(height).filter(|value| *value <= source_height).is_none() { return Err(refused()); }
                source.crop_imm(x, y, width, height)
            }
            "convert" | "compress" => source,
            _ => return Err(refused()),
        };
        check(&self.cancelled)?;
        let mut encoded = ImageOutput { bytes: Vec::new(), position: 0, cancelled: &self.cancelled };
        let (width, height) = dimensions;
        match output_format {
            image::ImageFormat::Jpeg => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality)
                .encode_image(&output.to_rgb8()),
            image::ImageFormat::Gif => image::codecs::gif::GifEncoder::new(&mut encoded)
                .encode(&output.to_rgba8(), width, height, image::ExtendedColorType::Rgba8),
            image::ImageFormat::Bmp => image::codecs::bmp::BmpEncoder::new(&mut encoded)
                .encode(&output.to_rgba8(), width, height, image::ExtendedColorType::Rgba8),
            image::ImageFormat::Png => image::codecs::png::PngEncoder::new(&mut encoded)
                .write_image(output.as_bytes(), width, height, output.color().into()),
            image::ImageFormat::Tiff => image::codecs::tiff::TiffEncoder::new(&mut encoded)
                .write_image(output.as_bytes(), width, height, output.color().into()),
            _ => return Err(refused()),
        }.map_err(|_| refused())?;
        check(&self.cancelled)?;
        let bytes = encoded.bytes;
        self.observation(reference)?;
        if let Some(output_reference) = output_reference {
            self.write_bytes(output_reference, &bytes)?;
            Ok(Value::Null)
        } else { Ok(json!({ "bytes": bytes })) }
    }
    fn write_bytes(&mut self, reference: &str, bytes: &[u8]) -> Result<(), HelperError> {
        if bytes.len() > MAX_BYTES { return Err(refused()); }
        self.create_missing(reference, true)?;
        let observation = self.observation(reference)?;
        if observation.target.purpose != "write" || !observation.resolved.is_file
            || (observation.resolved.is_symlink && !observation.target.follow) { return Err(refused()); }
        let file = observation.resolved.file.as_ref().ok_or_else(refused)?;
        let mut writer = file.try_clone().map_err(io_error)?;
        check(&self.cancelled)?;
        writer.seek(SeekFrom::Start(0)).map_err(io_error)?;
        check(&self.cancelled)?;
        writer.set_len(0).map_err(|error| io_error(error).after_dispatch())?;
        for chunk in bytes.chunks(64 * 1024) {
            check(&self.cancelled).map_err(HelperError::after_dispatch)?;
            writer.write_all(chunk).map_err(|error| io_error(error).after_dispatch())?;
        }
        check(&self.cancelled).map_err(HelperError::after_dispatch)?;
        writer.sync_all().map_err(|error| io_error(error).after_dispatch())?;
        observation.validate(&self.cancelled).map_err(HelperError::after_dispatch)
    }
    fn reference(&mut self) -> Result<String, HelperError> {
        if self.observations.len() + self.entries.len() >= MAX_TARGETS * 2 { return Err(refused()); }
        self.serial = self.serial.checked_add(1).ok_or_else(refused)?;
        Ok(format!("{}:{}", self.id, self.serial))
    }
    fn observation(&self, reference: &str) -> Result<&Observation, HelperError> {
        check(&self.cancelled)?;
        let observation = self.observations.get(reference).ok_or_else(refused)?;
        observation.validate(&self.cancelled)?;
        Ok(observation)
    }
    fn observe(&mut self, target: Target, parent_ref: Option<String>) -> Result<Value, HelperError> {
        let observation = Observation::new(target, &self.cancelled, parent_ref)?;
        let reference = self.reference()?;
        let result = observation.describe(&reference)?;
        self.observations.insert(reference, observation);
        Ok(result)
    }
    fn refresh_created(&mut self) -> Result<(), HelperError> {
        for observation in self.observations.values_mut() {
            if observation.resolved.missing.is_empty() { continue; }
            for anchor in observation.resolved.anchors.iter().chain(observation.canonical_anchors.iter()) {
                anchor.validate(&self.cancelled)?;
            }
            let mut parent = Arc::clone(&observation.resolved.parent);
            let mut changed = false;
            for name in &observation.resolved.missing {
                check(&self.cancelled)?;
                let entry = match platform::relative(&parent, name, Access::Attributes, false, None) {
                    Ok(entry) => entry,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(error) => return Err(io_error(error)),
                };
                let path = platform::canonical(&entry).map_err(io_error)?;
                let identity = platform::identity(&entry).map_err(io_error)?;
                if self.created.get(&path) != Some(&identity) { return Err(refused()); }
                parent = Arc::new(entry);
                changed = true;
            }
            if changed {
                let updated = Observation::new(observation.target.clone(), &self.cancelled, observation.parent_ref.clone())?;
                if updated.resolved.canonical != observation.resolved.canonical { return Err(refused()); }
                *observation = updated;
            }
        }
        Ok(())
    }
    fn create_missing(&mut self, reference: &str, include_file: bool) -> Result<(), HelperError> {
        let observation = self.observation(reference)?;
        if observation.target.purpose != "write" { return Err(refused()); }
        let missing = observation.resolved.missing.clone();
        let mut parent = Arc::clone(&observation.resolved.parent);
        let count = if include_file { missing.len() } else { missing.len().saturating_sub(1) };
        for (index, name) in missing.iter().take(count).enumerate() {
            self.observation(reference)?;
            check(&self.cancelled)?;
            let directory = index + 1 < missing.len();
            let created = platform::relative(&parent, name,
                if directory { Access::Attributes } else { Access::Write }, false, Some(directory)).map_err(io_error)?;
            let path = platform::canonical(&created).map_err(|error| io_error(error).after_dispatch())?;
            let identity = platform::identity(&created).map_err(|error| io_error(error).after_dispatch())?;
            self.created.insert(path, identity);
            parent = Arc::new(created);
            self.refresh_created().map_err(HelperError::after_dispatch)?;
        }
        Ok(())
    }
    fn prepare_trash(&mut self, reference: &str, params: &Value) -> Result<Value, HelperError> {
        let manifest = params.get("manifest").and_then(Value::as_array).ok_or_else(refused)?;
        if manifest.is_empty() || manifest.len() > MAX_TARGETS { return Err(refused()); }
        let references = manifest.iter().map(|value| value.as_str().ok_or_else(refused))
            .collect::<Result<HashSet<_>, _>>()?;
        if references.len() != manifest.len() || !references.contains(reference) { return Err(refused()); }
        let root = self.observation(reference)?;
        if root.target.purpose != "delete" || root.resolved.file.is_none() { return Err(refused()); }
        let path = root.target.path.clone();
        if path.parent().is_none() { return Err(refused()); }
        let mut visited = HashSet::new();
        let mut pending = vec![reference];
        while let Some(current) = pending.pop() {
            if !visited.insert(current) { return Err(refused()); }
            let observation = self.observation(current)?;
            if observation.target.purpose != "delete" || observation.target.follow { return Err(refused()); }
            if observation.resolved.is_dir && !observation.resolved.is_symlink {
                let file = observation.resolved.file.as_ref().ok_or_else(refused)?;
                let names = platform::names(file, &|| check(&self.cancelled)
                    .map_err(|_| io::Error::other("File session cancelled"))).map_err(io_error)?;
                let children = self.observations.iter().filter(|(key, value)| references.contains(key.as_str())
                    && value.parent_ref.as_deref() == Some(current)).collect::<Vec<_>>();
                if names.len() != children.len() { return Err(refused()); }
                for name in names {
                    let child = children.iter().find(|(_, value)| value.target.path.file_name()
                        .and_then(|name| name.to_str()) == Some(name.as_str())).ok_or_else(refused)?;
                    pending.push(child.0.as_str());
                }
            }
        }
        if visited != references { return Err(refused()); }
        for current in &references { self.observation(current)?; }
        check(&self.cancelled)?;
        // The host immediately hands this checked entry to the OS Trash API.
        // Its documented check-to-Trash boundary cannot be made atomic.
        self.observations.clear();
        self.entries.clear();
        Ok(json!({ "path": slash(&path)? }))
    }
    fn run(&mut self, params: &Value) -> Result<Value, HelperError> {
        check(&self.cancelled)?;
        let action = text(params, "action")?;
        if action == "branch-move" || action == "branch-remove" { return self.branch_entry(params); }
        if action == "image-process" { return self.process_image(params); }
        if action == "observe" {
            let target = Target::parse(params)?;
            if !self.targets.contains(&target) { return Err(refused()); }
            return self.observe(target, None);
        }
        if action == "observe-child" {
            let parent_ref = text(params, "parent")?;
            let parent = self.observation(parent_ref)?;
            let entry = self.entries.get(text(params, "entry")?).ok_or_else(refused)?;
            if entry.parent != parent_ref || !parent.resolved.is_dir { return Err(refused()); }
            let purpose = text(params, "purpose")?;
            if (parent.target.purpose == "delete" && purpose != "delete")
                || (parent.target.purpose != "delete" && !["read", "list", "traverse"].contains(&purpose)) { return Err(refused()); }
            let target = Target::parse(&json!({ "path": parent.target.path.join(&entry.name), "purpose": purpose,
                "followFinalSymlink": params.get("followFinalSymlink") }))?;
            let observation = Observation::child(parent, parent_ref.to_owned(), target, entry.name.clone(), &self.cancelled)?;
            let reference = self.reference()?;
            let result = observation.describe(&reference)?;
            self.observations.insert(reference, observation);
            return Ok(result);
        }
        let reference = text(params, "reference")?;
        if action == "ensure-parent" { self.create_missing(reference, false)?; return Ok(Value::Null); }
        if action == "trash" { return self.prepare_trash(reference, params); }
        if action == "search-lines" {
            let pattern = text(params, "pattern")?;
            let maximum = params.get("maxResults").and_then(Value::as_u64)
                .filter(|maximum| (1..=500).contains(maximum)).ok_or_else(refused)? as usize;
            if pattern.len() > 4096 { return Err(refused()); }
            if !self.searches.contains_key(pattern) {
                if self.searches.len() >= 8 { return Err(refused()); }
                let compiled = regex::RegexBuilder::new(pattern).size_limit(1024 * 1024)
                    .dfa_size_limit(1024 * 1024).nest_limit(64).build().map_err(|_| refused())?;
                self.searches.insert(pattern.to_owned(), compiled);
            }
            let observation = self.observation(reference)?;
            let bytes = observation.read_bytes(&self.cancelled)?;
            let total = self.search_bytes.checked_add(bytes.len()).filter(|total| *total <= MAX_BYTES).ok_or_else(refused)?;
            let content = std::str::from_utf8(&bytes).ok().filter(|_| !bytes.contains(&0));
            let Some(content) = content else {
                observation.validate(&self.cancelled)?;
                self.search_bytes = total;
                return Ok(json!({ "searchable": false, "matches": [], "bytesRead": bytes.len() }));
            };
            let expression = self.searches.get(pattern).ok_or_else(refused)?;
            let mut matches = Vec::new();
            let mut output_bytes = 0usize;
            for (index, line) in content.lines().enumerate() {
                check(&self.cancelled)?;
                if expression.is_match(line) {
                    output_bytes = output_bytes.checked_add(line.len()).filter(|total| *total <= 1024 * 1024).ok_or_else(refused)?;
                    matches.push(json!({ "lineNumber": index + 1, "line": line }));
                    if matches.len() == maximum { break; }
                }
            }
            observation.validate(&self.cancelled)?;
            self.search_bytes = total;
            return Ok(json!({ "searchable": true, "matches": matches, "bytesRead": bytes.len() }));
        }
        if action == "write-chunk" { return self.write_chunk(reference, params); }
        if action == "finish-write" { return self.finish_write(reference, params); }
        if action == "copy-file" { return self.copy_file(reference, params); }
        if action == "write" {
            let bytes = params.get("bytes").and_then(Value::as_array).filter(|bytes| bytes.len() <= MAX_BYTES)
                .ok_or_else(refused)?.iter().map(|byte| byte.as_u64().filter(|byte| *byte <= 255)
                    .map(|byte| byte as u8).ok_or_else(refused)).collect::<Result<Vec<_>, _>>()?;
            self.write_bytes(reference, &bytes)?;
            return Ok(Value::Null);
        }
        let observation = self.observation(reference)?;
        match action {
            "validate" => Ok(Value::Null),
            "compare-component" => observation.compare_component(params, &self.cancelled),
            "office-document" => observation.open_document(&self.cancelled),
            "exists" => Ok(json!(observation.resolved.file.is_some())),
            "stat" => {
                if !["read", "list", "traverse"].contains(&observation.target.purpose.as_str()) { return Err(refused()); }
                let file = observation.resolved.file.as_ref().ok_or_else(refused)?;
                check(&self.cancelled)?;
                let metadata = file.metadata().map_err(io_error)?;
                Ok(json!({ "isFile": observation.resolved.is_file, "isDirectory": observation.resolved.is_dir,
                    "isSymlink": observation.resolved.is_symlink, "size": metadata.len(),
                    "mtime": metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_millis() as u64) }))
            }
            "read" => {
                let bytes = observation.read_bytes(&self.cancelled)?;
                Ok(json!({ "bytes": bytes }))
            }
            "media-info" => observation.media_info(&self.cancelled),
            "read-media-range" => observation.read_media_range(params, &self.cancelled),
            "enumerate" => {
                if !["list", "traverse", "delete"].contains(&observation.target.purpose.as_str())
                    || !observation.resolved.is_dir
                    || (observation.resolved.is_symlink && (!observation.target.follow || observation.target.purpose == "delete")) { return Err(refused()); }
                if !params.get("cursor").is_none_or(Value::is_null) { return Err(refused()); }
                let file = observation.resolved.file.as_ref().ok_or_else(refused)?;
                let names = platform::names(file, &|| check(&self.cancelled).map_err(|_| io::Error::other("File session cancelled")))
                    .map_err(io_error)?;
                observation.validate(&self.cancelled)?;
                let mut entries = Vec::new();
                for name in names {
                    if name.contains(['/', '\\', '\0']) || name.is_empty() { return Err(refused()); }
                    let entry = self.reference()?;
                    self.entries.insert(entry.clone(), Entry { parent: reference.to_owned(), name: name.clone() });
                    entries.push(json!({ "name": name, "reference": entry }));
                }
                Ok(json!({ "entries": entries, "cursor": null, "complete": true }))
            }
            _ => Err(refused()),
        }
    }
}

fn remove_branch_entry(parent: &File, name: &str, cancelled: &AtomicBool, depth: usize) -> Result<(), HelperError> {
    check(cancelled)?;
    if depth > 128 { return Err(refused()); }
    let entry = platform::relative(parent, name, Access::Attributes, false, None).map_err(io_error)?;
    let metadata = entry.metadata().map_err(io_error)?;
    let directory = metadata.is_dir() && !metadata.file_type().is_symlink();
    if directory {
        for child in platform::names(&entry, &|| check(cancelled).map_err(|_| io::Error::other("File session cancelled"))).map_err(io_error)? {
            remove_branch_entry(&entry, &child, cancelled, depth + 1)?;
        }
    }
    check(cancelled)?;
    drop(entry);
    platform::remove_entry(parent, name, directory).map_err(|error| io_error(error).after_dispatch())
}

pub(crate) fn handle(params: &Value) -> Result<Value, HelperError> {
    let id = session_id(params)?;
    let action = text(params, "action")?;
    let mut sessions = SESSIONS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| refused())?;
    if action == "release" {
        sessions.remove(&id);
        if let Some(controls) = CONTROLS.get() {
            controls.lock().map_err(|_| refused())?.active.remove(&id);
        }
        return Ok(Value::Null);
    }
    if action == "open" {
        let cancelled = CONTROLS.get_or_init(|| Mutex::new(Controls::default())).lock().map_err(|_| refused())?
            .active.get(&id).cloned().ok_or_else(refused)?;
        check(&cancelled)?;
        if sessions.contains_key(&id) { return Err(refused()); }
        let targets = params.get("targets").and_then(Value::as_array).ok_or_else(refused)?
            .iter().map(Target::parse).collect::<Result<Vec<_>, _>>()?;
        sessions.insert(id, Session { id, cancelled, targets, observations: HashMap::new(), entries: HashMap::new(),
            created: HashMap::new(), serial: 0, searches: HashMap::new(), search_bytes: 0, stream_writes: HashMap::new() });
        return Ok(json!({ "session": id.to_string() }));
    }
    sessions.get_mut(&id).ok_or_else(refused)?.run(params)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn image_output_bounds_seek_and_write_before_allocating() {
        let cancelled = AtomicBool::new(false);
        let mut output = ImageOutput { bytes: Vec::new(), position: 0, cancelled: &cancelled };
        output.write_all(b"encoded").unwrap();
        assert!(output.seek(SeekFrom::Start(MAX_BYTES as u64 + 1)).is_err());
        output.seek(SeekFrom::Start(MAX_BYTES as u64)).unwrap();
        assert!(output.write_all(b"x").is_err());
        assert_eq!(output.bytes, b"encoded");
    }

    #[test]
    fn image_output_supports_tiff_seeks_without_losing_encoded_bytes() {
        let cancelled = AtomicBool::new(false);
        let mut output = ImageOutput { bytes: Vec::new(), position: 0, cancelled: &cancelled };
        output.write_all(b"abcd").unwrap();
        output.seek(SeekFrom::Start(1)).unwrap();
        output.write_all(b"XY").unwrap();
        output.seek(SeekFrom::End(0)).unwrap();
        output.write_all(b"z").unwrap();
        assert_eq!(output.bytes, b"aXYdz");
    }

    #[test]
    fn image_output_rechecks_cancellation_during_encoding() {
        let cancelled = AtomicBool::new(false);
        let mut output = ImageOutput { bytes: Vec::new(), position: 0, cancelled: &cancelled };
        output.write_all(b"partial").unwrap();
        cancelled.store(true, Ordering::Release);
        assert!(output.write_all(b"next").is_err());
        assert!(output.seek(SeekFrom::Start(0)).is_err());
        assert_eq!(output.bytes, b"partial");
    }

    fn office_fixture(run: impl FnOnce(&Observation, &Path, &AtomicBool)) {
        let parent_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.agent").canonicalize().unwrap();
        let parent = platform::canonical(&platform::root(&parent_path).unwrap()).unwrap();
        let root = parent.join(format!("file-office-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("public")).unwrap();
        std::fs::create_dir(root.join("private")).unwrap();
        let target = root.join("public/report.xlsx");
        std::fs::write(&target, b"approved fixture").unwrap();
        std::fs::write(root.join("private/report.xlsx"), b"other fixture").unwrap();
        std::fs::hard_link(&target, root.join("public/other.xlsx")).unwrap();
        let cancelled = AtomicBool::new(false);
        let observation = Observation::new(Target { path: target, purpose: "read".into(), follow: true }, &cancelled, None).unwrap();
        run(&observation, &root, &cancelled);
        drop(observation);
        let resolved = platform::canonical(&platform::root(&root).unwrap()).unwrap();
        assert!(resolved != parent && resolved.starts_with(&parent), "fixture cleanup must remain inside the repository agent directory");
        std::fs::remove_dir_all(resolved).unwrap();
    }

    #[test]
    fn scoped_office_only_publishes_the_approved_entry() {
        office_fixture(|observation, root, cancelled| {
            let denied = slash(&root.join("private/report.xlsx")).unwrap();
            let allowed = slash(&root.join("public/report.xlsx")).unwrap();
            let report = observation.filter_open_documents([
                ("word", denied.as_str(), true), ("excel", allowed.as_str(), true),
            ], true, cancelled).unwrap();
            assert_eq!(report["documents"].as_array().unwrap().len(), 1);
            assert_eq!(report["documents"][0]["path"], allowed);
            assert_eq!(report["documents"][0]["name"], "report.xlsx");
            assert_eq!(report["documents"][0]["app"], "excel");
            assert_eq!(report["documents"][0]["unsaved"], true);
            assert_eq!(report["complete"], true);
        });
    }

    #[test]
    fn scoped_office_distinguishes_a_second_hardlink_entry() {
        office_fixture(|observation, root, cancelled| {
            let other = slash(&root.join("public/other.xlsx")).unwrap();
            let report = observation.filter_open_documents([("excel", other.as_str(), true)], true, cancelled).unwrap();
            assert!(report["documents"].as_array().unwrap().is_empty());
            assert_eq!(report["complete"], true);
        });
    }

    #[test]
    fn scoped_office_unknown_names_and_cancellation_never_publish_metadata() {
        office_fixture(|observation, _, cancelled| {
            let report = observation.filter_open_documents([("excel", "unresolved.xlsx", true)], true, cancelled).unwrap();
            assert!(report["documents"].as_array().unwrap().is_empty());
            assert_eq!(report["complete"], false);
            cancelled.store(true, Ordering::Release);
            assert!(observation.filter_open_documents([("excel", "unresolved.xlsx", true)], true, cancelled).is_err());
        });
    }
}
