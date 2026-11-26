use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{
        disable_raw_mode, enable_raw_mode, size as terminal_size, EnterAlternateScreen,
        LeaveAlternateScreen,
    },
};
use ratatui::{
    backend::{CrosstermBackend, TestBackend},
    widgets::Paragraph,
    Frame, Terminal,
};
use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::sync::mpsc;
use std::thread;
use unicode_width::UnicodeWidthStr;

const FIXTURE_MODEL: &str = "fixture-model";
const FIXTURE_RUN_TOKENS: u64 = 120;

#[allow(dead_code)]
#[derive(Deserialize)]
struct ProtocolSnapshot {
    version: u8,
    session: Option<ProtocolSession>,
    sessions: Vec<ProtocolSession>,
    approvals: Vec<ProtocolApproval>,
    provider: ProtocolProvider,
    usage: Option<ProtocolUsage>,
    palette: Vec<ProtocolPaletteCommand>,
    diagnostics: Vec<String>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolSession {
    id: String,
    workspace: String,
    model: String,
    status: String,
    continuation_count: u64,
    run_token_count: u64,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ProtocolApproval {
    #[serde(rename = "holdId")]
    hold_id: String,
    tool: String,
    status: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ProtocolProvider {
    status: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ProtocolPaletteCommand {
    command: String,
    description: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolUsage {
    context_messages: u64,
    run_token_count: u64,
}

#[derive(Deserialize)]
struct ProtocolMessage {
    version: u8,
    event: ProtocolServerEvent,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ProtocolServerEvent {
    #[serde(rename = "snapshot")]
    Snapshot { snapshot: ProtocolSnapshot },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SnapshotInput {
    Message(ProtocolMessage),
    Snapshot(ProtocolSnapshot),
}

fn snapshot_from_raw(raw: &str) -> Result<ProtocolSnapshot, Box<dyn std::error::Error>> {
    let input: SnapshotInput = serde_json::from_str(raw)?;
    let snapshot = match input {
        SnapshotInput::Snapshot(snapshot) => snapshot,
        SnapshotInput::Message(message) => {
            if message.version != 1 {
                return Err(
                    format!("unsupported TUI protocol version: {}", message.version).into(),
                );
            }
            match message.event {
                ProtocolServerEvent::Snapshot { snapshot } => snapshot,
                ProtocolServerEvent::Other => {
                    return Err("TUI protocol message is not a snapshot event".into());
                }
            }
        }
    };
    if snapshot.version != 1 {
        return Err(format!("unsupported TUI protocol version: {}", snapshot.version).into());
    }
    Ok(snapshot)
}

fn facts_from_snapshot(snapshot: &ProtocolSnapshot) -> (String, u64) {
    let model = snapshot
        .session
        .as_ref()
        .map(|session| session.model.clone())
        .unwrap_or_else(|| FIXTURE_MODEL.to_string());
    let tokens = snapshot
        .usage
        .as_ref()
        .map(|usage| usage.run_token_count)
        .or_else(|| {
            snapshot
                .session
                .as_ref()
                .map(|session| session.run_token_count)
        })
        .unwrap_or(FIXTURE_RUN_TOKENS);
    (model, tokens)
}

fn snapshot_facts_from_raw(raw: &str) -> Result<(String, u64), Box<dyn std::error::Error>> {
    Ok(facts_from_snapshot(&snapshot_from_raw(raw)?))
}

fn snapshot_facts(path: &str) -> Result<(String, u64), Box<dyn std::error::Error>> {
    snapshot_facts_from_raw(&std::fs::read_to_string(path)?)
}

fn visible_len(value: &str) -> usize {
    UnicodeWidthStr::width(value)
}

fn fit(value: &str, width: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for point in value.chars() {
        let cell = UnicodeWidthStr::width(point.to_string().as_str());
        if used + cell > width {
            break;
        }
        out.push(point);
        used += cell;
    }
    out
}

fn pad(value: &str, width: usize) -> String {
    let mut out = fit(value, width);
    let missing = width.saturating_sub(visible_len(&out));
    out.push_str(&" ".repeat(missing));
    out
}

fn wrap_cells(value: &str, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let mut part = String::new();
    for point in value.chars() {
        let cell = UnicodeWidthStr::width(point.to_string().as_str());
        if !part.is_empty() && visible_len(&part) + cell > width {
            rows.push(part);
            part = String::new();
        }
        part.push(point);
    }
    rows.push(part);
    rows
}

fn inspector_lines(width: usize) -> Vec<String> {
    let mut rows = vec![
        "◈ NOMO".to_string(),
        "real local data, no demo metrics".to_string(),
        "-".repeat(width),
        "WORKING".to_string(),
    ];
    let fields = [
        ("chat", "Type to send; Enter sends; Shift+Enter adds a line. PgUp/PgDn scroll; Up/Down browse one-line history."),
        ("selection", "Escape returns to Chat; Enter opens or inspects the selected row; y/n decides after review."),
        ("paste", "Paste focuses the composer. Control characters are removed."),
        ("commands", "/ opens them, arrows select, Tab completes"),
        ("subagents", "/subagent cancel|review for verified spawned children"),
        ("palette", "/ opens command suggestions; /command-palette opens a searchable list of 75 commands"),
        ("shortcuts", "/keybindings, searchable by key or by action"),
        ("panels", "Escape returns to Chat; Up/Down selects; Enter opens rows or toggles groups; Left/Right pages a tree."),
        ("mode", "Shift+Tab: normal, accept, plan"),
        ("scroll", "PgUp/PgDn, or /bottom to follow the latest"),
        ("stop", "Esc closes a picker, review or detail, clears a filter, or stops the selected run"),
    ];
    let label_col = fields
        .iter()
        .map(|(label, _)| visible_len(label))
        .max()
        .unwrap_or(0);
    let value_width = width.saturating_sub(label_col + 2);
    for (label, value) in fields {
        let chunks = wrap_cells(value, value_width);
        rows.push(format!(
            "{}{}: {}",
            label,
            " ".repeat(label_col - visible_len(label)),
            chunks.first().cloned().unwrap_or_default()
        ));
        for chunk in chunks.iter().skip(1) {
            rows.push(format!("{}{}", " ".repeat(label_col + 2), chunk));
        }
    }
    rows.push(String::new());
    rows.push("MODES THAT CHANGE WHAT A KEY DOES".to_string());
    for (label, value) in [
        ("normal", "Every action asks before it changes anything"),
        (
            "accept",
            "Edit keys are shortened. Tool approvals stay explicit.",
        ),
        (
            "plan  ",
            "Prompts are prefixed so the model plans before acting",
        ),
    ] {
        rows.push(format!("{}: {}", label, value));
    }
    rows.push(String::new());
    rows.push("THINGS THAT ARE NOT HERE".to_string());
    let label = "no equivalent";
    let value = "background tasks, clipboard paste/image attachment, live voice, speech input, Vim editing, /hooks, /vim";
    let value_width = width.saturating_sub(visible_len(label) + 2);
    let chunks = wrap_cells(value, value_width);
    rows.push(format!(
        "{}: {}",
        label,
        chunks.first().cloned().unwrap_or_default()
    ));
    for chunk in chunks.iter().skip(1) {
        rows.push(format!("{}{}", " ".repeat(visible_len(label) + 2), chunk));
    }
    rows.push(String::new());
    rows.push("GUARANTEES".to_string());
    for line in [
        "Revision conflicts never overwrite changes.",
        "Undo and approvals require an explicit confirmation.",
        "Branches copy text and documents; tools are never replayed.",
        "The free model is never silently replaced with a paid one.",
        "Exports use 0600 and never overwrite an existing file.",
        "Data is encrypted in NOMO_DATA_DIR, default ~/.nomo/workbench.",
        "The local TUI never reads private cloud conversations.",
    ] {
        rows.push(line.to_string());
    }
    rows
}

fn content_lines(width: usize) -> Vec<String> {
    let mut rows = vec![
        "QUICK KEYS".to_string(),
        "Ctrl+P  Find a command".to_string(),
        "Alt+M   Choose provider and model".to_string(),
        "/keybindings  See the active keymap".to_string(),
        String::new(),
        "HELP · 75 commands · 7 groups".to_string(),
        String::new(),
    ];
    rows.extend(inspector_lines(width));
    rows
}

fn footer_lines(width: usize, model: &str, run_tokens: u64) -> Vec<String> {
    if width < 50 {
        vec![
            "↑↓/PgUp/PgDn scroll · Esc Chat".to_string(),
            "mode: normal".to_string(),
            format!("model {} · tokens {}", model, run_tokens),
        ]
    } else if width < 120 {
        vec![
            "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat".to_string(),
            if width < 64 {
                format!("model {} · mode  ◆ mode: normal", model)
            } else {
                format!(
                    "model {} · mode  ◆ mode: normal (local only, not enforced)",
                    model
                )
            },
            format!("tokens {} · cost ? · activity details", run_tokens),
        ]
    } else {
        vec![
            "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat".to_string(),
            format!("model {} · mode  ◆ mode: normal (local only, not enforced)  · tokens {} · cost ? · activity details", model, run_tokens),
        ]
    }
}

fn frame_lines(columns: usize, rows: usize, model: &str, run_tokens: u64) -> Vec<String> {
    let body_width = columns.saturating_sub(6).max(1);
    let footer_count = if columns >= 120 { 2usize } else { 3usize };
    let body_budget = rows.saturating_sub(6 + footer_count);
    let mut body = Vec::new();
    for line in content_lines(body_width) {
        for chunk in wrap_cells(&line, body_width) {
            body.push(chunk);
        }
    }
    body.truncate(body_budget);
    while body.len() < body_budget {
        body.push(String::new());
    }

    let mut out = vec![
        pad(" NOMO  ? Help", columns),
        pad(" ← Chat  ·  Esc returns to Chat", columns),
    ];
    for line in body {
        out.push(pad(&format!("   {}", fit(&line, body_width)), columns));
    }
    out.push(format!(" {}{} ", "─".repeat(columns.saturating_sub(2)), ""));
    let footer = footer_lines(columns, model, run_tokens);
    for line in footer.iter().take(3) {
        out.push(pad(&format!(" {}", line), columns));
    }
    while out.len() < rows {
        out.push(" ".repeat(columns));
    }
    out.truncate(rows);
    out.into_iter().map(|line| pad(&line, columns)).collect()
}

fn draw_lines(frame: &mut Frame, lines: &[String]) {
    let text = lines.join("\n");
    frame.render_widget(Paragraph::new(text), frame.area());
}

fn run_interactive(
    columns: u16,
    rows: u16,
    initial_model: &str,
    initial_run_tokens: u64,
    connect: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (tx, rx) = mpsc::channel::<(String, u64)>();
    if let Some(address) = connect {
        let stream = TcpStream::connect(address)?;
        thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(facts) = snapshot_facts_from_raw(&line) {
                    if tx.send(facts).is_err() {
                        break;
                    }
                }
            }
        });
    }

    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut size = (columns, rows);
    let mut model = initial_model.to_string();
    let mut run_tokens = initial_run_tokens;
    let mut redraw = true;
    loop {
        let mut updated = false;
        while let Ok((next_model, next_tokens)) = rx.try_recv() {
            model = next_model;
            run_tokens = next_tokens;
            updated = true;
        }
        if redraw || updated {
            let lines = frame_lines(size.0 as usize, size.1 as usize, &model, run_tokens);
            terminal.draw(|frame| draw_lines(frame, &lines))?;
            redraw = false;
        }
        if !event::poll(std::time::Duration::from_millis(100))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
                    break;
                }
            }
            Event::Resize(columns, rows) => {
                size = (columns, rows);
                redraw = true;
            }
            _ => {}
        }
    }
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}

fn render_with_ratatui(
    lines: &[String],
    columns: u16,
    rows: u16,
) -> Result<String, Box<dyn std::error::Error>> {
    let backend = TestBackend::new(columns, rows);
    let mut terminal = Terminal::new(backend)?;
    let text = lines.join("\n");
    terminal.draw(|frame| {
        frame.render_widget(Paragraph::new(text.as_str()), frame.area());
    })?;
    let buffer = terminal.backend().buffer();
    let mut output = Vec::new();
    for y in 0..rows {
        let mut row = String::new();
        for x in 0..columns {
            row.push_str(buffer[(x, y)].symbol());
        }
        output.push(row);
    }
    Ok(output.join("\n"))
}

fn client_view_select_message(view: &str) -> Result<String, Box<dyn std::error::Error>> {
    const VIEWS: &[&str] = &[
        "chat",
        "sessions",
        "runs",
        "documents",
        "ledger",
        "approvals",
        "policy",
        "tools",
        "mcp",
        "status",
        "models",
        "usage",
        "help",
    ];
    if !VIEWS.contains(&view) {
        return Err(format!("unsupported TUI view: {view}").into());
    }
    Ok(serde_json::json!({
        "version": 1,
        "intent": { "type": "view.select", "view": view }
    })
    .to_string())
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    let prefix = format!("--{}=", name);
    args.iter()
        .find_map(|value| value.strip_prefix(&prefix).map(str::to_string))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("client-intent") {
        let view = args.get(2).map(String::as_str).unwrap_or("help");
        print!("{}", client_view_select_message(view)?);
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("interactive") {
        let columns = args.get(2).map_or(80, |value| value.parse().unwrap_or(80));
        let rows = args.get(3).map_or(24, |value| value.parse().unwrap_or(24));
        let snapshot_path = flag_value(&args, "snapshot").or_else(|| {
            args.get(4)
                .filter(|value| !value.starts_with("--"))
                .cloned()
        });
        let (model, run_tokens) = if let Some(path) = snapshot_path {
            snapshot_facts(&path)?
        } else {
            (FIXTURE_MODEL.to_string(), FIXTURE_RUN_TOKENS)
        };
        return run_interactive(
            columns,
            rows,
            &model,
            run_tokens,
            flag_value(&args, "connect"),
        );
    }
    let (columns, rows) = if args.len() >= 3 {
        (args[1].parse::<u16>()?, args[2].parse::<u16>()?)
    } else {
        terminal_size()?
    };
    if let Some(preset) = args.get(3) {
        match preset.as_str() {
            // The canonical Help frame uses shared glyphs in all three presets.
            "ascii" | "unicode" | "nerd" => {}
            _ => return Err(format!("unsupported symbol preset: {preset}").into()),
        }
    }
    let (model, run_tokens) = if let Some(path) = args.get(4) {
        let (model, tokens) = snapshot_facts(path)?;
        (model, tokens)
    } else {
        (FIXTURE_MODEL.to_string(), FIXTURE_RUN_TOKENS)
    };
    let lines = frame_lines(columns as usize, rows as usize, &model, run_tokens);
    print!("{}", render_with_ratatui(&lines, columns, rows)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        client_view_select_message, frame_lines, snapshot_facts, visible_len, FIXTURE_MODEL,
        FIXTURE_RUN_TOKENS,
    };

    #[test]
    fn frame_shape_is_exact_across_the_parity_matrix() {
        for (columns, rows) in [
            (40, 12),
            (52, 16),
            (80, 24),
            (120, 40),
            (160, 45),
            (200, 48),
        ] {
            let frame = frame_lines(columns, rows, FIXTURE_MODEL, FIXTURE_RUN_TOKENS);
            assert_eq!(frame.len(), rows);
            for row in frame {
                assert_eq!(visible_len(&row), columns);
            }
        }
    }

    #[test]
    fn protocol_snapshot_drives_footer_facts() {
        let (model, tokens) =
            snapshot_facts("fixtures/snapshot.json").expect("fixture snapshot parses");
        assert_eq!(model, "fixture-model");
        assert_eq!(tokens, 120);
        let frame = frame_lines(80, 24, "other-model", 777);
        assert!(frame.iter().any(|row| row.contains("model other-model")));
        assert!(frame.iter().any(|row| row.contains("tokens 777")));
    }

    #[test]
    fn versioned_snapshot_envelope_is_accepted() {
        let raw = std::fs::read_to_string("fixtures/snapshot.json").expect("read fixture");
        let snapshot: serde_json::Value = serde_json::from_str(&raw).expect("fixture json");
        let envelope = serde_json::json!({
            "version": 1,
            "event": { "type": "snapshot", "snapshot": snapshot }
        });
        let path = std::env::temp_dir().join("nomo-rust-spike-envelope.json");
        std::fs::write(
            &path,
            serde_json::to_string(&envelope).expect("serialize envelope"),
        )
        .expect("write envelope");
        let (model, tokens) =
            snapshot_facts(path.to_str().expect("utf8 path")).expect("envelope parses");
        let _ = std::fs::remove_file(path);
        assert_eq!(model, "fixture-model");
        assert_eq!(tokens, 120);
    }

    #[test]
    fn non_snapshot_envelope_is_rejected() {
        let path = std::env::temp_dir().join("nomo-rust-spike-diagnostic.json");
        std::fs::write(
            &path,
            r#"{"version":1,"event":{"type":"diagnostic","message":"hello"}}"#,
        )
        .expect("write diagnostic");
        assert!(snapshot_facts(path.to_str().expect("utf8 path")).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn protocol_snapshot_rejects_unknown_version() {
        let path = std::env::temp_dir().join("nomo-rust-spike-version.json");
        std::fs::write(&path, r#"{"version":2}"#).expect("write fixture");
        assert!(snapshot_facts(path.to_str().expect("utf8 path")).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn client_view_intent_is_versioned_ndjson() {
        let line = client_view_select_message("help").expect("intent serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("intent json");
        assert_eq!(value["version"], 1);
        assert_eq!(value["intent"]["type"], "view.select");
        assert_eq!(value["intent"]["view"], "help");
        assert!(!line.contains('\n'));
        assert!(client_view_select_message("not-a-view").is_err());
    }
}
