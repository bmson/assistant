import XCTest
import SwiftUI
import QuartzCore
@testable import Assistant

/// Stubbed page renders support visual review. They do not establish control
/// activation, VoiceOver behavior or physical gesture correctness.
final class NativeVisualReviewTests: XCTestCase {
    private final class RecoveryActionCounts {
        var retry = 0
        var activity = 0
    }

    // Test-only, external storage: observing the bubble environment must not
    // publish SwiftUI state or change the production view's layout.
    @MainActor
    private final class ConversationViewportRecorder {
        struct Measurement: Equatable {
            let rawRootWidth: CGFloat
            let outerAvailableWidth: CGFloat
            let leadingSafeArea: CGFloat
            let trailingSafeArea: CGFloat
            let inheritedWidth: CGFloat?
            let accessibility: Bool
        }

        let expectedMessageIDs: Set<String>
        private(set) var measurements: [String: Measurement] = [:]

        init(messageIDs: Set<String>) { expectedMessageIDs = messageIDs }
        func reset() { measurements.removeAll() }
        func record(_ measurement: Measurement, messageID: String) {
            measurements[messageID] = measurement
        }
    }

    @MainActor
    private struct ConversationViewportReader: View {
        @Environment(\.conversationViewportWidth) private var inheritedWidth
        @Environment(\.dynamicTypeSize) private var dynamicTypeSize
        let recorder: ConversationViewportRecorder
        let messageID: String
        let rawRootWidth: CGFloat
        let outerAvailableWidth: CGFloat
        let leadingSafeArea: CGFloat
        let trailingSafeArea: CGFloat

        private var measurement: ConversationViewportRecorder.Measurement {
            .init(rawRootWidth: rawRootWidth, outerAvailableWidth: outerAvailableWidth,
                  leadingSafeArea: leadingSafeArea,
                  trailingSafeArea: trailingSafeArea, inheritedWidth: inheritedWidth,
                  accessibility: dynamicTypeSize.isAccessibilitySize)
        }

        var body: some View {
            Color.clear
                .onAppear { recorder.record(measurement, messageID: messageID) }
                .onChange(of: measurement) { _, value in recorder.record(value, messageID: messageID) }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    @MainActor
    private final class DocumentLayoutFrameRecorder {
        private(set) var frames: [String: CGRect] = [:]

        func record(_ name: String, _ frame: CGRect) {
            frames[name] = frame
        }

        func reset() {
            frames.removeAll()
        }
    }

    @MainActor
    private final class ConnectedToolActionLayoutRecorder {
        var frames: [String: CGRect] = [:]
        var confirmationLabels: [String] = []

        func record(_ values: [String: CGRect]) {
            frames.merge(values, uniquingKeysWith: { _, latest in latest })
        }
    }

    @MainActor
    private final class ComposerPresentationSampler: NSObject {
        struct Sample {
            let timestamp: CFTimeInterval
            let draftIsEmpty: Bool
            let draftRevision: Int
            let targetBounds: [ComposerPresentationTarget: CGRect]
            let presentationFrames: [ComposerPresentationTarget: CGRect]
            let missingPresentation: [ComposerPresentationTarget]
            let presentationLayerHasWindowAncestor: [ComposerPresentationTarget: Bool]
            let windowPresentationAvailable: Bool
        }

        private weak var window: UIWindow?
        private let probe: ComposerPresentationProbe
        private var displayLink: CADisplayLink?
        private(set) var samples: [Sample] = []

        init(window: UIWindow, probe: ComposerPresentationProbe) {
            self.window = window
            self.probe = probe
        }

        func start() {
            guard displayLink == nil else { return }
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }

        func stop() {
            displayLink?.invalidate()
            displayLink = nil
        }

        @objc private func tick(_ link: CADisplayLink) {
            guard let window, window.windowScene != nil else {
                samples.append(Sample(
                    timestamp: CACurrentMediaTime(), draftIsEmpty: false, draftRevision: -1,
                    targetBounds: [:], presentationFrames: [:],
                    missingPresentation: ComposerPresentationTarget.allCases,
                    presentationLayerHasWindowAncestor: [:],
                    windowPresentationAvailable: false
                ))
                return
            }
            guard let windowPresentation = window.layer.presentation() else {
                samples.append(Sample(
                    timestamp: CACurrentMediaTime(), draftIsEmpty: false, draftRevision: -1,
                    targetBounds: [:], presentationFrames: [:],
                    missingPresentation: ComposerPresentationTarget.allCases,
                    presentationLayerHasWindowAncestor: [:],
                    windowPresentationAvailable: false
                ))
                return
            }
            var bounds: [ComposerPresentationTarget: CGRect] = [:]
            var frames: [ComposerPresentationTarget: CGRect] = [:]
            var missing: [ComposerPresentationTarget] = []
            var layerAncestry: [ComposerPresentationTarget: Bool] = [:]
            var empty = true
            var revision = 0
            for target in ComposerPresentationTarget.allCases {
                guard let marker = probe.marker(target), marker.view.window === window,
                      marker.view.isDescendant(of: window),
                      let presentation = marker.view.layer.presentation() else {
                    missing.append(target)
                    continue
                }
                var layerAncestor: CALayer? = presentation
                var hasWindowAncestor = false
                while let layer = layerAncestor {
                    if layer === windowPresentation {
                        hasWindowAncestor = true
                        break
                    }
                    layerAncestor = layer.superlayer
                }
                layerAncestry[target] = hasWindowAncestor
                guard hasWindowAncestor else {
                    missing.append(target)
                    continue
                }
                empty = empty && marker.draftIsEmpty
                revision = max(revision, marker.draftRevision)
                bounds[target] = marker.view.bounds
                frames[target] = presentation.convert(presentation.bounds, to: windowPresentation)
            }
            samples.append(Sample(
                timestamp: CACurrentMediaTime(), draftIsEmpty: empty,
                draftRevision: revision, targetBounds: bounds,
                presentationFrames: frames, missingPresentation: missing,
                presentationLayerHasWindowAncestor: layerAncestry,
                windowPresentationAvailable: true
            ))
        }

        func wait(until predicate: () -> Bool, timeout: TimeInterval) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(timeout))
            while !predicate(), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(16))
            }
        }

        func stableTail(after timestamp: CFTimeInterval, emptyRevision: Int? = nil) -> [Sample]? {
            let tail = Array(samples.suffix(4))
            guard tail.count == 4,
                  tail.allSatisfy({
                $0.timestamp >= timestamp && $0.missingPresentation.isEmpty
                    && (emptyRevision == nil || ($0.draftIsEmpty && $0.draftRevision >= emptyRevision!))
                  }) else { return nil }
            guard tail.allSatisfy({ framesAreStable(tail[0].presentationFrames, $0.presentationFrames) }) else {
                return nil
            }
            return tail
        }

        func maximumMotion(from baseline: Sample, after timestamp: CFTimeInterval) -> CGFloat {
            samples.filter { $0.timestamp >= timestamp }.reduce(CGFloat.zero) { current, sample in
                let displacement = ComposerPresentationTarget.allCases.compactMap { target -> CGFloat? in
                    guard let before = baseline.presentationFrames[target],
                          let after = sample.presentationFrames[target] else { return nil }
                    return max(
                        max(abs(before.minX - after.minX), abs(before.minY - after.minY)),
                        max(abs(before.width - after.width), abs(before.height - after.height))
                    )
                }.max() ?? 0
                return max(current, displacement)
            }
        }

        func jsonSamples() -> [[String: Any]] {
            samples.map { sample in
                let targetBounds = Dictionary(uniqueKeysWithValues: sample.targetBounds.map {
                    ($0.key.rawValue, Self.rectJSON($0.value))
                })
                let frames = Dictionary(uniqueKeysWithValues: sample.presentationFrames.map {
                    ($0.key.rawValue, Self.rectJSON($0.value))
                })
                let ancestry = Dictionary(uniqueKeysWithValues: sample.presentationLayerHasWindowAncestor.map {
                    ($0.key.rawValue, $0.value)
                })
                return [
                    "time": sample.timestamp,
                    "draftIsEmpty": sample.draftIsEmpty,
                    "draftRevision": sample.draftRevision,
                    "targetBounds": targetBounds,
                    "presentationFrames": frames,
                    "missingPresentation": sample.missingPresentation.map(\.rawValue),
                    "presentationLayerHasWindowAncestor": ancestry,
                    "windowPresentationAvailable": sample.windowPresentationAvailable
                ]
            }
        }

        private func framesAreStable(
            _ lhs: [ComposerPresentationTarget: CGRect],
            _ rhs: [ComposerPresentationTarget: CGRect]
        ) -> Bool {
            ComposerPresentationTarget.allCases.allSatisfy { target in
                guard let a = lhs[target], let b = rhs[target] else { return false }
                return max(
                    max(abs(a.minX - b.minX), abs(a.minY - b.minY)),
                    max(abs(a.width - b.width), abs(a.height - b.height))
                ) <= 1
            }
        }

        fileprivate static func rectJSON(_ rect: CGRect) -> [String: Any] {
            func number(_ value: CGFloat) -> Any { value.isFinite ? value as Any : NSNull() }
            return ["x": number(rect.minX), "y": number(rect.minY),
                    "width": number(rect.width), "height": number(rect.height),
                    "isNull": rect.isNull, "isInfinite": rect.isInfinite]
        }
    }

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
    func testFullHeightChatWithRecoveryAndJump() async throws {
        // Keep the shared review inventory compact. This case alone needs a
        // transcript tall enough to exercise real older-message scrolling.
        let fixture = try NativeReviewFixture(transcriptMessageCount: 30)
        NativeReviewProtocol.install(fixture.responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: configuration))
        let suite = "assistant.full-height-review.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("https://native-review.test", forKey: "assistant.server-url")
        defaults.set(true, forKey: "assistant.push-prompted")
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(apiClient: client, defaults: defaults, storeConnectionToken: { _ in })
        var draftSavePhase = "model-setup"
#if DEBUG
        var draftSaveSequence = 0
        var draftSaveOmittedCount = 0
        var draftSaveHistory: [[String: Any]] = []
        model.composerDraftSaveObserver = { observation in
            draftSaveSequence += 1
            draftSaveHistory.append([
                "sequence": draftSaveSequence,
                "phase": draftSavePhase,
                "sourceFile": observation.sourceFile,
                "sourceFunction": observation.sourceFunction,
                "sourceLine": observation.sourceLine,
                "accepted": observation.accepted,
                "scopeMatchesCurrent": observation.scopeMatchesCurrent,
                "sessionMatchesCurrent": observation.sessionMatchesCurrent,
                "requestedLength": observation.requestedLength,
                "requestedEmpty": observation.requestedEmpty,
                "beforeLength": observation.beforeLength,
                "beforeEmpty": observation.beforeEmpty,
                "afterLength": observation.afterLength,
                "afterEmpty": observation.afterEmpty,
                "beforeRecovery": observation.beforeRecovery,
                "afterRecovery": observation.afterRecovery,
            ])
            if draftSaveHistory.count > 64 {
                draftSaveHistory.removeFirst()
                draftSaveOmittedCount += 1
            }
        }
        defer { model.composerDraftSaveObserver = nil }
