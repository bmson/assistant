import SwiftUI

private enum ActivityFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case needsYou = "Needs you"
    case working = "Working"
    case scheduled = "Scheduled"
    case completed = "Done"
    var id: Self { self }
    var requestValue: String {
        switch self { case .all: "all"; case .needsYou: "needs-you"; case .working: "working"; case .scheduled: "scheduled"; case .completed: "completed" }
    }
}

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var filter: ActivityFilter = .all
    @State private var showingArchived = false
    @State private var activityActionInFlight: String?
    @State private var archiveProgress: ArchiveOldActivityProgress?
    @State private var budgetItem: ActivityItem?
    @State private var itemPendingCancellation: ActivityItem?
    @State private var budgetText = ""
    @State private var discoveryQuery = ""
    @State private var discovery: ActivityList?
    @State private var discoveryInFlight = false
    @State private var discoveryGeneration = UUID()
    @State private var discoveryTask: Task<Void, Never>?
    @State private var activityStatuses: [String: ActivityStatusResponse] = [:]
    @State private var activityStatusAvailability = ActivityStatusAvailability()
    @State private var statusRefreshOffset = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                filterControl
                HStack {
                    TextField("Search recorded work", text: $discoveryQuery)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.search)
                        .onSubmit { loadDiscovery(reset: true) }
                        .accessibilityIdentifier("activity-search")
                    Button("Search") { loadDiscovery(reset: true) }
                        .disabled(discoveryInFlight)
                }
                if let archiveProgress, !archiveProgress.complete {
                    Label(
                        "Archived \(archiveProgress.archivedTotal) older tasks. Continue to process the next batch.",
                        systemImage: "archivebox"
                    )
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("activity-archive-progress")
                }
                if !items.isEmpty { activitySummary }

                if discovery == nil && (showingArchived ? model.archivedActivity == nil : model.overview == nil) {
                    AssistantLoadingState(title: "Loading activity…")
                } else if filteredItems.isEmpty {
                    AssistantEmptyState(
                        discovery != nil ? "No matches in these records" : (filter == .all ? "No activity yet" : "Nothing here"),
                        systemImage: "waveform.path.ecg",
                        description: discovery != nil
                            ? "Continue to older records if available, or change the filters. Legacy records without creation times cannot match date filters."
                            : filter == .all
                            ? "Work you hand off in chat will appear here with its evidence and decisions."
                            : "Try another activity filter."
                    )
                } else if isLandscape {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: AssistantTheme.cardStackSpacing),
                            GridItem(.flexible(), spacing: AssistantTheme.cardStackSpacing),
                        ],
                        spacing: AssistantTheme.cardStackSpacing
                    ) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                } else {
                    LazyVStack(spacing: AssistantTheme.cardStackSpacing) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                }
                if let discovery {
                    Text(discovery.searchIncomplete == true
                         ? "More records remain. Continue searching before concluding that a task is absent."
                         : "Reached the end of this search.")
                        .font(.footnote).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    Text("Detailed audit evidence may be unavailable or redacted. Legacy records without creation times cannot match date filters.")
                        .font(.footnote).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    if discovery.nextCursor != nil {
                        Button("Continue to older records") { loadDiscovery(reset: false) }
                            .disabled(discoveryInFlight)
                            .accessibilityIdentifier("activity-load-older")
                    }
                } else {
                    Button("Browse all recorded work") { loadDiscovery(reset: true) }
                        .disabled(discoveryInFlight)
                }
                if discoveryInFlight { ProgressView("Reading records…") }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("Activity")
        .onChange(of: showingArchived) { _, _ in
            discoveryTask?.cancel()
            discoveryGeneration = UUID()
            discoveryInFlight = false
            discovery = nil
            activityStatuses = [:]
            activityStatusAvailability.reset()
            statusRefreshOffset = 0
        }
        .onChange(of: filter) { _, _ in
            discoveryTask?.cancel()
            discoveryGeneration = UUID()
            discoveryInFlight = false
            if discovery != nil { loadDiscovery(reset: true) }
        }
        .onChange(of: model.activityConnectionVersion) { _, _ in
            discoveryTask?.cancel()
            discoveryGeneration = UUID()
            discoveryInFlight = false
            discovery = nil
            activityStatuses = [:]
            activityStatusAvailability.reset()
            statusRefreshOffset = 0
        }
        .onDisappear {
            discoveryTask?.cancel()
            discoveryTask = nil
            discoveryGeneration = UUID()
            discoveryInFlight = false
        }
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(
                        showingArchived ? "Show current activity" : "Show archived activity",
                        systemImage: showingArchived ? "tray.and.arrow.up" : "archivebox"
                    ) {
                        showingArchived.toggle()
                        if showingArchived { Task { await model.refreshArchivedActivity() } }
                    }
                    if !showingArchived {
                        Button(
                            archiveProgress.map { $0.complete ? "Archive old activity" : "Continue archiving (\($0.archivedTotal))" } ?? "Archive old activity",
                            systemImage: "archivebox"
                        ) {
                            activityActionInFlight = "archive-old"
                            Task {
                                let operationId = archiveProgress?.complete == false
                                    ? archiveProgress?.operationId
                                    : nil
                                if let progress = await model.archiveOldActivity(operationId: operationId) {
                                    archiveProgress = progress
                                }
                                activityActionInFlight = nil
                            }
                        }
                        .disabled(activityActionInFlight != nil)
                    }
                } label: {
                    Label("Activity actions", systemImage: "ellipsis")
                }
            }
        }
        .refreshable {
            if showingArchived { await model.refreshArchivedActivity() }
            else { await model.refreshOverview() }
            if discovery != nil { loadDiscovery(reset: true) }
        }
        .task(id: "\(scenePhase)-\(model.activityConnectionVersion)-\(showingArchived)-\(filter.rawValue)") {
            guard scenePhase == .active else { return }
            var failures = 0
            while !Task.isCancelled, scenePhase == .active {
                failures = await refreshVisibleActivity() ? 0 : failures + 1
                do {
                    try await Task.sleep(
                        for: .seconds(PollingPolicy.activityIntervalSeconds(consecutiveFailures: failures))
                    )
                } catch { return }
            }
        }
        .alert(
            "Raise task budget",
            isPresented: Binding(
                get: { budgetItem != nil },
                set: { if !$0 { budgetItem = nil } }
            )
        ) {
            TextField("New limit in USD", text: $budgetText)
                .keyboardType(.decimalPad)
            Button("Raise and retry") {
                guard let item = budgetItem, let amount = Double(budgetText) else { return }
                updateActivity(item, action: "raise-budget", budgetUsdLimit: amount)
                budgetItem = nil
            }
            Button("Cancel", role: .cancel) { budgetItem = nil }
        } message: {
            Text("The task resumes from its saved checkpoint; completed actions are not repeated.")
        }
        .confirmationDialog(
            "Stop task?",
            isPresented: Binding(
                get: { itemPendingCancellation != nil },
                set: { if !$0 { itemPendingCancellation = nil } }
            ),
            titleVisibility: .visible,
            presenting: itemPendingCancellation
        ) { item in
            Button("Stop task", role: .destructive) {
                updateActivity(item, action: "cancel")
            }
        } message: { item in
            Text("This cancels “\(item.displayTitle)”.")
        }
        .sensoryFeedback(.selection, trigger: filter)
    }

    private var filterControl: some View {
        AssistantFilterPicker(title: "Activity filter", options: ActivityFilter.allCases,
            selection: $filter, label: { $0.rawValue })
    }

    private var activitySummary: some View {
        let summary = ActivityVisualSummary(statuses: items.map(\.displayStatus))
        let colors: [Color] = [AssistantTheme.warning(for: colorScheme),
            AssistantTheme.accent(for: colorScheme), AssistantTheme.inkMuted(for: colorScheme),
            AssistantTheme.success(for: colorScheme).opacity(0.4), AssistantTheme.errorInk(for: colorScheme), .secondary]
        return AssistantFlowLayout(spacing: 12) {
            Text("\(items.count) \(items.count == 1 ? "task" : "tasks")")
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            ForEach(Array(summary.counts.enumerated()), id: \.offset) { index, count in
                if count > 0 {
                    HStack(spacing: 5) {
                        Circle().fill(colors[index]).frame(width: 6, height: 6).accessibilityHidden(true)
                        Text("\(count) \(ActivityVisualSummary.labels[index])")
                    }
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }

    private func loadDiscovery(reset: Bool) {
        if !reset && discoveryInFlight { return }
        if reset { discoveryTask?.cancel() }
        let generation = UUID()
        discoveryGeneration = generation
        if reset { statusRefreshOffset = 0 }
        discoveryInFlight = true
        let archived = showingArchived
        let query = discoveryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let status = filter.requestValue
        let cursor = reset ? nil : discovery?.nextCursor
        let previous = reset ? [] : discovery?.items ?? []
        discoveryTask = Task {
            let page = await model.activityDiscoveryPage(archived: archived, query: query, filter: status, cursor: cursor)
            guard !Task.isCancelled, discoveryGeneration == generation, showingArchived == archived else { return }
            discoveryInFlight = false
            discoveryTask = nil
            guard let page else { return }
            var seen = Set(previous.map(\.id))
            let newItems = page.items.filter { seen.insert($0.id).inserted }
            discovery = ActivityList(items: previous + newItems, archivedCount: page.archivedCount,
                                     nextCursor: page.nextCursor, searchIncomplete: page.searchIncomplete,
                                     scanned: page.scanned, captureStatus: page.captureStatus)
        }
    }

    private func refreshVisibleActivity() async -> Bool {
        let generation = discoveryGeneration
        let connectionVersion = model.activityConnectionVersion
        let archived = showingArchived
        let refreshed = archived
            ? await model.refreshArchivedActivity(reportFailure: false)
            : await model.refreshOverview(reportFailure: false)
        guard isCurrentActivityRefresh(generation, connectionVersion, archived) else { return false }

        let ownerID = model.bootstrap?.identity.id ?? ""
        for item in storedItems where ["done", "failed", "cancelled"].contains(item.status) {
            activityStatusAvailability.clear(ActivityStatusAvailabilityKey(ownerID: ownerID, taskID: item.id))
        }
        let candidates = storedItems.filter { !["done", "failed", "cancelled"].contains($0.status) }
        guard !candidates.isEmpty else { return refreshed }
        let cap = 12
        let start = statusRefreshOffset % candidates.count
        let rotated = Array(candidates.dropFirst(start)) + Array(candidates.prefix(start))
        let batch = Array(rotated.prefix(cap))
        statusRefreshOffset = (start + batch.count) % candidates.count

        let outcomes = await withTaskGroup(of: (String, ActivityStatusReadOutcome).self) { group in
            var next = 0
            let initialCount = min(4, batch.count)
            while next < initialCount {
                let id = batch[next].id
                group.addTask { (id, await model.fetchActivityStatusOutcome(id: id)) }
                next += 1
            }
            var collected: [(String, ActivityStatusReadOutcome)] = []
            while let result = await group.next() {
                guard !Task.isCancelled else {
                    group.cancelAll()
                    break
                }
                collected.append(result)
                if !Task.isCancelled, next < batch.count {
                    let id = batch[next].id
                    group.addTask { (id, await model.fetchActivityStatusOutcome(id: id)) }
                    next += 1
                }
            }
            return collected
        }
        guard isCurrentActivityRefresh(generation, connectionVersion, archived) else { return false }
        for (id, outcome) in outcomes {
            let key = ActivityStatusAvailabilityKey(ownerID: ownerID, taskID: id)
            activityStatusAvailability.record(outcome, for: key)
            if case let .updated(status) = outcome { activityStatuses[status.id] = status }
        }
        return refreshed && outcomes.count == batch.count && outcomes.allSatisfy {
            if case .updated = $0.1 { return true }
            return false
        }
    }

    private func isCurrentActivityRefresh(_ generation: UUID, _ connectionVersion: Int, _ archived: Bool) -> Bool {
        !Task.isCancelled && scenePhase == .active && discoveryGeneration == generation &&
            showingArchived == archived && model.activityConnectionIsCurrent(version: connectionVersion)
    }

    private var storedItems: [ActivityItem] {
        let source = discovery?.items ?? (showingArchived
            ? model.archivedActivity?.items ?? []
            : model.overview?.activity.items ?? [])
        return source.map { item in
            activityStatuses[item.id].map(item.applying) ?? item
        }
    }

    private var items: [ActivityItem] {
        storedItems.filter { showingArchived ? $0.archivedAt != nil : $0.archivedAt == nil }
    }

    private var filteredItems: [ActivityItem] {
        return items.filter { item in
            switch filter {
            case .all: true
            case .needsYou: ["waiting_approval", "waiting_budget", "needs_attention", "stuck"].contains(item.displayStatus)
            case .working: ["pending", "running"].contains(item.status)
            case .scheduled: ["sleeping", "waiting_event"].contains(item.status)
            case .completed: ["done", "failed", "cancelled"].contains(item.status)
            }
        }
    }

    private func activityCard(_ item: ActivityItem) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            activityHeader(item)
            if let ownerID = model.bootstrap?.identity.id,
               let notice = activityStatusAvailability.notice(
                   for: ActivityStatusAvailabilityKey(ownerID: ownerID, taskID: item.id),
                   savedStatus: item.status
               ) {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityIdentifier("activity-status-unavailable-\(item.id)")
            }
            DisclosureGroup("Details") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Task \(item.id)")
                    if let source = item.source { Text("Source: \(source)") }
                    if let created = item.createdAt { Text("Created: \(created)") }
                    if let event = item.externalEventId { Text("Source record: \(event)") }
                }.font(.caption).textSelection(.enabled)
            }.font(.caption)

            if !item.displayProgress.isEmpty {
                Text((try? AttributedString(markdown: item.displayProgress,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(item.displayProgress))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 3)
            }

            Divider()
            HStack(alignment: .bottom, spacing: AssistantTheme.actionSpacing) {
                VStack(alignment: .leading, spacing: AssistantTheme.actionSpacing) {
                    activityMetadata(item)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    activityPrimaryActions(item)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !showingArchived {
                    activityActions(item)
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func activityPrimaryActions(_ item: ActivityItem) -> some View {
        if showingArchived || item.hasPendingApproval || item.status == "needs_attention" || item.stuckWaiting == true {
            AssistantFlowLayout(spacing: AssistantTheme.actionSpacing) {
                if showingArchived {
                    actionButton(item, title: "Restore", icon: "tray.and.arrow.up", action: "restore")
                } else {
                    if item.hasPendingApproval {
                        Button { model.present(.approvals) } label: {
                            Label("Review approval", systemImage: "checkmark.shield")
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                        .disabled(activityActionInFlight != nil)
                    }
                    if item.status == "needs_attention" && item.progress.hasPrefix("budget: task budget") {
                        Button {
                            budgetItem = item
                            budgetText = suggestedBudget(for: item)
                        } label: {
                            Label("Raise budget", systemImage: "dollarsign.arrow.circlepath")
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                        .disabled(activityActionInFlight != nil)
                    } else if item.status == "needs_attention" || item.stuckWaiting == true {
                        actionButton(item, title: "Retry", icon: "arrow.clockwise", action: "retry")
                    }
                }
            }
        }
    }

    private func activityActions(_ item: ActivityItem) -> some View {
        Menu {
            if isTerminal(item) {
                Button("Archive", systemImage: "archivebox") {
                    updateActivity(item, action: "archive")
                }
            }
            if item.hasActiveAutonomy == true {
                Button("Revoke autonomy", systemImage: "hand.raised") {
                    updateActivity(item, action: "revoke-autonomy")
                }
            }
            if !isTerminal(item) {
                Button("Stop task", systemImage: "xmark.circle", role: .destructive) {
                    itemPendingCancellation = item
                }
            }
        } label: {
            AssistantActionMenuLabel(isUpdating: activityActionInFlight == item.id)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Actions for \(item.displayTitle)")
        .disabled(activityActionInFlight != nil)
    }

    @ViewBuilder
    private func activityActionLabel(_ item: ActivityItem, title: String, icon: String) -> some View {
        if activityActionInFlight == item.id {
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("Updating…")
            }
        } else {
            Label(title, systemImage: icon)
        }
    }

    private func updateActivity(_ item: ActivityItem, action: String) {
        activityActionInFlight = item.id
        Task {
            _ = await model.updateActivity(item, action: action)
            activityActionInFlight = nil
        }
    }

    private func updateActivity(_ item: ActivityItem, action: String, budgetUsdLimit: Double) {
        activityActionInFlight = item.id
        Task {
            _ = await model.updateActivity(
                item,
                action: action,
                budgetUsdLimit: budgetUsdLimit
            )
            activityActionInFlight = nil
        }
    }

    private func actionButton(
        _ item: ActivityItem,
        title: String,
        icon: String,
        action: String
    ) -> some View {
        Button { updateActivity(item, action: action) } label: {
            activityActionLabel(item, title: title, icon: icon)
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        .disabled(activityActionInFlight != nil)
    }

    private func suggestedBudget(for item: ActivityItem) -> String {
        let current = Double(item.budgetUsdLimit) ?? 0
        let spent = Double(item.spentUsd) ?? 0
        let suggested = ceil(max(current * 2, spent + 0.25) * 4) / 4
        return String(format: "%.2f", suggested)
    }

    private func isTerminal(_ item: ActivityItem) -> Bool {
        ["done", "failed", "cancelled"].contains(item.status)
    }

    @ViewBuilder
    private func activityHeader(_ item: ActivityItem) -> some View {
        let identity = HStack(alignment: .top, spacing: 12) {
                AssistantGlyph(systemName: icon(for: item.displayStatus), tint: color(for: item.displayStatus))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.displayTitle)
                        .font(.headline)
                        .lineLimit(usesAccessibilityLayout ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(item.type.sentenceCaseIdentifier)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                identity
                StatusPill(status: item.displayStatus)
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                identity
                StatusPill(status: item.displayStatus)
            }
        }
    }

    @ViewBuilder
    private func activityMetadata(_ item: ActivityItem) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.budgetSummary)
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                }
            }
        } else {
            AssistantFlowLayout(spacing: 7) {
                Text(item.budgetSummary)
                Text("·")
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Text("·")
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                    .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                }
            }
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
    private var isLandscape: Bool { verticalSizeClass == .compact }

    private func icon(for status: String) -> String {
        switch status {
        case "running": "arrow.triangle.2.circlepath"
        case "done": "checkmark.circle.fill"
        case "failed", "cancelled": "xmark.circle.fill"
        case "waiting_approval", "waiting_budget", "needs_attention", "stuck": "hand.raised.fill"
        case "sleeping", "waiting_event": "clock.fill"
        default: "circle.dotted"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "running": AssistantTheme.accent(for: colorScheme)
        // The brand green, matching the StatusPill sitting beside it in the
        // same card — system green is a visibly different hue.
        case "done": AssistantTheme.success(for: colorScheme)
        case "failed", "cancelled": .red
        case "waiting_approval", "waiting_budget", "needs_attention", "stuck": AssistantTheme.warning(for: colorScheme)
        default: .secondary
        }
    }
}

func relative(_ value: String) -> String {
    // Both fractional and whole-second ISO timestamps are valid server dates.
    guard let date = value.assistantDate
        ?? AssistantFormatters.internetDateTime.date(from: value) else { return value }
    return AssistantFormatters.relative.localizedString(for: date, relativeTo: .now)
}
