import SwiftUI
import UIKit

/// Semantic colour tokens for the chat surface.
///
/// The app already had one visual language before the chat existed: neutral
/// system surfaces, the system type ramp, and a single orange action accent.
/// These tokens name that language, so the chat cannot quietly introduce
/// literals of its own. A tone only tints a background and a border; the
/// state itself is always carried by a text label, so no state in the chat is
/// ever carried by colour alone.
enum NomoColor {
    static let canvas = Color(uiColor: .systemBackground)
    static let surface = Color(uiColor: .secondarySystemBackground)
    static let raised = Color(uiColor: .tertiarySystemBackground)
    static let line = Color(uiColor: .separator)
    static let text = Color(uiColor: .label)

    /// Muted text still has to clear AA, so it is not the system's
    /// 60%-alpha secondary label, which lands around 3.5:1 on the canvas.
    /// These two values measure 5.9:1 and 6.6:1 on the surfaces they are used
    /// on, and the UI test re-measures the rendered pixels.
    static let mutedText = dynamic(light: 0x5C5C66, dark: 0xA0A0AC)

    /// The action accent from the design contract's token table. It is darker
    /// than the system orange it replaces so the accent can carry a text label
    /// and still clear AA: 5.3:1 on the light canvas, 6.8:1 on the dark one.
    static let accent = dynamic(light: 0xBD4206, dark: 0xE8702C)

    /// The foreground on a filled action. It has to flip with the accent: white
    /// on the light accent measures 5.3:1, and the dark accent needs a dark
    /// foreground to reach 6.8:1 instead of the 3.1:1 white would give.
    static let onAccent = dynamic(light: 0xFFFFFF, dark: 0x000000)

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(nomoRGB: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

/// Non-text state colour. Used for pill fills, pill borders, and notice
/// accents only. Every one of these is accompanied by a text label, so a
/// tone is never the sole carrier of meaning.
enum NomoTone {
    case neutral
    case action
    case success
    case warning
    case danger
    case unknown

    var color: Color {
        switch self {
        case .neutral: NomoColor.dynamic(light: 0x5C5C66, dark: 0xA0A0AC)
        case .action: NomoColor.accent
        case .success: NomoColor.dynamic(light: 0x1B6B2F, dark: 0x5BD07A)
        case .warning: NomoColor.dynamic(light: 0x8A5A00, dark: 0xF2B45C)
        case .danger: NomoColor.dynamic(light: 0xA32020, dark: 0xFF7B72)
        case .unknown: NomoColor.dynamic(light: 0x5C5C66, dark: 0xA0A0AC)
        }
    }
}

enum NomoMetrics {
    /// The 4/8/12/16/24/32 spacing rhythm from the design contract.
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let space6: CGFloat = 24
    static let corner: CGFloat = 8
    /// Mobile controls never shrink below this.
    static let minTouchTarget: CGFloat = 44
    /// The transcript keeps a readable measure instead of running edge to
    /// edge on a wide window.
    static let readableColumn: CGFloat = 760
    /// Interaction feedback only. Never used to imply that state changed.
    static let motionDuration: Double = 0.15
}

/// Font roles. Every one is a semantic font, so Dynamic Type scales the whole
/// surface and nothing here is a hard-coded point size.
enum NomoFont {
    static let messageBody = Font.body
    static let uiLabelEmphasised = Font.subheadline.weight(.semibold)
    static let metadata = Font.footnote
    static let metadataEmphasised = Font.footnote.weight(.semibold)
    static let code = Font.system(.footnote, design: .monospaced)
}

/// A short, always-textual state marker. The tone tints the pill; the label
/// carries the state.
struct NomoStatePill: View {
    let label: String
    let tone: NomoTone
    var symbol: String?

    var body: some View {
        HStack(spacing: NomoMetrics.space1) {
            if let symbol {
                Image(systemName: symbol).accessibilityHidden(true)
            }
            Text(label)
        }

        .font(NomoFont.metadataEmphasised)
        .foregroundStyle(NomoColor.text)
        .padding(.horizontal, NomoMetrics.space2)
        .padding(.vertical, 6)
        .background(tone.color.opacity(0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(tone.color.opacity(0.55), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// A titled notice for the bounded region above the composer.
///
/// The title and the body are deliberately left as two separate accessible
/// children: they are two different sentences, and a screen reader should
/// not run them together into one ambiguous statement. Views that need a
/// single combined element compose the notice into one phrase themselves.
struct NomoNotice: View {
    enum Kind {
        case info
        case blocked
        case warning
        case sample

        var tone: NomoTone {
            switch self {
            case .info: .action
            case .blocked: .warning
            case .warning: .danger
            case .sample: .unknown
            }
        }

        var symbol: String {
            switch self {
            case .info: "info.circle"
            case .blocked: "lock"
            case .warning: "exclamationmark.triangle"
            case .sample: "testtube.2"
            }
        }
    }

    let kind: Kind
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: NomoMetrics.space2) {
            Image(systemName: kind.symbol)
                .foregroundStyle(kind.tone.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: NomoMetrics.space1) {
                Text(title)
                    .font(NomoFont.uiLabelEmphasised)
                    .foregroundStyle(NomoColor.text)
                if let detail {
                    Text(detail)
                        .font(NomoFont.metadata)
                        .foregroundStyle(NomoColor.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(NomoMetrics.space3)
        .background(kind.tone.color.opacity(0.10), in: RoundedRectangle(cornerRadius: NomoMetrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: NomoMetrics.corner)
                .strokeBorder(kind.tone.color.opacity(0.45), lineWidth: 1)
        )
    }
}

extension UIColor {
    fileprivate convenience init(nomoRGB value: UInt32) {
        self.init(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// The chat's single action control.
///
/// The stock prominent style derives its foreground from the tint, which for a
/// bright orange in a dark appearance leaves the symbol near 3:1. This style
/// names the foreground instead, so the action clears AA in both appearances
/// and the disabled state stays readable instead of disappearing.
struct NomoPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title3)
            .foregroundStyle(isEnabled ? NomoColor.onAccent : NomoColor.mutedText)
            .frame(width: NomoMetrics.minTouchTarget, height: NomoMetrics.minTouchTarget)
            .background(
                RoundedRectangle(cornerRadius: NomoMetrics.corner)
                    .fill(isEnabled ? NomoColor.accent : NomoColor.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: NomoMetrics.corner)
                    .strokeBorder(isEnabled ? NomoColor.accent.opacity(0.55) : NomoColor.line, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

