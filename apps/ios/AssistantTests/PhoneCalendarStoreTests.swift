import EventKit
import SwiftUI
import XCTest
@testable import Assistant

@MainActor
final class PhoneCalendarStoreTests: XCTestCase {
    private let work = PhoneCalendar(id: "work", title: "Work", account: "Work account")
    private let personal = PhoneCalendar(id: "personal", title: "Personal", account: "Personal account")

    private func fixture(enabled: Bool = false, selected: [String] = []) -> (PhoneCalendarStore, CalendarSourceFixture, UserDefaults) {
        let defaults = UserDefaults(suiteName: "calendar-tests-\(UUID().uuidString)")!
        defaults.set(enabled, forKey: PhoneCalendarStore.enabledKey)
        defaults.set(selected, forKey: PhoneCalendarStore.selectionKey)
        let source = CalendarSourceFixture()
        source.available = [work, personal]
        let store = PhoneCalendarStore(source: source, defaults: defaults)
        store.day = Date(timeIntervalSince1970: 1_792_411_200)
        return (store, source, defaults)
    }

    func testOpeningDoesNotRequestPermissionOrReadBeforeOptIn() {
        let (store, source, _) = fixture()
        store.refresh()
        XCTAssertEqual(source.requests, 0)
        XCTAssertEqual(source.calendarReads, 0)
        XCTAssertTrue(source.eventReads.isEmpty)
    }

    func testGrantRequiresExplicitCalendarSelectionBeforeReadingEvents() async {
        let (store, source, defaults) = fixture()
        source.access = .notDetermined
        await store.enable()
        XCTAssertEqual(source.requests, 1)
        XCTAssertTrue(store.isEnabled)
        XCTAssertTrue(defaults.bool(forKey: PhoneCalendarStore.enabledKey))
        XCTAssertEqual(store.calendars.count, 2)
        XCTAssertTrue(store.selectedIDs.isEmpty)
        XCTAssertTrue(source.eventReads.isEmpty)
        store.select(work, enabled: true)
        XCTAssertEqual(source.eventReads.last, Set(["work"]))
        XCTAssertEqual(defaults.stringArray(forKey: PhoneCalendarStore.selectionKey), ["work"])
    }

    func testDeniedAndRestrictedAccessClearVisibleDataAndSelection() {
        for access in [PhoneCalendarAccess.denied, .restricted, .writeOnly] {
            let (store, source, defaults) = fixture(enabled: true, selected: ["work"])
            source.records = [event(store, id: "meeting")]
            store.refresh()
            XCTAssertEqual(store.events.count, 1)
            let reads = source.eventReads.count
            source.access = access
            store.refresh()
            XCTAssertEqual(store.access, access)
            XCTAssertTrue(store.events.isEmpty)
            XCTAssertTrue(store.calendars.isEmpty)
            XCTAssertTrue(store.selectedIDs.isEmpty)
            XCTAssertEqual(defaults.stringArray(forKey: PhoneCalendarStore.selectionKey), [])
            XCTAssertEqual(source.eventReads.count, reads)
        }
    }

    func testDeclinedPromptDoesNotEnableOrRead() async {
        let (store, source, _) = fixture()
        source.access = .notDetermined
        source.grantsAccess = false
        await store.enable()
        XCTAssertFalse(store.isEnabled)
        XCTAssertEqual(store.access, .denied)
        XCTAssertTrue(source.eventReads.isEmpty)
    }

    func testFailedPromptCanBeRetried() async {
        let (store, source, _) = fixture()
        source.access = .notDetermined
        source.failsRequest = true
        await store.enable()
        XCTAssertNotNil(store.errorMessage)
        XCTAssertFalse(store.isEnabled)
        XCTAssertFalse(store.isRequesting)
        source.failsRequest = false
        await store.enable()
        XCTAssertNil(store.errorMessage)
        XCTAssertTrue(store.isEnabled)
    }

