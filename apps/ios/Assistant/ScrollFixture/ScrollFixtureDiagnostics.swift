#if ASSISTANT_SCROLL_FIXTURE
import SwiftUI
import UIKit

struct ScrollFixtureGeometry: Equatable {
    var offset: CGFloat = 0
    var viewport: CGFloat = 0
    var content: CGFloat = 0
    var bottomInset: CGFloat = 0
    var topInset: CGFloat = 0
    var bottom: CGFloat { max(0, content - viewport + topInset + bottomInset) }
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
    private var phase = "idle"
    private var interacted = false
    private var decelerated = false
    private var completed = false
    private var gestureStart: Double?
    private var gestureEnd: Double?
    private var lastGeometryAt = ProcessInfo.processInfo.systemUptime

    func record(_ next: ScrollPhase) {
        phase = String(describing: next)
        switch next {
        case .interacting:
            if !interacted { gestureStart = ProcessInfo.processInfo.systemUptime }
            interacted = true
        case .decelerating:
            decelerated = true
        case .idle:
            if interacted {
                completed = true
                gestureEnd = ProcessInfo.processInfo.systemUptime
            }
        default: break
        }
    }

    var snapshot: String {
        let now = ProcessInfo.processInfo.systemUptime
        let payload: [String: Any] = [
            "launchID": launchID,
            "fixtureRows": fixtureRows,
            "failure": failure ?? "",
            "phase": phase,
            "offset": Double(geometry.offset),
            "bottom": Double(geometry.bottom),
            "viewport": Double(geometry.viewport),
            "content": Double(geometry.content),
            "settled": phase == "idle" && now - lastGeometryAt >= 0.3,
            "interacted": interacted,
            "decelerated": decelerated,
            "completed": completed,
            "gestureStart": gestureStart ?? -1,
            "gestureEnd": gestureEnd ?? -1,
            "simulator": Self.isSimulator,
            "maximumFramesPerSecond": UIScreen.main.maximumFramesPerSecond,
            "thermalState": ProcessInfo.processInfo.thermalState.rawValue,
        ]
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
