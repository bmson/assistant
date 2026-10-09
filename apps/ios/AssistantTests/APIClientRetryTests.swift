import XCTest
import SwiftUI
import Observation
import CoreLocation
@testable import Assistant

/// Stands in for the network so a dead pooled connection can be reproduced
/// deterministically. Each queued outcome is consumed by one request, so a test
/// says exactly what the first attempt and the retry each see.
final class StubURLProtocol: URLProtocol {
    enum Outcome {
        case failure(URLError)
        case success(status: Int, body: Data)
        /// Answers after `delay`, to stand in for a slow endpoint.
        case delayed(after: TimeInterval, status: Int, body: Data)
        case stream(body: Data)
        case taskStream(body: Data, taskId: String)
        case operationCancellation(status: Int, outcome: String)
        case terminalOperationCancellation(status: Int, outcome: String, taskId: String, taskStatus: String, transitioned: Bool?)
        case delayedOperationCancellation(after: TimeInterval, status: Int, outcome: String)
        case delayedChatCancelledBeforeAdmission(after: TimeInterval)
    }

    private static let lock = NSLock()
    private static var outcomes: [Outcome] = []
    private static var pathOutcomes: [String: [Outcome]] = [:]
    private static var recordedMethods: [String] = []
    private static var recordedURLs: [URL] = []
    private static var recordedBodies: [Data] = []
    private static var recordedHeaders: [[String: String]] = []
    private static weak var activeStream: StubURLProtocol?
    private static var streamsByOperation: [String: StubURLProtocol] = [:]

    static func prime(_ queued: [Outcome], paths: [String: [Outcome]] = [:]) {
        lock.withLock {
            outcomes = queued
            pathOutcomes = paths
            recordedMethods = []
            recordedURLs = []
            recordedBodies = []
            recordedHeaders = []
            activeStream = nil
            streamsByOperation = [:]
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

    static func appendStream(_ body: Data, operationId: String? = nil) {
        let stream = lock.withLock {
            operationId.flatMap { streamsByOperation[$0] } ?? activeStream
        }
        guard let stream else { return }
        stream.client?.urlProtocol(stream, didLoad: body)
    }

    private static func rememberStream(_ stream: StubURLProtocol, requestBody: Data) {
        lock.withLock {
            activeStream = stream
            if let object = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any],
               let operationId = object["clientOperationId"] as? String {
                streamsByOperation[operationId] = stream
            }
        }
    }

    private static func next(for method: String, url: URL?, body: Data, headers: [String: String]) -> Outcome {
        lock.withLock {
            recordedMethods.append(method)
            if let url { recordedURLs.append(url) }
            recordedBodies.append(body)
            recordedHeaders.append(headers)
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
    override func stopLoading() { stopped.withLock { isStopped = true } }

    private func respond(status: Int, body: Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let requestBody = Self.body(of: request)
        switch Self.next(
            for: method,
            url: request.url,
            body: requestBody,
            headers: request.allHTTPHeaderFields ?? [:]
        ) {
        case let .failure(error):
            client?.urlProtocol(self, didFailWithError: error)
        case let .stream(body):
            Self.rememberStream(self, requestBody: requestBody)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["content-type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            // Remain open so the test can deliver later tokens while sending.
        case let .taskStream(body, taskId):
            Self.rememberStream(self, requestBody: requestBody)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: [
                    "content-type": "text/event-stream", "x-async-task": taskId,
                ])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
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
        case let .delayed(delay, status, body):
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
                guard !stopped.withLock({ isStopped }) else { return }
                respond(status: status, body: body)
            }
        }
    }
}

final class APIClientRetryTests: XCTestCase {
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
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/activity": [.success(status: 200, body: Data(#"{"items":[],"archivedCount":0}"#.utf8))],
        ])
        let cursor = "opaque+/=& cursor"
        let result = try await makeClient().activity(archived: true, query: "owner & older?", filter: "completed", cursor: cursor)
        let url = try XCTUnwrap(StubURLProtocol.urls.first)
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

