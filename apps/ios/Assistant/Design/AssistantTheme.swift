import SwiftUI

/// The app's appearance override. The app used to follow the iPhone's
/// appearance silently, so a scheduled system change flipped the
/// conversation between light and dark with no visible cause.
enum AssistantAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    static let defaultsKey = "assistant.appearance"

    var id: Self { self }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum AssistantTheme {
    /// Semantic geometry keeps the conversation's signature silhouette while
    /// letting utility cards and nested panels recede behind it.
    static let heroCornerRadius: CGFloat = 27
    static let conversationCornerRadius: CGFloat = Self.heroCornerRadius
    static let cardCornerRadius: CGFloat = 22
    static let panelCornerRadius: CGFloat = 18
    static let controlCornerRadius: CGFloat = 12
    /// Chat bubbles remain part of the conversation surface, rather than a
    /// utility list item.
    static let chatCardCornerRadius: CGFloat = Self.heroCornerRadius
    static let responseCardMinHeight: CGFloat = 56
    static let compactGutter: CGFloat = 16
    static let cardStackSpacing: CGFloat = 12
    static let cardContentSpacing: CGFloat = 12
    static let actionSpacing: CGFloat = 8
    static let canvas = Color(hex: 0xEEF5F0)
    static let canvasDark = Color(hex: 0x101712)
    static let raised = Color.white
    static let raisedDark = Color(hex: 0x1B2820)
    // The chat dashboard is intentionally a little warmer and lighter than
    // the utility cards used elsewhere. On the dark-green stage these read as
    // sheets of paper with room to scan, echoing the menu sheet without
    // turning every dashboard section into a floating tile.
    static let dashboardPaper = Color(hex: 0xFAFBF9)
    static let dashboardPaperDark = Color(hex: 0x23342A)
    static let sunken = Color(hex: 0xE3EDE6)
    static let sunkenDark = Color(hex: 0x152019)
    static let ink = Color(hex: 0x15201A)
    static let inkDark = Color(hex: 0xEDF6F0)
    // Shared secondary ink clears small-text contrast on opaque sunken panels:
    // #5A6D62 on #E3EDE6 is 4.61:1; the former shade reached only 4.30:1.
    static let inkMuted = Color(hex: 0x5A6D62)
    static let inkMutedDark = Color(hex: 0xA9BAAF)
    static let accent = Color(hex: 0x217A4B)
    static let accentLight = Color(hex: 0x6FCB9C)
    // Foreground semantic colors clear small-text contrast on the light card
    // surfaces; their brighter companions are reserved for dark appearance.
    static let success = Color(hex: 0x147A49)
    static let successDark = Color(hex: 0x6EE7B7)
    static let stage = Color(hex: 0x2B8253)
    static let stageDark = Color(hex: 0x1B3626)
    static let stageStrong = Color(hex: 0xF4FAF5)
    // Small conversation text needs a stable pair, including under the stage's
    // bright washes and glass. Secondary #C6DDCF on #1E613E is 5.17:1.
    static let stageWell = Color(hex: 0x1E613E)
    static let stageWellDark = Color(hex: 0x193424)
    static let stageSecondary = Color(hex: 0xC6DDCF)
    static let bubblePaper = Color(hex: 0xF5FAF6)
    // A paper surface needs to read as a distinct object on the dark green
    // stage. The old value was nearly iso-luminant with `stageDark`, so reply
    // bubbles disappeared even though their outlines remained visible.
    static let bubblePaperDark = Color(hex: 0x293D31)
    static let bubblePaperInk = Color(hex: 0x15201A)
    static let bubblePaperInkDark = Color(hex: 0xEDF6F0)
    static let companionHousing = Color(hex: 0x131D17)
    static let warning = Color(hex: 0x9D5A0A)
    static let warningDark = Color(hex: 0xF0B45A)
    static let warningSurface = Color(hex: 0xFFF7E7)
    static let warningSurfaceDark = Color(hex: 0x362A18)
    static let warningInk = Color(hex: 0x5C3A0E)
    static let warningInkDark = Color(hex: 0xFFE1A8)
    // Count pills signal work that needs attention, not a decorative tag.
    // This stays one alert red in both appearances for instant recognition.
    static let notificationBadge = Color(hex: 0xC9362C)
    static let errorSurface = Color(hex: 0xFFF0EE)
    static let errorSurfaceDark = Color(hex: 0x3A211F)
    static let errorInk = Color(hex: 0x7A201B)
    static let errorInkDark = Color(hex: 0xFFD7D2)
    static let stageDepth = Color(hex: 0x0C2D1B)
    /// Warning pair for surfaces that sit on the conversation stage rather
    /// than the canvas. The stage is dark in both color schemes, so this pair
    /// deliberately does not vary — unlike `warningSurface(for:)`.
    static let stageWarningSurface = Color(hex: 0xFFE9B7)
    static let stageWarningInk = Color(hex: 0x5C3A0E)

    static func canvas(for scheme: ColorScheme) -> Color {
        scheme == .dark ? canvasDark : canvas
    }

    static func raised(for scheme: ColorScheme) -> Color {
        scheme == .dark ? raisedDark : raised
    }

    static func dashboardPaper(for scheme: ColorScheme) -> Color {
        scheme == .dark ? dashboardPaperDark : dashboardPaper
    }

    static func sunken(for scheme: ColorScheme) -> Color {
        scheme == .dark ? sunkenDark : sunken
    }

    static func ink(for scheme: ColorScheme) -> Color {
        scheme == .dark ? inkDark : ink
    }

    static func inkMuted(for scheme: ColorScheme) -> Color {
        scheme == .dark ? inkMutedDark : inkMuted
    }

    static func accent(for scheme: ColorScheme) -> Color {
        scheme == .dark ? accentLight : accent
    }

    static func success(for scheme: ColorScheme) -> Color {
        scheme == .dark ? successDark : success
    }

    static func warning(for scheme: ColorScheme) -> Color {
        scheme == .dark ? warningDark : warning
    }

    static func bubblePaper(for scheme: ColorScheme) -> Color {
        scheme == .dark ? bubblePaperDark : bubblePaper
    }

    static func bubblePaperInk(for scheme: ColorScheme) -> Color {
        scheme == .dark ? bubblePaperInkDark : bubblePaperInk
    }

    static func warningSurface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? warningSurfaceDark : warningSurface
    }

    static func warningInk(for scheme: ColorScheme) -> Color {
        scheme == .dark ? warningInkDark : warningInk
    }

    static func errorSurface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? errorSurfaceDark : errorSurface
    }

    static func errorInk(for scheme: ColorScheme) -> Color {
        scheme == .dark ? errorInkDark : errorInk
    }

    static func stage(for scheme: ColorScheme) -> Color {
        scheme == .dark ? stageDark : stage
    }

    static func stageWell(for scheme: ColorScheme) -> Color {
        scheme == .dark ? stageWellDark : stageWell
    }

    /// The chat's accent, tinted by the companion's color mood.
    ///
    /// A `[theme:]` cue re-tints the accent and leaves the stage alone, which is
    /// what the web client has always done (`globals.css`, "Companion chat
    /// themes"). The stage used to carry the mood here instead, so one cue
    /// repainted the whole conversation background — a swing with no visible
    /// cause, since the cue tag never reaches the reader.
    ///
    /// Deliberately does not vary by color scheme: the stage is dark in both, so
    /// one light tint reads on either — the same reasoning as
    /// `stageWarningSurface`. The three mood tints are the web values verbatim;
    /// the resting tint stays this app's own `0xB9ECCF` rather than web's
    /// `#9fe7c0`, so the default look is unchanged.
    static func chatAccent(mood: CompanionMood = .default) -> Color {
        switch mood {
        case .warmAmber: Color(hex: 0xFCD390)
        case .softRose: Color(hex: 0xF7BCD2)
        case .coolSky: Color(hex: 0xA5DAF6)
        case .default: Color(hex: 0xB9ECCF)
        }
    }
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

