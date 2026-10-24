#if DEBUG
import SwiftUI
import UIKit

/// Deliberately isolated experiment. Nothing opts in outside its focused tests.
/// Three retained hosts are a lifetime hypothesis, not a production renderer.
@MainActor
final class NativeTranscriptExperimentSession {
    struct Scope: Hashable {
        let ownerID: String
        let serverIdentity: String
        let connectionEpoch: Int
        let conversationID: String
    }
    enum Kind: String, Hashable { case plain, rich, receipts }
    struct Row {
        let kind: Kind
        let messages: [ChatMessage]
        let streaming: Bool
        var id: String {
            kind == .receipts
                ? ChatTranscriptItem.approvedReceiptGroup(messages, firstIndex: 0).id
                : messages[0].id
        }
        var durableAssistant: Bool {
            kind != .receipts && !streaming && !id.hasPrefix("stream-")
                && messages[0].isDurableLogRow && messages[0].role == .assistant
        }
    }
    enum Change: Equatable { case initial, values, arrival, provisionalToDurable, membership }
    struct Snapshot {
        let scope: Scope
        let revision: Int
        let actionRevision: Int
        let rows: [Row]
        let change: Change
        init(scope: Scope, revision: Int, actionRevision: Int = 0, rows: [Row], change: Change) {
            precondition(rows.count == 3 && Set(rows.map(\.kind)).count == 3)
            precondition(rows.map(\.kind) == [.plain, .rich, .receipts])
            precondition(rows.allSatisfy { !$0.messages.isEmpty })
            precondition(Set(rows.map(\.id)).count == 3)
            self.scope = scope; self.revision = revision; self.actionRevision = actionRevision
            self.rows = rows; self.change = change
        }
    }
    struct Key: Hashable { let scope: Scope; let itemID: String; let kind: Kind }
    struct Lease: Equatable {
        enum Action: Equatable { case probe, delivery }
        let key: Key
        let action: Action
        let actionRevision: Int
        let generation: Int
    }
    struct Anchor {
        let itemID: String?
        let preFrame: CGRect?
        let preOffset: CGFloat
        let preHeight: CGFloat
        let fraction: CGFloat?
        let reason: String
    }
    struct Restoration {
        let anchor: Anchor
        let newFrame: CGRect?
        let viewportHeight: CGFloat
        let contentHeight: CGFloat
        let requested: CGFloat
        let clamped: CGFloat
        let actual: CGFloat
        let suppressedByGesture: Bool
        let reason: String
        let clampReason: String
        var clampDelta: CGFloat { clamped - requested }
    }
    struct ContextReceipt: Equatable {
        let revision: Int
        let modelIdentity: ObjectIdentifier
        let colorScheme: ColorScheme
        let contrast: ColorSchemeContrast
        let typeSize: DynamicTypeSize
        let locale: String
        let calendar: Calendar.Identifier
        let timeZone: String
        let direction: LayoutDirection
        let scene: ScenePhase
        let enabled: Bool
        let reduceMotion: Bool
        let reduceTransparency: Bool
        let fixtureViewportWidth: CGFloat?
    }
    struct Geometry {
        let scope: Scope
        let bounds: CGRect
        let frame: CGRect
        let viewportInWindow: CGRect
        let stationaryInWindow: CGRect
        let composerInWindow: CGRect
        let noticeInWindow: CGRect?
        let rowFramesInWindow: [String: CGRect]
        let contentInset: UIEdgeInsets
        let adjustedInset: UIEdgeInsets
        let offset: CGPoint
        let contentSize: CGSize
        let windowBounds: CGRect
        let windowSafeArea: UIEdgeInsets
        let header: CGFloat
        let footer: CGFloat
        let reveal: CGFloat
    }
    enum CrownOcclusion { case unavailable, absent, measured(CGRect) }
    var crownOcclusion: CrownOcclusion = .unavailable { didSet { refreshVisibility() } }
    var coveringPresentation = false { didSet { refreshVisibility() } }
    private(set) var snapshot: Snapshot
    private(set) var events: [String] = []
    private(set) var geometry: Geometry?
    private(set) var restorations: [Restoration] = []
    private(set) var contextRevisions: [String: Int] = [:]
    private(set) var contextReceipts: [String: ContextReceipt] = [:]
    private(set) var mountTokens: [String: UUID] = [:]
    private(set) var completionValues: [Key: String] = [:]
    private var diagnosticSequence = 0
    private var configureDiagnosticCount = 0
    private var captureDiagnosticCount = 0
    private var configureDiagnostics: [[String: Any]] = []
    private var captureDiagnostics: [[String: Any]] = []
    private var parentBoundaryCounts: [DiagnosticCall: Int] = [:]
    private var parentBoundaryDiagnostics: [DiagnosticCall: [[String: Any]]] = [:]
    var acknowledge: ((String) async -> Bool)?
    weak var controller: NativeTranscriptExperimentController?
    var setReveal: ((CGFloat) -> Void)?
    var stationaryView: UIView?
    var composerView: UIView?
    var noticeView: UIView?
    init(snapshot: Snapshot) { self.snapshot = snapshot }
    func event(_ value: String) { events.append(value) }
    enum DiagnosticCall: String, Hashable {
        case configure, capture
        case composerGeometryAction = "composer-geometry-action"
        case nativeReplacementConstruction = "native-replacement-construction"
        case nativeTranscriptSelectorEvaluation = "native-transcript-selector-evaluation"
        case representableUpdateEntry = "representable-update-entry"
    }
    func observe(_ call: DiagnosticCall, values: [String: Any]) {
        diagnosticSequence += 1
        var sample = values
        sample["sequence"] = diagnosticSequence
        switch call {
        case .configure:
            configureDiagnosticCount += 1
            configureDiagnostics.append(sample)
            configureDiagnostics = Array(configureDiagnostics.suffix(8))
        case .capture:
            captureDiagnosticCount += 1
            captureDiagnostics.append(sample)
            captureDiagnostics = Array(captureDiagnostics.suffix(8))
        case .composerGeometryAction, .nativeReplacementConstruction, .nativeTranscriptSelectorEvaluation, .representableUpdateEntry:
            parentBoundaryCounts[call, default: 0] += 1
            var history = parentBoundaryDiagnostics[call] ?? []
            history.append(sample)
            parentBoundaryDiagnostics[call] = Array(history.suffix(8))
        }
    }
    /// Passive observation only: never asks UIKit to lay out or capture again.
    func readinessDiagnosticSnapshot() -> [String: Any] {
        let parentCalls: [DiagnosticCall] = [.composerGeometryAction, .nativeReplacementConstruction,
                                             .nativeTranscriptSelectorEvaluation, .representableUpdateEntry]
        let boundaries = Dictionary(uniqueKeysWithValues: parentCalls.map { call in
            let count = parentBoundaryCounts[call] ?? 0
            return (call.rawValue, ["presence": count > 0 ? "observed" : "not-observed", "total": count,
                                   "last8": parentBoundaryDiagnostics[call] ?? []] as [String: Any])
        })
        return ["schema": "native-experiment-readiness-diagnostics/v1", "sampleKind": "final-passive",
         "session": ["scope": NativeExperimentDiagnostic.scope(snapshot.scope), "revision": snapshot.revision,
                     "actionRevision": snapshot.actionRevision, "expectedRowIDs": snapshot.rows.map(\.id),
                     "controllerID": NativeExperimentDiagnostic.identity(controller),
                     "geometry": NativeExperimentDiagnostic.geometry(geometry)],
         "controller": controller?.passiveDiagnosticSnapshot() as Any? ?? NSNull(),
         "readiness": NativeExperimentDiagnostic.readiness(geometry),
         "configure": ["total": configureDiagnosticCount, "last8": configureDiagnostics],
         "capture": ["total": captureDiagnosticCount, "last8": captureDiagnostics],
         "parentPropagation": ["schema": "native-experiment-parent-propagation/v1", "boundaries": boundaries,
                               "assignmentMeaning": "assignedValue is the write RHS, not a committed state read",
                               "selectorAbsenceMeaning": "No native-branch observation does not prove fallback selection"]]
    }
    func apply(_ value: Snapshot) {
        guard value.scope != snapshot.scope || value.revision > snapshot.revision else {
            event("stale-snapshot-rejected"); return
        }
        if value.scope != snapshot.scope {
            invalidateGeometry()
            mountTokens.removeAll(); contextRevisions.removeAll(); contextReceipts.removeAll(); completionValues.removeAll()
        }
        snapshot = value
        controller?.apply(value)
    }
    func reveal(_ points: CGFloat) { setReveal?(points) }
    func refreshVisibility() { controller?.captureGeometry(); controller?.recomputeVisibility() }
    func record(_ value: Geometry) { geometry = value }
    func invalidateGeometry() { geometry = nil }
    func restoration(_ value: Restoration) { restorations.append(value) }
    func mounted(_ key: Key, token: UUID, revision: Int) {
        guard key.scope == snapshot.scope else { event("stale-mount-observation"); return }
        if let old = mountTokens[key.itemID], old != token { event("REMOUNT:\(key.itemID)") }
        mountTokens[key.itemID] = token; contextRevisions[key.itemID] = revision
    }
    func context(_ value: ContextReceipt, key: Key) {
        guard key.scope == snapshot.scope else { return }
        contextReceipts[key.itemID] = value
    }
    func beginLease(itemID: String) -> Lease? { controller?.beginLease(itemID: itemID) }
    @discardableResult
    func complete(_ lease: Lease, value: String) -> Bool {
        guard controller?.leaseIsCurrent(lease) == true else { event("stale-completion-rejected"); return false }
        completionValues[lease.key] = value; return true
    }
    static func anchor(oldIDs: [String], newIDs: Set<String>, selected: String?,
                       frames: [String: CGRect], offset: CGFloat, height: CGFloat) -> Anchor {
        var chosen = selected
        var reason = "same-anchor"
        if let selected, !newIDs.contains(selected), let index = oldIDs.firstIndex(of: selected) {
            chosen = oldIDs[..<index].reversed().first(where: newIDs.contains)
            reason = "nearest-surviving-predecessor"
            if chosen == nil {
                chosen = oldIDs.dropFirst(index + 1).first(where: newIDs.contains)
                reason = "nearest-surviving-successor"
            }
        }
        guard let id = chosen, newIDs.contains(id), let frame = frames[id],
              frame.minY.isFinite, frame.height.isFinite, frame.width.isFinite,
              frame.height > 0, frame.width > 0, height.isFinite, height > 0, offset.isFinite else {
            return .init(itemID: nil, preFrame: nil, preOffset: offset, preHeight: height,
                         fraction: nil, reason: "absolute-fallback-missing-survivor-or-actual-attributes")
        }
        return .init(itemID: id, preFrame: frame, preOffset: offset, preHeight: height,
                     fraction: (frame.minY - offset) / height, reason: reason)
    }
    /// Exact union subtraction; full row area remains the denominator.
    static func visibleFraction(row: CGRect, viewport: CGRect, window: CGRect, occlusions: [CGRect]) -> CGFloat {
        guard row.width > 0, row.height > 0 else { return 0 }
        var pieces = [row.intersection(viewport).intersection(window)].filter { !$0.isNull && !$0.isEmpty }
        for cover in occlusions {
            pieces = pieces.flatMap { rectangle -> [CGRect] in
                let cut = rectangle.intersection(cover)
                guard !cut.isNull, !cut.isEmpty else { return [rectangle] }
                return [CGRect(x: rectangle.minX, y: rectangle.minY, width: rectangle.width, height: cut.minY - rectangle.minY),
                        CGRect(x: rectangle.minX, y: cut.maxY, width: rectangle.width, height: rectangle.maxY - cut.maxY),
                        CGRect(x: rectangle.minX, y: cut.minY, width: cut.minX - rectangle.minX, height: cut.height),
                        CGRect(x: cut.maxX, y: cut.minY, width: rectangle.maxX - cut.maxX, height: cut.height)]
                    .filter { $0.width > 0 && $0.height > 0 }
            }
        }
        return pieces.reduce(0) { $0 + $1.width * $1.height } / (row.width * row.height)
    }
}

