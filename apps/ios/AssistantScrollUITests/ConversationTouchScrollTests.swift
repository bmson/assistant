import XCTest

/// First smoke only: public touch input against the real production ChatView.
/// Metric presence/values must additionally be audited in xcresult by the runner.
@MainActor
final class ConversationTouchScrollTests: XCTestCase {
    func testOneDragAndDeceleration() throws {
        continueAfterFailure = false
        guard #available(iOS 26.0, *) else { throw XCTSkip("XCTHitchMetric requires iOS 26") }
        let app = XCUIApplication()
        defer { app.terminate() }
        let options = XCTMeasureOptions()
        // XCTest also performs one discarded warm-up. Each iteration relaunches.
        options.iterationCount = 1
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTHitchMetric(application: app),
                          XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
            app.terminate()
            app.launchArguments = ["--assistant-scroll-fixture"]
            app.launch()
            let probe = app.staticTexts["assistant.scroll-fixture.diagnostics"]
            guard probe.waitForExistence(timeout: 12) else {
                XCTFail("Fixture diagnostics did not mount")
                return
            }
            guard let before = waitForSnapshot(probe, timeout: 12, accepting: { receipt in
                receipt.bool("settled") && receipt.number("fixtureRows") == 500
                    && receipt.number("viewport") > 100
                    && receipt.number("bottom") > receipt.number("viewport") * 2
                    && abs(receipt.number("bottom") - receipt.number("offset")) <= 3
            }) else { return }
            let transcript = app.scrollViews["assistant.scroll-fixture.transcript"]
            guard transcript.exists, transcript.frame.height > 100 else {
                XCTFail("Actual transcript viewport is unavailable")
                return
            }
            // Starting at the newest edge, drag DOWN to reveal older rows.
            // Use the gutter to avoid link/copy actions in the mixed payload.
            let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25))
            let end = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.75))
            startMeasuring()
            start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
            let after = waitForSnapshot(probe, timeout: 8, accepting: { receipt in
                receipt.bool("completed") && receipt.bool("settled")
            })
            stopMeasuring()
            guard let after else { return }
            XCTAssertEqual(before.string("launchID"), after.string("launchID"))
            XCTAssertEqual(after.number("fixtureRows"), 500)
            XCTAssertTrue(after.bool("interacted"), "No public touch interaction observed")
            XCTAssertTrue(after.bool("decelerated"), "Fling did not exercise deceleration")
            XCTAssertGreaterThan(after.number("gestureEnd"), after.number("gestureStart"), "Incomplete interval")
            XCTAssertGreaterThan(before.number("offset") - after.number("offset"), 80, "No meaningful movement toward older messages")
            XCTAssertEqual(before.number("content"), after.number("content"), accuracy: 3, "Content changed during quiet smoke")
            attach(before: before, after: after)
        }
    }

    private func waitForSnapshot(_ probe: XCUIElement, timeout: TimeInterval,
                                 accepting: @escaping (Receipt) -> Bool) -> Receipt? {
        var latest: Receipt?
        let predicate = NSPredicate { _, _ in
            guard let raw = probe.value as? String,
                  let data = raw.data(using: .utf8),
                  let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            let receipt = Receipt(values: dictionary)
            latest = receipt
            // Surface a fixture fault immediately rather than timing out as smooth.
            return !receipt.string("failure").isEmpty || accepting(receipt)
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout)
        guard result == .completed, let receipt = latest else {
            XCTFail("Fixture did not reach required anchor/complete interval: \(latest?.values.description ?? "no receipt")")
            return nil
        }
        guard receipt.string("failure").isEmpty else {
            XCTFail(receipt.string("failure"))
            return nil
        }
        return receipt
    }

    private func attach(before: Receipt, after: Receipt) {
        let payload: [String: Any] = [
            "mode": "public-touch-one-fling-smoke",
            "before": before.values, "after": after.values,
            "metricSamplesRequireXCResultAudit": true,
            "physical60fpsProven": false,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .prettyPrinted]) else {
            XCTFail("Could not encode smoke receipt")
            return
        }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "touch-scroll-smoke-receipt.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private struct Receipt {
        let values: [String: Any]
        func bool(_ key: String) -> Bool { values[key] as? Bool ?? false }
        func number(_ key: String) -> Double { (values[key] as? NSNumber)?.doubleValue ?? -1 }
        func string(_ key: String) -> String { values[key] as? String ?? "" }
    }
}
