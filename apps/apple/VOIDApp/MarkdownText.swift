import SwiftUI
import UIKit

/// One parsed block. The parser is a value type with no UIKit or SwiftUI
/// dependency, so its output can be reasoned about on its own.
struct MarkdownElement: Identifiable, Equatable {
    let id: Int
    let block: MarkdownBlock
}

enum MarkdownBlock: Equatable {
    case heading(level: Int, inline: String)
    case paragraph(String)
    case bullet(items: [String])
    case ordered(items: [String])
    case code(language: String?, source: String)
    case table(headers: [String], rows: [[String]])
    case quote([String])
}

/// A small block parser for the subset of Markdown a conversation actually
/// contains. Raw HTML is never interpreted: `<script>` is a paragraph of text,
/// which is why the parser has no pass-through path to a view.
enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownElement] {
        let lines = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")

        var elements: [MarkdownElement] = []
        var index = 0
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            elements.append(MarkdownElement(id: elements.count, block: .paragraph(paragraph.joined(separator: " "))))
            paragraph = []
        }

        while index < lines.count {
            let raw = lines[index]
            let line = raw.trimmingCharacters(in: .whitespaces)

            if line.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if let fence = fenceMarker(line) {
                flushParagraph()
                var body: [String] = []
                var cursor = index + 1
                while cursor < lines.count, fenceMarker(lines[cursor].trimmingCharacters(in: .whitespaces)) == nil {
                    body.append(lines[cursor])
                    cursor += 1
                }
                let afterFence = fence.dropFirst(fence.hasPrefix("```") ? 3 : 3)
                let language = afterFence.trimmingCharacters(in: .whitespaces)
                elements.append(MarkdownElement(id: elements.count, block: .code(language: language, source: body.joined(separator: "\n"))))
                index = min(cursor + 1, lines.count)
                continue
            }

            if line.hasPrefix("#") {
                let hashes = line.prefix(while: { $0 == "#" }).count
                if hashes >= 1, hashes <= 6, line.dropFirst(hashes).first == " " {
                    flushParagraph()
                    let text = String(line.dropFirst(hashes + 1))
                    elements.append(MarkdownElement(id: elements.count, block: .heading(level: hashes, inline: text)))
                    index += 1
                    continue
                }
            }

            if let (headers, rows, next) = parseTable(lines, at: index) {
                flushParagraph()
                elements.append(MarkdownElement(id: elements.count, block: .table(headers: headers, rows: rows)))
                index = next
                continue
            }

            if line.hasPrefix("> ") {
                flushParagraph()
                var quoted: [String] = []
                var cursor = index
                while cursor < lines.count, lines[cursor].trimmingCharacters(in: .whitespaces).hasPrefix("> ") {
                    quoted.append(String(lines[cursor].trimmingCharacters(in: .whitespaces).dropFirst(2)))
                    cursor += 1
                }
                elements.append(MarkdownElement(id: elements.count, block: .quote(quoted)))
                index = cursor
                continue
            }

            if let (item, isOrdered) = listItem(line) {
                flushParagraph()
                var items: [String] = [item]
                var cursor = index + 1
                while cursor < lines.count,
                      let (next, nextOrdered) = listItem(lines[cursor].trimmingCharacters(in: .whitespaces)),
                      nextOrdered == isOrdered {
                    items.append(next)
                    cursor += 1
                }
                elements.append(MarkdownElement(id: elements.count, block: isOrdered ? .ordered(items: items) : .bullet(items: items)))
                index = cursor
                continue
            }

            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return elements
    }

    private static func fenceMarker(_ line: String) -> String? {
        for marker in ["```", "~~~"] where line.hasPrefix(marker) {
            return line
        }
        return nil
    }

    private static func listItem(_ line: String) -> (String, Bool)? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            return (String(line.dropFirst(marker.count)), false)
        }
        let digits = line.prefix(while: { $0.isNumber })
        if !digits.isEmpty {
            let remainder = line.dropFirst(digits.count)
            if remainder.hasPrefix(". ") {
                return (String(remainder.dropFirst(2)), true)
            }
        }
        return nil
    }

    private static func parseTable(_ lines: [String], at start: Int) -> (headers: [String], rows: [[String]], next: Int)? {
        guard start + 1 < lines.count else { return nil }
        let header = lines[start].trimmingCharacters(in: .whitespaces)
        let divider = lines[start + 1].trimmingCharacters(in: .whitespaces)
        guard header.contains("|"), divider.contains("|") else { return nil }
        // A bordered row splits into an empty leading and trailing cell, so the
        // pipes have to come off before the alignment row is inspected.
        let alignment = splitRow(divider)
        guard alignment.count >= 2, alignment.allSatisfy({ cell in
            !cell.isEmpty && cell.allSatisfy { $0 == "-" || $0 == ":" }
        }) else { return nil }

        let headers = splitRow(header)
        guard headers.count >= 2 else { return nil }

        var rows: [[String]] = []
        var cursor = start + 2
        while cursor < lines.count {
            let line = lines[cursor].trimmingCharacters(in: .whitespaces)
            guard line.contains("|") else { break }
            rows.append(splitRow(line))
            cursor += 1
        }
        return (headers, rows, cursor)
    }

    private static func splitRow(_ line: String) -> [String] {
        var body = line
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }
}

