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

        // Common, unmeasured setup settles the mounted transcript first, then
        // derives the real five-viewport window from stable UIKit geometry.
        let prepared = try await prepareFixedWindow(fixture: fixture, fixtureDigest: fixtureDigest,
                                                    mode: "fixed-window-setup")
        let actualTop = prepared.actualTop
        let viewport = prepared.viewport
        let target = prepared.target
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
    func testFullChatView500RowControlledIdleRefreshOverlap() async throws {
        let baseMessages = Self.fixtureMessages(count: 500, includeCalendarAgenda: true)
        let timestampedMessages = try Self.timestampedFixtureMessages(baseMessages)
        let fixtureDigest = try Self.fixtureDigest(timestampedMessages)
        for (original, dated) in zip(baseMessages, timestampedMessages) {
            XCTAssertEqual(original.id, dated.id)
            XCTAssertEqual(original.role, dated.role)
            XCTAssertEqual(original.parts, dated.parts)
            var originalMetadata = original.metadata ?? [:]
            var datedMetadata = dated.metadata ?? [:]
            originalMetadata.removeValue(forKey: "createdAt")
            datedMetadata.removeValue(forKey: "createdAt")
            XCTAssertEqual(originalMetadata, datedMetadata)
        }
        let parsedDates = timestampedMessages.compactMap(\.createdAt)
        XCTAssertEqual(parsedDates.count, timestampedMessages.count)
        XCTAssertTrue(zip(parsedDates, parsedDates.dropFirst()).allSatisfy { pair in pair.0 <= pair.1 })
        let calendarResponse = try JSONEncoder().encode(PhoneCalendarSharingRead(
            ownerId: ConversationPerformanceFixture.ownerID,
            ownerEmail: "owner@example.invalid", timeZone: "UTC", state: nil
        ))
        let durableTimestampCount = timestampedMessages.filter(\.isDurableLogRow).filter { $0.createdAt != nil }.count
        XCTAssertEqual(durableTimestampCount, timestampedMessages.filter(\.isDurableLogRow).count)
        XCTAssertEqual(durableTimestampCount, 500, "Every fixture row must be durable and timestamped")
        XCTAssertTrue(timestampedMessages.filter(\.isDurableLogRow).allSatisfy { $0.createdAt != nil })

        let fixture = try await ConversationPerformanceFixture.make(
            messages: timestampedMessages, controlledIdleUpdates: true,
            disabledCalendarSharingRead: calendarResponse
        )
        addTeardownBlock { await fixture.tearDown() }
        XCTAssertEqual(fixture.model.messages.count, 500)
        XCTAssertFalse(UIAccessibility.isReduceMotionEnabled)
        fixture.assertValidMeasurementBoundary()

        let scroll = fixture.scrollView
        let prepared = try await prepareFixedWindow(fixture: fixture, fixtureDigest: fixtureDigest,
                                                    mode: "controlled-overlap-setup")
        let usableViewport = prepared.viewport
        let actualTop = prepared.actualTop
        let target = prepared.target

        let initialIDs = fixture.model.messages.map(\.id)
        let warmBody = try Self.emptyUpdates(nextCursor: "overlap-warm")
        let measuredBody = try Self.emptyUpdates(nextCursor: "overlap-measured")
        let verificationBody = try Self.emptyUpdates(nextCursor: "overlap-verified")
        ControlledIdleUpdatesURLProtocol.prime(cursor: "performance-start", phase: "warm", body: warmBody, held: false)
        ControlledIdleUpdatesURLProtocol.prime(cursor: "overlap-warm", phase: "measured", body: measuredBody, held: true)
        ControlledIdleUpdatesURLProtocol.prime(cursor: "overlap-measured", phase: "verification", body: verificationBody, held: true)

        let activeStarted = CACurrentMediaTime()
        fixture.model.scenePhaseDidChange(.active)
        try await Self.waitUntil(timeout: 2.0) {
            let calendar = ControlledIdleUpdatesURLProtocol.snapshot.first { $0.phase == "calendar" }
            return calendar?.responseCompletedUptime != nil
                && !fixture.model.phoneCalendarSharing.isWorking
                && fixture.model.phoneCalendarSharing.isOwnerVerified
                && fixture.model.phoneCalendarSharing.errorMessage == nil
        }
        let calendarRead = try XCTUnwrap(ControlledIdleUpdatesURLProtocol.snapshot.first { $0.phase == "calendar" })
        let calendarReadCount = ControlledIdleUpdatesURLProtocol.snapshot.filter { $0.path == "/api/mobile/v1/calendars" }.count
        XCTAssertEqual(calendarReadCount, 1, "Active scene must settle one typed disabled-sharing read")
        XCTAssertEqual(calendarRead.method, "GET")
        XCTAssertEqual(calendarRead.path, "/api/mobile/v1/calendars")
        XCTAssertNotNil(calendarRead.responseCompletedUptime, "Typed calendar read must complete before warm refresh")
        XCTAssertEqual(fixture.model.phoneCalendarSharing.serverState, nil, "Fixture calendar response represents disabled sharing")
        XCTAssertFalse(fixture.model.phoneCalendarSharing.isSharingEnabled)
        XCTAssertTrue(fixture.model.phoneCalendarSharing.isOwnerVerified)
        XCTAssertNil(fixture.model.phoneCalendarSharing.errorMessage)

        let warmChanged = await fixture.model.refreshIdleConversation()
        XCTAssertEqual(warmChanged, false, "The accepted empty warm response must return false, not nil")
        let warmObservation = try XCTUnwrap(ControlledIdleUpdatesURLProtocol.snapshot.first { $0.phase == "warm" })
        XCTAssertEqual(warmObservation.query["cursor"], "performance-start")
        XCTAssertEqual(warmObservation.query["wait"], "20000")
        XCTAssertEqual(warmObservation.query["conversationId"], ConversationPerformanceFixture.conversationID)
        XCTAssertEqual(warmObservation.method, "GET")
        XCTAssertEqual(warmObservation.path, "/api/mobile/v1/chat/status")
        XCTAssertNil(warmObservation.query["taskId"])
        XCTAssertNil(warmObservation.query["refresh"], "Fixture has no pending decision refresh IDs")

        let recorder = FullChatViewScrollRecorder(scrollView: scroll, duration: 3.5)
        let recorderRequestStarted = CACurrentMediaTime()
        let recorderTask = Task {
            let invoked = CACurrentMediaTime()
            let result = await recorder.run(from: actualTop, to: target)
            return (invoked, result, CACurrentMediaTime())
        }
        try await Task.sleep(for: .milliseconds(500))
        let measuredTask = Task {
            let invoked = CACurrentMediaTime()
            let changed = await fixture.model.refreshIdleConversation()
            return (invoked, changed, CACurrentMediaTime())
        }
        try await Self.waitUntil(timeout: 2.0) {
            ControlledIdleUpdatesURLProtocol.snapshot.contains { $0.phase == "measured" }
        }
        try await Task.sleep(for: .milliseconds(1_500))
        ControlledIdleUpdatesURLProtocol.release("measured")
        let (recorderInvoked, scrollResult, recorderReturned) = await recorderTask.value
        let recorderFirstCallback = try XCTUnwrap(scrollResult.firstCallbackUptime)
        let recorderLastCallback = try XCTUnwrap(scrollResult.lastCallbackUptime)
        let (refreshInvoked, measuredChanged, refreshReturned) = await measuredTask.value
        let measuredObservation = try XCTUnwrap(ControlledIdleUpdatesURLProtocol.snapshot.first { $0.phase == "measured" })
        let idsAfterMeasured = fixture.model.messages.map(\.id)

        XCTAssertEqual(measuredChanged, false, "The accepted empty measured response must return false, not nil")
        XCTAssertEqual(idsAfterMeasured, initialIDs, "Cursor-only refresh must preserve ordered message IDs")
        XCTAssertEqual(fixture.model.messages.count, initialIDs.count)
        XCTAssertEqual(fixture.model.bootstrap?.identity.id, ConversationPerformanceFixture.ownerID)
        XCTAssertEqual(fixture.model.conversationId, ConversationPerformanceFixture.conversationID)
        XCTAssertFalse(fixture.model.isSending)
        XCTAssertEqual(measuredObservation.query["cursor"], "overlap-warm")
        XCTAssertEqual(measuredObservation.query["wait"], "20000")
        XCTAssertEqual(measuredObservation.query["conversationId"], ConversationPerformanceFixture.conversationID)
        XCTAssertEqual(measuredObservation.method, "GET")
        XCTAssertEqual(measuredObservation.path, "/api/mobile/v1/chat/status")
        XCTAssertNil(measuredObservation.query["taskId"])
        XCTAssertNil(measuredObservation.query["refresh"], "Fixture has no pending decision refresh IDs")
        XCTAssertGreaterThanOrEqual(scrollResult.intervals.count, 30)
        XCTAssertFalse(scrollResult.timedOut)
        XCTAssertGreaterThanOrEqual(scrollResult.elapsed, 3.0)
        XCTAssertEqual(scrollResult.fromOffset, actualTop, accuracy: 2)
        XCTAssertEqual(scrollResult.toOffset, target, accuracy: 2)
        XCTAssertEqual(scrollResult.offsetSamples.first?.observedYPoints ?? .nan, actualTop, accuracy: 2)
        XCTAssertEqual(scrollResult.offsetSamples.last?.observedYPoints ?? .nan, target, accuracy: 2)
        XCTAssertEqual(scrollResult.offsetSamples.first?.viewportHeightPoints ?? .nan, usableViewport, accuracy: 2)
        XCTAssertEqual(scrollResult.offsetSamples.last?.viewportHeightPoints ?? .nan, usableViewport, accuracy: 2)
        XCTAssertGreaterThanOrEqual(ConversationScrollPerformanceTests.bottomOffset(of: scroll), target + 2)

        let measuredDelivery = try XCTUnwrap(measuredObservation.responseDeliveredUptime)
        let measuredCompletion = try XCTUnwrap(measuredObservation.responseCompletedUptime)
        XCTAssertGreaterThanOrEqual(recorderInvoked, recorderRequestStarted)
        XCTAssertGreaterThanOrEqual(recorderFirstCallback, recorderInvoked)
        XCTAssertGreaterThanOrEqual(recorderLastCallback, recorderFirstCallback)
        XCTAssertGreaterThanOrEqual(recorderReturned, recorderLastCallback)
        XCTAssertGreaterThanOrEqual(refreshInvoked, recorderFirstCallback)
        XCTAssertLessThan(refreshInvoked, recorderLastCallback)
        XCTAssertGreaterThanOrEqual(measuredObservation.requestStartedUptime, recorderFirstCallback)
        XCTAssertGreaterThanOrEqual(measuredDelivery, measuredObservation.requestStartedUptime)
        XCTAssertLessThanOrEqual(measuredDelivery, recorderLastCallback)
        XCTAssertLessThanOrEqual(measuredCompletion, recorderLastCallback)
        XCTAssertGreaterThanOrEqual(refreshReturned, measuredCompletion)
        XCTAssertLessThanOrEqual(refreshReturned, recorderLastCallback)
        XCTAssertEqual(scrollResult.fromOffset, actualTop, accuracy: 2)
        assertSamplesStayWithinLegalBounds(scrollResult, expectedTop: actualTop, expectedViewport: usableViewport)
        let verificationTask = Task { await fixture.model.refreshIdleConversation() }
        try await Self.waitUntil(timeout: 2.0) {
            ControlledIdleUpdatesURLProtocol.snapshot.contains { $0.phase == "verification" }
        }
        let verificationObservation = try XCTUnwrap(ControlledIdleUpdatesURLProtocol.snapshot.first { $0.phase == "verification" })
        XCTAssertEqual(verificationObservation.query["cursor"], "overlap-measured")
        XCTAssertEqual(verificationObservation.query["wait"], "20000")
        XCTAssertEqual(verificationObservation.method, "GET")
        XCTAssertEqual(verificationObservation.path, "/api/mobile/v1/chat/status")
        XCTAssertNil(verificationObservation.query["taskId"])
        XCTAssertNil(verificationObservation.query["refresh"])
        fixture.model.scenePhaseDidChange(.background)
        let backgroundedAt = CACurrentMediaTime()
        ControlledIdleUpdatesURLProtocol.release("verification")
        let verificationChanged = await verificationTask.value
        XCTAssertNil(verificationChanged, "Background fence must reject the verification response")
        XCTAssertEqual(fixture.model.messages.map(\.id), initialIDs)

        let observations = ControlledIdleUpdatesURLProtocol.snapshot
        let setupCalendarCount = observations.filter { $0.path == "/api/mobile/v1/calendars" }.count
        let statusObservations = observations.filter { $0.path == "/api/mobile/v1/chat/status" }
        XCTAssertEqual(statusObservations.count, 3, "Expected warm, measured, and one post-window verification request")
        XCTAssertEqual(statusObservations.filter { $0.phase == "measured" }.count, 1)
        XCTAssertEqual(statusObservations.map(\.phase), ["warm", "measured", "verification"])
        XCTAssertFalse(statusObservations.contains { $0.phase == "UNPLANNED" }, "Unexpected status requests invalidate this run")
        XCTAssertEqual(setupCalendarCount, 1, "Active scene must settle one typed disabled-sharing read")
        XCTAssertLessThan(backgroundedAt - activeStarted, 12, "Controlled active fixture must finish before the first idle poll timer")
        fixture.assertValidMeasurementBoundary()

        func routeJSON(_ observation: ControlledIdleUpdatesURLProtocol.Observation) -> [String: Any] {
            [
                "method": observation.method,
                "path": observation.path,
                "query": observation.query,
                "conversation_id": observation.query["conversationId"] ?? "",
                "cursor": observation.query["cursor"] ?? "",
                "wait_ms": Int(observation.query["wait"] ?? "0") ?? 0,
                "task_id": observation.query["taskId"].map { $0 as Any } ?? NSNull(),
                "refresh_ids": (observation.query["refresh"] ?? "").split(separator: ",").map(String.init),
                "request_started_uptime": observation.requestStartedUptime,
                "response_delivered_uptime": observation.responseDeliveredUptime.map { NSNumber(value: $0) as Any } ?? NSNull(),
                "response_completed_uptime": observation.responseCompletedUptime.map { NSNumber(value: $0) as Any } ?? NSNull(),
                "phase": observation.phase,
            ]
        }
        let acceptedRoutes = statusObservations.filter { $0.phase != "verification" }
        let measuredOverlap = max(0, min(measuredCompletion, recorderLastCallback) - max(measuredObservation.requestStartedUptime, recorderFirstCallback))
        let phaseReport = Self.phaseSummary("controlled-idle-refresh-overlap", scrollResult)
        let summary: [String: Any] = [
            "schema_version": 1,
            "mode": "controlled-idle-refresh-overlap",
            "test_case_id": fixture.requestScopeID,
            "fixture_sha256": fixtureDigest,
            "timestamped_fixture_sha256": fixtureDigest,
            "message_count": timestampedMessages.count,
            "durable_timestamp_count": durableTimestampCount,
            "owner_id": ConversationPerformanceFixture.ownerID,
            "conversation_id": ConversationPerformanceFixture.conversationID,
            "scene_active": true,
            "scene_active_during_measured": true,
            "scene_active_after_window": false,
            "active_duration_seconds": backgroundedAt - activeStarted,
            "calendar_sync_get_count": setupCalendarCount,
            "status_request_count": statusObservations.count,
            "status_routes": statusObservations.map(routeJSON),
            "calendar_routes": observations.filter { $0.path == "/api/mobile/v1/calendars" }.map(routeJSON),
            "warm_cursor": warmObservation.query["cursor"] ?? "",
            "measured_cursor": measuredObservation.query["cursor"] ?? "",
            "measured_response_next_cursor": "overlap-measured",
            "verification_request_cursor": verificationObservation.query["cursor"] ?? "",
            "warm_result_changed": warmChanged.map { NSNumber(value: $0) as Any } ?? NSNull(),
            "measured_result_changed": measuredChanged.map { NSNumber(value: $0) as Any } ?? NSNull(),
            "warm_result_exactly_false": warmChanged == false,
            "measured_result_exactly_false": measuredChanged == false,
            "verification_result_is_nil": verificationChanged == nil,
            "accepted_in_window_count": acceptedRoutes.filter { $0.phase == "measured" }.count,
            "before_message_ids": initialIDs,
            "after_message_ids": fixture.model.messages.map(\.id),
            "before_message_count": initialIDs.count,
            "after_message_count": fixture.model.messages.count,
            "viewport_height_points": usableViewport,
            "actual_top_points": actualTop,
            "target_points": target,
            "measured_from_points": scrollResult.fromOffset,
            "measured_to_points": scrollResult.toOffset,
            "clock": "CACurrentMediaTime",
            "recorder_request_started_uptime": recorderRequestStarted,
            "recorder_invoked_uptime": recorderInvoked,
            "recorder_returned_uptime": recorderReturned,
            "callback_first_uptime": recorderFirstCallback,
            "callback_last_uptime": recorderLastCallback,
            "requested_to_first_callback_seconds": scrollResult.requestedToFirstCallbackSeconds as Any? ?? NSNull(),
            "recorder_phase_summary": phaseReport,
            "refresh_invoked_uptime": refreshInvoked,
            "refresh_returned_uptime": refreshReturned,
            "measured_response_overlap_ms": measuredOverlap * 1_000,
            "recorder_elapsed_seconds": scrollResult.elapsed,
            "recorder_sample_count": scrollResult.intervals.count,
            "scroll_result_valid": !scrollResult.timedOut && scrollResult.intervals.count >= 30
                && scrollResult.elapsed >= 3.0 && usableViewport > 100
                && abs(scrollResult.fromOffset - actualTop) <= 2 && abs(scrollResult.toOffset - target) <= 2
                && abs((scrollResult.offsetSamples.first?.observedYPoints ?? .greatestFiniteMagnitude) - actualTop) <= 2
                && abs((scrollResult.offsetSamples.last?.observedYPoints ?? .greatestFiniteMagnitude) - target) <= 2
                && ConversationScrollPerformanceTests.bottomOffset(of: scroll) >= target + 2,
            "expected_refresh_ids": (measuredObservation.query["refresh"] ?? "").split(separator: ",").map(String.init),
            "unexpected_requests": fixture.diagnosticState["unexpectedRequests"] ?? [],
            "driver": "CADisplayLink setContentOffset",
            "physical_touch_profile": false,
            "production_cadence": false,
            "profiler": false,
        ]
        let data = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys, .prettyPrinted])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "controlled-idle-refresh-overlap.json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("CONTROLLED_IDLE_REFRESH_OVERLAP \(String(decoding: data, as: UTF8.self))")
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
        // Identical unmeasured prelude warms the same five-viewport region used
        // in the matched fixed-window run before the external trace starts.
        let prepared = try await prepareFixedWindow(fixture: fixture, fixtureDigest: fixtureDigest,
                                                    mode: "quiet-profile-setup")
        let actualTop = prepared.actualTop
        let viewport = prepared.viewport
        let target = prepared.target
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

    private struct FixedWindowGeometry {
        let offset: CGFloat
        let top: CGFloat
        let bottom: CGFloat
        let viewport: CGFloat
        let contentWidth: CGFloat
        let contentHeight: CGFloat
        let boundsWidth: CGFloat
        let boundsHeight: CGFloat
        let insetTop: CGFloat
        let insetBottom: CGFloat
        let insetLeft: CGFloat
        let insetRight: CGFloat
        let adjustedInsetTop: CGFloat
        let adjustedInsetBottom: CGFloat
        let adjustedInsetLeft: CGFloat
        let adjustedInsetRight: CGFloat
        let sampledAt: TimeInterval

        var diagnostic: [String: Double] {
            [
                "observedOffsetPoints": Double(offset),
                "actualTopPoints": Double(top),
                "actualBottomPoints": Double(bottom),
                "viewportHeightPoints": Double(viewport),
                "contentWidthPoints": Double(contentWidth),
                "contentHeightPoints": Double(contentHeight),
                "boundsWidthPoints": Double(boundsWidth),
                "boundsHeightPoints": Double(boundsHeight),
                "contentInsetTopPoints": Double(insetTop),
                "contentInsetBottomPoints": Double(insetBottom),
                "contentInsetLeftPoints": Double(insetLeft),
                "contentInsetRightPoints": Double(insetRight),
                "adjustedInsetTopPoints": Double(adjustedInsetTop),
                "adjustedInsetBottomPoints": Double(adjustedInsetBottom),
                "adjustedInsetLeftPoints": Double(adjustedInsetLeft),
                "adjustedInsetRightPoints": Double(adjustedInsetRight),
                "sampledAtCACurrentMediaTime": sampledAt,
            ]
        }

        func matchesGeometry(_ other: FixedWindowGeometry, tolerance: CGFloat = 2) -> Bool {
            abs(top - other.top) <= tolerance
                && abs(bottom - other.bottom) <= tolerance
                && abs(viewport - other.viewport) <= tolerance
                && abs(contentWidth - other.contentWidth) <= tolerance
                && abs(contentHeight - other.contentHeight) <= tolerance
                && abs(boundsWidth - other.boundsWidth) <= tolerance
                && abs(boundsHeight - other.boundsHeight) <= tolerance
                && abs(insetTop - other.insetTop) <= tolerance
                && abs(insetBottom - other.insetBottom) <= tolerance
                && abs(insetLeft - other.insetLeft) <= tolerance
                && abs(insetRight - other.insetRight) <= tolerance
                && abs(adjustedInsetTop - other.adjustedInsetTop) <= tolerance
                && abs(adjustedInsetBottom - other.adjustedInsetBottom) <= tolerance
                && abs(adjustedInsetLeft - other.adjustedInsetLeft) <= tolerance
                && abs(adjustedInsetRight - other.adjustedInsetRight) <= tolerance
        }
    }

    private struct PreparedFixedWindow {
        let actualTop: CGFloat
        let viewport: CGFloat
        let target: CGFloat
        let contentHeight: CGFloat
    }

    private enum FixedWindowPreparationError: LocalizedError {
        case initialGeometryDidNotSettle
        case unusableViewport
        case insufficientScrollRoom
        case stageDidNotSettle(String)
        case geometryChanged(String)

        var errorDescription: String? {
            switch self {
            case .initialGeometryDidNotSettle: return "Initial scroll geometry did not settle within 3 seconds."
            case .unusableViewport: return "The settled usable viewport was too small for fixed-window measurement."
            case .insufficientScrollRoom: return "The settled transcript did not contain five usable viewport lengths."
            case .stageDidNotSettle(let stage): return "The \(stage) offset did not settle within ±2 points."
            case .geometryChanged(let stage): return "Scroll geometry changed from its settled anchor during \(stage)."
            }
        }
    }

    /// Shared bounded, unmeasured setup for every five-viewport run. It waits
    /// for the mounted content, insets, bounds, and viewport to settle before
    /// deriving the target, then records all three direct-UIKit positions.
    @MainActor
    private func prepareFixedWindow(
        fixture: ConversationPerformanceFixture,
        fixtureDigest: String,
        mode: String
    ) async throws -> PreparedFixedWindow {
        let scroll = fixture.scrollView
        let window = fixture.window
        let preparationStarted = CACurrentMediaTime()
        try await Task.sleep(for: .milliseconds(500))

        func sample() -> FixedWindowGeometry {
            window.setNeedsLayout()
            window.layoutIfNeeded()
            scroll.layoutIfNeeded()
            let adjusted = scroll.adjustedContentInset
            let viewport = scroll.bounds.height - adjusted.top - adjusted.bottom
            return FixedWindowGeometry(
                offset: scroll.contentOffset.y,
                top: -adjusted.top,
                bottom: Self.bottomOffset(of: scroll),
                viewport: viewport,
                contentWidth: scroll.contentSize.width,
                contentHeight: scroll.contentSize.height,
                boundsWidth: scroll.bounds.width,
                boundsHeight: scroll.bounds.height,
                insetTop: scroll.contentInset.top,
                insetBottom: scroll.contentInset.bottom,
                insetLeft: scroll.contentInset.left,
                insetRight: scroll.contentInset.right,
                adjustedInsetTop: adjusted.top,
                adjustedInsetBottom: adjusted.bottom,
                adjustedInsetLeft: adjusted.left,
                adjustedInsetRight: adjusted.right,
                sampledAt: CACurrentMediaTime()
            )
        }

        let initialDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        var initialAnchor: FixedWindowGeometry?
        var initialStableSamples = 0
        var initialSamples: [[String: Double]] = []
        var settled: FixedWindowGeometry?
        while ContinuousClock.now < initialDeadline {
            let current = sample()
            initialSamples.append(current.diagnostic)
            if let initialAnchor, current.matchesGeometry(initialAnchor) {
                initialStableSamples += 1
            } else {
                initialAnchor = current
                initialStableSamples = 1
            }
            if initialStableSamples >= 4 {
                settled = current
                break
            }
            try await Task.sleep(for: .milliseconds(60))
        }
        guard let settled else {
            attachDiagnostic([
                "mode": mode == "fixed-window-setup"
                    ? "fixed-window-geometry-settle" : "\(mode)-initial-geometry",
                "phase": "initial-geometry",
                "setupValid": false,
                "failure": "initial-geometry-did-not-settle",
                "fixtureSHA256": fixtureDigest,
                "messageCount": fixture.model.messages.count,
                "initialMountQuiescenceSeconds": CACurrentMediaTime() - preparationStarted,
                "stableSampleCount": initialStableSamples,
                "geometrySamples": initialSamples,
                "fixtureState": fixture.diagnosticState,
            ], name: "\(mode)-initial-geometry")
            throw FixedWindowPreparationError.initialGeometryDidNotSettle
        }
        let initialGeometrySettledAt = CACurrentMediaTime()

        let actualTop = settled.top
        let viewport = settled.viewport
        guard viewport > 100 else {
            attachDiagnostic([
                "mode": mode == "fixed-window-setup"
                    ? "fixed-window-geometry-settle" : "\(mode)-initial-geometry",
                "phase": "initial-geometry", "setupValid": false,
                "failure": "unusable-viewport", "fixtureSHA256": fixtureDigest,
                "initialMountQuiescenceSeconds": initialGeometrySettledAt - preparationStarted,
                "settledGeometry": settled.diagnostic, "geometrySamples": initialSamples,
            ], name: "\(mode)-initial-geometry")
            throw FixedWindowPreparationError.unusableViewport
        }
        let target = actualTop + viewport * 5
        guard settled.bottom >= target + 2 else {
            attachDiagnostic([
                "mode": mode == "fixed-window-setup"
                    ? "fixed-window-geometry-settle" : "\(mode)-initial-geometry",
                "phase": "initial-geometry", "setupValid": false,
                "failure": "insufficient-scroll-room", "fixtureSHA256": fixtureDigest,
                "initialMountQuiescenceSeconds": initialGeometrySettledAt - preparationStarted,
                "targetOffsetPoints": Double(target), "settledGeometry": settled.diagnostic,
                "geometrySamples": initialSamples,
            ], name: "\(mode)-initial-geometry")
            throw FixedWindowPreparationError.insufficientScrollRoom
        }
        attachDiagnostic([
            "mode": mode == "fixed-window-setup"
                ? "fixed-window-geometry-settle" : "\(mode)-initial-geometry",
            "phase": "initial-geometry", "setupValid": true,
            "fixtureSHA256": fixtureDigest, "messageCount": fixture.model.messages.count,
            "initialMountQuiescenceSeconds": initialGeometrySettledAt - preparationStarted,
            "targetOffsetPoints": Double(target), "stableSampleCount": initialStableSamples,
            "settledGeometry": settled.diagnostic, "geometrySamples": initialSamples,
        ], name: "\(mode)-initial-geometry")

        let stages: [(name: String, reportName: String, offset: CGFloat)]
        switch mode {
        case "fixed-window-setup":
            stages = [("top", "initial-top", actualTop),
                      ("target", "warm-target", target),
                      ("scored-start", "scored-start", actualTop)]
        case "quiet-profile-setup":
            stages = [("top", "prelude-top", actualTop),
                      ("target", "prelude-target", target),
                      ("scored-start", "prelude-scored-start", actualTop)]
        default:
            stages = [("top", "top", actualTop), ("target", "target", target),
                      ("scored-start", "scored-start", actualTop)]
        }
        for (stage, reportName, requested) in stages {
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            var anchor: FixedWindowGeometry?
            var stableSamples = 0
            var samples: [[String: Double]] = []
            var finalSample: FixedWindowGeometry?
            var geometryStayedFixed = true
            var offsetStayedLegal = true
            scroll.setContentOffset(CGPoint(x: 0, y: requested), animated: false)
            while ContinuousClock.now < deadline {
                // Observe after a full settling interval. Never set the offset
                // immediately before sampling, which could hide a competing
                // layout correction between consecutive observations.
                try await Task.sleep(for: .milliseconds(60))
                let current = sample()
                var diagnostic = current.diagnostic
                diagnostic["requestedOffsetPoints"] = Double(requested)
                let sameSettledGeometry = current.matchesGeometry(settled)
                geometryStayedFixed = geometryStayedFixed && sameSettledGeometry
                let offsetSettled = abs(current.offset - requested) <= 2
                let offsetLegal = requested >= current.top - 2 && requested <= current.bottom + 2
                offsetStayedLegal = offsetStayedLegal && offsetLegal
                diagnostic["requestedOffsetLegal"] = offsetLegal ? 1 : 0
                samples.append(diagnostic)
                if !sameSettledGeometry {
                    stableSamples = 0
                    anchor = nil
                } else if offsetSettled {
                    if let anchor, current.matchesGeometry(anchor), abs(current.offset - anchor.offset) <= 2 {
                        stableSamples += 1
                    } else {
                        anchor = current
                        stableSamples = 1
                    }
                } else {
                    stableSamples = 0
                    anchor = nil
                }
                finalSample = current
                if stableSamples >= 4 { break }
                if !offsetSettled && offsetLegal {
                    // A single bounded reassertion follows the diagnostic
                    // sample; the next stability observation is delayed.
                    scroll.setContentOffset(CGPoint(x: 0, y: requested), animated: false)
                }
            }
            let valid = stableSamples >= 4 && geometryStayedFixed && offsetStayedLegal
            var report: [String: Any] = [
                "mode": mode, "phase": reportName, "stage": reportName, "setupValid": valid,
                "failure": valid ? "" : (!geometryStayedFixed ? "settled-geometry-changed"
                    : !offsetStayedLegal ? "requested-offset-out-of-bounds" : "offset-did-not-settle"),
                "positioningProtocol": "direct-UIKit-top-target-top",
                "fixtureSHA256": fixtureDigest, "messageCount": fixture.model.messages.count,
                "requestedOffsetPoints": Double(requested),
                "actualTopPoints": Double(actualTop), "targetOffsetPoints": Double(target),
                "viewportHeightPoints": Double(viewport),
                "initialMountQuiescenceSeconds": initialGeometrySettledAt - preparationStarted,
                "settledGeometry": settled.diagnostic,
                "finalGeometry": finalSample?.diagnostic ?? [:],
                "stableSampleCount": stableSamples, "offsetStayedLegal": offsetStayedLegal,
                "geometrySamples": samples,
                "fixtureState": fixture.diagnosticState,
            ]
            if mode == "fixed-window-setup" {
                report["canonicalFixtureSHA256"] = fixtureDigest
                report["renderProbeInstrumented"] = ConversationRenderProbe.callSitesInstalled
                report["notScoredPerformance"] = ConversationRenderProbe.callSitesInstalled
            }
            attachDiagnostic(report, name: "\(mode)-\(reportName)")
            guard valid else {
                if !geometryStayedFixed { throw FixedWindowPreparationError.geometryChanged(stage) }
                if !offsetStayedLegal { throw FixedWindowPreparationError.insufficientScrollRoom }
                throw FixedWindowPreparationError.stageDidNotSettle(stage)
            }
        }

        return PreparedFixedWindow(actualTop: actualTop, viewport: viewport,
                                   target: target, contentHeight: settled.contentHeight)
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

    private static func timestampedFixtureMessages(_ messages: [ChatMessage]) throws -> [ChatMessage] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        guard let base = formatter.date(from: "2026-10-01T00:00:00.000Z") else {
            throw ControlledOverlapError.invalidTimestampBase
        }
        return messages.enumerated().map { index, original in
            var message = original
            var metadata = message.metadata ?? [:]
            metadata["createdAt"] = .string(formatter.string(from: base.addingTimeInterval(TimeInterval(index))))
            message.metadata = metadata
            return message
        }
    }

    private static func emptyUpdates(nextCursor: String) throws -> Data {
        try JSONEncoder().encode(ChatUpdates(
            taskStatus: nil, messages: [], refreshed: [], superseded: [],
            nextCursor: nextCursor, hasMore: false, activity: []
        ))
    }

    @MainActor
    private static func waitUntil(timeout: TimeInterval, predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(timeout))
        while ContinuousClock.now < deadline {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw ControlledOverlapError.timedOutWaitingForRequest
    }

    private enum ControlledOverlapError: Error {
        case invalidTimestampBase
        case timedOutWaitingForRequest
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

    var errorDescription: String? {
        switch self {
        case .controllerAborted(let payload): return "Profiler aborted the quiet-scroll profile: \(payload)"
        case .invalidControllerReceipt: return "Profiler GO receipt did not match the ready profile and trace-start notification"
        case .controllerTimedOut: return "Profiler did not publish GO or abort within 30 seconds"
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
        let firstCallbackUptime: CFTimeInterval?
        let lastCallbackUptime: CFTimeInterval?
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
            requestedToFirstCallbackSeconds: requestedToFirstCallbackSeconds,
            firstCallbackUptime: startTime == 0 ? nil : startTime,
            lastCallbackUptime: previousCallback
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
            requestedToFirstCallbackSeconds: requestedToFirstCallbackSeconds,
            firstCallbackUptime: startTime == 0 ? nil : startTime,
            lastCallbackUptime: previousCallback
        ))
        completion = nil
    }
}

