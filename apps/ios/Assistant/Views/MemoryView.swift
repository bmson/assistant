import SwiftUI
import UniformTypeIdentifiers

/// The memory home.
///
/// One screen, read top to bottom: the map of who and what the assistant
/// knows, anything waiting on the owner, a handful of the facts it holds, and
/// a short list of places to go for the rest. Each fact is one row — tap to
/// read and act on it, swipe for the common moves — rather than a card
/// carrying three buttons, which is what made the old page a wall of controls.
struct MemoryView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingCreateMemory = false
    @State private var openFact: WorkspaceMemoryFact?
    @State private var reviewInFlightID: String?
    @State private var reviewInFlightAction: String?
    @State private var reviewErrorID: String?
    @State private var reviewedIDs: Set<String> = []
    @State private var forgetting: WorkspaceMemoryFact?
    @State private var graph: RelationshipGraphSnapshot?
    @State private var graphFailed = false
    /// The map's own settings, so the preview looks like the map it opens.
    @AppStorage(GraphSettings.defaultsKey) private var graphSettingsData = Data()
    @State private var showsMap = false

    /// Enough to recognise the memory, not so many that the page becomes the
    /// library. The library is one tap away.
    private let factPreviewCount = 5

    var body: some View {
        AssistantSettingsList {
            if let memory = model.workspace?.memory {
                content(memory)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 220)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Memory")
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add memory", systemImage: "plus") { showingCreateMemory = true }
                    .disabled(model.workspace?.memory.ownerContactId == nil)
            }
        }
        .refreshable {
            await model.refreshWorkspace()
            await loadGraph()
        }
        .task {
            if model.workspace == nil { await model.refreshWorkspace() }
            if graph == nil { await loadGraph() }
        }
        .fullScreenCover(isPresented: $showsMap, onDismiss: { Task { await loadGraph() } }) {
            NavigationStack { RelationshipGraphScreen(initialGraph: graph) }
        }
        .sheet(isPresented: $showingCreateMemory) {
            if let ownerContactId = model.workspace?.memory.ownerContactId {
                NavigationStack { MemoryEditor(ownerContactId: ownerContactId, fact: nil) }
            }
        }
        .sheet(item: $openFact, onDismiss: { Task { await model.refreshWorkspace(reportFailure: false) } }) { fact in
            NavigationStack { MemoryFactSheet(fact: fact, onReviewCompleted: { reviewedIDs.insert(fact.id); openFact = nil }) }
                .presentationDetents([.medium, .large])
        }
        .confirmationDialog(
            "Forget this?",
            isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
            titleVisibility: .visible,
            presenting: forgetting
        ) { fact in
            Button("Forget", role: .destructive) { perform(fact, action: "forget") }
        } message: { _ in
            Text("It is removed, and the assistant won’t learn it again from the same source.")
        }
    }

    @ViewBuilder
    private func content(_ memory: WorkspaceMemory) -> some View {
        Section {
            mapCard
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
        }

        let toReview = memory.awaitingReview.filter { !reviewedIDs.contains($0.id) }
        if !toReview.isEmpty {
            Section {
                ForEach(toReview) { fact in
                    reviewRow(fact)
                }
            } header: {
                Text("Review memories")
            } footer: {
                Text("Choose what the assistant should remember. These aren’t used until you decide.")
            }
        }

        Section {
            if memory.facts.isEmpty {
                Text("Nothing saved yet. Tap + to add something the assistant should always know.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(rowBackground)
            } else {
                ForEach(previewFacts(memory)) { fact in
                    factRow(fact, review: false)
                }
            }
            NavigationLink {
                MemoryLibraryScreen()
            } label: {
                Text(memory.health.totalUsable > 0 ? "See all \(memory.health.totalUsable)" : "Open the library")
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            }
            .listRowBackground(rowBackground)
        } header: {
            Text(memory.ownerName.map { "About \($0)" } ?? "About you")
        } footer: {
            if memory.health.totalUsable > 0 {
                Text("\(memory.health.totalUsable) in use · \(memory.health.ownerConfirmed) confirmed by you")
            }
        }

        Section {
            destination("Open loops", systemImage: "clock.arrow.circlepath") { CommitmentsScreen() }
            destination("Profile summary", systemImage: "person.text.rectangle") { MemoryProfileScreen() }
            destination("Writing voice", systemImage: "text.quote") { WritingVoiceScreen() }
            destination("Tidy up the map", systemImage: "sparkles") { KnowledgeCleanupScreen() }
            destination("Your data", systemImage: "arrow.down.circle") { MemoryDataScreen() }
        } header: {
            Text("More")
        }
    }

    private var rowBackground: Color { AssistantTheme.raised(for: colorScheme) }

    /// Facts the owner pinned lead, then the newest — the order the assistant
    /// itself weighs them in.
    private func previewFacts(_ memory: WorkspaceMemory) -> [WorkspaceMemoryFact] {
        let pinned = memory.facts.filter(\.pinned)
        let rest = memory.facts.filter { !$0.pinned }
        return Array((pinned + rest).prefix(factPreviewCount))
    }

    private func destination<Destination: View>(
        _ title: String, systemImage: String, @ViewBuilder _ destination: @escaping () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            Label(title, systemImage: systemImage)
        }
        .listRowBackground(rowBackground)
    }

    // MARK: - Map card

    private var mapCard: some View {
        Button { showsMap = true } label: {
            VStack(spacing: 0) {
                ZStack {
                    if let graph, !graph.nodes.isEmpty {
                        let settings = GraphSettings(data: graphSettingsData)
                        let shown = graph.filtered(by: settings)
                        RelationshipGraphCanvas(snapshot: shown.nodes.isEmpty ? graph : shown, selectedID: nil, interactive: false,
                                                insets: UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0),
                                                settings: settings)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    } else {
                        AssistantTheme.sunken(for: colorScheme)
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.system(size: 44, weight: .light))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .accessibilityHidden(true)
                    }
                }
                .frame(height: 170)
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Your map").font(.headline).foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        Text(mapSubtitle).font(.footnote).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .frame(width: 36, height: 36)
                        .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
                        .accessibilityHidden(true)
                }
                .padding(16)
            }
            .background(AssistantTheme.raised(for: colorScheme))
            .clipShape(RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
                    .stroke(Color.primary.opacity(colorScheme == .dark ? 0.16 : 0.07), lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Your map. \(mapSubtitle)")
        .accessibilityHint("Opens the relationship map full screen")
        .accessibilityIdentifier("assistant.memory.map")
    }

    private var mapSubtitle: String {
        guard let graph else { return graphFailed ? "Tap to open" : "Loading…" }
        guard !graph.nodes.isEmpty else { return "Fills in as the assistant learns who knows whom" }
        let items = graph.nodes.count, links = graph.links.count
        return "\(items)\(graph.truncated ? "+" : "") \(items == 1 ? "item" : "items") · \(links) \(links == 1 ? "connection" : "connections")"
    }

    private func loadGraph() async {
        if let result = await model.relationshipGraph() {
            graph = result; graphFailed = false
        } else if graph == nil {
            graphFailed = true
        }
    }

    // MARK: - Facts

    /// Decide from the list; reading the full text is optional.
    private func reviewRow(_ fact: WorkspaceMemoryFact) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Button { openFact = fact } label: {
                Text(fact.content)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the full memory review")

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { reviewButtons(fact) }
                VStack(spacing: 10) { reviewButtons(fact) }
            }

            if reviewErrorID == fact.id {
                Text("Couldn’t save your choice. Try again.")
                    .font(.footnote)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
            }
        }
        .padding(.vertical, 6)
        .disabled(reviewInFlightID != nil)
        .listRowBackground(rowBackground)
    }

    @ViewBuilder
    private func reviewButtons(_ fact: WorkspaceMemoryFact) -> some View {
        Button {
            performReview(fact, action: "approve")
        } label: {
            reviewButtonLabel("Remember", fact: fact, action: "approve")
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: false, fillsWidth: true))
        .accessibilityIdentifier("assistant.memory.remember.\(fact.id)")

        Button {
            performReview(fact, action: "reject")
        } label: {
            reviewButtonLabel("Don’t remember", fact: fact, action: "reject")
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .neutral, compact: false, fillsWidth: true))
        .accessibilityIdentifier("assistant.memory.dontRemember.\(fact.id)")
    }

    private func reviewButtonLabel(_ title: String, fact: WorkspaceMemoryFact, action: String) -> some View {
        HStack(spacing: 8) {
            if reviewInFlightID == fact.id && reviewInFlightAction == action {
                ProgressView().tint(action == "approve" ? .white : AssistantTheme.ink(for: colorScheme))
            }
            Text(title).fixedSize(horizontal: true, vertical: false)
        }
    }

    private func performReview(_ fact: WorkspaceMemoryFact, action: String) {
        guard reviewInFlightID == nil else { return }
        reviewInFlightID = fact.id
        reviewInFlightAction = action
        reviewErrorID = nil
        Task {
            let saved = await model.updateMemory(id: fact.id, action: action, refreshAfterSave: false)
            if saved { reviewedIDs.insert(fact.id) }
            reviewErrorID = saved ? nil : fact.id
            reviewInFlightID = nil
            reviewInFlightAction = nil
            if saved { await model.refreshWorkspace(reportFailure: false) }
        }
    }

    private func factRow(_ fact: WorkspaceMemoryFact, review: Bool) -> some View {
        Button { openFact = fact } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if fact.pinned && !review {
                    Image(systemName: "pin.fill")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .accessibilityLabel("Always used")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(fact.content)
                        .foregroundStyle(.primary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 3)
                        .multilineTextAlignment(.leading)
                    Text(factMeta(fact, review: review))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(review ? AssistantTheme.warningSurface(for: colorScheme) : rowBackground)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if review {
                Button("Remember", systemImage: "checkmark") { perform(fact, action: "approve") }
                    .tint(AssistantTheme.accent(for: colorScheme))
            } else if !fact.ownerConfirmed {
                Button("Confirm", systemImage: "checkmark.seal") { perform(fact, action: "confirm") }
                    .tint(AssistantTheme.accent(for: colorScheme))
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if review {
                Button("Don’t remember", systemImage: "xmark", role: .destructive) { perform(fact, action: "reject") }
            } else {
                Button("Forget", systemImage: "trash", role: .destructive) { forgetting = fact }
            }
        }
        .contextMenu {
            if review {
                Button("Remember", systemImage: "checkmark") { perform(fact, action: "approve") }
                Button("Don’t remember", systemImage: "xmark", role: .destructive) { perform(fact, action: "reject") }
            } else {
                if !fact.ownerConfirmed {
                    Button("Confirm it’s right", systemImage: "checkmark.seal") { perform(fact, action: "confirm") }
                }
                Button(fact.pinned ? "Use only when relevant" : "Always use", systemImage: fact.pinned ? "pin.slash" : "pin") {
                    perform(fact, action: "prominence", prominence: fact.pinned ? "auto" : "always")
                }
                Button("Forget", systemImage: "trash", role: .destructive) { forgetting = fact }
            }
        }
    }

    private func factMeta(_ fact: WorkspaceMemoryFact, review: Bool) -> String {
        var parts = [fact.domain?.sentenceCaseIdentifier ?? "General"]
        if !review && !fact.ownerConfirmed { parts.append("Not confirmed") }
        parts.append(relative(fact.createdAt))
        return parts.joined(separator: " · ")
    }

    private func perform(_ fact: WorkspaceMemoryFact, action: String, prominence: String? = nil) {
        Task { _ = await model.updateMemory(id: fact.id, action: action, prominence: prominence) }
    }
}

