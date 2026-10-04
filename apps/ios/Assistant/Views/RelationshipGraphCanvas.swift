import SwiftUI
import UIKit

struct RelationshipGraphCanvas: UIViewRepresentable {
    let snapshot: RelationshipGraphSnapshot
    let selectedID: String?
    var command = GraphCanvasCommand()
    /// A still, framed thumbnail with no gestures — the Memory home's preview.
    var interactive = true
    /// Screen space the floating controls cover. A selected item is kept
    /// clear of them, and the camera frames the map inside what is left.
    var insets = UIEdgeInsets.zero
    /// How the owner has tuned the map: sizes, names, arrows and forces.
    var settings = GraphSettings()
    var select: (String?) -> Void = { _ in }
    /// Long-press one item and let go over another — or over open canvas,
    /// which passes nil for the second end: a new item.
    var connect: ((String, String?) -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> RelationshipGraphCanvasView {
        RelationshipGraphCanvasView(interactive: interactive)
    }

    func updateUIView(_ view: RelationshipGraphCanvasView, context: Context) {
        view.onSelect = select
        view.onConnect = connect
        view.insets = insets
        view.settings = settings
        view.configure(snapshot: snapshot, selectedID: selectedID, dark: colorScheme == .dark, reduceMotion: reduceMotion)
        view.perform(command)
    }

    static func dismantleUIView(_ view: RelationshipGraphCanvasView, coordinator: ()) {
        view.stopPreparingLayout()
    }
}

struct GraphCanvasCommand: Equatable {
    enum Action: Equatable {
        case fit, zoomIn, zoomOut
        /// Fly the camera to an item and bring it close enough to read.
        case reveal(String)
    }
    var id = 0
    var action: Action = .fit
}

/// The relationship map, drawn and driven by UIKit so that a frame of physics
/// or a finger's movement never rebuilds SwiftUI's view tree.
///
/// It behaves the way Obsidian's graph does, because that is the model the
/// owner already has in their hands: the map is alive and finds its own
/// shape; a dot's size is how connected it is; touching one lights it and its
/// neighbours while the rest of the map recedes; one finger pans with
/// momentum, two pinch; names
/// fade in as you zoom, hubs first, and closer still each item says what it
/// is and each line says what it means. What it adds is connecting:
/// long-press an item, drag to another, let go.
///
/// Nothing on it jumps. A dot that gains connections grows into its new size
/// on a spring, a newcomer pops in where it joins the map, an item that
/// leaves shrinks away, and highlighting crossfades — so an update reads as
/// the map changing rather than being replaced.
final class RelationshipGraphCanvasView: UIView, UIGestureRecognizerDelegate {
    /// Canvas labels are drawn into a CGContext, so they get none of SwiftUI's
    /// Dynamic Type scaling for free. Scaling them by hand is what keeps this
    /// screen legible for someone who has turned the system text size up.
    /// Capped, because past roughly double a name collides with its
    /// neighbours rather than helping.
    static func scaledFont(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        return UIFontMetrics(forTextStyle: .caption1).scaledFont(for: base, maximumPointSize: size * 2)
    }

    /// How much a node's name wants to be shown: a hub earns its name from
    /// further out than a leaf does, which is what lets a zoomed-out map be
    /// read by its landmarks.
    static func importance(degree: Int) -> CGFloat { 1 + 0.55 * log2(1 + CGFloat(degree)) }

    /// 0 → hidden, 1 → fully drawn. Names fade rather than pop, so zooming
    /// feels continuous instead of like a switch being flipped. `fade` is the
    /// owner's text-fade setting: each step up halves the zoom a name needs.
    static func labelOpacity(scale: CGFloat, degree: Int, fade: CGFloat = 0) -> CGFloat {
        let threshold = 0.8 * pow(2, -fade)
        return min(1, max(0, (scale * importance(degree: degree) - threshold) / 0.35))
    }

    /// World-space radius: node size carries how connected an item is.
    static func worldRadius(degree: Int, size: CGFloat = 1) -> CGFloat {
        RelationshipGraphLayout.radius(degree: degree, size: size)
    }

    /// Zoom thresholds at which the map starts saying more.
    static let detailScale: CGFloat = 1.6
    static let allEdgePhrasesScale: CGFloat = 1.9

    /// Which nodes the last paint actually put a name on. The canvas has far
    /// more nodes than room for names, so which ones get one is a real
    /// decision with a real failure mode — an overview where nothing is
    /// named. Recording it is what lets that be asserted.
    private(set) var namedNodeIDs: Set<String> = []

    private(set) var layout = RelationshipGraphLayout()
    private(set) var viewport = GraphViewport()
    private(set) var selectedID: String?
    private let interactive: Bool
    private var nodes: [RelationshipGraphNode] = []
    private var nodeByID: [String: RelationshipGraphNode] = [:]
    private var links: [GraphLink] = []
    private var degrees: [String: Int] = [:]
    private var adjacency: [String: Set<String>] = [:]
    private var unreviewed = Set<GraphLink>()
    private var dark = false
    private var reduceMotion = false
    /// Only value-layout preparation runs off-main. Gestures, drawing and the
    /// viewport stay owned by UIKit, and each replacement invalidates its work.
    private var preparationTask: Task<Void, Never>?
    private var preparationGeneration = 0
    private var pendingPreparationSteps: Int?
    private var preparationSuspended = false
    private var touching = false
    var isPreparingLayout: Bool { pendingPreparationSteps != nil }
    private var previousSize = CGSize.zero
    private var edgeLabels: [GraphLink: String] = [:]
    private var edgeDirections: [GraphLink: String] = [:]
    private var lastCommand = -1
    private var needsInitialFit = true
    /// Until the owner moves the map, it keeps itself framed as the controls
    /// around it settle; after that, the camera is theirs.
    var insets = UIEdgeInsets.zero {
        didSet {
            guard oldValue != insets, !nodes.isEmpty, !bounds.isEmpty else { return }
            guard !isNavigating else { return }
            if !cameraTouched { fit(animated: false) }
            else if let selectedID { keepVisible(selectedID) }
        }
    }
    var settings = GraphSettings() {
        didSet {
            guard settings != oldValue else { return }
            let reshapes = settings.reshapesLayout(from: oldValue)
            let wasPreparing = isPreparingLayout
            layout.apply(settings)
            if reshapes {
                cancelPreparation(keepingRequest: false)
                if reduceMotion || !interactive || wasPreparing {
                    prepareLayout(maxSteps: reduceMotion || !interactive ? 400 : 150)
                }
            }
            wake()
        }
    }
    private var cameraTouched = false
    var onSelect: ((String?) -> Void)?
    var onConnect: ((String, String?) -> Void)?

    // Gesture state.
    /// The item under a finger that has touched down but not yet become a
    /// tap, a drag or a connection — the phone's stand-in for hovering.
    private(set) var pressedID: String?
    private var dragStart: CGPoint?
    private var originalViewport = GraphViewport()
    private weak var panGesture: UIPanGestureRecognizer?
    private var panNeedsReanchor = false
    private var pinchStartScale: CGFloat = 1
    private var pinchRecognizerStartScale: CGFloat = 1
    private var pinchWorldAnchor = CGPoint.zero
    private var pinching = false
    private var momentum = CGPoint.zero
    private var camera: CameraFlight?
    private(set) var connectSourceID: String?
    private(set) var connectTargetID: String?
    private var connectPoint: CGPoint?
    private var lastLabelIDs: Set<String> = []

    // Animation state.
    private struct Motion {
        /// World radius as drawn, springing towards the layout's.
        var radius: CGFloat
        var radiusVelocity: CGFloat = 0
        /// 0 → not yet on the map, 1 → arrived. Springs, so it overshoots a
        /// little: a newcomer pops rather than fades.
        var presence: CGFloat
        var presenceVelocity: CGFloat = 0
        /// How much this item belongs to what is being looked at.
        var lit: CGFloat = 0
    }
    /// An item that has left the map, drawn shrinking away where it was.
    private struct Ghost {
        let point: CGPoint
        let radius: CGFloat
        let kind: String
        let ends: [CGPoint]
        var life: CGFloat = 1
    }
    private var motion: [String: Motion] = [:]
    private var linkLit: [GraphLink: CGFloat] = [:]
    private var ghosts: [Ghost] = []
    /// How far everything outside the focus has receded.
    private var dim: CGFloat = 0
    /// The selection ring, drawing itself in.
    private var ring: CGFloat = 0
    private var animating = false
    private var labelImages: [String: UIImage] = [:]

