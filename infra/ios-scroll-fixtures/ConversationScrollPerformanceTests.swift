import XCTest
import SwiftUI
import UIKit
import QuartzCore
import CryptoKit
import os
@testable import Assistant

/// Bounded synthetic simulator scrolling evidence for the production transcript.
/// CADisplayLink callback intervals are not presented-frame FPS.
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
    func testFullChatView500RowFixedWindowBidirectional() async throws {
        let messageCount = 500
        let messages = Self.fixtureMessages(count: messageCount, includeCalendarAgenda: true)
        let fixtureDigest = try Self.fixtureDigest(messages)
        ConversationRenderProbe.shared.begin()
        let fixture: ConversationPerformanceFixture
        do {
            fixture = try await ConversationPerformanceFixture.make(messages: messages)
        } catch {
            ConversationRenderProbe.shared.end()
            throw error
        }
        addTeardownBlock {
            await fixture.tearDown()
            ConversationRenderProbe.shared.end()
        }

        XCTAssertEqual(fixture.model.messages.count, messageCount)
        XCTAssertFalse(UIAccessibility.isReduceMotionEnabled)
        fixture.assertValidMeasurementBoundary()

        // The production view owns ScrollPosition. Do not introduce another
        // ID-scroll authority or wait on historical delivery ACKs to position a
        // timing experiment. Functional visibility/state checks live separately.
        let scroll = fixture.scrollView
        try await Task.sleep(for: .milliseconds(500))
        emitRenderWorkCounter(
            phase: "after-mount-settle",
            boundary: "Mount window: fixture creation and initial mount settling."
        )

        func positionAndValidate(_ target: CGFloat, stage: String) async throws -> Bool {
            scroll.setContentOffset(CGPoint(x: 0, y: target), animated: false)
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            var samples: [[String: Double]] = []
            var stableSamples = 0
            var previousHeight: CGFloat?
            var previousViewport: CGFloat?
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(60))
                fixture.window.layoutIfNeeded()
                let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
                let height = scroll.contentSize.height
                samples.append([
                    "observedOffsetPoints": Double(scroll.contentOffset.y),
                    "actualTopPoints": Double(-scroll.adjustedContentInset.top),
                    "actualBottomPoints": Double(Self.bottomOffset(of: scroll)),
                    "viewportHeightPoints": Double(viewport),
                    "contentHeightPoints": Double(height),
                ])
                let stable = abs(scroll.contentOffset.y - target) <= 2
                    && previousHeight.map { abs(height - $0) <= 2 } == true
                    && previousViewport.map { abs(viewport - $0) <= 2 } == true
                stableSamples = stable ? stableSamples + 1 : 0
                previousHeight = height
                previousViewport = viewport
                if stableSamples >= 4 { break }
            }
            let valid = stableSamples >= 4
            // Emit before asserting: failed setup must still leave a compact
            // receipt instead of disappearing before the first timed phase.
            attachDiagnostic([
                "mode": "fixed-window-setup",
                "phase": stage,
                "positioningProtocol": "direct-UIKit-top-target-top",
                "canonicalFixtureSHA256": fixtureDigest,
                "messageCount": fixture.model.messages.count,
                "requestedOffsetPoints": Double(target),
                "setupValid": valid,
                "geometrySamples": samples,
                "fixtureState": fixture.diagnosticState,
                "renderProbeInstrumented": ConversationRenderProbe.callSitesInstalled,
                "notScoredPerformance": ConversationRenderProbe.callSitesInstalled,
            ], name: "fixed-window-setup-\(stage)")
            XCTAssertTrue(valid, "Direct UIKit \(stage) positioning failed to settle within ±2pt")
            return valid
        }

        let actualTop = -scroll.adjustedContentInset.top
        guard try await positionAndValidate(actualTop, stage: "initial-top") else { return }
        let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        let target = actualTop + viewport * 5
        let hasRoom = viewport > 100 && Self.bottomOffset(of: scroll) >= target + 2
        XCTAssertTrue(hasRoom, "Transcript must contain five usable viewport lengths below its actual top")
        guard hasRoom else { return }

        // Identical untimed endpoint positioning warms this fixed window on
        // both variants. This is not a full-history traversal or cold-pass claim.
        guard try await positionAndValidate(target, stage: "warm-target") else { return }
        guard try await positionAndValidate(actualTop, stage: "scored-start") else { return }
        XCTAssertEqual(scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom,
                       viewport, accuracy: 2)
        XCTAssertEqual(-scroll.adjustedContentInset.top, actualTop, accuracy: 2)
        XCTAssertGreaterThanOrEqual(Self.bottomOffset(of: scroll), target + 2)
        fixture.assertValidMeasurementBoundary()
        emitRenderWorkCounter(
            phase: "after-scored-start",
            boundary: "Preparation and delivery-acknowledgement window through scored start."
        )

        let down = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
            .run(from: actualTop, to: target)
        emitRenderWorkCounter(
            phase: "downward-scroll",
            boundary: "Immediately after the downward timed recorder returned."
        )
        assertSamplesStayWithinLegalBounds(down, expectedTop: actualTop, expectedViewport: viewport)
        let downJSON = Self.phaseSummary("fixed-five-viewports-down", down)
        emitFixedWindowPhase(
            name: "fixed-five-viewports-down", phase: downJSON,
            fixtureDigest: fixtureDigest, viewport: viewport,
            contentHeight: scroll.contentSize.height,
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
        emitRenderWorkCounter(
            phase: "upward-scroll",
            boundary: "Immediately after the upward timed recorder returned."
        )
        assertSamplesStayWithinLegalBounds(up, expectedTop: actualTop, expectedViewport: viewport)
        let upJSON = Self.phaseSummary("fixed-five-viewports-up", up)
        emitFixedWindowPhase(
            name: "fixed-five-viewports-up", phase: upJSON,
            fixtureDigest: fixtureDigest, viewport: viewport,
            contentHeight: scroll.contentSize.height,
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
    func testFullChatView500RowQuietScrollProfile() async throws {
        let messageCount = 500
        let messages = Self.fixtureMessages(count: messageCount, includeCalendarAgenda: true)
        let fixtureDigest = try Self.fixtureDigest(messages)
        let fixture = try await ConversationPerformanceFixture.make(messages: messages)
        addTeardownBlock { await fixture.tearDown() }

        XCTAssertEqual(fixture.model.messages.count, messageCount)
        XCTAssertFalse(UIAccessibility.isReduceMotionEnabled)
        XCTAssertFalse(ConversationRenderProbe.callSitesInstalled,
                       "The quiet profile must not inject render-work probes")
        fixture.assertValidMeasurementBoundary()

        let scroll = fixture.scrollView
        try await Task.sleep(for: .milliseconds(500))
        let actualTop = -scroll.adjustedContentInset.top
        let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        let target = actualTop + viewport * 5
        let hasRoom = viewport > 100 && Self.bottomOffset(of: scroll) >= target + 2
        XCTAssertTrue(hasRoom, "Transcript must contain five usable viewport lengths below its actual top")
        guard hasRoom else { return }

        func positionAndValidate(_ requested: CGFloat, stage: String) async throws {
            scroll.setContentOffset(CGPoint(x: 0, y: requested), animated: false)
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            var stableSamples = 0
            var previousHeight: CGFloat?
            var previousViewport: CGFloat?
            var samples: [[String: Double]] = []
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(60))
                fixture.window.layoutIfNeeded()
                let height = scroll.contentSize.height
                let usableViewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
                samples.append([
                    "observedOffsetPoints": Double(scroll.contentOffset.y),
                    "actualTopPoints": Double(-scroll.adjustedContentInset.top),
                    "actualBottomPoints": Double(Self.bottomOffset(of: scroll)),
                    "viewportHeightPoints": Double(usableViewport),
                    "contentHeightPoints": Double(height),
                ])
                let stable = abs(scroll.contentOffset.y - requested) <= 2
                    && previousHeight.map { abs(height - $0) <= 2 } == true
                    && previousViewport.map { abs(usableViewport - $0) <= 2 } == true
                stableSamples = stable ? stableSamples + 1 : 0
                previousHeight = height
                previousViewport = usableViewport
                if stableSamples >= 4 { break }
            }
            let valid = stableSamples >= 4
            attachDiagnostic([
                "mode": "quiet-profile-setup",
                "stage": stage,
                "requestedOffsetPoints": Double(requested),
                "setupValid": valid,
                "fixtureSHA256": fixtureDigest,
                "geometrySamples": samples,
            ], name: "quiet-profile-setup-\(stage)")
            XCTAssertTrue(valid, "Direct UIKit \(stage) positioning failed to settle within ±2pt")
            guard valid else { throw QuietScrollProfileError.positioningFailed(stage) }
        }

        // Identical unmeasured prelude warms the same five-viewport region used
        // in the matched fixed-window run before the external trace starts.
        try await positionAndValidate(actualTop, stage: "prelude-top")
        try await positionAndValidate(target, stage: "prelude-target")
        try await positionAndValidate(actualTop, stage: "prelude-scored-start")
        XCTAssertEqual(scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom,
                       viewport, accuracy: 2)
        XCTAssertEqual(-scroll.adjustedContentInset.top, actualTop, accuracy: 2)
        XCTAssertGreaterThanOrEqual(Self.bottomOffset(of: scroll), target + 2)
        fixture.assertValidMeasurementBoundary()

        let handshake = try fixture.makeQuietScrollProfileHandshake(fixtureSHA256: fixtureDigest)
        defer {
            try? FileManager.default.removeItem(at: handshake.readyURL)
            try? FileManager.default.removeItem(at: handshake.releaseURL)
            try? FileManager.default.removeItem(at: handshake.abortURL)
        }
        attachDiagnostic([
            "mode": "quiet-profile-ready",
            "profileId": handshake.profileID,
            "fixtureSHA256": handshake.fixtureSHA256,
            "messageCount": handshake.messageCount,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "executablePath": Bundle.main.executablePath ?? "",
            "readyPath": handshake.readyURL.path,
            "releasePath": handshake.releaseURL.path,
            "abortPath": handshake.abortURL.path,
            "notifyKey": handshake.notifyKey,
            "monotonicReadyUptime": handshake.monotonicReadyUptime,
            "actualTopPoints": Double(actualTop),
            "targetPoints": Double(target),
            "viewportHeightPoints": Double(viewport),
            "renderProbeInstrumented": false,
            "driver": "CADisplayLink setContentOffset",
            "physicalTouchProfile": false,
        ], name: "quiet-profile-ready")

        let controller = try await Self.awaitProfileController(handshake)
        let profileLog = OSLog(subsystem: "com.baldvinsmarason.assistant.scroll-profile", category: .pointsOfInterest)
        var completedPhases: [[String: Any]] = []
        let phases: [(String, CGFloat, CGFloat)] = [
            ("down-1", actualTop, target),
            ("up-2", target, actualTop),
            ("down-3", actualTop, target),
        ]
        for (phaseName, start, end) in phases {
            // A single OS signpost interval per phase is exported by Points of
            // Interest in the same trace as Time Profiler samples.
            let signpostID = OSSignpostID(log: profileLog)
            let phaseStart = ProcessInfo.processInfo.systemUptime
            os_signpost(.begin, log: profileLog, name: "QuietScrollPhase", signpostID: signpostID,
                        "phase=%{public}@ fixture=%{public}@", phaseName as NSString, handshake.profileID as NSString)
            let result = await FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
                .run(from: start, to: end)
            os_signpost(.end, log: profileLog, name: "QuietScrollPhase", signpostID: signpostID,
                        "phase=%{public}@ fixture=%{public}@", phaseName as NSString, handshake.profileID as NSString)
            let phaseEnd = ProcessInfo.processInfo.systemUptime
            let phase = Self.phaseSummary(phaseName, result)
            let report: [String: Any] = [
                "mode": "quiet-500-row-scroll-profile",
                "profileId": handshake.profileID,
                "fixtureSHA256": fixtureDigest,
                "messageCount": messageCount,
                "phase": phaseName,
                "phaseStartUptime": phaseStart,
                "phaseEndUptime": phaseEnd,
                "recordingStartedUptime": controller.recordingStartedUptime,
                "actualTopPoints": Double(actualTop),
                "targetPoints": Double(target),
                "viewportHeightPoints": Double(viewport),
                "contentHeightPoints": Double(scroll.contentSize.height),
                "signpostSubsystem": "com.baldvinsmarason.assistant.scroll-profile",
                "signpostCategory": "pointsOfInterest",
                "signpostName": "QuietScrollPhase",
                "signpostInterval": "phase=\(phaseName) fixture=\(handshake.profileID)",
                "renderProbeInstrumented": false,
                "driver": "CADisplayLink setContentOffset",
                "physicalTouchProfile": false,
                "requestCountsByMethodAndPath": fixture.requestCountsByMethodAndPath,
                "phaseResult": phase,
            ]
            attachDiagnostic(report, name: "quiet-profile-\(phaseName)")
            assertSamplesStayWithinLegalBounds(result, expectedTop: actualTop, expectedViewport: viewport)
            XCTAssertFalse(result.timedOut, "Quiet profile phase \(phaseName) exceeded its bounded callback wait")
            XCTAssertGreaterThanOrEqual(result.intervals.count, 30,
                                        "Quiet profile phase \(phaseName) callback coverage was too sparse")
            XCTAssertEqual(result.fromOffset, start, accuracy: 2)
            XCTAssertEqual(result.toOffset, end, accuracy: 2)
            XCTAssertEqual(result.offsetSamples.first?.observedYPoints ?? .nan, start, accuracy: 2)
            XCTAssertEqual(result.offsetSamples.last?.observedYPoints ?? .nan, end, accuracy: 2)
            XCTAssertEqual(scroll.contentOffset.y, end, accuracy: 2)
            fixture.assertValidMeasurementBoundary()
            completedPhases.append([
                "name": phaseName,
                "startUptime": phaseStart,
                "endUptime": phaseEnd,
                "callbackCount": result.offsetSamples.count,
                "firstCallbackDelaySeconds": result.requestedToFirstCallbackSeconds as Any? ?? NSNull(),
            ])
        }

        attachDiagnostic([
            "mode": "quiet-500-row-scroll-profile-complete",
            "profileId": handshake.profileID,
            "fixtureSHA256": fixtureDigest,
            "recordingStartedUptime": controller.recordingStartedUptime,
            "profileCompletedUptime": ProcessInfo.processInfo.systemUptime,
            "completedPhaseCount": completedPhases.count,
            "phases": completedPhases,
        ], name: "quiet-profile-complete")
        XCTAssertEqual(completedPhases.count, 3)
    }

    private struct ProfileControllerReceipt {
        let recordingStartedUptime: TimeInterval
    }

    @MainActor
    private static func awaitProfileController(
        _ handshake: QuietScrollProfileHandshake
    ) async throws -> ProfileControllerReceipt {
        let deadline = ContinuousClock.now.advanced(by: .seconds(30))
        while ContinuousClock.now < deadline {
            if FileManager.default.fileExists(atPath: handshake.abortURL.path) {
                let data = try Data(contentsOf: handshake.abortURL)
                throw QuietScrollProfileError.controllerAborted(String(decoding: data, as: UTF8.self))
            }
            if FileManager.default.fileExists(atPath: handshake.releaseURL.path) {
                let data = try Data(contentsOf: handshake.releaseURL)
                let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard let object,
                      object["profileId"] as? String == handshake.profileID,
                      object["recordingStartedObserved"] as? Bool == true,
                      object["recordingStarted"] as? Bool == true,
                      object["recordingStartedNotifyKey"] as? String == handshake.notifyKey,
                      let started = object["recordingStartedUptime"] as? NSNumber else {
                    throw QuietScrollProfileError.invalidControllerReceipt
                }
                return ProfileControllerReceipt(recordingStartedUptime: started.doubleValue)
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw QuietScrollProfileError.controllerTimedOut
    }

    @MainActor
    private func emitFixedWindowPhase(
        name: String,
        phase: [String: Any],
        fixtureDigest: String,
        viewport: CGFloat,
        contentHeight: CGFloat,
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
            "positioningProtocol": "direct-UIKit-top-target-top",
            "renderProbeInstrumented": ConversationRenderProbe.callSitesInstalled,
            "notScoredPerformance": ConversationRenderProbe.callSitesInstalled,
            "requestCountsByMethodAndPath": fixture.requestCountsByMethodAndPath,
            "unexpectedRequests": fixture.diagnosticState["unexpectedRequests"] ?? [],
            "modelError": fixture.model.errorMessage ?? "",
        ]
        attachDiagnostic(report, name: "fixed-window-\(name)")
    }

    @MainActor
    private func emitRenderWorkCounter(phase: String, boundary: String) {
        let counts = ConversationRenderProbe.shared.snapshotAndReset()
        attachDiagnostic([
            "mode": "render-work-counter-diagnostic",
            "phase": phase,
            "phaseBoundaryDescription": boundary,
            "bodyEvaluationCount": counts.bodyEvaluations,
            "explicitCardParserAttempts": counts.explicitCardParseAttempts,
            "renderProbeInstrumented": ConversationRenderProbe.callSitesInstalled,
            "notScoredPerformance": ConversationRenderProbe.callSitesInstalled,
        ], name: "render-work-counter-\(phase)")
    }

    @MainActor
    private func assertSamplesStayWithinLegalBounds(
        _ result: FullChatViewScrollRecorder.Result,
        expectedTop: CGFloat,
        expectedViewport: CGFloat
    ) {
        XCTAssertFalse(result.offsetSamples.isEmpty)
        for (index, sample) in result.offsetSamples.enumerated() {
            XCTAssertEqual(sample.actualTopPoints, expectedTop, accuracy: 2,
                           "Actual top changed during callback sample \(index)")
            XCTAssertEqual(sample.viewportHeightPoints, expectedViewport, accuracy: 2,
                           "Viewport changed during callback sample \(index)")
            XCTAssertGreaterThanOrEqual(sample.requestedYPoints, sample.actualTopPoints - 2,
                                         "Requested offset escaped the legal top at callback sample \(index)")
            XCTAssertLessThanOrEqual(sample.requestedYPoints, sample.actualBottomPoints + 2,
                                      "Requested offset escaped the legal bottom at callback sample \(index)")
            XCTAssertGreaterThanOrEqual(sample.observedYPoints, sample.actualTopPoints - 2,
                                         "Observed offset escaped the legal top at callback sample \(index)")
            XCTAssertLessThanOrEqual(sample.observedYPoints, sample.actualBottomPoints + 2,
                                      "Observed offset escaped the legal bottom at callback sample \(index)")
        }
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
                "actualTopPoints": Double($0.actualTopPoints),
                "actualBottomPoints": Double($0.actualBottomPoints),
                "viewportHeightPoints": Double($0.viewportHeightPoints),
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

private enum QuietScrollProfileError: LocalizedError {
    case controllerAborted(String)
    case invalidControllerReceipt
    case controllerTimedOut
    case positioningFailed(String)

    var errorDescription: String? {
        switch self {
        case .controllerAborted(let payload): return "Profiler aborted the quiet-scroll profile: \(payload)"
        case .invalidControllerReceipt: return "Profiler GO receipt did not match the ready profile and trace-start notification"
        case .controllerTimedOut: return "Profiler did not publish GO or abort within 30 seconds"
        case .positioningFailed(let stage): return "Quiet profile positioning failed at \(stage)"
        }
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
        let offsetSamples: [(
            timeSeconds: Double,
            requestedYPoints: CGFloat,
            observedYPoints: CGFloat,
            actualTopPoints: CGFloat,
            actualBottomPoints: CGFloat,
            viewportHeightPoints: CGFloat
        )]
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
    private var offsetSamples: [(
        timeSeconds: Double,
        requestedYPoints: CGFloat,
        observedYPoints: CGFloat,
        actualTopPoints: CGFloat,
        actualBottomPoints: CGFloat,
        viewportHeightPoints: CGFloat
    )] = []
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
        offsetSamples.append((
            timeSeconds: elapsed,
            requestedYPoints: offset,
            observedYPoints: scrollView.contentOffset.y,
            actualTopPoints: -scrollView.adjustedContentInset.top,
            actualBottomPoints: ConversationScrollPerformanceTests.bottomOffset(of: scrollView),
            viewportHeightPoints: scrollView.bounds.height - scrollView.adjustedContentInset.top - scrollView.adjustedContentInset.bottom
        ))
        guard elapsed >= duration else { return }
        scrollView.setContentOffset(CGPoint(x: 0, y: toOffset), animated: false)
        offsetSamples.append((
            timeSeconds: elapsed,
            requestedYPoints: toOffset,
            observedYPoints: scrollView.contentOffset.y,
            actualTopPoints: -scrollView.adjustedContentInset.top,
            actualBottomPoints: ConversationScrollPerformanceTests.bottomOffset(of: scrollView),
            viewportHeightPoints: scrollView.bounds.height - scrollView.adjustedContentInset.top - scrollView.adjustedContentInset.bottom
        ))
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

