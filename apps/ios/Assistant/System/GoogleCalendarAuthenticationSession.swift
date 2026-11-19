import AuthenticationServices
import Foundation

enum GoogleCalendarAuthenticationError: LocalizedError, Equatable {
    case alreadySigningIn
    case invalidAuthorizationURL
    case expired
    case invalidCallback
    case couldNotStart

    var errorDescription: String? {
        switch self {
        case .alreadySigningIn: "Google sign-in is already open."
        case .invalidAuthorizationURL: "Couldn’t open Google sign-in. Try connecting again."
        case .expired: "This sign-in has expired. Try connecting again."
        case .invalidCallback: "Couldn’t verify this sign-in. Try connecting again."
        case .couldNotStart: "Couldn’t open Google sign-in. Try again."
        }
    }
}

@MainActor
protocol GoogleCalendarWebAuthenticationSession: AnyObject {
    func start() -> Bool
    func cancel()
}

extension ASWebAuthenticationSession: GoogleCalendarWebAuthenticationSession {}

/// Owns only the system browser handoff. The caller binds the callback to its
/// pending server flow and reads canonical connection status after completion.
@MainActor
final class GoogleCalendarAuthenticationSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    typealias Completion = @MainActor (URL?, Error?) -> Void
    typealias Factory = @MainActor (URL, String, @escaping Completion) -> any GoogleCalendarWebAuthenticationSession

    private let factory: Factory?
    private var session: (any GoogleCalendarWebAuthenticationSession)?
    private var continuation: CheckedContinuation<URL, Error>?
    private var operationID: UUID?
    private var anchor: ASPresentationAnchor?

    init(factory: Factory? = nil) { self.factory = factory }

    nonisolated static func hasExpectedCallbackRoute(_ url: URL, host: String = "google-calendar") -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme == "assistant-oauth" && components.host == host
            && components.path == "/callback" && components.user == nil && components.password == nil
            && components.port == nil && components.fragment == nil
    }

    func authenticate(
        authorizationURL: URL,
        expiresAt: Date,
        anchor: ASPresentationAnchor,
        callbackHost: String = "google-calendar",
        validateCallback: @escaping @MainActor (URL) -> Bool
    ) async throws -> URL {
        guard operationID == nil else { throw GoogleCalendarAuthenticationError.alreadySigningIn }
        guard let components = URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false),
              components.scheme == "https", components.host?.isEmpty == false,
              components.user == nil, components.password == nil, components.fragment == nil else {
            throw GoogleCalendarAuthenticationError.invalidAuthorizationURL
        }
        guard expiresAt > Date() else { throw GoogleCalendarAuthenticationError.expired }
        try Task.checkCancellation()
        let id = UUID()
        operationID = id
        self.anchor = anchor
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let completion: Completion = { [weak self] url, error in
                    guard let self, self.operationID == id else { return }
                    if let error { self.finish(.failure(error), id: id); return }
                    guard expiresAt > Date() else {
                        self.finish(.failure(GoogleCalendarAuthenticationError.expired), id: id); return
                    }
                    guard let url, Self.hasExpectedCallbackRoute(url, host: callbackHost), validateCallback(url) else {
                        self.finish(.failure(GoogleCalendarAuthenticationError.invalidCallback), id: id); return
                    }
                    self.finish(.success(url), id: id)
                }
                if let factory {
                    session = factory(authorizationURL, "assistant-oauth", completion)
                } else {
                    let browser = ASWebAuthenticationSession(url: authorizationURL, callbackURLScheme: "assistant-oauth") { url, error in
                        Task { @MainActor in completion(url, error) }
                    }
                    browser.presentationContextProvider = self
                    browser.prefersEphemeralWebBrowserSession = true
                    session = browser
                }
                if session?.start() != true {
                    finish(.failure(GoogleCalendarAuthenticationError.couldNotStart), id: id)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id: id) }
        }
    }

    func cancel() {
        guard let operationID else { return }
        cancel(id: operationID)
    }

    private func cancel(id: UUID) {
        guard operationID == id else { return }
        let browser = session
        finish(.failure(CancellationError()), id: id)
        browser?.cancel()
    }

    private func finish(_ result: Result<URL, Error>, id: UUID) {
        guard operationID == id else { return }
        let pending = continuation
        continuation = nil
        operationID = nil
        session = nil
        anchor = nil
        pending?.resume(with: result)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }
}