/// Inline runs: code spans, emphasis, and links with a controlled protocol.
/// Anything that is not a link with an `http` or `https` URL stays plain text,
/// and a link whose protocol is refused keeps its URL visible so no target is
/// hidden from a screen reader.
enum MarkdownInline {
    private static let pattern = try? NSRegularExpression(
        pattern: "(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*]+\\*)|(_[^_]+_)|(\\[[^\\]]+\\]\\([^)\\s]+\\))"
    )

    static func attributed(_ source: String, body: Font = VoidFont.messageBody, code: Font = VoidFont.code, accent: Color = VoidColor.accent) -> AttributedString {
        var result = AttributedString()
        guard let pattern else {
            result.append(plain(source, font: body))
            return result
        }

        let ns = source as NSString
        let matches = pattern.matches(in: source, range: NSRange(location: 0, length: ns.length))
        var cursor = 0

        for match in matches {
            if match.range.location > cursor {
                result.append(plain(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), font: body))
            }
            let token = ns.substring(with: match.range)
            result.append(styled(token, body: body, code: code, accent: accent))
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            result.append(plain(ns.substring(from: cursor), font: body))
        }
        return result
    }

    private static func plain(_ text: String, font: Font) -> AttributedString {
        var value = AttributedString(text)
        value.font = font
        return value
    }

    private static func styled(_ token: String, body: Font, code: Font, accent: Color) -> AttributedString {
        if token.hasPrefix("`"), token.hasSuffix("`"), token.count >= 2 {
            var value = AttributedString(String(token.dropFirst().dropLast()))
            value.font = code
            value.foregroundColor = VoidColor.text
            value.backgroundColor = VoidColor.raised
            return value
        }
        if token.hasPrefix("**"), token.hasSuffix("**"), token.count >= 4 {
            var value = AttributedString(String(token.dropFirst(2).dropLast(2)))
            value.font = body
            value.foregroundColor = VoidColor.text
            value.inlinePresentationIntent = .stronglyEmphasized
            return value
        }
        if (token.hasPrefix("*") && token.hasSuffix("*")) || (token.hasPrefix("_") && token.hasSuffix("_")),
           token.count >= 2 {
            var value = AttributedString(String(token.dropFirst().dropLast()))
            value.font = body
            value.foregroundColor = VoidColor.text
            value.inlinePresentationIntent = .emphasized
            return value
        }
        if token.hasPrefix("["), let separator = token.firstIndex(of: "]"), token.hasSuffix(")") {
            let label = String(token[token.index(token.startIndex, offsetBy: 1) ..< separator])
            let urlText = String(token[token.index(after: separator) ..< token.index(token.endIndex, offsetBy: -1)])
            if let url = URL(string: urlText), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                var value = AttributedString(label)
                value.font = body
                value.foregroundColor = accent
                value.link = url
                value.underlineStyle = .single
                return value
            }
            // Refused protocol. Show the destination instead of hiding it.
            var value = AttributedString("\(label) (\(urlText))")
            value.font = body
            value.foregroundColor = VoidColor.text
            return value
        }
        return plain(token, font: body)
    }
}

