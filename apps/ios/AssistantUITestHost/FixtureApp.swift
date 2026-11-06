#if DEBUG && ASSISTANT_UI_TEST_FIXTURES
import SwiftUI
import Foundation
import UIKit

private struct FixtureArguments {
    let scene: String
    let theme: String
    let textSize: String
    let orientation: String
    let nonce: String
    init?(_ args: [String]) {
        guard args.count == 10 else { return nil }
        var values: [String: String] = [:]
        let allowed: Set<String> = ["--fixture-case", "--fixture-theme", "--fixture-text-size", "--fixture-orientation", "--fixture-nonce"]
        for index in stride(from: 0, to: args.count, by: 2) {
            let key = args[index]
            guard allowed.contains(key), values[key] == nil else { return nil }
            values[key] = args[index + 1]
        }
        guard let scene = values["--fixture-case"], ["approvals", "proactive"].contains(scene),
              let theme = values["--fixture-theme"], ["light", "dark"].contains(theme),
              let text = values["--fixture-text-size"], ["default", "accessibility5"].contains(text),
              let orientation = values["--fixture-orientation"], ["portrait", "landscape"].contains(orientation),
              let nonce = values["--fixture-nonce"],
              nonce.range(of: "^[A-Za-z0-9_-]{1,48}$", options: .regularExpression) != nil else { return nil }
        self.scene = scene; self.theme = theme; self.textSize = text
        self.orientation = orientation; self.nonce = nonce
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
    @State private var windowOrientation = "unknown"

    var body: some View {
        VStack(spacing: 0) {
            if failed {
                Text("fixture.error").accessibilityIdentifier("fixture.error")
            } else if ready {
                Text("ready").font(.system(size: 10)).accessibilityIdentifier("fixture.ready")
                TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                    Text(String(FixtureTransport.state.violations))
                        .font(.system(size: 10)).accessibilityIdentifier("fixture.transport.violations")
                }
                Text(String(registrations)).font(.system(size: 10))
                    .accessibilityIdentifier("fixture.notifications.registrations")
                FixtureEnvironmentReadout(
                    requestedOrientation: arguments.orientation,
                    windowOrientation: windowOrientation
                )
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
        .preferredColorScheme(arguments.theme == "dark" ? .dark : .light)
        .environment(\.dynamicTypeSize, arguments.textSize == "accessibility5" ? .accessibility5 : .large)
        .transaction { $0.animation = nil; $0.disablesAnimations = true }
        .background {
            FixtureWindowOrientationProbe { reported in
                if windowOrientation != reported { windowOrientation = reported }
            }
            .frame(width: 1, height: 1)
            .opacity(0)
            .accessibilityHidden(true)
        }
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

private struct FixtureEnvironmentReadout: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let requestedOrientation: String
    let windowOrientation: String

    var body: some View {
        let theme = colorScheme == .dark ? "dark" : "light"
        let textSize: String
        switch dynamicTypeSize {
        case .large: textSize = "default"
        case .accessibility5: textSize = "accessibility5"
        default: textSize = "unknown"
        }
        let vertical: String
        switch verticalSizeClass {
        case .compact?: vertical = "compact"
        case .regular?: vertical = "regular"
        default: vertical = "unknown"
        }
        Text("theme=\(theme);size=\(textSize);vertical=\(vertical);requestedOrientation=\(requestedOrientation);windowOrientation=\(windowOrientation)")
            .font(.system(size: 10))
            .lineLimit(1)
            .accessibilityIdentifier("fixture.host.environment")
    }
}

@MainActor
private struct FixtureWindowOrientationProbe: UIViewRepresentable {
    let report: (String) -> Void

    func makeUIView(context: Context) -> FixtureOrientationReportingView {
        let view = FixtureOrientationReportingView()
        view.report = report
        return view
    }

    func updateUIView(_ view: FixtureOrientationReportingView, context: Context) {
        view.report = report
        view.reportWindowOrientation()
    }
}

@MainActor
private final class FixtureOrientationReportingView: UIView {
    var report: ((String) -> Void)?
    private var lastReportedOrientation: String?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        reportWindowOrientation()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        reportWindowOrientation()
    }

    func reportWindowOrientation() {
        guard let orientation = window?.windowScene?.interfaceOrientation else { return }
        let value: String
        switch orientation {
        case .portrait, .portraitUpsideDown: value = "portrait"
        case .landscapeLeft, .landscapeRight: value = "landscape"
        case .unknown: value = "unknown"
        @unknown default: value = "unknown"
        }
        guard value != lastReportedOrientation else { return }
        lastReportedOrientation = value
        let callback = report
        DispatchQueue.main.async { callback?(value) }
    }
}
#else
#error("Fixture app must only compile in the isolated Debug fixture host")
#endif
