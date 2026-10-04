import XCTest
import SwiftUI
@testable import Assistant

/// A page inventory, rendered by UIKit on an isolated simulator. No server,
/// credentials, microphone, or provider inference is used. Attachments are
/// review evidence, not pixel-perfect assertions or physical interaction QA.
final class NativeVisualReviewTests: XCTestCase {
    func testConversationSmallTextPairsClearContrast() {
        func luminance(_ color: Color) -> Double {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            XCTAssertTrue(UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha))
            XCTAssertEqual(alpha, 1, "Small text pairs must not depend on a moving backdrop")
            func linear(_ component: CGFloat) -> Double {
                let value = Double(component)
                return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }
        for scheme in [ColorScheme.light, .dark] {
            let background = luminance(AssistantTheme.stageWell(for: scheme))
            for ink in [AssistantTheme.stageStrong, AssistantTheme.stageSecondary] {
                let foreground = luminance(ink)
                let ratio = (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "Normal conversation text requires a stable contrast pair")
            }
        }
    }

    @MainActor
    func testEveryPageInLightAndDark() async throws {
        let savedAppearance = UserDefaults.standard.string(forKey: AssistantAppearance.defaultsKey)
        defer {
            if let savedAppearance { UserDefaults.standard.set(savedAppearance, forKey: AssistantAppearance.defaultsKey) }
            else { UserDefaults.standard.removeObject(forKey: AssistantAppearance.defaultsKey) }
        }
        let fixture = try NativeReviewFixture()
        NativeReviewProtocol.install(fixture.responses)
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: sessionConfig))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.native-visual-review"))
        defaults.removePersistentDomain(forName: "assistant.native-visual-review")
        let model = AppModel(apiClient: client, defaults: defaults)
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        _ = await model.refreshModelProviders()
        _ = await model.refreshMcpConnections()
        _ = await model.refreshCards()
        await model.loadPeople()
        await model.loadPersonCard(id: "robin")
        await model.loadPersonProfile(id: "robin")
        XCTAssertNotNil(model.bootstrap, model.errorMessage ?? "Missing fixture bootstrap")
        let workspace = try XCTUnwrap(model.workspace)
        let providers = try XCTUnwrap(model.modelProviders)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let routes = try pages(fixture, workspace: workspace, providers: providers)
        XCTAssertEqual(Set(routes.map(\.name)).count, routes.count)
        for scheme in [ColorScheme.light, .dark] {
            for page in routes {
                try await capture(page, scheme: scheme, size: .large, scene: scene, model: model)
            }
        }
        // Check shared hierarchy at a large accessible text size as well.
        for name in ["activity", "approvals", "more", "people", "memory", "improvements", "provider-detail", "edit-goal", "writing-voice-editor", "report-issue"] {
            let page = try XCTUnwrap(routes.first { $0.name == name })
            try await capture(page, scheme: .light, size: .accessibility3, scene: scene, model: model)
        }
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty, "Every read must remain in the fixture transport")
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty, "Screenshots must not perform mutations")
    }

    @MainActor
    func testEmptyAndRefreshFailurePages() async throws {
        let fixture = try NativeReviewFixture()
        let savedAppearance = UserDefaults.standard.string(forKey: AssistantAppearance.defaultsKey)
        defer {
            if let savedAppearance { UserDefaults.standard.set(savedAppearance, forKey: AssistantAppearance.defaultsKey) }
            else { UserDefaults.standard.removeObject(forKey: AssistantAppearance.defaultsKey) }
        }
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: sessionConfig))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.native-visual-recovery"))
        defaults.removePersistentDomain(forName: "assistant.native-visual-recovery")
        let model = AppModel(apiClient: client, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        var empty = fixture.responses
        let overviewPath = "/api/mobile/v1/overview"
        var overview = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(empty[overviewPath])) as? [String: Any])
        overview["activity"] = ["items": [], "archivedCount": 0]
        overview["goals"] = ["items": [], "archivedCount": 0]
        overview["approvals"] = ["pending": [], "resolved": []]
        empty[overviewPath] = try JSONSerialization.data(withJSONObject: overview)
        let workspacePath = "/api/mobile/v1/workspace"
        var workspace = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(empty[workspacePath])) as? [String: Any])
        workspace["skills"] = []
        workspace["improvements"] = []
        empty[workspacePath] = try JSONSerialization.data(withJSONObject: workspace)
        NativeReviewProtocol.install(empty)
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        XCTAssertEqual(model.overview?.goals.items.count, 0)
        let emptyPages: [Page] = [Page("activity-empty", ActivityView()), Page("goals-empty", GoalsView()),
                                 Page("approvals-empty", ApprovalsView()), Page("skills-empty", WorkspaceView(area: .skills))]
        for scheme in [ColorScheme.light, .dark] {
            for page in emptyPages { try await capture(page, scheme: scheme, size: .large, scene: scene, model: model) }
        }
        // Keep previous projections, then make reads fail. These are the real
        // pages' refresh/recovery UI, with their normal mutation guards intact.
        NativeReviewProtocol.install(fixture.responses)
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        _ = await model.refreshModelProviders()
        NativeReviewProtocol.install([:])
        // More retains its loaded preferences until a deliberate refresh. An
        // unloaded model exercises its real first-read failure instead of
        // incorrectly labeling cached healthy preferences as a failed refresh.
        let unloadedDefaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.native-visual-unloaded"))
        unloadedDefaults.removePersistentDomain(forName: "assistant.native-visual-unloaded")
        let unloadedModel = AppModel(apiClient: client, defaults: unloadedDefaults)
        let failedPages: [Page] = [Page("more-load-failed", MoreView()),
                                  Page("providers-refresh-failed", AIProvidersView()),
                                  Page("improvements-refresh-failed", WorkspaceView(area: .improvements)),
                                  Page("tools-load-failed", try XCTUnwrap(MoreView.visualReviewScreen("connected-tools", workspace: try XCTUnwrap(model.workspace))))]
        for scheme in [ColorScheme.light, .dark] {
            for page in failedPages {
                try await capture(page, scheme: scheme, size: .large, scene: scene,
                                  model: page.name == "more-load-failed" ? unloadedModel : model)
            }
        }
        for page in failedPages {
            try await capture(page, scheme: .light, size: .accessibility3, scene: scene,
                              model: page.name == "more-load-failed" ? unloadedModel : model)
        }
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
    }

    private struct Page {
        let name: String
        var ownsNavigation = false
        var isModal: Bool {
            ["approval-editor", "family-suggestions", "connection", "writing-voice-editor", "forget-source",
             "memory-fact", "new-memory", "correct-memory", "new-person", "edit-person", "person-details", "person-dates",
             "new-occasion", "edit-occasion", "edit-open-loop", "new-goal", "edit-goal", "map-groups", "map-add-connection",
             "map-quick-connect", "map-connections", "new-connection", "correct-connection", "edit-item",
             "assistant-settings", "new-skill", "edit-skill", "cost-limits", "report-issue"].contains(name)
        }
        let content: AnyView
        init(_ name: String, ownsNavigation: Bool = false, _ content: some View) {
            self.name = name; self.ownsNavigation = ownsNavigation; self.content = AnyView(content)
        }
    }

    @MainActor private func capture(_ page: Page, scheme: ColorScheme, size: DynamicTypeSize,
                                    scene: UIWindowScene, model: AppModel) async throws {
        UserDefaults.standard.set((scheme == .light ? AssistantAppearance.light : .dark).rawValue,
                                  forKey: AssistantAppearance.defaultsKey)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
        let host = UIHostingController(rootView: Group {
            if page.ownsNavigation { page.content }
            else if page.isModal { NavigationStack { page.content } }
            else {
                NavigationStack(path: .constant(["review"])) {
                    Color.clear.navigationTitle("Assistant")
                        .navigationDestination(for: String.self) { _ in page.content }
                }
            }
        }.environmentObject(model).environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size).transaction { $0.animation = nil; $0.disablesAnimations = true }
            .environment(\.scenePhase, .active))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(500))
        window.layoutIfNeeded()
        func record(_ position: String) {
            var rendered = false
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            XCTAssertTrue(rendered, "UIKit failed to render \(page.name)")
            XCTAssertGreaterThan(image.pngData()?.count ?? 0, 15_000, "Blank capture: \(page.name)")
            let attachment = XCTAttachment(image: image)
            attachment.name = "\(page.name)-phone-\(scheme == .light ? "light" : "dark")-\(Int(window.bounds.width))\(size.isAccessibilitySize ? "-accessible" : "")-\(position)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        record("top")
        // Lists recycle off-screen cells, so a tall bitmap alone would hide
        // rows. Capture every vertical viewport with overlapping scroll steps.
        func scrollViews(in view: UIView) -> [UIScrollView] {
            ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap { scrollViews(in: $0) }
        }
        // Presented native sheets live outside the original hosting subtree.
        if let scroll = scrollViews(in: window).filter({
            $0.bounds.width >= window.bounds.width * 0.7 && $0.bounds.height >= window.bounds.height * 0.35 &&
                $0.contentSize.height > $0.bounds.height + 12
        }).max(by: { $0.bounds.height < $1.bounds.height }) {
            let initial = scroll.contentOffset
            var offset = max(initial.y, -scroll.adjustedContentInset.top)
            var index = 0
            // A native List estimates off-screen row heights. Its extent can
            // grow dramatically as enlarged-text rows are realized, so never
            // freeze the initial bottom and silently miss the final sections.
            while index < 32 {
                let bottom = max(-scroll.adjustedContentInset.top,
                                 scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                guard offset < bottom - 2 else { break }
                offset = min(bottom, offset + scroll.bounds.height * 0.72)
                scroll.setContentOffset(CGPoint(x: initial.x, y: offset), animated: false)
                try await Task.sleep(for: .milliseconds(130))
                window.layoutIfNeeded()
                offset = scroll.contentOffset.y
                index += 1
                record("scroll-\(String(format: "%02d", index))")
            }
            let finalBottom = max(-scroll.adjustedContentInset.top,
                                  scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            XCTAssertLessThanOrEqual(finalBottom - offset, 2, "Incomplete below-fold capture: \(page.name)")
            scroll.setContentOffset(initial, animated: false)
        }
    }

    @MainActor private func pages(_ fixture: NativeReviewFixture, workspace: WorkspaceResponse,
                                  providers: ModelProviderSettings) throws -> [Page] {
        let graph = fixture.graph
        let node = try XCTUnwrap(graph.nodes.first)
        let candidates = graph.nodes.map(\.entity)
        let relation = fixture.relation
        var result: [Page] = [
            Page("chat", ownsNavigation: true, RootView()),
            Page("chat-directory", ownsNavigation: true, NavigationStack { ChatView.visualReviewMenu() }),
            Page("activity", ActivityView()), Page("goals", GoalsView()), Page("approvals", ApprovalsView()),
            Page("approval-editor", ApprovalsView.visualReviewEditor(try XCTUnwrap(fixture.overview.approvals.pending.first))),
            Page("about-open-loops", CommitmentsScreen.visualReviewGuide()),
            Page("family-suggestions", GraphFamilySuggestionsSheet(suggestions: [.init(id: "family", subject: graph.nodes[0], predicate: "sibling_of", object: graph.nodes[1], sentence: "Alex and Robin may be siblings.", reason: "A recorded parent connection links them.", support: [])])),
            Page("cards", CardsView()), Page("memory", MemoryView()), Page("people", PeopleView()), Page("more", MoreView()),
            Page("connection", ConnectionView(isOnboarding: false, showsDoneButton: true)),
            Page("connection-onboarding", ownsNavigation: true, ConnectionView(isOnboarding: true)),
            Page("ai-providers", AIProvidersView()), Page("calls", CallsView()),
            Page("call-detail", CallsView.visualReviewDetail()),
            Page("talk-paused", ownsNavigation: true, TalkView.visualReviewPaused()),
            Page("memory-library", MemoryLibraryScreen()), Page("open-loops", CommitmentsScreen()),
            Page("profile-summary", MemoryProfileScreen()), Page("writing-voice", WritingVoiceScreen()),
            Page("writing-voice-editor", VoiceProfileEditor()), Page("your-data", MemoryDataScreen()),
            Page("tidy-up", KnowledgeCleanupScreen()), Page("forget-source", KnowledgeCleanupScreen.visualReviewForget()),
            Page("memory-fact", MemoryFactSheet(fact: fixture.fact)),
            Page("new-memory", MemoryEditor(ownerContactId: "owner", fact: nil)),
            Page("correct-memory", MemoryEditor(ownerContactId: "owner", fact: fixture.fact)),
            Page("new-person", PersonEditor(person: nil)), Page("edit-person", PersonEditor(person: workspace.memory.people?.first)),
            Page("person", PersonCardScreen(personId: "robin")), Page("person-details", PersonDetailsView(personId: "robin", personName: "Robin Morgan")),
            Page("person-dates", PersonDatesScreen(personId: "robin")),
            Page("new-occasion", OccasionEditor(personId: "robin")), Page("edit-occasion", OccasionEditor(personId: "robin", occasion: fixture.occasion)),
            Page("people-connections", PeopleView.visualReviewConnections()),
            Page("relationship-evidence", PersonRelationshipEvidenceScreen(evidence: PeopleMapFixture.relations[0], didChange: {})),
            Page("edit-open-loop", CommitmentEditor(commitment: fixture.commitment, onSaved: {})),
            Page("new-goal", GoalEditor(goal: nil)), Page("edit-goal", GoalEditor(goal: fixture.goal)),
            Page("map", RelationshipGraphScreen(initialGraph: graph)),
            Page("map-groups", GraphGroupsSheet(graph: graph, focus: { _ in }, saved: { _ in })),
            Page("map-add-connection", GraphConnectSheet(source: node, graph: graph, saved: { _ in })),
            Page("map-quick-connect", GraphQuickConnectSheet(draft: .init(first: node, second: graph.nodes.dropFirst().first), saved: { _ in })),
            Page("map-settings", ownsNavigation: true, GraphSettingsSheet(settings: .constant(GraphSettings()), kinds: [.init(kind: "person", count: 8), .init(kind: "place", count: 4)], showMe: .constant(true))),
            Page("new-connection", KnowledgeConnectionEditor(selected: node.entity, candidates: candidates, didSave: {})),
            Page("correct-connection", KnowledgeConnectionEditor(selected: node.entity, relationToCorrect: relation, candidates: candidates, didSave: {})),
            Page("edit-item", KnowledgeItemEditor(item: node.entity, duplicates: [], didSave: { _ in })),
            Page("situation-packs", SituationPacksView()), Page("situation-pack", SituationPackDetail(packId: fixture.pack.id)),
        ]
        for (name, area) in [("chats", WorkspaceArea.chats), ("documents", .documents), ("skills", .skills),
                             ("capabilities", .capabilities), ("costs", .costs), ("anomalies", .anomalies), ("improvements", .improvements)] {
            result.append(Page(name, WorkspaceView(area: area)))
        }
        for name in ["reminders", "assistant-settings", "connected-tools"] {
            result.append(Page(name, try XCTUnwrap(MoreView.visualReviewScreen(name, workspace: workspace))))
        }
        for name in ["new-skill", "edit-skill", "cost-limits", "report-issue"] {
            result.append(Page(name, try XCTUnwrap(WorkspaceView.visualReviewScreen(name, workspace: workspace))))
        }
        for name in ["connect-provider", "provider-detail", "choose-model"] {
            result.append(Page(name, try XCTUnwrap(AIProvidersView.visualReviewScreen(name, providers: providers))))
        }
        for name in ["map-find", "map-connections", "map-connection-detail"] {
            result.append(Page(name, try XCTUnwrap(RelationshipGraphScreen.visualReviewScreen(name, graph: graph))))
        }
        for name in ["new-pack", "linked-item", "rehearse-change", "choice-reason"] {
            result.append(Page(name, ownsNavigation: true, try XCTUnwrap(SituationPacksView.visualReviewScreen(name, pack: fixture.pack))))
        }
        return result
    }
}

private final class NativeReviewProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var responses: [String: Data] = [:]
    private static var external: [String] = []
    private static var writes: [String] = []
    static var externalRequests: [String] { lock.withLock { external } }
    static var mutations: [String] { lock.withLock { writes } }
    static func install(_ values: [String: Data]) { lock.withLock { responses = values; external = []; writes = [] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let (status, body) = Self.lock.withLock { () -> (Int, Data) in
            guard request.url?.host == "native-review.test" else {
                Self.external.append(request.url?.absoluteString ?? "unknown"); return (403, Data(#"{"error":"fixture-only transport"}"#.utf8))
            }
            guard request.httpMethod == "GET" || request.httpMethod == nil else {
                Self.writes.append(request.url?.path ?? "unknown"); return (405, Data(#"{"error":"screenshots are read-only"}"#.utf8))
            }
            if let data = Self.responses[request.url!.path] { return (200, data) }
            return (404, Data(#"{"error":"No fixture for this read"}"#.utf8))
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private struct NativeReviewFixture {
    let graph = RelationshipGraphFixture.snapshot()
    let fact = WorkspaceMemoryFact(id: "fact-1", content: "Prefers a quiet hotel and a window seat on longer flights.", kind: "fact", domain: "preferences", ownerConfirmed: true, pinned: true, importance: 4, createdAt: "2026-10-03T09:00:00Z")
    let occasion = PersonOccasion(id: "occasion", kind: "birthday", label: "Robin’s birthday", month: 3, day: 18, year: 1986, notes: "Send a note a week ahead.", quarantined: false, leadDays: 7)
    let commitment = Commitment(id: "loop", kind: "follow_up", title: "Confirm the weekend arrival time", details: "Robin is waiting for the train schedule.", nextAction: "Share the arrival time once tickets are confirmed.", dueAt: "2026-10-08T15:00:00Z", status: "open")
    let goal = GoalRecord(id: "goal", title: "Plan a relaxed weekend away", description: "A short trip with room for a slow morning.", status: "active", priority: 3, progress: "Found **three places** near the train station.", nextAction: "Compare cancellation terms before booking.", targetDate: "2026-10-09", createdAt: "2026-10-01", updatedAt: "2026-10-03", archivedAt: nil, mirrorToPrimary: true, autonomy: false, taintedOrigin: false)
    let pack: SituationPack
    let relation: KnowledgeRelation
    let responses: [String: Data]
    let overview: OverviewResponse
    init() throws {
        let encoder = JSONEncoder()
        func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
        let stamp = "2026-10-03T09:00:00Z"
        let health = MemoryHealth(totalUsable: 42, notYetOrganized: 3, awaitingReview: 1, ownerConfirmed: 17, lastOrganizedAt: stamp)
        let conversation = ConversationView(conversation: .init(id: "main", title: "Your assistant", modelOverride: nil, archivedAt: nil, isPrimary: true), agentName: "Assistant", agentTimezone: "America/Los_Angeles", messages: [
            ChatMessage(id: "owner-message", role: .user, parts: [.init(type: "text", text: "Help me plan the weekend and keep an eye on the bookings.")]),
            ChatMessage(id: "assistant-message", role: .assistant, parts: [.init(type: "text", text: "I found three good options. I’ll keep the arrival details together and ask before making a booking."), RichMessageFixture.generated()])
        ], models: [.init(id: "review-model", label: "Default assistant model")], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        let bootstrap = BootstrapResponse(generatedAt: stamp, identity: .init(id: "fixture-owner", name: "Assistant", avatarUrl: nil), shell: .init(dashboard: .init(pendingApprovals: 1, needsAttention: 1, presence: .idle), memoryHealth: health), conversation: conversation)
        let pending = PendingApproval(approval: .init(id: "approval", taskId: "task", shortCode: "A12", summary: "Send Robin the confirmed arrival time", payload: .object(["to": .string("robin@example.test"), "subject": .string("Weekend arrival"), "body": .string("I’ll arrive at 4:30 PM on Friday.")]), resolutionPayload: nil, status: "pending", requestedAt: stamp, resolvedAt: nil, resolvedVia: nil, expiresAt: "2026-10-04T09:00:00Z"), taskType: "chat_turn", taskTrust: "owner", toolName: "gmail.send", decision: .object([:]))
        let docs = DocumentsOverview(documents: [.init(id: "document", title: "Weekend booking confirmation.pdf", mime: "application/pdf", source: "upload", trust: "owner", status: "ready", extractor: "pdf", chunkCount: 4, charCount: 2100, bytes: 31840, error: nil, createdAt: stamp)], stats: .init(total: 1, ready: 1, pending: 0, chunks: 4), primaryConversationId: "main")
        overview = OverviewResponse(generatedAt: stamp, activity: .init(items: [
            .init(id: "task", type: "chat_turn", status: "waiting_approval", title: "Share the arrival plan", progress: "Your message is ready. Waiting for your approval before sending.", trust: "owner", spentUsd: "0.012", budgetUsdLimit: "0.50", updatedAt: stamp, archivedAt: nil, hasPendingApproval: true),
            .init(id: "completed", type: "scheduled", status: "done", title: "Check the weekend forecast", progress: "Expect mild weather with some rain on Sunday.", trust: "owner", spentUsd: "0.006", budgetUsdLimit: "0.10", updatedAt: stamp, archivedAt: nil, hasPendingApproval: false)
        ], archivedCount: 0), goals: .init(items: [.init(goal: goal, conversationId: "goal-chat", workActive: false, automation: nil, cadenceLabel: "On demand", blockedQuestion: "", stalled: false)], archivedCount: 0), approvals: .init(pending: [pending], resolved: []), documents: docs)
        let workspaceData = try json([
            "generatedAt": stamp, "chats": ["current": [["id": "main", "title": "Your assistant", "isPrimary": true, "updatedAt": stamp, "active": false], ["id": "goal-chat", "title": "Weekend planning", "isPrimary": false, "updatedAt": stamp, "active": false]], "archived": []],
            "memory": ["ownerName": "Alex", "ownerContactId": "owner", "health": try JSONSerialization.jsonObject(with: encoder.encode(health)), "facts": try JSONSerialization.jsonObject(with: encoder.encode([fact])), "awaitingReview": [], "peopleCount": 3, "people": [["id": "robin", "name": "Robin Morgan", "aliases": ["Robin"], "relationship": "Friend", "trust": "owner", "factCount": 7]], "card": ["content": "Alex prefers quiet places, clear plans, and a little room to be spontaneous.\n\nThe assistant checks before making a booking or sending a message.", "compiledAt": stamp], "voiceStats": ["total": 12, "auto": 9, "uploaded": 3]],
            "skills": [["id": "skill", "name": "Prepare a weekend plan", "preconditions": "Dates and destination are confirmed.", "steps": "Compare travel times.\nCheck cancellation terms.\nKeep booking details together.", "gotchas": "Ask before making a booking.", "ownerAuthored": true, "deprecated": false, "useCount": 8, "successCount": 7, "failureCount": 1, "updatedAt": stamp]],
            "capabilities": [["id": "google", "title": "Email and calendar", "summary": "Keep your plans and messages in view.", "enabled": true, "ready": true, "status": "ready", "detail": "Connected to your account."], ["id": "browser", "title": "Browser", "summary": "Research places and compare options.", "enabled": true, "ready": false, "status": "setup_needed", "detail": "Finish connecting your browser to use this tool."]],
            "settings": ["agent": ["name": "Assistant", "timezone": "America/Los_Angeles", "locale": "en-US", "signature": "Alex"], "schedules": [], "reminders": [["id": "reminder", "text": "Check in for the Friday train", "kind": "once", "status": "scheduled", "nextRunAt": "2026-10-08T15:00:00Z"]], "policies": [], "goalAutomationCount": 1],
            "costs": ["dailySpentUsd": 0.24, "monthlySpentUsd": 7.84, "heldUsd": 0.05, "dailyLimitUsd": 2.0, "monthlyLimitUsd": 25.0, "taskDefaultLimit": "0.50", "parkedTasks": 0, "bySource": [["source": "models", "usd": "7.84", "count": 83]], "byModel": [["model": "review-model", "usd": "7.84", "count": 83]], "held": [], "topTasks": [], "recent": []],
            "anomalies": [["id": "anomaly", "kind": "approval_policy", "toolName": "gmail.send", "detail": "A standing permission was requested more often than expected.", "observed": 4, "expected": 1, "citationCount": 3, "hasPolicy": false, "createdAt": stamp]],
            "improvements": [["id": "improvement", "kind": "prompt", "title": "Ask one clearer question before planning", "rationale": "Several recent requests needed the same clarification.", "suggestion": "Confirm the destination before comparing hotels.", "evidenceCount": 3, "applyable": false, "createdAt": stamp]],
            "repairs": ["enabled": true, "configured": true, "dailyLimit": 2, "issues": [["id": "repair", "title": "Booking details repeated in chat", "summary": "The same confirmation appeared twice.", "status": "monitoring", "diagnosis": "Updated duplicate handling; waiting for you to check the original behavior.", "lastError": "", "updatedAt": stamp, "mergeSha": "abc123", "history": [["status": "testing", "at": stamp, "detail": "Regression checks passed."], ["status": "monitoring", "at": stamp, "detail": "Deployment detected."]]]]]
        ])
        let provider = ModelConnection(id: "provider", kind: "openrouter", label: "My OpenRouter", baseUrl: nil, vertexProject: nil, vertexLocation: nil, hasApiKey: true, enabled: true, source: "owner", lastTestedAt: stamp, lastError: nil)
        let providers = ModelProviderSettings(connections: [provider], models: [.init(id: "review-model", label: "Assistant model", connectionId: provider.id, enabled: true, routable: true, embedding: false, realtime: false, promptCostPerMTok: "0.30", completionCostPerMTok: "0.90", audioInputPerMTok: nil, audioOutputPerMTok: nil)], mainModel: "review-model", fastModel: "review-model", voiceModel: nil, voicePresets: [])
        let packData = Data(#"{"packs":[{"id":"pack","title":"A relaxed weekend","version":3,"archived":false,"updatedAt":"2026-10-03T09:00:00Z","data":{"items":[{"id":"ride","title":"Confirm the arrival time","details":"Share the train arrival once confirmed.","lane":"i_owe","dependsOn":[],"needsReview":true}],"decisions":[]},"changes":[],"affectedIds":["ride"]}],"sources":[]}"#.utf8)
        pack = try JSONDecoder().decode(SituationOverview.self, from: packData).packs[0]
        relation = .init(id: "father", subject: .init(id: "alex", label: "Alex Morgan", kind: "person", canonicalKey: "alex"), predicate: "parent_of", object: .init(id: "robin", label: "Robin Morgan", kind: "person", canonicalKey: "robin"), confidence: 1, reviewStatus: "confirmed", validFrom: nil, validUntil: nil, inRecall: true, source: .init(memoryId: fact.id, content: "Alex is Robin’s father.", createdAt: stamp, ownerConfirmed: true, originTrust: "owner"), presentation: .init(sentence: "Alex Morgan is Robin Morgan’s father.", label: "Parent", accessibleLabel: "Alex Morgan is Robin Morgan’s father."))
        let call = PhoneCall(id: "call-1", to: "+15550100000", contactName: "Harbor Hotel", status: "ended", active: false, outcome: "completed", summary: "Late check-in is available until 10 PM.", brief: .init(goal: "Confirm late check-in", context: "Arriving Friday evening.", mayAgreeTo: "A later arrival time", mustNot: "Make payments or change the booking"), maxMinutes: 3, createdAt: stamp, durationSeconds: 84, costUsd: "0.07", transcript: [.init(role: "assistant", text: "Can Alex check in around 9 PM?", at: stamp), .init(role: "other", text: "Yes, reception stays open until 10 PM.", at: stamp)], notes: ["Reception closes at 10 PM."], checkins: [], openCheckin: nil)
        let profile = PersonProfileResponse(contact: .init(id: "robin", name: "Robin Morgan", aliases: ["Robin"], relationship: "Friend", trust: "owner"), occasions: [occasion], mergeOptions: [], occasionSuggestions: [])
        let library = MemoryLibraryResponse(rows: [.init(id: fact.id, content: fact.content, domain: "preferences", ownerConfirmed: true, pinned: true, importance: 4, organized: true, originTrust: "owner", subjectLabel: "Alex", aboutOwner: true, connectionCount: 2, projectionStatus: "in-use", createdAt: stamp)], total: 1, page: 1, totalPages: 1, subjects: [.init(id: "owner", label: "Alex", trust: "owner")], sources: ["chat"])
        guard case let .object(cardData)? = RichMessageFixture.generated().data, let cardSpec = cardData["spec"] else { throw CocoaError(.coderInvalidValue) }
        var values: [String: Data] = [
            "bootstrap": try encoder.encode(bootstrap), "overview": try encoder.encode(overview), "workspace": workspaceData,
            "activity": try encoder.encode(overview.activity), "goals": try encoder.encode(overview.goals), "providers": try encoder.encode(providers),
            "providers/provider/models": Data(#"{"models":[]}"#.utf8), "mcp": Data(#"{"connections":[]}"#.utf8),
            "people": try encoder.encode(PersonDirectoryResponse(generatedAt: stamp, people: [.init(id: "robin", name: "Robin Morgan", initials: "RM", relationship: "Friend", group: "friends", groupLabel: "Friends", trust: "owner", location: "Oakland", factCount: 7, birthday: "18 March", birthdayDaysUntil: 166, lastContact: "Last contact yesterday")])),
            "people/robin": try encoder.encode(PeopleMapFixture.card()), "memory/people/robin": try encoder.encode(profile),
            "memory/profile": try json(["voiceStats": ["total": 12, "auto": 9, "uploaded": 3], "voiceProfile": ["description": "Warm, direct, and clear. Use short paragraphs and a natural rhythm.", "dos": ["Keep the main point first", "Use plain words"], "donts": ["Avoid unnecessary ceremony"], "signature": "Alex"]]),
            "memory/library": try encoder.encode(library), "memory/commitments": try encoder.encode(CommitmentsResponse(commitments: [commitment])),
            "cards": try encoder.encode(SavedCardsResponse(cards: [.init(id: "saved-1", revisionId: "r1", status: "active", spec: cardSpec, conversationId: "main", updatedAt: stamp)])),
            "packs": packData, "calls": try encoder.encode(PhoneCallsResponse(calls: [call])), "calls/call-1": try encoder.encode(PhoneCallResponse(call: call)),
            "knowledge/graph": try encoder.encode(graph), "knowledge/cleanup": try encoder.encode(KnowledgeCleanupResponse(findings: [.init(id: "finding", kind: "unreviewed_relation", title: "Check a newly remembered connection", detail: "Confirm this before it guides a future answer.", memoryId: fact.id, relationId: relation.id, count: 1)])),
            "knowledge/sources/fact-1": try encoder.encode(KnowledgeSourceImpact(memoryId: fact.id, content: fact.content, connectionCount: 2, activeConnectionCount: 2, retiredProjectionCount: 0, orphanedItems: [])),
            "knowledge/relations/father": try encoder.encode(relation), "chats/main": try encoder.encode(conversation),
            "knowledge": try encoder.encode(KnowledgeOverview(totalEntities: graph.nodes.count, totalRelations: graph.edges.count, unreviewedRelations: 1, entities: graph.nodes.map(\.entity), matchingEntities: graph.nodes.count, entityPage: 1, entityPages: 1, selected: graph.nodes.first!.entity, relations: [relation], selectedActiveRelationTotal: 1, duplicates: []))
        ]
        // Card data is private fixture material, never fetched from a live account.
        values["knowledge/\(graph.nodes.first!.id)"] = try encoder.encode(graph.nodes.first!.entity)
        responses = Dictionary(uniqueKeysWithValues: values.map { ("/api/mobile/v1/" + $0.key, $0.value) })
    }
}
