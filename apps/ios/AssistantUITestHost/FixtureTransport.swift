#if DEBUG && ASSISTANT_UI_TEST_FIXTURES
import Foundation
import EventKit

/// A private session consumes only the single synthetic overview read. No
/// request is forwarded, including redirects and mutation attempts.
final class FixtureTransport: URLProtocol, @unchecked Sendable {
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var data: Data?
        private var count = 0
        func install(_ value: Data) { lock.lock(); defer { lock.unlock() }; data = value }
        func response(for request: URLRequest) -> Data? {
            lock.lock(); defer { lock.unlock() }
            guard request.httpMethod == "GET", let url = request.url,
                  url.scheme == "https", url.host == "fixture.invalid",
                  url.path == "/api/mobile/v1/overview", url.query == nil,
                  let data else { count = min(count + 1, 999); return nil }
            return data
        }
        var violations: Int { lock.lock(); defer { lock.unlock() }; return count }
    }
    static let state = State()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let data = Self.state.response(for: request), data.count <= 65_536,
              let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                  headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
struct FixtureSystemSurfaces: AppSystemSurfaces {
    func ensure(agentName: String, thought: AssistantThought, detail: String, pendingCount: Int) async {}
    func start(agentName: String, thought: AssistantThought, detail: String, pendingCount: Int) async {}
    func update(thought: AssistantThought, detail: String, pendingCount: Int) async {}
    func needsAttention(agentName: String, detail: String, pendingCount: Int) async {}
    func finish(thought: AssistantThought, detail: String, succeeded: Bool) async {}
    func dismiss() async {}
    func updateBadge(_ count: Int) async {}
}

@MainActor
struct FixtureCalendarSource: PhoneCalendarSource {
    let access: PhoneCalendarAccess = .denied
    func requestAccess() async throws -> Bool { false }
    func calendars() -> [PhoneCalendar] { [] }
    func events(in interval: DateInterval, calendarIDs: Set<String>) -> [PhoneCalendarEvent] { [] }
}

@MainActor
final class FixtureCalendarRecords: PhoneCalendarSharingRecordStore {
    func load(scope: String) -> PhoneCalendarSharingLocalRecord? { nil }
    func save(_ record: PhoneCalendarSharingLocalRecord, scope: String) -> Bool { false }
}
#else
#error("Fixture transport must only compile in the isolated Debug fixture host")
#endif
