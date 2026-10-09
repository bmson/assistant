import XCTest
@testable import Assistant

/// What the assistant says out loud, and — more importantly — what it only ever
/// says once.
final class SpeakableTextTests: XCTestCase {

    // MARK: - Prose

    func testEmphasisAndLinksLoseTheirPunctuation() {
        let passages = SpeakableText.passages(forProse: "It is **already booked**, see [the invite](https://cal.example/x).")
        XCTAssertEqual(passages, ["It is already booked, see the invite."])
    }

    func testBareURLBecomesAWord() {
        let passages = SpeakableText.passages(forProse: "The page is at https://example.com/a/very/long/path?q=1 now.")
        XCTAssertEqual(passages, ["The page is at a link now."])
    }

    func testDegreesAreSpokenAsWords() {
        let passages = SpeakableText.passages(forProse: "It is 18°C and falling.")
        XCTAssertEqual(passages, ["It is 18 degrees Celsius and falling."])
    }

    func testCodeBlockIsNamedRatherThanRead() {
        let source = """
        Run this:

        ```swift
        let x = try await client.send()
        ```
        """
        XCTAssertEqual(SpeakableText.passages(forProse: source), [
            "Run this:",
            "There's a Swift code block here.",
        ])
    }

    func testTableIsDescribedRatherThanRecited() {
        let source = """
        | Day | Time |
        | --- | --- |
        | Monday | 9am |
        | Tuesday | 10am |
        """
        let passages = SpeakableText.passages(forProse: source)
        XCTAssertEqual(passages, ["There's a table here, with 2 rows: Day and Time."])
        XCTAssertFalse(passages.joined().contains("|"))
    }

    func testEachBlockIsItsOwnPassage() {
        let source = """
        # Tomorrow

        Two things need you.

        - Call the studio
        - Sign the lease
        """
        XCTAssertEqual(SpeakableText.passages(forProse: source), [
            "Tomorrow",
            "Two things need you.",
            "Call the studio",
            "Sign the lease",
        ])
    }

    func testNumberedItemsKeepTheirNumbers() {
        let passages = SpeakableText.passages(forProse: "1. First\n2. Second")
        XCTAssertEqual(passages, ["1. First", "2. Second"])
    }

    func testDividerSaysNothing() {
        XCTAssertEqual(SpeakableText.passages(forProse: "---"), [])
    }

    func testWhitespaceOnlyProseSaysNothing() {
        XCTAssertEqual(SpeakableText.passages(forProse: "   \n\n  "), [])
    }

    // MARK: - Messages

    func testApprovalIsAnnouncedButNeverRead() {
        let message = ChatMessage(
            id: "m1",
            role: .assistant,
            parts: [
                .init(type: "text", text: "Sending £4,000 to Acme Ltd, account 12345678."),
                .init(type: "approval", approvalId: "a1", status: "pending"),
            ],
            metadata: nil
        )
        let passages = SpeakableText.passages(for: message)
        XCTAssertEqual(passages, ["A decision is waiting for you."])
        XCTAssertFalse(passages.joined().contains("12345678"))
    }

    /// A suggestion is not an approval: it holds nothing back, and the prose
    /// beside it is only half a sentence without it.
    func testOpenSuggestionIsReadAfterItsProseAndNeverCalledADecision() {
        let message = ChatMessage(
            id: "m5",
            role: .assistant,
            parts: [
                .init(type: "text", text: "One more thing from your **Flights** watch:"),
                .init(type: "suggestion", suggestionId: "s1", summary: "Fares to Lisbon dropped — want me to hold one?"),
                .init(type: "suggestion", suggestionId: "s2", summary: "Renew the passport?", status: "dismissed"),
            ],
            metadata: nil
        )
        XCTAssertEqual(SpeakableText.passages(for: message), [
            "One more thing from your Flights watch:",
            "Fares to Lisbon dropped — want me to hold one?",
        ])
    }

    func testUserMessagesAreNeverSpoken() {
        let message = ChatMessage.optimistic(role: .user, text: "What's on tomorrow?")
        XCTAssertEqual(SpeakableText.passages(for: message), [])
    }

    func testProseMessageSpeaksItsBubbles() {
        let message = ChatMessage(
            id: "m2",
            role: .assistant,
            parts: [
                .init(type: "text", text: "Both are free."),
                .init(type: "text", text: "Want me to hold the later one?"),
            ],
            metadata: nil
        )
        XCTAssertEqual(SpeakableText.passages(for: message), [
            "Both are free.",
            "Want me to hold the later one?",
        ])
    }