    func testOnlySelectedCalendarsAndOverlappingEventsAreDisplayed() {
        let (store, source, _) = fixture(enabled: true, selected: ["work"])
        let interval = Calendar.autoupdatingCurrent.dateInterval(of: .day, for: store.day)!
        source.records = [
            event(store, id: "later", offset: 7200),
            event(store, id: "earlier", offset: 3600),
            event(store, id: "private", calendarID: "personal"),
            .init(id: "all-day", calendarID: "work", title: "Away", start: interval.start,
                  end: interval.end, isAllDay: true, location: nil),
            .init(id: "overnight", calendarID: "work", title: "Overnight", start: interval.start.addingTimeInterval(-3600),
                  end: interval.start.addingTimeInterval(3600), isAllDay: false, location: nil),
            .init(id: "ended", calendarID: "work", title: "Ended", start: interval.start.addingTimeInterval(-7200),
                  end: interval.start, isAllDay: false, location: nil),
            .init(id: "next-day", calendarID: "work", title: "Tomorrow", start: interval.end,
                  end: interval.end.addingTimeInterval(3600), isAllDay: false, location: nil)
        ]
        store.refresh()
        XCTAssertEqual(store.events.map(\.id), ["all-day", "overnight", "earlier", "later"])
        XCTAssertEqual(source.lastInterval, interval)
        XCTAssertEqual(source.eventReads, [Set(["work"])])
    }

    func testAccountRemovalPrunesSelectionAndDoesNotReadAllCalendars() {
        let (store, source, defaults) = fixture(enabled: true, selected: ["work"])
        source.available = [personal]
        store.refresh()
        XCTAssertTrue(store.selectedIDs.isEmpty)
        XCTAssertTrue(source.eventReads.isEmpty)
        XCTAssertEqual(defaults.stringArray(forKey: PhoneCalendarStore.selectionKey), [])
    }

    func testDeselectingLastCalendarImmediatelyClearsEvents() {
        let (store, source, _) = fixture(enabled: true, selected: ["work"])
        source.records = [event(store, id: "meeting")]
        store.refresh()
        XCTAssertFalse(store.events.isEmpty)
        let reads = source.eventReads.count
        store.select(work, enabled: false)
        XCTAssertTrue(store.events.isEmpty)
        XCTAssertEqual(source.eventReads.count, reads)
    }

    func testStopClearsOptInAndSelectionAcrossRelaunch() {
        let (store, source, defaults) = fixture(enabled: true, selected: ["work"])
        source.records = [event(store, id: "meeting")]
        store.refresh()
        store.disable()
        store.refresh()
        XCTAssertFalse(store.isEnabled)
        XCTAssertTrue(store.events.isEmpty)
        XCTAssertTrue(store.selectedIDs.isEmpty)
        let relaunched = PhoneCalendarStore(source: source, defaults: defaults)
        relaunched.refresh()
        XCTAssertFalse(relaunched.isEnabled)
        XCTAssertTrue(relaunched.events.isEmpty)
        XCTAssertTrue(relaunched.selectedIDs.isEmpty)
        XCTAssertEqual(source.eventReads.count, 1)
    }

    func testBackgroundClearsEventDetailsWithoutReadingAgain() {
        let (store, source, _) = fixture(enabled: true, selected: ["work"])
        source.records = [event(store, id: "meeting")]
        store.refresh()
        store.clearVisibleEvents()
        XCTAssertTrue(store.events.isEmpty)
        XCTAssertEqual(source.eventReads.count, 1)
        store.refresh()
        XCTAssertEqual(store.events.count, 1)
    }

    func testPermissionRestoredDoesNotRestorePreviouslySelectedCalendars() {
        let (store, source, _) = fixture(enabled: true, selected: ["work"])
        source.access = .denied
        store.refresh()
        source.access = .fullAccess
        store.refresh()
        XCTAssertTrue(store.selectedIDs.isEmpty)
        XCTAssertTrue(source.eventReads.isEmpty)
    }