    // Frame loop.
    private var displayLink: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private let impactFeedback = UIImpactFeedbackGenerator(style: .medium)

    private struct CameraFlight {
        let from: GraphViewport
        let to: GraphViewport
        let start: CFTimeInterval
        let duration: CFTimeInterval
    }

    init(interactive: Bool = true) {
        self.interactive = interactive
        super.init(frame: .zero)
        commonInit()
    }

    override init(frame: CGRect) {
        interactive = true
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { preparationTask?.cancel() }

    private func commonInit() {
        isOpaque = true
        contentMode = .redraw
        isMultipleTouchEnabled = true
        accessibilityIdentifier = "assistant.relationship.graph.canvas"
        // Names are cached as pictures at one text size and screen scale.
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) {
            (view: RelationshipGraphCanvasView, _: UITraitCollection) in
            view.labelImages.removeAll()
            view.setNeedsDisplay()
        }
        guard interactive else {
            isUserInteractionEnabled = false
            isAccessibilityElement = false
            return
        }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.maximumNumberOfTouches = 2
        panGesture = pan
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
        let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        let press = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
        press.minimumPressDuration = 0.32
        press.allowableMovement = 6
        // A finger that moves straight away pans; one that holds still first
        // picks up a thread to connect. Waiting for the press to fail costs
        // the pan only its first 6 points.
        pan.require(toFail: press)
        tap.require(toFail: pan)
        for recognizer in [pan, pinch, press, tap, doubleTap] as [UIGestureRecognizer] {
            recognizer.delegate = self
            addGestureRecognizer(recognizer)
        }
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Pinch alongside a pan, so a second finger turns a drag into a zoom
        // without lifting the first.
        (gestureRecognizer is UIPinchGestureRecognizer && other is UIPanGestureRecognizer)
            || (gestureRecognizer is UIPanGestureRecognizer && other is UIPinchGestureRecognizer)
    }

    // MARK: - Configuration

    func configure(snapshot: RelationshipGraphSnapshot, selectedID: String?, dark: Bool, reduceMotion: Bool) {
        let newLinks = snapshot.links
        let changed = nodes != snapshot.nodes || links != newLinks
        let selectionChanged = self.selectedID != selectedID
        let motionChanged = self.reduceMotion != reduceMotion
        let wasPreparing = isPreparingLayout
        if dark != self.dark { labelImages.removeAll() }
        self.dark = dark
        self.reduceMotion = reduceMotion
        edgeLabels = [:]; edgeDirections = [:]
        let claims = Dictionary(grouping: snapshot.edges.filter { $0.reviewStatus != "rejected" },
                                by: { GraphLink($0.subjectId, $0.objectId) })
        for (link, edges) in claims {
            let statements = Set(edges.map { "\($0.subjectId)|\($0.predicate)|\($0.objectId)|\($0.validFrom ?? "")|\($0.validUntil ?? "")" })
            if statements.count == 1, let edge = edges.first {
                edgeLabels[link] = edge.presentation.label; edgeDirections[link] = edge.objectId
            } else { edgeLabels[link] = "\(statements.count) relationships" }
        }
        unreviewed = Set(snapshot.edges.filter { $0.reviewStatus != "confirmed" }.map { GraphLink($0.subjectId, $0.objectId) })
        if changed {
            cancelPreparation(keepingRequest: false)
            let firstLayout = layout.ids.isEmpty
            let leaving: Set<String> = firstLayout || reduceMotion ? [] : Set(nodes.map(\.id)).subtracting(snapshot.nodes.map(\.id))
            if !leaving.isEmpty { letGo(leaving) }
            nodes = snapshot.nodes
            nodeByID = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            links = newLinks
            degrees = snapshot.degrees
            adjacency = snapshot.adjacency
            layout.update(nodes: nodes, links: links)
            if firstLayout || reduceMotion || !interactive || wasPreparing {
                // Draw the deterministic seed immediately; prepare the costly
                // force passes without blocking Memory or the full map.
                prepareLayout(maxSteps: reduceMotion || !interactive ? 400 : 150)
                if firstLayout { needsInitialFit = true }
            }
            syncMotion(arriving: !firstLayout && !reduceMotion)
            if needsInitialFit, !bounds.isEmpty { fit(animated: false); needsInitialFit = false }
        } else if motionChanged {
            cancelPreparation(keepingRequest: false)
            if reduceMotion || !interactive || wasPreparing {
                prepareLayout(maxSteps: reduceMotion || !interactive ? 400 : 150)
            }
        }
        self.selectedID = selectedID
        if selectionChanged {
            ring = 0
            if let selectedID {
                // A selection brings up the card; the camera stops reframing
                // itself around the controls from here on.
                cameraTouched = true
                keepVisible(selectedID)
            }
        }
        refreshAccessibility()
        wake()
    }

    private func prepareLayout(maxSteps: Int) {
        guard !layout.isSettled else { return }
        pendingPreparationSteps = maxSteps
        startPreparationIfNeeded()
    }

    private func startPreparationIfNeeded() {
        guard preparationTask == nil, !preparationSuspended, !isNavigating, !touching,
              let steps = pendingPreparationSteps else { return }
        let generation = preparationGeneration
        let seed = layout
        preparationTask = Task.detached(priority: .userInitiated) { [weak self] in
            let prepared = seed.prepared(maxSteps: steps, isCancelled: { Task.isCancelled })
            guard !Task.isCancelled, let prepared else { return }
            await self?.finishPreparation(prepared, generation: generation)
        }
    }

    private func finishPreparation(_ prepared: RelationshipGraphLayout, generation: Int) {
        guard generation == preparationGeneration, !preparationSuspended, !isNavigating, !touching,
              prepared.ids == layout.ids else { return }
        preparationTask = nil
        pendingPreparationSteps = nil
        let previous = layout
        layout = prepared
        // Display-only settings can change while the worker is running; their
        // current value wins without reheating the prepared forces.
        layout.apply(settings)
        if !cameraTouched {
            if bounds.isEmpty { needsInitialFit = true }
            else { fit(animated: false); needsInitialFit = false }
        }
        if !reduceMotion && interactive { layout = layout.transitioning(from: previous) }
        refreshAccessibility()
        wake()
    }

    private func cancelPreparation(keepingRequest: Bool) {
        preparationGeneration &+= 1
        preparationTask?.cancel()
        preparationTask = nil
        if !keepingRequest { pendingPreparationSteps = nil }
    }

    /// Removal releases the worker as well as the display link. A temporary
    /// window detach retains its request and resumes it when shown again.
    func stopPreparingLayout() {
        preparationSuspended = true
        cancelPreparation(keepingRequest: false)
        stopLoop()
    }

    private func interruptPreparationForInteraction() {
        // Normal motion resumes from the positions the owner actually saw;
        // Reduce Motion instead prepares one still replacement after release.
        cancelPreparation(keepingRequest: reduceMotion)
    }

    /// Carries each item's animation over an update. Items already on the
    /// map keep their drawn size and spring to the new one; newcomers start
    /// at nothing when they are joining a map that is already there.
    private func syncMotion(arriving: Bool) {
        var next: [String: Motion] = [:]
        next.reserveCapacity(layout.ids.count)
        for (i, id) in layout.ids.enumerated() {
            next[id] = motion[id] ?? Motion(radius: layout.radii[i], presence: arriving ? 0 : 1)
        }
        motion = next
        let current = Set(links)
        linkLit = linkLit.filter { current.contains($0.key) }
    }

