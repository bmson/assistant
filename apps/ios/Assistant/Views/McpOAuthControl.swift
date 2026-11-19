import AuthenticationServices
import SwiftUI
import UIKit

struct McpOAuthStatus: Decodable {
    enum Grant: String, Decodable {
        case none, authorized
        case reauthorizationRequired = "reauthorization_required"
    }

    let connectionId: String
    let signInAvailable: Bool
    let grant: Grant
    let grantGeneration: String?
    let providerAvailable: Bool?

    func confirms(flowId: String) -> Bool {
        grant == .authorized && grantGeneration == flowId
    }
}

struct McpOAuthStart: Decodable {
    let connectionId: String
    let flowId: String
    let authorizationUrl: URL
    let expiresAt: String

    var expiry: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }

    func matchesCallback(_ url: URL) -> Bool {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            items.count == 1, items[0].name == "flowId"
        else { return false }
        return items[0].value == flowId
    }
}

struct McpOAuthFlow: Decodable {
    enum Outcome: String, Decodable {
        case pending, processing, authorized, denied, cancelled, expired, failed, superseded

        var isPending: Bool { self == .pending || self == .processing }
    }

    let connectionId: String
    let flowId: String
    let outcome: Outcome
}

@MainActor
struct McpOAuthControl: View {
    let connection: McpConnection
    let disabled: Bool
    @Environment(AppModel.self) private var model
    @State private var browser = GoogleCalendarAuthenticationSession()
    @State private var window: UIWindow?
    @State private var status: McpOAuthStatus?
    @State private var pending: String?
    @State private var providerAvailable = false
    @State private var notice: String?
    @State private var busy = false
    @State private var unconfirmed = false
    @State private var confirmingDisconnect = false
    @State private var isVisible = false
    @State private var generation = UUID()

