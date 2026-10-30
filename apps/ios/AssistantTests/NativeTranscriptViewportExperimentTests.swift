#if DEBUG
import XCTest
import SwiftUI
import QuartzCore
@testable import Assistant

/// Source-defined gates, not recorded runtime results. A failed geometry
/// requirement throws immediately: no state gate or layout variant follows it.
final class NativeTranscriptViewportExperimentTests: XCTestCase {
    private enum GateFailure: Error { case stop(String) }
    @MainActor
    private func require(_ condition: @autoclosure () -> Bool, _ message: String,
                         file: StaticString = #filePath, line: UInt = #line) throws {
        let passed = condition(); XCTAssertTrue(passed, message, file: file, line: line)
        if !passed { throw GateFailure.stop(message) }
    }
    @MainActor
    private func close(_ actual: CGFloat, _ expected: CGFloat, _ label: String,
                       file: StaticString = #filePath, line: UInt = #line) throws {
        try require(actual.isFinite && expected.isFinite && abs(actual - expected) <= 0.5,
                    "\(label): actual=\(actual), expected=\(expected)", file: file, line: line)
    }
    @MainActor
    private func wait(_ label: String, until predicate: @escaping @MainActor () -> Bool) async throws {
        if predicate() { return }
        let ready = expectation(description: label)
        let observer = NativeViewportFrameObserver(predicate: predicate, ready: { ready.fulfill() })
        observer.start()
        defer { observer.stop() }
        await fulfillment(of: [ready], timeout: 3)
        try require(predicate(), "STOP: missing actual native readiness: \(label)")
    }
    @MainActor
    private func fixture(revision: Int = 1, plainID: String = "stream-experiment", token: String = "initial",
                         actionRevision: Int = 0, scope: NativeTranscriptExperimentSession.Scope? = nil,
                         receiptCount: Int = 2, shortPlain: Bool = false,
                         change: NativeTranscriptExperimentSession.Change = .initial) -> NativeTranscriptExperimentSession.Snapshot {
        let plainText = (shortPlain ? "" : String(repeating: "A paragraph from the actual streaming Markdown renderer.\n\n", count: 26)) + token
        let plain = ChatMessage.optimistic(role: .assistant, text: plainText, id: plainID)
        let events: [MessagePart] = (0..<4).map { index in
            .init(type: "data-card", data: .object([
                "kind": .string("calendar-event"), "id": .string("event-\(index)"),
                "start": .string("2026-10-\(24 + index)T09:30:00-07:00"),
                "time": .string("9:30 AM"), "title": .string("Read-only fixture day \(index + 1)"),
                "location": .string("Fixture room"), "attendees": .array([]), "calendars": .array([.string("Personal")]),
            ]))
        }
        let rich = ChatMessage(id: "rich-experiment", role: .assistant, parts: [
            .init(type: "text", text: String(repeating: "The supporting result remains part of this real answer.\n\n", count: 20))
        ] + events)
        let receipts = (0..<receiptCount).map { index in
            ChatMessage(id: "receipt-\(index)", role: .assistant, parts: [
                .init(type: "text", text: "Recorded fixture decision \(index)"),
                .init(type: "approval", approvalId: "approval-\(index)", shortCode: "A\(index)",
                      summary: "Recorded fixture decision \(index)", status: "approved"),
            ])
        }
        return .init(scope: scope ?? .init(ownerID: "fixture-owner", serverIdentity: "https://viewport.invalid",
                                           connectionEpoch: 1, conversationID: "fixture-conversation"),
                     revision: revision, actionRevision: actionRevision,
                     rows: [.init(kind: .plain, messages: [plain], streaming: plainID.hasPrefix("stream-")),
                            .init(kind: .rich, messages: [rich], streaming: false),
                            .init(kind: .receipts, messages: receipts, streaming: false)], change: change)
    }

