import SwiftUI

/// The relationship map, full screen.
///
/// It opens on the whole map and stays out of the way: a close button, find,
/// and one options menu float over the canvas, and everything else is done by
/// touching the map itself. Tap an item to see what it is and who it touches;
/// tap one of those to walk the graph; hold an item and drag to another to
/// connect them. Large text sizes and VoiceOver get the same map as a list.
struct RelationshipGraphScreen: View {
    var personID: String? = nil
    var entityID: String? = nil
    /// A snapshot already on hand — the Memory home's preview — so the map
    /// opens drawn instead of blank while it refreshes.
    var initialGraph: RelationshipGraphSnapshot? = nil
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var graph = RelationshipGraphSnapshot.empty
    @State private var selectedID: String?
    @State private var loading = false
    @State private var hasLoaded = false
    @State private var failure: String?
    @State private var requestID = UUID()
    @State private var command = GraphCanvasCommand()
    @State private var listView = false
    @State private var showSettings = false
    @State private var showSearch = false
    @State private var showGroups = false
    @State private var showConnections = false
    @State private var connecting: RelationshipGraphNode?
    @State private var quickConnect: GraphConnectionDraft?
    @State private var editingItem: RelationshipGraphNode?
    @State private var notice: String?
    @State private var cardHeight: CGFloat = 0
    @State private var loadedAt: Date?
    /// Items recently looked at. They survive when the map is full and has to
    /// let something go, so walking back retraces familiar ground.
    @State private var trail: [String] = []
    @AppStorage("assistant.graph.gestureHintSeen") private var hintSeen = false
    /// The owner is connected to nearly everything, so their own dot pulls the
    /// whole map into one star. Hidden by default, as Obsidian users tend to
    /// hide their own note; one toggle, or picking yourself, brings it back.
    @AppStorage("assistant.graph.showMe") private var showMe = false
    /// Groups, filters, display and forces, tuned in the settings panel and
    /// shared with the Memory home's preview.
    @AppStorage(GraphSettings.defaultsKey) private var settingsData = Data()

    private var usesList: Bool { listView || dynamicTypeSize.isAccessibilitySize }
    private var selected: RelationshipGraphNode? { graph.nodes.first { $0.id == selectedID } }
    /// The owner's own item on the map, when the workspace says who that is.
    private var ownerNodeID: String? {
        guard let owner = model.workspace?.memory.ownerContactId else { return nil }
        return graph.nodes.first { $0.contactId == owner }?.id
    }
    private var settings: GraphSettings { GraphSettings(data: settingsData) }
    private var settingsBinding: Binding<GraphSettings> {
        Binding(get: { GraphSettings(data: settingsData) }, set: { settingsData = $0.data })
    }
    private var visible: RelationshipGraphSnapshot {
        graph.filtered(by: settings, hiding: showMe ? nil : ownerNodeID, keeping: selectedID)
    }
    /// Every kind on the loaded map, with how many of each, in a fixed order
    /// so the legend does not reshuffle as the map grows.
    private var kinds: [GraphKindCount] {
        let counts = Dictionary(grouping: graph.nodes, by: \.kind).mapValues(\.count)
        let order = ["person", "place", "organization", "project", "event", "topic"]
        return counts.keys.sorted {
            let a = order.firstIndex(of: $0) ?? order.count, b = order.firstIndex(of: $1) ?? order.count
            return a != b ? a < b : $0 < $1
        }.map { GraphKindCount(kind: $0, count: counts[$0] ?? 0) }
    }
    private var selectedEdges: [RelationshipGraphEdge] {
        guard let selectedID else { return [] }
        return graph.edges.filter { $0.reviewStatus != "rejected" && ($0.subjectId == selectedID || $0.objectId == selectedID) }
    }

