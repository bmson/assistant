import XCTest
import SwiftUI
import UIKit
import QuartzCore
import CryptoKit
@testable import Assistant

/// Bounded synthetic simulator scrolling evidence for the production transcript.
/// It records CADisplayLink callback intervals while a UIScrollView advances
/// through a fixed fixture; it is not a physical-touch or device frame profile.
final class ConversationScrollPerformanceTests: XCTestCase {
    @MainActor
    func testSyntheticTranscriptScrollFrameIntervals() async throws {
        let messages = Self.fixtureMessages(count: 100)
        let transcript = ChatTranscriptRows(
            messages: messages, isSending: false,
            openApprovals: {}, send: { _, _ in },
            decideApproval: { _, _ in false }, rememberApproval: { _ in false },
            decideSuggestion: { _, _ in nil }, openActivity: {},
            refreshCard: { _, _ in nil }, hideMessage: { _ in },
            setRecallSourceSuppressed: { _, _, _ in .failed },
            recallSourceSuppressed: { _, _ in nil },
            acknowledgeMessageDelivery: { _ in false },
            cardFormActions: nil, cardFormStateRevision: 0, cardFormTaskRevision: 0
        )

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let host = UIHostingController(rootView: ScrollView {
            transcript.padding(.horizontal, 16).padding(.vertical, 8)
        }.environment(\.colorScheme, .light).environment(\.dynamicTypeSize, .large))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }

        try await Task.sleep(for: .milliseconds(350))
        window.layoutIfNeeded()
        host.view.layoutIfNeeded()
        let scroll = try XCTUnwrap(Self.scrollView(in: window), "Hosted transcript did not expose its production UIScrollView")
        let viewportHeight = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        let initialBottom = Self.bottomOffset(of: scroll)
        XCTAssertGreaterThan(viewportHeight, 100)
        XCTAssertGreaterThan(initialBottom, viewportHeight * 2, "Fixture must create enough scroll work to profile")

        let recorder = TranscriptScrollRecorder(scrollView: scroll, duration: 3.5)
        await recorder.run()
        let samples = recorder.intervals
        XCTAssertFalse(recorder.timedOut, "CADisplayLink did not deliver callbacks before the bounded timeout")
        XCTAssertGreaterThanOrEqual(samples.count, 30, "Display-link callback coverage was too sparse")
        XCTAssertGreaterThanOrEqual(recorder.elapsed, 3.0, "The bounded scroll run ended too early")

        window.layoutIfNeeded()
        let finalBottom = Self.bottomOffset(of: scroll)
        XCTAssertGreaterThanOrEqual(scroll.contentOffset.y, finalBottom - 2, "Synthetic scroll did not reach the transcript bottom")

