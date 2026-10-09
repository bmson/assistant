import Foundation

struct APIConfiguration: Equatable, Sendable {
    let baseURL: URL
    let token: String
}

/// Owns the app's URLSession so its connection pool can be discarded wholesale.
///
/// `URLSession.shared` cannot be used for this: its configuration is immutable,
/// so `waitsForConnectivity` can never be set, and it can never be invalidated.
/// Its pool is process-global and survives suspension — which is the whole
/// problem. While the app is backgrounded the peer forgets the socket (NAT
/// eviction, a Wi-Fi/cellular handoff, the server's own keep-alive timeout) but
/// iOS keeps the entry. The next request is handed a connection that is already
/// dead, writes into a black hole, and never sees a byte back, so the
/// inactivity timer runs its full course before failing.
final class Transport: @unchecked Sendable {
    static let shared = Transport()

    private let lock = NSLock()
    private var _session: URLSession

    private init() { _session = Self.makeSession() }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        // A launch off the lock screen can beat the radio. Waiting is better
        // than failing a request the network was a moment away from carrying.
        configuration.waitsForConnectivity = true
        // Inactivity, not wall clock. Short enough that a stalled connection is
        // reported while the owner is still looking at the screen.
        configuration.timeoutIntervalForRequest = 30
        // A whole-task ceiling, where the default of seven days is none at all.
        // It has to clear the longest legitimate task rather than the typical
        // one: this bounds an SSE turn and a document upload, not just a GET.
        // 900s is the agent's own Cloud Run request timeout (infra/gcp/deploy.sh),
        // so nothing the server will still be working on gets cut off here.
        configuration.timeoutIntervalForResource = 900
        return URLSession(configuration: configuration)
    }

    var session: URLSession {
        lock.withLock { _session }
    }

    /// Drop every pooled connection and start clean. Called when the app returns
    /// from the background, where the pool is most likely to be holding sockets
    /// the other end has already forgotten.
    func reset() {
        lock.withLock {
            _session.invalidateAndCancel()
            _session = Self.makeSession()
        }
    }
}

enum APIError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case chatTurnCancelledBeforeAdmission(conversationId: String, clientOperationId: String)
    case unauthorized
    case server(status: Int, message: String)
    case decoding(model: String, detail: String)
    /// The request never reached the server, or its answer never came back.
    /// Distinct from every other case, all of which mean the server replied.
    case transport(URLError)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "Enter a valid Assistant server URL."
        case .invalidResponse: "The server returned an unreadable response."
        case .chatTurnCancelledBeforeAdmission: "This turn was cancelled before it was admitted."
        case .unauthorized: "The access key was not accepted by this Assistant server."
        case let .server(_, message): message
        case let .decoding(model, detail): "Could not read the \(model) response: \(detail)."
        case let .transport(error): Self.transportDescription(error)
        }
    }

    /// A transport failure is worth trying again; a server that answered on the
    /// merits is not. The banner uses this to decide whether to offer Retry.
    var isTransport: Bool {
        if case .transport = self { return true }
        return false
    }

    /// Say what the owner can act on. Foundation's own copy for these codes —
    /// "The request timed out." — names the symptom and not the situation, and
    /// reads like a bug in the app rather than a server still waking up.
    private static func transportDescription(_ error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet:
            "You appear to be offline."
        case .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
             .networkConnectionLost:
            "Couldn't reach your assistant — it may still be waking up."
        default:
            error.localizedDescription
        }
    }

    /// Name the field that failed rather than collapsing every mismatch into
    /// "unreadable response" — a decode failure against a server that answered
    /// 200 is otherwise indistinguishable from a network problem.
    static func decodeFailure(_ error: Error, as type: Any.Type) -> APIError {
        let model = String(describing: type)
        guard let decodingError = error as? DecodingError else {
            return .decoding(model: model, detail: error.localizedDescription)
        }
        func at(_ context: DecodingError.Context) -> String {
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? "the top level" : "'\(path)'"
        }
        let detail: String = switch decodingError {
        case let .keyNotFound(key, context): "'\(key.stringValue)' is missing at \(at(context))"
        case let .typeMismatch(_, context): "unexpected type at \(at(context))"
        case let .valueNotFound(_, context): "an expected value was null at \(at(context))"
        case let .dataCorrupted(context): "malformed data at \(at(context))"
        @unknown default: "an unrecognized decoding failure"
        }
        return .decoding(model: model, detail: detail)
    }
}

private final class NativeCardFormProjectionReadiness: @unchecked Sendable {
    private let lock = NSLock()
    private var enabled = false

    var isEnabled: Bool { lock.withLock { enabled } }

    func setEnabled(_ value: Bool) { lock.withLock { enabled = value } }
}

struct APIClient: Sendable {
    let configuration: APIConfiguration
    let clientID: String?
    /// A test seam. Production passes nothing and reads `Transport.shared` on
    /// every call, so a pool reset reaches clients that were built before it.
    private let sessionOverride: URLSession?
    /// Shared by value-copies of this client so session readiness gates every
    /// request path consistently. Replacing a server configuration starts
    /// with a fresh, disabled capability until that server's owner is verified.
    private let nativeCardFormProjectionReadiness: NativeCardFormProjectionReadiness

    init(configuration: APIConfiguration, session: URLSession? = nil, clientID: String? = nil) {
      self.configuration = configuration
      self.clientID = clientID ?? (session == nil ? KeychainStore.readOrCreateClientID() : nil)
      self.sessionOverride = session
      self.nativeCardFormProjectionReadiness = NativeCardFormProjectionReadiness()
    }

    /// Verify a candidate connection with the same transport. Production
    /// continues to use the shared pool; injected sessions remain isolated.
    func replacingConfiguration(_ configuration: APIConfiguration) -> APIClient {
      APIClient(configuration: configuration, session: sessionOverride, clientID: clientID)
    }

