use serde::Serialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;
use std::sync::{Mutex, OnceLock};

use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use ::windows::Win32::Security::Cryptography::Catalog::{
    CryptCATAdminAcquireContext2, CryptCATAdminCalcHashFromFileHandle2,
    CryptCATAdminEnumCatalogFromHash, CryptCATAdminReleaseCatalogContext,
    CryptCATAdminReleaseContext, CryptCATCatalogInfoFromContext, CATALOG_INFO,
};
use ::windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use ::windows::Win32::Security::Cryptography::{
    CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext, CertGetNameStringW,
    CryptMsgClose, CryptMsgGetParam, CryptQueryObject, CERT_FIND_SUBJECT_CERT, CERT_INFO,
    CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_ENCODING_TYPE, CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE,
    CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, HCERTSTORE, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
};
use ::windows::Win32::Security::WinTrust::{
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_CATALOG_INFO, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_CATALOG,
    WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE,
    WTD_REVOKE_NONE, WTD_STATEACTION_IGNORE, WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
};

#[derive(Clone, Debug, Serialize)]
pub struct SignatureIdentity {
    pub signature_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signer_subject: Option<String>,
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn verify_embedded_signature(path: &str) -> bool {
    let wide_path = wide_null(path);
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide_path.as_ptr()),
        hFile: HANDLE::default(),
        pgKnownSubject: ptr::null_mut(),
    };
    let mut trust_data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: &mut file_info,
        },
        dwStateAction: WTD_STATEACTION_IGNORE,
        // Signature inspection must never pause Computer Use on a certificate
        // download. Microsoft documents this as the no-network verification
        // flag, so policy remains deterministic and bounded.
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
        dwUIContext: WTD_UICONTEXT_EXECUTE,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    unsafe {
        WinVerifyTrust(
            HWND::default(),
            &mut action,
            (&mut trust_data as *mut WINTRUST_DATA).cast::<c_void>(),
        ) == 0
    }
}

fn embedded_signer_subject(path: &str) -> Option<String> {
    let wide_path = wide_null(path);
    let mut encoding = CERT_QUERY_ENCODING_TYPE::default();
    let mut store = HCERTSTORE::default();
    let mut message: *mut c_void = ptr::null_mut();
    unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            wide_path.as_ptr().cast::<c_void>(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            Some(&mut encoding),
            None,
            None,
            Some(&mut store),
            Some(&mut message),
            None,
        )
        .ok()?;
    }

    let result = (|| unsafe {
        if message.is_null() || store.0.is_null() {
            return None;
        }
        let mut required = 0u32;
        CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, None, &mut required).ok()?;
        if required < size_of::<CMSG_SIGNER_INFO>() as u32 || required > 1024 * 1024 {
            return None;
        }
        // A usize backing buffer guarantees alignment for CMSG_SIGNER_INFO.
        let word = size_of::<usize>();
        let mut signer_storage = vec![0usize; (required as usize + word - 1) / word];
        CryptMsgGetParam(
            message,
            CMSG_SIGNER_INFO_PARAM,
            0,
            Some(signer_storage.as_mut_ptr().cast::<c_void>()),
            &mut required,
        )
        .ok()?;
        let signer = &*(signer_storage.as_ptr().cast::<CMSG_SIGNER_INFO>());
        let search = CERT_INFO {
            Issuer: signer.Issuer,
            SerialNumber: signer.SerialNumber,
            ..Default::default()
        };
        let certificate = CertFindCertificateInStore(
            store,
            X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
            0,
            CERT_FIND_SUBJECT_CERT,
            Some((&search as *const CERT_INFO).cast::<c_void>()),
            None,
        );
        if certificate.is_null() {
            return None;
        }
        let mut name = vec![0u16; 1024];
        let length = CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            None,
            Some(&mut name),
        );
        let _ = CertFreeCertificateContext(Some(certificate));
        if length <= 1 || length as usize > name.len() {
            return None;
        }
        let subject = String::from_utf16_lossy(&name[..length as usize - 1])
            .trim()
            .to_string();
        (!subject.is_empty()).then_some(subject)
    })();

    unsafe {
        if !message.is_null() {
            let _ = CryptMsgClose(Some(message));
        }
        if !store.0.is_null() {
            let _ = CertCloseStore(store, 0);
        }
    }
    result
}

