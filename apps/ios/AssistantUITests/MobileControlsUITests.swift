import XCTest

/// Contract: NATIVE-XCUI-SEAM-PLAN-001/CONTRACT.v2.1.json, SHA fc972018d21107f15a398fd3d83b5e6a04b33186d74d690ebd98f6f20e6f728e.
/// Synthetic component-host capability only; no production account or VoiceOver claim.
@MainActor
final class MobileControlsUITests: XCTestCase {
    private enum CapabilityFailure: Error { case assertion, budget }
    private var deadline = ContinuousClock.now
    private var caseBudgetSeconds = 60
    private var attachmentCount = 0
    private var retainedPNGBytes = 0
    private var surfaceSwipes: [String: Int] = [:]
    private let maximumPNGBytes = 32 * 1024 * 1024
    private let sourceFact = "The phone calendar was not checked. These synthetic facts are not evidence of live calendar coverage."
    private let actionSummary = "Read both original listings before deciding."

    func testNativeControlsCapability() throws {
        continueAfterFailure = true
        executionTimeAllowance = 60
        caseBudgetSeconds = 60
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

    func testApprovalsLandscapeAccessibility5Light() throws {
        beginExtendedCase()
        let app = XCUIApplication()
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try launch(app, fixture: "approvals", theme: "light", textSize: "accessibility5", orientation: .landscapeLeft)
        try assertLandscapeAccessibilityApprovalLayout(app)
    }

    func testApprovalsLandscapeAccessibility5Dark() throws {
        beginExtendedCase()
        let app = XCUIApplication()
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try launch(app, fixture: "approvals", theme: "dark", textSize: "accessibility5", orientation: .landscapeLeft)
        try assertLandscapeAccessibilityApprovalLayout(app)
    }

    func testProactivePortraitDefaultDarkDetails() throws {
        beginExtendedCase()
        let app = XCUIApplication()
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try launch(app, fixture: "proactive", theme: "dark", textSize: "default", orientation: .portrait)
        let proactiveSurface = app.descendants(matching: .any)
            .matching(identifier: "fixture.surface.proactive").firstMatch
        try require(proactiveSurface.waitForExistence(timeout: waitBudget()), "Proactive surface unavailable", app)
        let disclosureQuery = proactiveSurface.buttons.matching(NSPredicate(format: "label == %@", "Details"))
        let details = disclosureQuery.firstMatch
        try require(details.waitForExistence(timeout: waitBudget()), "Details absent from native automation tree", app)
        try require(disclosureQuery.count == 1, "Details must identify exactly one real button", app)
        let facts = proactiveSurface.staticTexts.matching(NSPredicate(format: "label == %@", sourceFact))
        let summaries = proactiveSurface.staticTexts.matching(NSPredicate(format: "label == %@", actionSummary))
        try capture(app, "dark-proactive-collapsed-before-assertions")
        try require(facts.count == 0 && summaries.count == 0, "Expanded-only source facts and summary must start absent", app)
        try revealTogether([details], surface: proactiveSurface, app: app)
        try require(details.frame.height >= 44 && details.isHittable && app.frame.contains(details.frame),
                    "Details must expose a visible 44pt native frame and be hittable", app)
        details.tap()
        try require(facts.firstMatch.waitForExistence(timeout: waitBudget()), "Details tap must reveal the exact source qualification", app)
        try require(summaries.firstMatch.waitForExistence(timeout: waitBudget()), "Details tap must reveal the exact action summary", app)
        try require(facts.count == 1 && summaries.count == 1, "Expanded facts and action summary must each appear once", app)
        try revealTogether([facts.firstMatch, summaries.firstMatch], surface: proactiveSurface, app: app)
        try capture(app, "dark-proactive-expanded-visible-source-and-summary")
        try revealTogether([details], surface: proactiveSurface, app: app, upwards: false)
        details.tap()
        let collapsed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            facts.count == 0 && summaries.count == 0
        }, object: nil)
        try require(XCTWaiter.wait(for: [collapsed], timeout: waitBudget()) == .completed,
                    "Second Details tap must remove expanded-only source facts and summary", app)
        try capture(app, "dark-proactive-after-collapse")
        try assertTransport(app)
    }

    private func beginExtendedCase() {
        continueAfterFailure = true
        caseBudgetSeconds = 90
        executionTimeAllowance = 90
        deadline = ContinuousClock.now.advanced(by: .seconds(caseBudgetSeconds))
        attachmentCount = 0
        retainedPNGBytes = 0
        surfaceSwipes = [:]
    }

    private func assertLandscapeAccessibilityApprovalLayout(_ app: XCUIApplication) throws {
        let approvalSurface = app.descendants(matching: .any)
            .matching(identifier: "fixture.surface.approvals").firstMatch
        try require(approvalSurface.waitForExistence(timeout: waitBudget()), "Approval surface unavailable", app)
        let approveQuery = approvalSurface.buttons.matching(identifier: "assistant.approvals.approval.approved")
        let denyQuery = approvalSurface.buttons.matching(identifier: "assistant.approvals.approval.denied")
        let moreQuery = approvalSurface.buttons.matching(NSPredicate(format: "label == %@", "More"))
        let approve = approveQuery.firstMatch
        let deny = denyQuery.firstMatch
        let more = moreQuery.firstMatch
        let requestedQuery = approvalSurface.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Requested ")
        )
        let requested = requestedQuery.firstMatch
        try require(approve.waitForExistence(timeout: waitBudget()), "Approve absent from native automation tree", app)
        try require(deny.waitForExistence(timeout: waitBudget()), "Deny absent from native automation tree", app)
        try require(more.waitForExistence(timeout: waitBudget()), "More absent from native automation tree", app)
        try require(requested.waitForExistence(timeout: waitBudget()), "Last approval detail text absent from native tree", app)
        try require(approveQuery.count == 1 && denyQuery.count == 1 && moreQuery.count == 1 && requestedQuery.count == 1,
                    "Approval actions and last detail text must each be unique", app)

        // The metadata tail and Approve must be measured together. This fails if
        // landscape puts actions in the old side column beside approval details.
        try revealTogether([requested, approve], surface: approvalSurface, app: app)
        try capture(app, "landscape-ax5-requested-and-approve-same-viewport")
        try require(requested.elementType == .staticText && approve.elementType == .button,
                    "Requested detail and Approve must retain their native element roles", app)
        try require(requested.isHittable && approve.isHittable && app.frame.contains(requested.frame) && app.frame.contains(approve.frame),
                    "Requested detail and Approve must share a visible viewport", app)
        try require(approve.frame.minY >= requested.frame.maxY,
                    "Landscape AX5 approval actions must begin below the final details text", app)

        try require(approve.elementType == .button && approve.frame.height >= 44,
                    "Approve must be a native button at least 44pt high", app)

        try revealTogether([approve, deny], surface: approvalSurface, app: app)
        try capture(app, "landscape-ax5-approve-deny-same-viewport")
        try require(approve.elementType == .button && deny.elementType == .button &&
                    approve.frame.height >= 44 && deny.frame.height >= 44,
                    "Approve and Deny must be native buttons at least 44pt high", app)
        try require(approve.isHittable && deny.isHittable && app.frame.contains(approve.frame) && app.frame.contains(deny.frame),
                    "Approve and Deny must share a visible viewport", app)
        try require(approve.frame.minY < deny.frame.minY && approve.frame.maxY <= deny.frame.minY + 1,
                    "Approve must precede Deny vertically", app)

        try revealTogether([deny, more], surface: approvalSurface, app: app)
        try capture(app, "landscape-ax5-deny-more-same-viewport")
        try require(deny.elementType == .button && more.elementType == .button &&
                    deny.frame.height >= 44 && more.frame.height >= 44,
                    "Deny and More must be native buttons at least 44pt high", app)
        try require(deny.isHittable && more.isHittable && app.frame.contains(deny.frame) && app.frame.contains(more.frame),
                    "Deny and More must share a visible viewport", app)
        try require(deny.frame.minY < more.frame.minY && deny.frame.maxY <= more.frame.minY + 1,
                    "Deny must precede More vertically", app)
        try assertTransport(app)
        try checkBudget()
    }

    private func launch(_ app: XCUIApplication, fixture: String, theme: String = "light",
                        textSize: String = "default", orientation: UIDeviceOrientation = .portrait) throws {
        try checkBudget()
        XCUIDevice.shared.orientation = orientation
        let expectedOrientation = orientation.isLandscape ? "landscape" : "portrait"
        app.launchArguments = ["--fixture-case", fixture, "--fixture-theme", theme,
                               "--fixture-text-size", textSize, "--fixture-orientation", expectedOrientation,
                               "--fixture-nonce", UUID().uuidString]
        app.launch()
        try capture(app, "\(fixture)-launch-before-ready-assertion")
        let ready = app.staticTexts["fixture.ready"]
        try require(ready.waitForExistence(timeout: waitBudget()) && ready.label == "ready",
                    "Synthetic fixture failed to become ready", app)
        try require(!app.descendants(matching: .any).matching(identifier: "fixture.error").firstMatch.exists,
                    "Host reported fixture.error", app)
        let vertical = expectedOrientation == "landscape" ? "compact" : "regular"
        let expectedEnvironment = "theme=\(theme);size=\(textSize);vertical=\(vertical);requestedOrientation=\(expectedOrientation);windowOrientation=\(expectedOrientation)"
        let environment = app.staticTexts["fixture.host.environment"]
        try require(environment.waitForExistence(timeout: waitBudget()), "Fixture host environment report unavailable", app)
        let environmentExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", expectedEnvironment), object: environment
        )
        try require(XCTWaiter.wait(for: [environmentExpectation], timeout: waitBudget()) == .completed,
                    "Observed SwiftUI environment and UIKit window orientation must match requested fixture parameters", app)
        if expectedOrientation == "landscape" {
            try require(app.frame.width > app.frame.height, "Native app frame must be landscape", app)
        } else {
            try require(app.frame.height > app.frame.width, "Native app frame must be portrait", app)
        }
        try assertTransport(app)
    }

    private func assertTransport(_ app: XCUIApplication) throws {
        let violations = app.staticTexts["fixture.transport.violations"]
        try require(violations.exists && violations.label == "0", "Fixture transport must have zero unknown or mutation requests", app)
    }

    private func revealTogether(_ elements: [XCUIElement], surface: XCUIElement,
                                app: XCUIApplication, upwards: Bool = true) throws {
        let key = surface.identifier
        while true {
            try checkBudget()
            if elements.allSatisfy({ $0.exists && $0.isHittable && app.frame.contains($0.frame) }) { return }
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
            XCTFail("Native capability exceeded its \(caseBudgetSeconds)-second monotonic budget")
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
        guard attachmentCount + 2 <= 24 else {
            XCTFail("Native capability attachment count exceeded 24")
            throw CapabilityFailure.budget
        }
        let png = app.screenshot().pngRepresentation
        guard png.count <= maximumPNGBytes - retainedPNGBytes else {
            XCTFail("Native capability PNG bytes exceeded 32MiB")
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