    var nativeCardFormsEnabled: Bool { nativeCardFormProjectionReadiness.isEnabled }

    func enableNativeCardForms() { nativeCardFormProjectionReadiness.setEnabled(true) }

    func disableNativeCardForms() { nativeCardFormProjectionReadiness.setEnabled(false) }

    private var session: URLSession { sessionOverride ?? Transport.shared.session }

    func bootstrap() async throws -> BootstrapResponse {
        try await get("api/mobile/v1/bootstrap")
    }

    func overview() async throws -> OverviewResponse {
        try await get("api/mobile/v1/overview")
    }

    func documentsPage(cursor: String, limit: Int = 50) async throws -> DocumentsOverview {
        guard (1...100).contains(limit) else { throw APIError.invalidResponse }
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/documents"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "cursor", value: cursor),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else { throw APIError.invalidResponse }
        return try await perform(makeRequest(url: url), as: DocumentsOverview.self)
    }

    func activity(archived: Bool, query: String = "", filter: String = "all", cursor: String? = nil) async throws -> ActivityList {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/activity"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [.init(name: "archived", value: archived ? "true" : "false"),
                                  .init(name: "q", value: query), .init(name: "filter", value: filter)]
        if let cursor { components?.queryItems?.append(.init(name: "cursor", value: cursor)) }
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: ActivityList.self)
    }

    func updateActivity(id: String, action: String, budgetUsdLimit: Double? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/activity/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            ActivityActionBody(action: action, budgetUsdLimit: budgetUsdLimit)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func archiveOldActivity(operationId: String? = nil) async throws -> ArchiveOldActivityProgress {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/activity"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body = ["action": "archive-old"]
        if let operationId { body["operationId"] = operationId }
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request, as: ArchiveOldActivityProgress.self)
    }

    func createGoal(_ goal: GoalMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/goals"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(goal)
        _ = try await perform(request, as: GoalCreateReceipt.self)
    }

    func goals(archived: Bool) async throws -> GoalsDashboard {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/goals"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [.init(name: "archived", value: archived ? "true" : "false")]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: GoalsDashboard.self)
    }

    func updateGoal(id: String, goal: GoalMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/goals/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(goal)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateGoal(id: String, action: String, status: String? = nil, enabled: Bool? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/goals/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            GoalActionBody(action: action, status: status, enabled: enabled)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func archiveInactiveGoals() async throws {
        try await postCollectionAction(path: "goals", action: "archive-inactive")
    }

    func createChat() async throws -> ChatCreateReceipt {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/chats"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": "create"])
        return try await perform(request, as: ChatCreateReceipt.self)
    }

    func archiveInactiveChats() async throws {
        try await postCollectionAction(path: "chats", action: "archive-inactive")
    }

    func conversation(id: String) async throws -> ConversationView {
        try await get("api/mobile/v1/chats/\(id)")
    }

    func updateChat(id: String, action: String, modelId: String? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/chats/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(ChatActionBody(action: action, modelId: modelId))
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Take one message out of the log, or put it back. The message is kept
    /// server-side and only skipped on read, so this is recoverable and the
    /// same decision reaches every surface the owner reads the thread on.
    func setMessageHidden(conversationId: String, messageId: String, hidden: Bool) async throws {
        var request = makeRequest(
            url: configuration.baseURL
                .appending(path: "api/mobile/v1/chats/\(conversationId)/messages/\(messageId)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": hidden ? "hide" : "unhide"])
        _ = try await perform(request, as: OkPayload.self)
    }

    func setRecallSourceSuppressed(
        surfaceKey: String,
        sourceRevision: String,
        suppressed: Bool
    ) async throws {
        guard Self.isDigest(surfaceKey), Self.isDigest(sourceRevision) else {
            throw APIError.invalidResponse
        }
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/recall/sources/\(surfaceKey)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            RecallSourceMutationBody(suppressed: suppressed, expectedSourceRevision: sourceRevision)
        )
        let response = try await perform(request, as: RecallSourceMutationResponse.self)
        guard response.ok, response.version > 0 else { throw APIError.invalidResponse }
    }

    func recallSourceSuppressed(surfaceKey: String, sourceRevision: String) async throws -> Bool {
        guard Self.isDigest(surfaceKey), Self.isDigest(sourceRevision) else { throw APIError.invalidResponse }
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/recall/sources/\(surfaceKey)"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "sourceRevision", value: sourceRevision)]
        guard let url = components?.url else { throw APIError.invalidResponse }
        let response: RecallSourceStateResponse = try await perform(makeRequest(url: url), as: RecallSourceStateResponse.self)
        return response.suppressed
    }

    private static func isDigest(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    func workspace() async throws -> WorkspaceResponse {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/workspace"))
        request.setValue("1", forHTTPHeaderField: "x-assistant-workspace-sections")
        return try await perform(request, as: WorkspaceResponse.self)
    }

    func workspacePage<Item: Codable & Sendable>(
        section: WorkspacePageSection,
        cursor: String,
        archived: Bool = false,
        limit: Int = 50
    ) async throws -> WorkspaceSectionPage<Item> {
        guard (1...100).contains(limit) else { throw APIError.invalidResponse }
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/workspace/sections/\(section.rawValue)"),
            resolvingAgainstBaseURL: false
        )
        var queryItems = [URLQueryItem(name: "cursor", value: cursor), URLQueryItem(name: "limit", value: String(limit))]
        if section == .chats {
            queryItems.append(URLQueryItem(name: "archived", value: archived ? "true" : "false"))
        }
        components?.queryItems = queryItems
        guard let url = components?.url else { throw APIError.invalidResponse }
        return try await perform(makeRequest(url: url), as: WorkspaceSectionPage<Item>.self)
    }

    func cards() async throws -> SavedCardsResponse {
        try await get("api/mobile/v1/cards")
    }

    func refreshCard(
        id: String,
        expectedRevisionId: String?,
        operationId: String
    ) async throws -> CardRefreshResult {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/cards/\(id)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body = ["action": "refresh", "operationId": operationId]
        if let expectedRevisionId, !expectedRevisionId.isEmpty {
            body["expectedRevisionId"] = expectedRevisionId
        }
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request, as: CardRefreshResult.self)
    }

    /// Live scores for a scoreboard card: `leagues` is `mlb:401,402;nfl:77`.
    func liveScoreboard(leagues: String) async throws -> LiveScoresPayload {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/live/scoreboard"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "leagues", value: leagues)]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: LiveScoresPayload.self)
    }

    func situationPacks() async throws -> SituationOverview {
        try await get("api/mobile/v1/packs")
    }

    func changeSituationPack(_ command: SituationCommand) async throws -> SituationCommandResult {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/packs"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(command)
        return try await perform(request, as: SituationCommandResult.self)
    }

    func dismissCard(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/cards/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": "dismiss"])
        _ = try await perform(request, as: OkPayload.self)
    }

    func knowledge(query: String = "", kind: String = "", page: Int = 1) async throws -> KnowledgeOverview {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            .init(name: "q", value: query.isEmpty ? nil : query),
            .init(name: "kind", value: kind.isEmpty ? nil : kind),
            .init(name: "page", value: String(max(page, 1))),
        ]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: KnowledgeOverview.self)
    }

    /// Find-as-you-type over graph items: names and kinds only. An older
    /// server ignores `mode` and answers with the browse overview, which also
    /// carries `entities`, so this decodes either.
    func searchKnowledge(query: String) async throws -> [KnowledgeEntity] {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [.init(name: "mode", value: "search"), .init(name: "q", value: query)]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: KnowledgeSearchResponse.self).entities
    }

    func relationshipGraph(personID: String? = nil, entityID: String? = nil, query: String = "") async throws -> RelationshipGraphSnapshot {
        var components = URLComponents(url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/graph"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "person", value: personID), URLQueryItem(name: "entity", value: entityID), URLQueryItem(name: "q", value: query.isEmpty ? nil : query)].filter { $0.value != nil }
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: RelationshipGraphSnapshot.self)
    }

    func knowledgeItem(id: String) async throws -> KnowledgeOverview {
        try await get("api/mobile/v1/knowledge/\(id)")
    }

    func knowledgeRelation(id: String) async throws -> KnowledgeRelation {
        try await get("api/mobile/v1/knowledge/relations/\(id)")
    }

    func removeKnowledgeRelation(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/relations/\(id)")
        )
        request.httpMethod = "DELETE"
        let result = try await perform(request, as: OkPayload.self)
        guard result.ok else {
            throw APIError.server(status: 409, message: "The relationship could not be removed.")
        }
    }

    func knowledgeReview() async throws -> KnowledgeReviewInbox {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [.init(name: "mode", value: "review")]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: KnowledgeReviewInbox.self)
    }

    func knowledgeCleanup() async throws -> KnowledgeCleanupResponse {
        try await get("api/mobile/v1/knowledge/cleanup")
    }

    func resolveKnowledgeCleanup(action: String, memoryId: String? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/cleanup")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body = ["action": action]
        if let memoryId { body["memoryId"] = memoryId }
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    func knowledgeSourceImpact(id: String) async throws -> KnowledgeSourceImpact {
        try await get("api/mobile/v1/knowledge/sources/\(id)")
    }

    func forgetKnowledgeSource(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/sources/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    @discardableResult
    func createKnowledgeConnection(_ mutation: KnowledgeConnectionMutation) async throws -> String {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(mutation)
        return try await perform(request, as: KnowledgeConnectionSavedPayload.self).relationId
    }

    func reviewKnowledgeRelation(id: String, approve: Bool) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/relations/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": approve ? "confirm" : "reject"])
        _ = try await perform(request, as: OkPayload.self)
    }

    func correctKnowledgeRelation(id: String, mutation: KnowledgeConnectionMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/relations/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            KnowledgeCorrectionMutation(
                action: "correct",
                subjectLabel: mutation.subjectLabel,
                subjectKind: mutation.subjectKind,
                subjectId: mutation.subjectId,
                predicate: mutation.predicate,
                objectLabel: mutation.objectLabel,
                objectKind: mutation.objectKind,
                objectId: mutation.objectId,
                note: mutation.note
            )
        )
        _ = try await perform(request, as: KnowledgeConnectionSavedPayload.self)
    }

    func updateKnowledgeItem(id: String, action: String, value: String) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/\(id)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: String] = action == "rename"
            ? ["action": action, "label": value]
            : ["action": action, "kind": value]
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    func mergeKnowledgeItem(id: String, targetId: String) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/knowledge/\(id)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": "merge", "targetId": targetId])
        _ = try await perform(request, as: OkPayload.self)
    }

    func uploadDocument(data: Data, name: String, title: String, mime: String) async throws {
        let boundary = "AssistantBoundary-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"title\"\r\n\r\n")
        append("\(title)\r\n")
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        append("Content-Type: \(mime)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/documents")
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        request.httpBody = body
        _ = try await perform(request, as: OkPayload.self)
    }

    func deleteDocument(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/documents/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func uploadImport(
        data: Data,
        name: String,
        source: String,
        voice: Bool,
        register: String
    ) async throws {
        let boundary = "AssistantImportBoundary-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        for (field, value) in [
            ("source", source),
            ("voice", voice ? "1" : "0"),
            ("register", register),
        ] {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(field)\"\r\n\r\n")
            append("\(value)\r\n")
        }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        append("Content-Type: text/plain\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/imports")
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        request.httpBody = body
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateImport(
        action: String,
        source: String,
        verdict: String? = nil,
        workspacePath: String? = nil
    ) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/imports"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            ImportActionBody(
                action: action,
                source: source,
                verdict: verdict,
                workspacePath: workspacePath
            )
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func createSkill(_ skill: SkillMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/skills"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(skill)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateSkill(id: String, skill: SkillMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/skills/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(skill)
        _ = try await perform(request, as: OkPayload.self)
    }

    func setSkillDeprecated(id: String, deprecated: Bool) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/skills/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["deprecated": deprecated])
        _ = try await perform(request, as: OkPayload.self)
    }

    func deleteSkill(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/skills/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateCostLimits(_ limits: CostLimitsMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/costs"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(limits)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateAnomaly(id: String, action: String) async throws {
        try await postWorkspaceAction(path: "anomalies/\(id)", action: action)
    }

    func updateRepair(id: String, action: String) async throws {
        try await postWorkspaceAction(path: "repairs/\(id)", action: action)
    }

    func reportRepair(title: String, summary: String, sourceTaskId: String? = nil) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/repairs"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var payload = ["title": title, "summary": summary]
        if let sourceTaskId { payload["sourceTaskId"] = sourceTaskId }
        request.httpBody = try JSONEncoder().encode(payload)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateImprovement(id: String, action: String) async throws -> ImprovementDecisionResult {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/improvements/\(id)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        return try await perform(request, as: ImprovementDecisionResult.self)
    }

    func updateSettings(_ settings: AgentSettingsMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/settings"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(settings)
        _ = try await perform(request, as: OkPayload.self)
    }

    func setScheduleEnabled(id: String, enabled: Bool) async throws {
        try await setEnabled(path: "settings/schedules/\(id)", enabled: enabled)
    }

    func deleteReminder(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/settings/reminders/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func setPolicyEnabled(id: String, enabled: Bool) async throws {
        try await setEnabled(path: "settings/policies/\(id)", enabled: enabled)
    }

    func deletePolicy(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/settings/policies/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func mcpConnections() async throws -> McpConnectionsResponse {
        try await get("api/mobile/v1/mcp")
    }

    func createMcpConnection(name: String, endpoint: String, bearerToken: String?) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/mcp"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body = ["name": name, "endpoint": endpoint]
        if let bearerToken, !bearerToken.isEmpty { body["bearerToken"] = bearerToken }
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: EmptyPayload.self)
    }

    func updateMcpConnection(id: String, action: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/mcp/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await perform(request, as: EmptyPayload.self)
    }

    func deleteMcpConnection(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/mcp/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func modelProviders() async throws -> ModelProviderSettings {
        try await get("api/mobile/v1/providers")
    }

    func connectModelProvider(_ input: ModelConnectionInput) async throws -> ProviderConnectResult {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/providers"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(input)
        return try await perform(request, as: ProviderConnectResult.self)
    }

    func testModelProvider(id: String) async throws -> ProviderTestResult {
        try await providerAction(id: id, body: ProviderActionBody(action: "test"), as: ProviderTestResult.self)
    }

    func setModelProviderEnabled(id: String, enabled: Bool) async throws {
        _ = try await providerAction(
            id: id,
            body: ProviderActionBody(action: enabled ? "enable" : "disable"),
            as: OkPayload.self
        )
    }

    func removeModelProvider(id: String) async throws {
        _ = try await providerAction(id: id, body: ProviderActionBody(action: "remove"), as: OkPayload.self)
    }

    func addProviderModel(
        connectionId: String,
        model: String,
        label: String?,
        inputPrice: String,
        outputPrice: String,
        thinking: Bool?
    ) async throws {
        _ = try await providerAction(
            id: connectionId,
            body: ProviderActionBody(
                action: "add_model",
                model: model,
                label: label,
                promptCostPerMTok: inputPrice,
                completionCostPerMTok: outputPrice,
                thinking: thinking
            ),
            as: EmptyPayload.self
        )
    }

    func chooseTextModels(main: String, fast: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/providers/choice")
        )
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["mainModel": main, "fastModel": fast])
        _ = try await perform(request, as: OkPayload.self)
    }

    func chooseVoiceModel(_ modelId: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/providers/choice")
        )
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["voiceModel": modelId])
        _ = try await perform(request, as: OkPayload.self)
    }

    func addVoicePreset(connectionId: String, model: String) async throws {
        _ = try await providerAction(
            id: connectionId,
            body: ProviderActionBody(action: "add_voice_preset", model: model),
            as: EmptyPayload.self
        )
    }

    func phoneCalls() async throws -> PhoneCallsResponse {
        try await get("api/mobile/v1/calls")
    }

    func phoneCall(id: String) async throws -> PhoneCallResponse {
        try await get("api/mobile/v1/calls/\(id)")
    }

    func answerCallCheckin(callId: String, checkinId: String, revision: Int, answer: String) async throws {
        try await callAction(callId: callId, body: [
            "action": "answer",
            "checkinId": checkinId,
            "revision": String(revision),
            "answer": answer,
        ])
    }

    func hangUpCall(callId: String) async throws {
        try await callAction(callId: callId, body: ["action": "hangup"])
    }

    private func callAction(callId: String, body: [String: String]) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/calls/\(callId)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    private func providerAction<T: Decodable>(
        id: String,
        body: ProviderActionBody,
        as type: T.Type
    ) async throws -> T {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/providers/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request, as: type)
    }

    func createMemory(_ memory: MemoryMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/memory"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(memory)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateMemory(id: String, content: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["content": content])
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateMemory(id: String, action: String, prominence: String? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: String] = ["action": action]
        if let prominence { body["prominence"] = prominence }
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateMemoryProfile(action: String) async throws {
        try await postWorkspaceAction(path: "memory/profile", action: action)
    }

    func memoryLibrary(_ query: MemoryLibraryQuery) async throws -> MemoryLibraryResponse {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/library"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = query.items
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: MemoryLibraryResponse.self)
    }

    func commitments() async throws -> CommitmentsResponse {
        try await get("api/mobile/v1/memory/commitments")
    }

    func updateCommitment(_ mutation: CommitmentMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/commitments")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(mutation)
        _ = try await perform(request, as: OkPayload.self)
    }

    func voiceProfile() async throws -> VoiceProfileResponse {
        try await get("api/mobile/v1/memory/profile")
    }

    func updateVoiceProfile(_ profile: VoiceProfileMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/profile")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(profile)
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Irreversible: drops saved facts, graph projections, voice samples, and
    /// the learned voice profile. Chats, goals and people records survive.
    func forgetLongTermMemory() async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/profile")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // The server asks for the intent twice on this one action; every other
        // action on that route is recoverable and this one is not.
        request.httpBody = try JSONEncoder().encode([
            "action": "forget-all",
            "confirm": "forget-all",
        ])
        _ = try await perform(request, as: OkPayload.self)
    }

    /// The owner's memory export, as the raw JSON bytes the server sends, so it
    /// can be written to a file and handed to the share sheet unmodified.
    func memoryExport() async throws -> Data {
        let request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/export")
        )
        let (data, response) = try await load(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        try await validate(http, data: data)
        return data
    }

    func createPerson(_ person: PersonMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(person)
        _ = try await perform(request, as: PersonCreateReceipt.self)
    }

    func updatePerson(id: String, person: PersonMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(person)
        _ = try await perform(request, as: OkPayload.self)
    }

    func deletePerson(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func personProfile(id: String) async throws -> PersonProfileResponse {
        try await get("api/mobile/v1/memory/people/\(id)")
    }

    /// The People directory. Separate from `memory/people`, which is the
    /// editing contract — this is the read the People screens render from.
    func people() async throws -> PersonDirectoryResponse {
        try await get("api/mobile/v1/people")
    }

    func peoplePage(cursor: String, limit: Int = 50) async throws -> PersonDirectoryResponse {
        guard (1...100).contains(limit) else { throw APIError.invalidResponse }
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/people"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "cursor", value: cursor),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else { throw APIError.invalidResponse }
        return try await perform(makeRequest(url: url), as: PersonDirectoryResponse.self)
    }

    func personCard(id: String) async throws -> PersonCard {
        try await get("api/mobile/v1/people/\(id)")
    }

    func addOccasion(personId: String, occasion: OccasionMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(
                path: "api/mobile/v1/memory/people/\(personId)/occasions"
            )
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(occasion)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateOccasion(id: String, occasion: OccasionMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/memory/occasions/\(id)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(occasion)
        _ = try await perform(request, as: OkPayload.self)
    }

    func reviewOccasion(id: String, verdict: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/occasions/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["verdict": verdict])
        _ = try await perform(request, as: OkPayload.self)
    }

    func deleteOccasion(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/occasions/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func mergePerson(id: String, targetId: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            PersonMergeBody(action: "merge", targetId: targetId)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Read whatever the conversation has produced since `cursor`.
    ///
    /// With `waitMilliseconds` the server is allowed to hold the connection
    /// until there is something to report, so the answer arrives when it is
    /// written rather than on the next tick of a client-side timer — and the
    /// phone spends one radio wake-up on the wait instead of one per interval.
    /// A server that does not understand `wait` simply answers immediately;
    /// PollingPolicy.gapMilliseconds is what keeps that from becoming a spin.
    func updates(
        conversationId: String,
        taskId: String?,
        cursor: String?,
        refreshIds: [String] = [],
        waitMilliseconds: Int64 = 0
    ) async throws -> ChatUpdates {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/chat/status"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            .init(name: "conversationId", value: conversationId),
            taskId.map { .init(name: "taskId", value: $0) },
            cursor.map { .init(name: "cursor", value: $0) },
            refreshIds.isEmpty
                ? nil
                : .init(name: "refresh", value: refreshIds.prefix(10).joined(separator: ",")),
            waitMilliseconds > 0 ? .init(name: "wait", value: String(waitMilliseconds)) : nil
        ].compactMap { $0 }
        guard let url = components?.url else { throw APIError.invalidServerURL }
        var request = makeRequest(url: url)
        if waitMilliseconds > 0 {
            // The session default (30s) leaves no room above a 20s hold once
            // the network is slow. Clear the hold by a wide margin so a held
            // poll ends at the server's choosing, never as a client timeout.
            request.timeoutInterval = Double(waitMilliseconds) / 1_000 + 30
        }
        return try await perform(request, as: ChatUpdates.self)
    }

    func decideApproval(id: String, decision: String) async throws -> ApprovalResult {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/approvals/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["decision": decision])
        return try await perform(request, as: ApprovalResult.self)
    }

    /// Answer a proactive suggestion. A 400 or 409 comes back with the
    /// server's own words, which the card shows where the owner tapped.
    func decideSuggestion(id: String, decision: SuggestionDecision) async throws -> SuggestionResult {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/suggestions/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["decision": decision])
        return try await perform(request, as: SuggestionResult.self)
    }

    func approveAndRemember(id: String) async throws -> ApprovalResult {
        try await approvalAction(id: id, body: ApprovalActionBody(action: "remember", payload: nil))
    }

    func editAndApprove(id: String, payload: JSONValue) async throws -> ApprovalResult {
        try await approvalAction(id: id, body: ApprovalActionBody(action: "edit", payload: payload))
    }

    /// Fire-and-forget ambient ping; callers use `try?` — a failed post only
    /// means the next foreground refresh carries the position.
    func postLocationPing(_ ping: LocationPingBody) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/location"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(ping)
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Fire-and-forget APNs token registration; the next app launch retries,
    /// so a failed post only delays proactive pushes until then.
    func postDeviceToken(_ body: DeviceTokenBody) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Foreground "wake" signal; the server dedupes its own reactions to it.
    func postForegroundActivity() async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/activity/foreground"))
        request.httpMethod = "POST"
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Sends the exact body persisted by CardFormDraftCoordinator. This write is
    /// never retried here: a missing response remains unknown and the caller
    /// replays the same frozen operation explicitly.
    func submitCardForm(_ pending: CardFormPendingRequest) async throws -> CardFormHTTPResult {
        guard pending.body.count <= 16 * 1024,
              let encoded = try? JSONDecoder().decode(CardFormSubmission.self, from: pending.body),
              encoded == pending.submission else {
            throw APIError.invalidResponse
        }
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/chat/forms"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = pending.body
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await load(request)
        } catch {
            return .init(admission: .init(operationId: encoded.operationId, outcome: .outcomeUnknown), messageCursor: nil)
        }
        guard let http = response as? HTTPURLResponse else {
            return .init(admission: .init(operationId: encoded.operationId, outcome: .outcomeUnknown), messageCursor: nil)
        }
        if (200..<300).contains(http.statusCode) {
            guard let envelope = try? JSONDecoder().decode(CardFormAdmissionEnvelope.self, from: data),
                  envelope.ok == true, let taskId = envelope.taskId, UUID(uuidString: taskId) != nil,
                  let messageId = envelope.messageId, UUID(uuidString: messageId) != nil,
                  let taskStatus = envelope.status ?? envelope.taskStatus,
                  Self.isCardFormTaskStatus(taskStatus),
                  let messageCursor = envelope.messageCursor,
                  !messageCursor.isEmpty, messageCursor.utf8.count <= 4_096,
                  (envelope.queueGeneration ?? 0) >= 0 else {
                // A malformed success response may follow a committed task.
                // Preserve the operation as unknown and retry only its body.
                return .init(admission: .init(operationId: encoded.operationId, outcome: .outcomeUnknown), messageCursor: nil)
            }
            let receipt = CardFormAdmissionReceipt(
                taskId: taskId, messageId: messageId, taskStatus: taskStatus,
                queueGeneration: envelope.queueGeneration ?? 0, created: envelope.created ?? false,
                dispatch: envelope.dispatch.flatMap(CardFormDispatch.init(rawValue:))
            )
            return .init(
                admission: .init(operationId: encoded.operationId, outcome: .accepted(receipt)),
                messageCursor: messageCursor
            )
        }
        guard (400..<500).contains(http.statusCode),
              let envelope = try? JSONDecoder().decode(CardFormAdmissionEnvelope.self, from: data),
              envelope.ok != true else {
            return .init(admission: .init(operationId: encoded.operationId, outcome: .outcomeUnknown), messageCursor: nil)
        }
        if http.statusCode == 409, envelope.ok == false, envelope.reason == "active_form",
           let taskId = envelope.activeTaskId, UUID(uuidString: taskId) != nil,
           let taskStatus = envelope.taskStatus,
           Self.isCardFormTaskStatus(taskStatus) {
            return .init(
                admission: .init(
                    operationId: encoded.operationId,
                    outcome: .activeForm(.init(taskId: taskId, taskStatus: taskStatus))
                ),
                messageCursor: nil
            )
        }
        // Only the exact typed freshness conflict proves the operation was not
        // admitted. Other 4xx responses, including generic 409 and expired 401,
        // may follow a commit and therefore remain replayable as unknown.
        if http.statusCode == 409, envelope.ok == false, envelope.reason == "stale_revision" {
            return .init(
                admission: .init(operationId: encoded.operationId, outcome: .rejected(status: 409, code: "stale_revision")),
                messageCursor: nil
            )
        }
        return .init(admission: .init(operationId: encoded.operationId, outcome: .outcomeUnknown), messageCursor: nil)
    }

    private static func isCardFormTaskStatus(_ value: String) -> Bool {
        CardFormDraftCoordinator.isKnownTaskStatus(value)
    }

    func encodeChatRequest(
        conversationId: String,
        text: String,
        clientOperationId: String,
        autonomous: Bool,
        force: Bool,
        spoken: Bool,
        clientMessageId: String
    ) throws -> Data {
        let body = ChatRequest(
            conversationId: conversationId,
            clientOperationId: clientOperationId,
            clientId: clientID,
            autonomous: autonomous,
            force: force,
            spoken: spoken,
            messages: [.init(
                id: clientMessageId,
                role: "user",
                parts: [.init(type: "text", text: text)]
            )]
        )
        return try JSONEncoder().encode(body)
    }

    func sendMessage(
        conversationId: String,
        text: String,
        clientOperationId: String = UUID().uuidString.lowercased(),
        autonomous: Bool,
        force: Bool = false,
        spoken: Bool = false,
        encodedRequestBody: Data? = nil,
        onDelta: @escaping @Sendable (String) async -> Void,
        onCue: @escaping @Sendable (MessagePart) async -> Void
    ) async throws -> SendReceipt {
        let url = configuration.baseURL.appending(path: "api/mobile/v1/chat")
        var request = makeRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let encodedRequestBody {
            request.httpBody = encodedRequestBody
        } else {
            request.httpBody = try encodeChatRequest(
                conversationId: conversationId,
                text: text,
                clientOperationId: clientOperationId,
                autonomous: autonomous,
                force: force,
                spoken: spoken,
                clientMessageId: UUID().uuidString
            )
        }

        let (bytes, response) = try await stream(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        // Error bodies are small JSON with owner-facing copy; drain them so the
        // banner shows the server's own words rather than a stock status string.
        if !(200..<300).contains(http.statusCode) {
            var errorData = Data()
            for try await byte in bytes { errorData.append(byte) }
            if http.statusCode == 409,
               let cancellation = try? JSONDecoder().decode(ChatTurnCancellationEnvelope.self, from: errorData),
               cancellation.outcome == "cancelled_before_admission",
               cancellation.code == "chat_turn_cancelled_before_admission",
               cancellation.conversationId == conversationId,
               cancellation.clientOperationId == clientOperationId,
               cancellation.taskId == nil,
               cancellation.effectStatus == "not_started" {
                throw APIError.chatTurnCancelledBeforeAdmission(
                    conversationId: conversationId, clientOperationId: clientOperationId
                )
            }
            try await validate(http, data: errorData)
        }
        try await validate(http, data: nil)
        let taskId = http.value(forHTTPHeaderField: "x-async-task")
        let cursor = http.value(forHTTPHeaderField: "x-message-cursor")
        let responseConversation = http.value(forHTTPHeaderField: "x-conversation-id") ?? conversationId

        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let data = payload.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else { continue }
            if type == "text-delta", taskId == nil, let delta = object["delta"] as? String {
                await onDelta(delta)
            } else if type.hasPrefix("data-") {
                let value = object["data"].map(JSONValue.init(any:)) ?? .null
                await onCue(.init(type: type, data: value))
            }
        }
        return .init(taskId: taskId, cursor: cursor, conversationId: responseConversation)
    }


    func cancelChatOperation(conversationId: String, clientOperationId: String) async throws -> ChatOperationCancellationReceipt {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/chat/cancel"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(ChatOperationCancellationRequest(
            conversationId: conversationId, clientOperationId: clientOperationId
        ))
        let (data, response) = try await load(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard let receipt = try? JSONDecoder().decode(ChatOperationCancellationReceipt.self, from: data),
              receipt.conversationId == conversationId,
              receipt.clientOperationId == clientOperationId else {
            // Any unrecognized status/body, including a lost or malformed 503,
            // leaves the operation outcome unknown at the caller.
            if http.statusCode == 503 { throw APIError.invalidResponse }
            try await validate(http, data: data)
            throw APIError.invalidResponse
        }
        let isUnknown = receipt.outcome == .unknown
        guard (isUnknown && http.statusCode == 503 && !receipt.ok && receipt.taskId == nil && receipt.effectStatus == "unknown")
                || (!isUnknown && (200..<300).contains(http.statusCode) && receipt.ok) else {
            throw APIError.invalidResponse
        }
        if receipt.outcome == .cancelledBeforeAdmission {
            guard receipt.taskId == nil, receipt.transitioned != nil,
                  receipt.effectStatus == "not_started" else { throw APIError.invalidResponse }
        } else if !isUnknown {
            guard let taskId = receipt.taskId, UUID(uuidString: taskId) != nil,
                  receipt.effectStatus == "unknown" else { throw APIError.invalidResponse }
            switch receipt.outcome {
            case .cancelled:
                guard receipt.taskStatus == "cancelled", receipt.transitioned == true else {
                    throw APIError.invalidResponse
                }
            case .alreadyCancelled:
                guard receipt.taskStatus == "cancelled", receipt.transitioned == false else {
                    throw APIError.invalidResponse
                }
            case .alreadyTerminal:
                guard (receipt.taskStatus == "done" || receipt.taskStatus == "failed"),
                      receipt.transitioned == false else {
                    throw APIError.invalidResponse
                }
            case .cancelledBeforeAdmission, .unknown:
                throw APIError.invalidResponse
            }
        }
        return receipt
    }

    func acknowledgeMessageDelivery(conversationId: String, messageId: String) async throws {
        guard let clientID else { throw APIError.invalidResponse }
        var request = makeRequest(
            url: configuration.baseURL.appending(
                path: "api/mobile/v1/chats/\(conversationId)/messages/\(messageId)"
            )
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            MessageDeliveryAcknowledgement(action: "delivered", clientId: clientID)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await perform(makeRequest(url: configuration.baseURL.appending(path: path)), as: T.self)
    }

    private func postWorkspaceAction(path: String, action: String) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await perform(request, as: OkPayload.self)
    }

    private func postCollectionAction(path: String, action: String) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await perform(request, as: OkPayload.self)
    }

    private func setEnabled(path: String, enabled: Bool) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["enabled": enabled])
        _ = try await perform(request, as: OkPayload.self)
    }

    private func approvalAction(id: String, body: ApprovalActionBody) async throws -> ApprovalResult {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/approvals/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request, as: ApprovalResult.self)
    }

    /// One retry, for reads only.
    ///
    /// A connection pooled across a suspension is routinely dead on the other
    /// end, and the first request after foregrounding is the one that finds
    /// out — by stalling for the full inactivity timeout. Resetting the pool is
    /// what makes the second attempt worth making: without it the retry is
    /// handed the same dead socket and fails the same way.
    ///
    /// Reads only, because a write may well have reached the server before the
    /// answer went missing. Replaying `sendMessage` or an approval decision
    /// could double it, and a duplicated turn is worse than a visible failure.
    private func load(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError where Self.isRetryable(error) && Self.isRead(request) {
            // Only the shared pool can have gone stale behind our back; an
            // injected session belongs to whoever injected it.
            if sessionOverride == nil { Transport.shared.reset() }
            do {
                return try await session.data(for: request)
            } catch let retried as URLError {
                throw APIError.transport(retried)
            }
        } catch let error as URLError {
            throw APIError.transport(error)
        }
    }

    /// The streaming counterpart to `load`. Never retried, for the same reason.
    private func stream(_ request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do {
            return try await session.bytes(for: request)
        } catch let error as URLError {
            throw APIError.transport(error)
        }
    }

    /// Failures a fresh connection plausibly fixes. A rejected certificate or
    /// an unsupported URL is not one of them: those fail again, identically.
    private static func isRetryable(_ error: URLError) -> Bool {
        switch error.code {
        case .timedOut, .networkConnectionLost, .cannotConnectToHost, .dnsLookupFailed:
            true
        default:
            false
        }
    }

    private static func isRead(_ request: URLRequest) -> Bool {
        (request.httpMethod ?? "GET").uppercased() == "GET"
    }

    private func makeRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("1", forHTTPHeaderField: "x-assistant-card-schema")
        if nativeCardFormsEnabled {
            request.setValue("card-form-v1", forHTTPHeaderField: "x-assistant-card-forms")
        }
        if !configuration.token.isEmpty {
            request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "authorization")
        }
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await load(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        try await validate(http, data: data)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decodeFailure(error, as: type)
        }
    }

    private func validate(_ response: HTTPURLResponse, data: Data?) async throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if response.statusCode == 401 { throw APIError.unauthorized }
        let message: String
        if let data,
           let body = try? JSONDecoder().decode(ErrorBody.self, from: data) {
            message = body.error
        } else {
            message = HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
        }
        throw APIError.server(status: response.statusCode, message: message)
    }
}