        let sorted = samples.sorted()
        let summary: [String: Any] = [
            "mode": "synthetic-simulator-scroll",
            "fixture": "100 production ChatTranscriptRows with Markdown, recall and rich cards (50 assistant rows)",
            "physicalTouchProfile": false,
            "durationSeconds": recorder.elapsed,
            "callbackCount": samples.count + 1,
            "viewportHeightPoints": viewportHeight,
            "contentHeightPoints": scroll.contentSize.height,
            "scrollableDistancePoints": finalBottom,
            "finalOffsetPoints": scroll.contentOffset.y,
            "callbackIntervalMilliseconds": [
                "p50": Self.percentile(sorted, 0.50) * 1_000 as Any,
                "p95": Self.percentile(sorted, 0.95) * 1_000 as Any,
                "max": (sorted.last ?? 0) * 1_000 as Any,
                "over33_3ms": samples.filter { $0 > 0.0333 }.count as Any,
            ],
            "intervalsMilliseconds": samples.map { $0 * 1_000 },
        ]
        let data = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys, .prettyPrinted])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "conversation-scroll-performance.json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("CONVERSATION_SCROLL_BENCHMARK \(String(decoding: data, as: UTF8.self))")
    }

    @MainActor
    func testFullChatView100RowColdMountBidirectionalStreamAndAppend() async throws {
        try await runFullChatViewPerformance(messageCount: 100)
    }

    @MainActor
    func testFullChatView500RowColdMountBidirectionalStreamAndAppend() async throws {
        try await runFullChatViewPerformance(messageCount: 500)
    }

    @MainActor
    private func runFullChatViewPerformance(messageCount: Int) async throws {
        let messages = Self.fixtureMessages(count: messageCount, includeCalendarAgenda: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let fixtureDigest = SHA256.hash(data: try encoder.encode(messages))
            .map { String(format: "%02x", $0) }
            .joined()
        let setupStart = CACurrentMediaTime()
        let fixture = try await ConversationPerformanceFixture.make(messages: messages)
        let totalSetupSeconds = CACurrentMediaTime() - setupStart
        addTeardownBlock { await fixture.tearDown() }
        fixture.assertValidMeasurementBoundary()

        XCTAssertEqual(fixture.model.messages.count, messageCount)
        XCTAssertEqual(Set(fixture.model.messages.map(\.id)).count, messageCount)
        XCTAssertEqual(fixture.model.messages.first?.id, "scroll-bench-user-0")
        XCTAssertEqual(fixture.model.messages.last?.id, "scroll-bench-assistant-\(messageCount - 1)")
        XCTAssertFalse(UIAccessibility.isReduceMotionEnabled, "Use a simulator with Reduce Motion disabled for paired runs")
        let agendaCardCount = fixture.model.messages.flatMap(\.parts).filter { part in
            guard case let .object(fields) = part.data else { return false }
            return fields["presentation"] == .string("calendar-agenda")
        }.count
        XCTAssertGreaterThan(agendaCardCount, 0, "The fixture must include real calendar agenda response cards")

        let scroll = fixture.scrollView
        let viewportHeight = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        let bottom = Self.bottomOffset(of: scroll)
        XCTAssertGreaterThan(viewportHeight, 100)
        XCTAssertGreaterThan(bottom, viewportHeight * 2, "Full ChatView fixture must create meaningful scroll work")

        let down = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
            .run(from: -scroll.adjustedContentInset.top, to: bottom)
        XCTAssertFalse(down.timedOut)
        XCTAssertGreaterThanOrEqual(down.intervals.count, 30)
        XCTAssertEqual(scroll.contentOffset.y, bottom, accuracy: 2)
        fixture.assertValidMeasurementBoundary()

        let typeStart = CACurrentMediaTime()
        let typingStart = bottom * 0.55
        scroll.setContentOffset(CGPoint(x: 0, y: typingStart), animated: false)
        let typingRecorder = FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
        let typingPhase = Task { @MainActor in
            await typingRecorder.run(from: typingStart, to: -scroll.adjustedContentInset.top)
        }
        try await fixture.typeInComposer("Give me a concise update while I review the conversation.")
        let composerTypingSeconds = CACurrentMediaTime() - typeStart
        let typing = await typingPhase.value
        XCTAssertFalse(typing.timedOut)
        XCTAssertGreaterThanOrEqual(typing.intervals.count, 30)
        fixture.assertValidMeasurementBoundary()
        fixture.window.endEditing(true)
        fixture.window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))

        let streamedText = "The saved plan still leaves time to check the calendar and confirm the arrival window."
        let initialChunk = "The saved plan still leaves time "
        try await fixture.beginStreamTurn(
            text: "Summarize the saved plan and calendar details.",
            initialChunk: initialChunk,
            finalText: streamedText
        )
        let streamStart = Self.bottomOffset(of: scroll) * 0.45
        scroll.setContentOffset(CGPoint(x: 0, y: streamStart), animated: false)
        let streamRecorder = FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
        let streamPhase = Task { @MainActor in
            await streamRecorder.run(from: streamStart, to: bottom)
        }
        for chunk in ["to check ", "the calendar ", "and confirm ", "the arrival window."] {
            try await Task.sleep(for: .milliseconds(60))
            try await fixture.appendStreamChunk(chunk)
        }
        try await fixture.finishStreamAndPoll()
        let streaming = await streamPhase.value
        XCTAssertFalse(streaming.timedOut)
        XCTAssertGreaterThanOrEqual(streaming.intervals.count, 30)
        fixture.assertValidMeasurementBoundary()
        XCTAssertNotNil(fixture.model.workspace, "Turn settlement must load its valid workspace projection")
        XCTAssertEqual(fixture.model.workspace?.memory.ownerName, "Performance Owner")
        XCTAssertEqual(fixture.model.workspace?.settings.agent.name, "Fixture Assistant")

        let midPoint = bottom * 0.52
        scroll.setContentOffset(CGPoint(x: 0, y: midPoint), animated: false)
        let updateRecorder = FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
        let updatePhase = Task { @MainActor in
            await updateRecorder.run(from: midPoint, to: -scroll.adjustedContentInset.top)
        }
        try await Task.sleep(for: .milliseconds(900))
        try await fixture.appendMessage(.init(
            id: "ignored-fixture-id",
            role: .assistant,
            parts: [.init(type: "text", text: "A newly appended update arrived while you were reading earlier messages.")]
        ))
        let updating = await updatePhase.value
        XCTAssertFalse(updating.timedOut)
        XCTAssertGreaterThanOrEqual(updating.intervals.count, 30)
        fixture.assertValidMeasurementBoundary()

        let requestPaths = fixture.interceptedRequestPaths
        XCTAssertTrue(requestPaths.contains("/api/mobile/v1/chat"), "The measured stream phase must exercise the real chat request path")
        XCTAssertTrue(requestPaths.contains("/api/mobile/v1/chat/status"), "The stream phase must settle through the production poll path")
        XCTAssertTrue(requestPaths.contains("/api/mobile/v1/chats/\(ConversationPerformanceFixture.conversationID)"), "The mid-scroll append must reload the active conversation")
        XCTAssertEqual(fixture.model.messages.count, messageCount + 3, "User send, streamed assistant reply and appended production row must remain in the transcript")
        XCTAssertTrue(fixture.model.messages.contains(where: { $0.id == "performance-final-1" && $0.text == streamedText }))
        XCTAssertTrue(fixture.model.messages.contains(where: { $0.id == "performance-appended-1" && $0.text == "A newly appended update arrived while you were reading earlier messages." }))
        let contentHeightAfterUpdate = scroll.contentSize.height

        let summary: [String: Any] = [
            "mode": "synthetic-simulator-full-chat-view-scroll",
            "fixture": "\(messageCount) production ChatView rows with Markdown, recall, proactive cards and calendar agenda cards",
            "physicalTouchProfile": false,
            "reduceMotionEnabled": UIAccessibility.isReduceMotionEnabled,
            "messageCount": messageCount,
            "fixtureSHA256": fixtureDigest,
            "coldMountToScrollableSeconds": fixture.hostMountToScrollableSeconds,
            "fixtureSetupSecondsIncludingBootstrap": totalSetupSeconds,
            "composerTypingSeconds": composerTypingSeconds,
            "viewportHeightPoints": viewportHeight,
            "contentHeightPoints": scroll.contentSize.height,
            "contentHeightAfterUpdatePoints": contentHeightAfterUpdate,
            "agendaCardCount": agendaCardCount,
            "finalOffsetPoints": scroll.contentOffset.y,
            "scrollableDistancePoints": bottom,
            "phases": [
                Self.phaseSummary("top-to-bottom", down),
                Self.phaseSummary("composer-typing-while-scrolling-up", typing),
                Self.phaseSummary("streaming-while-scrolling-down", streaming),
                Self.phaseSummary("append-while-scrolling-up", updating),
            ],
            "requestCountsByMethodAndPath": fixture.requestCountsByMethodAndPath,
            "interceptedRequestPaths": requestPaths,
        ]
        let data = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys, .prettyPrinted])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "full-chat-view-scroll-performance-\(messageCount).json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("FULL_CHAT_VIEW_SCROLL_BENCHMARK \(String(decoding: data, as: UTF8.self))")
    }

    private static func fixtureMessages(count: Int, includeCalendarAgenda: Bool = false) -> [ChatMessage] {
        let sources = [
            MessageRecallSource(date: "2026-10-18", label: "A previous conversation about the weekend plan and the confirmed arrival details", kind: "chat", hops: 1, surfaceKey: nil, sourceRevision: nil),
            MessageRecallSource(date: "2026-10-17", label: "Prefers quiet hotels close to the station", kind: "knowledge_graph", hops: 2,
                                surfaceKey: String(repeating: "a", count: 64), sourceRevision: String(repeating: "b", count: 64)),
            MessageRecallSource(date: "2026-10-16", label: "Choose a refundable room before confirming the train", kind: "situation_decision", hops: 1,
                                surfaceKey: String(repeating: "c", count: 64), sourceRevision: String(repeating: "d", count: 64)),
            MessageRecallSource(date: "2026-10-15", label: "Confirm the late arrival window with the hotel", kind: "commitment", hops: 1,
                                surfaceKey: String(repeating: "e", count: 64), sourceRevision: String(repeating: "f", count: 64)),
        ]
        return (0..<count).map { index in
            if index.isMultiple(of: 2) {
                return .optimistic(role: .user,
                    text: index.isMultiple(of: 10)
                        ? "Can you compare the options, keep our earlier decision in view, and tell me what still needs confirmation?"
                        : "Please check the weekend details and keep the plan flexible.",
                    id: "scroll-bench-user-\(index)")
            }

            let assistantIndex = index / 2
            var parts: [MessagePart] = [.init(type: "text", text: assistantIndex.isMultiple(of: 3)
                ? "**Harbor House** is close to the station.\n\nThe cancellation window stays open until Thursday, and the train arrives at 4:30 PM.\n\n- Keep the confirmation nearby.\n- Ask before changing the booking."
                : "The train arrives at 4:30 PM, and the hotel can hold the room until 5 PM. This leaves time to collect the bags and walk over.")]
            if assistantIndex.isMultiple(of: 4) { parts.append(.init(type: "recall", sources: sources)) }
            if assistantIndex.isMultiple(of: 10) {
                parts.append(.init(type: "data-card", data: .object([
                    "kind": .string("proactive-alert"), "id": .string("scroll-alert-\(assistantIndex)"),
                    "category": .string("travel"), "urgencyLabel": .string("Worth your attention"),
                    "title": .string("Confirm the late arrival window"),
                    "summary": .string("The hotel may need an updated arrival time before the weekend."),
                    "details": .array([.object(["label": .string("Hotel"), "value": .string("Harbor House")])]),
                ])))
            }
            if includeCalendarAgenda, assistantIndex.isMultiple(of: 12) {
                parts.append(.init(type: "data-card", data: .object([
                    "kind": .string("briefing"), "id": .string("scroll-agenda-\(assistantIndex)"),
                    "presentation": .string("calendar-agenda"), "title": .string("Agenda"),
                    "date": .string("Tuesday, October 27 · Pacific Time"),
                    "lead": .string("Four events across Personal and Work; all calendars checked."),
                    "sections": .array([.object([
                        "type": .string("agenda"), "title": .string("Tuesday, October 27"), "complete": .bool(true),
                        "items": .array((0..<4).map { eventIndex in .object([
                            "id": .string("scroll-event-\(assistantIndex)-\(eventIndex)"),
                            "day": .string(eventIndex == 0 ? "All day" : "Timed"),
                            "time": .string(eventIndex == 0 ? "All day · through Wednesday, October 28" : "\(9 + eventIndex):00 AM – \(10 + eventIndex):00 AM"),
                            "title": .string(eventIndex == 0 ? "Local holiday and office closure" : "Planning review with the project team \(eventIndex)"),
                            "location": .string(eventIndex == 0 ? "" : "Harbor House meeting room \(eventIndex)"),
                            "note": .string(eventIndex == 1 ? "Needs response" : ""),
                            "calendars": .array([.string(eventIndex.isMultiple(of: 2) ? "Personal" : "Work")]),
                            "calendarLinks": .array([.object([
                                "label": .string("Open event"),
                                "url": .string("https://calendar.google.com/calendar/event?eid=scroll-\(assistantIndex)-\(eventIndex)"),
                            ])]),
                        ]) }),
                    ])]),
                ])))
            }
            return ChatMessage(id: "scroll-bench-assistant-\(index)", role: .assistant, parts: parts)
        }
    }

    private static func phaseSummary(_ name: String, _ phase: FullChatViewScrollRecorder.Result) -> [String: Any] {
        let sorted = phase.intervals.sorted()
        return [
            "name": name,
            "durationSeconds": phase.elapsed,
            "callbackCount": phase.intervals.count + 1,
            "timedOut": phase.timedOut,
            "fromOffsetPoints": phase.fromOffset,
            "toOffsetPoints": phase.toOffset,
            "callbackIntervalMilliseconds": [
                "p50": Self.percentile(sorted, 0.50) * 1_000,
                "p95": Self.percentile(sorted, 0.95) * 1_000,
                "max": (sorted.last ?? 0) * 1_000,
                "over16_67ms": phase.intervals.filter { $0 > 0.01667 }.count,
                "over33_3ms": phase.intervals.filter { $0 > 0.0333 }.count,
                "over100ms": phase.intervals.filter { $0 > 0.100 }.count,
            ],
            "intervalsMilliseconds": phase.intervals.map { $0 * 1_000 },
        ]
    }

    @MainActor
    private static func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView,
           scroll.bounds.width >= view.bounds.width * 0.7,
           scroll.contentSize.height > scroll.bounds.height * 2 {
            return scroll
        }
        for child in view.subviews {
            if let found = scrollView(in: child) { return found }
        }
        return nil
    }

    @MainActor fileprivate static func bottomOffset(of scroll: UIScrollView) -> CGFloat {
        max(-scroll.adjustedContentInset.top,
            scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
    }

    private static func percentile(_ sorted: [Double], _ fraction: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        let index = min(sorted.count - 1, Int((Double(sorted.count - 1) * fraction).rounded()))
        return sorted[index]
    }
}

