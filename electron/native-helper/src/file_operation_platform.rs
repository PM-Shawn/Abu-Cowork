use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(crate) enum Access { Attributes, Read, Write, Delete }

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows::Wdk::Storage::FileSystem::{NtCreateFile, NtQueryDirectoryFile, NtQueryInformationFile,
        FileNamesInformation, FileAlternateNameInformation, FILE_NAME_INFORMATION,
        FILE_CREATE, FILE_OPEN, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE,
        FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT};
    use windows::Win32::Foundation::{HANDLE, UNICODE_STRING};
    use windows::Win32::Storage::FileSystem::{GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
        GetVolumeInformationByHandleW, FileCaseSensitiveInfo, FileIdInfo, FILE_ACCESS_RIGHTS,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAGS_AND_ATTRIBUTES, FILE_ID_INFO,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_NAME_NORMALIZED};
    use windows::Win32::System::IO::IO_STATUS_BLOCK;
    use windows::Win32::System::WindowsProgramming::FILE_CASE_SENSITIVE_INFO;

    fn handle(file: &File) -> HANDLE { HANDLE(file.as_raw_handle()) }
    fn error() -> io::Error { io::Error::other("Cannot inspect the retained file handle") }

    pub(crate) fn root(path: &Path) -> io::Result<File> {
        OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES.0 | 0x0010_0000)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0).open(path)
    }

    pub(crate) fn sensitive(parent: &File) -> io::Result<bool> {
        let mut info = FILE_CASE_SENSITIVE_INFO::default();
        unsafe { GetFileInformationByHandleEx(handle(parent), FileCaseSensitiveInfo,
            &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32) }.map_err(|_| error())?;
        Ok(info.Flags & 1 != 0)
    }

    pub(crate) fn relative(parent: &File, name: &str, access: Access, follow: bool,
        create: Option<bool>) -> io::Result<File> {
        let mut units: Vec<u16> = name.encode_utf16().collect();
        if units.is_empty() || units.contains(&0) || units.len() > 16_383 { return Err(error()); }
        let mut text = UNICODE_STRING { Length: (units.len() * 2) as u16,
            MaximumLength: (units.len() * 2) as u16, Buffer: windows::core::PWSTR(units.as_mut_ptr()) };
        let attributes = OBJECT_ATTRIBUTES { Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(parent), ObjectName: &mut text,
            // An unknown comparison mode only permits an exact lookup. It must
            // not be treated as evidence for a case-insensitive policy match.
            Attributes: if matches!(sensitive(parent), Ok(false)) { 0x40 } else { 0 }, ..Default::default() };
        let mut output = HANDLE::default();
        let mut status = IO_STATUS_BLOCK::default();
        let data_access = match access { Access::Attributes => 0, Access::Read => 1, Access::Write => 2, Access::Delete => 0x0001_0000 };
        let mut options = FILE_SYNCHRONOUS_IO_NONALERT;
        if !follow { options |= FILE_OPEN_REPARSE_POINT; }
        if let Some(directory) = create {
            options |= if directory { FILE_DIRECTORY_FILE } else { FILE_NON_DIRECTORY_FILE };
        }
        let result = unsafe { NtCreateFile(&mut output,
            FILE_ACCESS_RIGHTS(FILE_READ_ATTRIBUTES.0 | 0x0010_0000 | data_access), &attributes,
            &mut status, None, FILE_FLAGS_AND_ATTRIBUTES(0), FILE_SHARE_READ | FILE_SHARE_WRITE,
            if create.is_some() { FILE_CREATE } else { FILE_OPEN }, options, None, 0) };
        if result.0 < 0 {
            return Err(if matches!(result.0 as u32, 0xc0000034 | 0xc000003a) {
                io::Error::from(io::ErrorKind::NotFound)
            } else { io::Error::other(format!("Relative file operation failed: {:08x}", result.0 as u32)) });
        }
        Ok(unsafe { File::from_raw_handle(output.0) })
    }

    pub(crate) fn identity(file: &File) -> io::Result<String> {
        let mut info = FILE_ID_INFO::default();
        unsafe { GetFileInformationByHandleEx(handle(file), FileIdInfo,
            &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32) }.map_err(|_| error())?;
        Ok(format!("{}:{:02x?}", info.VolumeSerialNumber, info.FileId.Identifier))
    }

    pub(crate) fn move_directory(parent: &File, name: &str, destination: &File, expected: &str) -> io::Result<()> {
        use windows::Wdk::Storage::FileSystem::{NtSetInformationFile, FileRenameInformation, FILE_RENAME_INFORMATION};
        let source = relative(parent, name, Access::Delete, false, None)?;
        if !source.metadata()?.is_dir() || source.metadata()?.file_type().is_symlink() || identity(&source)? != expected {
            return Err(error());
        }
        let units: Vec<u16> = name.encode_utf16().collect();
        let size = std::mem::size_of::<FILE_RENAME_INFORMATION>() + units.len() * 2;
        let mut storage = vec![0u64; size.div_ceil(8)];
        let info = storage.as_mut_ptr() as *mut FILE_RENAME_INFORMATION;
        let mut status = IO_STATUS_BLOCK::default();
        let result = unsafe {
            (*info).RootDirectory = handle(destination);
            (*info).FileNameLength = (units.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(units.as_ptr(), (*info).FileName.as_mut_ptr(), units.len());
            NtSetInformationFile(handle(&source), &mut status, info.cast(), size as u32, FileRenameInformation)
        };
        if result.0 < 0 {
            return Err(io::Error::other(format!("Cannot move the retained directory: {:08x}", result.0 as u32)));
        }
        Ok(())
    }

    pub(crate) fn remove_entry(parent: &File, name: &str, directory: bool) -> io::Result<()> {
        use windows::Win32::Storage::FileSystem::{SetFileInformationByHandle, FileDispositionInfo, FILE_DISPOSITION_INFO};
        let entry = relative(parent, name, Access::Delete, false, None)?;
        if entry.metadata()?.is_dir() != directory { return Err(error()); }
        let info = FILE_DISPOSITION_INFO { DeleteFile: true.into() };
        unsafe { SetFileInformationByHandle(handle(&entry), FileDispositionInfo,
            &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) }
            .map_err(|failure| io::Error::other(format!("Cannot remove the retained entry: {failure}")))?;
        Ok(())
    }

    pub(crate) fn canonical(file: &File) -> io::Result<PathBuf> {
        let mut buffer = vec![0u16; 32_768];
        let count = unsafe { GetFinalPathNameByHandleW(handle(file), &mut buffer, FILE_NAME_NORMALIZED) } as usize;
        if count == 0 || count >= buffer.len() { return Err(error()); }
        let text = String::from_utf16(&buffer[..count]).map_err(|_| error())?;
        let text = if let Some(tail) = text.strip_prefix("\\\\?\\UNC\\") { format!("\\\\{tail}") }
            else { text.strip_prefix("\\\\?\\").unwrap_or(&text).to_owned() };
        Ok(PathBuf::from(text))
    }

    pub(crate) fn facts(parent: &File) -> io::Result<serde_json::Value> {
        let mut filesystem = [0u16; 64];
        unsafe { GetVolumeInformationByHandleW(handle(parent), None, None, None, None, Some(&mut filesystem)) }
            .map_err(|_| error())?;
        let length = filesystem.iter().position(|unit| *unit == 0).ok_or_else(error)?;
        Ok(serde_json::json!({ "caseMode": match sensitive(parent) {
                Ok(true) => "sensitive", Ok(false) => "insensitive", Err(_) => "unknown" },
            "directoryIdentity": identity(parent)?, "platform": "windows",
            "filesystem": String::from_utf16(&filesystem[..length]).map_err(|_| error())? }))
    }

    pub(crate) fn compare_component(parent: &File, expected_identity: &str, expected_path: &Path, pattern: &str,
        check: &dyn Fn() -> io::Result<()>) -> io::Result<&'static str> {
        check()?;
        if pattern.contains(['?', '<', '>', '"', ':', '/', '\\']) { return Ok("unknown"); }
        if pattern.contains('*') {
            if sensitive(parent)? || pattern == "*.*" { return Ok("unknown"); }
            for name in matching_names(parent, Some(pattern), check)? {
                check()?;
                let found = relative(parent, &name, Access::Attributes, false, None)?;
                if identity(&found)? == expected_identity && canonical(&found)? == expected_path {
                    return long_name_equivalence(&found, check);
                }
            }
            check()?;
            return Ok("no-match");
        }
        sensitive(parent)?;
        let found = match relative(parent, pattern, Access::Attributes, false, None) {
            Ok(found) => found,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("no-match"),
            Err(error) => return Err(error),
        };
        check()?;
        if identity(&found)? != expected_identity || canonical(&found)? != expected_path {
            return Ok("no-match");
        }
        long_name_equivalence(&found, check)
    }

    fn long_name_equivalence(found: &File, check: &dyn Fn() -> io::Result<()>) -> io::Result<&'static str> {
        // A native match with an alternate name needs further evidence for
        // equivalence with the entry's long name.
        let mut buffer = [0u64; 64];
        let mut status = IO_STATUS_BLOCK::default();
        let code = unsafe { NtQueryInformationFile(handle(found), &mut status,
            buffer.as_mut_ptr() as *mut _, std::mem::size_of_val(&buffer) as u32, FileAlternateNameInformation) };
        check()?;
        if code.0 as u32 == 0xc0000034 { return Ok("match"); }
        if code.0 != 0 || status.Information < std::mem::size_of::<FILE_NAME_INFORMATION>()
            || status.Information > std::mem::size_of_val(&buffer) { return Ok("unknown"); }
        let information = unsafe { &*(buffer.as_ptr() as *const FILE_NAME_INFORMATION) };
        Ok(if information.FileNameLength == 0 { "match" } else { "unknown" })
    }

    pub(crate) fn names(parent: &File, check: &dyn Fn() -> io::Result<()>) -> io::Result<Vec<String>> {
        matching_names(parent, None, check)
    }

    fn matching_names(parent: &File, pattern: Option<&str>, check: &dyn Fn() -> io::Result<()>) -> io::Result<Vec<String>> {
        check()?;
        let mut pattern_units = pattern.map(|value| value.encode_utf16().collect::<Vec<_>>());
        let expression = if let Some(units) = pattern_units.as_mut() {
            if units.is_empty() || units.contains(&0) || units.len() > 16_383 { return Err(error()); }
            Some(UNICODE_STRING {
                Length: (units.len() * 2) as u16, MaximumLength: (units.len() * 2) as u16,
                Buffer: windows::core::PWSTR(units.as_mut_ptr()),
            })
        } else { None };
        let expected_identity = identity(parent)?;
        let expected_path = canonical(parent)?;
        // A separate FileObject owns this query's cursor. The retained parent
        // stays open until the new handle's directory entry has been verified.
        let query = OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES.0 | 0x0010_0000 | 1)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(&expected_path)?;
        let validate = || -> io::Result<()> {
            check()?;
            if !query.metadata()?.is_dir() || identity(&query)? != expected_identity
                || canonical(&query)? != expected_path || identity(parent)? != expected_identity
                || canonical(parent)? != expected_path { return Err(error()); }
            check()
        };
        validate()?;
        let mut buffer = vec![0u64; 8192];
        let mut first = true;
        let mut result = Vec::new();
        loop {
            check()?;
            let mut status = IO_STATUS_BLOCK::default();
            let code = unsafe { NtQueryDirectoryFile(handle(&query), HANDLE::default(), None, None,
                &mut status, buffer.as_mut_ptr() as *mut _, (buffer.len() * 8) as u32,
                FileNamesInformation, false, expression.as_ref().map(|value| value as *const _), first) };
            if first && code.0 as u32 == 0xc000000f { validate()?; return Ok(result); }
            if code.0 as u32 == 0x80000006 { validate()?; return Ok(result); }
            let used = status.Information;
            if (code.0 == 0 && used == 0) || (first && code.0 as u32 == 0x80000005) {
                if buffer.len() >= 524_288 { return Err(error()); }
                buffer.resize(buffer.len() * 2, 0);
                continue;
            }
            if code.0 < 0 || used > buffer.len() * 8 { return Err(error()); }
            first = false;
            let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr() as *const u8, used) };
            let mut offset = 0usize;
            loop {
                if offset + 12 > used { return Err(error()); }
                let number = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                let next = number(offset);
                let length = number(offset + 8);
                if length % 2 != 0 || offset + 12 + length > used { return Err(error()); }
                let units: Vec<u16> = bytes[offset + 12..offset + 12 + length].chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
                let name = String::from_utf16(&units).map_err(|_| error())?;
                if name != "." && name != ".." { result.push(name); }
                if result.len() > 10_000 { return Err(io::Error::other("Directory enumeration limit reached")); }
                if next == 0 { break; }
                if next < 12 || offset + next <= offset { return Err(error()); }
                offset += next;
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
    use std::os::unix::fs::MetadataExt;

    fn string(value: &str) -> io::Result<CString> {
        CString::new(value).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }
    pub(crate) fn root(path: &Path) -> io::Result<File> { File::open(path) }
    pub(crate) fn relative(parent: &File, name: &str, access: Access, follow: bool,
        create: Option<bool>) -> io::Result<File> {
        let name = string(name)?;
        if create == Some(true) {
            if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let mut flags = libc::O_CLOEXEC | libc::O_NONBLOCK | match access {
            Access::Attributes | Access::Delete => libc::O_EVTONLY, Access::Read => libc::O_RDONLY, Access::Write => libc::O_WRONLY,
        };
        if !follow { flags |= libc::O_SYMLINK; }
        if create == Some(false) { flags |= libc::O_CREAT | libc::O_EXCL; }
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(crate) fn move_directory(parent: &File, name: &str, destination: &File, expected: &str) -> io::Result<()> {
        let source = relative(parent, name, Access::Delete, false, None)?;
        if !source.metadata()?.is_dir() || source.metadata()?.file_type().is_symlink() || identity(&source)? != expected {
            return Err(io::Error::other("Branch directory changed"));
        }
        let name = string(name)?;
        if unsafe { libc::renameatx_np(parent.as_raw_fd(), name.as_ptr(), destination.as_raw_fd(), name.as_ptr(), libc::RENAME_EXCL) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let moved = relative(destination, name.to_str().map_err(io::Error::other)?, Access::Attributes, false, None)?;
        if identity(&moved)? != expected { return Err(io::Error::other("Branch directory changed")); }
        parent.sync_all()?;
        destination.sync_all()?;
        Ok(())
    }

    pub(crate) fn remove_entry(parent: &File, name: &str, directory: bool) -> io::Result<()> {
        let name = string(name)?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), if directory { libc::AT_REMOVEDIR } else { 0 }) } != 0 {
            return Err(io::Error::last_os_error());
        }
        parent.sync_all()
    }
    pub(crate) fn identity(file: &File) -> io::Result<String> {
        let metadata = file.metadata()?;
        #[repr(C, packed(4))]
        struct LinkInfo { length: u32, returned: libc::attribute_set_t, link_id: u64 }
        let mut requested: libc::attrlist = unsafe { std::mem::zeroed() };
        requested.bitmapcount = libc::ATTR_BIT_MAP_COUNT as u16;
        requested.commonattr = libc::ATTR_CMN_RETURNED_ATTRS;
        requested.forkattr = libc::ATTR_CMNEXT_LINKID;
        let mut result: LinkInfo = unsafe { std::mem::zeroed() };
        if unsafe { libc::fgetattrlist(file.as_raw_fd(), (&mut requested as *mut libc::attrlist).cast(), &mut result as *mut _ as *mut _,
            std::mem::size_of_val(&result), (libc::FSOPT_ATTR_CMN_EXTENDED | libc::FSOPT_REPORT_FULLSIZE) as _) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if result.length as usize != std::mem::size_of_val(&result)
            || result.returned.forkattr & libc::ATTR_CMNEXT_LINKID == 0 {
            return Err(io::Error::other("Directory entry identity is unavailable"));
        }
        let link_id = result.link_id;
        Ok(format!("{}:{}:{link_id}", metadata.dev(), metadata.ino()))
    }
    pub(crate) fn canonical(file: &File) -> io::Result<PathBuf> {
        let mut path = vec![0u8; libc::PATH_MAX as usize];
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let path = unsafe { CStr::from_ptr(path.as_ptr() as *const _) };
        Ok(PathBuf::from(path.to_str().map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?))
    }
    /// `expected_identity` and `expected_path` are the entry's values recorded when it was
    /// observed. APFS gives every hard link of one file a single vnode whose link id and
    /// path follow the name looked up last, so they are not read again from the entry here.
    pub(crate) fn compare_component(parent: &File, expected_identity: &str, expected_path: &Path, pattern: &str,
        check: &dyn Fn() -> io::Result<()>) -> io::Result<&'static str> {
        check()?;
        if pattern.contains('*') { return Ok("unknown"); }
        let found = match relative(parent, pattern, Access::Attributes, false, None) {
            Ok(found) => found,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("no-match"),
            Err(error) => return Err(error),
        };
        check()?;
        Ok(if identity(&found)? == expected_identity && canonical(&found)? == expected_path {
            "match"
        } else { "no-match" })
    }
    pub(crate) fn facts(parent: &File) -> io::Result<serde_json::Value> {
        let mut filesystem: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(parent.as_raw_fd(), &mut filesystem) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let filesystem_name = unsafe { CStr::from_ptr(filesystem.f_fstypename.as_ptr()) }
            .to_str().map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let mount_path = unsafe { CStr::from_ptr(filesystem.f_mntonname.as_ptr()) }
            .to_str().map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let mode = volume_case_mode(parent, Path::new(mount_path));
        Ok(serde_json::json!({ "caseMode": match mode {
                Ok(true) => "sensitive", Ok(false) => "insensitive", Err(_) => "unknown" },
            "directoryIdentity": identity(parent)?, "platform": "macos", "filesystem": filesystem_name }))
    }
    fn volume_case_mode(parent: &File, mount_path: &Path) -> io::Result<bool> {
        let volume = File::open(mount_path)?;
        if volume.metadata()?.dev() != parent.metadata()?.dev() {
            return Err(io::Error::other("Volume identity changed"));
        }
        #[repr(C)]
        struct VolumeInfo { length: u32, returned: libc::attribute_set_t, capabilities: libc::vol_capabilities_attr_t }
        let mut requested: libc::attrlist = unsafe { std::mem::zeroed() };
        requested.bitmapcount = libc::ATTR_BIT_MAP_COUNT as u16;
        requested.commonattr = libc::ATTR_CMN_RETURNED_ATTRS;
        requested.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES;
        let mut result: VolumeInfo = unsafe { std::mem::zeroed() };
        if unsafe { libc::fgetattrlist(volume.as_raw_fd(), (&mut requested as *mut libc::attrlist).cast(), &mut result as *mut _ as *mut _,
            std::mem::size_of_val(&result), libc::FSOPT_REPORT_FULLSIZE as _) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let index = libc::VOL_CAPABILITIES_FORMAT as usize;
        if result.length as usize != std::mem::size_of_val(&result)
            || result.returned.volattr & libc::ATTR_VOL_CAPABILITIES == 0
            || result.capabilities.valid[index] & libc::VOL_CAP_FMT_CASE_SENSITIVE == 0 {
            return Err(io::Error::other("Volume comparison mode is unavailable"));
        }
        Ok(result.capabilities.capabilities[index] & libc::VOL_CAP_FMT_CASE_SENSITIVE != 0)
    }
    pub(crate) fn names(parent: &File, check: &dyn Fn() -> io::Result<()>) -> io::Result<Vec<String>> {
        check()?;
        let query = relative(parent, ".", Access::Read, true, None)?;
        let fd = query.into_raw_fd();
        let directory = unsafe { libc::fdopendir(fd) };
        if directory.is_null() {
            unsafe { libc::close(fd); }
            return Err(io::Error::last_os_error());
        }
        struct Directory(*mut libc::DIR);
        impl Drop for Directory { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
        let directory = Directory(directory);
        let mut result = Vec::new();
        loop {
            check()?;
            unsafe { *libc::__error() = 0; }
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                if unsafe { *libc::__error() } != 0 { return Err(io::Error::last_os_error()); }
                return Ok(result);
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str()
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
            if name != "." && name != ".." { result.push(name.to_owned()); }
            if result.len() > 10_000 { return Err(io::Error::other("Directory enumeration limit reached")); }
        }
    }
}

pub(crate) use platform::*;
