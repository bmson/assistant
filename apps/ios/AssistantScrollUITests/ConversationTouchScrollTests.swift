import CoreFoundation
import XCTest

/// One measured public fling plus XCTest's discarded warm-up fling.
/// Metric presence/values and native-selection screenshots require runner/QA audit.
@MainActor
final class ConversationTouchScrollTests: XCTestCase {
    func testOneDragAndDeceleration() throws {
        continueAfterFailure = false
        guard #available(iOS 26.0, *) else { throw XCTSkip("XCTHitchMetric requires iOS 26") }
        let app = XCUIApplication()
        defer { app.terminate() }
        let options = XCTMeasureOptions()
        options.iterationCount = 1
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        var invocation = 0
        measure(metrics: [XCTHitchMetric(application: app),
                          XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
            invocation += 1
            let label = invocation == 1 ? "discarded-warmup" : "measured"
            app.terminate()
            app.launchArguments = ["--assistant-scroll-fixture"]
            app.launch()
            let probe = app.staticTexts["assistant.scroll-fixture.diagnostics"]
            guard probe.waitForExistence(timeout: 12) else {
                XCTFail("Fixture diagnostics did not mount")
                return
            }
            guard let before = waitForSnapshot(probe, timeout: 12, onFailure: {
                // Preserve the mounted viewport and raw AX receipt before a
                // failed initial gate returns, outside metric collection.
                let raw = probe.value as? String
                self.screenshot(app, name: "\(label)-initial-failure")
                if let raw {
                    let attachment = XCTAttachment(data: Data(raw.utf8), uniformTypeIdentifier: "public.json")
                    attachment.name = "touch-scroll-\(label)-initial-failure-receipt.json"
                    attachment.lifetime = .keepAlways
                    self.add(attachment)
                }
            }, accepting: { receipt in
                receipt.bool("ownershipReady") && receipt.bool("settled")
                    && receipt.number("fixtureRows") == 500 && receipt.number("viewport") > 100
                    && receipt.number("viewportWidth") > 100 && receipt.number("viewportFrameHeight") > 100
                    && receipt.number("bottom") > receipt.number("viewport") * 2
                    // Use the same native visible-edge contract as production,
                    // retaining the strict three-point initial-anchor gate.
                    && abs(receipt.number("bottomGap")) <= 3
            }) else { return }
            let transcript = app.scrollViews["assistant.scroll-fixture.transcript"]
            guard transcript.exists, transcript.frame.height > 100 else {
                XCTFail("Actual transcript viewport is unavailable")
                return
            }
            let beforeFrame = transcript.frame
            let beforeControls = PublicControls(app: app)
            screenshot(app, name: "\(label)-before")
            attach(before: before, after: nil, beforeFrame: beforeFrame, afterFrame: nil,
                   beforeControls: beforeControls, afterControls: nil, label: "\(label)-initial")
            XCTAssertEqual(beforeControls.jumpCount, 0, "Jump must be absent at the newest edge")
            assertPublicUI(app, transcript: transcript)
            assertOwnership(before)
            XCTAssertTrue(before.bool("readerFollowsLatest"), "Initial newest-edge anchor lost")
            XCTAssertFalse(before.bool("completed"), "Gesture already occurred before measurement")
            XCTAssertTrue(before.events.isEmpty, "Unexpected interaction before measurement")
            // Starting at the newest edge, drag DOWN in the gutter to older rows.
            let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25))
            let end = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.75))
            startMeasuring()
            start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
            let after = waitForSnapshot(probe, timeout: 8, accepting: { receipt in
                receipt.bool("completed") && receipt.bool("settled")
            })
            stopMeasuring()
            // Keep post-gesture evidence even when the completion receipt fails.
            screenshot(app, name: "\(label)-after")
            guard let after else { return }
            let afterFrame = transcript.frame
            let afterControls = PublicControls(app: app)
            // Retain geometry evidence before any post-gesture assertion can stop the test.
            attach(before: before, after: after, beforeFrame: beforeFrame, afterFrame: afterFrame,
                   beforeControls: beforeControls, afterControls: afterControls, label: label)
            assertPublicUI(app, transcript: transcript)
            assertOwnership(after)
            XCTAssertFalse(after.bool("readerFollowsLatest"), "Reader did not release newest-edge following")
            XCTAssertTrue(after.bool("positionedByUser"), "Scroll position is not owned by the reader")
            XCTAssertEqual(before.string("launchID"), after.string("launchID"))
            XCTAssertEqual(after.number("fixtureRows"), 500)
            XCTAssertEqual(after.events.map(\.phase), ["interacting", "decelerating", "idle"])
            let began = after.number("gestureStart")
            let decelerated = after.number("decelerationStart")
            let ended = after.number("gestureEnd")
            XCTAssertGreaterThan(began, before.number("capturedAt"))
            XCTAssertGreaterThan(decelerated, began)
            XCTAssertGreaterThan(ended, decelerated)
            XCTAssertLessThanOrEqual(ended, after.number("capturedAt"))
            XCTAssertEqual(after.string("phase"), "idle")
            XCTAssertGreaterThan(before.number("offset") - after.number("offset"), 80, "No meaningful movement toward older messages")
            for key in ["content", "topInset", "bottomInset", "viewportTop", "viewportLeft", "viewportWidth"] {
                XCTAssertEqual(before.number(key), after.number(key), accuracy: 1, "Geometry drift: \(key)")
            }
            for (name, first, second) in [("left", beforeFrame.minX, afterFrame.minX),
                                          ("top", beforeFrame.minY, afterFrame.minY),
                                          ("width", beforeFrame.width, afterFrame.width)] {
                XCTAssertTrue(first.isFinite && second.isFinite, "Non-finite public viewport \(name)")
                XCTAssertEqual(first, second, accuracy: 1, "Public viewport drift: \(name)")
            }
            assertFrame(beforeControls.composerFrame, equals: afterControls.composerFrame)
            XCTAssertEqual(afterControls.jumpCount, 1, "Exactly one Jump must appear after reading older rows")
            XCTAssertTrue(afterControls.jumpHittable, "Jump must be visible and hittable")
            guard let jump = afterControls.jumpFrame else { return } // Count assertion already failed.
            XCTAssertTrue([jump.minX, jump.minY, jump.width, jump.height,
                           beforeFrame.height, afterFrame.height].allSatisfy { $0.isFinite })
            XCTAssertGreaterThan(jump.width, 0)
            XCTAssertGreaterThan(jump.height, 0)
            let reservation = Double(jump.height + Self.jumpStackSpacing)
            for (name, reduction) in [
                ("scroll viewport", before.number("viewport") - after.number("viewport")),
                ("fixture frame", before.number("viewportFrameHeight") - after.number("viewportFrameHeight")),
                ("public frame", Double(beforeFrame.height - afterFrame.height)),
                ("public bottom rise", Double(beforeFrame.maxY - afterFrame.maxY)),
            ] {
                XCTAssertEqual(reduction, reservation, accuracy: 1, "Jump reservation mismatch: \(name)")
            }
            XCTAssertGreaterThanOrEqual(jump.minY, afterFrame.maxY - 1, "Jump overlaps clipped transcript")
            XCTAssertLessThanOrEqual(jump.maxY, afterControls.composerFrame.minY + 1, "Jump overlaps input")
            XCTAssertGreaterThanOrEqual(jump.minX, afterFrame.minX - 1)
            XCTAssertLessThanOrEqual(jump.maxX, afterFrame.maxX + 1)
        }
    }

    private func assertOwnership(_ receipt: Receipt) {
        XCTAssertTrue(receipt.bool("ownershipReady"))
        XCTAssertTrue(receipt.bool("menuClosed"), "Menu must remain fully closed")
        for key in ["menuOwnsSurface", "everMenuClaimed", "unexpectedOverlay", "everUnexpectedOverlay", "composerFocused", "everComposerFocused"] {
            XCTAssertFalse(receipt.bool(key), "Unexpected gesture/UI ownership: \(key)")
        }
    }

    private func assertPublicUI(_ app: XCUIApplication, transcript: XCUIElement) {
        XCTAssertTrue(transcript.exists && transcript.isHittable)
        let composer = app.textViews["assistant.chat.composer"]
        XCTAssertTrue(composer.exists && composer.isHittable)
        XCTAssertEqual(app.keyboards.count, 0, "Composer/keyboard unexpectedly activated")
        XCTAssertEqual(app.alerts.count, 0)
        XCTAssertEqual(app.sheets.count, 0)
        XCTAssertEqual(app.menus.count, 0, "Unexpected native context/selection menu")
        XCTAssertEqual(app.menuItems.count, 0, "Unexpected native context/selection actions")
        for destination in ["activity", "goals", "more"] {
            let button = app.buttons["assistant.chat.menu.\(destination)"]
            XCTAssertFalse(button.exists && button.isHittable, "Pull menu destination exposed")
        }
        // Public AX does not reliably expose selection handles/highlights in all
        // iOS versions. Mandatory screenshots need human review before acceptance.
    }

    private func assertFrame(_ before: CGRect, equals after: CGRect) {
        for (name, first, second) in [("left", before.minX, after.minX), ("top", before.minY, after.minY),
                                      ("width", before.width, after.width), ("height", before.height, after.height)] {
            XCTAssertTrue(first.isFinite && second.isFinite, "Non-finite public viewport \(name)")
            XCTAssertEqual(first, second, accuracy: 1, "Public viewport drift: \(name)")
        }
    }

    private func screenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "touch-scroll-\(name).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForSnapshot(_ probe: XCUIElement, timeout: TimeInterval,
                                 onFailure: (() -> Void)? = nil,
                                 accepting: @escaping (Receipt) -> Bool) -> Receipt? {
        var latest: Receipt?
        var invalid: String?
        let predicate = NSPredicate { _, _ in
            do {
                guard let raw = probe.value as? String, let data = raw.data(using: .utf8),
                      let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw ReceiptError.invalid("missing JSON object")
                }
                let receipt = try Receipt(values: dictionary)
                latest = receipt
                return !receipt.string("failure").isEmpty || accepting(receipt)
            } catch {
                invalid = String(describing: error)
                return true // Reject malformed fields immediately, never coerce/sentinel.
            }
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout)
        guard invalid == nil else { onFailure?(); XCTFail("Invalid fixture receipt: \(invalid!)"); return nil }
        guard result == .completed, let receipt = latest else {
            onFailure?()
            XCTFail("Required anchor/complete interval absent: \(latest?.values.description ?? "no receipt")")
            return nil
        }
        guard receipt.string("failure").isEmpty else { onFailure?(); XCTFail(receipt.string("failure")); return nil }
        return receipt
    }

    // Matches the existing composer VStack spacing, not a device-specific height.
    private static let jumpStackSpacing: CGFloat = 8

    @MainActor
    private struct PublicControls {
        let composerFrame: CGRect
        let jumpCount: Int
        let jumpHittable: Bool
        let jumpFrame: CGRect?

        init(app: XCUIApplication) {
            composerFrame = app.textViews["assistant.chat.composer"].frame
            let matches = app.buttons.matching(identifier: "assistant.chat.jump-to-latest")
            jumpCount = matches.count
            let jump = matches.firstMatch
            jumpHittable = jump.exists && jump.isHittable
            jumpFrame = jump.exists ? jump.frame : nil
        }

        var payload: [String: Any] {
            var value: [String: Any] = [
                "composerFrame": ConversationTouchScrollTests.framePayload(composerFrame),
                "jumpCount": jumpCount, "jumpHittable": jumpHittable,
            ]
            if let jumpFrame { value["jumpFrame"] = ConversationTouchScrollTests.framePayload(jumpFrame) }
            return value
        }
    }

    private static func framePayload(_ rect: CGRect) -> [String: CGFloat] {
        ["left": rect.minX, "top": rect.minY, "width": rect.width, "height": rect.height]
    }

    private func attach(before: Receipt, after: Receipt?, beforeFrame: CGRect, afterFrame: CGRect?,
                        beforeControls: PublicControls, afterControls: PublicControls?, label: String) {
        var payload: [String: Any] = [
            "mode": "public-touch-one-fling-per-invocation", "invocation": label,
            "measuredGestureCount": 1, "discardedWarmupGestureCount": 1,
            "before": before.values, "publicViewportBefore": Self.framePayload(beforeFrame),
            "publicControlsBefore": beforeControls.payload,
            "jumpStackSpacing": Self.jumpStackSpacing,
            "nativeSelectionScreenshotReviewRequired": true,
            "metricSamplesRequireXCResultAudit": true, "physical60fpsProven": false,
        ]
        if let after { payload["after"] = after.values }
        if let afterFrame { payload["publicViewportAfter"] = Self.framePayload(afterFrame) }
        if let afterControls {
            payload["publicControlsAfter"] = afterControls.payload
            if let jump = afterControls.jumpFrame {
                payload["expectedJumpReservation"] = jump.height + Self.jumpStackSpacing
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .prettyPrinted]) else {
            XCTFail("Could not encode smoke receipt")
            return
        }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "touch-scroll-\(label)-receipt.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private enum ReceiptError: Error { case invalid(String) }
    private struct Receipt {
        struct PhaseEvent { let phase: String; let uptime: Double }
        let values: [String: Any]
        private let numbers: [String: Double]
        private let bools: [String: Bool]
        private let strings: [String: String]
        let events: [PhaseEvent]

        init(values: [String: Any]) throws {
            func numeric(_ value: Any?, key: String) throws -> Double {
                guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue.isFinite else { throw ReceiptError.invalid("required finite number: \(key)") }
                return number.doubleValue
            }
            var numbers: [String: Double] = [:]
            for key in ["fixtureRows", "offset", "rawOffset", "visibleMinY", "visibleMaxY", "visibleHeight", "bottomGap", "bottom", "viewport", "content", "topInset", "bottomInset", "viewportTop", "viewportLeft", "viewportWidth", "viewportFrameHeight", "capturedAt", "maximumFramesPerSecond", "thermalState"] {
                numbers[key] = try numeric(values[key], key: key)
            }
            var bools: [String: Bool] = [:]
            func boolean(_ key: String) throws -> Bool {
                guard let value = values[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {
                    throw ReceiptError.invalid("required Boolean: \(key)")
                }
                return value.boolValue
            }
            for key in ["settled", "completed", "simulator", "ownershipReady", "everMenuClaimed", "everUnexpectedOverlay", "everComposerFocused"] {
                bools[key] = try boolean(key)
            }
            if bools["ownershipReady"] == true {
                for key in ["menuClosed", "menuOwnsSurface", "readerFollowsLatest", "positionedByUser", "unexpectedOverlay", "composerFocused"] {
                    bools[key] = try boolean(key)
                }
            }
            var strings: [String: String] = [:]
            for key in ["launchID", "failure", "phase"] {
                guard let value = values[key] as? String else { throw ReceiptError.invalid("required string: \(key)") }
                strings[key] = value
            }
            guard UUID(uuidString: strings["launchID"]!) != nil, numbers["capturedAt"]! > 0,
                  let rawEvents = values["phaseEvents"] as? [[String: Any]] else {
                throw ReceiptError.invalid("launch identity, positive capture timestamp or phase array")
            }
            let events = try rawEvents.map { event -> PhaseEvent in
                guard let phase = event["phase"] as? String else { throw ReceiptError.invalid("phase event name") }
                let uptime = try numeric(event["uptime"], key: "phase event uptime")
                guard uptime > 0 else { throw ReceiptError.invalid("nonpositive phase timestamp") }
                return PhaseEvent(phase: phase, uptime: uptime)
            }
            for key in ["gestureStart", "decelerationStart", "gestureEnd"] where values[key] != nil {
                let value = try numeric(values[key], key: key)
                guard value > 0 else { throw ReceiptError.invalid("nonpositive \(key)") }
                numbers[key] = value
            }
            if bools["completed"] == true {
                guard bools["ownershipReady"] == true, events.map(\.phase) == ["interacting", "decelerating", "idle"],
                      let start = numbers["gestureStart"], let deceleration = numbers["decelerationStart"],
                      let end = numbers["gestureEnd"], start < deceleration, deceleration < end,
                      end <= numbers["capturedAt"]!,
                      events.map(\.uptime) == [start, deceleration, end] else {
                    throw ReceiptError.invalid("missing or unordered completed gesture interval")
                }
            }
            self.values = values; self.numbers = numbers; self.bools = bools
            self.strings = strings; self.events = events
        }

        // Access only schema-validated required fields; no fallback values.
        func bool(_ key: String) -> Bool { bools[key]! }
        func number(_ key: String) -> Double { numbers[key]! }
        func string(_ key: String) -> String { strings[key]! }
    }
}
