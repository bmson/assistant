import XCTest

@testable import Assistant

@MainActor
final class McpSignInOptionsTests: XCTestCase {
  private func response(
    id: String = "connection-1", status: String = "supported",
    reason: String? = nil, authenticated: Bool = false,
    connectionSupported: Bool = false
  ) throws -> McpSignInOptionsResponse {
    let value: [String: Any] = [
      "connectionId": id, "status": status, "authenticated": authenticated,
      "oauthConnectionSupported": connectionSupported, "transportProtocolVersion": "2025-11-25",
      "resource": "https://tools.example.test/mcp", "reason": reason as Any? ?? NSNull(),
      "authorizationServers": [
        [
          "issuer": "https://auth.example.test/oauth", "pkceS256": true,
          "authorizationResponseIssuerRequired": false,
          "registration": [
            "preRegistration": "not_checked", "clientIdMetadataDocument": true,
            "dynamicClientRegistration": false,
          ],
        ]
      ],
    ]
    return try JSONDecoder().decode(
      McpSignInOptionsResponse.self, from: JSONSerialization.data(withJSONObject: value))
  }

  private actor Service: McpSignInOptionsService {
    let response: McpSignInOptionsResponse
    var calls: [String] = []
    var held: CheckedContinuation<McpSignInOptionsResponse, Error>?
    var hold = false
    init(_ response: McpSignInOptionsResponse) { self.response = response }
    func holdNext() { hold = true }
    func release() {
      held?.resume(returning: response)
      held = nil
    }
    func mcpSignInOptions(id: String) async throws -> McpSignInOptionsResponse {
      calls.append(id)
      if hold {
        hold = false
        return try await withCheckedThrowingContinuation { held = $0 }
      }
      return response
    }
  }

  func testDiagnosticNeverGrantsAuthenticationOrConnectionReadiness() throws {
    let result = try response()
    XCTAssertFalse(result.authenticated)
    XCTAssertFalse(result.oauthConnectionSupported)
    XCTAssertEqual(
      result.presentation, .supported(authorizationServers: ["https://auth.example.test/oauth"]))
    XCTAssertEqual(result.presentation.authorizationHosts, ["auth.example.test"])
    XCTAssertTrue(
      result.presentation.detail.contains("Checking setup doesn’t sign you in"))
    XCTAssertEqual(try response(authenticated: true).presentation, .unavailable)
    XCTAssertEqual(try response(connectionSupported: true).presentation, .unavailable)
    XCTAssertEqual(try response(status: "future-state").presentation, .unavailable)
  }

  func testUnsupportedFailureAndPausedAreSeparate() throws {
    XCTAssertEqual(try response(status: "unsupported").presentation, .unsupported)
    XCTAssertEqual(
      try response(status: "discovery_failed", reason: "deadline").presentation, .unavailable)
    XCTAssertEqual(
      try response(status: "unsupported", reason: "connection_disabled").presentation, .paused)
    XCTAssertTrue(McpSignInOptionsPresentation.unsupported.detail.contains("couldn’t validate"))
    XCTAssertTrue(McpSignInOptionsPresentation.paused.detail.contains("Enable this connection"))
  }

  func testReportedServerDoesNotExposeCredentialsQueriesOrNavigation() {
    let unsafe = McpSignInOptionsPresentation.supported(authorizationServers: [
      "https://user:secret@auth.example.test/oauth", "https://auth.example.test/oauth?code=private",
      "https://auth.example.test/#private", "http://auth.example.test",
    ])
    XCTAssertEqual(unsafe.authorizationHosts, [])
    let host = String(repeating: "long-host-", count: 15) + "example.test"
    XCTAssertEqual(
      McpSignInOptionsPresentation.supported(authorizationServers: ["https://\(host)/oauth"])
        .authorizationHosts, [host])
  }

  func testExplicitCheckPreventsDuplicateAndRechecksOnlyOnRequest() async throws {
    let service = Service(try response())
    await service.holdNext()
    let coordinator = McpSignInOptionsCoordinator()
    coordinator.bind(service: service, connectionID: "connection-1", isCurrent: { true })
    XCTAssertNil(coordinator.result)
    let pending = Task { await coordinator.check() }
    while await service.calls.isEmpty { await Task.yield() }
    await coordinator.check()
    let calls = await service.calls
    XCTAssertEqual(calls, ["connection-1"])
    await service.release()
    await pending.value
    XCTAssertFalse(coordinator.isChecking)
    XCTAssertNotNil(coordinator.result)
    await coordinator.check()
    let nextCalls = await service.calls
    XCTAssertEqual(nextCalls.count, 2)
  }

