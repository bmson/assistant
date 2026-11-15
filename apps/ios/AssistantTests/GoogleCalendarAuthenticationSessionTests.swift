import AuthenticationServices
import XCTest
@testable import Assistant

@MainActor
final class GoogleCalendarAuthenticationSessionTests: XCTestCase {
    private final class Browser: GoogleCalendarWebAuthenticationSession {
        var didStart = false
        var didCancel = false
        var canStart = true
        func start() -> Bool { didStart = true; return canStart }
        func cancel() { didCancel = true }
    }

    func testCallbackRequiresExactRouteWithoutCredentialsPortOrFragment() {
        XCTAssertTrue(GoogleCalendarAuthenticationSession.hasExpectedCallbackRoute(
            URL(string: "assistant-oauth://google-calendar/callback?flowId=opaque")!))
        for value in [
            "assistant://google-calendar/callback", "assistant-oauth://other/callback",
            "assistant-oauth://google-calendar/callback/", "assistant-oauth://google-calendar/other",
            "assistant-oauth://user@google-calendar/callback", "assistant-oauth://google-calendar:123/callback",
            "assistant-oauth://google-calendar/callback#token"
        ] {
            XCTAssertFalse(GoogleCalendarAuthenticationSession.hasExpectedCallbackRoute(URL(string: value)!), value)
        }
    }

    func testExpiredAndInsecureStartsNeverOpenBrowser() async {
        var created = false
        let authentication = GoogleCalendarAuthenticationSession { _, _, _ in
            created = true
            return Browser()
        }
        for (value, expiry, expected) in [
            ("http://assistant.example.com/start", Date().addingTimeInterval(60), GoogleCalendarAuthenticationError.invalidAuthorizationURL),
            ("https://assistant.example.com/start", Date.distantPast, .expired)
        ] {
            do {
                _ = try await authentication.authenticate(authorizationURL: URL(string: value)!, expiresAt: expiry,
                                                          anchor: ASPresentationAnchor(), validateCallback: { _ in true })
                XCTFail("Invalid start accepted")
            } catch { XCTAssertEqual(error as? GoogleCalendarAuthenticationError, expected) }
        }
        XCTAssertFalse(created)
    }

    func testMismatchedFlowCannotCompleteSignIn() async {
        var completion: GoogleCalendarAuthenticationSession.Completion?
        let authentication = GoogleCalendarAuthenticationSession { _, scheme, callback in
            XCTAssertEqual(scheme, "assistant-oauth")
            completion = callback
            return Browser()
        }
        let task = Task {
            try await authentication.authenticate(authorizationURL: URL(string: "https://assistant.example.com/start")!,
                                                   expiresAt: Date().addingTimeInterval(60), anchor: ASPresentationAnchor(),
                                                   validateCallback: { $0.query == "flowId=expected" })
        }
        while completion == nil { await Task.yield() }
        completion?(URL(string: "assistant-oauth://google-calendar/callback?flowId=other"), nil)
        do { _ = try await task.value; XCTFail("Mismatched flow accepted") }
        catch { XCTAssertEqual(error as? GoogleCalendarAuthenticationError, .invalidCallback) }
    }

    func testCancellationRejectsLateCallbackAndAllowsAnotherAttempt() async throws {
        var callbacks: [GoogleCalendarAuthenticationSession.Completion] = []
        var browsers: [Browser] = []
        let authentication = GoogleCalendarAuthenticationSession { _, _, callback in
            callbacks.append(callback)
            let browser = Browser()
            browsers.append(browser)
            return browser
        }
        func attempt() -> Task<URL, Error> {
            Task {
                try await authentication.authenticate(authorizationURL: URL(string: "https://assistant.example.com/start")!,
                                                       expiresAt: Date().addingTimeInterval(60), anchor: ASPresentationAnchor(),
                                                       validateCallback: { _ in true })
            }
        }
        let first = attempt()
        while callbacks.count < 1 { await Task.yield() }
        first.cancel()
        do { _ = try await first.value; XCTFail("Cancelled attempt succeeded") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(browsers[0].didCancel)
        let second = attempt()
        while callbacks.count < 2 { await Task.yield() }
        let returned = URL(string: "assistant-oauth://google-calendar/callback?flowId=second")!
        callbacks[0](URL(string: "assistant-oauth://google-calendar/callback?flowId=first"), nil)
        callbacks[1](returned, nil)
        let result = try await second.value
        XCTAssertEqual(result, returned)
    }

    func testBrowserStartFailureClearsPendingSession() async {
        let authentication = GoogleCalendarAuthenticationSession { _, _, _ in
            let browser = Browser()
            browser.canStart = false
            return browser
        }
        for _ in 0..<2 {
            do {
                _ = try await authentication.authenticate(authorizationURL: URL(string: "https://assistant.example.com/start")!,
                                                          expiresAt: Date().addingTimeInterval(60), anchor: ASPresentationAnchor(),
                                                          validateCallback: { _ in true })
                XCTFail("Start failure accepted")
            } catch { XCTAssertEqual(error as? GoogleCalendarAuthenticationError, .couldNotStart) }
        }
    }
}
