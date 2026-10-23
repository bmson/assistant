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
    func testFullChatView100RowSettledBidirectionalDiagnostic() async throws {
        try await runSettledBidirectionalDiagnostic(messageCount: 100)
    }

    @MainActor
    func testFullChatView500RowSettledBidirectionalDiagnostic() async throws {
        try await runSettledBidirectionalDiagnostic(messageCount: 500)
    }

    @MainActor
    func testFullChatView500RowFixedWindowBidirectional() async throws {
        let messageCount = 500
        let messages = Self.fixtureMessages(count: messageCount, includeCalendarAgenda: true)
        let fixtureDigest = try Self.fixtureDigest(messages)
        let fixture = try await ConversationPerformanceFixture.make(messages: messages)
        addTeardownBlock { await fixture.tearDown() }

        XCTAssertEqual(fixture.model.messages.count, messageCount)
        XCTAssertFalse(UIAccessibility.isReduceMotionEnabled)
        fixture.assertValidMeasurementBoundary()

        // Seek to real top, middle, and tail rows before timing so lazy row
        // creation and delivery acknowledgements are validated outside the
        // scored fixed-window phases.
        let firstID = "scroll-bench-assistant-3"
        let middleID = "scroll-bench-assistant-249"
        let tailID = "scroll-bench-assistant-499"
        let firstAckBaseline = fixture.deliveryAcknowledgementAttempts(for: firstID)
        let firstOffset = try await fixture.seekMessage(firstID, anchor: .center)
        let firstAckCount = fixture.deliveryAcknowledgementAttempts(for: firstID)
        XCTAssertGreaterThan(firstAckCount, 0,
                             "First durable assistant row must use the real visibility acknowledgement path")
        if firstAckBaseline == 0 {
            XCTAssertGreaterThan(firstAckCount, firstAckBaseline,
                                 "Seeking to a previously unacknowledged first row must issue its acknowledgement")
        }
        let middleAckBaseline = fixture.deliveryAcknowledgementAttempts(for: middleID)
        let middleOffset = try await fixture.seekMessage(middleID, anchor: .center)
        let middleAckCount = fixture.deliveryAcknowledgementAttempts(for: middleID)
        XCTAssertGreaterThan(middleAckCount, 0,
                             "Middle durable assistant row must use the real visibility acknowledgement path")
        if middleAckBaseline == 0 {
            XCTAssertGreaterThan(middleAckCount, middleAckBaseline,
                                 "Seeking to a previously unacknowledged middle row must issue its acknowledgement")
        }
        let tailAckBaseline = fixture.deliveryAcknowledgementAttempts(for: tailID)
        let tailOffset = try await fixture.seekMessage(tailID, anchor: .center)
        let tailAckCount = fixture.deliveryAcknowledgementAttempts(for: tailID)
        XCTAssertGreaterThanOrEqual(firstAckCount, 1, "First durable assistant row must reach its real delivery acknowledgement path")
        XCTAssertGreaterThanOrEqual(middleAckCount, 1, "Middle durable assistant row must reach its real delivery acknowledgement path")
        XCTAssertGreaterThanOrEqual(tailAckCount, 1, "Tail durable assistant row must reach its real delivery acknowledgement path")
        XCTAssertLessThan(firstOffset, middleOffset)
        XCTAssertLessThan(middleOffset, tailOffset)

        for (messageID, acknowledgedCount) in [
            (firstID, firstAckCount), (middleID, middleAckCount), (tailID, tailAckCount),
        ] {
            _ = try await fixture.seekMessage(messageID, anchor: .center)
            XCTAssertEqual(fixture.deliveryAcknowledgementAttempts(for: messageID), acknowledgedCount,
                           "Returning to a previously acknowledged row must not issue another delivery acknowledgement")
        }

        let scroll = fixture.scrollView
        let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        let actualTop = -scroll.adjustedContentInset.top
        let actualBottom = Self.bottomOffset(of: scroll)
        let target = actualTop + viewport * 5
        XCTAssertGreaterThan(viewport, 100)
        XCTAssertGreaterThanOrEqual(actualBottom, target + 2,
                                     "Transcript must contain at least five usable viewport lengths below its actual top")
        XCTAssertLessThanOrEqual(firstOffset, actualTop + viewport,
                                 "First-row seek must be near the transcript top")
        XCTAssertGreaterThanOrEqual(tailOffset, actualBottom - viewport,
                                    "Tail-row seek must be near the transcript bottom")
        XCTAssertLessThanOrEqual(tailOffset, actualBottom + 2)

        // Return to the actual transcript top and settle before timing; seek
        // movements above are validation setup, not part of this score.
        _ = try await fixture.seekMessage(firstID, anchor: .top)
        scroll.setContentOffset(CGPoint(x: 0, y: actualTop), animated: false)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(scroll.contentOffset.y, actualTop, accuracy: 2)
        fixture.assertValidMeasurementBoundary()

        let down = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
            .run(from: actualTop, to: target)
        let downJSON = Self.phaseSummary("fixed-five-viewports-down", down)
        emitFixedWindowPhase(
            name: "fixed-five-viewports-down", phase: downJSON,
            fixtureDigest: fixtureDigest, viewport: viewport,
            contentHeight: scroll.contentSize.height,
            visibilitySeekOffsets: [firstID: firstOffset, middleID: middleOffset, tailID: tailOffset],
            acknowledgementBaselines: [firstID: firstAckBaseline, middleID: middleAckBaseline, tailID: tailAckBaseline],
            acknowledgementCounts: [firstID: firstAckCount, middleID: middleAckCount, tailID: tailAckCount],
            fixture: fixture
        )
        XCTAssertFalse(down.timedOut)
        XCTAssertGreaterThanOrEqual(down.intervals.count, 30)
        XCTAssertEqual(down.fromOffset, actualTop, accuracy: 2)
        XCTAssertEqual(down.toOffset, target, accuracy: 2)
        XCTAssertEqual(down.offsetSamples.first?.observedYPoints ?? .nan, actualTop, accuracy: 2)
        XCTAssertEqual(down.offsetSamples.last?.observedYPoints ?? .nan, target, accuracy: 2)
        XCTAssertEqual(scroll.contentOffset.y, target, accuracy: 2)
        fixture.assertValidMeasurementBoundary()

        let up = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
            .run(from: target, to: actualTop)
        let upJSON = Self.phaseSummary("fixed-five-viewports-up", up)
        emitFixedWindowPhase(
            name: "fixed-five-viewports-up", phase: upJSON,
            fixtureDigest: fixtureDigest, viewport: viewport,
            contentHeight: scroll.contentSize.height,
            visibilitySeekOffsets: [firstID: firstOffset, middleID: middleOffset, tailID: tailOffset],
            acknowledgementBaselines: [firstID: firstAckBaseline, middleID: middleAckBaseline, tailID: tailAckBaseline],
            acknowledgementCounts: [firstID: firstAckCount, middleID: middleAckCount, tailID: tailAckCount],
            fixture: fixture
        )
        XCTAssertFalse(up.timedOut)
        XCTAssertGreaterThanOrEqual(up.intervals.count, 30)
        XCTAssertEqual(up.fromOffset, down.toOffset, accuracy: 2)
        XCTAssertEqual(up.toOffset, down.fromOffset, accuracy: 2)
        XCTAssertEqual(up.offsetSamples.first?.observedYPoints ?? .nan, target, accuracy: 2)
        XCTAssertEqual(up.offsetSamples.last?.observedYPoints ?? .nan, actualTop, accuracy: 2)
        XCTAssertEqual(scroll.contentOffset.y, actualTop, accuracy: 2)
        fixture.assertValidMeasurementBoundary()
    }

    @MainActor
    private func runSettledBidirectionalDiagnostic(messageCount: Int) async throws {
        let messages = Self.fixtureMessages(count: messageCount, includeCalendarAgenda: true)
        let fixtureDigest = try Self.fixtureDigest(messages)
        let setupStart = CACurrentMediaTime()
        let fixture: ConversationPerformanceFixture
        do {
            fixture = try await ConversationPerformanceFixture.make(messages: messages)
        } catch {
            emitFailureDiagnostic(
                phase: "setup-full-chat-view-\(messageCount)", error: error,
                fixtureDigest: fixtureDigest,
                fixtureSetupSeconds: CACurrentMediaTime() - setupStart,
                fixture: nil, scroll: nil
            )
            throw error
        }
        let setupSeconds = CACurrentMediaTime() - setupStart
        addTeardownBlock { await fixture.tearDown() }
        let scroll = fixture.scrollView
        let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        let bottom = Self.bottomOffset(of: scroll)
        XCTAssertEqual(fixture.model.messages.count, messageCount)
        XCTAssertGreaterThan(viewport, 100)
        XCTAssertGreaterThan(bottom, viewport * 2)

        let down = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
            .run(from: -scroll.adjustedContentInset.top, to: bottom)
        emitPhaseDiagnostic(
            name: "settled-top-to-bottom", result: down,
            fixtureDigest: fixtureDigest, setupSeconds: setupSeconds,
            fixture: fixture, scroll: scroll
        )
        XCTAssertFalse(down.timedOut, "top-to-bottom phase exceeded its bounded deadline")
        XCTAssertGreaterThanOrEqual(down.intervals.count, 30, "top-to-bottom callback coverage was too sparse")
        XCTAssertEqual(scroll.contentOffset.y, bottom, accuracy: 2)
        fixture.assertValidMeasurementBoundary()

        let upStart = Self.bottomOffset(of: scroll)
        let up = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
            .run(from: upStart, to: -scroll.adjustedContentInset.top)
        emitPhaseDiagnostic(
            name: "settled-bottom-to-top", result: up,
            fixtureDigest: fixtureDigest, setupSeconds: setupSeconds,
            fixture: fixture, scroll: scroll
        )
        XCTAssertFalse(up.timedOut, "bottom-to-top phase exceeded its bounded deadline")
        XCTAssertGreaterThanOrEqual(up.intervals.count, 30, "bottom-to-top callback coverage was too sparse")
        XCTAssertEqual(scroll.contentOffset.y, -scroll.adjustedContentInset.top, accuracy: 2)
        fixture.assertValidMeasurementBoundary()
    }

    @MainActor
    private func runFullChatViewPerformance(messageCount: Int) async throws {
        let messages = Self.fixtureMessages(count: messageCount, includeCalendarAgenda: true)
        let fixtureDigest = try Self.fixtureDigest(messages)
        let setupStart = CACurrentMediaTime()
        let fixture: ConversationPerformanceFixture
        do {
            fixture = try await ConversationPerformanceFixture.make(messages: messages)
        } catch {
            emitFailureDiagnostic(
                phase: "setup-full-chat-view-\(messageCount)", error: error,
                fixtureDigest: fixtureDigest,
                fixtureSetupSeconds: CACurrentMediaTime() - setupStart,
                fixture: nil, scroll: nil
            )
            throw error
        }
        let totalSetupSeconds = CACurrentMediaTime() - setupStart
        addTeardownBlock { await fixture.tearDown() }

        emitStateDiagnostic(
            phase: "fixture-mounted",
            fixtureDigest: fixtureDigest,
            setupSeconds: totalSetupSeconds,
            fixture: fixture, scroll: fixture.scrollView
        )
        XCTAssertEqual(fixture.model.messages.count, messageCount)
        XCTAssertEqual(Set(fixture.model.messages.map(\.id)).count, messageCount)
        XCTAssertEqual(fixture.model.messages.first?.id, "scroll-bench-user-0")
        XCTAssertEqual(fixture.model.messages.last?.id, "scroll-bench-assistant-\(messageCount - 1)")
        XCTAssertFalse(UIAccessibility.isReduceMotionEnabled, "Use a simulator with Reduce Motion disabled for paired runs")
        fixture.assertValidMeasurementBoundary()
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
        emitPhaseDiagnostic(
            name: "top-to-bottom", result: down,
            fixtureDigest: fixtureDigest, setupSeconds: totalSetupSeconds,
            fixture: fixture, scroll: scroll
        )
        XCTAssertFalse(down.timedOut)
        XCTAssertGreaterThanOrEqual(down.intervals.count, 30)
        XCTAssertEqual(scroll.contentOffset.y, bottom, accuracy: 2)
        fixture.assertValidMeasurementBoundary()
        guard !down.timedOut, down.intervals.count >= 30 else { return }

        let typeStart = CACurrentMediaTime()
        let typingStart = bottom * 0.55
        scroll.setContentOffset(CGPoint(x: 0, y: typingStart), animated: false)
        let typingRecorder = FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
        let typingPhase = Task { @MainActor in
            await typingRecorder.run(from: typingStart, to: -scroll.adjustedContentInset.top)
        }
        do {
            try await fixture.typeInComposer("Give me a concise update while I review the conversation.")
        } catch {
            let partialTyping = await typingPhase.value
            emitFailureDiagnostic(
                phase: "synthetic-per-character-typing-stress-while-scrolling-up", error: error,
                fixtureDigest: fixtureDigest, fixtureSetupSeconds: totalSetupSeconds,
                fixture: fixture, scroll: scroll, partialPhase: partialTyping
            )
            throw error
        }
        let composerTypingSeconds = CACurrentMediaTime() - typeStart
        let typing = await typingPhase.value
        emitPhaseDiagnostic(
            name: "synthetic-per-character-typing-stress-while-scrolling-up", result: typing,
            fixtureDigest: fixtureDigest, setupSeconds: totalSetupSeconds,
            fixture: fixture, scroll: scroll, additional: ["composerTypingSeconds": composerTypingSeconds]
        )
        XCTAssertFalse(typing.timedOut)
        XCTAssertGreaterThanOrEqual(typing.intervals.count, 30)
        fixture.assertValidMeasurementBoundary()
        guard !typing.timedOut, typing.intervals.count >= 30 else { return }
        fixture.window.endEditing(true)
        fixture.window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))

        let streamedText = "The saved plan still leaves time to check the calendar and confirm the arrival window."
        let initialChunk = "The saved plan still leaves time "
        do {
            try await fixture.beginStreamTurn(
                text: "Summarize the saved plan and calendar details.",
                initialChunk: initialChunk,
                finalText: streamedText
            )
        } catch {
            emitFailureDiagnostic(
                phase: "begin-stream-turn", error: error,
                fixtureDigest: fixtureDigest, fixtureSetupSeconds: totalSetupSeconds,
                fixture: fixture, scroll: scroll
            )
            throw error
        }
        let streamStart = Self.bottomOffset(of: scroll) * 0.45
        scroll.setContentOffset(CGPoint(x: 0, y: streamStart), animated: false)
        let streamRecorder = FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
        let streamPhase = Task { @MainActor in
            await streamRecorder.run(from: streamStart, to: bottom)
        }
        do {
            for chunk in ["to check ", "the calendar ", "and confirm ", "the arrival window."] {
                try await Task.sleep(for: .milliseconds(60))
                try await fixture.appendStreamChunk(chunk)
            }
            try await fixture.finishStreamAndPoll()
        } catch {
            let partialStreaming = await streamPhase.value
            emitFailureDiagnostic(
                phase: "stream-and-poll-settlement", error: error,
                fixtureDigest: fixtureDigest, fixtureSetupSeconds: totalSetupSeconds,
                fixture: fixture, scroll: scroll, partialPhase: partialStreaming
            )
            throw error
        }
        let streaming = await streamPhase.value
        emitPhaseDiagnostic(
            name: "streaming-while-scrolling-down", result: streaming,
            fixtureDigest: fixtureDigest, setupSeconds: totalSetupSeconds,
            fixture: fixture, scroll: scroll
        )
        XCTAssertFalse(streaming.timedOut)
        XCTAssertGreaterThanOrEqual(streaming.intervals.count, 30)
        fixture.assertValidMeasurementBoundary()
        guard !streaming.timedOut, streaming.intervals.count >= 30 else { return }
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
        do {
            try await fixture.appendMessage(.init(
                id: "ignored-fixture-id",
                role: .assistant,
                parts: [.init(type: "text", text: "A newly appended update arrived while you were reading earlier messages.")]
            ))
        } catch {
            let partialUpdate = await updatePhase.value
            emitFailureDiagnostic(
                phase: "append-while-scrolling-up", error: error,
                fixtureDigest: fixtureDigest, fixtureSetupSeconds: totalSetupSeconds,
                fixture: fixture, scroll: scroll, partialPhase: partialUpdate
            )
            throw error
        }
        let updating = await updatePhase.value
        emitPhaseDiagnostic(
            name: "append-while-scrolling-up", result: updating,
            fixtureDigest: fixtureDigest, setupSeconds: totalSetupSeconds,
            fixture: fixture, scroll: scroll
        )
        XCTAssertFalse(updating.timedOut)
        XCTAssertGreaterThanOrEqual(updating.intervals.count, 30)
        fixture.assertValidMeasurementBoundary()
        guard !updating.timedOut, updating.intervals.count >= 30 else { return }

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
                Self.phaseSummary("synthetic-per-character-typing-stress-while-scrolling-up", typing),
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

    @MainActor
    private func emitPhaseDiagnostic(
        name: String,
        result: FullChatViewScrollRecorder.Result,
        fixtureDigest: String,
        setupSeconds: TimeInterval,
        fixture: ConversationPerformanceFixture,
        scroll: UIScrollView,
        additional: [String: Any] = [:]
    ) {
        var report = diagnosticBase(
            phase: name, fixtureDigest: fixtureDigest,
            setupSeconds: setupSeconds, fixture: fixture, scroll: scroll
        )
        report["phaseMeasurement"] = Self.phaseSummary(name, result)
        var phaseErrors: [String] = []
        if result.timedOut { phaseErrors.append("CADisplayLink phase exceeded its bounded deadline") }
        if result.intervals.count < 30 {
            phaseErrors.append("callback coverage \(result.intervals.count) is below the retained minimum of 30")
        }
        report["phaseErrorType"] = phaseErrors.isEmpty ? (NSNull() as Any) : ("ConversationScrollPhaseValidation" as Any)
        report["phaseErrorDescription"] = phaseErrors.isEmpty ? (NSNull() as Any) : (phaseErrors.joined(separator: "; ") as Any)
        report["additional"] = additional
        attachDiagnostic(report, name: "full-chat-view-\(name)")
    }

    @MainActor
    private func emitFixedWindowPhase(
        name: String,
        phase: [String: Any],
        fixtureDigest: String,
        viewport: CGFloat,
        contentHeight: CGFloat,
        visibilitySeekOffsets: [String: CGFloat],
        acknowledgementBaselines: [String: Int],
        acknowledgementCounts: [String: Int],
        fixture: ConversationPerformanceFixture
    ) {
        let report: [String: Any] = [
            "mode": "full-chat-view-fixed-five-usable-viewports",
            "phase": name,
            "messageCount": fixture.model.messages.count,
            "canonicalFixtureSHA256": fixtureDigest,
            "durationSeconds": phase["durationSeconds"] ?? NSNull(),
            "requestedFromOffsetPoints": phase["fromOffsetPoints"] ?? NSNull(),
            "requestedToOffsetPoints": phase["toOffsetPoints"] ?? NSNull(),
            "viewportHeightPoints": Double(viewport),
            "contentHeightPoints": Double(contentHeight),
            "requestedDistancePoints": phase["requestedDistancePoints"] ?? NSNull(),
            "observedDistancePoints": phase["observedDistancePoints"] ?? NSNull(),
            "requestedToFirstCallbackSeconds": phase["requestedToFirstCallbackSeconds"] ?? NSNull(),
            "callbackCount": phase["callbackCount"] ?? NSNull(),
            "timedOut": phase["timedOut"] ?? NSNull(),
            "callbackIntervalMilliseconds": phase["callbackIntervalMilliseconds"] ?? NSNull(),
            "requestedAndObservedOffsetSamples": phase["offsetSamples"] ?? [],
            "visibilitySeekOffsetsPoints": visibilitySeekOffsets.mapValues(Double.init),
            "deliveryAcknowledgementBaselines": acknowledgementBaselines,
            "deliveryAcknowledgementAttempts": acknowledgementCounts,
            "requestCountsByMethodAndPath": fixture.requestCountsByMethodAndPath,
            "unexpectedRequests": fixture.diagnosticState["unexpectedRequests"] ?? [],
            "modelError": fixture.model.errorMessage ?? "",
        ]
        attachDiagnostic(report, name: "fixed-window-\(name)")
    }

    @MainActor
    private func emitStateDiagnostic(
        phase: String,
        fixtureDigest: String,
        setupSeconds: TimeInterval,
        fixture: ConversationPerformanceFixture,
        scroll: UIScrollView
    ) {
        let report = diagnosticBase(
            phase: phase, fixtureDigest: fixtureDigest,
            setupSeconds: setupSeconds, fixture: fixture, scroll: scroll
        )
        attachDiagnostic(report, name: "full-chat-view-\(phase)")
    }

    @MainActor
    private func emitFailureDiagnostic(
        phase: String,
        error: Error,
        fixtureDigest: String,
        fixtureSetupSeconds: TimeInterval,
        fixture: ConversationPerformanceFixture?,
        scroll: UIScrollView?,
        partialPhase: FullChatViewScrollRecorder.Result? = nil
    ) {
        var report = diagnosticBase(
            phase: phase, fixtureDigest: fixtureDigest,
            setupSeconds: fixtureSetupSeconds, fixture: fixture, scroll: scroll
        )
        let nsError = error as NSError
        report["errorType"] = String(reflecting: type(of: error))
        report["errorDescription"] = String(describing: error)
        report["errorDomain"] = nsError.domain
        report["errorCode"] = nsError.code
        if let partialPhase {
            report["partialPhaseMeasurement"] = Self.phaseSummary(phase, partialPhase)
        }
        attachDiagnostic(report, name: "full-chat-view-error-\(phase)")
    }

    @MainActor
    private func diagnosticBase(
        phase: String,
        fixtureDigest: String,
        setupSeconds: TimeInterval,
        fixture: ConversationPerformanceFixture?,
        scroll: UIScrollView?
    ) -> [String: Any] {
        let state = fixture?.diagnosticState ?? [:]
        let unexpectedRequests = state["unexpectedRequests"] as? [String] ?? []
        let modelError = fixture?.model.errorMessage
        return [
            "mode": "diagnostic-before-assertion",
            "phase": phase,
            "messageCount": fixture.map { $0.model.messages.count as Any } ?? NSNull(),
            "fixtureSHA256": fixtureDigest,
            "fixtureSetupSecondsIncludingBootstrap": setupSeconds,
            "coldMountToScrollableSeconds": fixture.map { $0.hostMountToScrollableSeconds as Any } ?? NSNull(),
            "reduceMotionEnabled": UIAccessibility.isReduceMotionEnabled,
            "viewportHeightPoints": scroll.map { ($0.bounds.height - $0.adjustedContentInset.top - $0.adjustedContentInset.bottom) as Any } ?? NSNull(),
            "contentHeightPoints": scroll.map { $0.contentSize.height as Any } ?? NSNull(),
            "contentOffsetYPoints": scroll.map { $0.contentOffset.y as Any } ?? NSNull(),
            "modelError": modelError ?? "",
            "boundaryError": unexpectedRequests.isEmpty ? (modelError ?? "") : unexpectedRequests.joined(separator: ", "),
            "requestState": state,
        ]
    }

    @MainActor
    private func attachDiagnostic(_ report: [String: Any], name: String) {
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .prettyPrinted]) else {
            XCTFail("Could not serialize diagnostic report for \(name)")
            return
        }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "\(name).json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("FULL_CHAT_VIEW_PHASE_DIAGNOSTIC \(String(decoding: data, as: UTF8.self))")
    }

    private static func fixtureDigest(_ messages: [ChatMessage]) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return SHA256.hash(data: try encoder.encode(messages))
            .map { String(format: "%02x", $0) }
            .joined()
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
        let observedStart = phase.offsetSamples.first?.observedYPoints
        let observedEnd = phase.offsetSamples.last?.observedYPoints
        return [
            "name": name,
            "durationSeconds": phase.elapsed,
            "requestedToFirstCallbackSeconds": phase.requestedToFirstCallbackSeconds as Any? ?? NSNull(),
            "callbackCount": phase.offsetSamples.count,
            "timedOut": phase.timedOut,
            "fromOffsetPoints": phase.fromOffset,
            "toOffsetPoints": phase.toOffset,
            "requestedDistancePoints": phase.toOffset - phase.fromOffset,
            "observedStartOffsetPoints": observedStart as Any? ?? NSNull(),
            "observedEndOffsetPoints": observedEnd as Any? ?? NSNull(),
            "observedDistancePoints": (observedStart != nil && observedEnd != nil)
                ? (observedEnd! - observedStart!) as Any : NSNull(),
            "callbackIntervalMilliseconds": [
                "p50": Self.percentile(sorted, 0.50) * 1_000,
                "p95": Self.percentile(sorted, 0.95) * 1_000,
                "max": (sorted.last ?? 0) * 1_000,
                "over16_67ms": phase.intervals.filter { $0 > 0.01667 }.count,
                "over33_3ms": phase.intervals.filter { $0 > 0.0333 }.count,
                "over100ms": phase.intervals.filter { $0 > 0.100 }.count,
            ],
            "intervalsMilliseconds": phase.intervals.map { $0 * 1_000 },
            "offsetSamples": phase.offsetSamples.map { [
                "timeSeconds": $0.timeSeconds,
                "requestedYPoints": Double($0.requestedYPoints),
                "observedYPoints": Double($0.observedYPoints),
            ] },
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
        let offsetSamples: [(timeSeconds: Double, requestedYPoints: CGFloat, observedYPoints: CGFloat)]
        let elapsed: Double
        let timedOut: Bool
        let requestedToFirstCallbackSeconds: Double?
    }

    private let scrollView: UIScrollView
    private let duration: CFTimeInterval
    private var displayLink: CADisplayLink?
    private var completion: CheckedContinuation<Result, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var startTime: CFTimeInterval = 0
    private var requestedAt: CFTimeInterval = 0
    private var requestedToFirstCallbackSeconds: Double?
    private var previousCallback: CFTimeInterval?
    private var fromOffset: CGFloat = 0
    private var toOffset: CGFloat = 0
    private var intervals: [Double] = []
    private var offsetSamples: [(timeSeconds: Double, requestedYPoints: CGFloat, observedYPoints: CGFloat)] = []
    private var elapsed: Double = 0
    private var timedOut = false

    var partialResult: Result {
        Result(
            fromOffset: fromOffset,
            toOffset: toOffset,
            intervals: intervals,
            offsetSamples: offsetSamples,
            elapsed: elapsed,
            timedOut: timedOut,
            requestedToFirstCallbackSeconds: requestedToFirstCallbackSeconds
        )
    }

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
            requestedAt = CACurrentMediaTime()
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
        if startTime == 0 {
            startTime = now
            requestedToFirstCallbackSeconds = max(0, now - requestedAt)
        }
        if let previousCallback { intervals.append(now - previousCallback) }
        previousCallback = now
        elapsed = now - startTime

        let progress = min(1, elapsed / duration)
        let offset = fromOffset + (toOffset - fromOffset) * progress
        scrollView.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
        offsetSamples.append((timeSeconds: elapsed, requestedYPoints: offset, observedYPoints: scrollView.contentOffset.y))
        guard elapsed >= duration else { return }
        scrollView.setContentOffset(CGPoint(x: 0, y: toOffset), animated: false)
        offsetSamples.append((timeSeconds: elapsed, requestedYPoints: toOffset, observedYPoints: scrollView.contentOffset.y))
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
            offsetSamples: offsetSamples,
            elapsed: elapsed,
            timedOut: timedOut,
            requestedToFirstCallbackSeconds: requestedToFirstCallbackSeconds
        ))
        completion = nil
    }
}
