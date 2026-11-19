import AuthenticationServices
import SwiftUI
import UIKit

struct McpOAuthStatus: Decodable, Sendable {
    enum Grant: String, Decodable, Sendable {
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

struct McpOAuthFlow: Decodable, Sendable {
    enum Outcome: String, Decodable, Sendable {
        case pending, processing, authorized, denied, cancelled, expired, failed, superseded

        var isPending: Bool { self == .pending || self == .processing }
    }

    let connectionId: String
    let flowId: String
    let outcome: Outcome
}

protocol McpOAuthRecoveryService: Sendable {
    func mcpOAuthStatus(id: String, verifyProvider: Bool) async throws -> McpOAuthStatus
    func mcpOAuthFlow(id: String, flowId: String, cancel: Bool) async throws -> McpOAuthFlow
}
extension APIClient: McpOAuthRecoveryService {}

struct McpOAuthRecovery {
    struct Snapshot {
        let status: McpOAuthStatus; let outcome: McpOAuthFlow.Outcome?; let flowUnavailable: Bool
    }
    enum InvalidResponse: Error { case identity }
    static func read(
        _ service: any McpOAuthRecoveryService, connectionID: String, flowID: String?, cancel: Bool = false
    ) async throws -> Snapshot {
        var outcome: McpOAuthFlow.Outcome?
        var unavailable = false
        if let flowID {
            do {
                let flow = try await service.mcpOAuthFlow(id: connectionID, flowId: flowID, cancel: cancel)
                guard flow.connectionId == connectionID, flow.flowId == flowID else {
                    throw InvalidResponse.identity
                }
                outcome = flow.outcome
            } catch APIError.server(status: 404, message: _) {
                unavailable = true
            }
        }
        let status = try await service.mcpOAuthStatus(id: connectionID, verifyProvider: false)
        guard status.connectionId == connectionID else { throw InvalidResponse.identity }
        return .init(status: status, outcome: outcome, flowUnavailable: unavailable)
    }
}

struct McpOAuthDisconnectIntent {
    let ownerID: String
    let version: Int
    let identity: McpSignInOptionsIdentity
    let viewGeneration: UUID
    let grantGeneration: String?

    func matches(
        _ context: McpSignInOptionsRequestContext, viewGeneration: UUID,
        grantGeneration: String?, starting: Bool, pendingFlow: String?
    ) -> Bool {
        !starting && pendingFlow == nil && self.viewGeneration == viewGeneration
            && ownerID == context.ownerID && version == context.version
            && identity == context.identity && self.grantGeneration == grantGeneration
    }
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
    @State private var starting = false
    @State private var providerAvailable = false
    @State private var notice: String?
    @State private var busy = false
    @State private var unconfirmed = false
    @State private var confirmingDisconnect = false
    @State private var disconnectIntent: McpOAuthDisconnectIntent?
    @State private var isVisible = false
    @State private var generation = UUID()

