#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod diagnostics;
mod keychain;
use base64::Engine;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Runtime {
    child: Mutex<Child>,
    exit: Mutex<mpsc::Receiver<()>>,
    stopping: AtomicBool,
}

impl Runtime {
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            // Closing the ownership pipe asks Node to cancel sessions and close its server.
            drop(child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn wait_for_exit(&self) -> bool {
        self.exit.lock().map(|exit| exit.recv().is_ok()).unwrap_or(false)
            && !self.stopping.load(Ordering::SeqCst)
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(serde::Deserialize)]
struct Ready {
    port: u16,
}

fn forward_runtime_stdout(
    stdout: impl BufRead,
    sender: mpsc::Sender<Result<String, String>>,
    exit_sender: mpsc::Sender<()>,
) {
    let mut lines = stdout.lines();
    let ready = lines
        .next()
        .ok_or("Runtime exited before readiness".to_owned())
        .and_then(|line| line.map_err(|error| error.to_string()));
    let _ = sender.send(ready);
    for _ in lines {}
    let _ = exit_sender.send(());
}


fn launch_runtime(
    resources: PathBuf,
    data: PathBuf,
    smoke: bool,
) -> Result<(Runtime, u16), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
    }
    let workspace_key = if smoke {
        keychain::ephemeral()?
    } else {
        #[cfg(target_os = "macos")]
        {
            keychain::load_or_create(
                &data,
                &keychain::MacKeychain {
                    account: data.to_string_lossy().into_owned(),
                },
            )?
        }
        #[cfg(windows)]
        {
            keychain::load_or_create(
                &data,
                &keychain::WindowsCredentials {
                    account: data.to_string_lossy().into_owned(),
                },
            )?
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            return Err("Native workspace key storage is supported on macOS and Windows".into());
        }
    };
    let node = resources
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut search_path = vec![resources.join("bin")];
    search_path.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let mut command = Command::new(node);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW for the owned Node runtime.
    }
    let mut child = command
        .arg(resources.join("runtime/runtime.mjs"))
        .current_dir(&data)
        .env("VOID_DATA_DIR", &data)
        .env(
            "VOID_WORKSPACE_KEY",
            base64::engine::general_purpose::STANDARD.encode(&workspace_key.bytes),
        )
        .env("PATH", std::env::join_paths(search_path)?)
        .env("VOID_DESKTOP_WEB_ROOT", resources.join("web"))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("VOID_CONTROL_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().ok_or("Runtime stdout missing")?;
    let (sender, receiver) = mpsc::channel();
    let (exit_sender, exit_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        forward_runtime_stdout(BufReader::new(stdout), sender, exit_sender);
    });
    let runtime = Runtime {
        child: Mutex::new(child),
        exit: Mutex::new(exit_receiver),
        stopping: AtomicBool::new(false),
    };
    let line = receiver.recv_timeout(Duration::from_secs(30))??;
    let ready: Ready = serde_json::from_str(&line)?;
    if ready.port == 0 {
        return Err("Runtime returned an invalid port".into());
    }
    workspace_key.finish_migration()?;
    Ok((runtime, ready.port))
}