/// Renders a parsed document. Code blocks and wide tables scroll horizontally
/// inside their own container so the transcript itself never overflows.
struct MarkdownText: View {
    let source: String
    @State private var elements: [MarkdownElement]
    @State private var wrapsCode = false

    /// The document is parsed during initialisation, not in `onAppear`.
    /// `onAppear` only fires once a view is on screen, so parsing there left
    /// every message below the fold rendered as an empty view until the reader
    /// scrolled to it.
    init(source: String) {
        self.source = source
        _elements = State(initialValue: MarkdownParser.parse(source))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VoidMetrics.space3) {
            ForEach(elements) { element in
                block(element.block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: source) {
            elements = MarkdownParser.parse(source)
        }
    }

    @ViewBuilder
    private func block(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let inline):
            Text(MarkdownInline.attributed(inline, body: headingFont(level)))
                .font(headingFont(level))
                .foregroundStyle(VoidColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let inline):
            Text(MarkdownInline.attributed(inline))
                .fixedSize(horizontal: false, vertical: true)
        case .bullet(let items):
            VStack(alignment: .leading, spacing: VoidMetrics.space1) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    MarkdownText.Row(text: MarkdownInline.attributed(item), bullet: "•")
                }
            }
        case .ordered(let items):
            VStack(alignment: .leading, spacing: VoidMetrics.space1) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    MarkdownText.Row(text: MarkdownInline.attributed(item), bullet: "\(index + 1).")
                }
            }
        case .code(let language, let code):
            CodeBlock(language: language, source: code, wraps: $wrapsCode)
        case .table(let headers, let rows):
            MarkdownTable(headers: headers, rows: rows)
        case .quote(let lines):
            VStack(alignment: .leading, spacing: VoidMetrics.space1) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(MarkdownInline.attributed(line))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, VoidMetrics.space3)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(VoidColor.accent)
                    .frame(width: 2)
            }
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title3.weight(.semibold)
        case 2: .headline
        case 3: .subheadline.weight(.semibold)
        default: .subheadline
        }
    }
}