/// The catalog that vouches for a file, when its signature is not inside it.
///
/// Windows does not put an Authenticode signature in most of its own
/// binaries. It hashes them into `.cat` catalogs and signs the catalog, so
/// `WinVerifyTrust` over the file alone says "untrusted" for files that are
/// in fact signed by Microsoft. Measured here: `System32\calc.exe` and
/// `System32\notepad.exe` both verify as `Valid`/`Catalog`/`Microsoft
/// Windows` through the catalog and as nothing at all through the file.
///
/// That mattered in product terms: Calculator and Paint resolve to
/// catalog-signed executables, so they were classified `untrusted` and asked
/// for approval on every cold launch, while Word and QQ — which carry
/// embedded signatures — did not.
fn catalog_signer(path: &str) -> Option<String> {
    let wide_path = wide_null(path);
    let file = unsafe {
        CreateFileW(
            PCWSTR(wide_path.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .ok()?;

    let mut admin = 0isize;
    // SHA-256: catalogs for anything current are hashed with it, and the V1
    // context would silently fall back to SHA-1 and miss them.
    let algorithm = wide_null("SHA256");
    let acquired = unsafe {
        CryptCATAdminAcquireContext2(&mut admin, None, PCWSTR(algorithm.as_ptr()), None, 0)
    };
    if acquired.is_err() {
        unsafe {
            let _ = CloseHandle(file);
        }
        return None;
    }

    // The admin context has to outlive the verification, not just the lookup:
    // a SHA-256 catalog is only verified correctly when `hCatAdmin` is handed
    // to WinTrust, and releasing it first was the difference between
    // "Microsoft Windows" and "untrusted" for every built-in Windows app.
    let signer = (|| {
        let mut hash_size = 0u32;
        // Two calls: the first sizes the hash, the second fills it.
        unsafe { CryptCATAdminCalcHashFromFileHandle2(admin, file, &mut hash_size, None, 0) }
            .ok()?;
        if hash_size == 0 {
            return None;
        }
        let mut hash = vec![0u8; hash_size as usize];
        unsafe {
            CryptCATAdminCalcHashFromFileHandle2(
                admin,
                file,
                &mut hash_size,
                Some(hash.as_mut_ptr()),
                0,
            )
        }
        .ok()?;

        let context = unsafe { CryptCATAdminEnumCatalogFromHash(admin, &hash, 0, None) };
        if context == 0 {
            return None; // Not in any catalog — genuinely unsigned, as far as this goes.
        }
        let catalog_path = catalog_path_of(context);
        let _ = unsafe { CryptCATAdminReleaseCatalogContext(admin, context, 0) };
        let catalog_path = catalog_path?;

        verify_against_catalog(path, &catalog_path, &mut hash, admin)
            .then(|| embedded_signer_subject(&catalog_path))?
    })();

    unsafe {
        let _ = CryptCATAdminReleaseContext(admin, 0);
        let _ = CloseHandle(file);
    }
    signer
}

fn catalog_path_of(context: isize) -> Option<String> {
    let mut info = CATALOG_INFO {
        cbStruct: size_of::<CATALOG_INFO>() as u32,
        ..Default::default()
    };
    unsafe { CryptCATCatalogInfoFromContext(context, &mut info, 0) }.ok()?;
    let end = info
        .wszCatalogFile
        .iter()
        .position(|&value| value == 0)
        .unwrap_or(info.wszCatalogFile.len());
    let path = String::from_utf16_lossy(&info.wszCatalogFile[..end]);
    (!path.is_empty()).then_some(path)
}

/// Verify the file against the catalog that claims it. The member tag is the
/// file hash in uppercase hex, which is how catalogs name their members.
fn verify_against_catalog(
    path: &str,
    catalog_path: &str,
    hash: &mut [u8],
    admin: isize,
) -> bool {
    use std::fmt::Write;
    let tag = hash.iter().fold(String::with_capacity(hash.len() * 2), |mut text, byte| {
        let _ = write!(text, "{byte:02X}");
        text
    });
    let wide_catalog = wide_null(catalog_path);
    let wide_member = wide_null(path);
    let wide_tag = wide_null(&tag);

    let mut catalog_info = WINTRUST_CATALOG_INFO {
        cbStruct: size_of::<WINTRUST_CATALOG_INFO>() as u32,
        pcwszCatalogFilePath: PCWSTR(wide_catalog.as_ptr()),
        pcwszMemberTag: PCWSTR(wide_tag.as_ptr()),
        pcwszMemberFilePath: PCWSTR(wide_member.as_ptr()),
        pbCalculatedFileHash: hash.as_mut_ptr(),
        cbCalculatedFileHash: hash.len() as u32,
        hCatAdmin: admin,
        ..Default::default()
    };
    let mut trust_data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_CATALOG,
        Anonymous: WINTRUST_DATA_0 {
            pCatalog: &mut catalog_info,
        },
        dwStateAction: WTD_STATEACTION_IGNORE,
        // Same no-network rule as the embedded path: signature inspection
        // must never pause Computer Use on a certificate download.
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
        dwUIContext: WTD_UICONTEXT_EXECUTE,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    unsafe {
        WinVerifyTrust(
            HWND::default(),
            &mut action,
            (&mut trust_data as *mut WINTRUST_DATA).cast::<c_void>(),
        ) == 0
    }
}

fn inspect_uncached(path: &str) -> SignatureIdentity {
    if verify_embedded_signature(path) {
        return SignatureIdentity {
            signature_status: "valid".to_string(),
            signer_subject: embedded_signer_subject(path),
        };
    }
    // No signature in the file. It may still be signed, by a catalog — and
    // the signer is then the catalog's, since that is who vouched for it.
    if let Some(subject) = catalog_signer(path) {
        return SignatureIdentity {
            signature_status: "valid".to_string(),
            signer_subject: Some(subject),
        };
    }
    SignatureIdentity {
        signature_status: "untrusted".to_string(),
        signer_subject: None,
    }
}

pub fn executable_signature(path: &str) -> SignatureIdentity {
    static CACHE: OnceLock<Mutex<HashMap<String, SignatureIdentity>>> = OnceLock::new();
    let key = path.to_lowercase();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(value) = cache
        .lock()
        .ok()
        .and_then(|values| values.get(&key).cloned())
    {
        return value;
    }
    let value = inspect_uncached(path);
    if let Ok(mut values) = cache.lock() {
        values.insert(key, value.clone());
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_wire_status_is_finite_and_subject_requires_valid_trust() {
        let current = std::env::current_exe().expect("current executable path");
        let signature = executable_signature(current.to_string_lossy().as_ref());
        assert!(matches!(
            signature.signature_status.as_str(),
            "valid" | "untrusted"
        ));
        if signature.signature_status != "valid" {
            assert!(signature.signer_subject.is_none());
        }
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    /// Windows signs most of its own binaries by hashing them into a `.cat`
    /// catalog rather than embedding a signature, so verifying the file alone
    /// reports "untrusted" for files Microsoft plainly signed. Calculator and
    /// Paint resolve to exactly such executables, which is why they asked for
    /// approval on every cold launch while Word and QQ did not.
    #[test]
    fn a_catalog_signed_windows_binary_is_recognised_as_microsoft() {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let calculator = format!(r"{system_root}\System32\calc.exe");
        if !std::path::Path::new(&calculator).is_file() {
            return; // Not this machine's layout; nothing to assert.
        }
        let signature = executable_signature(&calculator);
        assert_eq!(signature.signature_status, "valid", "calc.exe is catalog-signed");
        let subject = signature.signer_subject.unwrap_or_default();
        assert!(
            subject.contains("Microsoft"),
            "expected a Microsoft signer, got {subject:?}",
        );
    }

    /// The catalog leg must not turn into a way for anything unsigned to pass.
    #[test]
    fn a_file_in_no_catalog_stays_untrusted() {
        let temporary = std::env::temp_dir().join("abu-signature-probe.exe");
        std::fs::write(&temporary, b"MZ not a real executable").expect("write probe");
        let signature = executable_signature(temporary.to_string_lossy().as_ref());
        let _ = std::fs::remove_file(&temporary);
        assert_eq!(signature.signature_status, "untrusted");
        assert!(signature.signer_subject.is_none());
    }

    /// Diagnostic: where the catalog lookup gives up. An empty document is
    /// indistinguishable from a failed lookup at the call site, which is how
    /// the whole leg can look like "nothing is catalog-signed".
    #[test]
    #[ignore = "reports catalog lookup internals on this machine"]
    fn catalog_lookup_probe() {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let path = format!(r"{system_root}\System32\calc.exe");
        let wide_path = wide_null(&path);
        let file = unsafe {
            CreateFileW(
                PCWSTR(wide_path.as_ptr()),
                FILE_GENERIC_READ.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
        };
        println!("CreateFileW: {:?}", file.as_ref().map(|_| "ok"));
        let Ok(file) = file else { return };

        for algorithm in ["SHA256", "SHA1"] {
            let mut admin = 0isize;
            let wide_algorithm = wide_null(algorithm);
            let acquired = unsafe {
                CryptCATAdminAcquireContext2(&mut admin, None, PCWSTR(wide_algorithm.as_ptr()), None, 0)
            };
            println!("{algorithm} AcquireContext2: {acquired:?}");
            if acquired.is_err() {
                continue;
            }
            let mut size = 0u32;
            let sized =
                unsafe { CryptCATAdminCalcHashFromFileHandle2(admin, file, &mut size, None, 0) };
            println!("{algorithm}   CalcHash size: {sized:?} -> {size}");
            if sized.is_ok() && size > 0 {
                let mut hash = vec![0u8; size as usize];
                let filled = unsafe {
                    CryptCATAdminCalcHashFromFileHandle2(
                        admin,
                        file,
                        &mut size,
                        Some(hash.as_mut_ptr()),
                        0,
                    )
                };
                println!("{algorithm}   CalcHash fill: {filled:?}");
                if filled.is_ok() {
                    let context =
                        unsafe { CryptCATAdminEnumCatalogFromHash(admin, &hash, 0, None) };
                    println!("{algorithm}   EnumCatalogFromHash: {context:#x}");
                    if context != 0 {
                        let _ = unsafe { CryptCATAdminReleaseCatalogContext(admin, context, 0) };
                    }
                }
            }
            let _ = unsafe { CryptCATAdminReleaseContext(admin, 0) };
        }
        unsafe { let _ = CloseHandle(file); }

        println!("catalog_signer: {:?}", catalog_signer(&path));
    }

    /// Diagnostic: what this machine's apps actually report. Run with
    /// `cargo test signature_probe -- --ignored --nocapture`.
    #[test]
    #[ignore = "reports the signatures on this machine"]
    fn signature_probe() {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        // Packaged apps are the gap this does not close: a binary under
        // WindowsApps carries no embedded signature and is in no catalog,
        // because the *package* is what Microsoft signed. Measured: Paint
        // resolves to `…\Microsoft.Paint_…\PaintApp\mspaint.exe` and still
        // reports untrusted. The policy's `ordinaryPackagePrefixes` classify
        // such apps by AUMID instead, which the launch path does not yet
        // carry — it reduces a catalog entry to its executable.
        for name in [
            r"System32\calc.exe",
            r"System32\notepad.exe",
            r"System32\cmd.exe",
            "explorer.exe",
        ] {
            let path = format!(r"{system_root}\{name}");
            let signature = executable_signature(&path);
            println!(
                "{name:<24} {:<10} {:?}",
                signature.signature_status, signature.signer_subject
            );
        }
    }
}