    /// Items leaving the map become ghosts that shrink away where they were,
    /// taking their lines with them.
    private func letGo(_ ids: Set<String>) {
        for id in ids {
            guard let point = layout.position(of: id) else { continue }
            let ends = (adjacency[id] ?? []).compactMap { layout.position(of: $0) }
            let fallback: CGFloat = layout.radius(of: id) ?? 6
            let radius: CGFloat = motion[id].map { (m: Motion) -> CGFloat in m.radius * max(0, m.presence) } ?? fallback
            ghosts.append(Ghost(point: point, radius: radius, kind: nodeByID[id]?.kind ?? "", ends: ends))
        }
        if ghosts.count > 80 { ghosts.removeFirst(ghosts.count - 80) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Keep what is on screen where it is when the canvas changes size.
        if !previousSize.equalTo(.zero), previousSize != bounds.size {
            viewport.offset.x += (previousSize.width - bounds.width) / 2
            viewport.offset.y += (previousSize.height - bounds.height) / 2
        }
        previousSize = bounds.size
        if needsInitialFit, !bounds.isEmpty, !nodes.isEmpty { fit(animated: false); needsInitialFit = false }
        refreshAccessibility()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        preparationSuspended = window == nil
        if window == nil {
            cancelPreparation(keepingRequest: true)
            stopLoop()
        } else {
            startPreparationIfNeeded()
            startLoopIfNeeded()
        }
    }

    func perform(_ command: GraphCanvasCommand) {
        guard lastCommand != command.id else { return }
        let first = lastCommand == -1
        lastCommand = command.id
        // The command a view is created with has already been honoured by the
        // initial fit; replaying it would throw away a restored position.
        if first && command.id == 0 { return }
        interruptPreparationForInteraction()
        cameraTouched = true
        switch command.action {
        case .fit: fit(animated: true)
        case .zoomIn: zoom(to: viewport.scale * 1.5, anchor: focusCenter, animated: true)
        case .zoomOut: zoom(to: viewport.scale / 1.5, anchor: focusCenter, animated: true)
        case .reveal(let id): reveal(id)
        }
    }

    // MARK: - Camera

    /// The middle of the part of the canvas the controls leave uncovered.
    private var focusCenter: CGPoint {
        CGPoint(x: insets.left + (bounds.width - insets.left - insets.right) / 2,
                y: insets.top + (bounds.height - insets.top - insets.bottom) / 2)
    }

    private func fit(animated: Bool) {
        var target = GraphViewport()
        let area = CGSize(width: max(80, bounds.width - insets.left - insets.right),
                          height: max(80, bounds.height - insets.top - insets.bottom))
        // A thumbnail names only its hubs, so it can use its whole frame.
        target.fit(layout.positions, size: area,
                   margin: interactive ? CGSize(width: 100, height: 120) : CGSize(width: 48, height: 36))
        // `fit` centres on the canvas; shift it to the uncovered area's centre.
        target.offset.x += focusCenter.x - bounds.midX
        target.offset.y += focusCenter.y - bounds.midY
        fly(to: target, animated: animated)
    }

    func zoom(to scale: CGFloat, anchor: CGPoint, animated: Bool = false) {
        var target = viewport
        target.zoom(to: scale, anchor: anchor, size: bounds.size)
        fly(to: target, animated: animated)
    }

    private func reveal(_ id: String) {
        guard let position = layout.position(of: id) else { return }
        var target = viewport
        target.scale = min(4, max(viewport.scale, 1.15))
        target.offset = CGPoint(x: focusCenter.x - bounds.midX - position.x * target.scale,
                                y: focusCenter.y - bounds.midY - position.y * target.scale)
        fly(to: target, animated: true)
    }

    /// A tapped item that would land under the controls is slid into view,
    /// keeping the zoom — the owner chose the scale, the canvas only makes
    /// room.
    private func keepVisible(_ id: String) {
        guard !isNavigating else { return }
        guard !bounds.isEmpty, let position = layout.position(of: id) else { return }
        let point = viewport.screen(position, size: bounds.size)
        let safe = bounds.inset(by: insets).insetBy(dx: 24, dy: 24)
        guard !safe.isEmpty, !safe.contains(point) else { return }
        var target = viewport
        target.offset.x += min(max(point.x, safe.minX), safe.maxX) - point.x
        target.offset.y += min(max(point.y, safe.minY), safe.maxY) - point.y
        fly(to: target, animated: true)
    }

    private func fly(to target: GraphViewport, animated: Bool) {
        momentum = .zero
        if !animated || reduceMotion || window == nil {
            camera = nil
            viewport = target
            refreshAccessibility()
            setNeedsDisplay()
            return
        }
        camera = CameraFlight(from: viewport, to: target, start: CACurrentMediaTime(), duration: 0.42)
        startLoopIfNeeded()
    }

    private func points() -> [String: CGPoint] { Dictionary(uniqueKeysWithValues: zip(layout.ids, layout.positions)) }

    /// A dot's size on screen. It tracks the zoom one to one while it is
    /// small, then grows more slowly, so zooming in on a hub gives room to
    /// read around it instead of filling the screen with one circle.
    private func screenRadius(world: CGFloat) -> CGFloat {
        let linear = world * viewport.scale
        return max(2.5, linear < 22 ? linear : 22 + (linear - 22) * 0.35)
    }

    private func screenRadius(for id: String) -> CGFloat {
        screenRadius(world: layout.radius(of: id) ?? Self.worldRadius(degree: degrees[id] ?? 0, size: settings.nodeSize))
    }

    func hitNode(at point: CGPoint, slop: CGFloat = 20, excluding: String? = nil) -> String? {
        var closest: (String, CGFloat)?
        for (id, position) in zip(layout.ids, layout.positions) where id != excluding {
            let screen = viewport.screen(position, size: bounds.size)
            let distance = hypot(screen.x - point.x, screen.y - point.y)
            let reach = max(22, screenRadius(for: id) + slop)
            if distance <= reach && (closest == nil || distance < closest!.1) { closest = (id, distance) }
        }
        return closest?.0
    }

    // MARK: - Focus

    /// What the map is lighting up: a thread being drawn, a dot being
    /// touched, else the selection.
    private var focusID: String? { connectSourceID ?? pressedID ?? selectedID }

    private func focusSet(_ focus: String?) -> Set<String> {
        guard let focus else { return [] }
        return (adjacency[focus] ?? []).union([focus])
    }

    // MARK: - Frame loop

    private var isNavigating: Bool {
        dragStart != nil || panNeedsReanchor || pinching || connectSourceID != nil || hypot(momentum.x, momentum.y) > 4
    }

    private var needsFrames: Bool {
        (!layout.isSettled && !reduceMotion && !isNavigating && !touching && !isPreparingLayout) || camera != nil || animating
            || hypot(momentum.x, momentum.y) > 4 || connectSourceID != nil
            || (isPreparingLayout && preparationTask == nil && !isNavigating && !touching)
    }

    /// Something the drawing animates towards has changed.
    private func wake() {
        if reduceMotion { settleAnimations() } else { animating = true }
        startPreparationIfNeeded()
        setNeedsDisplay()
        startLoopIfNeeded()
    }

    private func startLoopIfNeeded() {
        guard displayLink == nil, window != nil, needsFrames else { return }
        let link = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        displayLink = link
        lastTick = CACurrentMediaTime()
    }

    private func stopLoop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    fileprivate func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = min(1.0 / 20, max(1.0 / 240, now - lastTick))
        lastTick = now
        startPreparationIfNeeded()
        if !layout.isSettled && !reduceMotion && !isNavigating && !touching && !isPreparingLayout {
            layout.step()
            if !interactive { fit(animated: false) }
        }
        if let flight = camera {
            let t = min(1, (now - flight.start) / flight.duration)
            let eased = CGFloat(t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2)
            viewport = GraphViewport(
                scale: flight.from.scale + (flight.to.scale - flight.from.scale) * eased,
                offset: CGPoint(x: flight.from.offset.x + (flight.to.offset.x - flight.from.offset.x) * eased,
                                y: flight.from.offset.y + (flight.to.offset.y - flight.from.offset.y) * eased))
            if t >= 1 { camera = nil }
        }
        if hypot(momentum.x, momentum.y) > 4 {
            viewport.offset.x += momentum.x * CGFloat(dt)
            viewport.offset.y += momentum.y * CGFloat(dt)
            // Exponential friction, frame-rate independent.
            let friction = CGFloat(pow(0.0025, dt))
            momentum.x *= friction; momentum.y *= friction
        }
        if let point = connectPoint, connectSourceID != nil { edgePan(toward: point, dt: dt) }
        if animating { animate(CGFloat(dt)) }
        setNeedsDisplay()
        if !needsFrames {
            momentum = .zero
            stopLoop()
            refreshAccessibility()
        }
    }