/// Value copies only. Histories never retain views/windows or request layout.
@MainActor
enum NativeExperimentDiagnostic {
    struct Scalar { let value: Double }
    static func number(_ value: CGFloat) -> Scalar { Scalar(value: Double(value)) }
    static func nullable<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }
    static func identity(_ object: AnyObject?) -> Any {
        guard let object else { return NSNull() }
        return String(describing: ObjectIdentifier(object))
    }
    static func scope(_ value: NativeTranscriptExperimentSession.Scope?) -> Any {
        guard let value else { return NSNull() }
        return ["ownerID": value.ownerID, "serverIdentity": value.serverIdentity,
                "connectionEpoch": value.connectionEpoch, "conversationID": value.conversationID] as [String: Any]
    }
    static func rect(_ value: CGRect) -> [String: Any] {
        ["x": number(value.origin.x), "y": number(value.origin.y),
         "width": number(value.size.width), "height": number(value.size.height)]
    }
    static func size(_ value: CGSize) -> [String: Any] { ["width": number(value.width), "height": number(value.height)] }
    static func point(_ value: CGPoint) -> [String: Any] { ["x": number(value.x), "y": number(value.y)] }
    static func insets(_ value: UIEdgeInsets) -> [String: Any] {
        ["top": number(value.top), "left": number(value.left), "bottom": number(value.bottom), "right": number(value.right)]
    }
    static func window(_ value: UIWindow?) -> Any {
        guard let value else { return NSNull() }
        return ["id": identity(value), "hidden": value.isHidden, "bounds": rect(value.bounds)] as [String: Any]
    }
    static func view(_ value: UIView?) -> [String: Any] {
        guard let value else { return ["present": false, "objectID": NSNull(), "windowID": NSNull(),
                                        "windowHidden": NSNull(), "bounds": NSNull(), "frame": NSNull()] }
        return ["present": true, "objectID": identity(value), "windowID": identity(value.window),
                "windowHidden": nullable(value.window?.isHidden), "bounds": rect(value.bounds), "frame": rect(value.frame)]
    }
    static func geometry(_ value: NativeTranscriptExperimentSession.Geometry?) -> Any {
        guard let value else { return NSNull() }
        return ["scope": scope(value.scope), "bounds": rect(value.bounds), "frame": rect(value.frame),
                "viewportInWindow": rect(value.viewportInWindow), "stationaryInWindow": rect(value.stationaryInWindow),
                "composerInWindow": rect(value.composerInWindow), "noticeInWindow": value.noticeInWindow.map { rect($0) as Any } ?? NSNull(),
                "rowFramesInWindow": value.rowFramesInWindow.mapValues { rect($0) }, "contentInset": insets(value.contentInset),
                "adjustedInset": insets(value.adjustedInset), "offset": point(value.offset), "contentSize": size(value.contentSize),
                "windowBounds": rect(value.windowBounds), "windowSafeArea": insets(value.windowSafeArea),
                "header": number(value.header), "footer": number(value.footer), "reveal": number(value.reveal)] as [String: Any]
    }
    static func readiness(_ value: NativeTranscriptExperimentSession.Geometry?) -> [String: Any] {
        guard let value else {
            return ["A_geometryAvailable": false, "B_rowCountExactly3": NSNull(), "C_composerHeightPositive": NSNull(),
                    "D_footerDifferenceBelowHalfPoint": NSNull(), "overall": false, "rowIDs": NSNull(),
                    "rowCount": NSNull(), "composerHeight": NSNull(), "footer": NSNull(), "footerDifference": NSNull()]
        }
        let b = value.rowFramesInWindow.count == 3
        let c = value.composerInWindow.height > 0
        let delta = value.footer - value.composerInWindow.height - 18
        let d = abs(delta) < 0.5
        return ["A_geometryAvailable": true, "B_rowCountExactly3": b, "C_composerHeightPositive": c,
                "D_footerDifferenceBelowHalfPoint": d, "overall": b && c && d,
                "rowIDs": value.rowFramesInWindow.keys.sorted(), "rowCount": value.rowFramesInWindow.count,
                "composerHeight": number(value.composerInWindow.height), "footer": number(value.footer), "footerDifference": number(delta)]
    }
}

