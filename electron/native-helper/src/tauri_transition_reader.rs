//! Read-only bridge for the one-time Tauri -> Electron transition.
//!
//! The caller copies WebView2's LevelDB directory to a temporary staging
//! directory before invoking this binary. The original profile is never
//! opened, locked, rewritten, or deleted. On Windows this binary can also read
//! an explicit allowlist of Abu Credential Manager entries. Secret values are
//! returned only on stdout to the parent process and are never logged.

use rusty_leveldb::{LdbIterator, Options, DB};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::Path;

#[cfg(target_os = "windows")]
const MAX_KEYS: usize = 256;
const MAX_ITEMS: usize = 128;
const MAX_ITEM_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum Request {
    LocalStorage { database: String },
    WindowsSecrets { keys: Vec<String> },
}

#[derive(Serialize)]
struct Item {
    key: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStorageResponse {
    items: Vec<Item>,
    rejected_count: usize,
}

#[derive(Serialize)]
struct SecretResponse {
    entries: Vec<Item>,
    missing: Vec<String>,
    failed: Vec<String>,
}

fn decode_dom_string(raw: &[u8]) -> Option<String> {
    let (&encoding, bytes) = raw.split_first()?;
    let decoded = match encoding {
        0 => {
            if bytes.len() % 2 != 0 {
                return None;
            }
            let units = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
            String::from_utf16(&units.collect::<Vec<_>>()).ok()?
        }
        1 => bytes.iter().map(|byte| char::from(*byte)).collect(),
        _ => return None,
    };
    Some(decoded)
}

fn is_tauri_storage_key(serialized: &[u8]) -> bool {
    let Ok(value) = std::str::from_utf8(serialized) else {
        return false;
    };
    matches!(
        value.trim_end_matches('/'),
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
    )
}

fn read_local_storage(database: &str) -> Result<LocalStorageResponse, String> {
    let database_path = Path::new(database);
    if !database_path.join("CURRENT").is_file() {
        return Err("staged LevelDB has no CURRENT file".into());
    }

    let mut options = Options::default();
    options.create_if_missing = false;
    options.error_if_exists = false;
    options.reuse_logs = false;
    options.reuse_manifest = false;
    let mut db = DB::open(database_path, options)
        .map_err(|error| format!("could not open staged LevelDB: {error}"))?;
    let mut iterator = db
        .new_iter()
        .map_err(|error| format!("could not iterate staged LevelDB: {error}"))?;

    let mut items = Vec::new();
    let mut rejected_count = 0usize;
    let mut total_bytes = 0usize;
    while let Some((raw_key, raw_value)) = iterator.next() {
        if raw_key.first() != Some(&b'_') {
            continue;
        }
        let Some(separator) = raw_key[1..].iter().position(|byte| *byte == 0) else {
            rejected_count += 1;
            continue;
        };
        let separator = separator + 1;
        if !is_tauri_storage_key(&raw_key[1..separator]) {
            continue;
        }
        let Some(key) = decode_dom_string(&raw_key[separator + 1..]) else {
            rejected_count += 1;
            continue;
        };
        let Some(value) = decode_dom_string(&raw_value) else {
            rejected_count += 1;
            continue;
        };
        let bytes = key.len().saturating_add(value.len());
        if items.len() >= MAX_ITEMS
            || bytes > MAX_ITEM_BYTES
            || total_bytes.saturating_add(bytes) > MAX_TOTAL_BYTES
        {
            rejected_count += 1;
            continue;
        }
        total_bytes += bytes;
        items.push(Item { key, value });
    }
    Ok(LocalStorageResponse {
        items,
        rejected_count,
    })
}

#[cfg(target_os = "windows")]
fn read_windows_secrets(keys: Vec<String>) -> Result<SecretResponse, String> {
    if keys.len() > MAX_KEYS {
        return Err("too many secret keys requested".into());
    }
    let mut entries = Vec::new();
    let mut missing = Vec::new();
    let mut failed = Vec::new();
    for key in keys {
        if key.is_empty() || key.len() > 512 {
            failed.push(key);
            continue;
        }
        let entry = match keyring::Entry::new("abu", &key) {
            Ok(entry) => entry,
            Err(_) => {
                failed.push(key);
                continue;
            }
        };
        match entry.get_password() {
            Ok(value) => entries.push(Item { key, value }),
            Err(keyring::Error::NoEntry) => missing.push(key),
            Err(_) => failed.push(key),
        }
    }
    Ok(SecretResponse {
        entries,
        missing,
        failed,
    })
}

#[cfg(not(target_os = "windows"))]
fn read_windows_secrets(_keys: Vec<String>) -> Result<SecretResponse, String> {
    Err("Windows Credential Manager is available only on Windows".into())
}

fn main() {
    let result = (|| -> Result<String, String> {
        let mut input = String::new();
        io::stdin()
            .take(1024 * 1024)
            .read_to_string(&mut input)
            .map_err(|error| format!("could not read request: {error}"))?;
        let request: Request =
            serde_json::from_str(&input).map_err(|_| "invalid request JSON".to_string())?;
        match request {
            Request::LocalStorage { database } => {
                serde_json::to_string(&read_local_storage(&database)?)
                    .map_err(|error| format!("could not encode response: {error}"))
            }
            Request::WindowsSecrets { keys } => serde_json::to_string(&read_windows_secrets(keys)?)
                .map_err(|error| format!("could not encode response: {error}")),
        }
    })();

    match result {
        Ok(json) => println!("{json}"),
        Err(message) => {
            eprintln!("tauri-transition-reader: {message}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_dom_string, is_tauri_storage_key, read_local_storage};
    use rusty_leveldb::{Options, DB};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn decodes_chromium_dom_strings() {
        assert_eq!(
            decode_dom_string(&[1, b'a', b'b', b'u']),
            Some("abu".to_string())
        );
        assert_eq!(
            decode_dom_string(&[0, b'a', 0, b'b', 0, b'u', 0]),
            Some("abu".to_string())
        );
        assert_eq!(decode_dom_string(&[0, b'a']), None);
        assert_eq!(decode_dom_string(&[2, b'a']), None);
    }

    #[test]
    fn accepts_only_tauri_production_origins() {
        assert!(is_tauri_storage_key(b"https://tauri.localhost/"));
        assert!(is_tauri_storage_key(b"tauri://localhost"));
        assert!(!is_tauri_storage_key(b"https://example.com"));
        assert!(!is_tauri_storage_key(b"https://tauri.localhost.evil"));
    }

    #[test]
    fn reads_a_chromium_local_storage_leveldb_copy() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "abu-transition-leveldb-{}-{unique}",
            std::process::id()
        ));
        let mut database = DB::open(&root, Options::default()).expect("create fixture");
        let mut key = b"_https://tauri.localhost/\0".to_vec();
        key.extend_from_slice(&[1]);
        key.extend_from_slice(b"abu-settings");
        let mut value = vec![1];
        value.extend_from_slice(br#"{"state":{"source":"tauri"},"version":42}"#);
        database.put(&key, &value).expect("write fixture");
        database.flush().expect("flush fixture");
        drop(database);

        let result = read_local_storage(root.to_str().expect("utf8 path")).expect("read fixture");
        assert_eq!(result.rejected_count, 0);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].key, "abu-settings");
        assert_eq!(
            result.items[0].value,
            r#"{"state":{"source":"tauri"},"version":42}"#
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn credential_manager_round_trip_on_ci() {
        if std::env::var("CI").as_deref() != Ok("true") {
            return;
        }
        let key = format!("abu-transition-test-{}", std::process::id());
        let entry = keyring::Entry::new("abu", &key).expect("create credential entry");
        entry
            .set_password("not-a-real-secret")
            .expect("write credential");
        assert_eq!(
            entry.get_password().expect("read credential"),
            "not-a-real-secret"
        );
        entry.delete_credential().expect("delete credential");
    }
}
