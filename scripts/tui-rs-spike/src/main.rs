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
use unicode_width::UnicodeWidthStr;

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

fn footer_lines(width: usize) -> Vec<String> {
    if width < 50 {
        vec![
            "↑↓/PgUp/PgDn scroll · Esc Chat".to_string(),
            "mode: normal".to_string(),
            "model fixture-model · tokens 120".to_string(),
        ]
    } else if width < 120 {
        vec![
            "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat".to_string(),
            if width < 64 {
                "model fixture-model · mode  ◆ mode: normal".to_string()
            } else {
                "model fixture-model · mode  ◆ mode: normal (local only, not enforced)".to_string()
            },
            "tokens 120 · cost ? · activity details".to_string(),
        ]
    } else {
        vec![
            "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat".to_string(),
            "model fixture-model · mode  ◆ mode: normal (local only, not enforced)  · tokens 120 · cost ? · activity details".to_string(),
        ]
    }
}

fn frame_lines(columns: usize, rows: usize) -> Vec<String> {
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
    let footer = footer_lines(columns);
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

fn run_interactive(columns: u16, rows: u16) -> Result<(), Box<dyn std::error::Error>> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut size = (columns, rows);
    let lines = frame_lines(size.0 as usize, size.1 as usize);
    terminal.draw(|frame| draw_lines(frame, &lines))?;
    loop {
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
                let lines = frame_lines(size.0 as usize, size.1 as usize);
                terminal.draw(|frame| draw_lines(frame, &lines))?;
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("interactive") {
        let columns = args.get(2).map_or(80, |value| value.parse().unwrap_or(80));
        let rows = args.get(3).map_or(24, |value| value.parse().unwrap_or(24));
        return run_interactive(columns, rows);
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
    let lines = frame_lines(columns as usize, rows as usize);
    print!("{}", render_with_ratatui(&lines, columns, rows)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{frame_lines, visible_len};

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
            let frame = frame_lines(columns, rows);
            assert_eq!(frame.len(), rows);
            for row in frame {
                assert_eq!(visible_len(&row), columns);
            }
        }
    }
}