@MainActor
private final class TranscriptScrollRecorder: NSObject {
    private let scrollView: UIScrollView
    private let duration: CFTimeInterval
    private var displayLink: CADisplayLink?
    private var completion: CheckedContinuation<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var startTime: CFTimeInterval = 0
    private var previousCallback: CFTimeInterval?
    private(set) var intervals: [Double] = []
    private(set) var elapsed: Double = 0
    private(set) var timedOut = false

    init(scrollView: UIScrollView, duration: CFTimeInterval) {
        self.scrollView = scrollView
        self.duration = duration
        super.init()
    }

    func run() async {
        await withCheckedContinuation { continuation in
            completion = continuation
            timeoutTask = Task { @MainActor [weak self] in
                guard let self else { return }
                try? await Task.sleep(for: .seconds(self.duration + 2))
                guard !Task.isCancelled, self.completion != nil else { return }
                self.timedOut = true
                self.finish()
            }
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            displayLink = link
            link.add(to: .main, forMode: .common)
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if startTime == 0 { startTime = now }
        if let previousCallback { intervals.append(now - previousCallback) }
        previousCallback = now
        elapsed = now - startTime

        let bottom = ConversationScrollPerformanceTests.bottomOffset(of: scrollView)
        let progress = min(1, elapsed / duration)
        scrollView.setContentOffset(CGPoint(x: 0, y: bottom * progress), animated: false)
        guard elapsed >= duration else { return }

        scrollView.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
        finish()
    }

    private func finish() {
        displayLink?.invalidate()
        displayLink = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        completion?.resume()
        completion = nil
    }
}

@MainActor
private final class FullChatViewScrollRecorder: NSObject {
    struct Result {
        let fromOffset: CGFloat
        let toOffset: CGFloat
        let intervals: [Double]
        let elapsed: Double
        let timedOut: Bool
    }

