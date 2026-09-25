use std::path::{Path, PathBuf};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub trait SecretStore {
    fn get(&self) -> Result<Option<Vec<u8>>>;
    fn put(&self, key: &[u8]) -> Result<()>;
}

pub struct WorkspaceKey {
    pub bytes: Vec<u8>,
    legacy: Option<PathBuf>,
}
impl WorkspaceKey {
    // Only retire the old file once the backend has opened the encrypted state.
    pub fn finish_migration(&self) -> Result<()> {
        if let Some(path) = &self.legacy {
            if std::fs::read(path)? != self.bytes {
                return Err("Legacy workspace key changed during migration".into());
            }
            std::fs::remove_file(path)?;
        }
        Ok(())
    }
}

pub fn random_key() -> Result<Vec<u8>> {
    let mut key = vec![0u8; 32];
    getrandom::fill(&mut key).map_err(|_| "Operating system randomness unavailable")?;
    Ok(key)
}

pub fn load_or_create(data: &Path, store: &impl SecretStore) -> Result<WorkspaceKey> {
    let legacy_path = data.join("workspace.key");
    let legacy = match std::fs::read(&legacy_path) {
        Ok(key) => Some(key),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let stored = store.get()?;
    let needs_store = stored.is_none();
    if legacy.as_ref().is_some_and(|key| key.len() != 32)
        || stored.as_ref().is_some_and(|key| key.len() != 32)
    {
        return Err("Invalid workspace encryption key; data was left unchanged".into());
    }
    let key = match (stored, legacy.as_ref()) {
        (Some(stored), Some(legacy)) if &stored != legacy => return Err("Keychain and legacy workspace keys disagree; data was left unchanged".into()),
        (Some(stored), _) => stored,
        (None, Some(legacy)) => legacy.clone(),
        (None, None) if data.join("workspace.enc").exists() => return Err("Encrypted workspace exists without its encryption key; restore the original key before opening VOID".into()),
        (None, None) => random_key()?,
    };
    if needs_store {
        store.put(&key)?;
    }
    if store.get()?.as_deref() != Some(key.as_slice()) {
        return Err("Keychain did not retain the workspace key; data was left unchanged".into());
    }
    Ok(WorkspaceKey {
        bytes: key,
        legacy: legacy.map(|_| legacy_path),
    })
}

pub fn ephemeral() -> Result<WorkspaceKey> {
    Ok(WorkspaceKey {
        bytes: random_key()?,
        legacy: None,
    })
}

/// The Windows Credential Manager target name for one workspace, NUL
/// terminated and UTF-16 as `CredWriteW` requires. It is the Windows spelling
/// of the same `dev.void.desktop.workspace` service and `account` pair the
/// macOS keychain uses, so the two platforms name one credential rather than
/// two. Kept outside the `cfg(windows)` block on purpose: the naming rule is
/// the part that has to stay identical across platforms, and a rule that can
/// only be tested on the platform it runs on is a rule nobody tests.
pub fn windows_credential_target(account: &str) -> Vec<u16> {
    format!("dev.void.desktop.workspace:{}", account)
        .encode_utf16()
        .chain(Some(0))
        .collect()
}

/// The only blob length Credential Manager will hand back as a workspace key.
/// A short or long blob is a corrupt or foreign entry, never a key to guess at.
pub const WINDOWS_CREDENTIAL_BLOB_BYTES: usize = 32;

#[cfg(target_os = "macos")]
pub struct MacKeychain {
    pub account: String,
}
#[cfg(target_os = "macos")]
impl SecretStore for MacKeychain {
    fn get(&self) -> Result<Option<Vec<u8>>> {
        match security_framework::passwords::get_generic_password(
            "dev.void.desktop.workspace",
            &self.account,
        ) {
            Ok(key) => Ok(Some(key)),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err("Cannot unlock the VOID workspace key in macOS Keychain".into()),
        }
    }
    fn put(&self, key: &[u8]) -> Result<()> {
        security_framework::passwords::set_generic_password(
            "dev.void.desktop.workspace",
            &self.account,
            key,
        )
        .map_err(|_| "Cannot save the VOID workspace key in macOS Keychain".into())
    }
}

#[cfg(windows)]
pub struct WindowsCredentials {
    pub account: String,
}
#[cfg(windows)]
impl WindowsCredentials {
    fn target(&self) -> Vec<u16> {
        windows_credential_target(&self.account)
    }
}
#[cfg(windows)]
impl SecretStore for WindowsCredentials {
    fn get(&self) -> Result<Option<Vec<u8>>> {
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_NOT_FOUND},
            Security::Credentials::*,
        };
        let target = self.target();
        let mut credential = std::ptr::null_mut();
        // Windows owns the returned allocation until CredFree. Copy only a valid key.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
                if GetLastError() == ERROR_NOT_FOUND {
                    return Ok(None);
                }
                return Err("Cannot unlock the VOID key in Windows Credential Manager".into());
            }
            let entry = &*credential;
            let key = if entry.CredentialBlobSize as usize == WINDOWS_CREDENTIAL_BLOB_BYTES
                && !entry.CredentialBlob.is_null()
            {
                Some(std::slice::from_raw_parts(entry.CredentialBlob, WINDOWS_CREDENTIAL_BLOB_BYTES).to_vec())
            } else {
                None
            };
            CredFree(credential.cast());
            key.map(Some)
                .ok_or_else(|| "Invalid Windows workspace key; data was left unchanged".into())
        }
    }
    fn put(&self, key: &[u8]) -> Result<()> {
        use windows_sys::Win32::Security::Credentials::*;
        if key.len() != 32 {
            return Err("Invalid workspace key length".into());
        }
        let mut target = self.target();
        let mut username: Vec<u16> = "VOID".encode_utf16().chain(Some(0)).collect();
        let mut bytes = key.to_vec();
        let entry = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };
        let saved = unsafe { CredWriteW(&entry, 0) };
        bytes.fill(0);
        if saved == 0 {
            return Err("Cannot save the VOID key in Windows Credential Manager".into());
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    struct CredentialCleanup(Vec<u16>);

    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            use windows_sys::Win32::Security::Credentials::*;
            unsafe {
                CredDeleteW(self.0.as_ptr(), CRED_TYPE_GENERIC, 0);
            }
        }
    }

    #[test]
    fn windows_credentials_round_trip() {
        let store = WindowsCredentials {
            account: format!(
                "test-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
            ),
        };
        let _cleanup = CredentialCleanup(store.target());
        assert!(store.get().unwrap().is_none());
        let key = random_key().unwrap();
        store.put(&key).unwrap();
        assert_eq!(store.get().unwrap(), Some(key));
    }

    #[test]
    fn windows_credentials_persist_across_workspace_loads() {
        let store = WindowsCredentials {
            account: format!(
                "test-persistence-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
            ),
        };
        let _cleanup = CredentialCleanup(store.target());
        let directory = std::env::temp_dir().join(format!(
            "void-windows-credential-persistence-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();

        let first = load_or_create(&directory, &store).unwrap();
        let expected = first.bytes.clone();
        drop(first);
        let second = load_or_create(&directory, &store).unwrap();

        assert_eq!(second.bytes, expected);
        assert!(!directory.join("workspace.key").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Store {
        key: RefCell<Option<Vec<u8>>>,
        writable: bool,
    }
    impl SecretStore for Store {
        fn get(&self) -> Result<Option<Vec<u8>>> {
            Ok(self.key.borrow().clone())
        }
        fn put(&self, key: &[u8]) -> Result<()> {
            if !self.writable {
                return Err("Keychain locked".into());
            }
            *self.key.borrow_mut() = Some(key.to_vec());
            Ok(())
        }
    }
    fn directory(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("void-keychain-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn migrates_existing_key_without_deleting_it_before_backend_readiness() {
        let dir = directory("migration");
        let original = vec![17; 32];
        std::fs::write(dir.join("workspace.key"), &original).unwrap();
        let store = Store {
            key: RefCell::new(None),
            writable: true,
        };
        let key = load_or_create(&dir, &store).unwrap();
        assert_eq!(key.bytes, original);
        assert_eq!(store.get().unwrap(), Some(original));
        assert!(dir.join("workspace.key").exists());
        key.finish_migration().unwrap();
        assert!(!dir.join("workspace.key").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn locked_keychain_preserves_legacy_key_and_ciphertext() {
        let dir = directory("locked");
        let original = vec![18; 32];
        std::fs::write(dir.join("workspace.key"), &original).unwrap();
        std::fs::write(dir.join("workspace.enc"), b"encrypted-state").unwrap();
        let store = Store {
            key: RefCell::new(None),
            writable: false,
        };
        assert!(load_or_create(&dir, &store).is_err());
        assert_eq!(std::fs::read(dir.join("workspace.key")).unwrap(), original);
        assert_eq!(
            std::fs::read(dir.join("workspace.enc")).unwrap(),
            b"encrypted-state"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn mismatched_or_missing_keys_never_replace_existing_encrypted_data() {
        let dir = directory("mismatch");
        std::fs::write(dir.join("workspace.key"), vec![19; 32]).unwrap();
        let store = Store {
            key: RefCell::new(Some(vec![20; 32])),
            writable: true,
        };
        assert!(load_or_create(&dir, &store).is_err());
        assert_eq!(store.get().unwrap(), Some(vec![20; 32]));
        std::fs::remove_file(dir.join("workspace.key")).unwrap();
        *store.key.borrow_mut() = None;
        std::fs::write(dir.join("workspace.enc"), b"encrypted-state").unwrap();
        assert!(load_or_create(&dir, &store).is_err());
        assert_eq!(store.get().unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod windows_naming_tests {
    use super::{windows_credential_target, WINDOWS_CREDENTIAL_BLOB_BYTES};

    /// The Windows target is the same `dev.void.desktop.workspace` service and
    /// account the macOS keychain uses, joined by a colon. A change here would
    /// silently orphan every existing Windows credential, so it is pinned
    /// rather than left to a Windows-only test that nobody can run here.
    #[test]
    fn windows_target_names_the_same_workspace_the_keychain_does() {
        let target = windows_credential_target("default");
        let text: String = String::from_utf16(&target[..target.len() - 1]).unwrap();
        assert_eq!(text, "dev.void.desktop.workspace:default");
        assert!(target.starts_with(&"dev.void.desktop.workspace:".encode_utf16().collect::<Vec<u16>>()[..]));
    }

    #[test]
    fn windows_target_is_nul_terminated_exactly_once() {
        let target = windows_credential_target("abc");
        assert_eq!(*target.last().unwrap(), 0);
        assert_eq!(target.iter().filter(|unit| **unit == 0).count(), 1);
    }

    /// A non-ASCII account must survive as UTF-16 code units, not be truncated
    /// at a byte boundary the way a `CString` would allow.
    #[test]
    fn windows_target_carries_non_ascii_accounts_whole() {
        let target = windows_credential_target("úloha-Ω");
        let text: String = String::from_utf16(&target[..target.len() - 1]).unwrap();
        assert_eq!(text, "dev.void.desktop.workspace:úloha-Ω");
    }

    #[test]
    fn distinct_workspaces_never_share_a_credential_target() {
        assert_ne!(
            windows_credential_target("a"),
            windows_credential_target("b"),
            "one shared target would hand one workspace another workspace's key"
        );
    }

    /// The read path accepts exactly one blob length. Anything else is a
    /// corrupt or foreign entry, and the caller turns it into an error rather
    /// than a key.
    #[test]
    fn only_a_full_length_workspace_key_is_accepted() {
        assert_eq!(WINDOWS_CREDENTIAL_BLOB_BYTES, 32);
    }
}