extension View {
    /// Shared shell for pages revealed from the pull-up directory. Keeping the
    /// canvas, navigation treatment, tint, and scrolling behavior here prevents
    /// submenu pages from slowly becoming a collection of unrelated mini-apps.
    func assistantSubmenuChrome() -> some View {
        modifier(AssistantSubmenuChrome())
    }

    /// The normal content-card spec: 16pt padding, 22pt radius, deliberate
    /// minimum optical height, and a hairline stroke. Warning cards (memory
    /// review, approvals) pass a surface and stroke tint so they keep the same
    /// geometry instead of hand-rolling a near-copy.
    func assistantCard(
        in scheme: ColorScheme,
        surface: Color? = nil,
        strokeTint: Color? = nil
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)

        return self
            .padding(.horizontal, AssistantTheme.compactGutter)
            .padding(.vertical, 16)
            .frame(minHeight: AssistantTheme.responseCardMinHeight)
            .background(surface ?? AssistantTheme.raised(for: scheme), in: shape)
            .overlay {
                shape
                    .stroke(
                        strokeTint?.opacity(0.28) ?? Color.primary.opacity(scheme == .dark ? 0.16 : 0.07),
                        lineWidth: 1
                    )
            }
    }

    /// The recessed companion to `assistantCard`, for summary and info
    /// panels. A recessed panel is intentionally quieter and tighter than a
    /// content card so nested summaries do not compete with the page's main
    /// action.
    func assistantPanel(in scheme: ColorScheme) -> some View {
        self
            .padding(14)
            .background(
                AssistantTheme.sunken(for: scheme).opacity(0.72),
                in: RoundedRectangle(cornerRadius: AssistantTheme.panelCornerRadius, style: .continuous)
            )
    }
}