    func testWorkspaceAdvertisesTypedSectionAvailability() async {
        StubURLProtocol.prime([.success(status: 200, body: Data("{}".utf8))])
        _ = try? await makeClient().workspace()

        let headers = StubURLProtocol.headers.first ?? [:]
        XCTAssertEqual(
            headers.first(where: { $0.key.caseInsensitiveCompare("x-assistant-workspace-sections") == .orderedSame })?.value,
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
        let model = AppModel(apiClient: makeClient())
        for hasExistingError in [false, true] {
            if hasExistingError {
                model.reportError(APIError.transport(URLError(.notConnectedToInternet)), retry: {})
            }
            let original = model.errorMessage
            let notice = model.errorNotice
            for read in 0..<4 {
                // A cancelled bootstrap can end the operation before the
                // parallel overview child starts. Every endpoint that did
                // start still makes one attempt and cannot trigger a retry.
                let requests = read == 0 ? 2 : 1
                StubURLProtocol.prime(Array(repeating: .failure(URLError(.cancelled)), count: requests))
                switch read {
                case 0: await model.refreshAll()
                case 1: await model.refreshOverview()
                case 2: await model.refreshWorkspace()
                default: _ = await model.knowledge()
                }
                XCTAssertTrue((1...requests).contains(StubURLProtocol.attempts.count))
                XCTAssertTrue(StubURLProtocol.attempts.allSatisfy { $0 == "GET" })
                XCTAssertEqual(Set(StubURLProtocol.urls.map(\.path)).count, StubURLProtocol.attempts.count,
                    "Cancellation must not trigger a second attempt for an endpoint")
                if read == 0 {
                    XCTAssertTrue(Set(StubURLProtocol.urls.map(\.path)).isSubset(of:
                        ["/api/mobile/v1/bootstrap", "/api/mobile/v1/overview"]))
                }
                XCTAssertEqual(model.errorMessage, original)
                XCTAssertEqual(model.errorNotice, notice)
                XCTAssertEqual(model.errorRetry != nil, hasExistingError)
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
        try await Task.sleep(for: .milliseconds(400))
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }
            .first { !($0 is UITextView) })
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
            try await Task.sleep(for: .milliseconds(150))
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

    private func makeClient(clientID: String? = nil) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: "t"),
            session: URLSession(configuration: configuration),
            clientID: clientID
        )
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
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/knowledge/cleanup": [.failure(URLError(.unsupportedURL))],
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected the error to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
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

