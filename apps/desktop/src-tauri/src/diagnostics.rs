use std::{error::Error, fs::OpenOptions, io::Write, path::Path};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const STARTUP_LOG: &str = "desktop-startup.log";

/// Persist only a stable category. Error strings can contain paths, URLs,
/// environment values, or backend messages and must never enter a diagnostic
/// file or the terminal.
pub fn classify(error: &(dyn Error + 'static)) -> &'static str {
    let text = error.to_string().to_ascii_lowercase();
    // Checked before the keychain branch: the denied message names the
    // workspace key but not the keychain, so it would otherwise fall through
    // to the generic workspace category and lose the only actionable part.
    if text.contains("not authorised to read it") {
        "KEYCHAIN_ACCESS_DENIED"
    } else if text.contains("keychain")
        || text.contains("credential manager")
        || text.contains("invalid windows workspace key")
        || text.contains("workspace encryption key")
    {
        "KEYCHAIN_UNAVAILABLE"
    } else if text.contains("runtime exited before readiness") || text.contains("runtime returned") {
        "RUNTIME_STARTUP_FAILED"
    } else if text.contains("loopback") || text.contains("listen") || text.contains("bind") {
        "RUNTIME_NETWORK_FAILED"
    } else if text.contains("workspace") || text.contains("permission") || text.contains("access") {
        "WORKSPACE_ACCESS_FAILED"
    } else {
        "STARTUP_FAILED"
    }
}

fn allowlisted_code(code: &str) -> &'static str {
    match code {
        "KEYCHAIN_ACCESS_DENIED" => "KEYCHAIN_ACCESS_DENIED",
        "KEYCHAIN_UNAVAILABLE" => "KEYCHAIN_UNAVAILABLE",
        "RUNTIME_STARTUP_FAILED" => "RUNTIME_STARTUP_FAILED",
        "RUNTIME_NETWORK_FAILED" => "RUNTIME_NETWORK_FAILED",
        "WORKSPACE_ACCESS_FAILED" => "WORKSPACE_ACCESS_FAILED",
        "STARTUP_FAILED" => "STARTUP_FAILED",
        _ => "STARTUP_FAILED",
    }
}

pub fn clear_startup(data: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(data.join(STARTUP_LOG)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn write_startup(data: &Path, code: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(data)?;
    #[cfg(unix)]
    std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o700))?;
    let path = data.join(STARTUP_LOG);
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut log = options.open(path)?;
    #[cfg(unix)]
    log.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    writeln!(log, "code={}", allowlisted_code(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn classifies_startup_failures_without_returning_error_text() {
        assert_eq!(classify(&io::Error::other("Cannot unlock the NOMO workspace key in macOS Keychain")), "KEYCHAIN_UNAVAILABLE");
        assert_eq!(classify(&io::Error::other("Runtime exited before readiness")), "RUNTIME_STARTUP_FAILED");
        assert_eq!(classify(&io::Error::other("Desktop runtime did not bind loopback")), "RUNTIME_NETWORK_FAILED");
        assert_eq!(classify(&io::Error::other("workspace.enc exists with a secret-bearing path")), "WORKSPACE_ACCESS_FAILED");
        assert_eq!(classify(&io::Error::other("unexpected internal detail")), "STARTUP_FAILED");
    }
    #[test]
    fn classifies_windows_credential_failures_as_secure_store_failures() {
        assert_eq!(
            classify(&io::Error::other(
                "Cannot unlock the NOMO key in Windows Credential Manager"
            )),
            "KEYCHAIN_UNAVAILABLE"
        );
    }

    /// The denied message names the workspace key but not the keychain, so
    /// without an explicit branch it lands in the generic workspace category
    /// and the operator loses the only part they can act on.
    #[test]
    fn classifies_a_refused_keychain_read_as_its_own_category() {
        assert_eq!(
            classify(&io::Error::other(
                "NOMO workspace key exists but this build is not authorised to read it"
            )),
            "KEYCHAIN_ACCESS_DENIED"
        );
        assert_eq!(allowlisted_code("KEYCHAIN_ACCESS_DENIED"), "KEYCHAIN_ACCESS_DENIED");
    }

    #[test]
    fn startup_log_never_persists_unallowlisted_input() {
        let directory = std::env::temp_dir().join(format!(
            "nomo-startup-diagnostics-unallowlisted-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        write_startup(&directory, "TOKEN=synthetic-secret").unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join(STARTUP_LOG)).unwrap(),
            "code=STARTUP_FAILED\n"
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
    #[test]
    fn startup_log_contains_only_allowlisted_categories() {
        let directory = std::env::temp_dir().join(format!("nomo-startup-diagnostics-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        write_startup(&directory, "KEYCHAIN_UNAVAILABLE").unwrap();
        let log = directory.join(STARTUP_LOG);
        assert_eq!(std::fs::read_to_string(log).unwrap(), "code=KEYCHAIN_UNAVAILABLE\n");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn startup_log_describes_only_the_latest_failure() {
        let directory = std::env::temp_dir().join(format!(
            "nomo-startup-diagnostics-latest-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        write_startup(&directory, "KEYCHAIN_UNAVAILABLE").unwrap();
        write_startup(&directory, "RUNTIME_NETWORK_FAILED").unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join(STARTUP_LOG)).unwrap(),
            "code=RUNTIME_NETWORK_FAILED\n"
        );
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn successful_start_removes_a_stale_failure() {
        let directory = std::env::temp_dir().join(format!(
            "nomo-startup-diagnostics-clear-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        write_startup(&directory, "STARTUP_FAILED").unwrap();
        clear_startup(&directory).unwrap();
        assert!(!directory.join(STARTUP_LOG).exists());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
