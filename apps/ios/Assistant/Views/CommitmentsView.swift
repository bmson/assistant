import SwiftUI

/// Open follow-ups, with one primary action and shared overflow controls.
struct CommitmentsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var rows: [Commitment] = []
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var pendingIDs: Set<String> = []
    @State private var correcting: Commitment?
    @State private var showingGuide = false
    @State private var dismissingLoop: Commitment?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AssistantTheme.cardStackSpacing) {
                Text("Follow-ups, questions, and promises still waiting to be closed.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 8)
                if !loaded {
                    if loadFailed {
                        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                            Text("Open loops couldn’t be loaded.").font(.subheadline)
                            Button("Try again") { Task { await load() } }
                                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                        }
                        .assistantPanel(in: colorScheme)
                    } else {
                        AssistantLoadingState(title: "Loading open loops")
                    }
                } else if rows.isEmpty {
                    AssistantEmptyState(
                        "Nothing is waiting for your attention",
                        systemImage: "checkmark.circle",
                        description: "Decisions, questions and follow-ups appear here when the assistant is still holding one open.")
                } else {
                    ForEach(rows) { row in loopCard(row) }
                }
            }
            .padding(AssistantTheme.compactGutter)
            .padding(.bottom, 28)
        }
        .navigationTitle("Open loops")
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("About open loops", systemImage: "questionmark.circle") { showingGuide = true }
            }
        }
        .sheet(isPresented: $showingGuide) {
            NavigationStack {
                ScrollView {
                    loopGuide.padding(AssistantTheme.compactGutter)
                }
                .navigationTitle("About open loops")
                .assistantEditorChrome()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showingGuide = false }
                    }
                }
            }
        }
        .confirmationDialog(
            "Dismiss this loop?",
            isPresented: Binding(
                get: { dismissingLoop != nil },
                set: { if !$0 { dismissingLoop = nil } }
            ),
            titleVisibility: .visible,
            presenting: dismissingLoop
        ) { row in
            Button("Not relevant", role: .destructive) { act(row, action: "dismiss") }
        } message: { row in
            Text("This removes “\(row.title)” from your open loops.")
        }
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(item: $correcting) { row in
            NavigationStack { CommitmentEditor(commitment: row, onSaved: { Task { await load() } }) }
        }
    }

    /// Detailed guidance stays available without preceding every follow-up.
    private var loopGuide: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Loops are the threads the assistant is still holding from your conversations — something you decided, asked, promised, or are waiting on. They stay here until you close them: **Done** resolves a loop, **Later** hides it for a day, **Correct** fixes what the assistant misheard, and **Not relevant** drops it for good. A loop you never touch retires itself eventually, and how long that takes depends on the kind.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup("What the labels mean") {
                VStack(alignment: .leading, spacing: 10) {
                    legendRow(
                        title: "Decision",
                        description: "a choice you settled that is worth remembering.",
                        retires: "90 days")
                    legendRow(
                        title: "Question",
                        description: "something left unanswered.",
                        retires: "30 days")
                    legendRow(
                        title: "Promise",
                        description: "a concrete follow-up you said you would do.",
                        retires: "45 days")
                    legendRow(
                        title: "Waiting on",
                        description: "a reply, approval, or document you need from someone else.",
                        retires: "30 days")
                    Text("A loop that named a due date retires two weeks after it, whatever kind it is.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.subheadline.weight(.semibold))
        }
        .assistantPanel(in: colorScheme)
    }

    /// The retirement window is part of what the label means — a kind the
    /// assistant forgets in a month is a different promise to the owner than
    /// one it holds for a quarter, and this is the only screen that says so.
    private func legendRow(title: String, description: String, retires: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(description)
                .font(.caption)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            Text("Retires after \(retires) untouched")
                .font(.caption2)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        }
    }

    private func loopCard(_ row: Commitment) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            AssistantFlowLayout(spacing: AssistantTheme.actionSpacing) {
                Text(kindLabel(row.kind))
                    .font(.caption.weight(.semibold))
                if let due = dueLabel(row) {
                    Label(due, systemImage: "calendar")
                        .font(.caption)
                }
            }
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))

            Text(row.title)
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if !row.nextAction.isEmpty {
                Text("Next: \(row.nextAction)")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            HStack(spacing: AssistantTheme.actionSpacing) {
                Button("Done", systemImage: "checkmark") { act(row, action: "resolve") }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                Spacer(minLength: 0)
                Menu {
                    Button("Later (1 day)", systemImage: "clock") { act(row, action: "snooze") }
                    Button("Correct", systemImage: "pencil") { correcting = row }
                    Divider()
                    Button("Not relevant", systemImage: "xmark", role: .destructive) {
                        dismissingLoop = row
                    }
                } label: {
                    AssistantActionMenuLabel(isUpdating: pendingIDs.contains(row.id))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Actions for \(row.title)")
            }
            .disabled(pendingIDs.contains(row.id))
        }
        .assistantCard(in: colorScheme)
    }

    /// `sentenceCaseIdentifier` title-cases every word of a machine
    /// identifier, which turns `waiting_on` into "Waiting On". Every other
    /// kind here is already one capitalized word, so only this one needs its
    /// own mapping rather than a change to the shared helper.
    private func kindLabel(_ kind: String) -> String {
        kind == "waiting_on" ? "Waiting on" : kind.sentenceCaseIdentifier
    }

    private func dueLabel(_ row: Commitment) -> String? {
        guard let date = row.dueAt?.assistantDate else { return nil }
        return "Due \(AssistantFormatters.mediumDate.string(from: date))"
    }

    private func act(_ row: Commitment, action: String) {
        Task { await perform(row, action: action) }
    }

    private func perform(_ row: Commitment, action: String) async {
        guard pendingIDs.insert(row.id).inserted else { return }
        defer { pendingIDs.remove(row.id) }
        if await model.updateCommitment(CommitmentMutation(action: action, id: row.id)) {
            await load()
        }
    }

    private func load() async {
        loadFailed = false
        if let result = await model.commitments() {
            rows = result
            loaded = true
        } else {
            loadFailed = true
        }
    }
}

