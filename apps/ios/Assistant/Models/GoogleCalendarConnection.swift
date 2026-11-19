import Foundation

struct GoogleCalendarStatus: Codable, Equatable, Sendable {
    struct Account: Codable, Equatable, Sendable {
        let subject: String
        let email: String
    }
    struct Capabilities: Codable, Equatable, Sendable { let calendarRead: Bool }
    struct Flow: Codable, Equatable, Sendable {
        let id: String
        let outcome: String
        let expiresAt: String
    }
    let configured: Bool
    let state: String
    let account: Account?
    let capabilities: Capabilities
    let flow: Flow?

    var isReady: Bool {
        configured && state == "connected" && capabilities.calendarRead && hasConfirmedAccount
    }

    var canRetryCalendarInChat: Bool {
        configured && state == "provider_unavailable" && hasConfirmedAccount
    }

    private var hasConfirmedAccount: Bool {
        account?.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && account?.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}

struct GoogleCalendarConnectResponse: Codable, Sendable {
    let authorizationUrl: String
    let flowId: String
    let expiresAt: String

    var expiry: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }

    func matchesCallback(_ url: URL) -> Bool {
        guard GoogleCalendarAuthenticationSession.hasExpectedCallbackRoute(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let query = components.queryItems, query.count == 1 else { return false }
        return !flowId.isEmpty && query[0].name == "flowId" && query[0].value == flowId
    }
}

protocol GoogleCalendarConnectionService: Sendable {
    func googleCalendarStatus(flowID: String?) async throws -> GoogleCalendarStatus
    func connectGoogleCalendar() async throws -> GoogleCalendarConnectResponse
    func cancelGoogleCalendarFlow(id: String) async throws
    func disconnectGoogleCalendar() async throws
}

struct GoogleCalendarRequestContext {
    let ownerID: String
    let version: Int
    let client: APIClient
}
