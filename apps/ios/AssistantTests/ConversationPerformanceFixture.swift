import SwiftUI
import UIKit
import XCTest
import QuartzCore
@testable import Assistant

/// A fully hosted production `ChatView` with deterministic model/network inputs.
/// Every request is intercepted by `StubURLProtocol`; the fixture uses a fake
/// bearer token and never reads the app's saved connection credentials.
@MainActor
final class ConversationPerformanceFixture {
    static let ownerID = "11111111-1111-4111-8111-111111111111"
    static let conversationID = "22222222-2222-4222-8222-222222222222"
    static let baseURL = URL(string: "https://conversation-performance.invalid")!

    let model: AppModel
    let window: UIWindow
    let session: URLSession
    let defaults: UserDefaults
    let defaultsSuite: String
    let requestScopeID: String
    let token = "conversation-performance-fixture-only"
    let scrollView: UIScrollView
    /// Wall time from creating the production host until its transcript is
    /// scrollable, including the bounded run-loop mount wait; excludes bootstrap.
    let hostMountToScrollableSeconds: TimeInterval
    private let previousKeyWindow: UIWindow?

    private var streamOperationID: String?
    private var streamFinalMessage: ChatMessage?
    private var streamExpectedText: String?
    private var streamedText = ""
    private var streamTurnCount = 0
    private var appendedMessageCount = 0
    private var requestHistory: [String: Int] = [:]
    private var didTearDown = false
    private var expectedRequests: Set<String>

    private init(
        model: AppModel,
        window: UIWindow,
        session: URLSession,
        defaults: UserDefaults,
        defaultsSuite: String,
        requestScopeID: String,
        scrollView: UIScrollView,
        hostMountToScrollableSeconds: TimeInterval,
        requestHistory: [String: Int],
        previousKeyWindow: UIWindow?
    ) {
        self.model = model
        self.window = window
        self.session = session
        self.defaults = defaults
        self.defaultsSuite = defaultsSuite
        self.requestScopeID = requestScopeID
        self.scrollView = scrollView
        self.hostMountToScrollableSeconds = hostMountToScrollableSeconds
        self.requestHistory = requestHistory
        self.previousKeyWindow = previousKeyWindow
        self.expectedRequests = Set(Self.messageAcknowledgementPaths(for: model.messages).keys.map { "POST \($0)" })
            .union(["GET /api/mobile/v1/bootstrap", "GET /api/mobile/v1/overview"])
    }

