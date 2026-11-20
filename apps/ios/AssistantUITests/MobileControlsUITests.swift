import XCTest
import UIKit

/// Native controls qualification v3: capability plus bounded accessibility matrix.
/// Synthetic component-host capability only; no production account or VoiceOver claim.
@MainActor
final class MobileControlsUITests: XCTestCase {
    private enum CapabilityFailure: Error { case assertion, budget }
    private var deadline = ContinuousClock.now
    private var attachmentCount = 0
    private var retainedPNGBytes = 0
    private var surfaceSwipes: [String: Int] = [:]
    private let maximumPNGBytes = 64 * 1024 * 1024
    private let sourceFact = "The phone calendar was not checked. These synthetic facts are not evidence of live calendar coverage."
    private let actionSummary = "Read both original listings before deciding."

    func testNativeControlsCapability() throws {
        continueAfterFailure = true
        executionTimeAllowance = 60
        deadline = ContinuousClock.now.advanced(by: .seconds(60))
        attachmentCount = 0
        retainedPNGBytes = 0
        surfaceSwipes = [:]
        let app = XCUIApplication()
        defer { app.terminate() }

        try launch(app, fixture: "approvals")
        let approvalSurface = app.descendants(matching: .any)
            .matching(identifier: "fixture.surface.approvals").firstMatch
        try require(approvalSurface.waitForExistence(timeout: waitBudget()), "Approval surface unavailable", app)
        let approveQuery = approvalSurface.buttons.matching(identifier: "assistant.approvals.approval.approved")
        let denyQuery = approvalSurface.buttons.matching(identifier: "assistant.approvals.approval.denied")
        let moreQuery = approvalSurface.buttons.matching(NSPredicate(format: "label == %@", "More"))
        let approve = approveQuery.firstMatch
        let deny = denyQuery.firstMatch
        let more = moreQuery.firstMatch
        try require(approve.waitForExistence(timeout: waitBudget()), "Approve absent from native automation tree", app)
        try require(deny.waitForExistence(timeout: waitBudget()), "Deny absent from native automation tree", app)
        try require(more.waitForExistence(timeout: waitBudget()), "More absent from native automation tree", app)
        try require(approveQuery.count == 1 && denyQuery.count == 1 && moreQuery.count == 1,
                    "Approval action identities must be unique", app)
        // Compare frames only while all actions share this same viewport.
        try revealTogether([approve, deny, more], surface: approvalSurface, app: app)
        try capture(app, "approval-actions-before-assertions")
        for action in [approve, deny, more] {
            let frame = action.frame
            let hittable = action.isHittable
            try require(action.elementType == .button && meetsMinimumTargetHeight(frame),
                        "Native action must be a 44pt button: \(targetMeasurement(action, frame: frame, hittable: hittable))", app)
            try require(hittable && app.frame.intersects(frame),
                        "Every approval action must be visible and hittable", app)
        }
        try require(precedes(approve.frame, deny.frame) && precedes(deny.frame, more.frame),
                    "Default flow layout must preserve Approve, Deny, More visual order in one viewport", app)
        try require(approve.label == "Approve", "Approve must begin unarmed", app)
        approve.tap() // Exactly one tap: arm the real confirmation control, never submit.
        let armed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Approve?"), object: approve)
        try require(XCTWaiter.wait(for: [armed], timeout: waitBudget()) == .completed,
                    "One tap must arm Approve? without confirming", app)
        try capture(app, "approval-after-one-arm-tap")
        try assertTransport(app)
        let registrations = app.staticTexts["fixture.notifications.registrations"]
        try require(registrations.exists && registrations.label == "1",
                    "Fixture must capture exactly one injected notification registrar call", app)

        // Proactive disclosure assertions run in every matrix configuration
        // below; keeping this method to one cold launch preserves its 60s cap.
        try checkBudget()
    }

