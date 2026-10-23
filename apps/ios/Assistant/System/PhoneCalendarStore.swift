import EventKit
import Observation

enum PhoneCalendarAccess: Equatable {
    case notDetermined, fullAccess, writeOnly, denied, restricted
}

struct PhoneCalendar: Identifiable, Equatable {
    let id: String
    let title: String
    let account: String
    var timeZoneIdentifier: String? = nil
}

struct PhoneCalendarEvent: Identifiable, Equatable {
    let id: String
    let calendarID: String
    let title: String
    let start: Date
    let end: Date
    let isAllDay: Bool
    let location: String?
}

struct PhoneCalendarShareEvent: Sendable {
    let eventId: String
    let calendarId: String
    let providerExternalIdentifier: String?
    let status: String?
    let calendarTimeZone: String?
    let ownerParticipant: PhoneCalendarSharedEvent.OwnerParticipant?
    let originalStartTime: Date?
    let summary: String
    let location: String
    let start: Date
    let end: Date
    let allDay: Bool
    let blocksTime: Bool
}

/// This boundary intentionally has no networking or event mutation operations.
@MainActor
protocol PhoneCalendarSource {
    var access: PhoneCalendarAccess { get }
    func requestAccess() async throws -> Bool
    func calendars() -> [PhoneCalendar]
    func events(in interval: DateInterval, calendarIDs: Set<String>) -> [PhoneCalendarEvent]
    func shareEvents(in interval: DateInterval, calendarIDs: Set<String>, verifiedOwnerEmail: String) -> [PhoneCalendarShareEvent]
}

extension PhoneCalendarSource {
    func shareEvents(in interval: DateInterval, calendarIDs: Set<String>, verifiedOwnerEmail: String) -> [PhoneCalendarShareEvent] {
        events(in: interval, calendarIDs: calendarIDs).map { event in
            PhoneCalendarShareEvent(
                eventId: event.id, calendarId: event.calendarID, providerExternalIdentifier: nil,
                status: "confirmed", calendarTimeZone: nil, ownerParticipant: nil,
                originalStartTime: nil, summary: event.title, location: event.location ?? "",
                start: event.start, end: event.end, allDay: event.isAllDay, blocksTime: true
            )
        }
    }
}

@MainActor
final class EventKitCalendarSource: PhoneCalendarSource {
    private static let sharedStore = EKEventStore()
    private let store: EKEventStore

    init(store: EKEventStore? = nil) {
        self.store = store ?? Self.sharedStore
    }

    var access: PhoneCalendarAccess {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: .fullAccess
        case .writeOnly: .writeOnly
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .restricted
        }
    }

    func requestAccess() async throws -> Bool {
        try await store.requestFullAccessToEvents()
    }

    func calendars() -> [PhoneCalendar] {
        guard access == .fullAccess else { return [] }
        // Recreate EventKit objects after permissions, accounts, or events change.
        store.reset()
        return store.calendars(for: .event).map {
            PhoneCalendar(id: $0.calendarIdentifier, title: $0.title, account: $0.source.title)
        }
    }

    func events(in interval: DateInterval, calendarIDs: Set<String>) -> [PhoneCalendarEvent] {
        guard access == .fullAccess, !calendarIDs.isEmpty else { return [] }
        let calendars = store.calendars(for: .event).filter { calendarIDs.contains($0.calendarIdentifier) }
        // A nil calendar predicate would read every calendar. Never use that fallback.
        guard !calendars.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: interval.start, end: interval.end, calendars: calendars)
        return store.events(matching: predicate).compactMap { event -> PhoneCalendarEvent? in
            guard event.status != .canceled, let calendar = event.calendar,
                  let start = event.startDate, let end = event.endDate else { return nil }
            return PhoneCalendarEvent(
                id: "\(calendar.calendarIdentifier):\(event.calendarItemIdentifier):\(start.timeIntervalSince1970)",
                calendarID: calendar.calendarIdentifier,
                title: event.title?.isEmpty == false ? event.title! : "Untitled event",
                start: start, end: end, isAllDay: event.isAllDay,
                location: event.location?.isEmpty == false ? event.location : nil
            )
        }
    }

    func shareEvents(in interval: DateInterval, calendarIDs: Set<String>, verifiedOwnerEmail: String) -> [PhoneCalendarShareEvent] {
        guard access == .fullAccess, !calendarIDs.isEmpty else { return [] }
        let selected = store.calendars(for: .event).filter { calendarIDs.contains($0.calendarIdentifier) }
        guard !selected.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: interval.start, end: interval.end, calendars: selected)
        return store.events(matching: predicate).compactMap { event -> PhoneCalendarShareEvent? in
            guard event.status != .canceled, let calendar = event.calendar,
                  calendarIDs.contains(calendar.calendarIdentifier),
                  let start = event.startDate, let end = event.endDate, end > start else { return nil }
            let verifiedEmail = verifiedOwnerEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let participant = event.attendees?.first(where: \.isCurrentUser)
            let participantEmail = participant.flatMap { Self.emailAddress(from: $0.url) }
            let ownerParticipant: PhoneCalendarSharedEvent.OwnerParticipant? = {
                guard let participant, let participantEmail,
                      participantEmail.caseInsensitiveCompare(verifiedEmail) == .orderedSame else { return nil }
                let status: String = switch participant.participantStatus {
                case .accepted: "accepted"
                case .declined: "declined"
                case .tentative: "tentative"
                case .pending, .unknown: "needsAction"
                case .delegated, .completed, .inProcess: "needsAction"
                @unknown default: "needsAction"
                }
                return .init(email: verifiedEmail, responseStatus: status)
            }()
            let eventID = "\(calendar.calendarIdentifier):\(event.calendarItemIdentifier):\(event.occurrenceDate.timeIntervalSince1970)"
            return PhoneCalendarShareEvent(
                eventId: String(eventID.prefix(1024)), calendarId: calendar.calendarIdentifier,
                providerExternalIdentifier: event.calendarItemExternalIdentifier.isEmpty ? nil : String(event.calendarItemExternalIdentifier.prefix(1024)),
                status: event.status == .tentative ? "tentative" : "confirmed",
                calendarTimeZone: event.timeZone?.identifier,
                ownerParticipant: ownerParticipant, originalStartTime: event.occurrenceDate,
                summary: String((event.title?.isEmpty == false ? event.title! : "Untitled event").prefix(500)),
                location: String((event.location ?? "").prefix(2000)), start: start, end: end,
                allDay: event.isAllDay,
                blocksTime: event.availability != .free
            )
        }
    }

    private static func emailAddress(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "mailto" else { return nil }
        let value = String(url.absoluteString.dropFirst("mailto:".count))
        guard !value.isEmpty, !value.contains("?") else { return nil }
        return value.removingPercentEncoding ?? value
    }
}