    /// A card grounded in a lookup stands in for the reply. With no prose to
    /// read, silence would be the bug.
    func testCardOnlyReplySpeaksTheCard() {
        let message = ChatMessage(
            id: "m3",
            role: .assistant,
            parts: [generatedCardPart(accessibilityLabel: "Your flight leaves at 6:40pm from gate 12.")],
            metadata: nil
        )
        XCTAssertEqual(SpeakableText.passages(for: message), [
            "Your flight leaves at 6:40pm from gate 12.",
        ])
    }

    func testSensitiveFactsAreNotSpoken() {
        let message = ChatMessage(
            id: "m4",
            role: .assistant,
            // No accessibility label, so the parser falls back to the title and
            // the facts carry the answer.
            parts: [generatedCardPart(accessibilityLabel: nil)],
            metadata: nil
        )
        let spoken = SpeakableText.passages(for: message).joined(separator: " ")
        XCTAssertTrue(spoken.contains("Gate: 12"))
        XCTAssertFalse(spoken.contains("hunter2"))
    }

    func testGeneratedAccessibilityLabelCannotSpeakSensitiveFactValues() {
        let message = ChatMessage(
            id: "m5",
            role: .assistant,
            parts: [generatedCardPart(accessibilityLabel: "Your booking reference is hunter2 and your gate is 12.")],
            metadata: nil
        )
        let spoken = SpeakableText.passages(for: message).joined(separator: " ")
        XCTAssertFalse(spoken.localizedCaseInsensitiveContains("hunter2"))
        XCTAssertTrue(spoken.contains("Your booking reference is"))

        guard case let .generated(card)? = message.parts.compactMap(MessageResponseCard.init(part:)).first else {
            return XCTFail("Expected generated card")
        }
        XCTAssertFalse(SpeakableText.safeAccessibilityLabel(for: card).localizedCaseInsensitiveContains("hunter2"))
    }

    func testAvailabilitySpeechRequiresExplicitCompletenessAndCheckedCalendar() {
        func passages(complete: JSONValue?, calendars: [JSONValue]) -> [String] {
            var card: [String: JSONValue] = [
                "kind": .string("availability"),
                "busy": .array([]),
                "calendarsChecked": .array(calendars),
            ]
            if let complete { card["complete"] = complete }
            let message = ChatMessage(
                id: "availability", role: .assistant,
                parts: [.init(type: "data-card", data: .object(card))], metadata: nil
            )
            return SpeakableText.passages(for: message)
        }

        XCTAssertEqual(
            passages(complete: nil, calendars: [.string("Work")]),
            ["No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown."]
        )
        XCTAssertEqual(passages(complete: .bool(true), calendars: []), ["Availability is unconfirmed."])
        XCTAssertEqual(passages(complete: .bool(true), calendars: [.string("  ")]), ["Availability is unconfirmed."])
        XCTAssertEqual(
            passages(complete: .bool(false), calendars: [.string("Work"), .string("Family")]),
            ["No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown."]
        )
        XCTAssertEqual(passages(complete: .bool(false), calendars: [.string("Work")]), [
            "No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown.",
        ])
        XCTAssertEqual(passages(complete: .bool(true), calendars: [.string("Work")]), ["Nothing is booked."])
    }