    private enum Unverified: Error { case response }
    private let unknown = "Couldn’t confirm the change. Check its status before trying again."

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            if status?.grant == .authorized {
                Text("Tool sign-in authorized").font(.subheadline.weight(.semibold))
            } else if status?.grant == .reauthorizationRequired {
                Text("Tool sign-in needs attention").font(.subheadline.weight(.semibold))
            }
            if status?.signInAvailable != false, pending == nil, !unconfirmed,
                !providerAvailable
            {
                action("Check browser sign-in") {
                    run { context, current in
                        let verified = try await context.client.mcpOAuthStatus(
                            id: connection.id, verifyProvider: true)
                        guard verified.connectionId == connection.id else {
                            throw Unverified.response
                        }
                        guard accepts(context, current) else { return }
                        status = verified
                        providerAvailable = verified.providerAvailable == true
                        if !providerAvailable {
                            notice =
                                "Browser sign-in isn’t available for this service. Manual setup is still available."
                        }
                    }
                }
            }
            if let status, status.signInAvailable, pending == nil, !unconfirmed,
                providerAvailable
            {
                action(
                    status.grant == .none ? "Sign in to this service" : "Reconnect sign-in",
                    extraDisabled: window == nil
                ) {
                    guard let window else { return }
                    run { context, current in
                        try await connect(context, window: window, current: current)
                    }
                }
            }
            if pending != nil || unconfirmed {
                action("Check sign-in status") {
                    run { context, current in
                        try await reconcile(context, flowId: pending, current: current)
                    }
                }
            }
            if let pending {
                action("Cancel sign-in attempt", extraDisabled: unconfirmed) {
                    run { context, current in
                        try await reconcile(
                            context, flowId: pending, cancel: true, current: current)
                    }
                }
            }
            if let status, status.grant != .none {
                Button("Disconnect sign-in", role: .destructive) {
                    confirmingDisconnect = true
                }
                .buttonStyle(
                    AssistantActionButtonStyle(
                        kind: .destructive, fillsWidth: true, minimumHeight: 44)
                )
                .disabled(disabled || busy || unconfirmed || pending != nil)
            }
            if busy {
                ProgressView("Checking tool sign-in…").font(.caption)
            } else if let notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
        }
        .background(AssistantWindowReader(window: $window).frame(width: 0, height: 0))
        .onAppear { isVisible = true }
        .task {
            isVisible = true
            guard let context = model.mcpSignInOptionsRequestContext(for: connection),
                model.mcpSignInOptionsConnectionIsCurrent(context)
            else { return }
            let current = generation
            busy = true
            do {
                try await reconcile(context, flowId: nil, current: current)
            } catch {
                if accepts(context, current), !Task.isCancelled {
                    notice = "Couldn’t check tool sign-in. Try Check browser sign-in."
                }
            }
            if accepts(context, current) { busy = false }
        }
        .onDisappear {
            isVisible = false
            generation = UUID()
            browser.cancel()
            status = nil
            pending = nil
            providerAvailable = false
            notice = nil
            busy = false
            unconfirmed = false
        }
        .confirmationDialog("Disconnect tool sign-in?", isPresented: $confirmingDisconnect) {
            Button("Disconnect sign-in", role: .destructive) {
                run { context, current in
                    try await context.client.disconnectMcpOAuth(id: connection.id)
                    try await reconcile(context, flowId: nil, current: current)
                    guard accepts(context, current) else { return }
                    if status?.grant == McpOAuthStatus.Grant.none {
                        notice = "Tool sign-in disconnected."
                    } else {
                        notice = unknown
                        unconfirmed = true
                    }
                }
            }
        } message: {
            Text(
                "This removes authorization for this tool service. The saved connection and any manual bearer token are kept."
            )
        }
    }

    private func action(_ title: String, extraDisabled: Bool = false, perform: @escaping () -> Void)
        -> some View
    {
        Button(title, action: perform)
            .buttonStyle(
                AssistantActionButtonStyle(kind: .secondary, fillsWidth: true, minimumHeight: 44)
            )
            .disabled(disabled || busy || extraDisabled)
    }

    private func accepts(_ context: McpSignInOptionsRequestContext, _ current: UUID) -> Bool {
        generation == current && isVisible && model.mcpSignInOptionsConnectionIsCurrent(context)
    }

    private func run(_ work: @escaping (McpSignInOptionsRequestContext, UUID) async throws -> Void)
    {
        guard !disabled, !busy, isVisible,
            let context = model.mcpSignInOptionsRequestContext(for: connection),
            model.mcpSignInOptionsConnectionIsCurrent(context)
        else { return }
        let current = generation
        busy = true
        notice = nil
        Task {
            defer { if accepts(context, current) { busy = false } }
            do { try await work(context, current) } catch {
                guard accepts(context, current) else { return }
                notice = unknown
                providerAvailable = false
                unconfirmed = true
            }
        }
    }

    private func connect(_ context: McpSignInOptionsRequestContext, window: UIWindow, current: UUID)
        async throws
    {
        let start = try await context.client.startMcpOAuth(id: connection.id)
        guard start.connectionId == connection.id, UUID(uuidString: start.flowId) != nil,
            let expiry = start.expiry
        else { throw Unverified.response }
        guard accepts(context, current) else {
            _ = try? await context.client.mcpOAuthFlow(
                id: connection.id, flowId: start.flowId, cancel: true)
            return
        }
        pending = start.flowId
        do {
            _ = try await browser.authenticate(
                authorizationURL: start.authorizationUrl, expiresAt: expiry,
                anchor: window, callbackHost: "mcp", validateCallback: start.matchesCallback)
        } catch {
            let cancelled =
                error is CancellationError
                || (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
            guard cancelled else { throw error }
            try await reconcile(context, flowId: start.flowId, cancel: true, current: current)
            return
        }
        guard accepts(context, current) else { return }
        try await reconcile(context, flowId: start.flowId, current: current)
    }

    private func reconcile(
        _ context: McpSignInOptionsRequestContext, flowId: String?, cancel: Bool = false,
        current: UUID
    ) async throws {
        var outcome: McpOAuthFlow.Outcome?
        if let flowId {
            let flow = try await context.client.mcpOAuthFlow(
                id: connection.id, flowId: flowId, cancel: cancel)
            guard flow.connectionId == connection.id, flow.flowId == flowId else {
                throw Unverified.response
            }
            outcome = flow.outcome
        }
        let value = try await context.client.mcpOAuthStatus(id: connection.id)
        guard value.connectionId == connection.id else { throw Unverified.response }
        guard accepts(context, current), !Task.isCancelled else { return }
        status = value
        unconfirmed = false
        guard let outcome else { return }
        if !outcome.isPending { pending = nil }
        switch outcome {
        case .authorized:
            notice = flowId.map(value.confirms(flowId:)) == true ? "Sign-in confirmed." : unknown
        case .pending, .processing:
            notice = "Sign-in is still being checked. Refresh its status before trying again."
        case .denied:
            notice = "The service did not grant access."
        case .cancelled:
            notice = "Sign-in attempt cancelled."
        case .expired:
            notice = "This sign-in attempt expired."
        case .failed, .superseded:
            notice = "This sign-in attempt didn’t complete."
        }
    }
}
