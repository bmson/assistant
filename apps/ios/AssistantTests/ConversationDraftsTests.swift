import XCTest
import SwiftUI
@testable import Assistant

final class ConversationDraftsTests: XCTestCase {
    func testSwitchingChatsRestoresEachUnsentDraft() {
        var drafts = ConversationDrafts()
        let main = drafts.scope(conversationID: "main")
        let side = drafts.scope(conversationID: "side")
        drafts.save("Book a quiet hotel", in: main)
        drafts.save("Compare these dates", in: side)
        XCTAssertEqual(drafts.draft(in: main), "Book a quiet hotel")
        XCTAssertEqual(drafts.draft(in: side), "Compare these dates")
        drafts.save("", in: side)
        XCTAssertEqual(drafts.draft(in: side), "")
        XCTAssertEqual(drafts.draft(in: main), "Book a quiet hotel")
    }

    func testFailedSendNeverOverwritesAFollowUp() {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        drafts.preserveUnsent("The message that failed", in: scope)
        drafts.save("A follow-up I am still writing", in: scope)
        XCTAssertNil(drafts.restore(in: scope, replacing: drafts.draft(in: scope)))
        XCTAssertEqual(drafts.draft(in: scope), "A follow-up I am still writing")
        XCTAssertTrue(drafts.hasRecovery(in: scope))
        XCTAssertEqual(drafts.restore(in: scope, replacing: " \n"), "The message that failed")
        XCTAssertEqual(drafts.draft(in: scope), "The message that failed")
        XCTAssertFalse(drafts.hasRecovery(in: scope))
        XCTAssertNil(drafts.restore(in: scope, replacing: ""))
    }

    func testFailureRecoveryBelongsToItsConversation() {
        var drafts = ConversationDrafts()
        let main = drafts.scope(conversationID: "main")
        let side = drafts.scope(conversationID: "side")
        drafts.preserveUnsent("Unsent in main", in: main)
        XCTAssertNil(drafts.restore(in: side, replacing: ""))
        XCTAssertFalse(drafts.hasRecovery(in: side))
        XCTAssertEqual(drafts.restore(in: main, replacing: ""), "Unsent in main")
    }

    func testAccountChangeClearsDraftsAndRejectsDisappearingViews() {
        var drafts = ConversationDrafts()
        let old = drafts.scope(conversationID: "same-id")
        drafts.save("Private old account text", in: old)
        drafts.preserveUnsent("Private failed turn", in: old)
        drafts.reset()
        let current = drafts.scope(conversationID: "same-id")
        XCTAssertNotEqual(old, current)
        drafts.save("A delayed disappearing view", in: old)
        drafts.preserveUnsent("A delayed old failure", in: old)
        XCTAssertEqual(drafts.draft(in: current), "")
        XCTAssertEqual(drafts.draft(in: old), "")
        XCTAssertFalse(drafts.hasRecovery(in: current))
        XCTAssertNil(drafts.restore(in: old, replacing: ""))
        drafts.save("Current account text", in: current)
        XCTAssertEqual(drafts.draft(in: current), "Current account text")
    }

    func testDraftContentPreservesWhitespaceAndUnicode() {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let text = "  Halló 👋\n\nKeep my formatting.  "
        drafts.save(text, in: scope)
        XCTAssertEqual(drafts.draft(in: scope), text)
        drafts.preserveUnsent(text, in: scope)
        XCTAssertEqual(drafts.restore(in: scope, replacing: ""), text)
    }
}

