#![cfg(target_os = "macos")]

use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

/// Exercise the real Tauri monitor in a child process: its decisive
/// `std::process::exit(1)` cannot be observed safely from an in-process test.
#[test]
fn runtime_exit_smoke_reports_monitor_failure_and_exits_nonzero() {
    let binary = std::env::var("CARGO_BIN_EXE_nomo-desktop")
        .expect("Cargo provides the desktop binary to integration tests");
    let mut child = Command::new(binary)
        .arg("--smoke-runtime-exit")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("desktop runtime-exit smoke must start");
    let mut stderr = child.stderr.take().expect("child stderr is piped");
    let stderr_reader = thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stderr.read_to_end(&mut output);
        output
    });

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            observation => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stderr_reader.join();
                panic!("runtime-exit smoke did not finish within 20s: {observation:?}");
            }
        }
    };
    let stderr = stderr_reader.join().expect("stderr reader completes");
    let marker = b"NOMO native desktop runtime exited unexpectedly.";

    assert_eq!(
        status.code(),
        Some(1),
        "runtime-exit smoke must fail closed"
    );
    assert!(
        stderr.windows(marker.len()).any(|window| window == marker),
        "exit 1 must come from the runtime monitor, not startup failure"
    );
}