    private enum Unverified: Error { case response }
    private let statusUnavailable = "Couldn’t load the saved sign-in status. Try again."
    private let unknown = "Couldn’t confirm the change. Check its status before trying again."

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            if status?.grant == .authorized {
                Text("Tool sign-in authorized").font(.subheadline.weight(.semibold))
            } else if status?.grant == .reauthorizationRequired {
                Text("Tool sign-in needs attention").font(.subheadline.weight(.semibold))
            }
            if status?.signInAvailable == true, pending == nil, !starting, !unconfirmed,
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
            if let status, status.signInAvailable, pending == nil, !starting, !unconfirmed,
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
            if starting {
                Text("Sign-in is starting. Its status will be available here.").font(.caption)
            }
            if pending != nil || unconfirmed || starting {
                action("Check sign-in status") {
                    run(failureNotice: statusUnavailable) { context, current in
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
                    guard let context = model.mcpSignInOptionsRequestContext(for: connection),
                        accepts(context, generation), !model.mcpSignInAttemptIsStarting(context),
                        model.pendingMcpSignInFlow(for: context) == nil
                    else { return }
                    disconnectIntent = .init(
                        ownerID: context.ownerID, version: context.version,
                        identity: context.identity, viewGeneration: generation,
                        grantGeneration: status.grantGeneration)
                    confirmingDisconnect = true
                }
                .buttonStyle(
                    AssistantActionButtonStyle(
                        kind: .destructive, fillsWidth: true, minimumHeight: 44)
                )
                .disabled(disabled || busy || starting || unconfirmed || pending != nil)
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
                try await restoreAttempt(context, current: current)
            } catch {
                if accepts(context, current), !Task.isCancelled {
                    unconfirmed = true
                    notice = statusUnavailable
                }
            }
            if accepts(context, current) { busy = false }
        }
        .onChange(of: model.mcpSignInAttemptRevision) { _, _ in
            guard isVisible, let context = model.mcpSignInOptionsRequestContext(for: connection) else {
                return
            }
            let restored = model.pendingMcpSignInFlow(for: context)
            let isStarting = model.mcpSignInAttemptIsStarting(context)
            guard pending != restored || starting != isStarting else { return }
            let arrived = restored != nil && pending != restored
            pending = restored
            starting = isStarting
            if arrived && !busy {
                run(failureNotice: statusUnavailable) { context, current in
                    try await restoreAttempt(context, current: current)
                }
            }
        }
        .onDisappear {
            isVisible = false
            generation = UUID()
            browser.cancel()
            confirmingDisconnect = false
            disconnectIntent = nil
            status = nil
            pending = nil
            starting = false
            providerAvailable = false
            notice = nil
            busy = false
            unconfirmed = false
        }
        .confirmationDialog("Disconnect tool sign-in?", isPresented: $confirmingDisconnect) {
            Button("Disconnect sign-in", role: .destructive) {
                guard let intent = disconnectIntent else { return }
                disconnectIntent = nil
                run { context, current in
                    guard
                        intent.matches(
                            context, viewGeneration: current,
                            grantGeneration: status?.grantGeneration,
                            starting: model.mcpSignInAttemptIsStarting(context),
                            pendingFlow: model.pendingMcpSignInFlow(for: context))
                    else { return }
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

    private func run(
        failureNotice: String? = nil,
        _ work: @escaping (McpSignInOptionsRequestContext, UUID) async throws -> Void
    ) {
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
                notice = failureNotice ?? unknown
                providerAvailable = false
                unconfirmed = true
            }
        }
    }

    private func connect(_ context: McpSignInOptionsRequestContext, window: UIWindow, current: UUID)
        async throws
    {
        guard let ticket = model.beginMcpSignInAttempt(context) else { return }
        let start: McpOAuthStart
        do { start = try await context.client.startMcpOAuth(id: connection.id) } catch {
            model.abandonMcpSignInAttempt(ticket, context: context); throw error
        }
        guard start.connectionId == connection.id, UUID(uuidString: start.flowId) != nil,
            let expiry = start.expiry
        else { model.abandonMcpSignInAttempt(ticket, context: context); throw Unverified.response }
        // Retain a valid late start response across navigation, but never replace a newer start.
        guard model.retainMcpSignInFlow(start.flowId, ticket: ticket, context: context) else { return }
        guard accepts(context, current) else { return }
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
            guard accepts(context, current), model.pendingMcpSignInFlow(for: context) == start.flowId else {
                return
            }
            try await reconcile(context, flowId: start.flowId, cancel: true, current: current)
            return
        }
        guard accepts(context, current) else { return }
        try await reconcile(context, flowId: start.flowId, current: current)
    }

    private func restoreAttempt(_ context: McpSignInOptionsRequestContext, current: UUID) async throws {
        let restored = model.pendingMcpSignInFlow(for: context)
        pending = restored
        starting = model.mcpSignInAttemptIsStarting(context)
        try await reconcile(context, flowId: restored, current: current)
        // A start response may arrive during the initial read in a newly appeared view.
        guard accepts(context, current) else { return }
        let latest = model.pendingMcpSignInFlow(for: context)
        starting = model.mcpSignInAttemptIsStarting(context)
        if latest != restored {
            pending = latest
            try await reconcile(context, flowId: latest, current: current)
        }
    }

    private func reconcile(
        _ context: McpSignInOptionsRequestContext, flowId: String?, cancel: Bool = false,
        current: UUID
    ) async throws {
        // A stale view (including its browser cancellation callback) cannot mutate any flow.
        guard accepts(context, current), model.pendingMcpSignInFlow(for: context) == flowId else { return }
        let snapshot = try await McpOAuthRecovery.read(
            context.client, connectionID: connection.id, flowID: flowId, cancel: cancel)
        guard accepts(context, current), !Task.isCancelled,
            model.pendingMcpSignInFlow(for: context) == flowId
        else { return }
        let value = snapshot.status
        status = value
        unconfirmed = false
        if snapshot.flowUnavailable {
            if let flowId { model.clearMcpSignInFlow(flowId, context: context) }
            pending = nil
            notice =
                flowId.map(value.confirms(flowId:)) == true
                ? "Sign-in confirmed." : "Saved sign-in status loaded. This attempt is no longer available."
            return
        }
        guard let outcome = snapshot.outcome else { return }
        if !outcome.isPending {
            if let flowId { model.clearMcpSignInFlow(flowId, context: context) }
            pending = nil
        }
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