/// Wraps compact controls instead of forcing them into a clipped horizontal row.
struct AssistantFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = measuredSizes(subviews, width: proposal.width)
        let metrics = Self.metrics(
            sizes: sizes,
            availableWidth: proposal.width ?? .greatestFiniteMagnitude,
            spacing: spacing
        )
        return CGSize(width: proposal.width ?? metrics.size.width, height: metrics.size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = measuredSizes(subviews, width: bounds.width)
        let metrics = Self.metrics(sizes: sizes, availableWidth: bounds.width, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            let origin = metrics.origins[index]
            subview.place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                anchor: .topLeading,
                proposal: ProposedViewSize(sizes[index])
            )
        }
    }

    private func measuredSizes(_ subviews: Subviews, width: CGFloat?) -> [CGSize] {
        subviews.map { subview in
            let ideal = subview.sizeThatFits(.unspecified)
            guard let width, ideal.width > width else { return ideal }
            return subview.sizeThatFits(ProposedViewSize(width: max(0, width), height: nil))
        }
    }

    struct Metrics {
        let size: CGSize
        let origins: [CGPoint]
    }

    static func metrics(sizes: [CGSize], availableWidth: CGFloat, spacing: CGFloat) -> Metrics {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var contentWidth: CGFloat = 0

        for size in sizes {
            let proposedX = x == 0 ? 0 : x + spacing
            if x > 0, proposedX + size.width > availableWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            } else {
                x = proposedX
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width
            rowHeight = max(rowHeight, size.height)
            contentWidth = max(contentWidth, x)
        }
        return Metrics(size: CGSize(width: contentWidth, height: y + rowHeight), origins: origins)
    }
}

private struct AssistantSubmenuChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
            .scrollBounceBehavior(.basedOnSize)
            .scrollClipDisabled()
            .scrollEdgeEffectStyle(.soft, for: .top)
            .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
            .tint(AssistantTheme.accent(for: colorScheme))
            // A stable title does not disappear between large/inline states.
            // Native glass controls float above the softly receding content.
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbarBackground(.hidden, for: .navigationBar)
    }
}

/// Native field behavior, with the same paper/canvas pair as the rest of the
/// workspace. Apply row styling inside the builder so it reaches each Section.
struct AssistantForm<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @ViewBuilder let content: Content

    var body: some View {
        Form { content.listRowBackground(AssistantTheme.raised(for: colorScheme)) }
            .headerProminence(.increased)
            .environment(\.defaultMinListRowHeight, 44)
            .listSectionSpacing(20)
            .assistantEditorChrome()
    }
}

