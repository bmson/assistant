import XCTest
import SwiftUI
import UIKit
import QuartzCore
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

    /// Opt-in tooling feasibility only. Debug synthetic CPU capture is not FPS.
    @MainActor
    func testOwnedTranscriptProfilingCapability() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let token = environment["ASSISTANT_PROFILE_TOKEN"],
              UUID(uuidString: token) != nil else { throw XCTSkip("Profiling capability is explicitly opt-in") }
        guard !UserDefaults.standard.bool(forKey: "assistant.connection-configured") else {
            XCTFail("Profiling fixture forbids a saved connection and automatic bootstrap")
            return
        }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("profiling-capability-" + token, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        // Immutable payload; existing mixed Markdown/recall/card factory, no IO.
        let messages = Self.fixtureMessages(count: 100)
        let rows = ChatTranscriptRows(
            messages: messages, isSending: false,
            openApprovals: {}, send: { _, _ in },
            decideApproval: { _, _ in false }, rememberApproval: { _ in false },
            decideSuggestion: { _, _ in nil }, openActivity: {},
            refreshCard: { _, _ in nil }, hideMessage: { _ in },
            setRecallSourceSuppressed: { _, _, _ in .failed },
            recallSourceSuppressed: { _, _ in nil }, acknowledgeMessageDelivery: { _ in false },
            cardFormActions: nil, cardFormStateRevision: 0, cardFormTaskRevision: 0
        )
        let host = UIHostingController(rootView: ConversationColumn {
            ScrollView { rows.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 100) }
        } composer: {
            ProfilingCapabilityComposer().frame(height: 52)
        }.environment(\.colorScheme, .light).environment(\.dynamicTypeSize, .large))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKey()
        }
        try await Task.sleep(for: .milliseconds(350))
        window.layoutIfNeeded()
        host.view.layoutIfNeeded()
        let scroll = try XCTUnwrap(Self.scrollView(in: window))
        let bottom = Self.bottomOffset(of: scroll)
        XCTAssertGreaterThan(bottom, scroll.bounds.height * 2)
        func composerView(in view: UIView) -> UIView? {
            if view.accessibilityIdentifier == "profiling-capability-composer" { return view }
            for child in view.subviews {
                if let result = composerView(in: child) { return result }
            }
            return nil
        }
        let composer = try XCTUnwrap(composerView(in: window))
        let viewportFrame = scroll.convert(scroll.bounds, to: window)
        let composerFrame = composer.convert(composer.bounds, to: window)
        XCTAssertFalse(composer.isDescendant(of: scroll))
        XCTAssertTrue(viewportFrame.intersects(composerFrame))
        XCTAssertGreaterThan(viewportFrame.height, composerFrame.height)
        guard bottom > scroll.bounds.height * 2,
              !composer.isDescendant(of: scroll),
              viewportFrame.intersects(composerFrame),
              viewportFrame.height > composerFrame.height else { return }
        let ready: [String: Any] = [
            "version": 1, "token": token, "pid": ProcessInfo.processInfo.processIdentifier,
            "configuration": "Debug-testability", "messageCount": messages.count,
            "messageIDs": messages.map(\.id), "fixture": "existing-mixed-scroll-fixture-v1",
            "contentHeight": scroll.contentSize.height, "viewportHeight": scroll.bounds.height,
            "bottomOffset": bottom, "windowWidth": window.bounds.width, "windowHeight": window.bounds.height,
            "viewportInWindow": [viewportFrame.minX, viewportFrame.minY, viewportFrame.width, viewportFrame.height],
            "composerInWindow": [composerFrame.minX, composerFrame.minY, composerFrame.width, composerFrame.height],
            "coverage": "100 loaded messages; scroll path traverses full native content range, visible-row count not instrumented",
            "savedConnectionConfigured": false,
            "readinessMonotonic": CACurrentMediaTime(), "presentedFrames": "unavailable"
        ]
        try JSONSerialization.data(withJSONObject: ready, options: [.sortedKeys])
            .write(to: directory.appendingPathComponent("ready.json"), options: .atomic)
        // Readiness and layout checks occur before the capture starts. The
        // controller writes start only after xctrace's tracing-started notification.
        let deadline = ContinuousClock.now.advanced(by: .seconds(45))
        while !FileManager.default.fileExists(atPath: directory.appendingPathComponent("start").path),
              ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        guard FileManager.default.fileExists(atPath: directory.appendingPathComponent("start").path) else {
            XCTFail("No confirmed capture-start barrier before bounded deadline")
            return
        }
        let recorder = TranscriptScrollRecorder(scrollView: scroll, duration: 5)
        await recorder.run()
        // No geometry observers, screenshots or attachment writes in workload.
        let result: [String: Any] = [
            "version": 1, "token": token, "elapsed": recorder.elapsed,
            "timedOut": recorder.timedOut, "callbackIntervals": recorder.intervals,
            "finalOffset": scroll.contentOffset.y, "expectedBottom": bottom,
            "completedMonotonic": CACurrentMediaTime(),
            "claim": "Debug synthetic callback pacing and CPU-tool feasibility only; no presented-frame/FPS claim"
        ]
        try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            .write(to: directory.appendingPathComponent("done.json"), options: .atomic)
        XCTAssertFalse(recorder.timedOut)
        XCTAssertGreaterThanOrEqual(recorder.elapsed, 5)
        XCTAssertGreaterThanOrEqual(scroll.contentOffset.y, bottom - 2)
        // Keep this exact app PID alive while xctrace closes its bounded trace.
        let finishDeadline = ContinuousClock.now.advanced(by: .seconds(30))
        while !FileManager.default.fileExists(atPath: directory.appendingPathComponent("release").path),
              ContinuousClock.now < finishDeadline {
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    private static func fixtureMessages(count: Int) -> [ChatMessage] {
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
            return ChatMessage(id: "scroll-bench-assistant-\(index)", role: .assistant, parts: parts)
        }
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

/// Test-only sibling composer with directly observable UIKit geometry. No IO.
private struct ProfilingCapabilityComposer: UIViewRepresentable {
    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.text = "Offline profiling fixture composer"
        label.backgroundColor = .secondarySystemBackground
        label.accessibilityIdentifier = "profiling-capability-composer"
        return label
    }
    func updateUIView(_ view: UILabel, context: Context) {}
}
