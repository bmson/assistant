import Foundation

enum PhoneCalendarPurpose: String, Codable, CaseIterable, Identifiable, Sendable {
    case unspecified
    case commitments
    case reference

    var id: String { rawValue }

    var title: String {
        switch self {
        case .unspecified: "Not specified"
        case .commitments: "My commitments"
        case .reference: "Shared, family or reference"
        }
    }
}

enum PhoneCalendarSnapshotFreshness: Equatable {
    case notSent
    case stale
    case incomplete
    case current

    static func evaluate(_ state: PhoneCalendarSharingState, ownerTimeZone: String, now: Date = Date()) -> Self {
        guard let received = state.receivedAt.flatMap(parseISODate) else { return .notSent }
        guard let captured = state.capturedAt.flatMap(parseISODate) else { return .incomplete }
        let receiptAge = now.timeIntervalSince(received)
        let captureAge = now.timeIntervalSince(captured)
        // A recent server receipt cannot make an old (or future-dated) capture
        // current. Validate each timestamp independently against the same clock.
        guard receiptAge >= 0, receiptAge <= 30 * 60,
              captureAge >= 0, captureAge <= 30 * 60 else { return .stale }
        guard state.complete == true, state.truncated != true,
              let zone = TimeZone(identifier: ownerTimeZone),
              let actualMin = state.timeMin.flatMap(parseISODate),
              let actualMax = state.timeMax.flatMap(parseISODate),
              let expected = expectedWindow(now: now, zone: zone),
              actualMin <= expected.start, actualMax >= expected.end else { return .incomplete }
        return .current
    }

    private static func parseISODate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    private static func expectedWindow(now: Date, zone: TimeZone) -> DateInterval? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let today = calendar.startOfDay(for: now)
        guard let start = calendar.date(byAdding: .day, value: -7, to: today),
              let end = calendar.date(byAdding: .day, value: 46, to: today) else { return nil }
        return DateInterval(start: start, end: end)
    }
}

enum PhoneCalendarSnapshotWindowFormatter {
    static func format(timeMin: String?, timeMax: String?, ownerTimeZone: String?, locale: Locale = .current) -> String? {
        guard let timeMin, let timeMax, let ownerTimeZone,
              let zone = TimeZone(identifier: ownerTimeZone),
              let lower = parse(timeMin), let upper = parse(timeMax), lower < upper else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        let inclusiveEnd = upper.addingTimeInterval(-1)
        let exclusiveFormatter = DateFormatter()
        exclusiveFormatter.locale = locale
        exclusiveFormatter.calendar = Calendar(identifier: .gregorian)
        exclusiveFormatter.timeZone = zone
        exclusiveFormatter.dateFormat = "MMM d, yyyy 'at' h:mm a zzz"
        return "Snapshot window: \(formatter.string(from: lower)) through \(formatter.string(from: inclusiveEnd)) inclusive; exclusive end \(exclusiveFormatter.string(from: upper)) (\(ownerTimeZone))."
    }

    private static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

struct PhoneCalendarEventRefreshRevision {
    private(set) var value = 0

    mutating func advance() -> Int {
        value += 1
        return value
    }

    func owns(_ revision: Int) -> Bool { value == revision }
}

struct SharedPhoneCalendar: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    var purpose: PhoneCalendarPurpose
    var timeZone: String?
}

struct PhoneCalendarSharingState: Codable, Equatable, Sendable {
    let version: Int
    let ownerId: String
    let publisherId: String?
    let generation: Int
    let enabled: Bool
    let consentVersion: Int
    let calendars: [SharedPhoneCalendar]
    let updatedAt: String
    let capturedAt: String?
    let receivedAt: String?
    let timeMin: String?
    let timeMax: String?
    let complete: Bool?
    let truncated: Bool?
    let mutationId: String?
}

struct PhoneCalendarSharingRead: Codable, Sendable {
    let ownerId: String
    let ownerEmail: String
    let timeZone: String
    var state: PhoneCalendarSharingState?
}

struct PhoneCalendarSharingMutationResult: Decodable, Sendable {
    let ok: Bool
    let state: PhoneCalendarSharingState
    let error: String?
}

struct PhoneCalendarSharingCommandBody: Codable, Sendable {
    let command: String
    let ownerId: String
    let publisherId: String
    let expectedGeneration: Int
    let mutationId: String?
    let consentVersion: Int?
    let calendars: [SharedPhoneCalendar]?
    let snapshot: PhoneCalendarSnapshotInput?

    static func configure(
        _ command: String,
        ownerId: String,
        publisherId: String,
        expectedGeneration: Int,
        mutationId: String,
        calendars: [SharedPhoneCalendar]
    ) -> Self {
        .init(command: command, ownerId: ownerId, publisherId: publisherId, expectedGeneration: expectedGeneration,
              mutationId: mutationId, consentVersion: 1, calendars: calendars, snapshot: nil)
    }

}

struct PhoneCalendarRevocationBody: Encodable, Sendable {
    let ownerId: String
    let publisherId: String
    let generation: Int
    let cancelPendingMutationId: String?
}

struct PhoneCalendarSnapshotUploadBody: Encodable, Sendable {
    let ownerId: String
    let publisherId: String
    let generation: Int
    let snapshot: PhoneCalendarSnapshotInput
}

struct PhoneCalendarSnapshotInput: Codable, Sendable {
    let timeMin: String
    let timeMax: String
    let capturedAt: String
    let selectionRevision: Int
    let complete: Bool
    let truncated: Bool
    let sourceAvailability: [PhoneCalendarSourceAvailability]
    let timeZone: String
    let calendars: [SharedPhoneCalendar]
    let events: [PhoneCalendarSharedEvent]
}

struct PhoneCalendarSourceAvailability: Codable, Sendable {
    enum Status: String, Codable, Sendable { case available, missing, permissionDenied = "permission-denied" }
    let calendarId: String
    let status: Status
    let complete: Bool
    let reason: String?
}

struct PhoneCalendarSharedEvent: Codable, Sendable {
    let eventId: String
    let calendarId: String
    let providerExternalIdentifier: String?
    let status: String?
    let calendarTimeZone: String?
    let ownerParticipant: OwnerParticipant?
    let iCalUID: String?
    let originalStartTime: String?
    let summary: String
    let location: String
    let start: String
    let end: String
    let allDay: Bool
    let blocksTime: Bool

    struct OwnerParticipant: Codable, Sendable {
        let email: String
        let responseStatus: String
    }
}

struct PendingPhoneCalendarRevocation: Codable, Equatable, Sendable {
    let baseURL: String
    let ownerId: String
    let ownerEmail: String
    let publisherId: String
    let expectedGeneration: Int
    let tombstoneGeneration: Int
    let cancelPendingMutationId: String?
}
