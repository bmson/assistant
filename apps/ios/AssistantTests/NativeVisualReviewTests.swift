import XCTest
import SwiftUI
@testable import Assistant

/// A page inventory, rendered by UIKit on an isolated simulator. No server,
/// credentials, microphone, or provider inference is used. Attachments are
/// review evidence, not pixel-perfect assertions or physical interaction QA.
final class NativeVisualReviewTests: XCTestCase {
    @MainActor
    func testOptimisticSaveFeedbackInLightDarkAndLargeText() async throws {
        let fixture = try NativeReviewFixture()
        NativeReviewProtocol.install(fixture.responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: configuration))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.optimistic-save-visual-review"))
        defaults.removePersistentDomain(forName: "assistant.optimistic-save-visual-review")
        let model = AppModel(apiClient: client, defaults: defaults)
        // CI deliberately runs an unsigned Simulator app. Exercise the real
        // encrypted file journal with an isolated vault instead of Keychain.
        let recoveryRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let vault = TestMobileEditKeyVault()
        model.edits.recoveryJournalFactory = { scope in
            MobileEditRecoveryJournal(scope: scope, keyVault: vault, applicationSupportRoot: recoveryRoot)
        }
        defer { try? FileManager.default.removeItem(at: recoveryRoot) }
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        await model.loadPeople()
        model.present(.settings)
        defer { model.edits.reset() }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let gate = NativeSaveReviewGate()
        model.edits.reconcile = { _ in false }
        model.edits.submit(title: "Assistant settings", draft: "Signature: Review draft", resources: [.workspace], patch: {
            $0.workspace?.settings.agent.signature = "Review draft"
        }) {
            await gate.wait()
            throw APIError.server(status: 400, message: "The submitted settings were rejected. Your draft is kept for review.")
        }
        for scheme in [ColorScheme.light, .dark] {
            for size in [DynamicTypeSize.large, .accessibility3] {
                try await capture(Page("save-pending", ownsNavigation: true,
                    RootView().environment(\.scenePhase, .inactive)), scheme: scheme, size: size, scene: scene, model: model)
            }
        }
        XCTAssertEqual(model.edits.pendingCount, 1)
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Review draft")
        gate.release()
        await model.edits.settle()
        XCTAssertEqual(model.edits.failures.count, 1)
        XCTAssertEqual(model.workspace?.settings.agent.signature, "Alex")
        for scheme in [ColorScheme.light, .dark] {
            for size in [DynamicTypeSize.large, .accessibility3] {
                try await capture(Page("save-needs-review", ownsNavigation: true,
                    RootView().environment(\.scenePhase, .inactive)), scheme: scheme, size: size, scene: scene, model: model)
            }
        }
        model.edits.dismissFailure(try XCTUnwrap(model.edits.failures.first?.id))
        model.edits.submit(title: "Assistant settings", resources: [.workspace], patch: {
            $0.workspace?.settings.agent.signature = "Saved signature"
        }) {}
        await model.edits.settle()
        XCTAssertTrue(model.edits.needsRefresh)
        for scheme in [ColorScheme.light, .dark] {
            try await capture(Page("save-confirmed-refresh-pending", ownsNavigation: true,
                RootView().environment(\.scenePhase, .inactive)), scheme: scheme, size: .large, scene: scene, model: model)
        }
        let exported = try JSONSerialization.data(withJSONObject: fixture.responses.mapValues { $0.base64EncodedString() }, options: [.sortedKeys])
        let attachment = XCTAttachment(data: exported, uniformTypeIdentifier: "public.json")
        attachment.name = "mobile-interaction-fixtures.json"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
    }

    @MainActor
    func testPartialAnswerNoticeFormatting() async throws {
        let fixture = try NativeReviewFixture()
        NativeReviewProtocol.install(fixture.responses)
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: sessionConfig))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.partial-answer-visual-review"))
        defaults.removePersistentDomain(forName: "assistant.partial-answer-visual-review")
        let model = AppModel(apiClient: client, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let message = ChatMessage(id: "partial-answer-fixture", role: .assistant, parts: [
            .init(type: "text", text: """
            The return date still needs confirmation.

            - **Flight:** 17 October. [Booking](https://example.com/booking)
            - **Transfer:** duration unverified. [Transport source](https://example.com/transport)

            | Option | Checked detail |
            | --- | --- |
            | Train | Requires one change |
            | Taxi | Fare unverified |
            """),
            .init(type: "notice", notice: "response-contract")
        ])
        let page = Page("partial-answer-notice", ownsNavigation: true, ScrollView {
            MessageBubble(message: message, userPrompt: nil, isStreaming: false,
                          openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
                .padding(20)
        })
        for scheme in [ColorScheme.light, .dark] {
            for size in [DynamicTypeSize.large, .accessibility3] {
                try await capture(page, scheme: scheme, size: size, scene: scene, model: model,
                                  requiresScrolling: size.isAccessibilitySize && scene.coordinateSpace.bounds.width < 600)
            }
        }
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
    }

    @MainActor
    func testConversationSpacingAndContextRows() async throws {
        NativeReviewProtocol.install([:])
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: sessionConfig))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.conversation-spacing-visual-review"))
        defaults.removePersistentDomain(forName: "assistant.conversation-spacing-visual-review")
        let model = AppModel(apiClient: client, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)

        let digest = String(repeating: "a", count: 64)
        let sources: [MessageRecallSource] = [
            .init(date: "2026-10-18", label: "The last planning conversation where Robin asked to keep Friday's arrival flexible", kind: "chat", hops: 1, surfaceKey: nil, sourceRevision: nil),
            .init(date: "2026-10-17", label: "Robin prefers a quiet hotel near the station and a room away from the street", kind: "knowledge_graph", hops: 2, surfaceKey: digest, sourceRevision: String(repeating: "b", count: 64)),
            .init(date: "2026-10-16", label: "Choose a refundable place before confirming the train", kind: "situation_decision", hops: 1, surfaceKey: String(repeating: "c", count: 64), sourceRevision: String(repeating: "d", count: 64)),
            .init(date: "2026-10-15", label: "Confirm the weekend arrival time with Robin after the ticket is booked", kind: "commitment", hops: 1, surfaceKey: String(repeating: "e", count: 64), sourceRevision: String(repeating: "f", count: 64)),
            .init(date: "2026-10-14", label: "Saved context with a deliberately long source title to check wrapping without clipping or squeezing the controls", kind: "future_source", hops: 1, surfaceKey: nil, sourceRevision: nil),
        ]
        let briefing = MessagePart(type: "data-card", data: .object([
            "kind": .string("briefing"), "id": .string("briefing-review"), "date": .string("Saturday, October 24"),
            "lead": .string("A relaxed start, with one decision to make before you leave."),
            "sections": .array([
                .object(["type": .string("agenda"), "title": .string("Today"), "complete": .bool(true), "items": .array([
                    .object(["day": .string("Today"), "time": .string("9:30 AM"), "title": .string("Train to the coast"), "location": .string("Oakland station"), "flag": .string("On time"), "note": .string("Arrive ten minutes early")]),
                    .object(["day": .string("Today"), "time": .string("3:00 PM"), "title": .string("Check in at Harbor House"), "location": .string("Near the old town"), "flag": .string("Flexible"), "note": .string("Cancellation is available until Thursday")])
                ])]),
                .object(["type": .string("weather"), "title": .string("Weather"), "location": .string("Monterey"), "temperature": .string("18°"), "condition": .string("Clouds and sun"), "symbol": .string("cloud.sun.fill"), "detail": .string("A light jacket should be enough.")])
            ])
        ]))
        let calendarAgenda = MessagePart(type: "data-card", data: .object([
            "kind": .string("briefing"), "id": .string("calendar-agenda-review"),
            "presentation": .string("calendar-agenda"), "title": .string("Agenda"),
            "date": .string("Tuesday, October 27 · Pacific Time"),
            "lead": .string("Eight events across Personal and Work; all calendars checked."),
            "sections": .array([.object([
                "type": .string("agenda"), "title": .string("Tuesday, October 27"), "complete": .bool(true),
                "items": .array((0..<8).map { index in .object([
                    "id": .string("agenda-review-\(index)"),
                    "day": .string(index == 0 ? "All day" : "Timed"),
                    "time": .string(index == 0 ? "All day" : "\(9 + index):00 AM"),
                    "title": .string(index == 0 ? "City holiday" : "Review \(index) with the team"),
                    "location": .string(index == 0 ? "" : "Room \(index)"),
                    "note": .string(index == 1 ? "Needs response" : ""),
                    "calendars": .array([.string(index == 0 ? "Personal" : "Work")]),
                    "calendarLinks": .array([.object(["label": .string("Open in Work"), "url": .string("https://calendar.google.com/event/review-\(index)")])]),
                    "meetingLink": .object(["label": .string("Join meeting"), "url": .string("https://meet.google.com/review-\(index)")]),
                ]) })
            ]),
            .object([
                "type": .string("attention"), "title": .string("4 possible overlaps"),
                "items": .array([.object(["title": .string("4 possible overlaps"), "detail": .string("Calendar overlap does not confirm attendance.")])]),
                "overlaps": .array((0..<4).map { index in .object([
                    "title": .string("Review \(index + 1) overlaps with another event"),
                    "detail": .string("The two schedules overlap by 20 minutes."),
                ]) }),
            ])
            ])
        ]))
        let alert = MessagePart(type: "data-card", data: RichMessageFixture.alert)
        let event = MessagePart(type: "data-card", data: .object([
            "kind": .string("calendar-event"), "id": .string("spacing-event"),
            "start": .string("2026-10-24T09:30:00-07:00"), "time": .string("9:30 AM"),
            "title": .string("Train to the coast"), "location": .string("Oakland station"),
            "attendees": .array([]), "calendars": .array([.string("Personal")]),
        ]))
        let messages: [ChatMessage] = [
            .optimistic(role: .user, text: "Plan a quiet weekend with Robin.", id: "spacing-user-short"),
            .optimistic(role: .assistant, text: "I’ll keep it simple and leave room to adjust.", id: "spacing-assistant-short"),
            .optimistic(role: .user, text: "Can you compare the options and remind me what we already decided?", id: "spacing-user-long"),
            ChatMessage(id: "spacing-assistant-long", role: .assistant, parts: [
                .init(type: "text", text: "**Harbor House** is close to the station, and the cancellation window gives us some flexibility.\n\nThe train gets in at 4:30 PM. I can keep the arrival time handy and check whether the hotel can hold the room until then.\n\nThe saved decision was to choose a refundable place before confirming travel."),
                .init(type: "text", text: "One more thing: I’ll keep the check-in time open until the tickets are booked."),
                .init(type: "recall", sources: sources),
            ]),
            ChatMessage(id: "spacing-assistant-second-bubble", role: .assistant, parts: [
                .init(type: "text", text: "One more detail: the last conversation left the check-in time open until the tickets were booked."),
                .init(type: "recall", sources: [sources[3], sources[4]]),
            ]),
            ChatMessage(id: "spacing-recall-missing", role: .assistant, parts: [
                .init(type: "text", text: "This older reply has recall content without hydrated source rows, so it should keep a calm empty state."),
                .init(type: "recall", sources: []),
            ]),
            ChatMessage(id: "spacing-receipt", role: .assistant, parts: [
                .init(type: "text", text: "Sent Robin the confirmed arrival time."),
                .init(type: "approval", approvalId: "receipt-1", shortCode: "A12", summary: "Send Robin the confirmed arrival time", purpose: "Weekend arrival", status: "approved"),
            ]),
            ChatMessage(id: "spacing-receipt-followup", role: .assistant, parts: [
                .init(type: "text", text: "Confirmed the hotel can hold the room until 5 PM."),
                .init(type: "approval", approvalId: "receipt-2", shortCode: "A13", summary: "Confirm the hotel's late arrival window", purpose: "Weekend arrival", status: "approved"),
            ]),
            ChatMessage(id: "stream-spacing-current", role: .assistant, parts: [
                .init(type: "text", text: "I’m checking the latest arrival details now.")
            ]),
            ChatMessage(id: "spacing-proactive", role: .assistant, parts: [
                .init(type: "text", text: "There is one item to review before the weekend."), alert, event,
            ]),
            ChatMessage(id: "spacing-briefing", role: .assistant, parts: [
                .init(type: "text", text: "Here is your weekend briefing."), briefing,
            ]),
            ChatMessage(id: "spacing-calendar-agenda", role: .assistant, parts: [
                .init(type: "text", text: "Here is the schedule for Tuesday."), calendarAgenda,
            ]),
            ChatMessage(id: "spacing-generated", role: .assistant, parts: [
                .init(type: "text", text: "I kept the travel details together for quick reference."), RichMessageFixture.generated(),
            ]),
        ]
        func transcript(sending: Bool) -> ChatTranscriptRows {
            ChatTranscriptRows(
            messages: messages, isSending: sending,
            openApprovals: {}, send: { _, _ in },
            decideApproval: { _, _ in false }, rememberApproval: { _ in false },
            decideSuggestion: { _, _ in nil }, openActivity: {},
            refreshCard: { _, _ in nil }, hideMessage: { _ in },
            setRecallSourceSuppressed: { _, _, _ in .failed },
            recallSourceSuppressed: { _, _ in nil },
            acknowledgeMessageDelivery: { _ in false },
            cardFormActions: nil, cardFormStateRevision: 0, cardFormTaskRevision: 0
            )
        }
        let page = Page("conversation-spacing-context", ownsNavigation: true, ScrollView {
            transcript(sending: true).padding(.horizontal, 16).padding(.vertical, 8)
        }.background(AssistantTheme.stage))
        for scheme in [ColorScheme.light, .dark] {
            try await capture(page, scheme: scheme, size: .large, scene: scene, model: model, requiresScrolling: true)
            try await capture(page, scheme: scheme, size: .accessibility3, scene: scene, model: model, requiresScrolling: true)
        }
        let highContrastPage = Page("conversation-spacing-context-increased-contrast", ownsNavigation: true,
            ScrollView { transcript(sending: true).padding(.horizontal, 16).padding(.vertical, 8) }
                .background(AssistantTheme.stage))
        try await capture(highContrastPage, scheme: .light, size: .accessibility3, scene: scene, model: model,
                          requiresScrolling: true, increasedContrast: true)
        for size in [DynamicTypeSize.large, .accessibility3] {
            try await capture(page, scheme: .light, size: size, scene: scene, model: model,
                              requiresScrolling: true, viewportWidth: 320)
        }
        let settledPage = Page("conversation-spacing-settled", ownsNavigation: true, ScrollView {
            transcript(sending: false).padding(.horizontal, 16).padding(.vertical, 8)
        }.background(AssistantTheme.stage))
        try await capture(settledPage, scheme: .light, size: .large, scene: scene, model: model, requiresScrolling: true)
        // Exercise the same standalone overflow composition in its expanded
        // state; the first three results remain outside this disclosure.
        let cards = try [alert, event, briefing, RichMessageFixture.generated()].map {
            try XCTUnwrap(MessageResponseCard(part: $0))
        }
        XCTAssertEqual(cards.count, 4)
        let expandedPage = Page("conversation-spacing-expanded-results", ownsNavigation: true, ScrollView {
            VStack(spacing: 8) {
                RichResponseCards(cards: Array(cards.prefix(3)))
                CardDisclosure(collapsedLabel: "Show 1 more result", expandedLabel: "Showing all 4 results",
                               standalone: true, showsBottomCollapse: true, initiallyExpanded: true) {
                    RichResponseCards(cards: Array(cards.suffix(1)))
                }
            }.padding(.horizontal, 16).padding(.vertical, 8)
        }.background(AssistantTheme.stage))
        try await capture(expandedPage, scheme: .light, size: .large, scene: scene, model: model, requiresScrolling: true)
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
    }

    @MainActor
    func testGeneratedTableFormatting() async throws {
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [NativeReviewProtocol.self]
        NativeReviewProtocol.install([:])
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: sessionConfig))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.table-visual-review"))
        defaults.removePersistentDomain(forName: "assistant.table-visual-review")
        let model = AppModel(apiClient: client, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let entries = [("hotel", "Harbor House"), ("price", "$189 per night"),
                       ("location", "Historic waterfront, 20 minutes from the station"),
                       ("policy", "Free cancellation until 6 PM Thursday"),
                       ("hotel2", "Station Garden"), ("price2", "$145 per night"),
                       ("location2", "Opposite the central railway station"), ("policy2", "Non-refundable")]
        let facts: [String: MessageResponseCard.GeneratedFact] = Dictionary(uniqueKeysWithValues: entries.map {
            ($0.0, .init(id: $0.0, label: $0.0, value: $0.1, sensitive: false))
        })
        for count in [2, 3, 4] {
            let columns = Array(["Hotel", "Price", "Location", "Cancellation"].prefix(count))
            let rows = [["hotel", "price", "location", "policy"], ["hotel2", "price2", "location2", "policy2"]]
            let block = MessageResponseCard.GeneratedBlock(id: "comparison", type: "table", values: [
                "columns": .array(columns.map { .string($0) }),
                "rows": .array(rows.map { .array($0.prefix(count).map { .string($0) }) })
            ])
            let page = Page("generated-table-\(count)-columns", ownsNavigation: true, ScrollView {
                GeneratedCardBlockView(block: block, facts: facts, cardId: "visual-review").padding(20)
            })
            for scheme in [ColorScheme.light, .dark] {
                for size in [DynamicTypeSize.large, .accessibility3] {
                    try await capture(page, scheme: scheme, size: size, scene: scene, model: model,
                                      requiresScrolling: count == 4 && size.isAccessibilitySize && scene.coordinateSpace.bounds.width < 600)
                }
            }
        }
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
    }

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
            let link = luminance(AssistantTheme.accent(for: scheme))
            let paper = luminance(AssistantTheme.bubblePaper(for: scheme))
            let linkRatio = (max(link, paper) + 0.05) / (min(link, paper) + 0.05)
            XCTAssertGreaterThanOrEqual(linkRatio, 4.5, "Small Markdown links must remain readable on reply paper")
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
    func testImprovementsRepairEvidenceStatesInLightDarkAndAccessibleText() async throws {
        let stamp = "2026-10-22T19:00:00Z"
        let cases: [(String, [String: Any])] = [
            ("recorded-pr-old-review", [
                "id": "repair-pr", "title": "The recorded pull request may have a newer revision",
                "summary": "Saved independent review for an earlier commit.", "status": "pr_open",
                "diagnosis": "The original issue is fixed in the proposed change.", "lastError": "",
                "sourceTaskId": "3d60a0fb-3939-455a-9e36-b54073c3b4df",
                "prUrl": "https://github.com/example/repo/pull/31",
                "runUrl": "https://github.com/example/repo/actions/runs/41", "updatedAt": stamp,
                "workerProvider": "github", "prNumber": 31,
                "mergeSha": NSNull(), "codeReview": [
                    "commitSha": "abcdef0123456789abcdef0123456789abcdef01", "approved": true,
                    "modelId": "review-model", "summary": "The saved revision addresses the issue. Check the current pull request revision and checks before merging.",
                    "reviewedAt": "2026-10-22T18:00:00Z",
                ],
                "history": [["status": "testing", "at": stamp, "detail": "Regression checks passed for the reviewed commit."],
                            ["status": "pr_open", "at": stamp, "detail": "Pull request recorded; current head not checked."]],
            ]),
            ("provider-blocked-before-extra-attempt", [
                "id": "repair-blocked", "title": "Publisher setup is required before another attempt",
                "summary": "The attempted code fix could not be published.", "status": "blocked",
                "diagnosis": "The publisher is not configured for this repository.",
                "lastError": "Publisher settings are incomplete.", "updatedAt": stamp,
                "workerProvider": "github", "prNumber": NSNull(),
                "prUrl": NSNull(), "runUrl": NSNull(), "mergeSha": NSNull(),
                "outcome": ["message": "The publisher is not configured.", "nextStep": "Check publisher settings before retrying."],
                "waitingReason": "Repository publishing settings need attention.",
                "history": [["status": "blocked", "at": stamp, "detail": "Publishing stopped before a pull request was created."]],
            ]),
            ("deployment-observed-needs-confirmation", [
                "id": "repair-monitoring", "title": "The original behavior still needs checking",
                "summary": "A deployment was observed for the merged revision.", "status": "monitoring",
                "diagnosis": "Check the original behavior before confirming the fix.", "lastError": "",
                "updatedAt": stamp, "prUrl": "https://github.com/example/repo/pull/32",
                "runUrl": NSNull(), "mergeSha": "fedcba9876543210", "deploymentConfirmed": true,
                "workerProvider": "github", "prNumber": 32,
                "history": [["status": "merged", "at": stamp, "detail": "Merged revision fedcba9876543210."],
                            ["status": "monitoring", "at": stamp, "detail": "Deployment observed. Owner confirmation remains pending."]],
            ]),
            ("closed-report-history", [
                "id": "repair-closed", "title": "A dismissed report remains available in history",
                "summary": "The report was closed without removing its recorded evidence.", "status": "dismissed",
                "diagnosis": "The report was dismissed after review.", "lastError": "", "updatedAt": stamp,
                "prUrl": NSNull(), "runUrl": NSNull(), "mergeSha": NSNull(),
                "workerProvider": "github", "prNumber": NSNull(),
                "history": [["status": "reported", "at": "2026-10-20T19:00:00Z", "detail": "Report saved."],
                            ["status": "dismissed", "at": stamp, "detail": "Owner dismissed the report; history retained."]],
            ]),
        ]

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, repair) in cases {
            let repairData = try JSONSerialization.data(withJSONObject: repair)
            let decodedRepair = try JSONDecoder().decode(WorkspaceRepairIssue.self, from: repairData)
            XCTAssertEqual(decodedRepair.id, repair["id"] as? String, "Repair fixture failed DTO decoding: \(name)")
            let fixture = try NativeReviewFixture()
            NativeReviewProtocol.install(try fixture.responsesByReplacingRepair(repair))
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [NativeReviewProtocol.self]
            let client = APIClient(
                configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                session: URLSession(configuration: configuration)
            )
            let suite = "assistant.improvements-visual-review-\(name)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defaults.removePersistentDomain(forName: suite)
            let model = AppModel(apiClient: client, defaults: defaults)
            await model.refreshWorkspace()
            XCTAssertNotNil(model.workspace?.repairs, "Repair fixture failed to decode: \(name)")
            let page = Page("improvements-\(name)", WorkspaceView(area: .improvements))
            try await capture(page, scheme: .light, size: .large, scene: scene, model: model)
            try await capture(page, scheme: .dark, size: .large, scene: scene, model: model)
            try await capture(page, scheme: .light, size: .accessibility3, scene: scene, model: model)
            XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty, "Review fixture escaped the stub transport: \(name)")
            XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty, "Review capture attempted a mutation: \(name)")
        }
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
        let searchStates: [(String, String, Bool, Bool, Bool)] = [
            ("activity-search-empty", "", false, false, false),
            ("activity-search-typed", "calendar planning", false, false, false),
            ("activity-search-focused", "calendar planning", false, true, false),
            ("activity-search-clear-high-contrast", "calendar planning", false, true, true),
            ("activity-search-loading", "calendar planning", true, false, false),
        ]
        for scheme in [ColorScheme.light, .dark] {
            for (name, query, loading, focused, highContrast) in searchStates {
                try await capture(
                    Page(name, ActivitySearchRowReviewFixture(query: query, isLoading: loading, startsFocused: focused)),
                    scheme: scheme,
                    size: .large,
                    scene: scene,
                    model: model,
                    increasedContrast: highContrast
                )
            }
        }
        try await capture(
            Page("activity-search-narrow-accessibility", ActivitySearchRowReviewFixture(
                query: "calendar planning",
                isLoading: false,
                startsFocused: false
            )),
            scheme: .light,
            size: .accessibility3,
            scene: scene,
            model: model,
            viewportWidth: 320,
            increasedContrast: true
        )
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

    @MainActor
    func testDocumentsAndImportCardsWrapAtCompactAndAccessibleWidths() async throws {
        let fixture = try NativeReviewFixture()
        var responses = fixture.responses
        let workspacePath = "/api/mobile/v1/workspace"
        var workspace = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(responses[workspacePath])) as? [String: Any])
        workspace["imports"] = [
            "sources": [
                [
                    "source": "Family archive — weekend plans, receipts, and confirmations (2018–2024)",
                    "workspacePath": "imports/family-archive.zip",
                    "kind": "archive",
                    "status": "importing",
                    "itemsTotal": 120,
                    "itemsProcessed": 63,
                    "memoriesSaved": 18,
                    "quarantinedNow": 4,
                    "taskId": "task-import",
                    "error": "Some entries need review because their dates and source details could not be matched confidently.",
                    "updatedAt": "2026-10-03T09:00:00Z"
                ],
                [
                    "source": "A very long failed backup source with a descriptive title",
                    "workspacePath": "imports/failed-backup.zip",
                    "kind": "archive",
                    "status": "failed",
                    "itemsTotal": 8,
                    "itemsProcessed": 3,
                    "memoriesSaved": 0,
                    "quarantinedNow": 0,
                    "taskId": NSNull(),
                    "error": "The archive could not be read. Try importing the original file again after checking that it is complete.",
                    "updatedAt": "2026-10-03T09:00:00Z"
                ]
            ],
            "unstartedFiles": [
                ["name": "Trip planning notes — family weekend (final revised copy).md", "dir": false]
            ],
            "sourceAvailability": ["status": "available", "version": 1],
            "filesAvailability": ["status": "available", "version": 1]
        ]
        responses[workspacePath] = try JSONSerialization.data(withJSONObject: workspace)
        NativeReviewProtocol.install(responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: configuration))
        let suite = "assistant.documents-compact-visual-review"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let model = AppModel(apiClient: client, defaults: defaults)
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let page = Page("documents-and-imports", WorkspaceView(area: .documents))
        try await capture(page, scheme: .light, size: .large, scene: scene, model: model, viewportWidth: 320)
        try await capture(page, scheme: .dark, size: .large, scene: scene, model: model, viewportWidth: 320)
        try await capture(page, scheme: .light, size: .accessibility3, scene: scene, model: model, viewportWidth: 320)

        let emptyFixture = try NativeReviewFixture(emptyDocuments: true)
        var emptyResponses = emptyFixture.responses
        emptyResponses[workspacePath] = try JSONSerialization.data(withJSONObject: workspace)
        NativeReviewProtocol.install(emptyResponses)
        let emptyConfiguration = URLSessionConfiguration.ephemeral
        emptyConfiguration.protocolClasses = [NativeReviewProtocol.self]
        let emptyClient = APIClient(
            configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
            session: URLSession(configuration: emptyConfiguration))
        let emptySuite = "assistant.documents-empty-imports-visual-review"
        let emptyDefaults = try XCTUnwrap(UserDefaults(suiteName: emptySuite))
        emptyDefaults.removePersistentDomain(forName: emptySuite)
        let emptyModel = AppModel(apiClient: emptyClient, defaults: emptyDefaults)
        await emptyModel.refreshAll()
        _ = await emptyModel.refreshWorkspace()
        let emptyDocuments = try XCTUnwrap(emptyModel.overview?.documents)
        XCTAssertEqual(DocumentListPresentation(emptyDocuments), .confirmedEmpty)
        XCTAssertEqual(emptyDocuments.stats.total, 0)
        XCTAssertEqual(emptyModel.workspace?.imports?.sources.count, 2,
            "The true-empty documents fixture must retain the existing Backstory imports rows")
        let emptyPage = Page("documents-empty-with-imports", WorkspaceView(area: .documents))
        try await capture(emptyPage, scheme: .light, size: .large, scene: scene, model: emptyModel, viewportWidth: 320)
        try await capture(emptyPage, scheme: .dark, size: .large, scene: scene, model: emptyModel, viewportWidth: 320)
        try await capture(emptyPage, scheme: .light, size: .accessibility3, scene: scene, model: emptyModel, viewportWidth: 320)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty, "Visual fixtures must not run import actions.")
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty, "Every visual read must stay in the fixture transport.")
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
                                    scene: UIWindowScene, model: AppModel, requiresScrolling: Bool = false,
                                    viewportWidth: CGFloat? = nil, increasedContrast: Bool = false) async throws {
        UserDefaults.standard.set((scheme == .light ? AssistantAppearance.light : .dark).rawValue,
                                  forKey: AssistantAppearance.defaultsKey)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        if let viewportWidth { window.frame.size.width = viewportWidth }
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
        }.environment(model).environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size).transaction { $0.animation = nil; $0.disablesAnimations = true }
            .environment(\.scenePhase, .active))
        window.rootViewController = host
        if increasedContrast { host.traitOverrides.accessibilityContrast = .high }
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
        var capturedScrollPositions = 0
        // Lists recycle off-screen cells, so a tall bitmap alone would hide
        // rows. Capture every vertical viewport with overlapping scroll steps.
        func scrollViews(in view: UIView) -> [UIScrollView] {
            ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap { scrollViews(in: $0) }
        }
        // Presented native sheets live outside the original hosting subtree.
        if let scroll = scrollViews(in: window).filter({ scroll in
            // Safe-area/navigation insets reduce the usable viewport even
            // when the content is shorter than the scroll view's bounds.
            let viewportHeight = max(0, scroll.bounds.height
                                     - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
            return scroll.bounds.width >= window.bounds.width * 0.7 && scroll.bounds.height >= window.bounds.height * 0.35 &&
                scroll.contentSize.height > viewportHeight + 2
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
                let viewportHeight = max(1, scroll.bounds.height
                                         - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
                offset = min(bottom, offset + viewportHeight * 0.72)
                scroll.setContentOffset(CGPoint(x: initial.x, y: offset), animated: false)
                try await Task.sleep(for: .milliseconds(130))
                window.layoutIfNeeded()
                offset = scroll.contentOffset.y
                index += 1
                capturedScrollPositions += 1
                record("scroll-\(String(format: "%02d", index))")
            }
            let finalBottom = max(-scroll.adjustedContentInset.top,
                                  scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            XCTAssertLessThanOrEqual(finalBottom - offset, 2, "Incomplete below-fold capture: \(page.name)")
            scroll.setContentOffset(initial, animated: false)
        }
        if requiresScrolling {
            XCTAssertGreaterThan(capturedScrollPositions, 0, "Long message fixture was not captured below the fold: \(page.name)")
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

private struct ActivitySearchRowReviewFixture: View {
    @State private var query: String
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var colorScheme

    let isLoading: Bool
    let startsFocused: Bool

    init(query: String, isLoading: Bool, startsFocused: Bool) {
        _query = State(initialValue: query)
        self.isLoading = isLoading
        self.startsFocused = startsFocused
    }

    var body: some View {
        ActivityDiscoverySearchRow(
            query: $query,
            isFocused: $focused,
            isLoading: isLoading,
            onSubmit: {}
        )
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.canvas(for: colorScheme))
        .onAppear {
            if startsFocused { focused = true }
        }
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
    func responsesByReplacingRepair(_ repair: [String: Any]) throws -> [String: Data] {
        var result = responses
        let path = "/api/mobile/v1/workspace"
        let original = try XCTUnwrap(result[path])
        var workspace = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
        var repairs = workspace["repairs"] as? [String: Any] ?? [:]
        repairs["issues"] = [repair]
        workspace["repairs"] = repairs
        result[path] = try JSONSerialization.data(withJSONObject: workspace)
        return result
    }
    init(emptyDocuments: Bool = false) throws {
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
        let docs = DocumentsOverview(
            documents: emptyDocuments ? [] : [.init(id: "document", title: "Weekend booking confirmation.pdf", mime: "application/pdf", source: "upload", trust: "owner", status: "ready", extractor: "pdf", chunkCount: 4, charCount: 2100, bytes: 31840, error: nil, createdAt: stamp)],
            stats: emptyDocuments ? .init(total: 0, ready: 0, pending: 0, chunks: 0)
                : .init(total: 1, ready: 1, pending: 0, chunks: 4),
            primaryConversationId: "main")
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

@MainActor
private final class NativeSaveReviewGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        guard !released else { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}