    @MainActor
    func testActualChatViewGeometryThenStreamingReaderPolicyAndRetainedRows() async throws {
        try await runActualParent(geometryOnly: false)
    }
    @MainActor
    func testActualChatViewRTLAX3AndNonzeroHorizontalSafeAreaGeometry() async throws {
        try await runActualParent(geometryOnly: true, additionalInsets: UIEdgeInsets(top: 0, left: 20, bottom: 0, right: 20),
                                  typeSize: .accessibility3, direction: .rightToLeft)
    }
    @MainActor
    private func runActualParent(geometryOnly: Bool, additionalInsets: UIEdgeInsets = .zero,
                                 typeSize: DynamicTypeSize = .large, direction: LayoutDirection = .leftToRight) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible(); window.layoutIfNeeded()
        defer { window.isHidden = true; window.rootViewController = nil; previousKeyWindow?.makeKey() }
        let suite = "assistant.native-viewport-experiment.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativeViewportNoNetwork.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://viewport.invalid")!, token: "synthetic"),
                               session: URLSession(configuration: config))
        let initial = fixture()
        // No refreshAll/bootstrap/send: this gate must not queue OS Live Activity,
        // badges, provider requests or authoritative business work.
        let model = AppModel(apiClient: client, initialMessages: initial.rows.flatMap(\.messages), defaults: defaults,
                             enqueueAutomaticSpeech: { _ in XCTFail("No speech in a geometry fixture") },
                             scheduleLocalNotification: { _, _, _, _, _, _ in XCTFail("No notifications"); return false })
        let session = NativeTranscriptExperimentSession(snapshot: initial)
        var proofStage = "geometry-first"
        defer { try? attachDiagnostics(session, stage: proofStage) }
        // This gate mounts ChatView itself; RootView's ActivityCrown is absent,
        // not a fabricated rectangle. RootView integration remains a later gate.
        session.crownOcclusion = .absent
        var acknowledgements: [String] = []
        session.acknowledge = { id in acknowledgements.append(id); return true }
        let chat = ChatView.nativeViewportExperiment(session,
            safeAreaTopInset: window.safeAreaInsets.top, safeAreaBottomInset: window.safeAreaInsets.bottom,
            safeAreaLeadingInset: window.safeAreaInsets.left + additionalInsets.left,
            safeAreaTrailingInset: window.safeAreaInsets.right + additionalInsets.right)
        let effectiveWidth = window.bounds.width - window.safeAreaInsets.left - window.safeAreaInsets.right
            - additionalInsets.left - additionalInsets.right
        let host = UIHostingController(rootView: AnyView(chat.environment(model).environment(\.scenePhase, .active)
            .environment(\.colorScheme, .light).environment(\.dynamicTypeSize, typeSize)
            .environment(\.locale, Locale(identifier: "en_US_POSIX"))
            .environment(\.calendar, Calendar(identifier: .gregorian)).environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
            .environment(\.layoutDirection, direction).environment(\.nativeExperimentFixtureViewportWidth, effectiveWidth)))
        host.additionalSafeAreaInsets = additionalInsets
        window.rootViewController = host; window.layoutIfNeeded()
        try await wait("real collection, all three laid-out row attributes and actual composer") {
            guard let geometry = session.geometry else { return false }
            return geometry.rowFramesInWindow.count == 3 && geometry.composerInWindow.height > 0
                && abs(geometry.footer - geometry.composerInWindow.height - 18) < 0.5
        }
        let controller = try XCTUnwrap(session.controller)
        let composerInput = try XCTUnwrap(descendants(window).compactMap { $0 as? UITextView }
            .first(where: { $0.accessibilityIdentifier == "assistant.chat.composer" }))
        let baseline = try XCTUnwrap(session.geometry)
        let stationaryMarker = try XCTUnwrap(session.stationaryView)
        let composerMarker = try XCTUnwrap(session.composerView)
        let nativeBaselineSize = controller.collection.bounds.size
        let nativeBaselineOffset = controller.collection.contentOffset
        let nativeBaselineViewport = controller.collection.convert(controller.collection.bounds, to: window)
        let nativeBaselineComposer = composerMarker.convert(composerMarker.bounds, to: window)
        let nativeLastCell = try XCTUnwrap(controller.collection.cellForItem(at: IndexPath(item: 2, section: 0)))
        let nativeLastFrame = nativeLastCell.convert(nativeLastCell.bounds, to: window)
        try close(controller.collection.bounds.width, stationaryMarker.bounds.width, "independent actual stationary width")
        try close(controller.collection.bounds.height, stationaryMarker.bounds.height, "independent actual stationary height")
        try close(host.view.safeAreaInsets.left, window.safeAreaInsets.left + additionalInsets.left, "actual hosting horizontal safe area")
        let receiptID = initial.rows[2].id
        let lastRow = try XCTUnwrap(baseline.rowFramesInWindow[receiptID])
        try require(baseline.contentInset == .zero && baseline.adjustedInset == .zero, "Native insets must actually be zero")
        try require(baseline.bounds.width > 0 && baseline.bounds.height > 0, "Missing viewport cannot pass")
        try require(descendants(controller.view).filter { $0 is UICollectionView }.count == 1,
                    "Exactly one collection viewport")
        try require(!descendants(controller.view).contains { $0 is UIScrollView && !($0 is UICollectionView) && !($0 is UITextView) },
                    "No nested transcript ScrollView")
        try close(baseline.composerInWindow.minY - lastRow.maxY, 18, "actual no-notice row/composer clearance")
        for lift in [CGFloat(0), 1, 5, 10, 20, 450, 20, 10, 5, 1, 0] {
            session.reveal(lift)
            try await wait("actual parent reveal \(lift)") { session.geometry?.reveal == lift }
            window.layoutIfNeeded(); controller.captureGeometry()
            let measured = try XCTUnwrap(session.geometry)
            // Independent oracle reads UIKit objects here; no expected frame,
            // clearance or reveal delta comes from the candidate's receipt math.
            let actualViewport = controller.collection.convert(controller.collection.bounds, to: window)
            let actualComposer = composerMarker.convert(composerMarker.bounds, to: window)
            let actualCell = try XCTUnwrap(controller.collection.cellForItem(at: IndexPath(item: 2, section: 0)))
            let actualRow = actualCell.convert(actualCell.bounds, to: window)
            try close(controller.collection.bounds.width, nativeBaselineSize.width, "independent native width")
            try close(controller.collection.bounds.height, nativeBaselineSize.height, "independent native height")
            try close(controller.collection.contentOffset.y, nativeBaselineOffset.y, "independent offset")
            try require(controller.collection.contentInset == .zero && controller.collection.adjustedContentInset == .zero,
                        "Independent actual native inset oracle")
            try close(actualViewport.minY, nativeBaselineViewport.minY - lift, "independent native reveal")
            try close(actualComposer.minY, nativeBaselineComposer.minY - lift, "independent original composer reveal")
            try close(actualRow.minY, nativeLastFrame.minY - lift, "independent actual cell reveal")
            try close(actualComposer.minY - actualRow.maxY, 18, "independent painted row/composer spacing")
            try close(measured.bounds.width, baseline.bounds.width, "native width at \(lift)")
            try close(measured.bounds.height, baseline.bounds.height, "native height at \(lift)")
            try require(measured.contentInset == .zero && measured.adjustedInset == .zero, "Insets drift at \(lift)")
            try close(measured.offset.y, baseline.offset.y, "contentOffset at \(lift)")
            try close(measured.contentSize.height, baseline.contentSize.height, "content size at \(lift)")
            try close(measured.stationaryInWindow.minY, baseline.stationaryInWindow.minY, "stationary origin")
            try close(measured.viewportInWindow.minY, baseline.viewportInWindow.minY - lift, "native 1:1 reveal")
            try close(measured.composerInWindow.minY, baseline.composerInWindow.minY - lift, "composer 1:1 reveal")
            let last = try XCTUnwrap(measured.rowFramesInWindow[receiptID])
            try close(last.minY, lastRow.minY - lift, "row 1:1 reveal")
            try close(measured.composerInWindow.minY - last.maxY, 18, "18pt clearance at \(lift)")
            try require(descendants(window).contains { $0 === composerInput }, "SwiftUI-owned composer's original UITextView replaced")
            try attachGeometry(measured, name: "geometry-first-\(Int(lift))")
            var rendered = false
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try require(rendered, "Actual window screenshot must render")
            let attachment = XCTAttachment(image: image)
            attachment.name = "actual-native-parent-\(typeSize)-\(direction)-lift-\(Int(lift))"
            attachment.lifetime = .keepAlways; add(attachment)
        }
        // Nothing below runs if any geometry assertion above fails.
        if geometryOnly { return }
        proofStage = "streaming-and-policy-phase-not-physical-gesture"
        let provisional = initial.rows[0].id
        let provisionalHost = try XCTUnwrap(controller.hostIdentity(provisional))
        controller.collection.setContentOffset(.zero, animated: false)
        controller.collection.layoutIfNeeded()
        try await wait("actual provisional subtree mount") { session.mountTokens[provisional] != nil }
        let provisionalMount = session.mountTokens[provisional]
        controller.jumpToLatest()
        try await wait("explicit latest policy reaches its actual edge") {
            abs(controller.collection.contentOffset.y - max(0, controller.collection.contentSize.height - controller.collection.bounds.height)) < 0.5
        }
        session.apply(fixture(revision: 73, token: "latest-token-73", change: .values))
        try await wait("typed value revision73") { controller.renderedRevision == 73 && !controller.applyingSnapshot }
        try require(controller.renderedText(provisional)?.hasSuffix("latest-token-73") == true, "Latest root VALUE delivered; not Transaction equivalence")
        try require(controller.hostIdentity(provisional) == provisionalHost, "Token update must retain host")
        try close(controller.collection.contentOffset.y,
                  max(0, controller.collection.contentSize.height - controller.collection.bounds.height), "latest follows token growth")
        session.apply(fixture(revision: 72, token: "STALE", change: .values))
        try require(session.snapshot.revision == 73, "Older render revision rejected")
        // Explicit policy-phase injection exercises actual native offset/layout;
        // this is NOT finger-driven scrolling, UIKit phase delivery or selection proof.
        controller.exerciseReaderPhase(.interacting)
        let richFrame = try XCTUnwrap(controller.rowFrame("rich-experiment"))
        controller.collection.setContentOffset(CGPoint(x: 0, y: richFrame.minY + 50), animated: false)
        let readerOffset = controller.collection.contentOffset.y
        session.apply(fixture(revision: 74, token: "latest-token-74\n" + String(repeating: "growth\n", count: 25), change: .values))
        try await wait("typed value revision74") { controller.renderedRevision == 74 && !controller.applyingSnapshot }
        try require(controller.renderedText(provisional)?.contains("latest-token-74") == true, "Revision74 root VALUE delivered")
        try close(controller.collection.contentOffset.y, readerOffset, "No pin while reader policy phase owns offset")
        try require(session.restorations.last?.suppressedByGesture == true, "Reader-phase restoration must be recorded as suppressed")
        controller.exerciseReaderPhase(.idle)
        try require(!controller.followsLatest, "Older reader stays opted out after policy idle")
        let beforeUpdate = controller.collection.contentOffset.y
        let beforeFrame = try XCTUnwrap(controller.rowFrame("rich-experiment"))
        let fraction = (beforeFrame.minY - beforeUpdate) / controller.collection.bounds.height
        session.apply(fixture(revision: 75, token: "more growth\n" + String(repeating: "growth\n", count: 35), change: .values))
        try await wait("older-reader layout") { controller.renderedRevision == 75 && !controller.applyingSnapshot }
        let afterFrame = try XCTUnwrap(controller.rowFrame("rich-experiment"))
        let requested = afterFrame.minY - fraction * controller.collection.bounds.height
        let expected = min(max(0, requested), max(0, controller.collection.contentSize.height - controller.collection.bounds.height))
        try close(controller.collection.contentOffset.y, expected, "Selected surviving row's own TOP fraction")
        let olderOffset = controller.collection.contentOffset
        controller.collection.setContentOffset(.zero, animated: false)
        controller.collection.layoutIfNeeded()
        try await wait("actual same-identity provisional subtree returned with latest value") {
            session.contextRevisions[provisional] == 75 && session.mountTokens[provisional] == provisionalMount
        }
        controller.collection.setContentOffset(olderOffset, animated: false)
        let oldLease = try XCTUnwrap(session.beginLease(itemID: provisional))
        let arrivalCount = session.events.filter { $0.hasPrefix("arrival-intent:") }.count
        let replacementAnchorFrame = try XCTUnwrap(controller.rowFrame("rich-experiment"))
        let replacementFraction = (replacementAnchorFrame.minY - controller.collection.contentOffset.y) / controller.collection.bounds.height
        session.acknowledge = nil // Later dedicated delivery gate controls its own admission.
        session.apply(fixture(revision: 76, plainID: "durable-experiment", token: "latest durable value", change: .provisionalToDurable))
        try await wait("replacement update completion") { !controller.applyingSnapshot && controller.hostIdentity("durable-experiment") != nil }
        try require(controller.hostIdentity(provisional) == nil, "Retire actual provisional key")
        try require(controller.hostIdentity("durable-experiment") != provisionalHost, "No provisional/durable host alias")
        try require(controller.renderedText("durable-experiment")?.hasSuffix("latest durable value") == true, "Replacement retains latest durable value")
        let replacementNewFrame = try XCTUnwrap(controller.rowFrame("rich-experiment"))
        let replacementRequested = replacementNewFrame.minY - replacementFraction * controller.collection.bounds.height
        try close(controller.collection.contentOffset.y,
                  min(max(0, replacementRequested), max(0, controller.collection.contentSize.height - controller.collection.bounds.height)),
                  "Older reader retains surviving stable anchor through finalization")
        try require(session.events.filter { $0 == "retire:\(provisional)" }.count == 1, "Exactly one provisional retirement")
        try require(session.events.filter { $0.hasPrefix("arrival-intent:") }.count == arrivalCount, "No second arrival intent")
        try require(!session.complete(oldLease, value: "late"), "Retired callback cannot update durable host")
        try require(!acknowledgements.contains(provisional), "Provisional row never acknowledges")
        try require(controller.retainedHostCount == 3, "Exactly three live retained hosts")
        try require(!session.events.contains(where: { $0.hasPrefix("REMOUNT:") }), "Same-identity subtree mount changed")

        // Actual production controls: no direct callback or lookup fallback.
        proofStage = "actual-production-local-disclosure-state"
        // If this hosted native environment cannot activate them, that is a
        // failed state gate, not permission to seed expansion or waive it.
        try scrollRowToBottom("rich-experiment", controller: controller)
        try await wait("actual Sources button") { self.accessible(label: "Sources and details", in: controller.rowView("rich-experiment")) != nil }
        try activate(try XCTUnwrap(accessible(label: "Sources and details", in: controller.rowView("rich-experiment"))))
        try await wait("actual source expansion") { self.accessibilityValue(label: "Sources and details", in: controller.rowView("rich-experiment")) == "Expanded" }
        try scrollRowToBottom("rich-experiment", controller: controller)
        try await wait("actual nested CardDisclosure") { self.accessible(label: "Show 1 more result", in: controller.rowView("rich-experiment")) != nil }
        try activate(try XCTUnwrap(accessible(label: "Show 1 more result", in: controller.rowView("rich-experiment"))))
        try await wait("actual nested expanded label") { self.accessible(label: "Showing all 4 results", in: controller.rowView("rich-experiment")) != nil }
        let richHost = controller.hostIdentity("rich-experiment")
        let richMount = session.mountTokens["rich-experiment"]
        controller.collection.setContentOffset(.zero, animated: false)
        controller.collection.layoutIfNeeded()
        session.apply(fixture(revision: 77, plainID: "durable-experiment", token: "same durable value", change: .values))
        try scrollRowToBottom("rich-experiment", controller: controller)
        try await wait("retained actual disclosure") { self.accessibilityValue(label: "Showing all 4 results", in: controller.rowView("rich-experiment")) == "Expanded" }
        try require(controller.hostIdentity("rich-experiment") == richHost && session.mountTokens["rich-experiment"] == richMount,
                    "Retained controller alone is insufficient: mount token and actual expanded control must survive")
        try scrollRowToBottom(receiptID, controller: controller)
        try await wait("actual receipt group") { self.accessible(label: "2 requests approved", in: controller.rowView(receiptID)) != nil }
        try activate(try XCTUnwrap(accessible(label: "2 requests approved", in: controller.rowView(receiptID))))
        try await wait("actual receipt expansion") { self.accessibilityHint(label: "2 requests approved", in: controller.rowView(receiptID))?.contains("hide") == true }
        let groupHost = controller.hostIdentity(receiptID)
        session.apply(fixture(revision: 78, plainID: "durable-experiment", token: "same", change: .values))
        try require(controller.hostIdentity(receiptID) == groupHost, "Same full membership retains group host")
        session.apply(fixture(revision: 79, plainID: "durable-experiment", token: "same", receiptCount: 3, change: .membership))
        let newGroupID = session.snapshot.rows[2].id
        try await wait("new full membership identity") { !controller.applyingSnapshot && controller.hostIdentity(newGroupID) != nil }
        try require(controller.hostIdentity(receiptID) == nil && controller.hostIdentity(newGroupID) != groupHost,
                    "Membership change cannot carry old state by first member ID")
        try scrollRowToBottom(newGroupID, controller: controller)
        try await wait("new collapsed group") { self.accessibilityHint(label: "3 requests approved", in: controller.rowView(newGroupID))?.contains("show") == true }
        // Delayed TRUE delivery on the same durable host must remain once-only
        proofStage = "native-visibility-and-origin-completion-lease"
        // when an unrelated probe/action revision changes during the await.
        session.coveringPresentation = true
        var heldAcknowledgement: CheckedContinuation<Bool, Never>?
        defer { heldAcknowledgement?.resume(returning: false) }
        var durableAcknowledgements = 0
        session.acknowledge = { id in
            guard id == "durable-experiment" else { return true }
            durableAcknowledgements += 1
            return await withCheckedContinuation { heldAcknowledgement = $0 }
        }
        session.apply(fixture(revision: 80, plainID: "durable-experiment", token: "short durable result", receiptCount: 3,
                              shortPlain: true, change: .values))
        try await wait("short durable layout") { controller.renderedRevision == 80 && !controller.applyingSnapshot }
        controller.collection.setContentOffset(.zero, animated: false)
        controller.collection.layoutIfNeeded(); session.refreshVisibility()
        try require(durableAcknowledgements == 0, "Covering presentation suppresses admission")
        session.coveringPresentation = false
        try await wait("actual visible durable acknowledgement") { heldAcknowledgement != nil }
        _ = try XCTUnwrap(session.beginLease(itemID: "durable-experiment"))
        session.apply(fixture(revision: 81, plainID: "durable-experiment", token: "short durable result", actionRevision: 1,
                              receiptCount: 3, shortPlain: true, change: .values))
        heldAcknowledgement?.resume(returning: true); heldAcknowledgement = nil
        try await wait("successful original same-host acknowledgement completion") { controller.deliveryAcknowledged("durable-experiment") }
        session.refreshVisibility(); session.refreshVisibility()
        try require(durableAcknowledgements == 1, "Unrelated revision/probe cannot duplicate a successful same-host acknowledgement")

        proofStage = "queued-scope-pre-invocation-delivery-fence"
        session.coveringPresentation = true
        var heldBatchCompletion: (() -> Void)?
        defer { controller.batchCompletionGate = nil; heldBatchCompletion?() }
        controller.batchCompletionGate = { completion in heldBatchCompletion = completion }
        let oldPendingID = "durable-pending-batch"
        var oldScopeCallbackInvocations = 0
        session.acknowledge = { id in
            if id == oldPendingID { oldScopeCallbackInvocations += 1 }
            return true
        }
        session.apply(fixture(revision: 82, plainID: oldPendingID, token: "short old-scope result",
                              receiptCount: 3, shortPlain: true, change: .membership))
        try await wait("actual UIKit identity batch completion held") { heldBatchCompletion != nil }
        try require(controller.applyingSnapshot && controller.renderedRevision == 82,
                    "Actual old-scope batch remains applying until its real completion is released")
        controller.collection.setContentOffset(.zero, animated: false)
        controller.collection.layoutIfNeeded(); session.refreshVisibility()
        let oldCell = try XCTUnwrap(controller.collection.cellForItem(at: IndexPath(item: 0, section: 0)))
        let oldVisibleFraction = NativeTranscriptExperimentSession.visibleFraction(
            row: oldCell.convert(oldCell.bounds, to: window),
            viewport: controller.collection.convert(controller.collection.bounds, to: window), window: window.bounds,
            occlusions: [composerMarker.convert(composerMarker.bounds, to: window)])
        try require(oldVisibleFraction >= 0.5, "Old durable row really qualifies before the scope switch")
        let rejectedBeforeSwitch = session.events.filter { $0 == "stale-ack-admission-rejected" }.count
        // This synchronous admission queues a Task; switch scope in the same
        // MainActor turn before that Task can invoke the old callback.
        session.coveringPresentation = false
        session.apply(fixture(revision: 1, plainID: "durable-experiment", token: "queued new-scope result",
            scope: .init(ownerID: "queued-owner", serverIdentity: "https://viewport.invalid", connectionEpoch: 2,
                         conversationID: "queued-conversation"), receiptCount: 3, shortPlain: true, change: .initial))
        try require(session.geometry == nil, "Scope switch invalidates old geometry synchronously before UIKit completion")
        session.refreshVisibility(); controller.recomputeVisibility()
        try require(session.geometry == nil && controller.applyingSnapshot && controller.renderedRevision == 82,
                    "Queued scope cannot recapture/admit the still-live old controller scope")
        try await wait("old queued Task rejects before invoking delivery callback") {
            session.events.filter { $0 == "stale-ack-admission-rejected" }.count > rejectedBeforeSwitch
        }
        try require(oldScopeCallbackInvocations == 0,
                    "Old acknowledgement closure invocation count is ZERO, not merely a discarded result")
        session.coveringPresentation = true
        controller.batchCompletionGate = nil
        let releaseBatch = try XCTUnwrap(heldBatchCompletion); heldBatchCompletion = nil
        releaseBatch()
        try await wait("queued new scope applies after real old batch completion") {
            !controller.applyingSnapshot && controller.renderedRevision == 1
                && controller.hostIdentity(oldPendingID) == nil
        }
        try require(oldScopeCallbackInvocations == 0, "Releasing the old batch cannot dispatch its retired delivery")
        let beforeScopeSwitch = controller.hostIdentity("durable-experiment")
        window.isHidden = true
        session.apply(fixture(revision: 1, plainID: "durable-experiment", token: "different owner result",
            scope: .init(ownerID: "different-owner", serverIdentity: "https://viewport.invalid", connectionEpoch: 2,
                         conversationID: "other-conversation"), receiptCount: 3, shortPlain: true, change: .initial))
        session.refreshVisibility()
        try require(session.geometry == nil, "Detached/hidden native geometry is invalid, not cached visibility")
        try require(durableAcknowledgements == 1, "A hidden new scope cannot admit using stale window evidence")
        try require(controller.hostIdentity("durable-experiment") != beforeScopeSwitch && controller.followsLatest,
                    "Scope change gets fresh host and follow namespace")
        let trace = XCTAttachment(string: session.events.joined(separator: "\n"))
        trace.name = "actual-host-containment-appearance-task-trace"; trace.lifetime = .keepAlways; add(trace)
    }

    @MainActor
    func testExactTopFractionFallbackAndFullAreaOcclusionUnion() throws {
        let frames = ["a": CGRect(x: 0, y: 10, width: 100, height: 20), "b": CGRect(x: 0, y: 900, width: 100, height: 20)]
        let anchor = NativeTranscriptExperimentSession.anchor(oldIDs: ["a", "removed", "b"], newIDs: ["a", "b"],
            selected: "removed", frames: frames, offset: 500, height: 100)
        try require(anchor.itemID == "a" && anchor.fraction == -4.9, "Fallback uses predecessor's own unclamped TOP fraction")
        let successor = NativeTranscriptExperimentSession.anchor(oldIDs: ["removed", "b"], newIDs: ["b"],
            selected: "removed", frames: frames, offset: 500, height: 100)
        try require(successor.itemID == "b" && successor.fraction == 4, "Successor fraction is allowed above one")
        let missing = NativeTranscriptExperimentSession.anchor(oldIDs: ["removed", "b"], newIDs: ["b"],
            selected: "removed", frames: [:], offset: 123, height: 100)
        try require(missing.itemID == nil && missing.fraction == nil && missing.preOffset == 123, "Missing attributes preserve absolute position")
        let fraction = NativeTranscriptExperimentSession.visibleFraction(row: CGRect(x: 0, y: 0, width: 100, height: 100),
            viewport: CGRect(x: 0, y: 0, width: 100, height: 100), window: CGRect(x: 0, y: 0, width: 100, height: 100),
            occlusions: [CGRect(x: 0, y: 0, width: 100, height: 30), CGRect(x: 0, y: 20, width: 100, height: 30)])
        try require(abs(fraction - 0.5) <= 1e-9, "Occlusions subtract union, not overlapping area twice")
        let tall = NativeTranscriptExperimentSession.visibleFraction(row: CGRect(x: 0, y: 0, width: 100, height: 300),
            viewport: CGRect(x: 0, y: 0, width: 100, height: 100), window: CGRect(x: 0, y: 0, width: 100, height: 100), occlusions: [])
        try require(tall < 0.5, "Full-row denominator intentionally leaves very tall rows unacknowledged")
    }

    @MainActor private func scrollRowToBottom(_ id: String, controller: NativeTranscriptExperimentController) throws {
        let frame = try XCTUnwrap(controller.rowFrame(id))
        controller.collection.setContentOffset(CGPoint(x: 0, y: min(max(0, frame.maxY - controller.collection.bounds.height),
            max(0, controller.collection.contentSize.height - controller.collection.bounds.height))), animated: false)
        controller.collection.layoutIfNeeded(); controller.captureGeometry()
    }
    @MainActor private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
    @MainActor private func accessible(label: String, in root: UIView?) -> NSObject? {
        guard let root, root.window != nil else { return nil }
        if root.isAccessibilityElement, root.accessibilityLabel == label { return root }
        let elements = root.accessibilityElements as? [NSObject]
            ?? (0..<max(0, root.accessibilityElementCount())).compactMap { root.accessibilityElement(at: $0) as? NSObject }
        for element in elements {
            if element.accessibilityLabel == label { return element }
            if let view = element as? UIView, let found = accessible(label: label, in: view) { return found }
        }
        return root.subviews.lazy.compactMap { self.accessible(label: label, in: $0) }.first
    }
    @MainActor private func activate(_ element: NSObject) throws {
        try require(element.accessibilityActivate(), "Actual control did not support native accessibility activation; STOP")
    }
    @MainActor private func accessibilityValue(label: String, in root: UIView?) -> String? { accessible(label: label, in: root)?.accessibilityValue }
    @MainActor private func accessibilityHint(label: String, in root: UIView?) -> String? { accessible(label: label, in: root)?.accessibilityHint }
    @MainActor private func attachGeometry(_ value: NativeTranscriptExperimentSession.Geometry, name: String) throws {
        func rect(_ r: CGRect) -> [String: CGFloat] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
        let data = try JSONSerialization.data(withJSONObject: [
            "bounds": rect(value.bounds), "frame": rect(value.frame), "window": rect(value.windowBounds),
            "stationary": rect(value.stationaryInWindow), "viewport": rect(value.viewportInWindow),
            "composer": rect(value.composerInWindow), "rows": value.rowFramesInWindow.mapValues(rect),
            "offsetY": value.offset.y, "contentHeight": value.contentSize.height,
            "header": value.header, "footer": value.footer, "reveal": value.reveal,
            "nativeInsets": [value.contentInset.top, value.contentInset.left, value.contentInset.bottom, value.contentInset.right],
            "adjustedInsets": [value.adjustedInset.top, value.adjustedInset.left, value.adjustedInset.bottom, value.adjustedInset.right],
            "windowSafeArea": [value.windowSafeArea.top, value.windowSafeArea.left, value.windowSafeArea.bottom, value.windowSafeArea.right],
        ], options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    @MainActor private func attachDiagnostics(_ session: NativeTranscriptExperimentSession, stage: String) throws {
        func number(_ value: CGFloat) -> Any { NativeExperimentDiagnostic.number(value) }
        func rect(_ value: CGRect?) -> Any {
            guard let r = value else { return NSNull() }
            return ["x": number(r.minX), "y": number(r.minY), "width": number(r.width), "height": number(r.height)]
        }
        let restorations: [[String: Any]] = session.restorations.map { value in
            ["selectedItem": value.anchor.itemID as Any? ?? NSNull(), "preFrame": rect(value.anchor.preFrame),
             "preOffset": number(value.anchor.preOffset), "preViewportHeight": number(value.anchor.preHeight),
             "unclampedTopFraction": value.anchor.fraction.map(number) ?? NSNull(), "newFrame": rect(value.newFrame),
             "newViewportHeight": number(value.viewportHeight), "newContentHeight": number(value.contentHeight),
             "requestedOffset": number(value.requested), "clampedOffset": number(value.clamped), "actualOffset": number(value.actual),
             "clampDelta": number(value.clampDelta), "clampReason": value.clampReason, "selectionReason": value.reason,
             "gesturePolicySuppressed": value.suppressedByGesture]
        }
        let data = try JSONSerialization.data(withJSONObject: diagnosticJSON([
            "stage": stage, "events": session.events, "restorations": restorations,
            "readinessDiagnostics": session.readinessDiagnosticSnapshot(),
            "proofLimits": "Authored tests only until executed. Phase injection is not a physical gesture. Revision73/74 is VALUE delivery, not generic Transaction equivalence.",
        ]), options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "native-experiment-stage-anchor-lifecycle-receipt"; attachment.lifetime = .keepAlways; add(attachment)
    }
    @MainActor private func diagnosticJSON(_ value: Any) -> Any {
        if let scalar = value as? NativeExperimentDiagnostic.Scalar {
            if scalar.value.isFinite { return scalar.value }
            let bits = String(scalar.value.bitPattern, radix: 16)
            return ["nonfinite": scalar.value.isNaN ? "NaN" : scalar.value.sign == .minus ? "-Infinity" : "+Infinity",
                    "ieee754Bits": "0x" + String(repeating: "0", count: 16 - bits.count) + bits]
        }
        if let object = value as? [String: Any] { return object.mapValues { self.diagnosticJSON($0) } }
        if let array = value as? [Any] { return array.map { self.diagnosticJSON($0) } }
        return value
    }
}

/// Wait on actual display turns without spinning MainActor or replaying layout
/// state on a timer. XCTest's unchanged bounded timeout remains the stop gate.
@MainActor
private final class NativeViewportFrameObserver: NSObject {
    private let predicate: @MainActor () -> Bool
    private let ready: () -> Void
    private var link: CADisplayLink?
    init(predicate: @escaping @MainActor () -> Bool, ready: @escaping () -> Void) {
        self.predicate = predicate; self.ready = ready
    }
    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        self.link = link; link.add(to: .main, forMode: .common)
    }
    func stop() { link?.invalidate(); link = nil }
    @objc private func tick() {
        guard predicate() else { return }
        stop(); ready()
    }
}

private final class NativeViewportNoNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Unexpected network request in native viewport geometry fixture: \(request.url?.path ?? "unknown")")
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}
#endif