/// Keep a field's purpose visible after its placeholder becomes a value.
/// The native input supplies the accessibility label; the visual heading avoids
/// a duplicate VoiceOver stop and never changes focus or selection behaviour.
struct AssistantField<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .accessibilityHidden(true)
            content.accessibilityLabel(title)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct AssistantSettingsList<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @ViewBuilder let content: Content

    var body: some View {
        List { content.listRowBackground(AssistantTheme.raised(for: colorScheme)) }
            .listStyle(.insetGrouped)
            .headerProminence(.increased)
            .environment(\.defaultMinListRowHeight, 44)
            .listSectionSpacing(20)
            .labelStyle(AssistantSettingsLabelStyle())
            .assistantEditorChrome()
    }
}

extension View {
    func assistantEditorChrome() -> some View { modifier(AssistantEditorChrome()) }
}

private struct AssistantEditorChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content
            .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
            .scrollContentBackground(.hidden)
            .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
            .tint(AssistantTheme.accent(for: colorScheme))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(AssistantTheme.canvas(for: colorScheme), for: .navigationBar)
    }
}

/// Keeps utility-list symbols on one optical column. SwiftUI's default Label
/// width varies with each SF Symbol, which makes settings rows look ragged;
/// a quiet fixed icon lane gives the text a consistent start without changing
/// the list's native typography, tint, or control behavior.
private struct AssistantSettingsLabelStyle: LabelStyle {
    @ScaledMetric(relativeTo: .body) private var iconColumnWidth: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var iconTextSpacing: CGFloat = 12

    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: iconTextSpacing) {
            configuration.icon
                .font(.body.weight(.regular))
                .frame(width: iconColumnWidth, alignment: .center)
                .accessibilityHidden(true)
            configuration.title
        }
        .contentShape(Rectangle())
    }
}

enum AssistantMotion {
    static func response(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0)
    }
}

/// A single moving selection surface, rather than a separate pill animation
/// on every option. List contents are deliberately outside this animation.
struct AssistantFilterPicker<Option: Hashable & Identifiable>: View {
    let title: String
    let options: [Option]
    @Binding var selection: Option
    let label: (Option) -> String
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionSpace

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Picker(title, selection: $selection) {
                ForEach(options) { Text(label($0)).tag($0) }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .assistantPanel(in: colorScheme)
        } else {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(options) { option in
                            Button { selection = option } label: {
                                Text(label(option))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(selection == option
                                        ? AssistantTheme.canvas(for: colorScheme)
                                        : AssistantTheme.inkMuted(for: colorScheme))
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 44)
                                    .background {
                                        if selection == option {
                                            RoundedRectangle(cornerRadius: AssistantTheme.controlCornerRadius)
                                                .fill(AssistantTheme.accent(for: colorScheme))
                                                .matchedGeometryEffect(id: "selection", in: selectionSpace)
                                        }
                                    }
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(title): \(label(option))")
                            .accessibilityAddTraits(selection == option ? .isSelected : [])
                            .id(option.id)
                        }
                    }.padding(4)
                    .animation(AssistantMotion.response(reduceMotion: reduceMotion), value: selection)
                }
                .background(AssistantTheme.sunken(for: colorScheme),
                    in: RoundedRectangle(cornerRadius: 16))
                .onChange(of: selection) { _, selected in
                    withAnimation(AssistantMotion.response(reduceMotion: reduceMotion)) {
                        proxy.scrollTo(selected.id, anchor: .center)
                    }
                }
            }
        }
    }
}

/// Subpage evidence expands in place with a coordinated chevron. The chat
/// transcript retains its own non-animated disclosure/scroll arbitration.
struct AssistantEvidenceDisclosureStyle: DisclosureGroupStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(AssistantMotion.response(reduceMotion: reduceMotion)) {
                    configuration.isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    configuration.label
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded {
                configuration.content.padding(.top, 8)
                    .transition(.opacity)
            }
        }
    }
}

