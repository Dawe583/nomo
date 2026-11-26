use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind,
        KeyModifiers,
    },
    execute,
    terminal::{
        disable_raw_mode, enable_raw_mode, size as terminal_size, EnterAlternateScreen,
        LeaveAlternateScreen,
    },
};
use ratatui::{
    backend::{CrosstermBackend, TestBackend},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::Paragraph,
    Frame, Terminal,
};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_width::UnicodeWidthStr;

const FIXTURE_MODEL: &str = "fixture-model";
const FIXTURE_RUN_TOKENS: u64 = 120;

#[allow(dead_code)]
#[derive(Deserialize)]
struct ProtocolSnapshot {
    version: u8,
    session: Option<ProtocolSession>,
    sessions: Vec<ProtocolSession>,
    transcript: Option<ProtocolTranscriptPage>,
    approvals: Vec<ProtocolApproval>,
    provider: ProtocolProvider,
    usage: Option<ProtocolUsage>,
    palette: Vec<ProtocolPaletteCommand>,
    diagnostics: Vec<String>,
}

#[allow(dead_code)]
#[derive(Clone, Deserialize)]
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

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolTranscriptPage {
    session_id: String,
    events: Vec<ProtocolTranscriptEvent>,
    latest_seq: u64,
    oldest_seq: u64,
    has_more: bool,
    next_before_seq: Option<u64>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ProtocolTranscriptEvent {
    seq: u64,
    at: String,
    kind: String,
    text: String,
}

#[derive(Clone)]
struct TranscriptRow {
    seq: u64,
    kind: String,
    text: String,
}

#[derive(Clone)]
struct SnapshotFacts {
    session_id: String,
    model: String,
    run_tokens: u64,
    status: String,
    event_count: u64,
    latest_seq: u64,
    transcript_events: Vec<TranscriptRow>,
    sessions: Vec<ProtocolSession>,
}

impl SnapshotFacts {
    fn fixture() -> Self {
        Self {
            session_id: "sess-visual".to_string(),
            model: FIXTURE_MODEL.to_string(),
            run_tokens: FIXTURE_RUN_TOKENS,
            status: "idle".to_string(),
            event_count: 0,
            latest_seq: 0,
            transcript_events: Vec::new(),
            sessions: Vec::new(),
        }
    }
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
    #[serde(rename = "transcript.appended")]
    TranscriptAppended {
        #[serde(rename = "sessionId")]
        session_id: String,
        event: ProtocolTranscriptEvent,
    },
    #[serde(rename = "session.updated")]
    SessionUpdated { session: ProtocolSession },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SnapshotInput {
    Message(ProtocolMessage),
    Snapshot(ProtocolSnapshot),
}

enum WireUpdate {
    Snapshot(SnapshotFacts),
    TranscriptAppended {
        session_id: String,
        event: TranscriptRow,
    },
    SessionUpdated(ProtocolSession),
}

fn capped_transcript(mut rows: Vec<TranscriptRow>) -> Vec<TranscriptRow> {
    if rows.len() > 100 {
        rows = rows.split_off(rows.len() - 100);
    }
    rows
}

fn apply_wire_update(facts: &mut SnapshotFacts, update: WireUpdate) {
    match update {
        WireUpdate::Snapshot(next) => *facts = next,
        WireUpdate::TranscriptAppended { session_id, event } => {
            if session_id != facts.session_id
                || facts
                    .transcript_events
                    .iter()
                    .any(|existing| existing.seq == event.seq)
            {
                return;
            }
            facts.transcript_events.push(event);
            facts.transcript_events.sort_by_key(|row| row.seq);
            facts.transcript_events =
                capped_transcript(std::mem::take(&mut facts.transcript_events));
            facts.event_count = facts.transcript_events.len() as u64;
            facts.latest_seq = facts
                .transcript_events
                .last()
                .map_or(facts.latest_seq, |row| row.seq);
        }
        WireUpdate::SessionUpdated(session) => {
            if session.id != facts.session_id {
                return;
            }
            facts.model = session.model.clone();
            facts.status = session.status.clone();
            facts.run_tokens = session.run_token_count;
            if let Some(existing) = facts
                .sessions
                .iter_mut()
                .find(|existing| existing.id == session.id)
            {
                *existing = session;
            } else {
                facts.sessions.push(session);
            }
        }
    }
}

fn wire_update_from_raw(raw: &str) -> Result<WireUpdate, Box<dyn std::error::Error>> {
    let input: SnapshotInput = serde_json::from_str(raw)?;
    match input {
        SnapshotInput::Snapshot(snapshot) => {
            if snapshot.version != 1 {
                return Err(
                    format!("unsupported TUI protocol version: {}", snapshot.version).into(),
                );
            }
            Ok(WireUpdate::Snapshot(facts_from_snapshot(&snapshot)))
        }
        SnapshotInput::Message(message) => {
            if message.version != 1 {
                return Err(
                    format!("unsupported TUI protocol version: {}", message.version).into(),
                );
            }
            match message.event {
                ProtocolServerEvent::Snapshot { snapshot } => {
                    if snapshot.version != 1 {
                        return Err(format!(
                            "unsupported TUI protocol version: {}",
                            snapshot.version
                        )
                        .into());
                    }
                    Ok(WireUpdate::Snapshot(facts_from_snapshot(&snapshot)))
                }
                ProtocolServerEvent::TranscriptAppended { session_id, event } => {
                    Ok(WireUpdate::TranscriptAppended {
                        session_id,
                        event: TranscriptRow {
                            seq: event.seq,
                            kind: event.kind,
                            text: event.text,
                        },
                    })
                }
                ProtocolServerEvent::SessionUpdated { session } => {
                    Ok(WireUpdate::SessionUpdated(session))
                }
                ProtocolServerEvent::Other => Err("unsupported TUI protocol event".into()),
            }
        }
    }
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
                ProtocolServerEvent::TranscriptAppended { .. }
                | ProtocolServerEvent::SessionUpdated { .. }
                | ProtocolServerEvent::Other => {
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

fn facts_from_snapshot(snapshot: &ProtocolSnapshot) -> SnapshotFacts {
    let session = snapshot.session.as_ref();
    let transcript = snapshot.transcript.as_ref();
    SnapshotFacts {
        session_id: session
            .map(|value| value.id.clone())
            .unwrap_or_else(|| "sess-visual".to_string()),
        model: session
            .map(|value| value.model.clone())
            .unwrap_or_else(|| FIXTURE_MODEL.to_string()),
        run_tokens: snapshot
            .usage
            .as_ref()
            .map(|usage| usage.run_token_count)
            .or_else(|| session.map(|value| value.run_token_count))
            .unwrap_or(FIXTURE_RUN_TOKENS),
        status: session
            .map(|value| value.status.clone())
            .unwrap_or_else(|| "idle".to_string()),
        event_count: transcript.map_or(0, |page| page.events.len() as u64),
        latest_seq: transcript.map_or(0, |page| page.latest_seq),
        transcript_events: transcript
            .map(|page| {
                page.events
                    .iter()
                    .map(|event| TranscriptRow {
                        seq: event.seq,
                        kind: event.kind.clone(),
                        text: event.text.clone(),
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .take(100)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            })
            .unwrap_or_default(),
        sessions: snapshot.sessions.clone(),
    }
}

fn snapshot_facts_from_raw(raw: &str) -> Result<SnapshotFacts, Box<dyn std::error::Error>> {
    Ok(facts_from_snapshot(&snapshot_from_raw(raw)?))
}

fn snapshot_facts(path: &str) -> Result<SnapshotFacts, Box<dyn std::error::Error>> {
    snapshot_facts_from_raw(&std::fs::read_to_string(path)?)
}

fn visible_len(value: &str) -> usize {
    UnicodeWidthStr::width(value)
}

fn fit(value: &str, width: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for raw in value.chars() {
        let point = if matches!(raw, '\n' | '\r') {
            '⏎'
        } else if raw.is_control() {
            ' '
        } else {
            raw
        };
        let cell = UnicodeWidthStr::width(point.to_string().as_str());
        if used + cell > width {
            break;
        }
        out.push(point);
        used += cell;
    }
    out
}

struct Composer {
    text: String,
    cursor: usize,
}

impl Composer {
    fn new() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
        }
    }

    fn insert_char(&mut self, ch: char) {
        if self.text.len() + ch.len_utf8() > 500 {
            return;
        }
        self.text.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
    }

    fn insert_str(&mut self, value: &str) {
        for ch in value.chars() {
            self.insert_char(ch);
        }
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let previous = self.text[..self.cursor]
            .char_indices()
            .last()
            .map_or(0, |(index, _)| index);
        self.text.replace_range(previous..self.cursor, "");
        self.cursor = previous;
    }

    fn delete(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let ch = self.text[self.cursor..]
            .chars()
            .next()
            .expect("cursor is before a character");
        self.text
            .replace_range(self.cursor..self.cursor + ch.len_utf8(), "");
    }

    fn left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor = self.text[..self.cursor]
            .char_indices()
            .last()
            .map_or(0, |(index, _)| index);
    }

    fn right(&mut self) {
        if let Some(ch) = self.text[self.cursor..].chars().next() {
            self.cursor += ch.len_utf8();
        }
    }

    fn display(&self) -> String {
        let mut raw = self.text.clone();
        raw.insert(self.cursor, '▏');
        raw.chars()
            .map(|ch| {
                if matches!(ch, '\n' | '\r') {
                    '⏎'
                } else if ch.is_control() {
                    ' '
                } else {
                    ch
                }
            })
            .collect()
    }
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

fn footer_lines(
    width: usize,
    facts: &SnapshotFacts,
    live: bool,
    scroll: usize,
    composer: Option<&str>,
) -> Vec<String> {
    let model = facts.model.as_str();
    let run_tokens = facts.run_tokens;
    if width < 50 {
        vec![
            if live {
                composer.map_or_else(
                    || "↑↓ scroll · [/] session · i prompt · s stop".to_string(),
                    |prompt| format!("prompt> {}", prompt),
                )
            } else {
                "↑↓/PgUp/PgDn scroll · Esc Chat".to_string()
            },
            if live {
                format!(
                    "status {} · page {} · sc{}",
                    facts.status, facts.event_count, scroll
                )
            } else {
                "mode: normal".to_string()
            },
            format!("model {} · tokens {}", model, run_tokens),
        ]
    } else if width < 120 {
        vec![
            if live {
                composer.map_or_else(
                    || "↑/↓ scroll · [/] session · i prompt · s stop".to_string(),
                    |prompt| format!("prompt> {}", prompt),
                )
            } else {
                "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat".to_string()
            },
            if width < 64 {
                format!("model {} · mode  ◆ mode: normal", model)
            } else {
                format!(
                    "model {} · mode  ◆ mode: normal (local only, not enforced)",
                    model
                )
            },
            if live {
                format!(
                    "tokens {} · cost ? · status {} · page {}/{} · sc{}",
                    run_tokens, facts.status, facts.event_count, facts.latest_seq, scroll
                )
            } else {
                format!("tokens {} · cost ? · activity details", run_tokens)
            },
        ]
    } else {
        vec![
            if live {
                composer.map_or_else(
                    || "↑/↓ scroll · [/] session · i prompt · s stop".to_string(),
                    |prompt| format!("prompt> {}", prompt),
                )
            } else {
                "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat".to_string()
            },
            if live {
                format!("model {} · mode  ◆ mode: normal (local only, not enforced)  · tokens {} · cost ? · status {} · page {}/{} · sc{}", model, run_tokens, facts.status, facts.event_count, facts.latest_seq, scroll)
            } else {
                format!("model {} · mode  ◆ mode: normal (local only, not enforced)  · tokens {} · cost ? · activity details", model, run_tokens)
            },
        ]
    }
}

fn transcript_body_lines(facts: &SnapshotFacts, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    if facts.transcript_events.is_empty() {
        rows.push("waiting for transcript".to_string());
        return rows;
    }
    for event in facts
        .transcript_events
        .iter()
        .filter(|event| !event.text.trim().is_empty())
    {
        let label = format!("{} {}", event.kind, event.text);
        rows.extend(wrap_cells(&label, width));
    }
    rows
}

fn body_budget(columns: usize, rows: usize) -> usize {
    let footer_count = if columns >= 120 { 2usize } else { 3usize };
    rows.saturating_sub(6 + footer_count)
}

fn frame_lines_with_live(
    columns: usize,
    rows: usize,
    facts: &SnapshotFacts,
    live: bool,
    scroll: usize,
    composer: Option<&str>,
) -> Vec<String> {
    let body_width = columns.saturating_sub(6).max(1);
    let budget = body_budget(columns, rows);
    let body = if live {
        let lines = transcript_body_lines(facts, body_width);
        let max_scroll = lines.len().saturating_sub(budget);
        let clamped_scroll = scroll.min(max_scroll);
        let start = lines.len().saturating_sub(budget + clamped_scroll);
        let end = (start + budget).min(lines.len());
        let mut viewport = lines[start..end].to_vec();
        while viewport.len() < budget {
            viewport.push(String::new());
        }
        viewport
    } else {
        let mut static_body = Vec::new();
        for line in content_lines(body_width) {
            static_body.extend(wrap_cells(&line, body_width));
        }
        static_body.truncate(budget);
        while static_body.len() < budget {
            static_body.push(String::new());
        }
        static_body
    };

    let mut out = if live {
        vec![
            pad(" NOMO  live Chat", columns),
            pad(
                " ↑/↓ scroll · g/G top/bottom · s stop · Esc/q quit",
                columns,
            ),
        ]
    } else {
        vec![
            pad(" NOMO  ? Help", columns),
            pad(" ← Chat  ·  Esc returns to Chat", columns),
        ]
    };
    for line in body {
        out.push(pad(&format!("   {}", fit(&line, body_width)), columns));
    }
    out.push(format!(" {}{} ", "─".repeat(columns.saturating_sub(2)), ""));
    let footer = footer_lines(columns, facts, live, scroll, composer);
    for line in footer.iter().take(3) {
        out.push(pad(&format!(" {}", line), columns));
    }
    while out.len() < rows {
        out.push(" ".repeat(columns));
    }
    out.truncate(rows);
    out.into_iter().map(|line| pad(&line, columns)).collect()
}

fn frame_lines(columns: usize, rows: usize, model: &str, run_tokens: u64) -> Vec<String> {
    let facts = SnapshotFacts {
        session_id: "sess-visual".to_string(),
        model: model.to_string(),
        run_tokens,
        status: "idle".to_string(),
        event_count: 0,
        latest_seq: 0,
        transcript_events: Vec::new(),
        sessions: Vec::new(),
    };
    frame_lines_with_live(columns, rows, &facts, false, 0, None)
}

fn role_style(kind: &str, color: bool) -> Style {
    let mut style = Style::default();
    if color {
        style = style.fg(match kind {
            "assistant" => Color::Green,
            "user" => Color::Cyan,
            "tool" => Color::Yellow,
            "error" => Color::Red,
            "usage" => Color::Magenta,
            _ => Color::Reset,
        });
    }
    match kind {
        "assistant" | "user" | "error" => style.add_modifier(Modifier::BOLD),
        "tool" | "usage" => style.add_modifier(Modifier::DIM),
        _ => style,
    }
}

fn styled_line(line: &str, live: bool, color: bool) -> Line<'static> {
    if !live {
        return Line::raw(line.to_string());
    }
    let indent = line.len() - line.trim_start().len();
    let rest = &line[indent..];
    for kind in ["assistant", "user", "tool", "error", "usage"] {
        let prefix = format!("{kind} ");
        if rest.starts_with(&prefix) {
            return Line::from(vec![
                Span::raw(line[..indent].to_string()),
                Span::styled(kind.to_string(), role_style(kind, color)),
                Span::raw(rest[kind.len()..].to_string()),
            ]);
        }
    }
    Line::raw(line.to_string())
}

fn draw_lines(frame: &mut Frame, lines: &[String], live: bool, color: bool) {
    let rows = lines
        .iter()
        .map(|line| styled_line(line, live, color))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(Text::from(rows)), frame.area());
}

fn run_interactive(
    columns: u16,
    rows: u16,
    initial_facts: SnapshotFacts,
    connect: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let connected = connect.is_some();
    let (tx, rx) = mpsc::channel::<WireUpdate>();
    let mut writer = None;
    if let Some(address) = connect {
        let stream = TcpStream::connect(address)?;
        writer = Some(stream.try_clone()?);
        thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(update) = wire_update_from_raw(&line) {
                    if tx.send(update).is_err() {
                        break;
                    }
                }
            }
        });
    }

    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut size = (columns, rows);
    let mut facts = initial_facts;
    let mut scroll = 0usize;
    let mut composer: Option<Composer> = None;
    let mut redraw = true;
    loop {
        let mut updated = false;
        while let Ok(update) = rx.try_recv() {
            let previous_session = facts.session_id.clone();
            apply_wire_update(&mut facts, update);
            if facts.session_id != previous_session {
                scroll = 0;
            }
            updated = true;
        }
        if redraw || updated {
            let composer_text = composer.as_ref().map(Composer::display);
            let lines = frame_lines_with_live(
                size.0 as usize,
                size.1 as usize,
                &facts,
                connected,
                scroll,
                composer_text.as_deref(),
            );
            terminal.draw(|frame| {
                draw_lines(
                    frame,
                    &lines,
                    connected,
                    std::env::var_os("NO_COLOR").is_none(),
                )
            })?;
            redraw = false;
        }
        if !event::poll(std::time::Duration::from_millis(100))? {
            continue;
        }
        match event::read()? {
            Event::Paste(text) => {
                if let Some(buffer) = composer.as_mut() {
                    buffer.insert_str(&text);
                    redraw = true;
                }
            }
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if !connected {
                    if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
                        break;
                    }
                    continue;
                }
                if let Some(buffer) = composer.as_mut() {
                    match key.code {
                        KeyCode::Esc => {
                            composer = None;
                        }
                        KeyCode::Enter if key.modifiers.contains(KeyModifiers::ALT) => {
                            buffer.insert_char('\n');
                        }
                        KeyCode::Enter => {
                            let prompt = buffer.text.trim().to_string();
                            if !prompt.is_empty() {
                                if let Some(stream) = writer.as_mut() {
                                    let key = next_idempotency_key();
                                    let line = client_session_create_message(&prompt, &key)?;
                                    stream.write_all(line.as_bytes())?;
                                    stream.write_all(b"\n")?;
                                }
                            }
                            composer = None;
                        }
                        KeyCode::Backspace => buffer.backspace(),
                        KeyCode::Delete => buffer.delete(),
                        KeyCode::Left => buffer.left(),
                        KeyCode::Right => buffer.right(),
                        KeyCode::Home => buffer.cursor = 0,
                        KeyCode::End => buffer.cursor = buffer.text.len(),
                        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            buffer.text.clear();
                            buffer.cursor = 0;
                        }
                        KeyCode::Char(ch)
                            if matches!(
                                key.modifiers,
                                KeyModifiers::NONE | KeyModifiers::SHIFT
                            ) =>
                        {
                            buffer.insert_char(ch);
                        }
                        _ => {}
                    }
                    redraw = true;
                    continue;
                }
                if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
                    break;
                }
                let width = size.0 as usize;
                let height = size.1 as usize;
                let max_scroll = transcript_body_lines(&facts, width.saturating_sub(6).max(1))
                    .len()
                    .saturating_sub(body_budget(width, height));
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        scroll = (scroll + 1).min(max_scroll);
                        redraw = true;
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        scroll = scroll.saturating_sub(1);
                        redraw = true;
                    }
                    KeyCode::PageUp => {
                        scroll = (scroll + body_budget(width, height)).min(max_scroll);
                        redraw = true;
                    }
                    KeyCode::PageDown => {
                        scroll = scroll.saturating_sub(body_budget(width, height));
                        redraw = true;
                    }
                    KeyCode::Home | KeyCode::Char('g') => {
                        scroll = max_scroll;
                        redraw = true;
                    }
                    KeyCode::End | KeyCode::Char('G') => {
                        scroll = 0;
                        redraw = true;
                    }
                    KeyCode::Char('[') | KeyCode::Char(']') => {
                        if !facts.sessions.is_empty() {
                            let current = facts
                                .sessions
                                .iter()
                                .position(|session| session.id == facts.session_id)
                                .unwrap_or(0);
                            let delta: isize = if key.code == KeyCode::Char('[') {
                                -1
                            } else {
                                1
                            };
                            let len = facts.sessions.len() as isize;
                            let next = (current as isize + delta).rem_euclid(len) as usize;
                            let session_id = facts.sessions[next].id.clone();
                            if session_id != facts.session_id {
                                if let Some(stream) = writer.as_mut() {
                                    let line = client_session_select_message(&session_id)?;
                                    stream.write_all(line.as_bytes())?;
                                    stream.write_all(b"\n")?;
                                }
                            }
                        }
                    }
                    KeyCode::Char('i') => {
                        composer = Some(Composer::new());
                        redraw = true;
                    }
                    KeyCode::Char('s') => {
                        if let Some(stream) = writer.as_mut() {
                            let line = client_run_stop_message(&facts.session_id)?;
                            stream.write_all(line.as_bytes())?;
                            stream.write_all(b"\n")?;
                        }
                    }
                    _ => {}
                }
            }
            Event::Resize(columns, rows) => {
                size = (columns, rows);
                let max_scroll =
                    transcript_body_lines(&facts, (columns as usize).saturating_sub(6).max(1))
                        .len()
                        .saturating_sub(body_budget(columns as usize, rows as usize));
                scroll = scroll.min(max_scroll);
                redraw = true;
            }
            _ => {}
        }
    }
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableBracketedPaste,
        LeaveAlternateScreen
    )?;
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

