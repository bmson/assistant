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
      result.presentation.detail.contains("Automatic sign-in is not available in Assistant"))
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
