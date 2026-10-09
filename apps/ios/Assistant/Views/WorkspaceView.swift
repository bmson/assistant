import Foundation
import SwiftUI

enum AssistantFileImportError: LocalizedError {
    case tooLarge(limit: Int)
    case timedOut

    var errorDescription: String? {
        switch self {
        case let .tooLarge(limit):
            return "This file is larger than the \(limit / (1024 * 1024)) MB import limit. Nothing was uploaded."
        case .timedOut:
            return "The file provider did not finish reading in time. Nothing was uploaded; try a local copy."
        }
    }
}

/// Coordinates file-provider URLs and reads at most `maxBytes + 1` on a
/// background worker. The extra byte detects a changing or missing size
/// value without ever loading an oversized file into memory.
enum AssistantBoundedFileReader {
    static let defaultLimit = 25 * 1024 * 1024
    private static let chunkSize = 64 * 1024

    static func read(
        from url: URL,
        maxBytes: Int = defaultLimit,
        timeout: Duration = .seconds(45)
    ) async throws -> Data {
        precondition(maxBytes > 0)
        let operation = FileReadOperation()
        let completion = FileReadCompletion()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                completion.install(continuation)
                Task.detached(priority: .userInitiated) {
                    let result = Result {
                        try readCoordinated(url, maxBytes: maxBytes, timeout: timeout, operation: operation)
                    }
                    completion.finish(result)
                }
                let timeoutTask = Task.detached(priority: .utility) {
                    try? await Task.sleep(for: timeout)
                    guard !Task.isCancelled else { return }
                    completion.finish(.failure(AssistantFileImportError.timedOut))
                    operation.cancel()
                }
                completion.install(timeoutTask)
            }
        } onCancel: {
            operation.cancel()
            completion.finish(.failure(CancellationError()))
        }
    }

    private static func readCoordinated(
        _ url: URL,
        maxBytes: Int,
        timeout: Duration,
        operation: FileReadOperation
    ) throws -> Data {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        guard url.startAccessingSecurityScopedResource() else {
            // Local URLs do not require a security scope and return false.
            // The actual coordinated read below remains the authority check.
            return try coordinatedRead(url, maxBytes: maxBytes, deadline: deadline, operation: operation)
        }
        defer { url.stopAccessingSecurityScopedResource() }
        return try coordinatedRead(url, maxBytes: maxBytes, deadline: deadline, operation: operation)
    }

    private static func coordinatedRead(
        _ url: URL,
        maxBytes: Int,
        deadline: ContinuousClock.Instant,
        operation: FileReadOperation
    ) throws -> Data {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        operation.install(coordinator)
        var coordinationError: NSError?
        var result: Result<Data, Error>?
        coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { coordinatedURL in
            result = Result {
                if operation.isCancelled { throw CancellationError() }
                if let expectedSize = try? coordinatedURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                   expectedSize > maxBytes {
                    throw AssistantFileImportError.tooLarge(limit: maxBytes)
                }
                let handle = try FileHandle(forReadingFrom: coordinatedURL)
                operation.install(handle)
                defer {
                    operation.remove(handle)
                    try? handle.close()
                }

                var data = Data()
                while true {
                    if operation.isCancelled { throw CancellationError() }
                    if ContinuousClock.now >= deadline {
                        throw AssistantFileImportError.timedOut
                    }
                    let remaining = maxBytes + 1 - data.count
                    if remaining <= 0 { throw AssistantFileImportError.tooLarge(limit: maxBytes) }
                    let chunk = try handle.read(upToCount: min(chunkSize, remaining))
                    guard let chunk, !chunk.isEmpty else { break }
                    data.append(chunk)
                    if data.count > maxBytes { throw AssistantFileImportError.tooLarge(limit: maxBytes) }
                }
                return data
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw CocoaError(.fileReadUnknown) }
        return try result.get()
    }
}

private final class FileReadOperation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var coordinator: NSFileCoordinator?
    private var handle: FileHandle?

    var isCancelled: Bool { lock.withLock { cancelled } }

    func install(_ coordinator: NSFileCoordinator) {
        let cancelNow = lock.withLock { () -> Bool in
            self.coordinator = coordinator
            return cancelled
        }
        if cancelNow { coordinator.cancel() }
    }

    func install(_ handle: FileHandle) {
        let closeNow = lock.withLock { () -> Bool in
            self.handle = handle
            return cancelled
        }
        if closeNow { try? handle.close() }
    }

    func remove(_ handle: FileHandle) {
        lock.withLock { if self.handle === handle { self.handle = nil } }
    }

    func cancel() {
        let resources = lock.withLock { () -> (NSFileCoordinator?, FileHandle?) in
            cancelled = true
            return (coordinator, handle)
        }
        resources.0?.cancel()
        if let handle = resources.1 { try? handle.close() }
    }
}

private final class FileReadCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var result: Result<Data, Error>?
    private var timeoutTask: Task<Void, Never>?

    func install(_ continuation: CheckedContinuation<Data, Error>) {
        let pending = lock.withLock { () -> Result<Data, Error>? in
            self.continuation = continuation
            return result
        }
        if let pending { continuation.resume(with: pending) }
    }

    func install(_ timeoutTask: Task<Void, Never>) {
        let cancelNow = lock.withLock { () -> Bool in
            self.timeoutTask = timeoutTask
            return result != nil
        }
        if cancelNow { timeoutTask.cancel() }
    }

    func finish(_ result: Result<Data, Error>) {
        let values = lock.withLock { () -> (CheckedContinuation<Data, Error>?, Task<Void, Never>?) in
            guard self.result == nil else { return (nil, nil) }
            self.result = result
            return (continuation, timeoutTask)
        }
        values.1?.cancel()
        values.0?.resume(with: result)
    }
}
import UniformTypeIdentifiers

enum WorkspaceArea {
    case chats
    case documents
    case skills
    case capabilities
    case costs
    case anomalies
    case improvements

    var title: String {
        switch self {
        case .chats: "All chats"
        case .documents: "Documents"
        case .skills: "Skills"
        case .capabilities: "Capabilities"
        case .costs: "Costs"
        case .anomalies: "Anomalies"
        case .improvements: "Improvements"
        }
    }

    var icon: String {
        switch self {
        case .chats: "bubble.left.and.bubble.right"
        case .documents: "doc.text"
        case .skills: "lightbulb"
        case .capabilities: "puzzlepiece.extension"
        case .costs: "dollarsign.circle"
        case .anomalies: "exclamationmark.triangle"
        case .improvements: "arrow.triangle.2.circlepath"
        }
    }

    var introduction: String {
        switch self {
        case .chats:
            "Your main thread, active conversations, and the history you have kept."
        case .documents:
            "Files the assistant can search and cite when you ask a question in chat."
        case .skills:
            "Procedures the assistant has learned from completed work and reads as advice before planning."
        case .capabilities:
            "Optional tools installed on this assistant, including anything that still needs setup."
        case .costs:
            "This month’s charges, estimated month-end costs, and assistant usage limits."
        case .anomalies:
            "Unusual approval-policy activity that deserves a closer look before it becomes routine."
        case .improvements:
            "Changes the assistant has proposed from its own reliability and cost reviews."
        }
    }

    var availabilityKeys: [String] {
        switch self {
        case .chats: ["chats"]
        case .skills: ["skills"]
        case .capabilities: ["capabilities"]
        case .costs: ["costs"]
        case .anomalies: ["anomalies"]
        case .improvements: ["improvements"]
        case .documents: []
        }
    }
}

