//! Platform-aware secret storage for Abu API keys.
//!
//! - **Windows / Linux**: delegates to the `keyring` crate
//!   (Windows Credential Manager via DPAPI; Linux secret-service).
//! - **macOS**: hardware-bound AES-256-GCM. Key is derived from the machine
//!   UUID via HKDF-SHA256, so the ciphertext file can only be decrypted on
//!   the same physical machine. Protects against file-level leaks (backups,
//!   screenshots, cloud-sync) but not against same-user process attacks.
//!
//! Why not Keychain on macOS: without an Apple Developer account our builds
//! are ad-hoc signed; the signature hash changes on every build, which
//! invalidates Keychain ACLs and would re-prompt the user on every update.
//! When a Dev account is available, add a Keychain implementation here
//! guarded by `#[cfg(feature = "keychain")]`.
//!
//! Storage keys use colon-namespaced identifiers: e.g. `provider:claude`,
//! `aux:webSearch`. The `KEYRING_SERVICE` constant below is the service name
//! surfaced in Credential Manager / secret-service for grouping.

use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::Mutex;

/// Service name shown in OS credential stores. Appears in
/// `Credential Manager → Generic Credentials` on Windows.
#[cfg(not(target_os = "macos"))]
const KEYRING_SERVICE: &str = "abu";

#[derive(Debug)]
pub enum SecretError {
    DecryptFailed(String),
    Io(String),
    Backend(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DecryptFailed(m) => write!(f, "decrypt failed: {}", m),
            Self::Io(m) => write!(f, "io error: {}", m),
            Self::Backend(m) => write!(f, "backend error: {}", m),
        }
    }
}

impl std::error::Error for SecretError {}

/// Public entry point. Constructed once at app startup via [`SecretStore::load`]
/// and stored in Tauri state.
pub struct SecretStore {
    #[cfg(target_os = "macos")]
    inner: Mutex<macos::Inner>,
}

