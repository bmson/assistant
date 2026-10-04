import SwiftUI

/// The People directory.
///
/// Everything on screen arrives already worded by `/api/mobile/v1/people`:
/// "18 March · turns 40 in 7 months", "Last contact today", "10 years". The
/// rules behind those — when a birth year may become an age, when a start date
/// is precise enough to become a duration — are decided once in the
/// application layer, so this screen and the web read identically and cannot
/// drift apart. Nothing here formats a date or infers a fact.
struct PeopleView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var showsVisualGraph = false
    @State private var showsPersonCreator = false

    private var matches: [PersonSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.people.filter { person in
            needle.isEmpty || person.name.localizedStandardContains(needle)
                || person.relationship.localizedStandardContains(needle)
                || (person.location?.localizedStandardContains(needle) ?? false)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private var groups: [PersonGroupSection] {
        ["family", "work", "friends", "other"].compactMap { key in
            let people = matches.filter {
                key == "other" ? !["family", "work", "friends"].contains($0.group) : $0.group == key
            }
            guard !people.isEmpty else { return nil }
            let label = people.first?.groupLabel ?? ""
            return PersonGroupSection(label: key == "other" || label.isEmpty ? "Other people" : label, people: people)
        }
    }

    private var comingUp: [PersonSummary] {
        model.people.filter {
            guard let days = $0.birthdayDaysUntil else { return false }
            return (0...30).contains(days)
        }.sorted {
            let first = $0.birthdayDaysUntil ?? .max
            let second = $1.birthdayDaysUntil ?? .max
            return first == second
                ? $0.name.localizedStandardCompare($1.name) == .orderedAscending
                : first < second
        }
    }

    var body: some View {
        AssistantSettingsList {
            if !model.peopleLoaded {
                AssistantLoadingState(title: "Loading people…")
            } else if model.people.isEmpty {
                Section {
                    AssistantEmptyState("No people yet", systemImage: "person.2",
                        description: "Add someone here, or mention them in a conversation.")
                    Button("Add person", systemImage: "plus") { showsPersonCreator = true }
                }
            } else {
                if !comingUp.isEmpty && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section {
                        DisclosureGroup {
                            ForEach(comingUp) { person in
                                NavigationLink(value: AssistantDestination.person(id: person.id)) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(person.name).font(.subheadline.weight(.semibold))
                                        if let birthday = person.birthday {
                                            Text(birthday).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    .padding(.vertical, 4)
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                }
                            }
                        } label: {
                            Label("Upcoming birthdays (\(comingUp.count))", systemImage: "gift")
                                .font(.subheadline)
                        }
                    }
                }

                if matches.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    ForEach(groups) { group in
                        Section {
                            ForEach(group.people) { person in
                                NavigationLink(value: AssistantDestination.person(id: person.id)) {
                                    personRow(person)
                                }
                            }
                        } header: {
                            HStack {
                                Text(group.label)
                                Spacer()
                                Text("\(group.people.count)").monospacedDigit()
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("People")
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    NavigationLink {
                        PeopleConnectionsScreen()
                    } label: {
                        Label("Explore connections", systemImage: "person.2")
                    }
                    Button("Relationship graph", systemImage: "circle.hexagongrid") {
                        showsVisualGraph = true
                    }
                    .accessibilityIdentifier("assistant.people.visual-graph")
                } label: {
                    Label("People actions", systemImage: "ellipsis")
                }
                .disabled(model.people.isEmpty)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add person", systemImage: "plus") { showsPersonCreator = true }
            }
        }
        .sheet(isPresented: $showsPersonCreator) {
            NavigationStack { PersonEditor(person: nil) }
        }
        .fullScreenCover(isPresented: $showsVisualGraph) {
            NavigationStack { RelationshipGraphScreen() }
        }
        .searchable(text: $query, prompt: "Name, relationship, or place")
        .refreshable { await model.loadPeople() }
        .task { if !model.peopleLoaded { await model.loadPeople() } }
    }

    private func personRow(_ person: PersonSummary) -> some View {
        HStack(alignment: .center, spacing: AssistantTheme.cardContentSpacing) {
            PersonInitialsBadge(initials: person.initials)
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                if !person.relationship.isEmpty {
                    Text(person.relationship)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let details = [person.location, person.lastContact,
                    person.trust == "unknown" ? "Unverified" : nil]
                    .compactMap { $0 }.filter { !$0.isEmpty }
                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
    }
}

/// Connection exploration stays available without taking over the directory.
private struct PeopleConnectionsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var focusedPersonID: String?

    private var matches: [PersonSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.people.filter { needle.isEmpty || $0.name.localizedStandardContains(needle)
            || $0.relationship.localizedStandardContains(needle)
            || ($0.location?.localizedStandardContains(needle) ?? false) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        ScrollView {
            PeopleConnectionsExplorer(people: matches, query: $query) { focusedPersonID = $0 }
                .padding(AssistantTheme.compactGutter)
                .padding(.bottom, 28)
        }
        .navigationTitle("Connections")
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .searchable(text: $query, prompt: "Name, relationship, or place")
        .refreshable {
            await model.loadPeople()
            if let id = focusedPersonID { await model.loadPersonCard(id: id) }
        }
    }
}

/// One heading in the directory. A named type rather than a tuple so `ForEach`
/// has a stable `Identifiable` conformance to key rows off.
private struct PersonGroupSection: Identifiable {
    let label: String
    let people: [PersonSummary]
    var id: String { label }
}

/// An initials disc. There is no photograph anywhere in the data model, so
/// this is an identity marker rather than a placeholder for a missing image.
struct PersonInitialsBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let initials: String
    var size: CGFloat = 40

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.34, weight: .medium, design: .rounded))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Presentation groups only: no graph facts are merged, discarded, or marked
/// confirmed. Older servers send sentences without predicate metadata, so the
/// compact role recognizes only the presenter's exact family grammar with both
/// endpoint names. Unknown/custom wording stays under recorded details.
struct PersonRelationGroup: Identifiable {
    let id: String
    let relations: [PersonRelationSummary]
    let roles: [String]
    let relationshipIDs: Set<String>

    var representative: PersonRelationSummary { relations[0] }
    var relationshipEvidence: [PersonRelationSummary] {
        relations.filter { relationshipIDs.contains($0.id) }
    }
    var otherDetails: [PersonRelationSummary] {
        relations.filter { !relationshipIDs.contains($0.id) }
    }

    static func group(_ relations: [PersonRelationSummary], personName: String) -> [Self] {
        // Prefer identity over spelling. Name-only entries remain unlinked;
        // grouping their display never invents a contact/navigation target.
        let grouped = Dictionary(grouping: relations) {
            $0.otherContactId.map { "contact:\($0)" } ?? "name:\($0.otherLabel)"
        }
        var seen = Set<String>()
        return relations.compactMap { relation in
            let key = relation.otherContactId.map { "contact:\($0)" } ?? "name:\(relation.otherLabel)"
            guard seen.insert(key).inserted, let entries = grouped[key] else { return nil }
            let labeled = entries.compactMap { entry -> (String, String)? in
                role(entry, personName: personName).map { (entry.id, $0) }
            }
            var roles = Set(labeled.map(\.1))
            for (generic, specific) in [
                ("Parent", ["Father", "Mother"]), ("Child", ["Son", "Daughter"]),
                ("Sibling", ["Brother", "Sister"]),
                ("Grandparent", ["Grandfather", "Grandmother"]),
                ("Grandchild", ["Grandson", "Granddaughter"])
            ] where !roles.isDisjoint(with: specific) {
                roles.remove(generic)
            }
            return Self(id: key, relations: entries, roles: roles.sorted(),
                relationshipIDs: Set(labeled.map(\.0)))
        }
    }

    static func role(_ relation: PersonRelationSummary, personName: String) -> String? {
        let inverse = [
            "father": "Child", "mother": "Child", "parent": "Child",
            "son": "Parent", "daughter": "Parent", "child": "Parent",
            "brother": "Sibling", "sister": "Sibling", "sibling": "Sibling",
            "grandfather": "Grandchild", "grandmother": "Grandchild", "grandparent": "Grandchild",
            "grandson": "Grandparent", "granddaughter": "Grandparent", "grandchild": "Grandparent",
            "spouse": "Spouse", "partner": "Partner", "cousin": "Cousin"
        ]
        func possessive(_ name: String) -> String { name.hasSuffix("s") ? "\(name)'" : "\(name)'s" }
        let sentence = relation.sentence
        for (role, opposite) in inverse {
            if sentence == "\(relation.otherLabel) is \(possessive(personName)) \(role)."
                || sentence == "\(relation.otherLabel) is \(possessive(personName)) is \(role)." {
                return role.capitalized
            }
            if sentence == "\(personName) is \(possessive(relation.otherLabel)) \(role)." {
                return opposite
            }
        }
        for (plural, role) in [("spouses", "Spouse"), ("partners", "Partner"),
            ("siblings", "Sibling"), ("cousins", "Cousin")] {
            if sentence == "\(personName) and \(relation.otherLabel) are \(plural)."
                || sentence == "\(relation.otherLabel) and \(personName) are \(plural)." {
                return role
            }
        }
        return nil
    }
}

struct PersonRelationGroupCard: View {
    let group: PersonRelationGroup
    var inspectEvidence: ((PersonRelationSummary) -> Void)?
    @Environment(\.colorScheme) private var colorScheme
    @State private var showsRelationships = false
    @State private var showsDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let otherId = group.representative.otherContactId {
                NavigationLink(value: AssistantDestination.person(id: otherId)) {
                    identity(linked: true)
                }.buttonStyle(.plain)
            } else {
                identity(linked: false)
            }
            evidence(group.relationshipEvidence, title: "Relationship evidence", expanded: $showsRelationships)
            evidence(group.otherDetails, title: "Recorded details", expanded: $showsDetails)
        }
        .assistantCard(in: colorScheme)
    }

    private func identity(linked: Bool) -> some View {
        HStack(spacing: 10) {
            PersonInitialsBadge(initials: group.representative.otherInitials, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(group.representative.otherLabel).font(.subheadline.weight(.semibold))
                if !group.roles.isEmpty {
                    Text(group.roles.joined(separator: ", "))
                        .font(.caption).foregroundStyle(.secondary)
                    let spans = Set(group.relationshipEvidence.map(\.span).filter { !$0.isEmpty }).sorted()
                    if !spans.isEmpty {
                        Text(spans.joined(separator: "; ")).font(.caption).foregroundStyle(.secondary)
                    }
                    if group.relationshipEvidence.contains(where: \.unreviewed) {
                        Text(group.relationshipEvidence.allSatisfy(\.unreviewed)
                            ? "Not yet confirmed" : "Some details not yet confirmed")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 8)
            if linked {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func evidence(_ entries: [PersonRelationSummary], title: String, expanded: Binding<Bool>) -> some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withTransaction(TranscriptDisclosure.transaction()) {
                        expanded.wrappedValue.toggle()
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text("\(title) (\(entries.count))")
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(expanded.wrappedValue ? 90 : 0))
                            .accessibilityHidden(true)
                    }
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed")
                if expanded.wrappedValue {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(entries) { relation in
                            if let inspectEvidence {
                                Button { inspectEvidence(relation) } label: {
                                    HStack(spacing: 12) {
                                        evidenceLabel(relation)
                                        Spacer(minLength: 0)
                                        Image(systemName: "chevron.right")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                            .accessibilityHidden(true)
                                    }
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("View the source, edit, or remove this relationship")
                            } else {
                                evidenceLabel(relation)
                            }
                        }
                    }.padding(.top, 8)
                }
            }
        }
    }

    private func evidenceLabel(_ relation: PersonRelationSummary) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(relation.sentence).font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            if !relation.span.isEmpty {
                Text(relation.span).font(.caption).foregroundStyle(.secondary)
            }
            if relation.unreviewed {
                Text("Not yet confirmed").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

/// Inspect one exact source-backed claim, not every claim about the same person.
struct PersonRelationshipEvidenceScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    let evidence: PersonRelationSummary
    let didChange: () async -> Void
    @State private var relation: KnowledgeRelation?
    @State private var loading = true
    @State private var removing = false
    @State private var editing = false
    @State private var corrected = false
    @State private var failure: String?

    var body: some View {
        AssistantForm {
            Section("Relationship") {
                Text(relation?.presentation.sentence ?? evidence.sentence)
                    .font(.body)
                if !evidence.span.isEmpty {
                    Text(evidence.span).font(.caption).foregroundStyle(.secondary)
                }
            }
            if loading {
                ProgressView("Loading evidence…")
            } else if let relation {
                Section("Source evidence") {
                    Text(relation.source.content).textSelection(.enabled)
                    Text(relation.source.ownerConfirmed ? "Owner-confirmed source" : "Recorded source")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if relation.reviewStatus == "rejected" {
                    Section {
                        Text("This relationship has been removed. Its original source is retained.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        Button("Edit relationship", systemImage: "pencil") { editing = true }
                            .disabled(removing)
                        AssistantConfirmationButton("Remove relationship", hint: "Other claims and the original source stay saved.") {
                            removing = true
                            failure = nil
                            if await model.removeKnowledgeRelation(id: evidence.id) {
                                await didChange()
                                dismiss()
                            } else {
                                failure = "The relationship could not be removed. Please try again."
                            }
                            removing = false
                        }
                        .disabled(removing)
                    } footer: {
                        Text("Changes apply only to this claim. Other relationships and the original source are kept.")
                    }
                }
            } else {
                Section {
                    Text("The evidence could not be loaded. It may have been removed, or your server may need updating.")
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                }
            }
            if let failure {
                Section { Text(failure).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Relationship evidence")
        .tint(AssistantTheme.accent(for: colorScheme))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }.disabled(removing)
            }
        }
        .interactiveDismissDisabled(removing)
        .task { await load() }
        .sheet(isPresented: $editing, onDismiss: {
            if corrected { dismiss() }
        }) {
            if let relation {
                NavigationStack {
                    KnowledgeConnectionEditor(
                        selected: relation.subject, relationToCorrect: relation,
                        candidates: [relation.subject, relation.object]
                    ) {
                        await didChange()
                        // Close the inspector after the editor finishes dismissing,
                        // returning to the refreshed card rather than a retired claim.
                        corrected = true
                    }
                }
            }
        }
    }

    private func load() async {
        loading = true
        relation = await model.knowledgeRelation(id: evidence.id)
        loading = false
    }
}

/// One person, in full: identity, birthday and how you met, grouped connections,
/// and recent happenings, with direct access to relationship evidence.
struct PersonCardScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    let personId: String
    @State private var inspectingEvidence: PersonRelationSummary?
    @State private var showsDates = false
    @State private var showsTree = false
    @State private var showsManage = false

    private var card: PersonCard? { model.personCards[personId] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let card {
                    cardContent(card)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 220)
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle(card?.name ?? "Person")
        .navigationBarTitleDisplayMode(.inline)
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Edit person", systemImage: "pencil") { showsManage = true }
                    Button(card?.birthday == nil ? "Add birthday" : "Edit birthday", systemImage: "calendar") {
                        showsDates = true
                    }
                    Button("Explore relationships", systemImage: "circle.hexagongrid") { showsTree = true }
                } label: {
                    Label("Person actions", systemImage: "ellipsis")
                }
                .disabled(card == nil)
            }
        }
        .sheet(isPresented: $showsManage) {
            if let card {
                NavigationStack {
                    PersonDetailsView(personId: personId, personName: card.name)
                }
            }
        }
        .refreshable { await model.loadPersonCard(id: personId) }
        .task(id: card == nil) { if card == nil { await model.loadPersonCard(id: personId) } }
        .sheet(isPresented: $showsDates) {
            NavigationStack { PersonDatesScreen(personId: personId) }
        }
        .fullScreenCover(isPresented: $showsTree) {
            NavigationStack { RelationshipGraphScreen(personID: personId) }
        }
        .sheet(item: $inspectingEvidence) { evidence in
            NavigationStack {
                PersonRelationshipEvidenceScreen(evidence: evidence) {
                    await model.refreshPersonEvidence(id: personId)
                }
            }
        }
    }

    @ViewBuilder
    private func cardContent(_ card: PersonCard) -> some View {
        identity(card)
        if card.birthday != nil || !card.howWeMet.isEmpty {
            VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                if let birthday = card.birthday {
                    detailRow(icon: "gift", label: "Birthday", value: birthday)
                }
                if !card.howWeMet.isEmpty {
                    detailRow(
                        icon: "hand.wave",
                        label: "How you met",
                        value: card.howWeMet.joined(separator: "\n")
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantPanel(in: colorScheme)
        }

        let groups = PersonRelationGroup.group(card.relations, personName: card.name)
        let family = groups.filter { !$0.roles.isEmpty }
        let other = groups.filter { $0.roles.isEmpty }
        if !family.isEmpty {
            VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                sectionHeading("Relationships", count: family.count)
                ForEach(family) { group in
                    PersonRelationGroupCard(group: group) { inspectingEvidence = $0 }
                }
            }
        }

        if !other.isEmpty {
            VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                sectionHeading("Other people mentioned", count: other.count)
                ForEach(other) { group in
                    PersonRelationGroupCard(group: group) { inspectingEvidence = $0 }
                }
            }
        }

        if !card.connections.isEmpty {
            VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                sectionHeading("Also connected", count: card.connections.count)
                ForEach(card.connections) { connection in
                    HStack(alignment: .top, spacing: 10) {
                        Text(connection.sentence).font(.subheadline)
                        Spacer(minLength: 8)
                        if !connection.span.isEmpty {
                            Text(connection.span).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .assistantCard(in: colorScheme)
                }
            }
        }

        if !card.events.isEmpty {
            VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
                sectionHeading("Recently", count: card.events.count)
                ForEach(card.events) { event in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "sparkles")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(event.content)
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(
                                event.dateIsRecordTime
                                    ? "\(event.date) · as recorded"
                                    : event.date
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .assistantCard(in: colorScheme)
                }
                Text("What happened is kept for 90 days; lasting details are saved as facts.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }

        // Only ever backed by a real occasion inside its own lead window —
        // the same one that reaches the morning brief.
        if let reminder = card.reminder {
            VStack(alignment: .leading, spacing: 4) {
                Text(reminder.headline).font(.subheadline.weight(.semibold))
                Text(reminder.detail).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantCard(
                in: colorScheme,
                surface: AssistantTheme.accent(for: colorScheme).opacity(0.07),
                strokeTint: AssistantTheme.accent(for: colorScheme).opacity(0.28)
            )
        }

        Text("\(card.factCount) saved \(card.factCount == 1 ? "fact" : "facts")")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func identity(_ card: PersonCard) -> some View {
        HStack(alignment: .top, spacing: AssistantTheme.cardContentSpacing) {
            PersonInitialsBadge(initials: card.initials, size: 56)
            VStack(alignment: .leading, spacing: 5) {
                Text(card.name).font(.title3.weight(.semibold))
                if !identityLine(card).isEmpty {
                    Text(identityLine(card)).font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                AssistantFlowLayout(spacing: AssistantTheme.actionSpacing) {
                    if !card.groupLabel.isEmpty {
                        Text(card.groupLabel)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 6)
                            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                    }
                    if card.trust == "unknown" {
                        Text("Unverified")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 6)
                            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    private func identityLine(_ card: PersonCard) -> String {
        let parts = [
            card.relationship.isEmpty ? nil : card.relationship,
            card.location,
            card.lastContact,
        ].compactMap { $0 }
        return parts.joined(separator: " · ")
    }

    private func detailRow(icon: String, label: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.headline)
            if let count {
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }
        }
    }
}

#if DEBUG
extension PeopleView {
    @MainActor static func visualReviewConnections() -> AnyView { AnyView(PeopleConnectionsScreen()) }
}
#endif