#endif
        func draftSaveReceiptFields() -> [String: Any] {
#if DEBUG
            return [
                "draftSaveObserverInstalled": model.composerDraftSaveObserver != nil,
                "draftSaveObservationCount": draftSaveSequence,
                "draftSaveOmittedCount": draftSaveOmittedCount,
                "draftSaveHistory": draftSaveHistory,
            ]
#else
            return ["draftSaveObserverInstalled": false, "draftSaveHistory": []]
#endif
        }
        model.scenePhaseDidChange(.background)
        await model.refreshAll(reportFailure: false)
        _ = await model.refreshWorkspace(reportFailure: false)
        await model.loadPeople()
        XCTAssertNotNil(model.bootstrap)
        let scope = try XCTUnwrap(model.composerDraftScope)
        // The fixture rejects every POST locally with405: exercise real draft
        // recovery without admitting any task or reaching an external service.
        let recoveryText = "Unsent arrival note."
        draftSavePhase = "initial-send"
        model.send(recoveryText)
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.isSending, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertFalse(model.isSending)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        model.errorMessage = nil
        draftSavePhase = "preexisting-draft-seed"
        model.saveComposerDraft("A different draft is already in the input.", in: scope)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        defer { previousKeyWindow?.makeKey() }
        let variants: [(String, ColorScheme, DynamicTypeSize, Bool)] = [
            ("light-large", .light, .large, false),
            ("dark-large", .dark, .large, false),
            ("light-accessibility3", .light, .accessibility3, false),
            ("dark-accessibility3", .dark, .accessibility3, false),
            ("contrast-accessibility3", .light, .accessibility3, true)
        ]
        let presentationProbe = ComposerPresentationProbe()
        var blockerCaptureWindow: UIWindow?
        var blockerComposerTextView: UITextView?
        for (variant, scheme, size, increasedContrast) in variants {
            draftSavePhase = "original-host-mount-\(variant)"
            let window = UIWindow(windowScene: scene)
            window.frame = scene.coordinateSpace.bounds
            let host = UIHostingController(rootView:
                RootView().environment(model).environment(\.dynamicTypeSize, size)
                    .environment(\.colorScheme, scheme).environment(\.scenePhase, .inactive)
                    .environment(\.composerPresentationProbe, increasedContrast ? presentationProbe : nil))
            window.rootViewController = host
            if increasedContrast {
                host.traitOverrides.accessibilityContrast = .high
            }
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            window.makeKeyAndVisible()
            defer {
                draftSavePhase = "original-host-teardown-\(variant)"
                window.isHidden = true
                window.rootViewController = nil
            }
            try await Task.sleep(for: .milliseconds(600))
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            window.layoutIfNeeded()
            func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
            let transcript = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }
                .filter { !($0 is UITextView) }.max { $0.bounds.height < $1.bounds.height })
            let viewport = transcript.frame
            let top = -transcript.adjustedContentInset.top
            var bottom = max(top, transcript.contentSize.height - transcript.bounds.height
                + transcript.adjustedContentInset.bottom)
            for _ in 0..<4 where abs(transcript.contentOffset.y - bottom) > 1 {
                transcript.setContentOffset(CGPoint(x: transcript.contentOffset.x, y: bottom), animated: false)
                try await Task.sleep(for: .milliseconds(100))
                window.layoutIfNeeded()
                bottom = max(top, transcript.contentSize.height - transcript.bounds.height
                    + transcript.adjustedContentInset.bottom)
            }
            let newestOffset = transcript.contentOffset.y
            func attach(_ state: String) {
                var rendered = false
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let imageAttachment = XCTAttachment(image: image)
                imageAttachment.name = "full-height-\(variant)-\(state)"
                imageAttachment.lifetime = .keepAlways
                add(imageAttachment)
                let stateData = try? JSONSerialization.data(withJSONObject: [
                    "variant": variant, "state": state, "rendered": rendered, "messages": model.messages.count,
                    "viewport": ["x": transcript.frame.minX, "y": transcript.frame.minY,
                                  "width": transcript.frame.width, "height": transcript.frame.height],
                    "contentSize": ["width": transcript.contentSize.width, "height": transcript.contentSize.height],
                    "contentInset": ["top": transcript.contentInset.top, "bottom": transcript.contentInset.bottom],
                    "adjustedContentInset": ["top": transcript.adjustedContentInset.top, "bottom": transcript.adjustedContentInset.bottom],
                    "offset": transcript.contentOffset.y, "topOffset": top, "newestOffset": newestOffset,
                    "bottomOffset": bottom,
                    "hasRecovery": model.hasComposerRecovery(in: scope),
                    "composerDraft": model.composerDraft(in: scope),
                    "draftSaveEvidence": draftSaveReceiptFields(),
                    "controlActivationEvidence": "Send, recovery, Jump and VoiceOver activation were not exercised.",
                    "voiceOverEvidence": "Not tested by this fixture."
                ], options: [.prettyPrinted, .sortedKeys])
                let jsonAttachment = XCTAttachment(data: stateData ?? Data("{}".utf8), uniformTypeIdentifier: "public.json")
                jsonAttachment.name = "full-height-\(variant)-\(state)-state"
                jsonAttachment.lifetime = .keepAlways
                add(jsonAttachment)
                XCTAssertTrue(rendered, "UIKit did not render full-height capture \(variant)/\(state)")
            }
            func attachPresentationReceipt(_ value: [String: Any], name: String) {
                var receipt = value
                receipt["draftSaveEvidence"] = draftSaveReceiptFields()
                let data: Data
                do {
                    data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
                } catch {
                    let fallback = Data("Presentation receipt serialization failed: \(error)\n\(String(describing: receipt))".utf8)
                    let failedAttachment = XCTAttachment(data: fallback, uniformTypeIdentifier: "public.plain-text")
                    failedAttachment.name = "full-height-\(variant)-\(name)-serialization-error"
                    failedAttachment.lifetime = .keepAlways
                    add(failedAttachment)
                    XCTFail("Could not serialize presentation receipt \(name): \(error)")
                    return
                }
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                attachment.name = "full-height-\(variant)-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            func contains(_ outer: CGRect, _ inner: CGRect, tolerance: CGFloat = 1) -> Bool {
                outer.insetBy(dx: -tolerance, dy: -tolerance).contains(inner)
            }
            func roundedContains(_ outer: CGRect, _ inner: CGRect, radius: CGFloat, tolerance: CGFloat = 1) -> Bool {
                guard contains(outer, inner, tolerance: tolerance) else { return false }
                let r = min(radius, min(outer.width, outer.height) / 2)
                let corners = [
                    CGPoint(x: inner.minX, y: inner.minY), CGPoint(x: inner.maxX, y: inner.minY),
                    CGPoint(x: inner.minX, y: inner.maxY), CGPoint(x: inner.maxX, y: inner.maxY)
                ]
                return corners.allSatisfy { point in
                    var center: CGPoint?
                    if point.x < outer.minX + r && point.y < outer.minY + r {
                        center = CGPoint(x: outer.minX + r, y: outer.minY + r)
                    } else if point.x > outer.maxX - r && point.y < outer.minY + r {
                        center = CGPoint(x: outer.maxX - r, y: outer.minY + r)
                    } else if point.x < outer.minX + r && point.y > outer.maxY - r {
                        center = CGPoint(x: outer.minX + r, y: outer.maxY - r)
                    } else if point.x > outer.maxX - r && point.y > outer.maxY - r {
                        center = CGPoint(x: outer.maxX - r, y: outer.maxY - r)
                    }
                    guard let center else { return true }
                    return hypot(point.x - center.x, point.y - center.y) <= r + tolerance
                }
            }
            func finite(_ rect: CGRect?) -> Bool {
                guard let rect else { return false }
                return !rect.isNull && !rect.isInfinite && !rect.isEmpty
                    && rect.minX.isFinite && rect.minY.isFinite
                    && rect.width.isFinite && rect.height.isFinite
                    && rect.maxX.isFinite && rect.maxY.isFinite
            }

            // Attach the initial/newest state and its geometry before assertions
            // so a failing simulator run remains reviewable.
            attach("newest-recovery")
            XCTAssertLessThanOrEqual(abs(newestOffset - bottom), 1,
                "The newest-state capture must begin at the actual transcript bottom")
            XCTAssertEqual(transcript.frame.height, viewport.height, accuracy: 1)
            XCTAssertGreaterThan(bottom - top, viewport.height * 2,
                "The dedicated fixture must contain enough distinct rows to scroll")
            XCTAssertTrue(model.hasComposerRecovery(in: scope))

            transcript.setContentOffset(CGPoint(x: transcript.contentOffset.x, y: top), animated: false)
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            let olderOffset = transcript.contentOffset.y
            attach("older-transcript")
            XCTAssertEqual(transcript.frame.height, viewport.height, accuracy: 1,
                "Floating recovery and Jump controls must not reserve a transcript viewport lane")
            XCTAssertLessThan(olderOffset, newestOffset - 2,
                "The older capture must be a real scroll position away from newest")

            if variant == "contrast-accessibility3" {
                let composer = descendants(window).compactMap { $0 as? UITextView }
                    .filter { $0.accessibilityIdentifier == "assistant.chat.composer" }
                    .first
                let composerTextView = try XCTUnwrap(composer)
                let typedDraft = "Native editor updated this conversation draft."
                draftSavePhase = "original-host-native-input-typed"
                composerTextView.text = typedDraft
                let composerDelegate = try XCTUnwrap(composerTextView.delegate)
                composerDelegate.textViewDidChange?(composerTextView)
                let typedDeadline = ContinuousClock.now.advanced(by: .seconds(2))
                while model.composerDraft(in: scope) != typedDraft && ContinuousClock.now < typedDeadline {
                    try await Task.sleep(for: .milliseconds(40))
                }
                XCTAssertEqual(model.composerDraft(in: scope), typedDraft,
                    "The UIKit composer delegate must write through to this paired conversation scope")
                let sampler = ComposerPresentationSampler(window: window, probe: presentationProbe)
                sampler.start()
                defer { sampler.stop() }
                func stableBaselineTail() -> [ComposerPresentationSampler.Sample]? {
                    guard let first = sampler.samples.first,
                          let tail = sampler.stableTail(after: first.timestamp),
                          tail.allSatisfy({ !$0.draftIsEmpty }) else { return nil }
                    return tail
                }
                func baselineIsStable() -> Bool { stableBaselineTail() != nil }
                try await sampler.wait(until: baselineIsStable, timeout: 2)
                let baselineSamples = sampler.samples
                let baselineTail = stableBaselineTail()
                let baseline = baselineTail?.last
                let baselineRevision = baseline?.draftRevision ?? -1
                let markerDrafts = ComposerPresentationTarget.allCases.compactMap { presentationProbe.marker($0) }
                let baselineReceipt: [String: Any] = [
                    "phase": "typed-nonempty-stable-baseline",
                    "stable": baselineIsStable(),
                    "markerCount": markerDrafts.count,
                    "markersDraftNonempty": markerDrafts.allSatisfy { !$0.draftIsEmpty },
                    "markerDraftRevisions": markerDrafts.map(\.draftRevision),
                    "draftRevision": baseline?.draftRevision ?? -1,
                    "sampleCount": baselineSamples.count,
                    "samples": sampler.jsonSamples()
                ]
                attachPresentationReceipt(baselineReceipt, name: "composer-presentation-baseline")
                XCTAssertEqual(markerDrafts.count, ComposerPresentationTarget.allCases.count,
                    "The opt-in probe must register the actual capsule and both button targets")
                XCTAssertTrue(markerDrafts.allSatisfy { !$0.draftIsEmpty && $0.draftRevision == baselineRevision },
                    "Every target must report the same typed-draft revision")
                XCTAssertTrue(baselineIsStable(), "Typed geometry must be stable before clearing text")
                let baselineSample = try XCTUnwrap(baseline)
                let baselineCapsule = baselineSample.presentationFrames[.capsule]
                let baselineMic = baselineSample.presentationFrames[.microphone]
                let baselineSend = baselineSample.presentationFrames[.send]
                let baselineTargetBounds = baselineSample.targetBounds
                let baselineLayoutTargetsValid = [ComposerPresentationTarget.microphone, .send].allSatisfy {
                    guard let rect = baselineTargetBounds[$0] else { return false }
                    return rect.width >= 44 && rect.height >= 44
                }
                let baselinePresentationValid = finite(baselineCapsule) && finite(baselineMic) && finite(baselineSend)
                    && finite(window.bounds)
                    && roundedContains(baselineCapsule ?? .zero, baselineMic ?? .infinite,
                                       radius: AssistantTheme.conversationCornerRadius)
                    && roundedContains(baselineCapsule ?? .zero, baselineSend ?? .infinite,
                                       radius: AssistantTheme.conversationCornerRadius)
                    && contains(window.bounds, baselineCapsule ?? .infinite)
                    && contains(window.bounds, baselineMic ?? .infinite)
                    && contains(window.bounds, baselineSend ?? .infinite)
                    && baselineSample.presentationLayerHasWindowAncestor.count == ComposerPresentationTarget.allCases.count
                    && baselineSample.presentationLayerHasWindowAncestor.values.allSatisfy { $0 }
                    && baselineSample.windowPresentationAvailable
                let baselineTargetBoundsJSON = Dictionary(uniqueKeysWithValues: baselineTargetBounds.map {
                    ($0.key.rawValue, ComposerPresentationSampler.rectJSON($0.value))
                })
                let baselineFramesJSON = Dictionary(uniqueKeysWithValues: baselineSample.presentationFrames.map {
                    ($0.key.rawValue, ComposerPresentationSampler.rectJSON($0.value))
                })
                attachPresentationReceipt([
                    "phase": "typed-nonempty-stable-baseline-geometry",
                    "presentationGeometryValid": baselinePresentationValid,
                    "layoutTargetBoundsAtLeast44Points": baselineLayoutTargetsValid,
                    "presentationLayerHasWindowAncestor": Dictionary(uniqueKeysWithValues:
                        baselineSample.presentationLayerHasWindowAncestor.map { ($0.key.rawValue, $0.value) }),
                    "targetBounds": baselineTargetBoundsJSON,
                    "presentationFrames": baselineFramesJSON,
                    "windowBounds": ["x": window.bounds.minX, "y": window.bounds.minY,
                                     "width": window.bounds.width, "height": window.bounds.height]
                ], name: "composer-presentation-baseline-geometry")
                XCTAssertTrue(baselinePresentationValid,
                    "The stable typed baseline must have finite same-window presentation geometry within the capsule")
                XCTAssertTrue(baselineLayoutTargetsValid,
                    "The measured mic and Button layout target bounds must remain at least 44 points")

                let transitionID = presentationProbe.requestEmptyDraft(afterRevision: baselineRevision)
                draftSavePhase = "original-host-native-input-cleared"
                composerTextView.text = ""
                composerDelegate.textViewDidChange?(composerTextView)
                let emptyDeadline = ContinuousClock.now.advanced(by: .seconds(2))
                while !model.composerDraft(in: scope).isEmpty, ContinuousClock.now < emptyDeadline {
                    try await Task.sleep(for: .milliseconds(40))
                }
                try await Task.sleep(for: .milliseconds(120))
                window.layoutIfNeeded()
                // Preserve the original screenshot timing as the reference
                // capture; it may still fall inside the existing spring.
                attach("recovery-enabled")
                func stablePostChangeTail() -> [ComposerPresentationSampler.Sample]? {
                    guard let transition = presentationProbe.emptyTransition,
                          transition.id == transitionID,
                          let emptyRevision = transition.observedEmptyRevision,
                          let observedAt = transition.observedEmptyAt,
                          sampler.maximumMotion(from: baselineSample, after: transition.requestedAt) > 1 else {
                        return nil
                    }
                    return sampler.stableTail(
                        after: observedAt,
                        emptyRevision: emptyRevision
                    )
                }
                try await sampler.wait(until: { stablePostChangeTail() != nil }, timeout: 3)
                let transition = presentationProbe.emptyTransition
                let postChangeStableTail = stablePostChangeTail()
                let observedSample = postChangeStableTail?.last
                let capsule = observedSample?.presentationFrames[.capsule]
                let mic = observedSample?.presentationFrames[.microphone]
                let send = observedSample?.presentationFrames[.send]
                let windowBounds = window.bounds
                let stableMarkers = ComposerPresentationTarget.allCases.compactMap { presentationProbe.marker($0) }
                let targetBounds = observedSample?.targetBounds ?? [:]
                let layoutTargetBoundsAtLeast44 = [ComposerPresentationTarget.microphone, .send].allSatisfy {
                    guard let rect = targetBounds[$0] else { return false }
                    return rect.width >= 44 && rect.height >= 44
                }
                let presentationGeometryValid = finite(capsule) && finite(mic) && finite(send)
                    && finite(windowBounds)
                    && roundedContains(capsule ?? .zero, mic ?? .infinite,
                                       radius: AssistantTheme.conversationCornerRadius)
                    && roundedContains(capsule ?? .zero, send ?? .infinite,
                                       radius: AssistantTheme.conversationCornerRadius)
                    && contains(windowBounds, capsule ?? .infinite)
                    && contains(windowBounds, mic ?? .infinite)
                    && contains(windowBounds, send ?? .infinite)
                let motion = sampler.maximumMotion(from: baselineSample, after: transition?.requestedAt ?? 0)
                let postRequestSamples = sampler.samples.filter { $0.timestamp >= (transition?.requestedAt ?? .infinity) }
                let postRequestPresentationGeometryValid = !postRequestSamples.isEmpty
                    && postRequestSamples.allSatisfy { sample in
                        guard sample.windowPresentationAvailable,
                              sample.missingPresentation.isEmpty,
                              sample.presentationLayerHasWindowAncestor.count == ComposerPresentationTarget.allCases.count,
                              sample.presentationLayerHasWindowAncestor.values.allSatisfy({ $0 }),
                              let sampleCapsule = sample.presentationFrames[.capsule],
                              let sampleMic = sample.presentationFrames[.microphone],
                              let sampleSend = sample.presentationFrames[.send],
                              finite(sampleCapsule), finite(sampleMic), finite(sampleSend) else { return false }
                        return roundedContains(sampleCapsule, sampleMic,
                                               radius: AssistantTheme.conversationCornerRadius)
                            && roundedContains(sampleCapsule, sampleSend,
                                               radius: AssistantTheme.conversationCornerRadius)
                            && contains(windowBounds, sampleCapsule)
                            && contains(windowBounds, sampleMic)
                            && contains(windowBounds, sampleSend)
                    }
                let maximumPostRequestSampleGap = zip(postRequestSamples, postRequestSamples.dropFirst())
                    .map { $1.timestamp - $0.timestamp }.max() ?? 0
                let firstPostRequestObservationGap = postRequestSamples.first.map {
                    max(0, $0.timestamp - (transition?.requestedAt ?? $0.timestamp))
                } ?? 0
                let noMissingPresentationAfterRequest = !postRequestSamples.isEmpty
                    && postRequestSamples.allSatisfy {
                        $0.windowPresentationAvailable && $0.missingPresentation.isEmpty
                            && $0.presentationLayerHasWindowAncestor.count == ComposerPresentationTarget.allCases.count
                            && $0.presentationLayerHasWindowAncestor.values.allSatisfy { $0 }
                    }
                let targetBoundsJSON = Dictionary(uniqueKeysWithValues: targetBounds.map {
                    ($0.key.rawValue, ComposerPresentationSampler.rectJSON($0.value))
                })
                let observedFramesJSON = Dictionary(uniqueKeysWithValues: (observedSample?.presentationFrames ?? [:]).map {
                    ($0.key.rawValue, ComposerPresentationSampler.rectJSON($0.value))
                })
                let receipt: [String: Any] = [
                    "variant": variant,
                    "state": "composer-clear-observed-post-change-stable-samples",
                    "instrumented": true,
                    "measurementLimit": "Presentation frames cover the capsule and actual mic/send Button overlay targets; target bounds are untransformed layout bounds. These are display-link observations only, not continuous geometry proof or evidence every animation completed. They do not prove glyph bounds, hit-region behavior, touch activation, or VoiceOver activation.",
                    "requestedAt": transition?.requestedAt ?? 0,
                    "baselineDraftRevision": baselineRevision,
                    "observedEmptyRevision": transition?.observedEmptyRevision ?? -1,
                    "observedEmptyAt": transition?.observedEmptyAt ?? 0,
                    "transactionRemovedCompletionHintAt": transition?.animationCompletionAt.map { $0 as Any } ?? NSNull(),
                    "completionHintScope": "Recorded transaction callback only; not treated as proof that nested control animations completed.",
                    "maximumPresentationMotionPoints": motion,
                    "postChangeStableSampleCount": postChangeStableTail?.count ?? 0,
                    "postChangeStableSampleTimes": postChangeStableTail?.map(\.timestamp) ?? [],
                    "targetBounds": targetBoundsJSON,
                    "observedPresentationFrames": observedFramesJSON,
                    "windowBounds": ["x": windowBounds.minX, "y": windowBounds.minY, "width": windowBounds.width, "height": windowBounds.height],
                    "allMarkersRegisteredAtEnd": stableMarkers.count == ComposerPresentationTarget.allCases.count,
                    "layoutTargetBoundsAtLeast44Points": layoutTargetBoundsAtLeast44,
                    "observedFrameContainmentDiagnosticOnly": presentationGeometryValid,
                    "noMissingPresentationAfterRequest": noMissingPresentationAfterRequest,
                    "allPostRequestPresentationFramesFiniteAndContained": postRequestPresentationGeometryValid,
                    "firstPostRequestObservationGapSeconds": firstPostRequestObservationGap,
                    "maximumPostRequestSampleGapSeconds": maximumPostRequestSampleGap,
                    "samples": sampler.jsonSamples()
                ]
                attachPresentationReceipt(receipt, name: "composer-presentation-transition")
                attach("recovery-enabled-observed-post-change-stable-instrumented")
                XCTAssertNotNil(transition?.observedEmptyRevision,
                    "The probe must observe the scoped empty-draft revision")
                XCTAssertGreaterThan(motion, 1, "The public presentation geometry must record actual movement")
                XCTAssertEqual(postChangeStableTail?.count, 4,
                    "Require four consecutive post-change stable presentation samples after movement")
                XCTAssertEqual(stableMarkers.count, ComposerPresentationTarget.allCases.count)
                XCTAssertTrue(noMissingPresentationAfterRequest,
                    "Missing presentation layers or same-window ancestry must fail closed")
                XCTAssertTrue(postRequestPresentationGeometryValid,
                    "Every observed post-request sample must have finite same-window control frames contained by the capsule and window")

                let instrumentedViewport = transcript.frame
                let instrumentedContentSize = transcript.contentSize
                let instrumentedOffset = transcript.contentOffset
                host.rootView = RootView().environment(model).environment(\.dynamicTypeSize, size)
                    .environment(\.colorScheme, scheme).environment(\.scenePhase, .inactive)
                    .environment(\.composerPresentationProbe, nil)
                window.layoutIfNeeded()
                let removalDeadline = ContinuousClock.now.advanced(by: .seconds(1))
                while ComposerPresentationTarget.allCases.contains(where: { presentationProbe.marker($0) != nil }),
                      ContinuousClock.now < removalDeadline {
                    try await Task.sleep(for: .milliseconds(16))
                }
                window.layoutIfNeeded()
                attach("recovery-enabled-post-change-uninstrumented")
                let markersRemoved = ComposerPresentationTarget.allCases.allSatisfy {
                    presentationProbe.marker($0) == nil
                }
                let currentTranscript = descendants(window).compactMap { $0 as? UIScrollView }
                    .filter { !($0 is UITextView) }.max { $0.bounds.height < $1.bounds.height }
                let transcriptStillAttached = transcript.window === window && transcript.isDescendant(of: window)
                let transcriptReacquiredSame = currentTranscript === transcript
                attachPresentationReceipt([
                    "state": "post-change-uninstrumented-geometry",
                    "allMarkersRemoved": markersRemoved,
                    "transcriptStillAttached": transcriptStillAttached,
                    "transcriptReacquiredSameIdentity": transcriptReacquiredSame,
                    "reacquiredTranscriptFrame": currentTranscript.map { ComposerPresentationSampler.rectJSON($0.frame) } ?? [:],
                    "viewport": ["x": transcript.frame.minX, "y": transcript.frame.minY,
                                 "width": transcript.frame.width, "height": transcript.frame.height],
                    "contentSize": ["width": transcript.contentSize.width, "height": transcript.contentSize.height],
                    "contentOffset": ["x": transcript.contentOffset.x, "y": transcript.contentOffset.y]
                ], name: "composer-presentation-uninstrumented")
                XCTAssertTrue(markersRemoved, "The final post-change capture must remove every opt-in overlay")
                XCTAssertTrue(transcriptStillAttached,
                    "The original transcript scroll view must remain in this window after removing the probe")
                XCTAssertTrue(transcriptReacquiredSame,
                    "Reacquire the current transcript after removing the probe and verify its identity is retained")
                XCTAssertEqual(transcript.frame.minX, instrumentedViewport.minX, accuracy: 1)
                XCTAssertEqual(transcript.frame.minY, instrumentedViewport.minY, accuracy: 1)
                XCTAssertEqual(transcript.frame.width, instrumentedViewport.width, accuracy: 1)
                XCTAssertEqual(transcript.frame.height, instrumentedViewport.height, accuracy: 1)
                XCTAssertEqual(transcript.contentSize.width, instrumentedContentSize.width, accuracy: 1)
                XCTAssertEqual(transcript.contentSize.height, instrumentedContentSize.height, accuracy: 1)
                XCTAssertEqual(transcript.contentOffset.x, instrumentedOffset.x, accuracy: 1)
                XCTAssertEqual(transcript.contentOffset.y, instrumentedOffset.y, accuracy: 1)
                XCTAssertTrue(model.hasComposerRecovery(in: scope))
                XCTAssertTrue(model.composerDraft(in: scope).isEmpty,
                    "Clearing the input should leave an empty draft in the same scope")

                blockerCaptureWindow = window
                blockerComposerTextView = composerTextView
            }
            draftSavePhase = "original-host-teardown-\(variant)"
            window.isHidden = true
            window.rootViewController = nil
        }

        let originalDetachDeadline = ContinuousClock.now.advanced(by: .seconds(1))
        while (blockerCaptureWindow?.rootViewController != nil
            || blockerComposerTextView?.window != nil
            || ComposerPresentationTarget.allCases.contains(where: { presentationProbe.marker($0) != nil }))
            && ContinuousClock.now < originalDetachDeadline {
            try await Task.sleep(for: .milliseconds(16))
        }
        let detachedCaptureWindow = blockerCaptureWindow
        let detachedOriginalComposer = blockerComposerTextView
        let originalHostDetached = detachedCaptureWindow != nil
            && detachedOriginalComposer != nil
            && detachedCaptureWindow?.rootViewController == nil
            && detachedOriginalComposer?.window == nil
            && ComposerPresentationTarget.allCases.allSatisfy { presentationProbe.marker($0) == nil }
        let detachedReceipt: [String: Any] = [
            "phase": "original-host-detached-before-static-mount",
            "windowWasCaptured": detachedCaptureWindow != nil,
            "windowRootControllerRemoved": detachedCaptureWindow?.rootViewController == nil,
            "composerWasCaptured": detachedOriginalComposer != nil,
            "actualComposerDetachedFromWindow": detachedOriginalComposer?.window == nil,
            "allOriginalMarkersRemoved": ComposerPresentationTarget.allCases.allSatisfy { presentationProbe.marker($0) == nil },
            "sameDraftScope": model.composerDraftScope == scope,
            "draftStillEmptyBeforeBlockerSeed": model.composerDraft(in: scope).isEmpty,
            "recoveryStillAvailable": model.hasComposerRecovery(in: scope),
            "draftSaveEvidence": draftSaveReceiptFields()
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: detachedReceipt, options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "full-height-original-host-detached-before-static-mount"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not serialize original-host teardown receipt: \(error)")
        }
        XCTAssertTrue(originalHostDetached,
            "The original host, composer input, and presentation markers must be detached before seeding the static host")
        guard originalHostDetached else { return }
        XCTAssertEqual(model.composerDraftScope, scope)
        XCTAssertTrue(model.composerDraft(in: scope).isEmpty)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        let blockerText = "Keep recovery available while mounting static AX3."
        draftSavePhase = "static-blocker-seed"
        model.saveComposerDraft(blockerText, in: scope)
        let blockerSeedReceipt: [String: Any] = [
            "phase": "same-scope-blocker-seeded-after-original-host-detach",
            "sameDraftScope": model.composerDraftScope == scope,
            "modelDraft": model.composerDraft(in: scope),
            "recoveryStillAvailable": model.hasComposerRecovery(in: scope),
            "draftSaveEvidence": draftSaveReceiptFields()
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: blockerSeedReceipt, options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "full-height-static-blocker-seeded-after-original-host-detach"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not serialize static blocker seed receipt: \(error)")
        }
        XCTAssertEqual(model.composerDraft(in: scope), blockerText)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))

        // Static-only AX3 capture: the real RootView mounts with a local
        // SwiftUI transaction that disables animations from its first render.
        // It verifies the empty-state geometry, not transition behavior.
        let staticProbe = ComposerPresentationProbe()
        let staticWindow = UIWindow(windowScene: scene)
        staticWindow.frame = scene.coordinateSpace.bounds
        let staticHost = UIHostingController(rootView:
            RootView().environment(model).environment(\.dynamicTypeSize, .accessibility3)
                .environment(\.colorScheme, .light).environment(\.scenePhase, .inactive)
                .environment(\.composerPresentationProbe, staticProbe)
                .transaction { transaction in
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                })
        staticHost.traitOverrides.accessibilityContrast = .high
        draftSavePhase = "static-host-mount"
        staticWindow.rootViewController = staticHost
        staticWindow.overrideUserInterfaceStyle = .light
        staticWindow.makeKeyAndVisible()
        defer { staticWindow.isHidden = true; staticWindow.rootViewController = nil }
        let staticSampler = ComposerPresentationSampler(window: staticWindow, probe: staticProbe)
        defer { staticSampler.stop() }
        func staticDescendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(staticDescendants) }
        func staticComposer() -> UITextView? {
            staticDescendants(staticWindow).compactMap { $0 as? UITextView }
                .first { $0.accessibilityIdentifier == "assistant.chat.composer" }
        }
        let staticBlockerDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        func staticBlockerReady() -> Bool {
            guard let composer = staticComposer() else { return false }
            let markers = ComposerPresentationTarget.allCases.compactMap { staticProbe.marker($0) }
            guard let revision = markers.first?.draftRevision else { return false }
            return model.composerDraftScope == scope
                && model.composerDraft(in: scope) == "Keep recovery available while mounting static AX3."
                && model.hasComposerRecovery(in: scope)
                && composer.window === staticWindow
                && composer.text == "Keep recovery available while mounting static AX3."
                && markers.count == ComposerPresentationTarget.allCases.count
                && markers.allSatisfy { !$0.draftIsEmpty && $0.draftRevision == revision }
        }
        while !staticBlockerReady(), ContinuousClock.now < staticBlockerDeadline {
            try await Task.sleep(for: .milliseconds(40))
        }
        let staticBlockerComposer = try XCTUnwrap(staticComposer())
        let staticBlockerMarkers = ComposerPresentationTarget.allCases.compactMap { staticProbe.marker($0) }
        let staticBlockerRevision = staticBlockerMarkers.first?.draftRevision ?? -1
        let blockerReceipt: [String: Any] = [
            "phase": "static-host-mounted-with-nonempty-same-scope-blocker",
            "sameDraftScope": model.composerDraftScope == scope,
            "modelDraft": model.composerDraft(in: scope),
            "actualInputText": staticBlockerComposer.text ?? "",
            "actualInputInStaticWindow": staticBlockerComposer.window === staticWindow,
            "staticWindowIsKeyWindow": staticWindow.isKeyWindow,
            "staticWindowSceneSession": staticWindow.windowScene?.session.persistentIdentifier ?? "none",
            "hasRecovery": model.hasComposerRecovery(in: scope),
            "markerCount": staticBlockerMarkers.count,
            "markersAllNonemptyAtSameRevision": staticBlockerMarkers.count == ComposerPresentationTarget.allCases.count
                && staticBlockerMarkers.allSatisfy { !$0.draftIsEmpty && $0.draftRevision == staticBlockerRevision },
            "draftRevision": staticBlockerRevision,
            "draftSaveEvidence": draftSaveReceiptFields()
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: blockerReceipt, options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "full-height-static-host-blocker-before-clear"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not serialize static-host blocker receipt: \(error)")
        }
        XCTAssertTrue(staticBlockerReady(),
            "Static RootView must preserve the original nonempty scoped draft and recovery before clearing the actual input")
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        guard staticBlockerReady() else { return }

        staticSampler.start()
        draftSavePhase = "static-host-native-input-cleared"
        staticBlockerComposer.text = ""
        let staticClearDelegate = try XCTUnwrap(staticBlockerComposer.delegate)
        staticClearDelegate.textViewDidChange?(staticBlockerComposer)
        let staticClearDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        func staticClearObserved() -> Bool {
            let markers = ComposerPresentationTarget.allCases.compactMap { staticProbe.marker($0) }
            return model.composerDraftScope == scope
                && model.composerDraft(in: scope).isEmpty
                && model.hasComposerRecovery(in: scope)
                && staticComposer() === staticBlockerComposer
                && staticBlockerComposer.window === staticWindow
                && staticBlockerComposer.text?.isEmpty == true
                && markers.count == ComposerPresentationTarget.allCases.count
                && markers.allSatisfy { $0.draftIsEmpty && $0.draftRevision == markers[0].draftRevision }
        }
        while !staticClearObserved(), ContinuousClock.now < staticClearDeadline {
            try await Task.sleep(for: .milliseconds(40))
        }
        let markersAfterStaticClear = ComposerPresentationTarget.allCases.compactMap { staticProbe.marker($0) }
        let clearReceipt: [String: Any] = [
            "phase": "static-host-actual-input-cleared-through-delegate",
            "sameDraftScope": model.composerDraftScope == scope,
            "modelDraftEmpty": model.composerDraft(in: scope).isEmpty,
            "actualInputEmpty": staticBlockerComposer.text?.isEmpty == true,
            "currentInputReacquiredSameIdentity": staticComposer() === staticBlockerComposer,
            "actualInputInStaticWindow": staticBlockerComposer.window === staticWindow,
            "staticWindowIsKeyWindow": staticWindow.isKeyWindow,
            "staticWindowSceneSession": staticWindow.windowScene?.session.persistentIdentifier ?? "none",
            "hasRecovery": model.hasComposerRecovery(in: scope),
            "draftSaveEvidence": draftSaveReceiptFields(),
            "markerCount": markersAfterStaticClear.count,
            "markersAllEmpty": markersAfterStaticClear.count == ComposerPresentationTarget.allCases.count
                && markersAfterStaticClear.allSatisfy { $0.draftIsEmpty && $0.draftRevision == markersAfterStaticClear[0].draftRevision },
            "markerRevisions": markersAfterStaticClear.map(\.draftRevision)
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: clearReceipt, options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "full-height-static-host-empty-input-before-sampling"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not serialize static-host clear receipt: \(error)")
        }
        XCTAssertTrue(staticClearObserved(),
            "The actual static-host UITextView delegate must clear the same scoped draft while recovery remains available")
        guard staticClearObserved() else { return }
        func staticHasStableFrames() -> Bool {
            guard let first = staticSampler.samples.first else { return false }
            guard let tail = staticSampler.stableTail(after: first.timestamp) else { return false }
            return tail.allSatisfy(\.draftIsEmpty)
        }
        try await staticSampler.wait(until: staticHasStableFrames, timeout: 2)
        let staticTail = staticHasStableFrames()
            ? staticSampler.stableTail(after: staticSampler.samples.first?.timestamp ?? .infinity) : nil
        let staticSample = staticTail?.last
        let staticCapsule = staticSample?.presentationFrames[.capsule]
        let staticMic = staticSample?.presentationFrames[.microphone]
        let staticSend = staticSample?.presentationFrames[.send]
        let staticBounds = staticSample?.targetBounds ?? [:]
        let staticTranscript = staticDescendants(staticWindow).compactMap { $0 as? UIScrollView }
            .filter { !($0 is UITextView) }.max { $0.bounds.height < $1.bounds.height }
        let staticTranscriptAttached = staticTranscript.map { $0.window === staticWindow && $0.isDescendant(of: staticWindow) } ?? false
        func staticFinite(_ rect: CGRect?) -> Bool {
            guard let rect else { return false }
            return !rect.isNull && !rect.isInfinite && !rect.isEmpty
                && rect.minX.isFinite && rect.minY.isFinite
                && rect.width.isFinite && rect.height.isFinite
                && rect.maxX.isFinite && rect.maxY.isFinite
        }
        func staticContains(_ outer: CGRect, _ inner: CGRect, tolerance: CGFloat = 1) -> Bool {
            outer.insetBy(dx: -tolerance, dy: -tolerance).contains(inner)
        }
        func staticRoundedContains(_ outer: CGRect, _ inner: CGRect, radius: CGFloat, tolerance: CGFloat = 1) -> Bool {
            guard staticContains(outer, inner, tolerance: tolerance) else { return false }
            let r = min(radius, min(outer.width, outer.height) / 2)
            let corners = [
                CGPoint(x: inner.minX, y: inner.minY), CGPoint(x: inner.maxX, y: inner.minY),
                CGPoint(x: inner.minX, y: inner.maxY), CGPoint(x: inner.maxX, y: inner.maxY)
            ]
            return corners.allSatisfy { point in
                var center: CGPoint?
                if point.x < outer.minX + r && point.y < outer.minY + r {
                    center = CGPoint(x: outer.minX + r, y: outer.minY + r)
                } else if point.x > outer.maxX - r && point.y < outer.minY + r {
                    center = CGPoint(x: outer.maxX - r, y: outer.minY + r)
                } else if point.x < outer.minX + r && point.y > outer.maxY - r {
                    center = CGPoint(x: outer.minX + r, y: outer.maxY - r)
                } else if point.x > outer.maxX - r && point.y > outer.maxY - r {
                    center = CGPoint(x: outer.maxX - r, y: outer.maxY - r)
                }
                guard let center else { return true }
                return hypot(point.x - center.x, point.y - center.y) <= r + tolerance
            }
        }
        let staticMarkers = ComposerPresentationTarget.allCases.compactMap { staticProbe.marker($0) }
        let staticSameWindowHierarchy = staticMarkers.count == ComposerPresentationTarget.allCases.count
            && staticMarkers.allSatisfy { $0.view.window === staticWindow && $0.view.isDescendant(of: staticWindow) }
            && staticTranscriptAttached
        let staticTargetsHave44PointLayout = [ComposerPresentationTarget.microphone, .send].allSatisfy {
            guard let rect = staticBounds[$0] else { return false }
            return rect.width >= 44 && rect.height >= 44
        }
        let staticGeometryValid = staticFinite(staticCapsule) && staticFinite(staticMic) && staticFinite(staticSend)
            && staticFinite(staticWindow.bounds)
            && staticFinite(staticTranscript?.frame)
            && staticRoundedContains(staticCapsule ?? .zero, staticMic ?? .infinite,
                                     radius: AssistantTheme.conversationCornerRadius)
            && staticRoundedContains(staticCapsule ?? .zero, staticSend ?? .infinite,
                                     radius: AssistantTheme.conversationCornerRadius)
            && staticContains(staticWindow.bounds, staticCapsule ?? .infinite)
            && staticContains(staticWindow.bounds, staticMic ?? .infinite)
            && staticContains(staticWindow.bounds, staticSend ?? .infinite)
            && staticSample?.presentationLayerHasWindowAncestor.count == ComposerPresentationTarget.allCases.count
            && staticSample?.presentationLayerHasWindowAncestor.values.allSatisfy { $0 } == true
            && staticSample?.windowPresentationAvailable == true
            && staticSameWindowHierarchy
        let staticSourceBounds = Dictionary(uniqueKeysWithValues: staticBounds.map {
            ($0.key.rawValue, ComposerPresentationSampler.rectJSON($0.value))
        })
        let staticFrames = Dictionary(uniqueKeysWithValues: (staticSample?.presentationFrames ?? [:]).map {
            ($0.key.rawValue, ComposerPresentationSampler.rectJSON($0.value))
        })
        var staticRendered = false
        let staticImage = UIGraphicsImageRenderer(bounds: staticWindow.bounds).image { _ in
            staticRendered = staticWindow.drawHierarchy(in: staticWindow.bounds, afterScreenUpdates: true)
        }
        let staticImageAttachment = XCTAttachment(image: staticImage)
        staticImageAttachment.name = "full-height-contrast-accessibility3-empty-animation-disabled-static"
        staticImageAttachment.lifetime = .keepAlways
        add(staticImageAttachment)
        let staticReceipt: [String: Any] = [
            "state": "empty-AX3-animation-disabled-static-only",
            "animationPolicy": "RootView mounted with transaction.animation=nil and transaction.disablesAnimations=true; no global setting changed.",
            "configuredSwiftUIDynamicTypeSize": String(describing: DynamicTypeSize.accessibility3),
            "observedUIKitPreferredContentSizeCategory": staticWindow.traitCollection.preferredContentSizeCategory.rawValue,
            "observedUIKitUserInterfaceStyle": String(describing: staticWindow.traitCollection.userInterfaceStyle),
            "observedUIKitAccessibilityContrast": String(describing: staticWindow.traitCollection.accessibilityContrast),
            "rootObservedUIKitPreferredContentSizeCategory": staticHost.traitCollection.preferredContentSizeCategory.rawValue,
            "rootObservedUIKitUserInterfaceStyle": String(describing: staticHost.traitCollection.userInterfaceStyle),
            "rootObservedUIKitAccessibilityContrast": String(describing: staticHost.traitCollection.accessibilityContrast),
            "transcriptObservedUIKitPreferredContentSizeCategory": staticTranscript?.traitCollection.preferredContentSizeCategory.rawValue ?? "none",
            "transcriptObservedUIKitAccessibilityContrast": String(describing: staticTranscript?.traitCollection.accessibilityContrast ?? .normal),
            "notTransitionEvidence": true,
            "rendered": staticRendered,
            "modelDraftEmpty": model.composerDraft(in: scope).isEmpty,
            "hasRecovery": model.hasComposerRecovery(in: scope),
            "markerCount": staticMarkers.count,
            "allMarkerDraftsEmpty": staticMarkers.allSatisfy(\.draftIsEmpty),
            "sameWindowHierarchy": staticSameWindowHierarchy,
            "transcriptFrame": staticTranscript.map { ["x": $0.frame.minX, "y": $0.frame.minY,
                                                        "width": $0.frame.width, "height": $0.frame.height] } ?? [:],
            "presentationLayerHasWindowAncestor": Dictionary(uniqueKeysWithValues:
                (staticSample?.presentationLayerHasWindowAncestor ?? [:]).map { ($0.key.rawValue, $0.value) }),
            "sourceLayoutBoundsAtLeast44Points": staticTargetsHave44PointLayout,
            "presentationGeometryValid": staticGeometryValid,
            "targetBounds": staticSourceBounds,
            "presentationFrames": staticFrames,
            "windowBounds": ["x": staticWindow.bounds.minX, "y": staticWindow.bounds.minY,
                             "width": staticWindow.bounds.width, "height": staticWindow.bounds.height],
            "sampleCount": staticSampler.samples.count,
            "stableSampleTailCount": staticTail?.count ?? 0,
            "samples": staticSampler.jsonSamples(),
            "draftSaveEvidence": draftSaveReceiptFields(),
            "measurementLimit": "Static empty-state geometry only; does not establish transition behavior, glyph bounds, hit activation, or VoiceOver activation."
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: staticReceipt, options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "full-height-contrast-accessibility3-empty-animation-disabled-static-state"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            let attachment = XCTAttachment(data: Data("Static receipt serialization failed: \(error)\n\(String(describing: staticReceipt))".utf8),
                                           uniformTypeIdentifier: "public.plain-text")
            attachment.name = "full-height-contrast-accessibility3-static-serialization-error"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("Could not serialize AX3 static geometry receipt: \(error)")
        }
        XCTAssertTrue(staticRendered, "The static AX3 RootView capture must render")
        XCTAssertTrue(model.composerDraft(in: scope).isEmpty)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        XCTAssertTrue(staticMarkers.allSatisfy(\.draftIsEmpty))
        XCTAssertTrue(staticSameWindowHierarchy, "Static RootView transcript and markers must belong to the captured window")
        XCTAssertEqual(staticMarkers.count, ComposerPresentationTarget.allCases.count)
        XCTAssertTrue(staticTail?.count == 4, "Static geometry requires four consecutive presentation samples")
        XCTAssertTrue(staticTargetsHave44PointLayout,
            "The static mic and Button layout target bounds must remain at least 44 points")
        XCTAssertTrue(staticGeometryValid,
            "Static presentation frames must be finite, same-window, and contained within the capsule/window")
        staticSampler.stop()

        draftSavePhase = "static-host-teardown"
        staticHost.rootView = RootView().environment(model).environment(\.dynamicTypeSize, .accessibility3)
            .environment(\.colorScheme, .light).environment(\.scenePhase, .inactive)
            .environment(\.composerPresentationProbe, nil)
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        staticWindow.layoutIfNeeded()
        let staticMarkerRemovalDeadline = ContinuousClock.now.advanced(by: .seconds(1))
        while ComposerPresentationTarget.allCases.contains(where: { staticProbe.marker($0) != nil }),
              ContinuousClock.now < staticMarkerRemovalDeadline {
            try await Task.sleep(for: .milliseconds(16))
        }
        staticWindow.rootViewController = nil
        staticWindow.isHidden = true
        let staticDetachDeadline = ContinuousClock.now.advanced(by: .seconds(1))
        while (staticBlockerComposer.window != nil
            || ComposerPresentationTarget.allCases.contains(where: { staticProbe.marker($0) != nil }))
            && ContinuousClock.now < staticDetachDeadline {
            try await Task.sleep(for: .milliseconds(16))
        }
        let staticHostDetached = staticWindow.rootViewController == nil
            && staticBlockerComposer.window == nil
            && ComposerPresentationTarget.allCases.allSatisfy { staticProbe.marker($0) == nil }
        let postDetachState: [String: Any] = [
            "phase": "static-host-detached-before-one-shot-model-restore",
            "hostRootRemoved": staticWindow.rootViewController == nil,
            "actualInputDetachedFromWindow": staticBlockerComposer.window == nil,
            "allStaticMarkersRemoved": ComposerPresentationTarget.allCases.allSatisfy { staticProbe.marker($0) == nil },
            "staticWindowIsKeyWindowAfterDetach": staticWindow.isKeyWindow,
            "staticWindowSceneSession": staticWindow.windowScene?.session.persistentIdentifier ?? "none",
            "sameDraftScope": model.composerDraftScope == scope,
            "modelDraftEmpty": model.composerDraft(in: scope).isEmpty,
            "recoveryStillAvailable": model.hasComposerRecovery(in: scope),
            "draftSaveEvidence": draftSaveReceiptFields()
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: postDetachState, options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "full-height-static-host-detached-before-model-restore"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not serialize static-host teardown receipt: \(error)")
        }
        XCTAssertTrue(staticHostDetached,
            "The static host, input, and markers must be detached before one-shot recovery restoration")
        guard staticHostDetached else { return }
        XCTAssertEqual(model.composerDraftScope, scope)
        XCTAssertTrue(model.composerDraft(in: scope).isEmpty)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))

        // Verify the one-shot model lifecycle after all rendered states are
        // captured. Recovery is exercised through the model lifecycle only;
        // this suite does not activate Send, Restore, Jump, or VoiceOver.
        let clearedDraftDeadline = ContinuousClock.now.advanced(by: .seconds(1))
        while !model.composerDraft(in: scope).isEmpty, ContinuousClock.now < clearedDraftDeadline {
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTAssertTrue(model.composerDraft(in: scope).isEmpty)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        draftSavePhase = "model-recovery-restore"
        let restored = model.restoreComposerRecovery(in: scope, replacing: "")
        let restoredState = try JSONSerialization.data(withJSONObject: [
            "state": "model-recovery-restored", "hasRecovery": model.hasComposerRecovery(in: scope),
            "draft": model.composerDraft(in: scope), "returnedText": restored ?? "",
            "draftSaveEvidence": draftSaveReceiptFields()
        ], options: [.prettyPrinted, .sortedKeys])
        let restoredAttachment = XCTAttachment(data: restoredState, uniformTypeIdentifier: "public.json")
        restoredAttachment.name = "full-height-model-recovery-restored"
        restoredAttachment.lifetime = .keepAlways
        add(restoredAttachment)
        XCTAssertEqual(restored, recoveryText)
        XCTAssertFalse(model.hasComposerRecovery(in: scope))
        XCTAssertEqual(model.composerDraft(in: scope), recoveryText)
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

    // Public UIKit accessibility enumeration in this unit host did not expose
    // the rendered controls (bc835011: 38 lookup/frame failures). Policy tests
    // and reviewed images cover separate contracts; activation, VoiceOver and
    // hit behavior remain unverified.
    @MainActor
    func testRecoveryNoticeCardsAcrossAppearanceAndAccessibilitySizes() async throws {
        NativeReviewProtocol.install([:])
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: sessionConfig))
        let defaultsName = "assistant.recovery-notice-visual-review"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsName))
        defaults.removePersistentDomain(forName: defaultsName)
        let model = AppModel(apiClient: client, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let actions = RecoveryActionCounts()

        func message(_ id: String, kind: ChatNoticeKind, headline: String, summary: String,
                     diagnostics: [String] = []) -> ChatMessage {
            ChatMessage(id: id, role: .assistant, parts: [
                .init(type: "notice", notice: kind.rawValue, presentation: .init(
                    version: 1,
                    headline: headline,
                    summary: summary,
                    facts: nil,
                    detailLabel: "Failure details",
                    diagnostics: diagnostics.isEmpty ? nil : diagnostics
                ))
            ])
        }

        let cases: [(name: String, message: ChatMessage, userPrompt: String?, retry: ((String) -> Void)?, activity: (() -> Void)?)] = [
            (
                "recovery-confirmed-no-effect",
                message("recovery-no-effect", kind: .turnFailed,
                        headline: "Nothing was changed",
                        summary: "The request was confirmed as not applied. You can safely try again."),
                "Save the draft",
                { prompt in
                    XCTAssertEqual(prompt, "Save the draft")
                    actions.retry += 1
                },
                { actions.activity += 1 }
            ),
            (
                "recovery-unknown-effect",
                message("recovery-unknown-effect", kind: .providerFailed,
                        headline: "Check before retrying",
                        summary: "The connection ended after the request was sent, so its result is unknown. Review Activity to see whether the change completed before taking another action."),
                "Update the calendar",
                { _ in actions.retry += 1 },
                { actions.activity += 1 }
            ),
            (
                "recovery-provider-failed",
                message("recovery-provider-failed", kind: .providerFailed,
                        headline: "The model service stopped",
                        summary: "No finished answer was received. Review Activity for the interruption details."),
                "Retry this prompt",
                { _ in actions.retry += 1 },
                { actions.activity += 1 }
            ),
            (
                "recovery-retry-unavailable-while-sending",
                message("recovery-retry-unavailable", kind: .turnFailed,
                        headline: "Reply not completed",
                        summary: "This reply did not finish. Wait for the current response to settle before retrying."),
                "Do not queue this yet",
                nil,
                { actions.activity += 1 }
            ),
            (
                "recovery-whitespace-diagnostics",
                message("recovery-whitespace-diagnostics", kind: .providerFailed,
                        headline: "The model service stopped",
                        summary: "No finished answer was received. Review Activity before deciding what to do next.",
                        diagnostics: ["", " \n\t "]),
                "Review this request",
                nil,
                { actions.activity += 1 }
            ),
            (
                "recovery-long-diagnostics",
                message("recovery-long-diagnostics", kind: .providerFailed,
                        headline: "The request needs review",
                        summary: "The server could not confirm whether the requested changes completed. Review the detailed request and response information below before deciding what to do next.",
                        diagnostics: [
                            "Request ID: request-7c0e9f5d. The client sent the operation and then lost its connection before receiving a terminal response. The server may have committed the operation; check the authoritative record before retrying.",
                            "Transport detail: the response stream closed unexpectedly after the final request bytes were written. No automatic retry was attempted because repeating this operation could duplicate work."
                        ]),
                "Review the operation",
                nil,
                { actions.activity += 1 }
            )
        ]

        func page(_ fixture: (name: String, message: ChatMessage, userPrompt: String?, retry: ((String) -> Void)?, activity: (() -> Void)?)) -> Page {
            Page(fixture.name, ScrollView {
                MessageBubble(message: fixture.message, userPrompt: fixture.userPrompt, isStreaming: false,
                              openApprovals: {}, runForReal: nil, retry: fixture.retry, decideApproval: nil,
                              openActivity: fixture.activity)
                    .padding(20)
            })
        }

        for scheme in [ColorScheme.light, .dark] {
            for fixture in cases {
                try await capture(page(fixture), scheme: scheme, size: .large,
                                  scene: scene, model: model)
            }
        }
        for fixture in cases {
            try await capture(page(fixture), scheme: .light, size: .accessibility3,
                              scene: scene, model: model)
        }
        let contrastFixture = try XCTUnwrap(cases.first { $0.name == "recovery-unknown-effect" })
        try await capture(page(contrastFixture), scheme: .light, size: .accessibility3,
                          scene: scene, model: model, increasedContrast: true)

        XCTAssertEqual(actions.retry, 0, "Capturing recovery cards must not invoke retry callbacks")
        XCTAssertEqual(actions.activity, 0, "Capturing recovery cards must not open Activity")
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
    }

    func testRecoveryNoticePresentationKeepsRetryAndActivityEligibilityConservative() {
        let eligible = RecoveryNoticePresentation(
            kind: .turnFailed, userPrompt: "  exact original prompt  ", retryAvailable: true,
            activityAvailable: true, diagnostics: []
        )
        XCTAssertEqual(eligible.retryPrompt, "  exact original prompt  ")
        XCTAssertTrue(eligible.showsActivity)
        XCTAssertTrue(eligible.hasActions)

        let providerFailure = RecoveryNoticePresentation(
            kind: .providerFailed, userPrompt: "Retry text", retryAvailable: true,
            activityAvailable: true, diagnostics: []
        )
        XCTAssertNil(providerFailure.retryPrompt, "An unknown-effect provider failure must not gain retry eligibility")
        XCTAssertTrue(providerFailure.showsActivity)
        XCTAssertTrue(providerFailure.hasActions)

        let inFlight = RecoveryNoticePresentation(
            kind: .turnFailed, userPrompt: "Prompt", retryAvailable: false,
            activityAvailable: false, diagnostics: []
        )
        XCTAssertNil(inFlight.retryPrompt, "A missing retry callback must keep retry unavailable")
        XCTAssertFalse(inFlight.showsActivity)
        XCTAssertFalse(inFlight.hasActions)
        let activityOnly = RecoveryNoticePresentation(
            kind: .turnFailed, userPrompt: "Prompt", retryAvailable: false,
            activityAvailable: true, diagnostics: []
        )
        XCTAssertNil(activityOnly.retryPrompt)
        XCTAssertTrue(activityOnly.showsActivity)
        XCTAssertTrue(activityOnly.hasActions)

        let missingPrompt = RecoveryNoticePresentation(
            kind: .turnFailed, userPrompt: nil, retryAvailable: true,
            activityAvailable: false, diagnostics: []
        )
        XCTAssertNil(missingPrompt.retryPrompt)
        XCTAssertFalse(missingPrompt.hasActions)
    }

    func testRecoveryNoticePresentationFiltersOnlyBlankDiagnosticsAndPreservesOrder() {
        let blankCases: [[String]] = [[], [""], [" \n\t "]]
        for diagnostics in blankCases {
            XCTAssertTrue(RecoveryNoticePresentation(
                kind: .providerFailed, userPrompt: nil, retryAvailable: false,
                activityAvailable: false, diagnostics: diagnostics
            ).diagnostics.isEmpty)
        }
        let presentation = RecoveryNoticePresentation(
            kind: .providerFailed, userPrompt: nil, retryAvailable: false,
            activityAvailable: false,
            diagnostics: ["", " \n\t ", "  first detail  ", "second\nline", "\n"]
        )
        XCTAssertEqual(presentation.diagnostics, ["  first detail  ", "second\nline"])
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
        // Exercise production prose and standalone cards with the viewport
        // environment measured before the fixture's transcript gutters.
        let surfaceMessages: [ChatMessage] = [
            messages[0],
            .optimistic(role: .assistant,
                text: """
                **Weekend travel plan**

                Keep the morning flexible until the train and hotel arrangements are confirmed. The station is close enough to reach on foot, but leave time for the crossing near the waterfront and for finding the correct platform. If the weather turns, use the covered entrance rather than rushing with luggage through the garden path.

                The train booking is the first decision to settle. Check the departure station, the arrival station, the passenger names, and the luggage allowance together before paying. A slightly later departure may leave more time for breakfast, but it should still arrive early enough for a relaxed walk to the hotel. Save the confirmation where it can be found without searching through unrelated mail.

                - Confirm the outbound date and the station printed on the ticket.
                - Keep the return journey separate until the final afternoon plan is clear.
                - Put the booking reference beside the departure time in the shared note.
                  - Include the platform only after the operator confirms it.
                  - Keep the original confirmation available if the platform changes.
                - Check whether the fare can be changed and when that option expires.

                **Arrival and check-in**

                Ask the hotel whether luggage can be left before the room is ready. That answer determines whether the first stop should be the hotel or the cafe by the station. Keep the arrival message short: give the expected time, ask about the bag drop, and leave the final dinner decision for later. Do not describe an unconfirmed early check-in as a promise.

                There are two sensible afternoon routes. The waterfront walk is easier to shorten if someone is tired, while the old-town route offers more indoor stops if it rains. Both routes should keep a comfortable gap before dinner. A quiet hour at the hotel is part of the plan, rather than a delay to make up by hurrying through the last stop.

                1. Check the bags or leave them with the hotel if that has been confirmed.
                2. Choose lunch near the first stop so nobody has to cross town twice.
                3. Agree on a meeting point before splitting up for the afternoon.
                4. Recheck the weather and energy level before adding another activity.
                5. Keep the dinner reservation time visible in the shared plan.

                **Information to keep handy**

                The shared note should contain the train reference, hotel address, arrival window, and one contact number for each booking. Keep private confirmation details in the original booking record. The note only needs enough context to answer practical questions during the trip, including which entrance to use and where to wait if the group arrives at different times.

                ```swift
                let title = "Weekend plan"
                ```

                | Item | Status |
                | --- | --- |
                | Train | Confirm the fare conditions before booking |
                | Hotel | Ask about luggage storage and the arrival window |
                | Dinner | Keep the final time separate from the afternoon walk |

                **Before returning home**

                Leave enough time after breakfast to collect bags and check the room. Review the return service before leaving the hotel, especially if the route includes a transfer. If a service changes, update the shared note with the revised departure and meeting point instead of leaving two conflicting times in circulation. A calm fallback is to meet at the station cafe and make the next decision together.

                The final check is simple: everyone has their ticket, the bags are accounted for, the route to the station is clear, and the next departure time has been verified. Keep this closing note at the end of the answer so the native screenshot review can confirm the real Markdown content was reached below the fold.

                SURFACE-PADDING-END-OF-TRAVEL-PLAN-2026-10-23
                """,
                id: "surface-padding-markdown"),
            ChatMessage(id: "surface-padding-card", role: .assistant, parts: [event]),
            ChatMessage(id: "surface-padding-contract", role: .assistant, parts: [
                .init(type: "text", text: "The requested result could not be verified."),
                .init(type: "notice", notice: ChatNoticeKind.responseContract.rawValue),
            ]),
            ChatMessage(id: "surface-padding-retracted", role: .assistant, parts: [
                .init(type: "text", text: "This earlier answer was withdrawn."),
                .init(type: "notice", notice: ChatNoticeKind.retracted.rawValue),
            ]),
        ]
        let viewportRecorder = ConversationViewportRecorder(messageIDs: Set(surfaceMessages.map(\.id)))
        let paddingPage = Page("conversation-surface-padding", ownsNavigation: true,
            GeometryReader { available in
                GeometryReader { viewport in
                    ScrollView {
                        VStack(alignment: .leading, spacing: AssistantTheme.ConversationSpacing.surfaceGap) {
                            ForEach(surfaceMessages) { message in
                                MessageBubble(message: message, userPrompt: nil, isStreaming: false,
                                    openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
                                    .background(ConversationViewportReader(
                                        recorder: viewportRecorder, messageID: message.id,
                                        rawRootWidth: viewport.size.width,
                                        outerAvailableWidth: available.size.width,
                                        leadingSafeArea: available.safeAreaInsets.leading,
                                        trailingSafeArea: available.safeAreaInsets.trailing))
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                    }
                }
                .ignoresSafeArea(.container)
                .environment(\.conversationViewportWidth, available.size.width)
            }.background(AssistantTheme.stage))
        for width in [CGFloat(320), 360, 390, 430] {
            for scheme in [ColorScheme.light, .dark] {
                for size in [DynamicTypeSize.large, .accessibility3] {
                    try await capture(paddingPage, scheme: scheme, size: size, scene: scene, model: model,
                                      requiresScrolling: true, viewportWidth: width,
                                      viewportRecorder: viewportRecorder)
                }
            }
        }
        // The outer geometry is already a 350pt safe viewport. The ignored
        // inner stage stays 390pt wide, and both inherit the outer width without
        // subtracting its 20pt + 20pt safe-area metadata again.
        let safeAreaPage = Page("conversation-surface-padding-horizontal-safe-area", ownsNavigation: true,
                                paddingPage.content)
        try await capture(safeAreaPage, scheme: .light, size: .large, scene: scene, model: model,
                          requiresScrolling: true, viewportWidth: 390,
                          additionalSafeAreaInsets: UIEdgeInsets(top: 0, left: 20, bottom: 0, right: 20),
                          viewportRecorder: viewportRecorder)
        for message in surfaceMessages {
            let measured = try XCTUnwrap(viewportRecorder.measurements[message.id])
            XCTAssertEqual(measured.outerAvailableWidth, 350, accuracy: 0.5,
                           "The 390pt host with 20pt safe areas on both sides supplies a 350pt outer viewport")
        }
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

#if DEBUG
    private final class EventRhythmFrameRecorder: @unchecked Sendable {
        // Geometry is observed on the main actor; render callbacks may run elsewhere.
        var frames: [String: CGRect] = [:]
        private let textLock = NSLock()
        private var renderedText: [String: EventRhythmTextSample] = [:]
        func recordText(_ id: String, _ sample: EventRhythmTextSample) {
            textLock.lock(); defer { textLock.unlock() }
            renderedText[id] = sample
        }
        var textSamples: [String: EventRhythmTextSample] {
            textLock.lock(); defer { textLock.unlock() }
            return renderedText
        }
    }

    @MainActor
    func testEventRhythmProductionRows() async throws {
        let eventLedger = EventCaptureLedger()
        defer { eventLedger.finishMethod(self) }
        do {
        try eventLedger.check("method setup")
        NativeReviewProtocol.install([:])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: config))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "assistant.event-rhythm-review"))
        defaults.removePersistentDomain(forName: "assistant.event-rhythm-review")
        let model = AppModel(apiClient: client, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let start = Date.now.addingTimeInterval(5 * 60)
        var richCards: [MessageResponseCard] = (0..<6).map { index in
            .event(id: "rhythm-rich-\(index)", start: start.addingTimeInterval(Double(index) * 86400).ISO8601Format(),
                   time: "11:45 AM – 12:55 PM Pacific Time", title: "A deliberately long planning meeting title for the full family travel itinerary \(index)",
                   location: "North waterfront conference room, beyond the old station and the harbor entrance",
                   attendees: ["Robin — accepted"], calendars: ["Family planning calendar"],
                   calendarLinkURL: "https://calendar.google.com/event/rhythm-\(index)",
                   meetingLinkURL: "https://meet.google.com/rhythm-\(index)")
        }
        richCards.insert(.event(id: "rhythm-rich-same-day", start: start.ISO8601Format(), time: "All afternoon",
                                title: "Second event on the first day", location: "", attendees: [], calendars: ["Work"],
                                calendarLinkURL: nil, meetingLinkURL: nil), at: 1)
        // Production composes all day groups before non-event cards. An input
        // interleaving does not create a rendered day/non-day/day sequence.
        richCards.insert(try XCTUnwrap(MessageResponseCard(part: .init(type: "data-card", data: RichMessageFixture.alert))), at: 2)
        typealias Item = MessageResponseCard.BriefingCard.AgendaItem
        func item(_ id: String, day: String, location: String, note: String) -> Item {
            .init(id: id, day: day, time: day == "Unknown" ? "" : day == "All day" ? "All day" : "11:45 AM – 12:55 PM Pacific Time",
                  title: "A long event title that must remain readable while the clock changes position",
                  location: location, flag: "conflict", note: note, calendars: ["Work", "Personal"],
                  calendarLinks: [.init(label: "Open event", url: "https://calendar.google.com/event/\(id)")],
                  meetingLink: .init(label: "Join", url: "https://meet.google.com/\(id)"))
        }
        let longLocation = "North waterfront conference room beyond the old station, through the harbor entrance, upstairs past the library and the quiet garden"
        let legacyItems = (0..<4).map { index in
            item("rhythm-legacy-\(index)", day: index < 2 ? "Legacy day A" : "Legacy day B",
                 location: index.isMultiple(of: 2) ? longLocation : "", note: "Keep this note even when no location was supplied.")
        }
        let newItems = (0..<8).map { index in
            item("rhythm-new-\(index)", day: index == 0 ? "All day" : index == 1 ? "Unknown" : "Timed",
                 location: index.isMultiple(of: 2) ? longLocation : "", note: "Needs a response before the travel plan is confirmed.")
        }
        func briefing(_ id: String, presentation: MessageResponseCard.BriefingCard.Presentation?,
                      items: [Item]) throws -> MessageResponseCard.BriefingCard {
            var data: [String: JSONValue] = [
                "id": .string(id), "title": .string("Agenda"), "date": .string("Review day"),
                "lead": .string("Incomplete calendar coverage remains visible."),
                "sections": .array([
                    .object(["type": .string("agenda"), "title": .string("Schedule"), "complete": .bool(false),
                             "omittedCount": .number(2), "items": .array(items.map { item in .object([
                                "id": .string(item.id), "day": .string(item.day), "time": .string(item.time),
                                "title": .string(item.title), "location": .string(item.location), "flag": .string(item.flag),
                                "note": .string(item.note), "calendars": .array(item.calendars.map { .string($0) }),
                                "calendarLinks": .array(item.calendarLinks.map { .object(["label": .string($0.label), "url": .string($0.url)]) }),
                                "meetingLink": .object(["label": .string("Join"), "url": .string("https://meet.google.com/\(item.id)")])
                             ]) })]),
                    .object(["type": .string("attention"), "title": .string("Possible overlaps"),
                             "items": .array([.object(["title": .string("Schedules overlap"), "detail": .string("Overlap does not confirm attendance.")])]),
                             "overlaps": .array([.object(["title": .string("Travel and review"), "detail": .string("The schedules overlap by twenty minutes.")])]),
                             "overlapCount": .number(1), "itemCount": .number(1)])
                ])
            ]
            if let presentation { data["presentation"] = .string(presentation.rawValue) }
            return try XCTUnwrap(MessageResponseCard.BriefingCard(data: data))
        }
        let legacy = try briefing("rhythm-legacy", presentation: nil, items: legacyItems)
        let agenda = try briefing("rhythm-new", presentation: .calendarAgenda, items: newItems)
        let richIDs = (0..<6).map { "rhythm-rich-\($0)" } + ["rhythm-rich-same-day"]
        func reviewPage(_ recorder: EventRhythmFrameRecorder, width: CGFloat?, expanded: Bool) -> Page {
            Page("event-rhythm-\(width == nil ? "missing-width" : "viewport")-\(expanded ? "expanded" : "collapsed")", ownsNavigation: true,
                 ScrollView {
                     VStack(alignment: .leading, spacing: 24) {
                         RichResponseCards(cards: richCards)
                         RichResponseCards(cards: [.briefing(legacy)])
                         RichResponseCards(cards: [.briefing(agenda)])
                     }
                     .padding(.horizontal, 16).padding(.vertical, 8)
                     .coordinateSpace(name: "event-rhythm-review")
                 }
                 .environment(\.conversationViewportWidth, width)
                 .environment(\.eventRhythmReview, .init(expandsOverflow: expanded,
                     report: { recorder.frames[$0] = $1 }, reportText: { recorder.recordText($0, $1) }))
                 .background(AssistantTheme.stage))
        }
        func verify(_ recorder: EventRhythmFrameRecorder, width: CGFloat, size: DynamicTypeSize,
                    inheritedWidth: CGFloat?, expanded: Bool, scheme: ColorScheme = .light) throws {
            try eventLedger.check("before painted verification")
            let frames = recorder.frames
            func frame(_ id: String) throws -> CGRect {
                let value = try XCTUnwrap(frames[id], "Missing actual production geometry: \(id)")
                XCTAssertTrue(value.minX.isFinite && value.minY.isFinite && value.width.isFinite && value.height.isFinite)
                XCTAssertGreaterThan(value.width, 0); XCTAssertGreaterThan(value.height, 0)
                return value
            }
            let stacked = size.isAccessibilitySize || inheritedWidth == nil || (inheritedWidth ?? 0) <= 360
            // These are independent expectations for the unchanged standalone paper policy.
            // The renderer's inset22 argument is for embedded cards, not this owning paper.
            let expectedPaperInset: CGFloat = !size.isAccessibilitySize && (inheritedWidth ?? 0) > 360 ? 24 : 20
            let expectedPaperInnerWidth = width - 32 - expectedPaperInset * 2
            let briefingPaperIDs = ["legacy": "rich.item:card-\(legacy.id)", "new": "rich.item:card-\(agenda.id)"]
            let requiredBriefingPaperIDs = Set(briefingPaperIDs.values)
            // Require BOTH actual owning papers before the rich-card filter excludes them.
            for id in requiredBriefingPaperIDs {
                let paper = try frame(id)
                XCTAssertEqual(paper.minX, 16, accuracy: 1)
                XCTAssertEqual(paper.width, width - 32, accuracy: 1)
            }
            let visibleRich = expanded ? richIDs : ["rhythm-rich-0", "rhythm-rich-1", "rhythm-rich-2", "rhythm-rich-same-day"]
            let visibleNew = expanded ? newItems : Array(newItems.prefix(6))
            let cases: [(String, [String])] = [("rich", visibleRich), ("legacy", legacyItems.map(\.id)), ("new", visibleNew.map(\.id))]
            for (kind, ids) in cases {
                for id in ids {
                    let row = try frame("\(kind).row:\(id)")
                    let clock = try frame("\(kind).clock:\(id)")
                    let details = try frame("\(kind).details:\(id)")
                    XCTAssertGreaterThanOrEqual(row.minX, 15); XCTAssertLessThanOrEqual(row.maxX, width - 15)
                    if stacked {
                        XCTAssertEqual(details.minY - clock.maxY, 8, accuracy: 1, "Time-above separation")
                        XCTAssertEqual(clock.minX, details.minX, accuracy: 1)
                    } else {
                        XCTAssertEqual(clock.width, 74, accuracy: 1, "Actual fixed clock allocation")
                        XCTAssertEqual(details.minX - clock.maxX, 12, accuracy: 1)
                    }
                    if kind == "rich", id != "rhythm-rich-same-day" {
                        let join = try frame("rich.join:\(id)")
                        XCTAssertGreaterThanOrEqual(join.width + 1e-6, 44); XCTAssertGreaterThanOrEqual(join.height + 1e-6, 44)
                        let title = try frame("rich.title:\(id)")
                        XCTAssertFalse(title.intersects(join), "Title and actual Join target must not collide")
                    }
                    if kind != "rich" {
                        let paper = try frame(try XCTUnwrap(briefingPaperIDs[kind]))
                        let expectedLeading = paper.minX + expectedPaperInset
                        XCTAssertEqual(row.minX, expectedLeading, accuracy: 1, "Actual owning-paper content rail")
                        XCTAssertLessThanOrEqual(row.width, expectedPaperInnerWidth + 1)
                        XCTAssertLessThanOrEqual(row.maxX, paper.maxX - expectedPaperInset + 1)
                        let title = try frame("\(kind).title:\(id)")
                        XCTAssertEqual(title.minX, expectedLeading + (stacked ? 0 : 74 + 12), accuracy: 1,
                                       "Title retains the owning paper's time/details rail")
                        let previous: CGRect
                        if let location = frames["\(kind).location:\(id)"] {
                            XCTAssertEqual(location.minY - title.maxY, 4, accuracy: 1)
                            if kind == "legacy", size.isAccessibilitySize {
                                XCTAssertGreaterThan(location.height, 44, "Long AX location must grow vertically")
                            }
                            previous = location
                        } else { previous = title }
                        let note = try frame("\(kind).note:\(id)")
                        XCTAssertEqual(note.minY - previous.maxY, 8, accuracy: 1, "Notes keep 8pt even without location")
                    }
                }
            }
            // Actual first-day rows and headers, not duplicated test layouts.
            let first = try frame("rich.row:rhythm-rich-0"), second = try frame("rich.row:rhythm-rich-same-day")
            XCTAssertEqual(second.minY - first.maxY, 16, accuracy: 1)
            let dayPapers = frames.filter { $0.key.hasPrefix("rich.item:day-") }.sorted { $0.value.minY < $1.value.minY }
            XCTAssertEqual(dayPapers.count, expanded ? 6 : 3)
            guard dayPapers.count == (expanded ? 6 : 3) else {
                XCTFail("Missing actual visible day-paper geometry before spacing loops")
                return
            }
            XCTAssertEqual(try XCTUnwrap(dayPapers.first).value.minY, 8, accuracy: 1, "No first-item extra day gap")
            _ = try frame("rich.imminence:rhythm-rich-0")
            if expanded {
                let otherPapers = frames.filter {
                    $0.key.hasPrefix("rich.item:card-") && !requiredBriefingPaperIDs.contains($0.key)
                }.sorted { $0.value.minY < $1.value.minY }
                XCTAssertEqual(otherPapers.count, 1, "Production puts the interleaved non-event input after day groups")
                XCTAssertEqual(try XCTUnwrap(otherPapers.first).value.minY - (try XCTUnwrap(dayPapers.last).value.maxY), 8, accuracy: 1,
                               "A non-event paper keeps the existing8 gap")
            }
            for index in 1..<dayPapers.count where index != 3 {
                XCTAssertEqual(dayPapers[index].value.minY - dayPapers[index - 1].value.maxY, 20, accuracy: 1)
            }
            if expanded {
                XCTAssertGreaterThan(dayPapers[3].value.minY - dayPapers[2].value.maxY, 20,
                                     "The Show more control interrupts adjacency; do not bridge it")
            }
            let richHeadings = frames.filter { $0.key.hasPrefix("rich.heading:") }
            XCTAssertEqual(richHeadings.count, expanded ? 6 : 3, "Every visible day paper must report its heading")
            let requiredRichHeadings = Set(dayPapers.map { "rich.heading:" + String($0.key.dropFirst("rich.item:day-".count)) })
            XCTAssertEqual(Set(richHeadings.keys), requiredRichHeadings)
            // Require all IDs before iterating; missing probes cannot turn the
            // spacing oracle into an empty loop that passes.
            for id in requiredRichHeadings { _ = try frame(id) }
            for paper in dayPapers {
                let headingID = "rich.heading:" + String(paper.key.dropFirst("rich.item:day-".count))
                let heading = try frame(headingID)
                let rows = frames.filter {
                    $0.key.hasPrefix("rich.row:") && $0.value.minY >= heading.maxY - 1 &&
                    $0.value.minY >= paper.value.minY - 1 && $0.value.maxY <= paper.value.maxY + 1
                }.sorted { $0.value.minY < $1.value.minY }
                let firstRow = try XCTUnwrap(rows.first, "Missing first row INSIDE actual day paper: \(paper.key)").value
                XCTAssertEqual(firstRow.minY - heading.maxY, 12, accuracy: 1)
            }
            let expectedGroups = ["legacy": ["Legacy day A", "Legacy day B"],
                                  "new": ["All day", "Timed", "Time unavailable"]]
            for kind in ["legacy", "new"] {
                let names = try XCTUnwrap(expectedGroups[kind])
                let requiredGroupIDs = Set(names.map { "\(kind).group:\($0)" })
                let requiredHeadingIDs = Set(names.map { "\(kind).heading:\($0)" })
                let actualGroupIDs = Set(frames.keys.filter { $0.hasPrefix("\(kind).group:") })
                let actualHeadingIDs = Set(frames.keys.filter { $0.hasPrefix("\(kind).heading:") })
                XCTAssertEqual(actualGroupIDs.count, kind == "legacy" ? 2 : 3)
                XCTAssertEqual(actualHeadingIDs.count, kind == "legacy" ? 2 : 3)
                XCTAssertEqual(actualGroupIDs, requiredGroupIDs)
                XCTAssertEqual(actualHeadingIDs, requiredHeadingIDs)
                for id in requiredGroupIDs.union(requiredHeadingIDs) { _ = try frame(id) }
                let groups = try names.map { try frame("\(kind).group:\($0)") }.sorted { $0.minY < $1.minY }
                for index in 1..<groups.count {
                    XCTAssertEqual(groups[index].minY - groups[index - 1].maxY, 20, accuracy: 1)
                }
                for name in names {
                    let group = try frame("\(kind).group:\(name)")
                    let heading = try frame("\(kind).heading:\(name)")
                    XCTAssertGreaterThanOrEqual(heading.minY, group.minY - 1)
                    XCTAssertLessThanOrEqual(heading.maxY, group.maxY + 1)
                    let rows = frames.filter {
                        $0.key.hasPrefix("\(kind).row:") && $0.value.minY >= heading.maxY - 1 &&
                        $0.value.minY >= group.minY - 1 && $0.value.maxY <= group.maxY + 1
                    }.sorted { $0.value.minY < $1.value.minY }
                    let firstRow = try XCTUnwrap(rows.first, "Missing first row INSIDE actual \(kind) group: \(name)").value
                    XCTAssertEqual(firstRow.minY - heading.maxY, 12, accuracy: 1)
                }
            }
            let legacyA = try frame("legacy.row:rhythm-legacy-0"), legacyB = try frame("legacy.row:rhythm-legacy-1")
            XCTAssertEqual(legacyB.minY - legacyA.maxY, 16, accuracy: 1)
            let newA = try frame("new.row:rhythm-new-2"), newB = try frame("new.row:rhythm-new-3")
            XCTAssertEqual(newB.minY - newA.maxY, 16, accuracy: 1)
            let textSamples = recorder.textSamples
            let expectedClockIDs = Set(legacyItems.flatMap { ["legacy.clock.start:\($0.id)", "legacy.clock.end:\($0.id)"] })
            XCTAssertEqual(Set(textSamples.keys), expectedClockIDs, "Both source identities must draw; missing samples cannot pass")
            for item in legacyItems {
                let timeParts = item.time.components(separatedBy: " – ")
                let expectedLabels = [("start", timeParts.first ?? item.time),
                                      ("end", timeParts.dropFirst().joined(separator: " – "))]
                for (part, expectedText) in expectedLabels {
                    let id = "legacy.clock.\(part):\(item.id)"
                    let sample = try XCTUnwrap(textSamples[id], "Missing actual native TextRenderer receipt: \(id)")
                    let allocated = try frame(id)
                    XCTAssertEqual(sample.sourceText, expectedText, "Receipt must belong to the exact fixture clock source")
                    XCTAssertFalse(sample.isTruncated, "Native clock Text layout truncated: \(id)")
                    XCTAssertFalse(sample.lineBounds.isEmpty); XCTAssertFalse(sample.runBounds.isEmpty)
                    if !stacked && part == "end" {
                        XCTAssertGreaterThan(sample.lineBounds.count, 1, "Wide74 clock must wrap the full end time/timezone")
                    }
                    for nativeBounds in sample.lineBounds + sample.runBounds {
                        XCTAssertTrue(nativeBounds.minX.isFinite && nativeBounds.minY.isFinite &&
                                      nativeBounds.width.isFinite && nativeBounds.height.isFinite)
                        XCTAssertGreaterThan(nativeBounds.width, 0); XCTAssertGreaterThan(nativeBounds.height, 0)
                        // Preserve raw native local coordinates; no min/span normalization or clamping.
                        XCTAssertGreaterThanOrEqual(nativeBounds.minX, -1)
                        XCTAssertGreaterThanOrEqual(nativeBounds.minY, -1)
                        XCTAssertLessThanOrEqual(nativeBounds.maxX, allocated.width + 1)
                        XCTAssertLessThanOrEqual(nativeBounds.maxY, allocated.height + 1)
                    }
                }
            }
            func rawBounds(_ rect: CGRect) -> [String: CGFloat] {
                ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
            }
            let nativeTextReceipt = textSamples.keys.sorted().map { id -> [String: Any] in
                let sample = textSamples[id]!
                return ["id": id, "sourceText": sample.sourceText, "isTruncated": sample.isTruncated,
                        "lineCount": sample.lineBounds.count, "lineBounds": sample.lineBounds.map(rawBounds),
                        "runBounds": sample.runBounds.map(rawBounds)]
            }
            let receipt = frames.keys.sorted().map { id -> [String: Any] in
                let rect = frames[id]!
                return ["id": id, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
            }
            try eventLedger.check("painted receipt serialization")
            let data = try JSONSerialization.data(withJSONObject: ["scheme": scheme == .light ? "light" : "dark", "viewport": width, "inheritedViewport": inheritedWidth.map { $0 as Any } ?? NSNull(),
                "accessibility": size.isAccessibilitySize, "expanded": expanded, "stacked": stacked, "paintedBounds": receipt,
                "briefingPaperHorizontalInset": expectedPaperInset, "briefingPaperInnerWidth": expectedPaperInnerWidth,
                "nativeClockText": nativeTextReceipt,
                "reviewLimits": "Native TextRenderer reports truncation and raw line/run typographic bounds, not terminal Unicode/source-character or pixel-ink coverage. Public CharacterIndex has no validated terminal String mapping. Original PNG review MUST confirm the full time and Pacific Time suffix; VoiceOver reading/focus order also remains unproved."], options: [.prettyPrinted, .sortedKeys])
            try eventLedger.check("painted receipt serialization completed")
            try eventLedger.allowJSON(data.count)
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "event-rhythm-\(scheme == .light ? "light" : "dark")-\(Int(width))-\(size.isAccessibilitySize ? "AX3" : "large")-\(inheritedWidth == nil ? "missing" : "known")-\(expanded ? "expanded" : "collapsed")-painted-bounds"
            attachment.lifetime = .keepAlways; add(attachment)
            try eventLedger.check("painted receipt attachment completed")
        }
        for width in [CGFloat(320), 360, 390, 430] {
            for size in [DynamicTypeSize.large, .accessibility3] {
                try eventLedger.beginCase(self)
                let recorder = EventRhythmFrameRecorder()
                try await capture(reviewPage(recorder, width: width, expanded: true), scheme: .light, size: size,
                                  scene: scene, model: model, requiresScrolling: true, viewportWidth: width, eventCapturePolicy: eventLedger)
                try verify(recorder, width: width, size: size, inheritedWidth: width, expanded: true)
            }
        }
        for size in [DynamicTypeSize.large, .accessibility3] {
            try eventLedger.beginCase(self)
            let recorder = EventRhythmFrameRecorder()
            try await capture(reviewPage(recorder, width: nil, expanded: true), scheme: .light, size: size,
                              scene: scene, model: model, requiresScrolling: true, viewportWidth: 390, eventCapturePolicy: eventLedger)
            try verify(recorder, width: 390, size: size, inheritedWidth: nil, expanded: true)
        }
        try eventLedger.beginCase(self)
        let collapsed = EventRhythmFrameRecorder()
        try await capture(reviewPage(collapsed, width: 390, expanded: false), scheme: .light, size: .large,
                          scene: scene, model: model, requiresScrolling: true, viewportWidth: 390, eventCapturePolicy: eventLedger)
        try verify(collapsed, width: 390, size: .large, inheritedWidth: 390, expanded: false)
        for (width, size) in [(CGFloat(390), DynamicTypeSize.large), (CGFloat(320), .accessibility3)] {
            try eventLedger.beginCase(self)
            let recorder = EventRhythmFrameRecorder()
            try await capture(reviewPage(recorder, width: width, expanded: true), scheme: .dark, size: size,
                              scene: scene, model: model, requiresScrolling: true, viewportWidth: width, eventCapturePolicy: eventLedger)
            try verify(recorder, width: width, size: size, inheritedWidth: width, expanded: true, scheme: .dark)
        }
        XCTAssertEqual(eventLedger.ordinal, 13, "All thirteen existing event cases share one ledger")
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
        } catch {
            if !eventLedger.minimalEmitted { eventLedger.emitMinimal(self, reason: String(describing: error)) }
            throw error
        }
    }

#endif

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

    @MainActor private final class ConnectedToolCaptureLedger {
        struct Stop: Error { let reason: String }
        let started = ContinuousClock.now
        let test: NativeVisualReviewTests
        let initialFailures: Int
        var caseStart = ContinuousClock.now
        var seen: Set<String> = []
        var completed: Set<String> = []
        var photographed: Set<String> = []
        var perCasePNG: [String: Int] = [:]
        var pngCount = 0
        var retainedBytes = 0
        var attemptedPNGBytes = 0
        static let byteLimit = 80 * 1024 * 1024
        static let reserve = 4096
        static func key(_ name: String, scheme: ColorScheme, size: DynamicTypeSize, width: CGFloat) -> String {
            "\(name)|\(scheme == .light ? "light" : "dark")|\(size.isAccessibilitySize ? "accessibility3" : "large")|\(Int(width))"
        }
        static var expected: Set<String> {
            var result: Set<String> = [
                "connected-tools-production-get-fixture|light|large|393",
                "connected-tools-production-get-fixture-dark|dark|large|393",
                "connected-tools-remove-initially-armed-layout-only|light|large|393",
                "skills-compact-accessibility|light|accessibility3|320"
            ]
            for width in [320, 360, 390, 393, 430] {
                for state in ["pause", "enable", "working", "disabled"] {
                    result.insert("connected-tools-\(state)-\(width)|light|large|\(width)")
                }
            }
            for width in [320, 393] {
                for state in ["pause", "enable", "working", "disabled"] {
                    result.insert("connected-tools-\(state)-dark-\(width)|dark|large|\(width)")
                }
            }
            for width in [320, 360] {
                for scheme in ["light", "dark"] {
                    result.insert("connected-tools-accessible-\(width)|\(scheme)|accessibility3|\(width)")
                }
            }
            return result
        }
        // Four exact Design-selected tuples share one screenshot/byte budget.
        static let selected: Set<String> = [
            "connected-tools-production-get-fixture|light|large|393",
            "connected-tools-pause-dark-320|dark|large|320",
            "connected-tools-accessible-320|light|accessibility3|320",
            "skills-compact-accessibility|light|accessibility3|320"
        ]
        init(test: NativeVisualReviewTests) {
            self.test = test
            initialFailures = test.testRun?.failureCount ?? 0
        }
        func check(_ operation: String) throws {
            guard started.duration(to: ContinuousClock.now) < .seconds(360),
                  (seen.isEmpty || caseStart.duration(to: ContinuousClock.now) < .seconds(8)) else {
                throw Stop(reason: "wall-cap: " + operation)
            }
            guard (test.testRun?.failureCount ?? 0) == initialFailures else {
                throw Stop(reason: "preceding-geometry-assertion-failed")
            }
        }
        func begin(_ key: String) throws {
            try check("before case")
            guard Self.expected.contains(key), seen.insert(key).inserted else {
                throw Stop(reason: "unknown-or-duplicate-tuple: " + key)
            }
            caseStart = ContinuousClock.now
        }
        func attachJSON(_ object: [String: Any], name: String, test: NativeVisualReviewTests) throws {
            let data = try JSONSerialization.data(withJSONObject: EventCaptureLedger.safe(object), options: [.sortedKeys])
            guard data.count <= 1024 * 1024, retainedBytes + data.count <= Self.byteLimit - Self.reserve else {
                throw Stop(reason: "JSON-or-method-aggregate-cap")
            }
            try check("before JSON")
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = name; attachment.lifetime = .keepAlways; test.add(attachment)
            retainedBytes += data.count
            try check("after JSON")
        }
        func capturePNG(_ window: UIWindow, key: String, position: String, test: NativeVisualReviewTests) throws {
            guard Self.selected.contains(key) else { return }
            try check("before PNG")
            guard pngCount < 8, perCasePNG[key, default: 0] < 2 else { throw Stop(reason: "PNG-count-cap") }
            var rendered = false
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            guard rendered, let png = image.pngData() else { throw Stop(reason: "PNG-render-failed") }
            attemptedPNGBytes += png.count
            try check("after PNG encoding")
            guard png.count > 15_000, png.count <= 8 * 1024 * 1024,
                  retainedBytes + png.count <= Self.byteLimit - Self.reserve else { throw Stop(reason: "PNG-bytes-or-method-cap") }
            let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
            attachment.name = "\(key)-\(position)"; attachment.lifetime = .keepAlways; test.add(attachment)
            pngCount += 1; perCasePNG[key, default: 0] += 1; retainedBytes += png.count
            photographed.insert(key)
            try check("after PNG attachment")
        }
        func complete(_ key: String, steps: Int, test: NativeVisualReviewTests) throws {
            try check("case completed")
            guard completed.insert(key).inserted else { throw Stop(reason: "duplicate-completion") }
            try attachJSON(["case": key, "status": "geometry-mounted", "scrollSteps": steps,
                            "screenshotSelected": Self.selected.contains(key), "retainedPNGCount": perCasePNG[key, default: 0]],
                           name: "connected-tools-case-\(completed.count)", test: test)
        }
        func finish(_ test: NativeVisualReviewTests) {
            do {
                try check("method finished")
                guard Self.expected.count == 36, completed == Self.expected, seen == Self.expected,
                      photographed == Self.selected, Self.selected.count == 4 else { throw Stop(reason: "missing-or-extra-tuple") }
                try attachJSON(["status": "all-35-tools-plus-1-skills-cases-returned", "caseCount": completed.count,
                                "selectedTuples": Self.selected.sorted(), "PNGCount": pngCount,
                                "skillsRetiredExpansion": "Not activated: actual default Skills page only; no supported public fixture action to expand retired disclosure was exercised",
                                "retainedEncodedBytesBeforeReceipt": retainedBytes,
                                "limit": "Encoded PNG+JSON attachments only; xcresult container overhead is not measured here"],
                               name: "connected-tools-method-ledger", test: test)
            } catch {
                let object: [String: Any] = ["status": "STOP", "reason": String(describing: error).prefix(512).description,
                    "seenCount": seen.count, "completedCount": completed.count,
                    "missingTuples": Self.expected.subtracting(completed).sorted(),
                    "PNGCount": pngCount, "retainedBytes": retainedBytes, "attemptedPNGBytes": attemptedPNGBytes]
                let full = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
                let fallback = Data("{\"status\":\"STOP\",\"reason\":\"minimal-receipt-fallback\",\"fullRawTraceRetained\":false}".utf8)
                let data = full.flatMap { $0.count <= Self.reserve ? $0 : nil } ?? fallback
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                attachment.name = "connected-tools-STOP"; attachment.lifetime = .keepAlways; test.add(attachment)
                XCTFail("Connected-tools bounded fixture STOP: \(error)")
            }
        }
    }

    @MainActor
    func testConnectedToolActionRowPaintedTargetsAcrossResponsiveStates() async throws {
        let ledger = ConnectedToolCaptureLedger(test: self)
        defer { ledger.finish(self) }
        func captureBounded(_ page: Page, scheme: ColorScheme, size: DynamicTypeSize,
                            scene: UIWindowScene, model: AppModel, viewportWidth: CGFloat,
                            layoutReporter: (@MainActor ([String: CGRect]) -> Void)? = nil) async throws {
            let key = ConnectedToolCaptureLedger.key(page.name, scheme: scheme, size: size, width: viewportWidth)
            try ledger.begin(key)
            let previousWindow = scene.keyWindow
            let oldAppearance = UserDefaults.standard.string(forKey: AssistantAppearance.defaultsKey)
            let window = UIWindow(windowScene: scene)
            window.frame = scene.coordinateSpace.bounds
            window.frame.size.width = viewportWidth
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            let host = UIHostingController(rootView: Group {
                if page.ownsNavigation { page.content }
                else {
                    NavigationStack(path: .constant(["review"])) {
                        Color.clear.navigationTitle("Assistant")
                            .navigationDestination(for: String.self) { _ in page.content }
                    }
                }
            }.environment(model).environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
                .environment(\.scenePhase, .active)
                .transaction { $0.animation = nil; $0.disablesAnimations = true })
            var selected: UIScrollView?
            var originalOffset: CGPoint?
            defer {
                if let selected, let originalOffset { selected.setContentOffset(originalOffset, animated: false) }
                window.isHidden = true
                window.rootViewController = nil
                previousWindow?.makeKey()
                if let oldAppearance { UserDefaults.standard.set(oldAppearance, forKey: AssistantAppearance.defaultsKey) }
                else { UserDefaults.standard.removeObject(forKey: AssistantAppearance.defaultsKey) }
            }
            try ledger.check("window setup")
            window.rootViewController = host
            window.makeKeyAndVisible()
            var previousSize: CGSize?
            var stable = 0
            for _ in 0..<40 {
                try ledger.check("bounded settle")
                try await Task.sleep(for: .milliseconds(50))
                window.layoutIfNeeded()
                let current = host.view.systemLayoutSizeFitting(window.bounds.size)
                stable = current == previousSize ? stable + 1 : 0
                previousSize = current
                if stable >= 3 { break }
            }
            guard stable >= 3 else { throw ConnectedToolCaptureLedger.Stop(reason: "settle-step-cap") }
            layoutReporter?(["window.bounds": window.bounds,
                             "window.safe-area.available": window.safeAreaLayoutGuide.layoutFrame])
            try ledger.capturePNG(window, key: key, position: "top", test: self)
            func scrollViews(_ view: UIView) -> [UIScrollView] {
                ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews)
            }
            selected = scrollViews(window).filter {
                $0.bounds.width >= window.bounds.width * 0.7 && $0.bounds.height >= window.bounds.height * 0.35 &&
                $0.contentSize.height > $0.bounds.height - $0.adjustedContentInset.top - $0.adjustedContentInset.bottom + 2
            }.max { $0.bounds.height < $1.bounds.height }
            var steps = 0
            if let scroll = selected {
                originalOffset = scroll.contentOffset
                for _ in 0..<8 {
                    try ledger.check("bounded scroll")
                    let bottom = max(-scroll.adjustedContentInset.top,
                        scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                    if scroll.contentOffset.y >= bottom - 2 { break }
                    let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
                    guard viewport.isFinite && viewport > 0 && bottom.isFinite else {
                        throw ConnectedToolCaptureLedger.Stop(reason: "invalid-scroll-geometry")
                    }
                    scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x,
                        y: min(bottom, scroll.contentOffset.y + viewport * 0.72)), animated: false)
                    try await Task.sleep(for: .milliseconds(130))
                    window.layoutIfNeeded()
                    steps += 1
                }
                let bottom = max(-scroll.adjustedContentInset.top,
                    scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                guard bottom.isFinite && scroll.contentOffset.y >= bottom - 2 else {
                    throw ConnectedToolCaptureLedger.Stop(reason: "scroll-step-cap-or-incomplete")
                }
                if steps > 0 { try ledger.capturePNG(window, key: key, position: "bottom", test: self) }
            }
            try ledger.complete(key, steps: steps, test: self)
        }
        let connection = McpConnection(
            id: "review-tool-server",
            name: "Home Assistant",
            endpoint: "https://home.example.test/mcp",
            status: "ready",
            enabled: true,
            hasBearerToken: false,
            serverName: "Home Assistant",
            serverVersion: "1.2",
            instructions: nil,
            tools: [McpConnectionTool(name: "get_lights", description: "Read lights", inputSchema: .object([:]))],
            lastCheckedAt: "2026-10-23T18:00:00Z",
            lastError: nil
        )
        let fixture = try NativeReviewFixture()
        var responses = fixture.responses
        responses["/api/mobile/v1/mcp"] = try JSONEncoder().encode(McpConnectionsResponse(connections: [connection]))
        NativeReviewProtocol.install(responses)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(
            configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
            session: URLSession(configuration: configuration)
        )
        let suite = "assistant.connected-tools-action-geometry-review"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let model = AppModel(apiClient: client, defaults: defaults)
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        _ = await model.refreshMcpConnections()
        let workspace = try XCTUnwrap(model.workspace)
        XCTAssertEqual(model.mcpConnections.map(\.id), [connection.id])

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let productionScreen = try XCTUnwrap(MoreView.visualReviewScreen("connected-tools", workspace: workspace))
        try await captureBounded(
            Page("connected-tools-production-get-fixture", productionScreen),
            scheme: .light,
            size: .large,
            scene: scene,
            model: model,
            viewportWidth: 393
        )
        try await captureBounded(
            Page("connected-tools-production-get-fixture-dark", productionScreen),
            scheme: .dark,
            size: .large,
            scene: scene,
            model: model,
            viewportWidth: 393
        )

        struct RowState {
            let name: String
            let enabled: Bool
            let working: Bool
            let disabled: Bool
        }
        let states = [
            RowState(name: "pause", enabled: true, working: false, disabled: false),
            RowState(name: "enable", enabled: false, working: false, disabled: false),
            RowState(name: "working", enabled: true, working: true, disabled: false),
            RowState(name: "disabled", enabled: false, working: false, disabled: true)
        ]
        let widths: [CGFloat] = [320, 360, 390, 393, 430]
        var baselineSizes: [String: [String: CGSize]] = [:]

        func makeConnection(enabled: Bool) -> McpConnection {
            McpConnection(
                id: connection.id,
                name: connection.name,
                endpoint: connection.endpoint,
                status: connection.status,
                enabled: enabled,
                hasBearerToken: connection.hasBearerToken,
                serverName: connection.serverName,
                serverVersion: connection.serverVersion,
                instructions: connection.instructions,
                tools: connection.tools,
                lastCheckedAt: connection.lastCheckedAt,
                lastError: connection.lastError
            )
        }

        func assertPaintedLayout(_ frames: [String: CGRect], width: CGFloat, isAccessibility: Bool) throws {
            let safeArea = try XCTUnwrap(frames["window.safe-area.available"], "Missing actual UIWindow safe-area frame")
            let window = try XCTUnwrap(frames["window.bounds"], "Missing actual UIWindow bounds")
            let card = try XCTUnwrap(frames["card.surface"], "Missing painted assistant-card bounds")
            let row = try XCTUnwrap(frames["row.container"], "Missing actual connected-tool row bounds")
            func contains(_ outer: CGRect, _ inner: CGRect, tolerance: CGFloat = 1) -> Bool {
                inner.minX >= outer.minX - tolerance && inner.minY >= outer.minY - tolerance &&
                    inner.maxX <= outer.maxX + tolerance && inner.maxY <= outer.maxY + tolerance
            }
            XCTAssertTrue(contains(window, safeArea), "The safe-area frame must be inside the actual window.")
            XCTAssertTrue(contains(safeArea, card), "The painted card must stay inside the available safe-area frame.")
            XCTAssertTrue(contains(card, row), "The action row must stay inside its painted card.")

            for id in ["refresh", "toggle", "remove"] {
                let surface = try XCTUnwrap(frames["\(id).button"], "Missing painted action surface for \(id)")
                let group = try XCTUnwrap(frames["\(id).group"], "Missing visible icon-label group for \(id)")
                let glyph = try XCTUnwrap(frames["\(id).glyph"], "Missing visible icon slot for \(id)")
                let text = try XCTUnwrap(frames["\(id).text"], "Missing visible text for \(id)")
                XCTAssertTrue(surface.minX.isFinite && surface.minY.isFinite && surface.width.isFinite && surface.height.isFinite)
                XCTAssertGreaterThanOrEqual(surface.height, 48, "The connected-tool target must retain its 48pt baseline; Dynamic Type may grow it.")
                XCTAssertGreaterThanOrEqual(group.minX, surface.minX - 1)
                XCTAssertLessThanOrEqual(group.maxX, surface.maxX + 1)
                XCTAssertGreaterThanOrEqual(group.minY, surface.minY - 1)
                XCTAssertLessThanOrEqual(group.maxY, surface.maxY + 1)
                XCTAssertTrue(contains(row, surface), "The \(id) painted target overflowed its actual row.")
                XCTAssertTrue(contains(card, surface), "The \(id) painted target overflowed its card.")
                XCTAssertTrue(contains(safeArea, surface), "The \(id) painted target overflowed the available safe area.")
                XCTAssertTrue(contains(window, surface), "The \(id) painted target overflowed the actual window.")
                XCTAssertEqual(group.midX, surface.midX, accuracy: 1, "The complete visible label group must be centered.")
                XCTAssertGreaterThanOrEqual(text.minX - glyph.maxX, 8 - 1, "The scaled gap must stay outside the intrinsic glyph slot.")
                for symbol in AssistantIntrinsicActionGlyph.reservedSymbols + ["spinner"] {
                    let intrinsic = try XCTUnwrap(frames["\(id).intrinsic.\(symbol)"], "Missing uncompressed intrinsic extent for \(id)/\(symbol)")
                    XCTAssertGreaterThan(intrinsic.width, 0)
                    XCTAssertTrue(contains(glyph, intrinsic), "The symbol slot must contain every uncompressed state at the inherited Dynamic Type size.")
                    XCTAssertGreaterThanOrEqual(text.minX - intrinsic.maxX, 8 - 1, "No intrinsic symbol state may enter the label gap.")
                }
                XCTAssertEqual(text.midY, glyph.midY, accuracy: 1)
            }

            let refresh = frames["refresh.button"]!
            let toggle = frames["toggle.button"]!
            let remove = frames["remove.button"]!
            XCTAssertEqual(refresh.width, toggle.width, accuracy: 1)
            XCTAssertEqual(toggle.width, remove.width, accuracy: 1)
            XCTAssertEqual(refresh.height, toggle.height, accuracy: 1)
            XCTAssertEqual(toggle.height, remove.height, accuracy: 1)

            let horizontal = abs(refresh.midY - toggle.midY) < 1 && abs(toggle.midY - remove.midY) < 1
            if width <= 360 || isAccessibility {
                XCTAssertFalse(horizontal, "Narrow and Accessibility layouts must stack the complete controls.")
                XCTAssertEqual(refresh.minX, toggle.minX, accuracy: 1)
                XCTAssertEqual(toggle.minX, remove.minX, accuracy: 1)
            } else if horizontal {
                XCTAssertEqual(toggle.minX - refresh.maxX, 8, accuracy: 1)
                XCTAssertEqual(remove.minX - toggle.maxX, 8, accuracy: 1)
            } else {
                XCTAssertEqual(refresh.minX, toggle.minX, accuracy: 1)
                XCTAssertEqual(toggle.minX, remove.minX, accuracy: 1)
                XCTAssertEqual(toggle.minY - refresh.maxY, 8, accuracy: 1)
                XCTAssertEqual(remove.minY - toggle.maxY, 8, accuracy: 1)
            }
        }

        func captureRow(_ row: ConnectedToolActionRow, name: String, scheme: ColorScheme, size: DynamicTypeSize,
                        width: CGFloat, recorder: ConnectedToolActionLayoutRecorder) async throws {
            try await captureBounded(
                Page(name, ownsNavigation: true,
                     ConnectedToolsActionRowReviewCard(row: row, layoutReporter: { recorder.record($0) })),
                scheme: scheme,
                size: size,
                scene: scene,
                model: model,
                viewportWidth: width,
                layoutReporter: { recorder.record($0) }
            )
        }

        for width in widths {
            for state in states {
                let recorder = ConnectedToolActionLayoutRecorder()
                let row = ConnectedToolActionRow(
                    connection: makeConnection(enabled: state.enabled),
                    viewportWidth: width,
                    usesAccessibilityLayout: false,
                    working: state.working,
                    disabled: state.disabled,
                    onAction: { _ in XCTFail("The visual fixture must not run connected-tool actions.") },
                    onRemove: { XCTFail("The visual fixture must not remove a connection.") },
                    layoutReporter: { recorder.record($0) },
                    confirmationLabelReporter: { recorder.confirmationLabels.append($0) }
                )
                try await captureRow(row, name: "connected-tools-\(state.name)-\(Int(width))",
                                     scheme: .light, size: .large, width: width, recorder: recorder)
                try assertPaintedLayout(recorder.frames, width: width, isAccessibility: false)
                XCTAssertEqual(recorder.confirmationLabels.first, "Remove")

                let signature = "\(Int(width))-large"
                let currentSizes = Dictionary(uniqueKeysWithValues: ["refresh", "toggle", "remove"].map { id in
                    (id, recorder.frames["\(id).button"]!.size)
                })
                if state.name == "pause" {
                    baselineSizes[signature] = currentSizes
                } else if let baseline = baselineSizes[signature] {
                    for id in ["refresh", "toggle", "remove"] {
                        XCTAssertEqual(currentSizes[id]!.width, baseline[id]!.width, accuracy: 1,
                                       "Label or working state changed the reserved width of \(id).")
                        XCTAssertEqual(currentSizes[id]!.height, baseline[id]!.height, accuracy: 1,
                                       "Label or working state changed the reserved height of \(id).")
                    }
                }
            }
        }

        for width in [CGFloat(320), 393] {
            for state in states {
                let recorder = ConnectedToolActionLayoutRecorder()
                let row = ConnectedToolActionRow(
                    connection: makeConnection(enabled: state.enabled),
                    viewportWidth: width,
                    usesAccessibilityLayout: false,
                    working: state.working,
                    disabled: state.disabled,
                    onAction: { _ in XCTFail("The dark visual fixture must not run connected-tool actions.") },
                    onRemove: { XCTFail("The dark visual fixture must not remove a connection.") },
                    layoutReporter: { recorder.record($0) }
                )
                try await captureRow(row, name: "connected-tools-\(state.name)-dark-\(Int(width))",
                                     scheme: .dark, size: .large, width: width, recorder: recorder)
                try assertPaintedLayout(recorder.frames, width: width, isAccessibility: false)
            }
        }

        for width in [CGFloat(320), 360] {
            for scheme in [ColorScheme.light, .dark] {
                let recorder = ConnectedToolActionLayoutRecorder()
                let row = ConnectedToolActionRow(
                    connection: connection,
                    viewportWidth: width,
                    usesAccessibilityLayout: true,
                    working: false,
                    disabled: false,
                    onAction: { _ in XCTFail("The accessibility visual fixture must not run actions.") },
                    onRemove: { XCTFail("The accessibility visual fixture must not remove a connection.") },
                    layoutReporter: { recorder.record($0) }
                )
                try await captureRow(row, name: "connected-tools-accessible-\(Int(width))",
                                     scheme: scheme, size: .accessibility3, width: width, recorder: recorder)
                try assertPaintedLayout(recorder.frames, width: width, isAccessibility: true)
                if let regular = baselineSizes["\(Int(width))-large"] {
                    for id in ["refresh", "toggle", "remove"] {
                        XCTAssertGreaterThanOrEqual(recorder.frames["\(id).button"]!.height, regular[id]!.height)
                    }
                }
            }
        }

        let armRecorder = ConnectedToolActionLayoutRecorder()
        let callbacks = ConnectedToolReviewCallbacks()
        // Layout-only fixture: seed the actual production button's initial
        // @State and render its real armed branch. No activation is attempted.
        // Tap/AX arming and VoiceOver delivery remain UNVERIFIED manual follow-up.
        let armedRow = ConnectedToolActionRow(
            connection: connection,
            viewportWidth: 393,
            usesAccessibilityLayout: false,
            working: false,
            disabled: false,
            onAction: { callbacks.actions.append($0) },
            onRemove: { callbacks.removals += 1 },
            layoutReporter: { armRecorder.record($0) },
            initiallyArmedForLayoutReview: true,
            confirmationLabelReporter: { armRecorder.confirmationLabels.append($0) }
        )
        try await captureBounded(
            Page("connected-tools-remove-initially-armed-layout-only", ownsNavigation: true,
                 ConnectedToolsActionRowReviewCard(row: armedRow, layoutReporter: { armRecorder.record($0) })),
            scheme: .light,
            size: .large,
            scene: scene,
            model: model,
            viewportWidth: 393,
            layoutReporter: { armRecorder.record($0) }
        )
        // This is the same value supplied to the actual accessibilityLabel
        // modifier; observing it does not prove VoiceOver delivered the label.
        XCTAssertEqual(armRecorder.confirmationLabels.first, "Confirm remove")
        XCTAssertEqual(callbacks.actions, [])
        XCTAssertEqual(callbacks.removals, 0, "Mounting an initially armed layout fixture must not execute removal.")
        try assertPaintedLayout(armRecorder.frames, width: 393, isAccessibility: false)
        let resting393 = try XCTUnwrap(baselineSizes["393-large"])
        for id in ["refresh", "toggle", "remove"] {
            let armedSurface = try XCTUnwrap(armRecorder.frames["\(id).button"])
            XCTAssertEqual(armedSurface.width, resting393[id]!.width, accuracy: 1,
                           "Arming Remove must not grow the \(id) surface width.")
            XCTAssertEqual(armedSurface.height, resting393[id]!.height, accuracy: 1,
                           "Arming Remove must not grow the \(id) surface height.")
        }

        // Actual Skills composition shares the same four-case screenshot budget.
        // Retired remains in its real default state: no private expansion injection.
        try await captureBounded(
            Page("skills-compact-accessibility", WorkspaceView(area: .skills)),
            scheme: .light, size: .accessibility3, scene: scene, model: model, viewportWidth: 320
        )
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty, "No write request may be sent by a visual review fixture.")
    }

    @MainActor
    func testCostsCoverageNoticeAndSourceGapsInCompactAndAccessibleLayouts() async throws {
        let fixture = try NativeReviewFixture()
        var responses = fixture.responses
        let workspacePath = "/api/mobile/v1/workspace"
        var workspace = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(responses[workspacePath])) as? [String: Any])
        var costs = try XCTUnwrap(workspace["costs"] as? [String: Any])
        costs["billing"] = [
            [
                "id": "google-cloud",
                "label": "Google Cloud",
                "status": "reported",
                "period": "2026-10",
                "scope": "Project: assistant",
                "source": "Cloud Billing export",
                "message": "Latest usage is not a completeness guarantee.",
                "fetchedAt": "2026-10-22T08:00:00Z",
                "latestExportAt": "2026-10-21T03:00:00Z",
                "latestUsageAt": "2026-10-20T00:00:00Z",
                "lines": [
                    ["service": "Cloud Run", "detail": "regional compute", "currency": "USD", "cost": 12.0, "credits": -3.0, "net": 9.0],
                    ["service": "Vertex AI", "detail": "project model usage", "currency": "USD", "cost": 3.0, "credits": 0.0, "net": 3.0],
                    ["service": "Cloud Storage", "detail": "regional storage", "currency": "EUR", "cost": 4.0, "credits": 0.0, "net": 4.0]
                ],
                "forecast": [
                    "through": "2026-10-20T00:00:00Z",
                    "observedDays": 19.0,
                    "daysInMonth": 31.0,
                    "totals": [
                        ["currency": "USD", "spent": 12.0, "dailyAverage": 0.63, "projected": 19.58],
                        ["currency": "EUR", "spent": 4.0, "dailyAverage": 0.21, "projected": 6.53]
                    ],
                    "message": "Run rate assumes similar use; not an invoice forecast."
                ]
            ],
            [
                "id": "openrouter",
                "label": "OpenRouter",
                "status": "stale",
                "period": "2026-10",
                "scope": "Connected API key",
                "source": "Provider key endpoint",
                "message": "Stale snapshot; usage for this key may include other apps.",
                "fetchedAt": "2026-10-22T08:00:00Z",
                "latestExportAt": "2026-10-21T03:00:00Z",
                "latestUsageAt": "2026-10-20T00:00:00Z",
                "lines": [["service": "Key usage", "detail": "reported monthly spend", "currency": "USD", "cost": 0.0004, "credits": 0.0, "net": 0.0004]]
            ],
            [
                "id": "vertex",
                "label": "Google Vertex AI",
                "status": "included",
                "period": "2026-10",
                "scope": "Project: assistant",
                "source": "Google Cloud export",
                "message": "Matching project usage is included above.",
                "fetchedAt": NSNull(),
                "lines": [],
                "includedIn": "google-cloud"
            ]
        ]
        costs["billingCoverage"] = [
            "totalState": "unavailable",
            "title": "Whole-app total unavailable",
            "summary": "The sources below cover different accounts, projects and usage. Their amounts are not combined, and missing coverage is unknown rather than zero.",
            "statusSummary": "Current feeds: OpenRouter stale. Missing costs remain unknown, not zero.",
            "overlapWarning": "Assistant usage-ledger amounts may overlap provider bills. Keep them separate; assistant spending limits do not cap provider or cloud bills.",
            "entries": [
                ["id": "google-cloud", "label": "Google Cloud", "state": "partial", "scope": "Project: assistant", "detail": "Latest usage is not a completeness guarantee.", "period": "2026-10", "source": "Cloud Billing export"],
                ["id": "openrouter", "label": "OpenRouter", "state": "stale", "scope": "Connected API key", "detail": "Stale snapshot; usage for this key may include other apps.", "period": "2026-10", "source": "Provider key endpoint"]
            ]
        ]
        workspace["costs"] = costs
        responses[workspacePath] = try JSONSerialization.data(withJSONObject: workspace)
        NativeReviewProtocol.install(responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeReviewProtocol.self]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"),
                               session: URLSession(configuration: configuration))
        let suite = "assistant.cost-coverage-visual-review"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let model = AppModel(apiClient: client, defaults: defaults)
        await model.refreshAll()
        _ = await model.refreshWorkspace()
        XCTAssertEqual(model.workspace?.costs.billing?.count, 3)
        let googleReport = model.workspace?.costs.billing?.first(where: { $0.id == "google-cloud" })
        XCTAssertEqual(googleReport?.status, "reported")
        XCTAssertNotNil(googleReport?.forecast)
        XCTAssertTrue(googleReport?.lines.contains(where: { $0.service == "Vertex AI" }) == true)
        let openRouterReport = model.workspace?.costs.billing?.first(where: { $0.id == "openrouter" })
        XCTAssertEqual(openRouterReport?.status, "stale")
        XCTAssertEqual(openRouterReport?.lines.first?.net, 0.0004)
        XCTAssertNil(openRouterReport?.forecast)
        XCTAssertEqual(model.workspace?.costs.billing?.first(where: { $0.id == "vertex" })?.includedIn, "google-cloud")
        XCTAssertEqual(model.workspace?.costs.billingCoverage?.statusSummary, "Current feeds: OpenRouter stale. Missing costs remain unknown, not zero.")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let page = Page("cost-coverage", WorkspaceView(area: .costs))
        try await capture(page, scheme: .light, size: .large, scene: scene, model: model, viewportWidth: 320)
        try await capture(page, scheme: .dark, size: .large, scene: scene, model: model, viewportWidth: 320)
        try await capture(page, scheme: .light, size: .accessibility3, scene: scene, model: model, viewportWidth: 320)

        var setupWorkspace = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(responses[workspacePath])) as? [String: Any])
        var setupCosts = try XCTUnwrap(setupWorkspace["costs"] as? [String: Any])
        setupCosts["billing"] = [[
            "id": "google-cloud",
            "label": "Google Cloud",
            "status": "not_configured",
            "period": "2026-10",
            "scope": "Project: assistant",
            "source": "Cloud Billing export",
            "message": "Connect a Cloud Billing BigQuery export to see Google Cloud costs.",
            "fetchedAt": NSNull(),
            "latestExportAt": NSNull(),
            "latestUsageAt": NSNull(),
            "lines": []
        ]]
        setupCosts["billingCoverage"] = [
            "totalState": "unavailable",
            "title": "Whole-app total unavailable",
            "summary": "The sources below cover different accounts, projects and usage. Their amounts are not combined.",
            "statusSummary": "Current feeds: Google Cloud not configured. Missing costs remain unknown, not zero.",
            "overlapWarning": "Assistant usage-ledger amounts may overlap provider bills.",
            "entries": []
        ]
        setupWorkspace["costs"] = setupCosts
        responses[workspacePath] = try JSONSerialization.data(withJSONObject: setupWorkspace)
        NativeReviewProtocol.install(responses)
        _ = await model.refreshWorkspace()
        XCTAssertEqual(model.workspace?.costs.billing?.count, 1)
        XCTAssertEqual(model.workspace?.costs.billing?.first?.status, "not_configured")
        XCTAssertEqual(model.workspace?.costs.billingCoverage?.statusSummary, "Current feeds: Google Cloud not configured. Missing costs remain unknown, not zero.")
        try await capture(
            Page("cost-google-cloud-setup", WorkspaceView(area: .costs)),
            scheme: .light,
            size: .large,
            scene: scene,
            model: model,
            viewportWidth: 320
        )
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
    }

    @MainActor
    func testDocumentsAndImportCardsWrapAtCompactAndAccessibleWidths() async throws {
        let fixture = try NativeReviewFixture(longDocumentTitle: true)
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
        XCTAssertEqual(
            model.overview?.documents.documents.first?.title,
            "Confirmed family travel arrangements and payment receipts for the autumn weekend (revised copy).pdf"
        )
        let renderedImports = try XCTUnwrap(model.workspace?.imports)
        XCTAssertEqual(renderedImports.sources.first?.status, "importing")
        XCTAssertEqual(renderedImports.sources.first?.quarantinedNow, 4)
        XCTAssertNotNil(renderedImports.sources.first?.error)
        XCTAssertEqual(renderedImports.sources.last?.status, "failed")
        XCTAssertNotNil(renderedImports.sources.last?.error)
        XCTAssertEqual(renderedImports.unstartedFiles.first?.name, "Trip planning notes — family weekend (final revised copy).md")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let frames = DocumentLayoutFrameRecorder()
        let page = Page("documents-and-imports", WorkspaceView(
            area: .documents,
            documentLayoutObserver: { frames.record($0, $1) }
        ))
        try await captureDocumentReview(page, recorder: frames, width: 320, scheme: .light, size: .large,
            scene: scene, model: model, includesEmptyCard: false, includesDocumentActions: true, includesAdd: false)
        try await captureDocumentReview(page, recorder: frames, width: 320, scheme: .dark, size: .large,
            scene: scene, model: model, includesEmptyCard: false, includesDocumentActions: true, includesAdd: false)
        try await captureDocumentReview(page, recorder: frames, width: 320, scheme: .light, size: .accessibility3,
            scene: scene, model: model, includesEmptyCard: false, includesDocumentActions: true, includesAdd: false)
        try await captureDocumentReview(page, recorder: frames, width: 390, scheme: .light, size: .large,
            scene: scene, model: model, includesEmptyCard: false, includesDocumentActions: true, includesAdd: false)
        try await captureDocumentReview(page, recorder: frames, width: 390, scheme: .dark, size: .large,
            scene: scene, model: model, includesEmptyCard: false, includesDocumentActions: true, includesAdd: false)
        try await captureDocumentReview(page, recorder: frames, width: 390, scheme: .light, size: .accessibility3,
            scene: scene, model: model, includesEmptyCard: false, includesDocumentActions: true, includesAdd: false)

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
        let emptyFrames = DocumentLayoutFrameRecorder()
        let emptyPage = Page("documents-empty-with-imports", WorkspaceView(
            area: .documents,
            documentLayoutObserver: { emptyFrames.record($0, $1) }
        ))
        try await captureDocumentReview(emptyPage, recorder: emptyFrames, width: 320, scheme: .light, size: .large,
            scene: scene, model: emptyModel, includesEmptyCard: true, includesDocumentActions: false, includesAdd: true)
        try await captureDocumentReview(emptyPage, recorder: emptyFrames, width: 320, scheme: .dark, size: .large,
            scene: scene, model: emptyModel, includesEmptyCard: true, includesDocumentActions: false, includesAdd: true)
        try await captureDocumentReview(emptyPage, recorder: emptyFrames, width: 320, scheme: .light, size: .accessibility3,
            scene: scene, model: emptyModel, includesEmptyCard: true, includesDocumentActions: false, includesAdd: true)
        try await captureDocumentReview(emptyPage, recorder: emptyFrames, width: 390, scheme: .light, size: .large,
            scene: scene, model: emptyModel, includesEmptyCard: true, includesDocumentActions: false, includesAdd: true)
        try await captureDocumentReview(emptyPage, recorder: emptyFrames, width: 390, scheme: .dark, size: .large,
            scene: scene, model: emptyModel, includesEmptyCard: true, includesDocumentActions: false, includesAdd: true)
        try await captureDocumentReview(emptyPage, recorder: emptyFrames, width: 390, scheme: .light, size: .accessibility3,
            scene: scene, model: emptyModel, includesEmptyCard: true, includesDocumentActions: false, includesAdd: true)
        XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty, "Visual fixtures must not run import actions.")
        XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty, "Every visual read must stay in the fixture transport.")
    }

    @MainActor
    private func assertDocumentCardFrames(
        _ recorder: DocumentLayoutFrameRecorder,
        width: CGFloat,
        includesEmptyCard: Bool
    ) {
        var ids = [
            "card:import:imports/family-archive.zip",
            "card:import:imports/failed-backup.zip",
            "card:import-file:Trip planning notes — family weekend (final revised copy).md",
        ]
        ids.append(includesEmptyCard ? "card:document.empty" : "card:document:document")
        for id in ids {
            guard let frame = recorder.frames[id] else {
                XCTFail("Missing painted-card geometry for \(id)")
                continue
            }
            XCTAssertEqual(frame.minX, 16, accuracy: 2, "Unexpected leading page gutter for \(id)")
            XCTAssertEqual(frame.maxX, width - 16, accuracy: 2, "Card surface misses the trailing page gutter for \(id)")
        }
    }

    @MainActor
    private func assertDocumentActionFrames(
        _ recorder: DocumentLayoutFrameRecorder,
        width: CGFloat,
        includesDocumentActions: Bool,
        includesAdd: Bool,
        accessibilitySize: Bool
    ) {
        var ids = [
            "action:import.upload",
            "action:import.more:imports/family-archive.zip",
            "action:import.more:imports/failed-backup.zip",
            "action:import.approve:imports/family-archive.zip",
            "action:import.reject:imports/family-archive.zip",
            "action:import.start:Trip planning notes — family weekend (final revised copy).md",
        ]
        if includesDocumentActions { ids += ["action:document.ask:document", "action:document.delete:document"] }
        if includesAdd { ids.append("action:document.add") }
        for id in ids {
            guard let frame = recorder.frames[id] else {
                XCTFail("Missing painted-action geometry for \(id)")
                continue
            }
            if accessibilitySize {
                XCTAssertGreaterThanOrEqual(frame.height, 48, "AX action target is shorter than 48pt: \(id)")
            } else {
                XCTAssertEqual(frame.height, 48, accuracy: 1, "Normal-size action target should paint at 48pt: \(id)")
            }
            XCTAssertGreaterThanOrEqual(frame.minX, 16, "Action target escapes the leading page gutter: \(id)")
            XCTAssertLessThanOrEqual(frame.maxX, width - 16, "Action target escapes the trailing page gutter: \(id)")
        }
    }

    @MainActor
    private func captureDocumentReview(
        _ page: Page,
        recorder: DocumentLayoutFrameRecorder,
        width: CGFloat,
        scheme: ColorScheme,
        size: DynamicTypeSize,
        scene: UIWindowScene,
        model: AppModel,
        includesEmptyCard: Bool,
        includesDocumentActions: Bool,
        includesAdd: Bool
    ) async throws {
        recorder.reset()
        try await capture(page, scheme: scheme, size: size, scene: scene, model: model, viewportWidth: width)
        assertDocumentCardFrames(recorder, width: width, includesEmptyCard: includesEmptyCard)
        assertDocumentActionFrames(
            recorder,
            width: width,
            includesDocumentActions: includesDocumentActions,
            includesAdd: includesAdd,
            accessibilitySize: size.isAccessibilitySize
        )
    }

    // MARK: Connection safe-area source fixtures (two selected originals; no matrix entries)
