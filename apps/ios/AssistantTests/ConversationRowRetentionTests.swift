import XCTest
import UIKit
@testable import Assistant

/// Exercises row-local presentation state through the production ChatView and
/// its UIKit-backed accessibility/input controls. These tests do not infer
/// retention from a card's initial collapsed state.
final class ConversationRowRetentionTests: XCTestCase {
    @MainActor
    func testExpandedDisclosureRowsSurviveScrollingAwayAndBack() async throws {
        let receiptID = "retention-receipt"
        let agendaID = "retention-agenda"
        let sourcesID = "retention-sources"
        let tailID = "retention-tail"
        let messages = [
            ChatMessage(id: receiptID, role: .assistant, parts: [
                .init(type: "text", text: "The request was approved."),
                .init(type: "approval", approvalId: "retention-approval", shortCode: "R-41",
                      summary: "Send Robin the confirmed arrival time", status: "approved"),
            ]),
            ChatMessage(id: agendaID, role: .assistant, parts: [
                .init(type: "text", text: "Here is the full agenda."),
                Self.agendaPart(),
            ]),
            ChatMessage(id: sourcesID, role: .assistant, parts: [
                .init(type: "text", text: "The planning event is on the calendar."),
                .init(type: "data-card", data: .object([
                    "kind": .string("calendar-event"),
                    "id": .string("retention-source-event"),
                    "title": .string("Retention source detail record"),
                    "start": .string("2026-10-24T09:30:00Z"),
                    "location": .string("Planning room"),
                ])),
            ]),
        ] + (0..<36).map { index in
            ChatMessage.optimistic(role: .assistant, text: "Transcript filler row \(index).", id: "retention-filler-\(index)")
        } + [
            ChatMessage.optimistic(role: .assistant, text: "Tail row used to evict earlier rows.", id: tailID),
        ]

        let fixture = try await ConversationPerformanceFixture.make(messages: messages)
        addTeardownBlock { await fixture.tearDown() }

        let targets = [
            DisclosureTarget(
                messageID: receiptID,
                stableLabel: "Send Robin the confirmed arrival time",
                collapsedLabel: "Send Robin the confirmed arrival time",
                expandedLabel: "Send Robin the confirmed arrival time",
                expandedEvidence: "Permission was granted for this request"
            ),
            DisclosureTarget(
                messageID: agendaID,
                stableLabel: "Showing 6 of 8",
                collapsedLabel: "Showing 6 of 8",
                expandedLabel: "Show fewer",
                expandedEvidence: "Retention agenda item 8"
            ),
            DisclosureTarget(
                messageID: sourcesID,
                stableLabel: "Sources and details",
                collapsedLabel: "Sources and details",
                expandedLabel: "Sources and details",
                expandedEvidence: "Retention source detail record"
            ),
        ]

        for target in targets {
            _ = try await fixture.seekMessage(target.messageID, anchor: target.messageID == agendaID ? .bottom : .center)
            let collapsedCandidate = await waitForDisclosure(
                target, value: "Collapsed", in: fixture.window, scrollView: fixture.scrollView
            )
            let collapsed = try XCTUnwrap(
                collapsedCandidate,
                "Production accessibility tree did not expose the collapsed \(target.stableLabel) control"
            )
            XCTAssertTrue(
                collapsed.activate(),
                "The actual VoiceOver-accessible \(target.stableLabel) control refused accessibilityActivate()"
            )
            if target.messageID == agendaID {
                // Expansion adds events below the tapped control. Bring those
                // real rows into view before requiring their visible evidence.
                _ = try await fixture.seekMessage(target.messageID, anchor: .bottom)
            }
            let didExpand = await waitUntil {
                self.visibleDisclosure(target, value: "Expanded", in: fixture.window, scrollView: fixture.scrollView) != nil
            }
            XCTAssertTrue(
                didExpand,
                "Accessibility activation did not expand \(target.stableLabel)"
            )
            XCTAssertTrue(
                Self.hasVisibleEvidence(target.expandedEvidence, in: fixture.window, scrollView: fixture.scrollView),
                "The uniquely labeled expanded content was not visible in the transcript viewport"
            )

            let ackBeforeAway = fixture.deliveryAcknowledgementAttempts(for: target.messageID)
            XCTAssertGreaterThan(ackBeforeAway, 0, "The expanded row must have crossed the production visibility acknowledgement path")
            _ = try await fixture.seekMessage(tailID, anchor: .bottom)
            XCTAssertTrue(
                Self.hasVisibleLabel("Tail row used to evict earlier rows.", in: fixture.window, scrollView: fixture.scrollView),
                "The away destination did not enter the actual transcript viewport"
            )
            let controlLeftViewport = await waitUntil {
                    self.visibleDisclosure(target, value: "Expanded", in: fixture.window, scrollView: fixture.scrollView) == nil
                        && !Self.hasVisibleEvidence(target.expandedEvidence, in: fixture.window, scrollView: fixture.scrollView)
                }
            XCTAssertTrue(
                controlLeftViewport,
                "The control remained visible while away; this run did not establish offscreen return"
            )

            let ackBeforeReturn = fixture.deliveryAcknowledgementAttempts(for: target.messageID)
            _ = try await fixture.seekMessage(target.messageID, anchor: target.messageID == agendaID ? .bottom : .center)
            let restoredCandidate = await waitForDisclosure(
                target, value: "Expanded", in: fixture.window, scrollView: fixture.scrollView
            )
            let restored = try XCTUnwrap(
                restoredCandidate,
                "The control did not return in Expanded state after scrolling away and back"
            )
            XCTAssertEqual(restored.value, "Expanded")
            XCTAssertTrue(
                Self.accessibilityFrameIsMeaningfullyVisible(restored.frame, in: fixture.scrollView),
                "The restored accessibility control frame must intersect the transcript viewport"
            )
            XCTAssertTrue(
                Self.hasVisibleEvidence(target.expandedEvidence, in: fixture.window, scrollView: fixture.scrollView),
                "Expanded content disappeared after scrolling back to the transcript row"
            )
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertEqual(
                fixture.deliveryAcknowledgementAttempts(for: target.messageID), ackBeforeReturn,
                "Returning to a previously acknowledged assistant row must not issue a duplicate delivery acknowledgement"
            )
        }
    }