    private func notificationBootstrap() throws -> Data {
        try JSONEncoder().encode(BootstrapResponse(generatedAt: "2026-10-03T00:00:00Z",
            identity: .init(id: notificationOwner, name: "Ada", avatarUrl: nil),
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
        enqueueAutomaticSpeech: ((ChatMessage) -> Void)? = nil
    ) async throws -> AppModel {
        let model: AppModel
        if let enqueueAutomaticSpeech {
            model = AppModel(apiClient: makeClient(), enqueueAutomaticSpeech: enqueueAutomaticSpeech)
        } else {
            model = AppModel(apiClient: makeClient())
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
    func testStopRequestsServerCancellationAndWaitsForMatchingTaskStatus() async throws {
        let model = try await notificationModel()
        let working = ChatUpdates(taskStatus: "working", messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: [])
        let cancelled = ChatUpdates(taskStatus: "cancelled", messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: [])
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.taskStream(body: Data("data: [DONE]\n\n".utf8), taskId: "task-stop-1")],
            "/api/mobile/v1/chat/status": [
                .delayed(after: 0.08, status: 200, body: try JSONEncoder().encode(working)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
                .success(status: 200, body: try JSONEncoder().encode(cancelled)),
            ],
            "/api/mobile/v1/activity/task-stop-1": [
                .success(status: 200, body: Data(#"{"ok":true,"cancelled":true,"effectStatus":"unknown"}"#.utf8)),
            ],
        ])
        model.send("Stop this turn")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat/status" }) {
            await Task.yield()
        }

        model.cancelSend()
        XCTAssertTrue(model.isCancellingSend)
        XCTAssertNotEqual(model.activityDetail, "You stopped this turn")
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/activity/task-stop-1" }) {
            await Task.yield()
        }
        for _ in 0..<1_000 where model.isSending { try await Task.sleep(for: .milliseconds(10)) }

        XCTAssertFalse(model.isSending)
        XCTAssertFalse(model.isCancellingSend)
        XCTAssertEqual(StubURLProtocol.urls.first(where: { $0.path == "/api/mobile/v1/activity/task-stop-1" })?.path,
                       "/api/mobile/v1/activity/task-stop-1")
        let body = try XCTUnwrap(StubURLProtocol.bodies.enumerated().first(where: {
            StubURLProtocol.urls[$0.offset].path == "/api/mobile/v1/activity/task-stop-1"
        })?.element)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["action": "cancel"])
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
        let client = makeClient(clientID: "33333333-3333-4333-8333-333333333333")
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
        StubURLProtocol.prime([], paths: ["/api/mobile/v1/chat": [.stream(body: Data())]])
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
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }) { await Task.yield() }
        XCTAssertEqual(StubURLProtocol.bodies.first, body)
        StubURLProtocol.appendStream(Data("data: [DONE]\n\n".utf8))
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
        StubURLProtocol.prime([
            .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(updates)),
            .success(status: 200, body: try JSONEncoder().encode(notificationConversation(notificationSideID))),
        ])
        // This separate task deliberately remains uncancelled. The result
        // fence must protect a changed thread even if cancellation loses.
        let heldRead = Task { await model.refreshIdleConversation() }
        while StubURLProtocol.attempts.isEmpty { await Task.yield() }
        await model.openNotificationDestination(try notificationDestination(conversation: notificationSideID, owner: notificationOwner))
        let changed = await heldRead.value
        XCTAssertNil(changed)
        XCTAssertEqual(model.conversationId, notificationSideID)
        XCTAssertFalse(model.messages.contains(where: { $0.id == oldReply.id }))

        let quiet = ChatUpdates(taskStatus: nil, messages: [], refreshed: [], superseded: nil,
            nextCursor: nil, hasMore: false, activity: [])
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(quiet))])
        let currentChanged = await model.refreshIdleConversation()
        XCTAssertEqual(currentChanged, false)
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(StubURLProtocol.urls.first), resolvingAgainstBaseURL: false))
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
            let model = try await notificationModel()
            let outcomes: [StubURLProtocol.Outcome] = slowPhase == "write"
                ? [.delayed(after: 0.05, status: 200, body: Data(#"{"ok":true}"#.utf8)), .stream(body: Data())]
                : [.success(status: 200, body: Data(#"{"ok":true}"#.utf8)),
                   .delayed(after: 0.05, status: 200, body: try JSONEncoder().encode(notificationConversation(notificationPrimaryID))),
                   .stream(body: Data())]
            StubURLProtocol.prime(outcomes)
            let changing = Task { await model.changeConversationModel("candidate-model") }
            while StubURLProtocol.attempts.count < (slowPhase == "write" ? 1 : 2) { await Task.yield() }
            model.send("A new request while the picker is waiting")
            let changed = await changing.value
            XCTAssertFalse(changed)
            XCTAssertTrue(model.isSending)
            XCTAssertTrue(model.messages.contains(where: { $0.id.hasPrefix("stream-") }), "A late model refresh cannot throw away the new stream")
            XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "A new request while the picker is waiting" }))
            XCTAssertNil(model.errorMessage)
            model.cancelSend()
        }
    }

    @MainActor
    func testAReplyStartedDuringConversationOpeningOrCreationKeepsItsThread() async throws {
        for action in ["open", "create"] {
            for status in [200, 500] {
                let model = try await notificationModel()
                let body = status == 500 ? Data(#"{"error":"Request failed"}"#.utf8)
                    : action == "create" ? Data("{\"conversationId\":\"\(notificationSideID)\"}".utf8)
                    : try JSONEncoder().encode(notificationConversation(notificationSideID))
                StubURLProtocol.prime([.delayed(after: 0.05, status: status, body: body), .stream(body: Data())])
                let opening = Task {
                    action == "open" ? await model.openConversation(id: notificationSideID) : await model.createConversation()
                }
                while StubURLProtocol.attempts.isEmpty { await Task.yield() }
                model.send("Keep this reply in the original conversation")
                let opened = await opening.value
                XCTAssertFalse(opened)
                XCTAssertTrue(model.isSending)
                XCTAssertEqual(model.conversationId, notificationPrimaryID)
                XCTAssertTrue(model.messages.contains(where: { $0.id.hasPrefix("stream-") }))
                XCTAssertTrue(model.messages.contains(where: { $0.role == .user && $0.text == "Keep this reply in the original conversation" }))
                XCTAssertNil(model.errorMessage, "An older success or failure cannot interrupt the new reply")
                model.cancelSend()
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
            StubURLProtocol.primeBootstrap(try JSONEncoder().encode(replacement),
                overview: [.success(status: 401, body: Data()), .success(status: 401, body: Data())],
                queued: [.delayed(after: 0.05, status: 200, body: oldBody)])
            let mutation = Task {
                switch action {
                case "hide": await model.hideMessage(original)
                case "create": _ = await model.createConversation()
                default: _ = await model.changeConversationModel("candidate-model")
                }
            }
            while StubURLProtocol.attempts.isEmpty { await Task.yield() }
            await model.refreshAll(reportFailure: false)
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
}
