import AuthenticationServices
import Foundation
import Observation

@MainActor
@Observable
final class GoogleCalendarConnectionCoordinator {
    private(set) var status: GoogleCalendarStatus?
    private(set) var isBusy = false
    private(set) var couldNotCheck = false
    private(set) var notice: String?
    @ObservationIgnored private let authentication: GoogleCalendarAuthenticationSession
    @ObservationIgnored private var service: (any GoogleCalendarConnectionService)?
    @ObservationIgnored private var isCurrent: () -> Bool = { false }
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var pendingFlowID: String?

    init(authentication: GoogleCalendarAuthenticationSession? = nil) {
        self.authentication = authentication ?? GoogleCalendarAuthenticationSession()
    }

    func bind(service: (any GoogleCalendarConnectionService)?, isCurrent: @escaping () -> Bool) {
        revision += 1
        authentication.cancel()
        self.service = service
        self.isCurrent = isCurrent
        status = nil
        notice = nil
        pendingFlowID = nil
        couldNotCheck = false
        isBusy = false
    }

    private func accepts(_ version: Int) -> Bool { revision == version && isCurrent() }

    func refresh() async {
        guard !isBusy, let service, isCurrent() else { return }
        let version = revision
        isBusy = true
        defer { if accepts(version) { isBusy = false } }
        await readCanonical(service: service, version: version)
    }

    private func readCanonical(service: any GoogleCalendarConnectionService, version: Int) async {
        do {
            if let pendingFlowID {
                do {
                    let flowStatus = try await service.googleCalendarStatus(flowID: pendingFlowID)
                    guard accepts(version) else { return }
                    applyFlow(flowStatus.flow, expectedID: pendingFlowID)
                } catch {
                    guard accepts(version) else { return }
                    notice = "Couldn’t check this sign-in attempt. Your connection status is shown below."
                }
            }
            let value = try await service.googleCalendarStatus(flowID: nil)
            guard accepts(version) else { return }
            status = value
            couldNotCheck = false
        } catch {
            guard accepts(version) else { return }
            couldNotCheck = true
        }
    }

    func connect(anchor: ASPresentationAnchor) async {
        guard !isBusy, !couldNotCheck, let service, isCurrent(), status?.configured == true else { return }
        let version = revision
        isBusy = true
        notice = nil
        var startedFlow: String?
        defer { if accepts(version) { isBusy = false } }
        do {
            let response = try await service.connectGoogleCalendar()
            startedFlow = response.flowId
            guard accepts(version) else {
                try? await service.cancelGoogleCalendarFlow(id: response.flowId)
                return
            }
            guard !response.flowId.isEmpty, let url = URL(string: response.authorizationUrl), let expiry = response.expiry else {
                throw GoogleCalendarAuthenticationError.invalidAuthorizationURL
            }
            pendingFlowID = response.flowId
            _ = try await authentication.authenticate(authorizationURL: url, expiresAt: expiry, anchor: anchor,
                                                       validateCallback: response.matchesCallback)
            guard accepts(version) else { return }
            let flowStatus = try await service.googleCalendarStatus(flowID: response.flowId)
            guard accepts(version) else { return }
            applyFlow(flowStatus.flow, expectedID: response.flowId)
        } catch {
            // Cancel only this sign-in attempt. Never disconnect an existing account
            // when a replacement attempt was denied, cancelled or interrupted.
            if let startedFlow {
                do { try await service.cancelGoogleCalendarFlow(id: startedFlow) }
                catch {
                    if accepts(version) { notice = "Couldn’t confirm sign-in cancellation. Refresh to check its status." }
                }
            }
            guard accepts(version) else { return }
            let cancelled = error is CancellationError ||
                (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
            if notice == nil {
                notice = cancelled ? "Sign-in cancelled. Check your connection status below."
                    : "Couldn’t confirm this sign-in. Refresh to check your connection."
            }
        }
        guard accepts(version) else { return }
        await readCanonical(service: service, version: version)
    }

    private func applyFlow(_ flow: GoogleCalendarStatus.Flow?, expectedID: String) {
        guard let flow, flow.id == expectedID else {
            notice = "Couldn’t verify this sign-in attempt. Refresh to check your connection."
            return
        }
        switch flow.outcome {
        case "connected": notice = nil; pendingFlowID = nil
        case "pending", "processing": notice = "Sign-in is still being checked. Refresh to check again."
        case "denied", "cancelled":
            notice = "Sign-in wasn’t completed. Check your connection status below."
            pendingFlowID = nil
        case "missing_scope":
            notice = "Calendar read access wasn’t granted. Reconnect and allow calendar read access."
            pendingFlowID = nil
        case "expired": notice = "This sign-in expired. Try connecting again."; pendingFlowID = nil
        case "invalid_identity":
            notice = "Google sign-in couldn’t be verified. Try connecting again."
            if let email = status?.account?.email, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                notice = "Google sign-in couldn’t be verified. If you’re switching Google accounts, disconnect \(email) first, then connect the other account. Otherwise, try signing in again."
            }
            pendingFlowID = nil
        case "superseded": notice = "A newer sign-in replaced this attempt. Refresh to check your connection."; pendingFlowID = nil
        default: notice = "Couldn’t complete Google sign-in. Try connecting again."; pendingFlowID = nil
        }
    }

    func disconnect() async {
        guard !isBusy, let service, isCurrent() else { return }
        let version = revision
        isBusy = true
        notice = nil
        defer { if accepts(version) { isBusy = false } }
        do { try await service.disconnectGoogleCalendar() }
        catch {
            guard accepts(version) else { return }
            notice = "Couldn’t confirm disconnection. Refresh to check before trying again."
        }
        guard accepts(version) else { return }
        pendingFlowID = nil
        await readCanonical(service: service, version: version)
        if accepts(version), status?.account != nil, notice == nil {
            notice = "Disconnection hasn’t been confirmed. Refresh to check again."
        }
    }

    func unbind() { bind(service: nil, isCurrent: { false }) }
}
