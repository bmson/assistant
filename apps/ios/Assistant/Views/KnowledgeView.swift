import SwiftUI

/// Housekeeping for the knowledge map: derived items that lost their source,
/// connections nobody has confirmed, facts that expired or were superseded.
/// Browsing and editing connections happens on the map itself; this is the
/// short list of things that need a decision.
struct KnowledgeCleanupScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var cleanup: KnowledgeCleanupResponse?
    @State private var pendingIDs: Set<String> = []
    @State private var loadFailed = false
    @State private var forgettingFinding: KnowledgeCleanupFinding?
    @State private var clearingFinding: KnowledgeCleanupFinding?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AssistantTheme.cardStackSpacing) {
                Text("Review new connections and clear outdated information.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 8)
                if let cleanup, cleanup.findings.isEmpty {
                    AssistantEmptyState("All tidy", systemImage: "checkmark.seal",
                                        description: "Nothing on your map needs a decision right now.")
                } else if let cleanup {
                    ForEach(cleanup.findings) { finding in cleanupCard(finding) }
                } else if loadFailed {
                    VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                        Text("Your map couldn’t be checked.").font(.subheadline)
                        Button("Try again") { Task { await refresh() } }
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                    }
                    .assistantPanel(in: colorScheme)
                } else {
                    AssistantLoadingState(title: "Checking your map")
                }
            }
            .padding(AssistantTheme.compactGutter)
            .padding(.bottom, 28)
        }
        .navigationTitle("Tidy up")
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .sheet(item: $forgettingFinding) { finding in
            if let memoryId = finding.memoryId {
                NavigationStack {
                    KnowledgeForgetReview(memoryId: memoryId) { await refresh() }
                }
            }
        }
        .confirmationDialog(
            "Clear disconnected items?",
            isPresented: Binding(
                get: { clearingFinding != nil },
                set: { if !$0 { clearingFinding = nil } }
            ),
            titleVisibility: .visible,
            presenting: clearingFinding
        ) { finding in
            Button("Clear items", role: .destructive) {
                Task { await resolve(action: "remove-orphans", finding: finding) }
            }
        } message: { finding in
            Text(finding.detail)
        }
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func cleanupCard(_ finding: KnowledgeCleanupFinding) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            Text(finding.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(finding.detail).font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            HStack(spacing: AssistantTheme.actionSpacing) {
                primaryAction(finding)
                Spacer(minLength: 0)
                if finding.memoryId != nil {
                    Menu {
                        Button("Forget source", systemImage: "trash", role: .destructive) {
                            forgettingFinding = finding
                        }
                    } label: {
                        AssistantActionMenuLabel(isUpdating: pendingIDs.contains(finding.id))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Actions for \(finding.title)")
                }
            }
            .disabled(pendingIDs.contains(finding.id))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func primaryAction(_ finding: KnowledgeCleanupFinding) -> some View {
        switch finding.kind {
        case "projection_orphan":
            Button("Clear items", systemImage: "trash") { clearingFinding = finding }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        case "projection_failed":
            Button("Retry", systemImage: "arrow.clockwise") { Task { await resolve(action: "retry", finding: finding) } }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        case "unreviewed_connection":
            if let relationId = finding.relationId {
                Button("Confirm", systemImage: "checkmark") {
                    guard pendingIDs.insert(finding.id).inserted else { return }
                    Task {
                        defer { pendingIDs.remove(finding.id) }
                        if await model.reviewKnowledgeRelation(id: relationId, approve: true) {
                            await refresh()
                        }
                    }
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
            }
        case "quarantined":
            Button("Approve", systemImage: "checkmark") { Task { await resolve(action: "approve", finding: finding) } }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
        case "expired", "superseded":
            if finding.memoryId != nil {
                Button("Keep", systemImage: "checkmark.shield") { Task { await resolve(action: "keep", finding: finding) } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
            }
        default:
            EmptyView()
        }
    }

    private func refresh() async {
        loadFailed = false
        if let result = await model.knowledgeCleanup() { cleanup = result }
        else { loadFailed = true }
    }

    private func resolve(action: String, finding: KnowledgeCleanupFinding) async {
        guard pendingIDs.insert(finding.id).inserted else { return }
        defer { pendingIDs.remove(finding.id) }
        if await model.resolveKnowledgeCleanup(action: action, memoryId: finding.memoryId) {
            await refresh()
        }
    }
}

struct KnowledgeConnectionEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var subject: KnowledgeEntity
    let relationToCorrect: KnowledgeRelation?
    let candidates: [KnowledgeEntity]
    let didSave: () async -> Void
    @State private var objectLabel: String
    @State private var objectKind: String
    @State private var objectId: String?
    @State private var objectIdLabel: String
    @State private var objectIdKind: String
    @State private var predicate: String
    @State private var customPredicate = ""
    @State private var note = ""
    @State private var saving = false
    @State private var saveError: String?
    @State private var familySuggestions: [GraphFamilySuggestion] = []
    @State private var showFamilySuggestions = false

    init(
        selected: KnowledgeEntity,
        relationToCorrect: KnowledgeRelation? = nil,
        initialObject: KnowledgeEntity? = nil,
        candidates: [KnowledgeEntity],
        didSave: @escaping () async -> Void
    ) {
        _subject = State(initialValue: selected)
        self.relationToCorrect = relationToCorrect
        self.candidates = candidates
        self.didSave = didSave
        _objectLabel = State(initialValue: (relationToCorrect?.object ?? initialObject)?.displayLabel ?? "")
        _objectKind = State(initialValue: (relationToCorrect?.object ?? initialObject)?.kind ?? "person")
        _objectId = State(initialValue: (relationToCorrect?.object ?? initialObject)?.id)
        _objectIdLabel = State(initialValue: (relationToCorrect?.object ?? initialObject)?.displayLabel ?? "")
        _objectIdKind = State(initialValue: (relationToCorrect?.object ?? initialObject)?.kind ?? "person")
        let initialKind = (relationToCorrect?.object ?? initialObject)?.kind ?? "person"
        let options = Self.relationshipOptions(subjectKind: selected.kind, objectKind: initialKind)
        if let relationToCorrect, !options.contains(where: { $0.id == relationToCorrect.predicate })
        {
            _predicate = State(initialValue: "__custom")
            _customPredicate = State(initialValue: relationToCorrect.predicate)
        } else {
            _predicate = State(
                initialValue: relationToCorrect?.predicate ?? "__choose")
        }
    }

    var body: some View {
        AssistantForm {
            Section {
                Text(
                    "Say how these two are related. A correction keeps the original source for reference."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Section("First item") {
                Text(subject.displayLabel)
                Text(subject.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(
                    .secondary)
            }
            Section("Connected item") {
                TextField("Name", text: $objectLabel)
                    .onChange(of: objectLabel) { _, value in
                        if value != objectIdLabel { objectId = nil }
                    }
                Picker("Type", selection: $objectKind) {
                    ForEach(
                        ["person", "organization", "project", "place", "event", "date", "topic"],
                        id: \.self
                    ) { Text($0.sentenceCaseIdentifier).tag($0) }
                }
                .onChange(of: objectKind) { _, value in
                    if value != objectIdKind { objectId = nil }
                    let allowed = Self.relationshipOptions(
                        subjectKind: subject.kind, objectKind: value)
                    if predicate != "__custom" && !allowed.contains(where: { $0.id == predicate }) {
                        predicate = "__choose"
                    }
                }
                if !candidates.isEmpty {
                    Menu("Choose an existing item") {
                        ForEach(candidates.prefix(30)) { item in
                            Button(item.displayLabel) {
                                objectLabel = item.displayLabel
                                objectKind = item.kind
                                objectIdLabel = item.displayLabel
                                objectIdKind = item.kind
                                objectId = item.id
                            }
                        }
                    }
                }
            }
            Section("Relationship") {
                if relationToCorrect == nil, let objectId {
                    Button("Swap direction", systemImage: "arrow.up.arrow.down") {
                        let previous = subject
                        subject = .init(id: objectId, label: objectLabel, kind: objectKind, canonicalKey: objectId)
                        objectLabel = previous.displayLabel; objectKind = previous.kind
                        objectIdLabel = previous.displayLabel; objectIdKind = previous.kind
                        self.objectId = previous.id; predicate = "__choose"
                    }
                }
                Picker("Relationship", selection: $predicate) {
                    Text("Choose a relationship…").tag("__choose")
                    ForEach(relationshipOptions, id: \.id) { option in
                        Text(option.label).tag(option.id)
                    }
                    Text("Use my own words…").tag("__custom")
                }
                if predicate == "__custom" {
                    TextField("e.g. advises", text: $customPredicate)
                }
                Text("This will say: \(previewSentence)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Note (optional)") {
                TextField("How you know, e.g. met at university", text: $note, axis: .vertical)
                    .lineLimit(2...5)
            }
            if let saveError {
                Section { Text(saveError).foregroundStyle(.red) }
            }
        }
        .navigationTitle(relationToCorrect == nil ? "Add connection" : "Correct connection")
        .navigationBarTitleDisplayMode(.inline)
        .tint(AssistantTheme.accent(for: colorScheme))
        .interactiveDismissDisabled(saving)
        .sheet(isPresented: $showFamilySuggestions, onDismiss: {
            Task { dismiss(); await didSave(); saving = false }
        }) {
            NavigationStack { GraphFamilySuggestionsSheet(suggestions: familySuggestions) }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(saving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { save() }
                    .disabled(
                        saving || predicate == "__choose" || objectId == subject.id
                            || objectLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || (predicate == "__custom"
                                && customPredicate.trimmingCharacters(in: .whitespacesAndNewlines)
                                    .isEmpty))
            }
        }
    }

    private func save() {
        saving = true
        saveError = nil
        let mutation = KnowledgeConnectionMutation(
            subjectLabel: subject.label,
            subjectKind: subject.kind,
            subjectId: subject.id,
            predicate: storedPredicate,
            objectLabel: objectLabel,
            objectKind: objectKind,
            objectId: objectId,
            note: note
        )
        Task {
            let saved: Bool
            if let relationToCorrect {
                saved = await model.correctKnowledgeRelation(id: relationToCorrect.id, mutation: mutation)
            } else if let relationID = await model.createKnowledgeConnectionID(mutation) {
                saved = true
                model.invalidatePersonCaches()
                if GraphFamilySuggestion.canTrigger(mutation.predicate), let graph = await model.relationshipGraph() {
                    familySuggestions = GraphFamilySuggestionDismissals.remaining(graph.familyConnectionSuggestions(triggerRelationID: relationID))
                    if !familySuggestions.isEmpty { showFamilySuggestions = true; return }
                }
            } else { saved = false }
            if saved {
                dismiss()
                await didSave()
            } else {
                saveError =
                    "The relationship could not be saved. Your changes are still here; please try again."
            }
            saving = false
        }
    }

    private var storedPredicate: String {
        predicate == "__custom" ? customPredicate : predicate
    }

    private var relationshipOptions: [(id: String, label: String)] {
        Self.relationshipOptions(subjectKind: subject.kind, objectKind: objectKind)
    }

    static func relationshipOptions(subjectKind: String, objectKind: String) -> [(
        id: String, label: String
    )] {
        switch (subjectKind, objectKind) {
        case ("person", "person"):
            return [
                ("father_of", "is the father of"),
                ("mother_of", "is the mother of"),
                ("parent_of", "is the parent of"),
                ("child_of", "is the child of"),
                ("daughter_of", "is the daughter of"),
                ("son_of", "is the son of"),
                ("spouse_of", "is the spouse of"),
                ("partner_of", "is the partner of"),
                ("brother_of", "is the brother of"),
                ("sister_of", "is the sister of"),
                ("sibling_of", "is the sibling of"),
                ("grandmother_of", "is the grandmother of"),
                ("grandfather_of", "is the grandfather of"),
                ("grandparent_of", "is the grandparent of"),
                ("grandson_of", "is the grandson of"),
                ("granddaughter_of", "is the granddaughter of"),
                ("grandchild_of", "is the grandchild of"),
                ("aunt_of", "is the aunt of"),
                ("uncle_of", "is the uncle of"),
                ("niece_of", "is the niece of"),
                ("nephew_of", "is the nephew of"),
                ("cousin_of", "is the cousin of"),
                ("friend_of", "is a friend of"),
                ("colleague_of", "is a colleague of"),
                ("met", "met"),
            ]
        case ("person", "organization"):
            return [
                ("works_at", "works at"), ("worked_at", "worked at"), ("studies_at", "studies at"),
                ("studied_at", "studied at"), ("graduated_from", "graduated from"), ("interned_at", "interned at"),
            ]
        case ("organization", "person"):
            return [("employs", "employs")]
        case ("person", "place"):
            return [
                ("lives_in", "lives in"), ("born_in", "was born in"), ("grew_up_in", "grew up in"),
                ("met_at", "met at"),
            ]
        case ("person", "event"):
            return [("attended", "attended"), ("attends", "attends"), ("met_at", "met at"), ("met_during", "met during")]
        case ("event", "person"):
            return [("attended_by", "was attended by")]
        case ("event", "place"):
            return [("happens_at", "happens at")]
        case ("event", "date"), ("project", "date"):
            return [
                ("happens_on", "happens on"), ("starts_on", "starts on"), ("ends_on", "ends on"),
            ]
        case ("person", "date"):
            return [
                ("born_on", "was born on"), ("engaged_on", "got engaged on"), ("married_on", "married on"), ("divorced_on", "divorced on"), ("died_on", "died on"),
            ]
        case ("organization", "place"), ("project", "place"):
            return [("based_in", "is based in")]
        default:
            return []
        }
    }

    private var previewSentence: String {
        if predicate == "__choose" { return "Choose how these items are connected." }
        return Self.previewSentence(
            subject: subject.displayLabel, predicate: storedPredicate, objectLabel: objectLabel)
    }

    static func previewSentence(subject: String, predicate: String, objectLabel: String) -> String {
        let object = objectLabel.isEmpty ? "the connected item" : objectLabel
        switch predicate {
        case "daughter_of": return "\(subject) is \(object)’s daughter."
        case "son_of": return "\(subject) is \(object)’s son."
        case "spouse_of": return "\(subject) and \(object) are spouses."
        case "works_at": return "\(subject) works at \(object)."
        case "worked_at": return "\(subject) worked at \(object)."
        case "parent_of": return "\(subject) is \(object)’s parent."
        case "lives_in": return "\(subject) lives in \(object)."
        case "attended": return "\(subject) attended \(object)."
        default:
            if predicate.hasSuffix("_of") {
                let role = predicate.dropLast(3).replacingOccurrences(of: "_", with: " ")
                return "\(subject) is \(object)’s \(role)."
            }
            return
                "\(subject) \(predicate.replacingOccurrences(of: "_", with: " ")) \(object)."
        }
    }
}

struct KnowledgeItemEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: KnowledgeEntity
    let duplicates: [KnowledgeDuplicate]
    let didSave: (String) async -> Void
    @State private var label: String
    @State private var kind: String
    @State private var mergeTargetId = ""
    @State private var mergeTargetLabel = ""
    @State private var mergeSearch = ""
    @State private var mergeResults: [KnowledgeEntity] = []
    @State private var searchTask: Task<Void, Never>?
    @State private var searching = false
    @State private var saving = false

    init(
        item: KnowledgeEntity, duplicates: [KnowledgeDuplicate],
        didSave: @escaping (String) async -> Void
    ) {
        self.item = item
        self.duplicates = duplicates
        self.didSave = didSave
        _label = State(initialValue: item.displayLabel)
        _kind = State(initialValue: item.kind)
    }

    var body: some View {
        AssistantForm {
            Section("Display name") { TextField("Name", text: $label) }
            Section("Type") {
                Picker("Type", selection: $kind) {
                    ForEach(
                        ["person", "organization", "project", "place", "event", "date", "topic"],
                        id: \.self
                    ) { Text($0.sentenceCaseIdentifier).tag($0) }
                }
            }
            // Not gated on duplicates any more. The server only flags likely
            // duplicates, so an item it had not paired could not be merged from
            // the phone at all, while the web form has always searched the whole
            // graph. Suggestions stay as one-tap shortcuts when they exist.
            Section("Merge into another item") {
                if mergeTargetId.isEmpty {
                    ForEach(duplicates) { duplicate in
                        Button {
                            mergeTargetId = duplicate.targetId
                            mergeTargetLabel = duplicate.label.replacingOccurrences(
                                of: "_", with: " ")
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(duplicate.label.replacingOccurrences(of: "_", with: " "))
                                Text("Suggested — \(duplicate.reason)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .frame(minHeight: 44)
                    }
                    TextField("Search every item", text: $mergeSearch)
                        .autocorrectionDisabled()
                        .onChange(of: mergeSearch) { _, value in scheduleSearch(value) }
                    if searching {
                        Text("Searching…").font(.caption).foregroundStyle(.secondary)
                    } else if !mergeResults.isEmpty {
                        ForEach(mergeResults) { entity in
                            Button {
                                mergeTargetId = entity.id
                                mergeTargetLabel = entity.displayLabel
                                mergeSearch = ""
                                mergeResults = []
                            } label: {
                                HStack {
                                    Text(entity.displayLabel)
                                    Spacer(minLength: 8)
                                    Text(entity.kind.sentenceCaseIdentifier)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .frame(minHeight: 44)
                        }
                    } else if mergeSearch.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 {
                        Text("No other items match.").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    LabeledContent("Merging into", value: mergeTargetLabel)
                    Button("Keep separate") {
                        mergeTargetId = ""
                        mergeTargetLabel = ""
                    }
                    .frame(minHeight: 44)
                }
                Text(
                    "Merging keeps its source-backed connections and uses the selected item as the surviving record."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Edit item")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { save() }.disabled(saving || label.isEmpty)
            }
        }
    }

    /// Debounced, and cancelling: without cancellation a slower earlier query
    /// could land after a later one and replace the results actually typed for.
    private func scheduleSearch(_ query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            mergeResults = []
            searching = false
            return
        }
        searching = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let result = await model.searchKnowledge(query: trimmed)
            guard !Task.isCancelled else { return }
            // Never offer the item as its own merge target.
            mergeResults = (result ?? []).filter { $0.id != item.id }
            searching = false
        }
    }

    private func save() {
        saving = true
        Task {
            let renamed: Bool
            if label == item.displayLabel {
                renamed = true
            } else {
                renamed = await model.updateKnowledgeItem(
                    id: item.id, action: "rename", value: label)
            }
            let retyped: Bool
            if kind == item.kind {
                retyped = true
            } else {
                retyped = await model.updateKnowledgeItem(
                    id: item.id, action: "retype", value: kind)
            }
            let merged: Bool
            if mergeTargetId.isEmpty {
                merged = true
            } else {
                merged = await model.mergeKnowledgeItem(id: item.id, targetId: mergeTargetId)
            }
            saving = false
            if renamed && retyped && merged {
                await didSave(mergeTargetId.isEmpty ? item.id : mergeTargetId)
                dismiss()
            }
        }
    }
}

/// Preview the exact source and affected knowledge before removal.
private struct KnowledgeForgetReview: View {
    let memoryId: String
    let didForget: () async -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var impact: KnowledgeSourceImpact?
    @State private var loading = true
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        AssistantForm {
            if loading {
                Section { ProgressView("Checking affected information…") }
            } else if let impact {
                Section("Source to forget") {
                    Text(impact.content).font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Section {
                    LabeledContent("Active connections", value: "\(impact.activeConnections)")
                    LabeledContent("Disconnected items", value: "\(impact.orphanedItems.count)")
                    if impact.retiredProjections > 0 {
                        LabeledContent("Older map entries", value: "\(impact.retiredProjections)")
                    }
                    if !impact.orphanedItems.isEmpty {
                        DisclosureGroup("Affected items") {
                            ForEach(impact.orphanedItems) { item in
                                Text(item.label).font(.subheadline)
                            }
                        }
                    }
                } header: {
                    Text("This will remove")
                } footer: {
                    Text("The assistant won’t learn this source again from the same text.")
                }
                Section {
                    Button("Forget source", systemImage: "trash", role: .destructive) {
                        working = true
                        failure = nil
                        Task {
                            if await model.forgetKnowledgeSource(id: impact.memoryId) {
                                await didForget()
                                dismiss()
                            } else {
                                failure = "The source could not be removed. Please try again."
                            }
                            working = false
                        }
                    }
                    .disabled(working)
                }
            } else {
                Section {
                    Text("Couldn’t check the affected information.")
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                }
            }
            if let failure {
                Section { Text(failure).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Forget source")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(working)
            }
        }
        .interactiveDismissDisabled(working)
        .task { await load() }
    }

    private func load() async {
        loading = true
        impact = await model.knowledgeSourceImpact(id: memoryId)
        loading = false
    }
}

/// A dismissal stores only the proposal's stable entity IDs, never the names
/// or source notes. It prevents the same declined family claim being repeated.
@MainActor
enum GraphFamilySuggestionDismissals {
    static let key = "assistant.graph.dismissedFamilySuggestions"
    static func ids() -> Set<String> {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode(Set<String>.self, from: data)) ?? []
    }
    static func remaining(_ suggestions: [GraphFamilySuggestion]) -> [GraphFamilySuggestion] {
        let dismissed = ids()
        return suggestions.filter { !dismissed.contains($0.id) }
    }
    static func dismiss(_ id: String) {
        var next = ids(); next.insert(id)
        UserDefaults.standard.set(try? JSONEncoder().encode(next), forKey: key)
    }
}

struct GraphFamilySuggestionsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var suggestions: [GraphFamilySuggestion]
    @State private var handled = Set<String>()
    @State private var working: String?
    @State private var failure: String?
    @State private var added = 0

    init(suggestions: [GraphFamilySuggestion]) { _suggestions = State(initialValue: suggestions) }

    var body: some View {
        List {
            Section {
                Text("These may follow from your recorded family connections. Review each one before adding it.")
                Text("Siblings can share one parent or both. These suggestions do not assume which.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(suggestions) { suggestion in
                Section {
                    Text(suggestion.sentence).font(.headline)
                    Text(suggestion.reason).font(.subheadline).foregroundStyle(.secondary)
                    DisclosureGroup("Based on recorded connections") {
                        ForEach(suggestion.support) { source in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(source.sentence).font(.footnote)
                                if source.reviewStatus != "confirmed" { Text("Not reviewed yet").font(.caption).foregroundStyle(.secondary) }
                                DisclosureGroup("Source note") { Text(source.sourceContent).font(.footnote).foregroundStyle(.secondary) }
                            }
                        }
                    }
                    Button {
                        Task { await accept(suggestion) }
                    } label: {
                        if working == suggestion.id { ProgressView("Adding…") }
                        else { Label("Add connection", systemImage: "plus") }
                    }
                    .disabled(working != nil)
                    Button("Not right") {
                        GraphFamilySuggestionDismissals.dismiss(suggestion.id)
                        handled.insert(suggestion.id)
                        suggestions.removeAll { $0.id == suggestion.id }
                    }
                    .disabled(working != nil)
                }
            }
            if suggestions.isEmpty {
                Section { Text(added == 0 ? "No more suggestions to review." : "\(added) connection\(added == 1 ? "" : "s") added.") }
            }
            if let failure {
                Section { Text(failure).foregroundStyle(.red) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .tint(AssistantTheme.accent(for: colorScheme))
        .navigationTitle("Family suggestions")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(working != nil)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(working != nil) } }
    }

    private func accept(_ suggestion: GraphFamilySuggestion) async {
        guard working == nil else { return }
        working = suggestion.id; failure = nil
        defer { working = nil }
        // Re-read before writing: edits or rejection on another screen must
        // not turn an obsolete suggestion into a new owner-confirmed fact.
        guard let fresh = await model.relationshipGraph() else {
            failure = "Couldn’t check the recorded connections. Nothing was added. Try again."
            return
        }
        let eligibleIDs = Set(fresh.edges.filter { ["confirmed", "unreviewed"].contains($0.reviewStatus) && $0.validFrom == nil && $0.validUntil == nil }.map(\.id))
        guard suggestion.support.allSatisfy({ eligibleIDs.contains($0.id) }),
              let current = fresh.familyConnectionSuggestions(matchingSuggestionID: suggestion.id).first,
              current.predicate == suggestion.predicate else {
            suggestions.removeAll { $0.id == suggestion.id }
            failure = "That suggestion changed or is already recorded. It was not added."
            return
        }
        guard let relationID = await model.createKnowledgeConnectionID(current.mutation) else {
            failure = "Couldn’t add this connection. Try again."
            return
        }
        handled.insert(suggestion.id); added += 1
        suggestions.removeAll { $0.id == suggestion.id }
        model.invalidatePersonCaches()
        // Each accepted connection can offer another small, reviewable step;
        // proposed connections never become evidence before they are saved.
        if let updated = await model.relationshipGraph() {
            let next = GraphFamilySuggestionDismissals.remaining(updated.familyConnectionSuggestions(triggerRelationID: relationID))
            let shown = Set(suggestions.map(\.id)).union(handled)
            suggestions.append(contentsOf: next.filter { !shown.contains($0.id) })
        }
    }
}

#if DEBUG
extension KnowledgeCleanupScreen {
    @MainActor static func visualReviewForget() -> AnyView {
        AnyView(KnowledgeForgetReview(memoryId: "fact-1", didForget: {}))
    }
}
#endif