impl SecretStore {
    /// Load the secret store. On macOS this reads the ciphertext file at
    /// `path` (creating it on first run); on other platforms `path` is unused
    /// because storage is OS-managed.
    pub fn load(path: &Path) -> Result<Self, SecretError> {
        #[cfg(target_os = "macos")]
        {
            let inner = macos::Inner::load(path)?;
            Ok(Self { inner: Mutex::new(inner) })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            Ok(Self {})
        }
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.lock().map_err(|e| SecretError::Backend(e.to_string()))?;
            inner.get(key)
        }
        #[cfg(not(target_os = "macos"))]
        {
            match keyring_entry(key)?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(SecretError::Backend(e.to_string())),
            }
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        #[cfg(target_os = "macos")]
        {
            let mut inner = self.inner.lock().map_err(|e| SecretError::Backend(e.to_string()))?;
            inner.set(key, value)
        }
        #[cfg(not(target_os = "macos"))]
        {
            keyring_entry(key)?
                .set_password(value)
                .map_err(|e| SecretError::Backend(e.to_string()))
        }
    }

    pub fn delete(&self, key: &str) -> Result<(), SecretError> {
        #[cfg(target_os = "macos")]
        {
            let mut inner = self.inner.lock().map_err(|e| SecretError::Backend(e.to_string()))?;
            inner.delete(key)
        }
        #[cfg(not(target_os = "macos"))]
        {
            match keyring_entry(key)?.delete_credential() {
                Ok(()) => Ok(()),
                // Deleting a non-existent entry is a no-op from the caller's view.
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(SecretError::Backend(e.to_string())),
            }
        }
    }

    pub fn has(&self, key: &str) -> Result<bool, SecretError> {
        self.get(key).map(|v| v.is_some())
    }

    /// List all stored keys. macOS reads from the in-memory index;
    /// Windows/Linux returns `None` because the `keyring` crate has no
    /// enumeration API, and we keep no side index to avoid drift.
    pub fn list(&self) -> Result<Option<Vec<String>>, SecretError> {
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.lock().map_err(|e| SecretError::Backend(e.to_string()))?;
            Ok(Some(inner.keys()))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(None)
        }
    }

    /// Keys that were present on disk but could not be decrypted with the
    /// current machine-derived key (e.g. after a hardware change or UUID
    /// rotation). The UI surfaces these so users know their prior API
    /// keys need to be re-entered rather than silently finding them blank.
    ///
    /// Windows/Linux have no equivalent failure mode exposed here: a
    /// keyring read that fails is reported per-call via `get`. We return
    /// an empty slice in that case to keep the API shape uniform.
    pub fn failed_keys(&self) -> Result<Vec<String>, SecretError> {
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.lock().map_err(|e| SecretError::Backend(e.to_string()))?;
            Ok(inner.failed_keys())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(Vec::new())
        }
    }

    /// Wipe every stored secret. On macOS the file is overwritten with an
    /// empty entry map (not deleted, so permissions stay consistent); on
    /// Windows/Linux we iterate `keyring` entries via a frontend-provided
    /// list because the crate has no `clear_service` API.
    pub fn clear_all(&self, known_keys: &[String]) -> Result<(), SecretError> {
        #[cfg(target_os = "macos")]
        {
            let _ = known_keys;
            let mut inner = self.inner.lock().map_err(|e| SecretError::Backend(e.to_string()))?;
            inner.clear_all()
        }
        #[cfg(not(target_os = "macos"))]
        {
            for key in known_keys {
                if let Err(e) = self.delete(key) {
                    return Err(e);
                }
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keyring_entry(key: &str) -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| SecretError::Backend(e.to_string()))
}

// ================================================================
// macOS — hardware-bound AES-256-GCM
// ================================================================

#[cfg(target_os = "macos")]
mod macos {
    use super::SecretError;
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use base64::Engine;
    use hkdf::Hkdf;
    use rand::rngs::OsRng;
    use rand::RngCore;
    use sha2::Sha256;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    /// Fixed salt. Changing this invalidates all existing ciphertext —
    /// reserved for a future crypto rotation.
    const HKDF_SALT: &[u8] = b"abu.secrets.v1";
    /// Context string for HKDF expansion; pinned to the app and version tier.
    const HKDF_INFO: &[u8] = b"abu-secrets-aes256gcm";
    /// On-disk file format version; written to JSON so future readers can
    /// detect format changes without parsing ciphertext.
    const FILE_FORMAT_VERSION: u32 = 1;
    const NONCE_LEN: usize = 12; // AES-GCM standard
    const KEY_LEN: usize = 32; // AES-256

    #[derive(serde::Serialize, serde::Deserialize, Default)]
    struct FileModel {
        version: u32,
        /// key → base64(nonce || ciphertext || tag)
        entries: BTreeMap<String, String>,
    }

    pub struct Inner {
        path: PathBuf,
        cipher: Aes256Gcm,
        entries: BTreeMap<String, String>, // plaintext, cached
        /// Keys that existed on disk but failed to decrypt on load (e.g.
        /// hardware UUID changed, ciphertext tampered). Cleared on next
        /// successful write so stale entries don't linger forever.
        failed: Vec<String>,
    }

    impl Inner {
        pub fn load(path: &Path) -> Result<Self, SecretError> {
            let machine_uid = machine_uid::get()
                .map_err(|e| SecretError::Backend(format!("machine uid: {}", e)))?;
            let key = derive_key(machine_uid.as_bytes())?;
            let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));

            let (entries, failed) = if path.exists() {
                let bytes = std::fs::read(path).map_err(|e| SecretError::Io(e.to_string()))?;
                if bytes.is_empty() {
                    (BTreeMap::new(), Vec::new())
                } else {
                    let model: FileModel = serde_json::from_slice(&bytes)
                        .map_err(|e| SecretError::Io(format!("parse secrets.bin: {}", e)))?;
                    if model.version != FILE_FORMAT_VERSION {
                        return Err(SecretError::Io(format!(
                            "unsupported secrets file version {}",
                            model.version
                        )));
                    }
                    decrypt_all(&cipher, &model.entries)
                }
            } else {
                (BTreeMap::new(), Vec::new())
            };

            if !failed.is_empty() {
                eprintln!(
                    "[secrets] {} entries failed to decrypt (likely hardware change): {:?}",
                    failed.len(),
                    failed
                );
            }

            Ok(Self { path: path.to_path_buf(), cipher, entries, failed })
        }

        pub fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
            Ok(self.entries.get(key).cloned())
        }

        pub fn set(&mut self, key: &str, value: &str) -> Result<(), SecretError> {
            self.entries.insert(key.to_string(), value.to_string());
            // Overwriting a key makes any prior decrypt failure for it moot.
            self.failed.retain(|k| k != key);
            self.persist()
        }

        pub fn delete(&mut self, key: &str) -> Result<(), SecretError> {
            self.entries.remove(key);
            self.failed.retain(|k| k != key);
            self.persist()
        }

        pub fn keys(&self) -> Vec<String> {
            self.entries.keys().cloned().collect()
        }

        pub fn failed_keys(&self) -> Vec<String> {
            self.failed.clone()
        }

        pub fn clear_all(&mut self) -> Result<(), SecretError> {
            self.entries.clear();
            self.failed.clear();
            self.persist()
        }

        /// Encrypt the full in-memory map and write atomically
        /// (temp file + rename) to avoid partial writes on crash.
        fn persist(&self) -> Result<(), SecretError> {
            let encrypted = encrypt_all(&self.cipher, &self.entries)?;
            let model = FileModel { version: FILE_FORMAT_VERSION, entries: encrypted };
            let json = serde_json::to_vec(&model)
                .map_err(|e| SecretError::Io(format!("serialize: {}", e)))?;

            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| SecretError::Io(e.to_string()))?;
            }

            let tmp = self.path.with_extension("bin.tmp");
            {
                let mut f = std::fs::File::create(&tmp)
                    .map_err(|e| SecretError::Io(e.to_string()))?;
                f.write_all(&json).map_err(|e| SecretError::Io(e.to_string()))?;
                f.sync_all().map_err(|e| SecretError::Io(e.to_string()))?;
            }
            std::fs::rename(&tmp, &self.path).map_err(|e| SecretError::Io(e.to_string()))?;
            Ok(())
        }
    }

    fn derive_key(machine_id: &[u8]) -> Result<[u8; KEY_LEN], SecretError> {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), machine_id);
        let mut okm = [0u8; KEY_LEN];
        hk.expand(HKDF_INFO, &mut okm)
            .map_err(|e| SecretError::Backend(format!("hkdf expand: {}", e)))?;
        Ok(okm)
    }

    fn encrypt_all(
        cipher: &Aes256Gcm,
        plain: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, SecretError> {
        let mut out = BTreeMap::new();
        for (k, v) in plain {
            let mut nonce_bytes = [0u8; NONCE_LEN];
            OsRng.fill_bytes(&mut nonce_bytes);
            let nonce = Nonce::from_slice(&nonce_bytes);
            let mut ciphertext = cipher
                .encrypt(nonce, v.as_bytes())
                .map_err(|e| SecretError::Backend(format!("encrypt: {}", e)))?;

            // Pack as nonce || ciphertext_with_tag
            let mut packed = Vec::with_capacity(NONCE_LEN + ciphertext.len());
            packed.extend_from_slice(&nonce_bytes);
            packed.append(&mut ciphertext);
            out.insert(k.clone(), base64::engine::general_purpose::STANDARD.encode(&packed));
        }
        Ok(out)
    }

    /// Decrypt every entry in `encrypted`, returning successfully decrypted
    /// pairs plus the list of keys that failed. Partial recovery is intentional:
    /// one tampered or machine-rotated entry must not lock the user out of
    /// their other providers. Failed keys are surfaced via
    /// [`Inner::failed_keys`] so the UI can show "please re-enter" hints.
    fn decrypt_all(
        cipher: &Aes256Gcm,
        encrypted: &BTreeMap<String, String>,
    ) -> (BTreeMap<String, String>, Vec<String>) {
        let mut out = BTreeMap::new();
        let mut failed = Vec::new();
        for (k, b64) in encrypted {
            match try_decrypt_entry(cipher, b64) {
                Ok(plain) => {
                    out.insert(k.clone(), plain);
                }
                Err(_) => {
                    failed.push(k.clone());
                }
            }
        }
        (out, failed)
    }

    fn try_decrypt_entry(cipher: &Aes256Gcm, b64: &str) -> Result<String, SecretError> {
        let packed = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| SecretError::DecryptFailed(format!("base64: {}", e)))?;
        if packed.len() <= NONCE_LEN {
            return Err(SecretError::DecryptFailed("truncated entry".to_string()));
        }
        let (nonce_bytes, ct) = packed.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plain = cipher
            .decrypt(nonce, ct)
            .map_err(|e| SecretError::DecryptFailed(format!("aes-gcm: {}", e)))?;
        String::from_utf8(plain)
            .map_err(|e| SecretError::DecryptFailed(format!("utf8: {}", e)))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tempfile::TempDir;

        fn fixed_cipher() -> Aes256Gcm {
            // Deterministic key for in-test round-trip; don't use real machine id
            let key = [7u8; KEY_LEN];
            Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        }

        fn inner_with_cipher(path: PathBuf, cipher: Aes256Gcm) -> Inner {
            Inner { path, cipher, entries: BTreeMap::new(), failed: Vec::new() }
        }

        #[test]
        fn roundtrip_set_get_delete() {
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join("secrets.bin");
            let mut inner = inner_with_cipher(path.clone(), fixed_cipher());

            inner.set("provider:claude", "sk-ant-test-123").unwrap();
            inner.set("aux:webSearch", "tvly-test").unwrap();
            assert_eq!(inner.get("provider:claude").unwrap().as_deref(), Some("sk-ant-test-123"));
            assert_eq!(inner.get("aux:webSearch").unwrap().as_deref(), Some("tvly-test"));
            assert_eq!(inner.get("missing").unwrap(), None);

            // Reload from disk — verifies persistence and decryption path.
            let bytes = std::fs::read(&path).unwrap();
            let model: FileModel = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(model.version, FILE_FORMAT_VERSION);
            let (reloaded, failed) = decrypt_all(&fixed_cipher(), &model.entries);
            assert!(failed.is_empty());
            assert_eq!(reloaded.get("provider:claude").unwrap(), "sk-ant-test-123");

            inner.delete("provider:claude").unwrap();
            assert_eq!(inner.get("provider:claude").unwrap(), None);
            assert_eq!(inner.get("aux:webSearch").unwrap().as_deref(), Some("tvly-test"));
        }

        #[test]
        fn nonce_is_unique_per_write() {
            // Encrypt the same key twice; ciphertexts must differ because
            // each write generates a fresh nonce. Nonce reuse under the same
            // key is catastrophic for AES-GCM, so this guards against
            // accidentally hardcoding a nonce.
            let cipher = fixed_cipher();
            let mut map = BTreeMap::new();
            map.insert("k".to_string(), "v".to_string());
            let a = encrypt_all(&cipher, &map).unwrap();
            let b = encrypt_all(&cipher, &map).unwrap();
            assert_ne!(a.get("k").unwrap(), b.get("k").unwrap());
        }

        #[test]
        fn corrupted_entry_yields_failed_key_not_total_failure() {
            let cipher = fixed_cipher();
            let mut map = BTreeMap::new();
            map.insert("good".to_string(), "v1".to_string());
            map.insert("bad".to_string(), "v2".to_string());
            let mut encrypted = encrypt_all(&cipher, &map).unwrap();
            // Flip one bit in the "bad" ciphertext → GCM auth tag rejects.
            let tampered = {
                let b64 = encrypted.get("bad").unwrap();
                let mut bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
                let last = bytes.len() - 1;
                bytes[last] ^= 0x01;
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            };
            encrypted.insert("bad".to_string(), tampered);

            let (ok, failed) = decrypt_all(&cipher, &encrypted);
            // Partial recovery: the good entry is preserved, the bad one is
            // listed as failed. The user's other providers stay accessible.
            assert_eq!(ok.get("good").unwrap(), "v1");
            assert!(ok.get("bad").is_none());
            assert_eq!(failed, vec!["bad".to_string()]);
        }

        #[test]
        fn wrong_key_marks_all_entries_failed() {
            let cipher_a = fixed_cipher();
            let cipher_b = {
                let key = [9u8; KEY_LEN];
                Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
            };
            let mut map = BTreeMap::new();
            map.insert("a".to_string(), "1".to_string());
            map.insert("b".to_string(), "2".to_string());
            let encrypted = encrypt_all(&cipher_a, &map).unwrap();
            // Simulates IOPlatformUUID change / hardware swap: every entry
            // should end up in `failed`, but load itself succeeds so the UI
            // can prompt the user instead of the app crashing.
            let (ok, failed) = decrypt_all(&cipher_b, &encrypted);
            assert!(ok.is_empty());
            assert_eq!(failed.len(), 2);
            assert!(failed.contains(&"a".to_string()));
            assert!(failed.contains(&"b".to_string()));
        }

        #[test]
        fn load_missing_file_yields_empty_store() {
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join("does-not-exist.bin");
            let inner = Inner::load(&path).unwrap();
            assert!(inner.keys().is_empty());
            assert!(inner.failed_keys().is_empty());
        }

        #[test]
        fn set_on_previously_failed_key_clears_failed_flag() {
            // After user re-enters a key that failed to decrypt, the
            // "needs re-enter" hint must disappear.
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join("secrets.bin");
            let mut inner = inner_with_cipher(path, fixed_cipher());
            inner.failed.push("provider:claude".to_string());

            inner.set("provider:claude", "sk-new").unwrap();
            assert!(inner.failed_keys().is_empty());
        }

        #[test]
        fn clear_all_wipes_entries_and_failed() {
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join("secrets.bin");
            let mut inner = inner_with_cipher(path, fixed_cipher());
            inner.set("k1", "v1").unwrap();
            inner.failed.push("k2".to_string());

            inner.clear_all().unwrap();
            assert!(inner.keys().is_empty());
            assert!(inner.failed_keys().is_empty());
        }
    }
}
