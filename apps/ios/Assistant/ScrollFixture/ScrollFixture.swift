#if ASSISTANT_SCROLL_FIXTURE
import Foundation
import SwiftUI
import UIKit

@MainActor
enum ScrollFixture {
    static let enabled = ProcessInfo.processInfo.arguments.contains("--assistant-scroll-fixture")
    static let baseURL = URL(string: "https://assistant-scroll-fixture.invalid")!
    static let rowCount = 500
    static let client = APIClient(
        configuration: .init(baseURL: baseURL, token: "fixture-only"),
        session: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [ScrollFixtureProtocol.self]
            return URLSession(configuration: configuration)
        }(),
        clientID: "33333333-3333-4333-8333-333333333333"
    )

    static func makeModel() -> AppModel {
        // A fixture-compiled binary without its second opt-in fails closed.
        precondition(enabled, "ScrollPerformance requires --assistant-scroll-fixture")
        let suite = "assistant.scroll-fixture.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(
            apiClient: client,
            defaults: defaults,
            storeConnectionToken: { _ in },
            enqueueAutomaticSpeech: { _ in },
            scheduleLocalNotification: { _, _, _, _, _, _ in false },
            phoneCalendarSharing: PhoneCalendarSharingCoordinator(
                source: EmptyCalendar(), recordStore: EmptyCalendarRecords(),
                deviceTimeZone: TimeZone(secondsFromGMT: 0)!, installationID: "fixture-only"
            ),
            captureCurrentPlace: { nil }
        )
    }

    private final class EmptyCalendar: PhoneCalendarSource {
        var access: PhoneCalendarAccess { .denied }
        func requestAccess() async throws -> Bool { false }
        func calendars() -> [PhoneCalendar] { [] }
        func events(in interval: DateInterval, calendarIDs: Set<String>) -> [PhoneCalendarEvent] { [] }
    }
    private final class EmptyCalendarRecords: PhoneCalendarSharingRecordStore {
        func load(scope: String) -> PhoneCalendarSharingLocalRecord? { nil }
        func save(_ record: PhoneCalendarSharingLocalRecord, scope: String) -> Bool { false }
    }
}

/// The ordinary app WindowGroup hosts the real ChatView; no extra UIWindow,
/// hard-coded screen bounds, scroll offsets or gesture-recognizer injection.
struct ScrollFixtureRoot: View {
    let model: AppModel
    @State private var loaded = false

    var body: some View {
        Group {
            if loaded {
                // Retain RootView's NavigationStack, crown, error/save overlays,
                // and the complete ChatView gesture/reader hierarchy.
                RootView().environment(model)
            } else {
                Color.clear
            }
        }
        .preferredColorScheme(.light)
        .environment(\.dynamicTypeSize, .large)
        .environment(\.locale, Locale(identifier: "en_US"))
        .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
        .statusBarHidden(true)
        .task {
            guard !loaded else { return }
            do {
                let response = try await ScrollFixture.client.bootstrap()
                guard response.conversation.messages.count == ScrollFixture.rowCount else {
                    throw URLError(.badServerResponse)
                }
                model.installScrollFixture(response)
                loaded = true
            } catch {
                ScrollFixtureDiagnostics.shared.failure = "bootstrap: \(error)"
            }
        }
        .overlay(alignment: .bottomTrailing) {
            // Available even if bootstrap fails, so the smoke fails with a receipt.
            ScrollFixtureProbe().frame(width: 1, height: 1).allowsHitTesting(false)
        }
    }
}

/// Every request is intercepted, including unknown hosts. No fallback transport.
final class ScrollFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        do {
            guard request.url?.host == "assistant-scroll-fixture.invalid" else {
                throw URLError(.unsupportedURL)
            }
            let data: Data
            if method == "GET", path == "/api/mobile/v1/bootstrap" {
                data = try ScrollFixtureData.bootstrap(messages: ScrollFixtureData.messages(count: 500))
            } else if method == "POST",
                      path.hasPrefix("/api/mobile/v1/chats/\(ScrollFixtureData.conversationID)/messages/"),
                      let id = path.split(separator: "/").last,
                      Self.assistantIDs.contains(String(id)) {
                data = Data("{\"ok\":true}".utf8)
            } else {
                throw URLError(.unsupportedURL)
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            Task { @MainActor in
                ScrollFixtureDiagnostics.shared.failure = "Unexpected request: \(method) \(path)"
            }
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
    private static let assistantIDs = Set((0..<500).filter { !$0.isMultiple(of: 2) }.map { "scroll-bench-assistant-\($0)" })
}
#endif