    func testAvailabilitySpeechQualifiesMalformedAndPartialBusyEvidence() {
        func passage(complete: JSONValue, busy: JSONValue, calendars: [JSONValue]) -> [String] {
            let message = ChatMessage(
                id: "availability", role: .assistant,
                parts: [.init(type: "data-card", data: .object([
                    "kind": .string("availability"),
                    "busy": busy,
                    "complete": complete,
                    "calendarsChecked": .array(calendars),
                ]))], metadata: nil
            )
            return SpeakableText.passages(for: message)
        }
        let valid = JSONValue.object([
            "start": .string("2026-10-07T09:00:00Z"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])
        let malformed = JSONValue.object([
            "start": .string("not-a-date"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])
        let reversed = JSONValue.object([
            "start": .string("2026-10-07T11:00:00Z"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])
        let zeroDuration = JSONValue.object([
            "start": .string("2026-10-07T10:00:00Z"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])

        XCTAssertEqual(
            passage(complete: .bool(true), busy: .array([valid, malformed]), calendars: [.string("Work")]),
            ["1 booked block. Availability is incomplete; unlisted time is unknown."]
        )
        XCTAssertEqual(
            passage(complete: .bool(true), busy: .array([malformed]), calendars: [.string("Work")]),
            ["No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown."]
        )
        XCTAssertEqual(
            passage(complete: .bool(true), busy: .array([reversed, zeroDuration]), calendars: [.string("Work")]),
            ["No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown."]
        )
        XCTAssertEqual(
            passage(complete: .bool(true), busy: .string("unknown"), calendars: [.string("Work")]),
            ["No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown."]
        )
        XCTAssertEqual(
            passage(complete: .bool(true), busy: .array([]), calendars: []),
            ["Availability is unconfirmed."]
        )
    }

    private func generatedCardPart(accessibilityLabel: String?) -> MessagePart {
        var spec: [String: JSONValue] = [
            "version": .number(1),
            "title": .string("Flight BA429"),
            "facts": .array([
                .object(["id": .string("gate"), "label": .string("Gate"), "value": .string("12")]),
                .object([
                    "id": .string("ref"),
                    "label": .string("Booking reference"),
                    "value": .string("hunter2"),
                    "sensitive": .bool(true),
                ]),
            ]),
            "blocks": .array([.object(["type": .string("facts")])]),
        ]
        if let accessibilityLabel {
            spec["accessibilityLabel"] = .string(accessibilityLabel)
        }
        return MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("card-1"),
                "spec": .object(spec),
            ])
        )
    }
}

/// The offset that keeps a streamed reply from being read twice.
final class SpeechProgressTests: XCTestCase {

    func testOnlyFinishedBlocksAreSpokenWhileStreaming() {
        var progress = SpeechProgress()
        XCTAssertEqual(progress.take(from: "Both are fre", isFinal: false), [])
        XCTAssertEqual(progress.take(from: "Both are free.\n\n", isFinal: false), ["Both are free."])
    }

    func testAHalfWrittenTableWaitsForItsLastRow() {
        var progress = SpeechProgress()
        let partial = "Here:\n\n| Day | Time |\n| --- | --- |\n| Monday | 9am |"
        XCTAssertEqual(progress.take(from: partial, isFinal: false), ["Here:"])

        let whole = partial + "\n| Tuesday | 10am |"
        XCTAssertEqual(progress.take(from: whole, isFinal: true), [
            "There's a table here, with 2 rows: Day and Time.",
        ])
    }

    func testABlankLineInsideAnOpenCodeFenceIsNotABoundary() {
        let open = "```\nlet a = 1\n\nlet b = 2\n"
        XCTAssertEqual(SpeechProgress.finishedPrefixLength(of: open), 0)

        // Once the fence closes there is nothing left to reinterpret.
        let closed = open + "```\n"
        XCTAssertEqual(SpeechProgress.finishedPrefixLength(of: closed), closed.count)
    }

    /// The whole point. The streamed row is thrown away and replaced by the
    /// durable one; the reply must not start over.
    func testTheDurableRowSpeaksOnlyWhatTheStreamDidNotReach() {
        var progress = SpeechProgress()
        let streamed = "Both are free.\n\nWant me to hold the later one?"
        XCTAssertEqual(progress.take(from: streamed, isFinal: false), ["Both are free."])

        XCTAssertEqual(progress.take(from: streamed, isFinal: true), [
            "Want me to hold the later one?",
        ])
        XCTAssertEqual(progress.take(from: streamed, isFinal: true), [])
    }

    /// A split point leaves whitespace residue, so the persisted text can be a
    /// character shorter than what streamed. That must not read as "say it
    /// again from the top".
    func testAShorterDurableTextNeverReplaysTheReply() {
        var progress = SpeechProgress()
        let streamed = "Both are free.\n\nWant me to hold the later one?\n"
        _ = progress.take(from: streamed, isFinal: true)

        let durable = "Both are free.\nWant me to hold the later one?"
        XCTAssertEqual(progress.take(from: durable, isFinal: true), [])
    }

    /// A card-only reply streams no prose at all. `hasSpoken` is how the turn
    /// knows to read the card when it settles instead of saying nothing.
    func testHasSpokenReportsWhetherAnythingWasSaid() {
        var silent = SpeechProgress()
        XCTAssertFalse(silent.hasSpoken)
        XCTAssertEqual(silent.take(from: "   \n\n", isFinal: true), [])
        XCTAssertFalse(silent.hasSpoken)

        var spoken = SpeechProgress()
        XCTAssertEqual(spoken.take(from: "Done.", isFinal: true), ["Done."])
        XCTAssertTrue(spoken.hasSpoken)
    }
}
