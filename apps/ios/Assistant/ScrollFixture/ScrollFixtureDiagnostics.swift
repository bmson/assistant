#if ASSISTANT_SCROLL_FIXTURE
import SwiftUI
import UIKit

struct ScrollFixtureGeometry: Equatable {
    var offset: CGFloat = 0
    var rawOffset: CGFloat = 0
    var visibleMinY: CGFloat = 0
    var visibleMaxY: CGFloat = 0
    var visibleHeight: CGFloat = 0
    var viewport: CGFloat = 0
    var content: CGFloat = 0
    var bottomInset: CGFloat = 0
    var topInset: CGFloat = 0
    var bottomGap: CGFloat { content - visibleMaxY }
    var bottom: CGFloat { max(0, content - viewport + topInset + bottomInset) }
}

struct ScrollFixtureOwnership: Equatable {
    let menuClosed: Bool
    let menuOwnsSurface: Bool
    let readerFollowsLatest: Bool
    let positionedByUser: Bool
    let unexpectedOverlay: Bool
    let composerFocused: Bool
}

/// Not Observable: geometry only replaces a small value. Accessibility reads a
/// snapshot on demand; no per-frame publications, JSON encoding or UI rebuilds.
@MainActor
final class ScrollFixtureDiagnostics {
    static let shared = ScrollFixtureDiagnostics()
    let launchID = UUID().uuidString
    var failure: String?
    var fixtureRows = 0
    var geometry = ScrollFixtureGeometry() {
        didSet { lastGeometryAt = ProcessInfo.processInfo.systemUptime }
    }
    var viewportFrame = CGRect.zero
    private var phase = "idle"
    private var events: [(phase: String, uptime: Double)] = []
    private var ownership: ScrollFixtureOwnership?
    private var everMenuClaimed = false
    private var everUnexpectedOverlay = false
    private var everComposerFocused = false
    private var lastGeometryAt = ProcessInfo.processInfo.systemUptime

    func recordOwnership(_ state: ScrollFixtureOwnership) {
        ownership = state
        everMenuClaimed = everMenuClaimed || !state.menuClosed || state.menuOwnsSurface
        everUnexpectedOverlay = everUnexpectedOverlay || state.unexpectedOverlay
        everComposerFocused = everComposerFocused || state.composerFocused
    }

    func record(_ next: ScrollPhase) {
        phase = String(describing: next)
        let expected: [String]
        switch next {
        case .interacting: expected = []
        case .decelerating: expected = ["interacting"]
        case .idle:
            guard !events.isEmpty else { return } // Initial programmatic anchor.
            expected = ["interacting", "decelerating"]
        default: return // Tracking/programmatic animation is not a measured phase.
        }
        guard events.map(\.phase) == expected else {
            failure = "Unexpected scroll phase order: \(events.map(\.phase)) → \(phase)"
            return
        }
        events.append((phase, ProcessInfo.processInfo.systemUptime))
    }

    var snapshot: String {
        let now = ProcessInfo.processInfo.systemUptime
        var payload: [String: Any] = [
            "launchID": launchID,
            "fixtureRows": fixtureRows,
            "failure": failure ?? "",
            "phase": phase,
            "offset": Double(geometry.offset),
            "rawOffset": Double(geometry.rawOffset),
            "visibleMinY": Double(geometry.visibleMinY),
            "visibleMaxY": Double(geometry.visibleMaxY),
            "visibleHeight": Double(geometry.visibleHeight),
            "bottomGap": Double(geometry.bottomGap),
            "bottom": Double(geometry.bottom),
            "viewport": Double(geometry.viewport),
            "content": Double(geometry.content),
            "topInset": Double(geometry.topInset),
            "bottomInset": Double(geometry.bottomInset),
            "viewportTop": Double(viewportFrame.minY),
            "viewportLeft": Double(viewportFrame.minX),
            "viewportWidth": Double(viewportFrame.width),
            "viewportFrameHeight": Double(viewportFrame.height),
            "capturedAt": now,
            "settled": phase == "idle" && now - lastGeometryAt >= 0.3,
            "completed": events.map(\.phase) == ["interacting", "decelerating", "idle"],
            "phaseEvents": events.map { ["phase": $0.phase, "uptime": $0.uptime] as [String: Any] },
            "ownershipReady": ownership != nil,
            "everMenuClaimed": everMenuClaimed,
            "everUnexpectedOverlay": everUnexpectedOverlay,
            "everComposerFocused": everComposerFocused,
            "simulator": Self.isSimulator,
            "maximumFramesPerSecond": UIScreen.main.maximumFramesPerSecond,
            "thermalState": ProcessInfo.processInfo.thermalState.rawValue,
        ]
        if let ownership {
            payload["menuClosed"] = ownership.menuClosed
            payload["menuOwnsSurface"] = ownership.menuOwnsSurface
            payload["readerFollowsLatest"] = ownership.readerFollowsLatest
            payload["positionedByUser"] = ownership.positionedByUser
            payload["unexpectedOverlay"] = ownership.unexpectedOverlay
            payload["composerFocused"] = ownership.composerFocused
        }
        // Absent pre-gesture timestamps remain absent, never a numeric sentinel.
        if let start = events.first { payload["gestureStart"] = start.uptime }
        if events.count > 1 { payload["decelerationStart"] = events[1].uptime }
        if events.count == 3 { payload["gestureEnd"] = events[2].uptime }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return "{\"failure\":\"diagnostics serialization\"}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }
}

struct ScrollFixtureProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> Probe {
        let view = Probe()
        view.isAccessibilityElement = true
        view.accessibilityIdentifier = "assistant.scroll-fixture.diagnostics"
        view.accessibilityLabel = "Scroll fixture diagnostics"
        view.accessibilityTraits = .staticText
        view.isUserInteractionEnabled = false
        return view
    }
    func updateUIView(_ uiView: Probe, context: Context) {}

    final class Probe: UIView {
        override var accessibilityValue: String? {
            get { ScrollFixtureDiagnostics.shared.snapshot }
            set {}
        }
    }
}
#endif