    private let scrollView: UIScrollView
    private let duration: CFTimeInterval
    private var displayLink: CADisplayLink?
    private var completion: CheckedContinuation<Result, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var startTime: CFTimeInterval = 0
    private var previousCallback: CFTimeInterval?
    private var fromOffset: CGFloat = 0
    private var toOffset: CGFloat = 0
    private var intervals: [Double] = []
    private var elapsed: Double = 0
    private var timedOut = false

    init(scrollView: UIScrollView, duration: CFTimeInterval) {
        self.scrollView = scrollView
        self.duration = duration
        super.init()
    }

    func run(from: CGFloat, to: CGFloat) async -> Result {
        await withCheckedContinuation { continuation in
            completion = continuation
            fromOffset = from
            toOffset = to
            scrollView.setContentOffset(CGPoint(x: 0, y: from), animated: false)
            timeoutTask = Task { @MainActor [weak self] in
                guard let self else { return }
                try? await Task.sleep(for: .seconds(self.duration + 2))
                guard !Task.isCancelled, self.completion != nil else { return }
                self.timedOut = true
                self.finish()
            }
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
            displayLink = link
            link.add(to: .main, forMode: .common)
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if startTime == 0 { startTime = now }
        if let previousCallback { intervals.append(now - previousCallback) }
        previousCallback = now
        elapsed = now - startTime

        let progress = min(1, elapsed / duration)
        let offset = fromOffset + (toOffset - fromOffset) * progress
        scrollView.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
        guard elapsed >= duration else { return }
        scrollView.setContentOffset(CGPoint(x: 0, y: toOffset), animated: false)
        finish()
    }

    private func finish() {
        displayLink?.invalidate()
        displayLink = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        completion?.resume(returning: Result(
            fromOffset: fromOffset,
            toOffset: toOffset,
            intervals: intervals,
            elapsed: elapsed,
            timedOut: timedOut
        ))
        completion = nil
    }
}
