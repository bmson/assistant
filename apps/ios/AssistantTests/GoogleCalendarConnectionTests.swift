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
        var connects = 0
        var upgrades = 0
        var flowOutcome = "cancelled"
        var canonicalAfterFlow: GoogleCalendarStatus?
        var heldRead: CheckedContinuation<GoogleCalendarStatus, Error>?
        var hold = false
        var readStarted = false
        init(_ status: GoogleCalendarStatus) { canonical = status }
        func setFailure(_ value: Bool) { readsFail = value }
        func setFlow(outcome: String, canonical: GoogleCalendarStatus? = nil) {
            flowOutcome = outcome
            canonicalAfterFlow = canonical
        }
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
                if let canonicalAfterFlow { canonical = canonicalAfterFlow }
                return GoogleCalendarStatus(configured: canonical.configured, state: canonical.state,
                    account: canonical.account, capabilities: canonical.capabilities,
                    flow: .init(id: flowID, outcome: flowOutcome, expiresAt: "2026-11-15T01:00:00Z"),
                    connectionId: canonical.connectionId)
            }
            return canonical
        }
        func connectGoogleCalendar() async throws -> GoogleCalendarConnectResponse {
            connects += 1
            return .init(authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", flowId: "flow-id",
                  expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(300)))
        }
        func upgradeGoogleCalendarWriteAccess() async throws -> GoogleCalendarConnectResponse {
            upgrades += 1
            return .init(authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", flowId: "flow-id",
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

    private static func writeStatus(write: Bool? = false, connectionID: String? = "connection-1",
                                    account: GoogleCalendarStatus.Account? = connected.account,
                                    state: String = "connected") -> GoogleCalendarStatus {
        .init(configured: true, state: state, account: account,
              capabilities: .init(calendarRead: true, calendarWrite: write), flow: nil, connectionId: connectionID)
    }

    private final class CompletedBrowser: GoogleCalendarWebAuthenticationSession {
        let completion: GoogleCalendarAuthenticationSession.Completion
        init(_ completion: @escaping GoogleCalendarAuthenticationSession.Completion) { self.completion = completion }
        func start() -> Bool {
            completion(URL(string: "assistant-oauth://google-calendar/callback?flowId=flow-id")!, nil)
            return true
        }
        func cancel() {}
    }

    func testOlderServerDecodesWithoutOfferingWriteUpgrade() throws {
        let data = Data(#"{"configured":true,"state":"connected","account":{"subject":"subject","email":"owner@example.com"},"capabilities":{"calendarRead":true},"flow":null}"#.utf8)
        let value = try JSONDecoder().decode(GoogleCalendarStatus.self, from: data)
        XCTAssertTrue(value.isReady)
        XCTAssertNil(value.capabilities.calendarWrite)
        XCTAssertNil(value.connectionId)
        XCTAssertFalse(value.canCreateEvents)
        XCTAssertFalse(value.canRequestEventCreation)
        XCTAssertTrue(Self.writeStatus().canRequestEventCreation)
        XCTAssertTrue(Self.writeStatus(write: true).canCreateEvents)
    }

    func testUnsupportedOrUnconfirmedConnectionCannotStartUpgrade() async {
        for value in [Self.connected, Self.writeStatus(write: true), Self.writeStatus(connectionID: nil),
                      Self.writeStatus(connectionID: " "), Self.writeStatus(account: nil),
                      Self.writeStatus(state: "provider_unavailable"), Self.writeStatus(state: "reconnect_required")] {
            let service = Service(value)
            let coordinator = GoogleCalendarConnectionCoordinator()
            coordinator.bind(service: service, isCurrent: { true })
            await coordinator.refresh()
            await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor())
            let attempts = await service.upgrades
            XCTAssertEqual(attempts, 0)
        }
        let service = Service(Self.writeStatus())
        let coordinator = GoogleCalendarConnectionCoordinator()
        coordinator.bind(service: service, isCurrent: { true })
        await coordinator.refresh()
        await service.setFailure(true)
        await coordinator.refresh()
        await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor())
        let attempts = await service.upgrades
        XCTAssertEqual(attempts, 0)
    }

    func testCancelledUpgradePreservesReadConnectionAndCancelsOnlyUpgradeFlow() async {
        let original = Self.writeStatus()
        let service = Service(original)
        let auth = GoogleCalendarAuthenticationSession { _, _, completion in CancelledBrowser(completion) }
        let coordinator = GoogleCalendarConnectionCoordinator(authentication: auth)
        coordinator.bind(service: service, isCurrent: { true })
        await coordinator.refresh()
        await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor())
        XCTAssertEqual(coordinator.status, original)
        XCTAssertTrue(coordinator.status?.isReady == true)
        XCTAssertFalse(coordinator.status?.canCreateEvents == true)
        let cancelled = await service.cancelled
        let disconnects = await service.disconnects
        let connects = await service.connects
        let upgrades = await service.upgrades
        XCTAssertEqual(cancelled, ["flow-id"])
        XCTAssertEqual(disconnects, 0)
        XCTAssertEqual(connects, 0)
        XCTAssertEqual(upgrades, 1)
    }

    func testRejectedUpgradesPreserveCanonicalReadAccess() async {
        for outcome in ["denied", "missing_scope", "invalid_identity", "expired", "provider_unavailable"] {
            let original = Self.writeStatus()
            let service = Service(original)
            await service.setFlow(outcome: outcome)
            let auth = GoogleCalendarAuthenticationSession { _, _, completion in CompletedBrowser(completion) }
            let coordinator = GoogleCalendarConnectionCoordinator(authentication: auth)
            coordinator.bind(service: service, isCurrent: { true })
            await coordinator.refresh()
            await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor())
            XCTAssertEqual(coordinator.status, original, outcome)
            XCTAssertFalse(coordinator.couldNotCheck, outcome)
            XCTAssertFalse(coordinator.status?.canCreateEvents == true, outcome)
            let disconnects = await service.disconnects
            XCTAssertEqual(disconnects, 0)
            XCTAssertNotNil(coordinator.notice)
        }
    }

    func testCompletedCallbackRequiresCanonicalWriteGrantOnSameConnection() async {
        for granted in [false, true] {
            let service = Service(Self.writeStatus())
            await service.setFlow(outcome: "connected", canonical: Self.writeStatus(write: granted))
            let auth = GoogleCalendarAuthenticationSession { _, _, completion in CompletedBrowser(completion) }
            let coordinator = GoogleCalendarConnectionCoordinator(authentication: auth)
            coordinator.bind(service: service, isCurrent: { true })
            await coordinator.refresh()
            await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor())
            XCTAssertEqual(coordinator.status?.canCreateEvents, granted)
            XCTAssertEqual(coordinator.status?.connectionId, "connection-1")
            XCTAssertEqual(coordinator.notice?.contains("hasn’t been confirmed"), !granted)
        }
    }

    func testUpgradeDoesNotAcceptChangedAccountOrConnection() async {
        for changed in [Self.writeStatus(write: true, connectionID: "other-connection"),
                        Self.writeStatus(write: true, account: .init(subject: "other", email: "other@example.com"))] {
            let original = Self.writeStatus()
            let service = Service(original)
            await service.setFlow(outcome: "connected", canonical: changed)
            let auth = GoogleCalendarAuthenticationSession { _, _, completion in CompletedBrowser(completion) }
            let coordinator = GoogleCalendarConnectionCoordinator(authentication: auth)
            coordinator.bind(service: service, isCurrent: { true })
            await coordinator.refresh()
            await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor())
            XCTAssertEqual(coordinator.status, original)
            XCTAssertTrue(coordinator.couldNotCheck)
            XCTAssertFalse(coordinator.status?.canCreateEvents == true)
            XCTAssertTrue(coordinator.notice?.contains("account or connection changed") == true)
        }
    }

    private final class WaitingBrowser: GoogleCalendarWebAuthenticationSession {
        func start() -> Bool { true }
        func cancel() {}
    }

    func testServerSwitchCancelsUpgradeAndDiscardsLateCallback() async {
        let service = Service(Self.writeStatus())
        var callback: GoogleCalendarAuthenticationSession.Completion?
        let auth = GoogleCalendarAuthenticationSession { _, _, completion in
            callback = completion
            return WaitingBrowser()
        }
        let coordinator = GoogleCalendarConnectionCoordinator(authentication: auth)
        coordinator.bind(service: service, isCurrent: { true })
        await coordinator.refresh()
        let pending = Task { await coordinator.upgradeWriteAccess(anchor: ASPresentationAnchor()) }
        while callback == nil { await Task.yield() }
        coordinator.bind(service: nil, isCurrent: { false })
        callback?(URL(string: "assistant-oauth://google-calendar/callback?flowId=flow-id")!, nil)
        await pending.value
        XCTAssertNil(coordinator.status)
        XCTAssertNil(coordinator.notice)
        XCTAssertFalse(coordinator.isBusy)
        let disconnects = await service.disconnects
        let cancelled = await service.cancelled
        XCTAssertEqual(disconnects, 0)
        XCTAssertEqual(cancelled, ["flow-id"])
    }

    func testUpgradeTransportUsesExplicitCapabilityAndDoesNotReplayTimeout() async throws {
        let id = UUID().uuidString
        StubURLProtocol.beginTestCase(id)
        defer { StubURLProtocol.endTestCase(id) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Assistant-Test-Case": id]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://assistant.example.com")!, token: "mobile-key"), session: session)
        StubURLProtocol.prime([.failure(URLError(.timedOut))])
        do { _ = try await client.upgradeGoogleCalendarWriteAccess(); XCTFail("Expected uncertain timeout") }
        catch let APIError.transport(error) { XCTAssertEqual(error.code, .timedOut) }
        catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/connections/google-calendar/connect")
        let body = try XCTUnwrap(StubURLProtocol.bodies.first)
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: body), ["capability": "calendarWrite"])
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
        catch let APIError.transport(error) { XCTAssertEqual(error.code, .timedOut) }
        catch { XCTFail("Expected a timeout transport error, got \(error).") }
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/connections/google-calendar/connect")
        XCTAssertEqual(StubURLProtocol.headers.first?.first(where: { $0.key.caseInsensitiveCompare("authorization") == .orderedSame })?.value, "Bearer mobile-key")
        StubURLProtocol.prime([.failure(URLError(.timedOut))])
        do { try await client.disconnectGoogleCalendar(); XCTFail("Expected uncertain result") }
        catch let APIError.transport(error) { XCTAssertEqual(error.code, .timedOut) }
        catch { XCTFail("Expected a timeout transport error, got \(error).") }
        XCTAssertEqual(StubURLProtocol.attempts, ["DELETE"])
    }
}
