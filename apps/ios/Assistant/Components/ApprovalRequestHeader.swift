import SwiftUI

/// The presentation-only heading and identifier for one pending approval.
/// Kept independent of AppModel so the consequential label can be reviewed
/// with synthetic data without bootstrapping services.
struct ApprovalRequestHeader: View {
    let toolName: String
    let shortCode: String
    let isApplying: Bool
    let usesAccessibilityLayout: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let glyph = AssistantGlyph(systemName: "checkmark.shield.fill", tint: AssistantTheme.warning(for: colorScheme))
        let approvalTitle = Text("Approval needed")
            .font(CardStyle.eyebrow)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
        let toolNameLabel = Text(toolName)
            .font(.caption)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.74))
        let tool = HStack(spacing: 10) {
            glyph
            VStack(alignment: .leading, spacing: 3) {
                approvalTitle
                toolNameLabel
            }
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    glyph
                    approvalTitle
                }
                toolNameLabel
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Spacer(minLength: 0)
                    approvalCode
                }
            }
        } else {
            HStack {
                tool
                Spacer()
                approvalCode
            }
        }
    }

    private var approvalCode: some View {
        // Keep the same fixed-height slot while a decision is being applied.
        ZStack {
            if isApplying {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Applying decision")
            } else {
                Text(shortCode)
                    .font(.caption.monospaced().weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .background(
                        AssistantTheme.warning(for: colorScheme).opacity(0.12),
                        in: Capsule()
                    )
            }
        }
        .frame(minHeight: 28)
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: isApplying
        )
    }
}
