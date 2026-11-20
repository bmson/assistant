import Foundation

struct GoogleCalendarStatus: Codable, Equatable, Sendable {
    struct Account: Codable, Equatable, Sendable {
        let subject: String
        let email: String
    }
    struct Capabilities: Codable, Equatable, Sendable {
        let calendarRead: Bool
        // Absence means the server predates optional event creation.
        let calendarWrite: Bool?

        init(calendarRead: Bool, calendarWrite: Bool? = nil) {
            self.calendarRead = calendarRead
            self.calendarWrite = calendarWrite
        }
    }
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
    let connectionId: String?

    init(configured: Bool, state: String, account: Account?, capabilities: Capabilities,
         flow: Flow?, connectionId: String? = nil) {
        self.configured = configured
        self.state = state
        self.account = account
        self.capabilities = capabilities
        self.flow = flow
        self.connectionId = connectionId
    }

    var canCreateEvents: Bool { isReady && capabilities.calendarWrite == true && hasConnectionIdentity }

    var canRequestEventCreation: Bool {
        isReady && capabilities.calendarWrite == false && hasConnectionIdentity
    }

    private var hasConnectionIdentity: Bool {
        connectionId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

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
    func upgradeGoogleCalendarWriteAccess() async throws -> GoogleCalendarConnectResponse
    func cancelGoogleCalendarFlow(id: String) async throws
    func disconnectGoogleCalendar() async throws
}

struct GoogleCalendarRequestContext {
    let ownerID: String
    let version: Int
    let client: APIClient
}

enum GoogleHouseholdCalendarPurpose: String, Codable, Sendable {
    case household
    case workFreeBusy = "work_free_busy"
    case ignore
}

struct GoogleHouseholdCalendarSetup: Decodable, Sendable {
    struct Source: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
        let canShowDetails: Bool
        let canShowBusy: Bool
        let purpose: GoogleHouseholdCalendarPurpose?
    }

    let state: String
    let connectionId: String
    let revision: String?
    let remaining: Int?
    let calendars: [Source]
}

struct GoogleHouseholdCalendarSave: Encodable, Sendable {
    struct Choice: Encodable, Sendable {
        let id: String
        let purpose: GoogleHouseholdCalendarPurpose
    }

    let connectionId: String
    let revision: String?
    let choices: [Choice]
}

struct GoogleHouseholdCalendarPreview: Decodable, Sendable {
    struct Row: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        let calendar: String
        let start: String
        let end: String
        let allDay: Bool

        var timeLabel: String {
            if allDay { return "All day" }
            let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            guard let start = try? iso.parse(start), let end = try? iso.parse(end) else {
                return "Time unavailable"
            }
            return "\(start.formatted(date: .omitted, time: .shortened)) – \(end.formatted(date: .omitted, time: .shortened))"
        }
    }

    let complete: Bool
    let rows: [Row]
}