private struct ErrorBody: Decodable { let error: String }
private struct ChatTurnCancellationEnvelope: Decodable {
    let outcome: String?
    let code: String?
    let conversationId: String?
    let clientOperationId: String?
    let taskId: String?
    let effectStatus: String?
}
private struct ChatOperationCancellationRequest: Encodable {
    let conversationId: String
    let clientOperationId: String
}

private struct OkPayload: Decodable { let ok: Bool }
private struct KnowledgeConnectionSavedPayload: Decodable {
    let memoryId: String
    let relationId: String
}
private struct EmptyPayload: Decodable {}

private struct ProviderActionBody: Encodable {
    let action: String
    var model: String?
    var label: String?
    var promptCostPerMTok: String?
    var completionCostPerMTok: String?
    var thinking: Bool?
}

private struct ActivityActionBody: Encodable {
    let action: String
    let budgetUsdLimit: Double?
}

private struct GoalActionBody: Encodable {
    let action: String
    let status: String?
    let enabled: Bool?
}

private struct ChatActionBody: Encodable {
    let action: String
    let modelId: String?
}

private struct ApprovalActionBody: Encodable {
    let action: String
    let payload: JSONValue?
}

private struct ImportActionBody: Encodable {
    let action: String
    let source: String
    let verdict: String?
    let workspacePath: String?
}