fn client_run_stop_message(session_id: &str) -> Result<String, Box<dyn std::error::Error>> {
    if session_id.trim().is_empty() || session_id.len() > 160 {
        return Err("invalid TUI session id".into());
    }
    Ok(serde_json::json!({
        "version": 1,
        "intent": { "type": "run.stop", "sessionId": session_id }
    })
    .to_string())
}

fn client_session_select_message(session_id: &str) -> Result<String, Box<dyn std::error::Error>> {
    if session_id.trim().is_empty() || session_id.len() > 160 {
        return Err("invalid TUI session id".into());
    }
    Ok(serde_json::json!({
        "version": 1,
        "intent": { "type": "session.select", "sessionId": session_id }
    })
    .to_string())
}

fn valid_idempotency_key(key: &str) -> bool {
    (8..=128).contains(&key.len())
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '_' | '-'))
}

fn client_session_create_message(
    prompt: &str,
    idempotency_key: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    if prompt.trim().is_empty() || prompt.len() > 500 {
        return Err("invalid TUI prompt".into());
    }
    if !valid_idempotency_key(idempotency_key) {
        return Err("invalid TUI idempotency key".into());
    }
    Ok(serde_json::json!({
        "version": 1,
        "intent": {
            "type": "session.create",
            "prompt": prompt,
            "idempotencyKey": idempotency_key
        }
    })
    .to_string())
}