fn main() {
    let mobile_smoke = std::env::args().any(|argument| argument == "--smoke-mobile");
    let runtime_exit_smoke = std::env::args().any(|argument| argument == "--smoke-runtime-exit");
    let smoke = mobile_smoke || runtime_exit_smoke || std::env::args().any(|argument| argument == "--smoke-test");
    let smoke_data =
        std::env::temp_dir().join(format!("void-desktop-native-smoke-{}", std::process::id()));
    let cleanup_data = smoke_data.clone();
    let runtime_exited = Arc::new(AtomicBool::new(false));
    let setup_runtime_exited = runtime_exited.clone();
    let builder = tauri::Builder::default();
    let builder = if smoke {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };
    let app = match builder
        .setup(move |app| {
            let data = if smoke {
                smoke_data.clone()
            } else {
                app.path().app_data_dir()?
            };
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                diagnostics::clear_startup(&data)?;
                let resources = if cfg!(debug_assertions) {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
                } else {
                    app.path().resource_dir()?.join("resources")
                };
                let (runtime, port) = launch_runtime(resources, data.clone(), smoke)?;
                app.manage(runtime);
                let origin = format!("http://127.0.0.1:{port}");
            if smoke {
                let mut socket = std::net::TcpStream::connect(("127.0.0.1", port))?;
                socket.set_read_timeout(Some(Duration::from_secs(10)))?;
                write!(
                    socket,
                    "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
                )?;
                let mut response = String::new();
                socket.take(1_048_576).read_to_string(&mut response)?;
                if !response.starts_with("HTTP/1.1 200") || !response.contains("VOID") {
                    return Err("Packaged desktop runtime did not serve the workbench".into());
                }
                let timeout_app = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(20));
                    eprintln!("VOID native desktop smoke timed out waiting for the webview download.");
                    timeout_app.exit(1);
                });
            }
            let allowed = origin.clone();
            let download_origin = origin.clone();
            let download_root = if smoke { data.clone() } else { app.path().download_dir()? };
            std::fs::create_dir_all(&download_root)?;
            let smoke_file = data.join("void-desktop-download-smoke.txt");
            let finish_file = smoke_file.clone();
            let download_app = app.handle().clone();
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("{origin}/").parse()?),
            )
            .title("VOID")
            .visible(!smoke || mobile_smoke)
            .inner_size(if mobile_smoke { 390.0 } else { 1200.0 }, if mobile_smoke { 844.0 } else { 820.0 })
            .min_inner_size(360.0, 520.0)
            .on_navigation(move |url| url.origin().ascii_serialization() == allowed)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(move |_, event| {
                match event {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        if !downloads::allowed(&url, &download_origin) { return false; }
                        if smoke { *destination = smoke_file.clone(); }
                        // Wry picks a collision-free filename in Downloads. Keep it
                        // confined there rather than accepting arbitrary paths.
                        destination.parent() == Some(download_root.as_path())
                    }
                    tauri::webview::DownloadEvent::Finished { success, .. } => {
                        if smoke {
                            let correct = success && std::fs::read(&finish_file).ok().as_deref() == Some(b"VOID desktop download smoke");
                            if correct { println!("VOID native desktop smoke passed: bundled runtime, rendered WebView and Blob download verified. Mobile toolbar checks: {}.", mobile_smoke); }
                            else { eprintln!("VOID native desktop smoke failed: the expected local export was not saved"); }
                            download_app.exit(if correct { 0 } else { 1 });
                        }
                        true
                    }
                    _ => false,
                }
            })
            .on_page_load(move |window, payload| {
                if smoke && !runtime_exit_smoke && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    // Exercise the same browser Blob + anchor.download mechanism
                    // as the production document and conversation export buttons.
                    if mobile_smoke {
                        let _ = window.eval(r#"(() => {
                          const finish = text => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type: 'text/plain'})); a.download = 'void-desktop-download-smoke.txt'; document.body.appendChild(a); a.click(); a.remove(); };
                          const check = (ok, reason) => { if (!ok) throw Error(reason); };
                          let attempts = 0;
                          const timer = setInterval(() => {
                            const toggle = document.querySelector('.mobile-options-toggle');
                            if (!toggle) { if (++attempts > 150) { clearInterval(timer); finish('FAIL: React toolbar did not render'); } return; }
                            clearInterval(timer);
                            try {
                              check(innerWidth >= 360 && innerWidth <= 430, 'mobile viewport');
                              check(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
                              for (const button of document.querySelectorAll('.topbar > button')) {
                                const rect = button.getBoundingClientRect();
                                check(rect.width === 44 && rect.height === 44, 'toolbar target size');
                                check(button.querySelector('svg')?.getBoundingClientRect().width === 20, 'SVG size');
                              }
                              toggle.click();
                              setTimeout(() => {
                                try {
                                  check(document.querySelector('dialog[open]'), 'options dialog open');
                                  const actions = [...document.querySelectorAll('.mobile-action-list button')];
                                  check(actions.length >= 4, 'options present');
                                  check(actions.every(button => button.getBoundingClientRect().height >= 43.9), 'options touch size: ' + actions.map(button => button.getBoundingClientRect().height).join(','));
                                  const before = document.documentElement.dataset.theme;
                                  document.querySelector('.mobile-action-list .theme-toggle').click();
                                  setTimeout(() => {
                                    try { check(document.documentElement.dataset.theme !== before, 'theme action'); finish('VOID desktop download smoke'); }
                                    catch (error) { finish('FAIL: ' + error.message); }
                                  }, 100);
                                } catch (error) { finish('FAIL: ' + error.message); }
                              }, 350);
                            } catch (error) { finish('FAIL: ' + error.message); }
                          }, 100);
                        })()"#);
                    } else {
                    let _ = window.eval(r#"(() => {
                      const finish = text => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type: 'text/plain'})); a.download = 'void-desktop-download-smoke.txt'; document.body.appendChild(a); a.click(); a.remove(); };
                      let attempts = 0, opened = false;
                      const timer = setInterval(() => {
                        if (++attempts > 150) { clearInterval(timer); finish('FAIL: React command menu or bundled tool API unavailable'); return; }
                        const trigger = document.querySelector('.command-trigger');
                        if (!trigger) return;
                        if (!opened) { opened = true; trigger.click(); return; }
                        const options = [...document.querySelectorAll('.command-results [role=option]')];
                        const write = options.find(option => option.textContent.includes('/void_workspace_write'));
                        if (!write) return;
                        clearInterval(timer);
                        const palette = document.querySelector('.command-palette');
                        const composer = document.querySelector('.composer');
                        if (getComputedStyle(composer).overflow === 'hidden' || palette.getBoundingClientRect().height < 100) { finish('FAIL: command menu clipped'); return; }
                        write.click();
                        setTimeout(() => {
                          const draft = document.querySelector('.composer textarea');
                          finish(draft?.value.includes('void_workspace_write') && document.querySelector('.selected-tool') ? 'VOID desktop download smoke' : 'FAIL: tool selection did not prepare a request');
                        }, 150);
                      }, 100);
                    })()"#);
                    }
                }
            })
            .build()?;
                let monitor_app = app.handle().clone();
                let monitor_data = data.clone();
                let monitor_exited = setup_runtime_exited.clone();
                std::thread::spawn(move || {
                    if monitor_app.state::<Runtime>().wait_for_exit() {
                        monitor_exited.store(true, Ordering::SeqCst);
                        let _ = diagnostics::write_startup(&monitor_data, "RUNTIME_EXITED");
                        eprintln!("VOID native desktop runtime exited unexpectedly.");
                        if runtime_exit_smoke {
                            let _ = std::fs::remove_dir_all(&monitor_data);
                            std::process::exit(1);
                        }
                        monitor_app.exit(1);
                    }
                });
                if runtime_exit_smoke {
                    app.state::<Runtime>().kill();
                }
                Ok(())
            })();
            if let Err(error) = &result {
                let _ = diagnostics::write_startup(&data, diagnostics::classify(error.as_ref()));
            }
            result
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(_) => {
            eprintln!(
                "VOID could not start. Check desktop-startup.log in the application data directory; the log contains only a safe failure category."
            );
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<Runtime>().stop();
        }
    });
    if smoke {
        let _ = std::fs::remove_dir_all(cleanup_data);
    }
    if runtime_exited.load(Ordering::SeqCst) {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn runtime_stdout_reports_process_exit_after_readiness() {
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (exit_sender, exit_receiver) = mpsc::channel();

        forward_runtime_stdout(
            BufReader::new(Cursor::new(b"{\"port\":43123}\n".as_slice())),
            ready_sender,
            exit_sender,
        );

        assert_eq!(
            ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok("{\"port\":43123}".to_owned())
        );
        assert!(exit_receiver.recv_timeout(Duration::from_secs(1)).is_ok());
    }
}