#if DEBUG
    @MainActor
    private final class ConnectionLayoutRecorder {
        var frames: [ConnectionGeometryElement: CGRect] = [:]
        func record(_ sample: ConnectionGeometrySample) { frames[sample.element] = sample.frame }
    }

    @MainActor
    private final class ConnectionEvidenceLedger {
        private(set) var keys: Set<String> = []
        private(set) var bytes = 0
        private let allowed: Set<String> = ["connection-root-normal-initial", "connection-root-AX3-long-error"]

        func capture(_ window: UIWindow, key: String, test: NativeVisualReviewTests) throws {
            guard allowed.contains(key), !keys.contains(key), keys.count < 2 else {
                throw NSError(domain: "ConnectionEvidenceCap", code: 1)
            }
            var rendered = false
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            guard rendered, let png = image.pngData(), !png.isEmpty,
                  png.count <= 8 * 1024 * 1024, bytes + png.count <= 16 * 1024 * 1024 else {
                throw NSError(domain: "ConnectionEvidenceCap", code: 2)
            }
            keys.insert(key)
            bytes += png.count
            let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
            attachment.name = key
            attachment.lifetime = .keepAlways
            test.add(attachment)
        }

        func finish() {
            XCTAssertEqual(keys, allowed, "Only the two selected existing mounts produce original images")
            print("Connection selected originals: count=\(keys.count), encodedBytes=\(bytes); xcresult overhead not included")
        }
    }

    @MainActor
    private final class ConnectionRecordingSurfaces: AppSystemSurfaces {
        var operations: [String] = []
        func ensure(agentName: String, thought: AssistantThought, detail: String, pendingCount: Int) async { operations.append("ensure") }
        func start(agentName: String, thought: AssistantThought, detail: String, pendingCount: Int) async { operations.append("start") }
        func update(thought: AssistantThought, detail: String, pendingCount: Int) async { operations.append("update") }
        func needsAttention(agentName: String, detail: String, pendingCount: Int) async { operations.append("needsAttention") }
        func finish(thought: AssistantThought, detail: String, succeeded: Bool) async { operations.append("finish") }
        func dismiss() async { operations.append("dismiss") }
        func updateBadge(_ count: Int) async { operations.append("badge") }
    }

    @MainActor
    private func connectionDescendants<T: UIView>(_ view: UIView, as type: T.Type) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { connectionDescendants($0, as: type) }
    }

    @MainActor
    private func settleConnection(
        window: UIWindow,
        host: UIViewController,
        recorder: ConnectionLayoutRecorder,
        required: Set<ConnectionGeometryElement>
    ) async throws {
        var previous: [ConnectionGeometryElement: CGRect] = [:]
        var stable = 0
        for _ in 0..<40 {
            try Task.checkCancellation()
            host.view.setNeedsLayout()
            window.layoutIfNeeded()
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(16))
            let current = recorder.frames.filter { required.contains($0.key) }
            if current.count == required.count && current == previous { stable += 1 }
            else { stable = 0 }
            if stable >= 3 { return }
            previous = current
        }
        XCTFail("Connection geometry did not settle within 40 display opportunities; missing \(required.subtracting(recorder.frames.keys))")
        throw NSError(domain: "ConnectionLayoutFixture", code: 1)
    }

    @MainActor
    private func assertConnectionRect(_ frame: CGRect, inside safe: CGRect, name: String) {
        XCTAssertTrue([frame.minX, frame.minY, frame.maxX, frame.maxY].allSatisfy { $0.isFinite }, name)
        XCTAssertGreaterThan(frame.width, 0, name)
        XCTAssertGreaterThan(frame.height, 0, name)
        XCTAssertGreaterThanOrEqual(frame.minX, safe.minX - 1, "\(name) leading edge")
        XCTAssertGreaterThanOrEqual(frame.minY, safe.minY - 1, "\(name) top edge")
        XCTAssertLessThanOrEqual(frame.maxX, safe.maxX + 1, "\(name) trailing edge")
        XCTAssertLessThanOrEqual(frame.maxY, safe.maxY + 1, "\(name) bottom edge")
    }

    @MainActor
    private func revealConnectionElement(
        _ element: ConnectionGeometryElement,
        window: UIWindow,
        host: UIViewController,
        scroll: UIScrollView,
        recorder: ConnectionLayoutRecorder,
        required: Set<ConnectionGeometryElement>
    ) async throws {
        let frame = try XCTUnwrap(recorder.frames[element], "Missing production geometry: \(element)")
        let viewport = window.safeAreaLayoutGuide.layoutFrame.intersection(scroll.convert(scroll.bounds, to: window))
        XCTAssertGreaterThan(viewport.height, 0)
        let minimum = -scroll.adjustedContentInset.top
        let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let desired = scroll.contentOffset.y + frame.midY - viewport.midY
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(maximum, max(minimum, desired))), animated: false)
        try await settleConnection(window: window, host: host, recorder: recorder, required: required)
        let visible = try XCTUnwrap(recorder.frames[element])
        assertConnectionRect(visible, inside: window.safeAreaLayoutGuide.layoutFrame, name: element.rawValue)
        assertConnectionRect(visible, inside: viewport, name: "\(element.rawValue) scroll viewport")
    }

    @MainActor
    func testConnectionRootAndSettingsRespectActualWindowSafeAreaAtNormalAndAX3() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        // The fixture uses the allocated simulator's actual portrait window. It
        // does not manufacture a notch inset or infer a hardware model from width.
        XCTAssertGreaterThan(scene.coordinateSpace.bounds.height, scene.coordinateSpace.bounds.width)
        let evidence = ConnectionEvidenceLedger()
        defer { evidence.finish() }
        for onboarding in [true, false] {
            for size in [DynamicTypeSize.large, .accessibility3] {
                try await withConnectionLayoutMount(scene: scene, onboarding: onboarding, size: size, evidence: evidence)
            }
        }
    }

    @MainActor
    private func withConnectionLayoutMount(scene: UIWindowScene, onboarding: Bool, size: DynamicTypeSize, evidence: ConnectionEvidenceLedger) async throws {
        NativeReviewProtocol.install([:])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeReviewProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        guard NotificationManager.shared.pendingDestination == nil else {
            XCTFail("Connection fixture requires an empty notification destination; it must not consume another test's work")
            throw NSError(domain: "ConnectionLayoutFixture", code: 2)
        }
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://native-review.test")!, token: "fixture-only"), session: session)
        let suite = "assistant.connection-safe-area.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let previousApprovalHandler = NotificationManager.shared.approvalDecisionHandler
        let previousDeviceTokenHandler = NotificationManager.shared.deviceTokenHandler
        let surfaces = ConnectionRecordingSurfaces()
        var tokenWrites = 0
        let model = AppModel(
            apiClient: client, defaults: defaults,
            storeConnectionToken: { _ in tokenWrites += 1; XCTFail("Layout must never save a connection key") },
            enqueueAutomaticSpeech: { _ in XCTFail("No speech in connection layout fixture") },
            scheduleLocalNotification: { _, _, _, _, _, _ in XCTFail("No notification in connection layout fixture") },
            systemSurfaces: surfaces,
            captureCurrentPlace: { nil }
        )
        XCTAssertNil(model.bootstrap)
        XCTAssertFalse(model.hasSavedConnection)
        XCTAssertFalse(model.isLoading)
        let hasLongError = onboarding && size == .accessibility3
        let syntheticError = "Offline layout fixture: the assistant server could not be reached. Check the server address and this device’s connection, then review the access key before trying again. Nothing was submitted by this test. This deliberately long explanation must remain readable as the text size grows."
        if hasLongError { model.errorMessage = syntheticError }
        let recorder = ConnectionLayoutRecorder()
        let content: AnyView = onboarding
            ? AnyView(RootView())
            : AnyView(NavigationStack { ConnectionView(isOnboarding: false, showsDoneButton: true) })
        let host = UIHostingController(rootView: AnyView(content
            .environment(model)
            .environment(\.connectionGeometryReporter, ConnectionGeometryReporter(report: { recorder.record($0) }))
            .environment(\.dynamicTypeSize, size)
            .environment(\.scenePhase, .inactive)
            .environment(\.accessibilityReduceMotion, true)
            .transaction { $0.animation = nil; $0.disablesAnimations = true }))
        let previousWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.overrideUserInterfaceStyle = .light
        var selectedScroll: UIScrollView?
        var originalOffset: CGPoint?
        defer {
            window.endEditing(true)
            if let selectedScroll, let originalOffset { selectedScroll.setContentOffset(originalOffset, animated: false) }
            model.scenePhaseDidChange(.background)
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKey()
            NotificationManager.shared.approvalDecisionHandler = previousApprovalHandler
            NotificationManager.shared.deviceTokenHandler = previousDeviceTokenHandler
            session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
            XCTAssertEqual(tokenWrites, 0)
            XCTAssertTrue(NativeReviewProtocol.externalRequests.isEmpty)
            XCTAssertTrue(NativeReviewProtocol.mutations.isEmpty)
        }
        window.rootViewController = host
        window.makeKeyAndVisible()
        var required: Set<ConnectionGeometryElement> = onboarding
            ? [.rootAvailable, .scrollViewport, .scrollBody, .heading, .form, .serverField, .keyField, .primary]
            : [.scrollViewport, .scrollBody, .form, .serverField, .keyField, .primary]
        if hasLongError { required.insert(.error) }
        try await settleConnection(window: window, host: host, recorder: recorder, required: required)
        let viewport = try XCTUnwrap(recorder.frames[.scrollViewport])
        let scroll = try XCTUnwrap(connectionDescendants(window, as: UIScrollView.self)
            .filter { !$0.isHidden && $0.bounds.height > 0 }
            .max { left, right in
                left.convert(left.bounds, to: window).intersection(viewport).height < right.convert(right.bounds, to: window).intersection(viewport).height
            })
        selectedScroll = scroll
        originalOffset = scroll.contentOffset
        let windowSafe = window.safeAreaLayoutGuide.layoutFrame
        XCTAssertGreaterThan(windowSafe.height, 0)
        XCTAssertEqual(windowSafe.minY, window.bounds.minY + window.safeAreaInsets.top, accuracy: 1)
        if onboarding {
            let root = try XCTUnwrap(recorder.frames[.rootAvailable])
            XCTAssertEqual(root.minY, windowSafe.minY, accuracy: 1, "Root must start at actual window safe-area top")
            // Assert the initial unscrolled production layout before any test
            // reveal can repair a heading that began under the status area.
            XCTAssertEqual(viewport.minY, root.minY, accuracy: 1, "Initial viewport inherits the actual root safe-area top")
            let initialHeading = try XCTUnwrap(recorder.frames[.heading])
            XCTAssertEqual(initialHeading.minY, root.minY + 24, accuracy: 1, "Initial heading uses the designed 24pt content gap once")
            assertConnectionRect(initialHeading, inside: windowSafe, name: "Initial unscrolled heading")
            if size == .large { try evidence.capture(window, key: "connection-root-normal-initial", test: self) }
            try await revealConnectionElement(.heading, window: window, host: host, scroll: scroll, recorder: recorder, required: required)
        } else {
            let navigation = try XCTUnwrap(connectionDescendants(window, as: UINavigationBar.self).first { !$0.isHidden })
            XCTAssertEqual(navigation.topItem?.title, "Connection")
            assertConnectionRect(navigation.convert(navigation.bounds, to: window), inside: windowSafe, name: "Actual settings navigation heading")
        }
        let form = try XCTUnwrap(recorder.frames[.form])
        let actualViewport = windowSafe.intersection(scroll.convert(scroll.bounds, to: window))
        XCTAssertTrue([form.minX, form.minY, form.maxX, form.maxY].allSatisfy { $0.isFinite })
        XCTAssertGreaterThan(form.width, 0)
        XCTAssertGreaterThan(form.height, 0)
        XCTAssertGreaterThanOrEqual(form.minX, actualViewport.minX - 1)
        XCTAssertLessThanOrEqual(form.maxX, actualViewport.maxX + 1)
        if form.height <= actualViewport.height {
            try await revealConnectionElement(.form, window: window, host: host, scroll: scroll, recorder: recorder, required: required)
        } else {
            // An AX card may legitimately wrap beyond one viewport. Preserve
            // all text and prove each real field remains wholly reachable.
            print("Connection card legitimately exceeds viewport: cardHeight=\(form.height), viewportHeight=\(actualViewport.height), AX=\(size.isAccessibilitySize)")
        }
        for element in [ConnectionGeometryElement.serverField, .keyField, .primary] {
            try await revealConnectionElement(element, window: window, host: host, scroll: scroll, recorder: recorder, required: required)
        }
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(recorder.frames[.primary]).height, 48)
        if hasLongError {
            XCTAssertEqual(model.errorMessage, syntheticError)
            let error = try XCTUnwrap(recorder.frames[.error])
            XCTAssertTrue([error.minX, error.minY, error.maxX, error.maxY].allSatisfy { $0.isFinite })
            XCTAssertGreaterThan(error.width, 0)
            XCTAssertGreaterThanOrEqual(error.minX, actualViewport.minX - 1)
            XCTAssertLessThanOrEqual(error.maxX, actualViewport.maxX + 1)
            // Match the production subheadline style at SwiftUI AX3's UIKit
            // category. Subtract its actual 14pt-per-edge error padding before
            // comparing with a single font line; this is allocation evidence,
            // not terminal-glyph or complete-text rendering proof.
            let font = UIFont.preferredFont(forTextStyle: .subheadline,
                compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraLarge))
            XCTAssertGreaterThan(error.height - 28, font.lineHeight)
            if error.height <= actualViewport.height {
                try await revealConnectionElement(.error, window: window, host: host, scroll: scroll, recorder: recorder, required: required)
            } else {
                print("Connection AX3 error exceeds viewport: original shows only current scroll position; full explanation requires scrolling")
            }
            // A single original cannot promise the entire oversized card,
            // error and button simultaneously. Individual control reachability
            // was asserted above; report the actual visible context explicitly.
            let visible = windowSafe.intersection(scroll.convert(scroll.bounds, to: window))
            let names: [ConnectionGeometryElement] = [.form, .serverField, .keyField, .error, .primary]
            print("Connection AX3 original visible element intersections=\(names.filter { recorder.frames[$0]?.intersects(visible) == true }.map(\.rawValue)); whole-source glyph coverage not inferred")
            try evidence.capture(window, key: "connection-root-AX3-long-error", test: self)
        }
        // One explicit safe-area perturbation, only on the actual RootView normal
        // mount. The expected shift comes from UIKit's measured hosting guide.
        if onboarding && size == .large {
            scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
            try await settleConnection(window: window, host: host, recorder: recorder, required: required)
            let headingBefore = try XCTUnwrap(recorder.frames[.heading])
            let hostTopBefore = host.view.safeAreaLayoutGuide.layoutFrame.minY
            host.additionalSafeAreaInsets.top = 19
            try await settleConnection(window: window, host: host, recorder: recorder, required: required)
            let delta = host.view.safeAreaLayoutGuide.layoutFrame.minY - hostTopBefore
            XCTAssertEqual(delta, 19, accuracy: 1)
            XCTAssertEqual(try XCTUnwrap(recorder.frames[.rootAvailable]).minY - windowSafe.minY, delta, accuracy: 1)
            XCTAssertEqual(try XCTUnwrap(recorder.frames[.heading]).minY - headingBefore.minY, delta, accuracy: 1, "Safe-area delta must be applied once")
            host.additionalSafeAreaInsets = .zero
            try await settleConnection(window: window, host: host, recorder: recorder, required: required)
            try await assertConnectionNativeInputBehavior(window: window, host: host, recorder: recorder, required: required)
        }
        XCTAssertNil(model.bootstrap, "Layout never authenticates or submits the form")
        XCTAssertFalse(model.isLoading)
        print("Connection safe-area source fixture: onboarding=\(onboarding), AX=\(size.isAccessibilitySize), windowInsets=\(window.safeAreaInsets), safeFrame=\(windowSafe); selectedOriginalsRetained=\(evidence.keys.count)")
    }

    @MainActor
    private func assertConnectionNativeInputBehavior(window: UIWindow, host: UIViewController, recorder: ConnectionLayoutRecorder, required: Set<ConnectionGeometryElement>) async throws {
        let fields = connectionDescendants(window, as: UITextField.self)
        let server = try XCTUnwrap(fields.first { !$0.isSecureTextEntry && $0.keyboardType == .URL })
        let key = try XCTUnwrap(fields.first { $0.isSecureTextEntry })
        XCTAssertEqual(server.textContentType, .URL)
        XCTAssertEqual(server.returnKeyType, .next)
        XCTAssertEqual(server.autocapitalizationType, .none)
        XCTAssertEqual(server.autocorrectionType, .no)
        XCTAssertEqual(key.textContentType, .password)
        XCTAssertEqual(key.returnKeyType, .go)
        XCTAssertEqual(key.autocapitalizationType, .none)
        XCTAssertEqual(key.autocorrectionType, .no)
        XCTAssertTrue(server.becomeFirstResponder())
        XCTAssertTrue(server.isFirstResponder)
        XCTAssertTrue(key.becomeFirstResponder())
        XCTAssertTrue(key.isFirstResponder)
        XCTAssertFalse(server.isFirstResponder)
        // Give a real software keyboard up to 24 display opportunities. No
        // fabricated frame and no programmatic scroll repairs the focused field.
        for _ in 0..<24 {
            try await Task.sleep(for: .milliseconds(16))
            window.layoutIfNeeded()
            if window.keyboardLayoutGuide.layoutFrame.height > window.safeAreaInsets.bottom + 1 { break }
        }
        try await settleConnection(window: window, host: host, recorder: recorder, required: required)
        let keyboard = window.keyboardLayoutGuide.layoutFrame
        let observed = keyboard.height > window.safeAreaInsets.bottom + 1 && keyboard.minY < window.safeAreaLayoutGuide.layoutFrame.maxY - 1
        print("Connection native keyboard observed=\(observed), guide=\(keyboard); absence is NOT viewport-avoidance proof")
        if observed {
            XCTAssertTrue(key.isFirstResponder)
            XCTAssertLessThanOrEqual(key.convert(key.bounds, to: window).maxY, keyboard.minY + 1, "Native keyboard avoidance must reveal the focused key field without a test scroll")
            XCTAssertGreaterThanOrEqual(key.convert(key.bounds, to: window).minY, window.safeAreaLayoutGuide.layoutFrame.minY - 1)
        }
        // Never sends .editingDidEndOnExit / .go: no connection or keychain write.
        window.endEditing(true)
    }