    func testStoppingWhilePermissionRequestIsPendingDoesNotReenable() async {
        let (store, source, _) = fixture()
        source.access = .notDetermined
        source.suspendRequest = true
        let request = Task { await store.enable() }
        await source.waitUntilRequestPending()
        XCTAssertTrue(store.isRequesting)
        store.disable()
        source.finishRequest()
        await request.value
        XCTAssertFalse(store.isEnabled)
        XCTAssertTrue(source.eventReads.isEmpty)
        XCTAssertTrue(store.selectedIDs.isEmpty)
    }

    func testEventKitReadsRecurringEventsFromSelectedCalendar() throws {
        #if targetEnvironment(simulator)
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw XCTSkip("Grant Calendar permission on the isolated review simulator to exercise EventKit.")
        }
        let eventStore = EKEventStore()
        let localSource = try XCTUnwrap(eventStore.sources.first(where: { $0.sourceType == .local }))
        let calendar = EKCalendar(for: .event, eventStore: eventStore)
        calendar.title = "Assistant calendar test \(UUID().uuidString)"
        calendar.source = localSource
        try eventStore.saveCalendar(calendar, commit: true)
        defer { try? eventStore.removeCalendar(calendar, commit: true) }
        let day = Calendar.autoupdatingCurrent.startOfDay(for: Date())
        let event = EKEvent(eventStore: eventStore)
        event.calendar = calendar
        event.title = "Recurring calendar fixture"
        event.startDate = day.addingTimeInterval(9 * 3600)
        event.endDate = event.startDate.addingTimeInterval(1800)
        event.recurrenceRules = [EKRecurrenceRule(recurrenceWith: .daily, interval: 1,
                                                end: EKRecurrenceEnd(occurrenceCount: 3))]
        try eventStore.save(event, span: .thisEvent, commit: true)
        let source = EventKitCalendarSource()
        XCTAssertTrue(source.calendars().contains(where: { $0.id == calendar.calendarIdentifier }))
        let tomorrow = Calendar.autoupdatingCurrent.date(byAdding: .day, value: 1, to: day)!
        let interval = Calendar.autoupdatingCurrent.dateInterval(of: .day, for: tomorrow)!
        let records = source.events(in: interval, calendarIDs: [calendar.calendarIdentifier])
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records.first?.title, "Recurring calendar fixture")
        XCTAssertTrue(records.allSatisfy { $0.calendarID == calendar.calendarIdentifier })
        XCTAssertTrue(source.events(in: interval, calendarIDs: []).isEmpty)
        XCTAssertTrue(source.events(in: interval, calendarIDs: ["removed-calendar"]).isEmpty)
        #else
        throw XCTSkip("Calendar fixtures are created only on an isolated simulator.")
        #endif
    }

    func testCalendarPagesInLightDarkAndLargeText() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, enabled, access) in [
            ("onboarding", false, PhoneCalendarAccess.notDetermined),
            ("agenda", true, .fullAccess), ("denied", true, .denied), ("restricted", true, .restricted)
        ] {
            for scheme in [ColorScheme.light, .dark] {
                for size in [DynamicTypeSize.large, .accessibility3] {
                    let (store, source, _) = fixture(enabled: enabled, selected: enabled ? ["work"] : [])
                    source.access = access
                    source.records = [event(store, id: "meeting")]
                    let view = NavigationStack { PhoneCalendarsView(store: store) }
                        .environment(\.scenePhase, .active)
                        .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                        .preferredColorScheme(scheme)
                    let controller = UIHostingController(rootView: view)
                    let window = UIWindow(windowScene: scene)
                    window.frame = scene.coordinateSpace.bounds
                    window.rootViewController = controller
                    window.makeKeyAndVisible()
                    try await Task.sleep(for: .milliseconds(150))
                    controller.view.layoutIfNeeded()
                    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                    }
                    let attachment = XCTAttachment(image: image)
                    attachment.name = "phone-calendar-\(name)-\(scheme)-\(size)"
                    attachment.lifetime = .keepAlways
                    add(attachment)
                    window.isHidden = true
                    window.rootViewController = nil
                }
            }
        }
    }

    func testInactiveCalendarViewDoesNotReadEvents() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let (store, source, _) = fixture(enabled: true, selected: ["work"])
        let controller = UIHostingController(rootView:
            NavigationStack { PhoneCalendarsView(store: store) }.environment(\.scenePhase, .background))
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(source.calendarReads, 0)
        XCTAssertTrue(source.eventReads.isEmpty)
        XCTAssertTrue(store.events.isEmpty)
    }

    func testAccountSyncNotificationsRefreshOnTheMainThread() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let (store, source, _) = fixture(enabled: true, selected: ["work"])
        let initialRead = expectation(description: "The visible calendar loads")
        source.didReadEvents = { initialRead.fulfill() }
        let controller = UIHostingController(rootView:
            NavigationStack { PhoneCalendarsView(store: store) }.environment(\.scenePhase, .active))
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { source.didReadEvents = nil; window.isHidden = true; window.rootViewController = nil }
        await fulfillment(of: [initialRead], timeout: 5)
        let syncedRead = expectation(description: "An account sync refreshes the visible calendar")
        source.didReadEvents = { syncedRead.fulfill() }
        await Task.detached {
            NotificationCenter.default.post(name: .EKEventStoreChanged, object: nil)
        }.value
        await fulfillment(of: [syncedRead], timeout: 5)
        XCTAssertTrue(source.readsStayedOnMainThread)
    }

    private func event(_ store: PhoneCalendarStore, id: String, calendarID: String = "work", offset: TimeInterval = 3600) -> PhoneCalendarEvent {
        let start = Calendar.autoupdatingCurrent.startOfDay(for: store.day).addingTimeInterval(offset)
        return .init(id: id, calendarID: calendarID, title: "Team planning", start: start,
                     end: start.addingTimeInterval(1800), isAllDay: false, location: "Meeting room")
    }
}

