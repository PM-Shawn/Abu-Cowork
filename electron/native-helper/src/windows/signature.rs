use serde::Serialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;
use std::sync::{Mutex, OnceLock};

use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{HANDLE, HWND};
use ::windows::Win32::Security::Cryptography::{
    CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext, CertGetNameStringW,
    CryptMsgClose, CryptMsgGetParam, CryptQueryObject, CERT_FIND_SUBJECT_CERT, CERT_INFO,
    CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_ENCODING_TYPE, CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE,
    CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, HCERTSTORE, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
};
use ::windows::Win32::Security::WinTrust::{
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE,
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

fn inspect_uncached(path: &str) -> SignatureIdentity {
    if !verify_embedded_signature(path) {
        return SignatureIdentity {
            signature_status: "untrusted".to_string(),
            signer_subject: None,
        };
    }
    SignatureIdentity {
        signature_status: "valid".to_string(),
        signer_subject: embedded_signer_subject(path),
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