/// Matches the server's LocationPingSchema (packages/core/src/memory/location.ts).
struct LocationPingBody: Encodable {
    let lat: Double
    let lng: Double
    let label: String
    let accuracyM: Int?
    let capturedAt: String
    let timeZone: String
    let source: String
    let arrivalOptIn: Bool
}

/// Matches the server's DeviceTokenRegistrationSchema
/// (packages/core/src/push/devices.ts). Development-signed builds mint sandbox
/// tokens; TestFlight/App Store builds mint production ones.
struct DeviceTokenBody: Encodable {
    let token: String
    let platform: String = "ios"
    let environment: String = {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }()
}

struct GoalMutation: Encodable, Sendable {
    let title: String
    let description: String
    let priority: Int
    let targetDate: String?
    let progress: String
    let nextAction: String
    let mirrorToPrimary: Bool
}

struct SkillMutation: Encodable, Sendable {
    let name: String
    let preconditions: String
    let steps: String
    let gotchas: String
}

struct CostLimitsMutation: Encodable, Sendable {
    let taskDefault: String
    let daily: String
    let monthly: String
}

struct AgentSettingsMutation: Encodable, Sendable {
    let timezone: String
    let locale: String
    let signature: String
}

struct MemoryMutation: Encodable, Sendable {
    let content: String
    let domain: String
    let importance: Int
    let pinned: Bool
    let subjectContactId: String
}