/// One fact, read in full, with everything that can be done to it.
struct MemoryFactSheet: View {
    let fact: WorkspaceMemoryFact
    var onReviewCompleted: (() -> Void)? = nil
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var working = false
    @State private var correcting = false
    @State private var reviewAction: String?
    @State private var reviewFailed = false

    /// The live copy, so a change made here shows here.
    private var current: WorkspaceMemoryFact {
        let memory = model.workspace?.memory
        return (memory?.facts ?? []).first { $0.id == fact.id }
            ?? (memory?.awaitingReview ?? []).first { $0.id == fact.id }
            ?? fact
    }

    private var inReview: Bool {
        (model.workspace?.memory.awaitingReview ?? []).contains { $0.id == fact.id }
            || reviewAction != nil
    }

    private var prominence: Binding<String> {
        Binding(
            get: { current.pinned ? "always" : current.importance <= 1 ? "minor" : "auto" },
            set: { value in run(action: "prominence", prominence: value, closes: false) }
        )
    }

    var body: some View {
        Group {
            if inReview {
                reviewContent
            } else {
                AssistantForm {
                    Section {
                        Text(current.content)
                            .font(.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        LabeledContent("Topic", value: current.domain?.sentenceCaseIdentifier ?? "General")
                        LabeledContent("Saved", value: relative(current.createdAt))
                        LabeledContent("Confirmed by you", value: current.ownerConfirmed ? "Yes" : "Not yet")
                    }
                    Section {
                        if !current.ownerConfirmed {
                            Button("Yes, this is right", systemImage: "checkmark.seal") { run(action: "confirm", closes: false) }
                        }
                        Picker("Use it", selection: prominence) {
                            Text("Always").tag("always")
                            Text("When relevant").tag("auto")
                            Text("Rarely").tag("minor")
                        }
                        Button("Correct it", systemImage: "pencil") { correcting = true }
                    }
                    Section {
                        AssistantConfirmationButton(
                            "Forget this", confirmationTitle: "Forget for good",
                            hint: "Removes it and stops the assistant learning it again from the same source.",
                            fillsWidth: true
                        ) {
                            working = true
                            if await model.updateMemory(id: fact.id, action: "forget") { dismiss() }
                            working = false
                        }
                    }
                }
            }
        }
        .disabled(working)
        .navigationTitle(inReview ? "Remember this?" : "Memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(inReview ? "Later" : "Done") { dismiss() }
            }
        }
        .interactiveDismissDisabled(working)
        .sheet(isPresented: $correcting) {
            NavigationStack {
                MemoryEditor(ownerContactId: model.workspace?.memory.ownerContactId ?? "", fact: current)
            }
        }
    }