/// Only calendar identifiers and the owner's opt-in are persisted. Event details
/// live in memory while the calendar screen is active and never enter chat context.
@MainActor @Observable
final class PhoneCalendarStore {
    static let enabledKey = "assistant.phoneCalendars.enabled"
    static let selectionKey = "assistant.phoneCalendars.selectedIDs"

    private(set) var isEnabled: Bool
    private(set) var access: PhoneCalendarAccess
    private(set) var calendars: [PhoneCalendar] = []
    private(set) var events: [PhoneCalendarEvent] = []
    private(set) var selectedIDs: Set<String>
    private(set) var isRequesting = false
    private(set) var errorMessage: String?
    var day = Date()

    @ObservationIgnored private let source: any PhoneCalendarSource
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var generation = 0

    init(source: (any PhoneCalendarSource)? = nil, defaults: UserDefaults = .standard) {
        self.source = source ?? EventKitCalendarSource()
        self.defaults = defaults
        isEnabled = defaults.bool(forKey: Self.enabledKey)
        selectedIDs = Set(defaults.stringArray(forKey: Self.selectionKey) ?? [])
        access = self.source.access
    }

    func enable() async {
        guard !isRequesting else { return }
        isRequesting = true
        errorMessage = nil
        generation += 1
        let request = generation
        defer { isRequesting = false }
        do {
            if source.access != .fullAccess {
                guard try await source.requestAccess() else {
                    guard request == generation else { return }
                    refresh()
                    return
                }
            }
            guard request == generation, source.access == .fullAccess else { return }
            isEnabled = true
            defaults.set(true, forKey: Self.enabledKey)
            refresh()
        } catch {
            guard request == generation else { return }
            refresh()
            errorMessage = "Couldn’t request calendar access. Try again or check iPhone Settings."
        }
    }

    func refresh() {
        access = source.access
        events = []
        calendars = []
        guard isEnabled, access == .fullAccess else {
            // Revoked or restricted access must never silently resume sharing an
            // old selection if permission is granted again later.
            if isEnabled { clearSelection() }
            return
        }
        calendars = source.calendars().sorted {
            ($0.account, $0.title, $0.id) < ($1.account, $1.title, $1.id)
        }
        selectedIDs.formIntersection(Set(calendars.map(\.id)))
        saveSelection()
        guard !selectedIDs.isEmpty,
              let interval = Calendar.autoupdatingCurrent.dateInterval(of: .day, for: day) else { return }
        events = source.events(in: interval, calendarIDs: selectedIDs)
            .filter { selectedIDs.contains($0.calendarID) && $0.end >= $0.start && $0.start < interval.end && $0.end > interval.start }
            .sorted {
                if $0.isAllDay != $1.isAllDay { return $0.isAllDay }
                if $0.start != $1.start { return $0.start < $1.start }
                if $0.title != $1.title { return $0.title < $1.title }
                return $0.id < $1.id
            }
    }

    func select(_ calendar: PhoneCalendar, enabled: Bool) {
        guard isEnabled, access == .fullAccess, calendars.contains(where: { $0.id == calendar.id }) else { return }
        if enabled { selectedIDs.insert(calendar.id) }
        else { selectedIDs.remove(calendar.id) }
        saveSelection()
        refresh()
    }

    func disable() {
        generation += 1
        isEnabled = false
        defaults.set(false, forKey: Self.enabledKey)
        clearSelection()
        calendars = []
        events = []
        errorMessage = nil
    }

    func clearVisibleEvents() { events = [] }

    private func clearSelection() {
        selectedIDs = []
        saveSelection()
    }

    private func saveSelection() {
        defaults.set(selectedIDs.sorted(), forKey: Self.selectionKey)
    }
}