fn next_idempotency_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("rust:{}:{nanos}", std::process::id())
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
        let facts = if let Some(path) = snapshot_path {
            snapshot_facts(&path)?
        } else {
            SnapshotFacts::fixture()
        };
        return run_interactive(columns, rows, facts, flag_value(&args, "connect"));
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
    let facts = if let Some(path) = args.get(4) {
        snapshot_facts(path)?
    } else {
        SnapshotFacts::fixture()
    };
    let lines = frame_lines(
        columns as usize,
        rows as usize,
        &facts.model,
        facts.run_tokens,
    );
    print!("{}", render_with_ratatui(&lines, columns, rows)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_wire_update, client_run_stop_message, client_session_create_message,
        client_session_select_message, client_view_select_message, draw_lines, frame_lines,
        frame_lines_with_live, snapshot_facts, visible_len, wire_update_from_raw, Color, Composer,
        Modifier, SnapshotFacts, Terminal, TestBackend, TranscriptRow, FIXTURE_MODEL,
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
        let facts = snapshot_facts("fixtures/snapshot.json").expect("fixture snapshot parses");
        assert_eq!(facts.model, "fixture-model");
        assert_eq!(facts.run_tokens, 120);
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
        let facts = snapshot_facts(path.to_str().expect("utf8 path")).expect("envelope parses");
        let _ = std::fs::remove_file(path);
        assert_eq!(facts.model, "fixture-model");
        assert_eq!(facts.run_tokens, 120);
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

    #[test]
    fn client_run_stop_intent_is_versioned_ndjson() {
        let line = client_run_stop_message("session-1").expect("intent serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("intent json");
        assert_eq!(value["version"], 1);
        assert_eq!(value["intent"]["type"], "run.stop");
        assert_eq!(value["intent"]["sessionId"], "session-1");
        assert!(!line.contains('\n'));
        assert!(client_run_stop_message("").is_err());
    }

    #[test]
    fn client_session_create_intent_is_versioned_ndjson() {
        let line = client_session_create_message("hello composer", "rust:1:abcdef")
            .expect("intent serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("intent json");
        assert_eq!(value["version"], 1);
        assert_eq!(value["intent"]["type"], "session.create");
        assert_eq!(value["intent"]["prompt"], "hello composer");
        assert_eq!(value["intent"]["idempotencyKey"], "rust:1:abcdef");
        assert!(!line.contains('\n'));
        assert!(client_session_create_message(" ", "rust:1:abcdef").is_err());
        assert!(client_session_create_message("hello", "bad key").is_err());
    }

    #[test]
    fn client_session_select_intent_is_versioned_ndjson() {
        let line = client_session_select_message("session-1").expect("intent serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("intent json");
        assert_eq!(value["version"], 1);
        assert_eq!(value["intent"]["type"], "session.select");
        assert_eq!(value["intent"]["sessionId"], "session-1");
        assert!(!line.contains('\n'));
        assert!(client_session_select_message("").is_err());
    }

    #[test]
    fn composer_edits_unicode_cursor_and_sanitizes_display() {
        let mut composer = Composer::new();
        composer.insert_str("abč");
        composer.left();
        composer.insert_char('X');
        assert_eq!(composer.text, "abXč");
        composer.backspace();
        assert_eq!(composer.text, "abč");
        composer.right();
        assert_eq!(composer.cursor, composer.text.len());
        composer.left();
        composer.delete();
        assert_eq!(composer.text, "ab");
        composer.insert_str("\nž");
        assert_eq!(composer.text, "ab\nž");
        composer.cursor = 0;
        assert_eq!(composer.display(), "▏ab⏎ž");
    }
    #[test]
    fn connected_frame_surfaces_latest_assistant_text() {
        let facts = SnapshotFacts {
            session_id: "session-1".to_string(),
            model: "model".to_string(),
            run_tokens: 0,
            status: "running".to_string(),
            event_count: 1,
            latest_seq: 1,
            transcript_events: vec![TranscriptRow {
                seq: 1,
                kind: "assistant".to_string(),
                text: "live transcript visible".to_string(),
            }],
            sessions: Vec::new(),
        };
        let frame = frame_lines_with_live(80, 24, &facts, true, 0, None);
        assert!(frame
            .iter()
            .any(|row| row.contains("live transcript visible")));
        let canonical = frame_lines_with_live(80, 24, &facts, false, 0, None);
        assert!(!canonical
            .iter()
            .any(|row| row.contains("live transcript visible")));
    }
    #[test]
    fn connected_transcript_scrolls_to_top_and_bottom() {
        let facts = SnapshotFacts {
            session_id: "session-1".to_string(),
            model: "model".to_string(),
            run_tokens: 0,
            status: "running".to_string(),
            event_count: 30,
            latest_seq: 30,
            transcript_events: (0..30)
                .map(|index| TranscriptRow {
                    seq: index + 1,
                    kind: "assistant".to_string(),
                    text: format!("row-{index:02}"),
                })
                .collect(),
            sessions: Vec::new(),
        };
        let bottom = frame_lines_with_live(80, 24, &facts, true, 0, None);
        assert!(bottom.iter().any(|row| row.contains("row-29")));
        assert!(!bottom.iter().any(|row| row.contains("row-00")));
        let top = frame_lines_with_live(80, 24, &facts, true, usize::MAX, None);
        assert!(top.iter().any(|row| row.contains("row-00")));
        assert!(!top.iter().any(|row| row.contains("row-29")));
        assert_eq!(top.len(), 24);
        assert!(top.iter().all(|row| visible_len(row) == 80));
    }
    #[test]
    fn transcript_and_session_updates_apply_incrementally() {
        let mut facts = SnapshotFacts::fixture();
        let appended = wire_update_from_raw(
            r#"{"version":1,"event":{"type":"transcript.appended","sessionId":"sess-visual","event":{"seq":1,"at":"2026-01-01T00:00:00.000Z","kind":"assistant","type":"message.completed","text":"incremental row"}}}"#,
        )
        .expect("append update parses");
        apply_wire_update(&mut facts, appended);
        assert!(facts
            .transcript_events
            .iter()
            .any(|row| row.text == "incremental row"));
        assert_eq!(facts.latest_seq, 1);
        let updated = wire_update_from_raw(
            r#"{"version":1,"event":{"type":"session.updated","session":{"id":"sess-visual","workspace":"ws","model":"updated-model","status":"running","continuationCount":0,"runTokenCount":7}}}"#,
        )
        .expect("session update parses");
        apply_wire_update(&mut facts, updated);
        assert_eq!(facts.model, "updated-model");
        assert_eq!(facts.status, "running");
        assert_eq!(facts.run_tokens, 7);
    }
    #[test]
    fn live_role_labels_are_styled_without_changing_text() {
        let lines = vec!["   assistant answer".to_string()];
        let backend = TestBackend::new(30, 1);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw_lines(frame, &lines, true, true))
            .expect("draw styled line");
        let buffer = terminal.backend().buffer();
        let text = (0..30).map(|x| buffer[(x, 0)].symbol()).collect::<String>();
        assert_eq!(text.trim_end(), "   assistant answer");
        assert_eq!(buffer[(3, 0)].fg, Color::Green);
        assert!(buffer[(3, 0)].modifier.contains(Modifier::BOLD));
        assert_eq!(buffer[(12, 0)].fg, Color::Reset);
    }
}