    /// Boots a realistic owner and primary conversation, then mounts the real
    /// ChatView directly so RootView's normal connect-on-launch task is absent.
    static func make(
        messages: [ChatMessage],
        width: CGFloat = 393,
        height: CGFloat = 852
    ) async throws -> ConversationPerformanceFixture {
        let requestScopeID = UUID().uuidString.lowercased()
        let defaultsSuite = "assistant.conversation-performance.\(requestScopeID)"
        guard let defaults = UserDefaults(suiteName: defaultsSuite),
              let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else {
            throw FixtureError.missingWindowScene
        }
        defaults.removePersistentDomain(forName: defaultsSuite)
        // Keep caller-provided ids so the real visible-row delivery path runs;
        // callers should provide stable ids for paired benchmark runs.
        let safeMessages = messages

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Assistant-Test-Case": requestScopeID]
        let session = URLSession(configuration: configuration)
        let client = APIClient(
            configuration: .init(baseURL: baseURL, token: "conversation-performance-fixture-only"),
            session: session,
            clientID: "33333333-3333-4333-8333-333333333333"
        )
        let model = AppModel(
            apiClient: client,
            initialMessages: safeMessages,
            defaults: defaults,
            storeConnectionToken: { _ in },
            enqueueAutomaticSpeech: { _ in },
            scheduleLocalNotification: { _, _, _, _, _, _ in false },
            captureCurrentPlace: { nil }
        )
        model.scenePhaseDidChange(.background)

        StubURLProtocol.beginTestCase(requestScopeID)
        StubURLProtocol.primeBootstrap(
            try bootstrap(messages: safeMessages),
            overview: [.success(status: 200, body: try overview())]
        )
        await model.refreshAll(reportFailure: false)
        guard model.bootstrap?.identity.id == ownerID,
              model.composerDraftScope != nil,
              model.conversationId == conversationID else {
            session.invalidateAndCancel()
            StubURLProtocol.endTestCase(requestScopeID)
            defaults.removePersistentDomain(forName: defaultsSuite)
            throw FixtureError.bootstrapDidNotConfigureChat
        }
        // Visible durable assistant rows are acknowledged after the window is
        // mounted. Give those expected writes valid typed success bodies.
        let initialPaths = Self.messageAcknowledgementPaths(for: model.messages)
        var requestHistory: [String: Int] = [:]
        Self.recordRequests(StubURLProtocol.requests, into: &requestHistory)
        StubURLProtocol.prime([], paths: initialPaths)

        let previousKeyWindow = scene.keyWindow
        let mountStarted = CACurrentMediaTime()
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        window.rootViewController = UIHostingController(rootView:
            ChatView(
                safeAreaTopInset: 62,
                safeAreaBottomInset: 34,
                safeAreaLeadingInset: 0,
                safeAreaTrailingInset: 0
            )
            .environment(model)
            .environment(\.scenePhase, .active)
            .environment(\.colorScheme, .light)
            .environment(\.dynamicTypeSize, .large)
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
        )
        window.makeKeyAndVisible()

        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        var scrollView: UIScrollView?
        while scrollView == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(40))
            window.layoutIfNeeded()
            scrollView = findScrollView(in: window)
        }
        guard let scrollView else {
            window.isHidden = true
            window.rootViewController = nil
            session.invalidateAndCancel()
            StubURLProtocol.endTestCase(requestScopeID)
            defaults.removePersistentDomain(forName: defaultsSuite)
            throw FixtureError.chatTranscriptDidNotMount
        }
        return ConversationPerformanceFixture(
            model: model,
            window: window,
            session: session,
            defaults: defaults,
            defaultsSuite: defaultsSuite,
            requestScopeID: requestScopeID,
            scrollView: scrollView,
            hostMountToScrollableSeconds: CACurrentMediaTime() - mountStarted,
            requestHistory: requestHistory,
            previousKeyWindow: previousKeyWindow
        )
    }

    /// Drive the actual composer binding and UIKit delegate path, one inserted
    /// character at a time. This may show the simulator keyboard as normal.
    func typeInComposer(_ text: String, frameInterval: Duration = .milliseconds(16)) async throws {
        guard let composer = Self.descendants(of: window).compactMap({ $0 as? UITextView }).first,
              composer.becomeFirstResponder() || composer.isFirstResponder,
              composer.selectedTextRange != nil else {
            throw FixtureError.composerDidNotMount
        }
        for character in text {
            guard let range = composer.selectedTextRange else { throw FixtureError.composerDidNotMount }
            composer.replace(range, withText: String(character))
            window.layoutIfNeeded()
            try await Task.sleep(for: frameInterval)
        }
    }

    /// Start a real AppModel send. The open SSE fixture stays alive so the
    /// caller can advance chunks deterministically, then finish into one poll.
    func beginStreamTurn(
        text: String,
        initialChunk: String,
        finalText: String
    ) async throws {
        guard model.composerDraftScope != nil, model.conversationId == Self.conversationID,
              !model.isSending else { throw FixtureError.chatNotReadyForSend }
        streamTurnCount += 1
        let final = ChatMessage(
            id: "performance-final-\(streamTurnCount)",
            role: .assistant,
            parts: [.init(type: "text", text: finalText)]
        )
        streamFinalMessage = final
        streamExpectedText = finalText
        streamedText = initialChunk
        let updates = ChatUpdates(
            taskStatus: nil,
            messages: [final],
            refreshed: [],
            superseded: nil,
            nextCursor: "performance-final",
            hasMore: false,
            activity: []
        )
        let statusBody = try JSONEncoder().encode(updates)
        var paths = Self.messageAcknowledgementPaths(for: model.messages + [final])
        paths["/api/mobile/v1/chat"] = [.stream(body: Self.sseDelta(initialChunk))]
        paths["/api/mobile/v1/chat/status"] = [.success(status: 200, body: statusBody)]
        // A completed turn refreshes both projections before clearing its
        // ordinary-turn state. Keep that normal work successful and measured.
        paths["/api/mobile/v1/overview"] = [.success(status: 200, body: try Self.overview())]
        paths["/api/mobile/v1/workspace"] = [.success(status: 200, body: try Self.workspace())]
        paths["/api/mobile/v1/chat/cancel"] = [
            .operationCancellation(status: 200, outcome: "cancelled_before_admission"),
        ]
        prime(paths: paths)
        model.send(text)

        try await waitUntil {
            guard let request = StubURLProtocol.requests.first(where: {
                $0.0 == "POST" && $0.1.path == "/api/mobile/v1/chat"
            }),
            let body = try? JSONSerialization.jsonObject(with: request.3) as? [String: Any],
            let operationID = body["clientOperationId"] as? String else { return false }
            self.streamOperationID = operationID
            return StubURLProtocol.isStreamReady(
                operationId: operationID,
                authorization: "Bearer \(self.token)"
            ) && self.model.messages.last?.text == initialChunk
        }
    }

    func appendStreamChunk(_ text: String) async throws {
        guard let streamOperationID else { throw FixtureError.streamNotStarted }
        streamedText += text
        StubURLProtocol.appendStream(
            Self.sseDelta(text),
            operationId: streamOperationID,
            authorization: "Bearer \(token)"
        )
        try await waitUntil {
            self.model.messages.last?.text == self.streamedText
        }
    }

    /// Ends the event stream and waits for the configured status response to
    /// merge the durable twin and settle `AppModel.isSending`.
    func finishStreamAndPoll(timeout: Duration = .seconds(5)) async throws {
        guard let streamOperationID, let streamFinalMessage,
              let streamExpectedText else { throw FixtureError.streamNotStarted }
        guard streamedText == streamExpectedText else { throw FixtureError.streamContentMismatch }
        StubURLProtocol.appendStream(
            Data("data: [DONE]\n\n".utf8),
            operationId: streamOperationID,
            authorization: "Bearer \(token)"
        )
        try await waitUntil(timeout: timeout) {
            !self.model.isSending && !self.model.hasUnresolvedTurn
                && self.model.messages.contains(where: { $0.id == streamFinalMessage.id })
        }
        self.streamOperationID = nil
        self.streamFinalMessage = nil
        self.streamExpectedText = nil
        self.streamedText = ""
    }

    /// Append a row through the model's normal conversation-reload path while
    /// the hosted ChatView remains mounted (useful for a mid-scroll append).
    func appendMessage(_ message: ChatMessage) async throws {
        guard !model.isSending, let active = model.activeConversation else {
            throw FixtureError.chatNotReadyForAppend
        }
        appendedMessageCount += 1
        let appended = ChatMessage(
            id: "performance-appended-\(appendedMessageCount)",
            role: message.role,
            parts: message.parts,
            metadata: message.metadata
        )
        let updated = ConversationView(
            conversation: active.conversation,
            agentName: active.agentName,
            agentTimezone: active.agentTimezone,
            messages: model.messages + [appended],
            models: active.models,
            goalTitle: active.goalTitle,
            canArchive: active.canArchive,
            cursor: active.cursor,
            asyncTurn: active.asyncTurn
        )
        var paths = Self.messageAcknowledgementPaths(for: updated.messages)
        paths["/api/mobile/v1/chats/\(active.conversation.id)"] = [
            .success(status: 200, body: try JSONEncoder().encode(updated)),
        ]
        prime(paths: paths)
        guard await model.openConversation(id: active.conversation.id) else {
            throw FixtureError.conversationAppendFailed
        }
    }

    /// The only requests exposed here are those captured by the URLProtocol;
    /// an accidentally un-stubbed route fails closed instead of reaching a host.
    var interceptedRequestPaths: [String] {
        let history = requestHistory.flatMap { key, count -> [String] in
            guard let separator = key.firstIndex(of: " ") else { return [] }
            return Array(repeating: String(key[key.index(after: separator)...]), count: count)
        }
        return history + Self.recordedRequests(from: StubURLProtocol.requests).map(\.path)
    }

    /// Counts every intercepted request across fixture phases. `prime` resets
    /// StubURLProtocol's phase-local recorder; this view retains the full run.
    var requestCountsByMethodAndPath: [String: Int] {
        var counts = requestHistory
        for (key, count) in Self.requestCounts(from: StubURLProtocol.requests) {
            counts[key, default: 0] += count
        }
        return counts
    }

    /// Preserve bounded fixture state beside partial phase measurements even
    /// when XCTest stops before the complete benchmark summary is written.
    var diagnosticState: [String: Any] {
        [
            "messageCount": model.messages.count,
            "isSending": model.isSending,
            "hasUnresolvedTurn": model.hasUnresolvedTurn,
            "modelError": model.errorMessage ?? "",
            "lastMessageText": model.messages.last?.text ?? "",
            "streamOperationObserved": streamOperationID != nil,
            "streamReady": streamOperationID.map {
                StubURLProtocol.isStreamReady(operationId: $0, authorization: "Bearer \(token)")
            } ?? false,
            "requestCountsByMethodAndPath": requestCountsByMethodAndPath,
            "unexpectedRequests": Set(requestCountsByMethodAndPath.keys).subtracting(expectedRequests).sorted(),
        ]
    }

    func assertValidMeasurementBoundary(file: StaticString = #filePath, line: UInt = #line) {
        let unexpected = Set(requestCountsByMethodAndPath.keys).subtracting(expectedRequests)
        XCTAssertTrue(unexpected.isEmpty,
                      "Unexpected benchmark requests: \(unexpected.sorted())", file: file, line: line)
        XCTAssertNil(model.errorMessage, "A fixture error must invalidate the benchmark", file: file, line: line)
    }

    func tearDown() async {
        guard !didTearDown else { return }
        didTearDown = true
        if streamOperationID == nil {
            XCTAssertFalse(model.isSending, "A finished benchmark fixture must have no active send")
            XCTAssertFalse(model.hasUnresolvedTurn, "A finished benchmark fixture must have no unresolved turn")
        }
        if model.isSending || model.hasUnresolvedTurn {
            let operationID = streamOperationID
            model.cancelSend()
            _ = try? await waitUntil(timeout: .seconds(2)) {
                !self.model.isSending && !self.model.hasUnresolvedTurn
            }
            if let operationID {
                StubURLProtocol.cancelStream(
                    operationId: operationID,
                    authorization: "Bearer \(token)"
                )
                _ = try? await waitUntil(timeout: .seconds(1)) {
                    !self.model.isSending && !self.model.hasUnresolvedTurn
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        window.endEditing(true)
        window.isHidden = true
        window.rootViewController = nil
        session.invalidateAndCancel()
        StubURLProtocol.endTestCase(requestScopeID)
        defaults.removePersistentDomain(forName: defaultsSuite)
        previousKeyWindow?.makeKey()
    }

    private func waitUntil(
        timeout: Duration = .seconds(4),
        condition: @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        guard condition() else { throw FixtureError.conditionTimedOut }
    }

    private func prime(paths: [String: [StubURLProtocol.Outcome]]) {
        Self.recordRequests(StubURLProtocol.requests, into: &requestHistory)
        expectedRequests.formUnion(paths.keys.map { path in
            let isWrite = path == "/api/mobile/v1/chat" || path == "/api/mobile/v1/chat/cancel"
                || path.contains("/messages/")
            return "\(isWrite ? "POST" : "GET") \(path)"
        })
        StubURLProtocol.prime([], paths: paths)
    }

    private static func recordedRequests(
        from requests: [(String, URL, [String: String], Data)]
    ) -> [(method: String, path: String)] {
        requests.map { ($0.0, $0.1.path) }
    }

    private static func requestCounts(
        from requests: [(String, URL, [String: String], Data)]
    ) -> [String: Int] {
        requests.reduce(into: [:]) { counts, request in
            counts["\(request.0) \(request.1.path)", default: 0] += 1
        }
    }

    private static func recordRequests(
        _ requests: [(String, URL, [String: String], Data)],
        into history: inout [String: Int]
    ) {
        for (key, count) in requestCounts(from: requests) {
            history[key, default: 0] += count
        }
    }

    private static func bootstrap(messages: [ChatMessage]) throws -> Data {
        let conversation = ConversationView(
            conversation: .init(
                id: conversationID,
                title: "Performance fixture",
                modelOverride: nil,
                archivedAt: nil,
                isPrimary: true
            ),
            agentName: "Fixture Assistant",
            agentTimezone: "UTC",
            messages: messages,
            models: [],
            goalTitle: nil,
            canArchive: false,
            cursor: "performance-start",
            asyncTurn: nil
        )
        let response = BootstrapResponse(
            generatedAt: "2026-10-22T12:00:00Z",
            identity: .init(id: ownerID, name: "Performance Owner", avatarUrl: nil),
            shell: .init(
                dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
                memoryHealth: .init(
                    totalUsable: 0,
                    notYetOrganized: 0,
                    awaitingReview: 0,
                    ownerConfirmed: 0,
                    lastOrganizedAt: nil
                )
            ),
            conversation: conversation
        )
        return try JSONEncoder().encode(response)
    }

    private static func workspace() throws -> Data {
        let data = Data(#"""
        {"generatedAt":"2026-10-22T12:00:00Z","chats":{"current":[],"archived":[]},
        "memory":{"ownerName":"Performance Owner","ownerContactId":"11111111-1111-4111-8111-111111111111","health":{"totalUsable":0,"notYetOrganized":0,"awaitingReview":0,"ownerConfirmed":0},"facts":[],"awaitingReview":[],"peopleCount":0},
        "skills":[],"settings":{"agent":{"name":"Fixture Assistant","timezone":"UTC","locale":"en-US","signature":""},"schedules":[],"reminders":[],"policies":[],"goalAutomationCount":0},
        "costs":{"dailySpentUsd":0,"monthlySpentUsd":0,"heldUsd":0,"parkedTasks":0,"bySource":[],"byModel":[],"held":[],"topTasks":[],"recent":[]},"anomalies":[],"improvements":[]}
        """#.utf8)
        _ = try JSONDecoder().decode(WorkspaceResponse.self, from: data)
        return data
    }

    private static func overview() throws -> Data {
        try JSONEncoder().encode(OverviewResponse(
            generatedAt: "2026-10-22T12:00:00Z",
            activity: ActivityList(items: [], archivedCount: 0),
            goals: GoalsDashboard(items: [], archivedCount: 0),
            approvals: ApprovalInbox(pending: [], resolved: []),
            documents: DocumentsOverview(
                documents: [],
                stats: DocumentStats(total: 0, ready: 0, pending: 0, chunks: 0),
                primaryConversationId: conversationID
            )
        ))
    }

    private static func messageAcknowledgementPaths(for messages: [ChatMessage]) -> [String: [StubURLProtocol.Outcome]] {
        let success = Data("{\"ok\":true}".utf8)
        return Dictionary(messages.lazy.filter { $0.role == .assistant }.map { message in
            ("/api/mobile/v1/chats/\(conversationID)/messages/\(message.id)",
             Array(repeating: StubURLProtocol.Outcome.success(status: 200, body: success), count: 8))
        }, uniquingKeysWith: { first, _ in first })
    }

    private static func sseDelta(_ text: String) -> Data {
        let body = try! JSONSerialization.data(withJSONObject: ["type": "text-delta", "delta": text])
        return Data("data: \(String(decoding: body, as: UTF8.self))\n\n".utf8)
    }

    private static func findScrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView,
           !(scroll is UITextView),
           scroll.bounds.width >= view.bounds.width * 0.7,
           scroll.contentSize.height > scroll.bounds.height {
            return scroll
        }
        for child in view.subviews {
            if let found = findScrollView(in: child) { return found }
        }
        return nil
    }

    private static func descendants(of view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { descendants(of: $0) }
    }

    private enum FixtureError: Error {
        case missingWindowScene
        case bootstrapDidNotConfigureChat
        case chatTranscriptDidNotMount
        case composerDidNotMount
        case chatNotReadyForSend
        case chatNotReadyForAppend
        case streamNotStarted
        case streamContentMismatch
        case conversationAppendFailed
        case conditionTimedOut
    }
}