/// Correcting a loop rather than closing it: the assistant heard it slightly
/// wrong and the owner is fixing the record. A title is required, matching the
/// web form and the route, since an empty one would blank the loop's only
/// identifying text.
struct CommitmentEditor: View {
    let commitment: Commitment
    let onSaved: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var nextAction: String
    @State private var isSaving = false

    init(commitment: Commitment, onSaved: @escaping () -> Void) {
        self.commitment = commitment
        self.onSaved = onSaved
        _title = State(initialValue: commitment.title)
        _details = State(initialValue: commitment.details)
        _nextAction = State(initialValue: commitment.nextAction)
    }

    var body: some View {
        AssistantForm {
            Section("What you actually said") {
                AssistantField("Title") {
                    TextField("Title", text: $title, axis: .vertical)
                }
                AssistantField("Details") {
                    TextField("Details", text: $details, axis: .vertical)
                }
                AssistantField("Next action") {
                    TextField("Next action", text: $nextAction, axis: .vertical)
                }
            }
            .disabled(isSaving)
        }
        .interactiveDismissDisabled(isSaving)
        .navigationTitle("Correct this loop")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(
                        isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.updateCommitment(
                CommitmentMutation(
                    action: "correct",
                    id: commitment.id,
                    title: title,
                    details: details,
                    nextAction: nextAction
                )
            )
            isSaving = false
            if saved {
                onSaved()
                dismiss()
            }
        }
    }
}

#if DEBUG
extension CommitmentsScreen {
    @MainActor static func visualReviewGuide() -> AnyView {
        var view = CommitmentsScreen()
        view._showingGuide = State(initialValue: true)
        return AnyView(view)
    }
}
#endif