/// A failed read is a recoverable state, never an endless loading indicator or
/// an empty result. The last good content can remain below this quiet panel.
struct AssistantLoadFailureState: View {
    let title: String
    let message: String
    let retry: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            Label(title, systemImage: "exclamationmark.circle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            Text(message)
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again", systemImage: "arrow.clockwise", action: retry)
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantPanel(in: colorScheme)
        .accessibilityElement(children: .contain)
    }
}

struct AssistantLoadingState: View {
    let title: String
    var body: some View {
        ProgressView(title)
            .font(.subheadline)
            .frame(maxWidth: .infinity, minHeight: 190)
    }
}

/// A recoverable form action keeps its fields and explains the failure inside
/// the presented editor, where a root-level error banner may be covered.
struct AssistantInlineFailure: View {
    let message: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.subheadline)
            .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }
}

/// Real proportions only: these bars compare quantities, not invented task
/// progress. Non-finite/negative values never enter layout geometry.
enum AssistantChartScale {
    static func shares(_ values: [Double]) -> [Double] {
        let valid = values.map { $0.isFinite ? max(0, $0) : 0 }
        guard let maximum = valid.max(), maximum > 0 else { return valid.map { _ in 0 } }
        let scaled = valid.map { $0 / maximum }
        let total = scaled.reduce(0, +)
        return scaled.map { $0 / total }
    }
}

struct ActivityVisualSummary {
    static let labels = ["need you", "working", "scheduled", "done", "stopped", "other"]
    let counts: [Int]

    init(statuses: [String]) {
        var counts = Array(repeating: 0, count: Self.labels.count)
        for status in statuses {
            let index: Int = switch status {
            case "waiting_approval", "waiting_budget", "needs_attention": 0
            case "pending", "running": 1
            case "sleeping", "waiting_event": 2
            case "done": 3
            case "failed", "cancelled": 4
            default: 5
            }
            counts[index] += 1
        }
        self.counts = counts
    }
}

struct AssistantDistributionBar: View {
    let values: [Double]
    let colors: [Color]