    @MainActor
    func testUnsentNativeCardFormValueSurvivesScrollingAwayAndBack() async throws {
        let cardID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let revisionID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let messageID = "retention-native-form"
        let tailID = "retention-form-tail"
        let formBlock: JSONValue = .object([
            "type": .string("form"),
            "id": .string("retention_plan"),
            "title": .string("Plan the visit"),
            "serverAction": .string("submit_owner_chat_turn"),
            "submitLabel": .string("Review in message"),
            "fields": .array([.object([
                "id": .string("destination"),
                "type": .string("text"),
                "label": .string("Destination"),
                "required": .bool(true),
            ])]),
        ])
        let fact: JSONValue = .object([
            "id": .string("retention_fact"),
            "value": .string("A saved trip idea"),
            "label": .string("Trip idea"),
            "source": .string("Retention test fixture"),
        ])
        let spec: [String: JSONValue] = [
            "version": .number(1),
            "title": .string("Visit plan"),
            "sourceLabel": .string("Retention test"),
            "accessibilityLabel": .string("Visit plan"),
            "facts": .array([fact]),
            "blocks": .array([
                formBlock,
                .object(["type": .string("note"), "factId": .string("retention_fact")]),
            ]),
        ]
        let card = MessagePart(type: "data-card", data: .object([
            "kind": .string("generated-card"),
            "id": .string(cardID),
            "revisionId": .string(revisionID),
            "spec": .object(spec),
        ]))
        let message = ChatMessage(id: messageID, role: .assistant, parts: [
            .init(type: "text", text: "Fill in the destination when you are ready. Nothing has been sent."),
            card,
        ])
        let messages = [message] + (0..<36).map { index in
            ChatMessage.optimistic(role: .assistant, text: "Form retention filler \(index).", id: "retention-form-filler-\(index)")
        } + [
            ChatMessage.optimistic(role: .assistant, text: "Tail row used to evict the form.", id: tailID),
        ]

        let fixture = try await ConversationPerformanceFixture.make(messages: messages)
        addTeardownBlock {
            await fixture.tearDown()
            let formSession = await MainActor.run { fixture.model.cardFormSession }
            if let session = formSession {
                do {
                    try await session.closeAndRotate()
                } catch {
                    XCTFail("Could not clear the test-only encrypted native-form draft: \(error)")
                }
            }
        }

        let parserResult = try XCTUnwrap(NativeCardFormParser.forms(in: spec, cardId: cardID, revisionId: revisionID).first)
        let form = parserResult.descriptor
        XCTAssertNotNil(fixture.model.cardFormSession, "The hosted fixture must use the real encrypted card-form session")
        _ = try await fixture.seekMessage(messageID)
        let fieldCandidate = await waitForTextField(label: "Destination", in: fixture.window, scrollView: fixture.scrollView)
        let field = try XCTUnwrap(
            fieldCandidate,
            "The production generated-card renderer did not expose its actual Destination text field"
        )
        XCTAssertEqual(field.accessibilityLabel, "Destination")
        XCTAssertEqual(field.text, "", "The synthetic card must begin with an unsent empty field")
        XCTAssertTrue(Self.isVisible(field, in: fixture.window, scrollView: fixture.scrollView),
                      "The actual Destination text field must be in the current transcript viewport")
        XCTAssertTrue(field.becomeFirstResponder(), "The actual generated-card text field could not become first responder")
        guard let range = field.textRange(from: field.beginningOfDocument, to: field.endOfDocument) else {
            XCTFail("The native field could not provide a UIKit text range")
            return
        }
        field.selectedTextRange = range
        field.replace(range, withText: "Reykjavik")
        field.resignFirstResponder()

        let expected = CardFormValue.text("Reykjavik")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        var persisted: (CardFormScope, CardFormDraft)?
        while ContinuousClock.now < deadline {
            let loaded = try await fixture.model.openCardForm(form)
            if loaded.1.values["destination"] == expected {
                persisted = loaded
                break
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        let saved = try XCTUnwrap(persisted, "The actual UITextField edit did not reach encrypted draft storage")
        XCTAssertEqual(saved.1.values["destination"], expected)
        XCTAssertNil(saved.1.frozenSubmission, "The test covers an unsent draft, not a submitted request")

        let ackBeforeAway = fixture.deliveryAcknowledgementAttempts(for: messageID)
        XCTAssertGreaterThan(ackBeforeAway, 0, "The form row must have crossed the production visibility acknowledgement path")
        _ = try await fixture.seekMessage(tailID, anchor: .bottom)
        XCTAssertTrue(
            Self.hasVisibleLabel("Tail row used to evict the form.", in: fixture.window, scrollView: fixture.scrollView),
            "The away destination did not enter the actual transcript viewport"
        )
        let fieldLeftUIKitHierarchy = await waitUntil { Self.textField(label: "Destination", in: fixture.window) == nil }
        XCTAssertTrue(
            fieldLeftUIKitHierarchy,
            "The text field remained in the hosted UIKit hierarchy while away; this run did not establish offscreen return"
        )
        let ackBeforeReturn = fixture.deliveryAcknowledgementAttempts(for: messageID)
        _ = try await fixture.seekMessage(messageID)
        let restoredFieldCandidate = await waitForTextField(label: "Destination", in: fixture.window, scrollView: fixture.scrollView)
        let restoredField = try XCTUnwrap(
            restoredFieldCandidate,
            "The native form did not remount when its transcript row returned"
        )
        let restoredValue = await waitUntil { restoredField.text == "Reykjavik" }
        XCTAssertTrue(
            restoredValue,
            "The remounted actual UITextField did not restore its unsent value"
        )
        XCTAssertTrue(Self.isVisible(restoredField, in: fixture.window, scrollView: fixture.scrollView),
                      "The restored text field is mounted but outside the transcript viewport")
        XCTAssertEqual(restoredField.accessibilityLabel, "Destination")
        let reloaded = try await fixture.model.openCardForm(form)
        XCTAssertEqual(reloaded.0, saved.0)
        XCTAssertEqual(reloaded.1.values["destination"], expected, "The value must remain in the encrypted production draft store after remount")
        XCTAssertNil(reloaded.1.frozenSubmission)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(
            fixture.deliveryAcknowledgementAttempts(for: messageID), ackBeforeReturn,
            "Returning to a previously acknowledged assistant row must not issue a duplicate delivery acknowledgement"
        )
    }

    @MainActor
    private func waitForDisclosure(
        _ target: DisclosureTarget,
        value: String,
        in window: UIWindow,
        scrollView: UIScrollView
    ) async -> AccessibilityProxy? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while ContinuousClock.now < deadline {
            if let proxy = visibleDisclosure(target, value: value, in: window, scrollView: scrollView) { return proxy }
            try? await Task.sleep(for: .milliseconds(25))
            window.layoutIfNeeded()
        }
        return nil
    }

    @MainActor
    private func visibleDisclosure(
        _ target: DisclosureTarget,
        value: String,
        in window: UIWindow,
        scrollView: UIScrollView
    ) -> AccessibilityProxy? {
        Self.accessibilityElements(in: window).first { proxy in
            target.matches(label: proxy.label)
                && proxy.value == value
                && Self.accessibilityFrameIsMeaningfullyVisible(proxy.frame, in: scrollView)
        }
    }

    @MainActor
    private func disclosure(_ target: DisclosureTarget, value: String?, in window: UIWindow) -> AccessibilityProxy? {
        Self.accessibilityElements(in: window).first { proxy in
            guard let value else { return target.matches(label: proxy.label) }
            return target.matches(label: proxy.label) && proxy.value == value
        }
    }

    @MainActor
    private func waitForTextField(label: String, in window: UIWindow, scrollView: UIScrollView) async -> UITextField? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while ContinuousClock.now < deadline {
            if let field = Self.textField(label: label, in: window), Self.isVisible(field, in: window, scrollView: scrollView) {
                return field
            }
            try? await Task.sleep(for: .milliseconds(25))
            window.layoutIfNeeded()
        }
        return nil
    }