    private var reviewContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(current.content)
                    .font(.title3)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .assistantCard(in: colorScheme)

                Text("The assistant won’t use this unless you choose Remember.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: 12) {
                    Button(reviewAction == "approve" && working ? "Remembering…" : "Remember") {
                        run(action: "approve")
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: false, fillsWidth: true))
                    .accessibilityIdentifier("assistant.memory.remember")
                    .accessibilityHint("Adds this memory for the assistant to use")

                    Button(reviewAction == "reject" && working ? "Removing…" : "Don’t remember") {
                        run(action: "reject")
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .neutral, compact: false, fillsWidth: true))
                    .accessibilityIdentifier("assistant.memory.dontRemember")
                    .accessibilityHint("Removes this suggestion from review")
                }

                if reviewFailed {
                    Text("Couldn’t save your choice. Try again.")
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                        .accessibilityIdentifier("assistant.memory.reviewError")
                }
            }
            .padding(24)
        }
        .background(AssistantTheme.canvas(for: colorScheme))
    }

    private func run(action: String, prominence: String? = nil, closes: Bool = true) {
        guard !working else { return }
        reviewAction = inReview ? action : nil
        reviewFailed = false
        working = true
        Task {
            // Close on the saved decision; the presenting view refreshes afterward.
            let isReviewDecision = action == "approve" || action == "reject"
            let done = await model.updateMemory(
                id: fact.id, action: action, prominence: prominence,
                refreshAfterSave: !isReviewDecision
            )
            if done && closes {
                if isReviewDecision, let onReviewCompleted { onReviewCompleted() }
                else { dismiss() }
            }
            reviewFailed = !done && reviewAction != nil
            working = false
        }
    }
}