extension MarkdownText {
    struct Row: View {
        let text: AttributedString
        let bullet: String

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: VoidMetrics.space2) {
                Text(bullet)
                    .font(VoidFont.messageBody)
                    .foregroundStyle(VoidColor.mutedText)
                    .accessibilityHidden(true)
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A code block with the language, a wrap toggle, copy, and share. It stays
/// monospaced at a semantic size, so it grows with Dynamic Type instead of
/// shrinking to fit.
struct CodeBlock: View {
    let language: String?
    let source: String
    @Binding var wraps: Bool

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: VoidMetrics.space2) {
            HStack(spacing: VoidMetrics.space2) {
                Text(language ?? "text")
                    .font(VoidFont.metadata)
                    .foregroundStyle(VoidColor.mutedText)
                Spacer(minLength: VoidMetrics.space2)
                Button {
                    UIPasteboard.general.string = source
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .labelStyle(.titleAndIcon)
                        .font(VoidFont.metadata)
                        .frame(minHeight: VoidMetrics.minTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(VoidColor.accent)
                .accessibilityLabel(copied ? "Code copied to the clipboard" : "Copy code to the clipboard")

                ShareLink(item: source) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .labelStyle(.titleAndIcon)
                        .font(VoidFont.metadata)
                        .frame(minHeight: VoidMetrics.minTouchTarget)
                }
                .accessibilityLabel("Share this code block")

                Button {
                    wraps.toggle()
                } label: {
                    Label(wraps ? "No wrap" : "Wrap", systemImage: wraps ? "arrow.left.and.right" : "text.alignleft")
                        .labelStyle(.titleAndIcon)
                        .font(VoidFont.metadata)
                        .frame(minHeight: VoidMetrics.minTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(VoidColor.accent)
                .accessibilityLabel(wraps ? "Turn off line wrapping for this code block" : "Turn on line wrapping for this code block")
            }
            .labelStyle(.titleAndIcon)
            .font(VoidFont.metadata)

            if wraps {
                Text(source)
                    .font(VoidFont.code)
                    .foregroundStyle(VoidColor.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView(.horizontal) {
                    Text(source)
                        .font(VoidFont.code)
                        .foregroundStyle(VoidColor.text)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .accessibilityLabel("Code block, \(language ?? "plain text")")
                .accessibilityValue(source)
            }
        }
        .padding(VoidMetrics.space3)
        .background(VoidColor.surface, in: RoundedRectangle(cornerRadius: VoidMetrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: VoidMetrics.corner)
                .strokeBorder(VoidColor.line, lineWidth: 1)
        )
    }
}

/// A table that scrolls horizontally when it does not fit, and reads as one
/// narrated element to a screen reader so column position is never the only
/// way to tell the cells apart.
struct MarkdownTable: View {
    let headers: [String]
    let rows: [[String]]

    private let columnWidth: CGFloat = 132

    var body: some View {
        // The narration is attached to a plain container rather than to the
        // horizontal scroll view: a scroll view passes its identifier to its
        // content, which makes the table unaddressable as one element.
        ScrollViewContainer {
            header
            Divider()
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                MarkdownTableRow(headers: headers, cells: row)
                if index < rows.count - 1 { Divider() }
            }
        }
        .padding(VoidMetrics.space3)
        .background(VoidColor.surface, in: RoundedRectangle(cornerRadius: VoidMetrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: VoidMetrics.corner)
                .strokeBorder(VoidColor.line, lineWidth: 1)
        )
        // `.combine` is the pattern that reliably produces one addressable
        // element; `.ignore` on a scroll-backed container produced none, so the
        // table was invisible to both VoiceOver targeting and any UI test.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(narration)
        .accessibilityIdentifier("chat.markdown.table")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: VoidMetrics.space3) {
            ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                Text(header)
                    .font(VoidFont.metadataEmphasised)
                    .frame(width: columnWidth, alignment: .leading)
            }
        }
        .padding(.vertical, VoidMetrics.space2)
    }

    private var narration: Text {
        var parts: [String] = ["Table with \(headers.count) columns and \(rows.count) rows. Columns: \(headers.joined(separator: ", "))."]
        for (index, row) in rows.enumerated() {
            let cells = zip(headers, row).map { "\($0): \($1)" }
            parts.append("Row \(index + 1). \(cells.joined(separator: ", ")).")
        }
        return Text(parts.joined(separator: " "))
    }
}

/// One table row. Split out so the type checker does not have to reason about
/// a nested `ForEach` inside a `ForEach` inside a background modifier.
private struct MarkdownTableRow: View {
    let headers: [String]
    let cells: [String]
    private let columnWidth: CGFloat = 132

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: VoidMetrics.space3) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(MarkdownInline.attributed(cell, body: VoidFont.metadata))
                    .frame(width: columnWidth, alignment: .leading)
            }
        }
        .padding(.vertical, VoidMetrics.space2)
    }
}


/// The horizontally scrollable part of a table. Kept separate from the
/// narration container so the accessibility element is not a scroll view.
private struct ScrollViewContainer<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) { content() }
        }
    }
}
