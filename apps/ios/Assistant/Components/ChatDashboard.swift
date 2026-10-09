import SwiftUI

/// The chat's empty state doubles as the owner's briefing surface. It only
/// uses projections already loaded by the mobile overview endpoint, keeping
/// the conversation front door useful without inventing a separate dashboard
/// API or pretending an empty calendar contains appointments.
struct ChatDashboard: View {
    let agentName: String
    let overview: OverviewResponse?
    let pendingApprovalCount: Int
    let needsAttentionCount: Int
    let isSending: Bool
    let onRoute: (AssistantRoute) -> Void
    let onPrompt: (String) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    private var activeWork: [ActivityItem] {
        (overview?.activity.items ?? []).filter {
            ["pending", "running", "sleeping", "waiting_event"].contains($0.status)
        }
    }

    private var firstGoal: GoalDashboardItem? {
        overview?.goals.items.first { !$0.stalled } ?? overview?.goals.items.first
    }

    private var firstApproval: PendingApproval? {
        overview?.approvals.pending.first
    }

    private var agendaItems: [DashboardAgendaItem] {
        var items: [DashboardAgendaItem] = []

        if let approval = firstApproval {
            items.append(
                .init(
                    marker: "Now",
                    title: approval.approval.summary,
                    detail: pendingApprovalCount == 1 ? "Ready for your review" : "\(pendingApprovalCount) decisions waiting",
                    tag: "Approval",
                    action: "Review",
                    icon: "hand.raised.fill",
                    destination: .route(.approvals)
                )
            )
        } else if pendingApprovalCount > 0 {
            // Bootstrap carries the count even when an overview refresh is
            // temporarily unavailable. Keep the priority honest rather than
            // showing an empty, cheerful card until that retry succeeds.
            items.append(
                .init(
                    marker: "Now",
                    title: "Review pending approvals",
                    detail: "\(pendingApprovalCount) decisions are waiting for you.",
                    tag: "\(pendingApprovalCount) waiting",
                    action: "Review",
                    icon: "hand.raised.fill",
                    destination: .route(.approvals)
                )
            )
        } else if needsAttentionCount > 0 {
            items.append(
                .init(
                    marker: "Now",
                    title: "A task is waiting for your direction",
                    detail: "\(needsAttentionCount) \(needsAttentionCount == 1 ? "item needs" : "items need") your attention.",
                    tag: "Needs you",
                    action: "Open",
                    icon: "exclamationmark.circle",
                    destination: .route(.activity)
                )
            )
        }

        if let work = activeWork.first {
            items.append(
                .init(
                    marker: items.isEmpty ? "Now" : "Next",
                    title: work.displayTitle,
                    detail: work.displayProgress.isEmpty ? "The assistant is keeping this moving." : work.displayProgress,
                    tag: work.status == "running" ? "In motion" : "Scheduled",
                    action: "Track",
                    icon: "arrow.triangle.2.circlepath",
                    destination: .route(.activity)
                )
            )
        }

        if items.count < 3, let goal = firstGoal {
            items.append(
                .init(
                    marker: items.isEmpty ? "Next" : "Later",
                    title: goal.goal.displayTitle,
                    detail: goal.goal.nextAction.isEmpty ? goal.cadenceLabel : "Next: \(goal.goal.nextAction)",
                    tag: goal.workActive ? "Active" : goal.cadenceLabel,
                    action: "Open",
                    icon: "scope",
                    destination: .route(.goals)
                )
            )
        }

        if items.isEmpty {
            items.append(
                .init(
                    marker: "Ready",
                    title: "Put a task in motion",
                    detail: "Choose a starting point below.",
                    tag: "Start here",
                    action: "Ask",
                    icon: "sparkles",
                    destination: .prompt("Help me decide what to focus on today")
                )
            )
        }

        return items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardStackSpacing) {
            greeting
            upNextCard
            startCard
        }
        .padding(.top, 76)
        .padding(.bottom, 28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(greetingTitle)
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private var greetingTitle: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: "Good morning"
        case 12..<18: "Good afternoon"
        default: "Good evening"
        }
    }

    private var upNextCard: some View {
        DashboardCard(title: "Up next") {
            VStack(spacing: 0) {
                ForEach(Array(agendaItems.enumerated()), id: \.offset) { index, item in
                    agendaRow(item)
                    if index < agendaItems.count - 1 {
                        DashboardDivider()
                    }
                }
                DashboardDivider()
                dashboardFooter("View all activity") {
                    onRoute(.activity)
                }
            }
        }
    }

    private func agendaRow(_ item: DashboardAgendaItem) -> some View {
        Button {
            perform(item.destination)
        } label: {
            Group {
                if usesAccessibilityLayout {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.marker)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        agendaDetails(item)
                        Text(item.action)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(alignment: .top, spacing: 12) {
                        Text(item.marker)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .frame(width: 54, alignment: .leading)
                        agendaDetails(item)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(item.action)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .padding(.top, 1)
                    }
                }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
        .disabled(isSending && item.destination.isPrompt)
    }

    private func agendaDetails(_ item: DashboardAgendaItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .lineLimit(usesAccessibilityLayout ? nil : 2)
                .multilineTextAlignment(.leading)
            if !item.detail.isEmpty {
                Text(item.detail)
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(usesAccessibilityLayout ? nil : 2)
            }
            DashboardTag(title: item.tag, icon: item.icon)
        }
    }

    private var startCard: some View {
        DashboardCard(title: "Try a task") {
            VStack(spacing: 0) {
                promptRow("Plan a project", prompt: "Help me make a practical plan for a project", icon: "list.bullet.clipboard")
                DashboardDivider()
                promptRow("Research a decision", prompt: "Research the options and help me make a decision", icon: "magnifyingglass")
                DashboardDivider()
                promptRow("Draft something", prompt: "Help me draft a message", icon: "square.and.pencil")
                DashboardDivider()
                promptRow("Define a goal", prompt: "Help me define a goal and the first next steps", icon: "scope")
            }
        }
    }

    private func promptRow(_ title: String, prompt: String, icon: String) -> some View {
        Button {
            onPrompt(prompt)
        } label: {
            Group {
                if usesAccessibilityLayout {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: icon)
                                .font(.system(size: 16, weight: .regular))
                                .frame(width: 24, height: 24)
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                                .accessibilityHidden(true)
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                                .accessibilityHidden(true)
                        }
                        Text(title)
                            .font(.body.weight(.medium))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: icon)
                            .font(.body.weight(.regular))
                            .frame(width: 24)
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        Text(title)
                            .font(.body.weight(.medium))
                            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .accessibilityHidden(true)
                    }
                }
            }
            .frame(minHeight: 46)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
        .disabled(isSending)
    }

    private func dashboardFooter(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title)
                    .font(.body.weight(.medium))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.medium))
                    .accessibilityHidden(true)
            }
            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
    }

    private func perform(_ destination: DashboardDestination) {
        switch destination {
        case let .route(route): onRoute(route)
        case let .prompt(prompt): onPrompt(prompt)
        }
    }
}

private struct DashboardCard<Content: View>: View {
    let title: String
    let content: Content

    init(
        title: String,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.content = content()
    }

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)

        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))

            DashboardDivider()
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.dashboardPaper(for: colorScheme), in: shape)
        .overlay {
            shape.strokeBorder(
                AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.12 : 0.07),
                lineWidth: 0.8
            )
        }
    }
}

private struct DashboardDivider: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Rectangle()
            .fill(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.13 : 0.09))
            .frame(height: 1)
    }
}

private struct DashboardTag: View {
    let title: String
    var icon: String? = nil

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let icon {
                Label(title, systemImage: icon)
            } else {
                Text(title)
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(
            AssistantTheme.accent(for: colorScheme).opacity(colorScheme == .dark ? 0.15 : 0.09),
            in: Capsule()
        )
    }
}

private struct DashboardButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

private struct DashboardAgendaItem {
    let marker: String
    let title: String
    let detail: String
    let tag: String
    let action: String
    let icon: String
    let destination: DashboardDestination
}

private enum DashboardDestination {
    case route(AssistantRoute)
    case prompt(String)

    var isPrompt: Bool {
        if case .prompt(_) = self { return true }
        return false
    }
}