    @MainActor
    private func waitUntil(
        timeout: Duration = .seconds(4),
        condition: @MainActor () -> Bool
    ) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return condition()
    }

    @MainActor
    private static func textField(label: String, in window: UIWindow) -> UITextField? {
        descendants(of: window).compactMap { $0 as? UITextField }.first { $0.accessibilityLabel == label }
    }

    @MainActor
    private static func isVisible(_ view: UIView, in window: UIWindow, scrollView: UIScrollView) -> Bool {
        guard view.window === window else { return false }
        var current: UIView? = view
        while let ancestor = current {
            guard !ancestor.isHidden, ancestor.alpha > 0.01 else { return false }
            current = ancestor.superview
        }
        let screenFrame = UIAccessibility.convertToScreenCoordinates(view.bounds, in: view)
        return accessibilityFrameIsMeaningfullyVisible(screenFrame, in: scrollView)
    }

    @MainActor
    private static func hasVisibleLabel(_ label: String, in window: UIWindow, scrollView: UIScrollView) -> Bool {
        accessibilityElements(in: window).contains { proxy in
            proxy.label.contains(label) && accessibilityFrameIsMeaningfullyVisible(proxy.frame, in: scrollView)
        }
    }

    @MainActor
    private static func hasVisibleEvidence(_ evidence: String, in window: UIWindow, scrollView: UIScrollView) -> Bool {
        // Each marker is unique to one fixture row and must be visible within
        // the production transcript viewport, not merely elsewhere on screen.
        accessibilityElements(in: window).contains { proxy in
            proxy.label.contains(evidence) && accessibilityFrameIsMeaningfullyVisible(proxy.frame, in: scrollView)
        }
    }

    @MainActor
    private static func accessibilityFrameIsMeaningfullyVisible(_ frame: CGRect, in scrollView: UIScrollView) -> Bool {
        guard !frame.isNull, !frame.isInfinite, frame.width > 0, frame.height > 0 else { return false }
        let viewport = UIAccessibility.convertToScreenCoordinates(scrollView.bounds, in: scrollView)
        let intersection = frame.intersection(viewport)
        guard !intersection.isNull else { return false }
        return intersection.width >= 16
            && intersection.height >= 16
            && intersection.width * intersection.height >= frame.width * frame.height * 0.5
    }

    @MainActor
    private static func accessibilityElements(in root: UIView) -> [AccessibilityProxy] {
        var result: [AccessibilityProxy] = []
        var visited = Set<ObjectIdentifier>()

        func visit(_ object: AnyObject) {
            let identity = ObjectIdentifier(object)
            guard visited.insert(identity).inserted else { return }

            if let view = object as? UIView {
                let label = view.accessibilityLabel ?? ""
                let value = view.accessibilityValue as? String
                if view.isAccessibilityElement || !label.isEmpty || value != nil {
                    result.append(AccessibilityProxy(
                        identity: identity,
                        label: label,
                        value: value,
                        frame: view.accessibilityFrame,
                        activate: { view.accessibilityActivate() }
                    ))
                }
                view.subviews.forEach(visit)
            } else if let element = object as? UIAccessibilityElement {
                result.append(AccessibilityProxy(
                    identity: identity,
                    label: element.accessibilityLabel ?? "",
                    value: element.accessibilityValue as? String,
                    frame: element.accessibilityFrame,
                    activate: { element.accessibilityActivate() }
                ))
            }

            // UIKit exposes these through an NSObject category on this SDK,
            // rather than a castable UIAccessibilityContainer protocol.
            guard let container = object as? NSObject else { return }
            let rawCount = container.accessibilityElementCount()
            guard rawCount != NSNotFound, rawCount > 0 else { return }
            let count = min(rawCount, 2_000)
            for index in 0..<count {
                if let child = container.accessibilityElement(at: index) as AnyObject? {
                    visit(child)
                }
            }
        }

        visit(root)
        var unique: [ObjectIdentifier: AccessibilityProxy] = [:]
        for proxy in result { unique[proxy.identity] = proxy }
        return Array(unique.values)
    }

    @MainActor
    private static func descendants(of view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { descendants(of: $0) }
    }

    private static func agendaPart() -> MessagePart {
        .init(type: "data-card", data: .object([
            "kind": .string("briefing"),
            "id": .string("retention-agenda-card"),
            "presentation": .string("calendar-agenda"),
            "title": .string("Agenda"),
            "date": .string("Saturday, October 24"),
            "lead": .string("Eight events are ready to review."),
            "sections": .array([.object([
                "type": .string("agenda"),
                "title": .string("Saturday"),
                "complete": .bool(true),
                "items": .array((1...8).map { index in .object([
                    "id": .string("retention-agenda-event-\(index)"),
                    "day": .string("Timed"),
                    "time": .string("\(8 + index):00 AM"),
                    "title": .string("Retention agenda item \(index)"),
                ]) }),
            ])]),
        ]))
    }
}

private struct DisclosureTarget {
    let messageID: String
    let stableLabel: String
    let collapsedLabel: String
    let expandedLabel: String
    let expandedEvidence: String

    func matches(label: String) -> Bool {
        label.contains(stableLabel)
            || label.contains(collapsedLabel)
            || label.contains(expandedLabel)
    }
}

@MainActor
private struct AccessibilityProxy {
    let identity: ObjectIdentifier
    let label: String
    let value: String?
    let frame: CGRect
    private let activateAction: @MainActor () -> Bool

    init(
        identity: ObjectIdentifier,
        label: String,
        value: String?,
        frame: CGRect,
        activate: @escaping @MainActor () -> Bool
    ) {
        self.identity = identity
        self.label = label
        self.value = value
        self.frame = frame
        self.activateAction = activate
    }

    func activate() -> Bool { activateAction() }
}
