import XCTest
import UIKit

/// Contract: NATIVE-XCUI-SEAM-PLAN-001/CONTRACT.v2.1.json, SHA fc972018d21107f15a398fd3d83b5e6a04b33186d74d690ebd98f6f20e6f728e.
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
            try require(action.elementType == .button && action.frame.height >= 44,
                        "Native action must be a button with an accessibility frame at least 44pt high", app)
            try require(action.isHittable && app.frame.intersects(action.frame),
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

        app.terminate()
        try launch(app, fixture: "proactive")
        let proactiveSurface = app.descendants(matching: .any)
            .matching(identifier: "fixture.surface.proactive").firstMatch
        try require(proactiveSurface.waitForExistence(timeout: waitBudget()), "Proactive surface unavailable", app)
        let disclosureQuery = proactiveSurface.buttons.matching(NSPredicate(format: "label == %@", "Details"))
        let details = disclosureQuery.firstMatch
        try require(details.waitForExistence(timeout: waitBudget()), "Details absent from native automation tree", app)
        try require(disclosureQuery.count == 1, "Details must identify exactly one real button", app)
        let facts = proactiveSurface.staticTexts.matching(NSPredicate(format: "label == %@", sourceFact))
        let summaries = proactiveSurface.staticTexts.matching(NSPredicate(format: "label == %@", actionSummary))
        try capture(app, "proactive-collapsed-before-assertions")
        try require(facts.count == 0 && summaries.count == 0, "Expanded-only source facts and summary must start absent", app)
        try revealTogether([details], surface: proactiveSurface, app: app)
        try require(details.frame.height >= 44 && details.isHittable,
                    "Details must expose a 44pt native frame and be hittable", app)
        details.tap()
        try require(facts.firstMatch.waitForExistence(timeout: waitBudget()), "Details tap must reveal the exact source qualification", app)
        try require(summaries.firstMatch.waitForExistence(timeout: waitBudget()), "Details tap must reveal the exact action summary", app)
        try capture(app, "proactive-expanded-before-assertions")
        try require(facts.count == 1 && summaries.count == 1, "Expanded facts and action summary must each appear once", app)
        try revealTogether([facts.firstMatch, summaries.firstMatch], surface: proactiveSurface, app: app)
        try capture(app, "proactive-expanded-visible-source-and-summary")
        try revealTogether([details], surface: proactiveSurface, app: app, upwards: false)
        details.tap()
        let collapsed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            facts.count == 0 && summaries.count == 0
        }, object: nil)
        try require(XCTWaiter.wait(for: [collapsed], timeout: waitBudget()) == .completed,
                    "Second Details tap must remove expanded-only source facts and summary", app)
        try capture(app, "proactive-after-collapse")
        try assertTransport(app)
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
                            try require(action.frame.height >= 44 && action.isHittable,
                                        "Action must expose a hittable 44pt native frame: \(key)", app)
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
                        try require(details.frame.height >= 44 && details.isHittable, "Details target below 44pt: \(key)", app)
                        details.tap()
                        try require(facts.firstMatch.waitForExistence(timeout: waitBudget()) && facts.count == 1 && summaries.count == 1,
                                    "Expansion must show exact fact and summary once: \(key)", app)
                        try revealTogether([facts.firstMatch], surface: surface, app: app, fullyVisible: false)
                        try capture(app, key + "-expanded-source")
                        try revealTogether([details], surface: surface, app: app, upwards: false)
                        details.tap()
                        let collapsed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                            facts.count == 0 && summaries.count == 0
                        }, object: nil)
                        try require(XCTWaiter.wait(for: [collapsed], timeout: waitBudget()) == .completed,
                                    "Second tap must collapse exact source facts: \(key)", app)
                    }
                    try assertTransport(app)
                }
            }
        }
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
                                app: XCUIApplication, upwards: Bool = true, fullyVisible: Bool = true) throws {
        let key = surface.identifier
        while true {
            try checkBudget()
            if elements.allSatisfy({ $0.exists && $0.isHittable && (fullyVisible ? app.frame.contains($0.frame) : app.frame.intersects($0.frame)) }) { return }
            guard surfaceSwipes[key, default: 0] < 12 else { break }
            surfaceSwipes[key, default: 0] += 1
            if upwards { surface.swipeUp() } else { surface.swipeDown() }
        }
        try require(false, "Could not expose required native elements within 12 total swipes for this surface", app)
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
        let png = app.screenshot().pngRepresentation
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