    /// Semi-implicit spring step; stable at any frame time the loop allows.
    private static func spring(_ value: inout CGFloat, _ velocity: inout CGFloat, to target: CGFloat,
                               stiffness: CGFloat, damping: CGFloat, dt: CGFloat) {
        velocity += (stiffness * (target - value) - damping * velocity) * dt
        value += velocity * dt
    }

    /// One frame of every drawn transition. Clears `animating` once all of
    /// them are at rest, which lets the frame loop stop.
    private func animate(_ dt: CGFloat) {
        let lit = focusSet(focusID)
        // About 90ms to get most of the way: quick enough to feel attached
        // to the finger, slow enough to read as a crossfade.
        let ease = 1 - exp(-dt / 0.09)
        var moving = false
        for (i, id) in layout.ids.enumerated() {
            guard var m = motion[id] else { continue }
            let radius = layout.radii[i]
            let litTarget: CGFloat = lit.contains(id) ? 1 : 0
            Self.spring(&m.radius, &m.radiusVelocity, to: radius, stiffness: 120, damping: 14, dt: dt)
            Self.spring(&m.presence, &m.presenceVelocity, to: 1, stiffness: 210, damping: 18, dt: dt)
            m.lit += (litTarget - m.lit) * ease
            if abs(m.radius - radius) < 0.02 && abs(m.radiusVelocity) < 0.05 { m.radius = radius; m.radiusVelocity = 0 } else { moving = true }
            if abs(1 - m.presence) < 0.002 && abs(m.presenceVelocity) < 0.01 { m.presence = 1; m.presenceVelocity = 0 } else { moving = true }
            if abs(litTarget - m.lit) < 0.004 { m.lit = litTarget } else { moving = true }
            motion[id] = m
        }
        var focusLinks = Set<GraphLink>()
        if let focus = focusID { for other in adjacency[focus] ?? [] { focusLinks.insert(GraphLink(focus, other)) } }
        for link in focusLinks where linkLit[link] == nil { linkLit[link] = 0 }
        for (link, value) in linkLit {
            let target: CGFloat = focusLinks.contains(link) ? 1 : 0
            let next = value + (target - value) * ease
            if abs(target - next) < 0.004 { linkLit[link] = target == 0 ? nil : 1 } else { linkLit[link] = next; moving = true }
        }
        let dimTarget: CGFloat = focusID == nil ? 0 : 1
        dim += (dimTarget - dim) * ease
        if abs(dimTarget - dim) < 0.004 { dim = dimTarget } else { moving = true }
        let ringTarget: CGFloat = selectedID == nil ? 0 : 1
        ring += (ringTarget - ring) * (1 - exp(-dt / 0.14))
        if abs(ringTarget - ring) < 0.004 { ring = ringTarget } else { moving = true }
        for index in ghosts.indices { ghosts[index].life -= dt / 0.3 }
        ghosts.removeAll { $0.life <= 0 }
        animating = moving || !ghosts.isEmpty
    }

    /// Every transition at its end state, at once — Reduce Motion, and
    /// anything drawn without a frame loop.
    private func settleAnimations() {
        let lit = focusSet(focusID)
        for (i, id) in layout.ids.enumerated() {
            motion[id] = Motion(radius: layout.radii[i], presence: 1, lit: lit.contains(id) ? 1 : 0)
        }
        linkLit = [:]
        if let focus = focusID { for other in adjacency[focus] ?? [] { linkLit[GraphLink(focus, other)] = 1 } }
        dim = focusID == nil ? 0 : 1
        ring = selectedID == nil ? 0 : 1
        ghosts = []
        animating = false
    }

    /// While a connection is being drawn, holding the finger near an edge
    /// scrolls the map, so the other end can be anywhere.
    private func edgePan(toward point: CGPoint, dt: CFTimeInterval) {
        let margin: CGFloat = 44, speed: CGFloat = 420
        var push = CGPoint.zero
        if point.x < margin { push.x = (margin - point.x) / margin }
        if point.x > bounds.width - margin { push.x = -(point.x - bounds.width + margin) / margin }
        if point.y < insets.top + margin { push.y = (insets.top + margin - point.y) / margin }
        if point.y > bounds.height - margin { push.y = -(point.y - bounds.height + margin) / margin }
        guard push != .zero else { return }
        viewport.offset.x += push.x * speed * CGFloat(dt)
        viewport.offset.y += push.y * speed * CGFloat(dt)
        updateConnectTarget(at: point)
    }

    // MARK: - Gestures

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        touching = true
        interruptPreparationForInteraction()
        camera = nil; momentum = .zero
        guard interactive, event?.allTouches?.count == 1, let touch = touches.first else { return press(nil) }
        press(hitNode(at: touch.location(in: self), slop: 12))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        touching = !(event?.allTouches?.allSatisfy { $0.phase == .ended || $0.phase == .cancelled } ?? true)
        press(nil)
        startPreparationIfNeeded()
        startLoopIfNeeded()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        touching = false
        press(nil)
        startPreparationIfNeeded()
        startLoopIfNeeded()
    }

    /// A finger resting on a dot lights it and its neighbours, the way
    /// hovering does in Obsidian — before the finger has decided whether it
    /// is a tap, a drag or a connection.
    private func press(_ id: String?) {
        guard id != pressedID else { return }
        pressedID = id
        wake()
    }

    @objc private func tap(_ gesture: UITapGestureRecognizer) {
        momentum = .zero
        onSelect?(hitNode(at: gesture.location(in: self)))
    }

    @objc private func doubleTap(_ gesture: UITapGestureRecognizer) {
        interruptPreparationForInteraction()
        let point = gesture.location(in: self)
        cameraTouched = true
        if let id = hitNode(at: point) {
            onSelect?(id)
            guard let position = layout.position(of: id) else { return }
            var target = viewport
            target.scale = min(4, max(viewport.scale * 1.6, 1.3))
            target.offset = CGPoint(x: focusCenter.x - bounds.midX - position.x * target.scale,
                                    y: focusCenter.y - bounds.midY - position.y * target.scale)
            fly(to: target, animated: true)
        } else {
            zoom(to: viewport.scale * 1.8, anchor: point, animated: true)
        }
    }

    /// Every ordinary drag grabs the map, including one starting on a dot.
    func beginDrag(at point: CGPoint) {
        guard !pinching else { return }
        interruptPreparationForInteraction()
        cameraTouched = true
        camera = nil; momentum = .zero
        dragStart = point; originalViewport = viewport
    }

    func drag(to point: CGPoint) {
        guard dragStart != nil, !pinching else { return }
        if let start = dragStart {
            viewport.offset = CGPoint(x: originalViewport.offset.x + point.x - start.x,
                                      y: originalViewport.offset.y + point.y - start.y)
        }
        setNeedsDisplay()
    }