struct WorkspaceAvailabilityNotice: View {
    let title: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(title) unavailable")
                    .font(.headline)
                Text("This section could not be loaded. Refresh to try again.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "exclamationmark.arrow.circlepath")
                .foregroundStyle(.orange)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

struct WorkspaceView: View {
    let area: WorkspaceArea

    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingDocumentImporter = false
    @State private var showingBackstoryImporter = false
    @State private var showingSkillCreator = false
    @State private var editingSkill: WorkspaceSkill?
    @State private var expandedSkillIDs: Set<String> = []
    @State private var skillPendingDeletion: WorkspaceSkill?
    @State private var showingCostEditor = false
    @State private var showingIssueReporter = false
    @State private var issueReported = false
    @State private var workspaceActionInFlight: String?
    @State private var fileImportTask: Task<Void, Never>?
    @State private var fileImportID: UUID?
    @State private var fileImportStage: String?
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var improvementReceipt: ImprovementDecisionResult?
    @State private var improvementFailureID: String?
    @State private var improvementFailureDetail: String?
    @State private var recordedImprovementIDs: Set<String> = []
    @State private var repairFailureID: String?
    @State private var repairAcknowledgedRevisions: [String: String] = [:]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                if fileImportStage == "reading" {
                    ProgressView("Checking and reading file…")
                        .accessibilityIdentifier("file-import-reading")
                } else if fileImportStage == "uploading" {
                    ProgressView("Uploading…")
                        .accessibilityIdentifier("file-import-uploading")
                }

                if loadFailed {
                    AssistantLoadFailureState(
                        title: "Couldn’t refresh \(area.title.lowercased())",
                        message: model.workspace == nil ? "Try again to load this workspace." : "Previous information is shown. Refresh before making changes.",
                        retry: { Task { await refresh() } }
                    )
                }

                if area == .documents {
                    documentsContent
                } else if let workspace = model.workspace {
                    workspaceContent(workspace)
                } else if !loadFailed {
                    AssistantLoadingState(title: "Loading \(area.title.lowercased())")
                }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle(area.title)
        .assistantSubmenuChrome()
        .toolbarBackground(area == .skills ? .visible : .hidden, for: .navigationBar)
        .toolbarBackground(AssistantTheme.canvas(for: colorScheme), for: .navigationBar)
        .refreshable { await refresh() }
        .onDisappear { cancelFileImport() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await load()
            while area == .improvements && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) }
                catch { return }
                guard !Task.isCancelled else { return }
                await refresh()
            }
        }
        .onChange(of: model.composerDraftScope?.session) { _, _ in
            // The presentation belongs to the authenticated session too.
            improvementReceipt = nil
            improvementFailureID = nil
            improvementFailureDetail = nil
            recordedImprovementIDs = []
            repairFailureID = nil
            repairAcknowledgedRevisions = [:]
            workspaceActionInFlight = nil
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if area == .documents {
                    Menu {
                        Button("Add document", systemImage: "plus") {
                            showingDocumentImporter = true
                        }
                        Button("Import backstory", systemImage: "tray.and.arrow.down") {
                            showingBackstoryImporter = true
                        }
                    } label: {
                        Label("Document actions", systemImage: "ellipsis.circle")
                    }
                    .disabled(actionsUnavailable)
                } else if area == .skills {
                    Button("Add skill", systemImage: "plus") { showingSkillCreator = true }
                        .disabled(actionsUnavailable)
                } else if area == .costs {
                    Button("Edit limits", systemImage: "slider.horizontal.3") {
                        showingCostEditor = true
                    }
                    .disabled(model.workspace == nil || actionsUnavailable)
                }
            }
        }
        .fileImporter(
            isPresented: $showingDocumentImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { model.reportError(error) }
                return
            }
            uploadDocument(from: url)
        }
        .fileImporter(
            isPresented: $showingBackstoryImporter,
            allowedContentTypes: [.plainText, .json, .data],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { model.reportError(error) }
                return
            }
            uploadBackstory(from: url)
        }
        .sheet(isPresented: $showingSkillCreator) {
            NavigationStack { SkillEditor(skill: nil) }
        }
        .sheet(isPresented: $showingIssueReporter) {
            NavigationStack {
                IssueReportForm {
                    issueReported = true
                }
            }
        }
        .sheet(item: $editingSkill) { skill in
            NavigationStack { SkillEditor(skill: skill) }
        }
        .confirmationDialog(
            "Delete skill?",
            isPresented: Binding(
                get: { skillPendingDeletion != nil },
                set: { if !$0 { skillPendingDeletion = nil } }
            ),
            titleVisibility: .visible,
            presenting: skillPendingDeletion
        ) { skill in
            Button("Delete skill", role: .destructive) {
                workspaceActionInFlight = skill.id
                Task {
                    _ = await model.deleteSkill(skill)
                    workspaceActionInFlight = nil
                }
            }
        } message: { skill in
            Text("This removes “\(skill.name)” and its usage history.")
        }
        .sheet(isPresented: $showingCostEditor) {
            if model.workspace?.isSectionAvailable("costs") != false,
               let costs = model.workspace?.costs {
                NavigationStack { CostLimitsEditor(costs: costs) }
            }
        }
    }

    private var header: some View {
        Text(area.introduction)
            .font(.subheadline)
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }
    private var actionsUnavailable: Bool { workspaceActionInFlight != nil || isLoading || loadFailed }

    @ViewBuilder
    private func loadMoreButton(
        section: WorkspacePageSection,
        pagination: WorkspaceSectionPagination?,
        archived: Bool = false
    ) -> some View {
        if let pagination, pagination.hasMore {
            let key = section == .chats ? "chats-\(archived ? "archived" : "current")" : section.rawValue
            VStack(spacing: 8) {
                Button {
                    Task { _ = await model.loadMoreWorkspace(section, archived: archived) }
                } label: {
                    if model.workspacePagesLoading.contains(key) {
                        ProgressView("Loading more")
                            .frame(maxWidth: .infinity)
                    } else {
                        Label("Load more · \(pagination.loaded) loaded", systemImage: "arrow.down.circle")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true))
                .disabled(model.workspacePagesLoading.contains(key) || isLoading)
                .accessibilityHint("Loads the next \(pagination.pageSize) items. More items are not loaded until requested.")
                if let message = model.workspacePageErrors[key] {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else if pagination.map(\.hasMore) == nil && workspaceSectionCount(section, archived: archived) >= 50 {
            Text("More items may be available, but this server did not provide a supported page cursor.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func workspaceSectionCount(_ section: WorkspacePageSection, archived: Bool) -> Int {
        guard let workspace = model.workspace else { return 0 }
        switch section {
        case .chats: return archived ? workspace.chats.archived.count : workspace.chats.current.count
        case .skills: return workspace.skills.count
        case .anomalies: return workspace.anomalies.count
        case .improvements: return workspace.improvements.count
        case .importSources: return workspace.imports?.sources.count ?? 0
        case .importFiles: return workspace.imports?.unstartedFiles.count ?? 0
        }
    }

    @ViewBuilder
    private func workspaceContent(_ workspace: WorkspaceResponse) -> some View {
        if let failedSection = area.availabilityKeys.first(where: { !workspace.isSectionAvailable($0) }) {
            WorkspaceAvailabilityNotice(title: failedSection.capitalized)
                .accessibilityIdentifier("workspace-section-unavailable-\(failedSection)")
        } else {
            workspaceContentAvailable(workspace)
        }
    }

    @ViewBuilder
    private func workspaceContentAvailable(_ workspace: WorkspaceResponse) -> some View {
        switch area {
        case .chats:
            chats(workspace.chats)
        case .skills:
            skills(workspace.skills)
        case .capabilities:
            capabilities(workspace.capabilities)
        case .costs:
            costs(workspace.costs)
        case .anomalies:
            anomalies(workspace.anomalies)
        case .improvements:
            improvements(workspace.improvements, repairs: workspace.repairs)
        case .documents:
            EmptyView()
        }
    }

    private func chats(_ chats: WorkspaceChats) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                sectionHeading("Current chats", count: chats.current.count)
                Spacer()
                Button {
                    guard !actionsUnavailable, !model.isSending else { return }
                    workspaceActionInFlight = "new-chat"
                    Task {
                        _ = await model.createConversation()
                        workspaceActionInFlight = nil
                    }
                } label: {
                    Label("New chat", systemImage: "plus")
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                .disabled(actionsUnavailable || model.isSending)
                .accessibilityHint(model.isSending ? "Finish or stop the current reply before opening another chat." : "")
                Menu {
                    Button("Archive inactive chats", systemImage: "archivebox") {
                        workspaceActionInFlight = "archive-inactive"
                        Task {
                            _ = await model.archiveInactiveConversations()
                            workspaceActionInFlight = nil
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                .disabled(actionsUnavailable)
            }

            if model.isSending {
                Text("Finish or stop the current reply before opening another chat.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if chats.current.isEmpty {
                emptyState("No conversations yet", symbol: "bubble.left")
            } else {
                ForEach(chats.current) { chat in
                    HStack(spacing: 12) {
                        Button {
                            openChat(chat)
                        } label: {
                            HStack(spacing: 12) {
                                AssistantGlyph(
                                    systemName: chat.isPrimary ? "bubble.left.fill" : "bubble.left",
                                    tint: AssistantTheme.accent(for: colorScheme),
                                    sunkenBackground: true
                                )
                                chatIdentity(chat)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(actionsUnavailable || model.isSending)
                        .accessibilityHint(model.isSending ? "Finish or stop the current reply before opening another chat." : "")
                        Spacer(minLength: 0)
                        if !chat.isPrimary {
                            Menu {
                                Button("Archive", systemImage: "archivebox") {
                                    updateChat(chat, action: "archive")
                                }
                                .disabled(chat.active)
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                            .disabled(actionsUnavailable)
                        }
                    }
                    .assistantCard(in: colorScheme)
                }
            }
            loadMoreButton(section: .chats, pagination: model.workspace?.sectionPagination?.chats?.current)

            if !chats.archived.isEmpty || model.workspace?.sectionPagination?.chats?.archived.hasMore == true {
                DisclosureGroup("Archived chats (\(chats.archived.count))") {
                    VStack(spacing: 0) {
                        ForEach(chats.archived) { chat in
                            HStack {
                                Button { openChat(chat) } label: {
                                if usesAccessibilityLayout {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(chat.displayTitle)
                                        Text(relative(chat.updatedAt))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                } else {
                                    HStack {
                                        Text(chat.displayTitle)
                                            .lineLimit(2)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Spacer()
                                        Text(relative(chat.updatedAt))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                }
                                .buttonStyle(.plain)
                                .disabled(actionsUnavailable || model.isSending)
                                .accessibilityHint(model.isSending ? "Finish or stop the current reply before opening another chat." : "")
                                Spacer()
                                Button("Restore", systemImage: "tray.and.arrow.up") {
                                    updateChat(chat, action: "restore")
                                }
                                .labelStyle(.iconOnly)
                                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                                .disabled(actionsUnavailable)
                            }
                            .padding(.vertical, 10)
                            if chat.id != chats.archived.last?.id { Divider() }
                        }
                    }
                    .padding(.top, 8)
                    loadMoreButton(section: .chats, pagination: model.workspace?.sectionPagination?.chats?.archived, archived: true)
                }
                .font(.subheadline.weight(.semibold))
                .assistantPanel(in: colorScheme)
            }
        }
    }

    private var documentsContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let documents = model.overview?.documents {
                metricGrid([
                    ("Filed", documents.stats.total, "doc", AssistantTheme.accent(for: colorScheme)),
                    ("Ready", documents.stats.ready, "checkmark.circle", AssistantTheme.success(for: colorScheme)),
                    ("Reading", documents.stats.pending, "clock.arrow.circlepath", AssistantTheme.warning(for: colorScheme)),
                ])

                sectionHeading("Filed documents", count: documents.documents.count)
                if documents.documents.isEmpty {
                    emptyState("No documents filed", symbol: "doc")
                } else {
                    ForEach(documents.documents) { document in
                        documentCard(document)
                    }
                }
                if let pagination = documents.pagination, pagination.isSupported, pagination.hasMore {
                    VStack(spacing: 8) {
                        Button {
                            Task { _ = await model.loadMoreDocuments() }
                        } label: {
                            if model.documentPageLoading {
                                ProgressView("Loading more documents")
                                    .frame(maxWidth: .infinity)
                            } else {
                                Label("Load more documents · \(documents.documents.count) loaded", systemImage: "arrow.down.circle")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true))
                        .disabled(model.documentPageLoading || isLoading)
                        .accessibilityHint("Loads the next \(pagination.pageSize) documents. More are not loaded until requested.")
                        if let message = model.documentPageError {
                            Text(message)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else if documents.hasMore == true || documents.documents.count < documents.stats.total {
                    Text("More documents may be available, but this server did not provide a supported page cursor.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if model.workspace?.isSectionAvailable("imports") == false {
                    WorkspaceAvailabilityNotice(title: "Backstory imports")
                } else if let imports = model.workspace?.imports {
                    backstoryImports(imports)
                }
            } else if !loadFailed {
                AssistantLoadingState(title: "Loading documents")
            }
        }
    }

    private func skills(_ skills: [WorkspaceSkill]) -> some View {
        let active = skills
            .filter { !$0.deprecated }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let retired = skills
            .filter(\.deprecated)
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

        return VStack(alignment: .leading, spacing: 16) {
            if skills.isEmpty {
                skillEmptyState
            } else {
                skillLibrarySummary(skills, activeCount: active.count)

                sectionHeading("Ready to use", count: active.count)
                if active.isEmpty {
                    compactSkillEmptyState
                } else {
                    ForEach(active) { skill in
                        skillCard(skill)
                    }
                }

                if !retired.isEmpty {
                    retiredSkills(retired)
                }
            }
            loadMoreButton(section: .skills, pagination: model.workspace?.sectionPagination?.skills)
        }
    }

    @ViewBuilder
    private func capabilities(_ capabilities: [WorkspaceCapability]?) -> some View {
        if let capabilities {
            let enabledCount = capabilities.filter(\.enabled).count
            let readyCount = capabilities.filter { $0.enabled && $0.ready }.count

            VStack(alignment: .leading, spacing: 14) {
                metricGrid([
                    ("Installed", enabledCount, "puzzlepiece.extension", AssistantTheme.accent(for: colorScheme)),
                    ("Ready", readyCount, "checkmark.circle", AssistantTheme.success(for: colorScheme)),
                    ("Available", capabilities.count, "square.grid.2x2", .secondary),
                ])

                sectionHeading("Optional capabilities", count: capabilities.count)

                ForEach(capabilities) { capability in
                    let tint: Color = if !capability.enabled {
                        .secondary
                    } else if capability.ready {
                        AssistantTheme.success(for: colorScheme)
                    } else if capability.status == "unavailable" {
                        .secondary
                    } else {
                        AssistantTheme.warning(for: colorScheme)
                    }

                    HStack(alignment: .top, spacing: 12) {
                        AssistantGlyph(systemName: capability.icon, tint: tint)
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 5) {
                            if usesAccessibilityLayout {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(capability.title)
                                        .font(.headline)
                                    workspaceTag(capability.statusTitle, tint: tint)
                                }
                            } else {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(capability.title)
                                        .font(.headline)
                                    Spacer(minLength: 4)
                                    workspaceTag(capability.statusTitle, tint: tint)
                                }
                            }
                            Text(capability.summary)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            if capability.enabled && !capability.ready {
                                Text(capability.detail.sentenceCaseIdentifier)
                                    .font(.caption)
                                    .foregroundStyle(
                                        capability.status == "unavailable"
                                            ? Color.secondary
                                            : AssistantTheme.warning(for: colorScheme)
                                    )
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .assistantCard(in: colorScheme)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(capability.title), \(capability.statusTitle). \(capability.summary)")
                }
            }
        } else {
            AssistantEmptyState(
                "Capabilities unavailable",
                systemImage: "puzzlepiece.extension",
                description: "Update the assistant server to see installed optional tools."
            )
        }
    }

    private func costs(_ costs: WorkspaceCosts) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.workspace?.isSectionAvailable("billing") == false {
                WorkspaceAvailabilityNotice(title: "Provider billing")
            } else if let billing = costs.billing {
                sectionHeading("Provider billing")
                ForEach(billing) { report in
                    providerBillingCard(report)
                }
            }
            sectionHeading("Assistant usage ledger")
            Text("Includes estimates used for spending limits. These limits do not cap your cloud bill. Ledger costs overlap provider billing and are not added to it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let evidence = costs.byEvidence {
                SpendingBreakdownCard(title: "Cost evidence this month", rows: evidence.map { ($0.label, Optional($0.usd), $0.count) })
            }
            if usesAccessibilityLayout {
                VStack(spacing: 10) {
                    costMetric("Today", spent: costs.dailySpentUsd, limit: costs.dailyLimitUsd)
                    costMetric("This month", spent: costs.monthlySpentUsd, limit: costs.monthlyLimitUsd)
                }
            } else {
                HStack(spacing: 10) {
                    costMetric("Today", spent: costs.dailySpentUsd, limit: costs.dailyLimitUsd)
                    costMetric("This month", spent: costs.monthlySpentUsd, limit: costs.monthlyLimitUsd)
                }
            }

            if costs.parkedTasks > 0 {
                Label(
                    "\(costs.parkedTasks) \(costs.parkedTasks == 1 ? "task is" : "tasks are") paused at a spending limit.",
                    systemImage: "pause.circle"
                )
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AssistantTheme.warningSurface(for: colorScheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }

            if costs.heldUsd > 0 {
                Label("\(currency(costs.heldUsd)) reserved for work in progress", systemImage: "clock.arrow.circlepath")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            sectionHeading("Usage this month")
            SpendingBreakdownCard(title: "By source", rows: costs.bySource.map { ($0.source, $0.usd, $0.count) })
            SpendingBreakdownCard(title: "By model", rows: costs.byModel.map { ($0.model, $0.usd, $0.count) })
            Button("Edit assistant limits", systemImage: "slider.horizontal.3") {
                showingCostEditor = true
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
        }
    }

    private func providerBillingCard(_ report: WorkspaceProviderBilling) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(report.label).font(.headline)
            Text("\(report.scope) · \(report.period) · \(report.source)").font(.caption).foregroundStyle(.secondary)
            if report.lines.isEmpty {
                Text(report.includedIn != nil ? "Included in Google Cloud" : report.status == "not_configured" ? "Setup needed" : "Unavailable").font(.title3.weight(.semibold))
            } else {
                let currencies = Dictionary(grouping: report.lines, by: \.currency)
                ForEach(currencies.keys.sorted(), id: \.self) { code in
                    let total = currencies[code, default: []].reduce(0) { $0 + $1.net }
                    Text(total, format: .currency(code: code).precision(.fractionLength(2))).font(.title3.weight(.semibold)).monospacedDigit()
                }
                if let forecast = report.forecast {
                    ForEach(forecast.totals, id: \.currency) { total in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Estimated month end").font(.caption).foregroundStyle(.secondary)
                            Text(total.projected, format: .currency(code: total.currency).precision(.fractionLength(2)))
                                .font(.title2.weight(.semibold)).monospacedDigit()
                            Text("Average per day: \(total.dailyAverage.formatted(.currency(code: total.currency).precision(.fractionLength(2))))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                    }
                    Text(forecast.message).font(.caption).foregroundStyle(.secondary)
                } else if report.status == "reported" {
                    Text("Month-end estimate needs at least three days of reported usage.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("Services and credits") {
                    ForEach(Array(report.lines.enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(line.service).font(.subheadline)
                            Text(line.detail).font(.caption).foregroundStyle(.secondary)
                            Text(line.net, format: .currency(code: line.currency).precision(.fractionLength(2...8))).monospacedDigit()
                            if line.credits != 0 {
                                Text("Credits: \(line.credits.formatted(.currency(code: line.currency)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                    }
                }
            }
            if report.status == "stale" {
                Label("Stale snapshot", systemImage: "clock.badge.exclamationmark").font(.subheadline)
            }
            Text(report.message).font(.footnote).foregroundStyle(.secondary)
            if report.id == "google-cloud", report.status == "not_configured" {
                Text("Enable standard usage export in Google Cloud Billing, then connect its BigQuery table and grant this installation read access. Initial data can take hours or days. Missing costs are not zero.")
                    .font(.footnote).foregroundStyle(.secondary)
                Link("Open Google Cloud Billing", destination: URL(string: "https://console.cloud.google.com/billing")!)
                    .font(.subheadline)
                Link("Export setup guide", destination: URL(string: "https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup")!)
                    .font(.subheadline)
            }
            if let fetched = report.fetchedAt {
                Text("Fetched \(fetched)").font(.caption2).foregroundStyle(.secondary)
            }
            if let exported = report.latestExportAt {
                Text("Latest export \(exported)").font(.caption2).foregroundStyle(.secondary)
            }
            if let used = report.latestUsageAt {
                Text("Latest usage \(used)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
    }

    private func anomalies(_ anomalies: [WorkspaceAnomaly]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("Needs a closer look", count: anomalies.count)
            if anomalies.isEmpty {
                emptyState("Nothing unusual", symbol: "checkmark.shield")
            } else {
                ForEach(anomalies) { anomaly in
                    VStack(alignment: .leading, spacing: 10) {
                        if usesAccessibilityLayout {
                            VStack(alignment: .leading, spacing: 4) {
                                workspaceTag(
                                    anomaly.kind.sentenceCaseIdentifier,
                                    tint: anomaly.kind == "burst"
                                        ? .red
                                        : AssistantTheme.warning(for: colorScheme)
                                )
                                Text(anomaly.toolName.sentenceCaseIdentifier)
                                    .font(.headline)
                                Text(relative(anomaly.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    workspaceTag(
                                        anomaly.kind.sentenceCaseIdentifier,
                                        tint: anomaly.kind == "burst"
                                            ? .red
                                            : AssistantTheme.warning(for: colorScheme)
                                    )
                                    Text(anomaly.toolName.sentenceCaseIdentifier)
                                        .font(.headline)
                                }
                                Spacer()
                                Text(relative(anomaly.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(anomaly.detail)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Observed \(anomaly.observed)× · expected \(anomaly.expected)× · \(anomaly.citationCount) evidence items")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        AssistantFlowLayout(spacing: 9) {
                            if anomaly.hasPolicy {
                                Button("Suspend policy", systemImage: "pause.circle") {
                                    updateAnomaly(anomaly, action: "suspend-policy")
                                }
                                .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                            }
                            Button("Dismiss", systemImage: "xmark") {
                                updateAnomaly(anomaly, action: "dismiss")
                            }
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                        }
                        .disabled(actionsUnavailable)
                    }
                    .assistantCard(in: colorScheme)
                }
            }
            loadMoreButton(section: .anomalies, pagination: model.workspace?.sectionPagination?.anomalies)
        }
    }

    private func improvements(_ improvements: [WorkspaceImprovement], repairs: WorkspaceRepairs?) -> some View {
        let directlyApplyable = improvements.filter(\.applyable)
        let advisory = improvements.filter { !$0.applyable }

        return VStack(alignment: .leading, spacing: 16) {
            Button {
                issueReported = false
                showingIssueReporter = true
            } label: {
                HStack(spacing: 10) {
                    Label("Report an issue", systemImage: "plus.bubble")
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).accessibilityHidden(true)
                }
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true))
            .disabled(actionsUnavailable)

            if let receipt = improvementReceipt {
                VStack(alignment: .leading, spacing: 6) {
                    Label(receipt.receiptTitle, systemImage: "checkmark.circle")
                        .font(.subheadline.weight(.semibold))
                    Text(receipt.receiptDetail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .assistantPanel(in: colorScheme)
                .accessibilityElement(children: .combine)
            }

            if issueReported {
                Label("Issue reported. Follow its progress under Code fixes.", systemImage: "checkmark.circle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("issue-report-success")
            }
            if model.workspace?.isSectionAvailable("repairs") == false {
                WorkspaceAvailabilityNotice(title: "Code fixes")
            } else if let repairs {
                repairIssues(repairs)
            }

            if improvements.isEmpty {
                improvementEmptyState
            } else {
                improvementReviewSummary(improvements, applyableCount: directlyApplyable.count)

                if !directlyApplyable.isEmpty {
                    sectionHeading("Model routing proposals", count: directlyApplyable.count)
                    ForEach(directlyApplyable) { improvement in
                        improvementCard(improvement)
                    }
                }

                if !advisory.isEmpty {
                    sectionHeading("For your review", count: advisory.count)
                    ForEach(advisory) { improvement in
                        improvementCard(improvement)
                    }
                }
            }
            loadMoreButton(section: .improvements, pagination: model.workspace?.sectionPagination?.improvements)
        }
    }

    private func repairIssues(_ repairs: WorkspaceRepairs) -> some View {
        let active = repairs.issues.filter { !RepairPresentation(status: $0.status).isClosed }
        let closed = repairs.issues.filter { RepairPresentation(status: $0.status).isClosed }
        return VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Code fixes", count: active.count)
            Text(repairs.enabled && repairs.configured
                 ? "Investigation is on. Review code before merging, then confirm the original problem is fixed."
                 : "Automatic coding is not configured yet. Reports are saved for review.")
                .font(.subheadline).foregroundStyle(.secondary)
            if active.isEmpty {
                AssistantEmptyState("No active code fixes", systemImage: "wrench.and.screwdriver",
                    description: "Report a problem above, or request a code fix from a proposal.")
            }
            ForEach(active) { issue in
                repairIssueCard(issue, repairs: repairs)
            }
            if !closed.isEmpty {
                DisclosureGroup("Past reports (\(closed.count))") {
                    VStack(spacing: 12) {
                        ForEach(closed) { issue in
                            repairIssueCard(issue, repairs: repairs)
                        }
                    }
                    .padding(.top, 8)
                }
                .font(.subheadline.weight(.semibold))
                .assistantPanel(in: colorScheme)
            }
        }
    }

    private func repairIssueCard(_ issue: WorkspaceRepairIssue, repairs: WorkspaceRepairs) -> some View {
        let presentation = RepairPresentation(status: issue.status, manualRunRequested: issue.manualRunRequested == true, deploymentConfirmed: issue.deploymentConfirmed == true)
        let waitingForRefresh = repairAcknowledgedRevisions[issue.id] == issue.actionRevision
        return VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    if workspaceActionInFlight == issue.id {
                        ProgressView("Updating report").font(.caption)
                    } else {
                        Text(presentation.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Text(issue.title).font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text(presentation.detail).font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(issue.diagnosis.isEmpty ? issue.summary : issue.diagnosis).font(.subheadline)
                    Text("Updated \(relative(issue.updatedAt))").font(.caption).foregroundStyle(.secondary)
                    if let position = issue.queuePosition {
                        Text("Queue position: \(position)").font(.caption).foregroundStyle(.secondary)
                    }
                    if let reason = issue.waitingReason {
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                    if let outcome = issue.outcome { Text("\(outcome.message) \(outcome.nextStep)").font(.subheadline).foregroundStyle(.secondary) }
                    else if !issue.lastError.isEmpty { AssistantInlineFailure(message: issue.lastError) }
                    if repairFailureID == issue.id {
                        AssistantInlineFailure(message: "Couldn’t confirm that request. Refresh the report before trying again.")
                    }
                    if waitingForRefresh {
                        Text("Request saved. Refresh to see the report’s current state.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let link = issue.prUrl, let url = URL(string: link), url.scheme == "https", url.host == "github.com" {
                        Link("Review pull request", destination: url).font(.subheadline.weight(.semibold))
                    }
                    if let link = issue.runUrl, let url = URL(string: link), url.scheme == "https", url.host == "github.com" {
                        Link("View coding run", destination: url).font(.subheadline)
                    }
                    Group {
                    if presentation.canRetry && repairs.enabled && repairs.configured {
                        Button("Retry within daily allowance", systemImage: "arrow.clockwise") {
                            updateRepair(issue, action: "retry")
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                    }
                    if repairs.enabled && repairs.configured && presentation.canRequestManualRun {
                        AssistantConfirmationButton("Run now", confirmationTitle: "Start an extra coding attempt?", systemImage: "play",
                            kind: .primary, hint: "Authorizes one manual attempt beyond the automatic daily coding allowance. Provider usage may be billed.") {
                            updateRepair(issue, action: "run_now")
                        }
                    }
                    if presentation.canConfirmFixed {
                        AssistantConfirmationButton("Confirm fixed", confirmationTitle: "Is the original problem fixed?", systemImage: "checkmark",
                            kind: .primary, hint: "Confirm after checking the original behavior. Deployment alone does not confirm the fix.") {
                            updateRepair(issue, action: "resolve")
                        }
                    }
                    if presentation.canDismiss {
                        AssistantConfirmationButton("Dismiss report", hint: "Removes this report from the active queue.") {
                            updateRepair(issue, action: "dismiss")
                        }
                    }
                    }
                    .disabled(actionsUnavailable || waitingForRefresh)
                    repairEvidence(issue)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .assistantCard(in: colorScheme)
        }
    }

    @ViewBuilder
    private func repairEvidence(_ issue: WorkspaceRepairIssue) -> some View {
        if issue.mergeSha != nil || !(issue.history ?? []).isEmpty {
            DisclosureGroup("Evidence and history") {
                VStack(alignment: .leading, spacing: 10) {
                    if let sha = issue.mergeSha, !sha.isEmpty {
                        LabeledContent("Merged revision", value: String(sha.prefix(12)))
                            .font(.caption.monospaced())
                    }
                    ForEach(Array((issue.history ?? []).enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(RepairPresentation(status: entry.status).title).font(.caption.weight(.semibold))
                            Text(relative(entry.at)).font(.caption).foregroundStyle(.secondary)
                            if !entry.detail.isEmpty {
                                Text(entry.detail).font(.caption).foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(.top, 8)
            }
            .font(.subheadline)
        }
    }

    private func updateRepair(_ issue: WorkspaceRepairIssue, action: String) {
        guard !actionsUnavailable, repairAcknowledgedRevisions[issue.id] != issue.actionRevision else { return }
        repairFailureID = nil
        workspaceActionInFlight = issue.id
        let session = model.composerDraftScope?.session
        Task {
            let confirmed = await model.updateRepair(issue, action: action)
            guard model.composerDraftScope?.session == session else { return }
            if confirmed { repairAcknowledgedRevisions[issue.id] = issue.actionRevision }
            else { repairFailureID = issue.id }
            workspaceActionInFlight = nil
            AccessibilityNotification.Announcement(confirmed ? "Request saved" : "Request couldn’t be confirmed").post()
        }
    }

    private var improvementEmptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            AssistantGlyph(
                systemName: "checkmark.seal",
                tint: AssistantTheme.success(for: colorScheme)
            )
            VStack(alignment: .leading, spacing: 4) {
                Text("All caught up")
                    .font(.headline)
                Text("New proposals will appear after the assistant finds a repeatable way to improve reliability or cost.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Label("Pull down to check again", systemImage: "arrow.down")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .assistantPanel(in: colorScheme)
    }

    private func improvementReviewSummary(
        _ improvements: [WorkspaceImprovement],
        applyableCount: Int
    ) -> some View {
        let evidenceCount = improvements.reduce(0) { $0 + max(0, $1.evidenceCount) }
        return AssistantFlowLayout(spacing: 12) {
            Label("\(improvements.count) open", systemImage: "tray")
            if applyableCount > 0 {
                Text("\(applyableCount) routing \(applyableCount == 1 ? "proposal" : "proposals")")
            }
            if evidenceCount > 0 { Text("\(evidenceCount) evidence signals") }
        }
        .font(.subheadline)
        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        .accessibilityElement(children: .combine)
    }

    private func improvementCard(_ improvement: WorkspaceImprovement) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            improvementCardHeader(improvement)

            if !improvement.rationale.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    CardEyebrow("Why this surfaced")
                    Text(inlineMarkdown(improvement.rationale))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !improvement.suggestion.isEmpty {
                detailPill(
                    improvement.applyable ? "Proposed routing change" : "Suggested direction",
                    systemImage: improvement.applyable ? "wand.and.stars" : "lightbulb",
                    detail: improvement.suggestion,
                    tint: improvement.applyable
                        ? AssistantTheme.accent(for: colorScheme).opacity(0.09)
                        : AssistantTheme.sunken(for: colorScheme)
                )
            }

            improvementEvidenceLedger(improvement)
            if improvementFailureID == improvement.id {
                AssistantInlineFailure(message: improvementFailureDetail ?? "Couldn’t confirm that decision. Check the proposal and refresh before trying again.")
            }
            if recordedImprovementIDs.contains(improvement.id) {
                Text("Decision saved. Refresh to update the proposal queue.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            improvementActions(improvement)
        }
        .assistantCard(in: colorScheme)
    }

    private func improvementCardHeader(_ improvement: WorkspaceImprovement) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if usesAccessibilityLayout {
                AssistantFlowLayout(spacing: 10) {
                    improvementKind(improvement)
                    improvementStatus(improvement)
                }
            } else {
                HStack(spacing: 10) {
                    improvementKind(improvement)
                    Spacer(minLength: 6)
                    improvementStatus(improvement)
                }
            }

            Text(inlineMarkdown(improvement.title))
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func improvementKind(_ improvement: WorkspaceImprovement) -> some View {
        Label(
            improvement.kind.sentenceCaseIdentifier,
            systemImage: improvement.applyable ? "wrench.and.screwdriver" : "text.magnifyingglass"
        )
        .font(.caption.weight(.semibold))
        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
    }

    @ViewBuilder
    private func improvementStatus(_ improvement: WorkspaceImprovement) -> some View {
        if workspaceActionInFlight == improvement.id {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Updating")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
        } else if recordedImprovementIDs.contains(improvement.id) {
            workspaceTag("Decision recorded", tint: AssistantTheme.inkMuted(for: colorScheme))
        } else {
            workspaceTag(
                improvement.applyable ? "Proposed routing change" : "Guidance",
                tint: AssistantTheme.inkMuted(for: colorScheme)
            )
        }
    }

    private func improvementEvidenceLedger(_ improvement: WorkspaceImprovement) -> some View {
        let count = max(0, improvement.evidenceCount)

        return AssistantFlowLayout(spacing: 10) {
            Label(
                "\(count) \(count == 1 ? "evidence signal" : "evidence signals")",
                systemImage: "point.3.connected.trianglepath.dotted"
            )
            Label(
                improvement.applyable ? "Direct change" : "Guidance only",
                systemImage: improvement.applyable ? "bolt" : "doc.text"
            )
            Text("Proposed \(relative(improvement.createdAt))")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            AssistantTheme.sunken(for: colorScheme),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    private var canRequestCodeFix: Bool {
        model.workspace?.repairs?.enabled == true && model.workspace?.repairs?.configured == true
    }

    private func improvementActions(_ improvement: WorkspaceImprovement) -> some View {
        let presentation = ImprovementActionPresentation(applyable: improvement.applyable, canRequestCodeFix: canRequestCodeFix)
        return AssistantFlowLayout(spacing: AssistantTheme.actionSpacing) {
            if improvement.applyable {
                AssistantConfirmationButton(presentation.primaryTitle, confirmationTitle: "Apply this routing change?",
                    systemImage: presentation.primarySymbol, kind: .primary,
                    hint: "Changes live model routing after the server validates the proposal. Review the evidence and expected behavior first.", compact: true) {
                    updateImprovement(improvement, action: presentation.primaryAction)
                }
            } else {
                Button(presentation.primaryTitle, systemImage: presentation.primarySymbol) {
                    updateImprovement(improvement, action: presentation.primaryAction)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
            }
            if presentation.offersAcknowledgment {
                Button("Mark reviewed", systemImage: "checkmark") {
                    updateImprovement(improvement, action: .apply)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                .accessibilityHint("Records that you reviewed the guidance. Does not change code.")
            }
            Button("Dismiss", systemImage: "xmark") {
                updateImprovement(improvement, action: .dismiss)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        }
        .disabled(actionsUnavailable || recordedImprovementIDs.contains(improvement.id))
    }

    private func documentCard(_ document: DocumentRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            documentHeader(document)
            Text("\(ByteCountFormatter.string(fromByteCount: Int64(document.bytes), countStyle: .file)) · \(document.chunkCount) searchable \(document.chunkCount == 1 ? "passage" : "passages")")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            if document.status == "ready" {
                AssistantFlowLayout(spacing: 9) {
                    Button {
                        model.returnToChat()
                        model.send("From my documents, tell me about \"\(document.title)\".")
                    } label: {
                        Label("Ask about this", systemImage: "bubble.left")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                    .disabled(model.isSending)
                    AssistantConfirmationButton("Delete", hint: "Removes the file and its searchable passages.") {
                        workspaceActionInFlight = document.id
                        _ = await model.deleteDocument(document)
                        workspaceActionInFlight = nil
                    }
                    .disabled(actionsUnavailable)
                }
                .accessibilityHint(
                    model.isSending
                        ? "Finish or stop the current response first"
                        : "Starts a question in chat"
                )
            }
            if document.status == "failed", let error = document.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
            }
            if document.status != "ready" {
                AssistantConfirmationButton("Delete", hint: "Removes the file and its searchable passages.") {
                    workspaceActionInFlight = document.id
                    _ = await model.deleteDocument(document)
                    workspaceActionInFlight = nil
                }
                .disabled(actionsUnavailable)
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func backstoryImports(_ imports: WorkspaceImports) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionHeading("Backstory imports", count: imports.sources.count)
                Spacer()
                Button("Upload", systemImage: "tray.and.arrow.down") {
                    showingBackstoryImporter = true
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            }
            if imports.filesAvailability?.isAvailable == false {
                WorkspaceAvailabilityNotice(title: "Workspace files")
            }
            ForEach(imports.filesAvailability?.isAvailable == false ? [] : imports.unstartedFiles) { file in
                HStack {
                    Text(file.name)
                        .font(.subheadline)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Start") {
                        updateImport(
                            action: "start",
                            source: file.name.replacingOccurrences(
                                of: #"\.[A-Za-z0-9]+$"#,
                                with: "",
                                options: .regularExpression
                            ).lowercased(),
                            workspacePath: "import/\(file.name)"
                        )
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                }
                .assistantCard(in: colorScheme)
            }
            if let pagination = model.workspace?.sectionPagination?.importFiles {
                loadMoreButton(section: .importFiles, pagination: pagination)
            }
            if imports.sourceAvailability?.isAvailable == false {
                WorkspaceAvailabilityNotice(title: "Import history")
            }
            ForEach(imports.sources) { source in
                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(source.source).font(.headline)
                            Text("\(source.memoriesSaved) saved · \(source.itemsProcessed) processed")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusPill(status: source.status)
                    }
                    if source.quarantinedNow > 0 {
                        Text("\(source.quarantinedNow) memories are waiting for review.")
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                    }
                    if let error = source.error, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                    importActions(source)
                }
                .assistantCard(in: colorScheme)
            }
            if let pagination = model.workspace?.sectionPagination?.importSources {
                loadMoreButton(section: .importSources, pagination: pagination)
            }
        }
    }

    /// Controls for one import source.
    ///
    /// "Purge memories" and "Delete source" name two different destructive
    /// acts on the same card, so neither can be shortened into the other
    /// without becoming ambiguous, and the three of them will not share a line
    /// at any type size. They used to wrap as one undifferentiated run, which
    /// is what made the wrap read as an accident: a pending review sat in the
    /// same row as a deletion. Reviewing the quarantine is a separate decision
    /// from maintaining the source, so it gets its own row.
    ///
    /// Both rows stay `AssistantFlowLayout` rather than becoming stacks. It is
    /// the only layout here that measures per item, so a row that outgrows the
    /// card at large type wraps instead of squeezing its labels.
    private func importActions(_ source: WorkspaceImportSource) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if source.quarantinedNow > 0 {
                AssistantFlowLayout(spacing: 9) {
                    importReviewButtons(source)
                }
            }
            AssistantFlowLayout(spacing: 9) {
                importOverflowMenu(source)
                importPurgeButton(source)
                importDeleteButton(source)
            }
        }
        .disabled(actionsUnavailable)
    }

    @ViewBuilder
    private func importReviewButtons(_ source: WorkspaceImportSource) -> some View {
        Button("Approve all") {
            updateImport(action: "review", source: source.source, verdict: "approve")
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .primary))
        // Deletes and tombstones every held-back memory at once, so it asks
        // twice — as Reject does for a single memory.
        AssistantConfirmationButton("Reject all", confirmationTitle: "Reject all?", systemImage: "xmark",
            hint: "Deletes every memory this import is holding for review.") {
            updateImport(action: "review", source: source.source, verdict: "reject")
        }
    }

    private func importOverflowMenu(_ source: WorkspaceImportSource) -> some View {
        Menu {
            Button("Run again") {
                updateImport(
                    action: "start",
                    source: source.source,
                    workspacePath: source.workspacePath
                )
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
    }

    private func importPurgeButton(_ source: WorkspaceImportSource) -> some View {
        AssistantConfirmationButton("Purge memories") {
            updateImport(action: "purge", source: source.source)
        }
    }

    private func importDeleteButton(_ source: WorkspaceImportSource) -> some View {
        AssistantConfirmationButton("Delete source") {
            updateImport(action: "delete", source: source.source)
        }
    }

    @ViewBuilder
    private func documentHeader(_ document: DocumentRecord) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center) {
                    documentGlyph(document)
                    Spacer(minLength: 10)
                    StatusPill(status: document.status)
                }
                documentIdentity(document)
            }
        } else {
            HStack(alignment: .top, spacing: 11) {
                documentGlyph(document)
                documentIdentity(document)
                Spacer()
                StatusPill(status: document.status)
            }
        }
    }

    private func documentGlyph(_ document: DocumentRecord) -> some View {
        AssistantGlyph(
            systemName: documentIcon(document.mime),
            tint: AssistantTheme.accent(for: colorScheme),
            sunkenBackground: true
        )
    }

    private func documentIdentity(_ document: DocumentRecord) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(document.title)
                .font(.headline)
                .lineLimit(usesAccessibilityLayout ? nil : 2)
            Text(document.source == "email" ? "Email attachment" : document.source.sentenceCaseIdentifier)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func costMetric(_ title: String, spent: Double, limit: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(currency(spent)).font(.title3.monospacedDigit().weight(.semibold))
            Text(limit.map { "of \(currency($0))" } ?? "No cap")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let limit, limit > 0 {
                GeometryReader { geometry in
                    Capsule()
                        .fill(AssistantTheme.sunken(for: colorScheme))
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(spent >= limit ? Color.red : AssistantTheme.accent(for: colorScheme))
                                .frame(width: geometry.size.width * min(max(spent / limit, 0), 1))
                        }
                }
                .frame(height: 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    private func inlineMarkdown(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: source, options: options))
            ?? AttributedString(source)
    }

    @ViewBuilder
    private func metricGrid(_ metrics: [(String, Int, String, Color)]) -> some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: usesAccessibilityLayout ? 1 : min(metrics.count, 3)),
            spacing: 8
        ) {
            metricCards(metrics)
        }
    }

    @ViewBuilder
    private func metricCards(_ metrics: [(String, Int, String, Color)]) -> some View {
        ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
            VStack(alignment: .leading, spacing: 5) {
                Image(systemName: metric.2)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(metric.3)
                    .accessibilityHidden(true)
                Text("\(metric.1)")
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .contentTransition(.numericText(value: Double(metric.1)))
                    .animation(
                        reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0),
                        value: metric.1
                    )
                Text(metric.0)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantCard(in: colorScheme)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(metric.0), \(metric.1)")
        }
    }

    private func chatIdentity(_ chat: WorkspaceChat) -> some View {
        VStack(alignment: .leading, spacing: usesAccessibilityLayout ? 6 : 3) {
            if usesAccessibilityLayout {
                Text(chat.displayTitle)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    chatTags(chat)
                }
            } else {
                HStack(spacing: 6) {
                    Text(chat.displayTitle)
                        .font(.headline)
                        .lineLimit(1)
                    chatTags(chat)
                }
            }
            Text("Last active \(relative(chat.updatedAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func chatTags(_ chat: WorkspaceChat) -> some View {
        if chat.isPrimary {
            workspaceTag("Main", tint: AssistantTheme.accent(for: colorScheme))
        }
        if chat.active {
            workspaceTag("Working", tint: AssistantTheme.warning(for: colorScheme))
        }
    }

    private var skillEmptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            AssistantGlyph(
                systemName: "book.pages",
                tint: AssistantTheme.accent(for: colorScheme)
            )
            VStack(alignment: .leading, spacing: 4) {
                Text("Build a procedure library")
                    .font(.headline)
                Text("Add a repeatable way of working, or let the assistant learn one from completed work.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Add your first skill", systemImage: "plus") {
                showingSkillCreator = true
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .primary))
        }
        .assistantPanel(in: colorScheme)
    }

    private var compactSkillEmptyState: some View {
        HStack(alignment: .top, spacing: 12) {
            AssistantGlyph(systemName: "archivebox", tint: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("No active procedures")
                    .font(.subheadline.weight(.semibold))
                Text("Restore one from the retired section or add a new skill.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .assistantPanel(in: colorScheme)
    }

    private func skillLibrarySummary(_ skills: [WorkspaceSkill], activeCount: Int) -> some View {
        let totalRuns = skills.reduce(0) { $0 + max(0, $1.useCount) }
        let successes = skills.reduce(0) { $0 + max(0, $1.successCount) }
        let evaluatedRuns = skills.reduce(0) {
            $0 + max(0, $1.successCount) + max(0, $1.failureCount)
        }
        let successRate = evaluatedRuns > 0
            ? "\(Int((Double(successes) / Double(evaluatedRuns) * 100).rounded()))%"
            : "—"

        return VStack(alignment: .leading, spacing: 10) {
            Text("Your assistant’s playbook")
                .font(.title3.weight(.semibold))
            Text("Repeatable ways of working, ready when they’re needed.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            AssistantFlowLayout(spacing: 14) {
                Label("\(activeCount) active", systemImage: "checkmark.circle")
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                Text("\(totalRuns) uses")
                if evaluatedRuns > 0 {
                    Text("\(successRate) successful")
                }
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.top, 2)
        }
        .padding(.vertical, 8)
    }

    private func summaryMetric(_ value: String, label: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(tint)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(value)")
    }

    private func skillCard(_ skill: WorkspaceSkill) -> some View {
        VStack(alignment: .leading, spacing: AssistantTheme.cardContentSpacing) {
            HStack(alignment: .top, spacing: 8) {
                skillIdentity(skill)
                Spacer(minLength: 0)
                skillActions(skill)
            }

            DisclosureGroup(isExpanded: Binding(
                get: { expandedSkillIDs.contains(skill.id) },
                set: { expanded in
                    if expanded { expandedSkillIDs.insert(skill.id) }
                    else { expandedSkillIDs.remove(skill.id) }
                }
            )) {
                VStack(alignment: .leading, spacing: 16) {
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Procedure")
                            .font(.subheadline.weight(.semibold))
                        Text(skill.steps)
                            .font(.subheadline)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !skill.preconditions.isEmpty {
                        skillDetail("Use when", detail: skill.preconditions)
                    }
                    if !skill.gotchas.isEmpty {
                        skillDetail("Watch for", detail: skill.gotchas, warning: true)
                    }
                    Divider()
                    skillUsageLedger(skill)
                }
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    if !skill.preconditions.isEmpty && !expandedSkillIDs.contains(skill.id) {
                        Text(skill.preconditions)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(usesAccessibilityLayout ? nil : 2)
                    }
                    Text(expandedSkillIDs.contains(skill.id) ? "Hide procedure" : "View procedure")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .assistantCard(in: colorScheme, strokeTint: AssistantTheme.inkMuted(for: colorScheme).opacity(0.3))
    }

    private func skillIdentity(_ skill: WorkspaceSkill) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(skill.name)
                .font(.headline)
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            Label(
                skill.ownerAuthored ? "Written by you" : "Learned from completed work",
                systemImage: skill.ownerAuthored ? "person" : "sparkles"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func skillDetail(_ title: String, detail: String, warning: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(warning ? AssistantTheme.warning(for: colorScheme) : AssistantTheme.inkMuted(for: colorScheme))
            Text(detail)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func detailPill(
        _ title: String,
        systemImage: String = "arrow.triangle.2.circlepath",
        detail: String,
        tint: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            Text(detail)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(tint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func skillUsageLedger(_ skill: WorkspaceSkill) -> some View {
        let evaluatedRuns = max(0, skill.successCount) + max(0, skill.failureCount)
        let rate = evaluatedRuns > 0
            ? Int((Double(max(0, skill.successCount)) / Double(evaluatedRuns) * 100).rounded())
            : nil

        return AssistantFlowLayout(spacing: 10) {
            Label(
                skill.useCount == 0 ? "Not used yet" : "\(skill.useCount) uses",
                systemImage: "arrow.triangle.2.circlepath"
            )
            if let rate {
                Label("\(rate)% successful", systemImage: "checkmark.circle")
                    .foregroundStyle(AssistantTheme.success(for: colorScheme))
            }
            Text("Updated \(relative(skill.updatedAt))")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func skillActions(_ skill: WorkspaceSkill) -> some View {
        Menu {
            Button("Edit skill", systemImage: "pencil") { editingSkill = skill }
            if skill.deprecated {
                Button("Restore skill", systemImage: "arrow.uturn.backward") {
                    setSkill(skill, deprecated: false)
                }
            } else {
                Button("Retire skill", systemImage: "archivebox") {
                    setSkill(skill, deprecated: true)
                }
            }
            Divider()
            Button("Delete skill", systemImage: "trash", role: .destructive) {
                skillPendingDeletion = skill
            }
        } label: {
            AssistantActionMenuLabel(isUpdating: workspaceActionInFlight == skill.id)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Actions for \(skill.name)")
        .disabled(actionsUnavailable)
    }

    private func retiredSkills(_ skills: [WorkspaceSkill]) -> some View {
        DisclosureGroup {
            VStack(spacing: 0) {
                ForEach(skills) { skill in
                    retiredSkillRow(skill)
                    if skill.id != skills.last?.id { Divider() }
                }
            }
            .padding(.top, 6)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "archivebox")
                    .foregroundStyle(.secondary)
                Text("Retired procedures")
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                countTag(skills.count)
            }
        }
        .assistantPanel(in: colorScheme)
    }

    @ViewBuilder
    private func retiredSkillRow(_ skill: WorkspaceSkill) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                retiredSkillIdentity(skill)
                retiredSkillActions(skill)
            }
            .padding(.vertical, 10)
        } else {
            HStack(alignment: .center, spacing: 12) {
                retiredSkillIdentity(skill)
                Spacer(minLength: 8)
                retiredSkillActions(skill)
            }
            .padding(.vertical, 10)
        }
    }

    private func retiredSkillIdentity(_ skill: WorkspaceSkill) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(skill.name)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text("\(skill.useCount) uses · updated \(relative(skill.updatedAt))")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func retiredSkillActions(_ skill: WorkspaceSkill) -> some View {
        skillActions(skill)
    }

    private func setSkill(_ skill: WorkspaceSkill, deprecated: Bool) {
        workspaceActionInFlight = skill.id
        Task {
            _ = await model.setSkillDeprecated(skill, deprecated: deprecated)
            workspaceActionInFlight = nil
        }
    }

    @ViewBuilder
    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                if let count { countTag(count) }
            }
        } else {
            HStack(spacing: 7) {
                Text(title).font(.headline)
                if let count { countTag(count) }
            }
        }
    }

    private func countTag(_ count: Int) -> some View {
        Text("\(count)")
            .font(.caption.monospacedDigit().weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
    }

    private func workspaceTag(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 7)
            .padding(.vertical, 6)
            .background(tint.opacity(0.11), in: Capsule())
    }

    private func emptyState(_ title: String, symbol: String) -> some View {
        AssistantEmptyState(title, systemImage: symbol)
    }

    private func documentIcon(_ mime: String) -> String {
        if mime.contains("pdf") { return "doc.richtext" }
        if mime.contains("image") { return "photo" }
        return "doc.text"
    }

    private func currency(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(value > 0 && value < 0.01 ? 4 : 2)))
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    private func openChat(_ chat: WorkspaceChat) {
        guard !actionsUnavailable, !model.isSending else { return }
        workspaceActionInFlight = chat.id
        Task {
            _ = await model.openConversation(id: chat.id)
            workspaceActionInFlight = nil
        }
    }

    private func updateChat(_ chat: WorkspaceChat, action: String) {
        workspaceActionInFlight = chat.id
        Task {
            _ = await model.updateConversation(chat, action: action)
            workspaceActionInFlight = nil
        }
    }

    private func updateAnomaly(_ anomaly: WorkspaceAnomaly, action: String) {
        workspaceActionInFlight = anomaly.id
        Task {
            _ = await model.updateAnomaly(anomaly, action: action)
            workspaceActionInFlight = nil
        }
    }

    private func updateImprovement(_ improvement: WorkspaceImprovement, action: WorkspaceImprovementAction) {
        guard !actionsUnavailable, !recordedImprovementIDs.contains(improvement.id) else { return }
        improvementFailureID = nil
        improvementFailureDetail = nil
        improvementReceipt = nil
        workspaceActionInFlight = improvement.id
        let session = model.composerDraftScope?.session
        Task {
            let result = await model.updateImprovement(improvement, action: action.rawValue)
            guard model.composerDraftScope?.session == session else { return }
            if let result, result.ok {
                improvementReceipt = result
                recordedImprovementIDs.insert(improvement.id)
                AccessibilityNotification.Announcement(result.receiptTitle).post()
            } else {
                improvementFailureID = improvement.id
                if let detail = result?.detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    improvementFailureDetail = detail
                }
                AccessibilityNotification.Announcement("Decision couldn’t be confirmed").post()
            }
            workspaceActionInFlight = nil
        }
    }

    private func uploadDocument(from url: URL) {
        beginFileImport(url, action: "document-upload") { data in
            let type = UTType(filenameExtension: url.pathExtension)
            return await model.uploadDocument(
                data: data,
                name: url.lastPathComponent,
                title: url.deletingPathExtension().lastPathComponent,
                mime: type?.preferredMIMEType ?? "application/octet-stream"
            )
        }
    }

    private func uploadBackstory(from url: URL) {
        beginFileImport(url, action: "backstory-upload") { data in
            await model.uploadImport(data: data, name: url.lastPathComponent)
        }
    }

    private func beginFileImport(
        _ url: URL,
        action: String,
        upload: @escaping (Data) async -> Bool
    ) {
        cancelFileImport(showStatus: false)
        let requestID = UUID()
        fileImportID = requestID
        fileImportStage = "reading"
        workspaceActionInFlight = action
        fileImportTask = Task { @MainActor in
            do {
                let data = try await AssistantBoundedFileReader.read(from: url)
                guard !Task.isCancelled, fileImportID == requestID else { return }
                fileImportStage = "uploading"
                let confirmed = await upload(data)
                guard fileImportID == requestID else { return }
                if !confirmed {
                    model.errorMessage = "The upload status could not be confirmed. Check the workspace before retrying."
                }
                finishFileImport(requestID)
            } catch {
                guard fileImportID == requestID else { return }
                if !(error is CancellationError) { model.errorMessage = error.localizedDescription }
                finishFileImport(requestID)
            }
        }
    }

    private func finishFileImport(_ requestID: UUID) {
        guard fileImportID == requestID else { return }
        fileImportTask = nil
        fileImportID = nil
        fileImportStage = nil
        workspaceActionInFlight = nil
    }

    private func cancelFileImport(showStatus: Bool = true) {
        guard fileImportID != nil else { return }
        let wasUploading = fileImportStage == "uploading"
        self.fileImportID = nil
        fileImportTask?.cancel()
        fileImportTask = nil
        fileImportStage = nil
        if workspaceActionInFlight == "document-upload" || workspaceActionInFlight == "backstory-upload" {
            workspaceActionInFlight = nil
        }
        if showStatus {
            model.errorMessage = wasUploading
                ? "The screen closed while the upload was running. Its status is unknown; check the workspace before retrying."
                : "The file read was cancelled before upload. Nothing was sent."
        }
    }

    private func updateImport(
        action: String,
        source: String,
        verdict: String? = nil,
        workspacePath: String? = nil
    ) {
        workspaceActionInFlight = source
        Task {
            _ = await model.updateImport(
                action: action,
                source: source,
                verdict: verdict,
                workspacePath: workspacePath
            )
            workspaceActionInFlight = nil
        }
    }

    private func load() async {
        if loadFailed || model.workspace == nil || (area == .documents && model.overview == nil) || area == .improvements {
            await refresh()
        }
    }

    private func refresh() async {
        guard !isLoading, workspaceActionInFlight == nil else { return }
        isLoading = true
        let refreshed: Bool
        if area == .documents {
            async let overviewRefresh: Void = model.refreshOverview()
            async let workspaceRefresh: Bool = model.refreshWorkspace()
            let (_, workspaceLoaded) = await (overviewRefresh, workspaceRefresh)
            refreshed = workspaceLoaded && model.overview?.documents != nil
        } else {
            refreshed = await model.refreshWorkspace()
        }
        isLoading = false
        guard !Task.isCancelled else { return }
        loadFailed = !refreshed
    }
}

/// Preserve every entry and distinguish unavailable amounts from genuine zero
/// spending. Sorting is stable for ties, and ratios never enter invalid geometry.
struct SpendingBreakdown {
    struct Entry: Identifiable {
        let id: Int
        let label: String
        let amount: Double?
        let count: Int

        var amountLabel: String {
            guard let amount else { return "Unavailable" }
            if amount > 0 && amount < 0.000001 { return "< $0.000001" }
            return amount.formatted(.currency(code: "USD").precision(.fractionLength(2...6)))
        }
    }
    let entries: [Entry]
    let maximum: Double

    init(rows: [(String, String?, Int)]) {
        entries = rows.enumerated().map { index, row in
            let parsed = row.1.flatMap(Double.init)
            let amount = parsed.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            return Entry(id: index, label: row.0, amount: amount, count: max(0, row.2))
        }.sorted {
            let left = $0.amount ?? -1, right = $1.amount ?? -1
            return left == right ? $0.id < $1.id : left > right
        }
        maximum = entries.compactMap(\.amount).max() ?? 0
    }

    func fraction(for entry: Entry) -> Double {
        guard maximum > 0, let amount = entry.amount else { return 0 }
        return min(1, max(0, amount / maximum))
    }
}

struct SpendingBreakdownCard: View {
    let title: String
    let rows: [(String, String?, Int)]
    @State var showingAll = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let breakdown = SpendingBreakdown(rows: rows)
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                if !rows.isEmpty {
                    Text("Largest reported spend first").font(.caption).foregroundStyle(.secondary)
                }
            }
            if rows.isEmpty {
                Text("No spending recorded this month.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                ForEach(breakdown.entries.prefix(5)) { entry in
                    spendingRow(entry, fraction: breakdown.fraction(for: entry))
                }
                if breakdown.entries.count > 5 {
                    DisclosureGroup("\(breakdown.entries.count - 5) more entries", isExpanded: $showingAll) {
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach(breakdown.entries.dropFirst(5)) { entry in
                                spendingRow(entry, fraction: breakdown.fraction(for: entry))
                            }
                        }
                    }
                    .font(.subheadline)
                    .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func spendingRow(_ entry: SpendingBreakdown.Entry, fraction: Double) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.label).font(.subheadline.weight(.medium))
                    Text(entry.amountLabel).font(.subheadline.monospacedDigit())
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(entry.label).font(.subheadline.weight(.medium))
                    Spacer(minLength: 4)
                    Text(entry.amountLabel).font(.subheadline.monospacedDigit())
                        .layoutPriority(1)
                }
            }
            Text("\(entry.count) usage \(entry.count == 1 ? "entry" : "entries")")
                .font(.caption).foregroundStyle(.secondary)
            if entry.amount != nil {
                GeometryReader { geometry in
                    Capsule().fill(AssistantTheme.sunken(for: colorScheme))
                        .overlay(alignment: .leading) {
                            Capsule().fill(AssistantTheme.accent(for: colorScheme))
                                .frame(width: geometry.size.width * fraction)
                        }
                }
                .frame(height: 5)
                .accessibilityHidden(true)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}

private struct SkillEditor: View {
    let skill: WorkspaceSkill?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var preconditions: String
    @State private var steps: String
    @State private var gotchas: String
    @State private var isSaving = false
    @State private var saveFailed = false
    @FocusState private var focusedField: SkillEditorField?

    init(skill: WorkspaceSkill?) {
        self.skill = skill
        _name = State(initialValue: skill?.name ?? "")
        _preconditions = State(initialValue: skill?.preconditions ?? "")
        _steps = State(initialValue: skill?.steps ?? "")
        _gotchas = State(initialValue: skill?.gotchas ?? "")
    }

    var body: some View {
        AssistantForm {
            Section {
                TextField("e.g. Prepare a project brief", text: $name)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .name)
                    .onSubmit { focusedField = .preconditions }
            } header: {
                Label("Name", systemImage: "tag")
            } footer: {
                Text("Use a short name that describes the repeatable outcome.")
            }

            Section {
                TextField(
                    "Describe the situation that should trigger this procedure.",
                    text: $preconditions,
                    axis: .vertical
                )
                .lineLimit(3...7)
                .focused($focusedField, equals: .preconditions)
            } header: {
                Label("Use when", systemImage: "scope")
            } footer: {
                Text("Optional. This helps the assistant choose the skill at the right moment.")
            }

            Section {
                TextField(
                    "Write the procedure in the order it should be followed.",
                    text: $steps,
                    axis: .vertical
                )
                .lineLimit(5...12)
                .focused($focusedField, equals: .steps)
            } header: {
                Label("Procedure", systemImage: "list.bullet.rectangle")
            } footer: {
                Text("Required. Keep decisions and checkpoints explicit.")
            }

            Section {
                TextField(
                    "Add failure modes, exceptions, or checks worth remembering.",
                    text: $gotchas,
                    axis: .vertical
                )
                .lineLimit(3...8)
                .focused($focusedField, equals: .gotchas)
            } header: {
                Label("Watch for", systemImage: "exclamationmark.triangle")
            } footer: {
                Text("Optional. Name the edge cases that make this procedure safer.")
            }
            if saveFailed {
                Section { AssistantInlineFailure(message: "Couldn’t save this skill. Your entries are kept; try again.") }
            }
        }
        .disabled(isSaving)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(skill == nil ? "New skill" : "Edit skill")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(isSaving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button { save() } label: {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Saving skill")
                    } else {
                        Text(skill == nil ? "Add" : "Save")
                    }
                }
                    .disabled(
                        isSaving
                            || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || steps.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
        }
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        saveFailed = false
        Task {
            let saved = await model.saveSkill(
                id: skill?.id,
                mutation: .init(
                    name: name,
                    preconditions: preconditions,
                    steps: steps,
                    gotchas: gotchas
                )
            )
            isSaving = false
            saveFailed = !saved
            if saved { dismiss() }
        }
    }
}

private enum SkillEditorField: Hashable {
    case name
    case preconditions
    case steps
    case gotchas
}

private struct CostLimitsEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var taskDefault: String
    @State private var daily: String
    @State private var monthly: String
    @State private var isSaving = false
    @State private var saveFailed = false

    init(costs: WorkspaceCosts) {
        _taskDefault = State(initialValue: costs.taskDefaultLimit ?? "")
        _daily = State(initialValue: costs.dailyLimitUsd.map { String($0) } ?? "")
        _monthly = State(initialValue: costs.monthlyLimitUsd.map { String($0) } ?? "")
    }

    var body: some View {
        AssistantForm {
            Section {
                AssistantField("Default task limit (USD)") {
                    TextField("Default task limit", text: $taskDefault)
                        .keyboardType(.decimalPad)
                }
                AssistantField("Daily limit (USD)") {
                    TextField("Daily limit", text: $daily)
                        .keyboardType(.decimalPad)
                }
                AssistantField("Monthly limit (USD)") {
                    TextField("Monthly limit", text: $monthly)
                        .keyboardType(.decimalPad)
                }
            } header: {
                Text("Assistant limits in USD")
            } footer: {
                Text("These limits pause assistant work using its usage ledger. They do not cap Google Cloud billing or stop hosting and storage charges. Limits must be between $0.01 and $10,000. Blank fields keep their current value.")
            }
            if saveFailed {
                Section { AssistantInlineFailure(message: "Couldn’t save these limits. Check the amounts and try again; your entries are kept.") }
            }
        }
        .disabled(isSaving)
        .navigationTitle("Assistant limits")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(isSaving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving)
            }
        }
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        saveFailed = false
        Task {
            let saved = await model.updateCostLimits(
                .init(taskDefault: taskDefault, daily: daily, monthly: monthly)
            )
            isSaving = false
            saveFailed = !saved
            if saved { dismiss() }
        }
    }
}

private struct IssueReportForm: View {
    let onReported: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var sourceTaskId: String?
    @State private var happened = ""
    @State private var expected = ""
    @State private var submitting = false
    @State private var submissionError: String?

    private var cleanTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cleanHappened: String { happened.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cleanExpected: String { expected.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var summary: String {
        "What happened:\n\(cleanHappened)\n\nWhat I expected:\n\(cleanExpected)"
    }
    private var canSubmit: Bool {
        (3...200).contains(cleanTitle.count) && cleanHappened.count >= 5 &&
        cleanExpected.count >= 5 && summary.count <= 3000 && !submitting
    }

    var body: some View {
        AssistantForm {
            Section {
                TextField("Short title", text: $title)
                    .accessibilityIdentifier("issue-report-title")
                Text("\(cleanTitle.count)/200 characters")
                    .font(.caption).foregroundStyle(.secondary)
            } header: {
                Text("Issue")
            }
            Section {
                TextField("Describe the steps and what went wrong", text: $happened, axis: .vertical)
                    .lineLimit(4...8)
                    .accessibilityLabel("What happened")
                    .accessibilityIdentifier("issue-report-happened")
            } header: {
                Text("What happened?")
            }
            Section {
                TextField("Describe what should have happened", text: $expected, axis: .vertical)
                    .lineLimit(3...6)
                    .accessibilityLabel("What you expected")
                    .accessibilityIdentifier("issue-report-expected")
            } header: {
                Text("What did you expect?")
            } footer: {
                Text("Include steps we can reproduce. Avoid passwords, API keys, and private information. Details must fit within 3,000 characters.")
            }
            Section {
                Picker("Related activity", selection: $sourceTaskId) {
                    Text("None selected").tag(String?.none)
                    ForEach(model.overview?.activity.items.filter {
                        !$0.type.hasPrefix("self.")
                    } ?? []) { task in
                        Text(task.title ?? task.type).tag(Optional(task.id))
                    }
                }
                .accessibilityIdentifier("issue-report-related-task")
            } footer: {
                Text("Select the task that went wrong to include its diagnostic history. Personal content stays out of the coding brief.")
            }
            Section {
                Text("The assistant will investigate. If it finds a code defect, it can prepare a fix for you to review.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if summary.count > 3000 {
                    Text("Please shorten the details to 3,000 characters.").foregroundStyle(.red)
                }
                if let submissionError {
                    Text(submissionError).foregroundStyle(.red)
                        .accessibilityIdentifier("issue-report-error")
                }
                Button {
                    submit()
                } label: {
                    HStack {
                        if submitting { ProgressView() }
                        Text(submitting ? "Submitting…" : "Submit issue")
                    }
                }
                .disabled(!canSubmit)
                .accessibilityIdentifier("issue-report-submit")
            }
        }
        .disabled(submitting)
        .navigationTitle("Report an issue")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(submitting)
            }
        }
        .interactiveDismissDisabled(submitting)
    }

    private func submit() {
        guard canSubmit else { return }
        submitting = true
        submissionError = nil
        Task {
            let saved = await model.reportRepair(title: cleanTitle, summary: summary, sourceTaskId: sourceTaskId)
            submitting = false
            if saved {
                onReported()
                dismiss()
            } else {
                submissionError = model.errorMessage ?? "Could not submit the issue. Please try again."
            }
        }
    }
}

#if DEBUG
extension WorkspaceView {
    @MainActor static func visualReviewScreen(_ name: String, workspace: WorkspaceResponse) -> AnyView? {
        switch name {
        case "new-skill": return AnyView(SkillEditor(skill: nil))
        case "edit-skill": return AnyView(SkillEditor(skill: workspace.skills.first))
        case "cost-limits": return AnyView(CostLimitsEditor(costs: workspace.costs))
        case "report-issue": return AnyView(IssueReportForm(onReported: {}))
        default: return nil
        }
    }
}
#endif