private struct NativeExperimentViewportSizeKey: EnvironmentKey { static let defaultValue = CGSize.zero }
private struct NativeExperimentFixtureViewportWidthKey: EnvironmentKey { static let defaultValue: CGFloat? = nil }
extension EnvironmentValues {
    /// Fixture context only. Actual f97 MessageBubble does not consume this key
    /// or PR680 adaptive width; its production scaled insets remain unchanged.
    var nativeExperimentFixtureViewportWidth: CGFloat? {
        get { self[NativeExperimentFixtureViewportWidthKey.self] }
        set { self[NativeExperimentFixtureViewportWidthKey.self] = newValue }
    }
    var nativeExperimentViewportSize: CGSize {
        get { self[NativeExperimentViewportSizeKey.self] }
        set { self[NativeExperimentViewportSizeKey.self] = newValue }
    }
}

/// Neither the old generic host nor its SwiftUI ScrollView is mounted in the
/// explicitly opted-in branch. The unchanged baseline remains the nil branch.
struct NativeExperimentColumnSelection<Transcript: View>: ViewModifier {
    let enabled: Bool
    let transcript: Transcript
    @ViewBuilder func body(content: Content) -> some View {
        if enabled { transcript.frame(maxWidth: .infinity, maxHeight: .infinity) }
        else { content }
    }
}
struct NativeExperimentTranscriptSelection: ViewModifier {
    let replacement: NativeTranscriptViewportExperiment?
    @ViewBuilder func body(content: Content) -> some View {
        if let replacement {
            let _ = replacement.session.observe(.nativeTranscriptSelectorEvaluation, values: [
                "sampleKind": "selector-evaluation", "branch": "native-replacement",
                "sessionID": NativeExperimentDiagnostic.identity(replacement.session),
                "footer": NativeExperimentDiagnostic.number(replacement.footer)])
            replacement
        }
        else { content }
    }
}

/// Public UIView coordinates only. These references never publish SwiftUI state.
struct NativeTranscriptExperimentMarker: UIViewRepresentable {
    enum Target { case stationary, composer, notice }
    let session: NativeTranscriptExperimentSession
    let target: Target
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.isUserInteractionEnabled = false
        switch target {
        case .stationary: session.stationaryView = view
        case .composer: session.composerView = view
        case .notice: session.noticeView = view
        }
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

fileprivate struct NativeExperimentPresentation {
    let model: AppModel
    let colorScheme: ColorScheme
    let contrast: ColorSchemeContrast
    let typeSize: DynamicTypeSize
    let locale: Locale
    let calendar: Calendar
    let timeZone: TimeZone
    let direction: LayoutDirection
    let reduceMotion: Bool
    let reduceTransparency: Bool
    let enabled: Bool
    let scene: ScenePhase
    let openURL: OpenURLAction
    let fixtureViewportWidth: CGFloat?
}

struct NativeTranscriptViewportExperiment: UIViewControllerRepresentable {
    let session: NativeTranscriptExperimentSession
    let header: CGFloat
    let footer: CGFloat
    let leading: CGFloat
    let trailing: CGFloat
    let reveal: CGFloat
    let revealInProgress: Bool
    let alignShortToBottom: Bool
    @Environment(AppModel.self) private var model
    @Environment(\.nativeExperimentViewportSize) private var viewportSize
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.locale) private var locale
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone
    @Environment(\.layoutDirection) private var direction
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.isEnabled) private var enabled
    @Environment(\.scenePhase) private var scene
    @Environment(\.openURL) private var openURL
    @Environment(\.nativeExperimentFixtureViewportWidth) private var fixtureViewportWidth
    private var presentation: NativeExperimentPresentation {
        .init(model: model, colorScheme: colorScheme, contrast: contrast, typeSize: typeSize,
              locale: locale, calendar: calendar, timeZone: timeZone, direction: direction,
              reduceMotion: reduceMotion, reduceTransparency: reduceTransparency,
              enabled: enabled, scene: scene, openURL: openURL, fixtureViewportWidth: fixtureViewportWidth)
    }
    func makeUIViewController(context: Context) -> NativeTranscriptExperimentController {
        NativeTranscriptExperimentController(session: session)
    }
    func updateUIViewController(_ controller: NativeTranscriptExperimentController, context: Context) {
        let suppliedViewportSize = viewportSize
        session.observe(.representableUpdateEntry, values: ["sampleKind": "representable-update-entry",
            "sessionID": NativeExperimentDiagnostic.identity(session), "controllerID": NativeExperimentDiagnostic.identity(controller),
            "footer": NativeExperimentDiagnostic.number(footer), "viewport": NativeExperimentDiagnostic.size(suppliedViewportSize)])
        controller.configure(size: suppliedViewportSize, header: header, footer: footer, leading: leading, trailing: trailing,
                             reveal: reveal, inProgress: revealInProgress, alignShort: alignShortToBottom,
                             presentation: presentation)
    }
}