/// The short summary that rides along in every conversation, and the
/// organizer that keeps the memory behind it tidy.
struct MemoryProfileScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var inFlight: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("The assistant reads this summary at the start of every conversation, so it knows the basics without searching.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let card = model.workspace?.memory.card {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(card.content)
                            .font(.subheadline)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Updated \(relative(card.compiledAt))").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .assistantCard(in: colorScheme)
                } else {
                    AssistantEmptyState("No summary yet", systemImage: "person.text.rectangle",
                                        description: "One is written once there are a few things to summarise.")
                }
                Button {
                    run("recompile")
                } label: {
                    HStack(spacing: 7) {
                        if inFlight == "recompile" { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
                        Text(inFlight == "recompile" ? "Rewriting…" : "Rewrite summary")
                    }
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                .disabled(inFlight != nil)

                if let memory = model.workspace?.memory {
                    MemoryOrganizerPanel(
                        pendingCount: memory.health.notYetOrganized,
                        latest: memory.latestOrganizer,
                        requestInFlight: inFlight == "organize"
                    ) { run("organize") }
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle("Profile summary")
        .assistantSubmenuChrome()
        .refreshable { await model.refreshWorkspace() }
    }

    private func run(_ action: String) {
        inFlight = action
        Task {
            _ = await model.updateMemoryProfile(action: action)
            inFlight = nil
        }
    }
}

/// How the assistant writes when it drafts for the owner, and the samples it
/// learned that from.
struct WritingVoiceScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var register = "email_casual"
    @State private var importing = false
    @State private var editing = false
    @State private var inFlight = false
    @State private var confirmingClear = false
    @State private var response: VoiceProfileResponse?
    @State private var loaded = false

    private var stats: WorkspaceVoiceStats? {
        response?.voiceStats ?? model.workspace?.memory.voiceStats
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AssistantTheme.cardStackSpacing) {
                Text("Help the assistant draft in your own words.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)

                if let stats {
                    voiceCard
                    samplesCard(stats)
                } else if !loaded {
                    AssistantLoadingState(title: "Loading writing voice…")
                } else {
                    AssistantEmptyState("Writing voice unavailable", systemImage: "text.quote",
                        description: "This server doesn’t report writing samples yet.")
                }
            }
            .padding(AssistantTheme.compactGutter)
            .padding(.bottom, 28)
        }
        .navigationTitle("Writing voice")
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            if let stats, stats.total > 0 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Clear all samples", systemImage: "trash", role: .destructive) {
                            confirmingClear = true
                        }
                    } label: {
                        Label("Writing voice actions", systemImage: "ellipsis")
                    }
                    .disabled(inFlight)
                }
            }
        }
        .confirmationDialog("Clear all writing samples?", isPresented: $confirmingClear, titleVisibility: .visible) {
            Button("Clear all samples", role: .destructive) {
                inFlight = true
                Task {
                    if await model.updateMemoryProfile(action: "purge-voice") {
                        response = nil
                        await refresh()
                    }
                    inFlight = false
                }
            }
        } message: {
            Text("This deletes every writing sample and the learned voice profile.")
        }
        .refreshable { await refresh() }
        .task { if !loaded { await refresh() } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, .json, .data], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { model.reportError(error) }
                return
            }
            upload(url)
        }
        .sheet(isPresented: $editing, onDismiss: { Task { await refresh() } }) {
            NavigationStack { VoiceProfileEditor() }
        }
    }

    private var voiceCard: some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            Text("Your voice").font(.headline)
            if !loaded && response == nil {
                ProgressView("Loading your voice…")
                    .font(.subheadline)
            } else if let profile = response?.voiceProfile {
                Text(profile.description.isEmpty
                    ? "Describe your tone, or add sent messages to help the assistant learn it."
                    : profile.description)
                    .font(.subheadline)
                    .foregroundStyle(profile.description.isEmpty
                        ? AssistantTheme.inkMuted(for: colorScheme) : AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                if !profile.dos.isEmpty || !profile.donts.isEmpty || !profile.signature.isEmpty {
                    DisclosureGroup("Writing preferences") {
                        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                            voiceGuidelines("Always", lines: profile.dos)
                            voiceGuidelines("Never", lines: profile.donts)
                            if !profile.signature.isEmpty {
                                voiceGuidelines("Sign-off", lines: [profile.signature])
                            }
                        }
                    }
                    .font(.subheadline)
                }
            } else {
                Text("Your voice profile couldn’t be loaded.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button("Try again") { Task { await refresh() } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                    .disabled(inFlight)
            }
            Divider()
            Button("Edit voice", systemImage: "pencil") { editing = true }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                .disabled(inFlight)
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func voiceGuidelines(_ title: String, lines: [String]) -> some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func samplesCard(_ stats: WorkspaceVoiceStats) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            Text("Writing samples").font(.headline)
            Text("Add messages you’ve sent. The assistant also learns from drafts you approve.")
                .font(.subheadline).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            AssistantFlowLayout(spacing: 14) {
                Text("\(stats.total) samples")
                Text("\(stats.auto) learned")
                Text("\(stats.uploaded) uploaded")
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            Divider()
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: AssistantTheme.actionSpacing) {
                        Text("Message type").font(.subheadline)
                        sampleTypePicker
                    }
                } else {
                    HStack(spacing: AssistantTheme.actionSpacing) {
                        Text("Message type").font(.subheadline)
                        Spacer(minLength: 0)
                        sampleTypePicker
                    }
                }
            }
            .disabled(inFlight)
            Button { importing = true } label: {
                Label(inFlight ? "Updating…" : "Add sent messages", systemImage: "plus")
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .primary))
            .disabled(inFlight)
            Text("Text or JSON files, up to 25 MB.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .assistantCard(in: colorScheme)
    }

    private var sampleTypePicker: some View {
        Picker("Message type", selection: $register) {
            Text("Casual email").tag("email_casual")
            Text("Professional email").tag("email_professional")
            Text("Text messages").tag("sms")
            Text("Chat").tag("chat")
        }
        .pickerStyle(.menu)
        .labelsHidden()
    }

    private func refresh() async {
        await model.refreshWorkspace()
        if let updated = await model.voiceProfile() { response = updated }
        loaded = true
    }

    private func upload(_ url: URL) {
        inFlight = true
        Task {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                guard data.count <= 25 * 1024 * 1024 else {
                    model.errorMessage = "Writing sample uploads must be 25 MB or smaller."
                    inFlight = false
                    return
                }
                if await model.uploadImport(data: data, name: url.lastPathComponent, voice: true, register: register) {
                    await refresh()
                }
            } catch {
                model.reportError(error)
            }
            inFlight = false
        }
    }
}