struct PersonMutation: Encodable, Sendable {
    let name: String
    let relationship: String
    let aliases: String
}

struct OccasionMutation: Encodable, Sendable {
    let kind: String
    let label: String
    let month: String
    let day: String
    let year: String
    let leadDays: String
    let notes: String
}

private struct PersonMergeBody: Encodable {
    let action: String
    let targetId: String
}

private struct PersonCreateReceipt: Decodable {
    let contactId: String?
}

private struct GoalCreateReceipt: Decodable {
    let conversationId: String
    let taskId: String
    let messageCursor: String
}

struct ChatCreateReceipt: Decodable, Sendable {
    let conversationId: String
}

private struct ChatRequest: Encodable {
    let conversationId: String
    let clientOperationId: String
    let clientId: String?
    let autonomous: Bool
    /// "Run it for real" on an off-course reply: route straight to the
    /// executor without arming the autonomy grant.
    let force: Bool
    /// This turn will be heard rather than read. The server answers it in a
    /// register that survives being spoken: short, no tables, no Markdown.
    let spoken: Bool
    let messages: [RequestMessage]
}

private struct MessageDeliveryAcknowledgement: Encodable {
    let action: String
    let clientId: String
}

private struct RequestMessage: Encodable {
    let id: String
    let role: String
    let parts: [RequestPart]
}

private struct RequestPart: Encodable {
    let type: String
    let text: String
}

private extension JSONValue {
    init(any value: Any) {
        switch value {
        case let value as String: self = .string(value)
        case let value as Bool: self = .bool(value)
        case let value as NSNumber: self = .number(value.doubleValue)
        case let value as [String: Any]: self = .object(value.mapValues(JSONValue.init(any:)))
        case let value as [Any]: self = .array(value.map(JSONValue.init(any:)))
        default: self = .null
        }
    }
}

struct CardFormHTTPResult: Sendable {
    let admission: CardFormAdmissionResult
    let messageCursor: String?
}

private struct CardFormAdmissionEnvelope: Decodable {
    let ok: Bool?
    let created: Bool?
    let taskId: String?
    let messageId: String?
    let status: String?
    let taskStatus: String?
    let activeTaskId: String?
    let messageCursor: String?
    let queueGeneration: Int?
    let dispatch: String?
    let reason: String?
    let code: String?
    let error: String?
}
