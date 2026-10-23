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

    /// Counts every intercepted request from bootstrap through the scroll run.
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
        XCTAssertFalse(model.isSending, "The fixed-window fixture must not leave a send active")
        XCTAssertFalse(model.hasUnresolvedTurn, "The fixed-window fixture must not leave an unresolved turn")
        window.endEditing(true)
        window.isHidden = true
        window.rootViewController = nil
        session.invalidateAndCancel()
        StubURLProtocol.endTestCase(requestScopeID)
        defaults.removePersistentDomain(forName: defaultsSuite)
        previousKeyWindow?.makeKey()
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

    private enum FixtureError: Error {
        case missingWindowScene
        case bootstrapDidNotConfigureChat
        case chatTranscriptDidNotMount
    }
}