    /// Real simulator orientations and XCUI automation replace in-process
    /// UIView accessibility enumeration. No production account or writes.
    func testAccessibleControlsMatrix() throws {
        continueAfterFailure = false
        executionTimeAllowance = 900
        deadline = ContinuousClock.now.advanced(by: .seconds(900))
        attachmentCount = 0
        retainedPNGBytes = 0
        let app = XCUIApplication()
        defer { app.terminate(); XCUIDevice.shared.orientation = .portrait }
        let layouts: [(String, UIDeviceOrientation, String)] = [
            ("portrait-default", .portrait, "default"),
            ("portrait-AX5", .portrait, "AX5"),
            ("landscape-default", .landscapeLeft, "default"),
            ("landscape-AX1", .landscapeLeft, "AX1"),
            ("landscape-AX5", .landscapeLeft, "AX5"),
        ]
        for theme in ["light", "dark"] {
            for (layout, orientation, textSize) in layouts {
                for fixture in ["approvals", "proactive"] {
                    try checkBudget()
                    app.terminate()
                    surfaceSwipes = [:]
                    XCUIDevice.shared.orientation = orientation
                    try launch(app, fixture: fixture, theme: theme, textSize: textSize)
                    let key = "\(fixture)-\(layout)-\(theme)"
                    let surface = app.descendants(matching: .any)
                        .matching(identifier: "fixture.surface.\(fixture)").firstMatch
                    try require(surface.waitForExistence(timeout: waitBudget()), "Missing native surface: \(key)", app)
                    let landscape = orientation == .landscapeLeft
                    try require(landscape ? app.frame.width > app.frame.height : app.frame.height > app.frame.width,
                                "Native orientation did not settle: \(key)", app)
                    if !landscape && textSize == "AX5" {
                        try require(surface.frame.width <= 320, "Narrow AX5 fixture must remain 320pt wide: \(key)", app)
                    }
                    if fixture == "approvals" {
                        let actions = [surface.buttons["assistant.approvals.approval.approved"],
                                       surface.buttons["assistant.approvals.approval.denied"],
                                       surface.buttons.matching(NSPredicate(format: "label == %@", "More")).firstMatch]
                        for action in actions {
                            try require(action.waitForExistence(timeout: waitBudget()), "Approval action missing: \(key)", app)
                        }
                        // All native frames share a common viewport before any scroll.
                        // Offscreen frames preserve their common content origin.
                        let frames = actions.map(\.frame)
                        if textSize != "default" {
                            try require(frames[0].maxY <= frames[1].minY + 1 && frames[1].maxY <= frames[2].minY + 1,
                                        "Accessibility actions must stack Approve, Deny, More: \(key)", app)
                        } else {
                            try require(precedes(frames[0], frames[1]) && precedes(frames[1], frames[2]),
                                        "Actions must preserve visual order: \(key)", app)
                        }
                        for action in actions {
                            try revealTogether([action], surface: surface, app: app)
                            let frame = action.frame
                            let hittable = action.isHittable
                            try require(meetsMinimumTargetHeight(frame) && hittable,
                                        "Hittable 44pt target \(key): \(targetMeasurement(action, frame: frame, hittable: hittable))", app)
                        }
                        try capture(app, key + "-last-action-reached")
                        let geometry = XCTAttachment(string: frames.map { String(describing: $0) }.joined(separator: "\n"))
                        geometry.name = key + "-same-snapshot-action-frames"
                        geometry.lifetime = .keepAlways
                        add(geometry)
                    } else {
                        let details = surface.buttons.matching(NSPredicate(format: "label == %@", "Details")).firstMatch
                        let facts = surface.staticTexts.matching(NSPredicate(format: "label == %@", sourceFact))
                        let summaries = surface.staticTexts.matching(NSPredicate(format: "label == %@", actionSummary))
                        try require(details.waitForExistence(timeout: waitBudget()), "Details missing: \(key)", app)
                        try require(facts.count == 0 && summaries.count == 0, "Details must begin collapsed: \(key)", app)
                        try revealTogether([details], surface: surface, app: app)
                        let detailFrame = details.frame
                        let detailHittable = details.isHittable
                        try require(meetsMinimumTargetHeight(detailFrame) && detailHittable,
                                    "44pt Details \(key): \(targetMeasurement(details, frame: detailFrame, hittable: detailHittable))", app)
                        details.tap()
                        try require(facts.firstMatch.waitForExistence(timeout: waitBudget()) && facts.count == 1 && summaries.count == 1,
                                    "Expansion must show exact fact and summary once: \(key)", app)
                        if textSize == "default" {
                            try revealTogether([facts.firstMatch, summaries.firstMatch], surface: surface, app: app)
                        } else {
                            try revealTogether([facts.firstMatch], surface: surface, app: app, fullyVisible: false)
                        }
                        try capture(app, key + "-expanded-source")
                        try revealTogether([details], surface: surface, app: app)
                        details.tap()
                        let collapsed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                            facts.count == 0 && summaries.count == 0
                        }, object: nil)
                        try require(XCTWaiter.wait(for: [collapsed], timeout: waitBudget()) == .completed,
                                    "Second tap must collapse exact source facts: \(key)", app)
                        try capture(app, key + "-collapsed-source")
                    }
                    try assertTransport(app)
                }
            }
        }
    }

    func testHouseholdCalendarChoicesReopenAndPreview() throws {
        continueAfterFailure = false
        executionTimeAllowance = 90
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = ["--fixture-case", "household-calendar", "--fixture-theme", "light",
                               "--fixture-text-size", "default", "--fixture-nonce", UUID().uuidString]
        app.launch()
        XCTAssertTrue(app.staticTexts["fixture.ready"].waitForExistence(timeout: 8))
        let household = app.buttons["Household calendar"]
        if !household.isHittable { app.swipeUp() }
        XCTAssertTrue(household.waitForExistence(timeout: 5))
        household.tap()
        let remaining = app.staticTexts["household-calendar-remaining"]
        func expectCount(_ label: String) {
            let predicate = NSPredicate(format: "exists == true AND label == %@", label)
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: remaining)], timeout: 5), .completed)
        }
        func reveal(_ element: XCUIElement, scrollingUp: Bool = true) {
            for _ in 0..<5 where !element.isHittable {
                if scrollingUp { app.swipeUp() } else { app.swipeDown() }
            }
            XCTAssertTrue(element.waitForExistence(timeout: 5))
            XCTAssertTrue(element.isHittable)
        }
        func choose(_ source: String, _ label: String) {
            let picker = app.descendants(matching: .any)["household-calendar-source-" + source].firstMatch
            reveal(picker)
            picker.tap()
            let option = app.buttons[label].firstMatch
            XCTAssertTrue(option.waitForExistence(timeout: 5))
            option.tap()
        }
        let save = app.buttons["Save choices"]
        let preview = app.buttons["Preview today"]
        let extended = [
            (id: "school", label: "School", title: "Science fair"),
            (id: "activity", label: "Activity", title: "Practice"),
            (id: "holidays", label: "Holidays", title: "Local holiday")
        ]
        func previewEvents(showExtended: Bool) {
            reveal(preview)
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: preview)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
            preview.tap()
            reveal(app.staticTexts["Family appointment"])
            if showExtended {
                for source in extended { reveal(app.staticTexts[source.title]) }
            }
            reveal(app.staticTexts["Busy"])
            if !showExtended {
                for source in extended { XCTAssertFalse(app.staticTexts[source.title].exists) }
            }
            XCTAssertFalse(app.staticTexts["Private work title"].exists)
        }

        expectCount("6 calendars still need a choice")
        choose("family", "Household")
        choose("work", "Work · Free/busy only")
        choose("other", "Ignore")
        reveal(save)
        save.tap()
        reveal(remaining, scrollingUp: false)
        expectCount("3 calendars still need a choice")
        previewEvents(showExtended: false)

        reveal(remaining, scrollingUp: false)
        for source in extended { choose(source.id, source.label) }
        reveal(save)
        save.tap()
        reveal(remaining, scrollingUp: false)
        expectCount("All calendars classified")
        app.navigationBars["Household calendar"].buttons.firstMatch.tap()
        reveal(household)
        household.tap()
        expectCount("All calendars classified")
        previewEvents(showExtended: true)

        reveal(remaining, scrollingUp: false)
        for source in extended { choose(source.id, "Ignore") }
        reveal(save)
        save.tap()
        previewEvents(showExtended: false)
        XCTAssertEqual(app.staticTexts["fixture.transport.violations"].label, "0")
    }

    private func launch(_ app: XCUIApplication, fixture: String, theme: String = "light", textSize: String = "default") throws {
        try checkBudget()
        app.launchArguments = ["--fixture-case", fixture, "--fixture-theme", theme,
                               "--fixture-text-size", textSize, "--fixture-nonce", UUID().uuidString]
        app.launch()
        try capture(app, "\(fixture)-launch-before-ready-assertion")
        let ready = app.staticTexts["fixture.ready"]
        try require(ready.waitForExistence(timeout: waitBudget()) && ready.label == "ready",
                    "Synthetic fixture failed to become ready", app)
        try require(!app.descendants(matching: .any).matching(identifier: "fixture.error").firstMatch.exists,
                    "Host reported fixture.error", app)
        try assertTransport(app)
    }

    private func assertTransport(_ app: XCUIApplication) throws {
        let violations = app.staticTexts["fixture.transport.violations"]
        try require(violations.exists && violations.label == "0", "Fixture transport must have zero unknown or mutation requests", app)
    }

    private func revealTogether(_ elements: [XCUIElement], surface: XCUIElement,
                                app: XCUIApplication, fullyVisible: Bool = true) throws {
        let key = surface.identifier
        let nestedScroll = surface.descendants(matching: .scrollView).firstMatch
        let scrolling = surface.elementType == .scrollView ? surface : (nestedScroll.exists ? nestedScroll : surface)
        var previousTarget: (identifier: String, minY: CGFloat)?
        var stalledGestures = 0
        while true {
            try checkBudget()
            let viewport = scrolling.frame.intersection(app.frame)
            guard !viewport.isNull, viewport.width > 0, viewport.height > 24 else { break }
            func visible(_ element: XCUIElement) -> Bool {
                guard element.exists else { return false }
                let frame = element.frame
                return element.isHittable && (fullyVisible ? viewport.contains(frame) : viewport.intersects(frame))
            }
            guard let target = elements.first(where: { !visible($0) }) else { return }
            guard target.exists, surfaceSwipes[key, default: 0] < 24 else { break }
            let frame = target.frame
            guard frame.minY.isFinite, frame.maxY.isFinite else { break }
            let targetIdentity = target.identifier + "|" + target.label
            if let previousTarget, previousTarget.identifier == targetIdentity,
               abs(frame.minY - previousTarget.minY) < 2 {
                stalledGestures += 1
            } else {
                stalledGestures = 0
            }
            guard stalledGestures < 3 else { break }
            previousTarget = (targetIdentity, frame.minY)
            let displacement = scrollDisplacement(target: frame, viewport: viewport, fullyVisible: fullyVisible)
            let upward = displacement > 0
            let startY = upward ? viewport.maxY - 12 : viewport.minY + 12
            let distance = min(abs(displacement), viewport.height - 24)
            let endY = startY + (upward ? -distance : distance)
            let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let start = origin.withOffset(CGVector(dx: viewport.midX - app.frame.minX, dy: startY - app.frame.minY))
            let end = origin.withOffset(CGVector(dx: viewport.midX - app.frame.minX, dy: endY - app.frame.minY))
            surfaceSwipes[key, default: 0] += 1
            print("NATIVE_SCROLL surface=\(key) gesture=\(surfaceSwipes[key, default: 0]) target=\(frame) viewport=\(viewport) displacement=\(displacement)")
            // A bounded controlled drag avoids fling overshoot. Re-evaluate the
            // target after every gesture, including when a return overshoots it.
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
        }
        try require(false, "Could not expose required native elements within 24 total controlled drags with measurable progress for this surface", app)
    }

    private func scrollDisplacement(target: CGRect, viewport: CGRect, fullyVisible: Bool) -> CGFloat {
        let desired: CGFloat
        if !fullyVisible || target.height > viewport.height {
            desired = target.midY - viewport.midY
        } else if target.minY < viewport.minY + 24 {
            desired = target.minY - (viewport.minY + 24)
        } else if target.maxY > viewport.maxY - 24 {
            desired = target.maxY - (viewport.maxY - 24)
        } else {
            desired = target.midY - viewport.midY
        }
        // Native scroll recognition consumes about 10pt before content moves.
        // Compensate within the same bounded gesture, leaving a 24pt inset
        // for precise alignment. Distant targets use a longer traversal so
        // long AX5 journeys stay within the bounded traversal budget.
        let distance = max(24, min(abs(desired) + 12, viewport.height * 0.85))
        return desired < 0 ? -distance : distance
    }

    /// Coordinate conversion can subtract fractional screen origins from each
    /// other, returning 44.nextDown for a 44pt frame. Allow only eight ULPs of
    /// those coordinates, never a pixel-sized or point-sized target deficit.
    private func meetsMinimumTargetHeight(_ frame: CGRect) -> Bool {
        guard frame.minY.isFinite, frame.maxY.isFinite, frame.height.isFinite else { return false }
        let tolerance = 8 * max(44, max(abs(frame.minY), abs(frame.maxY))).ulp
        return frame.height + tolerance >= 44
    }

    private func targetMeasurement(_ element: XCUIElement, frame: CGRect, hittable: Bool) -> String {
        "label=\(element.label), type=\(element.elementType.rawValue), height=\(String(format: "%.17g", Double(frame.height))), minY=\(String(format: "%.17g", Double(frame.minY))), maxY=\(String(format: "%.17g", Double(frame.maxY))), hittable=\(hittable)"
    }

    /// Row-major order for the default flow layout, using same-viewport native frames.
    private func precedes(_ first: CGRect, _ second: CGRect) -> Bool {
        if abs(first.midY - second.midY) <= min(first.height, second.height) / 2 {
            return first.maxX <= second.minX + 1
        }
        return first.maxY <= second.minY + 1
    }

    private func waitBudget() throws -> TimeInterval {
        try checkBudget()
        let remaining = ContinuousClock.now.duration(to: deadline)
        let components = remaining.components
        return min(3, Double(components.seconds) + Double(components.attoseconds) / 1e18)
    }

    private func checkBudget() throws {
        guard ContinuousClock.now < deadline else {
            XCTFail("Native capability exceeded its monotonic budget")
            throw CapabilityFailure.budget
        }
    }

    private func require(_ condition: Bool, _ message: String, _ app: XCUIApplication,
                         file: StaticString = #filePath, line: UInt = #line) throws {
        guard condition else {
            try capture(app, "failure-before-assertion")
            XCTFail(message, file: file, line: line)
            throw CapabilityFailure.assertion
        }
    }

    private func capture(_ app: XCUIApplication, _ name: String) throws {
        try checkBudget()
        guard attachmentCount + 2 <= 160 else {
            XCTFail("Native capability attachment count exceeded 160")
            throw CapabilityFailure.budget
        }
        let png = XCUIScreen.main.screenshot().pngRepresentation
        guard png.count <= maximumPNGBytes - retainedPNGBytes else {
            XCTFail("Native capability PNG bytes exceeded 64MiB")
            throw CapabilityFailure.budget
        }
        retainedPNGBytes += png.count
        let image = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: String(app.debugDescription.prefix(32_768)))
        tree.name = name + "-native-tree"
        tree.lifetime = .keepAlways
        add(tree)
        attachmentCount += 2
        try checkBudget()
    }
}