extension ConversationDraftsTests {
    private func client() -> APIClient {
        let session = URLSessionConfiguration.ephemeral
        session.protocolClasses = [StubURLProtocol.self]
        return APIClient(configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: "test-token"),
            session: URLSession(configuration: session))
    }

    private func bootstrap(owner: String = "owner") throws -> Data {
        try JSONEncoder().encode(BootstrapResponse(generatedAt: "2026-10-03T00:00:00Z",
            identity: .init(id: owner, name: "Ada", avatarUrl: nil),
            shell: .init(dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
                memoryHealth: .init(totalUsable: 0, notYetOrganized: 0, awaitingReview: 0, ownerConfirmed: 0, lastOrganizedAt: nil)),
            conversation: .init(conversation: .init(id: "primary", title: "Main", modelOverride: nil,
                archivedAt: nil, isPrimary: true), agentName: "Ada", agentTimezone: "UTC", messages: [],
                models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)))
    }

    /// Each case owns its defaults and an in-memory credential sink. None of
    /// these pairing regressions reads or writes an owner's saved credentials.
    @MainActor
    private func pairedModel(tokenWriter: @escaping (String) throws -> Void = { _ in }) async throws -> (AppModel, UserDefaults, String) {
        let suite = "assistant.tests.pairing.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("https://assistant.test", forKey: "assistant.server-url")
        defaults.set(true, forKey: "assistant.push-prompted")
        let model = AppModel(apiClient: client(), defaults: defaults, storeConnectionToken: tokenWriter)
        model.scenePhaseDidChange(.background)
        StubURLProtocol.primeBootstrap(try bootstrap())
        await model.refreshAll(reportFailure: false)
        XCTAssertNotNil(model.bootstrap)
        return (model, defaults, suite)
    }

    @MainActor
    func testFailedPairingKeepsWorkingOwnerDraftAndSavedConnection() async throws {
        var writes = 0
        let (model, defaults, suite) = try await pairedModel { _ in writes += 1 }
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Stay in this account", in: scope)
        StubURLProtocol.prime([.success(status: 401, body: Data(#"{"error":"Invalid key"}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://candidate.test", token: "candidate-token")
        XCTAssertFalse(saved)
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(model.bootstrap?.identity.id, "owner")
        XCTAssertEqual(model.serverURL, "https://assistant.test")
        XCTAssertEqual(defaults.string(forKey: "assistant.server-url"), "https://assistant.test")
        XCTAssertEqual(model.composerDraftScope, scope)
        XCTAssertEqual(model.composerDraft(in: scope), "Stay in this account")
        XCTAssertEqual(StubURLProtocol.urls.first?.host, "candidate.test")
    }

    @MainActor
    func testVerifiedSameConnectionKeepsDraftSession() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Keep this draft", in: scope)
        StubURLProtocol.prime([.success(status: 200, body: try bootstrap()), .success(status: 401, body: Data()),
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://assistant.test/", token: "test-token")
        XCTAssertTrue(saved, "A supplementary overview failure must not reject verified pairing")
        XCTAssertEqual(model.composerDraftScope, scope)
        XCTAssertEqual(model.composerDraft(in: scope), "Keep this draft")
    }

    @MainActor
    func testVerifiedNewOwnerClearsPrivateDraftsEvenWithTheSameConversationID() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Old owner text", in: scope)
        StubURLProtocol.prime([.success(status: 200, body: try bootstrap(owner: "new-owner")),
            .success(status: 401, body: Data()), .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://candidate.test", token: "candidate-token")
        XCTAssertTrue(saved)
        let current = try XCTUnwrap(model.composerDraftScope)
        XCTAssertNotEqual(current.session, scope.session)
        XCTAssertEqual(model.bootstrap?.identity.id, "new-owner")
        XCTAssertEqual(model.composerDraft(in: current), "")
        model.saveComposerDraft("Late old view", in: scope)
        XCTAssertEqual(model.composerDraft(in: current), "")
    }

    @MainActor
    func testCancelledConnectClearsItsOwnLoadingIndicator() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/bootstrap": [.delayed(after: 0.2, status: 200, body: try bootstrap())],
            "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
        ])
        let connect = Task { await model.connect() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while StubURLProtocol.attempts.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(model.isLoading)
        connect.cancel()
        await connect.value
        XCTAssertFalse(model.isLoading)
        XCTAssertEqual(model.bootstrap?.identity.id, "owner")
    }

    @MainActor
    func testOldConnectionReadCannotPublishIntoNewOwner() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        let old = McpConnectionsResponse(connections: [.init(id: "old-tool", name: "Old private tools",
            endpoint: "https://old-tools.test", status: "ready", enabled: true, hasBearerToken: false,
            serverName: nil, serverVersion: nil, instructions: nil, tools: [], lastCheckedAt: nil, lastError: nil)])
        StubURLProtocol.prime([.delayed(after: 0.2, status: 200, body: try JSONEncoder().encode(old))])
        let refresh = Task { await model.refreshMcpConnections() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while StubURLProtocol.attempts.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/mcp")
        StubURLProtocol.prime([.success(status: 200, body: try bootstrap(owner: "new-owner")),
            .success(status: 401, body: Data()), .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://candidate.test", token: "candidate-token")
        XCTAssertTrue(saved)
        let published = await refresh.value
        XCTAssertFalse(published)
        XCTAssertEqual(model.bootstrap?.identity.id, "new-owner")
        XCTAssertTrue(model.mcpConnections.isEmpty, "A delayed old account read must not populate the new owner's tools")
    }
}