    var body: some View {
        GeometryReader { geometry in
            let shares = AssistantChartScale.shares(values)
            HStack(spacing: 0) {
                ForEach(Array(shares.enumerated()), id: \.offset) { index, share in
                    if share > 0 {
                        Rectangle().fill(index < colors.count ? colors[index] : .secondary)
                            .frame(width: geometry.size.width * share)
                    }
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

struct AssistantDirectionView: View {
    let progress: String
    let nextAction: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !progress.isEmpty {
                row("Latest", text: progress, symbol: "text.alignleft", next: false)
                    .background(alignment: .topLeading) {
                        if !nextAction.isEmpty {
                            GeometryReader { geometry in
                                // Join the two 24pt glyph centers, even when text wraps.
                                Rectangle().fill(AssistantTheme.accent(for: colorScheme).opacity(0.16))
                                    .frame(width: 1, height: geometry.size.height + 12)
                                    .offset(x: 12, y: 12)
                            }
                            .allowsHitTesting(false).accessibilityHidden(true)
                        }
                    }
            }
            if !nextAction.isEmpty { row("Next step", text: nextAction, symbol: "arrow.turn.down.right", next: true) }
        }
        .padding(.leading, 2)
    }

    private func row(_ title: String, text: String, symbol: String, next: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(next ? AssistantTheme.accent(for: colorScheme) : AssistantTheme.inkMuted(for: colorScheme))
                .frame(width: 24, height: 24)
                .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption.weight(.semibold))
                    .foregroundStyle(next ? AssistantTheme.accent(for: colorScheme) : AssistantTheme.inkMuted(for: colorScheme))
                Text((try? AttributedString(markdown: text,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The tinted rounded-square glyph at the head of cards. Exactly two sizes:
/// `.card` (40pt) for card headers, `.inline` (32pt) for compact callouts —
/// this motif previously existed in eight size/radius/font combinations.
struct AssistantGlyph: View {
    enum Variant {
        case card
        case inline
    }

    let systemName: String
    let tint: Color
    var variant: Variant = .card
    /// Document and chat rows sit the glyph on a neutral sunken tile rather
    /// than a tint wash.
    var sunkenBackground = false

    @Environment(\.colorScheme) private var colorScheme

    private var side: CGFloat { variant == .card ? 40 : 32 }

    var body: some View {
        Image(systemName: systemName)
            // The tile is fixed geometry; its adjacent semantic label scales
            // with Dynamic Type, not this decorative symbol inside the tile.
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: side, height: side)
            .background(
                sunkenBackground ? AssistantTheme.sunken(for: colorScheme) : tint.opacity(0.12),
                in: RoundedRectangle(cornerRadius: variant == .card ? 12 : 10, style: .continuous)
            )
    }
}

/// One empty-state treatment for every page: centered on the canvas at a
/// fixed minimum height. Pages previously picked their own top padding or
/// wrapped the state in a raised card, so "nothing here" looked different on
/// each screen.
struct AssistantEmptyState: View {
    let title: String
    let systemImage: String
    let description: String?

    init(_ title: String, systemImage: String, description: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.description = description
    }

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: systemImage,
            description: description.map { Text($0) }
        )
        .frame(maxWidth: .infinity, minHeight: 190)
    }
}

/// Quiet overflow affordance shared by cards and settings rows.
struct AssistantActionMenuLabel: View {
    var isUpdating = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if isUpdating {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
}

struct AssistantTactileButtonStyle: ButtonStyle {
    let reduceMotion: Bool
    var pressedScale: CGFloat = 0.98

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? pressedScale : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .brightness(configuration.isPressed ? -0.018 : 0)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.8),
                value: configuration.isPressed
            )
    }
}

enum AssistantActionButtonKind {
    case primary
    case secondary
    case neutral
    case destructive
}

/// The action language for assistant submenu pages. These controls use the
/// same recessed paper and rounded geometry as the cards they sit inside,
/// with compact padding by default and every target at least 44 points tall.
struct AssistantActionButtonStyle: ButtonStyle {
    let kind: AssistantActionButtonKind
    var compact = true
    var fillsWidth = false
    var confirming = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: compact ? AssistantTheme.controlCornerRadius : 14, style: .continuous)

        configuration.label
            .labelStyle(.titleAndIcon)
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, compact ? 12 : 20)
            .padding(.vertical, 10)
            .frame(minWidth: compact ? 44 : nil, maxWidth: fillsWidth ? .infinity : nil, minHeight: 44)
            .foregroundStyle(confirming ? Color.white : foregroundColor)
            .background(confirming ? AssistantTheme.notificationBadge : backgroundColor, in: shape)
            .overlay {
                shape.stroke(strokeColor, lineWidth: 1)
            }
            .contentShape(shape)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .brightness(configuration.isPressed ? -0.025 : 0)
            .opacity(isEnabled ? (configuration.isPressed ? 0.9 : 1) : 0.48)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.82),
                value: configuration.isPressed
            )
    }

    private var foregroundColor: Color {
        switch kind {
        case .primary:
            colorScheme == .dark ? AssistantTheme.stageDepth : .white
        case .neutral:
            AssistantTheme.ink(for: colorScheme)
        case .secondary:
            AssistantTheme.accent(for: colorScheme)
        case .destructive:
            AssistantTheme.errorInk(for: colorScheme)
        }
    }

    private var backgroundColor: Color {
        switch kind {
        case .primary:
            AssistantTheme.accent(for: colorScheme)
        case .secondary, .neutral:
            AssistantTheme.sunken(for: colorScheme)
        case .destructive:
            AssistantTheme.errorSurface(for: colorScheme)
        }
    }

    private var strokeColor: Color {
        switch kind {
        case .primary:
            Color.primary.opacity(colorScheme == .dark ? 0.16 : 0.08)
        case .neutral:
            AssistantTheme.inkMuted(for: colorScheme).opacity(0.2)
        case .secondary:
            AssistantTheme.accent(for: colorScheme).opacity(0.22)
        case .destructive:
            AssistantTheme.errorInk(for: colorScheme).opacity(0.22)
        }
    }
}


/// An expired confirmation can never execute, even if its reset task was suspended.
struct AssistantConfirmationState {
    static let lifetime: TimeInterval = 8
    private(set) var expiresAt: Date?