private struct NativeExperimentRowRoot: View {
    let session: NativeTranscriptExperimentSession
    let key: NativeTranscriptExperimentSession.Key
    let row: NativeTranscriptExperimentSession.Row
    let revision: Int
    let presentation: NativeExperimentPresentation
    @State private var mount = UUID()
    var body: some View {
        Group {
            if row.kind == .receipts {
                ApprovedReceiptGroup(messages: row.messages)
            } else {
                // Visibility/acknowledgement is deliberately owned by the native
                // intersection policy, not SwiftUI's mounted scroll hook.
                MessageBubble(message: row.messages[0], userPrompt: nil, isStreaming: row.streaming,
                              openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil,
                              acknowledgeDelivery: nil)
            }
        }
        .background(NativeExperimentContextReader(session: session, key: key, revision: revision))
        // Contrast, Reduce Motion and Reduce Transparency are read-only system
        // values observed independently in each host. They are not forwarded;
        // these receipts do not prove controlled propagation or equivalence.
        .environment(presentation.model)
        .environment(\.colorScheme, presentation.colorScheme)
        .environment(\.dynamicTypeSize, presentation.typeSize)
        .environment(\.locale, presentation.locale)
        .environment(\.calendar, presentation.calendar)
        .environment(\.timeZone, presentation.timeZone)
        .environment(\.layoutDirection, presentation.direction)
        .environment(\.isEnabled, presentation.enabled)
        .environment(\.scenePhase, presentation.scene)
        .environment(\.openURL, presentation.openURL)
        .environment(\.nativeExperimentFixtureViewportWidth, presentation.fixtureViewportWidth)
        .onAppear { session.event("appear:\(key.itemID)"); session.mounted(key, token: mount, revision: revision) }
        .onDisappear { session.event("disappear:\(key.itemID)") }
        .onChange(of: revision) { _, value in session.mounted(key, token: mount, revision: value) }
        .task {
            session.event("task-start:\(key.itemID)")
            for await _ in AsyncStream<Void> { _ in } {}
            session.event("task-ended:\(key.itemID)")
        }
    }
}

private struct NativeExperimentContextReader: View {
    let session: NativeTranscriptExperimentSession
    let key: NativeTranscriptExperimentSession.Key
    let revision: Int
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.locale) private var locale
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone
    @Environment(\.layoutDirection) private var direction
    @Environment(\.scenePhase) private var scene
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.nativeExperimentFixtureViewportWidth) private var viewportWidth
    private var receipt: NativeTranscriptExperimentSession.ContextReceipt {
        .init(revision: revision, modelIdentity: ObjectIdentifier(model), colorScheme: colorScheme,
              contrast: contrast, typeSize: typeSize, locale: locale.identifier, calendar: calendar.identifier,
              timeZone: timeZone.identifier, direction: direction, scene: scene, enabled: enabled,
              reduceMotion: reduceMotion, reduceTransparency: reduceTransparency, fixtureViewportWidth: viewportWidth)
    }
    var body: some View {
        Color.clear
            .onAppear { session.context(receipt, key: key) }
            .onChange(of: receipt) { _, value in session.context(value, key: key) }
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

private final class NativeExperimentCell: UICollectionViewCell {
    weak var borrowed: UIView?
    func borrow(_ view: UIView) {
        borrowed?.removeFromSuperview(); borrowed = view; contentView.addSubview(view)
        view.frame = contentView.bounds; view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }
    override func prepareForReuse() { super.prepareForReuse(); borrowed?.removeFromSuperview(); borrowed = nil }
}

@MainActor
private final class NativeExperimentHostingController: UIHostingController<NativeExperimentRowRoot> {
    var laidOut: (() -> Void)?
    var lifecycle: ((String) -> Void)?
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); laidOut?() }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); lifecycle?("will-appear") }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); lifecycle?("did-appear") }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); lifecycle?("will-disappear") }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); lifecycle?("did-disappear") }
    override func didMove(toParent parent: UIViewController?) { super.didMove(toParent: parent); lifecycle?("containment:\(parent != nil)") }
}