    func endDrag(cancelled: Bool, velocity: CGPoint = .zero) {
        guard dragStart != nil else { return }
        // Pinch owns the camera while two fingers are down. A cancelled pan
        // must not restore the camera from before the second finger arrived.
        if !pinching {
            if cancelled { viewport = originalViewport }
            else if !reduceMotion { momentum = velocity }
        }
        dragStart = nil
        startPreparationIfNeeded()
        startLoopIfNeeded()
        refreshAccessibility(); setNeedsDisplay()
    }

    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        handlePan(state: gesture.state, at: gesture.location(in: self),
                  translation: gesture.translation(in: self), velocity: gesture.velocity(in: self),
                  touchCount: gesture.numberOfTouches)
    }

    func handlePan(state: UIGestureRecognizer.State, at point: CGPoint,
                   translation: CGPoint = .zero, velocity: CGPoint = .zero, touchCount: Int) {
        switch state {
        case .began:
            guard touchCount == 1, !pinching else {
                panNeedsReanchor = true
                momentum = .zero; camera = nil
                return
            }
            panNeedsReanchor = false
            beginDrag(at: CGPoint(x: point.x - translation.x, y: point.y - translation.y)); drag(to: point)
        case .changed:
            // Adding a finger changes UIPan's location from that finger to
            // the midpoint. Only the pinch may use that midpoint to move
            // the camera, even before it crosses its recognition threshold.
            guard touchCount == 1 else {
                panNeedsReanchor = true
                momentum = .zero; camera = nil
                return
            }
            guard !pinching else { return }
            if panNeedsReanchor {
                panNeedsReanchor = false
                beginDrag(at: point)
            } else { drag(to: point) }
        case .ended:
            let releaseVelocity = panNeedsReanchor ? CGPoint.zero : velocity
            panNeedsReanchor = false
            endDrag(cancelled: false, velocity: releaseVelocity)
            startLoopIfNeeded()
        case .cancelled, .failed:
            let restore = !panNeedsReanchor
            panNeedsReanchor = false
            endDrag(cancelled: restore)
            startLoopIfNeeded()
        default: break
        }
    }

    @objc private func pinch(_ gesture: UIPinchGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            beginPinch(at: point, recognizerScale: gesture.scale)
        case .changed:
            if gesture.numberOfTouches == 2 { changePinch(scale: gesture.scale, at: point) }
        default: break
        }
        if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
            let continuing = panGesture.flatMap { pan in
                (pan.state == .began || pan.state == .changed) && pan.numberOfTouches == 1
                    ? pan.location(in: self) : nil
            }
            endPinch(continuingPanAt: continuing)
        }
        setNeedsDisplay()
    }

    func beginPinch(at point: CGPoint, recognizerScale: CGFloat = 1) {
        interruptPreparationForInteraction()
        cameraTouched = true
        camera = nil; momentum = .zero
        pinching = true
        pinchStartScale = viewport.scale
        pinchRecognizerStartScale = max(0.001, recognizerScale)
        pinchWorldAnchor = viewport.world(point, size: bounds.size)
    }

    func changePinch(scale: CGFloat, at point: CGPoint) {
        guard pinching else { return }
        // Use the live midpoint only while both fingers are down. On .ended
        // UIKit may report the remaining finger instead, which would jump
        // the map from the midpoint to that finger.
        viewport.scale = min(4, max(0.15, pinchStartScale * scale / pinchRecognizerStartScale))
        viewport.offset = CGPoint(x: point.x - bounds.midX - pinchWorldAnchor.x * viewport.scale,
                                  y: point.y - bounds.midY - pinchWorldAnchor.y * viewport.scale)
        setNeedsDisplay()
    }

    func endPinch(continuingPanAt point: CGPoint? = nil) {
        // A pinch that merely failed to recognize during an ordinary drag
        // does not own that drag and must not clear its starting position.
        guard pinching else { return }
        pinching = false
        panNeedsReanchor = false
        dragStart = nil
        if let point { beginDrag(at: point) }
        startPreparationIfNeeded()
        startLoopIfNeeded()
        refreshAccessibility()
    }

    @objc private func longPress(_ gesture: UILongPressGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            if onConnect != nil, let source = hitNode(at: point, slop: 12) {
                beginConnect(from: source, at: point)
            } else {
                // Not on an item: a held finger is just a slow pan.
                beginDrag(at: point)
            }
        case .changed:
            if connectSourceID != nil { moveConnect(to: point) } else { drag(to: point) }
        case .ended:
            if connectSourceID != nil { endConnect(cancelled: false) } else { endDrag(cancelled: false) }
        case .cancelled, .failed:
            if connectSourceID != nil { endConnect(cancelled: true) } else { endDrag(cancelled: true) }
        default: break
        }
    }

    func beginConnect(from source: String, at point: CGPoint) {
        interruptPreparationForInteraction()
        camera = nil; momentum = .zero
        connectSourceID = source
        connectPoint = point
        connectTargetID = nil
        impactFeedback.impactOccurred()
        selectionFeedback.prepare()
        wake()
    }

    func moveConnect(to point: CGPoint) {
        connectPoint = point
        updateConnectTarget(at: point)
        setNeedsDisplay()
    }

    private func updateConnectTarget(at point: CGPoint) {
        let target = hitNode(at: point, slop: 26, excluding: connectSourceID)
        if target != connectTargetID {
            connectTargetID = target
            if target != nil { selectionFeedback.selectionChanged() }
        }
    }

    /// How far from its item a thread has to be pulled before letting go on
    /// open canvas means "a new item" rather than "never mind".
    static let newItemPull: CGFloat = 90

    /// True while the thread is far enough out that releasing it would start
    /// a new item.
    var connectWouldCreate: Bool {
        guard connectTargetID == nil, let source = connectSourceID, let finger = connectPoint,
              let position = layout.position(of: source) else { return false }
        let from = viewport.screen(position, size: bounds.size)
        return hypot(finger.x - from.x, finger.y - from.y) >= Self.newItemPull
    }

    func endConnect(cancelled: Bool) {
        let source = connectSourceID, target = connectTargetID
        let create = connectWouldCreate
        connectSourceID = nil; connectTargetID = nil; connectPoint = nil
        wake()
        guard !cancelled, let source, target != nil || create else { return }
        impactFeedback.impactOccurred(intensity: 0.7)
        onConnect?(source, target)
    }

    // MARK: - Drawing

    /// The map's colours for one appearance, resolved once per frame.
    private struct Palette {
        let canvas: UIColor, ink: UIColor, muted: UIColor, accent: UIColor, raised: UIColor
        init(dark: Bool) {
            let scheme: ColorScheme = dark ? .dark : .light
            canvas = UIColor(AssistantTheme.canvas(for: scheme))
            ink = UIColor(AssistantTheme.ink(for: scheme))
            muted = UIColor(AssistantTheme.inkMuted(for: scheme))
            accent = UIColor(AssistantTheme.accent(for: scheme))
            raised = UIColor(AssistantTheme.raised(for: scheme))
        }
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let palette = Palette(dark: dark)
        palette.canvas.setFill(); context.fill(bounds)
        let size = bounds.size
        let scale = viewport.scale
        let focus = focusID
        let lit = focusSet(focus)
        let visibleArea = bounds.insetBy(dx: -60, dy: -40)

        // Where every dot is, and how big, once for the frame.
        var place: [String: CGPoint] = [:], radius: [String: CGFloat] = [:], presence: [String: CGFloat] = [:]
        place.reserveCapacity(layout.ids.count); radius.reserveCapacity(layout.ids.count)
        for (i, id) in layout.ids.enumerated() {
            place[id] = viewport.screen(layout.positions[i], size: size)
            let m = motion[id]
            let arrived: CGFloat = max(0, m?.presence ?? 1)
            let world: CGFloat = m?.radius ?? layout.radii[i]
            presence[id] = min(1, arrived)
            radius[id] = screenRadius(world: world) * arrived
        }
        /// How visible a dot is: everything outside the focus recedes
        /// together, and a newcomer fades up as it pops in.
        func opacity(_ id: String) -> CGFloat {
            let lit: CGFloat = motion[id]?.lit ?? 0
            let arrived: CGFloat = presence[id] ?? 1
            return (1 - dim * (1 - lit) * 0.84) * arrived
        }

        drawGhosts(context, palette: palette, size: size)
        drawLinks(context, palette: palette, place: place, radius: radius, presence: presence, visibleArea: visibleArea)
        drawThread(context, palette: palette, place: place)

        // Names are handed out in this order, and the canvas runs out of room
        // long before it runs out of nodes, so the order decides which names
        // the owner gets: the focus, its neighbours, names already showing
        // (so they do not flicker as the map drifts), then the biggest hubs.
        let rank = { (id: String) -> Int in
            if id == self.connectSourceID || id == self.connectTargetID || id == self.selectedID || id == focus { return 0 }
            if lit.contains(id) { return 1 }
            if self.lastLabelIDs.contains(id) { return 2 }
            return 3
        }
        let ordered = nodes.sorted {
            let r0 = rank($0.id), r1 = rank($1.id)
            if r0 != r1 { return r0 < r1 }
            let d0 = degrees[$0.id] ?? 0, d1 = degrees[$1.id] ?? 0
            return d0 != d1 ? d0 > d1 : $0.id < $1.id
        }

        // Every dot before any name, so no dot is ever painted over a name;
        // the least important first, so hubs and the focus sit on top.
        var nodeBounds: [CGRect] = []
        for node in ordered.reversed() {
            guard let point = place[node.id], visibleArea.contains(point), let r = radius[node.id], r > 0.3 else { continue }
            let alpha = opacity(node.id)
            let isSelected = node.id == selectedID
            let isConnectEnd = node.id == connectTargetID || node.id == connectSourceID
            let tint = Self.tint(for: node.kind, dark: dark)
            let body = CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)
            if isConnectEnd {
                let halo = r + 12
                context.setFillColor(palette.accent.withAlphaComponent(0.24).cgColor)
                context.fillEllipse(in: CGRect(x: point.x - halo, y: point.y - halo, width: halo * 2, height: halo * 2))
            } else if isSelected && ring > 0.01 {
                // A soft glow in the item's own colour, then a ring that draws
                // itself in around it.
                let halo = r + 4 + 10 * ring
                context.setFillColor(tint.withAlphaComponent(0.16 * ring).cgColor)
                context.fillEllipse(in: CGRect(x: point.x - halo, y: point.y - halo, width: halo * 2, height: halo * 2))
            }
            context.setFillColor(tint.withAlphaComponent(alpha).cgColor)
            context.fillEllipse(in: body)
            if r > 3.5 {
                // A hairline in the canvas colour cuts each dot out of the
                // lines beneath it, so a busy hub still reads as one clean disc.
                context.setStrokeColor(palette.canvas.withAlphaComponent(0.85 * alpha).cgColor)
                context.setLineWidth(1.2)
                context.strokeEllipse(in: body.insetBy(dx: -0.6, dy: -0.6))
            }
            if isSelected && ring > 0.01 {
                let ringRadius = r + 4.5
                context.setStrokeColor(palette.ink.withAlphaComponent(0.85 * ring).cgColor)
                context.setLineWidth(1.75)
                context.addArc(center: point, radius: ringRadius, startAngle: -.pi / 2,
                               endAngle: -.pi / 2 + 2 * .pi * ring, clockwise: false)
                context.strokePath()
            }
            nodeBounds.append(body)
        }

        var occupied: [CGRect] = []
        var named: Set<String> = []
        // A ration for the zoomed-out map. Fading alone would still let a
        // two-hundred-item overview wear forty names, and nobody reads that.
        var looseNamesLeft = scale < 0.6 ? 18 : 60
        let showDetail = scale >= Self.detailScale
        for (rankIndex, node) in ordered.enumerated() {
            guard let point = place[node.id], bounds.insetBy(dx: 2, dy: 2).contains(point) else { continue }
            let degree = degrees[node.id] ?? 0
            let isSelected = node.id == selectedID
            let isConnectEnd = node.id == connectSourceID || node.id == connectTargetID
            let isLit = focus != nil && lit.contains(node.id)
            let mustName = isSelected || isConnectEnd || isLit || (focus == nil && rankIndex < 3)
            var alpha = mustName ? 1 : Self.labelOpacity(scale: scale, degree: degree, fade: settings.textFade)
            let nodeLit: CGFloat = motion[node.id]?.lit ?? 0
            let arrived: CGFloat = presence[node.id] ?? 1
            alpha *= (1 - dim * (1 - nodeLit) * 0.65) * arrived
            guard alpha > 0.04 else { continue }
            guard mustName || looseNamesLeft > 0 else { continue }

            let emphasized = isSelected || isConnectEnd
            var subtitle: String?
            if showDetail {
                let count = degree == 1 ? "1 link" : "\(degree) links"
                subtitle = "\(node.kind.sentenceCaseIdentifier) · \(count)"
            }
            let image = labelImage(node.label, subtitle: subtitle, emphasized: emphasized, palette: palette)
            let r = radius[node.id] ?? screenRadius(for: node.id)
            let w = image.size.width, h = image.size.height
            func inside(_ rect: CGRect) -> CGRect {
                var shifted = rect
                shifted.origin.x = min(max(2, rect.origin.x), max(2, bounds.width - rect.width - 2))
                shifted.origin.y = min(max(0, rect.origin.y), max(0, bounds.height - rect.height))
                return shifted
            }
            // Below first, as Obsidian puts it; then above, right and left.
            let gap: CGFloat = isSelected ? 7 : 2
            let candidates = [
                CGRect(x: point.x - w / 2, y: point.y + r + gap, width: w, height: h),
                CGRect(x: point.x - w / 2, y: point.y - r - gap - h, width: w, height: h),
                CGRect(x: point.x + r + gap + 2, y: point.y - h / 2, width: w, height: h),
                CGRect(x: point.x - r - gap - 2 - w, y: point.y - h / 2, width: w, height: h),
            ].map(inside)
            func crowding(_ candidate: CGRect) -> CGFloat {
                let padded = candidate.insetBy(dx: -1, dy: 0)
                var total: CGFloat = 0
                for other in occupied {
                    let overlap = other.intersection(padded)
                    if !overlap.isNull { total += overlap.width * overlap.height }
                }
                for other in nodeBounds where other.intersects(padded) {
                    let overlap = other.intersection(padded)
                    total += overlap.width * overlap.height * 0.5
                }
                return total
            }
            let clear = candidates.first { crowding($0) == 0 }
            let fallback = mustName ? candidates.min(by: { crowding($0) < crowding($1) }) : nil
            guard let box = clear ?? fallback else { continue }
            if !mustName { looseNamesLeft -= 1 }
            named.insert(node.id)
            occupied.append(box)
            // No plate behind the name: a halo in the canvas colour, baked
            // into the picture, keeps it readable over lines without boxing
            // the map into labels.
            image.draw(in: box, blendMode: .normal, alpha: min(1, alpha))
        }
        namedNodeIDs = named
        lastLabelIDs = named

        drawPhrases(context, palette: palette, place: place, occupied: &occupied, nodeBounds: nodeBounds)
    }

    /// Lines are drawn from rim to rim, not centre to centre, so a dimmed,
    /// translucent dot never shows a line running through it. Lines at rest
    /// share one path per style — one stroke for hundreds of them — and only
    /// the few that are lit or still arriving are drawn one by one.
    private func drawLinks(_ context: CGContext, palette: Palette, place: [String: CGPoint], radius: [String: CGFloat],
                           presence: [String: CGFloat], visibleArea: CGRect) {
        let scale = viewport.scale
        let baseAlpha: CGFloat = dark ? 0.26 : 0.2
        let restAlpha: CGFloat = baseAlpha * (1 - dim * 0.72)
        let zoomWidth: CGFloat = min(1.6, max(0.7, sqrt(scale)))
        let width: CGFloat = 0.9 * settings.linkThickness * zoomWidth
        let arrowsAtRest = settings.arrows && scale >= 1.4
        let arrowsWhenLit = settings.arrows && scale >= 0.55
        let solid = CGMutablePath(), dashed = CGMutablePath(), heads = CGMutablePath()
        var special: [(link: GraphLink, start: CGPoint, end: CGPoint, lit: CGFloat, presence: CGFloat)] = []

        for link in links {
            guard let p = place[link.a], let q = place[link.b] else { continue }
            let box = CGRect(x: min(p.x, q.x), y: min(p.y, q.y), width: abs(p.x - q.x) + 1, height: abs(p.y - q.y) + 1)
            guard box.intersects(visibleArea) else { continue }
            let dx = q.x - p.x, dy = q.y - p.y, length = hypot(dx, dy)
            let ra: CGFloat = (radius[link.a] ?? 0) + 1
            let rb: CGFloat = (radius[link.b] ?? 0) + 1
            guard length > ra + rb + 1 else { continue }
            let ux = dx / length, uy = dy / length
            let start = CGPoint(x: p.x + ux * ra, y: p.y + uy * ra), end = CGPoint(x: q.x - ux * rb, y: q.y - uy * rb)
            let glow: CGFloat = linkLit[link] ?? 0
            let arrivingA: CGFloat = presence[link.a] ?? 1
            let arriving: CGFloat = min(arrivingA, presence[link.b] ?? 1)
            if glow > 0.01 || arriving < 0.999 {
                special.append((link, start, end, glow, arriving))
                continue
            }
            let path = unreviewed.contains(link) ? dashed : solid
            path.move(to: start); path.addLine(to: end)
            if arrowsAtRest { addArrowhead(to: heads, link: link, start: start, end: end, size: 5 * min(1.3, max(1, width))) }
        }

        context.setLineCap(.round)
        context.setLineWidth(width)
        context.setStrokeColor(palette.ink.withAlphaComponent(restAlpha).cgColor)
        context.addPath(solid); context.strokePath()
        context.setLineDash(phase: 0, lengths: [3, 4])
        context.addPath(dashed); context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
        context.setFillColor(palette.ink.withAlphaComponent(restAlpha * 1.4).cgColor)
        context.addPath(heads); context.fillPath()

        for line in special {
            // Lit lines take the accent and thicken; the crossfade is the
            // line's own colour moving, not a second line fading over it.
            let color = Self.mix(palette.ink, palette.accent, line.lit)
            let alpha: CGFloat = (restAlpha + (0.85 - restAlpha) * line.lit) * line.presence
            context.setStrokeColor(color.withAlphaComponent(alpha).cgColor)
            context.setLineWidth(width * (1 + 0.8 * line.lit))
            context.setLineDash(phase: 0, lengths: unreviewed.contains(line.link) ? [3, 4] : [])
            context.move(to: line.start); context.addLine(to: line.end); context.strokePath()
            if (line.lit > 0.5 && arrowsWhenLit) || arrowsAtRest {
                let head = CGMutablePath()
                addArrowhead(to: head, link: line.link, start: line.start, end: line.end, size: line.lit > 0.5 ? 7 : 5)
                context.setFillColor(color.withAlphaComponent(alpha).cgColor)
                context.addPath(head); context.fillPath()
            }
        }
        context.setLineDash(phase: 0, lengths: [])
    }

    /// A filled head at the recorded object's end of the line.
    private func addArrowhead(to path: CGMutablePath, link: GraphLink, start: CGPoint, end: CGPoint, size: CGFloat) {
        guard let target = edgeDirections[link] else { return }
        let tip = target == link.b ? end : start, tail = target == link.b ? start : end
        guard hypot(tip.x - tail.x, tip.y - tail.y) > size * 2.5 else { return }
        let angle = atan2(tip.y - tail.y, tip.x - tail.x)
        let back = CGPoint(x: tip.x - cos(angle) * size, y: tip.y - sin(angle) * size)
        let spread = size * 0.5
        path.move(to: tip)
        path.addLine(to: CGPoint(x: back.x + sin(angle) * spread, y: back.y - cos(angle) * spread))
        path.addLine(to: CGPoint(x: back.x - sin(angle) * spread, y: back.y + cos(angle) * spread))
        path.closeSubpath()
    }

    private func drawGhosts(_ context: CGContext, palette: Palette, size: CGSize) {
        for ghost in ghosts {
            let life = max(0, min(1, ghost.life))
            let point = viewport.screen(ghost.point, size: size)
            context.setStrokeColor(palette.ink.withAlphaComponent((dark ? 0.26 : 0.2) * life).cgColor)
            context.setLineWidth(0.9 * settings.linkThickness)
            for end in ghost.ends {
                context.move(to: point); context.addLine(to: viewport.screen(end, size: size))
            }
            context.strokePath()
            let r = screenRadius(world: ghost.radius) * (0.4 + 0.6 * life)
            context.setFillColor(Self.tint(for: ghost.kind, dark: dark).withAlphaComponent(life).cgColor)
            context.fillEllipse(in: CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2))
        }
    }

    /// The thread being drawn to make a new connection.
    private func drawThread(_ context: CGContext, palette: Palette, place: [String: CGPoint]) {
        guard let source = connectSourceID, let from = place[source], let finger = connectPoint else { return }
        let to = connectTargetID.flatMap { place[$0] } ?? finger
        context.setStrokeColor(palette.accent.cgColor)
        context.setLineWidth(2.2)
        context.setLineCap(.round)
        context.setLineDash(phase: 0, lengths: connectTargetID == nil ? [6, 5] : [])
        context.move(to: from); context.addLine(to: to); context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
        guard connectTargetID == nil else { return }
        // Out on open canvas the thread ends in a "+": letting go there makes
        // a new item.
        let creating = connectWouldCreate
        let radius: CGFloat = creating ? 17 : 14
        context.setFillColor(palette.accent.withAlphaComponent(creating ? 0.9 : 0.25).cgColor)
        context.fillEllipse(in: CGRect(x: finger.x - radius, y: finger.y - radius, width: radius * 2, height: radius * 2))
        if creating {
            context.setStrokeColor(palette.canvas.cgColor)
            context.setLineWidth(2.4)
            context.move(to: CGPoint(x: finger.x - 7, y: finger.y)); context.addLine(to: CGPoint(x: finger.x + 7, y: finger.y))
            context.move(to: CGPoint(x: finger.x, y: finger.y - 7)); context.addLine(to: CGPoint(x: finger.x, y: finger.y + 7))
            context.strokePath()
        }
    }

    /// What each line means: the focus's lines once they are long enough to
    /// carry words, every line once the map is close enough.
    private func drawPhrases(_ context: CGContext, palette: Palette, place: [String: CGPoint],
                             occupied: inout [CGRect], nodeBounds: [CGRect]) {
        let scale = viewport.scale
        // `links` is already sorted, so filtering it keeps the order stable.
        let lit: [GraphLink] = links.filter { (link: GraphLink) -> Bool in (linkLit[link] ?? 0) > 0.5 }
        let phraseLinks: [GraphLink]
        if scale >= Self.allEdgePhrasesScale {
            let rest: [GraphLink] = links.filter { (link: GraphLink) -> Bool in (linkLit[link] ?? 0) <= 0.5 }
            phraseLinks = lit + rest
        }
        else if scale >= 0.85 { phraseLinks = lit }
        else { phraseLinks = [] }
        // Rationed: a hub's forty meanings at once is a wall of pills, not a
        // map. The focus's lines are offered first.
        var phrasesLeft = 14
        for link in phraseLinks where phrasesLeft > 0 {
            guard let label = edgeLabels[link], let start = place[link.a], let end = place[link.b] else { continue }
            let length = hypot(end.x - start.x, end.y - start.y)
            guard length > 84 else { continue }
            let middle = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
            guard bounds.contains(middle) else { continue }
            let image = phraseImage(label, maxWidth: min(length - 30, 128), palette: palette)
            guard image.size.width > 24 else { continue }
            let box = CGRect(x: middle.x - image.size.width / 2, y: middle.y - image.size.height / 2,
                             width: image.size.width, height: image.size.height)
            guard !occupied.contains(where: { $0.intersects(box) }),
                  !nodeBounds.contains(where: { $0.intersects(box) }) else { continue }
            occupied.append(box)
            image.draw(in: box)
            phrasesLeft -= 1
        }
    }

    // MARK: - Label pictures

    /// A name, and at close zoom what it is, drawn once with a halo in the
    /// canvas colour and reused every frame after. Setting text is the most
    /// expensive thing a frame of this map does; blitting a picture is not.
    private func labelImage(_ title: String, subtitle: String?, emphasized: Bool, palette: Palette) -> UIImage {
        let key = "n|\(emphasized)|\(title)|\(subtitle ?? "")"
        if let cached = labelImages[key] { return cached }
        let font = Self.scaledFont(emphasized ? 14 : 12, weight: emphasized ? .semibold : .medium)
        let detailFont = Self.scaledFont(10, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        let maxWidth: CGFloat = emphasized ? 200 : 150
        let titleSize = (title as NSString).size(withAttributes: [.font: font])
        let detailSize = subtitle.map { ($0 as NSString).size(withAttributes: [.font: detailFont]) } ?? .zero
        let pad: CGFloat = 3
        let textWidth = min(maxWidth, ceil(max(titleSize.width, detailSize.width)))
        let titleHeight = ceil(titleSize.height), detailHeight = subtitle == nil ? 0 : ceil(detailFont.lineHeight)
        let size = CGSize(width: textWidth + pad * 2, height: titleHeight + detailHeight + pad * 2)
        let image = renderer(size).image { rendererContext in
            rendererContext.cgContext.setLineJoin(.round)
            let titleRect = CGRect(x: pad, y: pad, width: textWidth, height: titleHeight)
            let detailRect = CGRect(x: pad, y: pad + titleHeight, width: textWidth, height: detailHeight)
            for halo in [true, false] {
                var titleAttributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph,
                                                                      .foregroundColor: halo ? palette.canvas : palette.ink]
                var detailAttributes: [NSAttributedString.Key: Any] = [.font: detailFont, .paragraphStyle: paragraph,
                                                                       .foregroundColor: halo ? palette.canvas : palette.muted]
                if halo {
                    // A positive stroke width outlines without filling: a
                    // rim about two points wide around every letter.
                    titleAttributes[.strokeColor] = palette.canvas; titleAttributes[.strokeWidth] = 32
                    detailAttributes[.strokeColor] = palette.canvas; detailAttributes[.strokeWidth] = 36
                }
                (title as NSString).draw(with: titleRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                         attributes: titleAttributes, context: nil)
                if let subtitle {
                    (subtitle as NSString).draw(with: detailRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                                attributes: detailAttributes, context: nil)
                }
            }
        }
        store(image, key)
        return image
    }

    /// A line's meaning, on a small pill that interrupts the line cleanly.
    private func phraseImage(_ text: String, maxWidth: CGFloat, palette: Palette) -> UIImage {
        let width = floor(max(0, maxWidth))
        let key = "e|\(width)|\(text)"
        if let cached = labelImages[key] { return cached }
        let font = Self.scaledFont(10, weight: .medium)
        let measured = (text as NSString).size(withAttributes: [.font: font])
        let textWidth = min(width - 12, ceil(measured.width))
        guard textWidth > 12 else { return UIImage() }
        let size = CGSize(width: textWidth + 12, height: ceil(measured.height) + 4)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        let image = renderer(size).image { rendererContext in
            let pill = UIBezierPath(roundedRect: CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5), cornerRadius: size.height / 2)
            palette.raised.setFill(); pill.fill()
            palette.ink.withAlphaComponent(dark ? 0.16 : 0.08).setStroke(); pill.lineWidth = 1; pill.stroke()
            (text as NSString).draw(with: CGRect(x: 6, y: 2, width: textWidth, height: ceil(measured.height)),
                                    options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                    attributes: [.font: font, .foregroundColor: palette.muted, .paragraphStyle: paragraph],
                                    context: nil)
        }
        store(image, key)
        return image
    }

    private func renderer(_ size: CGSize) -> UIGraphicsImageRenderer {
        let format = UIGraphicsImageRendererFormat()
        format.scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 3
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format)
    }

    private func store(_ image: UIImage, _ key: String) {
        // Bounded: a long session of walking the map meets many names.
        if labelImages.count > 700 { labelImages.removeAll(keepingCapacity: true) }
        labelImages[key] = image
    }

    // MARK: - Colour

    /// One colour per kind of item — the map's groups, as Obsidian colours
    /// its groups. Tuned as a set: similar weight and lightness, so no kind
    /// shouts over another, and distinct in hue, so each reads at a glance in
    /// both appearances. People take the app's own green.
    static func tint(for kind: String, dark: Bool) -> UIColor {
        switch kind {
        case "person": dark ? UIColor(rgb: 0x6FCB9C) : UIColor(rgb: 0x217A4B)
        case "place": dark ? UIColor(rgb: 0x5DBFD4) : UIColor(rgb: 0x1C7589)
        case "organization": dark ? UIColor(rgb: 0x9AA3F7) : UIColor(rgb: 0x4B55C8)
        case "project": dark ? UIColor(rgb: 0xEBA564) : UIColor(rgb: 0xB35E14)
        case "event": dark ? UIColor(rgb: 0xCD91E6) : UIColor(rgb: 0x8E44AD)
        case "topic": dark ? UIColor(rgb: 0xEC8FB6) : UIColor(rgb: 0xB23F74)
        default: dark ? UIColor(rgb: 0x95A69C) : UIColor(rgb: 0x6F8077)
        }
    }

    private static func mix(_ from: UIColor, _ to: UIColor, _ amount: CGFloat) -> UIColor {
        var r0: CGFloat = 0, g0: CGFloat = 0, b0: CGFloat = 0, a0: CGFloat = 0
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        from.getRed(&r0, green: &g0, blue: &b0, alpha: &a0)
        to.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        let t = min(1, max(0, amount))
        return UIColor(red: r0 + (r1 - r0) * t, green: g0 + (g1 - g0) * t, blue: b0 + (b1 - b0) * t, alpha: 1)
    }

    // MARK: - Accessibility

    /// How this node connects, in words. The canvas draws a relationship as a
    /// line and its review status as a dash, so without this a VoiceOver user
    /// could hear every name and still learn nothing about how two relate.
    /// Bounded, because an announcement that recites forty edges is its own
    /// kind of unusable.
    private func connectionSummary(for id: String, names: [String: String], linksByID: [String: [GraphLink]]) -> String {
        let touching = linksByID[id] ?? []
        let described = touching.prefix(6).compactMap { link -> String? in
            guard let otherID = link.other(than: id), let other = names[otherID] else { return nil }
            let relation = edgeLabels[link] ?? "connected"
            let status = unreviewed.contains(link) ? "needs review" : "confirmed"
            return "\(relation) \(other), \(status)"
        }
        guard !described.isEmpty else { return "No recorded connections" }
        let more = touching.count > described.count ? ", and \(touching.count - described.count) more" : ""
        return described.joined(separator: "; ") + more
    }

    private func refreshAccessibility() {
        guard interactive else { accessibilityElements = nil; return }
        let positions = points()
        let names = Dictionary(nodes.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        var linksByID: [String: [GraphLink]] = [:]
        for link in links {
            linksByID[link.a, default: []].append(link)
            if link.b != link.a { linksByID[link.b, default: []].append(link) }
        }
        accessibilityElements = nodes.compactMap { node -> UIAccessibilityElement? in
            guard let position = positions[node.id] else { return nil }
            let point = viewport.screen(position, size: bounds.size)
            guard bounds.contains(point) else { return nil }
            let element = GraphAccessibleNode(accessibilityContainer: self)
            element.accessibilityLabel = node.label
            element.accessibilityValue = "\(node.kind.sentenceCaseIdentifier). \(connectionSummary(for: node.id, names: names, linksByID: linksByID))"
            element.accessibilityHint = "Select to see its connections"
            element.accessibilityTraits = node.id == selectedID ? [.button, .selected] : [.button]
            element.accessibilityFrameInContainerSpace = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
            element.activate = { [weak self] in self?.onSelect?(node.id) }
            return element
        }
    }
}

private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                  blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

/// CADisplayLink retains its target; this keeps it from retaining the view.
private final class FrameTarget {
    weak var view: RelationshipGraphCanvasView?
    init(_ view: RelationshipGraphCanvasView) { self.view = view }
    @objc func tick(_ link: CADisplayLink) {
        guard let view else { link.invalidate(); return }
        view.tick(link)
    }
}

private final class GraphAccessibleNode: UIAccessibilityElement {
    var activate: (() -> Void)?
    override func accessibilityActivate() -> Bool { activate?(); return true }
}