    mutating func tap(now: Date = .now) -> Bool {
        if let expiresAt, now < expiresAt {
            reset()
            return true
        }
        expiresAt = now.addingTimeInterval(Self.lifetime)
        return false
    }

    mutating func reset() { expiresAt = nil }
}

/// Keep confirmation at the original touch target. Every label the button can
/// show reserves the same space, so arming never moves this button or its
/// neighbours under the finger.
///
/// That reservation is why the confirmation word is short. Spelling the action
/// out again — "Confirm delete source" against a "Delete source" title — sized
/// every destructive button to a string it shows for at most eight seconds,
/// leaving the resting label adrift in a box half again too wide. The armed
/// state is already carried by the checkmark glyph and, for destructive
/// actions, a filled red surface; VoiceOver still hears the full phrase.
struct AssistantConfirmationButton: View {
    let title: String
    var confirmationTitle: String
    var systemImage: String = "trash"
    var kind: AssistantActionButtonKind = .destructive
    var hint: String = ""
    var compact = true
    var fillsWidth = false
    var prepare: (() async -> Bool)?
    let action: () async -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isEnabled) private var isEnabled
    @State private var confirmation = AssistantConfirmationState()
    @State private var working = false
    @State private var visible = false

    init(_ title: String, confirmationTitle: String? = nil, systemImage: String = "trash",
         kind: AssistantActionButtonKind = .destructive, hint: String = "",
         compact: Bool = true, fillsWidth: Bool = false,
         prepare: (() async -> Bool)? = nil,
         action: @escaping () async -> Void) {
        self.title = title
        self.confirmationTitle = confirmationTitle ?? Self.defaultConfirmationTitle
        self.systemImage = systemImage
        self.kind = kind
        self.hint = hint
        self.compact = compact
        self.fillsWidth = fillsWidth
        self.prepare = prepare
        self.action = action
    }

    static let defaultConfirmationTitle = "Confirm?"

    private var armed: Bool { confirmation.expiresAt != nil }

    /// What VoiceOver hears. The visible confirmation word is deliberately
    /// terse; the spoken one still names the action being confirmed.
    private var spokenConfirmation: String {
        confirmationTitle == Self.defaultConfirmationTitle
            ? "Confirm \(title.lowercased())"
            : confirmationTitle
    }

    var body: some View {
        Button {
            guard !working, isEnabled else { return }
            if !armed, let prepare {
                working = true
                Task {
                    let ready = await prepare()
                    working = false
                    if ready, visible, isEnabled, scenePhase == .active { _ = confirmation.tap() }
                }
                return
            }
            if confirmation.tap() {
                working = true
                Task {
                    await action()
                    working = false
                }
            }
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    Image(systemName: armed ? "checkmark" : systemImage)
                        .opacity(working ? 0 : 1)
                    if working { ProgressView().controlSize(.small) }
                }
                .frame(width: 16)
                ZStack {
                    Text(title).hidden()
                    Text(confirmationTitle).hidden()
                    // The working state keeps the resting title and swaps only
                    // the glyph for its spinner. A third word here would widen
                    // every button in the app for a state that lasts one
                    // round-trip, after the decision has already been made.
                    Text(armed && !working ? confirmationTitle : title)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(AssistantActionButtonStyle(kind: kind, compact: compact, fillsWidth: fillsWidth,
            confirming: armed && kind == .destructive))
        .disabled(working)
        .accessibilityLabel(working ? "Working" : armed ? spokenConfirmation : title)
        .accessibilityHint(armed ? "Tap again to confirm. \(hint)" : "Requires two taps. \(hint)")
        .accessibilityAction(.escape) { confirmation.reset() }
        .task(id: confirmation.expiresAt) {
            guard confirmation.expiresAt != nil else { return }
            do { try await Task.sleep(for: .seconds(AssistantConfirmationState.lifetime)) }
            catch { return }
            confirmation.reset()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { confirmation.reset() }
        }
        .onChange(of: isEnabled) { _, enabled in
            if !enabled { confirmation.reset() }
        }
        .onAppear { visible = true }
        .onDisappear {
            visible = false
            confirmation.reset()
        }
    }
}