@MainActor
final class NativeTranscriptExperimentController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
    private final class Record {
        let key: NativeTranscriptExperimentSession.Key
        let host: NativeExperimentHostingController
        var probeGeneration = 0
        var deliveryGeneration = 0
        var acknowledged = false
        var acknowledgementInFlight = false
        init(key: NativeTranscriptExperimentSession.Key, host: NativeExperimentHostingController) {
            self.key = key; self.host = host
        }
    }
    let session: NativeTranscriptExperimentSession
    let collection: UICollectionView
    private var snapshot: NativeTranscriptExperimentSession.Snapshot?
    private var records: [NativeTranscriptExperimentSession.Key: Record] = [:]
    private var order: [NativeTranscriptExperimentSession.Key] = []
    private var heights: [String: CGFloat] = [:]
    private var presentation: NativeExperimentPresentation?
    private var suppliedSize = CGSize.zero
    private var header: CGFloat = 0
    private var footer: CGFloat = 0
    private var leading: CGFloat = 0
    private var trailing: CGFloat = 0
    private var reveal: CGFloat = 0
    private var revealInProgress = false
    private var alignShort = false
    private var applying = false
    private var measuring = false
    private var selfSizing = false
    private var pendingSnapshot: NativeTranscriptExperimentSession.Snapshot?
    /// Focused tests may retain the real UIKit completion; nil preserves its normal path.
    var batchCompletionGate: ((@escaping () -> Void) -> Void)?
    private var pendingArrivals = Set<NativeTranscriptExperimentSession.Key>()
    private var deferredAnchor: NativeTranscriptExperimentSession.Anchor?
    private(set) var followsLatest = true
    private(set) var phase = "idle"
    private var jumpGeneration = 0
    private var pendingInitialFollow = false
    enum ReaderPhase: Equatable { case tracking, interacting, decelerating, idle }
    private var policyPhaseOverride: ReaderPhase?
    var applyingSnapshot: Bool { applying }
    var renderedRevision: Int? { snapshot?.revision }
    var retainedHostCount: Int { records.count }
    /// Raw property reads only; no view load, conversion or layout queries.
    func passiveDiagnosticSnapshot() -> [String: Any] {
        let window = collection.window
        let stationary = session.stationaryView
        let composer = session.composerView
        let checks: [String: Any] = [
            "sessionControllerIdentityMatches": session.controller === self,
            "snapshotPresent": snapshot != nil,
            "snapshotScopeMatches": NativeExperimentDiagnostic.nullable(snapshot.map { $0.scope == session.snapshot.scope }),
            "viewLoaded": isViewLoaded, "collectionWindowPresent": window != nil,
            "stationaryPresent": stationary != nil, "windowNotHidden": NativeExperimentDiagnostic.nullable(window.map { !$0.isHidden }),
            "stationarySameWindow": window != nil && stationary != nil ? (stationary?.window === window) as Any : NSNull(),
            "composerPresent": composer != nil,
            "composerSameWindow": window != nil && composer != nil ? (composer?.window === window) as Any : NSNull(),
            "widthFinite": collection.bounds.width.isFinite, "heightFinite": collection.bounds.height.isFinite,
            "widthPositive": collection.bounds.width > 0, "heightPositive": collection.bounds.height > 0]
        return ["objectID": NativeExperimentDiagnostic.identity(self), "sessionControllerID": NativeExperimentDiagnostic.identity(session.controller),
                "sessionScope": NativeExperimentDiagnostic.scope(session.snapshot.scope), "sessionRevision": session.snapshot.revision,
                "sessionActionRevision": session.snapshot.actionRevision,
                "isViewLoaded": isViewLoaded, "snapshotScope": NativeExperimentDiagnostic.scope(snapshot?.scope),
                "snapshotRevision": NativeExperimentDiagnostic.nullable(snapshot?.revision),
                "snapshotActionRevision": NativeExperimentDiagnostic.nullable(snapshot?.actionRevision),
                "orderIDs": order.map(\.itemID), "hostCount": records.count, "applying": applying,
                "pendingScope": NativeExperimentDiagnostic.scope(pendingSnapshot?.scope),
                "pendingRevision": NativeExperimentDiagnostic.nullable(pendingSnapshot?.revision),
                "suppliedSize": NativeExperimentDiagnostic.size(suppliedSize), "header": NativeExperimentDiagnostic.number(header),
                "footer": NativeExperimentDiagnostic.number(footer), "leading": NativeExperimentDiagnostic.number(leading),
                "trailing": NativeExperimentDiagnostic.number(trailing), "reveal": NativeExperimentDiagnostic.number(reveal),
                "revealInProgress": revealInProgress, "alignShort": alignShort,
                "native": ["collectionFrame": NativeExperimentDiagnostic.rect(collection.frame),
                           "collectionBounds": NativeExperimentDiagnostic.rect(collection.bounds),
                           "contentSize": NativeExperimentDiagnostic.size(collection.contentSize),
                           "offset": NativeExperimentDiagnostic.point(collection.contentOffset),
                           "contentInset": NativeExperimentDiagnostic.insets(collection.contentInset),
                           "adjustedInset": NativeExperimentDiagnostic.insets(collection.adjustedContentInset),
                           "collectionWindow": NativeExperimentDiagnostic.window(window),
                           "controllerViewIfLoaded": NativeExperimentDiagnostic.view(viewIfLoaded)],
                "markers": ["stationary": NativeExperimentDiagnostic.view(stationary),
                            "composer": NativeExperimentDiagnostic.view(composer), "notice": NativeExperimentDiagnostic.view(session.noticeView)],
                "rawCaptureChecks": checks]
    }
    /// Policy fixture input, explicitly NOT a physical gesture or UIKit phase proof.
    func exerciseReaderPhase(_ value: ReaderPhase?) {
        let wasReaderDriven = policyPhaseOverride.map { $0 != .idle } ?? false
        policyPhaseOverride = value
        phase = value.map { "policy-\($0)" } ?? "idle"
        if value == .idle, wasReaderDriven {
            followsLatest = atBottom; deferredAnchor = nil
            session.event("policy-reader-idle-discards-deferred-correction")
        }
    }
    func rowFrame(_ itemID: String) -> CGRect? {
        guard let index = order.firstIndex(where: { $0.itemID == itemID }) else { return nil }
        return collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame
    }
    func rowView(_ itemID: String) -> UIView? {
        guard let key = order.first(where: { $0.itemID == itemID }) else { return nil }
        return records[key]?.host.view
    }
    func renderedText(_ itemID: String) -> String? {
        guard let key = order.first(where: { $0.itemID == itemID }) else { return nil }
        return records[key]?.host.rootView.row.messages.first?.text
    }
    func deliveryAcknowledged(_ itemID: String) -> Bool {
        guard let key = order.first(where: { $0.itemID == itemID }) else { return false }
        return records[key]?.acknowledged == true
    }
    init(session: NativeTranscriptExperimentSession) {
        self.session = session
        let layout = UICollectionViewFlowLayout(); layout.minimumLineSpacing = AssistantTheme.ConversationSpacing.surfaceGap
        layout.minimumInteritemSpacing = 0
        collection = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init(nibName: nil, bundle: nil)
        session.controller = self
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func loadView() {
        view = UIView(); view.backgroundColor = .clear
        collection.backgroundColor = .clear; collection.dataSource = self; collection.delegate = self
        collection.register(NativeExperimentCell.self, forCellWithReuseIdentifier: "retained-row")
        for kind in [UICollectionView.elementKindSectionHeader, UICollectionView.elementKindSectionFooter] {
            collection.register(UICollectionReusableView.self, forSupplementaryViewOfKind: kind, withReuseIdentifier: kind)
        }
        collection.contentInsetAdjustmentBehavior = .never
        collection.contentInset = .zero; collection.scrollIndicatorInsets = .zero
        collection.keyboardDismissMode = .interactive; collection.alwaysBounceVertical = true
        collection.showsVerticalScrollIndicator = false
        view.addSubview(collection)
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        collection.frame = CGRect(origin: .zero, size: suppliedSize)
        captureGeometry(); recomputeVisibility()
    }
    fileprivate func configure(size: CGSize, header: CGFloat, footer: CGFloat, leading: CGFloat, trailing: CGFloat,
                               reveal: CGFloat, inProgress: Bool, alignShort: Bool, presentation: NativeExperimentPresentation) {
        var diagnosticAccepted = false
        defer {
            session.observe(.configure, values: ["sampleKind": "configure-exit", "accepted": diagnosticAccepted,
                "incoming": ["size": NativeExperimentDiagnostic.size(size), "header": NativeExperimentDiagnostic.number(header),
                             "footer": NativeExperimentDiagnostic.number(footer), "leading": NativeExperimentDiagnostic.number(leading),
                             "trailing": NativeExperimentDiagnostic.number(trailing), "reveal": NativeExperimentDiagnostic.number(reveal),
                             "inProgress": inProgress, "alignShort": alignShort],
                "sessionScope": NativeExperimentDiagnostic.scope(session.snapshot.scope), "sessionRevision": session.snapshot.revision,
                "sessionActionRevision": session.snapshot.actionRevision, "exitState": passiveDiagnosticSnapshot()])
        }
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              [header, footer, leading, trailing, reveal].allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            session.event("STOP-invalid-root-layout-input"); session.invalidateGeometry(); return
        }
        diagnosticAccepted = true
        self.presentation = presentation
        let layoutChanged = suppliedSize != size || self.header != header || self.footer != footer
            || self.leading != leading || self.trailing != trailing || self.alignShort != alignShort
        let anchor = snapshot == nil ? nil : captureAnchor(newIDs: Set(order.map(\.itemID)))
        suppliedSize = size; self.header = header; self.footer = footer; self.leading = leading; self.trailing = trailing
        self.reveal = reveal; revealInProgress = inProgress; self.alignShort = alignShort
        loadViewIfNeeded()
        collection.semanticContentAttribute = presentation.direction == .rightToLeft ? .forceRightToLeft : .forceLeftToRight
        if snapshot?.revision != session.snapshot.revision || snapshot?.scope != session.snapshot.scope { apply(session.snapshot) }
        else {
            updateRoots()
            if layoutChanged { reconcileLayout(anchor: anchor) }
        }
        captureGeometry(); recomputeVisibility()
    }
    func apply(_ next: NativeTranscriptExperimentSession.Snapshot) {
        guard presentation != nil else { return }
        if applying {
            if pendingSnapshot == nil || pendingSnapshot!.scope != next.scope || pendingSnapshot!.revision < next.revision {
                pendingSnapshot = next
            }
            return
        }
        if let previous = snapshot, previous.scope == next.scope, next.revision <= previous.revision { return }
        let newKeys = next.rows.map { NativeTranscriptExperimentSession.Key(scope: next.scope, itemID: $0.id, kind: $0.kind) }
        let changedScope = snapshot.map { $0.scope != next.scope } ?? false
        let first = snapshot == nil || changedScope
        let anchor = first ? nil : captureAnchor(newIDs: Set(newKeys.map(\.itemID)))
        if changedScope {
            followsLatest = true; phase = "idle"; deferredAnchor = nil
            pendingArrivals.removeAll(); jumpGeneration += 1
            session.event("fresh-scope-follow-policy")
        }
        let oldOrder = order
        applying = true
        for key in order where !newKeys.contains(key) {
            if let record = records.removeValue(forKey: key) {
                record.probeGeneration += 1; record.deliveryGeneration += 1
                record.host.willMove(toParent: nil)
                record.host.view.removeFromSuperview(); record.host.removeFromParent()
                session.event("retire:\(key.itemID)")
            }
            heights[key.itemID] = nil
            pendingArrivals.remove(key)
        }
        snapshot = next; order = newKeys
        for (key, row) in zip(order, next.rows) where records[key] == nil {
            let host = NativeExperimentHostingController(rootView: root(key: key, row: row))
            host.safeAreaRegions = []
            host.view.backgroundColor = .clear
            host.lifecycle = { [weak session] event in session?.event("native-\(event):\(key.itemID)") }
            host.laidOut = { [weak self] in self?.rowDidLayout(key) }
            addChild(host); host.didMove(toParent: self)
            records[key] = Record(key: key, host: host)
            session.event("create:\(key.itemID)")
            if first || next.change == .arrival {
                session.event("arrival-intent:\(key.itemID)"); pendingArrivals.insert(key)
            }
            if next.change == .provisionalToDurable { session.event("replacement-no-second-arrival:\(key.itemID)") }
        }
        updateRoots()
        let finish: () -> Void = { [weak self] in
            guard let self else { return }
            self.reconcileLayout(anchor: anchor, initial: first)
            self.applying = false
            self.captureGeometry(); self.recomputeVisibility()
            if let pending = self.pendingSnapshot { self.pendingSnapshot = nil; self.apply(pending) }
        }
        if first {
            collection.reloadData() // Initial population only; token/context updates never reload cells.
            finish()
        } else {
            let deleted = oldOrder.enumerated().compactMap { newKeys.contains($0.element) ? nil : IndexPath(item: $0.offset, section: 0) }
            let inserted = newKeys.enumerated().compactMap { oldOrder.contains($0.element) ? nil : IndexPath(item: $0.offset, section: 0) }
            if deleted.isEmpty && inserted.isEmpty { finish() }
            else {
                let update = {
                    self.collection.performBatchUpdates {
                        self.collection.deleteItems(at: deleted); self.collection.insertItems(at: inserted)
                    } completion: { _ in
                        if let gate = self.batchCompletionGate { gate(finish) }
                        else { finish() }
                    }
                }
                if next.change == .provisionalToDurable {
                    session.event("replacement-native-batch-unanimated")
                    UIView.performWithoutAnimation(update)
                } else { update() }
            }
        }
    }
    private func root(key: NativeTranscriptExperimentSession.Key, row: NativeTranscriptExperimentSession.Row) -> NativeExperimentRowRoot {
        .init(session: session, key: key, row: row, revision: snapshot!.revision, presentation: presentation!)
    }
    private func updateRoots() {
        guard let snapshot, presentation != nil else { return }
        for (key, row) in zip(order, snapshot.rows) { records[key]?.host.rootView = root(key: key, row: row) }
    }
    func hostIdentity(_ itemID: String) -> ObjectIdentifier? {
        guard let key = order.first(where: { $0.itemID == itemID }), let host = records[key]?.host else { return nil }
        return ObjectIdentifier(host)
    }
    func beginLease(itemID: String, action: NativeTranscriptExperimentSession.Lease.Action = .probe) -> NativeTranscriptExperimentSession.Lease? {
        guard let key = order.first(where: { $0.itemID == itemID }), let record = records[key], let snapshot else { return nil }
        let generation: Int
        switch action {
        case .probe: record.probeGeneration += 1; generation = record.probeGeneration
        case .delivery: record.deliveryGeneration += 1; generation = record.deliveryGeneration
        }
        // This bounded delivery action is keyed to the immutable durable
        // message/scope. Probe revision changes are unrelated to its admission.
        let revision = action == .probe ? snapshot.actionRevision : 0
        return .init(key: key, action: action, actionRevision: revision, generation: generation)
    }
    func leaseIsCurrent(_ lease: NativeTranscriptExperimentSession.Lease) -> Bool {
        guard session.snapshot.scope == lease.key.scope, snapshot?.scope == lease.key.scope,
              let record = records[lease.key] else { return false }
        if lease.action == .probe,
           (session.snapshot.actionRevision != lease.actionRevision || snapshot?.actionRevision != lease.actionRevision) { return false }
        return (lease.action == .probe ? record.probeGeneration : record.deliveryGeneration) == lease.generation
    }
    private var gestureOwnsOffset: Bool {
        collection.isTracking || collection.isDragging || collection.isDecelerating
            || (policyPhaseOverride.map { $0 != .idle } ?? false)
    }
    private var atBottom: Bool {
        collection.contentSize.height <= collection.bounds.height + 1
            || collection.contentOffset.y + collection.bounds.height >= collection.contentSize.height - 64
    }
    private func captureAnchor(newIDs: Set<String>) -> NativeTranscriptExperimentSession.Anchor {
        collection.layoutIfNeeded()
        var frames: [String: CGRect] = [:]
        for (index, key) in order.enumerated() {
            if let frame = collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame { frames[key.itemID] = frame }
        }
        let selected = order.first { key in frames[key.itemID].map { $0.maxY >= collection.contentOffset.y } ?? false }?.itemID
        return NativeTranscriptExperimentSession.anchor(oldIDs: order.map(\.itemID), newIDs: newIDs, selected: selected,
                                                        frames: frames, offset: collection.contentOffset.y, height: collection.bounds.height)
    }
    private func reconcileLayout(anchor: NativeTranscriptExperimentSession.Anchor?, initial: Bool = false) {
        collection.frame = CGRect(origin: .zero, size: suppliedSize)
        collection.collectionViewLayout.invalidateLayout(); collection.layoutIfNeeded()
        if initial && gestureOwnsOffset { pendingInitialFollow = true }
        else if initial || (followsLatest && !gestureOwnsOffset) {
            pendingInitialFollow = false
            collection.setContentOffset(CGPoint(x: 0, y: max(0, collection.contentSize.height - collection.bounds.height)), animated: false)
        } else if let anchor { restore(anchor) }
        collection.layoutIfNeeded()
    }
    private func restore(_ anchor: NativeTranscriptExperimentSession.Anchor) {
        let frame = anchor.itemID.flatMap { id in order.firstIndex(where: { $0.itemID == id }) }
            .flatMap { collection.layoutAttributesForItem(at: IndexPath(item: $0, section: 0))?.frame }
        let requested: CGFloat
        if let frame, let fraction = anchor.fraction { requested = frame.minY - fraction * collection.bounds.height }
        else { requested = anchor.preOffset }
        guard requested.isFinite else { session.event("STOP-invalid-anchor-offset"); return }
        let clamped = min(max(0, requested), max(0, collection.contentSize.height - collection.bounds.height))
        let suppressed = gestureOwnsOffset
        if suppressed { deferredAnchor = anchor }
        else {
            collection.setContentOffset(CGPoint(x: 0, y: clamped), animated: false)
            collection.layoutIfNeeded(); deferredAnchor = nil
        }
        session.restoration(.init(anchor: anchor, newFrame: frame, viewportHeight: collection.bounds.height,
                                  contentHeight: collection.contentSize.height, requested: requested, clamped: clamped,
                                  actual: collection.contentOffset.y, suppressedByGesture: suppressed,
                                  reason: frame == nil ? "absolute-fallback-missing-post-layout-attributes" : anchor.reason,
                                  clampReason: clamped == requested ? "none" : clamped == 0 ? "minimum" : "maximum"))
    }
    func jumpToLatest() {
        jumpGeneration += 1
        let generation = jumpGeneration
        collection.setContentOffset(collection.contentOffset, animated: false)
        followsLatest = true
        guard generation == jumpGeneration else { return }
        collection.setContentOffset(CGPoint(x: 0, y: max(0, collection.contentSize.height - collection.bounds.height)),
                                    animated: presentation?.reduceMotion == false)
    }
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { order.count }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "retained-row", for: indexPath) as! NativeExperimentCell
        if let record = records[order[indexPath.item]] { cell.borrow(record.host.view); session.event("borrow:\(record.key.itemID)") }
        return cell
    }
    func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String,
                        at indexPath: IndexPath) -> UICollectionReusableView {
        collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: kind, for: indexPath)
    }
    private func measuredHeight(_ key: NativeTranscriptExperimentSession.Key) -> CGFloat {
        guard let record = records[key] else { preconditionFailure("Missing retained host for real layout item") }
        let width = max(0, suppliedSize.width - leading - trailing)
        measuring = true
        let measured = record.host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
        measuring = false
        heights[key.itemID] = measured
        return measured
    }
    private func rowDidLayout(_ key: NativeTranscriptExperimentSession.Key) {
        guard !applying, !measuring, !selfSizing, records[key] != nil, let previous = heights[key.itemID] else { return }
        selfSizing = true
        defer { selfSizing = false }
        let anchor = captureAnchor(newIDs: Set(order.map(\.itemID)))
        let height = measuredHeight(key)
        guard abs(height - previous) > 0.5 else { return }
        // Disclosure layout is a reading action: keep its actual pre-layout
        // anchor, even when the prior follow policy was at the newest edge.
        collection.collectionViewLayout.invalidateLayout(); collection.layoutIfNeeded()
        restore(anchor); captureGeometry(); recomputeVisibility()
    }
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                        sizeForItemAt indexPath: IndexPath) -> CGSize {
        CGSize(width: max(0, suppliedSize.width - leading - trailing), height: measuredHeight(order[indexPath.item]))
    }
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                        insetForSectionAt section: Int) -> UIEdgeInsets {
        UIEdgeInsets(top: 0, left: leading, bottom: 0, right: trailing)
    }
    private var actualHeader: CGFloat {
        let rowsHeight = order.reduce(CGFloat.zero) { $0 + measuredHeight($1) }
            + CGFloat(max(0, order.count - 1)) * AssistantTheme.ConversationSpacing.surfaceGap
        return header + (alignShort && followsLatest ? max(0, suppliedSize.height - header - footer - rowsHeight) : 0)
    }
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForHeaderInSection section: Int) -> CGSize { CGSize(width: suppliedSize.width, height: actualHeader) }
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForFooterInSection section: Int) -> CGSize { CGSize(width: suppliedSize.width, height: footer) }
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { phase = "interacting" }
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if !applying, gestureOwnsOffset { followsLatest = atBottom }
        captureGeometry(); recomputeVisibility()
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        followsLatest = atBottom; phase = decelerate ? "decelerating" : "idle"
        if !decelerate {
            deferredAnchor = nil
            if pendingInitialFollow { followsLatest = true; reconcileLayout(anchor: nil, initial: true) }
        }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        followsLatest = atBottom; phase = "idle"; deferredAnchor = nil
        if pendingInitialFollow { followsLatest = true; reconcileLayout(anchor: nil, initial: true) }
        captureGeometry(); recomputeVisibility()
    }
    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        let key = order[indexPath.item]
        if pendingArrivals.remove(key) != nil {
            session.event("arrival-painted:\(key.itemID)")
            if presentation?.reduceMotion == false {
                cell.alpha = 0; cell.transform = CGAffineTransform(translationX: 0, y: 10).scaledBy(x: 0.986, y: 0.986)
                UIView.animate(withDuration: 0.3) { cell.alpha = 1; cell.transform = .identity }
            }
        }
        captureGeometry(); recomputeVisibility()
    }
    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        session.event("end-display:\(indexPath.item)"); recomputeVisibility()
    }
    func captureGeometry() {
        let diagnosticGeometryPresentBefore = session.geometry != nil
        let diagnosticScopeBefore = session.geometry?.scope
        var diagnosticInvalidated = false
        var diagnosticOutcome = "controller-mismatch"
        var diagnosticAttributeRows: [String: CGRect]?
        defer {
            session.observe(.capture, values: ["sampleKind": "capture-exit", "outcome": diagnosticOutcome,
                "invalidatedGeometry": diagnosticInvalidated, "geometryPresentBefore": diagnosticGeometryPresentBefore,
                "geometryScopeBefore": NativeExperimentDiagnostic.scope(diagnosticScopeBefore),
                "geometryAfter": NativeExperimentDiagnostic.geometry(session.geometry),
                "existingAttributeRows": diagnosticAttributeRows.map { rows in rows.mapValues { NativeExperimentDiagnostic.rect($0) } as Any } ?? NSNull(),
                "exitState": passiveDiagnosticSnapshot()])
        }
        guard session.controller === self else { return }
        session.invalidateGeometry()
        diagnosticInvalidated = true
        diagnosticOutcome = "guard-rejected"
        guard let snapshot, snapshot.scope == session.snapshot.scope,
              isViewLoaded, let window = collection.window, let stationary = session.stationaryView,
              !window.isHidden, stationary.window === window,
              let composer = session.composerView, composer.window === window,
              collection.bounds.width.isFinite, collection.bounds.height.isFinite,
              collection.bounds.width > 0, collection.bounds.height > 0 else { return }
        var rowFrames: [String: CGRect] = [:]
        for (index, key) in order.enumerated() {
            if let attributes = collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0)) {
                rowFrames[key.itemID] = collection.convert(attributes.frame, to: window)
            }
        }
        diagnosticAttributeRows = rowFrames
        let notice = session.noticeView.flatMap { $0.window === window && $0.bounds.height > 0 ? $0.convert($0.bounds, to: window) : nil }
        session.record(.init(scope: snapshot.scope, bounds: collection.bounds, frame: collection.frame,
                             viewportInWindow: collection.convert(collection.bounds, to: window),
                             stationaryInWindow: stationary.convert(stationary.bounds, to: window),
                             composerInWindow: composer.convert(composer.bounds, to: window), noticeInWindow: notice,
                             rowFramesInWindow: rowFrames, contentInset: collection.contentInset,
                             adjustedInset: collection.adjustedContentInset, offset: collection.contentOffset,
                             contentSize: collection.contentSize, windowBounds: window.bounds, windowSafeArea: window.safeAreaInsets,
                             header: actualHeader, footer: footer, reveal: reveal))
        diagnosticOutcome = "recorded"
    }
    private func deliveryIsAdmissible(_ key: NativeTranscriptExperimentSession.Key,
                                      lease: NativeTranscriptExperimentSession.Lease? = nil) -> Bool {
        guard let snapshot, let presentation, let geometry = session.geometry,
              session.controller === self, session.snapshot.scope == key.scope,
              snapshot.scope == key.scope, geometry.scope == key.scope,
              lease.map({ leaseIsCurrent($0) }) ?? true,
              let window = collection.window, !window.isHidden,
              session.stationaryView?.window === window, session.composerView?.window === window,
              presentation.scene == .active, !session.coveringPresentation,
              reveal == 0, !revealInProgress,
              let index = order.firstIndex(of: key), snapshot.rows[index].durableAssistant,
              let record = records[key], !record.acknowledged,
              collection.cellForItem(at: IndexPath(item: index, section: 0))?.window === window,
              record.host.view.window === window,
              let frame = geometry.rowFramesInWindow[key.itemID] else { return false }
        var occlusions = [geometry.composerInWindow]
        if let notice = geometry.noticeInWindow { occlusions.append(notice) }
        switch session.crownOcclusion {
        case .unavailable: return false // Missing real chrome evidence never invents visibility.
        case .absent: break
        case let .measured(frame): occlusions.append(frame)
        }
        return NativeTranscriptExperimentSession.visibleFraction(row: frame, viewport: geometry.viewportInWindow,
            window: geometry.windowBounds, occlusions: occlusions) >= 0.5
    }
    func recomputeVisibility() {
        guard let snapshot, snapshot.scope == session.snapshot.scope,
              session.geometry?.scope == snapshot.scope else { return }
        for (key, row) in zip(order, snapshot.rows) where row.durableAssistant {
            guard let record = records[key], !record.acknowledged, !record.acknowledgementInFlight,
                  deliveryIsAdmissible(key), let acknowledge = session.acknowledge,
                  let lease = beginLease(itemID: key.itemID, action: .delivery),
                  deliveryIsAdmissible(key, lease: lease) else { continue }
            record.acknowledgementInFlight = true
            Task { @MainActor [weak self] in
                guard let self else { return }
                // The session can switch scope while UIKit still holds an old
                // batch, or between enqueueing this Task and its first turn.
                guard self.deliveryIsAdmissible(key, lease: lease) else {
                    if let current = self.records[key], current.deliveryGeneration == lease.generation {
                        current.acknowledgementInFlight = false
                    }
                    self.session.event("stale-ack-admission-rejected"); return
                }
                let acknowledged = await acknowledge(key.itemID)
                // Retire this dispatch's in-flight flag even if its data lease
                // changed; never clear a newer dispatch or a different host.
                if let current = self.records[key], current.deliveryGeneration == lease.generation {
                    current.acknowledgementInFlight = false
                }
                guard self.leaseIsCurrent(lease), let current = self.records[key] else {
                    self.session.event("stale-ack-completion-rejected"); self.recomputeVisibility(); return
                }
                current.acknowledged = acknowledged
            }
        }
    }
}
#endif