#endif

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


    // Event-only resource policy. The default capture path below is intentionally
    // untouched; these ceilings stop with failure and never prove content fits.
    @MainActor private final class EventCaptureLedger {
        struct Stop: Error { let reason: String }
        let clock = ContinuousClock()
        let methodStart: ContinuousClock.Instant
        let runID = UUID().uuidString
        var caseStart: ContinuousClock.Instant
        var ordinal = 0
        var attemptedPNG = 0, retainedPNG = 0, caseAttemptedPNG = 0, caseRetainedPNG = 0
        var retainedJSON = 0, caseJSON = 0
        var failures: [String] = []
        var minimalEmitted = false
        var minimalUsed = 0
        var lastRejectedPNG: [String: Any] = [:]
        static let minimalBytes = 4096
        init() { let now = clock.now; methodStart = now; caseStart = now }
        var caseID: String { "\(runID)-case-\(ordinal)" }
        func seconds(_ start: ContinuousClock.Instant) -> Double {
            let d = start.duration(to: clock.now).components
            return Double(d.seconds) + Double(d.attoseconds) / 1e18
        }
        func check(_ operation: String) throws {
            if seconds(methodStart) >= 480 || (ordinal > 0 && seconds(caseStart) >= 60) {
                throw Stop(reason: "wall-cap: \(operation)")
            }
        }
        func beginCase(_ test: NativeVisualReviewTests) throws {
            // Includes preceding case verification/cleanup in the old case clock.
            do { try check("before case setup") }
            catch { emitMinimal(test, reason: String(describing: error)); throw error }
            ordinal += 1; caseStart = clock.now
            caseAttemptedPNG = 0; caseRetainedPNG = 0; caseJSON = 0
            minimalEmitted = false; minimalUsed = 0; lastRejectedPNG = [:]
            try check("case setup")
        }
        func recordAttemptedPNG(_ bytes: Int) {
            attemptedPNG += bytes; caseAttemptedPNG += bytes
        }
        func allowPNG(_ bytes: Int) throws {
            let reason: String?
            if bytes > 8 * 1024 * 1024 { reason = "PNG-each-cap" }
            else if caseRetainedPNG + bytes > 96 * 1024 * 1024 { reason = "PNG-case-cap" }
            else if retainedPNG + bytes > 512 * 1024 * 1024 { reason = "PNG-method-cap" }
            else { reason = nil }
            if let reason { throw Stop(reason: reason) }
            try check("before PNG attachment")
        }
        func recordAttachedPNG(_ bytes: Int) {
            // Only synchronous add(attachment) returning establishes retention.
            retainedPNG += bytes; caseRetainedPNG += bytes
        }
        func recordRejectedPNG(_ bytes: Int, error: Error) {
            lastRejectedPNG = ["actualBytes": bytes, "reason": String(describing: error), "attached": false]
        }
        func allowJSON(_ bytes: Int) throws {
            // Reserve all thirteen minimal failure records, including this case.
            let reserve = max(0, 14 - ordinal) * Self.minimalBytes
            guard caseJSON + bytes <= 1024 * 1024 - Self.minimalBytes,
                  retainedJSON + bytes <= 16 * 1024 * 1024 - reserve else {
                throw Stop(reason: "diagnostic-cap-overflow")
            }
            try check("before JSON attachment")
            retainedJSON += bytes; caseJSON += bytes
        }
        var totals: [String: Any] {
            ["methodSeconds": seconds(methodStart), "caseSeconds": seconds(caseStart),
             "attemptedPNGBytes": attemptedPNG, "retainedPNGBytes": retainedPNG,
             "caseAttemptedPNGBytes": caseAttemptedPNG, "caseRetainedPNGBytes": caseRetainedPNG,
             "retainedJSONBytesBeforeThisAttachment": retainedJSON, "caseJSONBytesBeforeThisAttachment": caseJSON]
        }
        // Observed nonfinite numbers are not replaced with plausible zeros.
        static func safe(_ object: Any) -> Any {
            if let dictionary = object as? [String: Any] { return dictionary.mapValues(safe) }
            if let array = object as? [Any] { return array.map(safe) }
            if let number = object as? NSNumber, !number.doubleValue.isFinite {
                let value = number.doubleValue
                return ["value": NSNull(), "observed": true,
                        "invalidNumeric": value.isNaN ? "NaN" : (value > 0 ? "+Inf" : "-Inf")] as [String: Any]
            }
            return object
        }
        func emitMinimal(_ test: NativeVisualReviewTests, reason: String,
                         attemptedFullBytes: Int? = nil, candidates: Int = 0, steps: Int = 0,
                         final: [String: Any]? = nil, lastRequest: [String: Any]? = nil,
                         restoration: String? = nil) {
            failures.append(reason)
            // A second failure after full diagnostics (e.g. cleanup) still gets a
            // bounded record; no full trace is claimed by this reserved header.
            var header: [String: Any] = ["runID": runID, "caseID": caseID, "caseOrdinal": ordinal,
                "status": "STOP", "reason": String(reason.prefix(256)), "reasonAbbreviated": reason.count > 256, "fullRawTraceRetained": false,
                "units": ["geometry": "pt", "elapsed": "s", "size": "B"],
                "attemptedFullJSONBytes": attemptedFullBytes.map { $0 as Any } ?? NSNull(),
                "omittedCandidateCount": candidates, "omittedStepCount": steps,
                "totals": totals, "rejectedPNG": lastRejectedPNG,
                "limits": ["steps": 64, "caseSeconds": 60, "methodSeconds": 480,
                           "PNGEachBytes": 8388608, "PNGCaseBytes": 100663296,
                           "PNGMethodBytes": 536870912, "JSONCaseBytes": 1048576,
                           "JSONMethodBytes": 16777216, "minimalBytes": 4096]]
            if let restoration { header["restorationStatusBeforeExit"] = restoration }
            if let final { header["selectedFinalBeforeRestore"] = final }
            if let lastRequest { header["lastAttemptedScrollRequest"] = lastRequest }
            var data = try? JSONSerialization.data(withJSONObject: Self.safe(header), options: [.sortedKeys])
            if data == nil || data!.count > Self.minimalBytes / 2 {
                header.removeValue(forKey: "selectedFinalBeforeRestore")
                header["omittedFields"] = ["selectedFinalBeforeRestore"]
                data = try? JSONSerialization.data(withJSONObject: Self.safe(header), options: [.sortedKeys])
            }
            if data == nil || data!.count > Self.minimalBytes / 2 {
                // Fixed scalar-only fallback, not a silently truncated raw trace.
                header = ["runID": runID, "caseID": caseID, "caseOrdinal": ordinal,
                          "status": "STOP", "reason": String(reason.prefix(128)), "reasonAbbreviated": reason.count > 128,
                          "fullRawTraceRetained": false, "omittedFields": "all optional raw fields and totals; minimal-header-size fallback",
                          "attemptedFullJSONBytes": attemptedFullBytes.map { $0 as Any } ?? NSNull(),
                          "omittedCandidateCount": candidates, "omittedStepCount": steps,
                          "caseAttemptedPNGBytes": caseAttemptedPNG, "methodAttemptedPNGBytes": attemptedPNG,
                          "rejectedPNG": lastRejectedPNG,
                          "caseRetainedPNGBytes": caseRetainedPNG, "methodRetainedPNGBytes": retainedPNG,
                          "units": ["size": "B", "elapsed": "s", "geometry": "pt"]]
                if let lastRequest { header["lastAttemptedScrollRequest"] = lastRequest }
                if let restoration { header["restorationStatusBeforeExit"] = restoration }
                data = try? JSONSerialization.data(withJSONObject: Self.safe(header), options: [.sortedKeys])
            }
            guard let data, data.count <= Self.minimalBytes / 2,
                  minimalUsed + data.count <= Self.minimalBytes,
                  caseJSON + data.count <= 1024 * 1024,
                  retainedJSON + data.count <= 16 * 1024 * 1024 else {
                XCTFail("Reserved event STOP diagnostic could not be retained: \(reason)"); return
            }
            retainedJSON += data.count; caseJSON += data.count; minimalUsed += data.count; minimalEmitted = true
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "event-\(caseID)-STOP"; attachment.lifetime = .keepAlways; test.add(attachment)
        }
        func finishMethod(_ test: NativeVisualReviewTests) {
            do {
                try check("method cleanup completed / before ledger serialization")
                let data = try JSONSerialization.data(withJSONObject: [
                    "runID": runID, "caseCount": ordinal, "totalsBeforeThisAttachment": totals,
                    "units": ["geometry": "pt", "elapsed": "s", "size": "B"],
                    "status": failures.isEmpty ? "method-returned" : "STOP",
                    "limit": "Helper PNG/JSON bytes exclude xcresult container overhead; no physical gesture or full-time PNG acceptance claim."
                ], options: [.sortedKeys])
                try check("method ledger serialization completed")
                try allowJSON(data.count)
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                attachment.name = "event-\(runID)-method-ledger"; attachment.lifetime = .keepAlways; test.add(attachment)
                try check("method ledger attachment completed")
            } catch {
                if !minimalEmitted { emitMinimal(test, reason: String(describing: error)) }
                XCTFail("\(error)")
            }
        }
    }

    @MainActor private func captureEvent(_ page: Page, scheme: ColorScheme, size: DynamicTypeSize,
                                         scene: UIWindowScene, model: AppModel, requiresScrolling: Bool,
                                         viewportWidth: CGFloat?, ledger: EventCaptureLedger) async throws {
        var stop: Error?
        var steps: [[String: Any]] = []
        var candidates: [UIScrollView] = []
        var initialDiagnostics: [[String: Any]] = []
        var inventoryObserved = false
        var selected: UIScrollView?
        var initial: CGPoint?
        var observedOriginalOffset: CGPoint?
        var restorationStatus = "not-performed: no selected scroll observed"
        var finalSample: [String: Any]?
        var finalGap: CGFloat?
        var capturedScrollPositions = 0
        var window: UIWindow?
        func check(_ operation: String) throws { try ledger.check(operation) }
        func measure(_ scroll: UIScrollView) -> [String: Any] {
            let viewport = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
            let bottom = max(-scroll.adjustedContentInset.top,
                             scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            let frame = window.map { scroll.convert(scroll.bounds, to: $0) }
            return ["candidateID": "\(ledger.caseID)-\(ObjectIdentifier(scroll))",
                    "class": String(describing: type(of: scroll)), "accessibilityIdentifier": scroll.accessibilityIdentifier ?? "",
                    "bounds": ["x": scroll.bounds.minX, "y": scroll.bounds.minY, "width": scroll.bounds.width, "height": scroll.bounds.height],
                    "frameInWindow": frame.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] as Any } ?? NSNull(),
                    "contentSize": ["width": scroll.contentSize.width, "height": scroll.contentSize.height],
                    "contentInset": ["top": scroll.contentInset.top, "left": scroll.contentInset.left, "bottom": scroll.contentInset.bottom, "right": scroll.contentInset.right],
                    "adjustedContentInset": ["top": scroll.adjustedContentInset.top, "left": scroll.adjustedContentInset.left, "bottom": scroll.adjustedContentInset.bottom, "right": scroll.adjustedContentInset.right],
                    "offset": ["x": scroll.contentOffset.x, "y": scroll.contentOffset.y],
                    "effectiveViewportHeight": viewport, "computedBottom": bottom,
                    "remaining": max(0, bottom - scroll.contentOffset.y), "selected": scroll === selected]
        }
        func valid(_ scroll: UIScrollView) -> Bool {
            let values = [scroll.bounds.minX, scroll.bounds.minY, scroll.bounds.width, scroll.bounds.height,
                          scroll.contentSize.width, scroll.contentSize.height, scroll.contentOffset.x, scroll.contentOffset.y,
                          scroll.contentInset.top, scroll.contentInset.left, scroll.contentInset.bottom, scroll.contentInset.right,
                          scroll.adjustedContentInset.top, scroll.adjustedContentInset.left, scroll.adjustedContentInset.bottom, scroll.adjustedContentInset.right]
            return values.allSatisfy(\.isFinite) && scroll.bounds.width > 0 && scroll.bounds.height > 0 &&
                scroll.contentSize.width >= 0 && scroll.contentSize.height >= 0 &&
                scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom > 0
        }
        defer {
            // Mandatory single original restoration, even on STOP/cancellation.
            if let selected, let initial { selected.setContentOffset(initial, animated: false) }
            window?.isHidden = true; window?.rootViewController = nil
            do { try check("case cleanup completed") }
            catch { ledger.emitMinimal(self, reason: String(describing: error)); XCTFail("\(error)") }
        }
        do {
            try check("window setup")
            UserDefaults.standard.set((scheme == .light ? AssistantAppearance.light : .dark).rawValue,
                                      forKey: AssistantAppearance.defaultsKey)
            let nativeWindow = UIWindow(windowScene: scene); window = nativeWindow
            nativeWindow.frame = scene.coordinateSpace.bounds
            if let viewportWidth { nativeWindow.frame.size.width = viewportWidth }
            nativeWindow.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
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
            nativeWindow.rootViewController = host
            guard [nativeWindow.bounds.minX, nativeWindow.bounds.minY, nativeWindow.bounds.width, nativeWindow.bounds.height].allSatisfy(\.isFinite),
                  nativeWindow.bounds.width > 0, nativeWindow.bounds.height > 0 else {
                throw EventCaptureLedger.Stop(reason: "invalid-initial-window-geometry")
            }
            try check("window setup completed"); try check("window presentation")
            nativeWindow.makeKeyAndVisible()
            try check("window presentation completed"); try check("initial sleep")
            try await Task.sleep(for: .milliseconds(500))
            try check("initial sleep completed"); try check("initial layout")
            nativeWindow.layoutIfNeeded()
            try check("initial layout completed")
            func record(_ position: String) throws {
                try check("render")
                var rendered = false
                let image = UIGraphicsImageRenderer(bounds: nativeWindow.bounds).image { _ in
                    rendered = nativeWindow.drawHierarchy(in: nativeWindow.bounds, afterScreenUpdates: true)
                }
                try check("render completed")
                XCTAssertTrue(rendered, "UIKit failed to render \(page.name)")
                try check("PNG encoding")
                guard let data = image.pngData() else { throw EventCaptureLedger.Stop(reason: "PNG encoding failed") }
                // Encoding completion is an attempt, not an attached artifact.
                ledger.recordAttemptedPNG(data.count)
                do {
                    try check("PNG encoding completed")
                    try ledger.allowPNG(data.count)
                    XCTAssertGreaterThan(data.count, 15_000, "Blank capture: \(page.name)")
                    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
                    attachment.name = "\(page.name)-phone-\(scheme == .light ? "light" : "dark")-\(Int(nativeWindow.bounds.width))\(size.isAccessibilitySize ? "-accessible" : "")-\(position)"
                    attachment.lifetime = .keepAlways
                    try check("PNG attachment prepared / before add")
                    add(attachment)
                    ledger.recordAttachedPNG(data.count)
                } catch {
                    ledger.recordRejectedPNG(data.count, error: error)
                    throw error
                }
                try check("PNG attachment completed")
            }
            try record("top")
            try check("native candidate inventory")
            func scrollViews(in view: UIView) -> [UIScrollView] {
                ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap { scrollViews(in: $0) }
            }
            candidates = scrollViews(in: nativeWindow)
            inventoryObserved = true
            selected = candidates.filter({ scroll in
                let viewportHeight = max(0, scroll.bounds.height
                                         - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
                return scroll.bounds.width >= nativeWindow.bounds.width * 0.7 && scroll.bounds.height >= nativeWindow.bounds.height * 0.35 &&
                    scroll.contentSize.height > viewportHeight + 2
            }).max(by: { $0.bounds.height < $1.bounds.height })
            initialDiagnostics = candidates.map { scroll in
                var sample = measure(scroll)
                let viewport = max(0, scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
                sample["meetsWidthPredicate"] = scroll.bounds.width >= nativeWindow.bounds.width * 0.7
                sample["meetsHeightPredicate"] = scroll.bounds.height >= nativeWindow.bounds.height * 0.35
                sample["meetsOverflowPredicate"] = scroll.contentSize.height > viewport + 2
                return sample
            }
            try check("native candidate inventory completed")
            guard let scroll = selected else { throw EventCaptureLedger.Stop(reason: "no-selected-candidate") }
            let originalOffset = scroll.contentOffset
            observedOriginalOffset = originalOffset
            guard originalOffset.x.isFinite && originalOffset.y.isFinite else {
                restorationStatus = "not-performed: invalid original offset; no scroll issued"
                throw EventCaptureLedger.Stop(reason: "nonfinite-original-offset-no-scroll-no-restore")
            }
            initial = originalOffset
            restorationStatus = "one original-offset restoration scheduled in defer; not yet performed"
            guard valid(scroll) else { throw EventCaptureLedger.Stop(reason: "invalid-initial-geometry") }
            var offset = max(scroll.contentOffset.y, -scroll.adjustedContentInset.top)
            var smallestPositive: CGFloat?
            var stalled = 0
            while true {
                try check("scroll planning")
                guard valid(scroll) else { throw EventCaptureLedger.Stop(reason: "invalid-geometry") }
                let bottom = max(-scroll.adjustedContentInset.top,
                                 scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                guard offset < bottom - 2 else { break }
                let viewportHeight = max(1, scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
                let planned = viewportHeight * 0.72
                let quantum = min(planned, smallestPositive ?? planned)
                let required = ceil(max(bottom - offset - 2, 0) / quantum)
                guard required.isFinite, quantum.isFinite, quantum > 0 else {
                    throw EventCaptureLedger.Stop(reason: "invalid-planning-quantum")
                }
                guard steps.count < 64, required <= CGFloat(64 - steps.count) else {
                    throw EventCaptureLedger.Stop(reason: "adaptive-step-cap")
                }
                let before = scroll.contentOffset.y
                let previousContentHeight = scroll.contentSize.height
                let requested = min(bottom, offset + viewportHeight * 0.72)
                let stepIndex = steps.count
                var sample: [String: Any] = ["index": stepIndex + 1, "phase": "request-prepared",
                    "requestedOffsetY": requested, "preOffsetY": before, "preSnapshot": measure(scroll),
                    "planningQuantum": quantum, "requiredAdditionalStepsBeforeStep": required,
                    "immediateOffsetY": ["value": NSNull(), "observed": false],
                    "settledOffsetY": ["value": NSNull(), "observed": false], "totals": ledger.totals]
                steps.append(sample)
                try check("forward scroll")
                steps[stepIndex]["phase"] = "requested"
                scroll.setContentOffset(CGPoint(x: initial!.x, y: requested), animated: false)
                // Observe the synchronous return BEFORE a budget check can throw.
                steps[stepIndex]["phase"] = "immediate-unsettled"
                steps[stepIndex]["immediateOffsetY"] = scroll.contentOffset.y
                steps[stepIndex]["immediateSnapshot"] = measure(scroll)
                try check("forward scroll completed"); try check("step sleep")
                try await Task.sleep(for: .milliseconds(130))
                steps[stepIndex]["phase"] = "sleep-returned-unsettled"
                steps[stepIndex]["postSleepSnapshot"] = measure(scroll)
                try check("step sleep completed"); try check("step layout")
                nativeWindow.layoutIfNeeded()
                offset = scroll.contentOffset.y
                let delta = offset - before
                sample = steps[stepIndex]
                sample["phase"] = "settled"
                sample["settledOffsetY"] = offset; sample["settledSnapshot"] = measure(scroll)
                sample["contentHeightChange"] = scroll.contentSize.height - previousContentHeight
                sample["actualProgress"] = delta; sample["totals"] = ledger.totals
                steps[stepIndex] = sample; capturedScrollPositions += 1
                try check("step layout completed")
                guard valid(scroll), delta.isFinite else { throw EventCaptureLedger.Stop(reason: "invalid-settled-geometry") }
                guard delta >= 0 else { throw EventCaptureLedger.Stop(reason: "negative-progress") }
                if delta > 0 { smallestPositive = min(smallestPositive ?? delta, delta); stalled = 0 }
                else { stalled += 1 }
                if stalled >= 2 { throw EventCaptureLedger.Stop(reason: "stalled-two-forward-steps") }
                try record("scroll-\(String(format: "%02d", steps.count))")
            }
        } catch { stop = error }
        // Final observation and reserved diagnostic exit are mandatory even if a
        // resource expired. No new wait/layout/scroll is introduced here.
        if let selected {
            finalSample = measure(selected)
            let bottom = max(-selected.adjustedContentInset.top,
                             selected.contentSize.height - selected.bounds.height + selected.adjustedContentInset.bottom)
            let gap = bottom - selected.contentOffset.y
            if gap.isFinite { finalGap = gap }
            else if stop == nil { stop = EventCaptureLedger.Stop(reason: "nonfinite-final-gap") }
        }
        var raw: [String: Any] = ["runID": ledger.runID, "caseID": ledger.caseID, "caseOrdinal": ledger.ordinal,
            "page": page.name, "scheme": scheme == .light ? "light" : "dark",
            "dynamicType": size.isAccessibilitySize ? "accessibility3" : "large",
            "sourceIdentity": ["head": NSNull(), "tree": NSNull(), "reason": "not supplied to native process"],
            "units": ["geometry": "pt", "elapsed": "s", "size": "B"],
            "status": stop == nil ? "EOF-observed" : "STOP", "reason": stop.map { String(describing: $0) } ?? "EOF",
            "selectedCandidateID": selected.map { "\(ledger.caseID)-\(ObjectIdentifier($0))" as Any } ?? NSNull(),
            "candidateInventoryObserved": inventoryObserved,
            "restorationStatusBeforeExit": restorationStatus,
            "originalOffset": observedOriginalOffset.map { ["x": $0.x, "y": $0.y] as Any } ?? ["value": NSNull(), "observed": false],
            "selectionObservation": inventoryObserved ? "observed" : "unobserved: native inventory not reached",
            "allInitialNativeScrollCandidates": initialDiagnostics, "scrollSteps": steps,
            "selectedFinalBeforeRestore": finalSample.map { $0 as Any } ?? ["value": NSNull(), "observed": false, "reason": "no observed selected scroll"],
            "capturedScrollPositions": capturedScrollPositions, "totals": ledger.totals,
            "rejectedPNG": ledger.lastRejectedPNG, "fullRawTraceRetained": true,
            "selectionRule": "Existing70percentwidth/35percentheight/overflow>effectiveviewport+2; greatest bounds.height. No fallback."]
        if let window {
            raw["windowFrame"] = ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height]
            raw["windowBounds"] = ["x": window.bounds.minX, "y": window.bounds.minY, "width": window.bounds.width, "height": window.bounds.height]
            if let safe = window.rootViewController?.view.safeAreaInsets {
                raw["hostSafeAreaInsets"] = ["top": safe.top, "left": safe.left, "bottom": safe.bottom, "right": safe.right]
            }
        }
        var attemptedBytes: Int?
        do {
            try check("diagnostic serialization")
            let data = try JSONSerialization.data(withJSONObject: EventCaptureLedger.safe(raw), options: [.sortedKeys])
            attemptedBytes = data.count
            try check("diagnostic serialization completed")
            try ledger.allowJSON(data.count)
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "event-\(ledger.caseID)-native-scroll-diagnostics"
            attachment.lifetime = .keepAlways; add(attachment)
            try check("diagnostic attachment completed")
        } catch {
            if stop == nil { stop = error }
            let lastRequest = steps.last.map { step in
                ["index": step["index"]!, "phase": step["phase"]!,
                 "requestedOffsetY": step["requestedOffsetY"]!, "preOffsetY": step["preOffsetY"]!,
                 "immediateOffsetY": step["immediateOffsetY"]!, "settledOffsetY": step["settledOffsetY"]!]
            }
            ledger.emitMinimal(self, reason: String(describing: error), attemptedFullBytes: attemptedBytes,
                               candidates: candidates.count, steps: steps.count, final: finalSample, lastRequest: lastRequest,
                               restoration: restorationStatus)
        }
        if let finalGap {
            XCTAssertLessThanOrEqual(finalGap, 2, "Incomplete below-fold capture: \(page.name)")
        } else if selected != nil { XCTFail("Unobservable/nonfinite final EOF metric: \(page.name)") }
        if requiresScrolling {
            XCTAssertGreaterThan(capturedScrollPositions, 0, "Long message fixture was not captured below the fold: \(page.name)")
        }
        if let stop { throw stop }
    }

    @MainActor private func capture(_ page: Page, scheme: ColorScheme, size: DynamicTypeSize,
                                    scene: UIWindowScene, model: AppModel, requiresScrolling: Bool = false,
                                    viewportWidth: CGFloat? = nil, increasedContrast: Bool = false,
                                    additionalSafeAreaInsets: UIEdgeInsets? = nil,
                                    eventCapturePolicy: EventCaptureLedger? = nil,
                                    viewportRecorder: ConversationViewportRecorder? = nil,
                                    layoutReporter: (@MainActor ([String: CGRect]) -> Void)? = nil) async throws {
        if let eventCapturePolicy {
            try await captureEvent(page, scheme: scheme, size: size, scene: scene, model: model,
                                   requiresScrolling: requiresScrolling, viewportWidth: viewportWidth, ledger: eventCapturePolicy)
            return
        }
        viewportRecorder?.reset()
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
        if let additionalSafeAreaInsets { host.additionalSafeAreaInsets = additionalSafeAreaInsets }
        if increasedContrast { host.traitOverrides.accessibilityContrast = .high }
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(500))
        window.layoutIfNeeded()
        if let layoutReporter {
            window.layoutIfNeeded()
            layoutReporter([
                "window.bounds": window.bounds,
                "window.safe-area.available": window.safeAreaLayoutGuide.layoutFrame
            ])
        }
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
        let nativeScrollCandidates = scrollViews(in: window)
        let selectedScroll = nativeScrollCandidates.filter({ scroll in
            // Safe-area/navigation insets reduce the usable viewport even
            // when the content is shorter than the scroll view's bounds.
            let viewportHeight = max(0, scroll.bounds.height
                                     - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
            return scroll.bounds.width >= window.bounds.width * 0.7 && scroll.bounds.height >= window.bounds.height * 0.35 &&
                scroll.contentSize.height > viewportHeight + 2
        }).max(by: { $0.bounds.height < $1.bounds.height })
        func scrollDiagnostic(_ scroll: UIScrollView, index: Int) -> [String: Any] {
            let visibleFrame = scroll.convert(scroll.bounds, to: window)
            let viewportHeight = max(0, scroll.bounds.height
                                     - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom)
            let bottom = max(-scroll.adjustedContentInset.top,
                             scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            func rect(_ value: CGRect) -> [String: CGFloat] {
                ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
            }
            func insets(_ value: UIEdgeInsets) -> [String: CGFloat] {
                ["top": value.top, "left": value.left, "bottom": value.bottom, "right": value.right]
            }
            return ["candidateIndex": index, "nativeIdentity": String(describing: ObjectIdentifier(scroll)),
                    "class": String(describing: type(of: scroll)), "accessibilityIdentifier": scroll.accessibilityIdentifier ?? "",
                    "bounds": rect(scroll.bounds), "frameInWindow": rect(visibleFrame),
                    "contentSize": ["width": scroll.contentSize.width, "height": scroll.contentSize.height],
                    "contentInset": insets(scroll.contentInset), "adjustedContentInset": insets(scroll.adjustedContentInset),
                    "contentOffset": ["x": scroll.contentOffset.x, "y": scroll.contentOffset.y],
                    "effectiveViewportHeight": viewportHeight, "computedBottom": bottom,
                    "meetsWidthPredicate": scroll.bounds.width >= window.bounds.width * 0.7,
                    "meetsHeightPredicate": scroll.bounds.height >= window.bounds.height * 0.35,
                    "meetsOverflowPredicate": scroll.contentSize.height > viewportHeight + 2,
                    "selected": selectedScroll === scroll]
        }
        let initialScrollDiagnostics = viewportRecorder == nil ? [] : nativeScrollCandidates.enumerated().map {
            scrollDiagnostic($0.element, index: $0.offset)
        }
        var scrollStepDiagnostics: [[String: Any]] = []
        var selectedFinalDiagnostic: [String: Any]?
        if let scroll = selectedScroll {
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
                let requestedOffsetY = offset
                scroll.setContentOffset(CGPoint(x: initial.x, y: offset), animated: false)
                try await Task.sleep(for: .milliseconds(130))
                window.layoutIfNeeded()
                offset = scroll.contentOffset.y
                index += 1
                capturedScrollPositions += 1
                if viewportRecorder != nil {
                    scrollStepDiagnostics.append(["index": index, "requestedOffsetY": requestedOffsetY,
                                                  "actualOffsetY": offset, "computedBottom": bottom,
                                                  "effectiveViewportHeight": viewportHeight])
                }
                record("scroll-\(String(format: "%02d", index))")
            }
            let finalBottom = max(-scroll.adjustedContentInset.top,
                                  scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            XCTAssertLessThanOrEqual(finalBottom - offset, 2, "Incomplete below-fold capture: \(page.name)")
            if viewportRecorder != nil, let selectedIndex = nativeScrollCandidates.firstIndex(where: { $0 === scroll }) {
                selectedFinalDiagnostic = scrollDiagnostic(scroll, index: selectedIndex)
            }
            scroll.setContentOffset(initial, animated: false)
        }
        if viewportRecorder != nil {
            let data = try JSONSerialization.data(withJSONObject: [
                "page": page.name, "scheme": scheme == .light ? "light" : "dark",
                "dynamicType": size.isAccessibilitySize ? "accessibility3" : "large",
                "windowFrame": ["x": window.frame.minX, "y": window.frame.minY,
                                "width": window.frame.width, "height": window.frame.height],
                "windowBounds": ["x": window.bounds.minX, "y": window.bounds.minY,
                                 "width": window.bounds.width, "height": window.bounds.height],
                "hostSafeAreaInsets": ["top": host.view.safeAreaInsets.top, "left": host.view.safeAreaInsets.left,
                                       "bottom": host.view.safeAreaInsets.bottom, "right": host.view.safeAreaInsets.right],
                "requiresScrolling": requiresScrolling, "capturedScrollPositions": capturedScrollPositions,
                "selectionRule": "Existing70percentwidth/35percentheight/overflow>effectiveviewport+2; greatest bounds.height. No fallback or selection-policy change.",
                "selectedCandidateIndex": nativeScrollCandidates.firstIndex(where: { $0 === selectedScroll }).map { $0 as Any } ?? NSNull(),
                "allInitialNativeScrollCandidates": initialScrollDiagnostics,
                "selectedFinalBeforeRestore": selectedFinalDiagnostic.map { $0 as Any } ?? NSNull(),
                "scrollSteps": scrollStepDiagnostics,
                "allNativeScrollCandidatesAfterRestore": nativeScrollCandidates.enumerated().map { scrollDiagnostic($0.element, index: $0.offset) },
                "fixtureEndMarker": "SURFACE-PADDING-END-OF-TRAVEL-PLAN-2026-10-23",
                "reviewLimit": "The semantic long-content precondition was corrected; this does not prove the original fixture fit or identify the original zero-scroll cause. Inspect actual geometry and PNG marker in an authorized native run."
            ], options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "\(page.name)-\(scheme == .light ? "light" : "dark")-\(Int(window.bounds.width))-\(size.isAccessibilitySize ? "AX3" : "large")-native-scroll-diagnostics"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        if requiresScrolling {
            XCTAssertGreaterThan(capturedScrollPositions, 0, "Long message fixture was not captured below the fold: \(page.name)")
        }
        if let viewportRecorder {
            let safeArea = host.view.safeAreaInsets
            let expectedWidth = max(0, window.bounds.width - safeArea.left - safeArea.right)
            let rows: [[String: Any]] = viewportRecorder.measurements.keys.sorted().compactMap { id in
                guard let measured = viewportRecorder.measurements[id] else { return nil }
                return [
                    "messageID": id, "rawRootWidth": measured.rawRootWidth,
                    "outerAvailableWidth": measured.outerAvailableWidth,
                    "leadingSafeArea": measured.leadingSafeArea, "trailingSafeArea": measured.trailingSafeArea,
                    "effectiveInheritedWidth": measured.inheritedWidth.map { $0 as Any } ?? NSNull(),
                    "accessibility": measured.accessibility,
                ]
            }
            let data = try JSONSerialization.data(withJSONObject: [
                "page": page.name, "scheme": scheme == .light ? "light" : "dark",
                "dynamicType": size.isAccessibilitySize ? "accessibility3" : "large",
                "windowWidth": window.bounds.width, "hostSafeAreaLeft": safeArea.left,
                "hostSafeAreaRight": safeArea.right, "expectedEffectiveWidth": expectedWidth,
                "expectedMessageIDs": viewportRecorder.expectedMessageIDs.sorted(),
                "missingMessageIDs": viewportRecorder.expectedMessageIDs.subtracting(viewportRecorder.measurements.keys).sorted(),
                "bubbles": rows,
            ], options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "\(page.name)-\(scheme == .light ? "light" : "dark")-\(Int(window.bounds.width))-\(size.isAccessibilitySize ? "AX3" : "large")-viewport-receipt"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertEqual(Set(viewportRecorder.measurements.keys), viewportRecorder.expectedMessageIDs,
                           "Every production MessageBubble root must report in this capture; stale or missing receipts fail")
            if let additionalSafeAreaInsets {
                XCTAssertGreaterThan(safeArea.left + safeArea.right, 0, "The nonzero safe-area fixture must actually take effect")
                XCTAssertEqual(safeArea.left, additionalSafeAreaInsets.left, accuracy: 0.5)
                XCTAssertEqual(safeArea.right, additionalSafeAreaInsets.right, accuracy: 0.5)
            }
            for id in viewportRecorder.expectedMessageIDs.sorted() {
                let measured = try XCTUnwrap(viewportRecorder.measurements[id], "Missing viewport receipt: \(id)")
                let inheritedWidth = try XCTUnwrap(measured.inheritedWidth, "Bubble did not inherit its viewport: \(id)")
                XCTAssertEqual(measured.rawRootWidth, window.bounds.width, accuracy: 0.5,
                               "The ignored inner stage measures the full window before transcript gutters")
                XCTAssertEqual(measured.outerAvailableWidth, expectedWidth, accuracy: 0.5,
                               "The outer pre-ignore producer already measures the available horizontal safe viewport")
                XCTAssertEqual(measured.leadingSafeArea, safeArea.left, accuracy: 0.5)
                XCTAssertEqual(measured.trailingSafeArea, safeArea.right, accuracy: 0.5)
                XCTAssertEqual(inheritedWidth, expectedWidth, accuracy: 0.5,
                               "The bubble inherits the outer available width directly without a second safe-area subtraction")
                XCTAssertEqual(measured.accessibility, size.isAccessibilitySize)
                let inset = AssistantTheme.ConversationSpacing.horizontalInset(
                    viewportWidth: inheritedWidth, accessibility: measured.accessibility)
                XCTAssertEqual(inset, size.isAccessibilitySize || expectedWidth <= 360 ? 20 : 24)
            }
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

@MainActor
private final class ConnectedToolReviewCallbacks {
    var actions: [String] = []
    var removals = 0
}

private struct ConnectedToolsActionCardFrameKey: PreferenceKey {
    static var defaultValue = CGRect.zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if !next.isEmpty { value = next }
    }
}

private struct ConnectedToolsActionRowReviewCard: View {
    @Environment(\.colorScheme) private var colorScheme
    let row: ConnectedToolActionRow
    let layoutReporter: (@MainActor ([String: CGRect]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Home Assistant")
                .font(.headline)
            row
        }
        .assistantCard(in: colorScheme)
        .background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ConnectedToolsActionCardFrameKey.self,
                    value: proxy.frame(in: .global)
                )
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .onPreferenceChange(ConnectedToolsActionCardFrameKey.self) { frame in
            guard !frame.isEmpty else { return }
            layoutReporter?(["card.surface": frame])
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
    init(transcriptMessageCount: Int? = nil, emptyDocuments: Bool = false, longDocumentTitle: Bool = false) throws {
        let encoder = JSONEncoder()
        func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
        let stamp = "2026-10-03T09:00:00Z"
        let health = MemoryHealth(totalUsable: 42, notYetOrganized: 3, awaitingReview: 1, ownerConfirmed: 17, lastOrganizedAt: stamp)
        let baseMessages = [
            ChatMessage(id: "owner-message", role: .user, parts: [.init(type: "text", text: "Help me plan the weekend and keep an eye on the bookings.")]),
            ChatMessage(id: "assistant-message", role: .assistant, parts: [.init(type: "text", text: "I found three good options. I’ll keep the arrival details together and ask before making a booking."), RichMessageFixture.generated()])
        ]
        let transcript = transcriptMessageCount.map { count in
            (0..<max(0, count)).map { index in
                let isAssistant = index.isMultiple(of: 2)
                let text = isAssistant
                    ? "Reply \(index / 2 + 1): I checked the details and kept the next step clear. **This is distinct transcript content** so the visual review can scroll to older messages."
                    : "Question \(index / 2 + 1): Please keep this detail with the weekend plan and the arrival information."
                return ChatMessage(id: "visual-review-transcript-\(index)",
                                   role: isAssistant ? .assistant : .user,
                                   parts: [.init(type: "text", text: text)])
            } + baseMessages
        } ?? baseMessages
        let conversation = ConversationView(conversation: .init(id: "main", title: "Your assistant", modelOverride: nil, archivedAt: nil, isPrimary: true), agentName: "Assistant", agentTimezone: "America/Los_Angeles", messages: transcript, models: [.init(id: "review-model", label: "Default assistant model")], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        let bootstrap = BootstrapResponse(generatedAt: stamp, identity: .init(id: "fixture-owner", name: "Assistant", avatarUrl: nil), shell: .init(dashboard: .init(pendingApprovals: 1, needsAttention: 1, presence: .idle), memoryHealth: health), conversation: conversation)
        let pending = PendingApproval(approval: .init(id: "approval", taskId: "task", shortCode: "A12", summary: "Send Robin the confirmed arrival time", payload: .object(["to": .string("robin@example.test"), "subject": .string("Weekend arrival"), "body": .string("I’ll arrive at 4:30 PM on Friday.")]), resolutionPayload: nil, status: "pending", requestedAt: stamp, resolvedAt: nil, resolvedVia: nil, expiresAt: "2026-10-04T09:00:00Z"), taskType: "chat_turn", taskTrust: "owner", toolName: "gmail.send", decision: .object([:]))
        let docs = DocumentsOverview(
            documents: emptyDocuments ? [] : [.init(id: "document", title: longDocumentTitle
                ? "Confirmed family travel arrangements and payment receipts for the autumn weekend (revised copy).pdf"
                : "Weekend booking confirmation.pdf", mime: "application/pdf", source: "upload", trust: "owner", status: "ready", extractor: "pdf", chunkCount: 4, charCount: 2100, bytes: 31840, error: nil, createdAt: stamp)],
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
