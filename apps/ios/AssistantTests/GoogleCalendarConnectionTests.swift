import AuthenticationServices
import XCTest
@testable import Assistant

@MainActor
final class GoogleCalendarConnectionTests: XCTestCase {
    private static let connected = GoogleCalendarStatus(configured: true, state: "connected",
        account: .init(subject: "subject", email: "owner@example.com"), capabilities: .init(calendarRead: true), flow: nil)

    private actor Service: GoogleCalendarConnectionService {
        var canonical: GoogleCalendarStatus
        var readsFail = false
        var cancelled: [String] = []
        var disconnects = 0
        var heldRead: CheckedContinuation<GoogleCalendarStatus, Error>?
        var hold = false
        var readStarted = false
        init(_ status: GoogleCalendarStatus) { canonical = status }
        func setFailure(_ value: Bool) { readsFail = value }
        func holdNextRead() { hold = true }
        func releaseRead() { heldRead?.resume(returning: canonical); heldRead = nil }
        func googleCalendarStatus(flowID: String?) async throws -> GoogleCalendarStatus {
            readStarted = true
            if hold {
                hold = false
                return try await withCheckedThrowingContinuation { heldRead = $0 }
            }
            if readsFail { throw URLError(.notConnectedToInternet) }
            if let flowID {
                return GoogleCalendarStatus(configured: canonical.configured, state: canonical.state,
                    account: canonical.account, capabilities: canonical.capabilities,
                    flow: .init(id: flowID, outcome: "cancelled", expiresAt: "2026-11-15T01:00:00Z"))
            }
            return canonical
        }
        func connectGoogleCalendar() async throws -> GoogleCalendarConnectResponse {
            .init(authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", flowId: "flow-id",
                  expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(300)))
        }
        func cancelGoogleCalendarFlow(id: String) async throws { cancelled.append(id) }
        func disconnectGoogleCalendar() async throws { disconnects += 1 }
    }

    private final class CancelledBrowser: GoogleCalendarWebAuthenticationSession {
        let completion: GoogleCalendarAuthenticationSession.Completion
        init(_ completion: @escaping GoogleCalendarAuthenticationSession.Completion) { self.completion = completion }
        func start() -> Bool {
            completion(nil, ASWebAuthenticationSessionError(.canceledLogin))
            return true
        }
        func cancel() {}
    }

    func testReadyRequiresCanonicalConnectedAccountAndReadGrant() {
        XCTAssertTrue(Self.connected.isReady)
        for status in [
            GoogleCalendarStatus(configured: true, state: "connected", account: nil, capabilities: .init(calendarRead: true), flow: nil),
            GoogleCalendarStatus(configured: true, state: "connected", account: Self.connected.account, capabilities: .init(calendarRead: false), flow: nil),
            GoogleCalendarStatus(configured: true, state: "reconnect_required", account: Self.connected.account, capabilities: .init(calendarRead: true), flow: nil),
            GoogleCalendarStatus(configured: true, state: "future_state", account: Self.connected.account, capabilities: .init(calendarRead: true), flow: nil)
        ] { XCTAssertFalse(status.isReady) }
    }

    func testChatRecoveryRequiresUnavailableProviderAndConfirmedAccountWithoutClaimingReady() {
        let unavailable = GoogleCalendarStatus(configured: true, state: "provider_unavailable",
            account: Self.connected.account, capabilities: .init(calendarRead: false), flow: nil)
        XCTAssertTrue(unavailable.canRetryCalendarInChat)
        XCTAssertFalse(unavailable.isReady)
        for status in [
            Self.connected,
            GoogleCalendarStatus(configured: true, state: "provider_unavailable", account: nil, capabilities: .init(calendarRead: false), flow: nil),
            GoogleCalendarStatus(configured: true, state: "provider_unavailable", account: .init(subject: " ", email: "owner@example.com"), capabilities: .init(calendarRead: false), flow: nil),
            GoogleCalendarStatus(configured: false, state: "provider_unavailable", account: Self.connected.account, capabilities: .init(calendarRead: false), flow: nil),
            GoogleCalendarStatus(configured: true, state: "reconnect_required", account: Self.connected.account, capabilities: .init(calendarRead: false), flow: nil)
        ] { XCTAssertFalse(status.canRetryCalendarInChat) }
    }

    func testCallbackRequiresSingleMatchingOpaqueFlowAndNoExtraPayload() {
        let response = GoogleCalendarConnectResponse(authorizationUrl: "https://example.com", flowId: "opaque", expiresAt: "2026-11-15T01:00:00.123Z")
        XCTAssertNotNil(response.expiry)
        XCTAssertTrue(response.matchesCallback(URL(string: "assistant-oauth://google-calendar/callback?flowId=opaque")!))
        for query in ["flowId=other", "flowId=opaque&flowId=opaque", "flowId=opaque&token=secret", "other=opaque", "flowId="] {
            XCTAssertFalse(response.matchesCallback(URL(string: "assistant-oauth://google-calendar/callback?\(query)")!))
        }
    }

    func testFailedStatusReadPreservesLastConfirmedAccount() async {
        let service = Service(Self.connected)
        let coordinator = GoogleCalendarConnectionCoordinator()
        coordinator.bind(service: service, isCurrent: { true })
        await coordinator.refresh()
        await service.setFailure(true)
        await coordinator.refresh()
        XCTAssertEqual(coordinator.status, Self.connected)
        XCTAssertTrue(coordinator.couldNotCheck)
    }

    func testCancelledReconnectCancelsOnlyMatchingFlowAndReadsCanonicalAccount() async {
        let service = Service(Self.connected)
        let authentication = GoogleCalendarAuthenticationSession { _, _, completion in CancelledBrowser(completion) }
        let coordinator = GoogleCalendarConnectionCoordinator(authentication: authentication)
        coordinator.bind(service: service, isCurrent: { true })
        await coordinator.refresh()
        await coordinator.connect(anchor: ASPresentationAnchor())
        XCTAssertEqual(coordinator.status, Self.connected)
        XCTAssertFalse(coordinator.isBusy)
        let cancelled = await service.cancelled
        let disconnects = await service.disconnects
        XCTAssertEqual(cancelled, ["flow-id"])
        XCTAssertEqual(disconnects, 0)
    }

    func testDisconnectDoesNotClaimConfirmationWhileUnavailableAccountRemains() async {
        let unavailable = GoogleCalendarStatus(configured: true, state: "provider_unavailable",
            account: Self.connected.account, capabilities: .init(calendarRead: false), flow: nil)
        let service = Service(unavailable)
        let coordinator = GoogleCalendarConnectionCoordinator()
        coordinator.bind(service: service, isCurrent: { true })
        await coordinator.refresh()
        await coordinator.disconnect()
        XCTAssertEqual(coordinator.status, unavailable)
        XCTAssertEqual(coordinator.notice, "Disconnection hasn’t been confirmed. Refresh to check again.")
        let disconnects = await service.disconnects
        XCTAssertEqual(disconnects, 1)
    }

    func testOwnerSwitchDiscardsAnEarlierServersStatus() async {
        let service = Service(Self.connected)
        await service.holdNextRead()
        let coordinator = GoogleCalendarConnectionCoordinator()
        coordinator.bind(service: service, isCurrent: { true })
        let pending = Task { await coordinator.refresh() }
        while !(await service.readStarted) { await Task.yield() }
        coordinator.bind(service: nil, isCurrent: { false })
        await service.releaseRead()
        await pending.value
        XCTAssertNil(coordinator.status)
        XCTAssertFalse(coordinator.isBusy)
    }

    func testTransportFailureDoesNotReplayConnectOrDisconnect() async {
        let testCaseID = UUID().uuidString
        StubURLProtocol.beginTestCase(testCaseID)
        defer { StubURLProtocol.endTestCase(testCaseID) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Assistant-Test-Case": testCaseID]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://assistant.example.com")!, token: "mobile-key"), session: session)
        StubURLProtocol.prime([.failure(URLError(.timedOut))])
        do { _ = try await client.connectGoogleCalendar(); XCTFail("Expected uncertain result") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/connections/google-calendar/connect")
        XCTAssertEqual(StubURLProtocol.headers.first?.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value, "Bearer mobile-key")
        StubURLProtocol.prime([.failure(URLError(.timedOut))])
        do { try await client.disconnectGoogleCalendar(); XCTFail("Expected uncertain result") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        XCTAssertEqual(StubURLProtocol.attempts, ["DELETE"])
    }
}