    var body: some View {
        Group {
            if usesList { readableList } else { map }
        }
        .tint(AssistantTheme.accent(for: colorScheme))
        .task { if !hasLoaded { await load() } }
        .task(id: scenePhase) {
            // While the map is open and the app is in front, what the
            // assistant learns keeps arriving: a quiet re-read every so often
            // blooms new items into place without moving the owner's view.
            guard scenePhase == .active else { return }
            if let loadedAt, Date().timeIntervalSince(loadedAt) > 60 { await refresh() }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(90)) } catch { return }
                await refresh()
            }
        }
        .onChange(of: settings.hiddenKinds) { _, hidden in
            if let selected, hidden.contains(selected.kind) { selectedID = nil }
            send(.fit)
        }
        .onChange(of: settings.showOrphans) { _, _ in send(.fit) }
        .onChange(of: showMe) { _, shown in
            if !shown, selectedID != nil, selectedID == ownerNodeID { selectedID = nil }
        }
        .sheet(isPresented: $showSearch) { itemBrowser }
        .sheet(isPresented: $showSettings) {
            GraphSettingsSheet(settings: settingsBinding, kinds: kinds,
                               showMe: ownerNodeID == nil ? nil : $showMe)
        }
        .sheet(item: $connecting) { node in
            NavigationStack {
                GraphConnectSheet(source: node, graph: graph) { provisional in
                    connecting = nil
                    await didConnect(node.id, provisional: provisional)
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { connecting = nil } } }
            }
        }
        .sheet(item: $quickConnect) { draft in
            NavigationStack {
                GraphQuickConnectSheet(draft: draft) { provisional in
                    quickConnect = nil
                    await didConnect(draft.first.id, provisional: provisional)
                }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showGroups) {
            NavigationStack {
                GraphGroupsSheet(graph: graph, focus: { node in
                    showGroups = false; choose(node.id)
                }, saved: { id in
                    showGroups = false
                    await didConnect(id)
                })
            }
        }
        .sheet(isPresented: $showConnections) {
            if let selected {
                NavigationStack {
                    GraphConnectionsSheet(node: selected, edges: selectedEdges, explore: { id in
                        showConnections = false; choose(id)
                    }, removed: { id in
                        graph.edges.removeAll { $0.id == id }
                        model.invalidatePersonCaches()
                        if let personID { Task { await model.refreshPersonEvidence(id: personID) } }
                    }, refresh: {
                        await expand(selected.id)
                        model.invalidatePersonCaches()
                    })
                }
            }
        }
        .sheet(item: $editingItem) { node in
            NavigationStack {
                KnowledgeItemEditor(item: node.entity, duplicates: []) { survivingID in
                    await load()
                    choose(survivingID)
                }
            }
        }
    }

    // MARK: - Map

    private var map: some View {
        GeometryReader { proxy in
            let top = proxy.safeAreaInsets.top + 64
            let bottom = proxy.safeAreaInsets.bottom + cardHeight + 16
            ZStack {
                RelationshipGraphCanvas(
                    snapshot: visible,
                    selectedID: selectedID,
                    command: command,
                    insets: UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0),
                    settings: settings,
                    select: { id in select(id) },
                    connect: { first, second in beginQuickConnect(first, second) }
                )
                .accessibilityIdentifier("assistant.relationship.graph")
                .ignoresSafeArea()

                centerState

                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                    bottomArea
                }
            }
        }
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .statusBarHidden(false)
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            floatingButton("Close", systemImage: "xmark") { dismiss() }
            Spacer(minLength: 0)
            Button { send(.fit) } label: {
                HStack(spacing: 6) {
                    if loading { ProgressView().controlSize(.mini) }
                    Text(statusText).font(.footnote.weight(.semibold)).monospacedDigit()
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .glassEffect(.regular, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Fits the whole map on screen")
            Spacer(minLength: 0)
            floatingButton("Find", systemImage: "magnifyingglass") { showSearch = true }
                .accessibilityIdentifier("assistant.relationship.search")
            Menu {
                Button("Fit to screen", systemImage: "arrow.up.left.and.arrow.down.right") { send(.fit) }
                Button("Graph settings", systemImage: "slider.horizontal.3") { showSettings = true }
                if ownerNodeID != nil {
                    Toggle(isOn: $showMe) { Label("Show me", systemImage: "person.crop.circle") }
                }
                Button("Show as a list", systemImage: "list.bullet") { listView = true }
                Divider()
                Button("Connect loose groups", systemImage: "point.3.connected.trianglepath.dotted") { showGroups = true }
                Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } }
            } label: {
                floatingLabel(systemImage: "ellipsis")
            }
            .accessibilityLabel("Map options")
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private var statusText: String {
        if loading && !hasLoaded { return "Loading" }
        let count = visible.nodes.count, total = graph.nodes.count
        let noun = count == 1 && total == 1 ? "item" : "items"
        let shown = count == total ? "\(count)" : "\(count) of \(total)"
        return "\(shown) \(noun)" + (graph.truncated ? "+" : "")
    }

    @ViewBuilder
    private var centerState: some View {
        if let failure, graph.nodes.isEmpty {
            VStack(spacing: 12) {
                Text(failure).font(.subheadline).multilineTextAlignment(.center)
                Button("Try again") { Task { await load() } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            }
            .padding(20)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(32)
        } else if hasLoaded && visible.nodes.isEmpty && !graph.nodes.isEmpty {
            VStack(spacing: 12) {
                AssistantEmptyState(
                    "Nothing to show",
                    systemImage: "line.3.horizontal.decrease.circle",
                    description: "Everything on the map is hidden by the graph settings."
                )
                Button("Show everything") {
                    var next = settings
                    next.hiddenKinds = []; next.showOrphans = true
                    settingsData = next.data
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            }
            .padding(32)
        } else if hasLoaded && visible.nodes.isEmpty {
            AssistantEmptyState(
                "Your map is empty",
                systemImage: "point.3.connected.trianglepath.dotted",
                description: "People, places and projects appear here as the assistant learns how they connect."
            )
            .padding(32)
        } else if loading && !hasLoaded {
            ProgressView()
        }
    }

    @ViewBuilder
    private var bottomArea: some View {
        VStack(spacing: 10) {
            if let notice {
                Label(notice, systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .glassEffect(.regular, in: Capsule())
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if let selected {
                GraphPeekCard(
                    node: selected,
                    graph: graph,
                    edges: selectedEdges,
                    walk: { id in choose(id) },
                    showConnections: { showConnections = true },
                    connect: { connecting = selected },
                    edit: { editingItem = selected },
                    close: { select(nil) }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if !hintSeen && hasLoaded && !visible.nodes.isEmpty {
                gestureHint.transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        // What the bottom of the canvas has lost to the card or the hint, so
        // the map frames itself — and keeps the selection — above it.
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cardHeight = $0 }
        .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86), value: selectedID)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: notice)
    }

    private var gestureHint: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "hand.draw").font(.title3).foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("Tap a dot to see its connections.").font(.subheadline.weight(.semibold))
                Text("Bigger dots are more connected. Pinch to zoom in for names and details. Hold a dot, then drag it onto another to connect them.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button("Dismiss", systemImage: "xmark") { hintSeen = true }
                .labelStyle(.iconOnly).font(.footnote.weight(.semibold))
                .frame(width: 32, height: 32).contentShape(Rectangle())
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func floatingButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { floatingLabel(systemImage: systemImage) }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
    }

    private func floatingLabel(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            .frame(width: 44, height: 44)
            .glassEffect(.regular.interactive(), in: Circle())
            .contentShape(Circle())
    }

    // MARK: - List

    private var readableList: some View {
        List {
            if let failure { Section { Text(failure); Button("Try again") { Task { await load() } } } }
            if loading && !hasLoaded { AssistantLoadingState(title: "Loading connections") }
            Section {
                ForEach(visible.nodes.sorted(by: byDegreeThenName)) { node in
                    Button {
                        selectedID = node.id; showConnections = true
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(node.label).foregroundStyle(.primary)
                                Text("\(node.kind.sentenceCaseIdentifier) · \(connectionCount(node.id))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if hasLoaded && visible.nodes.isEmpty { Text("No recorded connections yet.").foregroundStyle(.secondary) }
            } footer: {
                if graph.truncated { Text("Some items are not loaded. Use Find to reach them.") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .navigationTitle("Map")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Find", systemImage: "magnifyingglass") { showSearch = true }
            }
            if !dynamicTypeSize.isAccessibilitySize {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Show map", systemImage: "point.3.connected.trianglepath.dotted") { listView = false }
                }
            }
        }
    }

    private func byDegreeThenName(_ a: RelationshipGraphNode, _ b: RelationshipGraphNode) -> Bool {
        let degrees = visible.degrees
        let da = degrees[a.id] ?? 0, db = degrees[b.id] ?? 0
        return da != db ? da > db : a.label.localizedStandardCompare(b.label) == .orderedAscending
    }

    private func connectionCount(_ id: String) -> String {
        let count = graph.directNeighbors(of: id).count
        return count == 1 ? "1 connection" : "\(count) connections"
    }

    // MARK: - Find

    @State private var search = ""
    @State private var searchResults: [KnowledgeEntity] = []
    @State private var searching = false
    @State private var searchFailed = false

    private var itemBrowser: some View {
        NavigationStack {
            AssistantSettingsList {
                if search.isEmpty {
                    Section("On the map") {
                        ForEach(graph.nodes.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) { node in
                            Button { showSearch = false; choose(node.id) } label: { resultRow(node.label, kind: node.kind) }
                                .buttonStyle(.plain)
                        }
                    }
                } else {
                    Section {
                        if searching { ProgressView("Searching…") }
                        if searchFailed { Text("Search couldn’t load. Try again.").foregroundStyle(.secondary) }
                        ForEach(searchResults) { item in
                            Button {
                                showSearch = false
                                if graph.nodes.contains(where: { $0.id == item.id }) { choose(item.id) }
                                else { Task { await expand(item.id, chooseAfter: true) } }
                            } label: { resultRow(item.displayLabel, kind: item.kind) }
                            .buttonStyle(.plain)
                        }
                        if !searching && !searchFailed && searchResults.isEmpty { Text("Nothing matches.").foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationTitle("Find")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Person, place, project…")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSearch = false } } }
            .task(id: search) {
                let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
                searchResults = []; searchFailed = false; searching = false
                guard !query.isEmpty else { return }
                searching = true
                do { try await Task.sleep(for: .milliseconds(300)) } catch { searching = false; return }
                let result = await model.searchKnowledge(query: query)
                guard !Task.isCancelled else { return }
                searchResults = result ?? []; searching = false; searchFailed = result == nil
            }
        }
    }

    private func resultRow(_ label: String, kind: String) -> some View {
        HStack(spacing: 10) {
            Circle().fill(Color(RelationshipGraphCanvasView.tint(for: kind, dark: colorScheme == .dark)))
                .frame(width: 9, height: 9).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).foregroundStyle(.primary)
                Text(kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    // MARK: - Actions

    private func select(_ id: String?) {
        selectedID = id
        guard let id else { return }
        trail.removeAll { $0 == id }
        trail.append(id)
        if trail.count > 12 { trail.removeFirst(trail.count - 12) }
        // A truncated map may be missing some of this item's neighbours; fetch
        // them in the background and let them bloom out of it.
        if graph.truncated { Task { await expand(id) } }
    }

    /// Select an item and bring the camera to it.
    private func choose(_ id: String) {
        if id == ownerNodeID { showMe = true }
        select(id)
        send(.reveal(id))
    }

    private func beginQuickConnect(_ first: String, _ second: String?) {
        guard let a = graph.nodes.first(where: { $0.id == first }) else { return }
        hintSeen = true
        quickConnect = GraphConnectionDraft(first: a, second: second.flatMap { id in graph.nodes.first { $0.id == id } })
    }

    /// Show a saved connection straight away, then settle it against the
    /// server. The provisional line is replaced when the item's neighbourhood
    /// comes back, because fresh claims about an item replace its old ones.
    private func didConnect(_ id: String, provisional: RelationshipGraphEdge? = nil) async {
        if let provisional, graph.nodes.contains(where: { $0.id == provisional.subjectId }),
           graph.nodes.contains(where: { $0.id == provisional.objectId }) {
            graph.edges.append(provisional)
        }
        selectedID = id
        flash("Connection saved")
        await expand(id)
        await refresh()
        model.invalidatePersonCaches()
    }

    private func flash(_ message: String) {
        notice = message
        Task {
            try? await Task.sleep(for: .seconds(2.4))
            if notice == message { notice = nil }
        }
    }

    private func send(_ action: GraphCanvasCommand.Action) { command = .init(id: command.id + 1, action: action) }

    private func load() async {
        let token = UUID(); requestID = token; failure = nil
        if !hasLoaded, let initialGraph, !initialGraph.nodes.isEmpty, graph.nodes.isEmpty {
            graph = initialGraph; hasLoaded = true
        }
        loading = true
        var next = await model.relationshipGraph()
        var focus: String?
        if personID != nil || entityID != nil,
           let local = await model.relationshipGraph(personID: personID, entityID: entityID) {
            focus = local.focusId
            next = next.map { $0.nodes.isEmpty ? local : $0.merging(local, around: local.focusId ?? "") } ?? local
        }
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let next else {
            failure = "Couldn’t load the map. Check your connection and try again."
            return
        }
        graph = next; hasLoaded = true; loadedAt = .now
        if let selectedID, !graph.nodes.contains(where: { $0.id == selectedID }) { self.selectedID = nil }
        if let focus, graph.nodes.contains(where: { $0.id == focus }) { choose(focus) }
    }

    /// Re-reads the map in the background and lays it over what is on
    /// screen. It never takes the owner's place: nothing they opened or
    /// walked through is let go, and the camera stays where it is.
    private func refresh() async {
        guard hasLoaded, !loading, failure == nil else { return }
        let token = requestID
        guard let fresh = await model.relationshipGraph(), requestID == token, !Task.isCancelled else { return }
        var keep = Set(trail)
        if let selectedID { keep.insert(selectedID) }
        graph = graph.refreshed(with: fresh, keep: keep)
        loadedAt = .now
    }

    /// Pull one item's neighbourhood into the map, always. When the map is
    /// full, what gets let go is whatever is furthest from here and not on the
    /// recent trail — so digging in keeps going instead of hitting a wall.
    private func expand(_ id: String, chooseAfter: Bool = false) async {
        let token = UUID(); requestID = token
        loading = true
        let result = await model.relationshipGraph(entityID: id)
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let result else {
            if chooseAfter { flash("Couldn’t load that item") }
            return
        }
        var keep = Set(trail)
        if let selectedID { keep.insert(selectedID) }
        graph = graph.merging(result, around: id, keep: keep)
        if chooseAfter { choose(id) }
    }
}

/// An item the owner has just joined to another — or to something new, when
/// `second` is nil — before they say how.
struct GraphConnectionDraft: Identifiable {
    let first: RelationshipGraphNode
    let second: RelationshipGraphNode?
    var id: String { first.id + "→" + (second?.id ?? "new") }
}

/// The selected item, and the way on from it.
///
/// Its neighbours are right there to tap — that is how the map is walked —
/// and there are three verbs, not ten: read the connections, add one, and a
/// menu for the rarer edits.
private struct GraphPeekCard: View {
    let node: RelationshipGraphNode
    let graph: RelationshipGraphSnapshot
    let edges: [RelationshipGraphEdge]
    let walk: (String) -> Void
    let showConnections: () -> Void
    let connect: () -> Void
    let edit: () -> Void
    let close: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var neighbors: [RelationshipGraphNode] {
        let degrees = graph.degrees
        return graph.directNeighbors(of: node.id).sorted {
            let a = degrees[$0.id] ?? 0, b = degrees[$1.id] ?? 0
            return a != b ? a > b : $0.label.localizedStandardCompare($1.label) == .orderedAscending
        }
    }

    private var summary: String {
        let count = neighbors.count
        var parts = [node.kind.sentenceCaseIdentifier, count == 1 ? "1 connection" : "\(count) connections"]
        let review = edges.filter { $0.reviewStatus != "confirmed" }.count
        if review > 0 { parts.append("\(review) to review") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Circle()
                    .fill(Color(RelationshipGraphCanvasView.tint(for: node.kind, dark: colorScheme == .dark)))
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(node.label).font(.title3.weight(.semibold)).lineLimit(2)
                    Text(summary).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button("Close", systemImage: "xmark", action: close)
                    .labelStyle(.iconOnly)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
            }
            if !neighbors.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(neighbors.prefix(24)) { neighbor in
                            Button { walk(neighbor.id) } label: {
                                Text(neighbor.label)
                                    .font(.subheadline.weight(.medium))
                                    .lineLimit(1)
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 36)
                                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                                    .overlay { Capsule().stroke(Color.primary.opacity(colorScheme == .dark ? 0.18 : 0.08), lineWidth: 1) }
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Moves to \(neighbor.label) on the map")
                        }
                    }
                }
                .scrollClipDisabled()
            }
            HStack(spacing: 8) {
                Button(action: showConnections) {
                    Text("Connections").lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                Button(action: connect) {
                    Label("Connect", systemImage: "plus").lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                Menu {
                    if let contactID = node.contactId {
                        NavigationLink { PersonCardScreen(personId: contactID) } label: {
                            Label("Open profile", systemImage: "person.crop.circle")
                        }
                    }
                    Button("Rename or merge", systemImage: "pencil", action: edit)
                } label: {
                    Image(systemName: "ellipsis").frame(width: 20)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                .accessibilityLabel("More actions")
            }
        }
        .padding(16)
        // Opaque rather than glass: the map behind is busy with names, and
        // names showing through a card that is itself about a name blur into
        // one another.
        .background(AssistantTheme.raised(for: colorScheme), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.primary.opacity(colorScheme == .dark ? 0.16 : 0.07), lineWidth: 1)
        }
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.4 : 0.12), radius: 18, y: 6)
    }
}

/// Saying how two items the owner just joined are related. The ends are
/// already chosen — by the drag, or by Find — so this asks only what is left:
/// how they relate, a name when one end is new, and an optional note.
struct GraphQuickConnectSheet: View {
    let draft: GraphConnectionDraft
    /// The presenting screen closes the sheet after the server accepts it,
    /// draws this line at once, then fetches the real one (nil for a new end).
    let saved: (RelationshipGraphEdge?) async -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var reversed = false
    @State private var predicate: String?
    @State private var ownWords = ""
    @State private var note = ""
    @State private var newName = ""
    @State private var newKind = "person"
    @State private var saving = false
    @State private var failure: String?
    @State private var familySuggestions: [GraphFamilySuggestion] = []
    @State private var showFamilySuggestions = false
    @State private var committedProvisional: RelationshipGraphEdge?
    @FocusState private var nameFocused: Bool

    private struct End { let id: String?; let label: String; let kind: String }

    init(draft: GraphConnectionDraft, saved: @escaping (RelationshipGraphEdge?) async -> Void) {
        self.draft = draft
        self.saved = saved
    }

    private var other: End {
        if let second = draft.second { return End(id: second.id, label: second.label, kind: second.kind) }
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        return End(id: nil, label: name, kind: newKind)
    }
    private var mine: End { End(id: draft.first.id, label: draft.first.label, kind: draft.first.kind) }
    private var subject: End { reversed ? other : mine }
    private var object: End { reversed ? mine : other }

    private var options: [(id: String, label: String)] {
        KnowledgeConnectionEditor.relationshipOptions(subjectKind: subject.kind, objectKind: object.kind)
    }

    private var chosenPredicate: String {
        let typed = ownWords.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? (predicate ?? "") : typed
    }

    private var otherLabel: String { other.label.isEmpty ? "the new item" : other.label }

    var body: some View {
        AssistantForm {
            if draft.second == nil {
                Section("New item") {
                    TextField("Name", text: $newName)
                        .focused($nameFocused)
                        .textInputAutocapitalization(.words)
                    Picker("Type", selection: $newKind) {
                        ForEach(["person", "place", "organization", "project", "event", "topic"], id: \.self) {
                            Text($0.sentenceCaseIdentifier).tag($0)
                        }
                    }
                    .onChange(of: newKind) { _, _ in predicate = nil }
                }
            }
            Section {
                HStack(spacing: 12) {
                    endpoint(subject.label.isEmpty ? otherLabel : subject.label, subject.kind)
                    Button("Swap direction", systemImage: "arrow.left.arrow.right") {
                        reversed.toggle(); predicate = nil
                    }
                    .labelStyle(.iconOnly)
                    .frame(width: 44, height: 44)
                    endpoint(object.label.isEmpty ? otherLabel : object.label, object.kind)
                }
            } footer: {
                Text(chosenPredicate.isEmpty
                     ? "Choose how they relate."
                     : KnowledgeConnectionEditor.previewSentence(
                        subject: subject.label.isEmpty ? otherLabel : subject.label,
                        predicate: chosenPredicate,
                        objectLabel: object.label.isEmpty ? otherLabel : object.label))
            }
            Section("How are they connected?") {
                ForEach(options, id: \.id) { option in
                    Button {
                        predicate = option.id; ownWords = ""
                    } label: {
                        HStack {
                            Text(option.label).foregroundStyle(.primary)
                            Spacer()
                            if predicate == option.id && ownWords.isEmpty {
                                Image(systemName: "checkmark").foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                TextField(options.isEmpty ? "In your own words, e.g. advises" : "Or in your own words", text: $ownWords)
                    .autocorrectionDisabled()
            }
            Section("Note (optional)") {
                TextField("How you know, e.g. met at university", text: $note, axis: .vertical)
                    .lineLimit(1...4)
            }
            if let failure {
                Section { Text(failure).foregroundStyle(AssistantTheme.errorInk(for: colorScheme)) }
            }
        }
        .navigationTitle(draft.second == nil ? "New connection" : "Connect")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .onAppear { if draft.second == nil { nameFocused = true } }
        .sheet(isPresented: $showFamilySuggestions, onDismiss: {
            Task { await saved(committedProvisional); saving = false }
        }) {
            NavigationStack { GraphFamilySuggestionsSheet(suggestions: familySuggestions) }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { save() }
                    .disabled(saving || chosenPredicate.isEmpty || other.label.isEmpty)
            }
        }
    }

    private func endpoint(_ label: String, _ kind: String) -> some View {
        VStack(spacing: 3) {
            Text(label).font(.headline).lineLimit(2).multilineTextAlignment(.center)
            Text(kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func save() {
        saving = true; failure = nil
        let subject = subject, object = object, predicate = chosenPredicate
        let mutation = KnowledgeConnectionMutation(
            subjectLabel: subject.label, subjectKind: subject.kind, subjectId: subject.id,
            predicate: predicate,
            objectLabel: object.label, objectKind: object.kind, objectId: object.id,
            note: note.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        var provisional: RelationshipGraphEdge?
        if let subjectID = subject.id, let objectID = object.id {
            let sentence = KnowledgeConnectionEditor.previewSentence(subject: subject.label, predicate: predicate, objectLabel: object.label)
            let label = options.first { $0.id == predicate }?.label
                ?? predicate.replacingOccurrences(of: "_", with: " ")
            provisional = RelationshipGraphEdge(
                id: "pending-\(UUID().uuidString)", subjectId: subjectID, objectId: objectID, predicate: predicate,
                reviewStatus: "confirmed", sourceContent: sentence,
                presentation: KnowledgePresentation(sentence: sentence, label: label.sentenceCaseIdentifier, accessibleLabel: sentence),
                validFrom: nil, validUntil: nil)
        }
        Task {
            if let relationID = await model.createKnowledgeConnectionID(mutation) {
                committedProvisional = provisional
                model.invalidatePersonCaches()
                if GraphFamilySuggestion.canTrigger(mutation.predicate), let graph = await model.relationshipGraph() {
                    familySuggestions = GraphFamilySuggestionDismissals.remaining(graph.familyConnectionSuggestions(triggerRelationID: relationID))
                    if !familySuggestions.isEmpty {
                        showFamilySuggestions = true
                        return
                    }
                }
                await saved(provisional)
            } else {
                failure = model.errorMessage ?? "Couldn’t save this connection. Try again."
            }
            saving = false
        }
    }
}

/// Everything recorded about one item, one sentence per connection.
/// Reading is the default; confirming is a swipe, and the rarer edits sit one
/// tap further in, on the connection itself.
private struct GraphConnectionsSheet: View {
    let node: RelationshipGraphNode
    let edges: [RelationshipGraphEdge]
    let explore: (String) -> Void
    let removed: (String) -> Void
    let refresh: () async -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var failure: String?

    private var ordered: [RelationshipGraphEdge] {
        edges.sorted {
            let a = $0.reviewStatus == "confirmed", b = $1.reviewStatus == "confirmed"
            return a != b ? !a : $0.presentation.sentence.localizedStandardCompare($1.presentation.sentence) == .orderedAscending
        }
    }

    var body: some View {
        List {
            if edges.isEmpty {
                Text("No connections recorded yet.").foregroundStyle(.secondary)
            } else {
                Section {
                    ForEach(ordered) { edge in
                        NavigationLink {
                            GraphEdgeDetail(edge: edge, node: node, explore: explore, removed: removed, refresh: refresh)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(edge.presentation.sentence)
                                    .fixedSize(horizontal: false, vertical: true)
                                if edge.reviewStatus != "confirmed" {
                                    Text("Not yet confirmed").font(.caption).foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                                } else if edge.validFrom != nil || edge.validUntil != nil {
                                    Text("\(edge.validFrom ?? "Unknown start") to \(edge.validUntil ?? "present")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if edge.reviewStatus != "confirmed" {
                                Button("Confirm", systemImage: "checkmark") { confirm(edge) }
                                    .tint(AssistantTheme.accent(for: colorScheme))
                            }
                        }
                    }
                } footer: {
                    if edges.contains(where: { $0.reviewStatus != "confirmed" }) {
                        Text("Swipe right to confirm. Unconfirmed connections are dashed on the map.")
                    }
                }
            }
            if let failure { Text(failure).foregroundStyle(AssistantTheme.errorInk(for: colorScheme)) }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .navigationTitle(node.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .presentationDetents([.medium, .large])
    }

    private func confirm(_ edge: RelationshipGraphEdge) {
        failure = nil
        Task {
            if await model.reviewKnowledgeRelation(id: edge.id, approve: true) { await refresh() }
            else { failure = "Couldn’t confirm that connection. Try again." }
        }
    }
}

/// One recorded connection: what it says, where it came from, and the few
/// things that can be done about it.
private struct GraphEdgeDetail: View {
    let edge: RelationshipGraphEdge
    let node: RelationshipGraphNode
    let explore: (String) -> Void
    let removed: (String) -> Void
    let refresh: () async -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var working = false
    @State private var failure: String?
    @State private var correcting: KnowledgeRelation?

    private var otherID: String { edge.subjectId == node.id ? edge.objectId : edge.subjectId }

    var body: some View {
        AssistantForm {
            Section {
                Text(edge.presentation.sentence).font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if edge.validFrom != nil || edge.validUntil != nil {
                    LabeledContent("When", value: "\(edge.validFrom ?? "Unknown start") to \(edge.validUntil ?? "present")")
                }
                LabeledContent("Status", value: edge.reviewStatus == "confirmed" ? "Confirmed" : "Not yet confirmed")
            }
            Section("Source") {
                Text(edge.sourceContent).font(.subheadline).textSelection(.enabled)
            }
            Section {
                if edge.reviewStatus != "confirmed" {
                    Button("Confirm it’s right", systemImage: "checkmark.seal") {
                        run { await model.reviewKnowledgeRelation(id: edge.id, approve: true) } after: { await refresh() }
                    }
                }
                Button("Show on the map", systemImage: "scope") { explore(otherID) }
                Button("Correct it", systemImage: "pencil") {
                    Task {
                        correcting = await model.knowledgeRelation(id: edge.id)
                        if correcting == nil { failure = "Couldn’t load this connection." }
                    }
                }
            }
            .disabled(working)
            Section {
                AssistantConfirmationButton("Remove connection", confirmationTitle: "Remove for good",
                                            hint: "The original note and any other claims stay saved.", fillsWidth: true) {
                    working = true; failure = nil
                    if await model.removeKnowledgeRelation(id: edge.id) { removed(edge.id); dismiss() }
                    else { failure = "Couldn’t remove this connection. Try again." }
                    working = false
                }
                .disabled(working)
            }
            if let failure { Section { Text(failure).foregroundStyle(AssistantTheme.errorInk(for: colorScheme)) } }
        }
        .navigationTitle("Connection")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $correcting) { relation in
            NavigationStack {
                KnowledgeConnectionEditor(selected: relation.subject, relationToCorrect: relation,
                                          candidates: [relation.subject, relation.object]) { await refresh() }
            }
        }
    }

    private func run(_ action: @escaping () async -> Bool, after: @escaping () async -> Void) {
        working = true; failure = nil
        Task {
            if await action() { await after(); dismiss() } else { failure = "That didn’t work. Try again." }
            working = false
        }
    }
}

/// Help the owner join disconnected knowledge without presenting guesses as facts.
struct GraphGroupsSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    let graph: RelationshipGraphSnapshot
    let focus: (RelationshipGraphNode) -> Void
    let saved: (String) async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                Text("Connect loose groups").font(.title2.weight(.semibold))
                Text("These groups are separate in the loaded graph. Start with a small group, explore its items, and add any relationship you know is missing.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if graph.truncated { Label("This is a partial view. Expand an item to check for more recorded connections first.", systemImage: "info.circle").font(.footnote) }
            }
            if !graph.groups.filter({ $0.nodes.count == 1 }).isEmpty {
                Section("Items without a visible connection") {
                    ForEach(graph.groups.filter { $0.nodes.count == 1 }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) { group in
                        if let node = group.nodes.first {
                            NavigationLink { GraphConnectSheet(source: node, graph: graph) { _ in await saved(node.id) } } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(node.label)
                                    Text(node.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
                                }
                            }.accessibilityLabel("Connect \(node.label)")
                        }
                    }
                }
            }
            ForEach(graph.groups.filter { $0.nodes.count > 1 }.sorted { $0.nodes.count == $1.nodes.count ? $0.label.localizedStandardCompare($1.label) == .orderedAscending : $0.nodes.count < $1.nodes.count }) { group in
                Section {
                    if let anchor = group.nodes.first {
                        Button { focus(anchor) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(group.nodes.count == 1 ? group.label : "Around \(group.label)").font(.headline)
                                    Text("\(group.nodes.count) items · \(group.connectionCount) connections in this view")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "scope")
                            }
                        }.buttonStyle(.plain).accessibilityHint("Focus this group on the graph")
                    }
                    if group.nodes.count <= 4 {
                        ForEach(group.nodes) { node in connectLink(node) }
                    } else {
                        DisclosureGroup("Choose an item to connect") { ForEach(group.nodes) { node in connectLink(node) } }
                    }
                }
            }
            if graph.nodes.isEmpty { Text("Search the graph for a person, place, or project to start connecting it.").foregroundStyle(.secondary) }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .tint(AssistantTheme.accent(for: colorScheme))
        .navigationTitle("Groups")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }

    private func connectLink(_ node: RelationshipGraphNode) -> some View {
        NavigationLink {
            GraphConnectSheet(source: node, graph: graph) { _ in await saved(node.id) }
        } label: { Label("Connect \(node.label)", systemImage: "plus") }
    }
}

struct GraphConnectSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    let source: RelationshipGraphNode
    let graph: RelationshipGraphSnapshot
    let saved: (RelationshipGraphEdge?) async -> Void
    @EnvironmentObject private var model: AppModel
    @State private var search = ""
    @State private var results: [KnowledgeEntity] = []
    @State private var searching = false
    @State private var searchFailed = false
    @State private var target: KnowledgeEntity?
    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            Section {
                Text("How does \(source.label) connect?").font(.title2.weight(.semibold))
                Text("Choose an item you know is connected, then describe how. Shared connections can help you find the right item.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if query.isEmpty {
                Section("Items to consider") {
                    ForEach(graph.connectionCandidates(for: source.id).prefix(20), id: \.node.id) { candidate in
                        Button { target = candidate.node.entity } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(candidate.node.label)
                                Text(candidate.reason).font(.caption).foregroundStyle(.secondary)
                            }
                        }.buttonStyle(.plain)
                    }
                    if graph.connectionCandidates(for: source.id).isEmpty {
                        Text("Search for another person, place, or project.").foregroundStyle(.secondary)
                    }
                }
                Section("Already connected") {
                    ForEach(graph.nodes.filter { $0.id != source.id && graph.neighborhood(of: source.id).contains($0.id) }) { node in
                        Button(node.label) { target = node.entity }
                    }
                }
            } else {
                Section("Matching items") {
                    if searching { ProgressView("Searching…") }
                    if searchFailed { Text("Search couldn’t load. Change the search to try again.").foregroundStyle(.secondary) }
                    ForEach(results.filter { $0.id != source.id }) { item in
                        Button { target = item } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.displayLabel)
                                Text(item.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if !searching && !searchFailed && results.filter({ $0.id != source.id }).isEmpty { Text("No matching items.").foregroundStyle(.secondary) }
                }
            }
            Section {
                NavigationLink("Connect to something new…") {
                    GraphQuickConnectSheet(draft: GraphConnectionDraft(first: source, second: nil), saved: saved)
                }
            } footer: { Text("Search first to reuse an existing item and avoid duplicate nodes.") }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .tint(AssistantTheme.accent(for: colorScheme))
        .navigationTitle("Add connection")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Find a person, place, project…")
        .navigationDestination(item: $target) { item in
            GraphQuickConnectSheet(
                draft: GraphConnectionDraft(first: source, second: RelationshipGraphNode(id: item.id, label: item.displayLabel, kind: item.kind)),
                saved: saved)
        }
        .task(id: query) {
            results = []; searchFailed = false; searching = false
            guard !query.isEmpty else { return }
            let expected = query; searching = true
            do { try await Task.sleep(for: .milliseconds(300)) } catch { searching = false; return }
            let response = await model.searchKnowledge(query: expected)
            guard !Task.isCancelled else { return }
            results = response ?? []; searchFailed = response == nil; searching = false
        }
    }
}

/// The map's settings, laid out the way Obsidian's graph panel is: what is
/// shown, how it is drawn, and the forces that shape it. It opens at half
/// height over a live map, so every change can be watched taking effect —
/// that is how a slider called "repel force" becomes something a person can
/// actually use.
struct GraphSettingsSheet: View {
    @Binding var settings: GraphSettings
    let kinds: [GraphKindCount]
    /// Present only when the owner's own item is on the map.
    var showMe: Binding<Bool>?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AssistantForm {
                Section {
                    ForEach(kinds) { entry in
                        Toggle(isOn: shows(entry.kind)) {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(Color(RelationshipGraphCanvasView.tint(for: entry.kind, dark: colorScheme == .dark)))
                                    .frame(width: 12, height: 12)
                                    .accessibilityHidden(true)
                                Text(entry.kind.sentenceCaseIdentifier)
                                Spacer(minLength: 8)
                                Text("\(entry.count)").foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                        .accessibilityValue("\(entry.count) on the map")
                    }
                    if kinds.contains(where: { $0.kind == "person" }) && kinds.count > 1 {
                        Button(peopleOnly ? "Show every kind" : "People only") {
                            settings.hiddenKinds = peopleOnly ? [] : Set(kinds.map(\.kind)).subtracting(["person"])
                        }
                    }
                } header: {
                    Text("Groups")
                } footer: {
                    Text("Each kind of item has its own colour. Turn one off to take it off the map.")
                }

                Section("Filters") {
                    if let showMe { Toggle("Show me", isOn: showMe) }
                    Toggle("Unconnected items", isOn: $settings.showOrphans)
                }

                Section {
                    Toggle("Arrows", isOn: $settings.arrows)
                    slider("Names appear", value: $settings.textFade, in: -1.5...1.5,
                           low: "Closer", high: "Further out", reading: fadeReading)
                    slider("Node size", value: $settings.nodeSize, in: 0.5...2)
                    slider("Link thickness", value: $settings.linkThickness, in: 0.4...3)
                } header: {
                    Text("Display")
                } footer: {
                    Text("A dot's size is how connected it is. Names appear hubs first as you zoom in.")
                }

                Section {
                    slider("Center force", value: $settings.centerForce, in: GraphSettings.multiplierRange)
                    slider("Repel force", value: $settings.repelForce, in: GraphSettings.multiplierRange)
                    slider("Link force", value: $settings.linkForce, in: GraphSettings.multiplierRange)
                    slider("Link distance", value: $settings.linkDistance, in: 0.4...2.5)
                } header: {
                    Text("Forces")
                } footer: {
                    Text("Center pulls loose groups in, repel spreads items apart, and links hold connected items together at their distance.")
                }

                Section {
                    Button("Restore defaults") {
                        var standard = GraphSettings()
                        // Defaults are for how the map looks and moves; what
                        // the owner chose to hide stays hidden.
                        standard.hiddenKinds = settings.hiddenKinds
                        standard.showOrphans = settings.showOrphans
                        settings = standard
                    }
                    .disabled(settings.isDisplayStandard && settings.areForcesStandard)
                }
            }
            .navigationTitle("Graph settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(AssistantTheme.accent(for: colorScheme))
        .presentationDetents([.medium, .large])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .presentationContentInteraction(.scrolls)
    }

    private var peopleOnly: Bool {
        let others = Set(kinds.map(\.kind)).subtracting(["person"])
        return !others.isEmpty && others.isSubset(of: settings.hiddenKinds) && !settings.hiddenKinds.contains("person")
    }

    private func shows(_ kind: String) -> Binding<Bool> {
        Binding(get: { !settings.hiddenKinds.contains(kind) }, set: { shown in
            if shown { settings.hiddenKinds.remove(kind) } else { settings.hiddenKinds.insert(kind) }
        })
    }

    private func fadeReading(_ value: CGFloat) -> String {
        abs(value) < 0.05 ? "Default" : value > 0 ? "Earlier" : "Later"
    }

    private func slider(_ title: String, value: Binding<CGFloat>, in range: ClosedRange<CGFloat>,
                        low: String? = nil, high: String? = nil,
                        reading: ((CGFloat) -> String)? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text(reading?(value.wrappedValue) ?? multiple(value.wrappedValue))
                    .font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
            }
            Slider(value: value, in: range) {
                Text(title)
            } minimumValueLabel: {
                if let low { Text(low).font(.caption).foregroundStyle(.secondary) }
            } maximumValueLabel: {
                if let high { Text(high).font(.caption).foregroundStyle(.secondary) }
            }
            .accessibilityValue(reading?(value.wrappedValue) ?? multiple(value.wrappedValue))
        }
        .padding(.vertical, 2)
    }

    private func multiple(_ value: CGFloat) -> String {
        Double(value).formatted(.number.precision(.fractionLength(0...2))) + "×"
    }
}

/// One kind of item on the map, and how many of it are loaded.
struct GraphKindCount: Identifiable, Hashable {
    let kind: String
    let count: Int
    var id: String { kind }
}

#if DEBUG
extension RelationshipGraphScreen {
    @MainActor static func visualReviewScreen(_ name: String, graph: RelationshipGraphSnapshot) -> AnyView? {
        guard let node = graph.nodes.first, let edge = graph.edges.first else { return nil }
        switch name {
        case "map-find":
            var view = RelationshipGraphScreen(initialGraph: graph)
            view._showSearch = State(initialValue: true)
            return AnyView(view)
        case "map-connections": return AnyView(GraphConnectionsSheet(node: node, edges: graph.edges, explore: { _ in }, removed: { _ in }, refresh: {}))
        case "map-connection-detail": return AnyView(GraphEdgeDetail(edge: edge, node: node, explore: { _ in }, removed: { _ in }, refresh: {}))
        default: return nil
        }
    }
}
#endif