@MainActor
private final class CalendarSourceFixture: PhoneCalendarSource {
    var access = PhoneCalendarAccess.fullAccess
    var available: [PhoneCalendar] = []
    var records: [PhoneCalendarEvent] = []
    var grantsAccess = true
    var failsRequest = false
    var requests = 0
    var calendarReads = 0
    var eventReads: [Set<String>] = []
    var lastInterval: DateInterval?
    var didReadEvents: (() -> Void)?
    var readsStayedOnMainThread = true
    var suspendRequest = false
    private var pendingRequest: CheckedContinuation<Void, Never>?
    private var requestStarted: CheckedContinuation<Void, Never>?

    func requestAccess() async throws -> Bool {
        requests += 1
        if suspendRequest {
            await withCheckedContinuation {
                pendingRequest = $0
                requestStarted?.resume()
                requestStarted = nil
            }
        }
        if failsRequest { throw NSError(domain: "CalendarFixture", code: 1) }
        access = grantsAccess ? .fullAccess : .denied
        return grantsAccess
    }
    func finishRequest() { pendingRequest?.resume(); pendingRequest = nil }
    func waitUntilRequestPending() async {
        if pendingRequest != nil { return }
        await withCheckedContinuation { requestStarted = $0 }
    }
    func calendars() -> [PhoneCalendar] {
        readsStayedOnMainThread = readsStayedOnMainThread && Thread.isMainThread
        calendarReads += 1
        return available
    }
    func events(in interval: DateInterval, calendarIDs: Set<String>) -> [PhoneCalendarEvent] {
        eventReads.append(calendarIDs)
        lastInterval = interval
        readsStayedOnMainThread = readsStayedOnMainThread && Thread.isMainThread
        didReadEvents?()
        return records
    }
}
