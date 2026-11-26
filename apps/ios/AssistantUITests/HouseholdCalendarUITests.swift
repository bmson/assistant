import XCTest

@MainActor
final class HouseholdCalendarUITests: XCTestCase {
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
}