  func testUnboundRemovedOrChangedConnectionDiscardsLateResult() async throws {
    let service = Service(try response())
    await service.holdNext()
    let coordinator = McpSignInOptionsCoordinator()
    coordinator.bind(service: service, connectionID: "connection-1", isCurrent: { true })
    let pending = Task { await coordinator.check() }
    while await service.calls.isEmpty { await Task.yield() }
    coordinator.unbind()
    await service.release()
    await pending.value
    XCTAssertNil(coordinator.result)
    XCTAssertFalse(coordinator.isChecking)
  }

  func testWrongReturnedConnectionIsNotShownAsSupported() async throws {
    let service = Service(try response(id: "foreign-connection"))
    let coordinator = McpSignInOptionsCoordinator()
    coordinator.bind(service: service, connectionID: "connection-1", isCurrent: { true })
    await coordinator.check()
    XCTAssertEqual(coordinator.result, .unavailable)
  }

  func testOAuthConfirmationIsBoundToTheRequestedGrantGeneration() throws {
    let data = Data(
      """
      {"connectionId":"connection","signInAvailable":true,"grant":"authorized","grantGeneration":"newer"}
      """.utf8)
    let status = try JSONDecoder().decode(McpOAuthStatus.self, from: data)
    XCTAssertFalse(status.confirms(flowId: "attempt"))
    XCTAssertTrue(status.confirms(flowId: "newer"))
  }