/// A maintenance receipt, not a second dashboard. Keep raw run details
/// available without making a completed maintenance log lead the memory page.
struct MemoryOrganizerPanel: View {
    let pendingCount: Int
    let latest: WorkspaceMemoryOrganizer?
    let requestInFlight: Bool
    let organize: () -> Void
    @State var showsDetails = false
    @Environment(\.colorScheme) private var colorScheme

    static func statusLabel(_ status: String?) -> String {
        switch status {
        case "done": "Last run completed"
        case "pending", "running": "Organizing memory"
        case "failed": "Last run failed"
        case "cancelled": "Last run stopped"
        case nil: "Ready to organize"
        default: "Organizer update"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                AssistantGlyph(systemName: "tray.2", tint: AssistantTheme.accent(for: colorScheme), variant: .inline)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Memory organizer").font(.subheadline.weight(.semibold))
                    Text(Self.statusLabel(latest?.status)).font(.caption)
                        .foregroundStyle(latest?.status == "failed"
                            ? AssistantTheme.errorInk(for: colorScheme) : AssistantTheme.inkMuted(for: colorScheme))
                }
            }
            if pendingCount > 0 {
                Text("\(pendingCount) \(pendingCount == 1 ? "fact is" : "facts are") waiting to be organized.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
            if let latest {
                DisclosureGroup("Run details", isExpanded: $showsDetails) {
                    VStack(alignment: .leading, spacing: 8) {
                        if !latest.progress.isEmpty {
                            Text(latest.progress).font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text("Updated \(relative(latest.updatedAt))").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)
                .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
            }
            Button(action: organize) {
                HStack(spacing: 7) {
                    if requestInFlight { ProgressView().controlSize(.small) }
                    else { Image(systemName: "sparkles") }
                    Text(requestInFlight ? "Updating…" : "Organize now")
                }
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            .disabled(requestInFlight)
        }
        .assistantPanel(in: colorScheme)
    }
}

/// Everything you can change about one person: relationship, aliases, their
/// dates, merging a duplicate away. Reached from Memory and from the People
/// directory, which is why it takes an id rather than a workspace row — People
/// has a PersonCard in hand, not the same struct Memory does.
struct PersonDetailsView: View {
    let personId: String
    let personName: String

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingOccasionEditor = false
    @State private var editingOccasion: PersonOccasion?
    /// Suggestions already saved in this sitting. The profile only reloads on
    /// the next fetch, so without this a just-saved date stays on offer.
    @State private var savedSuggestions: Set<String> = []
    @State private var editingContact: PersonProfileContact?
    @State private var mergeTarget = ""
    @State private var isWorking = false

    private var profile: PersonProfileResponse? { model.personProfiles[personId] }

    var body: some View {
        AssistantForm {
            if let profile {
                Section("Details") {
                    LabeledContent("Relationship", value: profile.contact.relationship.isEmpty
                        ? "Not set"
                        : profile.contact.relationship)
                    if !profile.contact.aliases.isEmpty {
                        LabeledContent("Aliases", value: profile.contact.aliases.joined(separator: ", "))
                    }
                    Button("Edit name and relationship", systemImage: "pencil") {
                        editingContact = profile.contact
                    }
                }

                Section {
                    if profile.occasions.isEmpty {
                        Text("No birthdays or anniversaries saved.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(profile.occasions) { occasion in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(occasion.label.isEmpty
                                    ? occasion.kind.sentenceCaseIdentifier
                                    : occasion.label)
                                Text(occasionDate(occasion))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                AssistantFlowLayout(spacing: 8) {
                                    if occasion.quarantined {
                                        Button("Approve", systemImage: "checkmark") {
                                            review(occasion, verdict: "approve")
                                        }
                                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                                        AssistantConfirmationButton("Reject", systemImage: "xmark", compact: true) {
                                            review(occasion, verdict: "reject")
                                        }
                                    }
                                    Button("Edit", systemImage: "pencil") { editingOccasion = occasion }
                                        .buttonStyle(AssistantActionButtonStyle(kind: .neutral, compact: true))
                                    AssistantConfirmationButton("Delete", compact: true) {
                                        delete(occasion)
                                    }
                                }
                                .disabled(isWorking)
                            }
                        }
                    }
                    Button("Add occasion", systemImage: "calendar.badge.plus") {
                        showingOccasionEditor = true
                    }
                    // Dates the extractor already found in this person's facts
                    // but that are not recurring reminders yet. The endpoint
                    // has always sent them; web offers the same one-tap save.
                    if !visibleSuggestions(profile).isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Found in saved facts — save any of these as a recurring reminder:")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            AssistantFlowLayout(spacing: 8) {
                                ForEach(visibleSuggestions(profile)) { suggestion in
                                    Button {
                                        save(suggestion)
                                    } label: {
                                        Text("+ \(suggestionLabel(suggestion))")
                                            .font(.caption)
                                    }
                                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                                    .disabled(isWorking)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Important dates")
                }

                if !profile.mergeOptions.isEmpty {
                    Section {
                        Picker("Merge into", selection: $mergeTarget) {
                            Text("Choose a person").tag("")
                            ForEach(profile.mergeOptions) { option in
                                Text(option.label).tag(option.id)
                            }
                        }
                        AssistantConfirmationButton("Merge person", systemImage: "person.2", hint: "Moves all saved facts to the selected person and removes this duplicate.") {
                            guard !mergeTarget.isEmpty else { return }
                            isWorking = true
                            Task {
                                let merged = await model.mergePerson(id: personId, targetId: mergeTarget)
                                isWorking = false
                                if merged { dismiss() }
                            }
                        }
                        .id(mergeTarget)
                        .disabled(isWorking || mergeTarget.isEmpty)
                    } header: {
                        // Web badges this as "possible duplicate" with the
                        // reason; without it the phone gave no clue why these
                        // merge options were being offered at all.
                        if let duplicate = profile.duplicate {
                            Label("Possible duplicate — \(duplicate.reason)", systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        } else {
                            Text("Merge")
                        }
                    } footer: {
                        Text("Moves every saved fact onto the selected person and removes this duplicate.")
                    }
                }

                Section {
                    AssistantConfirmationButton(
                        "Delete \(personName)",
                        confirmationTitle: "Delete for good",
                        hint: "Removes this person and every fact saved about them.",
                        fillsWidth: true
                    ) {
                        isWorking = true
                        let deleted = await model.deletePerson(id: personId)
                        isWorking = false
                        if deleted { dismiss() }
                    }
                    .disabled(isWorking)
                } header: {
                    Text("Remove")
                } footer: {
                    Text("This cannot be undone.")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(personName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task { await model.loadPersonProfile(id: personId) }
        .sheet(isPresented: $showingOccasionEditor) {
            NavigationStack { OccasionEditor(personId: personId) }
        }
        .sheet(item: $editingOccasion) { occasion in
            NavigationStack { OccasionEditor(personId: personId, occasion: occasion) }
        }
        .sheet(item: $editingContact) { contact in
            NavigationStack { PersonEditor(contact: contact) }
        }
    }

    private func visibleSuggestions(
        _ profile: PersonProfileResponse
    ) -> [PersonOccasionSuggestion] {
        (profile.occasionSuggestions ?? []).filter { !savedSuggestions.contains($0.id) }
    }

    private func suggestionLabel(_ suggestion: PersonOccasionSuggestion) -> String {
        let date = Calendar.current.date(from: DateComponents(year: 2024, month: suggestion.month, day: suggestion.day))
        let day = date.map(AssistantFormatters.monthAndDay.string(from:))
            ?? "\(suggestion.month)/\(suggestion.day)"
        return "\(day) · \(suggestion.kind)"
    }

    private func save(_ suggestion: PersonOccasionSuggestion) {
        isWorking = true
        Task {
            let saved = await model.addOccasion(
                personId: personId,
                mutation: OccasionMutation(
                    kind: suggestion.kind,
                    label: "",
                    month: String(suggestion.month),
                    day: String(suggestion.day),
                    year: "",
                    leadDays: "7",
                    notes: ""
                )
            )
            isWorking = false
            if saved { savedSuggestions.insert(suggestion.id) }
        }
    }

    private func occasionDate(_ occasion: PersonOccasion) -> String {
        let month = AssistantFormatters.monthSymbols[max(0, min(11, occasion.month - 1))]
        return [month, String(occasion.day), occasion.year.map { String($0) }]
            .compactMap { $0 }
            .joined(separator: " ")
    }

    private func review(_ occasion: PersonOccasion, verdict: String) {
        isWorking = true
        Task {
            _ = await model.reviewOccasion(
                personId: personId,
                occasion: occasion,
                verdict: verdict
            )
            isWorking = false
        }
    }

    private func delete(_ occasion: PersonOccasion) {
        isWorking = true
        Task {
            _ = await model.deleteOccasion(personId: personId, occasion: occasion)
            isWorking = false
        }
    }
}

struct OccasionEditor: View {
    let personId: String
    let occasion: PersonOccasion?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var kind = "birthday"
    @State private var label = ""
    @State private var month = ""
    @State private var day = ""
    @State private var year = ""
    @State private var leadDays = "7"
    @State private var notes = ""
    @State private var isSaving = false
    @State private var failure: String?

    init(personId: String, occasion: PersonOccasion? = nil) {
        self.personId = personId
        self.occasion = occasion
        _kind = State(initialValue: occasion?.kind ?? "birthday")
        _label = State(initialValue: occasion?.label ?? "")
        _month = State(initialValue: occasion.map { String($0.month) } ?? "")
        _day = State(initialValue: occasion.map { String($0.day) } ?? "")
        _year = State(initialValue: occasion?.year.map { String($0) } ?? "")
        _leadDays = State(initialValue: String(occasion?.leadDays ?? 7))
        _notes = State(initialValue: occasion?.notes ?? "")
    }

    var body: some View {
        AssistantForm {
            Section("Occasion") {
                Picker("Type", selection: $kind) {
                    Text("Birthday").tag("birthday")
                    Text("Anniversary").tag("anniversary")
                    Text("Other").tag("custom")
                }
                if kind == "custom" { LabeledContent("Label") { TextField("Occasion name", text: $label).multilineTextAlignment(.trailing) } }
                Picker("Month", selection: $month) {
                    Text("Choose month").tag("")
                    ForEach(1...12, id: \.self) { number in
                        Text(AssistantFormatters.monthSymbols[number - 1]).tag(String(number))
                    }
                }
                LabeledContent("Day") { TextField("Day", text: $day).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                LabeledContent("Year (optional)") { TextField("Unknown", text: $year).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                LabeledContent("Remind days before") { TextField("7", text: $leadDays).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                LabeledContent("Notes") { TextField("Gift ideas", text: $notes, axis: .vertical).multilineTextAlignment(.trailing) }
            }
            .disabled(isSaving)
            if let failure {
                Section { Text(failure).foregroundStyle(AssistantTheme.errorInk(for: colorScheme)) }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .navigationTitle(occasion == nil ? "Add occasion" : "Edit occasion")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || month.isEmpty || day.isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        failure = nil
        Task {
            let saved = await model.addOccasion(
                personId: personId,
                mutation: .init(
                    kind: kind,
                    label: label,
                    month: month,
                    day: day,
                    year: year,
                    leadDays: leadDays,
                    notes: notes
                ),
                occasionId: occasion?.id
            )
            isSaving = false
            if saved { dismiss() } else { failure = model.errorMessage ?? "Couldn’t save this date. Try again." }
        }
    }
}

struct PersonEditor: View {
    /// The id being edited; nil creates a new person.
    private let personId: String?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var relationship: String
    @State private var aliases: String
    @State private var isSaving = false

    init(person: WorkspacePerson?) {
        personId = person?.id
        _name = State(initialValue: person?.name ?? "")
        _relationship = State(initialValue: person?.relationship ?? "")
        _aliases = State(initialValue: person?.aliases.joined(separator: ", ") ?? "")
    }

    /// The same editor from a loaded profile, which is what the People
    /// directory has rather than a workspace row.
    init(contact: PersonProfileContact) {
        personId = contact.id
        _name = State(initialValue: contact.name)
        _relationship = State(initialValue: contact.relationship)
        _aliases = State(initialValue: contact.aliases.joined(separator: ", "))
    }

    var body: some View {
        AssistantForm {
            Section("Person") {
                AssistantField("Name") {
                    TextField("Name", text: $name)
                }
                AssistantField("Relationship") {
                    TextField("Relationship", text: $relationship)
                }
                AssistantField("Aliases") {
                    TextField("Aliases, separated by commas", text: $aliases, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
        }
        .navigationTitle(personId == nil ? "Add person" : "Edit person")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.savePerson(
                id: personId,
                mutation: .init(name: name, relationship: relationship, aliases: aliases)
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}

struct MemoryEditor: View {
    private let ownerContactId: String
    /// The fact being corrected; nil creates a new one.
    private let factId: String?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var domain: String
    @State private var importance: Int
    @State private var pinned: Bool
    @State private var isSaving = false

    init(ownerContactId: String, fact: WorkspaceMemoryFact?) {
        self.ownerContactId = ownerContactId
        factId = fact?.id
        _content = State(initialValue: fact?.content ?? "")
        _domain = State(initialValue: fact?.domain ?? "other")
        _importance = State(initialValue: fact?.importance ?? 3)
        _pinned = State(initialValue: fact?.pinned ?? false)
    }

    /// Correcting a row from the library, which carries the same fields under a
    /// different type. Creation never starts here, so no owner contact is needed.
    init(row: MemoryLibraryRow) {
        ownerContactId = ""
        factId = row.id
        _content = State(initialValue: row.content)
        _domain = State(initialValue: row.domain.isEmpty ? "other" : row.domain)
        _importance = State(initialValue: row.importance)
        _pinned = State(initialValue: row.pinned)
    }

    var body: some View {
        AssistantForm {
            Section(factId == nil ? "New fact" : "Correction") {
                TextField("Something durable the assistant should remember", text: $content, axis: .vertical)
                    .lineLimit(3...8)
            }
            if factId == nil {
                Section("How it should be used") {
                    Picker("Topic", selection: $domain) {
                        ForEach(["identity", "work", "home", "relationships", "preferences", "health", "other"], id: \.self) { value in
                            Text(value.sentenceCaseIdentifier).tag(value)
                        }
                    }
                    Picker("Importance", selection: $importance) {
                        Text("Very high").tag(5)
                        Text("High").tag(4)
                        Text("Normal").tag(3)
                        Text("Low").tag(2)
                        Text("Minor").tag(1)
                    }
                    Toggle("Keep in profile summary", isOn: $pinned)
                }
            }
        }
        .navigationTitle(factId == nil ? "Add memory" : "Correct memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || content.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let succeeded: Bool
            if let factId {
                succeeded = await model.correctMemory(id: factId, content: content)
            } else {
                succeeded = await model.createMemory(MemoryMutation(
                    content: content,
                    domain: domain,
                    importance: importance,
                    pinned: pinned,
                    subjectContactId: ownerContactId
                ))
            }
            isSaving = false
            if succeeded { dismiss() }
        }
    }
}

/// Dates are editable where people are read, without a detour through Memory.
struct PersonDatesScreen: View {
    let personId: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var editing: PersonOccasion?
    @State private var adding = false

    var body: some View {
        AssistantForm {
            if let profile = model.personProfiles[personId] {
                Section("Important dates") {
                    ForEach(profile.occasions) { occasion in
                        Button { editing = occasion } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(occasion.label.isEmpty ? occasion.kind.sentenceCaseIdentifier : occasion.label)
                                    Text("\(AssistantFormatters.monthSymbols[max(0, min(11, occasion.month - 1))]) \(occasion.day)" + (occasion.year.map { ", \($0)" } ?? ""))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "pencil").accessibilityLabel("Edit")
                            }.frame(minHeight: 44)
                        }.buttonStyle(.plain)
                    }
                    Button("Add birthday or occasion", systemImage: "calendar.badge.plus") { adding = true }
                }
            } else {
                ProgressView("Loading dates…")
                Button("Try again") { Task { await model.loadPersonProfile(id: personId) } }
            }
        }
        .navigationTitle("Important dates")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task { await model.loadPersonProfile(id: personId) }
        .sheet(item: $editing) { occasion in
            NavigationStack { OccasionEditor(personId: personId, occasion: occasion) }
        }
        .sheet(isPresented: $adding) { NavigationStack { OccasionEditor(personId: personId) } }
    }
}
