#if DEBUG && ASSISTANT_UI_TEST_FIXTURES
import SwiftUI
import Foundation

private struct FixtureArguments {
    let scene: String
    let nonce: String
    init?(_ args: [String]) {
        guard args.count == 8 else { return nil }
        var values: [String: String] = [:]
        let allowed: Set<String> = ["--fixture-case", "--fixture-theme", "--fixture-text-size", "--fixture-nonce"]
        for index in stride(from: 0, to: args.count, by: 2) {
            let key = args[index]
            guard allowed.contains(key), values[key] == nil else { return nil }
            values[key] = args[index + 1]
        }
        guard let scene = values["--fixture-case"], ["approvals", "proactive"].contains(scene),
              let theme = values["--fixture-theme"], theme == "light",
              let text = values["--fixture-text-size"], text == "default",
              let nonce = values["--fixture-nonce"],
              nonce.range(of: "^[A-Za-z0-9_-]{1,48}$", options: .regularExpression) != nil else { return nil }
        self.scene = scene; self.nonce = nonce
    }
}

@main
struct AssistantFixtureApp: App {
    var body: some Scene {
        WindowGroup {
            if let args = FixtureArguments(Array(ProcessInfo.processInfo.arguments.dropFirst())) {
                FixtureRoot(arguments: args)
            } else {
                Text("fixture.error").accessibilityIdentifier("fixture.error")
            }
        }
    }
}

private struct FixtureRoot: View {
    let arguments: FixtureArguments
    @State private var model: AppModel?
    @State private var failed = false
    @State private var ready = false
    @State private var registrations = 0
    @State private var defaults: UserDefaults?
    @State private var session: URLSession?

    var body: some View {
        VStack(spacing: 0) {
            if failed {
                Text("fixture.error").accessibilityIdentifier("fixture.error")
            } else if ready {
                Text("ready").font(.caption2).accessibilityIdentifier("fixture.ready")
                TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                    Text(String(FixtureTransport.state.violations))
                        .font(.caption2).accessibilityIdentifier("fixture.transport.violations")
                }
                Text(String(registrations)).font(.caption2)
                    .accessibilityIdentifier("fixture.notifications.registrations")
                if arguments.scene == "approvals", let model {
                    NavigationStack { ApprovalsView().environment(model) }
                        .accessibilityIdentifier("fixture.surface.approvals")
                } else {
                    ScrollView {
                        ProactiveAlertContent(category: "calendar", urgency: "for_your_attention",
                            title: "Synthetic source listings need review",
                            summary: "The source listings have different times. Review the original source before making a change.",
                            startsAt: "", dueAt: "",
                            details: [.init(label: "Source qualification", value: "The phone calendar was not checked. These synthetic facts are not evidence of live calendar coverage.")],
                            actionSummary: "Read both original listings before deciding.")
                            .padding(16)
                    }.accessibilityIdentifier("fixture.surface.proactive")
                }
            } else { ProgressView("Preparing synthetic fixture") }
        }
        .environment(\.colorScheme, .light)
        .environment(\.dynamicTypeSize, .large)
        .transaction { $0.animation = nil; $0.disablesAnimations = true }
        .task { await prepare() }
    }

    @MainActor private func prepare() async {
        guard !ready, !failed else { return }
        if arguments.scene == "proactive" { ready = true; return }
        do {
            let suite = "assistant.fixture.\(arguments.nonce)"
            guard let store = UserDefaults(suiteName: suite) else { throw APIError.invalidResponse }
            store.removePersistentDomain(forName: suite)
            defaults = store
            let id = "approval"
            let pending = PendingApproval(approval: .init(id: id, taskId: "synthetic-task", shortCode: "A12",
                summary: "Send the synthetic arrival update only to the named recipient.",
                payload: .object(["to": .string("recipient@example.test"), "body": .string("Synthetic arrival update")]),
                resolutionPayload: nil, status: "pending", requestedAt: "2026-11-04T09:00:00Z",
                resolvedAt: nil, resolvedVia: nil, expiresAt: "2099-11-04T09:00:00Z"),
                taskType: "chat_turn", taskTrust: "owner", toolName: "gmail.send", decision: .object([:]))
            let overview = OverviewResponse(generatedAt: "2026-11-04T09:00:00Z",
                activity: .init(items: [], archivedCount: 0), goals: .init(items: [], archivedCount: 0),
                approvals: .init(pending: [pending], resolved: []),
                documents: .init(documents: [], stats: .init(total: 0, ready: 0, pending: 0, chunks: 0), primaryConversationId: "synthetic-main"))
            FixtureTransport.state.install(try JSONEncoder().encode(overview))
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [FixtureTransport.self]
            configuration.urlCache = nil; configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil; configuration.httpShouldSetCookies = false
            configuration.timeoutIntervalForRequest = 3; configuration.timeoutIntervalForResource = 3
            let session = URLSession(configuration: configuration); self.session = session
            let client = APIClient(configuration: .init(baseURL: URL(string: "https://fixture.invalid")!, token: "synthetic-only"), session: session)
            let model = AppModel(apiClient: client, defaults: store,
                storeConnectionToken: { _ in }, enqueueAutomaticSpeech: { _ in },
                scheduleLocalNotification: { _, _, _, _, _, _ in false },
                registerNotificationHandlers: { _ in registrations += 1 },
                systemSurfaces: FixtureSystemSurfaces(),
                phoneCalendarSharing: PhoneCalendarSharingCoordinator(source: FixtureCalendarSource(),
                    recordStore: FixtureCalendarRecords(), installationID: "synthetic-installation"),
                captureCurrentPlace: { nil },
                cardFormMobileSessionFactory: { _, _ in throw APIError.invalidResponse })
            guard await model.refreshOverview(reportFailure: false),
                  model.pendingApprovalCount == 1, registrations == 1,
                  FixtureTransport.state.violations == 0 else { throw APIError.invalidResponse }
            self.model = model
            ready = true
        } catch { failed = true }
    }
}
#else
#error("Fixture app must only compile in the isolated Debug fixture host")
#endif
