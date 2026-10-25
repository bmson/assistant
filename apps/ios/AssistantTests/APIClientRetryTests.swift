import XCTest
import SwiftUI
import Observation
import CoreLocation
import CryptoKit
@testable import Assistant

/// Stands in for the network so a dead pooled connection can be reproduced
/// deterministically. Each queued outcome is consumed by one request, so a test
/// says exactly what the first attempt and the retry each see.
final class StubURLProtocol: URLProtocol {
    enum Outcome {
        case failure(URLError)
        case success(status: Int, body: Data)
        case calendarConfigureAcknowledgement(status: Int, body: Data)
        /// Answers after `delay`, to stand in for a slow endpoint.
        case delayed(after: TimeInterval, status: Int, body: Data)
        case stream(body: Data)
        case taskStream(body: Data, taskId: String)
        case held(status: Int, body: Data)
        case heldCalendarConfigureAcknowledgement(status: Int, body: Data)
        case operationCancellation(status: Int, outcome: String)
        case terminalOperationCancellation(status: Int, outcome: String, taskId: String, taskStatus: String, transitioned: Bool?)
        case delayedOperationCancellation(after: TimeInterval, status: Int, outcome: String)
        case delayedChatCancelledBeforeAdmission(after: TimeInterval)
    }

    private static let lock = NSLock()
    private static var outcomes: [Outcome] = []
    private static var pathOutcomes: [String: [Outcome]] = [:]
    private static var tokenOutcomes: [String: [Outcome]] = [:]
    private static var recordedMethods: [String] = []
    private static var recordedURLs: [URL] = []
    private static var recordedBodies: [Data] = []
    private static var recordedHeaders: [[String: String]] = []
    private static var recordedTimeouts: [TimeInterval] = []
    private static var heldResponses: [String: StubURLProtocol] = [:]
    private static var stoppedPaths: Set<String> = []
    private static var stoppedRequests: Set<String> = []
    private static var stopLoadingObservers: [String: [() -> Void]] = [:]
    private static var completedPaths: Set<String> = []
    private static weak var activeStream: StubURLProtocol?
    private static var streamsByOperation: [String: StubURLProtocol] = [:]
    private static var streamsByIdentity: [String: StubURLProtocol] = [:]
    private static var readyStreamIdentities: Set<String> = []
    private static var activeTestCaseID: String?

    static func beginTestCase(_ id: String) {
        lock.withLock {
            activeTestCaseID = id
            outcomes = []
            pathOutcomes = [:]
            tokenOutcomes = [:]
            recordedMethods = []
            recordedURLs = []
            recordedBodies = []
            recordedHeaders = []
            recordedTimeouts = []
            heldResponses = [:]
            stoppedPaths = []
            stoppedRequests = []
            stopLoadingObservers = [:]
            completedPaths = []
            activeStream = nil
            streamsByOperation = [:]
            streamsByIdentity = [:]
            readyStreamIdentities = []
        }
    }

    static func endTestCase(_ id: String) {
        lock.withLock {
            if activeTestCaseID == id { activeTestCaseID = nil }
        }
    }

    private static func testCaseID(in headers: [String: String]) -> String? {
        headers.first(where: { $0.key.caseInsensitiveCompare("x-assistant-test-case") == .orderedSame })?.value
    }

    private static func isActiveTestCase(_ id: String?) -> Bool {
        guard let id else { return false }
        return lock.withLock { activeTestCaseID == id }
    }

    static func prime(_ queued: [Outcome], paths: [String: [Outcome]] = [:], tokens: [String: [Outcome]] = [:]) {
        lock.withLock {
            outcomes = queued
            pathOutcomes = paths
            tokenOutcomes = tokens
            recordedMethods = []
            recordedURLs = []
            recordedBodies = []
            recordedHeaders = []
            recordedTimeouts = []
            heldResponses = [:]
            stoppedPaths = []
            stoppedRequests = []
            stopLoadingObservers = [:]
            completedPaths = []
            activeStream = nil
            streamsByOperation = [:]
            streamsByIdentity = [:]
            readyStreamIdentities = []
        }
    }

    /// Parallel startup reads must not consume each other's response bodies.
    static func primeBootstrap(_ body: Data, overview: [Outcome] = [.success(status: 401, body: Data())],
                               queued: [Outcome] = []) {
        prime(queued, paths: [
            "/api/mobile/v1/bootstrap": [.success(status: 200, body: body)],
            "/api/mobile/v1/overview": overview,
        ])
    }

    /// One entry per attempt that reached the network — the assertion that
    /// distinguishes "retried once" from "never retried" and from "retried".
    static var attempts: [String] {
        lock.withLock { recordedMethods }
    }

    static var urls: [URL] { lock.withLock { recordedURLs } }

    /// What each attempt sent. URLSession hands a protocol its body as a
    /// stream rather than as `httpBody`, so it is drained here once.
    static var bodies: [Data] { lock.withLock { recordedBodies } }
    static var headers: [[String: String]] { lock.withLock { recordedHeaders } }
    static var timeouts: [TimeInterval] { lock.withLock { recordedTimeouts } }
    static var completedResponsePaths: Set<String> { lock.withLock { completedPaths } }
    static func isHoldingResponse(path: String) -> Bool { lock.withLock { heldResponses[path] != nil } }
    static func observeStopLoading(path: String, testCaseID: String, onStop: @escaping () -> Void) {
        let key = stopLoadingKey(path: path, testCaseID: testCaseID)
        let alreadyStopped = lock.withLock {
            if stoppedPaths.contains(key) { return true }
            stopLoadingObservers[key, default: []].append(onStop)
            return false
        }
        if alreadyStopped { onStop() }
    }

    private static func stopLoadingKey(path: String, testCaseID: String) -> String {
        "\(testCaseID)\u{0}\(path)"
    }

    static func hasStoppedRequest(method: String, url: URL, testCaseID: String) -> Bool {
        lock.withLock { stoppedRequests.contains("\(testCaseID)\u{0}\(method)\u{0}\(url.absoluteString)") }
    }

    static func releaseHeldResponse(path: String) {
        let protocolInstance = lock.withLock { heldResponses.removeValue(forKey: path) }
        protocolInstance?.releaseHeldResponse()
    }
    static var requests: [(String, URL, [String: String], Data)] {
        lock.withLock {
            (0..<recordedMethods.count).compactMap { index in
                guard index < recordedURLs.count, index < recordedHeaders.count, index < recordedBodies.count else { return nil }
                return (recordedMethods[index], recordedURLs[index], recordedHeaders[index], recordedBodies[index])
            }
        }
    }

    static func appendStream(_ body: Data, operationId: String? = nil, authorization: String? = nil) {
        let stream = lock.withLock {
            if let operationId, let authorization {
                return streamsByIdentity[streamIdentityKey(operationId: operationId, authorization: authorization)]
            }
            return operationId.flatMap { streamsByOperation[$0] } ?? activeStream
        }
        guard let stream,
              isActiveTestCase(testCaseID(in: stream.request.allHTTPHeaderFields ?? [:])) else { return }
        stream.client?.urlProtocol(stream, didLoad: body)
    }

    static func isStreamReady(operationId: String, authorization: String) -> Bool {
        let key = streamIdentityKey(operationId: operationId, authorization: authorization)
        return lock.withLock { readyStreamIdentities.contains(key) }
    }

    static func cancelStream(operationId: String, authorization: String) {
        let key = streamIdentityKey(operationId: operationId, authorization: authorization)
        let stream = lock.withLock { streamsByIdentity[key] }
        guard let stream else { return }
        stream.client?.urlProtocol(stream, didFailWithError: URLError(.cancelled))
    }

    private static func streamIdentityKey(operationId: String, authorization: String) -> String {
        "\(authorization)\u{0}\(operationId)"
    }

    private static func rememberStream(_ stream: StubURLProtocol, requestBody: Data,
                                       headers: [String: String]) -> (identityKey: String?, accepted: Bool) {
        let object = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any]
        let operationId = object?["clientOperationId"] as? String
        let authorization = headers.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value ?? ""
        let identityKey = operationId.map { streamIdentityKey(operationId: $0, authorization: authorization) }
        let accepted = lock.withLock {
            guard let requestCaseID = testCaseID(in: headers), requestCaseID == activeTestCaseID else {
                return false
            }
            activeStream = stream
            if let operationId { streamsByOperation[operationId] = stream }
            if let identityKey { streamsByIdentity[identityKey] = stream }
            return true
        }
        return (identityKey, accepted)
    }

    private static func markStreamReady(identityKey: String?, headers: [String: String]) {
        guard let identityKey else { return }
        lock.withLock {
            guard let requestCaseID = testCaseID(in: headers), requestCaseID == activeTestCaseID else { return }
            readyStreamIdentities.insert(identityKey)
        }
    }

    private static func next(for method: String, url: URL?, body: Data, headers: [String: String], timeout: TimeInterval) -> Outcome {
        lock.withLock {
            guard let requestCaseID = testCaseID(in: headers), requestCaseID == activeTestCaseID else {
                return .failure(URLError(.cancelled))
            }
            recordedMethods.append(method)
            if let url { recordedURLs.append(url) }
            recordedBodies.append(body)
            recordedHeaders.append(headers)
            recordedTimeouts.append(timeout)
            if let authorization = headers.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value,
               var queued = tokenOutcomes[authorization], !queued.isEmpty {
                let result = queued.removeFirst()
                tokenOutcomes[authorization] = queued
                return result
            }
            if let path = url?.path, var queued = pathOutcomes[path], !queued.isEmpty {
                let result = queued.removeFirst()
                pathOutcomes[path] = queued
                return result
            }
            return outcomes.isEmpty ? .success(status: 200, body: Data()) : outcomes.removeFirst()
        }
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private let stopped = NSLock()
    private var isStopped = false
    private var heldResponse: (status: Int, body: Data)?
    private var heldResponseCorrelatesMutation = false
    private var calendarConfigureRequestBody = Data()
    override func stopLoading() {
        stopped.withLock { isStopped = true }
        guard let path = request.url?.path,
              let testCaseID = Self.testCaseID(in: request.allHTTPHeaderFields ?? [:]) else { return }
        let key = Self.stopLoadingKey(path: path, testCaseID: testCaseID)
        let observers = Self.lock.withLock { () -> [() -> Void] in
            guard Self.activeTestCaseID == testCaseID else { return [] }
            if let held = Self.heldResponses[path], held === self {
                Self.heldResponses.removeValue(forKey: path)
            }
            Self.stoppedPaths.insert(key)
            if let url = request.url {
                Self.stoppedRequests.insert("\(testCaseID)\u{0}\(request.httpMethod ?? "GET")\u{0}\(url.absoluteString)")
            }
            return Self.stopLoadingObservers.removeValue(forKey: key) ?? []
        }
        observers.forEach { $0() }
    }

    private func releaseHeldResponse() {
        guard let heldResponse else { return }
        self.heldResponse = nil
        let body = heldResponseCorrelatesMutation
            ? calendarConfigureAcknowledgementBody(heldResponse.body, requestBody: calendarConfigureRequestBody, status: heldResponse.status)
            : heldResponse.body
        heldResponseCorrelatesMutation = false
        respond(status: heldResponse.status, body: body)
    }

    private func respond(status: Int, body: Data) {
        guard Self.isActiveTestCase(Self.testCaseID(in: request.allHTTPHeaderFields ?? [:])) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
        if let path = request.url?.path { Self.lock.withLock { Self.completedPaths.insert(path) } }
    }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let requestBody = Self.body(of: request)
        calendarConfigureRequestBody = requestBody
        switch Self.next(
            for: method,
            url: request.url,
            body: requestBody,
            headers: request.allHTTPHeaderFields ?? [:],
            timeout: request.timeoutInterval
        ) {
        case let .held(status, body):
            guard let requestTestCaseID = Self.testCaseID(in: request.allHTTPHeaderFields ?? [:]),
                  Self.isActiveTestCase(requestTestCaseID),
                  let path = request.url?.path else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
                return
            }
            heldResponse = (status, body)
            heldResponseCorrelatesMutation = false
            let key = Self.stopLoadingKey(path: path, testCaseID: requestTestCaseID)
            Self.lock.withLock {
                Self.stoppedPaths.remove(key)
                Self.heldResponses[path] = self
            }
        case let .heldCalendarConfigureAcknowledgement(status, body):
            guard let requestTestCaseID = Self.testCaseID(in: request.allHTTPHeaderFields ?? [:]),
                  Self.isActiveTestCase(requestTestCaseID),
                  let path = request.url?.path else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
                return
            }
            heldResponse = (status, body)
            heldResponseCorrelatesMutation = true
            let key = Self.stopLoadingKey(path: path, testCaseID: requestTestCaseID)
            Self.lock.withLock {
                Self.stoppedPaths.remove(key)
                Self.heldResponses[path] = self
            }
        case let .failure(error):
            client?.urlProtocol(self, didFailWithError: error)
        case let .stream(body):
            guard Self.isActiveTestCase(Self.testCaseID(in: request.allHTTPHeaderFields ?? [:])) else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
                return
            }
            let registration = Self.rememberStream(
                self, requestBody: requestBody, headers: request.allHTTPHeaderFields ?? [:]
            )
            guard registration.accepted else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
                return
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["content-type": "text/event-stream"])!
            guard let client else { return }
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocol(self, didLoad: body)
            Self.markStreamReady(identityKey: registration.identityKey, headers: request.allHTTPHeaderFields ?? [:])
            // Remain open so the test can deliver later tokens while sending.
        case let .taskStream(body, taskId):
            guard Self.isActiveTestCase(Self.testCaseID(in: request.allHTTPHeaderFields ?? [:])) else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
                return
            }
            let registration = Self.rememberStream(
                self, requestBody: requestBody, headers: request.allHTTPHeaderFields ?? [:]
            )
            guard registration.accepted else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
                return
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: [
                    "content-type": "text/event-stream", "x-async-task": taskId,
                ])!
            guard let client else { return }
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocol(self, didLoad: body)
            Self.markStreamReady(identityKey: registration.identityKey, headers: request.allHTTPHeaderFields ?? [:])
        case let .operationCancellation(status, outcome):
            let sent = try? JSONSerialization.jsonObject(with: requestBody) as? [String: String]
            var body: [String: Any] = [
                "ok": status < 300,
                "outcome": outcome,
                "conversationId": sent?["conversationId"] ?? "",
                "clientOperationId": sent?["clientOperationId"] ?? "",
                "taskId": NSNull(),
            ]
            body["effectStatus"] = outcome == "cancelled_before_admission" ? "not_started" : "unknown"
            if outcome == "cancelled_before_admission" { body["transitioned"] = true }
            body["code"] = outcome == "unknown" ? "cancellation_unconfirmed" : nil
            do {
                respond(status: status, body: try JSONSerialization.data(withJSONObject: body))
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        case let .terminalOperationCancellation(status, outcome, taskId, taskStatus, transitioned):
            let sent = try? JSONSerialization.jsonObject(with: requestBody) as? [String: String]
            var body: [String: Any] = [
                "ok": status < 300,
                "outcome": outcome,
                "conversationId": sent?["conversationId"] ?? "",
                "clientOperationId": sent?["clientOperationId"] ?? "",
                "taskId": taskId,
                "taskStatus": taskStatus,
                "effectStatus": "unknown",
            ]
            if let transitioned { body["transitioned"] = transitioned }
            do {
                respond(status: status, body: try JSONSerialization.data(withJSONObject: body))
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        case let .delayedOperationCancellation(after, status, outcome):
            let sent = try? JSONSerialization.jsonObject(with: requestBody) as? [String: String]
            var body: [String: Any] = [
                "ok": status < 300,
                "outcome": outcome,
                "conversationId": sent?["conversationId"] ?? "",
                "clientOperationId": sent?["clientOperationId"] ?? "",
                "taskId": NSNull(),
            ]
            body["effectStatus"] = outcome == "cancelled_before_admission" ? "not_started" : "unknown"
            if outcome == "cancelled_before_admission" { body["transitioned"] = true }
            body["code"] = outcome == "unknown" ? "cancellation_unconfirmed" : nil
            let data = try! JSONSerialization.data(withJSONObject: body)
            DispatchQueue.global().asyncAfter(deadline: .now() + after) { [self] in
                guard !stopped.withLock({ isStopped }) else { return }
                respond(status: status, body: data)
            }
        case let .delayedChatCancelledBeforeAdmission(after):
            let sent = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any]
            let body = [
                "outcome": "cancelled_before_admission",
                "code": "chat_turn_cancelled_before_admission",
                "conversationId": sent?["conversationId"] as? String ?? "",
                "clientOperationId": sent?["clientOperationId"] as? String ?? "",
                "taskId": NSNull(),
                "effectStatus": "not_started",
            ] as [String: Any]
            let data = try! JSONSerialization.data(withJSONObject: body)
            DispatchQueue.global().asyncAfter(deadline: .now() + after) { [self] in
                guard !stopped.withLock({ isStopped }) else { return }
                respond(status: 409, body: data)
            }
        case let .success(status, body):
            respond(status: status, body: body)
        case let .calendarConfigureAcknowledgement(status, body):
            respond(status: status, body: calendarConfigureAcknowledgementBody(body, requestBody: requestBody, status: status))
        case let .delayed(delay, status, body):
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
                guard !stopped.withLock({ isStopped }) else { return }
                respond(status: status, body: body)
            }
        }
    }

    /// This opt-in fixture emulates the server echoing a configure mutation ID.
    /// Ordinary responses remain byte-for-byte unchanged so malformed and
    /// mismatched acknowledgements stay testable.
    private func calendarConfigureAcknowledgementBody(_ body: Data, requestBody: Data, status: Int) -> Data {
        guard request.httpMethod == "POST", request.url?.path == "/api/mobile/v1/calendars",
              status < 300,
              let requestObject = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any],
              let mutationId = requestObject["mutationId"] as? String,
              let responseObject = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              responseObject["ok"] as? Bool == true,
              var state = responseObject["state"] as? [String: Any],
              state["mutationId"] == nil || state["mutationId"] is NSNull else { return body }
        state["mutationId"] = mutationId
        var correlated = responseObject
        correlated["state"] = state
        return (try? JSONSerialization.data(withJSONObject: correlated)) ?? body
    }
}

/// Task creation is synchronous; session invalidation follows the final task
/// delegate callback. Neither observation depends on URLProtocol queue timing.
private final class DeadlineSessionObserver: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var createdRequests: [URLRequest] = []
    private var finished = false
    var requests: [URLRequest] { lock.withLock { createdRequests } }
    var invalidated: Bool { lock.withLock { finished } }

    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        guard let request = task.originalRequest else { return }
        lock.withLock { createdRequests.append(request) }
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        lock.withLock { finished = true }
    }
}

@MainActor
private final class LocalNotificationRecorder {
    struct Entry {
        let title: String
        let body: String
        let route: AssistantRoute?
        let approvalId: String?
        let agentID: String?
        let conversationID: String?
    }

    private(set) var entries: [Entry] = []

    func schedule(
        title: String,
        body: String,
        route: AssistantRoute?,
        approvalId: String?,
        agentID: String?,
        conversationID: String?
    ) async -> Bool {
        entries.append(.init(
            title: title,
            body: body,
            route: route,
            approvalId: approvalId,
            agentID: agentID,
            conversationID: conversationID
        ))
        return true
    }
}

/// Immediate, per-model surface recorder. These calls never reach ActivityKit
/// or the system badge; their trace does not attribute an earlier OS stall.
@MainActor
private final class RecordingAppSystemSurfaces: AppSystemSurfaces {
    private let id = UUID().uuidString
    private(set) var operations: [String] = []

    private func record(_ operation: String) {
        operations.append(operation)
        print("Notification fixture surfaces [\(id)]: \(operation); cancelled=\(Task.isCancelled)")
    }

    func ensure(agentName: String, thought: AssistantThought, detail: String, pendingCount: Int) async {
        record("ensure(\(pendingCount))")
    }

    func start(agentName: String, thought: AssistantThought, detail: String, pendingCount: Int) async {
        record("start(\(pendingCount))")
    }

    func update(thought: AssistantThought, detail: String, pendingCount: Int) async {
        record("update(\(pendingCount))")
    }

    func needsAttention(agentName: String, detail: String, pendingCount: Int) async {
        record("needsAttention(\(pendingCount))")
    }

    func finish(thought: AssistantThought, detail: String, succeeded: Bool) async {
        record("finish(\(succeeded))")
    }

    func dismiss() async { record("dismiss") }
    func updateBadge(_ count: Int) async { record("updateBadge(\(count))") }
}

final class APIClientRetryTests: XCTestCase {
    private let sessionLock = NSLock()
    private var testSessions: [URLSession] = []
    private var testCaseID = ""

    @MainActor
    private final class SecurityReviewTransportStub: SecurityReviewTransport {
        var listCalls = 0
        var decisionCalls = 0
        var listHandler: @MainActor () async throws -> [SecurityReviewItem] = { [] }
        var decisionHandler: @MainActor (SecurityReviewItem, SecurityReviewDisposition) async -> SecurityReviewDecisionResult = { _, _ in .saved }

        func list() async throws -> [SecurityReviewItem] {
            listCalls += 1
            return try await listHandler()
        }

        func decide(_ item: SecurityReviewItem, as disposition: SecurityReviewDisposition) async -> SecurityReviewDecisionResult {
            decisionCalls += 1
            return await decisionHandler(item, disposition)
        }
    }

    override func setUp() {
        super.setUp()
        testCaseID = UUID().uuidString
        StubURLProtocol.beginTestCase(testCaseID)
    }

    override func tearDown() {
        StubURLProtocol.endTestCase(testCaseID)
        let sessions = sessionLock.withLock { () -> [URLSession] in
            defer { testSessions = [] }
            return testSessions
        }
        // Keep sessions valid: models can retain clients after a test method
        // returns. Cancel current tasks; case scoping prevents late requests from
        // touching the next test's recorder or consuming its outcomes.
        for session in sessions {
            session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
        }
        super.tearDown()
    }

    func testOwnerReplyDeliveryUsesTheSameStableClientIdentityAsTheChatRequest() async throws {
        let clientID = "33333333-3333-4333-8333-333333333333"
        StubURLProtocol.prime([
            .taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: "task-1"),
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
        ])
        let client = makeClient(clientID: clientID)
        _ = try await client.sendMessage(
            conversationId: "11111111-1111-4111-8111-111111111111",
            text: "Hello",
            clientOperationId: "22222222-2222-4222-8222-222222222222",
            autonomous: false,
            onDelta: { _ in },
            onCue: { _ in }
        )
        try await client.acknowledgeMessageDelivery(
            conversationId: "11111111-1111-4111-8111-111111111111",
            messageId: "44444444-4444-4444-8444-444444444444"
        )

        XCTAssertEqual(StubURLProtocol.urls.map(\.path), [
            "/api/mobile/v1/chat",
            "/api/mobile/v1/chats/11111111-1111-4111-8111-111111111111/messages/44444444-4444-4444-8444-444444444444",
        ])
        let chatBody = try XCTUnwrap(StubURLProtocol.bodies.first)
        let chat = try XCTUnwrap(JSONSerialization.jsonObject(with: chatBody) as? [String: Any])
        XCTAssertEqual(chat["clientId"] as? String, clientID)
        let deliveryBody = try XCTUnwrap(StubURLProtocol.bodies.last)
        let delivery = try XCTUnwrap(JSONSerialization.jsonObject(with: deliveryBody) as? [String: String])
        XCTAssertEqual(delivery, ["action": "delivered", "clientId": clientID])
    }

    func testSecurityReviewListUsesOneBoundedAuthenticatedAttempt() async throws {
        let body = Data(#"{"items":[{"incidentId":"a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1","revision":3,"confidence":"high","disposition":"unreviewed","category":"new_device","importance":7,"subject":"New sign-in","fromName":"Provider","observedAt":"2026-10-11T18:00:00Z","materialChangeReason":"A new device was reported.","evidence":{"eventType":"login","evidenceQuote":"A sign-in needs review."}}]}"#.utf8)
        StubURLProtocol.prime([.success(status: 200, body: body)])

        let items = try await makeClient().securityReviews()

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.revision, 3)
        XCTAssertEqual(items.first?.readableCategory, "New Device")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        let url = try XCTUnwrap(StubURLProtocol.urls.first)
        XCTAssertEqual(url.path, "/api/mobile/v1/security-reviews")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "limit", value: "50")])
        XCTAssertEqual(StubURLProtocol.timeouts, [12])
        XCTAssertEqual(
            StubURLProtocol.headers.first?.first { $0.key.caseInsensitiveCompare("authorization") == .orderedSame }?.value,
            "Bearer t"
        )
    }

    func testSecurityReviewListDoesNotRetryTransportFailure() async {
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .success(status: 200, body: Data(#"{"items":[]}"#.utf8)),
        ])

        do {
            _ = try await makeClient().securityReviews()
            XCTFail("A single failed review read must be reported rather than retried.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
            XCTAssertEqual(StubURLProtocol.timeouts, [12])
        }
    }

    func testSecurityReviewRequestsEnforceAbsoluteDeadlineAndCancelHeldTransport() async throws {
        let (client, session) = makeClient(requestScopeID: testCaseID, securityReviewDeadline: 0.2)
        let getPath = "/api/mobile/v1/security-reviews"
        StubURLProtocol.prime([.held(status: 200, body: Data(#"{"items":[]}"#.utf8))])
        let getStopped = expectation(description: "Deadline cancels the held GET transport")
        StubURLProtocol.observeStopLoading(path: getPath, testCaseID: testCaseID) {
            getStopped.fulfill()
        }

        do {
            _ = try await client.securityReviews()
            XCTFail("A held response must not exceed the absolute deadline.")
        } catch let APIError.transport(error) {
            XCTAssertEqual(error.code, .timedOut)
        } catch {
            XCTFail("Expected a deadline transport error, got \(error).")
        }

        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        XCTAssertEqual(StubURLProtocol.timeouts, [12])
        await fulfillment(of: [getStopped], timeout: 2)
        XCTAssertFalse(StubURLProtocol.isHoldingResponse(path: getPath))
        let getDrained = await cancelAndDrain(session)
        XCTAssertTrue(getDrained)

        let (postClient, postSession) = makeClient(requestScopeID: testCaseID, securityReviewDeadline: 0.2)
        let postPath = "/api/mobile/v1/security-reviews/a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1"
        StubURLProtocol.prime([.held(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let postStopped = expectation(description: "Deadline cancels the held POST transport")
        StubURLProtocol.observeStopLoading(path: postPath, testCaseID: testCaseID) {
            postStopped.fulfill()
        }
        let outcome = await postClient.decideSecurityReview(
            incidentId: "a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1",
            expectedRevision: 5,
            disposition: .dismissed
        )
        XCTAssertEqual(outcome, .uncertain)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.timeouts, [12])
        await fulfillment(of: [postStopped], timeout: 2)
        XCTAssertFalse(StubURLProtocol.isHoldingResponse(path: postPath))
        let postDrained = await cancelAndDrain(postSession)
        XCTAssertTrue(postDrained)
    }

    func testSecurityReviewParentCancellationCancelsHeldTransport() async throws {
        let (client, session) = makeClient(requestScopeID: testCaseID, securityReviewDeadline: 12)
        let path = "/api/mobile/v1/security-reviews"
        StubURLProtocol.prime([.held(status: 200, body: Data(#"{"items":[]}"#.utf8))])
        let transportStopped = expectation(description: "Parent cancellation stops the held transport")
        StubURLProtocol.observeStopLoading(path: path, testCaseID: testCaseID) {
            transportStopped.fulfill()
        }
        let request = Task { try await client.securityReviews() }

        let deadline = ContinuousClock.now + .seconds(2)
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path), "The request should reach its held response before cancellation.")
        request.cancel()

        do {
            _ = try await request.value
            XCTFail("Cancelling the parent operation must cancel its held network request.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }
        await fulfillment(of: [transportStopped], timeout: 2)
        XCTAssertFalse(StubURLProtocol.isHoldingResponse(path: path))
        XCTAssertEqual(StubURLProtocol.timeouts, [12])
        let drained = await cancelAndDrain(session)
        XCTAssertTrue(drained)
    }

    func testSecurityReviewListRejectsDuplicateAndMalformedRows() async throws {
        let duplicate = #"{"items":[{"incidentId":"a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1","revision":3,"confidence":"high","disposition":"unreviewed","category":"login","importance":7,"subject":"One","observedAt":"2026-10-11T18:00:00Z"},{"incidentId":"a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1","revision":4,"confidence":"high","disposition":"unreviewed","category":"login","importance":7,"subject":"Two","observedAt":"2026-10-11T18:00:00Z"}]}"#
        StubURLProtocol.prime([.success(status: 200, body: Data(duplicate.utf8))])
        do {
            _ = try await makeClient().securityReviews()
            XCTFail("Duplicate incident identities must fail closed.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }

        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"items":[{"incidentId":"not-an-id","revision":0,"confidence":"","disposition":"unreviewed","category":"login","importance":99,"subject":" ","observedAt":"invalid"}]}"#.utf8))])
        do {
            _ = try await makeClient().securityReviews()
            XCTFail("Malformed review fields must fail closed.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }

        let supplementaryCharactersOverUtf16Bound = String(repeating: "😀", count: 41)
        let oversizedUtf16 = try JSONSerialization.data(withJSONObject: ["items": [[
            "incidentId": "a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1",
            "revision": 3,
            "confidence": supplementaryCharactersOverUtf16Bound,
            "disposition": "unreviewed",
            "category": "login",
            "importance": 7,
            "subject": "A bounded UTF-16 value",
            "observedAt": "2026-10-11T18:00:00Z",
        ]]])
        StubURLProtocol.prime([.success(status: 200, body: oversizedUtf16)])
        do {
            _ = try await makeClient().securityReviews()
            XCTFail("A supplementary character counts as two UTF-16 code units for server parity.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }

        let tooMany = (0..<51).map { index in
            [
                "incidentId": String(format: "a2f7d86c-29ce-5c48-9d57-%012x", index),
                "revision": index + 1,
                "confidence": "high",
                "disposition": "unreviewed",
                "category": "login",
                "importance": 5,
                "subject": "Review \(index)",
                "observedAt": "2026-10-11T18:00:00Z",
            ] as [String: Any]
        }
        let oversizedBody = try JSONSerialization.data(withJSONObject: ["items": tooMany])
        StubURLProtocol.prime([.success(status: 200, body: oversizedBody)])
        do {
            _ = try await makeClient().securityReviews()
            XCTFail("The native client must preserve the server's 50-item bound.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
            XCTAssertEqual(StubURLProtocol.timeouts, [12])
        }
    }

    func testSecurityReviewDecisionUsesFixedReasonAndDoesNotRetry() async throws {
        let incidentID = "a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1"
        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":true}"#.utf8))])

        let result = await makeClient().decideSecurityReview(incidentId: incidentID, expectedRevision: 5, disposition: .expected)

        XCTAssertEqual(result, .saved)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.timeouts, [12])
        let url = try XCTUnwrap(StubURLProtocol.urls.first)
        XCTAssertEqual(url.path, "/api/mobile/v1/security-reviews/\(incidentID)")
        let bodyData = try XCTUnwrap(StubURLProtocol.bodies.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        XCTAssertEqual(body["expectedRevision"] as? Int, 5)
        XCTAssertEqual(body["disposition"] as? String, "expected")
        XCTAssertEqual(body["reason"] as? String, "Owner marked this activity as expected.")

        StubURLProtocol.prime([.success(status: 409, body: Data(#"{"error":"stale"}"#.utf8))])
        let stale = await makeClient().decideSecurityReview(incidentId: incidentID, expectedRevision: 5, disposition: .dismissed)
        XCTAssertEqual(stale, .stale)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])

        StubURLProtocol.prime([.failure(URLError(.timedOut)), .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let uncertain = await makeClient().decideSecurityReview(incidentId: incidentID, expectedRevision: 5, disposition: .expected)
        XCTAssertEqual(uncertain, .uncertain)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])

        StubURLProtocol.prime([])
        let invalid = await makeClient().decideSecurityReview(incidentId: incidentID, expectedRevision: 5, disposition: .unreviewed)
        XCTAssertEqual(invalid, .uncertain)
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty)
    }

    @MainActor
    func testSecurityReviewStaleDecisionReconcilesOnceWithoutOptimisticRemoval() async throws {
        let item = try securityReviewItem()
        let transport = SecurityReviewTransportStub()
        transport.listHandler = { [item] }
        transport.decisionHandler = { _, _ in .stale }
        let client = makeClient()
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 1, client: client),
            connectionIsCurrent: { true },
            transport: transport
        )
        await controller.refresh()

        await controller.decide(item, as: .dismissed)

        XCTAssertEqual(transport.decisionCalls, 1)
        XCTAssertEqual(transport.listCalls, 2)
        XCTAssertEqual(controller.items, [item])
        XCTAssertEqual(controller.message, "This review changed. The latest version is loaded.")
        XCTAssertNil(controller.pendingIncidentID)
    }

    @MainActor
    func testSecurityReviewUncertainDecisionReconcilesOnceAndNeverRetriesPost() async throws {
        let item = try securityReviewItem()
        let transport = SecurityReviewTransportStub()
        transport.listHandler = { [item] }
        transport.decisionHandler = { _, _ in .uncertain }
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            connectionIsCurrent: { true },
            transport: transport
        )
        await controller.refresh()

        await controller.decide(item, as: .expected)

        XCTAssertEqual(transport.decisionCalls, 1)
        XCTAssertEqual(transport.listCalls, 2)
        XCTAssertEqual(controller.items, [item])
        XCTAssertTrue(controller.message.contains("decision response was unclear"))
    }

    @MainActor
    func testSecurityReviewKeepsPriorRowsWhenPostDecisionRefreshFails() async throws {
        let item = try securityReviewItem()
        let transport = SecurityReviewTransportStub()
        var listCalls = 0
        transport.listHandler = {
            listCalls += 1
            if listCalls == 1 { return [item] }
            throw APIError.invalidResponse
        }
        transport.decisionHandler = { _, _ in .saved }
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            connectionIsCurrent: { true },
            transport: transport
        )
        await controller.refresh()

        await controller.decide(item, as: .expected)

        XCTAssertEqual(transport.decisionCalls, 1)
        XCTAssertEqual(transport.listCalls, 2)
        XCTAssertEqual(controller.items, [item])
        XCTAssertTrue(controller.staleList)
        XCTAssertTrue(controller.message.contains("Decision saved."))
        XCTAssertNil(controller.pendingIncidentID)
    }

    @MainActor
    func testSecurityReviewDoesNotShowEmptyAfterInitialEmptyRefreshFails() async throws {
        let transport = SecurityReviewTransportStub()
        var listCalls = 0
        transport.listHandler = {
            listCalls += 1
            if listCalls == 1 { return [] }
            throw APIError.invalidResponse
        }
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            connectionIsCurrent: { true },
            transport: transport
        )
        await controller.refresh()
        XCTAssertEqual(controller.loadState, .ready)
        XCTAssertTrue(controller.items.isEmpty)

        await controller.refresh()

        XCTAssertEqual(controller.loadState, .ready)
        XCTAssertTrue(controller.items.isEmpty)
        XCTAssertTrue(controller.staleList)
        XCTAssertTrue(controller.message.contains("could not be refreshed"))
        XCTAssertEqual(transport.listCalls, 2)
    }

    @MainActor
    func testSecurityReviewDecisionIsBlockedDuringRefreshAndForStaleRows() async throws {
        let item = try securityReviewItem()
        let transport = SecurityReviewTransportStub()
        var listCalls = 0
        var releaseList: (@MainActor () -> Void)?
        transport.listHandler = {
            listCalls += 1
            if listCalls == 1 { return [item] }
            return await withCheckedContinuation { continuation in
                releaseList = { continuation.resume(returning: [item]) }
            }
        }
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            connectionIsCurrent: { true },
            transport: transport
        )
        await controller.refresh()
        await controller.decide(item, as: .unreviewed)
        XCTAssertEqual(transport.decisionCalls, 0)
        let refreshing = Task { await controller.refresh() }
        for _ in 0..<50 {
            if releaseList != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard let finishRefresh = releaseList else {
            controller.dispose()
            XCTFail("The held refresh did not start.")
            return
        }

        await controller.decide(item, as: .dismissed)

        XCTAssertEqual(transport.decisionCalls, 0)
        finishRefresh()
        await refreshing.value
        XCTAssertFalse(controller.isRefreshing)
        controller.dispose()

        let staleTransport = SecurityReviewTransportStub()
        var staleListCalls = 0
        staleTransport.listHandler = {
            staleListCalls += 1
            if staleListCalls == 1 { return [item] }
            throw APIError.invalidResponse
        }
        staleTransport.decisionHandler = { _, _ in .stale }
        let staleController = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 2, client: makeClient()),
            connectionIsCurrent: { true },
            transport: staleTransport
        )
        await staleController.refresh()
        await staleController.decide(item, as: .dismissed)
        XCTAssertTrue(staleController.staleList)
        await staleController.decide(item, as: .dismissed)
        XCTAssertEqual(staleTransport.decisionCalls, 1)
        staleController.dispose()
    }

    @MainActor
    func testSecurityReviewLateDecisionAfterDisposeCannotReconcileOrPublish() async throws {
        let item = try securityReviewItem()
        let transport = SecurityReviewTransportStub()
        transport.listHandler = { [item] }
        var connectionCurrent = true
        var resumeDecision: (@MainActor () -> Void)?
        transport.decisionHandler = { _, _ in
            await withCheckedContinuation { continuation in
                resumeDecision = { continuation.resume(returning: .saved) }
            }
        }
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 7, client: makeClient()),
            connectionIsCurrent: { connectionCurrent },
            transport: transport
        )
        await controller.refresh()
        let mutation = Task { await controller.decide(item, as: .dismissed) }
        for _ in 0..<50 {
            if resumeDecision != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard let finishDecision = resumeDecision else {
            controller.dispose()
            XCTFail("The held decision did not start.")
            return
        }
        XCTAssertEqual(controller.pendingIncidentID, item.incidentId)
        await controller.refresh()
        XCTAssertEqual(transport.listCalls, 1)
        connectionCurrent = false
        controller.dispose()
        finishDecision()
        await mutation.value

        XCTAssertEqual(transport.decisionCalls, 1)
        XCTAssertEqual(transport.listCalls, 1)
        XCTAssertTrue(controller.items.isEmpty)
        XCTAssertNil(controller.pendingIncidentID)
        XCTAssertEqual(controller.loadState, .loading)
        XCTAssertTrue(controller.message.isEmpty)
    }

    @MainActor
    func testSecurityReviewLateListAfterConnectionReplacementCannotPublish() async throws {
        let item = try securityReviewItem()
        let transport = SecurityReviewTransportStub()
        var connectionCurrent = true
        var releaseList: (@MainActor () -> Void)?
        transport.listHandler = {
            await withCheckedContinuation { continuation in
                releaseList = { continuation.resume(returning: [item]) }
            }
        }
        let controller = SecurityReviewController(
            context: SecurityReviewRequestContext(ownerID: "owner-a", connectionVersion: 11, client: makeClient()),
            connectionIsCurrent: { connectionCurrent },
            transport: transport
        )
        let refresh = Task { await controller.refresh() }
        for _ in 0..<50 {
            if releaseList != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard let finishList = releaseList else {
            controller.dispose()
            XCTFail("The held list read did not start.")
            return
        }

        connectionCurrent = false
        controller.dispose()
        finishList()
        await refresh.value

        XCTAssertTrue(controller.items.isEmpty)
        XCTAssertEqual(controller.loadState, .loading)
        XCTAssertFalse(controller.isRefreshing)
    }

    @MainActor
    private func securityReviewItem() throws -> SecurityReviewItem {
        try JSONDecoder().decode(SecurityReviewItem.self, from: Data(#"{"incidentId":"a2f7d86c-29ce-5c48-9d57-7fd5b2fd4ba1","revision":3,"confidence":"high","disposition":"unreviewed","category":"new_device","importance":7,"subject":"New sign-in","fromName":"Provider","observedAt":"2026-10-11T18:00:00Z","materialChangeReason":"A new device was reported.","evidence":{"eventType":"login","evidenceQuote":"A sign-in needs review."}}"#.utf8))
    }

    func testCallCheckinAnswerForwardsServerIssuedRevision() async throws {
        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        try await makeClient().answerCallCheckin(
            callId: "call-1",
            checkinId: "checkin-1",
            revision: 7,
            answer: "Yes, that works"
        )

        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/calls/call-1")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(object, [
            "action": "answer",
            "checkinId": "checkin-1",
            "revision": "7",
            "answer": "Yes, that works",
        ])
    }

    func testActivityDiscoveryEncodesQueryAndCursorAndAcceptsLegacyResponse() async throws {
        let testToken = "activity-query-test"
        StubURLProtocol.prime([], tokens: [
            "Bearer \(testToken)": [.success(status: 200, body: Data(#"{"items":[],"archivedCount":0}"#.utf8))],
        ])
        let cursor = "opaque+/=& cursor"
        let result = try await makeClient(token: testToken).activity(archived: true, query: "owner & older?", filter: "completed", cursor: cursor)
        let activityRequests = StubURLProtocol.requests.filter {
            $0.1.path == "/api/mobile/v1/activity"
                && $0.2.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value == "Bearer \(testToken)"
        }
        XCTAssertEqual(activityRequests.count, 1, "This isolated client must issue one activity request")
        let url = try XCTUnwrap(activityRequests.first?.1)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "cursor" })?.value, cursor)
        XCTAssertEqual(query.first(where: { $0.name == "q" })?.value, "owner & older?")
        XCTAssertEqual(query.first(where: { $0.name == "archived" })?.value, "true")
        XCTAssertEqual(query.first(where: { $0.name == "filter" })?.value, "completed")
        XCTAssertNil(result.nextCursor)
        XCTAssertNil(result.searchIncomplete)
        XCTAssertTrue(result.items.isEmpty)
    }

    func testActivityDiscoveryRetainsIdentityAndCoverage() async throws {
        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"items":[],"archivedCount":2,"nextCursor":"older","searchIncomplete":true,"scanned":500,"captureStatus":"Unknown legacy evidence"}"#.utf8))])
        let result = try await makeClient().activity(archived: false)
        XCTAssertEqual(result.nextCursor, "older")
        XCTAssertEqual(result.searchIncomplete, true)
        XCTAssertEqual(result.scanned, 500)
        XCTAssertEqual(result.captureStatus, "Unknown legacy evidence")
    }

    func testActivityStatusReadsCompactLiveProjectionByTaskID() async throws {
        let id = "11000000-0000-0000-0000-000000000001"
        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"id":"11000000-0000-0000-0000-000000000001","status":"running","progress":"Checking sources","spentUsd":"0.01","budgetUsdLimit":"0.50","updatedAt":"2026-10-11T12:00:00.000Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":false,"stuckWaiting":false}"#.utf8))])
        let result = try await makeClient().activityStatus(id: id)
        XCTAssertEqual(result.id, id)
        XCTAssertEqual(result.status, "running")
        XCTAssertNil(result.archivedAt)
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/activity/\(id)")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    @MainActor
    func testActivityStatusFollowsPendingRunningDoneWithoutReplacingLoadedTitle() async throws {
        let id = "11000000-0000-0000-0000-000000000002"
        func body(_ status: String, _ progress: String) -> Data {
            Data(#"{"id":"\#(id)","status":"\#(status)","progress":"\#(progress)","spentUsd":"0.01","budgetUsdLimit":"0.50","updatedAt":"2026-10-11T12:00:00.000Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":false,"stuckWaiting":false}"#.utf8)
        }
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/activity/\(id)": [
                .success(status: 200, body: body("pending", "Waiting to start")),
                .success(status: 200, body: body("running", "Working")),
                .success(status: 200, body: body("done", "Finished")),
            ],
        ])
        let model = AppModel(apiClient: makeClient())
        var loaded = ActivityItem(
            id: id, type: "chat_turn", status: "pending", title: "Compare options",
            progress: "Queued", trust: "owner", spentUsd: "0", budgetUsdLimit: "0.50",
            updatedAt: "2026-10-11T11:00:00Z", archivedAt: nil, hasPendingApproval: false,
            hasActiveAutonomy: false, stuckWaiting: false
        )
        for expected in ["pending", "running", "done"] {
            let response = await model.fetchActivityStatus(id: id)
            let status = try XCTUnwrap(response)
            loaded = loaded.applying(status)
            XCTAssertEqual(loaded.status, expected)
            XCTAssertEqual(loaded.title, "Compare options")
        }
        XCTAssertEqual(loaded.progress, "Finished")
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/activity/\(id)" }.count, 3)
    }

    @MainActor
    func testActivityStatusDiscardsResponseAfterOwnerReplacement() async throws {
        let model = try await notificationModel()
        let id = "11000000-0000-0000-0000-000000000003"
        let path = "/api/mobile/v1/activity/\(id)"
        let oldStatus = Data(#"{"id":"11000000-0000-0000-0000-000000000003","status":"running","progress":"Old owner","spentUsd":"0","budgetUsdLimit":"0.50","updatedAt":"2026-10-11T12:00:00.000Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":false,"stuckWaiting":false}"#.utf8)
        let prior = try JSONDecoder().decode(BootstrapResponse.self, from: notificationBootstrap())
        let replacement = BootstrapResponse(
            generatedAt: "2026-10-03T00:00:01Z",
            identity: .init(id: "replacement-owner", name: "Robin", avatarUrl: nil),
            shell: prior.shell,
            conversation: prior.conversation
        )
        StubURLProtocol.prime([], paths: [
            path: [.held(status: 200, body: oldStatus)],
            "/api/mobile/v1/bootstrap": [.success(status: 200, body: try JSONEncoder().encode(replacement))],
            "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
        ])
        let oldRequest = Task { await model.fetchActivityStatusOutcome(id: id) }
        while !StubURLProtocol.isHoldingResponse(path: path) { await Task.yield() }
        await model.refreshAll(reportFailure: false)
        XCTAssertEqual(model.bootstrap?.identity.id, "replacement-owner")
        StubURLProtocol.releaseHeldResponse(path: path)
        let result = await oldRequest.value
        guard case .discarded = result else {
            return XCTFail("A response from a replaced owner must be discarded, not shown as unavailable")
        }
    }

    @MainActor
    func testCancelledActivityStatusRequestReturnsNoProjection() async throws {
        let id = "11000000-0000-0000-0000-000000000004"
        let path = "/api/mobile/v1/activity/\(id)"
        let body = Data(#"{"id":"11000000-0000-0000-0000-000000000004","status":"done","progress":"Finished","spentUsd":"0.01","budgetUsdLimit":"0.50","updatedAt":"2026-10-11T12:00:00.000Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":false,"stuckWaiting":false}"#.utf8)
        StubURLProtocol.prime([.held(status: 200, body: body)])
        let model = AppModel(apiClient: makeClient())
        let request = Task { await model.fetchActivityStatusOutcome(id: id) }
        while !StubURLProtocol.isHoldingResponse(path: path) { await Task.yield() }
        request.cancel()
        StubURLProtocol.releaseHeldResponse(path: path)
        let result = await request.value
        guard case .discarded = result else {
            return XCTFail("A canceled status request must not create an availability warning")
        }
    }

    @MainActor
    func testURLSessionCancellationDoesNotMarkActivityStatusUnavailable() async throws {
        let id = "11000000-0000-0000-0000-000000000007"
        let path = "/api/mobile/v1/activity/\(id)"
        StubURLProtocol.prime([], paths: [path: [.failure(URLError(.cancelled))]])
        let model = AppModel(apiClient: makeClient())
        let result = await model.fetchActivityStatusOutcome(id: id)
        guard case .discarded = result else {
            return XCTFail("URLSession cancellation is not a failed status refresh")
        }

        var availability = ActivityStatusAvailability()
        let key = ActivityStatusAvailabilityKey(ownerID: "owner-1", taskID: id)
        availability.record(result, for: key)
        XCTAssertNil(availability.notice(for: key, savedStatus: "running"))
    }

    @MainActor
    func testMissingActivityStatusDoesNotCloseLoadedTask() async throws {
        let id = "11000000-0000-0000-0000-000000000005"
        StubURLProtocol.prime([.success(status: 404, body: Data(#"{"error":"activity not found"}"#.utf8))])
        let model = AppModel(apiClient: makeClient())
        let response = await model.fetchActivityStatusOutcome(id: id)
        let loaded = ActivityItem(
            id: id, type: "chat_turn", status: "running", title: "Still checking",
            progress: "Looking for sources", trust: "owner", spentUsd: "0", budgetUsdLimit: "0.50",
            updatedAt: "2026-10-11T11:00:00Z", archivedAt: nil, hasPendingApproval: false,
            hasActiveAutonomy: false, stuckWaiting: false
        )
        guard case .unavailable = response else { return XCTFail("A current 404 should be reported as an unavailable refresh") }
        XCTAssertEqual(loaded.status, "running")
    }

    @MainActor
    func testActivityStatusUnavailableNoticeClearsAfterSuccessfulRefresh() async throws {
        let id = "11000000-0000-0000-0000-000000000006"
        let path = "/api/mobile/v1/activity/\(id)"
        let body = Data(#"{"id":"11000000-0000-0000-0000-000000000006","status":"running","progress":"Still checking","spentUsd":"0.01","budgetUsdLimit":"0.50","updatedAt":"2026-10-11T12:00:00.000Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":false,"stuckWaiting":false}"#.utf8)
        StubURLProtocol.prime([], paths: [path: [
            .success(status: 503, body: Data(#"{"error":"temporarily unavailable"}"#.utf8)),
            .success(status: 200, body: body),
        ]])
        let model = AppModel(apiClient: makeClient())
        let key = ActivityStatusAvailabilityKey(ownerID: "owner-1", taskID: id)
        var availability = ActivityStatusAvailability()
        XCTAssertNil(availability.notice(for: key, savedStatus: "running"), "Unqueried rows stay quiet")

        let first = await model.fetchActivityStatusOutcome(id: id)
        guard case .unavailable = first else { return XCTFail("A current 503 should be reported as unavailable") }
        availability.record(first, for: key)
        XCTAssertEqual(availability.notice(for: key, savedStatus: "running"),
                       "Latest update unavailable. Showing saved status.")

        let second = await model.fetchActivityStatusOutcome(id: id)
        guard case let .updated(status) = second else { return XCTFail("The next successful refresh should restore current status") }
        availability.record(second, for: key)
        XCTAssertEqual(status.status, "running")
        XCTAssertNil(availability.notice(for: key, savedStatus: "running"))
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == path }.count, 2)
    }

    func testWorkspaceAdvertisesTypedSectionAvailability() async {
        StubURLProtocol.prime([.success(status: 200, body: Data("{}".utf8))])
        _ = try? await makeClient().workspace()

        let headers = StubURLProtocol.headers.first ?? [:]
        XCTAssertEqual(
            headers.first(where: { $0.key.caseInsensitiveCompare("x-assistant-workspace-sections") == .orderedSame })?.value,
            "1"
        )
        XCTAssertEqual(
            headers.first(where: { $0.key.caseInsensitiveCompare("x-assistant-billing-amounts") == .orderedSame })?.value,
            "1"
        )
    }

    @MainActor
    func testKnowledgeEditStopsBeforeMergeWhenEarlierMutationIsUnconfirmed() async {
        var calls: [String] = []
        let outcome = await performKnowledgeEditInOrder(
            itemID: "source",
            originalLabel: "Old name",
            originalKind: "person",
            submittedLabel: "New name",
            submittedKind: "organization",
            mergeTargetID: "target",
            update: { _, action, value in
                calls.append("\(action):\(value)")
                return action == "rename"
            },
            merge: { _, _ in
                calls.append("merge")
                return true
            }
        )
        XCTAssertEqual(outcome, .typeNotConfirmed(nameChanged: true))
        XCTAssertEqual(calls, ["rename:New name", "retype:organization"],
            "An unconfirmed retype must prevent the destructive merge")

        calls = []
        let renameFailure = await performKnowledgeEditInOrder(
            itemID: "source",
            originalLabel: "Old name",
            originalKind: "person",
            submittedLabel: "New name",
            submittedKind: "organization",
            mergeTargetID: "target",
            update: { _, action, _ in
                calls.append(action)
                return false
            },
            merge: { _, _ in
                calls.append("merge")
                return true
            }
        )
        XCTAssertEqual(renameFailure, .nameNotConfirmed)
        XCTAssertEqual(calls, ["rename"])
    }

    func testBoundedFileReaderReturnsSmallFileAndRejectsKnownOversize() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("assistant-file-import-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let small = directory.appendingPathComponent("small.txt")
        let contents = Data("bounded sample".utf8)
        try contents.write(to: small)

        let read = try await AssistantBoundedFileReader.read(from: small, maxBytes: 64)
        XCTAssertEqual(read, contents)
        do {
            _ = try await AssistantBoundedFileReader.read(from: small, maxBytes: 4)
            XCTFail("Oversized input must be rejected before upload")
        } catch AssistantFileImportError.tooLarge(let limit) {
            XCTAssertEqual(limit, 4)
        }
    }

    func testImprovementDecisionPreservesAdvisoryAcknowledgment() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"outcome":"acknowledged","enacted":false,"detail":"Reviewed; no live settings changed."}"#.utf8))
        ])
        let result = try await makeClient().updateImprovement(id: "proposal-1", action: "apply")
        XCTAssertEqual(result.outcome, "acknowledged")
        XCTAssertEqual(result.enacted, false)
        XCTAssertEqual(result.receiptTitle, "Marked reviewed")
        XCTAssertEqual(result.receiptDetail, "Reviewed; no live settings changed.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/improvements/proposal-1")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["action": "apply"])
    }

    func testImprovementCodeFixRequestCarriesInvestigationIdentity() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"repairIssueId":"repair-1"}"#.utf8))
        ])
        let result = try await makeClient().updateImprovement(id: "proposal-1", action: "request_fix")
        XCTAssertEqual(result.repairIssueId, "repair-1")
        XCTAssertEqual(result.receiptTitle, "Code-fix report linked", "An older response identifies a report without promising a new coding run")
        XCTAssertNil(result.enacted, "Requesting an investigation is not a settings change")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["action": "request_fix"])
    }

    @MainActor
    func testRejectedImprovementDecisionDoesNotRefreshOrConfirm() async {
        StubURLProtocol.prime([
            .success(status: 409, body: Data(#"{"error":"The requested model is unavailable."}"#.utf8))
        ])
        let model = AppModel(apiClient: makeClient())
        let proposal = WorkspaceImprovement(id: "proposal-1", kind: "model_role", title: "Swap model", rationale: "Evaluate cost", suggestion: "Try another model", evidenceCount: 3, applyable: true, createdAt: "2026-10-03")
        let result = await model.updateImprovement(proposal, action: "apply")
        XCTAssertEqual(result?.ok, false)
        XCTAssertEqual(result?.detail, "The requested model is unavailable.")
        XCTAssertEqual(model.errorMessage, "The requested model is unavailable.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    func testIssueReportSendsDetailsToRepairEndpoint() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"issueId":"repair-1"}"#.utf8))
        ])
        try await makeClient().reportRepair(title: "Calendar event missing", summary: "What happened:\nNo event appeared.\n\nWhat I expected:\nThe saved event should appear.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/repairs")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertNil(payload["sourceTaskId"])
        XCTAssertEqual(payload["title"], "Calendar event missing")
        XCTAssertEqual(payload["summary"], "What happened:\nNo event appeared.\n\nWhat I expected:\nThe saved event should appear.")
    }

    func testIssueReportIncludesExplicitlySelectedTask() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"issueId":"repair-1"}"#.utf8))
        ])
        try await makeClient().reportRepair(title: "Calendar event missing", summary: "The saved event did not appear.", sourceTaskId: "task-1")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(payload["sourceTaskId"], "task-1")
    }

    @MainActor
    func testRejectedIssueReportDoesNotClaimSuccessOrRefresh() async {
        StubURLProtocol.prime([
            .success(status: 409, body: Data(#"{"error":"Could not report issue"}"#.utf8))
        ])
        let model = AppModel(apiClient: makeClient())
        let saved = await model.reportRepair(title: "Calendar event missing", summary: "The saved event did not appear.")
        XCTAssertFalse(saved)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testKnowledgeConnectionSaveAcceptsCommittedIDsAndRefreshesGraph() async throws {
        let graph = RelationshipGraphFixture.snapshot()
        StubURLProtocol.prime([
            .success(status: 201, body: Data(#"{"memoryId":"memory-1","relationId":"relation-1"}"#.utf8)),
            .success(status: 200, body: try JSONEncoder().encode(graph))
        ])
        let model = AppModel(apiClient: makeClient())
        let mutation = KnowledgeConnectionMutation(subjectLabel: "Ada", subjectKind: "person", subjectId: "node-0",
            predicate: "works_at", objectLabel: "Acme", objectKind: "organization", objectId: "node-6", note: "")
        let saved = await model.createKnowledgeConnection(mutation)
        XCTAssertTrue(saved, "The accepted save must reach the form's dismissal and graph refresh callback")
        XCTAssertNil(model.errorMessage)
        let refreshed = saved ? await model.relationshipGraph(entityID: "node-0") : nil
        XCTAssertEqual(refreshed?.edges, graph.edges)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
    }

    @MainActor
    func testKnowledgeConnectionReturnsTheCommittedIDForSuggestionScope() async throws {
        StubURLProtocol.prime([.success(status: 201, body: Data(#"{"memoryId":"family-memory","relationId":"family-relation"}"#.utf8))])
        let model = AppModel(apiClient: makeClient())
        let id = await model.createKnowledgeConnectionID(.init(subjectLabel: "Morgan", subjectKind: "person", subjectId: "mom",
            predicate: "mother_of", objectLabel: "Alex", objectKind: "person", objectId: "me", note: ""))
        XCTAssertEqual(id, "family-relation")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"], "Saving must not silently create inferred connections")
    }

    @MainActor
    func testKnowledgeConnectionCorrectionAcceptsCommittedIDs() async throws {
        StubURLProtocol.prime([
            .success(status: 201, body: Data(#"{"memoryId":"replacement-memory","relationId":"replacement-relation"}"#.utf8))
        ])
        let model = AppModel(apiClient: makeClient())
        let mutation = KnowledgeConnectionMutation(subjectLabel: "Ada", subjectKind: "person", subjectId: "node-0",
            predicate: "works_at", objectLabel: "Acme", objectKind: "organization", objectId: "node-6", note: "")
        let saved = await model.correctKnowledgeRelation(id: "old-relation", mutation: mutation)
        XCTAssertTrue(saved)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testKnowledgeConnectionRejectedSaveRemainsAFailure() async {
        StubURLProtocol.prime([.success(status: 400, body: Data(#"{"error":"Choose a different item."}"#.utf8))])
        let model = AppModel(apiClient: makeClient())
        let mutation = KnowledgeConnectionMutation(subjectLabel: "Ada", subjectKind: "person", subjectId: "node-0",
            predicate: "knows", objectLabel: "Ada", objectKind: "person", objectId: "node-0", note: "")
        let saved = await model.createKnowledgeConnection(mutation)
        XCTAssertFalse(saved)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testSavedCardRefreshPostsSourceRefreshWithoutPretendingContentIsNew() async throws {
        let original = ChatMessage(id: "card-message", role: .assistant, parts: [RichMessageFixture.generated(stale: true)])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/cards/saved-1": [.success(status: 202, body: Data(#"{"ok":true,"taskId":"refresh-2","refreshState":"refreshing"}"#.utf8))],
        ])
        let model = AppModel(apiClient: makeClient(), initialMessages: [original])
        let failure = await model.refreshSavedCard(id: "saved-1")
        XCTAssertNil(failure)
        XCTAssertTrue(try XCTUnwrap(model.messages.first).hasRefreshingCard)
        guard case let .object(data)? = model.messages.first?.parts.first?.data else { return XCTFail("Missing card") }
        XCTAssertEqual(data["updatedAt"], .string("2026-09-19T18:00:00.000Z"))
        XCTAssertEqual(data["stale"], .bool(true))
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/cards/saved-1")
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(StubURLProtocol.bodies.first))
        let request = try XCTUnwrap(body as? [String: String])
        XCTAssertEqual(request["action"], "refresh")
        XCTAssertEqual(request["expectedRevisionId"], "r1")
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(request["operationId"])))
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testFailedCardRefreshRetainsSnapshotAndReturnsInlineError() async {
        let original = ChatMessage(id: "card-message", role: .assistant, parts: [RichMessageFixture.generated(stale: true)])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/cards/saved-1": [.success(status: 503, body: Data(#"{"error":"The source is unavailable."}"#.utf8))],
        ])
        let model = AppModel(apiClient: makeClient(), initialMessages: [original])
        let failure = await model.refreshSavedCard(id: "saved-1")
        XCTAssertEqual(failure, "The source is unavailable.")
        XCTAssertEqual(model.messages, [original])
        XCTAssertNil(model.errorMessage)
    }

    @MainActor
    func testCardRefreshPrioritizesItsRowOverOldDecisionReceipts() async throws {
        let card = ChatMessage(id: "card-message", role: .assistant, parts: [RichMessageFixture.generated(stale: true)])
        let receipts = (0..<12).map { index in
            ChatMessage(id: "receipt-\(index)", role: .assistant, parts: [.init(type: "approval", status: "approved")])
        }
        let conversation = ConversationView(conversation: .init(id: "chat", title: "Cards", modelOverride: nil,
            archivedAt: nil, isPrimary: true), agentName: "Assistant", agentTimezone: "UTC",
            messages: [card] + receipts, models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        let stale = ChatUpdates(taskStatus: nil, messages: [], refreshed: [card], superseded: nil,
            nextCursor: nil, hasMore: false, activity: [])
        StubURLProtocol.prime([
            .success(status: 200, body: try JSONEncoder().encode(conversation)),
            .success(status: 202, body: Data(#"{"ok":true,"taskId":"refresh-2","refreshState":"refreshing"}"#.utf8)),
            .success(status: 200, body: try JSONEncoder().encode(stale))
        ])
        let model = AppModel(apiClient: makeClient())
        _ = await model.openConversation(id: "chat")
        let failure = await model.refreshSavedCard(id: "saved-1")
        XCTAssertNil(failure)
        let reread = try XCTUnwrap(StubURLProtocol.urls.last)
        let refreshedIDs = URLComponents(url: reread, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == "refresh" }?.value?.split(separator: ",")
        XCTAssertEqual(refreshedIDs?.first, "card-message")
        XCTAssertEqual(refreshedIDs?.count, 10)
        XCTAssertEqual(model.messages.filter(\.hasRefreshingCard).map(\.id), ["card-message"])
    }

    @MainActor
    func testCardRefreshCannotBeStartedTwiceWhileSaving() async {
        StubURLProtocol.prime([.stream(body: Data())])
        let model = AppModel(apiClient: makeClient(), initialMessages: [
            ChatMessage(id: "m", role: .assistant, parts: [RichMessageFixture.generated()])
        ])
        let first = Task { await model.refreshSavedCard(id: "saved-1") }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        let duplicate = await model.refreshSavedCard(id: "saved-1")
        XCTAssertEqual(duplicate, "This card is already refreshing.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        first.cancel()
        let failure = await first.value
        XCTAssertNotNil(failure)
        XCTAssertFalse(model.messages[0].hasRefreshingCard)
    }

    func testGraphSearchAsksForNamesOnlyAndReadsEitherServerShape() async throws {
        // The new lean search, and an older server that ignores `mode` and
        // answers with the browse overview — both carry `entities`.
        let lean = #"{"entities":[{"id":"e1","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"}]}"#
        let overview = #"{"totalEntities":1,"entities":[{"id":"e1","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"}],"relations":[]}"#
        for body in [lean, overview] {
            StubURLProtocol.prime([.success(status: 200, body: Data(body.utf8))])
            let found = try await makeClient().searchKnowledge(query: "Bald")
            XCTAssertEqual(found.map(\.id), ["e1"])
            let url = try XCTUnwrap(StubURLProtocol.urls.first)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(items.first { $0.name == "mode" }?.value, "search")
            XCTAssertEqual(items.first { $0.name == "q" }?.value, "Bald")
        }
    }

    func testRelationshipGraphOmitsAbsentQueryIdentifiers() async throws {
        let body = try JSONEncoder().encode(RelationshipGraphSnapshot.empty)
        for (person, entity, expected) in [(nil, nil, Set<String>()), ("person-id", nil, ["person"]), (nil, "entity-id", ["entity"])] as [(String?, String?, Set<String>)] {
            StubURLProtocol.prime([.success(status: 200, body: body)])
            _ = try await makeClient().relationshipGraph(personID: person, entityID: entity)
            let url = try XCTUnwrap(StubURLProtocol.urls.first)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(Set(items.map(\.name)), expected)
            XCTAssertTrue(items.allSatisfy { $0.value?.isEmpty == false })
        }
    }

    func testSpendingBreakdownPreservesEntriesAndSeparatesUnknownFromZero() {
        let breakdown = SpendingBreakdown(rows: [
            ("Small", "1", 1), ("Unknown", nil, 2), ("Largest", "4", 3),
            ("Zero", "0", 4), ("Invalid", "nan", 5), ("Negative", "-2", 6),
            ("Infinite", "inf", 7), ("Tie", "1", 8), ("Tiny", "0.0000001", 9)
        ])
        XCTAssertEqual(breakdown.entries.count, 9)
        XCTAssertEqual(breakdown.entries.map(\.label), ["Largest", "Small", "Tie", "Tiny", "Zero",
            "Unknown", "Invalid", "Negative", "Infinite"])
        XCTAssertEqual(Set(breakdown.entries.map(\.id)).count, 9)
        XCTAssertEqual(breakdown.fraction(for: breakdown.entries[0]), 1)
        XCTAssertEqual(breakdown.fraction(for: breakdown.entries[1]), 0.25)
        XCTAssertEqual(breakdown.entries[3].amountLabel, "< $0.000001")
        XCTAssertNotNil(breakdown.entries[4].amount)
        XCTAssertNil(breakdown.entries[5].amount)
        XCTAssertEqual(breakdown.entries[5].amountLabel, "Unavailable")
        let zeros = SpendingBreakdown(rows: [("Zero", "0", 0)])
        XCTAssertEqual(zeros.fraction(for: zeros.entries[0]), 0)
        let large = SpendingBreakdown(rows: [("Large", String(Double.greatestFiniteMagnitude), 1)])
        XCTAssertEqual(large.fraction(for: large.entries[0]), 1)
    }

    func testOrganizerStatusDoesNotImplyCompletionFromUnknownOrActiveStatus() {
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("done"), "Last run completed")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("running"), "Organizing memory")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("failed"), "Last run failed")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("new_status"), "Organizer update")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel(nil), "Ready to organize")
    }

    @MainActor
    func testMemoryOrganizerAndSpendingVisualStates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let rows: [(String, String?, Int)] = [
            ("Research", "3.6", 22), ("Calendar assistance", "1.2", 14),
            ("Memory organization", "0.034", 9), ("Travel planning", "0.0025", 2),
            ("Documents", "0", 4), ("Other provider", nil, 1), ("Small request", "0.0000001", 1)
        ]
        for (name, scheme, width, size, expanded, status) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, false, "done"),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large, false, "running"),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large, false, "failed"),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3, false, "done"),
            ("expanded", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, true, "done")
        ] {
            for page in ["memory", "costs"] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    ScrollView {
                        if page == "memory" {
                            MemoryOrganizerPanel(pendingCount: 17,
                                latest: WorkspaceMemoryOrganizer(id: "visual", status: status,
                                    progress: "consolidation: 17 memories reviewed in 2 batch(es) across 3 people, 5 duplicates expired, 0 contradictions resolved, 4 facts unified, owner card recompiled",
                                    updatedAt: "2026-09-06T20:00:00Z"), requestInFlight: false, organize: {}, showsDetails: expanded)
                                .padding(16)
                        } else {
                            SpendingBreakdownCard(title: "By source", rows: rows, showingAll: expanded).padding(16)
                        }
                    }
                    .navigationTitle(page == "memory" ? "Memory" : "Costs")
                    .assistantSubmenuChrome()
                }.environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "detail-\(page)-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    func testVisualSummaryKeepsEveryStatusAndRejectsInvalidChartValues() {
        let summary = ActivityVisualSummary(statuses: ["waiting_approval", "waiting_budget", "needs_attention",
            "pending", "running", "sleeping", "waiting_event", "done", "failed", "cancelled", "new_status"])
        XCTAssertEqual(summary.counts, [3, 2, 2, 1, 2, 1])
        XCTAssertEqual(AssistantChartScale.shares([0, -1, .nan, .infinity]), [0, 0, 0, 0])
        XCTAssertEqual(AssistantChartScale.shares([]), [])
        XCTAssertEqual(AssistantChartScale.shares([1, 3]), [0.25, 0.75])
        XCTAssertEqual(AssistantChartScale.shares([.greatestFiniteMagnitude, .greatestFiniteMagnitude]), [0.5, 0.5])
        XCTAssertNil(AssistantMotion.response(reduceMotion: true))
        XCTAssertNotNil(AssistantMotion.response(reduceMotion: false))
        XCTAssertNotEqual(relative("2026-09-06T20:00:00Z"), "2026-09-06T20:00:00Z")
        XCTAssertEqual(relative("Unknown date"), "Unknown date")
    }

    @MainActor
    func testVisualConsistencyActivityGoalsAndEditorSnapshots() async throws {
        let goal = GoalRecord(id: "visual-goal", title: "Plan the weekend", description: "A relaxed family trip.",
            status: "active", priority: 3, progress: "Found **three places** with space for everyone.",
            nextAction: "Compare travel times and cancellation policies before choosing.", targetDate: nil,
            createdAt: "2026-09-06", updatedAt: "2026-09-06", archivedAt: nil,
            mirrorToPrimary: false, autonomy: false, taintedOrigin: false)
        let overview = OverviewResponse(generatedAt: "2026-09-06",
            activity: ActivityList(items: [
                ActivityItem(id: "done", type: "chat_turn", status: "done", title: "Find places for lunch",
                    progress: "Compared **three options** along your route, with opening hours and travel times.",
                    trust: "owner", spentUsd: "0.008", budgetUsdLimit: "0.50", updatedAt: "2026-09-06T20:00:00Z",
                    archivedAt: nil, hasPendingApproval: false),
                ActivityItem(id: "running", type: "scheduled", status: "running", title: "Check the weekend forecast",
                    progress: "Checking the forecast for your destination.", trust: "owner", spentUsd: "0.003",
                    budgetUsdLimit: "0.02", updatedAt: "2026-09-06T20:00:00Z", archivedAt: nil, hasPendingApproval: false)
            ], archivedCount: 0),
            goals: GoalsDashboard(items: [GoalDashboardItem(goal: goal, conversationId: "visual-chat",
                workActive: false, automation: nil, cadenceLabel: "On demand", blockedQuestion: "", stalled: false)], archivedCount: 0),
            approvals: ApprovalInbox(pending: [], resolved: []),
            documents: DocumentsOverview(documents: [], stats: DocumentStats(total: 0, ready: 0, pending: 0, chunks: 0),
                primaryConversationId: "visual-chat"))
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(overview))])
        let model = AppModel(apiClient: makeClient())
        await model.refreshOverview()
        XCTAssertEqual(model.overview?.activity.items.count, 2)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, size) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3)
        ] {
            for page in ["activity", "goals", "editor"] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    if page == "activity" { ActivityView() }
                    else if page == "goals" { GoalsView() }
                    else {
                        AssistantForm {
                            Section("Details") {
                                TextField("Name", text: .constant("Weekend plan"))
                                Toggle("Keep updated", isOn: .constant(true))
                            }
                            Section("Evidence") {
                                DisclosureGroup("Recorded details", isExpanded: .constant(true)) {
                                    Text("Only confirmed information is shown here.")
                                }
                                DisclosureGroup("Source messages") { Text("Source preview") }
                            }
                        }
                        .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
                        .navigationTitle("Edit details")
                    }
                }
                .environment(model).environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "visual-\(page)-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    @MainActor
    func testMemoryHomeSnapshots() async throws {
        func fact(_ id: String, _ content: String, domain: String, confirmed: Bool = true, pinned: Bool = false) -> String {
            #"{"id":"\#(id)","content":"\#(content)","kind":"fact","domain":"\#(domain)","ownerConfirmed":\#(confirmed),"pinned":\#(pinned),"importance":3,"createdAt":"2026-09-20T10:00:00Z"}"#
        }
        let facts = [
            fact("f1", "Prefers window seats on flights longer than two hours.", domain: "preferences", pinned: true),
            fact("f2", "Works at Northstar Studio as a design lead.", domain: "work"),
            fact("f3", "Allergic to shellfish.", domain: "health", confirmed: false),
            fact("f4", "Lives in Oakland with Robin.", domain: "home"),
            fact("f5", "Runs on Tuesday and Thursday mornings.", domain: "preferences"),
            fact("f6", "Speaks Portuguese.", domain: "identity"),
        ].joined(separator: ",")
        let review = fact("r1", "Is planning to move to Lisbon next spring.", domain: "home", confirmed: false)
        let workspace = """
        {"generatedAt":"2026-09-26T10:00:00Z","chats":{"current":[],"archived":[]},
         "memory":{"ownerName":"Alex","ownerContactId":"owner","health":{"totalUsable":42,"notYetOrganized":3,"awaitingReview":1,"ownerConfirmed":17,"lastOrganizedAt":null},
           "facts":[\(facts)],"awaitingReview":[\(review)],"peopleCount":4,"people":[],
           "card":{"content":"Alex is a design lead in Oakland.","compiledAt":"2026-09-25T10:00:00Z"},
           "voiceStats":{"total":12,"auto":9,"uploaded":3},"latestOrganizer":null},
         "skills":[],"capabilities":[],
         "settings":{"agent":{"name":"Assistant","timezone":"UTC","locale":"en-US","signature":""},"schedules":[],"reminders":[],"policies":[],"goalAutomationCount":0},
         "costs":{"dailySpentUsd":0,"monthlySpentUsd":0,"heldUsd":0,"dailyLimitUsd":null,"monthlyLimitUsd":null,"taskDefaultLimit":null,"parkedTasks":0,"bySource":[],"byModel":[],"held":[],"topTasks":[],"recent":[]},
         "anomalies":[],"improvements":[],"imports":null}
        """
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, size) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", ColorScheme.dark, DynamicTypeSize.large),
            ("accessible", ColorScheme.light, DynamicTypeSize.accessibility2),
        ] {
            StubURLProtocol.prime([
                .success(status: 200, body: Data(workspace.utf8)),
                .success(status: 200, body: try JSONEncoder().encode(RelationshipGraphFixture.snapshot())),
            ])
            let model = AppModel(apiClient: makeClient())
            await model.refreshWorkspace()
            XCTAssertEqual(model.workspace?.memory.facts.count, 6)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            window.rootViewController = UIHostingController(rootView:
                NavigationStack { MemoryView() }.environment(model)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size))
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(900))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "memory-home-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
        }
    }

    @MainActor
    func testGraphCanvasAccessibilityUsesFocusedEndpointForEachSupportedRelation() throws {
        func edge(
            id: String, subjectID: String, predicate: String,
            objectID: String, forward: String, inverse: String,
            status: String = "confirmed", evidenceCount: Int = 2
        ) -> RelationshipGraphEdge {
            let subjectView = KnowledgeAssertionEndpointView(
                assertionId: id, semanticRevision: 1, focusEntityId: subjectID,
                relatedEntityId: objectID, direction: "forward", subjectEntityId: subjectID,
                predicate: predicate, objectEntityId: objectID, text: forward,
                accessibilityText: forward, evidenceCount: evidenceCount, reviewStatus: status
            )
            let objectView = KnowledgeAssertionEndpointView(
                assertionId: id, semanticRevision: 1, focusEntityId: objectID,
                relatedEntityId: subjectID, direction: "inverse", subjectEntityId: subjectID,
                predicate: predicate, objectEntityId: objectID, text: inverse,
                accessibilityText: inverse, evidenceCount: evidenceCount, reviewStatus: status
            )
            return RelationshipGraphEdge(
                id: id, subjectId: subjectID, objectId: objectID, predicate: predicate,
                reviewStatus: status, sourceContent: "A synthetic source quotation.",
                presentation: KnowledgePresentation(sentence: forward, label: predicate, accessibleLabel: forward),
                validFrom: nil, validUntil: nil, endpointViews: [subjectView, objectView]
            )
        }

        func values(for edge: RelationshipGraphEdge, focus: String) throws -> [String: String] {
            let snapshot = RelationshipGraphSnapshot(
                nodes: [
                    RelationshipGraphNode(id: edge.subjectId, label: edge.subjectId, kind: "person"),
                    RelationshipGraphNode(id: edge.objectId, label: edge.objectId, kind: "person"),
                ],
                edges: [edge], totalEdges: 1, truncated: false, focusId: focus
            )
            let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
            view.configure(snapshot: snapshot, selectedID: focus, dark: false, reduceMotion: true)
            let elements = try XCTUnwrap(view.accessibilityElements as? [UIAccessibilityElement])
            return Dictionary(uniqueKeysWithValues: elements.compactMap { element in
                guard let label = element.accessibilityLabel else { return nil }
                return (label, element.accessibilityValue ?? "")
            })
        }

        let cases: [(RelationshipGraphEdge, String, String)] = [
            (edge(id: "parent", subjectID: "parent", predicate: "parent_of",
                  objectID: "child", forward: "Parent is the parent of Child",
                  inverse: "Child is the child of Parent"), "Parent is the parent of Child", "Child is the child of Parent"),
            (edge(id: "child", subjectID: "child", predicate: "child_of",
                  objectID: "parent", forward: "Child is the child of Parent",
                  inverse: "Parent is the parent of Child"), "Child is the child of Parent", "Parent is the parent of Child"),
            (edge(id: "work", subjectID: "worker", predicate: "works_at",
                  objectID: "company", forward: "Alex works at Acme",
                  inverse: "Alex works at Acme"), "Alex works at Acme", "Alex works at Acme"),
            (edge(id: "sibling", subjectID: "alex", predicate: "sibling_of",
                  objectID: "robin", forward: "Alex is a sibling of Robin",
                  inverse: "Robin is a sibling of Alex"), "Alex is a sibling of Robin", "Robin is a sibling of Alex"),
            (edge(id: "spouse", subjectID: "alex", predicate: "spouse_of",
                  objectID: "robin", forward: "Alex is the spouse of Robin",
                  inverse: "Robin is the spouse of Alex"), "Alex is the spouse of Robin", "Robin is the spouse of Alex"),
        ]

        for (edge, forward, inverse) in cases {
            let byNode = try values(for: edge, focus: edge.objectId)
            XCTAssertTrue(byNode[edge.subjectId]?.contains(forward) == true, "Subject value for \(edge.predicate)")
            XCTAssertTrue(byNode[edge.objectId]?.contains(inverse) == true, "Object value for \(edge.predicate)")
            XCTAssertTrue(byNode[edge.subjectId]?.contains("2 evidence items") == true)
            XCTAssertTrue(byNode[edge.objectId]?.contains("2 evidence items") == true)
            XCTAssertTrue(byNode[edge.subjectId]?.contains("confirmed") == true)
            XCTAssertTrue(byNode[edge.objectId]?.contains("confirmed") == true)
        }
    }

    @MainActor
    func testGraphCanvasAccessibilityKeepsPerAssertionStateAndHonestLegacyProvenanceBounded() throws {
        func makeEdge(_ id: String, _ subjectID: String, _ objectID: String,
                      _ predicate: String, _ status: String,
                      _ sentence: String, endpointViews: [KnowledgeAssertionEndpointView]? = nil) -> RelationshipGraphEdge {
            RelationshipGraphEdge(
                id: id, subjectId: subjectID, objectId: objectID, predicate: predicate,
                reviewStatus: status, sourceContent: "A synthetic source quotation.",
                presentation: KnowledgePresentation(sentence: sentence, label: predicate, accessibleLabel: sentence),
                validFrom: nil, validUntil: nil, endpointViews: endpointViews
            )
        }
        func viewValues(for edges: [RelationshipGraphEdge]) throws -> [String: String] {
            let ids = Set(edges.flatMap { [$0.subjectId, $0.objectId] }).sorted()
            let nodes = ids.map { id in
                RelationshipGraphNode(id: id, label: id == "alex" ? "Alex" : id == "robin" ? "Robin" : id, kind: "person")
            }
            let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
            view.configure(snapshot: RelationshipGraphSnapshot(
                nodes: nodes, edges: edges, totalEdges: edges.count, truncated: false, focusId: "robin"
            ), selectedID: "robin", dark: false, reduceMotion: true)
            let elements = try XCTUnwrap(view.accessibilityElements as? [UIAccessibilityElement])
            return Dictionary(uniqueKeysWithValues: elements.compactMap { element in
                guard let label = element.accessibilityLabel else { return nil }
                return (label, element.accessibilityValue ?? "")
            })
        }

        func endpoint(_ id: String, _ focus: String, _ related: String, _ predicate: String,
                      _ count: Int, _ status: String, _ text: String) -> KnowledgeAssertionEndpointView {
            KnowledgeAssertionEndpointView(
                assertionId: id, semanticRevision: 1, focusEntityId: focus, relatedEntityId: related,
                direction: focus == "alex" ? "forward" : "inverse", subjectEntityId: "alex",
                predicate: predicate, objectEntityId: "robin", text: text, accessibilityText: text,
                evidenceCount: count, reviewStatus: status
            )
        }

        let spouse = makeEdge("active-spouse", "alex", "robin", "spouse_of", "confirmed",
            "Alex is the spouse of Robin",
            endpointViews: [endpoint("active-spouse", "alex", "robin", "spouse_of", 3, "confirmed", "Alex is the spouse of Robin"),
                           endpoint("active-spouse", "robin", "alex", "spouse_of", 3, "confirmed", "Robin is the spouse of Alex")])
        let former = makeEdge("former-spouse", "alex", "robin", "former_spouse_of", "unreviewed",
            "Alex was formerly married to Robin",
            endpointViews: [endpoint("former-spouse", "alex", "robin", "former_spouse_of", 1, "unreviewed", "Alex was formerly married to Robin"),
                           endpoint("former-spouse", "robin", "alex", "former_spouse_of", 1, "unreviewed", "Robin was formerly married to Alex")])
        let mixed = try viewValues(for: [spouse, former])
        XCTAssertTrue(mixed["Alex"]?.contains("Alex is the spouse of Robin, 3 evidence items, confirmed") == true)
        XCTAssertTrue(mixed["Alex"]?.contains("Alex was formerly married to Robin, 1 evidence item, needs review") == true)
        XCTAssertTrue(mixed["Robin"]?.contains("Robin is the spouse of Alex, 3 evidence items, confirmed") == true)
        XCTAssertTrue(mixed["Robin"]?.contains("Robin was formerly married to Alex, 1 evidence item, needs review") == true)

        let legacy = makeEdge("legacy-parent", "alex", "robin", "parent_of", "unreviewed",
            "Alex is the parent of Robin")
        let legacyValues = try viewValues(for: [legacy])
        for node in ["Alex", "Robin"] {
            let value = try XCTUnwrap(legacyValues[node])
            XCTAssertTrue(value.contains("Alex is the parent of Robin"))
            XCTAssertTrue(value.contains("source detail available"))
            XCTAssertTrue(value.contains("needs review"))
            XCTAssertFalse(value.contains("Robin is the child of Alex"), "Do not infer a legacy inverse")
            XCTAssertFalse(value.contains("evidence item"), "Do not infer a legacy evidence count")
        }

        let sameNeighbor = (0..<10).map { index in
            makeEdge("claim-\(index)", "alex", "robin", "spouse_of", "confirmed", "Recorded claim \(index)")
        }
        let sameNeighborValue = try XCTUnwrap(viewValues(for: sameNeighbor)["Alex"])
        XCTAssertTrue(sameNeighborValue.contains("Recorded claim 5"))
        XCTAssertTrue(sameNeighborValue.contains("4 more relationship facts"))
        XCTAssertFalse(sameNeighborValue.contains("Recorded claim 9"))

        let multipleNeighbors = (0..<7).map { index in
            makeEdge("neighbor-\(index)", "alex", "person-\(index)", "parent_of", "confirmed", "Relationship \(index)")
        }
        let multipleNeighborValue = try XCTUnwrap(viewValues(for: multipleNeighbors)["Alex"])
        for index in 0..<6 { XCTAssertTrue(multipleNeighborValue.contains("Relationship \(index)")) }
        XCTAssertTrue(multipleNeighborValue.contains("1 more relationship fact"))
        XCTAssertFalse(multipleNeighborValue.contains("Relationship 6"))
    }

    @MainActor
    func testGraphCanvasPansFromDotsAndBackgroundAndCancelsCleanly() throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        let graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        let point = view.layout.positions[0]
        let screen = view.viewport.screen(point, size: view.bounds.size)
        let viewport = view.viewport
        view.configure(snapshot: graph, selectedID: view.layout.ids[0], dark: false, reduceMotion: true)
        XCTAssertEqual(view.viewport, viewport, "Selecting an item already in view leaves the camera alone")
        view.beginDrag(at: screen)
        view.drag(to: CGPoint(x: screen.x + 60, y: screen.y + 30))
        XCTAssertEqual(view.layout.positions[0], point, "Panning from a dot must not rearrange the graph")
        XCTAssertEqual(view.viewport.offset.x, viewport.offset.x + 60, accuracy: 0.001)
        XCTAssertEqual(view.viewport.offset.y, viewport.offset.y + 30, accuracy: 0.001)
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.layout.positions[0], point)
        XCTAssertEqual(view.viewport, viewport)
        view.beginDrag(at: CGPoint(x: -100, y: -100))
        view.drag(to: CGPoint(x: -50, y: -60))
        XCTAssertEqual(view.viewport.offset.x, viewport.offset.x + 50, accuracy: 0.001)
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.viewport, viewport)
        view.zoom(to: 1.8, anchor: CGPoint(x: 70, y: 90))
        let zoomed = view.viewport
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.viewport, zoomed, "Starting a pinch without a pan must preserve the current viewport")
    }

    @MainActor
    func testGraphPanToPinchAndBackKeepsTheFingerAnchor() {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(), selectedID: nil, dark: false, reduceMotion: true)
        view.beginDrag(at: CGPoint(x: 20, y: 50))
        view.drag(to: CGPoint(x: 60, y: 70))
        let midpoint = CGPoint(x: 130, y: 200)
        let anchor = view.viewport.world(midpoint, size: view.bounds.size)
        view.beginPinch(at: midpoint)
        let movedMidpoint = CGPoint(x: 150, y: 220)
        view.changePinch(scale: 1.4, at: movedMidpoint)
        let pinched = view.viewport
        view.endDrag(cancelled: true, velocity: CGPoint(x: 800, y: 900))
        XCTAssertEqual(view.viewport, pinched, "Cancelling the one-finger pan cannot undo the pinch")
        let anchored = view.viewport.screen(anchor, size: view.bounds.size)
        XCTAssertEqual(anchored.x, movedMidpoint.x, accuracy: 0.001)
        XCTAssertEqual(anchored.y, movedMidpoint.y, accuracy: 0.001)
        let remainingFinger = CGPoint(x: 220, y: 250)
        view.endPinch(continuingPanAt: remainingFinger)
        view.drag(to: CGPoint(x: 230, y: 265))
        XCTAssertEqual(view.viewport.offset.x, pinched.offset.x + 10, accuracy: 0.001)
        XCTAssertEqual(view.viewport.offset.y, pinched.offset.y + 15, accuracy: 0.001)
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.viewport, pinched)
    }

    @MainActor
    func testSecondFingerCannotPanBeforePinchRecognizes() {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(), selectedID: nil, dark: false, reduceMotion: true)
        view.handlePan(state: .began, at: CGPoint(x: 60, y: 100), touchCount: 1)
        view.handlePan(state: .changed, at: CGPoint(x: 70, y: 110), touchCount: 1)
        let panned = view.viewport
        let midpoint = CGPoint(x: 170, y: 220)
        view.handlePan(state: .changed, at: midpoint, touchCount: 2)
        XCTAssertEqual(view.viewport, panned, "A second finger cannot pan by its distance from the first")
        let anchor = panned.world(midpoint, size: view.bounds.size)
        view.beginPinch(at: midpoint, recognizerScale: 1.08)
        view.changePinch(scale: 1.08, at: midpoint)
        XCTAssertEqual(view.viewport.scale, panned.scale, accuracy: 0.001,
                       "Recognizing a pinch must not apply its threshold movement a second time")
        let moved = CGPoint(x: 175, y: 225)
        view.changePinch(scale: 1.62, at: moved)
        XCTAssertEqual(view.viewport.scale, panned.scale * 1.5, accuracy: 0.001)
        let screen = view.viewport.screen(anchor, size: view.bounds.size)
        XCTAssertEqual(screen.x, moved.x, accuracy: 0.001)
        XCTAssertEqual(screen.y, moved.y, accuracy: 0.001)
        view.endPinch(continuingPanAt: CGPoint(x: 260, y: 310))
        let pinched = view.viewport
        view.handlePan(state: .changed, at: CGPoint(x: 264, y: 316), touchCount: 1)
        XCTAssertEqual(view.viewport.offset.x, pinched.offset.x + 4, accuracy: 0.001)
        XCTAssertEqual(view.viewport.offset.y, pinched.offset.y + 6, accuracy: 0.001)
        view.handlePan(state: .ended, at: .zero, touchCount: 0)
    }

    @MainActor
    func testUnrecognizedPinchDoesNotInterruptPanAndTouchCountChangesReanchor() {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(), selectedID: nil, dark: false, reduceMotion: true)
        view.handlePan(state: .began, at: CGPoint(x: 20, y: 50), touchCount: 1)
        view.endPinch() // UIKit sends .failed even when no pinch began.
        let start = view.viewport
        view.handlePan(state: .changed, at: CGPoint(x: 30, y: 70), touchCount: 1)
        XCTAssertEqual(view.viewport.offset.x, start.offset.x + 10, accuracy: 0.001)
        XCTAssertEqual(view.viewport.offset.y, start.offset.y + 20, accuracy: 0.001)
        let panned = view.viewport
        view.handlePan(state: .changed, at: CGPoint(x: 130, y: 170), touchCount: 2)
        view.handlePan(state: .changed, at: CGPoint(x: 230, y: 270), touchCount: 1)
        XCTAssertEqual(view.viewport, panned, "Lifting a finger changes the midpoint without moving the map")
        view.handlePan(state: .changed, at: CGPoint(x: 235, y: 275), touchCount: 1)
        XCTAssertEqual(view.viewport.offset.x, panned.offset.x + 5, accuracy: 0.001)
        XCTAssertEqual(view.viewport.offset.y, panned.offset.y + 5, accuracy: 0.001)
        view.handlePan(state: .ended, at: .zero, touchCount: 0)
    }

    @MainActor
    func testOffCenterPinchKeepsItsAnchorAtBothZoomLimits() {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(), selectedID: nil, dark: false, reduceMotion: true)
        let midpoint = CGPoint(x: 67, y: 493)
        let anchor = view.viewport.world(midpoint, size: view.bounds.size)
        view.beginPinch(at: midpoint)
        for scale: CGFloat in [100, 0.001, 1.2, 0.8] {
            view.changePinch(scale: scale, at: midpoint)
            let screen = view.viewport.screen(anchor, size: view.bounds.size)
            XCTAssertEqual(screen.x, midpoint.x, accuracy: 0.001)
            XCTAssertEqual(screen.y, midpoint.y, accuracy: 0.001)
        }
        view.endPinch()
    }

    @MainActor
    func testGraphControlsAndSelectionCannotMoveCameraDuringPan() {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        let graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        let positions = view.layout.positions
        view.beginDrag(at: CGPoint(x: 10, y: 10))
        view.drag(to: CGPoint(x: 80, y: 90))
        let panned = view.viewport
        view.insets = UIEdgeInsets(top: 200, left: 0, bottom: 300, right: 0)
        view.configure(snapshot: graph, selectedID: "node-0", dark: false, reduceMotion: true)
        XCTAssertEqual(view.viewport, panned)
        XCTAssertEqual(view.layout.positions, positions)
        view.drag(to: CGPoint(x: 90, y: 95))
        XCTAssertEqual(view.viewport.offset.x, panned.offset.x + 10, accuracy: 0.001)
        XCTAssertEqual(view.viewport.offset.y, panned.offset.y + 5, accuracy: 0.001)
        view.endDrag(cancelled: false)
    }

    @MainActor
    func testGraphPhysicsPauseDuringPanAndPinchAfterTopologyRefresh() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        let controller = UIViewController()
        window.rootViewController = controller
        let view = RelationshipGraphCanvasView(frame: window.bounds)
        controller.view.addSubview(view)
        window.isHidden = false
        defer { window.isHidden = true; view.removeFromSuperview() }
        var graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: false)
        view.beginDrag(at: CGPoint(x: 20, y: 50))
        graph.edges.append(RelationshipGraphFixture.edge("new-link", from: "node-7", to: "node-15"))
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: false)
        let positions = view.layout.positions
        XCTAssertFalse(view.layout.isSettled, "A new connection wakes the layout")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(view.layout.positions, positions, "Layout forces cannot compete with a finger pan")
        view.beginPinch(at: CGPoint(x: 130, y: 200))
        view.endDrag(cancelled: true)
        view.changePinch(scale: 1.3, at: CGPoint(x: 140, y: 210))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(view.layout.positions, positions, "Layout forces cannot move the pinch anchor")
        view.endPinch()
    }

    @MainActor
    func testGraphCanvasSelectionRefreshAndResizeKeepTheMapStill() throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 393, height: 620))
        var graph = RelationshipGraphFixture.snapshot(count: 60)
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        view.layoutIfNeeded()
        let positions = view.layout.positions
        view.beginDrag(at: CGPoint(x: 2, y: 2))
        view.drag(to: CGPoint(x: 22, y: 14))
        view.endDrag(cancelled: false)
        XCTAssertEqual(view.layout.positions, positions)
        let panned = view.viewport
        view.configure(snapshot: graph, selectedID: "node-0", dark: false, reduceMotion: true)
        XCTAssertEqual(view.layout.positions, positions, "Selecting never rearranges the map")
        let refreshed = graph.edges.removeLast()
        graph.edges.append(RelationshipGraphFixture.edge("refreshed-evidence", from: refreshed.subjectId, to: refreshed.objectId))
        view.configure(snapshot: graph, selectedID: "node-0", dark: true, reduceMotion: true)
        XCTAssertEqual(view.layout.positions, positions, "An evidence refresh with the same items keeps them where they are")
        XCTAssertEqual(view.viewport, panned)
        let screenBefore = view.viewport.screen(positions[0], size: view.bounds.size)
        view.frame.size.height -= 65
        view.layoutIfNeeded()
        let screenAfter = view.viewport.screen(positions[0], size: view.bounds.size)
        XCTAssertEqual(screenAfter.x, screenBefore.x, accuracy: 0.001, "Resizing must not shift map targets")
        XCTAssertEqual(screenAfter.y, screenBefore.y, accuracy: 0.001)
    }

    @MainActor
    func testReducedMotionConnectionStillRegroupsWhileKeepingSelectionAndCamera() async throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 393, height: 620))
        var graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: "node-7", dark: false, reduceMotion: true)
        try await waitForGraphPreparation(view)
        view.layoutIfNeeded()
        view.beginDrag(at: CGPoint(x: 2, y: 2))
        view.drag(to: CGPoint(x: 22, y: 14)); view.endDrag(cancelled: false)
        let camera = view.viewport
        func gap() -> CGFloat {
            let a = view.layout.position(of: "node-7")!, b = view.layout.position(of: "node-15")!
            return hypot(a.x - b.x, a.y - b.y)
        }
        let before = gap()
        graph.edges.append(RelationshipGraphFixture.edge("new-connection", from: "node-7", to: "node-15"))
        view.configure(snapshot: graph, selectedID: "node-7", dark: false, reduceMotion: true)
        try await waitForGraphPreparation(view)
        XCTAssertLessThan(gap(), before, "Reduce Motion must not freeze a new connection's geometry")
        XCTAssertEqual(view.selectedID, "node-7")
        XCTAssertEqual(view.viewport, camera)
        XCTAssertTrue(view.layout.isSettled, "The new layout appears without animated settling")
    }

    @MainActor
    func testGraphCanvasConnectGestureReportsBothEnds() throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        let graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        var connected: (String, String?)?
        view.onConnect = { connected = ($0, $1) }
        let ids = view.layout.ids
        let from = view.viewport.screen(view.layout.positions[0], size: view.bounds.size)
        let to = view.viewport.screen(view.layout.positions[ids.count - 1], size: view.bounds.size)
        view.beginConnect(from: ids[0], at: from)
        view.moveConnect(to: CGPoint(x: from.x + 20, y: from.y + 20))
        view.endConnect(cancelled: false)
        XCTAssertNil(connected, "A thread let go close to its own item is a change of mind")
        view.beginConnect(from: ids[0], at: from)
        view.moveConnect(to: CGPoint(x: -300, y: -300))
        XCTAssertTrue(view.connectWouldCreate)
        view.endConnect(cancelled: true)
        XCTAssertNil(connected, "A cancelled drag connects nothing")
        view.beginConnect(from: ids[0], at: from)
        view.moveConnect(to: CGPoint(x: -300, y: -300))
        view.endConnect(cancelled: false)
        let created = try XCTUnwrap(connected, "Let go on open canvas, far out, starts a new item")
        XCTAssertEqual(created.0, ids[0])
        XCTAssertNil(created.1)
        connected = nil
        view.beginConnect(from: ids[0], at: from)
        view.moveConnect(to: from)
        XCTAssertNil(view.connectTargetID, "An item cannot be connected to itself")
        view.moveConnect(to: to)
        XCTAssertEqual(view.connectTargetID, view.hitNode(at: to, slop: 26, excluding: ids[0]))
        let target = view.connectTargetID
        view.endConnect(cancelled: false)
        XCTAssertEqual(connected?.0, ids[0])
        XCTAssertEqual(connected.flatMap { $0.1 }, target)
        XCTAssertNil(view.connectSourceID)
    }

    @MainActor
    func testForceGraphScreenLightDarkDenseAndAccessibleSnapshots() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, count, size) in [
            ("light", ColorScheme.light, 18, DynamicTypeSize.large),
            ("dark", ColorScheme.dark, 18, DynamicTypeSize.large),
            ("selected", ColorScheme.light, 18, DynamicTypeSize.large),
            ("islands", ColorScheme.light, 18, DynamicTypeSize.large),
            ("dense", ColorScheme.dark, 200, DynamicTypeSize.large),
            ("dense-selected", ColorScheme.dark, 200, DynamicTypeSize.large),
            ("accessible", ColorScheme.light, 18, DynamicTypeSize.accessibility3),
            ("accessible-selected", ColorScheme.light, 18, DynamicTypeSize.accessibility3),
            ("empty", ColorScheme.light, 0, DynamicTypeSize.large)
        ] {
            let fixture = RelationshipGraphFixture.snapshot(count: count)
            let snapshot = RelationshipGraphSnapshot(nodes: fixture.nodes, edges: name == "islands" ? Array(fixture.edges.prefix(4)) : fixture.edges, totalEdges: fixture.totalEdges, truncated: name == "islands", focusId: name == "dense-selected" ? "node-4" : name.contains("selected") ? "node-0" : nil)
            StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(snapshot))])
            let model = AppModel(apiClient: makeClient())
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            window.rootViewController = UIHostingController(rootView:
                NavigationStack { RelationshipGraphScreen() }.environment(model)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size))
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(500))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "force-graph-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }
    }

    @MainActor
    func testGraphScreenOpensOnAnItemWithItsCard() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            let all = RelationshipGraphFixture.snapshot()
            let local = RelationshipGraphSnapshot(nodes: all.nodes, edges: all.edges, totalEdges: all.totalEdges, truncated: false, focusId: "node-2")
            StubURLProtocol.prime([
                .success(status: 200, body: try JSONEncoder().encode(all)),
                .success(status: 200, body: try JSONEncoder().encode(local)),
            ])
            let model = AppModel(apiClient: makeClient())
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            window.rootViewController = UIHostingController(rootView:
                NavigationStack { RelationshipGraphScreen(entityID: "node-2") }.environment(model)
                    .environment(\.colorScheme, scheme))
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(1200))
            window.layoutIfNeeded()
            XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"], "The whole map, then the item's own neighbourhood")
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "graph-item-card-\(scheme == .light ? "light" : "dark")"; attachment.lifetime = .keepAlways; add(attachment)
        }
    }

    @MainActor
    func testGraphManagementScreensInBothAppearances() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let fixture = RelationshipGraphFixture.snapshot()
        let graph = RelationshipGraphSnapshot(nodes: fixture.nodes, edges: Array(fixture.edges.prefix(4)), totalEdges: 20, truncated: true, focusId: nil)
        let source = try XCTUnwrap(graph.nodes.first)
        for scheme in [ColorScheme.light, .dark] {
            let model = AppModel(apiClient: makeClient())
            for (name, content) in [
                ("groups", AnyView(GraphGroupsSheet(graph: graph, focus: { _ in }, saved: { _ in }))),
                ("connect", AnyView(GraphConnectSheet(source: source, graph: graph, saved: { _ in }))),
                ("quick-connect", AnyView(GraphQuickConnectSheet(draft: GraphConnectionDraft(first: source, second: graph.nodes[1]), saved: { _ in }))),
                ("quick-connect-new", AnyView(GraphQuickConnectSheet(draft: GraphConnectionDraft(first: source, second: nil), saved: { _ in }))),
                ("editor", AnyView(KnowledgeConnectionEditor(selected: source.entity, initialObject: graph.nodes[1].entity, candidates: [], didSave: {})))
            ] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                window.rootViewController = UIHostingController(rootView: NavigationStack { content }.environment(model).environment(\.colorScheme, scheme))
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                let attachment = XCTAttachment(image: image); attachment.name = "graph-management-\(name)-\(scheme)"; attachment.lifetime = .keepAlways; add(attachment)
            }
        }
    }

    @MainActor
    func testPeopleConnectionsStartsWithChoiceNotInventedDirectoryEdges() async throws {
        let people = PeopleMapFixture.relations.compactMap { relation -> PersonSummary? in
            guard let id = relation.otherContactId else { return nil }
            return PersonSummary(id: id, name: relation.otherLabel, initials: relation.otherInitials,
                relationship: "", group: "family", groupLabel: "Family", trust: "known",
                location: nil, factCount: 1, birthday: nil, birthdayDaysUntil: nil, lastContact: nil)
        }
        var seen = Set<String>()
        let response = PersonDirectoryResponse(generatedAt: "2026-09-06", people: people.filter { seen.insert($0.id).inserted })
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(response))])
        let model = AppModel(apiClient: makeClient())
        await model.loadPeople()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for size in [DynamicTypeSize.large, .accessibility3] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = .light
            window.rootViewController = UIHostingController(rootView:
                NavigationStack { PeopleView() }.environment(model)
                    .environment(\.colorScheme, .light).environment(\.dynamicTypeSize, size))
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "people-chooser-\(size)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertTrue(model.peopleLoaded)
        XCTAssertTrue(model.personCards.isEmpty, "A directory category must not imply a connection or eagerly fetch every person")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    @MainActor
    func testPersonTreeAndBirthdayEditorSnapshots() async throws {
        let card = PeopleMapFixture.card(relations: PeopleMapFixture.relations)
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(card))])
        let model = AppModel(apiClient: makeClient())
        await model.loadPersonCard(id: card.id)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            for editor in [false, true] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                window.rootViewController = UIHostingController(rootView:
                    NavigationStack {
                        if editor {
                            OccasionEditor(personId: card.id, occasion: PersonOccasion(id: "date", kind: "birthday", label: "", month: 3, day: 18, year: 1985, notes: "Gift ideas", quarantined: false, leadDays: 14))
                        } else {
                            ScrollView { PersonConnectionOutline(personId: card.id, ancestors: [card.id]).padding(16) }.navigationTitle("Connections")
                        }
                    }.environment(model).environment(\.colorScheme, scheme))
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "person-\(editor ? "birthday" : "tree")-\(scheme)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    @MainActor
    func testPeopleConnectionMapLightDarkCompactAndLargeTextSnapshots() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, size, count) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, 7),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large, 7),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large, 7),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3, 7),
            ("empty", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, 0)
        ] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            let content = NavigationStack {
                ScrollView {
                    PeopleConnectionMap(card: PeopleMapFixture.card(relations: Array(PeopleMapFixture.relations.prefix(count))),
                        open: { _ in }, inspect: { _ in }).padding(16)
                }
                .navigationTitle("People")
                .assistantSubmenuChrome()
            }.environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            window.rootViewController = UIHostingController(rootView: content)
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "people-map-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testGoalEditorUsesSharedCanvasInBothAppearances() async throws {
        let goal = GoalRecord(
            id: "preview", title: "Plan the weekend", description: "Keep the plan flexible.",
            status: "active", priority: 3, progress: "Gathering options", nextAction: "Compare travel times",
            targetDate: nil, createdAt: "2026-09-06", updatedAt: "2026-09-06", archivedAt: nil,
            mirrorToPrimary: false, autonomy: false, taintedOrigin: false
        )
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            for editing in [false, true] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    GoalEditor(goal: editing ? goal : nil)
                }
                .environment(AppModel(apiClient: makeClient()))
                .environment(\.colorScheme, scheme)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                defer {
                    window.isHidden = true
                    window.rootViewController = nil
                }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "goal-\(editing ? "edit" : "new")-\(scheme == .light ? "light" : "dark")"
                attachment.lifetime = .keepAlways
                add(attachment)

                // The exposed gutter must be our canvas, not UIKit's gray
                // grouped-form background. Sample away from glass controls.
                let cgImage = try XCTUnwrap(image.cgImage)
                var pixels = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
                let context = try XCTUnwrap(CGContext(
                    data: &pixels, width: cgImage.width, height: cgImage.height,
                    bitsPerComponent: 8, bytesPerRow: cgImage.width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                ))
                context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
                let offset = (cgImage.height / 2 * cgImage.width + Int(2 * image.scale)) * 4
                let expected = scheme == .light ? [238, 245, 240] : [16, 23, 18]
                for channel in 0..<3 {
                    XCTAssertEqual(Double(pixels[offset + channel]), Double(expected[channel]), accuracy: 2)
                }
            }
        }
    }

    @MainActor
    func testSituationPackLightAndDarkSnapshots() async throws {
        let data = Data("""
        {"packs":[{"id":"pack","title":"Soccer weekend","version":3,"archived":false,"updatedAt":"2026-09-06T12:00:00Z",
        "data":{"items":[{"id":"ride","title":"Confirm ride","details":"Share the arrival time once confirmed.","lane":"i_owe","dependsOn":[],"source":null,"snapshot":null,"needsReview":true}],"decisions":[]},"changes":[],"affectedIds":["ride"]}],"sources":[]}
        """.utf8)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            for screen in ["list", "detail", "form", "unavailable"] {
                StubURLProtocol.prime([screen == "unavailable"
                    ? .success(status: 404, body: Data(#"{"error":"not found"}"#.utf8))
                    : .success(status: 200, body: data)])
                let model = AppModel(apiClient: makeClient())
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    if screen == "detail" {
                        SituationPackDetail(packId: "pack")
                    } else if screen == "form" {
                        SituationPackForm {
                            Section("Item") {
                                TextField("Title", text: .constant("Confirm ride"))
                                TextField("Notes", text: .constant("Share the arrival time"))
                            }
                            Button("Save") {}
                        }.navigationTitle("Linked item").navigationBarTitleDisplayMode(.inline)
                    } else {
                        SituationPacksView()
                    }
                }
                .environment(model)
                .environment(\.colorScheme, scheme)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "situation-\(screen)-\(scheme == .light ? "light" : "dark")"
                attachment.lifetime = .keepAlways
                add(attachment)
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }

    @MainActor
    func testEvidenceRefreshReloadsCurrentPersonAndInvalidatesOtherDossiers() async {
        func card(_ id: String, name: String) -> Data {
            Data("""
            {"id":"\(id)","name":"\(name)","initials":"AR","relationship":"Family",
             "group":"family","groupLabel":"Family","trust":"known","howWeMet":[],
             "relations":[],"connections":[],"events":[],"eventsAreRecent":true,"factCount":0}
            """.utf8)
        }
        StubURLProtocol.prime([
            .success(status: 200, body: card("alex", name: "Alex")),
            .success(status: 200, body: card("robin", name: "Robin")),
            .success(status: 200, body: card("robin", name: "Robin refreshed"))
        ])
        let model = AppModel(apiClient: makeClient())
        await model.loadPersonCard(id: "alex")
        await model.loadPersonCard(id: "robin")
        XCTAssertEqual(model.personCards.count, 2)
        await model.refreshPersonEvidence(id: "robin")
        XCTAssertNil(model.personCards["alex"], "Back navigation must not reuse stale evidence")
        XCTAssertEqual(model.personCards["robin"]?.name, "Robin refreshed")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET", "GET"])
    }

    func testBirthdayEditUsesPatchAndRejectsFailedSave() async throws {
        let mutation = OccasionMutation(kind: "birthday", label: "", month: "2", day: "29", year: "", leadDays: "3", notes: "")
        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        try await makeClient().updateOccasion(id: "birthday", occasion: mutation)
        XCTAssertEqual(StubURLProtocol.attempts, ["PATCH"])
        StubURLProtocol.prime([.success(status: 400, body: Data(#"{"error":"That date does not exist."}"#.utf8))])
        do {
            try await makeClient().updateOccasion(id: "birthday", occasion: mutation)
            XCTFail("A rejected edit must not report success")
        } catch { XCTAssertEqual(StubURLProtocol.attempts, ["PATCH"]) }
    }

    @MainActor
    func testRemovingRelationshipRequiresServerSuccess() async {
        StubURLProtocol.prime([.success(status: 404, body: Data(#"{"error":"relationship not found"}"#.utf8))])
        let model = AppModel(apiClient: makeClient())
        let failed = await model.removeKnowledgeRelation(id: "missing")
        XCTAssertFalse(failed)
        XCTAssertEqual(StubURLProtocol.attempts, ["DELETE"])
        XCTAssertNotNil(model.errorMessage)

        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":false}"#.utf8))])
        let refused = await model.removeKnowledgeRelation(id: "claim")
        XCTAssertFalse(refused)

        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let removed = await model.removeKnowledgeRelation(id: "claim")
        XCTAssertTrue(removed)
        XCTAssertEqual(StubURLProtocol.attempts, ["DELETE"])
    }

    @MainActor
    func testPackDiscussionPreparesADraftWithoutSendingOrCallingTheServer() {
        StubURLProtocol.prime([])
        let model = AppModel(apiClient: makeClient())
        model.discussSituationPack(id: "test-pack-id")
        XCTAssertTrue(model.packDiscussionDraft?.contains("test-pack-id") == true)
        XCTAssertFalse(model.isSending)
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty)
        XCTAssertNotNil(model.consumePackDiscussionDraft())
        XCTAssertNil(model.packDiscussionDraft)
        XCTAssertNil(model.restorableDraft)
    }
    @MainActor
    func testAcceptedApprovalAndDenialUpdateChatEvenWhenInboxRefreshFails() async {
        for decision in ["approved", "denied"] {
            StubURLProtocol.prime([
                .success(status: 200, body: Data(#"{"ok":true,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8)),
                .success(status: 401, body: Data())
            ])
            let model = AppModel(apiClient: makeClient(), initialMessages: [.init(id: "summary", role: .assistant,
                parts: [.init(type: "approval-summary", purpose: "Test action", approvalCount: 1,
                    approvalIds: ["a1"])])])
            let accepted = await model.decideApproval(id: "a1", decision: decision)
            XCTAssertTrue(accepted)
            XCTAssertEqual(model.messages[0].approvalSummary?.pendingCount, 0)
            XCTAssertEqual(model.messages[0].approvalSummary?.outcomes.first?.status, decision)
            await model.settleApprovalReconciliation()
            XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
        }
    }

    @MainActor
    func testFailedApprovalRequestDoesNotSettleTheChatCard() async {
        for response in [
            StubURLProtocol.Outcome.failure(URLError(.timedOut)),
            .success(status: 200, body: Data(#"{"ok":false,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8))
        ] {
            StubURLProtocol.prime([response])
            let pending = ChatMessage(id: "summary", role: .assistant,
                parts: [.init(type: "approval-summary", purpose: "Test action", approvalCount: 1,
                    approvalIds: ["a1"])])
            let model = AppModel(apiClient: makeClient(), initialMessages: [pending])
            let accepted = await model.decideApproval(id: "a1", decision: "approved")
            XCTAssertFalse(accepted)
            XCTAssertEqual(model.messages, [pending])
            XCTAssertNotNil(model.errorMessage)
            XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        }
    }

    private func pendingApproval(id: String = "a1", summary: String = "Send the note") -> PendingApproval {
        PendingApproval(
            approval: ApprovalRecord(
                id: id, taskId: "t-\(id)", shortCode: "A1", summary: summary, payload: .object([:]),
                resolutionPayload: nil, status: "pending", requestedAt: "2026-10-02T10:00:00Z",
                resolvedAt: nil, resolvedVia: nil, expiresAt: "2026-10-03T10:00:00Z"),
            taskType: "chat_turn", taskTrust: "owner", toolName: "gmail.send", decision: .null)
    }

    private func overviewBody(pending: [PendingApproval]) throws -> Data {
        try JSONEncoder().encode(OverviewResponse(
            generatedAt: "2026-10-02",
            activity: ActivityList(items: [], archivedCount: 0),
            goals: GoalsDashboard(items: [], archivedCount: 0),
            approvals: ApprovalInbox(pending: pending, resolved: []),
            documents: DocumentsOverview(documents: [], stats: DocumentStats(total: 0, ready: 0, pending: 0, chunks: 0),
                primaryConversationId: "test")))
    }

    /// The control is done when the server says yes. The inbox, the chat's
    /// decision cards and (for a standing approval) Settings catch up behind
    /// it — they used to be awaited in front of the owner, which held every
    /// button disabled for two more round-trips.
    @MainActor
    func testApprovalReturnsAsSoonAsTheServerAcceptsIt() async throws {
        let slow = try overviewBody(pending: [])
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8)),
            .delayed(after: 1.5, status: 200, body: slow)
        ])
        let model = AppModel(apiClient: makeClient())
        let started = ContinuousClock.now
        let accepted = await model.decideApproval(id: "a1", decision: "approved")
        let elapsed = ContinuousClock.now - started

        XCTAssertTrue(accepted)
        XCTAssertLessThan(elapsed, .milliseconds(750), "The decision waited on the inbox re-read")
        await model.settleApprovalReconciliation()
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"], "The re-read still happens, just not in front of the control")
    }

    @MainActor
    func testStandingApprovalDoesNotWaitOnTheWorkspaceRead() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8)),
            .delayed(after: 1.5, status: 401, body: Data()),
            .delayed(after: 1.5, status: 401, body: Data())
        ])
        let model = AppModel(apiClient: makeClient())
        let started = ContinuousClock.now
        let accepted = await model.approveAndRemember(id: "a1")
        let elapsed = ContinuousClock.now - started

        XCTAssertTrue(accepted)
        XCTAssertLessThan(elapsed, .milliseconds(750))
        await model.settleApprovalReconciliation()
        XCTAssertEqual(StubURLProtocol.attempts.first, "POST")
        XCTAssertTrue(StubURLProtocol.urls.contains { $0.path.hasSuffix("/workspace") })
    }

    /// An overview request that left before the tap comes back still listing
    /// the approval. Applied as it arrived it put the card back, and with it
    /// the Island the owner had just dismissed.
    @MainActor
    func testOverviewReadFromBeforeTheTapCannotResurrectADecidedApproval() async throws {
        let stale = try overviewBody(pending: [pendingApproval()])
        StubURLProtocol.prime([.success(status: 200, body: stale)])
        let model = AppModel(apiClient: makeClient())
        await model.refreshOverview()
        XCTAssertEqual(model.pendingApprovalCount, 1)

        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8)),
            .success(status: 200, body: stale)
        ])
        let accepted = await model.decideApproval(id: "a1", decision: "approved")
        XCTAssertTrue(accepted)
        XCTAssertEqual(model.pendingApprovalCount, 0, "The card leaves on the tap")
        await model.settleApprovalReconciliation()
        XCTAssertEqual(model.pendingApprovalCount, 0, "A read that predates the decision must not bring it back")
    }

    @MainActor
    func testRejectedDecisionPutsTheApprovalBackWhereItWas() async throws {
        let first = pendingApproval(id: "a1", summary: "First")
        let second = pendingApproval(id: "a2", summary: "Second")
        StubURLProtocol.prime([.success(status: 200, body: try overviewBody(pending: [first, second]))])
        let model = AppModel(apiClient: makeClient())
        await model.refreshOverview()

        StubURLProtocol.prime([.failure(URLError(.timedOut))])
        let accepted = await model.decideApproval(id: "a1", decision: "approved")
        XCTAssertFalse(accepted)
        XCTAssertEqual(model.overview?.approvals.pending.map(\.id), ["a1", "a2"])
        XCTAssertNotNil(model.errorMessage)
    }

    private func suggestionMessage(id: String = "suggestion-message", status: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: .assistant, parts: [
            .init(type: "text", text: "One more thing from your \"Flights\" watch:"),
            .init(type: "suggestion", suggestionId: "s1", summary: "Fares to Lisbon dropped — want me to hold one?",
                status: status, proposedAction: "Hold the cheapest Lisbon fare"),
        ])
    }

    @MainActor
    func testSuggestionAnswersPostTheContractAndSettleTheCard() async throws {
        for (decision, wire) in [(SuggestionDecision.accepted, "accepted"), (.dismissed, "dismissed"), (.snoozed, "snoozed")] {
            let body = decision == .accepted ? #"{"ok":true,"taskId":"t9"}"# : #"{"ok":true}"#
            StubURLProtocol.prime([
                .success(status: 200, body: Data(body.utf8)),
                .success(status: 401, body: Data())
            ])
            let model = AppModel(apiClient: makeClient(), initialMessages: [suggestionMessage()])
            let failure = await model.decideSuggestion(id: "s1", decision: decision)

            XCTAssertNil(failure)
            let part = try XCTUnwrap(model.messages.first?.suggestionParts.first)
            XCTAssertEqual(part.suggestionStatus.rawValue, wire)
            XCTAssertEqual(part.acceptedTaskId, decision == .accepted ? "t9" : nil)
            XCTAssertEqual(model.messages.first?.visibleTextBubbles.count, 1, "The prose explains the card")

            let url = try XCTUnwrap(StubURLProtocol.urls.first)
            XCTAssertEqual(url.path, "/api/mobile/v1/suggestions/s1")
            let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(StubURLProtocol.bodies.first))
            XCTAssertEqual(sent as? [String: String], ["decision": wire])
            // Only an accept creates work worth re-reading Activity for; the
            // inbox refresh it triggers failing must stay quiet.
            XCTAssertEqual(StubURLProtocol.attempts, decision == .accepted ? ["POST", "GET"] : ["POST"])
            XCTAssertNil(model.errorMessage)
            XCTAssertEqual(model.pendingApprovalCount, 0)
        }
    }

    @MainActor
    func testRejectedSuggestionAnswerReopensTheCardWithTheReasonInline() async {
        for response in [
            StubURLProtocol.Outcome.success(status: 409, body: Data(#"{"error":"This suggestion was already answered."}"#.utf8)),
            .failure(URLError(.timedOut)),
            .success(status: 200, body: Data(#"{"ok":false}"#.utf8))
        ] {
            StubURLProtocol.prime([response])
            let pending = suggestionMessage()
            let model = AppModel(apiClient: makeClient(), initialMessages: [pending])
            let failure = await model.decideSuggestion(id: "s1", decision: .accepted)

            XCTAssertNotNil(failure)
            XCTAssertEqual(model.messages, [pending], "A failed answer must put the question back exactly")
            XCTAssertNil(model.errorMessage, "The reason belongs on the card, not in a banner")
            XCTAssertEqual(StubURLProtocol.attempts, ["POST"], "An answer is never retried on its own")
        }
        StubURLProtocol.prime([.success(status: 409, body: Data(#"{"error":"This suggestion was already answered."}"#.utf8))])
        let model = AppModel(apiClient: makeClient(), initialMessages: [suggestionMessage()])
        let failure = await model.decideSuggestion(id: "s1", decision: .dismissed)
        XCTAssertEqual(failure, "This suggestion was already answered.")
    }

    /// The answer re-reads its own row, and a read that left before the POST
    /// landed cannot put the question back.
    @MainActor
    func testSuggestionAnswerRereadsItsMessageAndOutlivesAStaleRead() async throws {
        let model = AppModel(apiClient: makeClient())
        let conversation = ConversationView(
            conversation: .init(id: "suggestion-chat", title: "Suggestions", modelOverride: nil,
                archivedAt: nil, isPrimary: true),
            agentName: "Assistant", agentTimezone: "UTC", messages: [suggestionMessage()],
            models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(conversation))])
        let opened = await model.openConversation(id: "suggestion-chat")
        XCTAssertTrue(opened)

        let stale = ChatUpdates(taskStatus: nil, messages: [], refreshed: [suggestionMessage(status: "pending")],
            superseded: nil, nextCursor: nil, hasMore: false, activity: [])
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: try JSONEncoder().encode(stale))
        ])
        let failure = await model.decideSuggestion(id: "s1", decision: .dismissed)

        XCTAssertNil(failure)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
        let reread = try XCTUnwrap(StubURLProtocol.urls.last)
        XCTAssertEqual(reread.path, "/api/mobile/v1/chat/status")
        let refresh = URLComponents(url: reread, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "refresh" }?.value
        XCTAssertEqual(refresh, "suggestion-message")
        XCTAssertEqual(model.messages.first?.suggestionParts.first?.suggestionStatus, .dismissed)
    }

    @MainActor
    func testPendingSuggestionIsNeverAPendingApproval() {
        StubURLProtocol.prime([])
        let model = AppModel(apiClient: makeClient(), initialMessages: [
            suggestionMessage(), suggestionMessage(id: "snoozed-message", status: "snoozed")
        ])
        XCTAssertEqual(model.pendingApprovalCount, 0)
        XCTAssertFalse(model.messages.contains(where: \.hasPendingDecision))
        XCTAssertTrue(model.messages.allSatisfy(\.decisionParts.isEmpty))
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty)
    }

    @MainActor
    func testSuggestionAnswerCannotBeSubmittedTwiceWhileSaving() async {
        StubURLProtocol.prime([.stream(body: Data())])
        let model = AppModel(apiClient: makeClient(), initialMessages: [suggestionMessage()])
        let first = Task { await model.decideSuggestion(id: "s1", decision: .dismissed) }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        XCTAssertEqual(model.messages.first?.suggestionParts.first?.suggestionStatus, .pending,
            "A receipt must not claim success before the server confirms it")
        let duplicate = await model.decideSuggestion(id: "s1", decision: .accepted)
        XCTAssertEqual(duplicate, "Your answer is still being saved.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        first.cancel()
        let failure = await first.value
        XCTAssertEqual(failure, "Your answer could not be confirmed. Try again.")
        XCTAssertEqual(model.messages.first?.suggestionParts.first?.suggestionStatus, .pending)
    }

    @MainActor
    func testSnoozeSurvivesStaleReadsAfterTheDecisionRefresh() async throws {
        let model = AppModel(apiClient: makeClient())
        let conversation = ConversationView(
            conversation: .init(id: "suggestion-chat", title: "Suggestions", modelOverride: nil,
                archivedAt: nil, isPrimary: true),
            agentName: "Assistant", agentTimezone: "UTC", messages: [suggestionMessage()],
            models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        let conversationBody = try JSONEncoder().encode(conversation)
        StubURLProtocol.prime([.success(status: 200, body: conversationBody)])
        _ = await model.openConversation(id: "suggestion-chat")
        let stale = ChatUpdates(taskStatus: nil, messages: [], refreshed: [suggestionMessage(status: "pending")],
            superseded: nil, nextCursor: nil, hasMore: false, activity: [])
        let until = ISO8601DateFormatter.assistant.string(from: Date().addingTimeInterval(3600))
        let result = SuggestionResult(ok: true, taskId: nil, snoozedUntil: until)
        StubURLProtocol.prime([
            .success(status: 200, body: try JSONEncoder().encode(result)),
            .success(status: 200, body: try JSONEncoder().encode(stale)),
            .success(status: 200, body: conversationBody)
        ])
        let failure = await model.decideSuggestion(id: "s1", decision: .snoozed)
        XCTAssertNil(failure)
        _ = await model.openConversation(id: "suggestion-chat")
        XCTAssertEqual(model.messages.first?.suggestionParts.first?.suggestionStatus, .snoozed)
    }

    func testCancellationIsControlFlowIncludingFoundationWrappers() {
        let cancellations: [Error] = [
            CancellationError(), URLError(.cancelled), APIError.transport(URLError(.cancelled)),
            NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError),
            NSError(domain: "wrapper", code: 1, userInfo: [NSUnderlyingErrorKey: URLError(.cancelled)])
        ]
        for error in cancellations {
            XCTAssertTrue(isRequestCancellation(error))
        }
        XCTAssertFalse(isRequestCancellation(URLError(.timedOut)))
        XCTAssertFalse(isRequestCancellation(APIError.server(status: 409, message: "Action cancelled by server policy")))
    }

    @MainActor
    func testCancelledRefreshesNeverCreateOrReplaceAnError() async {
        for hasExistingError in [false, true] {
            for read in 0..<4 {
                let iterationID = "\(testCaseID)-\(UUID().uuidString)"
                StubURLProtocol.beginTestCase(iterationID)
                let (client, session) = makeClient(requestScopeID: iterationID)
                let model = AppModel(apiClient: client)
                if hasExistingError {
                    model.reportError(APIError.transport(URLError(.notConnectedToInternet)), retry: {})
                }
                let original = model.errorMessage
                let notice = model.errorNotice
                // A cancelled bootstrap can end the operation before the
                // parallel overview child starts. Every endpoint that did
                // start still makes one attempt and cannot trigger a retry.
                // Each iteration owns its model, URLSession, and request scope,
                // so a late overview start cannot consume the next prime().
                let requests = read == 0 ? 2 : 1
                StubURLProtocol.prime(Array(repeating: .failure(URLError(.cancelled)), count: requests))
                switch read {
                case 0: await model.refreshAll()
                case 1: await model.refreshOverview()
                case 2: await model.refreshWorkspace()
                default: _ = await model.knowledge()
                }
                // A parallel overview may start between two individually
                // locked getters. Compare methods and paths from one snapshot.
                let recorded = StubURLProtocol.requests
                let paths = Set(recorded.map { $0.1.path })
                XCTAssertTrue((1...requests).contains(recorded.count))
                XCTAssertTrue(recorded.allSatisfy { $0.0 == "GET" })
                XCTAssertEqual(paths.count, recorded.count,
                    "Cancellation must not trigger a second attempt for an endpoint")
                if read == 0 {
                    XCTAssertTrue(paths.isSubset(of:
                        ["/api/mobile/v1/bootstrap", "/api/mobile/v1/overview"]))
                }
                XCTAssertEqual(model.errorMessage, original)
                XCTAssertEqual(model.errorNotice, notice)
                XCTAssertEqual(model.errorRetry != nil, hasExistingError)
                StubURLProtocol.endTestCase(iterationID)
                let didDrain = await cancelAndDrain(session)
                XCTAssertTrue(didDrain, "The iteration's URLSession must drain before priming the next case")
            }
        }
    }

    @MainActor
    func testCancelledConnectionDoesNotOpenPairingOrOfferRetry() async {
        // The bootstrap and the overview leave together, so both are cancelled.
        StubURLProtocol.prime([.failure(URLError(.cancelled)), .failure(URLError(.cancelled))])
        let model = AppModel(apiClient: makeClient())
        await model.connect()
        XCTAssertFalse(model.showingConnection)
        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.errorNotice)
        XCTAssertNil(model.errorRetry)
    }

    @MainActor
    func testCancelledTaskCannotPublishAnUnrelatedTransportError() async {
        let model = AppModel(apiClient: makeClient())
        let request = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            model.reportError(APIError.transport(URLError(.networkConnectionLost)), retry: {})
        }
        await request.value
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.errorRetry)
    }

    @MainActor
    func testAutomaticRefreshFailuresAreQuietButExplicitRefreshRemainsActionable() async {
        let model = AppModel(apiClient: makeClient())
        for read in 0..<3 {
            StubURLProtocol.prime([.failure(URLError(.notConnectedToInternet))])
            switch read {
            case 0: await model.refreshAll(reportFailure: false)
            case 1: await model.refreshOverview(reportFailure: false)
            default: await model.refreshWorkspace(reportFailure: false)
            }
            XCTAssertNil(model.errorNotice)
            XCTAssertNil(model.errorRetry)
        }
        StubURLProtocol.prime([.failure(URLError(.notConnectedToInternet))])
        await model.refreshOverview()
        XCTAssertEqual(model.errorNotice?.title, "You’re offline")
        XCTAssertNotNil(model.errorRetry)
        model.dismissError()
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.errorNotice)
        XCTAssertNil(model.errorRetry)
    }

    @MainActor
    func testRecoveredReadClearsOnlyItsOwnNotice() async throws {
        let model = AppModel(apiClient: makeClient())
        let overview = OverviewResponse(generatedAt: "2026-09-07",
            activity: ActivityList(items: [], archivedCount: 0),
            goals: GoalsDashboard(items: [], archivedCount: 0),
            approvals: ApprovalInbox(pending: [], resolved: []),
            documents: DocumentsOverview(documents: [], stats: DocumentStats(total: 0, ready: 0, pending: 0, chunks: 0),
                primaryConversationId: "test"))
        let body = try JSONEncoder().encode(overview)
        StubURLProtocol.prime([.failure(URLError(.notConnectedToInternet))])
        await model.refreshOverview()
        XCTAssertNotNil(model.errorNotice)
        StubURLProtocol.prime([.success(status: 200, body: body)])
        await model.refreshOverview(reportFailure: false)
        XCTAssertNil(model.errorNotice)
        model.reportError(APIError.server(status: 400, message: "Your edit could not be saved."))
        StubURLProtocol.prime([.success(status: 200, body: body)])
        await model.refreshOverview(reportFailure: false)
        XCTAssertEqual(model.errorMessage, "Your edit could not be saved.")
    }

    @MainActor
    func testActualFailuresKeepUsefulCopyAndNeverInheritAnUnsafeRetry() {
        let model = AppModel(apiClient: makeClient())
        model.reportError(APIError.transport(URLError(.timedOut)), retry: {})
        XCTAssertNotNil(model.errorRetry)
        XCTAssertEqual(model.errorNotice?.title, "Connection interrupted")
        model.reportError(APIError.server(status: 400, message: "Choose a valid date."), retry: {})
        XCTAssertNil(model.errorRetry)
        XCTAssertEqual(model.errorNotice?.message, "Choose a valid date.")
        model.reportError(APIError.decoding(model: "InternalModel", detail: "raw implementation detail"))
        XCTAssertFalse(model.errorNotice?.message.contains("InternalModel") ?? true)
        XCTAssertTrue(model.errorNotice?.message.contains("app update") ?? false)
        model.errorMessage = "Your draft is preserved."
        XCTAssertEqual(model.errorNotice?.message, "Your draft is preserved.")
    }

    @MainActor
    func testErrorBannerVisualStates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, size, retryable) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, true),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large, true),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large, true),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3, true),
            ("validation", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, false)
        ] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 600)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            let content = VStack {
                AssistantErrorBanner(
                    notice: retryable
                        ? AssistantErrorNotice(error: APIError.transport(URLError(.notConnectedToInternet)))
                        : AssistantErrorNotice(message: "Choose a valid date before saving this occasion."),
                    retry: retryable ? {} : nil,
                    dismiss: {}
                )
                .padding(12)
                Spacer()
            }
            .background(AssistantTheme.canvas(for: scheme))
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            window.rootViewController = UIHostingController(rootView: content)
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(250))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "error-banner-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testChatFollowsNewMessagesAndGrowingStreamWhileAtBottom() async throws {
        let model = AppModel(apiClient: makeClient())
        // A chat read alone is not an authenticated composer session.
        StubURLProtocol.primeBootstrap(try notificationBootstrap())
        await model.refreshAll()
        XCTAssertNotNil(model.composerDraftScope)
        var messages = (0..<16).map { index in
            ChatMessage(id: "follow-\(index)", role: .assistant,
                parts: [.init(type: "text", text: "Earlier message \(index).\nKeep the latest response above the input.")])
        }
        func loadMessages() async throws {
            let conversation = ConversationView(
                conversation: .init(id: "follow-chat", title: "Follow test", modelOverride: nil,
                    archivedAt: nil, isPrimary: true),
                agentName: "Assistant", agentTimezone: "UTC", messages: messages,
                models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
            StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(conversation))])
            let opened = await model.openConversation(id: "follow-chat")
            XCTAssertTrue(opened)
        }
        try await loadMessages()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView:
            ChatView(safeAreaTopInset: 62, safeAreaBottomInset: 34,
                safeAreaLeadingInset: 0, safeAreaTrailingInset: 0)
                .environment(model))
        window.makeKeyAndVisible()
        defer {
            model.cancelSend()
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        func transcriptScrollView() -> UIScrollView? {
            descendants(window).compactMap { $0 as? UIScrollView }.first { !($0 is UITextView) }
        }
        // Hosting is asynchronous; wait for the view this test actually inspects.
        let mountDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        var mountedScroll = transcriptScrollView()
        while mountedScroll == nil, ContinuousClock.now < mountDeadline {
            try await Task.sleep(for: .milliseconds(50))
            mountedScroll = transcriptScrollView()
        }
        let scroll = try XCTUnwrap(mountedScroll)
        func assertAtBottom(file: StaticString = #filePath, line: UInt = #line) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            var settled = 0
            repeat {
                try await Task.sleep(for: .milliseconds(100))
                window.layoutIfNeeded()
                let error = abs(scroll.contentOffset.y + scroll.bounds.height
                    - scroll.contentSize.height - scroll.adjustedContentInset.bottom)
                settled = error <= 2 ? settled + 1 : 0
            } while settled < 3 && ContinuousClock.now < deadline
            XCTAssertEqual(scroll.contentOffset.y + scroll.bounds.height,
                scroll.contentSize.height + scroll.adjustedContentInset.bottom, accuracy: 2,
                "Incoming content must keep the newest edge visible", file: file, line: line)
        }
        try await assertAtBottom()
        messages.append(ChatMessage(id: "incoming", role: .assistant,
            parts: [.init(type: "text", text: String(repeating: "A newly arrived response.\n", count: 40))]))
        try await loadMessages()
        try await assertAtBottom()

        func chunk(_ text: String) throws -> Data {
            let json = try JSONSerialization.data(withJSONObject: ["type": "text-delta", "delta": text])
            return Data("data: \(String(decoding: json, as: UTF8.self))\n\n".utf8)
        }
        StubURLProtocol.prime([.stream(body: try chunk("First words.\n"))])
        model.send("Continue with a detailed response.")
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.messages.last?.text != "First words.\n", ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(model.messages.last?.text, "First words.\n")
        let streamID = model.messages.last?.id
        try await assertAtBottom()
        for index in 1...3 {
            let delta = String(repeating: "Streaming section \(index).\n", count: 35)
            let previousText = model.messages.last?.text ?? ""
            StubURLProtocol.appendStream(try chunk(delta))
            // Use the same bounded state wait as the first streamed chunk above.
            let deltaDeadline = ContinuousClock.now.advanced(by: .seconds(3))
            while model.messages.last?.text != previousText + delta, ContinuousClock.now < deltaDeadline {
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertEqual(model.messages.last?.text, previousText + delta)
            XCTAssertEqual(model.messages.last?.id, streamID)
            XCTAssertTrue(model.isSending)
            try await assertAtBottom()
        }
    }

    func testCardFormUnknownResponseReplaysTheExactFrozenBody() async throws {
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            expectedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            formId: "trip_plan",
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            values: ["destination": .string("Portland"), "confirmed": .boolean(false)],
            ownerMessageText: "Plan a weekend in Portland."
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let exactBody = try encoder.encode(submission)
        let pending = CardFormPendingRequest(submission: submission, body: exactBody)
        StubURLProtocol.prime([
            .failure(URLError(.networkConnectionLost)),
            .success(status: 202, body: Data(#"{"ok":true,"created":true,"taskId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","messageId":"ffffffff-ffff-4fff-8fff-ffffffffffff","taskStatus":"pending","messageCursor":"cursor-1","queueGeneration":1,"dispatch":"outbox"}"#.utf8))
        ])

        let client = makeClient()
        let unknown = try await client.submitCardForm(pending)
        let accepted = try await client.submitCardForm(pending)

        XCTAssertEqual(unknown.admission.operationId, submission.operationId)
        if case .outcomeUnknown = unknown.admission.outcome {} else { XCTFail("A missing reply must remain unknown") }
        if case .accepted(let receipt) = accepted.admission.outcome {
            XCTAssertEqual(receipt.taskId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
            XCTAssertEqual(accepted.messageCursor, "cursor-1")
        } else {
            XCTFail("The replayed request should return the durable admission receipt")
        }
        XCTAssertEqual(StubURLProtocol.urls.map(\.path), [
            "/api/mobile/v1/chat/forms", "/api/mobile/v1/chat/forms"
        ])
        XCTAssertEqual(StubURLProtocol.bodies, [exactBody, exactBody])
    }

    func testCardFormServerErrorStaysUnknownAndRetriesOnlyTheFrozenSubmission() async throws {
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            expectedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            formId: "trip_plan",
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            values: ["confirmed": .boolean(false)],
            ownerMessageText: "Please plan this trip."
        )
        var encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let body = try encoder.encode(submission)
        let pending = CardFormPendingRequest(submission: submission, body: body)
        StubURLProtocol.prime([
            .success(status: 503, body: Data(#"{"error":"temporarily unavailable"}"#.utf8)),
            .success(status: 202, body: Data(#"{"ok":true,"created":false,"taskId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","messageId":"ffffffff-ffff-4fff-8fff-ffffffffffff","taskStatus":"pending","messageCursor":"cursor-replay","queueGeneration":1,"dispatch":"outbox"}"#.utf8)),
        ])

        let client = makeClient()
        let first = try await client.submitCardForm(pending)
        let replay = try await client.submitCardForm(pending)

        if case .outcomeUnknown = first.admission.outcome {} else {
            XCTFail("A server error does not prove whether the admission committed")
        }
        if case .accepted = replay.admission.outcome {} else {
            XCTFail("The exact replay should recover the durable admission receipt")
        }
        XCTAssertEqual(replay.messageCursor, "cursor-replay")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "POST"])
        XCTAssertEqual(StubURLProtocol.bodies, [body, body])
    }

    func testCardFormMalformedSuccessWithoutCursorRemainsUnknown() async throws {
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            expectedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            formId: "trip_plan",
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            values: ["confirmed": .boolean(false)],
            ownerMessageText: "Please plan this trip."
        )
        var encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let body = try encoder.encode(submission)
        let pending = CardFormPendingRequest(submission: submission, body: body)
        StubURLProtocol.prime([.success(status: 202, body: Data(#"{"ok":true,"created":true,"taskId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","messageId":"ffffffff-ffff-4fff-8fff-ffffffffffff","taskStatus":"pending","queueGeneration":1}"#.utf8))])

        let result = try await makeClient().submitCardForm(pending)

        if case .outcomeUnknown = result.admission.outcome {} else {
            XCTFail("A 2xx response without the required cursor cannot confirm a committed admission")
        }
        XCTAssertNil(result.messageCursor)
        XCTAssertEqual(StubURLProtocol.bodies, [body])
    }

    func testCardFormGenericConflictAndExpiredAuthorizationRemainUnknownButActivePointerIsTyped() async throws {
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            expectedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            formId: "trip_plan",
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            values: ["confirmed": .boolean(false)],
            ownerMessageText: "Please plan this trip."
        )
        let body = try JSONEncoder().encode(submission)
        let pending = CardFormPendingRequest(submission: submission, body: body)
        StubURLProtocol.prime([
            .success(status: 409, body: Data(#"{"ok":false,"error":"A conflict occurred."}"#.utf8)),
            .success(status: 401, body: Data(#"{"error":"expired"}"#.utf8)),
            .success(status: 409, body: Data(#"{"ok":false,"reason":"active_form","activeTaskId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","taskStatus":"waiting_approval","error":"Another form is active."}"#.utf8)),
            .success(status: 409, body: Data(#"{"ok":false,"reason":"active_form","activeTaskId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","taskStatus":"future_state","error":"Another form is active."}"#.utf8)),
        ])

        let client = makeClient()
        let conflict = try await client.submitCardForm(pending)
        let expired = try await client.submitCardForm(pending)
        let active = try await client.submitCardForm(pending)
        let unknownStatus = try await client.submitCardForm(pending)

        if case .outcomeUnknown = conflict.admission.outcome {} else { XCTFail("A generic conflict cannot prove the request was not committed") }
        if case .outcomeUnknown = expired.admission.outcome {} else { XCTFail("An expired authorization response may follow a committed request") }
        if case let .activeForm(pointer) = active.admission.outcome {
            XCTAssertEqual(pointer.taskId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
            XCTAssertEqual(pointer.taskStatus, "waiting_approval")
        } else { XCTFail("Only a validated active_form response exposes an owner task pointer") }
        if case .outcomeUnknown = unknownStatus.admission.outcome {} else {
            XCTFail("An unknown task status must not be surfaced as a trusted active-task pointer")
        }
        XCTAssertEqual(StubURLProtocol.bodies, [body, body, body, body])
    }

    func testCardFormRejectsOversizedFrozenBodyBeforeNetworkAccess() async throws {
        StubURLProtocol.prime([])
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            expectedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            formId: "trip_plan",
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            values: ["confirmed": .boolean(false)],
            ownerMessageText: "Please plan this trip."
        )
        let oversized = CardFormPendingRequest(submission: submission, body: Data(repeating: 0x41, count: 16 * 1024 + 1))
        do {
            _ = try await makeClient().submitCardForm(oversized)
            XCTFail("The form route has a 16 KiB body limit")
        } catch APIError.invalidResponse {}
        XCTAssertTrue(StubURLProtocol.urls.isEmpty)
    }

    func testCardFormStaleRevisionIsADefiniteRejection() async throws {
        let submission = CardFormSubmission(
            protocolVersion: CardFormSubmission.currentProtocol,
            conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            expectedRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            formId: "trip_plan",
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            values: ["confirmed": .boolean(false)],
            ownerMessageText: "Please plan this trip."
        )
        let body = try JSONEncoder().encode(submission)
        let pending = CardFormPendingRequest(submission: submission, body: body)
        StubURLProtocol.prime([.success(status: 409, body: Data(#"{"ok":false,"reason":"stale_revision","error":"The card changed."}"#.utf8))])

        let result = try await makeClient().submitCardForm(pending)

        if case let .rejected(status, reason) = result.admission.outcome {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(reason, "stale_revision")
        } else {
            XCTFail("An explicit stale-revision conflict is definite and must not remain unknown")
        }
        XCTAssertNil(result.messageCursor)
        XCTAssertEqual(StubURLProtocol.bodies, [body])
    }

    func testNativeFormProjectionIsNegotiatedOnlyAfterSecureSessionReadiness() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"findings":[]}"#.utf8)),
            .success(status: 200, body: Data(#"{"findings":[]}"#.utf8)),
        ])
        let client = makeClient()
        let valueCopy = client

        _ = try await client.knowledgeCleanup()
        valueCopy.enableNativeCardForms()
        _ = try await client.knowledgeCleanup()

        let formHeaders = StubURLProtocol.headers.map { headers in
            headers.first { $0.key.caseInsensitiveCompare("x-assistant-card-forms") == .orderedSame }?.value
        }
        XCTAssertEqual(formHeaders, [nil, "card-form-v1"])

        let replacement = client.replacingConfiguration(
            APIConfiguration(baseURL: URL(string: "https://other-assistant.test")!, token: "new-token")
        )
        XCTAssertFalse(replacement.nativeCardFormsEnabled,
                       "A new server must bootstrap without advertising the previous encrypted session")
    }

    private func makeClient(clientID: String? = nil, token: String = "t") -> APIClient {
        makeClient(clientID: clientID, token: token, requestScopeID: testCaseID).client
    }

    private func makeClient(clientID: String? = nil, token: String = "t",
                            requestScopeID: String,
                            securityReviewDeadline: TimeInterval = 12,
                            delegate: URLSessionDelegate? = nil) -> (client: APIClient, session: URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Assistant-Test-Case": requestScopeID]
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        sessionLock.withLock { testSessions.append(session) }
        let client = APIClient(
            configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: token),
            session: session,
            clientID: clientID,
            securityReviewDeadline: securityReviewDeadline
        )
        return (client, session)
    }

    /// End one repeated fixture scope before the next one is primed. A late
    /// URLProtocol start carries the old scope ID and cannot consume the next
    /// iteration's global response queue.
    private func cancelAndDrain(_ session: URLSession, invalidate: Bool = true) async -> Bool {
        if invalidate { session.invalidateAndCancel() }
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            let tasks = await withCheckedContinuation { continuation in
                session.getAllTasks { continuation.resume(returning: $0) }
            }
            if tasks.isEmpty { return true }
            tasks.forEach { $0.cancel() }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    /// The failure this whole change exists for: the first attempt is handed a
    /// connection that died during suspension, and the second one succeeds.
    func testReadRetriesOnceAfterATimeout() async throws {
        let body = Data(#"{"findings":[]}"#.utf8)
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .success(status: 200, body: body),
        ])

        let cleanup = try await makeClient().knowledgeCleanup()

        XCTAssertEqual(cleanup.findings.count, 0)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
    }

    /// A retry that fails too reports the transport error, not Foundation's.
    func testRepeatedTimeoutSurfacesTransportCopy() async {
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .failure(URLError(.timedOut)),
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected the second timeout to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
            XCTAssertEqual(
                error.errorDescription,
                "Couldn't reach your assistant — it may still be waking up."
            )
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
    }

    /// Writes are never replayed: the server may well have applied the first
    /// one before its answer went missing, and a doubled decision is worse
    /// than a visible failure.
    func testWriteIsNotRetried() async {
        StubURLProtocol.prime([.failure(URLError(.timedOut))])

        do {
            _ = try await makeClient().decideApproval(id: "a1", decision: "approved")
            XCTFail("expected the timeout to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    /// Only failures a fresh connection could plausibly fix are retried.
    func testUnrecoverableTransportFailureIsNotRetried() async {
        let testToken = "nonretryable-transport-test"
        StubURLProtocol.prime([], tokens: [
            "Bearer \(testToken)": [
                .failure(URLError(.unsupportedURL)),
                .failure(URLError(.unsupportedURL)),
            ],
        ])

        do {
            _ = try await makeClient(token: testToken).knowledgeCleanup()
            XCTFail("expected the error to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        let cleanupAttempts = StubURLProtocol.requests.filter {
            $0.1.path == "/api/mobile/v1/knowledge/cleanup"
                && $0.2.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value == "Bearer \(testToken)"
        }.map { $0.0 }
        XCTAssertEqual(cleanupAttempts, ["GET"], "A non-retryable failure must not retry the knowledge-cleanup read")
    }

    /// A server that answered is not a transport failure, so the banner must
    /// not offer to retry it — the same answer would come back.
    func testServerErrorIsNotTreatedAsTransport() async {
        StubURLProtocol.prime([
            .success(status: 500, body: Data(#"{"error":"boom"}"#.utf8)),
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected a server error")
        } catch let error as APIError {
            XCTAssertFalse(error.isTransport)
            XCTAssertEqual(error.errorDescription, "boom")
        } catch {
            XCTFail("expected APIError.server, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    func testOfflineGetsItsOwnCopy() {
        let error = APIError.transport(URLError(.notConnectedToInternet))
        XCTAssertEqual(error.errorDescription, "You appear to be offline.")
    }
}

extension APIClientRetryTests {
    func testPhoneCalendarSharingUsesVerifiedOwnerAndGenerationWireContract() async throws {
        let activeState = #"{"version":1,"ownerId":"owner-1","publisherId":"publisher-1","generation":1,"enabled":true,"consentVersion":1,"calendars":[{"id":"work","name":"Work","purpose":"commitments"}],"updatedAt":"2026-10-22T12:00:00Z","mutationId":"mutation-1"}"#
        let disabledState = #"{"version":1,"ownerId":"owner-1","publisherId":"publisher-1","generation":2,"enabled":false,"consentVersion":1,"calendars":[],"updatedAt":"2026-10-22T12:01:00Z"}"#
        let stateBody = #"{"ok":true,"state":\#(activeState)}"#
        let disabledBody = #"{"ok":true,"state":\#(disabledState)}"#
        let getBody = #"{"ownerId":"owner-1","ownerEmail":"owner@example.com","timeZone":"America/Los_Angeles","state":null}"#
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: Data(getBody.utf8)),
                .success(status: 200, body: Data(stateBody.utf8)),
                .success(status: 200, body: Data(stateBody.utf8)),
                .success(status: 200, body: Data(disabledBody.utf8)),
            ]
        ])
        let client = makeClient()
        let read = try await client.phoneCalendarSharing()
        XCTAssertEqual(read.ownerId, "owner-1")
        XCTAssertEqual(read.ownerEmail, "owner@example.com")
        XCTAssertNil(read.state)

        let calendar = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: "America/Los_Angeles")
        let command = PhoneCalendarSharingCommandBody.configure(
            "enable", ownerId: "owner-1", publisherId: "publisher-1", expectedGeneration: 0,
            mutationId: "mutation-1", calendars: [calendar]
        )
        let configured = try await client.configurePhoneCalendarSharing(command)
        XCTAssertTrue(configured.ok)
        XCTAssertEqual(configured.state.generation, 1)

        let snapshot = PhoneCalendarSnapshotInput(
            timeMin: "2026-10-15T07:00:00Z", timeMax: "2026-12-07T08:00:00Z",
            capturedAt: "2026-10-22T12:00:00Z", selectionRevision: 1, complete: true, truncated: false,
            sourceAvailability: [.init(calendarId: "work", status: .available, complete: true, reason: nil)],
            timeZone: "America/Los_Angeles", calendars: [calendar],
            events: [.init(eventId: "work:event:1", calendarId: "work", providerExternalIdentifier: "provider-event-id",
                           status: "confirmed", calendarTimeZone: "America/Los_Angeles", ownerParticipant: nil,
                           iCalUID: nil, originalStartTime: nil, summary: "Planning", location: "Room 2",
                           start: "2026-10-23T16:00:00Z", end: "2026-10-23T17:00:00Z", allDay: false, blocksTime: true)]
        )
        _ = try await client.publishPhoneCalendarSnapshot(
            ownerId: "owner-1", publisherId: "publisher-1", generation: 1, snapshot: snapshot
        )
        let removed = try await client.revokePhoneCalendarSharing(.init(
            ownerId: "owner-1", publisherId: "publisher-1", generation: 0,
            cancelPendingMutationId: "mutation-1"
        ))
        XCTAssertFalse(removed.state.enabled)

        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "PUT", "DELETE"])
        XCTAssertEqual(StubURLProtocol.urls.map(\.path), Array(repeating: "/api/mobile/v1/calendars", count: 4))
        let post = try XCTUnwrap(try JSONSerialization.jsonObject(with: StubURLProtocol.bodies[1]) as? [String: Any])
        XCTAssertEqual(post["ownerId"] as? String, "owner-1")
        XCTAssertEqual(post["mutationId"] as? String, "mutation-1")
        XCTAssertEqual(post["expectedGeneration"] as? Int, 0)
        let put = try XCTUnwrap(try JSONSerialization.jsonObject(with: StubURLProtocol.bodies[2]) as? [String: Any])
        XCTAssertEqual(put["ownerId"] as? String, "owner-1")
        XCTAssertEqual(put["generation"] as? Int, 1)
        let sentSnapshot = try XCTUnwrap(put["snapshot"] as? [String: Any])
        let sentEvent = try XCTUnwrap((sentSnapshot["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(sentEvent["providerExternalIdentifier"] as? String, "provider-event-id")
        XCTAssertNil(sentEvent["iCalUID"])
        let delete = try XCTUnwrap(try JSONSerialization.jsonObject(with: StubURLProtocol.bodies[3]) as? [String: Any])
        XCTAssertEqual(delete["ownerId"] as? String, "owner-1")
        XCTAssertEqual(delete["generation"] as? Int, 0)
        XCTAssertEqual(delete["cancelPendingMutationId"] as? String, "mutation-1")
    }

    func testPhoneCalendarSharingPreservesConflictStateFrom409() async throws {
        let response = #"{"ok":false,"error":"publisher_conflict","state":{"version":1,"ownerId":"owner-1","publisherId":"other-device","generation":3,"enabled":true,"consentVersion":1,"calendars":[],"updatedAt":"2026-10-22T12:00:00Z"}}"#
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [.success(status: 409, body: Data(response.utf8))]
        ])
        let result = try await makeClient().configurePhoneCalendarSharing(.configure(
            "enable", ownerId: "owner-1", publisherId: "publisher-1", expectedGeneration: 0,
            mutationId: "mutation-1", calendars: [.init(id: "work", name: "Work", purpose: .unspecified)]
        ))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "publisher_conflict")
        XCTAssertEqual(result.state.publisherId, "other-device")
        XCTAssertEqual(result.state.generation, 3)
    }

    func testPhoneCalendarSnapshotFreshnessRequiresRecentCompleteFullWindow() {
        let now = ISO8601DateFormatter().date(from: "2026-10-22T19:00:00Z")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let today = calendar.startOfDay(for: now)
        let min = calendar.date(byAdding: .day, value: -7, to: today)!
        let max = calendar.date(byAdding: .day, value: 46, to: today)!
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func state(received: String?, captured: String? = nil, complete: Bool, truncated: Bool, lower: Date = min, upper: Date = max) -> PhoneCalendarSharingState {
            .init(version: 1, ownerId: "owner-1", publisherId: "publisher-1", generation: 1, enabled: true,
                  consentVersion: 1, calendars: [], updatedAt: formatter.string(from: now), capturedAt: captured,
                  receivedAt: received, timeMin: formatter.string(from: lower), timeMax: formatter.string(from: upper),
                  complete: complete, truncated: truncated, mutationId: nil)
        }

        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: nil, complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .notSent)
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now.addingTimeInterval(-31 * 60)), captured: formatter.string(from: now.addingTimeInterval(-31 * 60)), complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .stale)
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now), captured: formatter.string(from: now), complete: false, truncated: true), ownerTimeZone: "America/Los_Angeles", now: now), .incomplete)
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now), captured: formatter.string(from: now), complete: true, truncated: false, lower: min.addingTimeInterval(1)), ownerTimeZone: "America/Los_Angeles", now: now), .incomplete)
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now), captured: formatter.string(from: now.addingTimeInterval(-31 * 60)), complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .stale,
                       "A recent server receipt cannot make an old device capture current")
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now), captured: nil, complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .incomplete)
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now), captured: formatter.string(from: now), complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .current)
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now), captured: formatter.string(from: now.addingTimeInterval(60)), complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .stale,
                       "A future capture timestamp cannot be made current by a fresh receipt")
        XCTAssertEqual(PhoneCalendarSnapshotFreshness.evaluate(state(received: formatter.string(from: now.addingTimeInterval(60)), captured: formatter.string(from: now), complete: true, truncated: false), ownerTimeZone: "America/Los_Angeles", now: now), .stale,
                       "A future server receipt cannot make a snapshot current")
    }

    func testPhoneCalendarSnapshotWindowUsesOwnerZoneAndExclusiveUpperBound() {
        let result = PhoneCalendarSnapshotWindowFormatter.format(
            timeMin: "2026-10-22T00:00:00Z",
            timeMax: "2026-10-24T07:00:00Z",
            ownerTimeZone: "America/Los_Angeles",
            locale: Locale(identifier: "en_US_POSIX")
        )
        XCTAssertEqual(result, "Snapshot window: Oct 21, 2026 through Oct 23, 2026 inclusive; exclusive end Oct 24, 2026 at 12:00 AM PDT (America/Los_Angeles).")
        XCTAssertFalse(result?.contains("Oct 22, 2026 through Oct 24") == true,
                        "The window must not use a Tokyo/device-zone rendering for a Los Angeles owner")
    }
}

@MainActor
private final class PhoneCalendarSharingMemoryRecordStore: PhoneCalendarSharingRecordStore {
    private(set) var records: [String: PhoneCalendarSharingLocalRecord] = [:]
    var failNextSave = false

    func load(scope: String) -> PhoneCalendarSharingLocalRecord? { records[scope] }
    func save(_ record: PhoneCalendarSharingLocalRecord, scope: String) -> Bool {
        if failNextSave { failNextSave = false; return false }
        records[scope] = record
        return true
    }
}

@MainActor
private final class PhoneCalendarSharingFixtureSource: PhoneCalendarSource {
    var access: PhoneCalendarAccess = .fullAccess
    var availableCalendars: [PhoneCalendar] = [.init(id: "work", title: "Work", account: "Personal")]
    var sharedEvents: [PhoneCalendarShareEvent] = []
    private(set) var shareQueryCount = 0

    func requestAccess() async throws -> Bool { true }
    func calendars() -> [PhoneCalendar] { availableCalendars }
    func events(in interval: DateInterval, calendarIDs: Set<String>) -> [PhoneCalendarEvent] { [] }
    func shareEvents(in interval: DateInterval, calendarIDs: Set<String>, verifiedOwnerEmail: String) -> [PhoneCalendarShareEvent] {
        shareQueryCount += 1
        return sharedEvents
    }
}

extension APIClientRetryTests {
    private func phoneCalendarState(
        owner: String = "owner-1", publisher: String? = "publisher-1", generation: Int,
        enabled: Bool, calendars: [SharedPhoneCalendar] = [], mutationId: String? = nil
    ) -> PhoneCalendarSharingState {
        .init(version: 1, ownerId: owner, publisherId: publisher, generation: generation,
              enabled: enabled, consentVersion: enabled ? 1 : 0, calendars: calendars,
              updatedAt: "2026-10-22T12:00:00Z", capturedAt: nil, receivedAt: nil,
              timeMin: nil, timeMax: nil, complete: nil, truncated: nil, mutationId: mutationId)
    }

    private func phoneCalendarRead(
        _ state: PhoneCalendarSharingState?, owner: String = "owner-1",
        timeZone: String = "America/Los_Angeles"
    ) throws -> Data {
        try JSONEncoder().encode(PhoneCalendarSharingRead(
            ownerId: owner, ownerEmail: "owner@example.test", timeZone: timeZone, state: state
        ))
    }

    private func phoneCalendarMutation(_ state: PhoneCalendarSharingState, ok: Bool = true) throws -> Data {
        let encodedState = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state))
        return try JSONSerialization.data(withJSONObject: ["ok": ok, "state": encodedState])
    }

    private func phoneCalendarScope(baseURL: String = "https://assistant.test", owner: String = "owner-1") -> String {
        let normalized = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let digest = SHA256.hash(data: Data("\(normalized)|\(owner)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func waitForHeldCalendarRequest() async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/calendars"), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/calendars"))
    }

    @MainActor
    func testStopDuringPendingInitialEnableCancelsLateAcknowledgement() async throws {
        let store = PhoneCalendarSharingMemoryRecordStore()
        let source = PhoneCalendarSharingFixtureSource()
        let scope = phoneCalendarScope()
        _ = store.save(.init(publisherId: "publisher-1", generation: 0, pendingMutation: nil,
                         pendingRevocation: nil, lastRead: nil, lastState: nil), scope: scope)
        let enabled = phoneCalendarState(generation: 1, enabled: true,
                                         calendars: [.init(id: "work", name: "Work", purpose: .commitments, timeZone: nil)])
        let disabled = phoneCalendarState(generation: 2, enabled: false)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(nil)),
                .heldCalendarConfigureAcknowledgement(status: 200, body: try phoneCalendarMutation(enabled)),
                .success(status: 200, body: try phoneCalendarMutation(disabled))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        let enabling = Task {
            await coordinator.enable(client: client, expectedOwnerID: "owner-1", selectedCalendars: [
                .init(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
            ])
        }
        try await waitForHeldCalendarRequest()
        XCTAssertTrue(coordinator.hasPendingMutation)
        await coordinator.disable(client: client, expectedOwnerID: "owner-1")
        XCTAssertFalse(coordinator.isSharingEnabled, "A saved local revocation hides the stale enabled state immediately")
        XCTAssertFalse(coordinator.hasPendingRemoval, "The DELETE was acknowledged")
        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
        await enabling.value
        XCTAssertFalse(coordinator.isSharingEnabled, "The late POST acknowledgement cannot restore sharing")
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "DELETE"])
    }

    @MainActor
    func testFailedStopSaveDuringInitialEnableRetainsCancellationToken() async throws {
        let owner = "owner-initial-stop-save"
        let scope = phoneCalendarScope(owner: owner)
        let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(scope)"
        defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
        let store = PhoneCalendarSharingMemoryRecordStore()
        let source = PhoneCalendarSharingFixtureSource()
        _ = store.save(.init(publisherId: "publisher-initial-stop-save", generation: 0,
                             pendingMutation: nil, pendingRevocation: nil, lastRead: nil, lastState: nil), scope: scope)
        let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        let enabled = phoneCalendarState(owner: owner, publisher: "publisher-initial-stop-save", generation: 1,
                                         enabled: true, calendars: [work])
        let disabled = phoneCalendarState(owner: owner, publisher: "publisher-initial-stop-save", generation: 2,
                                          enabled: false)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(nil, owner: owner)),
                .heldCalendarConfigureAcknowledgement(status: 200, body: try phoneCalendarMutation(enabled)),
                .success(status: 200, body: try phoneCalendarRead(enabled, owner: owner)),
                .success(status: 200, body: try phoneCalendarMutation(disabled))
            ]
        ])
        let client = makeClient()
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: false)
        let enabling = Task {
            await coordinator.enable(client: client, expectedOwnerID: owner, selectedCalendars: [work])
        }
        try await waitForHeldCalendarRequest()
        let pendingMutationID = try XCTUnwrap(store.load(scope: scope)?.pendingMutation?.body.mutationId)

        store.failNextSave = true
        await coordinator.disable(client: client, expectedOwnerID: owner)
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertTrue(coordinator.hasPendingMutation, "Failed Stop persistence keeps the held initial POST cancellation token")
        XCTAssertTrue(coordinator.canStopSharing)
        XCTAssertFalse(coordinator.hasPendingRemoval, "The failed local write is not described as a queued removal")
        XCTAssertTrue(UserDefaults.standard.bool(forKey: pauseKey))
        XCTAssertEqual(source.shareQueryCount, 0)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST"], "No DELETE is sent before revocation metadata is durably saved")

        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
        await enabling.value
        XCTAssertTrue(coordinator.requiresPermissionReview, "A late enable acknowledgment cannot clear the Stop pause")
        XCTAssertTrue(coordinator.hasPendingMutation)
        XCTAssertEqual(source.shareQueryCount, 0, "The late enable acknowledgment cannot query event contents")

        let relaunched = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await relaunched.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
        XCTAssertTrue(relaunched.requiresPermissionReview)
        XCTAssertTrue(relaunched.hasPendingMutation)
        XCTAssertTrue(relaunched.canStopSharing)
        XCTAssertEqual(source.shareQueryCount, 0, "Relaunch does not query or upload while the pause fence is present")

        await relaunched.disable(client: client, expectedOwnerID: owner)
        XCTAssertFalse(relaunched.hasPendingRemoval)
        XCTAssertFalse(relaunched.requiresPermissionReview, "Confirmed server removal clears the local pause fence")
        XCTAssertEqual(source.shareQueryCount, 0)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "GET", "DELETE"])
        let deleteBody = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.requests.last!.3) as? [String: Any])
        XCTAssertEqual(deleteBody["cancelPendingMutationId"] as? String, pendingMutationID)
        XCTAssertEqual(deleteBody["generation"] as? Int, 1)
    }

    @MainActor
    func testSamePublisherStopGenerationConflictRequiresExplicitRetry() async throws {
        let owner = "owner-stop-conflict"
        let scope = phoneCalendarScope(owner: owner)
        let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(scope)"
        defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
        let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        let initial = phoneCalendarState(owner: owner, publisher: "same-phone", generation: 4,
                                         enabled: true, calendars: [work])
        let advanced = phoneCalendarState(owner: owner, publisher: "same-phone", generation: 5,
                                          enabled: true, calendars: [work])
        let removed = phoneCalendarState(owner: owner, publisher: "same-phone", generation: 6, enabled: false)
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "same-phone", generation: 4, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: initial), scope: scope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(initial, owner: owner)),
                .success(status: 409, body: try phoneCalendarMutation(advanced, ok: false)),
                .success(status: 200, body: try phoneCalendarRead(advanced, owner: owner)),
                .success(status: 200, body: try phoneCalendarMutation(removed))
            ]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        let client = makeClient()
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: false)
        await coordinator.disable(client: client, expectedOwnerID: owner)
        XCTAssertNil(store.load(scope: scope)?.pendingRevocation,
                      "The stale DELETE is retired after the server confirms a newer same-publisher generation")
        XCTAssertEqual(store.load(scope: scope)?.generation, 5)
        XCTAssertFalse(coordinator.isSharingEnabled)
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertTrue(coordinator.canStopSharing, "The explicit Stop action can use the new generation")

        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
        XCTAssertFalse(coordinator.hasPendingRemoval)
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "DELETE", "GET"],
                       "Foreground refresh must not automatically retry a conflicted DELETE")
        XCTAssertEqual(source.shareQueryCount, 0, "The paused roster is never queried while removal needs explicit retry")

        await coordinator.disable(client: client, expectedOwnerID: owner)
        XCTAssertFalse(coordinator.hasPendingRemoval)
        XCTAssertFalse(coordinator.requiresPermissionReview)
        XCTAssertEqual(source.shareQueryCount, 0)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "DELETE", "GET", "DELETE"])
        let retriedBody = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.requests.last!.3) as? [String: Any])
        XCTAssertEqual(retriedBody["generation"] as? Int, 5)
    }

    @MainActor
    func testOfflineStopForCommittedInitialEnableKeepsCancellationToken() async throws {
        let owner = "owner-offline-initial-stop"
        let scope = phoneCalendarScope(owner: owner)
        let mutationID = "initial-enable-mutation"
        let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        let committed = phoneCalendarState(owner: owner, publisher: "initial-publisher", generation: 1,
                                           enabled: true, calendars: [work], mutationId: mutationID)
        let disabled = phoneCalendarState(owner: owner, publisher: "initial-publisher", generation: 2, enabled: false)
        let pending = PendingPhoneCalendarRevocation(
            baseURL: "https://assistant.test", ownerId: owner, ownerEmail: "owner@example.test",
            publisherId: "initial-publisher", expectedGeneration: 0, tombstoneGeneration: 1,
            cancelPendingMutationId: mutationID
        )
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "initial-publisher", generation: 0, pendingMutation: nil,
                             pendingRevocation: pending, lastRead: nil, lastState: nil), scope: scope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(committed, owner: owner)),
                .success(status: 200, body: try phoneCalendarMutation(disabled))
            ]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await coordinator.refresh(client: makeClient(), expectedOwnerID: owner, publishIfEnabled: true)
        XCTAssertFalse(coordinator.hasPendingRemoval)
        XCTAssertFalse(coordinator.isSharingEnabled)
        XCTAssertEqual(source.shareQueryCount, 0)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "DELETE"],
                       "A committed initial enable is canceled instead of being retired as a stale Stop")
        let deleteBody = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.requests.last!.3) as? [String: Any])
        XCTAssertEqual(deleteBody["generation"] as? Int, 0)
        XCTAssertEqual(deleteBody["cancelPendingMutationId"] as? String, mutationID)
    }

    @MainActor
    func testStopDuringPendingSnapshotMakesLatePutNonAuthoritative() async throws {
        let store = PhoneCalendarSharingMemoryRecordStore()
        let source = PhoneCalendarSharingFixtureSource()
        _ = store.save(.init(publisherId: "publisher-1", generation: 0, pendingMutation: nil,
                         pendingRevocation: nil, lastRead: nil, lastState: nil), scope: phoneCalendarScope())
        let roster = [SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)]
        let enabled = phoneCalendarState(generation: 1, enabled: true, calendars: roster)
        let disabled = phoneCalendarState(generation: 2, enabled: false)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(nil)),
                .calendarConfigureAcknowledgement(status: 200, body: try phoneCalendarMutation(enabled)),
                .held(status: 200, body: try phoneCalendarMutation(enabled)),
                .success(status: 200, body: try phoneCalendarMutation(disabled))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        let enabling = Task {
            await coordinator.enable(client: client, expectedOwnerID: "owner-1", selectedCalendars: roster)
        }
        try await waitForHeldCalendarRequest()
        XCTAssertEqual(source.shareQueryCount, 1, "The explicit enable queries the selected source")
        await coordinator.disable(client: client, expectedOwnerID: "owner-1")
        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
        await enabling.value
        XCTAssertFalse(coordinator.isSharingEnabled)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "PUT", "DELETE"])
    }

    @MainActor
    func testOfflineDeleteReplaysAfterRestartOnlyForSameOwnerAndServer() async throws {
        let store = PhoneCalendarSharingMemoryRecordStore()
        let state = phoneCalendarState(generation: 1, enabled: true,
                                       calendars: [.init(id: "work", name: "Work", purpose: .commitments, timeZone: nil)])
        _ = store.save(.init(publisherId: "publisher-1", generation: 1, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: state), scope: phoneCalendarScope())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(state)),
                .success(status: 500, body: Data()),
                .success(status: 200, body: try phoneCalendarRead(state)),
                .success(status: 200, body: try phoneCalendarMutation(phoneCalendarState(generation: 2, enabled: false)))
            ]
        ])
        let first = PhoneCalendarSharingCoordinator(source: PhoneCalendarSharingFixtureSource(), recordStore: store)
        let client = makeClient()
        await first.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        await first.disable(client: client, expectedOwnerID: "owner-1")
        XCTAssertTrue(first.hasPendingRemoval)
        let relaunched = PhoneCalendarSharingCoordinator(source: PhoneCalendarSharingFixtureSource(), recordStore: store)
        await relaunched.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        XCTAssertFalse(relaunched.hasPendingRemoval)
        XCTAssertFalse(relaunched.isSharingEnabled)
        XCTAssertEqual(StubURLProtocol.requests.filter { $0.0 == "DELETE" }.count, 2)
    }

    @MainActor
    func testPendingRemovalDoesNotCrossServerOwnerOrLogoutBoundary() async throws {
        let store = PhoneCalendarSharingMemoryRecordStore()
        let pending = PendingPhoneCalendarRevocation(
            baseURL: "https://assistant.test", ownerId: "owner-1", ownerEmail: "owner@example.test",
            publisherId: "publisher-1", expectedGeneration: 0, tombstoneGeneration: 1,
            cancelPendingMutationId: "mutation-1"
        )
        _ = store.save(.init(publisherId: "publisher-1", generation: 0, pendingMutation: nil,
                         pendingRevocation: pending, lastRead: nil, lastState: nil), scope: phoneCalendarScope())
        let state = phoneCalendarState(generation: 1, enabled: false)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(state)),
                .success(status: 200, body: try phoneCalendarRead(
                    phoneCalendarState(owner: "owner-2", publisher: nil, generation: 0, enabled: false), owner: "owner-2"
                ))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(source: PhoneCalendarSharingFixtureSource(), recordStore: store)
        let sameCredentialsOtherServer = makeClient().replacingConfiguration(
            APIConfiguration(baseURL: URL(string: "https://other-assistant.test")!, token: "t")
        )
        await coordinator.refresh(client: sameCredentialsOtherServer, expectedOwnerID: "owner-1", publishIfEnabled: false)
        XCTAssertTrue(StubURLProtocol.requests.last?.1.host == "other-assistant.test")
        coordinator.cancelInFlightBinding()
        await coordinator.refresh(client: makeClient(), expectedOwnerID: "owner-2", publishIfEnabled: false)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET"], "The previous owner's tombstone is not replayed after logout, owner change, or server change")
        XCTAssertNotNil(store.load(scope: phoneCalendarScope())?.pendingRevocation)
    }

    @MainActor
    func testCancelledDelayedSharingReadDoesNotLatchBusyAcrossOwnerChange() async throws {
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .held(status: 200, body: try phoneCalendarRead(nil, owner: "owner-1")),
                .success(status: 200, body: try phoneCalendarRead(nil, owner: "owner-2"))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(
            source: PhoneCalendarSharingFixtureSource(), recordStore: PhoneCalendarSharingMemoryRecordStore()
        )
        let client = makeClient()
        let oldOwnerRead = Task {
            await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        }
        try await waitForHeldCalendarRequest()
        coordinator.cancelInFlightBinding()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-2", publishIfEnabled: false)
        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
        await oldOwnerRead.value
        XCTAssertEqual(coordinator.serverRead?.ownerId, "owner-2")
        XCTAssertTrue(coordinator.isOwnerVerified)
        XCTAssertFalse(coordinator.isWorking, "The canceled request releases only its own busy token")
        XCTAssertEqual(StubURLProtocol.requests.filter { $0.0 == "GET" }.count, 2)
    }

    @MainActor
    func testReplaceConflictDoesNotPublishOrClaimSnapshotSynced() async throws {
        let otherDevice = phoneCalendarState(owner: "owner-1", publisher: "other-device", generation: 4,
                                             enabled: true,
                                             calendars: [.init(id: "work", name: "Work", purpose: .reference, timeZone: nil)])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(otherDevice)),
                .success(status: 409, body: try phoneCalendarMutation(otherDevice, ok: false))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(source: PhoneCalendarSharingFixtureSource(), recordStore: PhoneCalendarSharingMemoryRecordStore())
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        await coordinator.enable(client: client, expectedOwnerID: "owner-1", command: "replace", selectedCalendars: [
            .init(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        ])
        XCTAssertTrue(coordinator.requiresReplace)
        XCTAssertTrue(coordinator.errorMessage?.contains("active from another iPhone") == true)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST"], "A rejected replacement cannot upload a snapshot")
        XCTAssertFalse(coordinator.statusMessage?.contains("up to date") == true)
    }

    @MainActor
    func testPreviouslySelectedMissingCalendarIsRetainedButNewMissingCalendarIsRejected() async throws {
        let source = PhoneCalendarSharingFixtureSource()
        let store = PhoneCalendarSharingMemoryRecordStore()
        let old = SharedPhoneCalendar(id: "old-calendar", name: "Old calendar", purpose: .reference, timeZone: nil)
        let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        let existing = phoneCalendarState(generation: 4, enabled: true, calendars: [work, old])
        let updated = phoneCalendarState(generation: 5, enabled: true, calendars: [work, old])
        _ = store.save(.init(publisherId: "publisher-1", generation: 4, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: existing), scope: phoneCalendarScope())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(existing)),
                .calendarConfigureAcknowledgement(status: 200, body: try phoneCalendarMutation(updated)),
                .success(status: 200, body: try phoneCalendarMutation(updated))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        await coordinator.enable(client: client, expectedOwnerID: "owner-1", command: "select", selectedCalendars: [work, old])

        let post = try XCTUnwrap(StubURLProtocol.requests.first { $0.0 == "POST" })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: post.3) as? [String: Any])
        let postedCalendars = try XCTUnwrap(body["calendars"] as? [[String: Any]])
        XCTAssertEqual(Set(postedCalendars.compactMap { $0["id"] as? String }), ["work", "old-calendar"])
        XCTAssertEqual(source.shareQueryCount, 1, "A missing selected source is never queried from the local device")

        await coordinator.enable(client: client, expectedOwnerID: "owner-1", command: "select", selectedCalendars: [work, old,
            .init(id: "never-selected", name: "Unavailable", purpose: .reference, timeZone: nil)
        ])
        XCTAssertTrue(coordinator.errorMessage?.contains("no longer available") == true)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "PUT"], "A newly selected unavailable ID is rejected")
    }

    @MainActor
    func testPermissionRevocationRemainsPausedAfterPermissionIsGrantedAgain() async throws {
        let scope = phoneCalendarScope()
        let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(scope)"
        UserDefaults.standard.removeObject(forKey: pauseKey)
        defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
        let state = phoneCalendarState(
            publisher: "publisher-1", generation: 1, enabled: true,
            calendars: [.init(id: "work", name: "Work", purpose: .commitments, timeZone: nil)]
        )
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "publisher-1", generation: 1, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: state), scope: scope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(state)),
                .failure(URLError(.notConnectedToInternet)),
                .success(status: 200, body: try phoneCalendarRead(state))
            ]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        source.access = .denied
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertTrue(coordinator.canStopSharing, "Permission pause must not hide removal for this installation's publisher")
        source.access = .fullAccess
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: true)
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET", "GET"],
                       "Restoring OS permission must not resume uploads without explicit calendar review")
        XCTAssertEqual(source.shareQueryCount, 0)
    }

    @MainActor
    func testNewInstallationRequiresReviewBeforeUsingKeychainPublisher() async throws {
        let state = phoneCalendarState(
            publisher: "publisher-1", generation: 1, enabled: true,
            calendars: [.init(id: "work", name: "Work", purpose: .commitments, timeZone: nil)]
        )
        let store = PhoneCalendarSharingMemoryRecordStore()
        var oldInstallation = PhoneCalendarSharingLocalRecord(
            publisherId: "publisher-1", generation: 1, pendingMutation: nil,
            pendingRevocation: nil, lastRead: nil, lastState: state
        )
        oldInstallation.installationID = "previous-installation"
        _ = store.save(oldInstallation, scope: phoneCalendarScope())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [.success(status: 200, body: try phoneCalendarRead(state))]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        let coordinator = PhoneCalendarSharingCoordinator(
            source: source, recordStore: store, installationID: "fresh-installation"
        )
        await coordinator.refresh(client: makeClient(), expectedOwnerID: "owner-1", publishIfEnabled: true)
        XCTAssertTrue(coordinator.requiresReplace)
        XCTAssertFalse(coordinator.isSharingEnabled)
        XCTAssertEqual(source.shareQueryCount, 0, "A new app installation must not inherit a Keychain opt-in silently")
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET"])
    }

    @MainActor
    func testFailedCalendarSelectionChangeDoesNotUploadPreviousRoster() async throws {
        let previous = [SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)]
        let state = phoneCalendarState(publisher: "publisher-1", generation: 1, enabled: true, calendars: previous)
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "publisher-1", generation: 1, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: state), scope: phoneCalendarScope())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(state)),
                .failure(URLError(.notConnectedToInternet))
            ]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        source.availableCalendars.append(.init(id: "personal", title: "Personal", account: "Personal"))
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        await coordinator.enable(client: client, expectedOwnerID: "owner-1", command: "select", selectedCalendars: [
            .init(id: "personal", name: "Personal", purpose: .reference)
        ])
        XCTAssertTrue(coordinator.hasPendingMutation, "The rejected selection remains pending for explicit resolution")
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST"],
                       "No PUT may upload the old enabled roster while the selected-roster change is unconfirmed")
        XCTAssertEqual(source.shareQueryCount, 0)
    }

    @MainActor
    func testFailedSecureSelectionSavePausesPreviousRosterUntilReview() async throws {
        let owner = "owner-selection-save-failure"
        let scope = phoneCalendarScope(owner: owner)
        let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(scope)"
        defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
        let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        let remote = phoneCalendarState(owner: owner, publisher: "publisher-selection-save", generation: 1,
                                        enabled: true, calendars: [work])
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "publisher-selection-save", generation: 1, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: remote), scope: scope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner)),
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner)),
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner))
            ]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        source.availableCalendars.append(.init(id: "personal", title: "Personal", account: "Personal"))
        let client = makeClient()
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: false)

        store.failNextSave = true
        await coordinator.enable(client: client, expectedOwnerID: owner, command: "select", selectedCalendars: [
            .init(id: "personal", name: "Personal", purpose: .reference, timeZone: nil)
        ])
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertFalse(coordinator.hasPendingMutation)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: pauseKey))
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET"], "No configure POST is sent when the reviewed selection cannot be saved")

        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
        let relaunched = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await relaunched.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
        XCTAssertTrue(relaunched.requiresPermissionReview, "The defaults fence survives a failed secure write and relaunch")
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET", "GET"])
        XCTAssertEqual(source.shareQueryCount, 0, "The prior Work roster is never queried or uploaded after failed review persistence")
    }

    @MainActor
    func testFailedSecureStopSavePausesUploadsAndCanRetryRemoval() async throws {
        let owner = "owner-stop-save-failure"
        let scope = phoneCalendarScope(owner: owner)
        let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(scope)"
        defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
        let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
        let remote = phoneCalendarState(owner: owner, publisher: "publisher-stop-save", generation: 2,
                                        enabled: true, calendars: [work])
        let disabled = phoneCalendarState(owner: owner, publisher: "publisher-stop-save", generation: 3,
                                          enabled: false, calendars: [])
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "publisher-stop-save", generation: 2, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: remote), scope: scope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner)),
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner)),
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner)),
                .success(status: 200, body: try phoneCalendarMutation(disabled))
            ]
        ])
        let source = PhoneCalendarSharingFixtureSource()
        let client = makeClient()
        let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: false)

        store.failNextSave = true
        await coordinator.disable(client: client, expectedOwnerID: owner)
        XCTAssertTrue(coordinator.requiresPermissionReview)
        XCTAssertFalse(coordinator.hasPendingRemoval, "An unsaved removal is not described as durably queued")
        XCTAssertTrue(coordinator.canStopSharing, "Stop remains available to retry after the failed local write")
        XCTAssertTrue(UserDefaults.standard.bool(forKey: pauseKey))
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET"], "No DELETE is sent without saved revocation metadata")

        await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
        let relaunched = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
        await relaunched.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
        XCTAssertTrue(relaunched.requiresPermissionReview)
        XCTAssertEqual(source.shareQueryCount, 0, "Neither foreground refresh nor relaunch publishes during the local pause")
        await relaunched.disable(client: client, expectedOwnerID: owner)
        XCTAssertFalse(relaunched.isSharingEnabled)
        XCTAssertFalse(relaunched.hasPendingRemoval)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET", "GET", "DELETE"])
        let deleteBody = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies.last!) as? [String: Any])
        XCTAssertEqual(deleteBody["generation"] as? Int, 2, "Retried Stop uses the latest verified server generation")
        XCTAssertEqual(source.shareQueryCount, 0)
    }

    @MainActor
    func testSamePublisherMutationConflictPausesRosterUntilReviewOrStop() async throws {
        let scenarios: [(Int, Int, Bool, String?)] = [
            (0, 409, false, "winner-mutation"),
            (1, 200, true, "winner-mutation"),
            (2, 200, true, nil),
            (3, 409, false, "winner-mutation")
        ]
        for (index, conflictStatus, conflictOK, winningMutationID) in scenarios {
            let owner = "owner-cas-\(index)"
            let scope = phoneCalendarScope(owner: owner)
            let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(scope)"
            defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
            let work = SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)
            let personal = SharedPhoneCalendar(id: "personal", name: "Personal", purpose: .reference, timeZone: nil)
            let remote = phoneCalendarState(owner: owner, publisher: "publisher-cas-\(index)", generation: 2,
                                            enabled: true, calendars: [personal], mutationId: winningMutationID)
            let prior = phoneCalendarState(owner: owner, publisher: "publisher-cas-\(index)", generation: 1,
                                           enabled: true, calendars: [work], mutationId: "initial-mutation")
            let request = PhoneCalendarSharingCommandBody.configure(
                "select", ownerId: owner, publisherId: "publisher-cas-\(index)", expectedGeneration: 1,
                mutationId: "latest-selection-\(index)", calendars: [work]
            )
            let store = PhoneCalendarSharingMemoryRecordStore()
            var local = PhoneCalendarSharingLocalRecord(
                publisherId: "publisher-cas-\(index)", generation: 1,
                pendingMutation: PendingPhoneCalendarMutation(body: request, baselineGeneration: 1),
                pendingRevocation: nil, lastRead: nil, lastState: prior
            )
            local.installationID = PhoneCalendarInstallationIdentity.current
            _ = store.save(local, scope: scope)
            let updated = phoneCalendarState(owner: owner, publisher: "publisher-cas-\(index)", generation: 3,
                                             enabled: true, calendars: [work])
            let disabled = phoneCalendarState(owner: owner, publisher: "publisher-cas-\(index)", generation: 4,
                                              enabled: false, calendars: [])
            var calendarResponses: [StubURLProtocol.Outcome] = [
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner)),
                .success(status: 200, body: try phoneCalendarRead(remote, owner: owner))
            ]
            let conflict = try phoneCalendarMutation(remote, ok: conflictOK)
            calendarResponses.insert(index == 3 ? .held(status: conflictStatus, body: conflict)
                                                 : .success(status: conflictStatus, body: conflict), at: 1)
            if index == 0 || index == 2 || index == 3 {
                calendarResponses.append(.success(status: 200, body: try phoneCalendarMutation(disabled)))
            } else {
                calendarResponses.append(contentsOf: [
                    .calendarConfigureAcknowledgement(status: 200, body: try phoneCalendarMutation(updated)),
                    .success(status: 200, body: try phoneCalendarMutation(updated)),
                    .success(status: 200, body: try phoneCalendarMutation(disabled))
                ])
            }
            StubURLProtocol.prime([], paths: ["/api/mobile/v1/calendars": calendarResponses])
            let source = PhoneCalendarSharingFixtureSource()
            source.availableCalendars.append(.init(id: "personal", title: "Personal", account: "Personal"))
            let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
            let client = makeClient()

            if index == 3 {
                let conflictRefresh = Task {
                    await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
                }
                try await waitForHeldCalendarRequest()
                store.failNextSave = true
                StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
                await conflictRefresh.value
            } else {
                await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
            }
            XCTAssertTrue(coordinator.requiresPermissionReview, "A mismatched mutation ID is not an acknowledgment (HTTP \(conflictStatus))")
            XCTAssertFalse(coordinator.hasPendingMutation, "A definite CAS conflict is cleared into review instead of retried forever")
            XCTAssertFalse(coordinator.isSharingEnabled)
            if index == 3 {
                XCTAssertTrue(UserDefaults.standard.bool(forKey: pauseKey),
                              "The defaults fence is saved even if secure record storage fails")
                XCTAssertNotNil(store.load(scope: scope)?.pendingMutation,
                                 "A failed secure write leaves the old durable pending mutation in place")
            } else {
                XCTAssertEqual(store.load(scope: scope)?.uploadsPausedForPermissionReview, true)
            }
            XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST"])
            XCTAssertEqual(source.shareQueryCount, 0, "Conflict handling must not query the winning remote roster")

            let relaunched = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
            await relaunched.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: true)
            XCTAssertTrue(relaunched.requiresPermissionReview, "Review pause survives coordinator relaunch")
            XCTAssertTrue(relaunched.hasPendingMutation == (index == 3),
                          "A stale persisted mutation remains review-fenced when the secure update failed")
            XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "GET"])
            XCTAssertEqual(source.shareQueryCount, 0, "Foreground refresh after relaunch cannot upload Personal")

            if index == 0 || index == 2 || index == 3 {
                XCTAssertTrue(relaunched.canStopSharing, "The authoritative same-publisher generation remains stoppable while paused")
                await relaunched.disable(client: client, expectedOwnerID: owner)
                XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "GET", "DELETE"])
                XCTAssertFalse(relaunched.isSharingEnabled)
                XCTAssertEqual(source.shareQueryCount, 0)
                let deleteBody = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies.last!) as? [String: Any])
                XCTAssertEqual(deleteBody["generation"] as? Int, 2,
                               "Stop uses the authoritative generation rather than the stale pending baseline")
            } else {
                await relaunched.enable(client: client, expectedOwnerID: owner, command: "select", selectedCalendars: [work])
                XCTAssertFalse(relaunched.requiresPermissionReview, "An explicit new selection clears review pause after matching acknowledgment")
                XCTAssertEqual(source.shareQueryCount, 1)
                XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "POST", "GET", "POST", "PUT"])
                let put = try XCTUnwrap(StubURLProtocol.bodies.last)
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: put) as? [String: Any])
                let snapshot = try XCTUnwrap(body["snapshot"] as? [String: Any])
                let calendars = try XCTUnwrap(snapshot["calendars"] as? [[String: Any]])
                XCTAssertEqual(calendars.compactMap { $0["id"] as? String }, ["work"],
                               "Explicit review publishes only the newly confirmed roster")
                await relaunched.disable(client: client, expectedOwnerID: owner)
                XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }.last, "DELETE")
            }
        }
    }

    @MainActor
    func testPreChatWaitsForInFlightSnapshotPutBeforeCalendarRead() async throws {
        let now = Date()
        var ownerCalendar = Calendar(identifier: .gregorian)
        ownerCalendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let today = ownerCalendar.startOfDay(for: now)
        let lower = ownerCalendar.date(byAdding: .day, value: -7, to: today)!
        let upper = ownerCalendar.date(byAdding: .day, value: 46, to: today)!
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let roster = [SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)]
        let fresh = PhoneCalendarSharingState(
            version: 1, ownerId: "owner-1", publisherId: "publisher-1", generation: 1,
            enabled: true, consentVersion: 1, calendars: roster,
            updatedAt: iso.string(from: now), capturedAt: iso.string(from: now), receivedAt: iso.string(from: now),
            timeMin: iso.string(from: lower), timeMax: iso.string(from: upper), complete: true, truncated: false, mutationId: nil
        )
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "publisher-1", generation: 1, pendingMutation: nil,
                             pendingRevocation: nil, lastRead: nil, lastState: fresh), scope: phoneCalendarScope())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(fresh)),
                .success(status: 200, body: try phoneCalendarRead(fresh)),
                .held(status: 200, body: try phoneCalendarMutation(fresh)),
                .success(status: 200, body: try phoneCalendarRead(fresh)),
                .success(status: 200, body: try phoneCalendarMutation(fresh))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(source: PhoneCalendarSharingFixtureSource(), recordStore: store)
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        let foregroundRefresh = Task {
            await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: true)
        }
        try await waitForHeldCalendarRequest()
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET", "PUT"])

        var calendarReadStarted = false
        var preChatResult = false
        let completed = expectation(description: "pre-chat refresh completes after PUT")
        Task { @MainActor in
            preChatResult = await coordinator.synchronizeBeforeChat(client: client, expectedOwnerID: "owner-1", timeout: .seconds(3))
            calendarReadStarted = true
            completed.fulfill()
        }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertFalse(calendarReadStarted, "An in-flight upload must finish before the calendar-question request starts")
        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
        await foregroundRefresh.value
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertTrue(preChatResult)
        XCTAssertTrue(calendarReadStarted)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET", "PUT"])

        let idlePreChat = await coordinator.synchronizeBeforeChat(
            client: client, expectedOwnerID: "owner-1", timeout: .seconds(3)
        )
        XCTAssertTrue(idlePreChat)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "GET", "PUT", "GET", "PUT"],
                       "An idle pre-chat refresh must fetch and upload even when the prior snapshot looked fresh")
    }

    @MainActor
    func testPendingStopIsRetiredAfterAnotherPublisherReplacesOrServerErasesSnapshot() async throws {
        for authoritative in [
            phoneCalendarState(publisher: "replacement-phone", generation: 7, enabled: true),
            phoneCalendarState(publisher: nil, generation: 7, enabled: false)
        ] {
            let store = PhoneCalendarSharingMemoryRecordStore()
            let pending = PendingPhoneCalendarRevocation(
                baseURL: "https://assistant.test", ownerId: "owner-1", ownerEmail: "owner@example.test",
                publisherId: "publisher-1", expectedGeneration: 4, tombstoneGeneration: 5,
                cancelPendingMutationId: nil
            )
            _ = store.save(.init(publisherId: "publisher-1", generation: 4, pendingMutation: nil,
                                 pendingRevocation: pending, lastRead: nil, lastState: nil), scope: phoneCalendarScope())
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/calendars": [
                    .success(status: 200, body: try phoneCalendarRead(authoritative)),
                    .success(status: 409, body: try phoneCalendarMutation(authoritative, ok: false))
                ]
            ])
            let coordinator = PhoneCalendarSharingCoordinator(source: PhoneCalendarSharingFixtureSource(), recordStore: store)
            let client = makeClient()
            await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
            XCTAssertFalse(coordinator.hasPendingRemoval)
            XCTAssertEqual(coordinator.serverState, authoritative)
            XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "DELETE"])
            if authoritative.enabled {
                XCTAssertTrue(coordinator.requiresReplace)
                XCTAssertFalse(coordinator.isSharingEnabled, "This iPhone must not claim the replacement publisher is local")
                XCTAssertFalse(coordinator.canStopSharing, "A stale publisher must not expose a Stop action for another phone")
                XCTAssertTrue(coordinator.statusMessage?.contains("another iPhone") == true)
            } else {
                XCTAssertFalse(coordinator.isSharingEnabled)
                XCTAssertFalse(coordinator.requiresPermissionReview,
                               "A verified server tombstone clears the pause once its local state is saved")
                XCTAssertTrue(coordinator.statusMessage?.contains("already removed") == true)
            }
            if authoritative.enabled {
                await coordinator.disable(client: client, expectedOwnerID: "owner-1")
                XCTAssertEqual(StubURLProtocol.requests.map { $0.0 }, ["GET", "DELETE"],
                               "Stop cannot send a stale DELETE against the replacement publisher")
            }
        }
    }

    @MainActor
    func testSnapshotPreservesUnknownAllDayZoneAndTimedDSTInstant() async throws {
        let source = PhoneCalendarSharingFixtureSource()
        var deviceCalendar = Calendar(identifier: .gregorian)
        deviceCalendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let allDayStart = deviceCalendar.date(from: DateComponents(year: 2026, month: 10, day: 22))!
        let dstInstant = ISO8601DateFormatter().date(from: "2026-11-01T08:30:00Z")!
        source.sharedEvents = [
            .init(eventId: "all-day", calendarId: "work", providerExternalIdentifier: nil,
                  status: "confirmed", calendarTimeZone: nil, ownerParticipant: nil,
                  originalStartTime: nil, summary: "Floating all-day event", location: "",
                  start: allDayStart, end: allDayStart.addingTimeInterval(86_400), allDay: true, blocksTime: true),
            .init(eventId: "dst", calendarId: "work", providerExternalIdentifier: "opaque-dst-id",
                  status: "confirmed", calendarTimeZone: "America/Los_Angeles", ownerParticipant: nil,
                  originalStartTime: dstInstant, summary: "DST event", location: "",
                  start: dstInstant, end: dstInstant.addingTimeInterval(3_600), allDay: false, blocksTime: true),
            .init(eventId: "unicode", calendarId: "work", providerExternalIdentifier: nil,
                  status: "confirmed", calendarTimeZone: "America/Los_Angeles", ownerParticipant: nil,
                  originalStartTime: nil, summary: String(repeating: "😀", count: 300), location: String(repeating: "📍", count: 1_200),
                  start: dstInstant, end: dstInstant.addingTimeInterval(1_800), allDay: false, blocksTime: true)
        ]
        let roster = [SharedPhoneCalendar(id: "work", name: String(repeating: "😀", count: 350), purpose: .commitments, timeZone: nil)]
        let enabled = phoneCalendarState(generation: 1, enabled: true, calendars: roster)
        let store = PhoneCalendarSharingMemoryRecordStore()
        _ = store.save(.init(publisherId: "publisher-1", generation: 0, pendingMutation: nil,
                         pendingRevocation: nil, lastRead: nil, lastState: nil), scope: phoneCalendarScope())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/calendars": [
                .success(status: 200, body: try phoneCalendarRead(nil, timeZone: "Pacific/Honolulu")),
                .calendarConfigureAcknowledgement(status: 200, body: try phoneCalendarMutation(enabled)),
                .success(status: 200, body: try phoneCalendarMutation(enabled))
            ]
        ])
        let coordinator = PhoneCalendarSharingCoordinator(
            source: source, recordStore: store, deviceTimeZone: TimeZone(identifier: "America/Los_Angeles")!
        )
        let client = makeClient()
        await coordinator.refresh(client: client, expectedOwnerID: "owner-1", publishIfEnabled: false)
        await coordinator.enable(client: client, expectedOwnerID: "owner-1", selectedCalendars: roster)

        let put = try XCTUnwrap(StubURLProtocol.requests.first { $0.0 == "PUT" })
        let post = try XCTUnwrap(StubURLProtocol.requests.first { $0.0 == "POST" })
        let postBody = try XCTUnwrap(JSONSerialization.jsonObject(with: post.3) as? [String: Any])
        let postCalendars = try XCTUnwrap(postBody["calendars"] as? [[String: Any]])
        let postedName = try XCTUnwrap(postCalendars.first?["name"] as? String)
        XCTAssertLessThanOrEqual(postedName.utf16.count, 300)
        XCTAssertFalse(postedName.contains("�"), "Truncation keeps complete Unicode scalars")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: put.3) as? [String: Any])
        let snapshot = try XCTUnwrap(body["snapshot"] as? [String: Any])
        let events = try XCTUnwrap(snapshot["events"] as? [[String: Any]])
        XCTAssertEqual(snapshot["complete"] as? Bool, false, "Unknown source-zone membership cannot be labeled complete")
        let availability = try XCTUnwrap(snapshot["sourceAvailability"] as? [[String: Any]])
        XCTAssertEqual(availability.first?["complete"] as? Bool, false)
        XCTAssertNotNil(availability.first?["reason"] as? String)
        let allDay = try XCTUnwrap(events.first { $0["eventId"] as? String == "all-day" })
        XCTAssertEqual(allDay["start"] as? String, "2026-10-22", "The source civil date is not reformatted in the owner's Honolulu zone")
        XCTAssertTrue(allDay["calendarTimeZone"] == nil || allDay["calendarTimeZone"] is NSNull,
                      "Unknown EventKit source zones remain unknown")
        let dst = try XCTUnwrap(events.first { $0["eventId"] as? String == "dst" })
        XCTAssertEqual(dst["start"] as? String, "2026-11-01T08:30:00.000Z")
        let unicode = try XCTUnwrap(events.first { $0["eventId"] as? String == "unicode" })
        XCTAssertLessThanOrEqual((unicode["summary"] as? String ?? "").utf16.count, 500)
        XCTAssertLessThanOrEqual((unicode["location"] as? String ?? "").utf16.count, 2_000)
        XCTAssertFalse((unicode["summary"] as? String ?? "").contains("�"))
        XCTAssertEqual(dst["calendarTimeZone"] as? String, "America/Los_Angeles")
    }
}

extension APIClientRetryTests {
    func testPhoneCalendarEventDebounceRevisionRejectsCancelledTaskAfterRebind() {
        var revision = PhoneCalendarEventRefreshRevision()
        let oldBindingTask = revision.advance()
        XCTAssertTrue(revision.owns(oldBindingTask))
        _ = revision.advance() // account/server rebind cancels the old debounce owner
        let newDebounceTask = revision.advance()
        XCTAssertFalse(revision.owns(oldBindingTask), "An old task completing after a rebind cannot clear a newer task handle")
        XCTAssertTrue(revision.owns(newDebounceTask))
    }

    func testWorkspaceSectionRequestUsesBoundedExplicitCursorQuery() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"section":"chats","items":[],"pagination":{"version":1,"consistency":"live-keyset","pageSize":50,"hasMore":false,"complete":true,"nextCursor":null},"availability":{"status":"available","version":1}}"#.utf8))
        ])

        let _: WorkspaceSectionPage<WorkspaceChat> = try await makeClient().workspacePage(
            section: .chats, cursor: "opaque/+cursor", archived: true
        )

        let url = try XCTUnwrap(StubURLProtocol.urls.first)
        XCTAssertEqual(url.path, "/api/mobile/v1/workspace/sections/chats")
        let query = Dictionary(uniqueKeysWithValues: try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["cursor"], "opaque/+cursor")
        XCTAssertEqual(query["archived"], "true")
        XCTAssertEqual(query["limit"], "50")
    }

    func testDocumentsAndPeoplePagesUseExplicitBoundedCursorQueries() async throws {
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"documents":[],"stats":{"total":120,"ready":100,"pending":2,"chunks":400},"primaryConversationId":"primary","hasMore":false,"pagination":{"version":1,"consistency":"live-keyset","pageSize":50,"hasMore":false,"complete":true,"nextCursor":null}}"#.utf8)),
            .success(status: 200, body: Data(#"{"generatedAt":"2026-10-07T00:00:00.000Z","people":[],"pagination":{"version":1,"consistency":"live-keyset","pageSize":50,"hasMore":false,"complete":true,"nextCursor":null}}"#.utf8)),
        ])

        let documents = try await makeClient().documentsPage(cursor: "documents-cursor")
        let people = try await makeClient().peoplePage(cursor: "people-cursor")
        XCTAssertEqual(documents.stats.total, 120)
        XCTAssertEqual(people.generatedAt, "2026-10-07T00:00:00.000Z")

        XCTAssertEqual(StubURLProtocol.urls.map(\.path), ["/api/mobile/v1/documents", "/api/mobile/v1/people"])
        let queries = try StubURLProtocol.urls.map { url -> [String: String] in
            Dictionary(uniqueKeysWithValues: try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems).map { ($0.name, $0.value ?? "") })
        }
        XCTAssertEqual(queries[0]["cursor"], "documents-cursor")
        XCTAssertEqual(queries[0]["limit"], "50")
        XCTAssertEqual(queries[1]["cursor"], "people-cursor")
        XCTAssertEqual(queries[1]["limit"], "50")
    }

    func testRecallSourceMutationUsesExactRevisionFence() async throws {
        let sourceKey = String(repeating: "a", count: 64)
        let revision = String(repeating: "b", count: 64)
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"version":3}"#.utf8))
        ])

        try await makeClient().setRecallSourceSuppressed(
            surfaceKey: sourceKey,
            sourceRevision: revision,
            suppressed: true
        )

        XCTAssertEqual(StubURLProtocol.attempts, ["PATCH"])
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/recall/sources/\(sourceKey)")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["suppressed"] as? Bool, true)
        XCTAssertEqual(object["expectedSourceRevision"] as? String, revision)
    }

    func testRecallSourceReadUsesExactDisplayedRevision() async throws {
        let sourceKey = String(repeating: "c", count: 64)
        let revision = String(repeating: "d", count: 64)
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"suppressed":true}"#.utf8))
        ])

        let suppressed = try await makeClient().recallSourceSuppressed(
            surfaceKey: sourceKey,
            sourceRevision: revision
        )

        XCTAssertTrue(suppressed)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        let url = try XCTUnwrap(StubURLProtocol.urls.first)
        XCTAssertEqual(url.path, "/api/mobile/v1/recall/sources/\(sourceKey)")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, [
            URLQueryItem(name: "sourceRevision", value: revision),
        ])
    }

    @MainActor
    func testSelectedItemNamesEveryNeighbourOnScreen() throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 393, height: 700))
        let graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: "node-0", dark: false, reduceMotion: true)
        view.layoutIfNeeded()
        _ = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
        }
        let placed = Dictionary(uniqueKeysWithValues: zip(view.layout.ids, view.layout.positions))
        let onScreen = graph.neighborhood(of: "node-0").filter { id in
            placed[id].map { view.bounds.insetBy(dx: 2, dy: 2).contains(view.viewport.screen($0, size: view.bounds.size)) } ?? false
        }
        XCTAssertFalse(onScreen.isEmpty)
        XCTAssertTrue(onScreen.isSubset(of: view.namedNodeIDs), "Every neighbour of the selection is named, however crowded")
    }

    func testNamesFadeInWithZoomHubsFirst() {
        let leaf = 1, hub = 40
        XCTAssertEqual(RelationshipGraphCanvasView.labelOpacity(scale: 0.3, degree: leaf), 0)
        XCTAssertGreaterThan(RelationshipGraphCanvasView.labelOpacity(scale: 0.3, degree: hub), 0,
                             "A hub is named from further out than a leaf")
        XCTAssertEqual(RelationshipGraphCanvasView.labelOpacity(scale: 1.2, degree: leaf), 1)
        let halfway = RelationshipGraphCanvasView.labelOpacity(scale: 0.55, degree: leaf)
        XCTAssertGreaterThan(halfway, 0); XCTAssertLessThan(halfway, 1, "Names fade rather than pop")
        XCTAssertGreaterThan(RelationshipGraphCanvasView.worldRadius(degree: hub), RelationshipGraphCanvasView.worldRadius(degree: leaf))
    }

    @MainActor
    func testOverviewNamesItsBiggestHubRatherThanNothing() async throws {
        // A real graph never fits above the zoom the old label gate required,
        // so it arrived as two hundred anonymous dots with nowhere to start.
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 393, height: 470))
        let graph = RelationshipGraphFixture.snapshot(count: 200)
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        try await waitForGraphPreparation(view)
        view.layoutIfNeeded()
        XCTAssertEqual(Set(view.layout.ids), Set(graph.nodes.map(\.id)))
        XCTAssertTrue(view.layout.positions.allSatisfy {
            view.bounds.insetBy(dx: 1, dy: 1).contains(view.viewport.screen($0, size: view.bounds.size))
        }, "Every prepared node must fit the overview's current viewport")
        _ = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
        }
        let named = view.namedNodeIDs
        XCTAssertFalse(named.isEmpty, "An overview that names nothing gives the owner nowhere to start")
        // node-0 and node-2 carry the fixture's edges, so they are its hubs;
        // the centre of a star is exactly the dot every side of which is
        // contested, and exactly the one worth naming.
        XCTAssertTrue(named.contains("node-0"), "The biggest hub is named even where the canvas is busiest")
        XCTAssertLessThanOrEqual(named.count, 20, "Names stay rationed rather than covering the map")
        XCTAssertTrue(named.isSubset(of: Set(graph.nodes.map(\.id))))
    }
}

extension APIClientRetryTests {
    @MainActor
    private func waitForGraphPreparation(_ view: RelationshipGraphCanvasView) async throws {
        let deadline = Date().addingTimeInterval(10)
        while view.isPreparingLayout && Date() < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertFalse(view.isPreparingLayout, "Graph preparation must finish or cancel")
    }

    @MainActor
    func testGraphStartupReturnsItsSeedBeforePreparingForces() async throws {
        let graph = RelationshipGraphFixture.snapshot()
        var seed = RelationshipGraphLayout()
        seed.update(nodes: graph.nodes, links: graph.links)
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        XCTAssertEqual(view.layout.positions, seed.positions, "configure must not run the 400-step batch on the UI thread")
        XCTAssertTrue(view.isPreparingLayout)
        try await waitForGraphPreparation(view)
        seed.settle()
        XCTAssertEqual(view.layout.positions, seed.positions)
        XCTAssertTrue(view.layout.isSettled, "Reduce Motion publishes one still layout")
    }

    @MainActor
    func testGraphPreparationRejectsAnOlderSnapshotAndKeepsCurrentDisplaySettings() async throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(count: 60), selectedID: nil, dark: false, reduceMotion: true)
        let graph = RelationshipGraphFixture.snapshot(count: 18)
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        var settings = GraphSettings()
        settings.arrows = false
        settings.textFade = 1
        view.settings = settings
        var expected = RelationshipGraphLayout()
        // Updates preserve positions; a stale result must not reintroduce the
        // removed nodes, even when both preparations finish close together.
        expected = view.layout
        expected.settle()
        try await waitForGraphPreparation(view)
        XCTAssertEqual(view.layout.ids, graph.nodes.map(\.id).sorted())
        XCTAssertEqual(view.layout.positions, expected.positions)
        XCTAssertEqual(view.layout.settings, settings, "A worker cannot revert current display-only settings")
    }

    @MainActor
    func testGraphTouchNavigationCancelsLateWarmupAndPreservesTheFingerViewport() async throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(count: 60), selectedID: nil, dark: false, reduceMotion: false)
        let positions = view.layout.positions
        view.beginDrag(at: CGPoint(x: 20, y: 50))
        view.drag(to: CGPoint(x: 80, y: 75))
        let viewport = view.viewport
        XCTAssertFalse(view.isPreparingLayout, "The finger owns normal-motion layout once navigation starts")
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(view.layout.positions, positions)
        XCTAssertEqual(view.viewport, viewport)
        view.endDrag(cancelled: true)
    }

    @MainActor
    func testGraphForceChangeInvalidatesPreparationAndUsesLatestTuning() async throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(), selectedID: nil, dark: false, reduceMotion: true)
        var settings = GraphSettings()
        settings.nodeSize = 1.5
        settings.repelForce = 0.7
        view.settings = settings
        var expected = view.layout
        expected.settle()
        try await waitForGraphPreparation(view)
        XCTAssertEqual(view.layout.positions, expected.positions)
        XCTAssertEqual(view.layout.radii, expected.radii)
        XCTAssertEqual(view.layout.settings, settings)
    }

    @MainActor
    func testReducedMotionPreparationWaitsForNavigationToRelease() async throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        var graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        try await waitForGraphPreparation(view)
        view.beginDrag(at: CGPoint(x: 20, y: 50))
        view.drag(to: CGPoint(x: 80, y: 75))
        graph.edges.append(RelationshipGraphFixture.edge("during-pan", from: "node-7", to: "node-15"))
        view.configure(snapshot: graph, selectedID: nil, dark: false, reduceMotion: true)
        let positions = view.layout.positions
        let viewport = view.viewport
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(view.layout.positions, positions, "A topology refresh cannot move the map under a finger")
        XCTAssertEqual(view.viewport, viewport)
        view.endDrag(cancelled: false)
        try await waitForGraphPreparation(view)
        XCTAssertTrue(view.layout.isSettled)
        XCTAssertEqual(view.viewport, viewport, "Still replacement after release preserves the owner's camera")
    }

    @MainActor
    func testGraphRemovalCancelsPreparationWithoutPublishing() async throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        view.configure(snapshot: RelationshipGraphFixture.snapshot(count: 60), selectedID: nil, dark: false, reduceMotion: true)
        let positions = view.layout.positions
        view.stopPreparingLayout()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(view.isPreparingLayout)
        XCTAssertEqual(view.layout.positions, positions, "A removed canvas must not receive a stale completion")
    }
}

// Notification routing is separate from graph and transcript presentation.
extension APIClientRetryTests {
    private var notificationOwner: String { "notification-owner" }
    private var notificationPrimaryID: String { "00000000-0000-4000-8000-000000000001" }
    private var notificationSideID: String { "00000000-0000-4000-8000-000000000002" }
    private var notificationOtherID: String { "00000000-0000-4000-8000-000000000003" }

    private func notificationConversation(_ id: String) -> ConversationView {
        ConversationView(conversation: .init(id: id, title: "Notification destination", modelOverride: nil,
            archivedAt: nil, isPrimary: id == notificationPrimaryID), agentName: "Ada", agentTimezone: "UTC",
            messages: [.init(id: "message-\(id)", role: .assistant, parts: [.init(type: "text", text: "Update for \(id)")])],
            models: [], goalTitle: nil, canArchive: id != notificationPrimaryID, cursor: nil, asyncTurn: nil)
    }

    private func notificationBootstrap(owner: String = "notification-owner") throws -> Data {
        try JSONEncoder().encode(BootstrapResponse(generatedAt: "2026-10-03T00:00:00Z",
            identity: .init(id: owner, name: "Ada", avatarUrl: nil),
            shell: .init(dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
                memoryHealth: .init(totalUsable: 0, notYetOrganized: 0, awaitingReview: 0, ownerConfirmed: 0, lastOrganizedAt: nil)),
            conversation: notificationConversation(notificationPrimaryID)))
    }

    private func notificationDestination(conversation: String? = nil, owner: String? = nil) throws -> AssistantNotificationDestination {
        var info: [AnyHashable: Any] = ["route": "chat"]
        if let conversation { info["conversationId"] = conversation }
        if let owner { info["agentId"] = owner }
        return try XCTUnwrap(AssistantNotificationDestination(userInfo: info))
    }

    @MainActor
    private func notificationModel(
        enqueueAutomaticSpeech: ((ChatMessage) -> Void)? = nil,
        scheduleLocalNotification: LocalNotificationScheduler? = nil
    ) async throws -> AppModel {
        let systemSurfaces = RecordingAppSystemSurfaces()
        let notificationScheduler: LocalNotificationScheduler = scheduleLocalNotification
            ?? { _, _, _, _, _, _ in false }
        let model: AppModel
        if let enqueueAutomaticSpeech {
            model = AppModel(
                apiClient: makeClient(),
                enqueueAutomaticSpeech: enqueueAutomaticSpeech,
                scheduleLocalNotification: notificationScheduler,
                systemSurfaces: systemSurfaces
            )
        } else {
            model = AppModel(apiClient: makeClient(), scheduleLocalNotification: notificationScheduler,
                             systemSurfaces: systemSurfaces)
        }
        model.scenePhaseDidChange(.background)
        StubURLProtocol.primeBootstrap(try notificationBootstrap())
        await model.refreshAll(reportFailure: false)
        XCTAssertNotNil(model.bootstrap)
        return model
    }

    func testNotificationDestinationRejectsMalformedOwnerAndNeverTreatsPathsAsConversationIDs() throws {
        XCTAssertNil(AssistantNotificationDestination(userInfo: ["route": "unknown"]))
        XCTAssertNil(AssistantNotificationDestination(userInfo: ["route": "chat", "agentId": 42]))
        XCTAssertNil(AssistantNotificationDestination(userInfo: ["route": "chat", "agentId": ""]))
        for invalid in ["../private", "https://other.example", "not-an-id"] {
            XCTAssertNil(try notificationDestination(conversation: invalid).conversationID)
        }
        let scoped = try notificationDestination(conversation: notificationSideID.uppercased(), owner: notificationOwner)
        XCTAssertEqual(scoped.conversationID, notificationSideID)
        XCTAssertTrue(scoped.belongsTo(ownerID: notificationOwner))
        XCTAssertFalse(scoped.belongsTo(ownerID: "other-owner"))
        XCTAssertTrue(try notificationDestination().belongsTo(ownerID: notificationOwner), "Route-only legacy notifications remain usable")
    }

    @MainActor
    func testSamePushTokenRegistersForEachServerOwnerScope() async throws {
        let suite = "assistant.push-scope-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let manager = NotificationManager(defaults: defaults)
        var registrations: [(String, String)] = []
        manager.deviceTokenHandler = { token, scope in registrations.append((token, scope)) }

        manager.setRegistrationScope("https://a.test|owner-a")
        manager.handleDeviceToken(Data([0x01, 0xab]))
        while registrations.count < 1 { await Task.yield() }
        manager.setRegistrationScope("https://b.test|owner-b")
        while registrations.count < 2 { await Task.yield() }

        XCTAssertEqual(registrations.map(\.0), ["01ab", "01ab"])
        XCTAssertEqual(registrations.map(\.1), ["https://a.test|owner-a", "https://b.test|owner-b"])
    }

    @MainActor
    func testSamePushTokenRegistersAgainWhenAPNSEnvironmentChanges() async throws {
        let suite = "assistant.push-environment-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let manager = NotificationManager(defaults: defaults)
        var registrations: [(String, String)] = []
        manager.deviceTokenHandler = { token, scope in registrations.append((token, scope)) }

        manager.setRegistrationScope("https://a.test|owner-a|sandbox")
        manager.handleDeviceToken(Data([0x01, 0xab]))
        while registrations.count < 1 { await Task.yield() }
        manager.setRegistrationScope("https://a.test|owner-a|production")
        while registrations.count < 2 { await Task.yield() }

        XCTAssertEqual(registrations.map(\.0), ["01ab", "01ab"])
        XCTAssertEqual(registrations.map(\.1), ["https://a.test|owner-a|sandbox", "https://a.test|owner-a|production"])
    }

    @MainActor
    func testStopAfterToolStartsWaitsForTaskStatusAndWarnsEffectsMayRemain() async throws {
        let model = try await notificationModel()
        let working = ChatUpdates(taskStatus: "working", messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false,
            activity: [ToolActivity(toolName: "gmail.send", status: "executing", step: 1)])
        let cancelled = ChatUpdates(taskStatus: "cancelled", messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: [])
        let taskId = "33333333-3333-4333-8333-333333333333"
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: taskId)],
            "/api/mobile/v1/chat/status": [
                .delayed(after: 0.08, status: 200, body: try JSONEncoder().encode(working)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
            ],
            "/api/mobile/v1/activity/\(taskId)": [
                .success(status: 200, body: Data(#"{"ok":true,"cancelled":true,"effectStatus":"unknown"}"#.utf8)),
            ],
        ])
        model.send("Stop this turn")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat/status" }) {
            await Task.yield()
        }
        let toolDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !model.toolActivity.contains(where: { $0.toolName == "gmail.send" }),
              ContinuousClock.now < toolDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.toolActivity.first?.toolName, "gmail.send",
                       "Stop is requested only after the task-status feed reports an entered tool handler")
        XCTAssertTrue(model.isSending)

        model.cancelSend()
        XCTAssertTrue(model.isCancellingSend)
        XCTAssertNotEqual(model.activityDetail, "You stopped this turn")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/activity/\(taskId)" }) {
            await Task.yield()
        }
        let settlementDeadline = ContinuousClock.now.advanced(by: .seconds(10))
        while model.activityDetail != "Task cancelled; external effects are not reversed",
              ContinuousClock.now < settlementDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertFalse(model.isSending)
        XCTAssertFalse(model.isCancellingSend)
        XCTAssertEqual(StubURLProtocol.urls.first(where: { $0.path == "/api/mobile/v1/activity/\(taskId)" })?.path,
                       "/api/mobile/v1/activity/\(taskId)")
        XCTAssertEqual(model.errorMessage,
                       "The task was cancelled. Any external action already started may still have taken effect.")
        XCTAssertEqual(model.activityDetail, "Task cancelled; external effects are not reversed")
        let body = try XCTUnwrap(StubURLProtocol.bodies.enumerated().first(where: {
            StubURLProtocol.urls[$0.offset].path == "/api/mobile/v1/activity/\(taskId)"
        })?.element)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["action": "cancel"])
    }

    @MainActor
    func testTaskAttentionNotificationUsesOnlyApprovalForThatTask() async throws {
        let unrelated = pendingApproval(id: "unrelated", summary: "Approve a different task")
        let matching = pendingApproval(id: "matching", summary: "Review this task")
        let genericBody = "Open the chat to see what needs your attention."
        let scenarios: [(status: String, taskId: String, pending: [PendingApproval], route: AssistantRoute, approvalId: String?, body: String)] = [
            ("waiting_approval", "t-current", [unrelated], .chat, nil, genericBody),
            ("waiting_approval", "t-matching", [unrelated, matching], .approvals, matching.id, "A decision is ready to review."),
            ("waiting_budget", "t-current", [unrelated], .chat, nil, genericBody),
            ("needs_attention", "t-current", [unrelated], .chat, nil, genericBody),
        ]

        for scenario in scenarios {
            let recorder = LocalNotificationRecorder()
            let notificationScheduled = expectation(description: "The \(scenario.status) notification for \(scenario.taskId) is scheduled")
            let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
                let scheduled = await recorder.schedule(
                    title: title,
                    body: body,
                    route: route,
                    approvalId: approvalId,
                    agentID: agentID,
                    conversationID: conversationID
                )
                notificationScheduled.fulfill()
                return scheduled
            })
            defer { model.scenePhaseDidChange(.background) }
            let reply = ChatMessage(id: "reply-\(scenario.taskId)", role: .assistant,
                parts: [.init(type: "text", text: "The task needs attention.")],
                metadata: ["taskId": .string(scenario.taskId)])
            let updates = ChatUpdates(taskStatus: scenario.status, messages: [reply], refreshed: [],
                superseded: nil, nextCursor: nil, hasMore: false, activity: [])
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/chat": [
                    .taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: scenario.taskId),
                ],
                "/api/mobile/v1/chat/status": [
                    .success(status: 200, body: try JSONEncoder().encode(updates)),
                ],
                "/api/mobile/v1/overview": [
                    .success(status: 200, body: try overviewBody(pending: scenario.pending)),
                ],
                "/api/mobile/v1/workspace": [.success(status: 401, body: Data())],
            ])

            model.send("Continue the task")
            // Wait for the event under test rather than racing repeated
            // main-actor timer callbacks against the notification task.
            await fulfillment(of: [notificationScheduled], timeout: 5)

            let scheduled = try XCTUnwrap(recorder.entries.first,
                "Expected one task attention notification for \(scenario.status), task \(scenario.taskId); sending=\(model.isSending), activity=\(model.activityDetail ?? "none")")
            XCTAssertEqual(recorder.entries.count, 1)
            XCTAssertEqual(scheduled.route, scenario.route)
            XCTAssertEqual(scheduled.approvalId, scenario.approvalId)
            XCTAssertEqual(scheduled.body, scenario.body)
            XCTAssertEqual(scheduled.agentID, notificationOwner)
            XCTAssertEqual(scheduled.conversationID, notificationPrimaryID)
            if scenario.route == .chat {
                XCTAssertEqual(scheduled.title, "Ada needs attention")
                XCTAssertEqual(model.activityDetail, "This task needs attention. Open the chat for details.")
            } else {
                XCTAssertEqual(scheduled.title, "Ada needs you")
                XCTAssertEqual(model.activityDetail, "A decision is ready to review")
            }
        }
    }

    @MainActor
    func testDoneTaskWithoutItsOwnReplyNeverUsesAnOlderOrForeignReply() async throws {
        let recorder = LocalNotificationRecorder()
        let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
            await recorder.schedule(
                title: title,
                body: body,
                route: route,
                approvalId: approvalId,
                agentID: agentID,
                conversationID: conversationID
            )
        })
        let taskId = "33333333-3333-4333-8333-333333333333"
        let unrelated = ChatMessage(
            id: "reply-from-another-task",
            role: .assistant,
            parts: [.init(type: "text", text: "This is another task's result.")],
            metadata: ["taskId": .string("44444444-4444-4444-8444-444444444444")]
        )
        let intermediateToolRow = ChatMessage(
            id: "tool-only-row-for-current-task",
            role: .assistant,
            parts: [.init(type: "tool-call")],
            metadata: ["taskId": .string(taskId)]
        )
        let unsupportedCardRow = ChatMessage(
            id: "unsupported-card-for-current-task",
            role: .assistant,
            parts: [.init(type: "data-card", data: .object(["kind": .string("unknown-card-kind")]))],
            metadata: ["taskId": .string(taskId)]
        )
        let doneWithoutOwnReply = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "done", messages: [unrelated, intermediateToolRow, unsupportedCardRow], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: []
        ))
        let recorderUnavailable = StubURLProtocol.Outcome.success(status: 401, body: Data())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: taskId)],
            "/api/mobile/v1/chat/status": Array(repeating: .success(status: 200, body: doneWithoutOwnReply), count: 4),
            "/api/mobile/v1/overview": [.success(status: 200, body: try overviewBody(pending: []))],
            "/api/mobile/v1/workspace": [recorderUnavailable],
        ])

        model.send("Check the completed task")
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while recorder.entries.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        let notification = try XCTUnwrap(recorder.entries.first)
        XCTAssertEqual(notification.title, "Task complete; reply not yet available")
        XCTAssertEqual(notification.body, "Open the conversation to check the task.")
        XCTAssertEqual(model.activityDetail, "This task is marked complete, but its reply has not appeared yet.")
        XCTAssertEqual(model.activityThought, .replyUnavailable)
        XCTAssertEqual(model.errorMessage, "This task is marked complete, but its reply has not appeared yet.")
        XCTAssertFalse(model.isSending)
        XCTAssertTrue(model.messages.contains(where: { $0.id == unrelated.id }))
        XCTAssertTrue(model.messages.contains(where: { $0.id == intermediateToolRow.id }))
        XCTAssertTrue(model.messages.contains(where: { $0.id == unsupportedCardRow.id }))
        XCTAssertNotEqual(notification.body, "Your result is ready.")
    }

    @MainActor
    func testLateExactTaskReplyClearsOnlyItsMissingReplyNotice() async throws {
        let recorder = LocalNotificationRecorder()
        let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
            await recorder.schedule(
                title: title,
                body: body,
                route: route,
                approvalId: approvalId,
                agentID: agentID,
                conversationID: conversationID
            )
        })
        let taskId = "33333333-3333-4333-8333-333333333333"
        model.recordCompletedTaskWithoutReply(taskId: taskId)
        model.scenePhaseDidChange(.active)
        defer { model.scenePhaseDidChange(.background) }

        let reply = ChatMessage(
            id: "late-exact-task-reply",
            role: .assistant,
            parts: [.init(type: "text", text: "The completed task result arrived.")],
            metadata: ["taskId": .string(taskId)]
        )
        let response = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "done", messages: [reply], refreshed: [], superseded: nil,
            nextCursor: "late-reply", hasMore: false, activity: []
        ))
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat/status": [.success(status: 200, body: response)],
        ])

        let changed = await model.refreshIdleConversation()
        XCTAssertEqual(changed, true)
        XCTAssertNil(model.errorMessage, "Only the exact task's newly visible durable reply clears the notice")
        XCTAssertTrue(model.messages.contains(where: { $0.id == reply.id }))
        XCTAssertEqual(recorder.entries.map(\.body), ["A new response is ready."])
        XCTAssertNotEqual(model.activityThought, .finished, "Idle reconciliation does not fabricate task completion speech or activity")
    }

    @MainActor
    func testIdleReconciliationIgnoresToolOnlyAndRetractedRepliesAndKeepsNewerErrors() async throws {
        let taskId = "33333333-3333-4333-8333-333333333333"
        let exactReply = ChatMessage(
            id: "late-exact-task-reply",
            role: .assistant,
            parts: [.init(type: "text", text: "The task result arrived.")],
            metadata: ["taskId": .string(taskId)]
        )
        let foreignReply = ChatMessage(
            id: "unrelated-task-reply",
            role: .assistant,
            parts: [.init(type: "text", text: "A different task result arrived.")],
            metadata: ["taskId": .string("44444444-4444-4444-8444-444444444444")]
        )
        let toolOnly = ChatMessage(
            id: "late-tool-only-row",
            role: .assistant,
            parts: [.init(type: "tool-call")],
            metadata: ["taskId": .string(taskId)]
        )
        let alreadyVisibleReply = ChatMessage(
            id: "message-\(notificationPrimaryID)",
            role: .assistant,
            parts: [.init(type: "text", text: "The existing visible result is refreshed with task identity.")],
            metadata: ["taskId": .string(taskId)]
        )
        let cases: [(String, [ChatMessage], [ChatMessage], [String]?, String?, Bool, Bool)] = [
            // The bootstrap includes an older visible assistant message. A
            // new tool-only row must not pair with it to announce a reply.
            ("historical-text-plus-tool-only", [toolOnly], [], nil, nil, false, false),
            ("retracted", [exactReply], [], [exactReply.id], nil, false, false),
            ("foreign-task", [foreignReply], [], nil, nil, false, true),
            ("newer-error", [exactReply], [], nil, "A newer connection issue.", false, true),
            ("refreshed-existing-exact-reply", [], [alreadyVisibleReply], nil, nil, true, false),
        ]

        for (name, rows, refreshed, superseded, newerError, clearsNotice, expectNotification) in cases {
            let recorder = LocalNotificationRecorder()
            let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
                await recorder.schedule(
                    title: title,
                    body: body,
                    route: route,
                    approvalId: approvalId,
                    agentID: agentID,
                    conversationID: conversationID
                )
            })
            model.recordCompletedTaskWithoutReply(taskId: taskId)
            if let newerError { model.errorMessage = newerError }
            model.scenePhaseDidChange(.active)
            let response = try JSONEncoder().encode(ChatUpdates(
                taskStatus: nil, messages: rows, refreshed: refreshed, superseded: superseded,
                nextCursor: name, hasMore: false, activity: []
            ))
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/chat/status": [.success(status: 200, body: response)],
            ])

            _ = await model.refreshIdleConversation()
            if let newerError {
                XCTAssertEqual(model.errorMessage, newerError, name)
            } else if clearsNotice {
                XCTAssertNil(model.errorMessage, name)
            } else {
                XCTAssertEqual(model.errorMessage, "This task is marked complete, but its reply has not appeared yet.", name)
            }
            XCTAssertEqual(!recorder.entries.isEmpty, expectNotification, name)
            if name == "retracted" {
                XCTAssertFalse(model.messages.contains(where: { $0.id == exactReply.id }))
            }
            model.scenePhaseDidChange(.background)
        }
    }

    @MainActor
    func testLateTaskReplyFromReplacedConnectionCannotClearCurrentNotice() async throws {
        for (serverURL, newOwner) in [("https://candidate.test", notificationOwner), ("https://assistant.test", "new-notification-owner")] {
            let suite = "assistant.late-reply-connection-tests.\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            // This test replaces a connection, not the owner's notification
            // consent. Pairing must not wait for an OS permission dialog or
            // write a real Keychain token on an unattended test runner.
            defaults.set(true, forKey: "assistant.push-prompted")
            let model = AppModel(apiClient: makeClient(), defaults: defaults,
                                 storeConnectionToken: { _ in })
            model.scenePhaseDidChange(.background)
            StubURLProtocol.primeBootstrap(try notificationBootstrap())
            await model.refreshAll(reportFailure: false)
            XCTAssertNotNil(model.bootstrap)
            let taskId = "33333333-3333-4333-8333-333333333333"
            model.recordCompletedTaskWithoutReply(taskId: taskId)
            model.scenePhaseDidChange(.active)
            let staleReply = ChatMessage(
                id: "late-reply-from-old-connection",
                role: .assistant,
                parts: [.init(type: "text", text: "A delayed old-connection result.")],
                metadata: ["taskId": .string(taskId)]
            )
            let staleResponse = try JSONEncoder().encode(ChatUpdates(
                taskStatus: nil, messages: [staleReply], refreshed: [], superseded: nil,
                nextCursor: "old-connection", hasMore: false, activity: []
            ))
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/chat/status": [.held(status: 200, body: staleResponse)],
                "/api/mobile/v1/bootstrap": [.success(status: 200, body: try notificationBootstrap(owner: newOwner))],
                "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
            ])
            let oldReadFinished = expectation(description: "The held old-connection read finishes")
            let oldRead = Task {
                _ = await model.refreshIdleConversation()
                oldReadFinished.fulfill()
            }
            defer {
                StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat/status")
                oldRead.cancel()
                model.scenePhaseDidChange(.background)
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(2))
            while !StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat/status"),
                  ContinuousClock.now < deadline { await Task.yield() }
            XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat/status"))

            let pairingFinished = expectation(description: "The replacement connection is verified")
            var saved: Bool?
            let pairing = Task {
                saved = await model.saveConnection(serverURL: serverURL, token: "replacement-token")
                pairingFinished.fulfill()
            }
            defer { pairing.cancel() }
            await fulfillment(of: [pairingFinished], timeout: 5)
            XCTAssertEqual(saved, true)
            // The authenticated bootstrap replaces the old task notice,
            // while this deliberately rejected supplementary overview
            // publishes a new error for the replacement connection.
            let currentConnectionError = "The access key was not accepted by this Assistant server."
            XCTAssertEqual(model.errorMessage, currentConnectionError)
            StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat/status")
            await fulfillment(of: [oldReadFinished], timeout: 2)
            XCTAssertFalse(model.messages.contains(where: { $0.id == staleReply.id }))
            XCTAssertEqual(model.errorMessage, currentConnectionError,
                           "The old connection's reply must not clear the replacement connection's error")
            model.scenePhaseDidChange(.background)
        }
    }

    @MainActor
    func testDoneTaskUsesItsMatchingAssistantReply() async throws {
        let recorder = LocalNotificationRecorder()
        var spokenReplies: [ChatMessage] = []
        let model = try await notificationModel(
            enqueueAutomaticSpeech: { spokenReplies.append($0) },
            scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
                await recorder.schedule(
                    title: title,
                    body: body,
                    route: route,
                    approvalId: approvalId,
                    agentID: agentID,
                    conversationID: conversationID
                )
            }
        )
        model.speechAlwaysOn = true
        let taskId = "33333333-3333-4333-8333-333333333333"
        let reply = ChatMessage(
            id: "reply-for-current-task",
            role: .assistant,
            parts: [.init(type: "text", text: "The requested update is ready.")],
            metadata: ["taskId": .string(taskId)]
        )
        let doneWithReply = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "done", messages: [reply], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: []
        ))
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: taskId)],
            "/api/mobile/v1/chat/status": [.success(status: 200, body: doneWithReply)],
            "/api/mobile/v1/overview": [.success(status: 200, body: try overviewBody(pending: []))],
            "/api/mobile/v1/workspace": [.success(status: 401, body: Data())],
        ])

        model.send("Check the completed task")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while (recorder.entries.isEmpty || spokenReplies.isEmpty), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        let notification = try XCTUnwrap(recorder.entries.first)
        XCTAssertEqual(notification.title, "Ada finished")
        XCTAssertEqual(notification.body, "Your result is ready.")
        XCTAssertEqual(model.activityDetail, "Your result is ready")
        XCTAssertEqual(model.activityThought, .finished)
        XCTAssertEqual(spokenReplies.map(\.id), [reply.id])
        XCTAssertEqual(spokenReplies.first?.text, "The requested update is ready.")
    }

    @MainActor
    func testDoneTaskAcceptsARecognizedCardOnlyReply() async throws {
        let recorder = LocalNotificationRecorder()
        let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
            await recorder.schedule(
                title: title,
                body: body,
                route: route,
                approvalId: approvalId,
                agentID: agentID,
                conversationID: conversationID
            )
        })
        let taskId = "33333333-3333-4333-8333-333333333333"
        let cardOnlyReply = ChatMessage(
            id: "card-reply-for-current-task",
            role: .assistant,
            parts: [.init(type: "data-card", data: .object([
                "kind": .string("status"),
                "id": .string("status-current-task"),
                "title": .string("Task result"),
                "detail": .string("The result is available."),
            ]))],
            metadata: ["taskId": .string(taskId)]
        )
        let doneWithCard = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "done", messages: [cardOnlyReply], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: []
        ))
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: taskId)],
            "/api/mobile/v1/chat/status": [.success(status: 200, body: doneWithCard)],
            "/api/mobile/v1/overview": [.success(status: 200, body: try overviewBody(pending: []))],
            "/api/mobile/v1/workspace": [.success(status: 401, body: Data())],
        ])

        model.send("Check the completed task")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while recorder.entries.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        let notification = try XCTUnwrap(recorder.entries.first)
        XCTAssertEqual(notification.title, "Ada finished")
        XCTAssertEqual(notification.body, "Your result is ready.")
        XCTAssertEqual(model.activityThought, .finished)
        XCTAssertNotEqual(model.errorMessage, "This task is marked complete, but its reply has not appeared yet.")
    }

    @MainActor
    func testSupersededTaskReplyNoLongerQualifiesAsCurrentResult() async throws {
        let recorder = LocalNotificationRecorder()
        let notificationReady = expectation(description: "The settled task reports its retracted reply")
        let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
            let scheduled = await recorder.schedule(
                title: title,
                body: body,
                route: route,
                approvalId: approvalId,
                agentID: agentID,
                conversationID: conversationID
            )
            notificationReady.fulfill()
            return scheduled
        })
        let taskId = "33333333-3333-4333-8333-333333333333"
        let earlyReply = ChatMessage(
            id: "early-reply-retracted-before-done",
            role: .assistant,
            parts: [.init(type: "text", text: "An early result that is later retracted.")],
            metadata: ["taskId": .string(taskId)]
        )
        let running = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "running", messages: [earlyReply], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: []
        ))
        let retractedDone = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "done", messages: [], refreshed: [], superseded: [earlyReply.id],
            nextCursor: nil, hasMore: false, activity: []
        ))
        let doneWithoutReply = try JSONEncoder().encode(ChatUpdates(
            taskStatus: "done", messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: []
        ))
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: taskId)],
            "/api/mobile/v1/chat/status": [
                .success(status: 200, body: running),
                .success(status: 200, body: retractedDone),
                .success(status: 200, body: doneWithoutReply),
                .success(status: 200, body: doneWithoutReply),
                .success(status: 200, body: doneWithoutReply),
            ],
            "/api/mobile/v1/overview": [.success(status: 200, body: try overviewBody(pending: []))],
            "/api/mobile/v1/workspace": [.success(status: 401, body: Data())],
        ])

        model.send("Check the completed task")
        // Wake on the settled notification with headroom for simulator
        // scheduling and the production reply-grace polling.
        await fulfillment(of: [notificationReady], timeout: 15)

        let notification = try XCTUnwrap(recorder.entries.first)
        XCTAssertEqual(notification.title, "Task complete; reply not yet available")
        XCTAssertEqual(model.activityThought, .replyUnavailable)
        XCTAssertEqual(model.errorMessage, "This task is marked complete, but its reply has not appeared yet.")
        XCTAssertFalse(model.isSending)
        XCTAssertFalse(model.messages.contains(where: { $0.id == earlyReply.id }))
    }

    @MainActor
    func testUnknownTaskStatusDoesNotSendACompletionNotification() async throws {
        let recorder = LocalNotificationRecorder()
        let model = try await notificationModel(scheduleLocalNotification: { title, body, route, approvalId, agentID, conversationID in
            await recorder.schedule(
                title: title,
                body: body,
                route: route,
                approvalId: approvalId,
                agentID: agentID,
                conversationID: conversationID
            )
        })
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.stream(body: Data("data: [DONE]\n\n".utf8))],
            // A status GET is retried once, so five failed polls need ten
            // wire outcomes to reach the intended bounded unknown outcome.
            "/api/mobile/v1/chat/status": Array(repeating: .failure(URLError(.timedOut)), count: 10),
        ])

        model.send("Check the task status")
        defer { if model.isSending { model.cancelSend() } }
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while model.isSending, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertFalse(model.isSending)
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat/status" }.count, 10,
            "Each of five bounded status polls reaches both the original read and its single retry")
        XCTAssertTrue(model.errorMessage?.localizedCaseInsensitiveContains("outcome is unknown") == true)
        XCTAssertNotEqual(model.activityThought, .finished)
        XCTAssertTrue(recorder.entries.isEmpty, "An unknown outcome must not claim that the task result is ready")
    }

    @MainActor
    func testWaitingApprovalActivityCanBeCancelledThroughAppModelCommand() async throws {
        let model = try await notificationModel()
        let item = ActivityItem(
            id: "approval-task-stop-1", type: "chat_turn", status: "waiting_approval",
            title: "Review the transfer", progress: "Waiting for your approval.", trust: "owner",
            spentUsd: "0.01", budgetUsdLimit: "0.50", updatedAt: "2026-10-11T12:00:00Z",
            archivedAt: nil, hasPendingApproval: true
        )
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/activity/approval-task-stop-1": [
                .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            ],
        ])

        let updated = await model.updateActivity(item, action: "cancel")
        XCTAssertTrue(updated)
        let index = try XCTUnwrap(StubURLProtocol.urls.firstIndex(where: {
            $0.path == "/api/mobile/v1/activity/approval-task-stop-1"
        }))
        XCTAssertEqual(StubURLProtocol.attempts[index], "POST")
        let body = try XCTUnwrap(StubURLProtocol.bodies[index])
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["action": "cancel"])
    }

    @MainActor
    func testLateTaskCancellationResponseCannotClearNewerTurnOnSuccess() async throws {
        try await assertLateTaskCancellationDoesNotAffectNewerTurn(responseStatus: 200)
    }

    @MainActor
    func testLateTaskCancellationResponseCannotClearNewerTurnOnFailure() async throws {
        try await assertLateTaskCancellationDoesNotAffectNewerTurn(responseStatus: 503)
    }

    @MainActor
    private func assertLateTaskCancellationDoesNotAffectNewerTurn(responseStatus: Int) async throws {
        let model = try await notificationModel()
        let workingMessage = ChatMessage(id: "old-task-status-message", role: .assistant,
            parts: [.init(type: "text", text: "The earlier task is still working.")])
        let working = ChatUpdates(
            taskStatus: "working", messages: [workingMessage], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: []
        )
        let cancelled = ChatUpdates(
            taskStatus: "cancelled", messages: [workingMessage],
            refreshed: [], superseded: nil, nextCursor: nil, hasMore: false, activity: []
        )
        let workingBody = try JSONEncoder().encode(working)
        let terminalBody = try JSONEncoder().encode(cancelled)
        let cancelBody = responseStatus == 200 ? Data(#"{"ok":true}"#.utf8) : Data()
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [
                .taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: "task-old-stop"),
                .stream(body: Data()),
            ],
            "/api/mobile/v1/chat/status": [
                .delayed(after: 0.08, status: 200, body: workingBody),
                .success(status: 200, body: terminalBody),
                .success(status: 200, body: terminalBody),
                .success(status: 200, body: terminalBody),
                .success(status: 200, body: terminalBody),
            ],
            "/api/mobile/v1/activity/task-old-stop": [
                .held(status: responseStatus, body: cancelBody),
            ],
        ])
        defer { StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/activity/task-old-stop") }

        model.send("Earlier task")
        let receiptPollDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !StubURLProtocol.urls.contains(where: { url in
            guard url.path == "/api/mobile/v1/chat/status",
                  let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
            return queryItems.contains { $0.name == "taskId" && $0.value == "task-old-stop" }
        }), ContinuousClock.now < receiptPollDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.urls.contains(where: { url in
            guard url.path == "/api/mobile/v1/chat/status",
                  let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
            return queryItems.contains { $0.name == "taskId" && $0.value == "task-old-stop" }
        }), "The durable task receipt is parsed before issuing Stop")
        let workingStatusDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !model.messages.contains(where: { $0.id == "old-task-status-message" }),
              ContinuousClock.now < workingStatusDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(model.messages.contains(where: { $0.id == "old-task-status-message" }),
            "Stop starts only after the task receipt and initial working status are observed")

        model.cancelSend()
        let cancelDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/activity/task-old-stop"),
              ContinuousClock.now < cancelDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/activity/task-old-stop"))

        let terminalDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while model.isSending, ContinuousClock.now < terminalDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.isSending, "Four matching cancelled statuses settle only the earlier task")
        XCTAssertGreaterThanOrEqual(
            StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat/status" }.count, 5
        )

        model.send("Newer task")
        let newerSendDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while StubURLProtocol.urls.filter({ $0.path == "/api/mobile/v1/chat" }).count < 2,
              ContinuousClock.now < newerSendDeadline {
            if !model.isSending { model.send("Newer task") }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 2)
        XCTAssertTrue(model.isSending)
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/activity/task-old-stop"),
            "The prior task cancellation response is still unreleased as the new turn begins")

        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/activity/task-old-stop")
        let responseDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.completedResponsePaths.contains("/api/mobile/v1/activity/task-old-stop"),
              ContinuousClock.now < responseDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(StubURLProtocol.completedResponsePaths.contains("/api/mobile/v1/activity/task-old-stop"))

        XCTAssertTrue(model.isSending, "A late success or failure for the old task cannot settle the newer turn")
        XCTAssertNil(model.errorMessage, "A late failure for the old task cannot replace newer-turn state")
        XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Newer task" }))
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/activity/task-old-stop" }.count, 1)
        let sends = StubURLProtocol.bodies.enumerated().compactMap { index, body -> [String: Any]? in
            guard StubURLProtocol.urls[index].path == "/api/mobile/v1/chat" else { return nil }
            return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        }
        XCTAssertEqual(sends.count, 2)
        XCTAssertNotEqual(sends[0]["clientOperationId"] as? String, sends[1]["clientOperationId"] as? String)
        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8))
    }

    @MainActor
    func testComposerKeepsSendSeparateFromStopWhenDraftExists() {
        let activeWithDraft = ChatComposerActionPolicy.resolve(
            hasDraft: true, canSend: false, isSending: true,
            canCancel: true, isCancelling: false, formAdmissionPending: false,
            hasUnresolvedTurn: true
        )
        XCTAssertEqual(activeWithDraft.primary, .send(enabled: false))
        XCTAssertTrue(activeWithDraft.showsSeparateStop)
        XCTAssertTrue(activeWithDraft.separateStopEnabled)
        XCTAssertEqual(
            ChatComposerActionPolicy.followUpDraftNotice(
                hasDraft: true, isSending: true, canCancel: true, isCancelling: false,
                formAdmissionPending: false, hasUnresolvedTurn: true
            ),
            "Your draft stays here. Send it after this turn finishes."
        )

        let stoppingWithDraft = ChatComposerActionPolicy.resolve(
            hasDraft: true, canSend: false, isSending: true,
            canCancel: true, isCancelling: true, formAdmissionPending: false,
            hasUnresolvedTurn: true
        )
        XCTAssertEqual(stoppingWithDraft.primary, .send(enabled: false))
        XCTAssertTrue(stoppingWithDraft.showsSeparateStop)
        XCTAssertFalse(stoppingWithDraft.separateStopEnabled)
        XCTAssertEqual(
            ChatComposerActionPolicy.followUpDraftNotice(
                hasDraft: true, isSending: true, canCancel: true, isCancelling: true,
                formAdmissionPending: false, hasUnresolvedTurn: true
            ),
            "Your draft stays here. Wait for the stop result before sending."
        )

        let activeWithoutDraft = ChatComposerActionPolicy.resolve(
            hasDraft: false, canSend: false, isSending: true,
            canCancel: true, isCancelling: false, formAdmissionPending: false,
            hasUnresolvedTurn: true
        )
        XCTAssertEqual(activeWithoutDraft.primary, .stop)
        XCTAssertFalse(activeWithoutDraft.showsSeparateStop)

        let readyWithDraft = ChatComposerActionPolicy.resolve(
            hasDraft: true, canSend: true, isSending: false,
            canCancel: false, isCancelling: false, formAdmissionPending: false,
            hasUnresolvedTurn: false
        )
        XCTAssertEqual(readyWithDraft.primary, .send(enabled: true))
        XCTAssertFalse(readyWithDraft.showsSeparateStop)
        XCTAssertNil(
            ChatComposerActionPolicy.followUpDraftNotice(
                hasDraft: true, isSending: false, canCancel: false, isCancelling: false,
                formAdmissionPending: false, hasUnresolvedTurn: false
            )
        )

        // A task can remain unresolved after its active-send flag clears, for
        // example while its durable status is being reconciled after reconnect.
        let resumedUnknownWithDraft = ChatComposerActionPolicy.resolve(
            hasDraft: true, canSend: true, isSending: false,
            canCancel: false, isCancelling: false, formAdmissionPending: false,
            hasUnresolvedTurn: true
        )
        XCTAssertEqual(resumedUnknownWithDraft.primary, .send(enabled: false))
        XCTAssertFalse(resumedUnknownWithDraft.showsSeparateStop)
        XCTAssertEqual(
            ChatComposerActionPolicy.followUpDraftNotice(
                hasDraft: true, isSending: false, canCancel: false, isCancelling: false,
                formAdmissionPending: false, hasUnresolvedTurn: true
            ),
            "Your draft stays here. Check the earlier turn before sending."
        )

        // Form admission owns its frozen operation. Even a transiently stale
        // can-cancel flag must not show a Stop control that AppModel will reject.
        let emptyDraftDuringFormAdmission = ChatComposerActionPolicy.resolve(
            hasDraft: false, canSend: false, isSending: true,
            canCancel: true, isCancelling: false, formAdmissionPending: true,
            hasUnresolvedTurn: true
        )
        XCTAssertEqual(emptyDraftDuringFormAdmission.primary, .waiting)
        XCTAssertFalse(emptyDraftDuringFormAdmission.showsSeparateStop)

        let draftDuringFormAdmission = ChatComposerActionPolicy.resolve(
            hasDraft: true, canSend: false, isSending: true,
            canCancel: true, isCancelling: false, formAdmissionPending: true,
            hasUnresolvedTurn: true
        )
        XCTAssertEqual(draftDuringFormAdmission.primary, .send(enabled: false))
        XCTAssertFalse(draftDuringFormAdmission.showsSeparateStop)
        XCTAssertEqual(
            ChatComposerActionPolicy.followUpDraftNotice(
                hasDraft: true, isSending: true, canCancel: true, isCancelling: false,
                formAdmissionPending: true, hasUnresolvedTurn: true
            ),
            "Your draft stays here. The form request is still being sent."
        )
    }

    @MainActor
    func testRetainedFollowUpDraftSurvivesDelayedTerminalTurnAndCanThenSend() async throws {
        // Draft admission does not depend on the simulator's notification
        // service accepting a real notification before the turn can settle.
        let model = try await notificationModel(scheduleLocalNotification: { _, _, _, _, _, _ in true })
        let scope = try XCTUnwrap(model.composerDraftScope)
        let firstTaskId = "33333333-3333-4333-8333-333333333333"
        let secondTaskId = "44444444-4444-4444-8444-444444444444"
        func updates(status: String, reply: String?, cursor: String) throws -> Data {
            let messages = reply.map { [ChatMessage(id: "reply-\(cursor)", role: .assistant,
                parts: [.init(type: "text", text: $0)], metadata: ["taskId": .string(cursor == "first-done" ? firstTaskId : secondTaskId)])] } ?? []
            return try JSONEncoder().encode(ChatUpdates(
                taskStatus: status, messages: messages, refreshed: [], superseded: nil,
                nextCursor: cursor, hasMore: false, activity: []
            ))
        }
        let firstReply = "The first answer is complete."
        let followUp = "Now compare the return options."
        let workspaceUnavailable = StubURLProtocol.Outcome.success(status: 401, body: Data())
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [
                .taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: firstTaskId),
                .taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: secondTaskId),
            ],
            "/api/mobile/v1/chat/status": [
                .success(status: 200, body: try updates(status: "working", reply: nil, cursor: "working")),
                .held(status: 200, body: try updates(status: "done", reply: firstReply, cursor: "first-done")),
                .success(status: 200, body: try updates(status: "done", reply: "The comparison is ready.", cursor: "second-done")),
            ],
            "/api/mobile/v1/overview": [
                .success(status: 200, body: try overviewBody(pending: [])),
                .success(status: 200, body: try overviewBody(pending: [])),
            ],
            "/api/mobile/v1/workspace": [workspaceUnavailable, workspaceUnavailable],
        ])
        defer { StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat/status") }

        model.saveComposerDraft("", in: scope)
        model.send("Find return flight options")
        let firstStatusDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while StubURLProtocol.urls.filter({ $0.path == "/api/mobile/v1/chat/status" }).count < 1,
              ContinuousClock.now < firstStatusDeadline {
            await Task.yield()
        }
        XCTAssertTrue(model.isSending)

        model.saveComposerDraft(followUp, in: scope)
        XCTAssertEqual(model.composerDraft(in: scope), followUp)
        model.send(followUp)
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 1,
            "AppModel cannot admit the retained draft while the earlier task is active")

        let heldTerminalDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat/status"),
              ContinuousClock.now < heldTerminalDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat/status"),
            "The terminal status response is held until the pending-state assertions complete")
        XCTAssertTrue(model.isSending, "The unresolved turn stays active while its terminal response is held")
        XCTAssertTrue(model.hasUnresolvedTurn)
        XCTAssertEqual(model.composerDraft(in: scope), followUp,
            "Polling and the held terminal response cannot consume the second draft")
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 1,
            "The retained draft cannot start a second task while the first terminal response is held")

        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat/status")

        let firstSettlementDeadline = ContinuousClock.now.advanced(by: .seconds(8))
        while model.hasUnresolvedTurn, ContinuousClock.now < firstSettlementDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(model.hasUnresolvedTurn)
        XCTAssertEqual(model.composerDraft(in: scope), followUp)
        XCTAssertTrue(model.messages.contains(where: { $0.role == .assistant && $0.text == firstReply }))
        XCTAssertEqual(model.messages.filter { $0.role == .user && $0.text == "Find return flight options" }.count, 1)

        model.saveComposerDraft("", in: scope)
        model.send(followUp)
        let secondSendDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while StubURLProtocol.urls.filter({ $0.path == "/api/mobile/v1/chat" }).count < 2,
              ContinuousClock.now < secondSendDeadline {
            await Task.yield()
        }
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 2,
            "The same follow-up becomes admissible once the first task reaches a terminal status")
        let sentBodies = try StubURLProtocol.urls.enumerated().compactMap { index, url -> [String: Any]? in
            guard url.path == "/api/mobile/v1/chat" else { return nil }
            return try JSONSerialization.jsonObject(with: StubURLProtocol.bodies[index]) as? [String: Any]
        }
        let sentTexts = sentBodies.compactMap { body -> String? in
            let messages = body["messages"] as? [[String: Any]]
            let parts = messages?.first?["parts"] as? [[String: Any]]
            return parts?.first?["text"] as? String
        }
        XCTAssertEqual(sentTexts, ["Find return flight options", followUp])

        let secondSettlementDeadline = ContinuousClock.now.advanced(by: .seconds(8))
        while model.hasUnresolvedTurn, ContinuousClock.now < secondSettlementDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(model.hasUnresolvedTurn)
        XCTAssertTrue(model.messages.contains(where: { $0.role == .assistant && $0.text == "The comparison is ready." }))
        XCTAssertEqual(model.messages.filter { $0.role == .user && $0.text == followUp }.count, 1)
    }

    @MainActor
    func testStopBeforeTaskReceiptCancelsExactOperationAndIgnoresLateStream() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.stream(body: Data())],
            "/api/mobile/v1/chat/cancel": [.operationCancellation(status: 200, outcome: "cancelled_before_admission")],
        ])
        model.send("A request whose receipt is delayed")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }) { await Task.yield() }
        let sendBody = try XCTUnwrap(StubURLProtocol.bodies.first)
        let send = try XCTUnwrap(JSONSerialization.jsonObject(with: sendBody) as? [String: Any])
        let operationId = try XCTUnwrap(send["clientOperationId"] as? String)
        let conversationId = try XCTUnwrap(send["conversationId"] as? String)
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Follow up about the return flight", in: scope)

        model.cancelSend()
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat/cancel" }) { await Task.yield() }
        let cancelIndex = try XCTUnwrap(StubURLProtocol.urls.firstIndex(where: { $0.path == "/api/mobile/v1/chat/cancel" }))
        let cancel = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies[cancelIndex]) as? [String: String])
        XCTAssertEqual(cancel["conversationId"], conversationId)
        XCTAssertEqual(cancel["clientOperationId"], operationId)

        let settlementDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.isSending, ContinuousClock.now < settlementDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.isSending)
        XCTAssertFalse(model.messages.contains(where: { $0.role == .user && $0.text == "A request whose receipt is delayed" }))
        XCTAssertEqual(model.restoreFailedDraft(), "A request whose receipt is delayed")
        XCTAssertEqual(model.composerDraft(in: scope), "Follow up about the return flight")
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 1)
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat/cancel" }.count, 1)

        let late = try JSONSerialization.data(withJSONObject: ["type": "text-delta", "delta": "late response must be ignored"])
        StubURLProtocol.appendStream(Data("data: \(String(decoding: late, as: UTF8.self))\n\n".utf8))
        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(model.messages.contains(where: { $0.text.contains("late response must be ignored") }))
    }

    @MainActor
    func testTerminalOperationCancellationUnblocksHeldStreamAndFencesLateCallback() async throws {
        let model = try await notificationModel()
        let cancelledTaskId = "33333333-3333-4333-8333-333333333333"
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [
                .stream(body: Data()),
                .stream(body: Data()),
            ],
            "/api/mobile/v1/chat/cancel": [
                .terminalOperationCancellation(status: 200, outcome: "cancelled",
                    taskId: cancelledTaskId, taskStatus: "cancelled", transitioned: true),
            ],
        ])

        model.send("Older turn with a held stream")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }) { await Task.yield() }
        let firstSend = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies[0]) as? [String: Any])
        let firstOperationId = try XCTUnwrap(firstSend["clientOperationId"] as? String)

        model.cancelSend()
        let cancelDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat/cancel" }),
              ContinuousClock.now < cancelDeadline { await Task.yield() }
        let settleDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while model.isSending, ContinuousClock.now < settleDeadline { try await Task.sleep(for: .milliseconds(10)) }

        XCTAssertFalse(model.isSending, "A terminal cancellation receipt settles without waiting for the SSE stream to close")
        XCTAssertFalse(model.isCancellingSend)
        XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Older turn with a held stream" }))
        XCTAssertTrue(model.errorMessage?.contains("external action already started") == true)

        model.send("Newer turn")
        let secondSendDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while StubURLProtocol.urls.filter({ $0.path == "/api/mobile/v1/chat" }).count < 2,
              ContinuousClock.now < secondSendDeadline { await Task.yield() }
        XCTAssertTrue(model.isSending)
        XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Newer turn" }))
        let secondChatIndex = try XCTUnwrap(StubURLProtocol.urls.indices.first(where: {
            StubURLProtocol.urls[$0].path == "/api/mobile/v1/chat" && $0 > 0
        }))
        let secondSend = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies[secondChatIndex]) as? [String: Any])
        XCTAssertNotEqual(firstOperationId, secondSend["clientOperationId"] as? String)

        let lateDelta = try JSONSerialization.data(withJSONObject: [
            "type": "text-delta", "delta": "late output from the cancelled operation",
        ])
        StubURLProtocol.appendStream(
            Data("data: \(String(decoding: lateDelta, as: UTF8.self))\n\n".utf8),
            operationId: firstOperationId
        )
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(model.isSending, "The old stream callback cannot settle the newer operation")
        XCTAssertFalse(model.messages.contains(where: { $0.text.contains("late output from the cancelled operation") }))
        XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Newer turn" }))
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat/cancel" }.count, 1,
                       "A terminal receipt must not trigger duplicate polling or cancellation")
        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8), operationId: try XCTUnwrap(secondSend["clientOperationId"] as? String))
    }

    func testChatOperationKeepsTheExactFrozenRequestBytes() async throws {
        let testToken = "frozen-chat-request-test"
        let client = makeClient(clientID: "33333333-3333-4333-8333-333333333333", token: testToken)
        let conversationId = "11111111-1111-4111-8111-111111111111"
        let operationId = "22222222-2222-4222-8222-222222222222"
        let body = try client.encodeChatRequest(
            conversationId: conversationId,
            text: "Do not rebuild this payload after an unknown result",
            clientOperationId: operationId,
            autonomous: false,
            force: false,
            spoken: false,
            clientMessageId: "44444444-4444-4444-8444-444444444444"
        )
        StubURLProtocol.prime([], tokens: ["Bearer \(testToken)": [.stream(body: Data())]])
        let send = Task {
            try await client.sendMessage(
                conversationId: conversationId,
                text: "Do not rebuild this payload after an unknown result",
                clientOperationId: operationId,
                autonomous: false,
                encodedRequestBody: body,
                onDelta: { _ in },
                onCue: { _ in }
            )
        }
        let authorization = "Bearer \(testToken)"
        let streamDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isStreamReady(operationId: operationId, authorization: authorization),
              ContinuousClock.now < streamDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard StubURLProtocol.isStreamReady(operationId: operationId, authorization: authorization) else {
            send.cancel()
            StubURLProtocol.cancelStream(operationId: operationId, authorization: authorization)
            _ = try? await send.value
            XCTFail("The exact operation stream did not become ready")
            return
        }
        let chatRequests = StubURLProtocol.requests.filter {
            $0.1.path == "/api/mobile/v1/chat"
                && $0.2.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value == "Bearer \(testToken)"
        }
        XCTAssertEqual(chatRequests.count, 1, "This frozen operation is sent once")
        XCTAssertEqual(chatRequests.first?.3, body)
        StubURLProtocol.appendStream(
            Data("data: [DONE]\n\n".utf8), operationId: operationId, authorization: authorization
        )
        let receipt = try await send.value
        XCTAssertNil(receipt.taskId)
    }

    func testOperationCancellationValidatesIdentityAndTreatsUnknownAsUnknown() async throws {
        let conversationId = "11111111-1111-4111-8111-111111111111"
        let operationId = "22222222-2222-4222-8222-222222222222"
        let receipt = #"{"ok":false,"outcome":"unknown","conversationId":"11111111-1111-4111-8111-111111111111","clientOperationId":"22222222-2222-4222-8222-222222222222","taskId":null,"effectStatus":"unknown","code":"cancellation_unconfirmed"}"#
        StubURLProtocol.prime([], paths: ["/api/mobile/v1/chat/cancel": [.success(status: 503, body: Data(receipt.utf8))]])
        let result = try await makeClient().cancelChatOperation(conversationId: conversationId, clientOperationId: operationId)
        XCTAssertEqual(result.outcome, .unknown)
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/chat/cancel")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(StubURLProtocol.bodies.first)) as? [String: String])
        XCTAssertEqual(payload, ["conversationId": conversationId, "clientOperationId": operationId])
    }

    func testOperationCancellationRejectsContradictoryTaskStatus() async throws {
        let response = #"{"ok":true,"outcome":"cancelled","conversationId":"11111111-1111-4111-8111-111111111111","clientOperationId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","taskStatus":"done","transitioned":true,"effectStatus":"unknown"}"#
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat/cancel": [.success(status: 200, body: Data(response.utf8))],
        ])
        do {
            _ = try await makeClient().cancelChatOperation(
                conversationId: "11111111-1111-4111-8111-111111111111",
                clientOperationId: "22222222-2222-4222-8222-222222222222"
            )
            XCTFail("A cancelled outcome must carry the matching cancelled task status")
        } catch APIError.invalidResponse {
            // Expected: contradictory terminal fields cannot settle an operation.
        }
    }

    func testOperationCancellationAcceptsOnlyKnownTerminalStatusPairs() async throws {
        let cases = [
            ("cancelled", "cancelled"),
            ("already_cancelled", "cancelled"),
            ("already_terminal", "done"),
            ("already_terminal", "failed"),
        ]
        for (outcome, taskStatus) in cases {
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/chat/cancel": [
                    .terminalOperationCancellation(status: 200, outcome: outcome,
                        taskId: "33333333-3333-4333-8333-333333333333", taskStatus: taskStatus,
                        transitioned: outcome == "cancelled"),
                ],
            ])
            let receipt = try await makeClient().cancelChatOperation(
                conversationId: "11111111-1111-4111-8111-111111111111",
                clientOperationId: "22222222-2222-4222-8222-222222222222"
            )
            XCTAssertEqual(receipt.outcome.rawValue, outcome)
            XCTAssertEqual(receipt.taskStatus, taskStatus)
            XCTAssertEqual(receipt.transitioned, outcome == "cancelled")
        }
    }

    func testOperationCancellationRejectsMissingOrContradictoryTransitionFlags() async throws {
        let cases: [(String, String, Bool?)] = [
            ("cancelled", "cancelled", nil),
            ("cancelled", "cancelled", false),
            ("already_cancelled", "cancelled", true),
            ("already_terminal", "done", true),
        ]
        for (outcome, taskStatus, transitioned) in cases {
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/chat/cancel": [
                    .terminalOperationCancellation(status: 200, outcome: outcome,
                        taskId: "33333333-3333-4333-8333-333333333333", taskStatus: taskStatus,
                        transitioned: transitioned),
                ],
            ])
            do {
                _ = try await makeClient().cancelChatOperation(
                    conversationId: "11111111-1111-4111-8111-111111111111",
                    clientOperationId: "22222222-2222-4222-8222-222222222222"
                )
                XCTFail("Contradictory or missing transition state must leave the cancellation unconfirmed")
            } catch APIError.invalidResponse {
                // Expected: status and transition must describe the same server result.
            }
        }
    }

    func testPreAdmissionCancellationAcceptsEitherTransitionValueForReplay() async throws {
        for transitioned in [false, true] {
            let body = try JSONSerialization.data(withJSONObject: [
                "ok": true,
                "outcome": "cancelled_before_admission",
                "conversationId": "11111111-1111-4111-8111-111111111111",
                "clientOperationId": "22222222-2222-4222-8222-222222222222",
                "taskId": NSNull(),
                "transitioned": transitioned,
                "effectStatus": "not_started",
            ] as [String: Any])
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/chat/cancel": [.success(status: 200, body: body)],
            ])
            let receipt = try await makeClient().cancelChatOperation(
                conversationId: "11111111-1111-4111-8111-111111111111",
                clientOperationId: "22222222-2222-4222-8222-222222222222"
            )
            XCTAssertEqual(receipt.outcome, .cancelledBeforeAdmission)
            XCTAssertEqual(receipt.transitioned, transitioned)
        }
    }

    @MainActor
    func testLateOperationCancellationCannotClearANewerSameConversationTurn() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [
                .delayedChatCancelledBeforeAdmission(after: 0.18),
                .stream(body: Data()),
            ],
            "/api/mobile/v1/chat/cancel": [
                .delayedOperationCancellation(after: 0.75, status: 200, outcome: "cancelled_before_admission"),
            ],
        ])
        model.send("Older operation")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }) { await Task.yield() }
        model.cancelSend()
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat/cancel" }) { await Task.yield() }

        let oldSettlementDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.isSending, ContinuousClock.now < oldSettlementDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.isSending, "The chat POST's exact cancellation-before-admission receipt settles only the older turn")
        model.send("Newer operation")
        let secondSendDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while StubURLProtocol.urls.filter({ $0.path == "/api/mobile/v1/chat" }).count < 2,
              ContinuousClock.now < secondSendDeadline { await Task.yield() }
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 2)

        try await Task.sleep(for: .milliseconds(850))
        XCTAssertTrue(model.isSending, "The delayed cancellation receipt for the old token cannot settle the newer turn")
        XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Newer operation" }))
        let sends = StubURLProtocol.bodies.enumerated().compactMap { index, body -> [String: Any]? in
            guard StubURLProtocol.urls[index].path == "/api/mobile/v1/chat" else { return nil }
            return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        }
        XCTAssertEqual(sends.count, 2)
        XCTAssertNotEqual(sends[0]["clientOperationId"] as? String, sends[1]["clientOperationId"] as? String)
        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8))
    }

    func testOperationCancellationRejectsAReceiptForAnotherScope() async throws {
        let response = #"{"ok":true,"outcome":"cancelled_before_admission","conversationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","clientOperationId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","taskId":null,"effectStatus":"not_started"}"#
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat/cancel": [.success(status: 200, body: Data(response.utf8))],
        ])
        do {
            _ = try await makeClient().cancelChatOperation(
                conversationId: "11111111-1111-4111-8111-111111111111",
                clientOperationId: "22222222-2222-4222-8222-222222222222"
            )
            XCTFail("A receipt for another chat operation must never settle this one")
        } catch APIError.invalidResponse {
            // Expected: the identity echo is part of the cancellation receipt.
        }
    }

    @MainActor
    func testUnknownOperationCancellationKeepsTheSameTurnFence() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.stream(body: Data())],
            "/api/mobile/v1/chat/cancel": [.operationCancellation(status: 503, outcome: "unknown")],
        ])
        model.send("Keep this operation fenced")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }) { await Task.yield() }
        model.cancelSend()
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat/cancel" }) { await Task.yield() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.isCancellingSend, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.isCancellingSend)
        XCTAssertTrue(model.isSending)
        XCTAssertTrue(model.errorMessage?.localizedCaseInsensitiveContains("outcome is unknown") == true)

        model.send("This must not create a second operation")
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 1)
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat/cancel" }.count, 1)
        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8))
    }

    @MainActor
    func testAutomaticSpeechWaitsForDurableApprovalClassification() async throws {
        var spoken: [[String]] = []
        let model = try await notificationModel { message in
            spoken.append(SpeakableText.passages(for: message))
        }
        model.speechAlwaysOn = true
        let approvalReply = ChatMessage(id: "durable-approval-reply", role: .assistant, parts: [
            .init(type: "text", text: "Transfer code 918273 to Acme now."),
            .init(type: "approval", approvalId: "approval-1", status: "pending"),
        ])
        let updates = ChatUpdates(taskStatus: nil, messages: [approvalReply], refreshed: [], superseded: nil,
            nextCursor: "cursor-approval", hasMore: false, activity: [])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.stream(body: Data())],
            "/api/mobile/v1/chat/status": [.success(status: 200, body: try JSONEncoder().encode(updates))],
        ])
        model.send("Review this transfer")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }) { await Task.yield() }
        let delta = try JSONSerialization.data(withJSONObject: [
            "type": "text-delta", "delta": "Transfer code 918273 to Acme now.",
        ])
        StubURLProtocol.appendStream(Data("data: \(String(decoding: delta, as: UTF8.self))\n\n".utf8))
        let streamDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !model.messages.contains(where: { $0.text.contains("918273") }), ContinuousClock.now < streamDeadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(spoken.isEmpty, "Streaming text must wait for the durable response's privacy classification")

        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8))
        let speechDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while spoken.isEmpty, ContinuousClock.now < speechDeadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(spoken, [["A decision is waiting for you."]])
        XCTAssertFalse(spoken.flatMap { $0 }.joined().contains("918273"))
    }

    @MainActor
    func testTurningLocationSharingOffDuringCapturePreventsTransmission() async throws {
        let suite = "assistant.location-consent-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: AppModel.shareLocationKey)
        var capture: CheckedContinuation<(location: CLLocation, label: String)?, Never>?
        let model = AppModel(apiClient: makeClient(), defaults: defaults, captureCurrentPlace: {
            await withCheckedContinuation { capture = $0 }
        })
        StubURLProtocol.prime([])
        let sharing = Task { await model.shareLocationIfEnabled(force: true) }
        while capture == nil { await Task.yield() }

        defaults.set(false, forKey: AppModel.shareLocationKey)
        model.locationSharingPreferenceChanged(enabled: false)
        capture?.resume(returning: (
            CLLocation(latitude: 37.7749, longitude: -122.4194),
            "San Francisco"
        ))
        await sharing.value

        XCTAssertTrue(StubURLProtocol.attempts.isEmpty)
    }

    func testOverlappingNotificationTurnCleanupKeepsTheNewerTurnGuarded() {
        var settlements = NotificationTurnSettlements()
        let cancelledTurn = settlements.begin()
        let completedNewerTurn = settlements.begin()
        settlements.finish(cancelledTurn)
        XCTAssertTrue(settlements.isSettling, "An older cancellation cannot release a newer turn's settlement")
        settlements.finish(cancelledTurn)
        XCTAssertTrue(settlements.isSettling, "Repeated older cleanup cannot release another token")
        settlements.finish(completedNewerTurn)
        XCTAssertFalse(settlements.isSettling)
    }

    @MainActor
    func testColdLaunchNotificationWaitsForBootstrapAndOpensItsAuthenticatedConversation() async throws {
        let model = AppModel(apiClient: makeClient())
        model.scenePhaseDidChange(.background)
        StubURLProtocol.prime([])
        await model.openNotificationDestination(try notificationDestination(conversation: notificationSideID, owner: notificationOwner))
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty, "No unverified destination is fetched before owner bootstrap")
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/bootstrap": [.delayed(after: 0.04, status: 200, body: try notificationBootstrap())],
            "/api/mobile/v1/chats/\(notificationSideID)": [.success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID)))],
            "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
        ])
        await model.refreshAll(reportFailure: false)
        XCTAssertEqual(model.conversationId, notificationSideID)
        let paths = StubURLProtocol.urls.map(\.path)
        XCTAssertEqual(paths.count, 3)
        XCTAssertEqual(Set(paths.prefix(2)), ["/api/mobile/v1/bootstrap", "/api/mobile/v1/overview"],
            "Both startup reads leave together; navigation still waits for authenticated bootstrap")
        XCTAssertEqual(paths.last, "/api/mobile/v1/chats/\(notificationSideID)")
    }

    @MainActor
    func testLegacyChatNotificationReturnsToMainConversationFromASideChat() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID)))])
        let opened = await model.openConversation(id: notificationSideID)
        XCTAssertTrue(opened)
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationPrimaryID)))])
        await model.openNotificationDestination(try notificationDestination())
        XCTAssertEqual(model.conversationId, notificationPrimaryID)
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/chats/\(notificationPrimaryID)")
    }

    @MainActor
    func testNotificationFromAnotherOwnerDoesNotFetchOrNavigate() async throws {
        let model = try await notificationModel()
        model.present(.settings)
        StubURLProtocol.prime([])
        await model.openNotificationDestination(try notificationDestination(conversation: notificationSideID, owner: "foreign-owner"))
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty)
        XCTAssertEqual(model.presentedRoute, .settings)
        XCTAssertEqual(model.conversationId, notificationPrimaryID)
    }

    @MainActor
    func testMissingForeignAndMismatchedNotificationConversationFallsBackToAuthenticatedMainThread() async throws {
        for response in [
            StubURLProtocol.Outcome.success(status: 404, body: Data(#"{"error":"Conversation not found"}"#.utf8)),
            .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationOtherID))),
        ] {
            let model = try await notificationModel()
            StubURLProtocol.prime([response])
            await model.openNotificationDestination(try notificationDestination(conversation: notificationSideID, owner: notificationOwner))
            XCTAssertEqual(model.conversationId, notificationPrimaryID)
            XCTAssertEqual(model.errorMessage, "Couldn’t open that conversation. Showing your main conversation.")
            XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/chats/\(notificationSideID)")
        }
    }

    @MainActor
    func testNewerNotificationWinsOverASlowEarlierDestination() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([
            .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
            .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationOtherID))),
        ])
        let first = try notificationDestination(conversation: notificationSideID, owner: notificationOwner)
        let earlier = Task { await model.openNotificationDestination(first) }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        await model.openNotificationDestination(try notificationDestination(conversation: notificationOtherID, owner: notificationOwner))
        await earlier.value
        XCTAssertEqual(model.conversationId, notificationOtherID)
        XCTAssertEqual(StubURLProtocol.urls.map(\.path), ["/api/mobile/v1/chats/\(notificationSideID)", "/api/mobile/v1/chats/\(notificationOtherID)"])
    }

    @MainActor
    func testExplicitChatSelectionWinsOverASlowNotification() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([
            .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
            .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationOtherID))),
        ])
        let destination = try notificationDestination(conversation: notificationSideID, owner: notificationOwner)
        let opening = Task { await model.openNotificationDestination(destination) }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        let opened = await model.openConversation(id: notificationOtherID)
        XCTAssertTrue(opened)
        await opening.value
        XCTAssertEqual(model.conversationId, notificationOtherID)
    }

    @MainActor
    func testManualPageAndBackNavigationWinOverASlowNotification() async throws {
        for returnToChat in [false, true] {
            let model = try await notificationModel()
            model.present(.activity)
            StubURLProtocol.prime([
                .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
            ])
            let destination = try notificationDestination(conversation: notificationSideID, owner: notificationOwner)
            let opening = Task { await model.openNotificationDestination(destination) }
            while StubURLProtocol.attempts.isEmpty { await Task.yield() }
            if returnToChat {
                model.navigationPath.removeLast()
            } else {
                model.present(.settings)
            }
            await opening.value
            XCTAssertEqual(model.conversationId, notificationPrimaryID, "A delayed notice cannot change the owner's current thread")
            XCTAssertEqual(model.presentedRoute, returnToChat ? nil : .settings)
        }
    }

    @MainActor
    func testOldIdleReplyCannotMergeRowsOrCursorIntoANotificationConversation() async throws {
        let model = try await notificationModel()
        model.scenePhaseDidChange(.active)
        defer { model.scenePhaseDidChange(.background) }
        let oldReply = ChatMessage(id: "old-thread-reply", role: .assistant,
            parts: [.init(type: "text", text: "This belongs to the old thread")])
        let updates = ChatUpdates(taskStatus: nil, messages: [oldReply], refreshed: [], superseded: nil,
            nextCursor: "old-thread-cursor", hasMore: false, activity: [])
        // Foreground calendar sync runs independently of this held chat read.
        // Keep response bodies and the start barrier tied to their endpoints.
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat/status": [
                .held(status: 200, body: try JSONEncoder().encode(updates))
            ],
            "/api/mobile/v1/chats/\(notificationSideID)": [
                .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID)))
            ],
        ])
        // This separate task deliberately remains uncancelled. The result
        // fence must protect a changed thread even if cancellation loses.
        let heldRead = Task { await model.refreshIdleConversation() }
        let heldDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat/status"), ContinuousClock.now < heldDeadline {
            await Task.yield()
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat/status"))
        await model.openNotificationDestination(try notificationDestination(conversation: notificationSideID, owner: notificationOwner))
        StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat/status")
        let changed = await heldRead.value
        XCTAssertNil(changed)
        XCTAssertEqual(model.conversationId, notificationSideID)
        XCTAssertFalse(model.messages.contains(where: { $0.id == oldReply.id }))

        let quiet = ChatUpdates(taskStatus: nil, messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: [])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat/status": [.success(status: 200, body: try JSONEncoder().encode(quiet))]
        ])
        let currentChanged = await model.refreshIdleConversation()
        XCTAssertEqual(currentChanged, false)
        let statusURL = try XCTUnwrap(StubURLProtocol.urls.first(where: { $0.path == "/api/mobile/v1/chat/status" }))
        let components = try XCTUnwrap(URLComponents(url: statusURL, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "conversationId" })?.value, notificationSideID)
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "cursor" }), "An old poll cannot replace the new thread's cursor")
    }

    @MainActor
    func testSlowManualConversationCannotReplaceANewerNoticePageOrBackAction() async throws {
        for newerAction in ["notice", "page", "back"] {
            let model = try await notificationModel()
            model.present(.activity)
            StubURLProtocol.prime([
                .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
                .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationOtherID))),
            ])
            let manualOpen = Task { await model.openConversation(id: notificationSideID) }
            while StubURLProtocol.attempts.isEmpty { await Task.yield() }
            switch newerAction {
            case "notice":
                await model.openNotificationDestination(try notificationDestination(conversation: notificationOtherID, owner: notificationOwner))
            case "page": model.present(.settings)
            default: model.navigationPath.removeLast()
            }
            let opened = await manualOpen.value
            XCTAssertFalse(opened, "A superseded manual request must not report an applied destination")
            XCTAssertEqual(model.conversationId, newerAction == "notice" ? notificationOtherID : notificationPrimaryID)
            XCTAssertEqual(model.presentedRoute, newerAction == "page" ? .settings : nil)
            XCTAssertNil(model.errorMessage)
        }
    }
}

// A completed mutation may still belong to a conversation the owner has left.
extension APIClientRetryTests {
    @MainActor
    func testActiveReplyBlocksCreationAndModelChangeBeforeNetworkWork() async throws {
        let model = try await notificationModel()
        StubURLProtocol.prime([.stream(body: Data())])
        model.send("Keep working on this")
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        XCTAssertTrue(model.isSending)
        let created = await model.createConversation()
        let changed = await model.changeConversationModel("candidate-model")
        XCTAssertFalse(created)
        XCTAssertFalse(changed)
        XCTAssertEqual(model.conversationId, notificationPrimaryID)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"], "The active reply is the only request; no stranded chat or model mutation is created")
        model.cancelSend()
    }

    @MainActor
    func testLateHideCannotRestoreOldTextOrUndoIntoAnotherConversation() async throws {
        for status in [200, 500] {
            let model = try await notificationModel()
            let original = try XCTUnwrap(model.messages.first)
            let body = Data((status == 200 ? #"{"ok":true}"# : #"{"error":"Hide failed"}"#).utf8)
            StubURLProtocol.prime([
                .delayed(after: 0.05, status: status, body: body),
                .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
            ])
            let hiding = Task { await model.hideMessage(original) }
            while StubURLProtocol.attempts.isEmpty { await Task.yield() }
            XCTAssertFalse(model.messages.contains(where: { $0.id == original.id }))
            let opened = await model.openConversation(id: notificationSideID)
            XCTAssertTrue(opened)
            await hiding.value
            XCTAssertEqual(model.conversationId, notificationSideID)
            XCTAssertEqual(model.messages.map(\.id), notificationConversation(notificationSideID).messages.map(\.id))
            XCTAssertNil(model.hiddenMessageUndo, "An old successful hide cannot offer undo in the new conversation")
            XCTAssertNil(model.errorMessage, "An old failure cannot become the new conversation’s error")
            XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
        }
    }

    @MainActor
    func testRejectedHideStillRestoresTheCurrentConversation() async throws {
        let model = try await notificationModel()
        let original = model.messages
        StubURLProtocol.prime([.success(status: 500, body: Data(#"{"error":"Hide failed"}"#.utf8))])
        await model.hideMessage(try XCTUnwrap(original.first))
        XCTAssertEqual(model.messages, original)
        XCTAssertNil(model.hiddenMessageUndo)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testDelayedUndoReadCannotReplaceConversationOpenedWhileItWasPending() async throws {
        let model = try await notificationModel()
        let primaryMessage = try XCTUnwrap(model.messages.first)
        let primaryMessagePath = "/api/mobile/v1/chats/\(notificationPrimaryID)/messages/\(primaryMessage.id)"
        let delayedOldConversation = try JSONEncoder().encode(notificationConversation(notificationPrimaryID))
        let sideConversation = try JSONEncoder().encode(notificationConversation(notificationSideID))
        StubURLProtocol.prime([], paths: [
            primaryMessagePath: [
                .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
                .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            ],
            "/api/mobile/v1/chats/\(notificationPrimaryID)": [
                .delayed(after: 0.15, status: 200, body: delayedOldConversation),
            ],
            "/api/mobile/v1/chats/\(notificationSideID)": [
                .success(status: 200, body: sideConversation),
            ],
        ])

        await model.hideMessage(primaryMessage)
        XCTAssertNotNil(model.hiddenMessageUndo)
        let undoing = Task { await model.undoHiddenMessage() }
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chats/\(notificationPrimaryID)" }) {
            await Task.yield()
        }

        let opened = await model.openConversation(id: notificationSideID)
        XCTAssertTrue(opened)
        await undoing.value

        XCTAssertEqual(model.conversationId, notificationSideID)
        XCTAssertEqual(model.messages.map(\.id), notificationConversation(notificationSideID).messages.map(\.id))
        XCTAssertEqual(StubURLProtocol.urls.filter { $0.path.hasSuffix("/messages/\(primaryMessage.id)") }.count, 2,
            "Undo still completes its server mutation even when its old read is no longer allowed to publish")
    }

    @MainActor
    func testSlowModelChangeCannotReopenAConversationAfterEitherNetworkPhase() async throws {
        for slowPhase in ["write", "read"] {
            let model = try await notificationModel()
            var outcomes: [StubURLProtocol.Outcome] = slowPhase == "write"
                ? [.delayed(after: 0.05, status: 200, body: Data(#"{"ok":true}"#.utf8))]
                : [.success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
                   .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(notificationConversation(notificationPrimaryID)))]
            outcomes.append(.success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))))
            StubURLProtocol.prime(outcomes)
            let changing = Task { await model.changeConversationModel("candidate-model") }
            let expectedRequests = slowPhase == "write" ? 1 : 2
            while StubURLProtocol.attempts.count < expectedRequests { await Task.yield() }
            let opened = await model.openConversation(id: notificationSideID)
            XCTAssertTrue(opened)
            let changed = await changing.value
            XCTAssertFalse(changed, "A committed old mutation cannot report a newly applied view")
            XCTAssertEqual(model.conversationId, notificationSideID)
            XCTAssertEqual(model.messages.map(\.id), notificationConversation(notificationSideID).messages.map(\.id))
            XCTAssertNil(model.errorMessage)
            XCTAssertEqual(StubURLProtocol.attempts, slowPhase == "write" ? ["POST", "GET"] : ["POST", "GET", "GET"])
        }
    }

    @MainActor
    func testAReplyStartedDuringAModelChangeKeepsItsStream() async throws {
        for slowPhase in ["write", "read"] {
            let iterationID = "\(testCaseID)-reply-model-change-\(slowPhase)-\(UUID().uuidString)"
            StubURLProtocol.beginTestCase(iterationID)
            let (client, session) = makeClient(requestScopeID: iterationID)
            let model = AppModel(apiClient: client)
            model.scenePhaseDidChange(.background)
            StubURLProtocol.primeBootstrap(try notificationBootstrap())
            await model.refreshAll(reportFailure: false)
            XCTAssertNotNil(model.bootstrap)

            let conversationPath = "/api/mobile/v1/chats/\(notificationPrimaryID)"
            let chatPath = "/api/mobile/v1/chat"
            let cancelPath = "/api/mobile/v1/chat/cancel"
            let updateAndReadOutcomes: [StubURLProtocol.Outcome] = slowPhase == "write"
                ? [.held(status: 200, body: Data(#"{"ok":true}"#.utf8))]
                : [.success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
                   .held(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationPrimaryID)))]
            StubURLProtocol.prime([], paths: [
                conversationPath: updateAndReadOutcomes,
                chatPath: [.stream(body: Data())],
                cancelPath: [.terminalOperationCancellation(
                    status: 200,
                    outcome: "cancelled",
                    taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    taskStatus: "cancelled",
                    transitioned: true
                )],
            ])

            let changing = Task { await model.changeConversationModel("candidate-model") }
            let heldDeadline = ContinuousClock.now + .seconds(2)
            while !StubURLProtocol.isHoldingResponse(path: conversationPath), ContinuousClock.now < heldDeadline {
                await Task.yield()
            }
            XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: conversationPath), "The selected model-change phase must be held before the reply starts")

            model.send("A new request while the picker is waiting")

            let streamDeadline = ContinuousClock.now + .seconds(2)
            var readyStream: (operationID: String, authorization: String)?
            while readyStream == nil, ContinuousClock.now < streamDeadline {
                for request in StubURLProtocol.requests where request.1.path == chatPath {
                    let payload = try? JSONSerialization.jsonObject(with: request.3) as? [String: Any]
                    let operationID = payload?["clientOperationId"] as? String
                    let authorization = request.2.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value
                    if let operationID, let authorization,
                       StubURLProtocol.isStreamReady(operationId: operationID, authorization: authorization) {
                        readyStream = (operationID, authorization)
                        break
                    }
                }
                if readyStream == nil { await Task.yield() }
            }
            XCTAssertNotNil(readyStream, "The new reply's stream must be ready before the older model-change response is released")
            XCTAssertTrue(StubURLProtocol.requests.contains(where: {
                $0.1.path == conversationPath && $0.0 == (slowPhase == "write" ? "POST" : "GET")
            }))
            XCTAssertTrue(StubURLProtocol.requests.contains(where: { $0.1.path == chatPath && $0.0 == "POST" }),
                          "The streaming outcome must route to the chat endpoint")

            StubURLProtocol.releaseHeldResponse(path: conversationPath)
            let changed = await changing.value
            XCTAssertFalse(changed)
            XCTAssertTrue(model.isSending)
            XCTAssertTrue(model.messages.contains(where: { $0.id.hasPrefix("stream-") }), "A late model refresh cannot throw away the new stream")
            XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "A new request while the picker is waiting" }))
            XCTAssertNil(model.errorMessage)

            model.cancelSend()
            let cancellationDeadline = ContinuousClock.now + .seconds(2)
            while model.hasUnresolvedTurn, ContinuousClock.now < cancellationDeadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertFalse(model.hasUnresolvedTurn, "The fixture's terminal cancellation receipt settles the turn before cleanup")
            XCTAssertFalse(model.isSending)
            if let readyStream {
                StubURLProtocol.cancelStream(operationId: readyStream.operationID, authorization: readyStream.authorization)
            }
            let didDrain = await cancelAndDrain(session, invalidate: false)
            XCTAssertTrue(didDrain, "The iteration's URLSession must drain before the next prime")
            StubURLProtocol.endTestCase(iterationID)
        }
    }

    @MainActor
    func testAReplyStartedDuringConversationOpeningOrCreationKeepsItsThread() async throws {
        for action in ["open", "create"] {
            for status in [200, 500] {
                let iterationID = "\(testCaseID)-reply-opening-\(action)-\(status)-\(UUID().uuidString)"
                StubURLProtocol.beginTestCase(iterationID)
                let (client, session) = makeClient(requestScopeID: iterationID)
                let model = AppModel(apiClient: client)
                model.scenePhaseDidChange(.background)
                StubURLProtocol.primeBootstrap(try notificationBootstrap())
                await model.refreshAll(reportFailure: false)
                XCTAssertNotNil(model.bootstrap)

                let body = status == 500 ? Data(#"{"error":"Request failed"}"#.utf8)
                    : action == "create" ? Data("{\"conversationId\":\"\(notificationSideID)\"}".utf8)
                    : try JSONEncoder().encode(notificationConversation(notificationSideID))
                let oldPath = action == "open"
                    ? "/api/mobile/v1/chats/\(notificationSideID)"
                    : "/api/mobile/v1/chats"
                let chatPath = "/api/mobile/v1/chat"
                StubURLProtocol.prime([], paths: [
                    oldPath: [.held(status: status, body: body)],
                    chatPath: [.stream(body: Data())],
                    "/api/mobile/v1/chat/cancel": [
                        .terminalOperationCancellation(status: 200, outcome: "cancelled",
                            taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                            taskStatus: "cancelled", transitioned: true)
                    ],
                ])
                let opening = Task {
                    action == "open" ? await model.openConversation(id: notificationSideID) : await model.createConversation()
                }
                let heldDeadline = ContinuousClock.now + .seconds(2)
                while !StubURLProtocol.isHoldingResponse(path: oldPath), ContinuousClock.now < heldDeadline {
                    await Task.yield()
                }
                XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: oldPath), "The older navigation request must be held before the reply starts")

                model.send("Keep this reply in the original conversation")
                let streamDeadline = ContinuousClock.now + .seconds(2)
                var readyStream: (operationID: String, authorization: String)?
                while readyStream == nil, ContinuousClock.now < streamDeadline {
                    for request in StubURLProtocol.requests where request.1.path == chatPath {
                        let payload = try? JSONSerialization.jsonObject(with: request.3) as? [String: Any]
                        let operationID = payload?["clientOperationId"] as? String
                        let authorization = request.2.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value
                        if let operationID, let authorization,
                           StubURLProtocol.isStreamReady(operationId: operationID, authorization: authorization) {
                            readyStream = (operationID, authorization)
                            break
                        }
                    }
                    if readyStream == nil { await Task.yield() }
                }
                XCTAssertNotNil(readyStream, "The new chat stream must be active before releasing the older request")
                XCTAssertTrue(StubURLProtocol.requests.contains(where: { $0.1.path == oldPath && $0.0 == (action == "open" ? "GET" : "POST") }))
                XCTAssertTrue(StubURLProtocol.requests.contains(where: { $0.1.path == chatPath && $0.0 == "POST" }), "The stream outcome must route to the chat endpoint")

                StubURLProtocol.releaseHeldResponse(path: oldPath)
                let opened = await opening.value
                XCTAssertFalse(opened)
                XCTAssertTrue(model.isSending)
                XCTAssertEqual(model.conversationId, notificationPrimaryID)
                XCTAssertTrue(model.messages.contains(where: { $0.id.hasPrefix("stream-") }))
                XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Keep this reply in the original conversation" }))
                XCTAssertNil(model.errorMessage, "An older success or failure cannot interrupt the new reply")
                model.cancelSend()
                let cancellationDeadline = ContinuousClock.now + .seconds(2)
                while model.hasUnresolvedTurn, ContinuousClock.now < cancellationDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                XCTAssertFalse(model.hasUnresolvedTurn, "The fixture's terminal cancellation receipt settles the turn before cleanup")
                XCTAssertFalse(model.isSending)
                if let readyStream {
                    StubURLProtocol.cancelStream(operationId: readyStream.operationID,
                                                 authorization: readyStream.authorization)
                }
                let didDrain = await cancelAndDrain(session, invalidate: false)
                XCTAssertTrue(didDrain, "The iteration's URLSession must drain before the next prime")
                StubURLProtocol.endTestCase(iterationID)
            }
        }
    }

    @MainActor
    func testSlowConversationCreationCannotReplaceNewerNavigationOrItsError() async throws {
        for newerAction in ["conversation", "page"] {
            for status in [200, 500] {
                let model = try await notificationModel()
                let body = status == 200
                    ? Data("{\"conversationId\":\"\(notificationOtherID)\"}".utf8)
                    : Data(#"{"error":"Create failed"}"#.utf8)
                StubURLProtocol.prime([
                    .delayed(after: 0.05, status: status, body: body),
                    .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
                ])
                let creating = Task { await model.createConversation() }
                while StubURLProtocol.attempts.isEmpty { await Task.yield() }
                if newerAction == "conversation" {
                    let opened = await model.openConversation(id: notificationSideID)
                    XCTAssertTrue(opened)
                } else { model.present(.settings) }
                let created = await creating.value
                XCTAssertFalse(created)
                XCTAssertEqual(model.conversationId, newerAction == "conversation" ? notificationSideID : notificationPrimaryID)
                XCTAssertEqual(model.presentedRoute, newerAction == "page" ? .settings : nil)
                XCTAssertNil(model.errorMessage)
                XCTAssertEqual(StubURLProtocol.attempts, newerAction == "conversation" ? ["POST", "GET"] : ["POST"])
            }
        }
    }

    @MainActor
    func testLateConversationMutationsCannotPublishIntoAReplacementOwner() async throws {
        for action in ["hide", "create", "model"] {
            let model = try await notificationModel()
            let original = try XCTUnwrap(model.messages.first)
            let oldBody = action == "create"
                ? Data("{\"conversationId\":\"\(notificationOtherID)\"}".utf8)
                : Data(#"{"ok":true}"#.utf8)
            let replacement = BootstrapResponse(generatedAt: "2026-10-03T00:00:01Z",
                identity: .init(id: "replacement-owner", name: "Robin", avatarUrl: nil),
                shell: try JSONDecoder().decode(BootstrapResponse.self, from: notificationBootstrap()).shell,
                conversation: notificationConversation(notificationPrimaryID))
            let mutationPath: String
            switch action {
            case "hide": mutationPath = "/api/mobile/v1/chats/\(notificationPrimaryID)/messages/\(original.id)"
            case "create": mutationPath = "/api/mobile/v1/chats"
            default: mutationPath = "/api/mobile/v1/chats/\(notificationPrimaryID)"
            }
            StubURLProtocol.primeBootstrap(try JSONEncoder().encode(replacement),
                overview: [.success(status: 401, body: Data()), .success(status: 401, body: Data())],
                queued: [.held(status: 200, body: oldBody)])
            defer { StubURLProtocol.releaseHeldResponse(path: mutationPath) }
            let mutation = Task {
                switch action {
                case "hide": await model.hideMessage(original)
                case "create": _ = await model.createConversation()
                default: _ = await model.changeConversationModel("candidate-model")
                }
            }
            let heldDeadline = ContinuousClock.now.advanced(by: .seconds(5))
            while !StubURLProtocol.isHoldingResponse(path: mutationPath), ContinuousClock.now < heldDeadline {
                await Task.yield()
            }
            XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: mutationPath),
                "The old-owner mutation stays pending until replacement bootstrap is applied")
            await model.refreshAll(reportFailure: false)
            XCTAssertEqual(model.bootstrap?.identity.id, "replacement-owner")
            XCTAssertEqual(model.conversationId, notificationPrimaryID)
            StubURLProtocol.releaseHeldResponse(path: mutationPath)
            await mutation.value
            XCTAssertEqual(model.bootstrap?.identity.id, "replacement-owner")
            XCTAssertEqual(model.conversationId, notificationPrimaryID)
            XCTAssertNil(model.hiddenMessageUndo)
            XCTAssertNil(model.errorMessage)
            XCTAssertEqual(StubURLProtocol.attempts.filter { $0 == "POST" }.count, 1)
            let reads = StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/bootstrap" || $0.path == "/api/mobile/v1/overview" }
            XCTAssertEqual(reads.filter { $0.path == "/api/mobile/v1/bootstrap" }.count, 1)
            XCTAssertTrue((1...2).contains(reads.filter { $0.path == "/api/mobile/v1/overview" }.count))
            XCTAssertEqual(StubURLProtocol.attempts.count, reads.count + 1,
                "The old result cannot issue a conversation read; a replaced owner needs a fresh overview")
            XCTAssertFalse(StubURLProtocol.requests.contains(where: {
                $0.0 == "GET" && $0.1.path.hasPrefix("/api/mobile/v1/chats/")
            }), "A stale create/model result cannot load or publish a conversation for the replacement owner")
        }
    }

    @MainActor
    func testReplacementBootstrapResetsPrivateDraftsCachesAndRejectsOlderProjections() async throws {
        let model = try await notificationModel()
        let oldScope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Private unsent text for the old owner", in: oldScope)
        let oldOverview = try overviewBody(pending: [pendingApproval(id: "old-owner-approval")])
        StubURLProtocol.prime([
            .success(status: 200, body: oldOverview),
            .success(status: 200, body: try JSONEncoder().encode(ActivityList(items: [], archivedCount: 1))),
        ])
        await model.refreshOverview(reportFailure: false)
        await model.refreshArchivedActivity(reportFailure: false)
        XCTAssertNotNil(model.overview)
        XCTAssertNotNil(model.archivedActivity)
        let replacement = BootstrapResponse(generatedAt: "2026-10-03T00:00:01Z",
            identity: .init(id: "replacement-owner", name: "Robin", avatarUrl: nil),
            shell: try JSONDecoder().decode(BootstrapResponse.self, from: notificationBootstrap()).shell,
            conversation: notificationConversation(notificationPrimaryID))
        StubURLProtocol.primeBootstrap(try JSONEncoder().encode(replacement), overview: [
            .delayed(after: 0.05, status: 200, body: oldOverview),
            .success(status: 401, body: Data()),
            .success(status: 401, body: Data()),
        ])
        let oldProjection = Task { await model.refreshOverview(reportFailure: false) }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        await model.refreshAll(reportFailure: false)
        await oldProjection.value
        let newScope = try XCTUnwrap(model.composerDraftScope)
        XCTAssertEqual(model.bootstrap?.identity.id, "replacement-owner")
        XCTAssertEqual(newScope.session, oldScope.session + 1, "Owner replacement creates a new draft session even with the same URL/key/conversation")
        XCTAssertEqual(newScope.conversationID, oldScope.conversationID)
        XCTAssertEqual(model.composerDraft(in: oldScope), "")
        XCTAssertEqual(model.composerDraft(in: newScope), "")
        model.saveComposerDraft("Late disappearing view text", in: oldScope)
        XCTAssertEqual(model.composerDraft(in: newScope), "", "The previous view cannot save into the replacement owner")
        XCTAssertNil(model.overview, "The old projection must be cleared and its late response fenced out")
        XCTAssertNil(model.archivedActivity)
        XCTAssertEqual(model.pendingApprovalCount, 0)
        XCTAssertNil(model.errorMessage)
        StubURLProtocol.primeBootstrap(try JSONEncoder().encode(replacement))
        await model.refreshAll(reportFailure: false)
        XCTAssertEqual(model.composerDraftScope?.session, newScope.session, "The same replacement identity must not reset twice")
    }

    @MainActor
    func testReplacementBootstrapDiscardsItsSpeculativeOverviewAndReadsTheNewOwner() async throws {
        let model = try await notificationModel()
        let oldScope = try XCTUnwrap(model.composerDraftScope)
        let replacement = BootstrapResponse(generatedAt: "2026-10-03T00:00:01Z",
            identity: .init(id: "replacement-owner", name: "Robin", avatarUrl: nil),
            shell: try JSONDecoder().decode(BootstrapResponse.self, from: notificationBootstrap()).shell,
            conversation: notificationConversation(notificationPrimaryID))
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/bootstrap": [.delayed(after: 0.04, status: 200, body: try JSONEncoder().encode(replacement))],
            "/api/mobile/v1/overview": [
                .success(status: 200, body: try overviewBody(pending: [pendingApproval(id: "old-owner-approval")])),
                .success(status: 200, body: try overviewBody(pending: [pendingApproval(id: "replacement-owner-approval")])),
            ],
        ])
        await model.refreshAll(reportFailure: false)
        XCTAssertEqual(model.bootstrap?.identity.id, "replacement-owner")
        XCTAssertEqual(model.composerDraftScope?.session, oldScope.session + 1)
        XCTAssertEqual(model.overview?.approvals.pending.map(\.approval.id), ["replacement-owner-approval"],
            "Updating the bootstrap ticket cannot bless a projection requested for the previous owner")
        let paths = StubURLProtocol.urls.map(\.path)
        XCTAssertEqual(Set(paths.prefix(2)), ["/api/mobile/v1/bootstrap", "/api/mobile/v1/overview"])
        XCTAssertEqual(paths.filter { $0 == "/api/mobile/v1/overview" }.count, 2,
            "Only owner replacement needs another read; ordinary startup remains parallel")
    }

    @MainActor
    func testObservationTracksPrivateDraftScopeAndSeparatesUnrelatedScreenState() async throws {
        let model = try await notificationModel()
        let scope = try XCTUnwrap(model.composerDraftScope)
        let draftChanged = NativeObservationSignal()
        let messagesChanged = NativeObservationSignal()
        withObservationTracking { _ = model.composerDraftScope } onChange: { draftChanged.mark() }
        withObservationTracking { _ = model.messages } onChange: { messagesChanged.mark() }
        model.saveComposerDraft("Unsent words", in: scope)
        XCTAssertTrue(draftChanged.changed, "A private stored property can still supply a visible computed scope")
        XCTAssertFalse(messagesChanged.changed, "Saving a draft must not invalidate an unchanged transcript")
        let errorChanged = NativeObservationSignal()
        withObservationTracking { _ = model.errorMessage } onChange: { errorChanged.mark() }
        model.reportError(APIError.transport(URLError(.notConnectedToInternet)))
        XCTAssertTrue(errorChanged.changed)
        XCTAssertFalse(messagesChanged.changed, "An unrelated error is observed separately from message contents")
        XCTAssertEqual(model.composerDraft(in: scope), "Unsent words")
    }
}

private final class NativeObservationSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var changed: Bool { lock.withLock { value } }
    func mark() { lock.withLock { value = true } }
}

extension APIClientRetryTests {
    @MainActor
    func testCancelledCardRefreshKeepsTheOriginalReceiptAndConnection() async {
        let model = AppModel(apiClient: makeClient(), initialMessages: [
            ChatMessage(id: "card-message", role: .assistant, parts: [RichMessageFixture.generated()])
        ])
        StubURLProtocol.prime([.stream(body: Data())])
        let request = Task { await model.refreshSavedCard(id: "saved-1") }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        request.cancel()
        let failure = await request.value
        XCTAssertEqual(failure, "The refresh could not be confirmed. Try again.")
        XCTAssertFalse(model.messages[0].hasRefreshingCard, "A cancelled request cannot publish an optimistic refresh receipt")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testSuggestionReceiptCannotCrossAnAuthenticatedOwnerReplacement() async throws {
        let model = try await notificationModel()
        let oldConversation = ConversationView(conversation: .init(id: notificationPrimaryID,
            title: "Original owner", modelOverride: nil, archivedAt: nil, isPrimary: true),
            agentName: "Ada", agentTimezone: "UTC", messages: [suggestionMessage()], models: [],
            goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(oldConversation))])
        let opened = await model.openConversation(id: notificationPrimaryID)
        XCTAssertTrue(opened)
        StubURLProtocol.prime([.delayed(after: 0.2, status: 200,
            body: Data(#"{"ok":true,"decision":"accepted","taskId":"old-owner-task"}"#.utf8))])
        let request = Task { await model.decideSuggestion(id: "s1", decision: .accepted) }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        var replacement = try XCTUnwrap(JSONSerialization.jsonObject(with: notificationBootstrap()) as? [String: Any])
        replacement["identity"] = ["id": "replacement-owner", "name": "New assistant"]
        StubURLProtocol.primeBootstrap(try JSONSerialization.data(withJSONObject: replacement),
            overview: [.success(status: 401, body: Data()), .success(status: 401, body: Data())])
        await model.refreshAll()
        let failure = await request.value
        XCTAssertEqual(model.bootstrap?.identity.id, "replacement-owner")
        XCTAssertEqual(failure, "Your connection changed. Check this suggestion on its original assistant.")
        XCTAssertTrue(model.messages.flatMap(\.suggestionParts).isEmpty,
            "An old assistant's receipt cannot enter the replacement owner's transcript")
    }

    func testChecklistCorrectionProjectionUsesExactBoundedQuery() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let itemID = "lookup-1"
        StubURLProtocol.prime([.success(status: 200, body: Data(
            #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight from Berlin"}]}"#.utf8
        ))])

        let projection = try await makeClient().checklistCorrectionProjection(taskID: taskID)

        XCTAssertTrue(projection.isValid(for: taskID))
        XCTAssertEqual(projection.items, [.init(id: itemID, label: "Find my flight from Berlin")])
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        let url = try XCTUnwrap(StubURLProtocol.urls.first)
        XCTAssertEqual(url.path, "/api/mobile/v1/activity/\(taskID)")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, [
            URLQueryItem(name: "checklistCorrection", value: "1")
        ])
    }

    func testChecklistCorrectionProjectionDoesNotRetryAfterTransportFailure() async {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight from Berlin"}]}"#
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .success(status: 200, body: Data(projection.utf8)),
        ])

        do {
            _ = try await makeClient().checklistCorrectionProjection(taskID: taskID)
            XCTFail("A failed projection read must not retry through the generic Activity GET policy.")
        } catch {
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }
    }

    func testChecklistCancellationUsesExactBoundPayloadAndAuditReconciliation() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let itemID = "reminder-1"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        StubURLProtocol.prime([.success(status: 200, body: Data(
            #"{"ok":true,"outcome":"cancelled","transitioned":true,"queueGeneration":7,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"reminder-1","checklistRevision":4,"cancellationRevision":2}"#.utf8
        ))])

        let result = await makeClient().cancelChecklistItem(
            taskID: taskID,
            itemID: itemID,
            expectedRevision: 4,
            expectedCancellationRevision: 1,
            ownerMessageID: operationID,
            itemLabel: "Remind me to pack"
        )

        XCTAssertEqual(result, .confirmed)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(payload["action"] as? String, "cancel-checklist")
        XCTAssertEqual(payload["itemId"] as? String, itemID)
        XCTAssertEqual(payload["expectedRevision"] as? Int, 4)
        XCTAssertEqual(payload["expectedCancellationRevision"] as? Int, 1)
        XCTAssertEqual(payload["ownerMessageId"] as? String, operationID)
        XCTAssertEqual(Set(payload.keys), ["action", "itemId", "expectedRevision", "expectedCancellationRevision", "ownerMessageId"])
    }

    func testChecklistCancellationConfirmsOnlyExactOwnerAuditAfterAmbiguousPost() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let itemID = "lookup-1"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: Data(
                #"{"id":"123e4567-e89b-12d3-a456-426614174000","checklistRevision":4,"cancellationRevision":2,"audit":{"revision":2,"checklistRevision":4,"taskId":"123e4567-e89b-12d3-a456-426614174000","conversationId":"conversation-1","ownerTaskId":"123e4567-e89b-12d3-a456-426614174000","ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","itemIds":["lookup-1"],"requestSpans":["Find my flight"]}}"#.utf8
            )),
        ])

        let confirmed = await makeClient().cancelChecklistItem(
            taskID: taskID,
            itemID: itemID,
            expectedRevision: 4,
            expectedCancellationRevision: 1,
            ownerMessageID: operationID,
            itemLabel: "Find my flight"
        )
        XCTAssertEqual(confirmed, .confirmed)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
        let readbackURL = try XCTUnwrap(StubURLProtocol.urls.last)
        XCTAssertEqual(URLComponents(url: readbackURL, resolvingAgainstBaseURL: false)?.queryItems, [
            URLQueryItem(name: "cancellationOwnerMessageId", value: operationID)
        ])

        let body = ChecklistCancellationBody(
            itemId: itemID,
            expectedRevision: 4,
            expectedCancellationRevision: 1,
            ownerMessageId: operationID
        )
        let wrongItemAudit = ChecklistCancellationReconciliation(
            id: taskID,
            checklistRevision: 4,
            cancellationRevision: 2,
            audit: .init(
                revision: 2,
                checklistRevision: 4,
                taskId: taskID,
                ownerTaskId: taskID,
                ownerMessageId: operationID,
                itemIds: ["hotel-lookup"],
                requestSpans: ["Find my flight"]
            )
        )
        XCTAssertFalse(wrongItemAudit.confirms(body, taskID: taskID, itemLabel: "Find my flight"))
        let laterRevisionAudit = ChecklistCancellationReconciliation(
            id: taskID,
            checklistRevision: 5,
            cancellationRevision: 2,
            audit: .init(
                revision: 2,
                checklistRevision: 4,
                taskId: taskID,
                ownerTaskId: taskID,
                ownerMessageId: operationID,
                itemIds: [itemID],
                requestSpans: ["Find my flight"]
            )
        )
        XCTAssertTrue(laterRevisionAudit.confirms(body, taskID: taskID, itemLabel: "Find my flight"),
            "An exact audit remains proof when later checklist edits advance the outer revisions.")
        let foreignOwnerAudit = ChecklistCancellationReconciliation(
            id: taskID,
            checklistRevision: 5,
            cancellationRevision: 3,
            audit: .init(
                revision: 2,
                checklistRevision: 4,
                taskId: taskID,
                ownerTaskId: "another-task",
                ownerMessageId: operationID,
                itemIds: [itemID],
                requestSpans: ["Find my flight"]
            )
        )
        XCTAssertFalse(foreignOwnerAudit.confirms(body, taskID: taskID, itemLabel: "Find my flight"))
        let mismatchedLabelAudit = ChecklistCancellationReconciliation(
            id: taskID,
            checklistRevision: 5,
            cancellationRevision: 3,
            audit: .init(
                revision: 2,
                checklistRevision: 4,
                taskId: taskID,
                ownerTaskId: taskID,
                ownerMessageId: operationID,
                itemIds: [itemID],
                requestSpans: ["Find my hotel"]
            )
        )
        XCTAssertFalse(mismatchedLabelAudit.confirms(body, taskID: taskID, itemLabel: "Find my flight"))
    }

    func testChecklistCorrectionAcceptsExactPostReceiptWithoutRetry() async {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let itemID = "lookup-1"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        let label = "Find my flight from Berlin to Paris"
        StubURLProtocol.prime([.success(status: 200, body: Data(
            #"{"ok":true,"outcome":"corrected","transitioned":true,"queueGeneration":3,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","revision":1,"replacementLabel":"Find my flight from Berlin to Paris","replacementKind":"lookup"}"#.utf8
        ))])

        let result = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: itemID,
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: label
        )

        XCTAssertEqual(result, .confirmed)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        let body = try? XCTUnwrap(StubURLProtocol.bodies.first)
        let payload = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertEqual(payload?["action"] as? String, "correct-checklist")
        XCTAssertEqual(payload?["itemId"] as? String, itemID)
        XCTAssertEqual(payload?["expectedRevision"] as? Int, 0)
        XCTAssertEqual(payload?["ownerMessageId"] as? String, operationID)
        XCTAssertEqual(payload?["replacementKind"] as? String, "lookup")
        XCTAssertEqual(payload?["replacementLabel"] as? String, label)
    }

    func testChecklistCorrectionUsesServerUtf16ItemIdentifierBound() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        let itemID = String(repeating: "😀", count: 64)
        let label = "Find my flight"
        let response: [String: Any] = [
            "ok": true,
            "outcome": "corrected",
            "transitioned": true,
            "queueGeneration": 1,
            "ownerMessageId": operationID,
            "taskId": taskID,
            "itemId": itemID,
            "revision": 1,
            "replacementLabel": label,
            "replacementKind": "lookup",
        ]
        StubURLProtocol.prime([.success(
            status: 200,
            body: try JSONSerialization.data(withJSONObject: response)
        )])

        let result = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: itemID,
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: label
        )

        XCTAssertEqual(itemID.utf16.count, 128)
        XCTAssertGreaterThan(itemID.utf8.count, 128)
        XCTAssertEqual(result, .confirmed, "The native client must use the route's UTF-16 bound for IDs.")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(payload["itemId"] as? String, itemID)
    }

    func testChecklistCorrectionReconcilesAmbiguousPostExactlyOnceWithSameOperationID() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let itemID = "lookup-1"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        let label = "Find my flight from Berlin to Paris"
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .success(status: 200, body: Data(
                #"{"id":"123e4567-e89b-12d3-a456-426614174000","revision":1,"audit":{"revision":1,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","itemId":"lookup-1","toLabel":"Find my flight from Berlin to Paris","toKind":"lookup"}}"#.utf8
            )),
        ])

        let result = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: itemID,
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: label
        )

        XCTAssertEqual(result, .confirmed)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
        let getURL = try XCTUnwrap(StubURLProtocol.urls.last)
        XCTAssertEqual(getURL.path, "/api/mobile/v1/activity/\(taskID)")
        XCTAssertEqual(URLComponents(url: getURL, resolvingAgainstBaseURL: false)?.queryItems, [
            URLQueryItem(name: "correctionOwnerMessageId", value: operationID)
        ])
        let sent = try XCTUnwrap(StubURLProtocol.bodies.first)
        let sentJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(sentJSON["ownerMessageId"] as? String, operationID)
    }

    func testChecklistCorrectionUsesAuditReadbackAfterMalformedSuccessBody() async {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: Data(
                #"{"id":"123e4567-e89b-12d3-a456-426614174000","revision":1,"audit":{"revision":1,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","itemId":"lookup-1","toLabel":"Find my flight from Berlin","toKind":"lookup"}}"#.utf8
            )),
        ])

        let result = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: "lookup-1",
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: "Find my flight from Berlin"
        )

        XCTAssertEqual(result, .confirmed)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
    }

    func testChecklistCorrectionDoesNotConfirmUnsafeQueueGenerationOrInvalidRevision() async {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        StubURLProtocol.prime([
            .success(status: 200, body: Data(
                #"{"ok":true,"outcome":"corrected","transitioned":true,"queueGeneration":9007199254740992,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","revision":1,"replacementLabel":"Find my flight from Berlin","replacementKind":"lookup"}"#.utf8
            )),
            .success(status: 200, body: Data(
                #"{"id":"123e4567-e89b-12d3-a456-426614174000","revision":1,"audit":{"revision":1,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","itemId":"lookup-1","toLabel":"Find my flight from Berlin","toKind":"lookup"}}"#.utf8
            )),
        ])

        let result = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: "lookup-1",
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: "Find my flight from Berlin"
        )

        XCTAssertEqual(result, .confirmed, "The unsafe POST receipt must be reconciled against the exact audit.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])

        let invalidBody = ChecklistCorrectionBody(
            itemId: "lookup-1",
            expectedRevision: Int.max,
            ownerMessageId: operationID,
            replacementLabel: "Find my flight from Berlin"
        )
        let impossiblePost = ChecklistCorrectionPostResponse(
            ok: true,
            outcome: "corrected",
            transitioned: true,
            queueGeneration: 0,
            ownerMessageId: operationID,
            taskId: taskID,
            itemId: "lookup-1",
            revision: 1,
            replacementLabel: "Find my flight from Berlin",
            replacementKind: "lookup"
        )
        XCTAssertFalse(impossiblePost.confirms(invalidBody, taskID: taskID))
        let impossibleReadback = ChecklistCorrectionReconciliation(
            id: taskID,
            revision: 1,
            audit: .init(
                revision: 1,
                ownerMessageId: operationID,
                itemId: "lookup-1",
                toLabel: "Find my flight from Berlin",
                toKind: "lookup"
            )
        )
        XCTAssertFalse(impossibleReadback.confirms(invalidBody, taskID: taskID))
    }

    func testChecklistCorrectionRejectsStalePostWithoutReadbackAndUnmatchedAuditStaysUnknown() async {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let operationID = "123e4567-e89b-12d3-a456-426614174001"
        StubURLProtocol.prime([.success(status: 409, body: Data(#"{"error":"stale"}"#.utf8))])
        let rejected = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: "lookup-1",
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: "Find my flight from Berlin"
        )
        XCTAssertEqual(rejected, .rejected)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])

        StubURLProtocol.prime([
            .success(status: 200, body: Data(#"{"ok":true,"outcome":"corrected","transitioned":true,"queueGeneration":3,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174002","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","revision":1,"replacementLabel":"Find my flight from Berlin","replacementKind":"lookup"}"#.utf8)),
            .success(status: 200, body: Data(#"{"id":"123e4567-e89b-12d3-a456-426614174000","revision":2,"audit":{"revision":2,"ownerMessageId":"other-operation","itemId":"lookup-1","toLabel":"Find my flight from Berlin","toKind":"lookup"}}"#.utf8)),
        ])
        let uncertain = await makeClient().correctChecklistItem(
            taskID: taskID,
            itemID: "lookup-1",
            expectedRevision: 0,
            ownerMessageID: operationID,
            replacementLabel: "Find my flight from Berlin"
        )
        XCTAssertEqual(uncertain, .uncertain)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
    }

    func testChecklistCorrectionHeldPostAndReadbackShareOneDeadline() async throws {
        StubURLProtocol.prime([
            .held(status: 200, body: Data()),
            .held(status: 200, body: Data()),
        ])
        let observer = DeadlineSessionObserver()
        let context = makeClient(requestScopeID: testCaseID, delegate: observer)
        let postURL = URL(string: "https://assistant.test/api/mobile/v1/activity/123e4567-e89b-12d3-a456-426614174000")!
        let readbackURL = URL(string: postURL.absoluteString + "?correctionOwnerMessageId=123e4567-e89b-12d3-a456-426614174001")!
        let start = ContinuousClock.now
        let result = await context.client.correctChecklistItem(
            taskID: "123e4567-e89b-12d3-a456-426614174000",
            itemID: "lookup-1",
            expectedRevision: 0,
            ownerMessageID: "123e4567-e89b-12d3-a456-426614174001",
            replacementLabel: "Find my flight from Berlin",
            totalDeadline: .milliseconds(220),
            postDeadline: .milliseconds(100)
        )
        let elapsed = ContinuousClock.now - start
        XCTAssertEqual(result, .uncertain)
        XCTAssertLessThan(elapsed, .milliseconds(700))
        // Cancellation can finish the API operation before URLProtocol's
        // serial queue registers the already-cancelled GET. Observe that
        // transport event separately from the operation's deadline.
        // Finish naturally; cleanup cancellation must not satisfy this barrier.
        context.session.finishTasksAndInvalidate()
        let observationDeadline = ContinuousClock.now + .seconds(2)
        while (!observer.invalidated ||
               !StubURLProtocol.hasStoppedRequest(method: "POST", url: postURL, testCaseID: testCaseID) ||
               !StubURLProtocol.hasStoppedRequest(method: "GET", url: readbackURL, testCaseID: testCaseID)),
              ContinuousClock.now < observationDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.hasStoppedRequest(method: "POST", url: postURL, testCaseID: testCaseID))
        XCTAssertTrue(StubURLProtocol.hasStoppedRequest(method: "GET", url: readbackURL, testCaseID: testCaseID))
        XCTAssertTrue(observer.invalidated)
        XCTAssertEqual(observer.requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(observer.requests.compactMap(\.url), [postURL, readbackURL])
        XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
    }

    func testChecklistCorrectionExhaustedTotalDeadlineDoesNotStartReadback() async throws {
        StubURLProtocol.prime([
            .held(status: 200, body: Data()),
            .held(status: 200, body: Data()),
        ])
        let observer = DeadlineSessionObserver()
        let context = makeClient(requestScopeID: testCaseID, delegate: observer)
        let postURL = URL(string: "https://assistant.test/api/mobile/v1/activity/123e4567-e89b-12d3-a456-426614174000")!
        let start = ContinuousClock.now
        let result = await context.client.correctChecklistItem(
            taskID: "123e4567-e89b-12d3-a456-426614174000",
            itemID: "lookup-1",
            expectedRevision: 0,
            ownerMessageID: "123e4567-e89b-12d3-a456-426614174001",
            replacementLabel: "Find my flight from Berlin",
            totalDeadline: .milliseconds(100),
            postDeadline: .seconds(1)
        )
        let elapsed = ContinuousClock.now - start
        XCTAssertEqual(result, .uncertain)
        XCTAssertLessThan(elapsed, .milliseconds(700))
        context.session.finishTasksAndInvalidate()
        let observationDeadline = ContinuousClock.now + .seconds(2)
        while (!observer.invalidated ||
               !StubURLProtocol.hasStoppedRequest(method: "POST", url: postURL, testCaseID: testCaseID)),
              ContinuousClock.now < observationDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.hasStoppedRequest(method: "POST", url: postURL, testCaseID: testCaseID))
        XCTAssertTrue(observer.invalidated)
        XCTAssertEqual(observer.requests.map(\.httpMethod), ["POST"])
        XCTAssertEqual(observer.requests.compactMap(\.url), [postURL])
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    @MainActor
    func testChecklistCorrectionManualRetryKeepsExactOperationAndDoesNotRetryAutomatically() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let itemID = "lookup-1"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight from Berlin"}]}"#
        let unmatchedAudit = #"{"id":"123e4567-e89b-12d3-a456-426614174000","revision":1,"audit":{"revision":1,"ownerMessageId":"other-operation","itemId":"lookup-1","toLabel":"Find my flight from Berlin to Paris","toKind":"lookup"}}"#
        StubURLProtocol.prime([
            .success(status: 200, body: Data(projection.utf8)),
            .failure(URLError(.timedOut)),
            .success(status: 200, body: Data(unmatchedAudit.utf8)),
            .failure(URLError(.timedOut)),
            .success(status: 200, body: Data(unmatchedAudit.utf8)),
        ])
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(
                ownerID: "owner-a",
                connectionVersion: 4,
                client: makeClient()
            ),
            taskID: taskID,
            connectionIsCurrent: { true }
        )
        await controller.load()
        XCTAssertEqual(controller.loadState, .ready)
        controller.select(.init(id: itemID, label: "Find my flight from Berlin"))
        controller.updateDraft("Find my flight from Berlin to Paris")

        let first = await controller.submit()
        let operationID = try XCTUnwrap(controller.operationID)
        XCTAssertEqual(first, .uncertain)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET"],
            "An unclear result must not trigger a second POST automatically.")

        let manualRetry = await controller.submit()
        XCTAssertEqual(manualRetry, .uncertain)
        XCTAssertEqual(controller.operationID, operationID)
        XCTAssertEqual(controller.draft, "Find my flight from Berlin to Paris")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET", "POST", "GET"])

        let postBodies = StubURLProtocol.requests.filter { $0.0 == "POST" }.map { $0.3 }
        let retryOperationIDs = try postBodies.map { data -> String in
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            return try XCTUnwrap(object["ownerMessageId"] as? String)
        }
        XCTAssertEqual(operationID, operationID.lowercased(), "The durable owner message id must match PostgreSQL UUID canonicalization.")
        XCTAssertEqual(retryOperationIDs, [operationID, operationID])
        let retryPayloads = try postBodies.map { data in
            try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertEqual(retryPayloads[0] as NSDictionary, retryPayloads[1] as NSDictionary)

        StubURLProtocol.prime([.success(status: 200, body: Data(
            #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":false,"revision":null,"items":[]}"#.utf8
        ))])
        await controller.load()
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty, "An uncertain operation cannot be cleared by an unrelated projection refresh.")
        XCTAssertEqual(controller.selectedItemID, itemID)
        XCTAssertEqual(controller.operationID, operationID)
        XCTAssertEqual(controller.draft, "Find my flight from Berlin to Paris")
        controller.dispose()
    }

    @MainActor
    func testChecklistCancellationKeepsItemAndExactOperationUntilConfirmed() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let expectedOperationID = "123e4567-e89b-12d3-a456-426614174001"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":false,"revision":null,"items":[],"cancellationEligible":true,"cancellationChecklistRevision":4,"cancellationRevision":1,"cancellableItems":[{"id":"lookup-1","label":"Find my flight","status":"blocked"},{"id":"reminder-1","label":"Remind me to pack","status":"pending"}]}"#
        let unmatchedAudit = #"{"id":"123e4567-e89b-12d3-a456-426614174000","checklistRevision":4,"cancellationRevision":2,"audit":{"revision":2,"checklistRevision":4,"taskId":"123e4567-e89b-12d3-a456-426614174000","conversationId":"conversation-1","ownerTaskId":"123e4567-e89b-12d3-a456-426614174000","ownerMessageId":"other-operation","itemIds":["lookup-1"],"requestSpans":["Find my flight"]}}"#
        let exactReceipt = #"{"ok":true,"outcome":"cancelled","transitioned":true,"queueGeneration":8,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","checklistRevision":4,"cancellationRevision":2}"#
        StubURLProtocol.prime([
            .success(status: 200, body: Data(projection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: Data(unmatchedAudit.utf8)),
            .success(status: 200, body: Data(unmatchedAudit.utf8)),
            .success(status: 200, body: Data(exactReceipt.utf8)),
        ])
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(
                ownerID: "owner-a",
                connectionVersion: 1,
                client: makeClient()
            ),
            taskID: taskID,
            connectionIsCurrent: { true },
            operationIDFactory: { expectedOperationID }
        )
        await controller.load()
        let selected = try XCTUnwrap(controller.cancellableItems.first(where: { $0.id == "lookup-1" }))
        XCTAssertEqual(controller.requestItems.map(\.id), ["lookup-1", "reminder-1"])
        XCTAssertEqual(Set(controller.requestItems.map(\.id)).count, controller.requestItems.count,
            "An editable lookup must not appear twice in the combined request list.")
        XCTAssertFalse(controller.requestItems.first(where: { $0.id == "lookup-1" })?.canChangeLookup == true,
            "A blocked lookup is cancellable but is not in the editable lookup projection.")
        XCTAssertTrue(controller.requestItems.first(where: { $0.id == "lookup-1" })?.canCancel == true)
        XCTAssertTrue(controller.requestItems.first(where: { $0.id == "reminder-1" })?.canCancel == true)
        controller.selectCancellationItem(selected)
        let selection = ChecklistCancellationSelection(
            itemID: selected.id,
            label: selected.label,
            checklistRevision: 4,
            cancellationRevision: 1
        )

        let firstResult = await controller.cancelSelectedItem(selection: selection)
        XCTAssertEqual(firstResult, .uncertain)
        let operationID = try XCTUnwrap(controller.cancellationOperationID)
        XCTAssertEqual(controller.selectedCancellationItem?.id, selected.id,
            "An unclear response must leave the selected item visible.")
        XCTAssertEqual(controller.cancellationTargetLabel, selected.label)
        await controller.load()
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET"],
            "A projection refresh must not clear or repeat an uncertain cancellation.")

        let statusResult = await controller.checkCancellationStatus()
        XCTAssertEqual(statusResult, .uncertain)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET", "GET"])
        let statusURL = try XCTUnwrap(StubURLProtocol.urls.last)
        XCTAssertEqual(URLComponents(url: statusURL, resolvingAgainstBaseURL: false)?.queryItems, [
            URLQueryItem(name: "cancellationOwnerMessageId", value: operationID)
        ])

        let retryResult = await controller.cancelSelectedItem()
        XCTAssertEqual(retryResult, .confirmed)
        XCTAssertEqual(controller.cancellationOperationID, operationID)
        XCTAssertEqual(operationID, expectedOperationID)
        XCTAssertEqual(controller.selectedCancellationItem?.id, selected.id,
            "The item is not optimistically removed from the saved projection.")
        let cancellationPayloads = try StubURLProtocol.requests.filter { $0.0 == "POST" }.map { request in
            let data = try XCTUnwrap(request.3)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertEqual(cancellationPayloads.count, 2)
        XCTAssertEqual(cancellationPayloads[0] as NSDictionary, cancellationPayloads[1] as NSDictionary,
            "A manual repeat must preserve the same operation ID and revision fences.")
        let expectedPayload: [String: Any] = [
            "action": "cancel-checklist",
            "itemId": selected.id,
            "expectedRevision": 4,
            "expectedCancellationRevision": 1,
            "ownerMessageId": expectedOperationID,
        ]
        XCTAssertEqual(cancellationPayloads[0] as NSDictionary, expectedPayload as NSDictionary)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET", "GET", "POST"])
        controller.dispose()
    }

    @MainActor
    func testChecklistCancellationConfirmationCannotFollowChangedSelection() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":false,"revision":null,"items":[],"cancellationEligible":true,"cancellationChecklistRevision":4,"cancellationRevision":1,"cancellableItems":[{"id":"lookup-1","label":"Find my flight","status":"pending"},{"id":"reminder-1","label":"Remind me to pack","status":"blocked"}]}"#
        StubURLProtocol.prime([.success(status: 200, body: Data(projection.utf8))])
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(
                ownerID: "owner-a",
                connectionVersion: 1,
                client: makeClient()
            ),
            taskID: taskID,
            connectionIsCurrent: { true }
        )
        await controller.load()
        let first = try XCTUnwrap(controller.cancellableItems.first)
        controller.selectCancellationItem(first)
        let confirmation = ChecklistCancellationSelection(
            itemID: first.id,
            label: first.label,
            checklistRevision: 4,
            cancellationRevision: 1
        )
        let second = try XCTUnwrap(controller.cancellableItems.last)
        controller.selectCancellationItem(second)

        let staleSelectionResult = await controller.cancelSelectedItem(selection: confirmation)
        XCTAssertNil(staleSelectionResult)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"],
            "A confirmation for an old selection must never send a cancellation for the new item.")
        controller.dispose()
    }

    @MainActor
    func testCorrectionAndCancellationCannotPassEachOthersUncertainFence() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":4,"items":[{"id":"lookup-1","label":"Find my flight"}],"cancellationEligible":true,"cancellationChecklistRevision":4,"cancellationRevision":1,"cancellableItems":[{"id":"lookup-1","label":"Find my flight","status":"pending"}]}"#
        let unknownCancellation = #"{"id":"123e4567-e89b-12d3-a456-426614174000","checklistRevision":4,"cancellationRevision":2,"audit":{"revision":2,"checklistRevision":4,"taskId":"123e4567-e89b-12d3-a456-426614174000","conversationId":"conversation-1","ownerTaskId":"123e4567-e89b-12d3-a456-426614174000","ownerMessageId":"other-operation","itemIds":["lookup-1"],"requestSpans":["Find my flight"]}}"#
        StubURLProtocol.prime([
            .success(status: 200, body: Data(projection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: Data(unknownCancellation.utf8)),
        ])
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(
                ownerID: "owner-a",
                connectionVersion: 1,
                client: makeClient()
            ),
            taskID: taskID,
            connectionIsCurrent: { true }
        )
        await controller.load()
        controller.select(.init(id: "lookup-1", label: "Find my flight"))
        controller.updateDraft("Find my flight from Berlin")
        let cancellable = try XCTUnwrap(controller.cancellableItems.first)
        XCTAssertTrue(controller.selectCancellationItem(cancellable))
        let cancellationResult = await controller.cancelSelectedItem(selection: .init(
            itemID: cancellable.id,
            label: cancellable.label,
            checklistRevision: 4,
            cancellationRevision: 1
        ))
        XCTAssertEqual(cancellationResult, .uncertain)

        let correctionResult = await controller.submit()
        let correctionStatus = await controller.checkStatus()
        XCTAssertNil(correctionResult, "An uncertain cancellation must block a new correction POST.")
        XCTAssertNil(correctionStatus, "An uncertain cancellation must block correction status traffic too.")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET"])
        controller.dispose()

        let unknownCorrection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","revision":5,"audit":{"revision":5,"ownerMessageId":"other-operation","itemId":"lookup-1","toLabel":"Find my flight from Berlin","toKind":"lookup"}}"#
        StubURLProtocol.prime([
            .success(status: 200, body: Data(projection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: Data(unknownCorrection.utf8)),
        ])
        let reverse = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(
                ownerID: "owner-a",
                connectionVersion: 1,
                client: makeClient()
            ),
            taskID: taskID,
            connectionIsCurrent: { true }
        )
        await reverse.load()
        reverse.select(.init(id: "lookup-1", label: "Find my flight"))
        reverse.updateDraft("Find my flight from Berlin")
        let reverseCorrectionResult = await reverse.submit()
        XCTAssertEqual(reverseCorrectionResult, .uncertain)
        let blockedCancellation = try XCTUnwrap(reverse.cancellableItems.first)
        XCTAssertFalse(reverse.selectCancellationItem(blockedCancellation))
        let blockedCancellationResult = await reverse.cancelSelectedItem()
        XCTAssertNil(blockedCancellationResult)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "POST", "GET"],
            "An uncertain correction cannot be overtaken by a cancellation POST.")
        reverse.dispose()
    }

    @MainActor
    func testConfirmedCorrectionStaysConfirmedWhenCancellationIsInterrupted() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let correctionID = "123e4567-e89b-12d3-a456-426614174001"
        let cancellationID = "123e4567-e89b-12d3-a456-426614174002"
        let firstProjection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight"}],"cancellationEligible":true,"cancellationChecklistRevision":0,"cancellationRevision":0,"cancellableItems":[{"id":"lookup-1","label":"Find my flight","status":"pending"},{"id":"reminder-1","label":"Remind me to pack","status":"pending"}]}"#
        let refreshedProjection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":1,"items":[{"id":"lookup-1","label":"Find my flight from Berlin"}],"cancellationEligible":true,"cancellationChecklistRevision":1,"cancellationRevision":0,"cancellableItems":[{"id":"lookup-1","label":"Find my flight from Berlin","status":"pending"},{"id":"reminder-1","label":"Remind me to pack","status":"pending"}]}"#
        var generatedIDs = [correctionID, cancellationID]
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            taskID: taskID,
            connectionIsCurrent: { true },
            operationIDFactory: { generatedIDs.removeFirst() }
        )
        let path = "/api/mobile/v1/activity/\(taskID)"
        defer {
            controller.dispose()
            StubURLProtocol.releaseHeldResponse(path: path)
        }
        StubURLProtocol.prime([
            .success(status: 200, body: Data(firstProjection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true,"outcome":"corrected","transitioned":true,"queueGeneration":2,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","revision":1,"replacementLabel":"Find my flight from Berlin","replacementKind":"lookup"}"#.utf8)),
            .success(status: 200, body: Data(refreshedProjection.utf8)),
            .held(status: 200, body: Data()),
        ])
        await controller.load()
        controller.select(.init(id: "lookup-1", label: "Find my flight"))
        controller.updateDraft("Find my flight from Berlin")
        let correctionResult = await controller.submit()
        XCTAssertEqual(correctionResult, .confirmed)
        await controller.load()
        XCTAssertEqual(controller.submission, .confirmed)

        let reminder = try XCTUnwrap(controller.cancellableItems.first(where: { $0.id == "reminder-1" }))
        XCTAssertTrue(controller.selectCancellationItem(reminder))
        let selection = ChecklistCancellationSelection(
            itemID: reminder.id,
            label: reminder.label,
            checklistRevision: 1,
            cancellationRevision: 0
        )
        let cancellation = Task { await controller.cancelSelectedItem(selection: selection) }
        let heldDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < heldDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path))

        controller.cancelInFlight()
        _ = await cancellation.value
        XCTAssertEqual(controller.submission, .confirmed,
            "Interrupting a later cancellation must preserve the completed correction.")
        XCTAssertEqual(controller.cancellationSubmission, .uncertain)
        controller.cancelInFlight()
        XCTAssertEqual(controller.submission, .confirmed)
        XCTAssertEqual(controller.cancellationSubmission, .uncertain)
    }

    @MainActor
    func testConfirmedCancellationStaysConfirmedWhenCorrectionIsInterrupted() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let cancellationID = "123e4567-e89b-12d3-a456-426614174001"
        let correctionID = "123e4567-e89b-12d3-a456-426614174002"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":4,"items":[{"id":"lookup-1","label":"Find my flight"}],"cancellationEligible":true,"cancellationChecklistRevision":4,"cancellationRevision":1,"cancellableItems":[{"id":"lookup-1","label":"Find my flight","status":"pending"}]}"#
        var generatedIDs = [cancellationID, correctionID]
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            taskID: taskID,
            connectionIsCurrent: { true },
            operationIDFactory: { generatedIDs.removeFirst() }
        )
        let path = "/api/mobile/v1/activity/\(taskID)"
        defer {
            controller.dispose()
            StubURLProtocol.releaseHeldResponse(path: path)
        }
        StubURLProtocol.prime([
            .success(status: 200, body: Data(projection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true,"outcome":"cancelled","transitioned":true,"queueGeneration":5,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","checklistRevision":4,"cancellationRevision":2}"#.utf8)),
            .held(status: 200, body: Data()),
        ])
        await controller.load()
        let lookup = try XCTUnwrap(controller.cancellableItems.first)
        XCTAssertTrue(controller.selectCancellationItem(lookup))
        let cancellationResult = await controller.cancelSelectedItem(selection: .init(
            itemID: lookup.id,
            label: lookup.label,
            checklistRevision: 4,
            cancellationRevision: 1
        ))
        XCTAssertEqual(cancellationResult, .confirmed)

        controller.selectLookupItem(id: lookup.id)
        controller.updateDraft("Find my flight from Berlin")
        let correction = Task { await controller.submit() }
        let heldDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < heldDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path))

        controller.cancelInFlight()
        _ = await correction.value
        XCTAssertEqual(controller.cancellationSubmission, .confirmed,
            "Interrupting a later correction must preserve the completed cancellation.")
        XCTAssertEqual(controller.submission, .uncertain)
    }

    @MainActor
    func testInterruptedReloadPreservesBothConfirmedOperations() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let correctionID = "123e4567-e89b-12d3-a456-426614174001"
        let cancellationID = "123e4567-e89b-12d3-a456-426614174002"
        let firstProjection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight"}],"cancellationEligible":true,"cancellationChecklistRevision":0,"cancellationRevision":0,"cancellableItems":[{"id":"lookup-1","label":"Find my flight","status":"pending"},{"id":"reminder-1","label":"Remind me to pack","status":"pending"}]}"#
        let refreshedProjection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":1,"items":[{"id":"lookup-1","label":"Find my flight from Berlin"}],"cancellationEligible":true,"cancellationChecklistRevision":1,"cancellationRevision":0,"cancellableItems":[{"id":"lookup-1","label":"Find my flight from Berlin","status":"pending"},{"id":"reminder-1","label":"Remind me to pack","status":"pending"}]}"#
        var generatedIDs = [correctionID, cancellationID]
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(ownerID: "owner-a", connectionVersion: 1, client: makeClient()),
            taskID: taskID,
            connectionIsCurrent: { true },
            operationIDFactory: { generatedIDs.removeFirst() }
        )
        let path = "/api/mobile/v1/activity/\(taskID)"
        defer {
            controller.dispose()
            StubURLProtocol.releaseHeldResponse(path: path)
        }
        StubURLProtocol.prime([
            .success(status: 200, body: Data(firstProjection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true,"outcome":"corrected","transitioned":true,"queueGeneration":2,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174001","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"lookup-1","revision":1,"replacementLabel":"Find my flight from Berlin","replacementKind":"lookup"}"#.utf8)),
            .success(status: 200, body: Data(refreshedProjection.utf8)),
            .success(status: 200, body: Data(#"{"ok":true,"outcome":"cancelled","transitioned":true,"queueGeneration":3,"ownerMessageId":"123e4567-e89b-12d3-a456-426614174002","taskId":"123e4567-e89b-12d3-a456-426614174000","itemId":"reminder-1","checklistRevision":1,"cancellationRevision":1}"#.utf8)),
            .held(status: 200, body: Data(refreshedProjection.utf8)),
        ])
        await controller.load()
        controller.select(.init(id: "lookup-1", label: "Find my flight"))
        controller.updateDraft("Find my flight from Berlin")
        let correctionResult = await controller.submit()
        XCTAssertEqual(correctionResult, .confirmed)
        await controller.load()
        let reminder = try XCTUnwrap(controller.cancellableItems.first(where: { $0.id == "reminder-1" }))
        XCTAssertTrue(controller.selectCancellationItem(reminder))
        let cancellationResult = await controller.cancelSelectedItem(selection: .init(
            itemID: reminder.id,
            label: reminder.label,
            checklistRevision: 1,
            cancellationRevision: 0
        ))
        XCTAssertEqual(cancellationResult, .confirmed)

        let reload = Task { await controller.load() }
        let heldDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < heldDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path))

        controller.cancelInFlight()
        await reload.value
        XCTAssertEqual(controller.submission, .confirmed)
        XCTAssertEqual(controller.cancellationSubmission, .confirmed)
        XCTAssertEqual(controller.loadState, .unavailable)
    }

    @MainActor
    func testChecklistCorrectionOwnerTaskAndConnectionFencesPreventStalePublication() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let path = "/api/mobile/v1/activity/\(taskID)"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight"}]}"#
        var activeOwner = "owner-a"
        var activeVersion = 4
        let context = ChecklistCorrectionRequestContext(
            ownerID: "owner-a",
            connectionVersion: 4,
            client: makeClient()
        )
        let isCurrent: @MainActor () -> Bool = {
            activeOwner == context.ownerID && activeVersion == context.connectionVersion
        }

        StubURLProtocol.prime([])
        activeOwner = "owner-b"
        let replacementOwnerController = ChecklistCorrectionController(
            context: context,
            taskID: taskID,
            connectionIsCurrent: isCurrent
        )
        await replacementOwnerController.load()
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty, "A replaced owner cannot even read the saved correction projection.")
        replacementOwnerController.dispose()

        activeOwner = "owner-a"
        activeVersion += 1
        let replacementConnectionController = ChecklistCorrectionController(
            context: context,
            taskID: taskID,
            connectionIsCurrent: isCurrent
        )
        await replacementConnectionController.load()
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty, "A new connection version cannot use an old API client.")
        replacementConnectionController.dispose()

        activeVersion = context.connectionVersion
        StubURLProtocol.prime([.held(status: 200, body: Data(projection.utf8))])
        let controller = ChecklistCorrectionController(
            context: context,
            taskID: taskID,
            connectionIsCurrent: isCurrent
        )
        defer {
            controller.dispose()
            StubURLProtocol.releaseHeldResponse(path: path)
        }
        let loading = Task { await controller.load() }
        let heldDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < heldDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path), "The projection must be in flight before replacing its owner.")

        activeOwner = "owner-b"
        activeVersion += 1
        controller.dispose()
        StubURLProtocol.releaseHeldResponse(path: path)
        await loading.value

        XCTAssertNil(controller.projection)
        XCTAssertNil(controller.selectedItemID)
        XCTAssertEqual(controller.loadState, .loading)
        XCTAssertFalse(controller.isWorking)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])

        StubURLProtocol.prime([.success(status: 200, body: Data(
            #"{"id":"123e4567-e89b-12d3-a456-426614174001","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight"}]}"#.utf8
        ))])
        activeOwner = "owner-a"
        activeVersion = context.connectionVersion
        let wrongTaskController = ChecklistCorrectionController(
            context: context,
            taskID: taskID,
            connectionIsCurrent: isCurrent
        )
        await wrongTaskController.load()
        XCTAssertNil(wrongTaskController.projection)
        XCTAssertEqual(wrongTaskController.loadState, .unavailable,
            "A response for another task must not populate this task's selected item.")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        wrongTaskController.dispose()
    }

    @MainActor
    func testChecklistCorrectionTaskEligibilityFencesPendingPostAndPreservesManualRetry() async throws {
        let taskID = "123e4567-e89b-12d3-a456-426614174000"
        let path = "/api/mobile/v1/activity/\(taskID)"
        let projection = #"{"id":"123e4567-e89b-12d3-a456-426614174000","eligible":true,"revision":0,"items":[{"id":"lookup-1","label":"Find my flight"}]}"#
        StubURLProtocol.prime([.success(status: 200, body: Data(projection.utf8))])
        let controller = ChecklistCorrectionController(
            context: ChecklistCorrectionRequestContext(
                ownerID: "owner-a",
                connectionVersion: 1,
                client: makeClient()
            ),
            taskID: taskID,
            connectionIsCurrent: { true }
        )
        await controller.load()
        controller.select(.init(id: "lookup-1", label: "Find my flight"))
        controller.updateDraft("Find my flight from Berlin")

        StubURLProtocol.prime([.held(status: 200, body: Data())])
        let pending = Task { await controller.submit() }
        let heldDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < heldDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path), "The correction POST must be in flight before eligibility changes.")
        let operationID = try XCTUnwrap(controller.operationID)
        XCTAssertEqual(operationID, operationID.lowercased())

        controller.updateTaskEligibility(false)
        XCTAssertFalse(controller.canPublishResult)
        XCTAssertEqual(controller.submission, .uncertain)
        StubURLProtocol.releaseHeldResponse(path: path)
        let pendingResult = await pending.value
        XCTAssertEqual(pendingResult, .uncertain)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"], "An ineligible task cannot start reconciliation or another POST.")
        XCTAssertEqual(controller.operationID, operationID)
        XCTAssertEqual(controller.draft, "Find my flight from Berlin")

        let blockedRetry = await controller.submit()
        XCTAssertNil(blockedRetry, "A task that is no longer eligible must not send the saved attempt.")
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])

        controller.updateTaskEligibility(true)
        let receipt: [String: Any] = [
            "ok": true,
            "outcome": "already_applied",
            "transitioned": false,
            "queueGeneration": 2,
            "ownerMessageId": operationID,
            "taskId": taskID,
            "itemId": "lookup-1",
            "revision": 1,
            "replacementLabel": "Find my flight from Berlin",
            "replacementKind": "lookup",
        ]
        StubURLProtocol.prime([.success(
            status: 200,
            body: try JSONSerialization.data(withJSONObject: receipt)
        )])
        let confirmedRetry = await controller.submit()
        XCTAssertEqual(confirmedRetry, .confirmed)
        XCTAssertTrue(controller.canPublishResult)
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        let retry = try XCTUnwrap(StubURLProtocol.bodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: retry) as? [String: Any])
        XCTAssertEqual(payload["ownerMessageId"] as? String, operationID)
        controller.dispose()
    }
}

extension APIClientRetryTests {
    private func optimisticWorkspace(signature: String = "Original") -> Data {
        Data("""
        {"generatedAt":"2026-10-18T10:00:00Z","chats":{"current":[],"archived":[]},
        "memory":{"ownerName":"Owner","ownerContactId":"owner","health":{"totalUsable":0,"notYetOrganized":0,"awaitingReview":0,"ownerConfirmed":0},"facts":[],"awaitingReview":[],"peopleCount":0},
        "skills":[],"settings":{"agent":{"name":"Assistant","timezone":"UTC","locale":"en-US","signature":"\(signature)"},"schedules":[],"reminders":[],"policies":[],"goalAutomationCount":0},
        "costs":{"dailySpentUsd":0,"monthlySpentUsd":0,"heldUsd":0,"parkedTasks":0,"bySource":[],"byModel":[],"held":[],"topTasks":[],"recent":[]},"anomalies":[],"improvements":[]}
        """.utf8)
    }

    @MainActor
    func testSettingsSaveAcceptsUnder200msBeforeTheWriteResponds() async throws {
        StubURLProtocol.prime([.success(status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        let loaded = await model.refreshWorkspace()
        XCTAssertTrue(loaded)
        StubURLProtocol.prime([
            .delayed(after: 0.5, status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: optimisticWorkspace(signature: "Changed"))
        ])
        let started = ContinuousClock.now
        let accepted = await model.updateAgentSettings(.init(timezone: "UTC", locale: "en-US", signature: "Changed"))
        XCTAssertTrue(accepted)
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(200))
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Changed")
        XCTAssertEqual(model.edits.pendingCount, 1)
        await model.edits.settle()
        XCTAssertEqual(StubURLProtocol.attempts, ["PATCH", "GET"])
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Changed")
        XCTAssertTrue(model.edits.failures.isEmpty)
    }

    @MainActor
    func testRejectedSettingsSaveRollsBackAndKeepsDraftForRetry() async throws {
        StubURLProtocol.prime([.success(status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        _ = await model.refreshWorkspace()
        StubURLProtocol.prime([.delayed(after: 0.1, status: 400, body: Data(#"{"error":"Rejected"}"#.utf8))])
        let accepted = await model.updateAgentSettings(.init(timezone: "UTC", locale: "en-US", signature: "Draft wording"))
        XCTAssertTrue(accepted, "Acceptance means the app owns the pending edit, not that the server committed it")
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Draft wording")
        await model.edits.settle()
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Original")
        XCTAssertEqual(model.edits.failures.count, 1)
        XCTAssertTrue(model.edits.failures.first?.draft.contains("Draft wording") == true)
        XCTAssertEqual(StubURLProtocol.attempts, ["PATCH"], "A failed write must not be replayed automatically")
    }

    @MainActor
    func testConcurrentPageOpensShareTheWorkspaceRead() async throws {
        StubURLProtocol.prime([.delayed(after: 0.15, status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        async let first = model.refreshWorkspace()
        async let second = model.refreshWorkspace()
        let results = await [first, second]
        XCTAssertTrue(results.allSatisfy { $0 })
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    @MainActor
    func testCancelledPageReadStillWarmsCacheForTheNextPage() async throws {
        StubURLProtocol.prime([.delayed(after: 0.2, status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        let abandoned = Task { await model.refreshWorkspace() }
        try await Task.sleep(for: .milliseconds(30))
        abandoned.cancel()
        let opened = await model.refreshWorkspace()
        _ = await abandoned.value
        XCTAssertTrue(opened)
        XCTAssertNotNil(model.workspace)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        XCTAssertNil(model.errorMessage)
    }
}

extension APIClientRetryTests {
    @MainActor
    func testWorkspaceReadFromBeforeSaveCannotOverwriteTheConfirmedEdit() async throws {
        StubURLProtocol.prime([.success(status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        _ = await model.refreshWorkspace()
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/workspace": [
                .delayed(after: 0.4, status: 200, body: optimisticWorkspace()),
                .success(status: 200, body: optimisticWorkspace(signature: "Latest"))
            ],
            "/api/mobile/v1/settings": [.delayed(after: 0.1, status: 200, body: Data(#"{"ok":true}"#.utf8))]
        ])
        let stale = Task { await model.refreshWorkspace() }
        try await Task.sleep(for: .milliseconds(30))
        _ = await model.updateAgentSettings(.init(timezone: "UTC", locale: "en-US", signature: "Latest"))
        await model.edits.settle()
        let appliedStale = await stale.value
        XCTAssertFalse(appliedStale)
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Latest")
        XCTAssertEqual(StubURLProtocol.attempts.filter { $0 == "PATCH" }.count, 1)
        XCTAssertTrue(model.edits.failures.isEmpty)
    }
}

extension APIClientRetryTests {
    @MainActor
    func testSettingsSaveCommitsNativeFeedbackBeforeTheDelayedWriteFinishes() async throws {
        StubURLProtocol.prime([.success(status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        _ = await model.refreshWorkspace()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let host = UIHostingController(rootView:
            NavigationStack { MoreView() }
                .overlay(alignment: .bottom) { MobileSaveFeedback(store: model.edits).padding(.bottom, 24) }
                .environment(model)
                .transaction { $0.animation = nil; $0.disablesAnimations = true })
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(500))
        window.layoutIfNeeded()
        StubURLProtocol.prime([
            .delayed(after: 1.5, status: 200, body: Data(#"{"ok":true}"#.utf8)),
            .success(status: 200, body: optimisticWorkspace(signature: "Changed"))
        ])
        let started = ContinuousClock.now
        let accepted = await model.updateAgentSettings(.init(timezone: "UTC", locale: "en-US", signature: "Changed"))
        await Task.yield()
        window.layoutIfNeeded()
        window.layer.displayIfNeeded()
        CATransaction.flush()
        let elapsed = ContinuousClock.now - started
        XCTAssertTrue(accepted)
        XCTAssertEqual(model.edits.pendingCount, 1, "Native feedback must commit while the write is still pending")
        XCTAssertLessThan(elapsed, .milliseconds(200), "Native save feedback commit exceeded the interaction budget")
        // Screenshot readback and image allocation are evidence collection,
        // not work performed by a tap in the app. Time them separately.
        let captureStarted = ContinuousClock.now
        var rendered = false
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered)
        XCTAssertEqual(model.edits.pendingCount, 1)
        print("Native settings save acceptance and layer commit: \(elapsed); screenshot readback: \(ContinuousClock.now - captureStarted)")
        let attachment = XCTAttachment(image: image)
        attachment.name = "settings-save-before-backend-response"
        attachment.lifetime = .keepAlways
        add(attachment)
        await model.edits.settle()
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Changed")
        XCTAssertTrue(model.edits.failures.isEmpty)
    }
}

extension APIClientRetryTests {
    @MainActor
    func testMemoryLibraryRetainsABoundedSetOfRecentQueries() async throws {
        let body = try JSONEncoder().encode(MemoryLibraryResponse.empty)
        StubURLProtocol.prime(Array(repeating: .success(status: 200, body: body), count: 12))
        let model = AppModel(apiClient: makeClient())
        for page in 1...12 {
            var query = MemoryLibraryQuery()
            query.page = page
            let response = await model.memoryLibrary(query)
            XCTAssertNotNil(response)
        }
        XCTAssertEqual(model.edits.visible.memoryLibraries.count, 8)
        XCTAssertNil(model.cachedMemoryLibrary(MemoryLibraryQuery()))
        var latest = MemoryLibraryQuery()
        latest.page = 12
        XCTAssertNotNil(model.cachedMemoryLibrary(latest))
    }
}

extension APIClientRetryTests {
    @MainActor
    func testProviderPageReadSurvivesAnUnrelatedSettingsSave() async throws {
        StubURLProtocol.prime([.success(status: 200, body: optimisticWorkspace())])
        let model = AppModel(apiClient: makeClient())
        _ = await model.refreshWorkspace()
        let providers = ModelProviderSettings(connections: [], models: [], mainModel: "loaded", fastModel: nil, voiceModel: nil, voicePresets: [])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/providers": [.delayed(after: 0.15, status: 200, body: try JSONEncoder().encode(providers))],
            "/api/mobile/v1/settings": [.delayed(after: 0.5, status: 200, body: Data(#"{"ok":true}"#.utf8))],
            "/api/mobile/v1/workspace": [.success(status: 200, body: optimisticWorkspace(signature: "Changed"))]
        ])
        let pageRead = Task { await model.refreshModelProviders() }
        try await Task.sleep(for: .milliseconds(30))
        _ = await model.updateAgentSettings(.init(timezone: "UTC", locale: "en-US", signature: "Changed"))
        let loaded = await pageRead.value
        XCTAssertTrue(loaded, "An unrelated save must not discard a page that is opening")
        XCTAssertEqual(model.modelProviders?.mainModel, "loaded")
        XCTAssertEqual(model.edits.pendingCount, 1)
        await model.edits.settle()
        XCTAssertTrue(model.edits.failures.isEmpty)
    }
}

extension APIClientRetryTests {
    @MainActor
    func testReadFromBeforeMemoryErasureCannotRestoreTheLibraryCache() async throws {
        let query = MemoryLibraryQuery()
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/memory/library": [.delayed(after: 0.3, status: 200, body: try JSONEncoder().encode(MemoryLibraryResponse.empty))],
            "/api/mobile/v1/memory/profile": [.success(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            "/api/mobile/v1/workspace": [.success(status: 200, body: optimisticWorkspace())]
        ])
        let model = AppModel(apiClient: makeClient())
        let staleRead = Task { await model.memoryLibrary(query) }
        try await Task.sleep(for: .milliseconds(30))
        let erased = await model.forgetLongTermMemory()
        XCTAssertTrue(erased)
        let result = await staleRead.value
        XCTAssertNil(result)
        XCTAssertNil(model.cachedMemoryLibrary(query), "A pre-erasure response must not restore erased cached content")
    }
}

extension APIClientRetryTests {
    @MainActor
    func testVoiceReadFromBeforeSamplePurgeCannotRestoreCachedSamples() async throws {
        let path = "/api/mobile/v1/memory/profile"
        let old = VoiceProfileResponse(voiceStats: .init(total: 3, auto: 1, uploaded: 2), voiceProfile: .empty)
        StubURLProtocol.prime([], paths: [
            path: [.held(status: 200, body: try JSONEncoder().encode(old)),
                   .success(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            "/api/mobile/v1/workspace": [.success(status: 200, body: optimisticWorkspace())]
        ])
        let model = AppModel(apiClient: makeClient())
        let stale = Task { await model.voiceProfile() }
        let deadline = ContinuousClock.now + .seconds(2)
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path))
        let purged = await model.updateMemoryProfile(action: "purge-voice")
        XCTAssertTrue(purged)
        StubURLProtocol.releaseHeldResponse(path: path)
        let result = await stale.value
        XCTAssertNil(result, "A read started before the purge cannot restore old sample counts")
        XCTAssertNil(model.cachedVoiceProfile)
    }

    @MainActor
    func testMemoryErasureBlocksRetryOfAnEarlierFailedMemorySave() async throws {
        let path = "/api/mobile/v1/memory/profile"
        StubURLProtocol.prime([], paths: [
            path: [.held(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            "/api/mobile/v1/workspace": [.success(status: 200, body: optimisticWorkspace())]
        ])
        let model = AppModel(apiClient: makeClient())
        var writes = 0
        model.edits.submit(title: "Memory correction", resources: [.memory], patch: { _ in }) {
            writes += 1
            throw APIError.server(status: 400, message: "Rejected")
        }
        await model.edits.settle()
        let failureID = try XCTUnwrap(model.edits.failures.first?.id)
        let erasure = Task { await model.forgetLongTermMemory() }
        let deadline = ContinuousClock.now + .seconds(2)
        while !StubURLProtocol.isHoldingResponse(path: path), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: path))
        model.edits.retry(failureID)
        await model.edits.settle()
        XCTAssertEqual(writes, 1, "A retry cannot recreate memory while erasure is in flight")
        StubURLProtocol.releaseHeldResponse(path: path)
        let erased = await erasure.value
        XCTAssertTrue(erased)
        XCTAssertTrue(model.edits.failures.isEmpty)
    }
}

extension APIClientRetryTests {
    @MainActor
    func testDeletingPersonInvalidatesOtherDossiersWithStaleMergeOptions() async throws {
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/memory/people/removed": [.success(status: 200, body: Data(#"{"ok":true}"#.utf8))],
            "/api/mobile/v1/people": [.success(status: 200, body: Data(#"{"generatedAt":"now","people":[]}"#.utf8))],
            "/api/mobile/v1/workspace": [.success(status: 200, body: optimisticWorkspace())]
        ])
        let model = AppModel(apiClient: makeClient())
        model.edits.updateRemote { state in
            state.personProfiles["other"] = PersonProfileResponse(
                contact: .init(id: "other", name: "Other", aliases: [], relationship: "Friend", trust: "known"),
                occasions: [], mergeOptions: [.init(id: "removed", label: "Removed person")])
        }
        let accepted = await model.deletePerson(id: "removed")
        XCTAssertTrue(accepted)
        await model.edits.settle()
        XCTAssertNil(model.personProfiles["other"], "Deleting a person must invalidate cached references in other dossiers")
        XCTAssertTrue(model.edits.failures.isEmpty)
        XCTAssertEqual(StubURLProtocol.requests.filter { $0.0 == "DELETE" }.map { $0.1.path },
                       ["/api/mobile/v1/memory/people/removed"])
    }
}

extension APIClientRetryTests {
    private enum CalendarPreflightDraftEdit: Equatable {
        case none
        case followUp
        case pendingFollowUp
        case pendingWhitespace
        case sameTextWrite
        case deferredEmpty
    }

    private func calendarPreflightState(owner: String, generation: Int) -> PhoneCalendarSharingState {
        let now = Date()
        var ownerCalendar = Calendar(identifier: .gregorian)
        ownerCalendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let today = ownerCalendar.startOfDay(for: now)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let roster = [SharedPhoneCalendar(id: "work", name: "Work", purpose: .commitments, timeZone: nil)]
        return PhoneCalendarSharingState(
            version: 1, ownerId: owner, publisherId: "publisher-\(owner)", generation: generation,
            enabled: true, consentVersion: 1, calendars: roster,
            updatedAt: formatter.string(from: now), capturedAt: formatter.string(from: now),
            receivedAt: formatter.string(from: now),
            timeMin: formatter.string(from: ownerCalendar.date(byAdding: .day, value: -7, to: today)!),
            timeMax: formatter.string(from: ownerCalendar.date(byAdding: .day, value: 46, to: today)!),
            complete: true, truncated: false, mutationId: nil
        )
    }

    @MainActor
    func testCalendarPreflightPreservesComposerDraftAndRecoversSubmittedText() async throws {
        enum ReadOutcome: Equatable { case ready, fallback, bindingLost }

        func exercise(
            _ label: String,
            outcome: ReadOutcome,
            edit: CalendarPreflightDraftEdit,
            initialStoredDraft: String = "",
            initialLocalDraft: String? = nil,
            holdChatFailure: Bool = false
        ) async throws {
            let owner = "calendar-draft-\(UUID().uuidString.lowercased())"
            let pauseKey = "assistant.phoneCalendarSharing.permissionPause.\(phoneCalendarScope(owner: owner))"
            defer { UserDefaults.standard.removeObject(forKey: pauseKey) }
            let suiteName = "assistant.calendar-draft-tests.\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }

            let initialState = calendarPreflightState(owner: owner, generation: 1)
            let acknowledgedState = calendarPreflightState(owner: owner, generation: 2)
            let store = PhoneCalendarSharingMemoryRecordStore()
            let scopeKey = phoneCalendarScope(owner: owner)
            _ = store.save(.init(
                publisherId: "publisher-\(owner)", generation: 1,
                pendingMutation: nil, pendingRevocation: nil, lastRead: nil, lastState: initialState
            ), scope: scopeKey)
            let source = PhoneCalendarSharingFixtureSource()
            let coordinator = PhoneCalendarSharingCoordinator(source: source, recordStore: store)
            let client = makeClient()
            defer {
                StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
                StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat")
            }
            let chatFailure = Data(#"{"error":"Synthetic definite rejection"}"#.utf8)
            var calendarResponses: [StubURLProtocol.Outcome] = [
                .success(status: 200, body: try phoneCalendarRead(initialState, owner: owner)),
                .held(
                    status: outcome == .fallback ? 503 : 200,
                    body: outcome == .ready
                        ? try phoneCalendarRead(initialState, owner: owner)
                        : outcome == .bindingLost
                            ? try phoneCalendarRead(
                                calendarPreflightState(owner: "different-owner-\(owner)", generation: 1),
                                owner: "different-owner-\(owner)"
                            )
                            : Data(#"{"error":"Synthetic calendar read failure"}"#.utf8)
                )
            ]
            if outcome == .ready {
                calendarResponses.append(.success(
                    status: 200, body: try phoneCalendarMutation(acknowledgedState)
                ))
            }
            StubURLProtocol.prime([], paths: [
                "/api/mobile/v1/bootstrap": [.success(status: 200, body: try notificationBootstrap(owner: owner))],
                "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
                "/api/mobile/v1/calendars": calendarResponses,
                "/api/mobile/v1/chat": [
                    holdChatFailure ? .held(status: 400, body: chatFailure) : .success(status: 400, body: chatFailure)
                ]
            ])
            let model = AppModel(
                apiClient: client,
                defaults: defaults,
                storeConnectionToken: { _ in },
                scheduleLocalNotification: { _, _, _, _, _, _ in true },
                phoneCalendarSharing: coordinator
            )
            model.scenePhaseDidChange(.background)
            await model.refreshAll(reportFailure: false)
            XCTAssertEqual(model.bootstrap?.identity.id, owner, "\(label): AppModel must have the owner-bound session")
            await coordinator.refresh(client: client, expectedOwnerID: owner, publishIfEnabled: false)
            XCTAssertTrue(coordinator.matchesBinding(client: client, expectedOwnerID: owner), "\(label): fixture must establish the real verified calendar binding")

            let draftScope = try XCTUnwrap(model.composerDraftScope)
            if !initialStoredDraft.isEmpty { model.saveComposerDraft(initialStoredDraft, in: draftScope) }
            let origin = try XCTUnwrap(model.composerDraftSnapshot(in: draftScope))
            var editorText = initialLocalDraft ?? initialStoredDraft
            var editorSnapshot = origin
            var editorIsVisible = true
            var stagedSubmission: ComposerDraftSubmissionProvenance?
            let context = ComposerDraftSubmissionContext(origin: origin, localDraft: editorText)
            XCTAssertEqual(context.mayStageSubmittedText, editorText.isEmpty && origin.text.isEmpty,
                           "\(label): only an actually empty local and stored composer is eligible for staging")
            var clearCallbacks = 0
            var clearWasAdopted = false
            let submittedText = "Original calendar question: what is on Work tomorrow?"
            model.send(
                submittedText,
                composerDraftContext: context,
                onComposerDraftStage: { submission in
                    guard let current = model.composerDraftSnapshot(in: draftScope),
                          let captured = origin.capturingSubmissionStage(
                            submission,
                            current: current,
                            localDraft: editorText,
                            activeScope: model.composerDraftScope,
                            isVisible: editorIsVisible
                          ) else { return }
                    stagedSubmission = captured
                },
                onComposerDraftClear: { callbackOrigin, cleared in
                    clearCallbacks += 1
                    guard let current = model.composerDraftSnapshot(in: draftScope) else { return }
                    guard let adopted = editorSnapshot.adoptingSubmissionClear(
                        cleared,
                        from: callbackOrigin,
                        current: current,
                        localDraft: editorText,
                        activeScope: model.composerDraftScope,
                        isVisible: editorIsVisible
                    ), callbackOrigin == origin else { return }
                    editorSnapshot = adopted
                    editorText = adopted.text
                    clearWasAdopted = true
                }
            )
            try await waitForHeldCalendarRequest()
            XCTAssertTrue(model.isPreparingCalendarContext, "\(label): send must wait on the held calendar preflight")
            XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 0, "\(label): no chat POST may start before preflight settles")
            XCTAssertEqual(model.composerDraft(in: draftScope), context.mayStageSubmittedText ? submittedText : initialStoredDraft,
                           "\(label): the real model stages only an empty initiating composer")
            if context.mayStageSubmittedText {
                let staged = try XCTUnwrap(stagedSubmission, "\(label): the visible initiating composer captures the real staging provenance")
                XCTAssertEqual(staged.origin, origin)
                XCTAssertEqual(staged.staged, model.composerDraftSnapshot(in: draftScope))
                XCTAssertEqual(staged.staged.text, submittedText)
            } else {
                XCTAssertNil(stagedSubmission, "\(label): a nonempty initiating composer has no staging provenance")
            }
            let competingOrigin = try XCTUnwrap(model.composerDraftSnapshot(in: draftScope))
            var competingClearCallbacks = 0
            model.send("Competing submission while preflight is held", composerDraftContext: .init(
                origin: competingOrigin, localDraft: competingOrigin.text
            )) { _, _ in competingClearCallbacks += 1 }
            XCTAssertEqual(competingClearCallbacks, 0, "\(label): a rejected competing submission cannot receive the initiating clear callback")
            XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 0,
                           "\(label): the held preflight admits only its initiating POST")

            switch edit {
            case .none:
                break
            case .followUp:
                editorText = "Follow-up typed while the calendar read is pending"
                editorSnapshot = try XCTUnwrap(
                    model.saveComposerDraftChange(editorText, currentDraft: editorText, in: draftScope),
                    "\(label): current follow-up is accepted by the real composer onChange path"
                )
                if let stagedSubmission {
                    let lifecycleBase = origin.lifecycleFlushSnapshot(localDraft: editorText, submission: stagedSubmission)
                    XCTAssertEqual(lifecycleBase, stagedSubmission.staged)
                    let currentBeforeRejectedFlush = try XCTUnwrap(model.composerDraftSnapshot(in: draftScope))
                    XCTAssertNil(model.saveComposerDraft(editorText, in: draftScope, ifUnchangedFrom: lifecycleBase),
                                 "\(label): lifecycle flush cannot overwrite a newer stored edit")
                    XCTAssertEqual(try XCTUnwrap(model.composerDraftSnapshot(in: draftScope)), currentBeforeRejectedFlush,
                                   "\(label): a rejected lifecycle flush leaves the newer storage snapshot untouched")
                }
            case .pendingFollowUp, .pendingWhitespace:
                editorText = edit == .pendingWhitespace ? " \n" : "Follow-up typed before onChange while calendar is pending"
                // This is the ChatView disappearance path: the final editor
                // value is local but its ordinary onChange has not reached the
                // model, so the lifecycle flush owns the only write.
                editorIsVisible = false
                let lifecycleBase = origin.lifecycleFlushSnapshot(localDraft: editorText, submission: stagedSubmission)
                XCTAssertEqual(lifecycleBase, stagedSubmission?.staged,
                               "\(label): pending nonempty local text selects only its own staged snapshot")
                let flushed = try XCTUnwrap(
                    model.saveComposerDraft(editorText, in: draftScope, ifUnchangedFrom: lifecycleBase),
                    "\(label): the real lifecycle CAS persists a pending edit before preflight settles"
                )
                editorSnapshot = flushed
                XCTAssertEqual(flushed.text, editorText)
                XCTAssertNil(model.saveComposerDraft(editorText, in: draftScope, ifUnchangedFrom: lifecycleBase),
                             "\(label): the same stage token cannot flush twice")
            case .sameTextWrite:
                editorText = submittedText
                let sameTextWrite = try XCTUnwrap(
                    model.saveComposerDraftChange(submittedText, currentDraft: submittedText, in: draftScope),
                    "\(label): a same-text store write still advances the real snapshot revision"
                )
                editorSnapshot = sameTextWrite
                XCTAssertEqual(sameTextWrite.text, submittedText)
                let lifecycleBase = origin.lifecycleFlushSnapshot(localDraft: editorText, submission: stagedSubmission)
                XCTAssertNil(model.saveComposerDraft(editorText, in: draftScope, ifUnchangedFrom: lifecycleBase),
                             "\(label): a same-text newer write rejects the stale lifecycle token")
                XCTAssertEqual(try XCTUnwrap(model.composerDraftSnapshot(in: draftScope)), sameTextWrite,
                               "\(label): same-text CAS rejection leaves its newer revision untouched")
            case .deferredEmpty:
                // Models the composer onChange empty write arriving after send staged
                // the original text but before the held preflight returns.
                editorText = ""
                editorSnapshot = try XCTUnwrap(
                    model.saveComposerDraftChange(editorText, currentDraft: editorText, in: draftScope),
                    "\(label): current deferred empty write is accepted by the real composer onChange path"
                )
            }
            let draftAfterEdit = edit == .followUp ? editorText
                : edit == .pendingFollowUp || edit == .pendingWhitespace ? editorText
                : edit == .sameTextWrite ? submittedText
                : edit == .deferredEmpty ? ""
                : context.mayStageSubmittedText ? submittedText : initialStoredDraft
            XCTAssertEqual(model.composerDraft(in: draftScope), draftAfterEdit,
                           "\(label): the test edit reaches the real model draft store before preflight completes")
            let snapshotAfterEdit = try XCTUnwrap(model.composerDraftSnapshot(in: draftScope))

            StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/calendars")
            let preflightDeadline = ContinuousClock.now + .seconds(5)
            while model.isPreparingCalendarContext, ContinuousClock.now < preflightDeadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertFalse(model.isPreparingCalendarContext, "\(label): preflight must settle")

            if outcome == .bindingLost {
                XCTAssertFalse(coordinator.isOwnerVerified, "\(label): a valid read for a different owner clears the verified binding")
                XCTAssertEqual(model.composerDraftScope, draftScope, "\(label): losing the calendar binding must not reset the AppModel draft session")
                XCTAssertEqual(model.composerDraft(in: draftScope), draftAfterEdit,
                               "\(label): the early exit leaves the staged request or lifecycle-flushed edit intact")
                XCTAssertEqual(model.composerDraftSnapshot(in: draftScope), snapshotAfterEdit,
                               "\(label): owner-binding loss does not mutate the draft snapshot")
                XCTAssertEqual(clearCallbacks, 0, "\(label): no clear callback runs when coordinator identity is lost")
                XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 0,
                               "\(label): binding loss before readiness must not post the original message")
                XCTAssertEqual(StubURLProtocol.requests.filter { $0.1.path == "/api/mobile/v1/calendars" }.map { $0.0 },
                               ["GET", "GET"], "\(label): the public owner-verification refresh is the only preflight request")
                return
            }

            if edit == .none, let stagedSubmission {
                XCTAssertEqual(origin.lifecycleFlushSnapshot(localDraft: "", submission: stagedSubmission), origin,
                               "\(label): an untouched empty composer cannot use the staging token to flush submitted text")
                XCTAssertNil(model.saveComposerDraft("", in: draftScope, ifUnchangedFrom: origin),
                             "\(label): the untouched editor's origin is stale after staging and cannot clear the staged text")
            }

            if holdChatFailure {
                let chatDeadline = ContinuousClock.now + .seconds(3)
                while !StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat"), ContinuousClock.now < chatDeadline {
                    await Task.yield()
                }
                XCTAssertTrue(StubURLProtocol.isHoldingResponse(path: "/api/mobile/v1/chat"), "\(label): chat failure must be held after preflight has completed")
                XCTAssertEqual(clearCallbacks, 1, "\(label): the successful clear CAS reports once")
                XCTAssertTrue(clearWasAdopted, "\(label): the visible composer adopts the production clear snapshot")
                let clearSnapshot = try XCTUnwrap(model.composerDraftSnapshot(in: draftScope))
                XCTAssertEqual(clearSnapshot.text, "")
                // A delayed onChange of the already-empty editor may follow the
                // clear callback. It must not replace the submitted message or
                // the separately tracked recovery when the POST fails.
                if let saved = model.saveComposerDraftChange("", currentDraft: editorText, in: draftScope) {
                    editorSnapshot = saved
                }
                XCTAssertEqual(model.composerDraft(in: draftScope), "")
                XCTAssertNotEqual(editorSnapshot, clearSnapshot,
                                  "\(label): the late empty onChange is a distinct CAS revision even though its text matches")
                StubURLProtocol.releaseHeldResponse(path: "/api/mobile/v1/chat")
            }

            let settlementDeadline = ContinuousClock.now + .seconds(5)
            while model.isSending, ContinuousClock.now < settlementDeadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertFalse(model.isSending, "\(label): a definite 400 must settle without retry")
            XCTAssertEqual(StubURLProtocol.urls.filter { $0.path == "/api/mobile/v1/chat" }.count, 1, "\(label): the original message is posted exactly once")
            let chatIndex = try XCTUnwrap(StubURLProtocol.urls.firstIndex { $0.path == "/api/mobile/v1/chat" })
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies[chatIndex]) as? [String: Any])
            let messages = try XCTUnwrap(request["messages"] as? [[String: Any]])
            let parts = try XCTUnwrap(messages.first?["parts"] as? [[String: Any]])
            XCTAssertEqual(parts.first?["text"] as? String, submittedText, "\(label): draft changes cannot rewrite the in-flight request")
            XCTAssertEqual(model.messages.filter { $0.role == .user && $0.text == submittedText }.count, 1)
            XCTAssertTrue(model.hasComposerRecovery(in: draftScope), "\(label): recovery is retained in the real draft store")
            let expectedStoredAfterSettlement = edit == .followUp || edit == .pendingFollowUp || edit == .pendingWhitespace ? editorText
                : edit == .sameTextWrite ? submittedText
                : context.mayStageSubmittedText ? "" : initialStoredDraft
            XCTAssertEqual(model.composerDraft(in: draftScope), expectedStoredAfterSettlement,
                           "\(label): the in-flight turn preserves the current unrelated stored draft")
            XCTAssertEqual(clearCallbacks, origin.text.isEmpty && editorText.isEmpty && edit != .deferredEmpty ? 1 : 0,
                           "\(label): the callback is emitted only when the original empty snapshot was successfully cleared")
            if clearCallbacks > 0 {
                XCTAssertTrue(clearWasAdopted, "\(label): the app-level callback must pass the same visible-scope CAS adoption used by ChatView")
            }

            let recoverySnapshot = try XCTUnwrap(model.composerDraftSnapshot(in: draftScope))
            XCTAssertEqual(editorSnapshot.scope, recoverySnapshot.scope)
            XCTAssertEqual(editorSnapshot.revision, recoverySnapshot.revision,
                           "\(label): own-clear handoff or current edit must retain the actual draft revision")
            XCTAssertEqual(editorSnapshot.text, recoverySnapshot.text)
            if !editorIsVisible {
                // The test models the editor as gone after its lifecycle flush.
                // It checks AppModel recovery retention only; it does not claim
                // SwiftUI cannot deliver a queued onChange after onDisappear.
                XCTAssertTrue(model.hasComposerRecovery(in: draftScope),
                              "\(label): the failed submitted message remains recoverable after its editor disappears")
                XCTAssertEqual(model.composerDraft(in: draftScope), expectedStoredAfterSettlement,
                               "\(label): disappearance does not run a later visible-editor recovery adoption")
            } else {
                let adoptedRecovery = editorSnapshot.adoptingRecoverySnapshot(recoverySnapshot, localDraft: editorText)
                let shouldAdoptRecovery = editorText == recoverySnapshot.text
                XCTAssertEqual(adoptedRecovery != nil, shouldAdoptRecovery,
                               "\(label): real editor state adopts recovery only when its local text still matches the prior snapshot")
                let shouldRestoreRecovery = shouldAdoptRecovery
                    && editorText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if let adoptedRecovery {
                    editorSnapshot = adoptedRecovery
                    if let restored = model.restoreComposerRecovery(
                        in: draftScope, replacing: editorText, ifUnchangedFrom: adoptedRecovery
                    ) {
                        editorSnapshot = restored
                        editorText = restored.text
                        if let persisted = model.saveComposerDraftChange(editorText, currentDraft: editorText, in: draftScope) {
                            editorSnapshot = persisted
                        }
                    }
                }

                if shouldRestoreRecovery {
                    XCTAssertEqual(editorText, submittedText, "\(label): blank editor restores the failed message through the snapshot CAS")
                    XCTAssertEqual(model.composerDraft(in: draftScope), submittedText)
                    XCTAssertFalse(model.hasComposerRecovery(in: draftScope), "\(label): successful recovery restore consumes the saved copy once")
                    XCTAssertNil(model.restoreComposerRecovery(
                        in: draftScope, replacing: editorText, ifUnchangedFrom: editorSnapshot
                    ), "\(label): a consumed recovery cannot be restored twice")
                } else {
                    XCTAssertEqual(model.composerDraft(in: draftScope), expectedStoredAfterSettlement,
                                   "\(label): nonempty or stale local editor text is not overwritten by recovery")
                    XCTAssertTrue(model.hasComposerRecovery(in: draftScope), "\(label): rejected automatic restore keeps the recovery available")
                    XCTAssertEqual(model.composerDraftSnapshot(in: draftScope), recoverySnapshot)
                    if let initialLocalDraft {
                        XCTAssertEqual(editorText, initialLocalDraft)
                        let closed = try XCTUnwrap(model.saveComposerDraft(
                            editorText, in: draftScope, ifUnchangedFrom: editorSnapshot
                        ))
                        XCTAssertEqual(closed.text, initialLocalDraft)
                        XCTAssertEqual(closed.recoveryRevision, recoverySnapshot.recoveryRevision)
                        XCTAssertTrue(model.hasComposerRecovery(in: draftScope))
                    }
                }
            }
            if outcome == .ready {
                XCTAssertEqual(source.shareQueryCount, 1, "\(label): the ready path publishes using the synthetic EventKit source once")
                XCTAssertEqual(StubURLProtocol.requests.filter { $0.1.path == "/api/mobile/v1/calendars" }.map { $0.0 },
                               ["GET", "GET", "PUT"], "\(label): the ready preflight publishes its refreshed snapshot")
            } else {
                XCTAssertEqual(source.shareQueryCount, 0, "\(label): a failed read must not publish calendar contents")
                XCTAssertEqual(StubURLProtocol.requests.filter { $0.1.path == "/api/mobile/v1/calendars" }.map { $0.0 },
                               ["GET", "GET"], "\(label): failed preflight must not publish calendar contents")
            }
        }

        for outcome in [ReadOutcome.ready, .fallback] {
            try await exercise("\(outcome)-no-edit", outcome: outcome, edit: .none)
            try await exercise("\(outcome)-follow-up", outcome: outcome, edit: .followUp)
            try await exercise("\(outcome)-deferred-empty", outcome: outcome, edit: .deferredEmpty)
        }
        try await exercise("ready-after-completion-empty-write", outcome: .ready, edit: .none, holdChatFailure: true)
        try await exercise("ready-preset-nonempty", outcome: .ready, edit: .none,
                           initialStoredDraft: "Existing local draft")
        try await exercise("ready-pending-whitespace", outcome: .ready, edit: .none,
                           initialLocalDraft: "   \n")
        try await exercise("ready-pending-unsaved-follow-up", outcome: .ready, edit: .pendingFollowUp)
        try await exercise("ready-pending-unsaved-whitespace", outcome: .ready, edit: .pendingWhitespace)
        try await exercise("ready-same-text-concurrent-write", outcome: .ready, edit: .sameTextWrite)
        try await exercise("ready-binding-lost", outcome: .bindingLost, edit: .none)
        try await exercise("binding-lost-pending-unsaved-follow-up", outcome: .bindingLost, edit: .pendingFollowUp)
        try await exercise("binding-lost-pending-unsaved-whitespace", outcome: .bindingLost, edit: .pendingWhitespace)
    }
}
