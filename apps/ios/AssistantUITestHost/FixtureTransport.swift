#if DEBUG && ASSISTANT_UI_TEST_FIXTURES
import Foundation
import EventKit

/// In-memory responses for explicit synthetic fixture routes. No request is forwarded.
final class FixtureTransport: URLProtocol, @unchecked Sendable {
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var data: Data?
        private var noticing: Data?
        private var count = 0
        private var householdCalendar = false
        private var choices: [String: String] = [:]
        private var revision: String?
        private let calendarRoot = "/api/mobile/v1/connections/google-calendar"
        private let connectionId = "12345678-1234-4123-8123-123456789012"

        private let detailSources = [
            (id: "family", name: "Family", purpose: "household", title: "Family appointment"),
            (id: "school", name: "Oak School", purpose: "school", title: "Science fair"),
            (id: "activity", name: "Community club", purpose: "activity", title: "Practice"),
            (id: "holidays", name: "Holiday calendar", purpose: "holidays", title: "Local holiday")
        ]

        func install(_ value: Data, householdCalendar: Bool, noticing: Data?) {
            lock.withLock {
                data = value
                self.householdCalendar = householdCalendar
                self.noticing = noticing
            }
        }

        func response(for request: URLRequest) -> Data? {
            lock.withLock {
                if let url = request.url, url.scheme == "https", url.host == "fixture.invalid" {
                    if request.httpMethod == "GET", url.path == "/api/mobile/v1/overview", url.query == nil {
                        return data
                    }
                    if request.httpMethod == "GET", url.path == "/api/mobile/v1/proactive-health",
                       url.query == nil, let noticing {
                        return noticing
                    }
                    if householdCalendar, let response = householdResponse(for: request, url: url) {
                        return response
                    }
                }
                count = min(count + 1, 999)
                return nil
            }
        }

        private func householdResponse(for request: URLRequest, url: URL) -> Data? {
            if url.path == calendarRoot + "/household",
               request.value(forHTTPHeaderField: "x-assistant-household-calendar-version") != "2" { return nil }
            switch (request.httpMethod, url.path) {
            case ("GET", "/api/mobile/v1/bootstrap"):
                return Data("""
                {"generatedAt":"2026-11-19T08:00:00Z","identity":{"id":"synthetic-owner","name":"Assistant"},
                 "shell":{"dashboard":{"pendingApprovals":1,"needsAttention":0,"presence":"idle"},
                 "memoryHealth":{"totalUsable":0,"notYetOrganized":0,"awaitingReview":0,"ownerConfirmed":0}},
                 "conversation":{"conversation":{"id":"synthetic-main","isPrimary":true},"agentName":"Assistant",
                 "agentTimezone":"America/Los_Angeles","messages":[],"models":[],"canArchive":false}}
                """.utf8)
            case ("GET", calendarRoot):
                return try? JSONEncoder().encode(GoogleCalendarStatus(
                    configured: true, state: "connected",
                    account: .init(subject: "synthetic-personal", email: "personal@example.test"),
                    capabilities: .init(calendarRead: true), flow: nil, connectionId: connectionId
                ))
            case ("GET", calendarRoot + "/household") where url.query == nil:
                return householdSetup()
            case ("GET", calendarRoot + "/household"):
                guard choices["family"] == "household", choices["work"] == "work_free_busy" else { return nil }
                let details = detailSources.filter { choices[$0.id] == $0.purpose }.map { source in
                    ["id": source.id, "title": source.title, "calendar": source.name, "allDay": false,
                     "start": "2026-11-19T18:00:00.000Z", "end": "2026-11-19T19:00:00.000Z"] as [String: Any]
                }
                let busy: [String: Any] = [
                    "id": "busy", "title": "Busy", "calendar": "Work", "allDay": false,
                    "start": "2026-11-19T20:00:00.000Z", "end": "2026-11-19T21:00:00.000Z"
                ]
                return try? JSONSerialization.data(withJSONObject: ["complete": true, "rows": details + [busy]])
            case ("PUT", calendarRoot + "/household"):
                guard let body = request.httpBody ?? request.httpBodyStream.map(readBody),
                      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      object["connectionId"] as? String == connectionId,
                      object["revision"] as? String == revision,
                      let rows = object["choices"] as? [[String: String]] else { return nil }
                var next: [String: String] = [:]
                for row in rows {
                    guard let id = row["id"], let purpose = row["purpose"], next[id] == nil else { return nil }
                    next[id] = purpose
                }
                let allowed = Dictionary(uniqueKeysWithValues: detailSources.map { ($0.id, $0.purpose) })
                guard next["family"] == "household", next["work"] == "work_free_busy", next["other"] == "ignore",
                      next.allSatisfy({ id, purpose in
                          id == "work" || id == "other" ||
                              (allowed[id] != nil && (purpose == allowed[id] || purpose == "ignore"))
                      }) else { return nil }
                choices = next
                revision = UUID().uuidString.lowercased()
                return householdSetup()
            default: return nil
            }
        }

        private func readBody(_ stream: InputStream) -> Data {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while body.count < 4096 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
            return body
        }

        private func householdSetup() -> Data? {
            let sources = detailSources.map { ($0.id, $0.name, true) } + [
                ("work", "Work", false), ("other", "Other", false)
            ]
            let calendars = sources.map { id, name, details in
                ["id": id, "name": name, "canShowDetails": details, "canShowBusy": true,
                 "purpose": choices[id] as Any? ?? NSNull()]
            }
            return try? JSONSerialization.data(withJSONObject: [
                "state": "ready", "connectionId": connectionId, "revision": revision as Any? ?? NSNull(),
                "remaining": sources.count - choices.count, "calendars": calendars,
                "extendedPurposesAvailable": true
            ])
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