  func testOAuthCapabilityIsOffOnOlderConnectionResponses() throws {
    let old = Data(#"{"connections":[]}"#.utf8)
    let current = Data(#"{"connections":[],"oauthConfigured":true}"#.utf8)
    XCTAssertNil(try JSONDecoder().decode(McpConnectionsResponse.self, from: old).oauthConfigured)
    XCTAssertEqual(
      try JSONDecoder().decode(McpConnectionsResponse.self, from: current).oauthConfigured, true)
  }

  func testTransportUsesOwnerCredentialAndFixedReadonlyRoute() async throws {
    let testID = UUID().uuidString
    StubURLProtocol.beginTestCase(testID)
    defer { StubURLProtocol.endTestCase(testID) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    config.httpAdditionalHeaders = ["X-Assistant-Test-Case": testID]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let client = APIClient(
      configuration: .init(
        baseURL: URL(string: "https://assistant.example.test")!, token: "mobile-test-key"),
      session: session)
    let value = try response()
    let data = try JSONSerialization.data(withJSONObject: [
      "connectionId": value.connectionId,
      "status": "discovery_failed", "authenticated": false, "oauthConnectionSupported": false,
      "transportProtocolVersion": "2025-11-25", "resource": NSNull(), "authorizationServers": [],
      "reason": "deadline",
    ])
    StubURLProtocol.prime([.success(status: 200, body: data)])
    let diagnostic = try await client.mcpSignInOptions(id: "connection-1")
    XCTAssertEqual(diagnostic.presentation, .unavailable)
    XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    XCTAssertEqual(
      StubURLProtocol.urls.first?.path, "/api/mobile/v1/mcp/connection-1/authorization")
    XCTAssertNil(StubURLProtocol.urls.first?.query)
    XCTAssertEqual(
      StubURLProtocol.headers.first?.first(where: {
        $0.key.caseInsensitiveCompare("authorization") == .orderedSame
      })?.value, "Bearer mobile-test-key")
  }
}

extension McpSignInOptionsTests {
  private func pendingConnection(
    endpoint: String = "https://tools.example.test/mcp", enabled: Bool = true,
    bearer: Bool = false, checked: String? = nil
  ) -> McpConnection {
    McpConnection(
      id: "connection-1", name: "Synthetic tools", endpoint: endpoint,
      status: "authorization_required", enabled: enabled, hasBearerToken: bearer,
      serverName: nil, serverVersion: nil, instructions: nil, tools: [], lastCheckedAt: checked,
      lastError: nil)
  }

  func testPendingStartCannotBeReplacedAndFailureReleasesOnlyItsTicket() throws {
    var store = McpPendingSignInStore()
    let scope = McpPendingSignInStore.Scope(ownerID: "owner", version: 1)
    let connection = McpPendingSignInStore.Connection(
      id: "connection", endpoint: "https://tools.example.test/mcp", hasBearerToken: false)
    let first = try XCTUnwrap(store.begin(connection, scope: scope))
    XCTAssertNil(
      store.begin(connection, scope: scope),
      "Navigation cannot start another POST while the first response is pending")
    XCTAssertTrue(store.isStarting(connection: connection, scope: scope))
    XCTAssertTrue(store.abandon(first, connection: connection, scope: scope))
    let second = try XCTUnwrap(store.begin(connection, scope: scope))
    XCTAssertFalse(store.abandon(first, connection: connection, scope: scope))
    XCTAssertTrue(store.record(UUID().uuidString, ticket: second, connection: connection, scope: scope))
  }

  func testStaleFlowClearAndLateStartCannotAlterNewerAttempt() throws {
    var store = McpPendingSignInStore()
    let scope = McpPendingSignInStore.Scope(ownerID: "owner", version: 1)
    let connection = McpPendingSignInStore.Connection(
      id: "connection", endpoint: "https://tools.example.test/mcp", hasBearerToken: false)
    let a = UUID().uuidString, b = UUID().uuidString
    let first = try XCTUnwrap(store.begin(connection, scope: scope))
    XCTAssertTrue(store.record(a, ticket: first, connection: connection, scope: scope))
    XCTAssertTrue(store.clear(a, connection: connection, scope: scope))
    let second = try XCTUnwrap(store.begin(connection, scope: scope))
    XCTAssertTrue(store.record(b, ticket: second, connection: connection, scope: scope))
    XCTAssertFalse(store.record(a, ticket: first, connection: connection, scope: scope))
    XCTAssertFalse(store.clear(a, connection: connection, scope: scope))
    XCTAssertEqual(store.flow(connection: connection, scope: scope), b)
  }

  func testScopeReplacementAndMeaningfulConnectionChangesRemoveAttemptsButRefreshDoesNot() throws {
    let scope = McpPendingSignInStore.Scope(ownerID: "owner", version: 1)
    let connection = McpPendingSignInStore.Connection(
      id: "connection-1", endpoint: "https://tools.example.test/mcp", hasBearerToken: false)
    for changed in [
      [], [pendingConnection(endpoint: "https://other.example.test/mcp")],
      [pendingConnection(enabled: false)], [pendingConnection(bearer: true)],
    ] {
      var store = McpPendingSignInStore()
      let ticket = try XCTUnwrap(store.begin(connection, scope: scope))
      let flow = UUID().uuidString
      XCTAssertTrue(store.record(flow, ticket: ticket, connection: connection, scope: scope))
      store.retain([pendingConnection(checked: "new-read-time")])
      XCTAssertEqual(store.flow(connection: connection, scope: scope), flow)
      store.retain(changed)
      XCTAssertNil(store.flow(connection: connection, scope: scope))
    }
    for replacement in [
      McpPendingSignInStore.Scope(ownerID: "other", version: 1), .init(ownerID: "owner", version: 2),
    ] {
      var store = McpPendingSignInStore()
      let ticket = try XCTUnwrap(store.begin(connection, scope: scope))
      XCTAssertTrue(store.record(UUID().uuidString, ticket: ticket, connection: connection, scope: scope))
      store.bind(replacement)
      XCTAssertNil(store.flow(connection: connection, scope: scope))
      XCTAssertFalse(store.record(UUID().uuidString, ticket: ticket, connection: connection, scope: scope))
    }
  }

  private actor RecoveryService: McpOAuthRecoveryService {
    var calls: [String] = []
    let flow: McpOAuthFlow?
    let status: McpOAuthStatus?
    init(flow: McpOAuthFlow?, status: McpOAuthStatus?) { self.flow = flow; self.status = status }
    func mcpOAuthFlow(id: String, flowId: String, cancel: Bool) async throws -> McpOAuthFlow {
      calls.append(cancel ? "DELETE flow" : "GET flow")
      guard let flow else { throw APIError.server(status: 404, message: "Not available") }
      return flow
    }
    func mcpOAuthStatus(id: String, verifyProvider: Bool) async throws -> McpOAuthStatus {
      calls.append(verifyProvider ? "provider verification" : "GET grant")
      guard let status else { throw APIError.server(status: 503, message: "Unavailable") }
      return status
    }
  }

  func testReopenUsesOnlyFlowAndGrantReadsAndPreservesPendingAttempt() async throws {
    let flowID = UUID().uuidString
    let service = RecoveryService(
      flow: .init(connectionId: "connection", flowId: flowID, outcome: .pending),
      status: .init(
        connectionId: "connection", signInAvailable: true, grant: .none, grantGeneration: nil,
        providerAvailable: nil))
    let result = try await McpOAuthRecovery.read(service, connectionID: "connection", flowID: flowID)
    XCTAssertEqual(result.outcome, .pending)
    XCTAssertFalse(result.flowUnavailable)
    let calls = await service.calls
    XCTAssertEqual(calls, ["GET flow", "GET grant"])
  }

  func testMissingFlowFallsBackToCanonicalGrantWithoutClaimingUnrelatedSuccess() async throws {
    let flowID = UUID().uuidString
    let service = RecoveryService(
      flow: nil,
      status: .init(
        connectionId: "connection", signInAvailable: true, grant: .authorized, grantGeneration: "different",
        providerAvailable: nil))
    let result = try await McpOAuthRecovery.read(service, connectionID: "connection", flowID: flowID)
    XCTAssertTrue(result.flowUnavailable)
    XCTAssertFalse(result.status.confirms(flowId: flowID))
    let calls = await service.calls
    XCTAssertEqual(calls, ["GET flow", "GET grant"])
  }

  func testFailedCanonicalReadDoesNotResolveAnUnavailableFlow() async {
    let service = RecoveryService(flow: nil, status: nil)
    do {
      _ = try await McpOAuthRecovery.read(service, connectionID: "connection", flowID: UUID().uuidString)
      XCTFail("Unavailable canonical state must remain unconfirmed")
    } catch {}
    let calls = await service.calls
    XCTAssertEqual(calls, ["GET flow", "GET grant"])
  }

  func testExplicitCurrentViewCancelStillSendsOneCancellationThenReadsGrant() async throws {
    let flowID = UUID().uuidString
    let service = RecoveryService(
      flow: .init(connectionId: "connection", flowId: flowID, outcome: .cancelled),
      status: .init(
        connectionId: "connection", signInAvailable: true, grant: .none, grantGeneration: nil,
        providerAvailable: nil))
    let result = try await McpOAuthRecovery.read(
      service, connectionID: "connection", flowID: flowID, cancel: true)
    XCTAssertEqual(result.outcome, .cancelled)
    let calls = await service.calls
    XCTAssertEqual(calls, ["DELETE flow", "GET grant"])
  }
}

extension McpSignInOptionsTests {
  private func pendingBootstrap(owner: String) throws -> Data {
    try JSONEncoder().encode(
      BootstrapResponse(
        generatedAt: "2026-11-19T00:00:00Z",
        identity: .init(id: owner, name: "Synthetic Assistant", avatarUrl: nil),
        shell: .init(
          dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
          memoryHealth: .init(
            totalUsable: 0, notYetOrganized: 0, awaitingReview: 0, ownerConfirmed: 0, lastOrganizedAt: nil)),
        conversation: .init(
          conversation: .init(
            id: UUID().uuidString, title: "Synthetic", modelOverride: nil, archivedAt: nil, isPrimary: true),
          agentName: "Synthetic Assistant", agentTimezone: "UTC", messages: [], models: [], goalTitle: nil,
          canArchive: false, cursor: nil, asyncTurn: nil)))
  }

  private func withPendingModel(_ work: (AppModel, APIClient) async throws -> Void) async throws {
    let testID = UUID().uuidString
    StubURLProtocol.beginTestCase(testID)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    config.httpAdditionalHeaders = ["X-Assistant-Test-Case": testID]
    let session = URLSession(configuration: config)
    let defaults = try XCTUnwrap(UserDefaults(suiteName: testID))
    defaults.set(true, forKey: "assistant.push-prompted")
    defer {
      session.invalidateAndCancel()
      StubURLProtocol.endTestCase(testID)
      defaults.removePersistentDomain(forName: testID)
    }
    let client = APIClient(
      configuration: .init(
        baseURL: try XCTUnwrap(URL(string: "https://assistant.example.test")), token: "synthetic-test-key"),
      session: session)
    let model = AppModel(
      apiClient: client, defaults: defaults, storeConnectionToken: { _ in }, enqueueAutomaticSpeech: { _ in },
      scheduleLocalNotification: { _, _, _, _, _, _ in false }, registerNotificationHandlers: { _ in })
    StubURLProtocol.primeBootstrap(try pendingBootstrap(owner: UUID().uuidString))
    await model.connect()
    XCTAssertNotNil(model.bootstrap)
    let list = try JSONEncoder().encode(
      McpConnectionsResponse(connections: [pendingConnection()], oauthConfigured: true))
    StubURLProtocol.prime([], paths: ["/api/mobile/v1/mcp": [.success(status: 200, body: list)]])
    let loaded = await model.refreshMcpConnections()
    XCTAssertTrue(loaded)
    try await work(model, client)
  }

  func testAppModelRetainsLateStartAcrossNavigationAndReadsAndClearsExactFlow() async throws {
    try await withPendingModel { model, client in
      let connection = try XCTUnwrap(model.mcpConnections.first)
      let original = try XCTUnwrap(model.mcpSignInOptionsRequestContext(for: connection))
      let ticket = try XCTUnwrap(model.beginMcpSignInAttempt(original))
      let reopened = try XCTUnwrap(model.mcpSignInOptionsRequestContext(for: connection))
      XCTAssertTrue(model.mcpSignInAttemptIsStarting(reopened))
      XCTAssertNil(
        model.beginMcpSignInAttempt(reopened), "A reappeared card cannot replace an in-flight POST")
      let revision = model.mcpSignInAttemptRevision
      let flow = UUID().uuidString
      XCTAssertTrue(model.retainMcpSignInFlow(flow, ticket: ticket, context: original))
      XCTAssertGreaterThan(
        model.mcpSignInAttemptRevision, revision, "The reappeared view observes the late flow")
      XCTAssertEqual(model.pendingMcpSignInFlow(for: reopened), flow)
      let flowData = Data(
        "{\"connectionId\":\"connection-1\",\"flowId\":\"\(flow)\",\"outcome\":\"expired\"}".utf8)
      let grantData = Data(
        "{\"connectionId\":\"connection-1\",\"signInAvailable\":true,\"grant\":\"none\"}".utf8)
      StubURLProtocol.prime(
        [],
        paths: [
          "/api/mobile/v1/mcp/connection-1/oauth/flow": [.success(status: 200, body: flowData)],
          "/api/mobile/v1/mcp/connection-1/oauth": [.success(status: 200, body: grantData)],
        ])
      let snapshot = try await McpOAuthRecovery.read(
        client, connectionID: connection.id, flowID: model.pendingMcpSignInFlow(for: reopened))
      XCTAssertEqual(snapshot.outcome, .expired)
      XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
      XCTAssertTrue(model.clearMcpSignInFlow(flow, context: reopened))
      XCTAssertNil(
        model.pendingMcpSignInFlow(for: reopened),
        "A terminal clear must not schedule a second grant read")
      XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
      let newerTicket = try XCTUnwrap(model.beginMcpSignInAttempt(reopened))
      let newerFlow = UUID().uuidString
      XCTAssertTrue(model.retainMcpSignInFlow(newerFlow, ticket: newerTicket, context: reopened))
      XCTAssertFalse(model.clearMcpSignInFlow(flow, context: original))
      XCTAssertEqual(model.pendingMcpSignInFlow(for: reopened), newerFlow)
    }
  }

  func testAppModelRefreshPreservesRoutineMetadataButRemovalAndSessionChangeClearAttempt() async throws {
    try await withPendingModel { model, _ in
      let connection = try XCTUnwrap(model.mcpConnections.first)
      let context = try XCTUnwrap(model.mcpSignInOptionsRequestContext(for: connection))
      let ticket = try XCTUnwrap(model.beginMcpSignInAttempt(context))
      let flow = UUID().uuidString
      XCTAssertTrue(model.retainMcpSignInFlow(flow, ticket: ticket, context: context))
      let refreshed = pendingConnection(checked: "later")
      let data = try JSONEncoder().encode(
        McpConnectionsResponse(connections: [refreshed], oauthConfigured: true))
      StubURLProtocol.prime([], paths: ["/api/mobile/v1/mcp": [.success(status: 200, body: data)]])
      _ = await model.refreshMcpConnections()
      let current = try XCTUnwrap(model.mcpSignInOptionsRequestContext(for: refreshed))
      XCTAssertEqual(model.pendingMcpSignInFlow(for: current), flow)
      XCTAssertFalse(
        model.mcpSignInOptionsConnectionIsCurrent(context),
        "A disappearing old view is fenced before cancellation")
      let empty = try JSONEncoder().encode(McpConnectionsResponse(connections: [], oauthConfigured: true))
      StubURLProtocol.prime([], paths: ["/api/mobile/v1/mcp": [.success(status: 200, body: empty)]])
      _ = await model.refreshMcpConnections()
      XCTAssertNil(model.pendingMcpSignInFlow(for: current))
      StubURLProtocol.prime([], paths: ["/api/mobile/v1/mcp": [.success(status: 200, body: data)]])
      _ = await model.refreshMcpConnections()
      let restored = try XCTUnwrap(model.mcpSignInOptionsRequestContext(for: refreshed))
      XCTAssertNil(
        model.pendingMcpSignInFlow(for: restored), "Re-adding the same ID cannot restore removed state")
      let replacementTicket = try XCTUnwrap(model.beginMcpSignInAttempt(restored))
      XCTAssertTrue(
        model.retainMcpSignInFlow(UUID().uuidString, ticket: replacementTicket, context: restored))
      StubURLProtocol.primeBootstrap(try pendingBootstrap(owner: UUID().uuidString))
      await model.connect()
      XCTAssertNil(model.pendingMcpSignInFlow(for: restored))
      XCTAssertFalse(model.retainMcpSignInFlow(flow, ticket: replacementTicket, context: restored))
    }
  }
}

extension McpSignInOptionsTests {
  func testDisconnectConfirmationRejectsStartingNewFlowAndReplacedViewOrAccount() throws {
    let client = APIClient(
      configuration: .init(
        baseURL: try XCTUnwrap(URL(string: "https://assistant.example.test")), token: "synthetic"))
    let identity = McpSignInOptionsIdentity(pendingConnection())
    let context = McpSignInOptionsRequestContext(
      ownerID: "owner", version: 1, identity: identity, client: client)
    let generation = UUID()
    let intent = McpOAuthDisconnectIntent(
      ownerID: "owner", version: 1, identity: identity, viewGeneration: generation, grantGeneration: "grant-A"
    )
    XCTAssertTrue(
      intent.matches(
        context, viewGeneration: generation, grantGeneration: "grant-A", starting: false, pendingFlow: nil))
    XCTAssertFalse(
      intent.matches(
        context, viewGeneration: generation, grantGeneration: "grant-A", starting: true, pendingFlow: nil))
    XCTAssertFalse(
      intent.matches(
        context, viewGeneration: generation, grantGeneration: "grant-A", starting: false,
        pendingFlow: "new-flow"))
    XCTAssertFalse(
      intent.matches(
        context, viewGeneration: generation, grantGeneration: "grant-B", starting: false, pendingFlow: nil))
    XCTAssertFalse(
      intent.matches(
        context, viewGeneration: UUID(), grantGeneration: "grant-A", starting: false, pendingFlow: nil))
    let otherOwner = McpSignInOptionsRequestContext(
      ownerID: "other", version: 1, identity: identity, client: client)
    XCTAssertFalse(
      intent.matches(
        otherOwner, viewGeneration: generation, grantGeneration: "grant-A", starting: false, pendingFlow: nil)
    )
    let otherSession = McpSignInOptionsRequestContext(
      ownerID: "owner", version: 2, identity: identity, client: client)
    XCTAssertFalse(
      intent.matches(
        otherSession, viewGeneration: generation, grantGeneration: "grant-A", starting: false,
        pendingFlow: nil))
  }
}
